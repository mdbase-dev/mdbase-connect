import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type {
  SyncMutation,
  SyncMutationReceipt,
  SyncRecord
} from "@mdbase/connect-protocol";
import { SyncError } from "./sync-error.js";

export interface MirrorEntry {
  path: string;
  revision: string;
  hash: string;
  record?: SyncRecord;
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
  lease?: MirrorLease;
  runtime?: MirrorRuntime;
  onProgress?: (progress: MirrorProgress) => void;
}

export interface MirrorProgress {
  phase: "uploading" | "applying";
  completed: number;
  total: number | null;
  done: boolean;
}

export interface MirrorFileSystem {
  read(path: string): Promise<string | null>;
  write(path: string, value: string): Promise<void>;
  remove(path: string): Promise<void>;
  listMarkdown(excluded: ReadonlySet<string>): Promise<string[]>;
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

/** Receive-only materialization of a sync replica into ordinary Markdown files. */
