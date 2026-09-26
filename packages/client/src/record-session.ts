import type { ConnectProblem, JsonObject } from "@mdbase-dev/connect-protocol";
import { connectProblem } from "./errors.js";
import type { ConnectRequestOptions } from "./operation-types.js";
import { connectFailure, connectSuccess, type ConnectOutcome } from "./outcomes.js";

/**
 * - `saved`: the draft is the acknowledged record.
 * - `unsaved`: local changes wait for autosave, `save()` or `flush()`.
 * - `saving`: a write or exact recovery is in flight.
 * - `conflict`: a newer record changed what was edited locally; see `remote`.
 * - `recovery`: a write's outcome is unknown; no new write is sent until it is recovered.
 * - `error`: the last write failed; local changes are kept.
 * - `deleted`: the record no longer exists; local changes are kept.
 */
export type MdbaseRecordSessionState =
  | "saved"
  | "unsaved"
  | "saving"
  | "conflict"
  | "recovery"
  | "error"
  | "deleted";

/** The parts of a record a session writes. Only locally changed parts are present. */
export interface MdbaseRecordChange {
  body?: string;
  patch?: JsonObject;
}

/**
 * How a session reads and writes one record. `R` is the application's record
 * value; the session reads it only through these accessors. Every expected
 * failure is a `ConnectOutcome` failure; an adapter that throws has a bug.
 */
export interface MdbaseRecordSessionAdapter<R> {
  revision(record: R): string;
  body(record: R): string;
  frontmatter?(record: R): JsonObject;
  /** Apply `change` to the record at `base`'s revision, or fail without writing. */
  write(base: R, change: MdbaseRecordChange, options?: ConnectRequestOptions): Promise<ConnectOutcome<R>>;
  /** The current record. A `file_not_found` failure means it was deleted. */
  read?(base: R, options?: ConnectRequestOptions): Promise<ConnectOutcome<R>>;
  /** Exact continuation of a write whose outcome is unknown. Never a new write. */
  recover?(requestId: string, options?: ConnectRequestOptions): Promise<ConnectOutcome<R>>;
  /** Whether that write's durable pending mutation is still unsettled. */
  isPending?(requestId: string): boolean;
}

export interface MdbaseRecordSessionOptions {
  /** Write after this much idle time following an edit. Default `{ idleMs: 1000 }`. */
  autosave?: { idleMs: number } | false;
}

export interface MdbaseRecordSessionSnapshot<R> {
  readonly state: MdbaseRecordSessionState;
  readonly body: string;
  /** The record's frontmatter with local patches applied. */
  readonly frontmatter: JsonObject;
  /** The latest record this session has accepted as its base. */
  readonly record: R;
  /** The newer record that conflicts with local changes, while `state` is `conflict`. */
  readonly remote: R | null;
  /** Local changes not yet acknowledged, including a write in flight or awaiting recovery. */
  readonly dirty: boolean;
  /** Why the last write or recovery failed. */
  readonly problem: ConnectProblem | null;
  /** The interrupted write's request ID, while `state` is `recovery`. */
  readonly pendingRequestId?: string;
}

export type MdbaseRecordResolution = { keep: "mine" | "theirs" } | { body: string };

interface Sent {
  body?: string;
  patch?: JsonObject;
}

type Classified = "resolved" | "rebased" | "failed";

/**
 * One open, editable record: debounced autosave, one write queue, own
 * acknowledgements recognized by revision after each write settles,
 * field-level conflict detection, and exact recovery of writes whose outcome
 * is unknown. Share one session between every view of the same record.
 */
export class MdbaseRecordSession<R> {
  private record: R;
  /** The local text `record` acknowledges; it differs from the record's body after server normalization. */
  private baseBody: string;
  private body: string;
  private patch: JsonObject = {};
  private remote: R | null = null;
  private problem: ConnectProblem | null = null;
  private deleted = false;
  private busy = false;
  private pending: { requestId: string; sent: Sent } | undefined;
  private incoming: R[] = [];
  private readonly seen = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private tail: Promise<unknown> = Promise.resolve();
  private queued = 0;
  private inFlight: Promise<ConnectOutcome<R>> | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private lastEdit = 0;
  private readonly idleMs: number | undefined;
  private current: MdbaseRecordSessionSnapshot<R>;

  constructor(
    record: R,
    private readonly adapter: MdbaseRecordSessionAdapter<R>,
    options: MdbaseRecordSessionOptions = {}
  ) {
    this.record = record;
    this.baseBody = this.body = adapter.body(record);
    this.seen.add(adapter.revision(record));
    this.idleMs = options.autosave === false ? undefined : options.autosave?.idleMs ?? 1000;
    this.current = this.compute();
  }

  get snapshot(): MdbaseRecordSessionSnapshot<R> {
    return this.current;
  }

  getSnapshot = (): MdbaseRecordSessionSnapshot<R> => this.current;

  /** Listeners run synchronously after every change, including each edit. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };

  setBody(body: string): void {
    if (body === this.body) return;
    this.body = body;
    this.edited();
  }

  patchFrontmatter(patch: JsonObject): void {
    this.patch = { ...this.patch, ...patch };
    this.edited();
  }

  /**
   * Offer a draft kept outside the session, such as a crash-recovery copy. It
   * is never written by itself: call `autosave()` or `save()`. A draft whose
   * base is unknown or has since changed is a conflict with the current record.
   */
  restore(draft: { body: string; baseBody?: string }): void {
    const current = this.adapter.body(this.record);
    if (draft.body === current) return;
    this.body = draft.body;
    if (draft.baseBody !== current) this.remote = this.record;
    this.emit();
  }

  /** Schedule an autosave one idle interval from now. */
  autosave(): void {
    this.lastEdit = Date.now();
    this.schedule();
  }

  /**
   * A record published by another view or cache. It may be stale, so a
   * revision this session has already seen is ignored, and records arriving
   * while a write is unsettled wait until that write's acknowledgement is known.
   */
  receive(record: R): void {
    if (this.seen.has(this.adapter.revision(record))) return;
    if (this.busy || this.pending) {
      this.incoming.push(record);
      return;
    }
    this.seen.add(this.adapter.revision(record));
    this.classify(record);
    this.emit();
  }

  /**
   * Read the current record after any queued write and apply it. Unlike a
   * publication this is never stale, so a revision seen before is still
   * applied (revisions repeat when content is reverted).
   */
  refresh(options?: ConnectRequestOptions): Promise<ConnectOutcome<R>> {
    return this.run(async () => {
      const read = this.adapter.read;
      if (!read || this.pending) return connectSuccess(this.record);
      const outcome = await read(this.record, options);
      if (!outcome.ok) {
        if (outcome.problem.code === "file_not_found") this.markDeleted();
        return outcome;
      }
      this.seen.add(this.adapter.revision(outcome.value));
      this.classify(outcome.value);
      this.emit();
      return connectSuccess(this.record);
    });
  }

  /**
   * Accept a record this application produced outside the session's writes,
   * such as a rename's result. It is never a conflict: local changes made
   * meanwhile are kept on top of it.
   */
  accept(record: R): void {
    this.seen.add(this.adapter.revision(record));
    const body = this.adapter.body(record);
    if (this.body === this.baseBody) this.body = body;
    this.baseBody = body;
    const matter = this.adapter.frontmatter?.(record) ?? {};
    for (const [key, value] of Object.entries(this.patch)) {
      if (sameJson(matter[key], value)) delete this.patch[key];
    }
    this.record = record;
    this.remote = null;
    this.problem = null;
    this.emit();
  }

  markDeleted(): void {
    clearTimeout(this.timer);
    this.deleted = true;
    this.emit();
  }

  /**
   * Write local changes now, or continue an interrupted write's exact
   * recovery. Joins a save already in flight. Resolves with the accepted record.
   */
  save(options?: ConnectRequestOptions): Promise<ConnectOutcome<R>> {
    clearTimeout(this.timer);
    if (this.inFlight) return this.inFlight;
    const write = this.run(() => this.pending ? this.recoverPending(options) : this.write(options, true));
    this.inFlight = write;
    const settle = () => { if (this.inFlight === write) this.inFlight = undefined; };
    write.then(settle, settle);
    return write;
  }

  /** Save until every local change is acknowledged, or report why it cannot be. */
  async flush(options?: ConnectRequestOptions): Promise<ConnectOutcome<R>> {
    for (;;) {
      if (this.deleted) return connectFailure(deletedProblem());
      if (this.remote) return connectFailure(conflictProblem());
      if (!this.inFlight && !this.pending && !this.dirtyLocally()) return connectSuccess(this.record);
      const saved = await this.save(options);
      if (!saved.ok) return saved;
    }
  }

  /** Run another operation on this record (rename, delete, …) in the session's write queue. */
  run<Result>(operation: () => Promise<Result>): Promise<Result> {
    // An idle queue starts synchronously, so a write is in flight before the caller's next edit.
    const result = this.queued === 0 ? operation() : this.tail.then(operation);
    this.queued += 1;
    const done = () => { this.queued -= 1; };
    this.tail = result.then(done, done);
    return result;
  }

  /** Settle a conflict: keep local changes on top of the remote record, take the remote record, or use merged text. */
  resolve(choice: MdbaseRecordResolution): void {
    const remote = this.remote;
    if (!remote || this.busy) return;
    this.record = remote;
    this.remote = null;
    this.problem = null;
    this.baseBody = this.adapter.body(remote);
    if ("body" in choice) this.body = choice.body;
    else if (choice.keep === "theirs") {
      this.body = this.baseBody;
      this.patch = {};
    }
    this.emit();
    if (this.dirtyLocally()) this.autosave();
  }

  /** Drop local changes and return to the latest record. */
  discard(): void {
    if (this.busy) return;
    clearTimeout(this.timer);
    this.record = this.remote ?? this.record;
    this.remote = null;
    this.problem = null;
    this.baseBody = this.body = this.adapter.body(this.record);
    this.patch = {};
    this.emit();
  }

  private edited(): void {
    this.problem = null;
    this.lastEdit = Date.now();
    this.emit();
    this.schedule();
  }

  private schedule(): void {
    clearTimeout(this.timer);
    if (this.idleMs === undefined || this.remote || this.deleted) return;
    const delay = Math.max(0, this.lastEdit + this.idleMs - Date.now());
    this.timer = setTimeout(() => void this.save(), delay);
  }

  private dirtyLocally(): boolean {
    return this.body !== this.baseBody || Object.keys(this.patch).length > 0;
  }

  private async write(options: ConnectRequestOptions | undefined, rebaseOnRejection: boolean): Promise<ConnectOutcome<R>> {
    if (this.remote) return connectFailure(conflictProblem());
    if (this.deleted) return connectFailure(deletedProblem());
    if (!this.dirtyLocally()) return connectSuccess(this.record);
    const sent: Sent = {};
    if (this.body !== this.baseBody) sent.body = this.body;
    if (Object.keys(this.patch).length) sent.patch = structuredClone(this.patch);
    this.busy = true;
    this.emit();
    const outcome = await this.guard(() => this.adapter.write(this.record, { ...sent }, options));
    if (outcome.ok) {
      this.acknowledge(outcome.value, sent);
      return connectSuccess(this.record);
    }
    const requestId = outcomeUnknownRequestId(outcome.problem);
    if (requestId) {
      this.busy = false;
      this.problem = outcome.problem;
      this.pending = { requestId, sent };
      this.emit();
      this.schedule();
      return outcome;
    }
    const classified = await this.classifyFailure(outcome.problem, options);
    if (classified === "resolved") return connectSuccess(this.record);
    if (classified === "rebased" && rebaseOnRejection) return this.write(options, false);
    return this.failure(outcome.problem);
  }

  private async recoverPending(options: ConnectRequestOptions | undefined): Promise<ConnectOutcome<R>> {
    const pending = this.pending!;
    const recover = this.adapter.recover;
    if (!recover) {
      return connectFailure(connectProblem(
        "pending_mutation_unresolved",
        "Exact recovery of the interrupted write is unavailable. No new write was attempted."
      ));
    }
    this.busy = true;
    this.emit();
    const outcome = await this.guard(() => recover(pending.requestId, options));
    if (outcome.ok) {
      this.acknowledge(outcome.value, pending.sent);
      return connectSuccess(this.record);
    }
    // Only the SDK settling its durable handle proves the original intent was resolved.
    const settled = outcome.problem.operation_outcome !== "unknown"
      && outcome.problem.code !== "operation_outcome_unknown"
      && this.adapter.isPending?.(pending.requestId) === false;
    if (!settled) {
      this.busy = false;
      this.problem = outcome.problem;
      this.emit();
      return outcome;
    }
    this.pending = undefined;
    await this.classifyFailure(outcome.problem, options);
    return this.failure(outcome.problem);
  }

  /** An adapter that throws breaks its contract: rethrow, but leave the queue usable. */
  private async guard<Value>(call: () => Promise<Value>): Promise<Value> {
    try {
      return await call();
    } catch (error) {
      this.busy = false;
      this.emit();
      throw error;
    }
  }

  private failure(problem: ConnectProblem): ConnectOutcome<R> {
    if (this.deleted) return connectFailure(deletedProblem());
    if (this.remote) return connectFailure(conflictProblem());
    return connectFailure(problem);
  }

  private acknowledge(result: R, sent: Sent): void {
    this.seen.add(this.adapter.revision(result));
    this.record = result;
    if (sent.body !== undefined) this.baseBody = sent.body;
    for (const [key, value] of Object.entries(sent.patch ?? {})) {
      if (key in this.patch && sameJson(this.patch[key], value)) delete this.patch[key];
    }
    this.problem = null;
    this.pending = undefined;
    this.settle();
    if (this.dirtyLocally()) this.schedule();
  }

  /** Read once to learn whether a failed write met a conflict, a convergent edit or deletion. */
  private async classifyFailure(problem: ConnectProblem, options: ConnectRequestOptions | undefined): Promise<Classified> {
    const base = this.adapter.revision(this.record);
    const read = this.adapter.read;
    const outcome = read ? await this.guard(() => read(this.record, options)) : undefined;
    if (outcome && !outcome.ok && outcome.problem.code === "file_not_found") {
      this.deleted = true;
      this.settle();
      return "failed";
    }
    if (!outcome?.ok || this.adapter.revision(outcome.value) === base) {
      this.problem = problem;
      this.settle();
      return "failed";
    }
    this.seen.add(this.adapter.revision(outcome.value));
    this.classify(outcome.value);
    this.settle();
    if (this.remote) return "failed";
    return this.dirtyLocally() ? "rebased" : "resolved";
  }

  private settle(): void {
    this.busy = false;
    for (const record of this.incoming.splice(0)) {
      if (this.seen.has(this.adapter.revision(record))) continue;
      this.seen.add(this.adapter.revision(record));
      this.classify(record);
    }
    this.emit();
  }

  /** Field-level three-way comparison of a newer record with the base and local changes. */
  private classify(record: R): void {
    if (this.adapter.revision(record) === this.adapter.revision(this.record)) return;
    const baseBody = this.adapter.body(this.record);
    const remoteBody = this.adapter.body(record);
    const bodyChanged = remoteBody !== baseBody;
    const bodyDirty = this.body !== this.baseBody;
    const baseMatter = this.adapter.frontmatter?.(this.record) ?? {};
    const remoteMatter = this.adapter.frontmatter?.(record) ?? {};
    const conflict = (bodyDirty && bodyChanged && remoteBody !== this.body)
      || Object.entries(this.patch).some(([key, value]) =>
        !sameJson(remoteMatter[key], baseMatter[key]) && !sameJson(remoteMatter[key], value));
    if (conflict) {
      clearTimeout(this.timer);
      this.remote = record;
      return;
    }
    this.remote = null;
    this.record = record;
    // Not a conflict, so a changed remote body either replaces a clean draft or equals it.
    if (bodyChanged) this.baseBody = this.body = remoteBody;
    for (const [key, value] of Object.entries(this.patch)) {
      if (sameJson(remoteMatter[key], value)) delete this.patch[key];
    }
    if (!this.dirtyLocally()) this.problem = null;
  }

  private compute(): MdbaseRecordSessionSnapshot<R> {
    const dirty = this.busy || Boolean(this.pending) || this.dirtyLocally();
    const state: MdbaseRecordSessionState = this.deleted ? "deleted"
      : this.remote ? "conflict"
        : this.busy ? "saving"
          : this.pending ? "recovery"
            : this.problem ? "error"
              : dirty ? "unsaved" : "saved";
    return {
      state,
      body: this.body,
      frontmatter: { ...(this.adapter.frontmatter?.(this.record) ?? {}), ...this.patch },
      record: this.record,
      remote: this.remote,
      dirty,
      problem: this.problem,
      ...(this.pending ? { pendingRequestId: this.pending.requestId } : {})
    };
  }

  private emit(): void {
    this.current = this.compute();
    this.listeners.forEach((listener) => listener());
  }
}

function conflictProblem(): ConnectProblem<"concurrent_modification"> {
  return connectProblem(
    "concurrent_modification",
    "This record changed elsewhere. Local changes are kept until the conflict is resolved."
  );
}

function deletedProblem(): ConnectProblem<"file_not_found"> {
  return connectProblem("file_not_found", "This record no longer exists. Local changes are kept.");
}

function outcomeUnknownRequestId(problem: ConnectProblem): string | undefined {
  return problem.code === "operation_outcome_unknown" ? problem.details.request_id : undefined;
}

function sameJson(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (typeof left !== "object" || typeof right !== "object" || left === null || right === null) return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length
      && left.every((value, index) => sameJson(value, right[index]));
  }
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length
    && keys.every((key) => key in right
      && sameJson((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]));
}
