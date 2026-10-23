import { t } from "@lingui/core/macro";
import { isMdbaseError, MdbaseError, type ChangesWatch, type ChangesWatchState, type MdbaseClient, type wire } from "@mdbase-dev/sdk";
import type { QueryRecord } from "@mdbase-dev/connect";
import { plain } from "./next-editor-records";
import type {
  EditorCollectionChange,
  NativeCollectionChange,
  NoteFrontmatter,
  NoteObservation,
  NoteObservationSnapshot,
  ObservationOutcome,
  ObservationProblem,
  ObservationWatchStatus
} from "./model";

type Reason = "page" | "reload" | "changes" | "local" | "status";
type Note = QueryRecord<NoteFrontmatter>;
interface Overlay { upserts: readonly Note[]; removed: readonly string[]; committed: boolean }

const PAGE_SIZE = 500;

/** Native note index over the borrowed public client. It owns no second record
 * engine: complete `pages()` snapshots, the SDK change watch, and exact `find()`
 * rereads by record ID. Optimistic overlays are presentation only. */
export class NativeNoteObservation implements NoteObservation {
  readonly ready: Promise<ObservationOutcome>;
  private readonly lifetime = new AbortController();
  private readonly listeners = new Set<(snapshot: NoteObservationSnapshot, delta: { readonly reason: Reason }) => void>();
  private readonly changeListeners = new Set<(change: EditorCollectionChange) => void>();
  private readonly watch: ChangesWatch;
  private readonly stopWatchState: () => void;
  /** Confirmed native index, keyed by original record ID. */
  private confirmed = new Map<string, Note>();
  private overlays: Overlay[] = [];
  private snapshot: NoteObservationSnapshot;
  private includeBody = false;
  private loading: Promise<ObservationOutcome> | undefined;
  private queued = new Set<string>();
  private draining = false;
  private reconnected = false;
  private closed = false;

  constructor(private readonly client: MdbaseClient, private readonly isCurrent: () => boolean = () => true) {
    this.snapshot = { records: [], state: "loading", generation: 1, problem: null, watchStatus: { state: "connecting" } };
    // Registered before the first page so no change between pages is missed.
    this.watch = client.watchChanges(undefined, batch => this.accept(batch));
    this.stopWatchState = this.watch.subscribe((state, error) => this.watchChanged(state, error));
    this.ready = this.load(false);
  }

  getSnapshot(): NoteObservationSnapshot { return this.snapshot; }

  subscribe(listener: (snapshot: NoteObservationSnapshot, delta: { readonly reason: Reason }) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  subscribeChanges(listener: (change: EditorCollectionChange) => void): () => void {
    this.changeListeners.add(listener);
    return () => { this.changeListeners.delete(listener); };
  }

  refresh(): Promise<ObservationOutcome> { return this.load(this.includeBody); }

  hydrate(): Promise<ObservationOutcome> {
    if (this.includeBody && this.snapshot.state === "ready") return Promise.resolve({ ok: true });
    return this.load(true);
  }

  optimistic(upserts: readonly Note[], removed: readonly string[] = []): { commit(): void; rollback(): void } {
    const overlay: Overlay = { upserts: [...upserts], removed: [...removed], committed: false };
    let settled = false;
    this.overlays.push(overlay);
    this.publish({}, "local");
    return {
      commit: () => { if (settled) return; settled = true; overlay.committed = true; this.publish({}, "local"); },
      rollback: () => {
        if (settled) return;
        settled = true;
        this.overlays = this.overlays.filter(candidate => candidate !== overlay);
        this.publish({}, "local");
      }
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.lifetime.abort();
    this.stopWatchState();
    this.watch();
    this.listeners.clear();
    this.changeListeners.clear();
    this.snapshot = { ...this.snapshot, state: "closed", watchStatus: { state: "closed" } };
  }

  private check(signal: AbortSignal): void {
    signal.throwIfAborted();
    if (this.closed || !this.isCurrent())
      throw new MdbaseError({ code: "cancelled", recovery: "none", message: t`This collection is no longer open in mdbase editor.` });
  }

  private load(includeBody: boolean): Promise<ObservationOutcome> {
    if (this.closed) return Promise.resolve(cancelled());
    // One complete snapshot at a time; a hydrate request widens the next one.
    if (this.loading) return this.includeBody || !includeBody ? this.loading : this.loading.then(() => this.load(includeBody));
    const first = this.snapshot.generation === 1 && this.snapshot.state === "loading" && !this.loading;
    const run = this.loadSnapshot(includeBody, first);
    this.loading = run;
    void run.finally(() => { if (this.loading === run) this.loading = undefined; });
    return run;
  }

  private async loadSnapshot(includeBody: boolean, first: boolean): Promise<ObservationOutcome> {
    const signal = this.lifetime.signal;
    const generation = first ? 1 : this.snapshot.generation + 1;
    if (!first) this.publish({ state: "loading", generation, problem: null }, "reload");
    try {
      await this.watch.ready;
      this.check(signal);
      const next = new Map<string, Note>();
      const paths = new Set<string>();
      let asOf: number | undefined;
      let complete = false;
      let total: number | undefined;
      for await (const page of this.client.pages({ limit: PAGE_SIZE }, { effective: true, ...(includeBody ? { body: true } : {}) }, signal)) {
        this.check(signal);
        if (asOf !== undefined && asOf !== page.asOf) throw nativeFailure(t`The collection changed while its notes were loading. Reload to try again.`);
        asOf = page.asOf;
        total ??= page.totalCount;
        for (const record of page.records) {
          if (next.has(record.id) || paths.has(record.path)) throw nativeFailure(t`The collection returned a note twice. Reload to try again.`);
          next.set(record.id, noteRecord(record));
          paths.add(record.path);
        }
        complete = page.complete && !page.cursor;
        if (first && !complete) {
          this.confirmed = new Map(next);
          this.publish({ total }, "page");
        }
      }
      if (!complete) throw nativeFailure(t`The collection did not return a complete list of notes.`);
      this.check(signal);
      this.confirmed = next;
      this.includeBody ||= includeBody;
      // A complete reread retires committed overlays; staged ones stay until settled.
      this.overlays = this.overlays.filter(overlay => !overlay.committed);
      this.publish({ state: "ready", generation, total: total ?? next.size, problem: null }, first ? "page" : "reload");
      void this.drain();
      return { ok: true };
    } catch (error) {
      if (this.closed || signal.aborted || isMdbaseError(error, "cancelled")) return cancelled();
      const problem = nativeProblem(error);
      this.publish({ state: "error", problem }, "reload");
      return { ok: false, problem };
    }
  }

  private accept(batch: wire.ChangesResult): void {
    if (this.closed) return;
    if (batch.reset) {
      this.queued.clear();
      this.emit({ source: "native", kind: "reset" });
      void (this.loading ? this.loading.then(() => this.refresh()) : this.refresh());
      return;
    }
    for (const change of batch.changes) this.queued.add(change.id);
    void this.drain();
  }

  /** Exact rereads by original record ID, serialized after any complete snapshot. */
  private async drain(): Promise<void> {
    if (this.draining || this.loading || this.closed) return;
    this.draining = true;
    const signal = this.lifetime.signal;
    try {
      while (this.queued.size && !this.loading) {
        const id = this.queued.values().next().value!;
        this.queued.delete(id);
        const previous = this.confirmed.get(id);
        const record = await this.client.find(id, { effective: true, ...(this.includeBody ? { body: true } : {}) }, signal);
        this.check(signal);
        if (this.loading) { this.queued.add(id); break; }
        let change: NativeCollectionChange | undefined;
        if (!record) {
          if (previous) {
            this.confirmed.delete(id);
            change = { source: "native", kind: "record.deleted", path: previous.path };
          }
        } else {
          const note = noteRecord(record);
          this.confirmed.set(id, note);
          change = !previous ? { source: "native", kind: "record.created", path: note.path, revision: record.revision }
            : previous.path !== note.path ? { source: "native", kind: "record.renamed", from: previous.path, to: note.path, revision: record.revision }
            : { source: "native", kind: "record.updated", path: note.path, revision: record.revision };
        }
        if (!change) continue;
        this.retire(change.kind === "record.renamed" ? [change.from, change.to] : change.kind === "reset" ? [] : [change.path]);
        this.publish({}, "changes");
        this.emit(change);
      }
    } catch (error) {
      if (!this.closed && !signal.aborted && !isMdbaseError(error, "cancelled")) this.publish({ problem: nativeProblem(error) }, "changes");
    } finally {
      this.draining = false;
    }
  }

  /** Committed overlays for reread paths are replaced by the confirmed records. */
  private retire(paths: readonly string[]): void {
    const reread = new Set(paths);
    this.overlays = this.overlays.flatMap(overlay => {
      if (!overlay.committed) return [overlay];
      const upserts = overlay.upserts.filter(note => !reread.has(note.path));
      const removed = overlay.removed.filter(path => !reread.has(path));
      return upserts.length || removed.length ? [{ ...overlay, upserts, removed }] : [];
    });
  }

  private watchChanged(state: ChangesWatchState, error: MdbaseError | null): void {
    if (this.closed) return;
    if (state === "stale") this.reconnected = true;
    if (state === "active" && this.reconnected) {
      // A resumed watch is not proof of freshness: reread one complete snapshot.
      this.reconnected = false;
      void this.refresh();
    }
    const watchStatus = watchState(state);
    if (state === "failed") {
      this.publish({ state: "error", watchStatus, problem: nativeProblem(error ?? nativeFailure(t`The collection watch stopped.`)) }, "status");
      return;
    }
    this.publish({ watchStatus }, "status");
  }

  private records(): Note[] {
    const byPath = new Map<string, Note>();
    for (const note of this.confirmed.values()) byPath.set(note.path, note);
    for (const overlay of this.overlays) {
      for (const path of overlay.removed) byPath.delete(path);
      for (const note of overlay.upserts) byPath.set(note.path, note);
    }
    return [...byPath.values()];
  }

  private publish(patch: Partial<Omit<NoteObservationSnapshot, "records">>, reason: Reason): void {
    if (this.closed) return;
    const records = this.records();
    const next = { ...this.snapshot, ...patch, records };
    // Pagination totals belong to the old read. A ready snapshot is the full
    // live membership, including watched changes and optimistic overlays.
    this.snapshot = next.state === "ready" ? { ...next, total: records.length } : next;
    for (const listener of [...this.listeners]) listener(this.snapshot, { reason });
  }

  private emit(change: NativeCollectionChange): void {
    for (const listener of [...this.changeListeners]) listener(change);
  }
}

function noteRecord(record: wire.RecordView): Note {
  return {
    path: record.path,
    revision: record.revision,
    types: [...record.types],
    frontmatter: plain(record.frontmatter),
    effectiveFrontmatter: plain(record.effective ?? record.frontmatter),
    ...(record.body === undefined ? {} : { body: record.body }),
    file: { path: record.path, ...(record.mtime === undefined ? {} : { mtime: new Date(record.mtime).toISOString() }) }
  };
}

function watchState(state: ChangesWatchState): ObservationWatchStatus {
  if (state === "starting") return { state: "connecting" };
  if (state === "active") return { state: "connected" };
  if (state === "stale") return { state: "reconnecting", problem: { message: t`Reconnecting to the collection…` } };
  return { state: "closed" };
}

function nativeFailure(message: string): MdbaseError {
  return new MdbaseError({ code: "internal", recovery: "contact_support", message });
}

function nativeProblem(error: unknown): ObservationProblem {
  return {
    source: "native",
    code: isMdbaseError(error) ? error.code : "internal",
    message: error instanceof Error ? error.message : t`The collection could not be read.`,
    error
  };
}

function cancelled(): ObservationOutcome {
  const error = new MdbaseError({ code: "cancelled", recovery: "none", message: t`This collection is no longer open in mdbase editor.` });
  return { ok: false, problem: { source: "native", code: "cancelled", message: error.message, error } };
}
