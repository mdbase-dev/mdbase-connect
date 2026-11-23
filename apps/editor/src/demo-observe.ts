import {
  MdbaseConnectError,
  connectFailure,
  connectProblem,
  connectSuccess,
  type CollectionChange,
  type ConnectOutcome,
  type ConnectProblem,
  type ObserveOptions,
  type QueryRecord,
  type WatchStatus
} from "./connect-types";
import type { CollectionGateway, NoteContentRequest, NoteFrontmatter, NoteIndexRequest, NoteIndexResult, NoteObservation, NoteSummary } from "./model";

export interface DemoObserveSnapshot {
  readonly records: readonly QueryRecord<NoteFrontmatter>[];
  readonly state: "loading" | "ready" | "error" | "closed";
  readonly generation: number;
  readonly total?: number;
  readonly problem: ConnectProblem | null;
  readonly watchStatus: WatchStatus | null;
}

export interface DemoObserveOverlay {
  commit(): void;
  rollback(): void;
}

/** Demo provider adapter only; production uses NativeNoteObservation directly. */
export function observeDemo(source: CollectionGateway & {
  list(options?: NoteIndexRequest): Promise<NoteIndexResult>;
  hydrateContent(options?: NoteContentRequest): Promise<NoteIndexResult>;
  watch(onChange: (change?: CollectionChange) => void, signal: AbortSignal, onStatus?: (status: WatchStatus) => void): Promise<void>;
}, options: ObserveOptions = {}): NoteObservation {
  return new DemoNoteObservation(source, options);
}

type ObserveReason = "changes" | "local" | "page" | "reload" | "status";

class DemoNoteObservation implements NoteObservation {
  private records = new Map<string, QueryRecord<NoteFrontmatter>>();
  private overlays = new Map<string, { token: object; record: QueryRecord<NoteFrontmatter> | null; committed: boolean }>();
  private pending = new Set<string>();
  private timer?: ReturnType<typeof setTimeout>;
  private draining = false;
  private listeners = new Set<(snapshot: DemoObserveSnapshot, delta: { readonly reason: ObserveReason }) => void>();
  private changes = new Set<(change: CollectionChange) => void>();
  private lifetime = new AbortController();
  private request = new AbortController();
  private includeBody = false;
  private snapshot: DemoObserveSnapshot = Object.freeze({
    records: Object.freeze([]),
    state: "loading",
    generation: 0,
    problem: null,
    watchStatus: null
  });
  private settleReady!: (outcome: ConnectOutcome<void>) => void;
  readonly ready = new Promise<ConnectOutcome<void>>((resolve) => { this.settleReady = resolve; });

  constructor(
    private readonly source: CollectionGateway & {
      list(options?: NoteIndexRequest): Promise<NoteIndexResult>;
      hydrateContent(options?: NoteContentRequest): Promise<NoteIndexResult>;
      watch(onChange: (change?: CollectionChange) => void, signal: AbortSignal, onStatus?: (status: WatchStatus) => void): Promise<void>;
    },
    private readonly options: ObserveOptions = {}
  ) {
    if (options.signal?.aborted) this.close();
    else {
      options.signal?.addEventListener("abort", () => this.close(), { once: true });
      void this.refresh();
    }
  }

  getSnapshot = (): DemoObserveSnapshot => this.snapshot;

  subscribe = (listener: (snapshot: DemoObserveSnapshot, delta: { readonly reason: ObserveReason }) => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  subscribeChanges(listener: (change: CollectionChange) => void): () => void {
    this.changes.add(listener);
    return () => { this.changes.delete(listener); };
  }

  hydrate(): Promise<ConnectOutcome<void>> {
    this.includeBody = true;
    return this.load(true);
  }

  refresh(): Promise<ConnectOutcome<void>> {
    return this.load(false);
  }

  optimistic(upserts: readonly QueryRecord<NoteFrontmatter>[] = [], removed: readonly string[] = []): DemoObserveOverlay {
    if (this.lifetime.signal.aborted) throw new Error("Observer is closed.");
    const token = {};
    const paths = [...new Set([...upserts.map((row) => row.path), ...removed])];
    for (const row of upserts) this.overlays.set(row.path, { token, record: row, committed: false });
    for (const path of removed) this.overlays.set(path, { token, record: null, committed: false });
    this.publish();
    return {
      commit: () => {
        for (const path of paths) {
          const overlay = this.overlays.get(path);
          if (overlay?.token === token) {
            overlay.committed = true;
            if (this.options.mode !== "manual" && !this.request.signal.aborted) this.pending.add(path);
          }
        }
        this.schedule();
      },
      rollback: () => {
        for (const path of paths) if (this.overlays.get(path)?.token === token) this.overlays.delete(path);
        if (!this.lifetime.signal.aborted) this.publish({}, "local");
      }
    };
  }

  close(): void {
    if (this.lifetime.signal.aborted) return;
    this.lifetime.abort();
    this.request.abort();
    clearTimeout(this.timer);
    this.timer = undefined;
    this.pending.clear();
    this.overlays.clear();
    this.publish({ state: "closed" }, "status");
    this.settleReady(connectFailure(connectProblem("operation_cancelled", "Query observation was cancelled.")));
    this.listeners.clear();
    this.changes.clear();
  }

  private async load(preserve: boolean): Promise<ConnectOutcome<void>> {
    if (this.lifetime.signal.aborted) return connectFailure(connectProblem("operation_cancelled", "Query observation was cancelled."));
    this.request.abort();
    this.request = new AbortController();
    const signal = this.request.signal;
    const generation = this.snapshot.generation + 1;
    this.pending.clear();
    clearTimeout(this.timer);
    this.timer = undefined;
    this.publish({ state: "loading", generation, problem: null, watchStatus: null }, "status");
    const current = () => !signal.aborted && !this.lifetime.signal.aborted;
    try {
      const accepted = new Map([...this.overlays].filter(([, overlay]) => overlay.committed));
      const loadFn = this.includeBody ? this.source.hydrateContent.bind(this.source) : this.source.list.bind(this.source);
      const result = await loadFn({
        signal,
        onProgress: (progress) => {
          if (!current()) return;
          if (!preserve) this.records = new Map(progress.notes.map((n) => [n.path, n]));
          else for (const n of progress.notes) this.records.set(n.path, n);
          this.publish({ total: progress.total }, "page");
        }
      });
      if (!current()) return connectFailure(connectProblem("operation_cancelled", "Query observation was cancelled."));
      this.records = new Map(result.notes.map((n: NoteSummary) => [n.path, n]));
      for (const [path, overlay] of accepted) if (this.overlays.get(path) === overlay) this.overlays.delete(path);
      this.settleReady(connectSuccess(undefined));
      this.publish({ state: "ready", total: this.records.size, problem: null }, "reload");
      if (this.options.mode !== "manual") {
        void this.follow(signal);
        this.schedule();
      }
      return connectSuccess(undefined);
    } catch (error) {
      if (!current()) return connectFailure(connectProblem("operation_cancelled", "Query observation was cancelled."));
      return this.fail(error);
    }
  }

  private async follow(signal: AbortSignal): Promise<void> {
    if (this.snapshot.generation === 1) await this.ready;
    if (signal.aborted) return;
    try {
      await this.source.watch((change) => {
        if (signal.aborted || !change) return;
        for (const listener of this.changes) listener(change);
        if (change.kind === "record.created" || change.kind === "record.updated" || change.kind === "record.deleted") {
          this.pending.add(change.path);
          this.schedule();
        } else if (change.kind === "record.renamed") {
          this.pending.add(change.from);
          this.pending.add(change.to);
          this.schedule();
        } else if (["reset", "gap", "unknown", "schema.changed", "config.changed", "contract.changed", "view.changed"].includes(change.kind)) {
          void this.refresh();
        }
      }, signal, (status) => {
        if (signal.aborted) return;
        this.publish({ watchStatus: status }, "status");
        if (status.state === "reset_required") void this.refresh();
      });
    } catch (error) {
      if (!signal.aborted) this.fail(error);
    }
  }

  private schedule(): void {
    const signal = this.request.signal;
    if (signal.aborted || this.options.mode === "manual" || !this.pending.size) return;
    if (this.snapshot.state !== "ready") return;
    if (!this.timer && !this.draining) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        void this.drain(signal);
      }, this.options.coalesceMs ?? 50);
    }
  }

  private async drain(signal: AbortSignal): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (!signal.aborted && this.pending.size) {
        const paths = [...this.pending];
        this.pending.clear();
        await this.rereadPaths(paths, signal);
      }
    } finally {
      this.draining = false;
      this.schedule();
    }
  }

  private async rereadPaths(paths: string[], signal: AbortSignal): Promise<void> {
    if (signal.aborted || !paths.length) return;
    const overlays = new Map([...this.overlays].filter(([path, overlay]) => paths.includes(path) && overlay.committed));
    for (const path of paths) {
      try {
        const note = await this.source.read(path);
        if (signal.aborted) return;
        this.records.set(path, note);
      } catch (error) {
        if (signal.aborted) return;
        if (error instanceof Error && error.message === "This note no longer exists.") this.records.delete(path);
      }
    }
    for (const [path, overlay] of overlays) if (overlay.committed && this.overlays.get(path) === overlay) this.overlays.delete(path);
    this.publish({ state: "ready", problem: null }, "changes");
  }

  private fail(error: unknown): ConnectOutcome<void> {
    const problem = error instanceof MdbaseConnectError
      ? error.problem
      : connectProblem("operation_failed", error instanceof Error ? error.message : "Query observation failed.");
    this.request.abort();
    this.publish({ state: "error", problem, watchStatus: this.options.mode === "manual" ? null : { state: "closed" } });
    const outcome = connectFailure(problem);
    this.settleReady(outcome);
    return outcome;
  }

  private publish(patch: Partial<DemoObserveSnapshot> = {}, reason: ObserveReason = "changes"): void {
    const visible = this.overlays.size ? new Map(this.records) : this.records;
    for (const [path, overlay] of this.overlays) {
      if (overlay.record) visible.set(path, overlay.record);
      else visible.delete(path);
    }
    const records = Object.freeze([...visible.values()]);
    const state = patch.state ?? this.snapshot.state;
    this.snapshot = Object.freeze({
      ...this.snapshot,
      ...patch,
      records,
      ...(state === "ready" ? { total: records.length } : {})
    });
    const delta = Object.freeze({ reason });
    for (const listener of this.listeners) listener(this.snapshot, delta);
  }
}
