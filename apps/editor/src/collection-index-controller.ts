import { MdbaseConnectError, type CollectionChange, type MdbaseQueryObserver, type ObserveSnapshot, type QueryRecord } from "@mdbase-dev/connect";
import type { CollectionGateway, NoteFrontmatter, NoteSummary } from "./model";

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
}
export interface CollectionIndexLoadResult { cancelled: boolean; notes: NoteSummary[] }
export interface CollectionIndexLoad { firstPage: Promise<NoteSummary[]>; complete: Promise<CollectionIndexLoadResult> }
const EMPTY_STATE: CollectionIndexState = { notes: [], listLoading: false, structureLoading: false, structureComplete: false, contentComplete: false, contentIndexing: false, contentLoaded: 0 };

/** Editor presentation only. The SDK owns reads, watch, generations and overlays. */
export class CollectionIndexController {
  private observation?: MdbaseQueryObserver<NoteFrontmatter>;
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

  beginLoad(): CollectionIndexLoad {
    let resolveFirst!: (notes: NoteSummary[]) => void;
    const firstPage = new Promise<NoteSummary[]>(resolve => { resolveFirst = resolve; });
    if (!this.observation) {
      const observation = this.source.observe();
      this.observation = observation;
      observation.subscribe((snapshot, delta) => {
        if (delta.reason === "status" && snapshot.state === "ready") this.publish(this.state);
        else this.accept(snapshot);
      });
      observation.subscribeChanges(change => { for (const listener of this.changeListeners) listener(change); });
      this.accept(observation.getSnapshot());
    }
    const observation = this.observation;
    const unsubscribe = observation.subscribe((snapshot, delta) => {
      if (delta.reason === "page" || snapshot.state !== "loading") {
        resolveFirst(this.state.notes); unsubscribe();
      }
    });
    const load = observation.getSnapshot().generation === 1 && observation.getSnapshot().state === "loading" ? observation.ready : observation.refresh();
    const complete = load.then(outcome => {
      unsubscribe();
      resolveFirst(this.state.notes);
      if (!outcome.ok) {
        if (outcome.problem.code === "operation_cancelled") return { cancelled: true, notes: [] };
        throw new MdbaseConnectError(outcome.problem);
      }
      return { cancelled: false, notes: this.state.notes };
    });
    return { firstPage, complete };
  }
  reload(): Promise<CollectionIndexLoadResult> { return this.beginLoad().complete; }
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
    observation?.close();
    this.hydration = undefined;
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
      contentComplete: complete && contentLoaded === notes.length, contentLoaded });
  }
  private publish(state: CollectionIndexState): void {
    this.state = state;
    for (const listener of this.listeners) listener();
  }
}
