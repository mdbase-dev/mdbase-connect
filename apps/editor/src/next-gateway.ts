import type { CollectionDescription, CollectionTypeDescriptor, DeletePreflightResult, JsonObject, MdbaseDiagnostic, MdbaseFileSource, PendingMutationSummary, RenamePreflightResult, TypePackAssessment } from "@mdbase-dev/connect";
import type { MdbaseRecordChange } from "@mdbase-dev/connect/advanced";
import { connect, mdbaseError, MdbaseError, toPlain, type ConflictEntry, type ConflictValue, type Connector, type FileView, type Include, type MdbaseClient, type PlainValue, type RecordView, type UpdateInput, type Write } from "@mdbase-dev/sdk";
import type {
  CollectionAuthorizationTarget,
  CollectionConflict,
  CollectionHold,
  CollectionFile,
  CollectionGateway,
  CollectionSessionSnapshot,
  ConnectionSummary,
  CreateNoteInput,
  DeletePreflight,
  FileListRequest,
  FileReadRequest,
  FileUploadRequest,
  HoldResolution,
  MutationOperationOptions,
  NoteDocument,
  NoteMutationProgress,
  NoteObservation,
  RenamePreflight,
  SyncAttention,
  TypeDocument,
  TypePackApplyResult
} from "./model";
import { persistedBody } from "./note";
import { connectFailureFrom, isNextError, isWaitingForDevice, nextErrorMessage, notAvailable, toConnectError, WAITING_FOR_DEVICE } from "./next-errors";
import { NextNoteObservation, NOTE_ORDER, plainFrontmatter } from "./next-observation";

/**
 * Where a NextCollectionGateway gets its replica connection. The relay source
 * wraps the (proposed) control plane; the demo source wraps a MemoryReplica.
 */
export interface NextGatewaySource {
  /** A connector for the selected collection, or `null` when consent is needed first. */
  open(): Promise<{ connector: Connector; displayName?: string } | null>;
  authorize?(): Promise<void>;
  forget?(collectionId: string): void;
}

/** Point reads of an opened note: the body, plus effective frontmatter for titles. */
const NOTE_INCLUDE: Include = { body: true, effective: true };
/** Recently read record views, by revision: the `base` of field-level updates. */
const SEEN_LIMIT = 256;

/**
 * The editor's CollectionGateway on the mdbase-next replica client API
 * (`@mdbase-dev/sdk`). Opt-in via `?backend=next` / `?backend=next-demo`; the
 * Connect gateway stays the default.
 */
export class NextCollectionGateway implements CollectionGateway {
  private client?: MdbaseClient;
  private connecting?: Promise<CollectionSessionSnapshot>;
  private waiting = false;
  private readonly lifetime = new AbortController();
  private snapshot: CollectionSessionSnapshot = { status: "unselected", connections: [] };
  private displayName?: string;
  /** From `hello`; kept so summaries work while the link reconnects. */
  private hello?: { collection: string; capabilities: string[]; version: string };
  private readonly sessionListeners = new Set<(snapshot: CollectionSessionSnapshot) => void>();
  private readonly problemListeners = new Set<(message: string) => void>();
  private readonly seen = new Map<string, RecordView>();
  private readonly unknown = new Map<string, PendingMutationSummary & { path: string }>();

  constructor(private readonly source: NextGatewaySource, private readonly app = { name: "dev.mdbase.editor", version: "0.1.0" }) {}

  // ------------------------------------------------------------ session

  sessionSnapshot(): CollectionSessionSnapshot {
    return this.snapshot;
  }

  startSession(): Promise<CollectionSessionSnapshot> {
    // While waiting for a device, the first attempt keeps connecting in the background.
    if (this.client || this.waiting) return Promise.resolve(this.snapshot);
    return this.connecting ??= this.connect().finally(() => { this.connecting = undefined; });
  }

  private async connect(): Promise<CollectionSessionSnapshot> {
    let opened: Awaited<ReturnType<NextGatewaySource["open"]>>;
    try {
      opened = await this.source.open();
    } catch (error) {
      return this.setSnapshot(this.failed(error));
    }
    if (!opened) {
      return this.setSnapshot({ status: "unavailable", collectionId: "", reason: "not_authorized", connections: [] });
    }
    this.displayName = opened.displayName;
    let waiting!: (snapshot: CollectionSessionSnapshot) => void;
    const firstWait = new Promise<CollectionSessionSnapshot>((resolve) => { waiting = resolve; });
    const connected = connect({
      app: this.app,
      connector: opened.connector,
      waitForDevice: true,
      // An end-to-end collection with no device online: wait, don't fail.
      signal: this.lifetime.signal,
      onWaiting: () => {
        if (this.waiting) return;
        this.waiting = true;
        waiting(this.setSnapshot({ status: "start_failed", problem: { message: WAITING_FOR_DEVICE, recovery: "retry" }, connections: [] }));
      }
    }).finally(() => { this.waiting = false; }).then((client) => {
      this.client = client;
      const hello = client.hello;
      this.hello = { collection: client.collection, capabilities: hello.grant.capabilities, version: `${hello.version.major}.${hello.version.minor}` };
      client.onLink(() => this.setSnapshot(this.readySnapshot()));
      return this.setSnapshot(this.readySnapshot());
    }, (error: unknown) => this.setSnapshot(this.failed(error)));
    return Promise.race([connected, firstWait]);
  }

  private failed(error: unknown): CollectionSessionSnapshot {
    if (isNextError(error) && (error.code === "unauthenticated" || error.code === "forbidden")) {
      return { status: "unavailable", collectionId: "", reason: "authorization_lost", connections: [] };
    }
    const message = isNextError(error) ? nextErrorMessage(error) : error instanceof Error ? error.message : String(error);
    return { status: "start_failed", problem: { message, recovery: isWaitingForDevice(error) ? "retry" : "contact_support" }, connections: [] };
  }

  private readySnapshot(): CollectionSessionSnapshot {
    const connection = this.summary();
    return { status: "ready", connection, connections: [connection] };
  }

  private summary(): ConnectionSummary {
    const hello = this.hello;
    if (!hello) throw new Error("Choose a collection before editing notes.");
    const capabilities = new Set(hello.capabilities);
    const operations: string[] = ["describe", "read", "query", "validate"];
    if (capabilities.has("records.create")) operations.push("create");
    if (capabilities.has("records.edit")) operations.push("update", "rename");
    if (capabilities.has("records.delete")) operations.push("delete");
    // Type definitions and type packs have no replica-client-api methods yet.
    return {
      collectionId: hello.collection,
      displayName: this.displayName ?? "mdbase-next collection",
      operations,
      authorityKind: "connector",
      fileActions: capabilities.has("files.write") ? ["read", "add"] : ["read"]
    };
  }

  private setSnapshot(snapshot: CollectionSessionSnapshot): CollectionSessionSnapshot {
    this.snapshot = snapshot;
    for (const listener of this.sessionListeners) listener(snapshot);
    return snapshot;
  }

  onSessionChange(listener: (snapshot: CollectionSessionSnapshot) => void): () => void {
    this.sessionListeners.add(listener);
    listener(this.snapshot);
    return () => { this.sessionListeners.delete(listener); };
  }

  onBackgroundProblem(listener: (message: string) => void): () => void {
    this.problemListeners.add(listener);
    return () => { this.problemListeners.delete(listener); };
  }

  selectConnection(collectionId: string): ConnectionSummary {
    if (this.snapshot.status !== "ready" || this.snapshot.connection.collectionId !== collectionId) {
      throw new Error("Only the collection this mdbase-next session opened is available.");
    }
    return this.snapshot.connection;
  }

  /** Direct (loopback) access is a Connect concept; the SDK picks its transport. */
  async checkDirectAccess(): Promise<ConnectionSummary | null> { return null; }
  async requestDirectAccess(): Promise<ConnectionSummary | null> { return null; }

  async authorize(_target: CollectionAuthorizationTarget): Promise<void> {
    if (!this.source.authorize) throw notAvailable("Choosing another collection");
    await this.source.authorize();
    if (!this.client) await this.startSession();
  }

  forgetConnection(collectionId: string): void {
    this.source.forget?.(collectionId);
  }

  /** Closes the replica session (tests and collection switches). */
  close(): void {
    this.lifetime.abort();
    this.client?.close();
    this.client = undefined;
    this.setSnapshot({ status: "destroyed", connections: [] });
  }

  // ------------------------------------------------------------ reads

  async describe(): Promise<CollectionDescription> {
    const client = this.requireClient();
    const raw = toPlain(await this.guard(() => client.describe())) as JsonObject | null;
    const summary = this.summary();
    return {
      protocolVersion: 1,
      collectionId: client.collection,
      displayName: summary.displayName ?? "mdbase-next collection",
      specVersion: typeof raw?.spec_version === "string" ? raw.spec_version : `replica API ${this.hello?.version ?? "1"}`,
      operations: summary.operations as CollectionDescription["operations"],
      // The replica's local view version, the same cursor space as `changes`. The
      // editor never follows the feed from here: live queries and the
      // observation's own watchChanges cursor (from the live result's asOf) do.
      changeCursor: await this.viewVersion(),
      types: typeDescriptors(raw?.types),
      contracts: []
    };
  }

  private async viewVersion(): Promise<number> {
    const client = this.requireClient();
    return (await this.guard(() => client.query({ limit: 1 }))).asOf;
  }

  observe(): NoteObservation {
    return new NextNoteObservation(this.requireClient());
  }

  async mostRecentNote(): Promise<string | undefined> {
    const client = this.requireClient();
    const page = await this.guard(() => client.query({ order_by: NOTE_ORDER, limit: 1 }));
    return page.records[0]?.path;
  }

  /** One note with its body: the only body read the editor makes. */
  async read(path: string): Promise<NoteDocument> {
    const client = this.requireClient();
    return this.document(await this.guard(() => client.get({ path }, NOTE_INCLUDE)));
  }

  async validate(path: string): Promise<MdbaseDiagnostic[]> {
    const client = this.requireClient();
    const view = await this.guard(() => client.get({ path }, { diagnostics: true }));
    return (view.diagnostics ?? []).map((issue) => ({
      severity: issue.severity, code: issue.code, message: issue.message, path: view.path
    }));
  }

  // ------------------------------------------------------------ writes

  pendingNoteMutations(): readonly PendingMutationSummary[] {
    return [...this.unknown.values()];
  }

  /** Outcome-unknown writes: ask the replica for the receipt, then re-read. */
  async recoverNoteMutation(requestId: string): Promise<NoteDocument> {
    const pending = this.unknown.get(requestId);
    if (!pending) throw new Error("The exact interrupted note operation is unavailable. No new write was attempted.");
    const client = this.requireClient();
    const receipt = await this.guard(() => client.receipt(requestId));
    if (receipt.state === "unknown") throw toConnectError(mdbaseError("outcome_unknown", "the outcome is still unknown"), requestId);
    this.unknown.delete(requestId);
    if (receipt.state === "rejected" && receipt.problem) throw toConnectError(new MdbaseError(receipt.problem));
    return this.read(pending.path);
  }

  async create(input: CreateNoteInput): Promise<NoteDocument> {
    const client = this.requireClient();
    return this.written(input.path, "create", () => client.create({
      path: input.path,
      ...(input.type ? { type: input.type } : {}),
      frontmatter: input.properties as Record<string, PlainValue>,
      body: input.titleField ? input.body : persistedBody(input.title, input.body, { kind: "heading" })
    }, { include: NOTE_INCLUDE }));
  }

  async restore(document: NoteDocument): Promise<NoteDocument> {
    const client = this.requireClient();
    return this.written(document.path, "create", () => client.create({
      path: document.path,
      frontmatter: document.frontmatter as Record<string, PlainValue>,
      body: document.body ?? ""
    }, { include: NOTE_INCLUDE }));
  }

  /**
   * A field-level intent against the view the editor read: the SDK sends `base`
   * values and body edits so concurrent edits merge. Returns the optimistic
   * record now; confirmation (or rejection) arrives later as record state.
   */
  async update(base: NoteDocument, change: MdbaseRecordChange): Promise<NoteDocument> {
    const seen = await this.view(base.path, base.revision);
    return this.written(base.path, "update", () => this.requireClient().update(seen, intent(change.patch, change.body), { include: NOTE_INCLUDE }));
  }

  async updateProperties(path: string, patch: JsonObject, revision: string): Promise<NoteDocument> {
    const seen = await this.view(path, revision);
    return this.written(path, "update", () => this.requireClient().update(seen, intent(patch), { include: NOTE_INCLUDE }));
  }

  async updateDocument(path: string, document: string, revision: string): Promise<NoteDocument> {
    const seen = await this.view(path, revision);
    return this.written(path, "update", () => this.requireClient().replaceDocument(seen, document, { include: NOTE_INCLUDE }));
  }

  /** The replica rewrites references during the rename; there is no dry run yet. */
  async preflightRename(from: string, to: string): Promise<RenamePreflight> {
    const operation: RenamePreflightResult = { from, to, dryRun: true, wouldRename: true };
    return { affectedPaths: [], warnings: ["Linked notes can’t be previewed with the mdbase-next backend yet. Links are still updated."], operation };
  }

  /**
   * One rename intent. Progress follows its receipt: `applying` (cancellable)
   * until the replica captures it, `submitted` (no longer cancellable) when the
   * write is pending, and `completed` once confirmed. A rejection throws.
   */
  async rename(from: string, to: string, revision: string, updateRefs = true, options: MutationOperationOptions = {}): Promise<NoteDocument> {
    const progress = mutationProgress("rename", options.onProgress);
    progress("applying", true);
    const seen = await this.guard(() => this.view(from, revision));
    return this.written(to, "rename", () => this.requireClient().rename(seen, to, {
      updateRefs, include: NOTE_INCLUDE, ...(options.signal ? { signal: options.signal } : {})
    }), progress);
  }

  /** No broken-link preview yet. */
  async preflightDelete(path: string): Promise<DeletePreflight> {
    const operation: DeletePreflightResult = { path, deleted: false, dryRun: true, wouldDelete: true };
    return { brokenLinkPaths: [], operation };
  }

  /** One delete intent, with the same receipt-driven progress as `rename`. */
  async delete(path: string, revision: string, options: MutationOperationOptions = {}): Promise<void> {
    const progress = mutationProgress("delete", options.onProgress);
    progress("applying", true);
    const seen = await this.guard(() => this.view(path, revision));
    const client = this.requireClient();
    const write = await this.guard(() => client.delete(seen, options.signal ? { signal: options.signal } : {}));
    await this.settled(write, path, "delete", progress);
    this.forget(path);
  }

  // ------------------------------------------------------------ holds and conflicts (§8)

  /**
   * Holds (files the replica keeps back until the user decides) and recorded
   * merge conflicts, pushed. Held notes also carry `hold` in the list, so an
   * edit is never silently stuck.
   */
  onSyncAttention(listener: (attention: SyncAttention) => void): () => void {
    const client = this.requireClient();
    let holds: CollectionHold[] = [];
    let conflicts: CollectionConflict[] = [];
    let active = true;
    let generation = 0;
    const publish = () => { if (active) listener({ holds, conflicts }); };
    const stopHolds = client.onHolds((next) => {
      holds = next.map((hold) => ({
        id: hold.id, path: hold.path, reason: hold.reason, since: hold.since, saves: hold.saves, hasTheirs: hold.theirs !== undefined
      }));
      publish();
    });
    const stopConflicts = client.onConflicts((entries) => {
      const current = ++generation;
      this.conflicts = new Map(entries.map((entry) => [conflictKey(entry), entry]));
      void Promise.all(entries.map(async (entry) => describeConflict(entry, await this.recordPath(entry.conflict.id)))).then((described) => {
        if (current !== generation) return;
        conflicts = described;
        publish();
      });
    });
    return () => { active = false; stopHolds(); stopConflicts(); };
  }

  async resolveHold(id: string, how: HoldResolution, use?: string): Promise<void> {
    const client = this.requireClient();
    const write = await this.guard(() => client.resolveHold(id, how, use));
    await this.settled(write, id, how === "delete" ? "delete" : "update");
  }

  async resolveConflict(key: string, choice: "kept" | "lost"): Promise<void> {
    const entry = this.conflicts.get(key);
    if (!entry) throw new Error("This conflict was already resolved.");
    const client = this.requireClient();
    const { conflict } = entry;
    let write: Write;
    if (choice === "kept") write = await this.guard(() => client.dismissConflict(entry));
    else if (conflict.kind === "field" && conflict.field && conflict.lost.form === "value") {
      const field = conflict.field;
      const value = toPlain(conflict.lost.value) as PlainValue;
      write = await this.guard(() => client.resolveConflict(entry, field, value));
    } else if (conflict.kind === "body" && conflict.lost.form === "text") {
      const body = conflict.lost.text;
      [write] = await this.guard(() => client.submit([
        { kind: "update", id: conflict.id, body },
        { kind: "conflict_dismiss", mutation: entry.mutation, record: conflict.id }
      ])) as [Write];
    } else throw notAvailable("Restoring this kind of conflict");
    await this.settled(write, this.paths.get(conflict.id) ?? conflict.id, "update");
  }

  private conflicts = new Map<string, ConflictEntry>();
  private paths = new Map<string, string>();

  private async recordPath(id: string): Promise<string | undefined> {
    const known = this.paths.get(id);
    if (known) return known;
    const view = await this.requireClient().find(id).catch(() => null);
    if (view) this.paths.set(id, view.path);
    return view?.path;
  }

  // ------------------------------------------------------------ files

  async listFiles({ signal, onProgress }: FileListRequest = {}): Promise<CollectionFile[]> {
    const client = this.requireClient();
    const files: CollectionFile[] = [];
    let published = 0;
    try {
      for await (const view of client.files.list({ pageSize: 1_000, ...(signal ? { signal } : {}) })) {
        files.push(fileDescriptor(view));
        if (files.length - published >= 100) {
          published = files.length;
          onProgress?.({ files: [...files], complete: false });
        }
      }
    } catch (error) {
      throw connectFailureFrom(error);
    }
    onProgress?.({ files: [...files], complete: true });
    return files;
  }

  async readFile(file: CollectionFile, { signal, onProgress }: FileReadRequest = {}): Promise<Blob> {
    const client = this.requireClient();
    const current = await this.guard(() => client.files.get(file.fileId, signal));
    if (current.digest !== file.revision) throw new Error("This file changed. Reload its preview.");
    const bytes = await this.guard(() => client.files.download(current, {
      ...(signal ? { signal } : {}),
      onProgress: (progress) => onProgress?.({ phase: "downloading", transferredBytes: progress.done, totalBytes: progress.total })
    }));
    return new Blob([bytes as BlobPart], file.mediaType ? { type: file.mediaType } : {});
  }

  async uploadFile(path: string, source: MdbaseFileSource, { signal, onProgress, transferId }: FileUploadRequest = {}): Promise<CollectionFile> {
    const client = this.requireClient();
    const bytes = ArrayBuffer.isView(source) && !(source instanceof Uint8Array)
      ? new Uint8Array(source.buffer, source.byteOffset, source.byteLength)
      : source as Blob | ArrayBuffer | Uint8Array;
    const write = await this.guard(() => client.files.upload(path, bytes, {
      ...(signal ? { signal } : {}),
      ...(transferId && UUID.test(transferId) ? { transferId } : {}),
      onProgress: (progress) => onProgress?.({ phase: "uploading", transferredBytes: progress.done, totalBytes: progress.total })
    }));
    this.track(write, path, "create");
    return fileDescriptor(await this.guard(() => client.files.get({ path }, signal)));
  }

  // ------------------------------------------------------------ not in the replica client API yet

  async readType(name: string): Promise<TypeDocument> { throw notAvailable(`Reading the type “${name}”`); }
  async createType(): Promise<TypeDocument> { throw notAvailable("Creating types"); }
  async updateType(): Promise<TypeDocument> { throw notAvailable("Editing types"); }
  async assessTypePack(): Promise<TypePackAssessment> { throw notAvailable("Installing type packs"); }
  async applyTypePack(): Promise<TypePackApplyResult> { throw notAvailable("Installing type packs"); }

  // ------------------------------------------------------------ internals

  private requireClient(): MdbaseClient {
    if (!this.client) throw new Error("Choose a collection before editing notes.");
    return this.client;
  }

  private async guard<Value>(operation: () => Promise<Value>, mutationId?: string): Promise<Value> {
    try {
      return await operation();
    } catch (error) {
      throw connectFailureFrom(error, mutationId);
    }
  }

  private remember(view: RecordView): void {
    this.seen.delete(view.revision);
    this.seen.set(view.revision, view);
    while (this.seen.size > SEEN_LIMIT) this.seen.delete(this.seen.keys().next().value!);
  }

  private forget(path: string): void {
    for (const [revision, view] of this.seen) if (view.path === path) this.seen.delete(revision);
  }

  /** The view an edit was made from, so the SDK can send its base values. */
  private async view(path: string, revision: string): Promise<RecordView> {
    const seen = this.seen.get(revision);
    if (seen && seen.path === path) return seen;
    const client = this.requireClient();
    const current = await this.guard(() => client.get({ path }, NOTE_INCLUDE));
    if (current.revision !== revision) {
      throw toConnectError(mdbaseError("conflict", "the note changed since it was read", "revision"));
    }
    this.remember(current);
    return current;
  }

  private document(view: RecordView): NoteDocument {
    this.remember(view);
    const frontmatter = plainFrontmatter(view.frontmatter);
    return {
      path: view.path,
      revision: view.revision,
      types: view.types,
      frontmatter,
      effectiveFrontmatter: view.effective ? plainFrontmatter(view.effective) : frontmatter,
      ...(view.body === undefined ? {} : { body: view.body }),
      ...(view.document === undefined ? {} : { document: view.document }),
      file: { path: view.path }
    };
  }

  /** Submit, surface an immediate rejection inline, and return the optimistic record. */
  private async written(path: string, operation: PendingMutationSummary["operation"], submit: () => Promise<Write>, progress?: Progress): Promise<NoteDocument> {
    const write = await this.guard(submit);
    await this.settled(write, path, operation, progress);
    const view = write.records.find((record) => record.path === path) ?? write.records[0];
    if (view && view.body !== undefined) return this.document(view);
    return this.read(view?.path ?? path);
  }

  private async settled(write: Write, path: string, operation: PendingMutationSummary["operation"], progress?: Progress): Promise<void> {
    if (write.state === "rejected" || write.state === "unknown") {
      try {
        await write.confirmed;
      } catch (error) {
        throw connectFailureFrom(error, write.mutationId);
      }
    }
    if (progress) {
      if (write.state === "pending") progress("submitted", false);
      write.confirmed.then(() => progress("completed", false), () => undefined);
    }
    this.track(write, path, operation);
  }

  /** Later rejections and unknown outcomes surface as notices and recovery toasts. */
  private track(write: Write, path: string, operation: PendingMutationSummary["operation"]): void {
    write.confirmed.catch((error: unknown) => {
      if (isNextError(error) && error.code === "outcome_unknown") {
        this.unknown.set(write.mutationId, {
          requestId: write.mutationId, operation, fingerprint: write.mutationId,
          status: "outcome_unknown", createdAt: new Date().toISOString(), path
        });
      }
      const message = isNextError(error) ? nextErrorMessage(error) : String(error);
      for (const listener of this.problemListeners) listener(`“${path}” wasn’t saved: ${message}`);
    });
  }
}

function conflictKey(entry: ConflictEntry): string {
  return `${entry.mutation}/${entry.conflict.id}/${entry.conflict.field ?? entry.conflict.kind}`;
}

function conflictText(value: ConflictValue): string {
  switch (value.form) {
    case "missing": return "(not set)";
    case "deleted": return "(deleted)";
    case "text": return value.text.length > 120 ? `${value.text.slice(0, 117)}…` : value.text;
    case "blob": return "(file contents)";
    case "value": return JSON.stringify(toPlain(value.value));
  }
}

function describeConflict(entry: ConflictEntry, path: string | undefined): CollectionConflict {
  const { conflict } = entry;
  return {
    key: conflictKey(entry),
    recordId: conflict.id,
    ...(path ? { path } : {}),
    kind: conflict.kind,
    ...(conflict.field ? { field: conflict.field } : {}),
    kept: conflictText(conflict.kept),
    lost: conflictText(conflict.lost),
    restorable: (conflict.kind === "field" && conflict.lost.form === "value") || (conflict.kind === "body" && conflict.lost.form === "text")
  };
}

type Progress = (state: NoteMutationProgress["state"], cancellable: boolean) => void;

function mutationProgress(operation: "rename" | "delete", report?: (progress: NoteMutationProgress) => void): Progress {
  const started = Date.now();
  return (state, cancellable) => report?.({
    operation, state, cancellable, resumed: false,
    completedUnits: state === "completed" || state === "submitted" ? 1 : 0,
    elapsedMs: Date.now() - started
  });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** `null` in an editor patch removes the key. */
function intent(patch: JsonObject = {}, body?: string): UpdateInput {
  const set: Record<string, PlainValue> = {};
  const unset: string[] = [];
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) unset.push(key);
    else set[key] = value as PlainValue;
  }
  return {
    ...(Object.keys(set).length ? { patch: set } : {}),
    ...(unset.length ? { unset } : {}),
    ...(body === undefined ? {} : { body })
  };
}

function fileDescriptor(view: FileView): CollectionFile {
  return {
    fileId: view.id,
    path: view.path,
    revision: view.digest,
    contentDigest: view.digest as `sha256:${string}`,
    size: view.size,
    mediaClass: view.media,
    // FileView has no modification time yet.
    modifiedAt: ""
  };
}

/** `describe` lists types as names or catalog entries; schemas aren't exposed yet. */
function typeDescriptors(value: unknown): CollectionTypeDescriptor[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): CollectionTypeDescriptor[] => {
    if (typeof entry === "string") return [{ name: entry, schema: {}, extensions: {} }];
    if (entry && typeof entry === "object" && typeof (entry as JsonObject).name === "string") {
      const type = entry as JsonObject;
      return [{
        name: type.name as string,
        ...(typeof type.description === "string" ? { description: type.description } : {}),
        schema: (type.schema && typeof type.schema === "object" ? type.schema : {}) as JsonObject,
        extensions: {}
      }];
    }
    return [];
  });
}
