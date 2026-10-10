import { MdbaseError, revisionOf, toPlain, type MdbaseClient, type PlainValue, type Write, type wire } from "@mdbase-dev/sdk";
import type { JsonObject } from "@mdbase-dev/connect";
import type { MdbaseRecordChange } from "@mdbase-dev/connect/advanced";
import type { CreateNoteInput, NoteDocument } from "./model";
import { persistedBody } from "./note";

export interface NextEditorPendingMutation {
  mutationId: string;
  operation: "create" | "update" | "rename" | "delete";
  recordId: string;
  createdAt: string;
}

/** Native record operations for the existing note-session boundary. The session
 * store still owns serialization/drafts; this adapter owns no second record index
 * and never reports an optimistic receipt as a saved note. Sign-in owns client. */
export class NextEditorRecords {
  private readonly lifetime = new AbortController();
  private readonly seen = new Map<string, { record: wire.RecordView; bytes: number }>();
  private seenBytes = 0;
  private readonly pending = new Map<string, NextEditorPendingMutation>();

  constructor(private readonly client: MdbaseClient) {}

  async read(path: string, signal?: AbortSignal): Promise<NoteDocument> {
    const current = this.signal(signal);
    const record = await this.client.get({ path }, noteInclude, current);
    current.throwIfAborted();
    return this.remember(record);
  }

  create(input: CreateNoteInput, signal?: AbortSignal): Promise<NoteDocument> {
    const id = crypto.randomUUID();
    return this.write("create", id, current => this.client.create({
      id, path: input.path, ...(input.type ? { type: input.type } : {}),
      frontmatter: input.properties as Record<string, PlainValue>,
      body: input.titleField ? input.body : persistedBody(input.title, input.body, { kind: "heading" }),
    }, current), signal) as Promise<NoteDocument>;
  }

  restore(document: NoteDocument, signal?: AbortSignal): Promise<NoteDocument> {
    if (document.document === undefined) throw unsupported("The original complete note source is unavailable.");
    const id = crypto.randomUUID();
    return this.write("create", id, current => this.client.create({ id, path: document.path, document: document.document }, current), signal) as Promise<NoteDocument>;
  }

  async update(base: NoteDocument, change: MdbaseRecordChange, signal?: AbortSignal): Promise<NoteDocument> {
    const current = this.signal(signal);
    const record = await this.base(base.path, base.revision, current);
    return this.write("update", record.id, options => this.client.update(record, {
      patch: (change.patch ?? {}) as Record<string, PlainValue>,
      ...(change.body === undefined ? {} : { body: change.body }),
      ifRevision: base.revision,
    }, options), current) as Promise<NoteDocument>;
  }

  async updateProperties(path: string, patch: JsonObject, revision: string, signal?: AbortSignal): Promise<NoteDocument> {
    const current = this.signal(signal);
    const record = await this.base(path, revision, current);
    return this.write("update", record.id, options => this.client.update(record, { patch: patch as Record<string, PlainValue>, ifRevision: revision }, options), current) as Promise<NoteDocument>;
  }

  async updateDocument(path: string, document: string, revision: string, signal?: AbortSignal): Promise<NoteDocument> {
    const current = this.signal(signal);
    const record = await this.base(path, revision, current);
    return this.write("update", record.id, options => this.client.replaceDocument(record, document, { ...options, ifRevision: revision }), current) as Promise<NoteDocument>;
  }

  async rename(path: string, to: string, revision: string, updateRefs = true, signal?: AbortSignal): Promise<NoteDocument> {
    const current = this.signal(signal);
    const record = await this.base(path, revision, current);
    return this.write("rename", record.id, options => this.client.rename(record, to, { ...options, updateRefs, ifRevision: revision }), current) as Promise<NoteDocument>;
  }

  async delete(path: string, revision: string, signal?: AbortSignal): Promise<void> {
    const current = this.signal(signal);
    const record = await this.base(path, revision, current);
    await this.write("delete", record.id, options => this.client.delete(record, { ...options, ifRevision: revision }), current);
  }

  async preflightRename(path: string, to: string, revision: string, signal?: AbortSignal): Promise<wire.Preflight> {
    const current = this.signal(signal);
    const record = await this.base(path, revision, current);
    const result = await this.client.preflightRename(record, to, { updateRefs: true });
    current.throwIfAborted();
    return result;
  }

  async preflightDelete(path: string, revision: string, signal?: AbortSignal): Promise<wire.Preflight> {
    const current = this.signal(signal);
    const record = await this.base(path, revision, current);
    const result = await this.client.preflightDelete(record);
    current.throwIfAborted();
    return result;
  }

  pendingMutations(): readonly NextEditorPendingMutation[] { return [...this.pending.values()]; }

  /** Restore only native record mutations whose exact target is unambiguous.
   * Resources/setup batches are not silently converted into note operations. */
  async restorePending(signal?: AbortSignal): Promise<void> {
    const current = this.signal(signal);
    const pending = await this.client.pendingWrites(current);
    current.throwIfAborted();
    for (const mutation of pending) {
      if (mutation.ops.length !== 1) continue;
      const op = mutation.ops[0];
      const operation = op.kind === "document" ? "update" : op.kind;
      if (operation !== "create" && operation !== "update" && operation !== "rename" && operation !== "delete") continue;
      if (!("id" in op)) continue;
      this.pending.set(mutation.receipt.mutation, { mutationId: mutation.receipt.mutation,
        operation, recordId: op.id, createdAt: new Date(mutation.captured).toISOString() });
    }
  }

  async recover(mutationId: string, signal?: AbortSignal): Promise<NoteDocument | undefined> {
    const mutation = this.pending.get(mutationId);
    if (!mutation) throw new Error("The exact interrupted note operation is unavailable. No new write was attempted.");
    return this.confirm(mutation, this.signal(signal));
  }

  dispose(): void { this.lifetime.abort(); this.clearSeen(); }

  private async base(path: string, revision: string, signal: AbortSignal): Promise<wire.RecordView> {
    signal.throwIfAborted();
    const key = JSON.stringify([path, revision]);
    const record = this.seen.get(key)?.record ?? await this.client.get({ path }, noteInclude, signal);
    signal.throwIfAborted();
    if (record.path !== path || record.revision !== revision)
      throw new MdbaseError({ code: "conflict", reason: "revision_mismatch", recovery: "refresh", message: "This note changed after it was opened. Reload before saving." });
    if (record.state.hold || record.state.unresolved)
      throw new MdbaseError({ code: "conflict", reason: "protected_edit", recovery: "resolve_conflict", message: "Resolve this note's protected edit before changing it." });
    completeSource(record);
    return record;
  }

  private async write(operation: NextEditorPendingMutation["operation"], recordId: string,
    submit: (options: { mutationId: string; signal: AbortSignal }) => Promise<Write>, signal?: AbortSignal): Promise<NoteDocument | undefined> {
    const current = this.signal(signal);
    if (this.pending.size) throw new Error("Recover the interrupted note operation before making another change. No new write was attempted.");
    const mutationId = crypto.randomUUID();
    const mutation = { mutationId, operation, recordId, createdAt: new Date().toISOString() };
    this.pending.set(mutationId, mutation);
    // An error code alone does not prove non-capture: even an internal SDK
    // response error can follow an accepted write. Only an exact native receipt
    // can settle this identity, so submission failures retain it for recovery.
    const write = await submit({ mutationId, signal: current });
    current.throwIfAborted();
    if (write.mutationId !== mutationId) throw new Error("The native write changed its mutation identity.");
    return this.confirm(mutation, current);
  }

  private async confirm(mutation: NextEditorPendingMutation, signal: AbortSignal): Promise<NoteDocument | undefined> {
    const receipt = await this.client.awaitReceipt(mutation.mutationId, 30_000, signal);
    signal.throwIfAborted();
    if (receipt.mutation !== mutation.mutationId) throw new Error("The native receipt changed its mutation identity.");
    if (receipt.state === "pending" || receipt.state === "unknown")
      throw new MdbaseError({ code: "outcome_unknown", recovery: "resolve_outcome", message: "This note change is not confirmed. Check the interrupted operation before trying again." });
    if (receipt.state === "rejected") {
      this.pending.delete(mutation.mutationId);
      throw receipt.problem ? new MdbaseError(receipt.problem) : new Error("The note change was rejected.");
    }
    if (receipt.status === "conflicted") {
      this.pending.delete(mutation.mutationId);
      throw new MdbaseError({ code: "conflict", recovery: "resolve_conflict", message: "This note change has a conflict. Resolve it before continuing." });
    }
    if (mutation.operation === "delete") { this.pending.delete(mutation.mutationId); this.clearSeen(); return undefined; }
    const record = await this.client.get(mutation.recordId, noteInclude, signal);
    signal.throwIfAborted();
    if (record.id !== mutation.recordId) throw new Error("The saved note changed its record identity.");
    if (record.state.state !== "confirmed" || record.state.hold || record.state.unresolved)
      throw new MdbaseError({ code: "outcome_unknown", reason: "unqualified_readback", recovery: "resolve_outcome", message: "The current note is pending or protected. Keep the original operation for recovery before reporting it as saved." });
    const document = this.remember(record);
    this.pending.delete(mutation.mutationId);
    return document;
  }

  private remember(record: wire.RecordView): NoteDocument {
    completeSource(record);
    const key = JSON.stringify([record.path, record.revision]);
    const previous = this.seen.get(key);
    if (previous) this.seenBytes -= previous.bytes;
    this.seen.delete(key);
    const bytes = 2 * (record.body.length + record.document.length +
      JSON.stringify(plain(record.frontmatter)).length +
      JSON.stringify(plain(record.effective ?? record.frontmatter)).length);
    if (bytes <= 8 * 1024 * 1024) {
      this.seen.set(key, { record, bytes });
      this.seenBytes += bytes;
    }
    while (this.seen.size > 128 || this.seenBytes > 8 * 1024 * 1024) {
      const oldest = this.seen.keys().next().value!;
      this.seenBytes -= this.seen.get(oldest)!.bytes;
      this.seen.delete(oldest);
    }
    return { path: record.path, revision: record.revision, types: [...record.types],
      frontmatter: plain(record.frontmatter), effectiveFrontmatter: plain(record.effective ?? record.frontmatter),
      body: record.body, document: record.document,
      file: { path: record.path, ...(record.mtime === undefined ? {} : { mtime: new Date(record.mtime).toISOString() }) } };
  }

  private clearSeen(): void { this.seen.clear(); this.seenBytes = 0; }

  private signal(extra?: AbortSignal): AbortSignal {
    this.lifetime.signal.throwIfAborted();
    return AbortSignal.any([this.lifetime.signal, ...(extra ? [extra] : []), AbortSignal.timeout(45_000)]);
  }
}

const noteInclude = { body: true, effective: true, document: true };
function completeSource(record: wire.RecordView): asserts record is wire.RecordView & { body: string; document: string } {
  if (record.body === undefined || record.document === undefined)
    throw unsupported("Mdbase did not return the complete note source. No source was reconstructed.");
  if (revisionOf(record.document) !== record.revision)
    throw unsupported("The complete note source does not match its native revision. No source was reconstructed or submitted.");
}
function plain(value: wire.FmMap): JsonObject { return Object.fromEntries([...value].map(([key, item]) => [key, toPlain(item)])) as JsonObject; }
function unsupported(message: string): MdbaseError { return new MdbaseError({ code: "invalid_request", recovery: "fix_request", reason: "unsupported", message }); }
