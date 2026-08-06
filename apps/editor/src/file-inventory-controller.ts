import type {
  CollectionFile,
  CollectionGateway,
  FileListProgress
} from "./model";

export type FileInventorySource = Pick<CollectionGateway, "listFiles">;

export interface FileInventoryState {
  files: CollectionFile[];
  loading: boolean;
  complete: boolean;
  error?: string;
}

const EMPTY_STATE: FileInventoryState = {
  files: [],
  loading: false,
  complete: false
};

/** Owns the collection file descriptor inventory independently from React. */
export class FileInventoryController {
  private state: FileInventoryState = EMPTY_STATE;
  private readonly listeners = new Set<() => void>();
  private generation = 0;
  private request?: AbortController;

  constructor(
    private readonly source: FileInventorySource,
    private readonly errorMessage: (error: unknown) => string = defaultErrorMessage
  ) {}

  getSnapshot = (): FileInventoryState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  async reload(): Promise<CollectionFile[]> {
    this.request?.abort("A newer file inventory request started");
    const controller = new AbortController();
    const generation = ++this.generation;
    this.request = controller;
    this.publish({ ...this.state, loading: true, complete: false, error: undefined });

    const acceptProgress = (progress: FileListProgress) => {
      if (!this.isCurrent(controller, generation)) return;
      this.publish({
        files: stableFileOrder(progress.files),
        loading: !progress.complete,
        complete: progress.complete,
        error: undefined
      });
    };

    try {
      const files = await this.source.listFiles({
        signal: controller.signal,
        onProgress: acceptProgress
      });
      if (!this.isCurrent(controller, generation)) return [];
      const ordered = stableFileOrder(files);
      this.publish({ files: ordered, loading: false, complete: true });
      return ordered;
    } catch (error) {
      if (!this.isCurrent(controller, generation)) return [];
      this.publish({
        ...this.state,
        loading: false,
        complete: false,
        error: this.errorMessage(error)
      });
      throw error;
    } finally {
      if (this.request === controller) this.request = undefined;
    }
  }

  upsert(file: CollectionFile): void {
    const files = stableFileOrder([
      file,
      ...this.state.files.filter((candidate) => candidate.fileId !== file.fileId)
    ]);
    this.publish({ ...this.state, files });
  }

  remove(fileId: string): void {
    const files = this.state.files.filter((file) => file.fileId !== fileId);
    if (files.length !== this.state.files.length) this.publish({ ...this.state, files });
  }

  reset(): void {
    this.request?.abort("File inventory reset");
    this.request = undefined;
    this.generation += 1;
    this.publish(EMPTY_STATE);
  }

  private isCurrent(controller: AbortController, generation: number): boolean {
    return this.request === controller && !controller.signal.aborted && this.generation === generation;
  }

  private publish(state: FileInventoryState): void {
    this.state = state;
    for (const listener of this.listeners) listener();
  }
}

function stableFileOrder(files: readonly CollectionFile[]): CollectionFile[] {
  return [...files].sort((left, right) => left.path.localeCompare(right.path, undefined, {
    numeric: true,
    sensitivity: "base"
  }));
}

function defaultErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The collection files could not be read.";
}
