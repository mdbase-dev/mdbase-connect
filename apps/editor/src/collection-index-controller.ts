import { t } from "@lingui/core/macro";
import { MdbaseConnectError, type QueryRecord } from "@mdbase-dev/connect";
import type { CollectionGateway, EditorCollectionChange, NoteFrontmatter, NoteObservation, NoteObservationSnapshot, NoteSummary, ObservationProblem } from "./model";

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
  /** Advances when records change, not when pages of an unchanged view arrive. */
  revision: number;
}
export interface CollectionIndexLoadResult { cancelled: boolean; notes: NoteSummary[] }
const EMPTY_STATE: CollectionIndexState = { notes: [], listLoading: false, structureLoading: false, structureComplete: false, contentComplete: false, contentIndexing: false, contentLoaded: 0, revision: 0 };

/** Editor presentation only. The SDK owns reads, watch, generations and overlays. */
export class CollectionIndexController {
  private observation?: NoteObservation;
  private state = EMPTY_STATE;
  private listeners = new Set<() => void>();
  private changeListeners = new Set<(change: EditorCollectionChange) => void>();
  private hydration?: Promise<void>;
  private summaries = new WeakMap<QueryRecord<NoteFrontmatter>, NoteSummary>();

  constructor(private readonly source: Pick<CollectionGateway, "observe">, private readonly errorMessage: (error: unknown) => string = String) {}
  getSnapshot = (): CollectionIndexState => this.state;
  getWatchStatus = () => this.observation?.getSnapshot().watchStatus;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  subscribeChanges = (listener: (change: EditorCollectionChange) => void): (() => void) => {
    this.changeListeners.add(listener);
    return () => { this.changeListeners.delete(listener); };
  };

  reload(): Promise<CollectionIndexLoadResult> {
    if (!this.observation) {
      const observation = this.source.observe();
      this.observation = observation;
      observation.subscribe((snapshot, delta) => {
        if (delta.reason === "status" && snapshot.state === "ready") this.publish(this.state);
        else this.accept(snapshot, delta.reason);
      });
      observation.subscribeChanges(change => { for (const listener of this.changeListeners) listener(change); });
      this.accept(observation.getSnapshot(), "page");
    }
    const observation = this.observation;
    const load = observation.getSnapshot().generation === 1 && observation.getSnapshot().state === "loading" ? observation.ready : observation.refresh();
    return load.then(outcome => {
      if (!outcome.ok) {
        if (isCancelled(outcome.problem)) return { cancelled: true, notes: [] };
        throw observationError(outcome.problem);
      }
      return { cancelled: false, notes: this.state.notes };
    });
  }
  hydrate(): Promise<void> {
    if (this.hydration) return this.hydration;
    if (!this.observation) return Promise.resolve();
    this.publish({ ...this.state, contentIndexing: true, contentError: undefined });
    const promise = this.observation.hydrate().then(outcome => {
      if (!outcome.ok && !isCancelled(outcome.problem)) this.publish({ ...this.state, contentError: this.errorMessage(observationError(outcome.problem)) });
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
    // The watch can confirm a save before the save returns: then this row adds nothing.
    const shown = previousPath === note.path ? this.state.notes.find(candidate => candidate.path === note.path) : undefined;
    if (shown && sameSource(shown, note)) return;
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
  private accept(snapshot: NoteObservationSnapshot, reason: "page" | "reload" | "changes" | "local" | "status"): void {
    // Only the authority's rereads can confirm a shown note; a local row is always shown as given.
    const reread = reason === "changes" || reason === "reload";
    let shown: Map<string, NoteSummary> | undefined;
    const shownAt = (path: string) => (shown ??= new Map(this.state.notes.map(note => [note.path, note]))).get(path);
    const fresh = snapshot.records.map(record => {
      const existing = this.summaries.get(record);
      if (existing) return existing;
      if (!record.frontmatter || !record.effectiveFrontmatter) throw new Error(t`Missing frontmatter projections for ${record.path}`);
      const previous = reread ? shownAt(record.path) : undefined;
      const note = previous && confirms(previous, record) ? previous
        : { ...record, frontmatter: record.frontmatter, effectiveFrontmatter: record.effectiveFrontmatter };
      this.summaries.set(record, note);
      return note;
    });
    // Whole-collection views are memoised on this array: keep it when every note is the one shown.
    const same = fresh.length === this.state.notes.length && fresh.every((note, index) => note === this.state.notes[index]);
    const notes = same ? this.state.notes : fresh;
    const changed = reason !== "page" && !same;
    const complete = snapshot.state === "ready";
    const contentLoaded = notes.filter(note => note.body !== undefined).length;
    const hydrating = this.state.contentIndexing;
    this.publish({ ...this.state, notes, total: snapshot.total ?? this.state.total,
      listLoading: !hydrating && snapshot.state === "loading", structureLoading: !hydrating && snapshot.state === "loading", structureComplete: hydrating ? this.state.structureComplete : complete,
      structureError: snapshot.problem ? this.errorMessage(observationError(snapshot.problem)) : undefined,
      contentComplete: complete && contentLoaded === notes.length, contentLoaded,
      revision: changed ? this.state.revision + 1 : this.state.revision });
  }
  private publish(state: CollectionIndexState): void {
    this.state = state;
    for (const listener of this.listeners) listener();
  }
}

/** The same exact source, as the revision identifies it, presented the same way: types and
 * effective frontmatter also follow type definitions, and the modified time is a file fact.
 * The Editor reads no other file fact from notes. */
function sameSource(shown: NoteSummary, record: QueryRecord<NoteFrontmatter>): boolean {
  return shown.revision !== undefined && shown.revision === record.revision
    && shown.file.mtime === record.file.mtime
    && JSON.stringify(shown.types) === JSON.stringify(record.types)
    && JSON.stringify(shown.effectiveFrontmatter) === JSON.stringify(record.effectiveFrontmatter);
}

/** A reread confirms a shown summary that already holds any body it brings, e.g. not while hydrating. */
function confirms(shown: NoteSummary, record: QueryRecord<NoteFrontmatter>): boolean {
  return sameSource(shown, record) && (record.body === undefined || shown.body !== undefined);
}

function isCancelled(problem: ObservationProblem): boolean {
  return "source" in problem ? problem.code === "cancelled" : problem.code === "operation_cancelled";
}

/** Native failures keep their original SDK error; Connect problems keep their typed error. */
function observationError(problem: ObservationProblem): unknown {
  return "source" in problem ? problem.error : new MdbaseConnectError(problem);
}
