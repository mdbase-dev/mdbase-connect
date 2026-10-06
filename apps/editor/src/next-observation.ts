import type { CollectionChange, ConnectOutcome, JsonObject, ObserveDelta, ObserveOverlay, ObserveSnapshot, QueryRecord, WatchStatus } from "@mdbase-dev/connect";
import { connectFailure, connectProblem, connectSuccess } from "@mdbase-dev/connect/advanced";
import { toPlain, type Change, type LiveQuery, type MdbaseClient, type Query, type RecordView } from "@mdbase-dev/sdk";
import type { CollectionSyncStatus, NoteFrontmatter, NoteObservation, NoteSummary } from "./model";
import { nextErrorMessage, toConnectError, WAITING_FOR_DEVICE } from "./next-errors";

/** Rows in the first live window, and how many each widening adds. */
export const NOTE_WINDOW = 200;
/** Most recently modified first, so the window holds what people are working on. */
export const NOTE_ORDER = ["-file.mtime"];
/** Never bodies: they are read per note when it opens (`get(…, {body: true})`). */
const LIST_INCLUDE = { effective: true } as const;
/** How long a removal waits for a matching put before it is reported as a delete. */
const RENAME_PAIRING_MS = 25;

const summaries = new WeakMap<RecordView, NoteSummary>();

export function plainFrontmatter(value: RecordView["frontmatter"] | undefined): NoteFrontmatter {
  return (value ? toPlain(value) : {}) as JsonObject;
}

function folderOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}

/** A list row: frontmatter and record state, with a body only if the view carried one. */
function noteSummary(view: RecordView): NoteSummary {
  const cached = summaries.get(view);
  if (cached) return cached;
  const frontmatter = plainFrontmatter(view.frontmatter);
  const summary: NoteSummary = {
    path: view.path,
    revision: view.revision,
    types: view.types,
    frontmatter,
    effectiveFrontmatter: view.effective ? plainFrontmatter(view.effective) : frontmatter,
    ...(view.body === undefined ? {} : { body: view.body }),
    file: { path: view.path, folder: folderOf(view.path) },
    syncState: view.state.state,
    ...(view.state.hold ? { hold: view.state.hold.reason } : {})
  };
  summaries.set(view, summary);
  return summary;
}

function syncStatus(status: MdbaseClient["status"]): CollectionSyncStatus {
  return {
    confirmedThrough: status.confirmedThrough,
    pending: status.pending,
    connection: status.connection,
    holds: status.holds,
    unresolved: status.unresolved
  };
}

type ChangesResult = Parameters<Parameters<MdbaseClient["watchChanges"]>[1]>[0];

interface Overlay { token: object; record: QueryRecord<NoteFrontmatter> | null; committed: boolean }

/**
 * The note list over one windowed live query (replica-client-api.md §4).
 *
 * - The replica pushes snapshot/diff updates; there is no polling and no hydration.
 * - The window starts at {@link NOTE_WINDOW} rows and widens with `loadMore()`.
 * - Open notes and files learn about changes from the change feed, which carries
 *   IDs and paths only.
 */
export class NextNoteObservation implements NoteObservation {
  private readonly live: LiveQuery;
  private query: Query;
  private snapshot: ObserveSnapshot<NoteFrontmatter>;
  private overlays = new Map<string, Overlay>();
  private readonly listeners = new Set<(snapshot: ObserveSnapshot<NoteFrontmatter>, delta: ObserveDelta<NoteFrontmatter>) => void>();
  private readonly changeListeners = new Set<(change: CollectionChange) => void>();
  private waiters: Array<(outcome: ConnectOutcome<void>) => void> = [];
  private readonly stops: Array<() => void> = [];
  private stopFeed?: () => void;
  private removals = new Map<string, { path: string; timer: ReturnType<typeof setTimeout> }>();
  private feedCursor = 0;
  private closed = false;
  private settleReady!: (outcome: ConnectOutcome<void>) => void;
  readonly ready = new Promise<ConnectOutcome<void>>((resolve) => { this.settleReady = resolve; });

  constructor(private readonly client: MdbaseClient, window = NOTE_WINDOW) {
    this.query = { order_by: NOTE_ORDER, limit: window };
    this.snapshot = Object.freeze({ records: Object.freeze([]), state: "loading", generation: 1, problem: null, watchStatus: null });
    this.live = client.live(this.query, LIST_INCLUDE);
    this.stops.push(this.live.subscribe((_, update) => this.onLive(update)));
    this.stops.push(client.onLink(() => this.publishLink()));
    this.publishLink();
  }

  getSnapshot = (): ObserveSnapshot<NoteFrontmatter> => this.snapshot;

  subscribe = (listener: (snapshot: ObserveSnapshot<NoteFrontmatter>, delta: ObserveDelta<NoteFrontmatter>) => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  subscribeChanges(listener: (change: CollectionChange) => void): () => void {
    this.changeListeners.add(listener);
    return () => { this.changeListeners.delete(listener); };
  }

  subscribeSync(listener: (status: CollectionSyncStatus) => void): () => void {
    return this.client.onStatus((status) => listener(syncStatus(status)));
  }

  /**
   * Full-text search needs every body, which this backend deliberately never
   * loads. Titles and properties of loaded notes stay searchable.
   */
  hydrate(): Promise<ConnectOutcome<void>> {
    return Promise.resolve(connectFailure(connectProblem("unsupported_operation",
      "Searching note text isn’t available with the mdbase-next backend yet. Titles and properties are searchable.")));
  }

  refresh(): Promise<ConnectOutcome<void>> {
    if (this.closed) return Promise.resolve(cancelled());
    const next = this.waitForSnapshot();
    this.publish("status", { state: "loading", generation: this.snapshot.generation + 1, problem: null });
    void this.live.setQuery(this.query, LIST_INCLUDE);
    return next;
  }

  hasMore(): boolean {
    const limit = this.query.limit ?? Infinity;
    return this.live.records.length >= limit;
  }

  async loadMore(): Promise<void> {
    if (this.closed || !this.hasMore()) return;
    this.query = { ...this.query, limit: (this.query.limit ?? NOTE_WINDOW) + NOTE_WINDOW };
    const next = this.waitForSnapshot();
    // Records stay visible while the wider window installs.
    void this.live.setQuery(this.query, LIST_INCLUDE);
    const outcome = await next;
    if (!outcome.ok && outcome.problem.code !== "operation_cancelled") throw new Error(outcome.problem.message);
  }

  optimistic(upserts: readonly QueryRecord<NoteFrontmatter>[] = [], removed: readonly string[] = []): ObserveOverlay {
    if (this.closed) throw new Error("Observer is closed.");
    const token = {};
    const paths = [...new Set([...upserts.map((row) => row.path), ...removed])];
    for (const row of upserts) this.overlays.set(row.path, { token, record: row, committed: false });
    for (const path of removed) this.overlays.set(path, { token, record: null, committed: false });
    this.publish("local");
    return {
      commit: () => {
        for (const path of paths) {
          const overlay = this.overlays.get(path);
          if (overlay?.token === token) overlay.committed = true;
        }
        if (this.retireSettled()) this.publish("local");
      },
      rollback: () => {
        for (const path of paths) if (this.overlays.get(path)?.token === token) this.overlays.delete(path);
        if (!this.closed) this.publish("local");
      }
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const stop of this.stops.splice(0)) stop();
    this.stopFeed?.();
    for (const { timer } of this.removals.values()) clearTimeout(timer);
    this.removals.clear();
    this.live.close();
    this.overlays.clear();
    this.publish("status", { state: "closed" });
    this.settleReady(cancelled());
    for (const waiter of this.waiters.splice(0)) waiter(cancelled());
    this.listeners.clear();
    this.changeListeners.clear();
  }

  private waitForSnapshot(): Promise<ConnectOutcome<void>> {
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  private onLive(update: Parameters<Parameters<LiveQuery["subscribe"]>[0]>[1]): void {
    if (this.closed) return;
    if (update?.kind === "snapshot") {
      this.retireSettled(true);
      this.publish("page", { state: "ready", problem: null, total: this.hasMore() ? undefined : this.live.records.length });
      this.settleReady(connectSuccess(undefined));
      for (const waiter of this.waiters.splice(0)) waiter(connectSuccess(undefined));
      if (!this.stopFeed) this.followChanges(this.live.asOf);
      return;
    }
    if (update?.kind === "diff") {
      this.retireSettled(true, new Set([...(update.added ?? []), ...(update.changed ?? [])].map((row) => row.path)));
      this.publish("changes", { total: this.hasMore() ? undefined : this.live.records.length });
      return;
    }
    if (update === null && this.live.error) {
      const problem = toConnectError(this.live.error).problem;
      this.publish("status", { state: this.snapshot.state === "ready" ? "ready" : "error", problem });
      const failure = connectFailure(problem);
      this.settleReady(failure);
      for (const waiter of this.waiters.splice(0)) waiter(failure);
    }
  }

  /** Retire committed overlays the live result now reflects (or that a push replaced). */
  private retireSettled(silent = false, touched = new Set<string>()): boolean {
    let retired = false;
    const current = new Map(this.live.records.map((row) => [row.path, row]));
    for (const [path, overlay] of this.overlays) {
      if (!overlay.committed) continue;
      const row = current.get(path);
      const settled = overlay.record ? row?.revision === overlay.record.revision : !row;
      if (settled || touched.has(path)) {
        this.overlays.delete(path);
        retired = true;
      }
    }
    return retired && !silent;
  }

  private followChanges(asOf: number): void {
    this.feedCursor = asOf;
    this.stopFeed = this.client.watchChanges(String(asOf), (batch) => this.onChanges(batch));
  }

  private onChanges(batch: ChangesResult): void {
    if (this.closed) return;
    if (batch.reset) {
      this.emit({ kind: "reset", cursor: this.feedCursor, type: "reset", occurredAt: null, payload: {}, raw: {} } as unknown as CollectionChange);
      return;
    }
    for (const change of batch.changes) {
      this.feedCursor = change.version;
      if (change.kind === "remove") this.holdRemoval(change);
      else this.emitPut(change);
    }
  }

  /** A rename arrives as remove(old path) then put(new path) for one ID. */
  private holdRemoval(change: Change): void {
    const timer = setTimeout(() => {
      this.removals.delete(change.id);
      this.emit(isNote(change.path)
        ? base("record.deleted", change, { path: change.path })
        : base("file.removed", change, { fileId: change.id, previousPath: change.path }));
    }, RENAME_PAIRING_MS);
    this.removals.set(change.id, { path: change.path, timer });
  }

  private emitPut(change: Change): void {
    const removal = this.removals.get(change.id);
    if (removal) {
      clearTimeout(removal.timer);
      this.removals.delete(change.id);
    }
    if (!isNote(change.path)) {
      this.emit(base("file.changed", change, { path: change.path }));
      return;
    }
    // The live window usually already holds the new revision; open notes skip
    // their re-read when it matches what they have.
    const revision = this.live.records.find((row) => row.id === change.id)?.revision;
    const metadata = revision ? { revision } : {};
    this.emit(removal && removal.path !== change.path
      ? base("record.renamed", change, { from: removal.path, to: change.path, ...metadata })
      : base("record.updated", change, { path: change.path, ...metadata }));
  }

  private emit(change: CollectionChange): void {
    for (const listener of this.changeListeners) listener(change);
  }

  private publishLink(): void {
    if (this.closed) return;
    const link = this.client.link;
    const why = this.client.linkProblem;
    let watchStatus: WatchStatus;
    if (link === "open") watchStatus = { state: "connected", cursor: this.feedCursor, recovered: false };
    else if (link === "closed") watchStatus = { state: "closed", cursor: this.feedCursor };
    else {
      const waiting = why?.code === "unavailable" && why.reason === "no_device_online";
      watchStatus = {
        state: "reconnecting", cursor: this.feedCursor, attempt: 1, retryInMs: why?.retryAfterMs ?? 0,
        problem: waiting
          ? connectProblem("connector_offline", WAITING_FOR_DEVICE)
          : connectProblem("temporarily_unavailable", why ? nextErrorMessage(why) : "Reconnecting to the collection.")
      };
    }
    // A closed link with a cause (revoked grant, upgrade) stops the list visibly.
    if (link === "closed" && why) this.publish("changes", { watchStatus, problem: toConnectError(why).problem });
    else this.publish("status", { watchStatus });
  }

  private publish(reason: ObserveDelta<NoteFrontmatter>["reason"], patch: Partial<ObserveSnapshot<NoteFrontmatter>> = {}): void {
    const previous = this.snapshot.records;
    const records = reason === "status" ? previous : this.visible();
    const before = new Set(previous);
    const after = new Set(records.map((row) => row.path));
    const delta: ObserveDelta<NoteFrontmatter> = Object.freeze({
      reason,
      upserts: Object.freeze(records.filter((row) => !before.has(row))),
      removed: Object.freeze(previous.filter((row) => !after.has(row.path)).map((row) => row.path))
    });
    this.snapshot = Object.freeze({ ...this.snapshot, ...patch, records });
    for (const listener of this.listeners) listener(this.snapshot, delta);
  }

  private visible(): readonly QueryRecord<NoteFrontmatter>[] {
    const rows: QueryRecord<NoteFrontmatter>[] = [];
    const seen = new Set<string>();
    for (const view of this.live.records) {
      seen.add(view.path);
      const overlay = this.overlays.get(view.path);
      if (overlay) { if (overlay.record) rows.push(overlay.record); }
      else rows.push(noteSummary(view));
    }
    for (const [path, overlay] of this.overlays) if (!seen.has(path) && overlay.record) rows.push(overlay.record);
    return Object.freeze(rows);
  }
}

function isNote(path: string): boolean {
  return path.toLowerCase().endsWith(".md");
}

function base<Kind extends CollectionChange["kind"]>(kind: Kind, change: Change, fields: Record<string, unknown>): CollectionChange {
  return {
    kind, cursor: change.version, type: kind, occurredAt: new Date().toISOString(), payload: {},
    raw: { id: change.id, path: change.path, kind: change.kind, version: change.version }, ...fields
  } as unknown as CollectionChange;
}

function cancelled(): ConnectOutcome<void> {
  return connectFailure(connectProblem("operation_cancelled", "Query observation was cancelled."));
}
