import {
  MdbaseError,
  toPlain,
  type MdbaseApplication,
  type MdbaseApplicationConnection,
  type MdbaseClient,
  type wire
} from "@mdbase-dev/sdk";
import type {
  CollectionDescription,
  DataContractSelector,
  JsonObject,
  MdbaseDiagnostic,
  MdbaseFileSource,
  PendingMutationSummary
} from "@mdbase-dev/connect";
import type { MdbaseRecordChange } from "@mdbase-dev/connect/advanced";
import { NativeNoteObservation } from "./native-note-observation";
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

type CollectionOperation = CollectionDescription["operations"][number];

/** Editor operations a native v2 capability grants. Type definitions are not
 * mapped: the public SDK has no type-document create (name/path derivation)
 * and setup belongs to `application.configure()`, so install/manage stay off. */
const CAPABILITY_OPERATIONS: Readonly<Record<string, readonly CollectionOperation[]>> = {
  "collection.read": ["describe", "changes", "read", "query", "validate", "read_type"],
  "records.create": ["create"],
  "records.edit": ["update", "rename"],
  "records.delete": ["delete"]
};

/** The editor's collection gateway over one borrowed public SDK connection.
 * `SdkEditorRoot` owns lifecycle, selection and readiness; this adapter never
 * closes the client, never retries a write under a fresh identity, and stops
 * at every await once the original connection is no longer current. */
export class NativeEditorGateway implements CollectionGateway {
  private readonly client: MdbaseClient;
  private readonly records: NextEditorRecords;
  private readonly listeners = new Set<(snapshot: CollectionSessionSnapshot) => void>();
  private disposed = false;

  constructor(private readonly application: MdbaseApplication, private readonly connection: MdbaseApplicationConnection) {
    this.client = connection.records;
    if (connection.id !== this.client.collection) throw new Error("The editor requires its original SDK collection client.");
    this.records = new NextEditorRecords(this.client, () => this.current());
  }

  /** Retire this scope. The borrowed client stays open for its SDK owner. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
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
    if (collectionId !== this.connection.id || !this.current()) throw new Error("The selected collection is not ready.");
    return this.summary();
  }

  /** Native connections have no Connect direct-access upgrade. */
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
    const described = await this.client.describe(signal);
    this.check();
    return {
      protocolVersion: 1,
      collectionId: this.connection.id,
      displayName: this.connection.displayName,
      specVersion: described.specVersion,
      operations: this.operations(),
      // Native change cursors are opaque; observe() owns the watch position.
      changeCursor: 0,
      configuration: { settings: toPlain(described.settings) },
      // Native describe has names, paths and contract bindings only.
      typing: "names_only",
      types: described.types.map((type) => ({ name: type.name, path: type.path, schema: {}, extensions: {} })),
      contracts: described.contracts.map((contract) => ({
        contractType: "record",
        id: contract.id,
        version: contract.version,
        digest: contract.digest,
        schema: {},
        implementations: described.types.flatMap((type) => type.implements
          .filter((implementation) => implementation.contract === contract.id && implementation.version === contract.version)
          .map((implementation) => ({
            typeName: type.name,
            typePath: type.path,
            typeVersion: 0,
            digest: "",
            fields: Object.fromEntries(implementation.fields),
            ...(implementation.binding === undefined ? {} : { binding: toPlain(implementation.binding) as JsonObject })
          })))
      }))
    };
  }

  async peopleDirectory(options: { signal?: AbortSignal } = {}) {
    const directory = await this.connection.people.directory({ members: "omit", signal: this.signal(options.signal) });
    this.check();
    return directory;
  }

  async queryContract(contract: DataContractSelector, options: { signal?: AbortSignal } = {}): Promise<Array<{ path: string; values: JsonObject }>> {
    const signal = this.signal(options.signal);
    const records: Array<{ path: string; values: JsonObject }> = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const result = await this.client.queryContract({ id: contract.id, version: contract.version }, { pageSize: 500, signal, ...(cursor ? { cursor } : {}) });
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
        if (cursors.has(cursor)) throw new Error("The collection repeated a query page.");
        cursors.add(cursor);
      } else if (!result.page.complete) throw new Error("The collection did not return every record for this contract.");
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
        if (ids.has(file.id)) throw new Error("The collection listed a file twice.");
        ids.add(file.id);
        files.push(collectionFile(file));
      }
      cursor = page.cursor;
      if (cursor) {
        if (cursors.has(cursor)) throw new Error("The collection repeated a file page.");
        cursors.add(cursor);
        onProgress?.({ files: [...files], complete: false });
      } else if (!page.complete) throw new Error("The collection did not return every file.");
    } while (cursor);
    onProgress?.({ files: [...files], complete: true });
    return files;
  }

  async readFile(file: CollectionFile, { signal, onProgress }: FileReadRequest = {}): Promise<Blob> {
    const current = this.signal(signal);
    const view = await this.connection.files.get(file.fileId, current);
    this.check();
    if (view.digest !== file.revision) throw new Error("This file changed. Reload its preview.");
    const bytes = await this.connection.files.download(view, {
      signal: current,
      ...(onProgress ? { onProgress: (progress: wire.TransferProgress) => onProgress({ phase: "downloading", transferredBytes: progress.done, totalBytes: progress.total }) } : {})
    });
    this.check();
    return new Blob([bytes as BlobPart]);
  }

  async uploadFile(path: string, source: MdbaseFileSource, { signal, onProgress, transferId }: FileUploadRequest = {}): Promise<CollectionFile> {
    const current = this.signal(signal);
    // Unknown/older grants stay closed. The native replica checks folder scope
    // and every actual operation; this UI gate never grants authority.
    if (!this.connection.files.grant?.actions.includes("add"))
      throw unsupported("Attaching files is not available for this collection in mdbase editor yet.");
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
        throw new MdbaseError({ code: "outcome_unknown", recovery: "resolve_outcome", message: "This file upload is not confirmed. Resolve its original operation before trying again." });
      const file = await this.connection.files.get(write.fileId, current);
      this.check();
      if (file.id !== write.fileId || file.confirmedSeq !== receipt.seq || file.hold || file.state === "pending_upload")
        throw new MdbaseError({ code: "outcome_unknown", recovery: "resolve_outcome", message: "The current file does not confirm this upload. Resolve its original operation before trying again." });
      return collectionFile(file);
    } catch (error) {
      // Receipt/readback/currentness failures retain the same SDK mutation ID.
      // Upload submission errors already carry it and are passed through above.
      throw new MdbaseError(error instanceof MdbaseError ? error.toProblem()
        : { code: "outcome_unknown", recovery: "resolve_outcome", message: "The file upload outcome is unknown." },
      { mutationId: write.mutationId, cause: error });
    }
  }

  create(input: CreateNoteInput): Promise<NoteDocument> { return this.records.create(input); }
  restore(document: NoteDocument): Promise<NoteDocument> { return this.records.restore(document); }
  update(base: NoteDocument, change: MdbaseRecordChange): Promise<NoteDocument> { return this.records.update(base, change); }
  updateProperties(path: string, patch: JsonObject, revision: string): Promise<NoteDocument> { return this.records.updateProperties(path, patch, revision); }
  updateDocument(path: string, document: string, revision: string): Promise<NoteDocument> { return this.records.updateDocument(path, document, revision); }

  async preflightRename(from: string, to: string, revision: string): Promise<RenamePreflight> {
    const result = await this.records.preflightRename(from, to, revision);
    const affectedPaths = uniquePaths(result.rewrites);
    const brokenPaths = uniquePaths(result.broken);
    return {
      affectedPaths,
      warnings: brokenPaths.map((path) => `A link in ${path} will stay broken.`),
      operation: { from, to, dryRun: true, wouldRename: true, referencesAffected: result.rewrites.map((rewrite) => ({ path: rewrite.path, ...(rewrite.field ? { field: rewrite.field } : {}) })) }
    };
  }

  rename(from: string, to: string, revision: string, updateRefs = true, options: MutationOperationOptions = {}): Promise<NoteDocument> {
    return this.records.rename(from, to, revision, updateRefs, options.signal);
  }

  async preflightDelete(path: string, revision: string): Promise<DeletePreflight> {
    const result = await this.records.preflightDelete(path, revision);
    const brokenLinkPaths = uniquePaths(result.broken);
    return { brokenLinkPaths, operation: { path, deleted: false, dryRun: true, wouldDelete: true, brokenLinks: brokenLinkPaths.map((broken) => ({ path: broken })) } };
  }

  delete(path: string, revision: string, options: MutationOperationOptions = {}): Promise<void> {
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
    if (!type) throw new MdbaseError({ code: "not_found", recovery: "refresh", message: `The type ${name} is not defined in this collection.` });
    const resource = await this.client.resources.get(type.path, signal);
    this.check();
    if (resource.text === undefined) throw unsupported("The collection did not return this type definition's source.");
    return { name: type.name, path: resource.path, revision: resource.revision, document: resource.text };
  }

  async createType(): Promise<TypeDocument> { throw typeManagementUnavailable(); }
  async updateType(): Promise<TypeDocument> { throw typeManagementUnavailable(); }
  async assessTypePack(): Promise<never> { throw setupUnavailable(); }
  async applyTypePack(): Promise<TypePackApplyResult> { throw setupUnavailable(); }

  private summary(): ConnectionSummary {
    return { collectionId: this.connection.id, displayName: this.connection.displayName, operations: this.operations(), fileActions: this.fileActions() };
  }

  private operations(): CollectionOperation[] {
    const granted = new Set(this.client.hello.grant.capabilities);
    return [...new Set(Object.entries(CAPABILITY_OPERATIONS).flatMap(([capability, operations]) => granted.has(capability) ? operations : []))];
  }

  /** Never widened: only an explicit file action in the grant is reported. */
  private fileActions(): string[] {
    return [...(this.connection.files.grant?.actions ?? [])];
  }

  private current(): boolean { return !this.disposed && this.connection.isCurrent(); }

  private check(): void {
    if (!this.current()) throw new MdbaseError({ code: "cancelled", recovery: "none", message: "This collection is no longer open in mdbase editor." });
  }

  private signal(extra?: AbortSignal): AbortSignal {
    this.check();
    extra?.throwIfAborted();
    return AbortSignal.any([...(extra ? [extra] : []), AbortSignal.timeout(45_000)]);
  }
}

function collectionFile(file: wire.FileView): CollectionFile {
  if (!file.digest.startsWith("sha256:")) throw new Error("The collection returned a file without its content digest.");
  return {
    fileId: file.id,
    path: file.path,
    revision: file.digest,
    contentDigest: file.digest as `sha256:${string}`,
    size: file.size,
    mediaClass: file.media,
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

function typeManagementUnavailable(): MdbaseError {
  return unsupported("Creating and editing type definitions is not available in mdbase editor for this collection yet.");
}

function setupUnavailable(): MdbaseError {
  return unsupported("Collection setup for mdbase editor runs through the mdbase sign-in setup step.");
}
