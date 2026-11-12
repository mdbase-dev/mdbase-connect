/**
 * A record set: every record of the chosen types, read completely once and
 * then kept current from the change feed.
 *
 * A live query (`client.live`) cannot hold a whole collection: one answer is
 * limited to 1,000 records and 1 MiB (`replica-client-api.md` §4). A record set
 * pages instead, and rereads only what the change feed names afterwards.
 */
import type { ChangesWatch, MdbaseClient } from "./client.js";
import { isMdbaseError, MdbaseError, mdbaseError } from "./errors.js";
import type { RecordView } from "./plain.js";
import type { ChangesResult, Include, Problem, Uuid } from "./wire.js";

export interface RecordSetOptions {
  /** Only records with one of these types. Default: every record. */
  types?: readonly string[];
  include?: Include;
  /** Closes the set when aborted. */
  signal?: AbortSignal;
}

/**
 * - `loading`: the first complete read is under way. `records` holds what has
 *   arrived so far.
 * - `current`: complete, and following changes.
 * - `stale`: `records` is the last complete read and may be behind: the
 *   connection is down, or a reread is under way or being retried. The set
 *   recovers by itself; `problem` says what it is waiting on, if anything.
 * - `failed`: the set cannot continue by itself (`problem`). `records` is
 *   kept. `reload()` tries again.
 * - `closed`.
 */
export type RecordSetState = "loading" | "current" | "stale" | "failed" | "closed";

export interface RecordSetSnapshot {
  /** In no particular order. The same array until the set changes. */
  readonly records: readonly RecordView[];
  readonly state: RecordSetState;
  readonly problem: Problem | null;
}

/** One record's change. A rename is a `put` whose `previous.path` differs. */
export type RecordSetChange =
  | { readonly kind: "put"; readonly record: RecordView; readonly previous?: RecordView }
  | { readonly kind: "remove"; readonly previous: RecordView };

/** `changes` is empty when only `state` or `problem` changed. */
export type RecordSetListener = (changes: readonly RecordSetChange[]) => void;

type SetClient = Pick<MdbaseClient, "pages" | "find" | "watchChanges" | "onStatus" | "status" | "link">;

const PAGE = 1000;
/** Above this many changed records, one complete read costs less than rereads. */
const REREAD_MAX = 500;
const REREAD_CONCURRENCY = 8;
const RETRY_MIN_MS = 250;
const RETRY_MAX_MS = 30_000;

/** A failure the set waits out: the link, the service, or a collection that
 * changed while it was being read (its paging cursor is then refused). */
function passing(e: unknown): boolean {
  if (!(e instanceof MdbaseError)) return false;
  if (e.recovery === "retry") return true;
  return (e.code === "invalid_request" && (e.reason === "cursor_stale" || e.reason === "cursor_expired"))
    || (e.code === "conflict" && e.reason === "collection_changed");
}

const problemOf = (e: unknown): Problem =>
  e instanceof MdbaseError ? e.toProblem() : { code: "internal", recovery: "contact_support", message: e instanceof Error ? e.message : String(e) };

/** Type names compare without ASCII case, as in a query's `types`. */
const fold = (type: string): string => type.replace(/[A-Z]/g, (c) => c.toLowerCase());
const sameTypes = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((t, i) => t === b[i]);
/** Whether a reread shows the record as it was, so no change is reported. */
const unchanged = (a: RecordView, b: RecordView): boolean =>
  a.revision === b.revision && a.path === b.path && a.state.state === b.state.state
  && a.state.hold?.id === b.state.hold?.id && a.state.unresolved === b.state.unresolved && sameTypes(a.types, b.types);

export class RecordSet {
  /** Resolves when the set is first `current`; rejects if it fails or closes first. */
  readonly ready: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (e: MdbaseError) => void;
  private readonly lifetime = new AbortController();
  private readonly listeners = new Set<RecordSetListener>();
  private readonly types: readonly string[] | undefined;
  private readonly folded: readonly string[] | undefined;
  private readonly include: Include | undefined;
  private byId = new Map<Uuid, RecordView>();
  private view: RecordSetSnapshot = Object.freeze({ records: Object.freeze([]), state: "loading", problem: null });
  /** Changed since `view.records` was built. */
  private touched = false;
  private state: RecordSetState = "loading";
  private problem: Problem | null = null;
  private watch!: ChangesWatch;
  private offWatch: () => void = () => {};
  private readonly offStatus: () => void;
  private readonly abort = () => this.close();
  /** Where the change feed was last read to, so a replaced watch resumes there. */
  private cursor: string | undefined;
  /** Records the feed named since they were last read. */
  private queued = new Set<Uuid>();
  /** A complete read has finished. */
  private loaded = false;
  /** A complete read is needed. */
  private dirty = true;
  private working = false;
  /** A retry that is waiting, and what it will do. */
  private timer: ReturnType<typeof setTimeout> | undefined;
  private again: (() => void) | undefined;
  private delay = RETRY_MIN_MS;
  private pending: number;
  private readonly signal: AbortSignal | undefined;

  /** @internal `MdbaseClient.recordSet`. */
  constructor(private readonly client: SetClient, options: RecordSetOptions = {}) {
    this.signal = options.signal;
    this.pending = client.status.pending;
    this.types = options.types?.length ? [...options.types] : undefined;
    this.folded = this.types?.map(fold);
    this.include = options.include ? { ...options.include } : undefined;
    this.ready = new Promise((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
    this.ready.catch(() => {});
    // A write's confirmation changes its record's state without a feed entry.
    this.offStatus = client.onStatus((s) => {
      const settled = s.pending < this.pending;
      this.pending = s.pending;
      if (!settled) return;
      for (const r of this.byId.values()) if (r.state.state === "pending") this.queued.add(r.id);
      void this.work();
    });
    this.startWatch();
    this.signal?.addEventListener("abort", this.abort, { once: true });
    if (this.signal?.aborted) this.close();
  }

  getSnapshot = (): RecordSetSnapshot => this.view;

  get(id: Uuid): RecordView | undefined {
    return this.byId.get(id);
  }

  subscribe = (listener: RecordSetListener): (() => void) => {
    if (this.state !== "closed") this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  /** Read every record again: after `failed`, or when something the change
   * feed does not report (a type definition) has changed. */
  reload(): Promise<void> {
    if (this.state === "closed") return Promise.reject(mdbaseError("cancelled", "record set closed"));
    this.dirty = true;
    this.delay = RETRY_MIN_MS;
    if (this.state === "failed") {
      this.problem = null;
      this.publish(this.loaded ? "stale" : "loading");
      if (this.watch.state === "failed" || this.watch.state === "closed") this.startWatch();
    }
    return new Promise((resolve, reject) => {
      const off = this.subscribe(() => {
        if (this.state === "current" && !this.dirty) { off(); resolve(); }
        else if (this.state === "failed" || this.state === "closed") { off(); reject(new MdbaseError(this.problem ?? { code: "cancelled", recovery: "none", message: "record set closed" })); }
      });
      this.resume();
    });
  }

  close(): void {
    if (this.state === "closed") return;
    this.lifetime.abort();
    this.cancelRetry();
    this.signal?.removeEventListener("abort", this.abort);
    this.offStatus(); this.offWatch(); this.watch();
    this.rejectReady(mdbaseError("cancelled", "record set closed"));
    this.publish("closed");
    this.listeners.clear();
  }

  private startWatch(): void {
    this.offWatch();
    const watch = this.client.watchChanges((batch) => { if (this.watch === watch) this.changed(batch); }, { cursor: this.cursor });
    this.watch = watch;
    // Without a cursor the new watch starts from now: what came before is unread.
    if (this.cursor === undefined) this.dirty = true;
    this.offWatch = watch.subscribe((state, error) => {
      if (this.watch !== watch || this.state === "closed" || this.state === "failed") return;
      if (state === "active") { void this.work(); return; }
      if (state === "stale") { if (this.loaded) this.publish("stale"); return; }
      if (state === "closed") { this.close(); return; }
      if (state === "failed") {
        // The watch does not restart itself. Replace it, unless the client is gone.
        if (error && passing(error) && this.client.link !== "closed") this.retry(error, () => this.startWatch());
        else this.fail(error ?? mdbaseError("unavailable", "the change watch stopped"));
      }
    });
  }

  private changed(batch: ChangesResult): void {
    this.cursor = batch.cursor;
    if (batch.reset) this.dirty = true;
    for (const c of batch.changes) {
      if (c.entity === "file") continue;
      // A record of other types that the set does not hold cannot belong to it.
      if (c.kind === "put" && this.types && c.types && !this.byId.has(c.id) && !this.member(c.types)) continue;
      if (c.kind === "remove" && !this.byId.has(c.id)) continue;
      this.queued.add(c.id);
    }
    void this.work();
  }

  private member(types: readonly string[]): boolean {
    return !this.folded || types.some((t) => this.folded!.includes(fold(t)));
  }

  /** One worker at a time: a complete read when one is needed, else rereads. */
  private async work(): Promise<void> {
    if (this.working || this.timer !== undefined) return;
    this.working = true;
    try {
      while (this.state !== "closed" && this.state !== "failed" && this.watch.state === "active" && (this.dirty || this.queued.size)) {
        if (!this.dirty && this.queued.size <= REREAD_MAX) await this.reread();
        else if (!(await this.load())) {
          // The collection is still arriving on this device (`complete: false`,
          // §4): what has arrived is shown, and the read is repeated.
          this.retry(null, () => void this.work());
          return;
        }
        this.delay = RETRY_MIN_MS;
      }
    } catch (e) {
      if (this.state === "closed" || isMdbaseError(e, "cancelled")) return;
      if (passing(e)) this.retry(e as MdbaseError, () => void this.work());
      else this.fail(e);
      return;
    } finally {
      this.working = false;
    }
    if (this.state === "closed" || this.state === "failed" || this.watch.state !== "active") return;
    this.problem = null;
    this.publish("current");
    this.resolveReady();
  }

  private retry(why: MdbaseError | null, again: () => void): void {
    this.problem = why?.toProblem() ?? null;
    this.publish(this.loaded ? "stale" : "loading");
    const delay = this.delay;
    this.delay = Math.min(delay * 2, RETRY_MAX_MS);
    clearTimeout(this.timer);
    this.again = again;
    this.timer = setTimeout(() => this.resume(), delay);
  }

  /** Do now what a waiting retry would do; without one, work. */
  private resume(): void {
    clearTimeout(this.timer); this.timer = undefined;
    const again = this.again ?? (() => void this.work());
    this.again = undefined;
    if (this.state !== "closed") again();
  }

  private cancelRetry(): void {
    clearTimeout(this.timer); this.timer = undefined; this.again = undefined;
  }

  private fail(e: unknown): void {
    this.cancelRetry();
    this.problem = problemOf(e);
    this.rejectReady(e instanceof MdbaseError ? e : new MdbaseError(this.problem));
    this.publish("failed");
  }

  /** One complete read. False when the replica could not answer completely. */
  private async load(): Promise<boolean> {
    const signal = this.lifetime.signal;
    // The watch is active, so every change from here on is queued; what is
    // already queued is older than this read.
    this.dirty = false;
    this.queued.clear();
    this.publish(this.loaded ? "stale" : "loading");
    const next = new Map<Uuid, RecordView>();
    let complete = true;
    try {
      const query = { ...(this.types ? { types: [...this.types] } : {}), limit: PAGE };
      for await (const page of this.client.pages(query, { include: this.include, signal })) {
        for (const r of page.records) next.set(r.id, r);
        complete &&= page.complete;
        // The first read shows its pages as they arrive.
        if (!this.loaded) this.apply(page.records.map((r) => ({ record: r })), this.state);
      }
    } catch (e) {
      this.dirty = true;
      throw e;
    }
    const changes = [...next.values()].map((record) => ({ record }));
    const removed = [...this.byId.keys()].filter((id) => !next.has(id)).map((id) => ({ id }));
    this.loaded ||= complete;
    // Not cleared here: a reset may have arrived while this read ran.
    if (!complete) this.dirty = true;
    this.apply([...changes, ...removed], this.state);
    return complete;
  }

  private async reread(): Promise<void> {
    const signal = this.lifetime.signal;
    const ids = [...this.queued];
    this.queued.clear();
    const read = new Array<RecordView | null>(ids.length);
    let next = 0;
    try {
      await Promise.all(Array.from({ length: Math.min(REREAD_CONCURRENCY, ids.length) }, async () => {
        while (next < ids.length) { const i = next++; read[i] = await this.client.find(ids[i]!, { include: this.include, signal }); }
      }));
    } catch (e) {
      // Only `not_found` means gone; any other failure leaves them unread.
      for (const id of ids) this.queued.add(id);
      throw e;
    }
    this.apply(ids.map((id, i) => (read[i] && this.member(read[i]!.types) ? { record: read[i]! } : { id })), this.state);
  }

  /** Put or remove records, then tell listeners what changed. */
  private apply(entries: readonly ({ record: RecordView } | { id: Uuid })[], state: RecordSetState): void {
    const changes: RecordSetChange[] = [];
    for (const entry of entries) {
      const id = "record" in entry ? entry.record.id : entry.id;
      const previous = this.byId.get(id);
      if ("record" in entry) {
        this.byId.set(id, entry.record);
        if (!previous) changes.push({ kind: "put", record: entry.record });
        else if (!unchanged(previous, entry.record)) changes.push({ kind: "put", record: entry.record, previous });
      } else if (previous) {
        this.byId.delete(id);
        changes.push({ kind: "remove", previous });
      }
    }
    this.touched ||= entries.length > 0;
    this.publish(state, changes);
  }

  private publish(state: RecordSetState, changes: readonly RecordSetChange[] = []): void {
    if (this.state === "closed") return;
    const problem = state === "current" ? null : this.problem;
    if (!this.touched && state === this.state && problem === this.view.problem) return;
    this.state = state;
    this.view = Object.freeze({ records: this.touched ? Object.freeze([...this.byId.values()]) : this.view.records, state, problem });
    this.touched = false;
    for (const listener of [...this.listeners]) {
      try { listener(changes); } catch { /* A listener's failure is its own. */ }
    }
  }
}
