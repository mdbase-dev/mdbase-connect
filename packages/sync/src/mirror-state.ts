import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type {
  CollectionFileDescriptor,
  SelectiveSyncPolicy,
  SyncMutation,
  SyncMutationReceipt,
  SyncRecord,
  SyncChange
} from "@mdbase-dev/connect-protocol";
import { SyncError } from "./sync-error.js";
import { assertRecordSyncChange } from "./record-sync-change.js";
import {
  normalizeSelectiveSyncPolicy,
  validateCollectionFileDescriptor
} from "./mirror-files.js";
import {
  portableMirrorPathKey,
  validatePortableMirrorPath
} from "./portable-path.js";
import type { MirrorBinaryInfo, MirrorBlobStore } from "./mirror-file-types.js";
export type { MirrorBinaryInfo, MirrorBlobStore } from "./mirror-file-types.js";

export interface MirrorEntry {
  path: string;
  revision: string;
  hash: string;
  record?: SyncRecord;
}

export interface MirrorFileEntry {
  file: CollectionFileDescriptor;
}

export interface PendingMirrorMutation {
  mutation: SyncMutation;
  local_path: string;
  local_hash: string | null;
}

export interface MirrorLocalIssue {
  path: string;
  code: "invalid_frontmatter";
  message: string;
}

export interface StoredMirrorLocalIssue extends MirrorLocalIssue {
  hash: string;
}

export const MIRROR_MUTATION_CHECKPOINT_SIZE = 64;

export interface MirrorState {
  protocol_version: 1;
  replica_id: string;
  scope_epoch: number;
  cursor: number;
  records: Record<string, MirrorEntry>;
  resources?: Record<string, MirrorEntry>;
  files?: Record<string, MirrorFileEntry>;
  selective_sync?: SelectiveSyncPolicy;
  mode?: "read_only" | "read_write";
  pending?: PendingMirrorMutation[];
  conflicts?: Record<string, SyncMutationReceipt>;
  local_issues?: Record<string, StoredMirrorLocalIssue>;
  last_synced_at?: string;
}

export interface MirrorStateStore {
  read(): Promise<MirrorState | null>;
  write(state: MirrorState): Promise<void>;
}

export interface MirrorLease {
  runExclusive<Value>(operation: () => Promise<Value>): Promise<Value>;
}

export interface AcquiredMirrorLease extends MirrorLease {
  release(): Promise<void>;
}

export interface MirrorRuntime {
  digest(value: string): string;
  randomId(): string;
  now(): string;
}

export interface DirectoryMirrorOptions {
  stateStore: MirrorStateStore;
  fileSystem: MirrorFileSystem;
  /** Required when any non-Markdown file class is selected. */
  blobStore?: MirrorBlobStore;
  selectiveSync?: SelectiveSyncPolicy;
  lease?: MirrorLease;
  runtime?: MirrorRuntime;
  onProgress?: (progress: MirrorProgress) => void;
}

export interface MirrorProgress {
  phase: "uploading" | "downloading" | "applying";
  completed: number;
  total: number | null;
  done: boolean;
}

export interface MirrorFileSystem {
  read(path: string): Promise<string | null>;
  write(path: string, value: string): Promise<void>;
  remove(path: string): Promise<void>;
  listMarkdown(excluded: ReadonlySet<string>): Promise<string[]>;
  inspectBinary(path: string): Promise<MirrorBinaryInfo | null>;
  /** Atomically install a fully-drained byte stream at path. */
  writeBinary(path: string, source: AsyncIterable<Uint8Array>): Promise<void>;
}

export interface MirrorStatus {
  state: "not_initialized" | "up_to_date" | "changes_waiting" | "attention";
  mode: "read_only" | "read_write";
  pending: number;
  conflicts: Array<{
    record_id: string;
    path: string | null;
    kind: "conflicted" | "rejected";
    message: string;
  }>;
  local_issues: MirrorLocalIssue[];
  cursor: number | null;
  last_synced_at: string | null;
}

export interface MirrorInitializationPreview {
  already_initialized: boolean;
  download_documents: number;
  upload_documents: number;
  unchanged_documents: number;
  download_files: number;
  unchanged_files: number;
  collisions: string[];
  local_issues: MirrorLocalIssue[];
}

export interface AuthorityPromotionManifest {
  cursor: number;
  digest: string;
}

const utf8 = new TextEncoder();

export const portableMirrorRuntime: MirrorRuntime = Object.freeze({
  digest: (value: string) => bytesToHex(sha256(utf8.encode(value))),
  randomId: () => {
    if (typeof globalThis.crypto?.randomUUID !== "function") {
      throw new SyncError(
        "mirror_random_unavailable",
        "This runtime must provide crypto.randomUUID() or a MirrorRuntime adapter."
      );
    }
    return globalThis.crypto.randomUUID();
  },
  now: () => new Date().toISOString()
});

export class MemoryMirrorStateStore implements MirrorStateStore {
  private state: MirrorState | null = null;

  async read(): Promise<MirrorState | null> {
    return this.state === null ? null : structuredClone(this.state);
  }

  async write(state: MirrorState): Promise<void> {
    this.state = structuredClone(state);
  }
}

/** Deterministic test adapter; production mirrors should use persistent storage. */
export class MemoryMirrorBlobStore implements MirrorBlobStore {
  private readonly blobs = new Map<string, Uint8Array>();

  async has(contentDigest: `sha256:${string}`): Promise<boolean> {
    return this.blobs.has(contentDigest);
  }

  async *read(contentDigest: `sha256:${string}`): AsyncGenerator<Uint8Array> {
    const value = this.blobs.get(contentDigest);
    if (!value) throw new SyncError("file_blob_missing", "A staged collection file is unavailable.");
    for (let offset = 0; offset < value.byteLength; offset += 64 * 1024) {
      yield value.slice(offset, offset + 64 * 1024);
    }
  }

  async write(
    contentDigest: `sha256:${string}`,
    source: AsyncIterable<Uint8Array>
  ): Promise<void> {
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of source) {
      chunks.push(chunk.slice());
      size += chunk.byteLength;
    }
    const value = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      value.set(chunk, offset);
      offset += chunk.byteLength;
    }
    this.blobs.set(contentDigest, value);
  }

  async remove(contentDigest: `sha256:${string}`): Promise<void> {
    this.blobs.delete(contentDigest);
  }
}

/** In-process lease for filesystem-neutral adapters and deterministic tests. */
export class MemoryMirrorLease implements MirrorLease {
  private held = false;

  async runExclusive<Value>(operation: () => Promise<Value>): Promise<Value> {
    if (this.held) {
      throw new SyncError(
        "mirror_folder_in_use",
        "Another mdbase mirror process is already using this folder."
      );
    }
    this.held = true;
    try {
      return await operation();
    } finally {
      this.held = false;
    }
  }
}

export function normalizeMirrorState(
  state: MirrorState,
  replicaId: string,
  mode: "read_only" | "read_write"
): MirrorState {
  if (state.protocol_version !== 1 || state.replica_id !== replicaId) throw new Error();
  state.resources ??= {};
  state.files ??= {};
  state.selective_sync = normalizeSelectiveSyncPolicy(state.selective_sync);
  state.pending ??= [];
  state.conflicts ??= {};
  state.mode ??= "read_only";
  if (state.mode !== mode) {
    throw new SyncError(
      "mirror_mode_mismatch",
      `Mirror metadata belongs to a ${state.mode.replace("_", "-")} replica.`
    );
  }
  const physicalPaths: string[] = [];
  for (const [recordId, entry] of Object.entries(state.records)) {
    physicalPaths.push(portableMirrorPathKey(entry.path));
    if (entry.record && (entry.record.record_id !== recordId || entry.record.path !== entry.path)) {
      throw new Error();
    }
  }
  for (const [path, entry] of Object.entries(state.resources)) {
    validatePortableMirrorPath(path);
    if (path !== entry.path) throw new Error();
    physicalPaths.push(portableMirrorPathKey(entry.path));
  }
  for (const [fileId, entry] of Object.entries(state.files)) {
    validateCollectionFileDescriptor(entry.file);
    if (entry.file.file_id !== fileId) throw new Error();
    physicalPaths.push(portableMirrorPathKey(entry.file.path));
  }
  physicalPaths.sort();
  for (let index = 1; index < physicalPaths.length; index += 1) {
    if (physicalPaths[index - 1] === physicalPaths[index]) {
      throw new SyncError(
        "invalid_mirror_state",
        "Mirror metadata contains paths that alias on a supported filesystem."
      );
    }
  }
  for (const pending of state.pending) validatePortableMirrorPath(pending.local_path);
  for (const [path, issue] of Object.entries(state.local_issues ?? {})) {
    validatePortableMirrorPath(path);
    validatePortableMirrorPath(issue.path);
    if (path !== issue.path) throw new Error();
  }
  return state;
}

export function refreshMirrorConflict(state: MirrorState, event: SyncChange): void {
  assertRecordSyncChange(event);
  const recordId = event.type === "put" ? event.record.record_id : event.record_id;
  const receipt = state.conflicts?.[recordId];
  if (!receipt || receipt.status !== "conflicted") return;
  state.conflicts![recordId] = {
    ...receipt,
    conflict: {
      ...receipt.conflict,
      ...(event.type === "put"
        ? { current: event.record, current_revision: event.record.revision }
        : { current: undefined, current_revision: event.revision })
    }
  };
}

/** Receive-only materialization of a sync replica into ordinary Markdown files. */
