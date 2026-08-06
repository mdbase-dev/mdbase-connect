import { fileAssetKey } from "./file-references";
import type { CollectionFile, CollectionGateway } from "./model";

export type FileAssetSnapshot =
  | { status: "idle"; file: CollectionFile }
  | { status: "loading"; file: CollectionFile }
  | { status: "ready"; file: CollectionFile; url: string }
  | { status: "too_large"; file: CollectionFile; error: string }
  | { status: "error"; file: CollectionFile; error: string };

interface AssetEntry {
  file: CollectionFile;
  status: FileAssetSnapshot["status"];
  url?: string;
  error?: string;
  references: number;
  lastUsed: number;
  request?: AbortController;
  promise?: Promise<void>;
}

export interface FileAssetStoreOptions {
  maxPreviewBytes?: number;
  maxCacheBytes?: number;
  maxEntries?: number;
}

const DEFAULT_MAX_PREVIEW_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_CACHE_BYTES = 96 * 1024 * 1024;
const DEFAULT_MAX_ENTRIES = 24;

/** Bounded, revision-aware cache for browser-previewable collection files. */
export class FileAssetStore {
  private readonly entries = new Map<string, AssetEntry>();
  private readonly listeners = new Set<() => void>();
  private version = 0;
  private readonly maxPreviewBytes: number;
  private readonly maxCacheBytes: number;
  private readonly maxEntries: number;

  constructor(
    private readonly source: Pick<CollectionGateway, "readFile">,
    options: FileAssetStoreOptions = {}
  ) {
    this.maxPreviewBytes = options.maxPreviewBytes ?? DEFAULT_MAX_PREVIEW_BYTES;
    this.maxCacheBytes = options.maxCacheBytes ?? DEFAULT_MAX_CACHE_BYTES;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  }

  getVersion = (): number => this.version;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  get(file: CollectionFile): FileAssetSnapshot {
    const entry = this.entries.get(fileAssetKey(file));
    if (!entry) return { status: "idle", file };
    if (entry.status === "ready" && entry.url) return { status: "ready", file: entry.file, url: entry.url };
    if (entry.status === "too_large") return { status: "too_large", file: entry.file, error: entry.error! };
    if (entry.status === "error") return { status: "error", file: entry.file, error: entry.error! };
    return { status: entry.status === "loading" ? "loading" : "idle", file: entry.file };
  }

  acquire(file: CollectionFile): () => void {
    const entry = this.entry(file);
    entry.references += 1;
    entry.lastUsed = Date.now();
    void this.loadEntry(entry);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      entry.references = Math.max(0, entry.references - 1);
      entry.lastUsed = Date.now();
      this.evict();
    };
  }

  async load(file: CollectionFile): Promise<FileAssetSnapshot> {
    const entry = this.entry(file);
    await this.loadEntry(entry);
    return this.get(file);
  }

  async retry(file: CollectionFile): Promise<FileAssetSnapshot> {
    const entry = this.entry(file);
    if (entry.status === "loading") return this.load(file);
    this.disposeEntry(entry);
    entry.status = "idle";
    entry.error = undefined;
    this.changed();
    return this.load(file);
  }

  invalidate(fileId: string): void {
    for (const [key, entry] of this.entries) {
      if (entry.file.fileId !== fileId) continue;
      this.disposeEntry(entry);
      this.entries.delete(key);
    }
    this.changed();
  }

  reset(): void {
    for (const entry of this.entries.values()) this.disposeEntry(entry);
    this.entries.clear();
    this.changed();
  }

  private entry(file: CollectionFile): AssetEntry {
    const key = fileAssetKey(file);
    const existing = this.entries.get(key);
    if (existing) return existing;
    for (const [candidateKey, candidate] of this.entries) {
      if (candidate.file.fileId === file.fileId && candidate.references === 0) {
        this.disposeEntry(candidate);
        this.entries.delete(candidateKey);
      }
    }
    const entry: AssetEntry = {
      file,
      status: "idle",
      references: 0,
      lastUsed: Date.now()
    };
    this.entries.set(key, entry);
    return entry;
  }

  private async loadEntry(entry: AssetEntry): Promise<void> {
    if (entry.status === "ready" || entry.status === "too_large") return;
    if (entry.promise) return entry.promise;
    if (entry.file.size > this.maxPreviewBytes) {
      entry.status = "too_large";
      entry.error = `Preview is limited to ${formatBytes(this.maxPreviewBytes)}. Download this ${formatBytes(entry.file.size)} file to open it.`;
      this.changed();
      return;
    }

    const controller = new AbortController();
    entry.request = controller;
    entry.status = "loading";
    entry.error = undefined;
    this.changed();
    const promise = this.source.readFile(entry.file, { signal: controller.signal })
      .then((blob) => {
        if (controller.signal.aborted || entry.request !== controller) return;
        entry.url = URL.createObjectURL(blob);
        entry.status = "ready";
        entry.lastUsed = Date.now();
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || entry.request !== controller) return;
        entry.status = "error";
        entry.error = error instanceof Error ? error.message : "The file could not be opened.";
      })
      .finally(() => {
        if (entry.request === controller) entry.request = undefined;
        if (entry.promise === promise) entry.promise = undefined;
        this.evict();
        this.changed();
      });
    entry.promise = promise;
    return promise;
  }

  private evict(): void {
    const ready = [...this.entries.entries()].filter(([, entry]) => entry.status === "ready");
    let bytes = ready.reduce((total, [, entry]) => total + entry.file.size, 0);
    let count = ready.length;
    const candidates = ready
      .filter(([, entry]) => entry.references === 0)
      .sort((left, right) => left[1].lastUsed - right[1].lastUsed);
    for (const [key, entry] of candidates) {
      if (bytes <= this.maxCacheBytes && count <= this.maxEntries) break;
      bytes -= entry.file.size;
      count -= 1;
      this.disposeEntry(entry);
      this.entries.delete(key);
    }
  }

  private disposeEntry(entry: AssetEntry): void {
    entry.request?.abort("File asset released");
    entry.request = undefined;
    entry.promise = undefined;
    if (entry.url) URL.revokeObjectURL(entry.url);
    entry.url = undefined;
  }

  private changed(): void {
    this.version += 1;
    for (const listener of this.listeners) listener();
  }
}

function formatBytes(value: number): string {
  if (value < 1_000_000) return `${Math.round(value / 1_000)} KB`;
  return `${Math.round(value / 1_000_000)} MB`;
}
