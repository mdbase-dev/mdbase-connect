import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type {
  CollectionFileDescriptor,
  SelectiveSyncPolicy,
  SyncMutation,
  SyncRecord
} from "@mdbase-dev/connect-protocol";
import { SyncError } from "./sync-error.js";
import {
  normalizeSelectiveSyncPolicy,
  validateCollectionFileDescriptor
} from "./mirror-files.js";
import {
  portableMirrorPathKey,
  validatePortableMirrorPath
} from "./portable-path.js";
import type { MirrorBinaryInfo, MirrorBlobStore } from "./mirror-file-types.js";
import type { ReconciliationPlan } from "./sync-planner.js";
import type { SyncBatchPhase, SyncFailure } from "./sync-model.js";
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

export interface MirrorFileConflict {
  file_id: string;
  path: string;
  code: string;
  message: string;
}

export interface MirrorLocalIssue {
  path: string;
  code: "invalid_frontmatter";
  message: string;
}

export interface DurableSyncReceipt {
  action_id: string;
  status: "completed" | "conflicted" | "rejected";
  record?: SyncRecord;
  file?: CollectionFileDescriptor;
  failure?: SyncFailure;
}

export interface DurableSyncPayloads {
  documents: Record<string, string>;
  records: Record<string, SyncRecord>;
  resources: Record<string, { path: string; revision: string; document: string }>;
  files: Record<string, CollectionFileDescriptor>;
  local_files: Record<string, {
    path: string;
    content_digest: `sha256:${string}`;
    size: number;
    media_type?: string;
  }>;
  mutations: Record<string, SyncMutation>;
}

export interface DurableSyncBatch {
  phase: SyncBatchPhase;
  plan: ReconciliationPlan;
  next_action: number;
  receipts: DurableSyncReceipt[];
  payloads: DurableSyncPayloads;
  checkpoint_before: { generation: number; cursor: number | null };
  checkpoint_after: { generation: number; cursor: number };
  failure?: SyncFailure;
}

export interface MirrorState {
  protocol_version: 1;
  /** Plan-only prerelease layout. Older layouts are rejected, never migrated. */
  engine_version?: 3;
  generation?: number;
  replica_id: string;
  scope_epoch: number;
  cursor: number;
  records: Record<string, MirrorEntry>;
  resources?: Record<string, MirrorEntry>;
  files?: Record<string, MirrorFileEntry>;
  selective_sync?: SelectiveSyncPolicy;
  mode?: "read_only" | "read_write";
  planned_conflicts?: Record<string, {
    entity: "record" | "file";
    local: import("./sync-model.js").ExpectedObjectState;
    remote: import("./sync-model.js").ExpectedObjectState;
    conflict_kind: "both_changed" | "delete_vs_change" | "path_occupied" | "rejected";
  }>;
  /** Temporary stable-identity bindings when local paths differ from the base. */
  local_bindings?: Record<string, { entity: "record" | "file"; path: string }>;
  last_synced_at?: string;
  batch?: DurableSyncBatch;
  last_completed_plan?: string;
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
  /** True when any filesystem entry occupies this exact portable path. */
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<string | null>;
  write(path: string, value: string): Promise<void>;
  /** Atomically rename one managed path without changing its bytes. */
  move(source: string, target: string): Promise<void>;
  remove(path: string): Promise<void>;
  listMarkdown(excluded: ReadonlySet<string>): Promise<string[]>;
  inspectBinary(path: string): Promise<MirrorBinaryInfo | null>;
  /** Atomically install a fully-drained byte stream at path. */
  writeBinary(path: string, source: AsyncIterable<Uint8Array>): Promise<void>;
  /** Writable-file adapters enumerate only eligible non-Markdown regular files. */
  listBinary?(excluded: ReadonlySet<string>): Promise<string[]>;
  /** Opens a fresh stream for a stable path snapshot. */
  readBinary?(path: string): Promise<AsyncIterable<Uint8Array> | null>;
}

export interface MirrorStatus {
  state:
    | "not_initialized"
    | "up_to_date"
    | "changes_waiting"
    | "attention"
    | "planned"
    | "applying"
    | "cancelled"
    | "stale"
    | "blocked"
    | "failed";
  mode: "read_only" | "read_write";
  pending: number;
  pending_files: number;
  conflicts: Array<{
    record_id: string;
    path: string | null;
    kind: "conflicted" | "rejected";
    message: string;
  }>;
  file_conflicts: MirrorFileConflict[];
  local_issues: MirrorLocalIssue[];
  cursor: number | null;
  last_synced_at: string | null;
  generation?: number;
  pending_checkpoint?: number | null;
  plan_fingerprint?: string;
  last_completed_plan?: string;
  recovery_required?: boolean;
  failure?: import("./sync-model.js").SyncFailure;
}

export interface MirrorInitializationPreview {
  already_initialized: boolean;
  download_documents: number;
  upload_documents: number;
  unchanged_documents: number;
  download_files: number;
  upload_files: number;
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

  async prune(retained: ReadonlySet<`sha256:${string}`>): Promise<void> {
    for (const digest of this.blobs.keys()) {
      if (!retained.has(digest as `sha256:${string}`)) this.blobs.delete(digest);
    }
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
  if (state.engine_version !== 3) {
    throw new SyncError(
      "mirror_state_upgrade_required",
      "Rebuild this prerelease mirror with the plan-only exact-document sync engine."
    );
  }
  if (state.protocol_version !== 1 || state.replica_id !== replicaId) throw new Error();
  state.resources ??= {};
  state.generation ??= 0;
  state.files ??= {};
  state.selective_sync = normalizeSelectiveSyncPolicy(state.selective_sync);
  state.planned_conflicts ??= {};
  state.local_bindings ??= {};
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
  for (const [identity, conflict] of Object.entries(state.planned_conflicts)) {
    if (identity === "" || (conflict.entity !== "record" && conflict.entity !== "file")) throw new Error();
    if (conflict.local.state === "exact") validatePortableMirrorPath(conflict.local.object.path);
    if (conflict.remote.state === "exact") validatePortableMirrorPath(conflict.remote.object.path);
  }
  for (const binding of Object.values(state.local_bindings)) {
    validatePortableMirrorPath(binding.path);
  }
  return state;
}

/** Receive-only materialization of a sync replica into ordinary Markdown files. */
