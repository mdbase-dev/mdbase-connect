import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { parse, stringify } from "yaml";
import type { JsonObject, SyncMutation, SyncMutationReceipt, SyncRecord } from "@mdbase/connect-protocol";
import type { SyncTransport } from "./index.js";
import { SyncError } from "./index.js";

interface MirrorEntry {
  path: string;
  revision: string;
  hash: string;
  record?: SyncRecord;
}

interface PendingMirrorMutation {
  mutation: SyncMutation;
  local_path: string;
  local_hash: string | null;
}

const MIRROR_MUTATION_CHECKPOINT_SIZE = 64;

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
  cursor: number | null;
  last_synced_at: string | null;
}

export interface MirrorInitializationPreview {
  already_initialized: boolean;
  download_documents: number;
  upload_documents: number;
  unchanged_documents: number;
  collisions: string[];
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
export class DirectoryMirror<Frontmatter extends JsonObject = JsonObject> {
  private readonly stateStore: MirrorStateStore;
  private readonly fileSystem: MirrorFileSystem;
  private readonly lease: MirrorLease;
  private readonly runtime: MirrorRuntime;
  private readonly onProgress?: (progress: MirrorProgress) => void;

  constructor(
    private readonly replicaId: string,
    private readonly transport: SyncTransport<Frontmatter>,
    options: DirectoryMirrorOptions,
    private readonly mode: "read_only" | "read_write" = "read_only"
  ) {
    this.stateStore = options.stateStore;
    this.fileSystem = options.fileSystem;
    this.lease = options.lease ?? new MemoryMirrorLease();
    this.runtime = options.runtime ?? portableMirrorRuntime;
    this.onProgress = options.onProgress;
  }

  async sync(): Promise<void> {
    await this.lease.runExclusive(() => this.syncUnlocked());
  }

  private async syncUnlocked(): Promise<void> {
    const state = await this.readState();
    if (!state) {
      await this.rebuild();
      // A writable first sync is also the import path for an existing local
      // directory: rebuild establishes the remote baseline, then a normal
      // pass journals and conditionally uploads files that were not remote.
      if (this.mode === "read_write") await this.syncUnlocked();
      return;
    }
    if (this.mode === "read_write") {
      await this.flushPending(state);
      await this.captureLocalChanges(state);
      await this.flushPending(state);
    } else {
      await this.assertUndiverged(state);
    }
    let appliedDocuments = 0;
    while (true) {
      const page = await this.transport.changes(state.cursor, 200);
      if (page.scope_epoch !== state.scope_epoch || page.reset_required) {
        await this.rebuild(state);
        return;
      }
      for (const event of page.events) {
        const eventRecordId = event.type === "put" ? event.record.record_id : event.record_id;
        if (state.conflicts?.[eventRecordId]) {
          this.refreshConflict(state, event);
        } else if (event.type === "put") {
          await this.put(state, event.record);
        } else {
          await this.remove(state, event.record_id, event.previous_path);
        }
        appliedDocuments += 1;
        this.reportProgress({
          phase: "applying",
          completed: appliedDocuments,
          total: null,
          done: false
        });
      }
      state.cursor = page.cursor;
      if (!page.has_more) {
        state.last_synced_at = this.runtime.now();
        await this.writeState(state);
        if (appliedDocuments > 0) {
          this.reportProgress({
            phase: "applying",
            completed: appliedDocuments,
            total: null,
            done: true
          });
        }
        return;
      }
      await this.writeState(state);
    }
  }

  async status(): Promise<MirrorStatus> {
    const state = await this.readState();
    if (!state) {
      return {
        state: "not_initialized",
        mode: this.mode,
        pending: 0,
        conflicts: [],
        cursor: null,
        last_synced_at: null
      };
    }
    const conflicts: MirrorStatus["conflicts"] = [];
    for (const [recordId, receipt] of Object.entries(state.conflicts ?? {})) {
      const entry = state.records[recordId];
      const pending = state.pending?.find((item) => item.mutation.record_id === recordId);
      if (receipt.status === "conflicted") {
        conflicts.push({
          record_id: recordId,
          path: pending?.local_path ?? entry?.path ?? receipt.conflict.current?.path ?? null,
          kind: "conflicted",
          message: "Local and hosted changes need a decision."
        });
      } else if (receipt.status === "rejected") {
        conflicts.push({
          record_id: recordId,
          path: pending?.local_path ?? entry?.path ?? null,
          kind: "rejected",
          message: receipt.error.message
        });
      }
    }
    const pending = state.pending?.length ?? 0;
    return {
      state: conflicts.length ? "attention" : pending ? "changes_waiting" : "up_to_date",
      mode: this.mode,
      pending,
      conflicts,
      cursor: state.cursor,
      last_synced_at: state.last_synced_at ?? null
    };
  }

  /**
   * Prove that this directory is an exact, complete copy of its last applied
   * authority cursor. The digest contains no paths or record content.
   */
  async authorityPromotionManifest(): Promise<AuthorityPromotionManifest> {
    return this.lease.runExclusive(() => this.authorityPromotionManifestUnlocked());
  }

  private async authorityPromotionManifestUnlocked(): Promise<AuthorityPromotionManifest> {
    if (this.mode !== "read_write") {
      throw new SyncError(
        "promotion_requires_writable_mirror",
        "Only a two-way full collection mirror can become the local source of truth."
      );
    }
    const state = await this.readState();
    if (!state) {
      throw new SyncError(
        "promotion_not_initialized",
        "Synchronize this folder before moving the source of truth."
      );
    }
    if ((state.pending?.length ?? 0) > 0 || Object.keys(state.conflicts ?? {}).length > 0) {
      throw new SyncError(
        "promotion_not_converged",
        "Upload or resolve every local change before moving the source of truth."
      );
    }
    await this.assertUndiverged(state);
    const resourcePaths = new Set(Object.keys(state.resources ?? {}));
    const managedPaths = new Set(Object.values(state.records).map((entry) => entry.path));
    const unmanaged = (await this.fileSystem.listMarkdown(resourcePaths))
      .filter((path) => !managedPaths.has(path));
    if (unmanaged.length > 0) {
      throw new SyncError(
        "promotion_unmanaged_files",
        `Synchronize unmanaged Markdown before promotion: ${unmanaged.join(", ")}.`
      );
    }
    return {
      cursor: state.cursor,
      digest: authorityManifestDigest([
        ...Object.entries(state.resources ?? {}).map(([path, entry]) => ({
          kind: "resource" as const,
          path,
          document_hash: entry.hash
        })),
        ...Object.values(state.records).map((entry) => ({
          kind: "record" as const,
          path: entry.path,
          // Hosted mdbase may normalize equivalent Markdown when it executes a
          // mutation. The provider-issued revision is the shared content
          // identity; assertUndiverged above separately proves the local bytes
          // still match the exact document materialized for that revision.
          document_hash: entry.revision
        }))
      ])
    };
  }

  async previewInitialization(): Promise<MirrorInitializationPreview> {
    if (await this.readState()) {
      return {
        already_initialized: true,
        download_documents: 0,
        upload_documents: 0,
        unchanged_documents: 0,
        collisions: []
      };
    }
    const session = await this.openSnapshot();
    const resources = session.resources.documents ?? [];
    const remotePaths = new Set<string>();
    let downloadDocuments = 0;
    let unchangedDocuments = 0;
    const collisions: string[] = [];
    const compareDocument = async (path: string, document: string): Promise<void> => {
      remotePaths.add(path);
      const local = await this.fileSystem.read(path);
      if (local === null) downloadDocuments += 1;
      else if (local === document) unchangedDocuments += 1;
      else collisions.push(path);
    };
    for (const resource of resources) {
      await compareDocument(resource.path, resource.document);
    }
    await this.visitSnapshotPages(session, async (records) => {
      for (const record of records) {
        await compareDocument(record.path, recordMarkdownDocument(record));
      }
    });
    const localMarkdown = await this.fileSystem.listMarkdown(new Set(resources.map((resource) => resource.path)));
    const uploadDocuments = this.mode === "read_write"
      ? localMarkdown.filter((path) => !remotePaths.has(path)).length
      : 0;
    return {
      already_initialized: false,
      download_documents: downloadDocuments,
      upload_documents: uploadDocuments,
      unchanged_documents: unchangedDocuments,
      collisions
    };
  }

  private async rebuild(prior?: MirrorState): Promise<void> {
    const session = await this.openSnapshot();
    const resources = session.resources.documents ?? [];
    const state: MirrorState = {
      protocol_version: 1,
      replica_id: this.replicaId,
      scope_epoch: session.scope_epoch,
      cursor: session.head,
      records: {},
      resources: {},
      mode: this.mode,
      pending: [],
      conflicts: {}
    };
    const collisions: string[] = [];
    for (const resource of resources) {
      const local = await this.fileSystem.read(resource.path);
      const managed = prior?.resources?.[resource.path];
      if (
        local !== null
        && local !== resource.document
        && (!managed || this.runtime.digest(local) !== managed.hash)
      ) {
        collisions.push(resource.path);
      }
    }
    const records: Array<{
      record: SyncRecord<Frontmatter>;
      document: string;
      hash: string;
    }> = [];
    const remoteRecordIds = prior ? new Set<string>() : null;
    await this.visitSnapshotPages(session, async (pageRecords) => {
      for (const record of pageRecords) {
        const document = recordMarkdownDocument(record);
        const local = await this.fileSystem.read(record.path);
        const managed = prior?.records[record.record_id];
        if (
          local !== null
          && local !== document
          && (!managed || managed.path !== record.path || this.runtime.digest(local) !== managed.hash)
        ) {
          collisions.push(record.path);
        }
        remoteRecordIds?.add(record.record_id);
        records.push({
          record,
          document,
          hash: this.runtime.digest(document)
        });
      }
    });
    if (prior) {
      for (const [recordId, entry] of Object.entries(prior.records)) {
        if (remoteRecordIds!.has(recordId)) continue;
        const local = await this.fileSystem.read(entry.path);
        if (local !== null && this.runtime.digest(local) !== entry.hash) collisions.push(entry.path);
      }
      const remoteResources = new Set(resources.map((resource) => resource.path));
      for (const entry of Object.values(prior.resources ?? {})) {
        if (remoteResources.has(entry.path)) continue;
        const local = await this.fileSystem.read(entry.path);
        if (local !== null && this.runtime.digest(local) !== entry.hash) collisions.push(entry.path);
      }
    }
    if (collisions.length) {
      throw new MirrorInitializationConflictError([...new Set(collisions)].sort());
    }

    const documentCount = resources.length + records.length;
    let appliedDocuments = 0;
    for (const resource of resources) {
      await this.putResource(state, resource, prior);
      appliedDocuments += 1;
      this.reportProgress({
        phase: "applying",
        completed: appliedDocuments,
        total: documentCount,
        done: appliedDocuments === documentCount
      });
    }
    for (const prepared of records) {
      await this.put(state, prepared.record, prior, undefined, false, prepared);
      appliedDocuments += 1;
      this.reportProgress({
        phase: "applying",
        completed: appliedDocuments,
        total: documentCount,
        done: appliedDocuments === documentCount
      });
    }
    if (prior) {
      for (const [recordId, entry] of Object.entries(prior.records)) {
        if (!state.records[recordId]) await this.remove(prior, recordId, entry.path);
      }
      for (const [path, entry] of Object.entries(prior.resources ?? {})) {
        if (!state.resources?.[path]) await this.removeResource(prior, path, entry);
      }
    }
    state.last_synced_at = this.runtime.now();
    await this.writeState(state);
  }

  private async openSnapshot(): Promise<
    Awaited<ReturnType<SyncTransport<Frontmatter>["openSession"]>>
  > {
    const session = await this.transport.openSession();
    if (session.replica_id !== this.replicaId || session.mode !== this.mode) {
      throw new SyncError(
        "invalid_mirror_session",
        `Filesystem mirror requires its own ${this.mode.replace("_", "-")} replica.`
      );
    }
    return session;
  }

  private async visitSnapshotPages(
    session: Awaited<ReturnType<SyncTransport<Frontmatter>["openSession"]>>,
    visitor: (records: Array<SyncRecord<Frontmatter>>) => Promise<void>
  ): Promise<void> {
    let page: string | undefined;
    do {
      const snapshot = await this.transport.snapshot(session.snapshot_id, page);
      if (snapshot.scope_epoch !== session.scope_epoch || snapshot.cursor !== session.head) {
        throw new SyncError("invalid_snapshot", "Hosted snapshot boundary changed during download.");
      }
      await visitor(snapshot.records);
      page = snapshot.next_page;
    } while (page);
  }

  private async put(
    state: MirrorState,
    record: SyncRecord<Frontmatter>,
    managedState: MirrorState | undefined = state,
    acceptedHash?: string | null,
    preserveAcceptedDocument = false,
    materialized?: { document: string; hash: string }
  ): Promise<void> {
    const document = materialized?.document ?? recordMarkdownDocument(record);
    const existing = await this.fileSystem.read(record.path);
    const prior = managedState?.records[record.record_id];
    if (existing !== null && existing !== document) {
      const existingHash = this.runtime.digest(existing);
      if (
        (!prior || prior.path !== record.path || existingHash !== prior.hash)
        && (acceptedHash === undefined || existingHash !== acceptedHash)
      ) {
        throw new MirrorDivergenceError(record.record_id, record.path);
      }
    }
    if (prior && prior.path !== record.path) {
      await this.remove(managedState!, record.record_id, prior.path);
    }
    const acceptedLocalHash = preserveAcceptedDocument
      && typeof acceptedHash === "string"
      && existing !== null
      && this.runtime.digest(existing) === acceptedHash
      ? acceptedHash
      : null;
    if (acceptedLocalHash === null) await this.fileSystem.write(record.path, document);
    state.records[record.record_id] = {
      path: record.path,
      revision: record.revision,
      hash: acceptedLocalHash ?? materialized?.hash ?? this.runtime.digest(document),
      ...(this.mode === "read_write" ? { record } : {})
    };
  }

  private async remove(state: MirrorState, recordId: string, pathValue: string): Promise<void> {
    const entry = state.records[recordId];
    const path = entry?.path ?? pathValue;
    const existing = await this.fileSystem.read(path);
    if (existing !== null && entry && this.runtime.digest(existing) !== entry.hash) {
      throw new MirrorDivergenceError(recordId, entry.path);
    }
    if (existing !== null) await this.fileSystem.remove(path);
    delete state.records[recordId];
  }

  private async putResource(
    state: MirrorState,
    resource: { path: string; revision: string; document: string },
    managedState?: MirrorState
  ): Promise<void> {
    const existing = await this.fileSystem.read(resource.path);
    const prior = managedState?.resources?.[resource.path];
    if (
      existing !== null
      && existing !== resource.document
      && (!prior || this.runtime.digest(existing) !== prior.hash)
    ) {
      throw new MirrorDivergenceError(`resource:${resource.path}`, resource.path);
    }
    await this.fileSystem.write(resource.path, resource.document);
    state.resources ??= {};
    state.resources[resource.path] = {
      path: resource.path,
      revision: resource.revision,
      hash: this.runtime.digest(resource.document)
    };
  }

  private async removeResource(state: MirrorState, pathValue: string, entry: MirrorEntry): Promise<void> {
    const existing = await this.fileSystem.read(pathValue);
    if (existing !== null && this.runtime.digest(existing) !== entry.hash) {
      throw new MirrorDivergenceError(`resource:${pathValue}`, pathValue);
    }
    if (existing !== null) await this.fileSystem.remove(pathValue);
    if (state.resources) delete state.resources[pathValue];
  }

  async resolveConflict(recordId: string, resolution: "local" | "remote"): Promise<void> {
    await this.lease.runExclusive(() => this.resolveConflictUnlocked(recordId, resolution));
  }

  private async resolveConflictUnlocked(
    recordId: string,
    resolution: "local" | "remote"
  ): Promise<void> {
    if (this.mode !== "read_write") {
      throw new SyncError("mirror_read_only", "Receive-only mirrors do not contain writable conflicts.");
    }
    const state = await this.readState();
    const receipt = state?.conflicts?.[recordId];
    if (!state || !receipt) {
      throw new SyncError("mirror_conflict_not_found", "Writable mirror conflict was not found.");
    }
    const pending = (state.pending ?? []).filter(
      (item) => item.mutation.record_id === recordId
    );
    if (resolution === "remote") {
      const current = receipt.status === "conflicted"
        ? receipt.conflict.current as SyncRecord<Frontmatter> | undefined
        : state.records[recordId]?.record as SyncRecord<Frontmatter> | undefined;
      await this.installRemoteResolution(state, recordId, current, pending);
      state.pending = (state.pending ?? []).filter(
        (item) => item.mutation.record_id !== recordId
      );
    } else if (receipt.status === "rejected") {
      // A rejected mutation cannot be replayed under its old idempotency key.
      // Clear this record's queued attempt so the next scan can journal the
      // user's current file as a fresh mutation.
      state.pending = (state.pending ?? []).filter(
        (item) => item.mutation.record_id !== recordId
      );
    } else {
      if (receipt.status !== "conflicted") {
        throw new SyncError("invalid_mirror_state", "Mirror conflict metadata is invalid.");
      }
      const source = pending.at(-1);
      if (!source) {
        throw new SyncError(
          "conflict_mutation_missing",
          "The local change for this sync issue is unavailable."
        );
      }
      const current = receipt.conflict.current as SyncRecord<Frontmatter> | undefined;
      const localDocument = await this.fileSystem.read(source.local_path);
      const replacements = this.localResolutionMutations(
        state,
        recordId,
        source.local_path,
        localDocument,
        current
      );
      const firstIndex = state.pending!.findIndex(
        (item) => item.mutation.record_id === recordId
      );
      state.pending = state.pending!.filter(
        (item) => item.mutation.record_id !== recordId
      );
      state.pending.splice(firstIndex < 0 ? state.pending.length : firstIndex, 0, ...replacements);
      if (current) {
        state.records[recordId] = {
          path: current.path,
          revision: current.revision,
          hash: this.runtime.digest(recordMarkdownDocument(current)),
          record: current
        };
      } else {
        delete state.records[recordId];
      }
    }
    delete state.conflicts![recordId];
    await this.writeState(state);
  }

  private async installRemoteResolution(
    state: MirrorState,
    recordId: string,
    current: SyncRecord<Frontmatter> | undefined,
    pending: PendingMirrorMutation[]
  ): Promise<void> {
    const localPaths = new Set(pending.map((item) => item.local_path));
    if (current) {
      for (const path of localPaths) {
        if (path !== current.path && await this.fileSystem.read(path) !== null) {
          await this.fileSystem.remove(path);
        }
      }
      const existing = await this.fileSystem.read(current.path);
      await this.put(
        state,
        current,
        state,
        existing === null ? null : this.runtime.digest(existing)
      );
      return;
    }
    const entry = state.records[recordId];
    if (entry) localPaths.add(entry.path);
    for (const path of localPaths) {
      if (await this.fileSystem.read(path) !== null) await this.fileSystem.remove(path);
    }
    delete state.records[recordId];
  }

  private localResolutionMutations(
    state: MirrorState,
    recordId: string,
    localPath: string,
    localDocument: string | null,
    current: SyncRecord<Frontmatter> | undefined
  ): PendingMirrorMutation[] {
    const queued: PendingMirrorMutation[] = [];
    let predecessor: string | undefined;
    const queue = (
      mutation: Omit<SyncMutation, "mutation_id" | "replica_id" | "scope_epoch" | "created_at">,
      localHash: string | null
    ) => {
      const mutationId = this.runtime.randomId();
      queued.push({
        mutation: {
          ...mutation,
          mutation_id: mutationId,
          replica_id: this.replicaId,
          scope_epoch: state.scope_epoch,
          created_at: this.runtime.now(),
          ...(predecessor ? { causal_predecessor: predecessor } : {})
        },
        local_path: localPath,
        local_hash: localHash
      });
      predecessor = mutationId;
    };
    if (localDocument === null) {
      if (current) {
        queue({
          operation: "delete",
          record_id: recordId,
          base_revision: current.revision,
          input: {}
        }, null);
      }
      return queued;
    }
    const parsed = parseMarkdown(localDocument, localPath);
    const localHash = this.runtime.digest(localDocument);
    if (!current) {
      queue({
        operation: "create",
        record_id: recordId,
        input: {
          path: localPath,
          frontmatter: parsed.frontmatter,
          body: parsed.body
        }
      }, localHash);
      return queued;
    }
    if (localDocument !== recordMarkdownDocument(current)) {
      queue({
        operation: "update",
        record_id: recordId,
        base_revision: current.revision,
        input: {
          patch: frontmatterPatch(current.frontmatter, parsed.frontmatter),
          body: parsed.body
        }
      }, localHash);
    }
    if (localPath !== current.path) {
      queue({
        operation: "rename",
        record_id: recordId,
        base_revision: current.revision,
        input: { path: localPath }
      }, localHash);
    }
    return queued;
  }

  private async captureLocalChanges(state: MirrorState): Promise<void> {
    const resourcePaths = new Set(Object.keys(state.resources ?? {}));
    for (const [path, entry] of Object.entries(state.resources ?? {})) {
      const value = await this.fileSystem.read(path);
      if (value === null || this.runtime.digest(value) !== entry.hash) {
        throw new MirrorDivergenceError(`resource:${path}`, path);
      }
    }
    const files = await this.fileSystem.listMarkdown(resourcePaths);
    const managedPaths = new Map(
      Object.entries(state.records).map(([recordId, entry]) => [entry.path, recordId])
    );
    const local = new Map<string, { document?: string; hash: string }>();
    for (const path of files) {
      const document = await this.fileSystem.read(path);
      if (document === null) continue;
      const hash = this.runtime.digest(document);
      const managed = managedPaths.get(path);
      const unchanged = managed !== undefined && state.records[managed]?.hash === hash;
      local.set(path, unchanged ? { hash } : { document, hash });
    }
    const untracked = new Set([...local.keys()].filter((path) => !managedPaths.has(path)));
    const missing = new Set(
      Object.entries(state.records)
        .filter(([, entry]) => !local.has(entry.path))
        .map(([recordId]) => recordId)
    );
    const queued: PendingMirrorMutation[] = [];
    const predecessors = new Map<string, string>();
    const queue = (
      mutation: Omit<SyncMutation, "mutation_id" | "replica_id" | "scope_epoch" | "created_at">,
      localPath: string,
      localHash: string | null
    ) => {
      const mutationId = this.runtime.randomId();
      const predecessor = predecessors.get(mutation.record_id);
      queued.push({
        mutation: {
          ...mutation,
          mutation_id: mutationId,
          replica_id: this.replicaId,
          scope_epoch: state.scope_epoch,
          created_at: this.runtime.now(),
          ...(predecessor ? { causal_predecessor: predecessor } : {})
        },
        local_path: localPath,
        local_hash: localHash
      });
      predecessors.set(mutation.record_id, mutationId);
    };

    for (const recordId of [...missing]) {
      if (state.conflicts?.[recordId]) {
        missing.delete(recordId);
        continue;
      }
      const entry = state.records[recordId]!;
      const candidates = [...untracked].filter((path) => local.get(path)?.hash === entry.hash);
      if (candidates.length !== 1) continue;
      const target = candidates[0]!;
      queue({
        operation: "rename",
        record_id: recordId,
        base_revision: entry.revision,
        input: { path: target }
      }, target, local.get(target)!.hash);
      missing.delete(recordId);
      untracked.delete(target);
    }

    for (const [recordId, entry] of Object.entries(state.records)) {
      if (state.conflicts?.[recordId]) continue;
      if (missing.has(recordId)) continue;
      const value = local.get(entry.path);
      if (!value || value.hash === entry.hash) continue;
      const record = entry.record;
      if (!record) {
        throw new SyncError(
          "mirror_state_upgrade_required",
          "Run a receive sync before editing this older writable mirror."
        );
      }
      const parsed = parseMarkdown(value.document!, entry.path);
      queue({
        operation: "update",
        record_id: recordId,
        base_revision: entry.revision,
        input: {
          patch: frontmatterPatch(record.frontmatter, parsed.frontmatter),
          body: parsed.body
        }
      }, entry.path, value.hash);
    }

    for (const recordId of missing) {
      if (state.conflicts?.[recordId]) continue;
      const entry = state.records[recordId]!;
      queue({
        operation: "delete",
        record_id: recordId,
        base_revision: entry.revision,
        input: {}
      }, entry.path, null);
    }

    for (const path of untracked) {
      const value = local.get(path)!;
      const parsed = parseMarkdown(value.document!, path);
      queue({
        operation: "create",
        record_id: this.runtime.randomId(),
        input: { path, frontmatter: parsed.frontmatter, body: parsed.body }
      }, path, value.hash);
    }
    if (queued.length) {
      state.pending!.push(...queued);
      await this.writeState(state);
    }
  }

  private async flushPending(state: MirrorState): Promise<void> {
    const pendingQueue = state.pending ??= [];
    let index = 0;
    let mutationsSinceCheckpoint = 0;
    const uploadTotal = pendingQueue.filter(
      (pending) => !state.conflicts?.[pending.mutation.record_id]
    ).length;
    let uploaded = 0;
    while (index < pendingQueue.length) {
      const pending = pendingQueue[index]!;
      if (state.conflicts?.[pending.mutation.record_id]) {
        index += 1;
        continue;
      }
      const localDocument = await this.fileSystem.read(pending.local_path);
      const localHash = localDocument === null ? null : this.runtime.digest(localDocument);
      if (localHash !== pending.local_hash) {
        throw new SyncError(
          "pending_local_changed",
          `Local edits at ${pending.local_path} changed while an earlier upload was pending.`
        );
      }
      const receipt = await this.transport.mutate(pending.mutation);
      uploaded += 1;
      this.reportProgress({
        phase: "uploading",
        completed: uploaded,
        total: uploadTotal,
        done: false
      });
      if (receipt.status === "applied" || receipt.status === "previously_applied") {
        if (receipt.record) {
          await this.put(
            state,
            receipt.record,
            state,
            pending.local_hash,
            true
          );
        } else {
          delete state.records[pending.mutation.record_id];
        }
        if (receipt.record) {
          for (const later of pendingQueue) {
            if (
              later.mutation.record_id === pending.mutation.record_id
              && later.mutation.causal_predecessor === pending.mutation.mutation_id
            ) {
              later.mutation.base_revision = receipt.record.revision;
              delete later.mutation.causal_predecessor;
            }
          }
        }
        pendingQueue.splice(index, 1);
        mutationsSinceCheckpoint += 1;
        if (mutationsSinceCheckpoint >= MIRROR_MUTATION_CHECKPOINT_SIZE) {
          await this.writeState(state);
          mutationsSinceCheckpoint = 0;
        }
        continue;
      }
      state.conflicts ??= {};
      state.conflicts[pending.mutation.record_id] = receipt;
      mutationsSinceCheckpoint += 1;
      if (mutationsSinceCheckpoint >= MIRROR_MUTATION_CHECKPOINT_SIZE) {
        await this.writeState(state);
        mutationsSinceCheckpoint = 0;
      }
      index += 1;
    }
    if (mutationsSinceCheckpoint > 0) await this.writeState(state);
    if (uploadTotal > 0) {
      this.reportProgress({
        phase: "uploading",
        completed: uploaded,
        total: uploadTotal,
        done: true
      });
    }
  }

  private refreshConflict(
    state: MirrorState,
    event: { type: "put"; record: SyncRecord<Frontmatter> } | {
      type: "remove";
      record_id: string;
      previous_path: string;
      revision: string;
    }
  ): void {
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

  private async readState(): Promise<MirrorState | null> {
    const state = await this.stateStore.read();
    if (state === null) return null;
    try {
      if (state.protocol_version !== 1 || state.replica_id !== this.replicaId) throw new Error();
      state.resources ??= {};
      state.pending ??= [];
      state.conflicts ??= {};
      state.mode ??= "read_only";
      if (state.mode !== this.mode) {
        throw new SyncError(
          "mirror_mode_mismatch",
          `Mirror metadata belongs to a ${state.mode.replace("_", "-")} replica.`
        );
      }
      return state;
    } catch (error) {
      if (error instanceof SyncError) throw error;
      throw new SyncError("invalid_mirror_state", "Mirror metadata is corrupt or belongs to another replica.");
    }
  }

  private async writeState(state: MirrorState): Promise<void> {
    await this.stateStore.write(state);
  }

  private reportProgress(progress: MirrorProgress): void {
    this.onProgress?.(progress);
  }

  private async assertUndiverged(state: MirrorState): Promise<void> {
    for (const [recordId, entry] of Object.entries(state.records)) {
      const value = await this.fileSystem.read(entry.path);
      if (value === null || this.runtime.digest(value) !== entry.hash) {
        throw new MirrorDivergenceError(recordId, entry.path);
      }
    }
    for (const [path, entry] of Object.entries(state.resources ?? {})) {
      const value = await this.fileSystem.read(entry.path);
      if (value === null || this.runtime.digest(value) !== entry.hash) {
        throw new MirrorDivergenceError(`resource:${path}`, entry.path);
      }
    }
  }
}

export class MirrorDivergenceError extends SyncError {
  constructor(public readonly recordId: string, public readonly path: string) {
    super("mirror_diverged", `Local edits at ${path} must be resolved before the mirror can continue.`);
  }
}

export class MirrorInitializationConflictError extends SyncError {
  constructor(public readonly paths: string[]) {
    super(
      "mirror_initialization_conflict",
      `Existing files differ from hosted Markdown: ${paths.join(", ")}. Move or reconcile them before syncing.`
    );
  }
}

export class WritableDirectoryMirror<Frontmatter extends JsonObject = JsonObject>
  extends DirectoryMirror<Frontmatter> {
  constructor(
    replicaId: string,
    transport: SyncTransport<Frontmatter>,
    options: DirectoryMirrorOptions
  ) {
    super(replicaId, transport, options, "read_write");
  }
}

export class WritableMirrorConflictError extends SyncError {
  constructor(public readonly recordId: string, message: string) {
    super("writable_mirror_conflict", message);
  }
}

export class WritableMirrorRejectedError extends SyncError {
  constructor(
    public readonly recordId: string,
    public readonly rejectionCode: string,
    message: string
  ) {
    super("writable_mirror_rejected", `${rejectionCode}: ${message}`);
  }
}

export function recordMarkdownDocument(record: SyncRecord): string {
  const yaml = stringify(record.frontmatter, { lineWidth: 0 }).trimEnd();
  const body = record.body ? `\n${record.body.replace(/^\n/, "")}` : "";
  return `---\n${yaml}\n---\n${body}`;
}

function parseMarkdown(document: string, path: string): { frontmatter: JsonObject; body: string } {
  const match = document.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/);
  if (!match) {
    throw new SyncError("invalid_markdown", `Writable mirror file ${path} requires YAML frontmatter.`);
  }
  let frontmatter: unknown;
  try {
    frontmatter = parse(match[1]!);
  } catch {
    throw new SyncError("invalid_frontmatter", `Writable mirror file ${path} has invalid YAML frontmatter.`);
  }
  if (!frontmatter || typeof frontmatter !== "object" || Array.isArray(frontmatter)) {
    throw new SyncError("invalid_frontmatter", `Writable mirror file ${path} requires object frontmatter.`);
  }
  return { frontmatter: frontmatter as JsonObject, body: match[2] ?? "" };
}

function frontmatterPatch(before: JsonObject, after: JsonObject): JsonObject {
  const patch: JsonObject = { ...after };
  for (const field of Object.keys(before)) {
    if (!(field in after)) patch[field] = null;
  }
  return patch;
}

export function authorityManifestDigest(entries: Array<{
  kind: "record" | "resource";
  path: string;
  document_hash: string;
}>): string {
  const manifest = sha256.create().update(utf8.encode("mdbase-authority-manifest-v1\n"));
  for (const entry of [...entries].sort((left, right) => {
    if (left.kind !== right.kind) return left.kind < right.kind ? -1 : 1;
    return compareBytes(utf8.encode(left.path), utf8.encode(right.path));
  })) {
    manifest.update(utf8.encode(entry.kind));
    manifest.update(Uint8Array.of(0));
    manifest.update(utf8.encode(entry.path));
    manifest.update(Uint8Array.of(0));
    manifest.update(utf8.encode(entry.document_hash));
    manifest.update(Uint8Array.of(10));
  }
  return bytesToHex(manifest.digest());
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = left[index]! - right[index]!;
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
}
