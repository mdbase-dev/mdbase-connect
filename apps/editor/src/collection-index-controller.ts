import { MdbaseConnectError, type CollectionChange, type ObserveSnapshot, type QueryRecord } from "@mdbase-dev/connect";
import type { CollectionGateway, CollectionSyncStatus, NoteFrontmatter, NoteObservation, NoteSummary } from "./model";

export interface CollectionIndexState {
  notes: NoteSummary[];
  total?: number;
  listLoading: boolean;
  structureLoading: boolean;
  structureComplete: boolean;
  structureError?: string;
  contentComplete: boolean;
  contentIndexing: boolean;
  contentLoaded: number;
  contentError?: string;
  /** Windowed (mdbase-next) lists: more notes exist beyond the loaded window. */
  hasMore?: boolean;
  loadingMore?: boolean;
  sync?: CollectionSyncStatus;
}
export interface CollectionIndexLoadResult { cancelled: boolean; notes: NoteSummary[] }
const EMPTY_STATE: CollectionIndexState = { notes: [], listLoading: false, structureLoading: false, structureComplete: false, contentComplete: false, contentIndexing: false, contentLoaded: 0 };

/** Editor presentation only. The SDK owns reads, watch, generations and overlays. */
export class CollectionIndexController {
  private observation?: NoteObservation;
  private stopSync?: () => void;
  private widening?: Promise<void>;
  private state = EMPTY_STATE;
  private listeners = new Set<() => void>();
  private changeListeners = new Set<(change: CollectionChange) => void>();
  private hydration?: Promise<void>;
  private summaries = new WeakMap<QueryRecord<NoteFrontmatter>, NoteSummary>();

  constructor(private readonly source: Pick<CollectionGateway, "observe">, private readonly errorMessage: (error: unknown) => string = String) {}
  getSnapshot = (): CollectionIndexState => this.state;
  getWatchStatus = () => this.observation?.getSnapshot().watchStatus;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  subscribeChanges = (listener: (change: CollectionChange) => void): (() => void) => {
    this.changeListeners.add(listener);
    return () => { this.changeListeners.delete(listener); };
  };

  reload(): Promise<CollectionIndexLoadResult> {
    if (!this.observation) {
      const observation = this.source.observe();
      this.observation = observation;
      observation.subscribe((snapshot, delta) => {
        if (delta.reason === "status" && snapshot.state === "ready") this.publish(this.state);
        else this.accept(snapshot);
      });
      observation.subscribeChanges(change => { for (const listener of this.changeListeners) listener(change); });
      this.stopSync = observation.subscribeSync?.(sync => this.publish({ ...this.state, sync }));
      this.accept(observation.getSnapshot());
    }
    const observation = this.observation;
    const load = observation.getSnapshot().generation === 1 && observation.getSnapshot().state === "loading" ? observation.ready : observation.refresh();
    return load.then(outcome => {
      if (!outcome.ok) {
        if (outcome.problem.code === "operation_cancelled") return { cancelled: true, notes: [] };
        throw new MdbaseConnectError(outcome.problem);
      }
      return { cancelled: false, notes: this.state.notes };
    });
  }
  hydrate(): Promise<void> {
    if (this.hydration) return this.hydration;
    if (!this.observation) return Promise.resolve();
    this.publish({ ...this.state, contentIndexing: true, contentError: undefined });
    const promise = this.observation.hydrate().then(outcome => {
      if (!outcome.ok && outcome.problem.code !== "operation_cancelled") this.publish({ ...this.state, contentError: this.errorMessage(new MdbaseConnectError(outcome.problem)) });
    }).finally(() => {
      if (this.hydration === promise) {
        this.hydration = undefined;
        this.publish({ ...this.state, contentIndexing: false });
      }
    });
    this.hydration = promise;
    return promise;
  }
  /** Widen a windowed list by one page. No-op for complete (Connect) lists. */
  loadMore(): Promise<void> {
    const observation = this.observation;
    if (!observation?.loadMore || !observation.hasMore?.()) return Promise.resolve();
    if (this.widening) return this.widening;
    this.publish({ ...this.state, loadingMore: true });
    const widening = observation.loadMore().catch(error => {
      if (this.observation === observation) this.publish({ ...this.state, structureError: this.errorMessage(error) });
    }).finally(() => {
      if (this.widening === widening) this.widening = undefined;
      if (this.observation === observation) this.publish({ ...this.state, loadingMore: false, hasMore: observation.hasMore?.() ?? false });
    });
    this.widening = widening;
    return widening;
  }
  upsert(note: NoteSummary, previousPath = note.path): void {
    void this.observation?.optimistic([note], previousPath === note.path ? [] : [previousPath]).commit();
  }
  create(note: NoteSummary): void { this.upsert(note); }
  stageRemoval(path: string): void {
    const note = this.state.notes.find(note => note.path === path);
    if (note) this.observation?.optimistic([note]);
  }
  commitRemoval(path: string): void { void this.observation?.optimistic([], [path]).commit(); }
  rollbackRemoval(note: NoteSummary): void { this.upsert(note); }
  reset(): void {
    const observation = this.observation;
    this.observation = undefined;
    this.stopSync?.();
    this.stopSync = undefined;
    observation?.close();
    this.hydration = undefined;
    this.widening = undefined;
    this.publish(EMPTY_STATE);
  }
  private accept(snapshot: ObserveSnapshot<NoteFrontmatter>): void {
    const notes = snapshot.records.map(record => {
      const existing = this.summaries.get(record);
      if (existing) return existing;
      if (!record.frontmatter || !record.effectiveFrontmatter) throw new Error(`Missing frontmatter projections for ${record.path}`);
      const note = { ...record, frontmatter: record.frontmatter, effectiveFrontmatter: record.effectiveFrontmatter };
      this.summaries.set(record, note);
      return note;
    });
    const complete = snapshot.state === "ready";
    const contentLoaded = notes.filter(note => note.body !== undefined).length;
    const hydrating = this.state.contentIndexing;
    this.publish({ ...this.state, notes, total: snapshot.total ?? this.state.total,
      listLoading: !hydrating && snapshot.state === "loading", structureLoading: !hydrating && snapshot.state === "loading", structureComplete: hydrating ? this.state.structureComplete : complete,
      structureError: snapshot.problem ? this.errorMessage(new MdbaseConnectError(snapshot.problem)) : undefined,
      contentComplete: complete && contentLoaded === notes.length, contentLoaded,
      hasMore: this.observation?.hasMore?.() ?? false });
  }
  private publish(state: CollectionIndexState): void {
    this.state = state;
    for (const listener of this.listeners) listener();
  }
}
