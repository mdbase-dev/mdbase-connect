import type {
  CollectionGateway,
  NoteListProgress,
  NoteSummary
} from "./model";
import { NoteIndexOverlay } from "./note-index-overlay";

export type CollectionIndexSource = Pick<CollectionGateway, "list" | "hydrateContent">;

export interface CollectionIndexState {
  notes: NoteSummary[];
  total?: number;
  listLoading: boolean;
  structureLoading: boolean;
  structureComplete: boolean;
  contentComplete: boolean;
  contentIndexing: boolean;
  contentLoaded: number;
  contentError?: string;
  snapshot?: string;
}

export interface CollectionIndexLoadResult {
  cancelled: boolean;
  notes: NoteSummary[];
}

export interface CollectionIndexLoad {
  firstPage: Promise<NoteSummary[]>;
  complete: Promise<CollectionIndexLoadResult>;
}

const EMPTY_STATE: CollectionIndexState = {
  notes: [],
  listLoading: false,
  structureLoading: false,
  structureComplete: false,
  contentComplete: false,
  contentIndexing: false,
  contentLoaded: 0
};

/**
 * Owns the collection index as one cancellable, externally observable runtime.
 * React consumes its immutable snapshots; request generations, snapshot tokens,
 * hydration deduplication, and mutation reconciliation stay out of the view.
 */
export class CollectionIndexController {
  private state: CollectionIndexState = EMPTY_STATE;
  private readonly listeners = new Set<() => void>();
  private readonly overlay = new NoteIndexOverlay();
  private generation = 0;
  private mutationVersion = 0;
  private listRequest?: AbortController;
  private contentRequest?: AbortController;
  private contentHydration?: Promise<void>;
  private readonly stagedRemovals = new Set<string>();

  constructor(
    private readonly source: CollectionIndexSource,
    private readonly errorMessage: (error: unknown) => string = defaultErrorMessage
  ) {}

  getSnapshot = (): CollectionIndexState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  beginLoad(): CollectionIndexLoad {
    this.cancelRequests();
    const controller = new AbortController();
    this.listRequest = controller;
    const generation = ++this.generation;
    const mutationVersion = this.mutationVersion;
    let lastProgress: NoteListProgress | undefined;
    let firstPageResolved = false;
    let resolveFirstPage!: (notes: NoteSummary[]) => void;
    const firstPage = new Promise<NoteSummary[]>((resolve) => { resolveFirstPage = resolve; });

    this.publish({
      ...this.state,
      total: undefined,
      listLoading: true,
      structureLoading: true,
      structureComplete: false,
      contentComplete: false,
      contentIndexing: false,
      contentLoaded: 0,
      contentError: undefined,
      snapshot: undefined
    });

    const resolveFirst = (notes: NoteSummary[]) => {
      if (firstPageResolved) return;
      firstPageResolved = true;
      resolveFirstPage(notes);
    };

    const publishProgress = (progress: NoteListProgress) => {
      if (!this.isCurrent(controller, generation)) return;
      lastProgress = progress;
      const notes = this.overlay.apply(progress.notes);
      this.publish({
        ...this.state,
        notes,
        total: progress.total ?? (progress.structureComplete ? notes.length : undefined),
        listLoading: !progress.complete,
        structureLoading: !progress.structureComplete,
        structureComplete: progress.structureComplete,
        contentComplete: progress.contentComplete ?? progress.complete,
        contentLoaded: progress.contentLoaded ?? (progress.contentComplete ? notes.length : 0),
        snapshot: progress.snapshot ?? this.state.snapshot
      });
      if (notes.length > 0 || progress.structureComplete) resolveFirst(notes);
    };

    const complete = this.source.list({
      signal: controller.signal,
      onProgress: publishProgress
    }).then((result): CollectionIndexLoadResult => {
      if (!this.isCurrent(controller, generation)) {
        resolveFirst([]);
        return { cancelled: true, notes: [] };
      }

      const rawNotes = result.notes;
      let notes = this.overlay.apply(rawNotes);
      if (!lastProgress?.complete) {
        publishProgress({
          notes,
          snapshot: result.snapshot,
          structureComplete: true,
          complete: true,
          contentComplete: lastProgress?.contentComplete ?? false,
          contentLoaded: lastProgress?.contentLoaded ?? 0,
          total: lastProgress?.total ?? notes.length
        });
      } else if (result.snapshot !== this.state.snapshot) {
        this.publish({ ...this.state, snapshot: result.snapshot });
      }

      // A load begun after the most recent accepted mutation is authoritative.
      // Retire the overlay so future external changes are not masked forever.
      if (mutationVersion === this.mutationVersion) {
        this.overlay.clear();
        this.stagedRemovals.clear();
        // Progress may mark structure complete and start hydration before the
        // list promise settles. Preserve any bodies that arrived in that gap.
        notes = carryLoadedContent(rawNotes, this.state.notes);
        if (!samePathsAndReferences(notes, this.state.notes)) {
          this.publish({ ...this.state, notes });
        }
      }
      resolveFirst(notes);
      return { cancelled: false, notes };
    }).catch((error: unknown): CollectionIndexLoadResult => {
      if (!this.isCurrent(controller, generation)) {
        resolveFirst([]);
        return { cancelled: true, notes: [] };
      }
      resolveFirst([]);
      this.publish({ ...this.state, listLoading: false, structureLoading: false });
      throw error;
    }).finally(() => {
      if (this.listRequest === controller) this.listRequest = undefined;
    });

    return { firstPage, complete };
  }

  async reload(): Promise<CollectionIndexLoadResult> {
    return this.beginLoad().complete;
  }

  hydrate(): Promise<void> {
    if (this.contentHydration) return this.contentHydration;
    const generation = this.generation;
    const controller = new AbortController();
    this.contentRequest?.abort();
    this.contentRequest = controller;
    this.publish({ ...this.state, contentIndexing: true, contentError: undefined });

    const publishProgress = (progress: NoteListProgress) => {
      if (!this.isCurrent(controller, generation, "content")) return;
      this.publish({
        ...this.state,
        notes: mergeHydratedNotes(this.state.notes, this.overlay.apply(progress.notes)),
        contentLoaded: progress.contentLoaded ?? progress.notes.length,
        contentComplete: progress.contentComplete ?? progress.complete
      });
    };

    const promise = this.source.hydrateContent({
      snapshot: this.state.snapshot,
      signal: controller.signal,
      onProgress: publishProgress
    }).then((result) => {
      if (!this.isCurrent(controller, generation, "content")) return;
      this.publish({
        ...this.state,
        notes: mergeHydratedNotes(this.state.notes, this.overlay.apply(result.notes)),
        contentLoaded: result.notes.length,
        contentComplete: true
      });
    }).catch((error: unknown) => {
      if (this.isCurrent(controller, generation, "content")) {
        this.publish({ ...this.state, contentError: this.errorMessage(error) });
      }
    }).finally(() => {
      if (this.contentHydration === promise) this.contentHydration = undefined;
      if (this.contentRequest === controller) this.contentRequest = undefined;
      if (!controller.signal.aborted && generation === this.generation) {
        this.publish({ ...this.state, contentIndexing: false });
      }
    });
    this.contentHydration = promise;
    return promise;
  }

  upsert(note: NoteSummary, previousPath = note.path): void {
    this.acceptMutation();
    this.overlay.upsert(note, previousPath);
    const previous = this.state.notes.find((item) => item.path === previousPath || item.path === note.path);
    const merged = previous?.file ? { ...note, file: { ...previous.file, ...note.file } } : note;
    this.publish({
      ...this.state,
      notes: [merged, ...this.state.notes.filter((item) => item.path !== previousPath && item.path !== note.path)]
    });
  }

  create(note: NoteSummary): void {
    const existed = this.state.notes.some((item) => item.path === note.path);
    this.upsert(note);
    if (!existed && this.state.total !== undefined) {
      this.publish({ ...this.state, total: this.state.total + 1 });
    }
  }

  stageRemoval(path: string): void {
    this.acceptMutation();
    this.overlay.remove(path);
    this.stagedRemovals.add(path);
  }

  commitRemoval(path: string): void {
    const counted = this.stagedRemovals.delete(path) || this.state.notes.some((note) => note.path === path);
    this.acceptMutation();
    this.overlay.remove(path);
    this.publish({
      ...this.state,
      notes: this.state.notes.filter((note) => note.path !== path),
      total: counted && this.state.total !== undefined ? Math.max(0, this.state.total - 1) : this.state.total
    });
  }

  rollbackRemoval(note: NoteSummary): void {
    this.stagedRemovals.delete(note.path);
    this.upsert(note);
  }

  reset(): void {
    this.cancelRequests();
    this.generation += 1;
    this.mutationVersion = 0;
    this.overlay.clear();
    this.stagedRemovals.clear();
    this.publish(EMPTY_STATE);
  }

  private acceptMutation(): void {
    this.mutationVersion += 1;
  }

  private cancelRequests(): void {
    this.listRequest?.abort();
    this.contentRequest?.abort();
    this.listRequest = undefined;
    this.contentRequest = undefined;
    this.contentHydration = undefined;
  }

  private isCurrent(controller: AbortController, generation: number, kind: "list" | "content" = "list"): boolean {
    const request = kind === "list" ? this.listRequest : this.contentRequest;
    return !controller.signal.aborted && request === controller && generation === this.generation;
  }

  private publish(next: CollectionIndexState): void {
    if (Object.is(next, this.state)) return;
    this.state = next;
    for (const listener of this.listeners) listener();
  }
}

function mergeHydratedNotes(current: NoteSummary[], hydrated: NoteSummary[]): NoteSummary[] {
  const byPath = new Map(hydrated.map((note) => [note.path, note]));
  const currentPaths = new Set(current.map((note) => note.path));
  const merged = current.map((note) => {
    const loaded = byPath.get(note.path);
    if (!loaded) return note;
    return {
      ...note,
      body: loaded.body,
      file: loaded.file ? { ...note.file, ...loaded.file } : note.file
    };
  });
  for (const note of hydrated) {
    if (!currentPaths.has(note.path)) merged.push(note);
  }
  return merged;
}

function carryLoadedContent(structure: NoteSummary[], current: NoteSummary[]): NoteSummary[] {
  const currentByPath = new Map(current.map((note) => [note.path, note]));
  return structure.map((note) => {
    const loaded = currentByPath.get(note.path);
    if (note.body !== undefined || loaded?.body === undefined) return note;
    return {
      ...note,
      body: loaded.body,
      file: loaded.file ? { ...note.file, ...loaded.file } : note.file
    };
  });
}

function samePathsAndReferences(left: readonly NoteSummary[], right: readonly NoteSummary[]): boolean {
  return left.length === right.length && left.every((note, index) => note === right[index]);
}

function defaultErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The note content index could not be loaded.";
}
