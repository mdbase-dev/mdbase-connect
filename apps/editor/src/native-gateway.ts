import { t } from "@lingui/core/macro";
import {
  effectiveCapabilities,
  isMdbaseError,
  MdbaseError,
  toPlain,
  type MdbaseApplication,
  type MdbaseApplicationConnection,
  type MdbaseApplicationDeclaration,
  type MdbaseClient,
  type TypePackPlan,
  type wire
} from "@mdbase-dev/sdk";
import type {
  CollectionDescription,
  DataContractSelector,
  JsonObject,
  MdbaseDiagnostic,
  MdbaseFileSource,
  PendingMutationSummary,
  TypePackAssessment,
  TypePackProvision
} from "@mdbase-dev/connect";
import type { MdbaseRecordChange } from "@mdbase-dev/connect/advanced";
import { NativeNoteObservation } from "./native-note-observation";
import { downloadNativeFile, type NativeFileSelection } from "./native-file-download";
import { fileAssetKey } from "./file-reference-resolution";
import { NextEditorRecords, plain } from "./next-editor-records";
import type {
  CollectionAuthorizationOptions,
  CollectionAuthorizationTarget,
  CollectionFile,
  CollectionGateway,
  CollectionSessionSnapshot,
  ConnectionSummary,
  CreateNoteInput,
  DeletePreflight,
  EditorCollectionDescription,
  FileListRequest,
  FileReadRequest,
  FileUploadRequest,
  MutationOperationOptions,
  NoteDocument,
  NoteObservation,
  RenamePreflight,
  TypeDocument,
  TypePackApplyResult
} from "./model";
import type { EditorSyncState } from "./app-state-types";

type CollectionOperation = CollectionDescription["operations"][number];

/** Editor operations a native v2 capability grants. Type documents are written
 * create-only or revision-guarded through `resources`; type packs install
 * through the SDK's guarded `typePacks` plan/apply. The replica checks every
 * actual operation; this map only shapes the UI. */
const CAPABILITY_OPERATIONS: Readonly<Record<string, readonly CollectionOperation[]>> = {
  "collection.read": ["describe", "changes", "read", "query", "validate", "read_type"],
  "records.create": ["create"],
  "records.edit": ["update", "rename"],
  "records.delete": ["delete"],
  "definitions.manage": ["create_type", "update_type", "assess_type_pack", "apply_type_pack"]
};

const INSTALLED_BY = "dev.mdbase.editor";
/** Reviewed plans kept for apply, newest last. */
const PLAN_MEMORY = 8;
const RECEIPT_TIMEOUT_MS = 30_000;

/** Production scopes belong to the SDK, for both cloud copies and Private
 * collections. Isolated tests may supply their own fenced scope actions. */
export type EditorScopeActions = Pick<MdbaseApplication, "chooseAnother" | "reauthorize" | "select" | "forget">
  & Partial<Pick<MdbaseApplication, "getSnapshot" | "subscribe">>;

/** One borrowed collection. People access exists only when the SDK supplies its
 * scoped client; document access never implies metadata permission. */
export type EditorConnection = Pick<MdbaseApplicationConnection, "id" | "displayName" | "generation" | "records" | "files" | "isCurrent">
  & { readonly people?: MdbaseApplicationConnection["people"] };

/** The editor's collection gateway over one borrowed public SDK connection.
 * The root follows SDK lifecycle, selection and readiness; this adapter never
 * closes the client, never retries a write under a fresh identity, and stops
 * at every await once the original connection is no longer current. */
export class NativeEditorGateway implements CollectionGateway {
  private readonly client: MdbaseClient;
  private readonly records: NextEditorRecords;
  private readonly listeners = new Set<(snapshot: CollectionSessionSnapshot) => void>();
  private disposed = false;
  private membershipDowngrade = false;
  private readonly stops: Array<() => void> = [];
  private readonly fileReads = new AbortController();
  private readonly plans = new Map<string, TypePackPlan>();

  /** `declaration` is the bundled app declaration; with it the summary reports
   * declared capabilities this grant lacks, for the "update access" prompts. */
  constructor(
    private readonly application: EditorScopeActions,
    private readonly connection: EditorConnection,
    private readonly declaration?: MdbaseApplicationDeclaration
  ) {
    this.client = connection.records;
    if (connection.id !== this.client.collection) throw new Error(t`The editor requires its original SDK collection client.`);
    this.records = new NextEditorRecords(this.client, () => this.current());
    let membership = this.membershipRole();
    this.membershipDowngrade = membership === "viewer";
    let role = this.role();
    const changed = () => {
      if (!this.current()) return;
      // A Connect downgrade can arrive before signed policy. Once policy has
      // caught up, native status also owns upgrades of this open collection.
      if (this.client.status.incidents.some((incident) => incident.kind === "read_only")
        || (this.client.status as wire.SyncStatus & { grant?: wire.GrantInfo }).grant?.role === "viewer") this.membershipDowngrade = false;
      const next = this.role();
      if (next === role) return;
      role = next;
      const snapshot = this.sessionSnapshot();
      for (const listener of [...this.listeners]) listener(snapshot);
    };
    this.stops.push(this.client.onStatus(changed));
    const stop = this.application.subscribe?.(() => {
      const next = this.membershipRole();
      if (next !== membership) {
        membership = next;
        this.membershipDowngrade = next === "viewer";
      }
      changed();
    });
    if (stop) this.stops.push(stop);
    const people = connection.people;
    if (people) this.peopleDirectory = async (options: { signal?: AbortSignal } = {}) => {
      const directory = await people.directory({ members: "omit", signal: this.signal(options.signal) });
      this.check();
      return directory;
    };
  }

  /** Absent when the scope supplies no people client (including custom test adapters). */
  readonly peopleDirectory?: CollectionGateway["peopleDirectory"];

  /** Retire this scope. The borrowed client stays open for its SDK owner. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.fileReads.abort("The editor collection scope was retired");
    for (const stop of this.stops) stop();
    this.records.dispose();
    const snapshot = this.sessionSnapshot();
    for (const listener of [...this.listeners]) listener(snapshot);
    this.listeners.clear();
  }

  sessionSnapshot(): CollectionSessionSnapshot {
    if (!this.current()) return { status: "unselected", connections: [] };
    const connection = this.summary();
    return { status: "ready", connection, connections: [connection] };
  }

  async startSession(): Promise<CollectionSessionSnapshot> { return this.sessionSnapshot(); }

  onSessionChange(listener: (snapshot: CollectionSessionSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.sessionSnapshot());
    return () => { this.listeners.delete(listener); };
  }

  selectConnection(collectionId: string): ConnectionSummary {
    if (collectionId !== this.connection.id || !this.current()) throw new Error(t`The selected collection is not ready.`);
    return this.summary();
  }

  /** The SDK's own sync state: its write ledger keeps changes on this device
   * while the collection can't be reached; the application's sync summary (or,
   * for a Private collection, the client's link) reports being offline. */
  syncState(): EditorSyncState {
    if (!this.current()) return "synced";
    if (this.client.ledger.getSnapshot().saveState === "saved_on_device") return "saved_on_device";
    const phase = this.application.getSnapshot?.().phase;
    const sync = phase?.kind === "ready" && phase.collectionId === this.connection.id ? this.application.getSnapshot?.().sync : null;
    return sync?.kind === "offline" || this.client.status.connection === "offline" || this.client.link !== "open" ? "offline" : "synced";
  }

  onSyncState(listener: () => void): () => void {
    const stops = [this.client.ledger.subscribe(listener), this.client.onStatus(listener), this.client.onLink(listener),
      this.application.subscribe?.(listener)];
    return () => { for (const stop of stops) stop?.(); };
  }

  /** Browser apps reach a collection through relay or hosted access only; the
   * SDK reports browser direct access as unsupported at launch, so the editor
   * shows no "this computer" control rather than a prompt that cannot work. */
  async checkDirectAccess(): Promise<ConnectionSummary | null> { return null; }
  async requestDirectAccess(): Promise<ConnectionSummary | null> { return null; }

  async authorize(target: CollectionAuthorizationTarget, options: CollectionAuthorizationOptions = {}): Promise<void> {
    const request = options.signal ? { signal: options.signal } : {};
    if (target === "choose") await this.application.chooseAnother(request);
    else if (target === "selected") await this.application.reauthorize(request);
    else await this.application.select(target.collectionId, request);
  }

  async forgetConnection(collectionId: string): Promise<void> {
    await this.application.forget(collectionId);
  }

  async describe(): Promise<EditorCollectionDescription> {
    const signal = this.signal();
    const full = await this.client.describe({ definitions: true, signal }).catch((error: unknown) => {
      // Older replicas, or catalogs over the replica's describe budget, still
      // open with names only; schema-driven features then stay off.
      if (isMdbaseError(error) && (error.code === "upgrade_required" || error.code === "too_large")) return undefined;
      throw error;
    });
    this.check();
    const described = full ?? await this.client.describe(signal);
    this.check();
    const versions = new Map(described.types.map((type) => [type.name, type.version]));
    return {
      protocolVersion: 1,
      collectionId: this.connection.id,
      displayName: this.connection.displayName,
      specVersion: described.specVersion,
      operations: this.operations(),
      // Native change cursors are opaque; observe() owns the watch position.
      changeCursor: 0,
      configuration: { settings: toPlain(described.settings) },
      ...(full ? {} : { typing: "names_only" as const }),
      types: described.types.map(typeDescriptor),
      contracts: described.contracts.map((contract) => {
        const schemas = contract.schemas;
        const bindingSchema = jsonObject(schemas?.get("binding_schema"));
        return {
          contractType: "record" as const,
          id: contract.id,
          version: contract.version,
          digest: contract.digest,
          schema: jsonObject(schemas?.get("record_schema")) ?? {},
          ...(bindingSchema ? { bindingSchema } : {}),
          implementations: described.types.flatMap((type) => type.implements
            .filter((implementation) => implementation.contract === contract.id && implementation.version === contract.version)
            .map((implementation) => ({
              typeName: type.name,
              typePath: type.path,
              // Names-only describes carry no versions; 0 never reads as current.
              typeVersion: full ? versions.get(type.name) ?? 1 : 0,
              digest: implementation.digest ?? "",
              fields: Object.fromEntries(implementation.fields),
              ...(implementation.binding === undefined ? {} : { binding: toPlain(implementation.binding) as JsonObject })
            })))
        };
      })
    };
  }

  async queryContract(contract: DataContractSelector, options: { signal?: AbortSignal } = {}): Promise<Array<{ path: string; values: JsonObject }>> {
    const signal = this.signal(options.signal);
    const records: Array<{ path: string; values: JsonObject }> = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const result = await this.client.queryContract({ id: contract.id, version: contract.version }, { pageSize: 128, signal, ...(cursor ? { cursor } : {}) });
      this.check();
      for (const record of result.records) {
        const projection = contract.type
          ? record.implementations.find((implementation) => implementation.typeName === contract.type)
          : record.implementations.length === 1 ? record.implementations[0] : undefined;
        const path = result.page.records.find((view) => view.id === record.id)?.path;
        if (projection && path) records.push({ path, values: plain(projection.fields) });
      }
      cursor = result.page.cursor;
      if (cursor) {
        if (cursors.has(cursor)) throw new Error(t`The collection repeated a query page.`);
        cursors.add(cursor);
      } else if (!result.page.complete) throw new Error(t`The collection did not return every record for this contract.`);
    } while (cursor);
    return records;
  }

  observe(): NoteObservation {
    this.check();
    return new NativeNoteObservation(this.client, () => this.current());
  }

  async mostRecentNote(): Promise<string | undefined> {
    const result = await this.client.query({ order_by: ["-file.mtime"], limit: 1 }, {}, this.signal());
    this.check();
    return result.records[0]?.path;
  }

  read(path: string): Promise<NoteDocument> { return this.records.read(path); }

  async listFiles({ signal, onProgress }: FileListRequest = {}): Promise<CollectionFile[]> {
    const current = this.signal(signal);
    const files: CollectionFile[] = [];
    const ids = new Set<string>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await this.connection.files.listPage({ limit: 500, signal: current, ...(cursor ? { cursor } : {}) });
      this.check();
      for (const file of page.files) {
        if (ids.has(file.id)) throw new Error(t`The collection listed a file twice.`);
        ids.add(file.id);
        files.push(collectionFile(file));
      }
      cursor = page.cursor;
      if (cursor) {
        if (cursors.has(cursor)) throw new Error(t`The collection repeated a file page.`);
        cursors.add(cursor);
        onProgress?.({ files: [...files], complete: false });
      } else if (!page.complete) throw new Error(t`The collection did not return every file.`);
    } while (cursor);
    onProgress?.({ files: [...files], complete: true });
    return files;
  }

  async readFile(file: CollectionFile, { signal, onProgress }: FileReadRequest = {}): Promise<Blob> {
    const current = AbortSignal.any([this.signal(signal), this.fileReads.signal]);
    if (file.confirmedSeq === undefined)
      throw new Error(t`This file has no native confirmation metadata. Reload its preview.`);
    const key = fileAssetKey(file);
    const selected: NativeFileSelection = {
      id: file.fileId, path: file.path, digest: file.revision, size: file.size,
      contentProfile: file.contentProfile, confirmedSeq: file.confirmedSeq
    };
    // Selection/inventory effects abort the caller's request. Also fence scalar
    // mutation and every settlement against this original borrowed scope.
    const isCurrent = () => this.current() && !current.aborted && fileAssetKey(file) === key;
    const check = () => {
      if (!isCurrent()) throw new MdbaseError({ code: "cancelled", recovery: "none", message: t`This file selection is no longer current.` });
    };
    check();
    try {
      const bytes = await downloadNativeFile({
        downloadStream: (ref, options) => this.connection.files.downloadStream(ref, {
          ...options,
          ...(onProgress ? { onProgress: (progress: wire.TransferProgress) => {
            if (isCurrent()) onProgress({ phase: "downloading", transferredBytes: progress.done, totalBytes: progress.total });
          } } : {})
        })
      }, selected, { signal: current, isCurrent });
      check();
      return new Blob([bytes as BlobPart]);
    } catch (error) {
      check();
      throw error;
    }
  }

  async uploadFile(path: string, source: MdbaseFileSource, { signal, onProgress, transferId }: FileUploadRequest = {}): Promise<CollectionFile> {
    await this.checkWritable();
    const current = this.signal(signal);
    // Unknown/older grants stay closed. The native replica checks folder scope
    // and every actual operation; this UI gate never grants authority.
    if (!this.connection.files.grant?.actions.includes("add"))
      throw unsupported(t`Attaching files is not available for this collection in mdbase editor yet.`);
    const bytes = ArrayBuffer.isView(source)
      ? new Uint8Array(source.buffer, source.byteOffset, source.byteLength) : source;
    const write = await this.connection.files.upload(path, bytes, {
      signal: current,
      ...(transferId ? { transferId } : {}),
      ...(onProgress ? { onProgress: (progress: wire.TransferProgress) => onProgress({ phase: "uploading", transferredBytes: progress.done, totalBytes: progress.total }) } : {})
    });
    try {
      this.check();
      const receipt = await this.client.awaitReceipt(write.mutationId, 30_000, current);
      this.check();
      if (receipt.mutation !== write.mutationId || receipt.state !== "confirmed" || receipt.status !== "applied"
        || (receipt.conflicts?.length ?? 0) !== 0 || receipt.published === "publishing" || receipt.published === "not_published")
        throw new MdbaseError({ code: "outcome_unknown", recovery: "resolve_outcome", message: t`This file upload is not confirmed. Resolve its original operation before trying again.` });
      const file = await this.connection.files.get(write.fileId, current);
      this.check();
      if (file.id !== write.fileId || file.confirmedSeq !== receipt.seq || file.hold || file.state === "pending_upload")
        throw new MdbaseError({ code: "outcome_unknown", recovery: "resolve_outcome", message: t`The current file does not confirm this upload. Resolve its original operation before trying again.` });
      return collectionFile(file);
    } catch (error) {
      // Receipt/readback/currentness failures retain the same SDK mutation ID.
      // Upload submission errors already carry it and are passed through above.
      throw new MdbaseError(error instanceof MdbaseError ? error.toProblem()
        : { code: "outcome_unknown", recovery: "resolve_outcome", message: t`The file upload outcome is unknown.` },
      { mutationId: write.mutationId, cause: error });
    }
  }

  async create(input: CreateNoteInput): Promise<NoteDocument> { await this.checkWritable(); return this.records.create(input); }
  async restore(document: NoteDocument, id?: string): Promise<NoteDocument> { await this.checkWritable(); return this.records.restore(document, id); }
  async update(base: NoteDocument, change: MdbaseRecordChange): Promise<NoteDocument> { await this.checkWritable(); return this.records.update(base, change); }
  async updateProperties(path: string, patch: JsonObject, revision: string): Promise<NoteDocument> { await this.checkWritable(); return this.records.updateProperties(path, patch, revision); }
  async updateDocument(path: string, document: string, revision: string): Promise<NoteDocument> { await this.checkWritable(); return this.records.updateDocument(path, document, revision); }

  async preflightRename(from: string, to: string, revision: string): Promise<RenamePreflight> {
    const result = await this.records.preflightRename(from, to, revision);
    const affectedPaths = uniquePaths(result.rewrites);
    const brokenPaths = uniquePaths(result.broken);
    return {
      affectedPaths,
      warnings: brokenPaths.map((path) => t`A link in ${path} will stay broken.`),
      operation: { from, to, dryRun: true, wouldRename: true, referencesAffected: result.rewrites.map((rewrite) => ({ path: rewrite.path, ...(rewrite.field ? { field: rewrite.field } : {}) })) }
    };
  }

  async rename(from: string, to: string, revision: string, updateRefs = true, options: MutationOperationOptions = {}): Promise<NoteDocument> {
    await this.checkWritable();
    return this.records.rename(from, to, revision, updateRefs, options.signal);
  }

  async preflightDelete(path: string, revision: string): Promise<DeletePreflight> {
    const result = await this.records.preflightDelete(path, revision);
    const brokenLinkPaths = uniquePaths(result.broken);
    return { brokenLinkPaths, operation: { path, deleted: false, dryRun: true, wouldDelete: true, brokenLinks: brokenLinkPaths.map((broken) => ({ path: broken })) } };
  }

  async delete(path: string, revision: string, options: MutationOperationOptions = {}): Promise<void> {
    await this.checkWritable();
    return this.records.delete(path, revision, options.signal);
  }

  pendingNoteMutations(): readonly PendingMutationSummary[] {
    return this.records.pendingMutations().map((pending) => ({
      requestId: pending.mutationId,
      operation: pending.operation,
      fingerprint: pending.recordId,
      status: "outcome_unknown",
      createdAt: pending.createdAt
    }));
  }

  recoverNoteMutation(requestId: string): Promise<NoteDocument | undefined> { return this.records.recover(requestId); }

  async validate(path: string): Promise<MdbaseDiagnostic[]> {
    const validations = await this.client.validate([{ path }], this.signal());
    this.check();
    return validations.flatMap((validation) => validation.issues.map((issue) => ({
      severity: issue.severity,
      code: issue.code,
      message: issue.message,
      path: validation.path,
      tier: issue.tier,
      ...(issue.location ? { location: issue.location } : {}),
      ...(issue.typeName ? { type: issue.typeName } : {})
    })));
  }

  async readType(name: string): Promise<TypeDocument> {
    const signal = this.signal();
    const type = (await this.client.describe(signal)).types.find((candidate) => candidate.name === name);
    this.check();
    if (!type) throw new MdbaseError({ code: "not_found", recovery: "refresh", message: t`The type ${name} is not defined in this collection.` });
    const resource = await this.client.resources.get(type.path, signal);
    this.check();
    if (resource.text === undefined) throw unsupported(t`The collection did not return this type definition's source.`);
    return { name: type.name, path: resource.path, revision: resource.revision, document: resource.text };
  }

  /** Core derives the name and `<types_folder>/<name>.md` path; the write is
   * create-only, so a concurrent creator of the same type loses with conflict. */
  async createType(document: string): Promise<TypeDocument> {
    await this.checkWritable();
    const signal = this.signal();
    const created = await this.client.createType(document, { signal });
    this.check();
    await this.confirmed(created.write.mutationId, signal, "type");
    return this.typeAt(created.path, document, signal);
  }

  /** Guarded by the reviewed revision: an edit made elsewhere since it was
   * opened is refused as a conflict, never overwritten. */
  async updateType(current: TypeDocument, source: string): Promise<TypeDocument> {
    await this.checkWritable();
    const signal = this.signal();
    const write = await this.client.resources.put(current.path, source, { baseRevision: current.revision, signal });
    this.check();
    await this.confirmed(write.mutationId, signal, "type");
    return this.typeAt(current.path, source, signal);
  }

  async assessTypePack(provision: TypePackProvision, adoptResources: Record<string, string> = {}): Promise<TypePackAssessment> {
    const plan = await this.client.typePacks.plan(provision, { installedBy: INSTALLED_BY, adopt: adoptResources, signal: this.signal() });
    this.check();
    this.plans.delete(plan.digest);
    this.plans.set(plan.digest, plan);
    for (const digest of [...this.plans.keys()].slice(0, Math.max(0, this.plans.size - PLAN_MEMORY))) this.plans.delete(digest);
    return assessmentOf(plan);
  }

  /** Applies exactly the reviewed plan as one guarded mutation and waits for
   * its receipt; any change since review is refused, never re-planned. */
  async applyTypePack(provision: TypePackProvision, assessment: TypePackAssessment, adoptResources: Record<string, string> = {}): Promise<TypePackApplyResult> {
    await this.checkWritable();
    let plan = this.plans.get(assessment.assessmentDigest);
    if (!plan) {
      plan = await this.client.typePacks.plan(provision, { installedBy: INSTALLED_BY, adopt: adoptResources, signal: this.signal() });
      this.check();
      if (plan.digest !== assessment.assessmentDigest) {
        throw new MdbaseError({ code: "conflict", recovery: "refresh", reason: "concurrent_modification", message: t`The collection changed since this setup was reviewed. Review it again.` });
      }
    }
    const signal = this.signal();
    const result = await this.client.typePacks.apply(plan, { signal });
    this.check();
    this.plans.delete(plan.digest);
    if (result.write) await this.confirmed(result.write.mutationId, signal, t`type pack install`);
    return { ...assessmentOf(plan), receipt: result.receipt, cleanupDeferred: false };
  }

  /** Waits for a definition write's receipt; anything short of confirmed and
   * applied is reported, never assumed. */
  private async confirmed(mutationId: string, signal: AbortSignal, subject: string): Promise<void> {
    const receipt = await this.client.awaitReceipt(mutationId, RECEIPT_TIMEOUT_MS, signal);
    this.check();
    if (receipt.state === "rejected") throw receipt.problem ? new MdbaseError(receipt.problem) : new Error(t`The ${subject} was rejected.`);
    if (receipt.status === "conflicted") throw new MdbaseError({ code: "conflict", recovery: "resolve_conflict", message: t`The ${subject} has a conflict. Resolve it before continuing.` });
    if (receipt.state !== "confirmed") {
      throw new MdbaseError({ code: "outcome_unknown", recovery: "resolve_outcome", message: t`The ${subject} is not confirmed yet. Check the collection before trying again.` });
    }
  }

  /** Reads back the confirmed type source and the name Core gives it. */
  private async typeAt(path: string, written: string, signal: AbortSignal): Promise<TypeDocument> {
    const resource = await this.client.resources.get(path, signal);
    this.check();
    if (resource.text !== written) {
      throw new MdbaseError({ code: "conflict", recovery: "refresh", reason: "concurrent_modification", message: t`This type changed after it was saved. Reload it before editing again.` });
    }
    const type = (await this.client.describe(signal)).types.find((candidate) => candidate.path === path);
    this.check();
    if (!type) throw new MdbaseError({ code: "invalid_request", recovery: "fix_request", reason: "invalid_type_definition", message: t`The collection does not read this file as a type definition. Check its name and kind.` });
    return { name: type.name, path, revision: resource.revision, document: resource.text };
  }

  private summary(): ConnectionSummary {
    const missing = this.missingCapabilities();
    return { collectionId: this.connection.id, role: this.role(), displayName: this.connection.displayName, operations: this.operations(), fileActions: this.fileActions(),
      ...(missing.length ? { missingCapabilities: missing } : {}) };
  }

  /** Declared capability groups the current grant lacks (SDK-computed). */
  private missingCapabilities(): string[] {
    if (!this.declaration || !this.current() || this.role() === "viewer") return [];
    return [...(effectiveCapabilities(this.declaration, this.connection)?.missing ?? [])];
  }

  private operations(): CollectionOperation[] {
    const viewer = this.role() === "viewer";
    const granted = new Set(this.client.hello.grant.capabilities.filter((capability) => !viewer || capability === "collection.read"));
    return [...new Set(Object.entries(CAPABILITY_OPERATIONS).flatMap(([capability, operations]) => granted.has(capability) ? operations : []))];
  }

  /** Never widened: only an explicit file action in the grant is reported. */
  private fileActions(): string[] {
    const viewer = this.role() === "viewer";
    return (this.connection.files.grant?.actions ?? []).filter((action) => !viewer || action === "list" || action === "read");
  }

  private role(): "owner" | "editor" | "viewer" {
    if (this.client.status.incidents.some((incident) => incident.kind === "read_only")) return "viewer";
    // The beta.141 SDK pin does not type API 1.3 status yet. Remove the
    // intersection when the SDK containing the live-grant codec is pinned.
    const status = this.client.status as wire.SyncStatus & { grant?: wire.GrantInfo };
    if (this.membershipDowngrade) return "viewer";
    if (status.grant) return status.grant.role;
    if (this.client.hello.grant.role === "viewer") return "viewer";
    return this.membershipRole() ?? this.client.hello.grant.role;
  }

  private membershipRole() {
    return this.application.getSnapshot?.().collections.find((entry) => entry.collectionId === this.connection.id)?.role;
  }

  private async checkWritable(): Promise<void> {
    this.check();
    if (this.role() === "viewer") throw new MdbaseError({
      code: "forbidden", recovery: "none", reason: "read_only",
      message: t`You have view access, so changes can't be saved.`
    });
  }

  private current(): boolean { return !this.disposed && this.connection.isCurrent(); }

  private check(): void {
    if (!this.current()) throw new MdbaseError({ code: "cancelled", recovery: "none", message: t`This collection is no longer open in mdbase editor.` });
  }

  private signal(extra?: AbortSignal): AbortSignal {
    this.check();
    extra?.throwIfAborted();
    return AbortSignal.any([...(extra ? [extra] : []), AbortSignal.timeout(45_000)]);
  }
}

function collectionFile(file: wire.FileView): CollectionFile {
  if (!file.digest.startsWith("sha256:")) throw new Error(t`The collection returned a file without its content digest.`);
  return {
    fileId: file.id,
    path: file.path,
    revision: file.digest,
    contentDigest: file.digest as `sha256:${string}`,
    size: file.size,
    mediaClass: file.media,
    ...(file.mediaType === undefined ? {} : { mediaType: file.mediaType }),
    ...(file.contentProfile === undefined ? {} : { contentProfile: file.contentProfile }),
    confirmedSeq: file.confirmedSeq,
    // Consumers treat an unparsable time as unknown; no time is invented.
    modifiedAt: file.mtime === undefined ? "" : new Date(file.mtime).toISOString()
  };
}

function uniquePaths(values: ReadonlyArray<{ path: string }>): string[] {
  return [...new Set(values.map((value) => value.path))];
}

function unsupported(message: string): MdbaseError {
  return new MdbaseError({ code: "invalid_request", recovery: "fix_request", reason: "unsupported", message });
}

function typeDescriptor(type: wire.TypeSummary): EditorCollectionDescription["types"][number] {
  const definition = jsonObject(type.definition);
  const description = definition?.description;
  const collection = jsonObject(definition?.collection);
  const lifecycle = jsonObject(definition?.lifecycle);
  return {
    name: type.name,
    path: type.path,
    ...(type.version === undefined ? {} : { version: type.version }),
    ...(type.revision === undefined ? {} : { revision: type.revision }),
    ...(typeof description === "string" ? { description } : {}),
    ...(definition ? { definition } : {}),
    schema: jsonObject(type.schema) ?? {},
    ...(collection ? { collection } : {}),
    ...(lifecycle ? { lifecycle } : {}),
    extensions: jsonObject(definition?.extensions) ?? {}
  };
}

function jsonObject(value: unknown): JsonObject | undefined {
  if (value === undefined || value === null) return undefined;
  const plainValue = value instanceof Map ? toPlain(value as wire.Value) : value;
  return plainValue && typeof plainValue === "object" && !Array.isArray(plainValue) ? plainValue as JsonObject : undefined;
}

/** The editor's assessment shape from the SDK plan (no contract setups). */
function assessmentOf(plan: TypePackPlan): TypePackAssessment {
  return {
    status: plan.status,
    applicable: plan.canApply,
    assessmentDigest: plan.digest,
    ...(plan.current ? { current: plan.current } : {}),
    desired: plan.desired,
    resources: plan.resources.map((resource) => ({ ...resource, digest: resource.digest ?? "" })),
    lock: { target: "mdbase.lock.yaml", action: plan.lock.action, digest: plan.lock.digest },
    contractSetups: { choices: [], resources: [] }
  };
}
