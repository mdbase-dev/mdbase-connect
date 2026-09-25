import type { JsonObject } from "@mdbase-dev/connect-protocol";
import { MdbaseConnectError } from "./errors.js";

/**
 * Experimental. One open, editable record: a debounced write queue with
 * revision checks, acknowledgement tracking, conflict classification and
 * exact outcome-unknown recovery. See docs/record-session.md.
 */
export type RecordSessionState =
  | "saved"
  | "unsaved"
  | "saving"
  | "conflict"
  | "recovery"
  | "error"
  | "deleted";

/** The parts of a record a session writes: only locally changed parts are present. */
export interface RecordChange {
  body?: string;
  patch?: JsonObject;
}

/**
 * The boundary between a session and whatever stores the record. `R` is the
 * application's record value; the session only reads it through these
 * accessors and hands it back unchanged.
 */
export interface RecordSessionAdapter<R> {
  revision(record: R): string;
  body(record: R): string;
  frontmatter?(record: R): JsonObject;
  /** Revision-checked against `base`. A rejection is classified with `read`. */
  write(base: R, change: RecordChange): Promise<R>;
  /** Current record, or null when it no longer exists. */
  read?(base: R): Promise<R | null>;
  /** Exact continuation of an outcome-unknown write. Never a new write. */
  recover?(requestId: string): Promise<R>;
  /** Whether the durable pending mutation is still unsettled. */
  isPending?(requestId: string): boolean;
}

export interface RecordSessionOptions {
  autosave: { idleMs: number } | false;
}

export interface RecordSessionSnapshot<R> {
  readonly state: RecordSessionState;
  readonly body: string;
  /** Record frontmatter with local patches applied. */
  readonly frontmatter: JsonObject;
  /** The latest record this session has accepted as its base. */
  readonly record: R;
  /** The newer record that conflicts with local changes. */
  readonly remote: R | null;
  /** Local changes not yet acknowledged by `record`, including an in-flight write. */
  readonly dirty: boolean;
  readonly error: unknown;
  readonly pendingRequestId?: string;
}

export type RecordResolution = { keep: "mine" | "theirs" } | { body: string };

interface Sent {
  body?: string;
  patch?: JsonObject;
}

export class RecordSession<R> {
  private record: R;
  /** Local text that `record` acknowledges; differs from its body after normalization. */
  private baseBody: string;
  private body: string;
  private patch: JsonObject = {};
  private remote: R | null = null;
  private error: unknown = null;
  private deleted = false;
  private busy = false;
  private pending: { requestId: string; sent: Sent } | undefined;
  private incoming: R[] = [];
  private readonly seen = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private tail: Promise<unknown> = Promise.resolve();
  private queued = 0;
  private inFlight: Promise<void> | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private lastEdit = 0;
  private current: RecordSessionSnapshot<R>;

  constructor(
    record: R,
    private readonly adapter: RecordSessionAdapter<R>,
    private readonly options: RecordSessionOptions
  ) {
    this.record = record;
    this.baseBody = this.body = adapter.body(record);
    this.seen.add(adapter.revision(record));
    this.current = this.compute();
  }

  get snapshot(): RecordSessionSnapshot<R> {
    return this.current;
  }

  getSnapshot = (): RecordSessionSnapshot<R> => this.current;

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
   * Offer a draft kept outside the session, such as a crash-recovery copy.
   * Never writes by itself. A draft whose base is unknown or has since
   * changed is a conflict with the current record.
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
   * A record published by another view, a watch event or a refresh. Records
   * arriving while a write is unsettled wait until its acknowledgement is known.
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
   * Read the current record after any queued write and classify it. Unlike a
   * publication, an authoritative read ordered behind this session's writes is
   * never stale, so a revision seen before (content revisions repeat when an
   * edit is reverted) is still applied.
   */
  refresh(): Promise<void> {
    return this.run(async () => {
      const read = this.adapter.read;
      if (!read || this.pending) return;
      const current = await read(this.record);
      if (current === null) {
        this.markDeleted();
        return;
      }
      this.seen.add(this.adapter.revision(current));
      this.classify(current);
      this.emit();
    });
  }

  /**
   * Accept a record this application produced outside the session's writes
   * (rename, whole-document replace). It is never a conflict: local changes
   * made meanwhile are kept on top of it.
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
    this.error = null;
    this.emit();
  }

  markDeleted(): void {
    clearTimeout(this.timer);
    this.deleted = true;
    this.emit();
  }

  /** Write now. Resolves once settled; rejects when the write or recovery failed. */
  save(): Promise<void> {
    clearTimeout(this.timer);
    if (this.inFlight) return this.inFlight;
    const write = this.run(() => this.pending ? this.recoverPending() : this.write(true));
    this.inFlight = write;
    const settle = () => { if (this.inFlight === write) this.inFlight = undefined; };
    write.then(settle, settle);
    return write;
  }

  /** Write until clean. Rejects on conflict, deletion or a failed write. */
  async flush(): Promise<R> {
    for (;;) {
      if (this.deleted) throw new Error("This record no longer exists. The local draft has been retained.");
      if (this.remote) throw new Error("Resolve the version changed elsewhere before continuing.");
      if (!this.inFlight && !this.pending && !this.dirtyLocally()) return this.record;
      await this.save();
    }
  }

  /** Run another operation on this record in the session's write queue. */
  run<Result>(operation: () => Promise<Result>): Promise<Result> {
    // An idle queue starts synchronously, so the write is in flight before the caller's next edit.
    const result = this.queued === 0 ? operation() : this.tail.then(operation);
    this.queued += 1;
    const done = () => { this.queued -= 1; };
    this.tail = result.then(done, done);
    return result;
  }

  resolve(choice: RecordResolution): void {
    const remote = this.remote;
    if (!remote || this.busy) return;
    this.record = remote;
    this.remote = null;
    this.error = null;
    this.baseBody = this.adapter.body(remote);
    if ("body" in choice) this.body = choice.body;
    else if (choice.keep === "theirs") {
      this.body = this.baseBody;
      this.patch = {};
    }
    this.emit();
    if (this.dirtyLocally()) this.autosave();
  }

  discard(): void {
    if (this.busy) return;
    clearTimeout(this.timer);
    this.record = this.remote ?? this.record;
    this.remote = null;
    this.error = null;
    this.baseBody = this.body = this.adapter.body(this.record);
    this.patch = {};
    this.emit();
  }

  private edited(): void {
    this.error = null;
    this.lastEdit = Date.now();
    this.emit();
    this.schedule();
  }

  private schedule(): void {
    clearTimeout(this.timer);
    if (!this.options.autosave || this.remote || this.deleted) return;
    const delay = Math.max(0, this.lastEdit + this.options.autosave.idleMs - Date.now());
    this.timer = setTimeout(() => void this.save().catch(() => undefined), delay);
  }

  private dirtyLocally(): boolean {
    return this.body !== this.baseBody || Object.keys(this.patch).length > 0;
  }

  private async write(rebaseOnRejection: boolean): Promise<void> {
    if (this.remote || this.deleted || !this.dirtyLocally()) return;
    const sent: Sent = {};
    if (this.body !== this.baseBody) sent.body = this.body;
    if (Object.keys(this.patch).length) sent.patch = structuredClone(this.patch);
    this.busy = true;
    this.emit();
    let result: R;
    try {
      result = await this.adapter.write(this.record, { ...sent });
    } catch (error) {
      const requestId = outcomeUnknownRequestId(error);
      if (requestId) {
        this.busy = false;
        this.error = error;
        this.pending = { requestId, sent };
        this.emit();
        this.schedule();
        throw error;
      }
      const outcome = await this.classifyFailure(error);
      if (outcome === "resolved") return;
      if (outcome === "rebased" && rebaseOnRejection) return this.write(false);
      throw error;
    }
    this.acknowledge(result, sent);
  }

  private async recoverPending(): Promise<void> {
    const pending = this.pending!;
    if (!this.adapter.recover) {
      throw new Error("Exact mutation recovery is unavailable. No new write was attempted.");
    }
    this.busy = true;
    this.emit();
    let result: R;
    try {
      result = await this.adapter.recover(pending.requestId);
    } catch (error) {
      // Only the SDK settling its durable handle proves the original intent was resolved.
      const settled = error instanceof MdbaseConnectError && !error.outcomeUnknown
        && this.adapter.isPending?.(pending.requestId) === false;
      if (!settled) {
        this.busy = false;
        this.error = error;
        this.emit();
        throw error;
      }
      this.pending = undefined;
      await this.classifyFailure(error);
      throw error;
    }
    this.acknowledge(result, pending.sent);
  }

  private acknowledge(result: R, sent: Sent): void {
    this.seen.add(this.adapter.revision(result));
    this.record = result;
    if (sent.body !== undefined) this.baseBody = sent.body;
    for (const [key, value] of Object.entries(sent.patch ?? {})) {
      if (key in this.patch && sameJson(this.patch[key], value)) delete this.patch[key];
    }
    this.error = null;
    this.pending = undefined;
    this.settle();
    if (this.dirtyLocally()) this.schedule();
  }

  /** Read once to learn whether a failed write met a conflict, a convergent edit or deletion. */
  private async classifyFailure(error: unknown): Promise<"resolved" | "rebased" | "failed"> {
    const base = this.adapter.revision(this.record);
    let current: R | null | undefined;
    try {
      current = await this.adapter.read?.(this.record);
    } catch {
      current = undefined;
    }
    if (current === null) {
      this.deleted = true;
      this.settle();
      return "failed";
    }
    if (current === undefined || this.adapter.revision(current) === base) {
      this.error = error;
      this.settle();
      return "failed";
    }
    this.seen.add(this.adapter.revision(current));
    this.classify(current);
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
    if (!this.dirtyLocally()) this.error = null;
  }

  private compute(): RecordSessionSnapshot<R> {
    const dirty = this.busy || Boolean(this.pending) || this.dirtyLocally();
    const state: RecordSessionState = this.deleted ? "deleted"
      : this.remote ? "conflict"
        : this.busy ? "saving"
          : this.pending ? "recovery"
            : this.error ? "error"
              : dirty ? "unsaved" : "saved";
    return {
      state,
      body: this.body,
      frontmatter: { ...(this.adapter.frontmatter?.(this.record) ?? {}), ...this.patch },
      record: this.record,
      remote: this.remote,
      dirty,
      error: this.error,
      ...(this.pending ? { pendingRequestId: this.pending.requestId } : {})
    };
  }

  private emit(): void {
    this.current = this.compute();
    this.listeners.forEach((listener) => listener());
  }
}

function outcomeUnknownRequestId(error: unknown): string | undefined {
  if (!(error instanceof MdbaseConnectError) || error.problem.code !== "operation_outcome_unknown") return undefined;
  return error.problem.details.request_id;
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
