import { t } from "@lingui/core/macro";
import { isMdbaseError, MdbaseError, revisionOf, toPlain, type MdbaseClient, type PlainValue, type Write, type wire } from "@mdbase-dev/sdk";
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

/** How long a save waits for the log before it counts as saved on this device (as `client.save()`). */
const RECEIPT_WAIT_MS = 3_000;

/** Native record operations for the existing note-session boundary. The session
 * store still owns serialization/drafts; this adapter owns no second record index.
 * A write the replica captured is saved: confirmed, or saved on this device when
 * the log hasn't confirmed it within the wait; the SDK's write ledger keeps and
 * settles those. Only an unknown outcome is kept here, for recovery by its exact
 * ID. Sign-in owns the client. */
export class NextEditorRecords {
  private readonly lifetime = new AbortController();
  private readonly seen = new Map<string, { record: wire.RecordView; bytes: number }>();
  private seenBytes = 0;
  /** Captured writes this adapter couldn't settle (unknown outcome, failed readback). */
  private readonly unknown = new Map<string, NextEditorPendingMutation>();
  private writing = false;
  /** Per create ID until confirmed: the first request, and every property key requested since. */
  private readonly creates = new Map<string, { first: string; keys: Set<string> }>();

  /** `isCurrent` is the borrowed SDK connection's currentness; a retired
   * connection fences every later await, including receipt readback. */
  constructor(private readonly client: MdbaseClient, private readonly isCurrent: () => boolean = () => true) {}

  async read(path: string, signal?: AbortSignal): Promise<NoteDocument> {
    const current = this.signal(signal);
    const record = await this.client.get({ path }, noteInclude, current);
    this.check(current);
    return this.remember(record);
  }

  /** With `input.id`, a retry lands once. The same intent keeps the first landed
   * attempt's content, so a retry with edited input then applies the edit as an
   * update (and rename) of the created note. */
  async create(input: CreateNoteInput, signal?: AbortSignal): Promise<NoteDocument> {
    const intent = input.id;
    const id = intent ?? crypto.randomUUID();
    const body = input.titleField ? input.body : persistedBody(input.title, input.body, { kind: "heading" });
    const request = JSON.stringify([input.path, body, input.properties]);
    const attempt = intent === undefined ? undefined : this.creates.get(intent) ?? { first: request, keys: new Set<string>() };
    if (intent !== undefined && attempt) {
      for (const key of Object.keys(input.properties)) attempt.keys.add(key);
      this.creates.set(intent, attempt);
    }
    let created = await this.write("create", id, current => this.client.create({
      id, path: input.path, ...(input.type ? { type: input.type } : {}),
      frontmatter: input.properties as Record<string, PlainValue>, body,
    }, current), signal, intent) as NoteDocument;
    if (intent === undefined || !attempt) return created;
    if (attempt.first !== request) {
      const current = this.signal(signal);
      const record = await this.base(created.path, created.revision, current);
      const unset = [...attempt.keys].filter(key => !(key in input.properties) && key in created.frontmatter);
      created = await this.write("update", id, options => this.client.update(record, {
        patch: input.properties as Record<string, PlainValue>, ...(unset.length ? { unset } : {}),
        ...(created.body === body ? {} : { body }), ifRevision: record.revision,
      }, options), current) as NoteDocument;
      if (created.path !== input.path) created = await this.rename(created.path, input.path, created.revision, false, signal);
    }
    this.creates.delete(intent);
    return created;
  }

  /** With `requestedId`, a restore retried after a lost reply lands once. */
  restore(document: NoteDocument, requestedId?: string, signal?: AbortSignal): Promise<NoteDocument> {
    if (document.document === undefined) throw unsupported(t`The original complete note source is unavailable.`);
    const id = requestedId ?? crypto.randomUUID();
    return this.write("create", id, current => this.client.create({ id, path: document.path, document: document.document }, current), signal, requestedId) as Promise<NoteDocument>;
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
    this.check(current);
    return result;
  }

  async preflightDelete(path: string, revision: string, signal?: AbortSignal): Promise<wire.Preflight> {
    const current = this.signal(signal);
    const record = await this.base(path, revision, current);
    const result = await this.client.preflightDelete(record);
    this.check(current);
    return result;
  }

  pendingMutations(): readonly NextEditorPendingMutation[] { return [...this.unknown.values()]; }

  async recover(mutationId: string, signal?: AbortSignal): Promise<NoteDocument | undefined> {
    const mutation = this.unknown.get(mutationId);
    if (!mutation) throw new Error(t`The exact interrupted note operation is unavailable. No new write was attempted.`);
    return this.confirm(mutation, this.signal(signal));
  }

  dispose(): void { this.lifetime.abort(); this.clearSeen(); }

  private async base(path: string, revision: string, signal: AbortSignal): Promise<wire.RecordView> {
    this.check(signal);
    const key = JSON.stringify([path, revision]);
    const record = this.seen.get(key)?.record ?? await this.client.get({ path }, noteInclude, signal);
    this.check(signal);
    if (record.path !== path || record.revision !== revision)
      throw new MdbaseError({ code: "conflict", reason: "revision_mismatch", recovery: "refresh", message: t`This note changed after it was opened. Reload before saving.` });
    if (record.state.hold || record.state.unresolved)
      throw new MdbaseError({ code: "conflict", reason: "protected_edit", recovery: "resolve_conflict", message: t`Resolve this note's protected edit before changing it.` });
    completeSource(record);
    return record;
  }

  /** With `intent`, the SDK derives the mutation ID from it, so a retried
   * action resubmits the same mutation; it is learned from the write or error. */
  private async write(operation: NextEditorPendingMutation["operation"], recordId: string,
    submit: (options: { mutationId?: string; intent?: string; signal: AbortSignal }) => Promise<Write>, signal?: AbortSignal,
    intent?: string): Promise<NoteDocument | undefined> {
    const current = this.signal(signal);
    if (this.unknown.size) throw new Error(t`Check your unconfirmed change before making another one. Nothing new was saved.`);
    if (this.writing) throw new Error(t`Your previous change is still being saved. Try again in a moment.`);
    const mutation = { mutationId: intent === undefined ? crypto.randomUUID() : "", operation, recordId, createdAt: new Date().toISOString() };
    this.writing = true;
    try {
      try {
        const write = await submit(intent === undefined ? { mutationId: mutation.mutationId, signal: current } : { intent, signal: current });
        if (intent !== undefined) mutation.mutationId = write.mutationId;
        this.check(current);
        if (write.mutationId !== mutation.mutationId) throw new Error(t`The native write changed its mutation identity.`);
      } catch (error) {
        if (!mutation.mutationId && error instanceof MdbaseError && error.mutationId) mutation.mutationId = error.mutationId;
        // An error code alone does not prove non-capture: only the exact receipt
        // settles it. No receipt for this ID means nothing was written.
        if (!mutation.mutationId || !await this.captured(mutation.mutationId)) throw error;
      }
      try { return await this.confirm(mutation, current); }
      catch (error) {
        // Captured but not settled here: keep the exact ID for recovery, never a new write.
        if (!(error instanceof Refused)) this.unknown.set(mutation.mutationId, mutation);
        throw error;
      }
    } finally { this.writing = false; }
  }

  private async captured(mutationId: string): Promise<boolean> {
    try { await this.client.receipt(mutationId, AbortSignal.timeout(10_000)); return true; }
    catch (error) { return !isMdbaseError(error, "not_found"); }
  }

  private async confirm(mutation: NextEditorPendingMutation, signal: AbortSignal): Promise<NoteDocument | undefined> {
    // Still pending after the wait is saved on this device, not a failure.
    const receipt = await this.client.awaitReceipt(mutation.mutationId, RECEIPT_WAIT_MS, signal).catch((error: unknown) => {
      if (isMdbaseError(error, "cancelled")) throw error;
      this.check(signal);
      return this.client.receipt(mutation.mutationId, signal);
    });
    this.check(signal);
    if (receipt.mutation !== mutation.mutationId) throw new Error(t`The native receipt changed its mutation identity.`);
    if (receipt.state === "unknown")
      throw new MdbaseError({ code: "outcome_unknown", recovery: "resolve_outcome", message: t`This note change is not confirmed. Check the interrupted operation before trying again.` });
    if (receipt.state === "rejected" || receipt.status === "conflicted") this.unknown.delete(mutation.mutationId);
    if (receipt.state === "rejected")
      throw new Refused(receipt.problem ?? { code: "conflict", recovery: "resolve_conflict", message: t`The note change was rejected.` });
    if (receipt.status === "conflicted")
      throw new Refused({ code: "conflict", recovery: "resolve_conflict", message: t`This note change has a conflict. Resolve it before continuing.` });
    if (mutation.operation === "delete") { this.unknown.delete(mutation.mutationId); this.clearSeen(); return undefined; }
    const record = await this.client.get(mutation.recordId, noteInclude, signal);
    this.check(signal);
    if (record.id !== mutation.recordId) throw new Error(t`The saved note changed its record identity.`);
    if (record.state.hold || record.state.unresolved)
      throw new MdbaseError({ code: "outcome_unknown", reason: "unqualified_readback", recovery: "resolve_outcome", message: t`The current note is protected. Keep the original operation for recovery before reporting it as saved.` });
    this.unknown.delete(mutation.mutationId);
    return this.remember(record);
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

  private check(signal: AbortSignal): void {
    if (!this.isCurrent())
      throw new MdbaseError({ code: "cancelled", recovery: "none", message: t`This collection is no longer open in mdbase editor.` });
    signal.throwIfAborted();
  }

  private clearSeen(): void { this.seen.clear(); this.seenBytes = 0; }

  private signal(extra?: AbortSignal): AbortSignal {
    this.check(this.lifetime.signal);
    extra?.throwIfAborted();
    return AbortSignal.any([this.lifetime.signal, ...(extra ? [extra] : []), AbortSignal.timeout(45_000)]);
  }
}

const noteInclude = { body: true, effective: true, document: true };
function completeSource(record: wire.RecordView): asserts record is wire.RecordView & { body: string; document: string } {
  if (record.body === undefined || record.document === undefined)
    throw unsupported(t`Mdbase did not return the complete note source. No source was reconstructed.`);
  if (revisionOf(record.document) !== record.revision)
    throw unsupported(t`The complete note source does not match its native revision. No source was reconstructed or submitted.`);
}
/** Plain JSON view of native frontmatter, for the editor's JSON domain model. */
export function plain(value: wire.FmMap): JsonObject { return Object.fromEntries([...value].map(([key, item]) => [key, toPlain(item)])) as JsonObject; }
/** The log refused the write: a plain failure, nothing to recover. */
class Refused extends MdbaseError {}
function unsupported(message: string): MdbaseError { return new MdbaseError({ code: "invalid_request", recovery: "fix_request", reason: "unsupported", message }); }
