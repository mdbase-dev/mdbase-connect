import type {
  CollectionFileDescriptor,
  JsonObject,
  SelectiveSyncPolicy,
  SyncChange,
  SyncMutation,
  SyncRecord
} from "@mdbase-dev/connect-protocol";
import type { SyncTransport } from "./sync-types.js";
import { SyncError } from "./sync-error.js";
import { MirrorDivergenceError } from "./mirror-errors.js";
import {
  parseMarkdown,
  recordMarkdownDocument
} from "./mirror-format.js";
import {
  MemoryMirrorLease,
  MIRROR_MUTATION_CHECKPOINT_SIZE,
  normalizeMirrorState,
  portableMirrorRuntime,
  refreshMirrorConflict,
  type AuthorityPromotionManifest,
  type DirectoryMirrorOptions,
  type MirrorFileSystem,
  type MirrorBlobStore,
  type MirrorInitializationPreview,
  type MirrorLease,
  type MirrorProgress,
  type MirrorRuntime,
  type MirrorState,
  type MirrorStateStore,
  type MirrorStatus,
  type PendingMirrorFileMutation,
  type PendingMirrorMutation
} from "./mirror-state.js";
import {
  validateRecordPath,
  type MirrorRecordPathPolicy
} from "./mirror-path-policy.js";
import { assertMirrorUndiverged } from "./mirror-integrity.js";
import { captureMirrorLocalChanges } from "./mirror-local-changes.js";
import {
  captureMirrorLocalFiles,
  flushPendingMirrorFiles
} from "./mirror-local-files.js";
import { MirrorMaterializer } from "./mirror-materializer.js";
import { buildAuthorityPromotionManifest } from "./mirror-promotion.js";
import {
  physicalMirrorPathKey,
  preflightChangePhysicalPaths
} from "./mirror-physical-path.js";
import {
  openMirrorSnapshot,
  rebuildMirror,
  type LoadedMirrorSnapshot
} from "./mirror-rebuild.js";
import {
  ensureFileBlob,
  fileSelected,
  normalizeSelectiveSyncPolicy,
  pathSelected,
  sameBinaryInfo,
  validateCollectionFileDescriptor,
  validateVisibleCollectionPath,
  visitFileSnapshotPages
} from "./mirror-files.js";
import {
  mirrorApplyResult,
  type MirrorApplyResult,
  type MirrorPlanIssue,
  type MirrorSyncPlan
} from "./mirror-plan.js";
import { checkpointMirrorStatus, mirrorStatusFromPlan } from "./mirror-status.js";
import {
  DirectoryMirrorPlanner,
  preflightProjectedPaths,
  type MirrorInspection
} from "./directory-mirror-planner.js";

type UnidentifiedSyncMutation =
  | Omit<Extract<SyncMutation, { operation: "put" }>,
      "mutation_id" | "replica_id" | "scope_epoch" | "created_at">
  | Omit<Extract<SyncMutation, { operation: "delete" }>,
      "mutation_id" | "replica_id" | "scope_epoch" | "created_at">
  | Omit<Extract<SyncMutation, { operation: "move" }>,
      "mutation_id" | "replica_id" | "scope_epoch" | "created_at">;

export class DirectoryMirror<Frontmatter extends JsonObject = JsonObject> {
  private readonly stateStore: MirrorStateStore;
  private readonly fileSystem: MirrorFileSystem;
  private readonly blobStore?: MirrorBlobStore;
  private readonly selectiveSync: SelectiveSyncPolicy;
  private readonly lease: MirrorLease;
  private readonly runtime: MirrorRuntime;
  private readonly materializer: MirrorMaterializer;
  private readonly onProgress?: (progress: MirrorProgress) => void;

  constructor(
    private readonly replicaId: string,
    private readonly transport: SyncTransport<Frontmatter>,
    options: DirectoryMirrorOptions,
    private readonly mode: "read_only" | "read_write" = "read_only"
  ) {
    this.stateStore = options.stateStore;
    this.fileSystem = options.fileSystem;
    this.blobStore = options.blobStore;
    this.selectiveSync = normalizeSelectiveSyncPolicy(options.selectiveSync);
    this.lease = options.lease ?? new MemoryMirrorLease();
    this.runtime = options.runtime ?? portableMirrorRuntime;
    this.materializer = new MirrorMaterializer(
      this.fileSystem,
      this.runtime,
      this.mode,
      this.blobStore
    );
    this.onProgress = options.onProgress;
  }

  async sync(options: { signal?: AbortSignal } = {}): Promise<MirrorApplyResult> {
    return this.lease.runExclusive(async () => {
      const inspection = await this.inspectUnlocked();
      return this.applyUnlocked(inspection.plan, options.signal, false, inspection);
    });
  }

  /** Inspect both sides without writing files, metadata, blobs, or authority state. */
  async inspect(): Promise<MirrorSyncPlan> {
    return this.lease.runExclusive(async () => (await this.inspectUnlocked()).plan);
  }

  /** Apply only the exact plan the caller inspected, after a full revalidation. */
  async apply(
    plan: MirrorSyncPlan,
    options: { signal?: AbortSignal } = {}
  ): Promise<MirrorApplyResult> {
    return this.lease.runExclusive(() => this.applyUnlocked(plan, options.signal));
  }

  private async applyUnlocked(
    plan: MirrorSyncPlan,
    signal?: AbortSignal,
    revalidate = true,
    inspected?: MirrorInspection<Frontmatter>
  ): Promise<MirrorApplyResult> {
    const inspection = revalidate ? await this.inspectUnlocked() : inspected ?? { plan };
    const current = inspection.plan;
    if (revalidate && current.fingerprint !== plan.fingerprint) {
      throw new SyncError(
        "sync_plan_stale",
        "The local folder or authority changed. Inspect the sync plan again."
      );
    }
    if (current.issues.some((issue) => issue.blocking)) {
      const checkpoint = await this.checkpointStatusUnlocked();
      return mirrorApplyResult("attention", current, checkpoint, 0);
    }
    if (signal?.aborted) {
      const checkpoint = await this.checkpointStatusUnlocked();
      return mirrorApplyResult("cancelled", current, checkpoint, 0);
    }
    try {
      await this.syncUnlocked(
        signal,
        true,
        inspection.snapshot,
        inspection.incremental
      );
      await this.pruneFileBlobs();
    } catch (error) {
      if (!signal?.aborted && !isAbortError(error)) throw error;
      const checkpoint = await this.checkpointStatusUnlocked();
      const pending = checkpoint.pending;
      return mirrorApplyResult(
        "cancelled",
        current,
        checkpoint,
        Math.max(0, current.actions.length - pending)
      );
    }
    const checkpoint = await this.checkpointStatusUnlocked();
    const attention = checkpoint.conflicts.length > 0
      || checkpoint.file_conflicts.length > 0
      || checkpoint.local_issues.length > 0;
    return mirrorApplyResult(
      attention ? "attention" : signal?.aborted ? "cancelled" : "applied",
      current,
      checkpoint,
      Math.max(0, current.actions.length - checkpoint.pending)
    );
  }

  private async syncUnlocked(
    signal?: AbortSignal,
    prevalidated = false,
    snapshot?: LoadedMirrorSnapshot<Frontmatter>,
    incremental?: NonNullable<MirrorInspection<Frontmatter>["incremental"]>
  ): Promise<void> {
    if (signal?.aborted) return;
    const state = incremental?.state ?? await this.readState();
    if (!state) {
      await this.rebuild(undefined, snapshot, prevalidated);
      // A writable first sync is also the import path for an existing local
      // directory: rebuild establishes the remote baseline, then a normal
      // pass journals and conditionally uploads files that were not remote.
      if (this.mode === "read_write") await this.syncUnlocked(signal, false);
      return;
    }
    if (JSON.stringify(state.selective_sync) !== JSON.stringify(this.selectiveSync)) {
      if (this.mode === "read_write" && (
        (state.pending?.length ?? 0) > 0
        || (state.pending_files?.length ?? 0) > 0
        || Object.keys(state.conflicts ?? {}).length > 0
        || Object.keys(state.file_conflicts ?? {}).length > 0
      )) {
        throw new SyncError(
          "selective_sync_pending_changes",
          "Upload pending Markdown changes before changing selective sync."
        );
      }
      await this.rebuild(state, snapshot, prevalidated);
      if (this.mode === "read_write") await this.syncUnlocked(signal, false);
      return;
    }
    const appliedIdentities = new Set<string>();
    if (this.mode === "read_write") {
      if (incremental?.stageFiles) {
        state.pending_files = [];
        await captureMirrorLocalFiles({
          state,
          fileSystem: this.fileSystem,
          blobStore: this.blobStore,
          selectiveSync: this.selectiveSync,
          runtime: this.runtime
        });
      }
      const hadPending = (state.pending?.length ?? 0) > 0
        || (state.pending_files?.length ?? 0) > 0;
      const pendingRecordsBefore = (state.pending ?? []).map((item) => ({
        mutationId: item.mutation.mutation_id,
        identity: `record:${item.mutation.record_id}`
      }));
      const pendingFilesBefore = (state.pending_files ?? []).map((item) => ({
        key: item.operation === "upload" ? item.transfer_id : item.mutation_id,
        identity: `file:${item.file_id ?? `new:${item.path}`}`
      }));
      await this.flushPending(state);
      await this.flushPendingFiles(state);
      if (!hadPending && !incremental) {
        await this.captureLocalChanges(state);
        await this.flushPending(state);
        await this.flushPendingFiles(state);
      }
      const remainingRecords = new Set(
        (state.pending ?? []).map((item) => item.mutation.mutation_id)
      );
      const remainingFiles = new Set(
        (state.pending_files ?? []).map((item) =>
          item.operation === "upload" ? item.transfer_id : item.mutation_id
        )
      );
      for (const item of pendingRecordsBefore) {
        if (!remainingRecords.has(item.mutationId)) appliedIdentities.add(item.identity);
      }
      for (const item of pendingFilesBefore) {
        if (!remainingFiles.has(item.key)) appliedIdentities.add(item.identity);
      }
    } else if (!prevalidated) {
      await assertMirrorUndiverged(
        state,
        await this.currentRecordPathPolicy(state),
        this.fileSystem,
        this.runtime.digest
      );
    }
    let appliedDocuments = 0;
    let preparedPage = 0;
    while (true) {
      if (signal?.aborted) return;
      const page = incremental
        ? incremental.pages[preparedPage++]
        : await this.transport.changes(state.cursor, 200);
      if (!page) {
        throw new SyncError(
          "invalid_sync_plan",
          "The inspected change-page sequence ended before its declared cursor."
        );
      }
      if (page.scope_epoch !== state.scope_epoch || page.reset_required) {
        await this.rebuild(state);
        return;
      }
      for (const event of page.events) {
        if (signal?.aborted) {
          await this.writeState(state);
          return;
        }
        if (event.type === "file_put") validateCollectionFileDescriptor(event.file);
      }
      const recordEvents = page.events.filter(
        (event): event is Extract<SyncChange<Frontmatter>, { type: "put" | "remove" }> =>
          event.type === "remove"
          || (event.type === "put" && pathSelected(this.selectiveSync, event.record.path))
      );
      if (recordEvents.some((event) => event.type === "put")) {
        preflightChangePhysicalPaths(
          recordEvents,
          await this.currentRecordPathPolicy(state),
          state
        );
      }
      if (page.events.length > 0) {
        preflightProjectedPaths(state, page.events, this.selectiveSync);
      }
      for (const event of page.events) {
        if (event.type === "file_put" && fileSelected(this.selectiveSync, event.file)) {
          if (!this.blobStore) {
            throw new SyncError(
              "file_storage_unavailable",
              "Selected collection files require a content-addressed blob store adapter."
            );
          }
          await ensureFileBlob(this.transport, this.blobStore, event.file);
        }
      }
      for (const event of page.events) {
        appliedIdentities.add(event.type === "put" || event.type === "remove"
          ? `record:${event.type === "put" ? event.record.record_id : event.record_id}`
          : `file:${event.type === "file_put" ? event.file.file_id : event.file_id}`);
        if (event.type === "file_put") {
          if (fileSelected(this.selectiveSync, event.file)) {
            if (
              incremental?.localFileIds.has(event.file.file_id)
              && !state.file_conflicts?.[event.file.file_id]
            ) continue;
            const accepted = state.files?.[event.file.file_id]?.file;
            if (!accepted || !sameBinaryInfo(accepted, event.file)) {
              await this.materializer.putFile(state, event.file);
            }
            // A mutation receipt may have checkpointed this descriptor while
            // the user made a newer local edit. Its change-feed echo advances
            // the cursor without overwriting those newer, unplanned bytes.
          } else {
            await this.materializer.removeFile(state, event.file.file_id);
          }
          appliedDocuments += 1;
          this.reportProgress({ phase: "applying", completed: appliedDocuments, total: null, done: false });
          continue;
        }
        if (event.type === "file_remove") {
          if (
            incremental?.localFileIds.has(event.file_id)
            && !state.file_conflicts?.[event.file_id]
          ) continue;
          await this.materializer.removeFile(state, event.file_id);
          appliedDocuments += 1;
          this.reportProgress({ phase: "applying", completed: appliedDocuments, total: null, done: false });
          continue;
        }
        const eventRecordId = event.type === "put" ? event.record.record_id : event.record_id;
        const localEntry = state.records[eventRecordId];
        const localPath = localEntry?.path;
        const alreadyApplied = this.mode === "read_write"
          && event.type === "put"
          && localEntry?.record !== undefined
          && localEntry.path === event.record.path
          && localEntry.revision === event.record.revision;
        const locallySuperseded = incremental?.localRecordIds.has(eventRecordId)
          && !state.conflicts?.[eventRecordId];
        if (alreadyApplied || locallySuperseded) {
          // The mutation receipt has already accepted and checkpointed these
          // local bytes. Replaying our own change event must not canonicalize
          // or otherwise rewrite the source file.
        } else if (localPath && state.local_issues?.[localPath]) {
          // Preserve invalid local bytes. Once fixed, the edit uses the last
          // accepted base and becomes an ordinary conflict if remote changed.
        } else if (state.conflicts?.[eventRecordId]) {
          refreshMirrorConflict(state, event);
        } else if (event.type === "put" && pathSelected(this.selectiveSync, event.record.path)) {
          await this.materializer.put(state, event.record, {
            physicalPathPreflighted: true
          });
        } else if (event.type === "put") {
          if (state.records[event.record.record_id]) {
            await this.materializer.remove(state, event.record.record_id, event.record.path);
          }
        } else {
          await this.materializer.remove(
            state,
            event.record_id,
            event.previous_path
          );
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
        appliedDocuments = appliedIdentities.size;
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

  private async inspectUnlocked(): Promise<MirrorInspection<Frontmatter>> {
    return new DirectoryMirrorPlanner(
      this.replicaId,
      this.transport,
      this.mode,
      this.fileSystem,
      this.blobStore,
      this.selectiveSync,
      this.runtime,
      () => this.readState(),
      (state) => this.currentRecordPathPolicy(state)
    ).inspectDetailed();
  }

  async status(): Promise<MirrorStatus> {
    const checkpoint = await this.checkpointStatus();
    if (checkpoint.state === "not_initialized") return checkpoint;
    return mirrorStatusFromPlan(checkpoint, await this.inspect());
  }

  /** Cheap durable checkpoint status; it deliberately makes no freshness claim. */
  async checkpointStatus(): Promise<MirrorStatus> {
    return this.lease.runExclusive(() => this.checkpointStatusUnlocked());
  }

  private async checkpointStatusUnlocked(): Promise<MirrorStatus> {
    return checkpointMirrorStatus(await this.readState(), this.mode);
  }

  /**
   * Prove that this directory is an exact, complete copy of its last applied
   * authority cursor. The digest commits to paths, stable record identities,
   * and exact document hashes without exposing those values to the control plane.
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
    return buildAuthorityPromotionManifest({
      state,
      selectiveSync: this.selectiveSync,
      fileSystem: this.fileSystem,
      pathPolicy: await this.currentRecordPathPolicy(state),
      digest: this.runtime.digest
    });
  }

  async previewInitialization(): Promise<MirrorInitializationPreview> {
    const plan = await this.inspect();
    const uploads = plan.actions.filter((action) => action.direction === "local_to_authority");
    const downloads = plan.actions.filter((action) => action.direction === "authority_to_local");
    return {
      already_initialized: plan.kind === "incremental",
      download_documents: downloads.filter((action) => action.entity !== "file").length,
      upload_documents: uploads.filter((action) => action.entity === "record").length,
      unchanged_documents: 0,
      download_files: downloads.filter((action) => action.entity === "file").length,
      upload_files: uploads.filter((action) => action.entity === "file").length,
      unchanged_files: 0,
      collisions: plan.issues
        .filter((issue) => issue.code === "local_collision" && issue.path)
        .map((issue) => issue.path!),
      local_issues: plan.issues
        .filter((issue): issue is MirrorPlanIssue & { path: string } =>
          issue.code === "invalid_frontmatter" && issue.path !== undefined
        )
        .map((issue) => ({ code: "invalid_frontmatter", message: issue.message, path: issue.path }))
    };
  }

  private async rebuild(
    prior?: MirrorState,
    snapshot?: LoadedMirrorSnapshot<Frontmatter>,
    collisionPreflighted = false
  ): Promise<void> {
    const state = await rebuildMirror(
      {
        replicaId: this.replicaId,
        transport: this.transport,
        mode: this.mode,
        fileSystem: this.fileSystem,
        runtime: this.runtime,
        materializer: this.materializer,
        blobStore: this.blobStore,
        selectiveSync: this.selectiveSync,
        reportProgress: (progress) => this.reportProgress(progress)
      },
      prior,
      snapshot,
      collisionPreflighted
    );
    await this.writeState(state);
  }

  async resolveConflict(recordId: string, resolution: "local" | "remote"): Promise<void> {
    await this.lease.runExclusive(() => this.resolveConflictUnlocked(recordId, resolution));
  }

  async resolveFileConflict(fileId: string, resolution: "local" | "remote"): Promise<void> {
    await this.lease.runExclusive(() => this.resolveFileConflictUnlocked(fileId, resolution));
  }

  private async resolveFileConflictUnlocked(
    fileId: string,
    resolution: "local" | "remote"
  ): Promise<void> {
    if (this.mode !== "read_write") {
      throw new SyncError("mirror_read_only", "Receive-only mirrors do not contain writable file conflicts.");
    }
    const state = await this.readState();
    const conflict = state?.file_conflicts?.[fileId];
    if (!state || !conflict) {
      throw new SyncError("mirror_file_conflict_not_found", "Writable file conflict was not found.");
    }
    const pending = (state.pending_files ?? []).filter((item) =>
      item.operation === "upload" && !item.file_id
        ? `new:${item.path}` === fileId
        : item.file_id === fileId
    );
    if (pending.length !== 1) {
      throw new SyncError("invalid_mirror_state", "Writable file conflict has no unique pending mutation.");
    }
    const source = pending[0]!;
    const authorityFiles = await this.currentAuthorityFiles();
    const currentById = fileId.startsWith("new:")
      ? undefined
      : authorityFiles.find((file) => file.file_id === fileId);
    const currentAtPath = authorityFiles.find((file) =>
      physicalMirrorPathKey(file.path) === physicalMirrorPathKey(source.path)
    );
    const current = currentById ?? currentAtPath;
    state.pending_files = state.pending_files!.filter((item) => item !== source);

    if (resolution === "remote") {
      const localPaths = new Set([source.path]);
      if (source.operation === "move") localPaths.add(source.from_path);
      const prior = source.operation === "upload" && !source.file_id
        ? undefined
        : state.files?.[source.file_id!]?.file;
      if (prior) localPaths.add(prior.path);
      for (const path of localPaths) {
        if (await this.fileSystem.inspectBinary(path) !== null) await this.fileSystem.remove(path);
      }
      if (current && fileSelected(this.selectiveSync, current)) {
        if (!this.blobStore) throw new SyncError("file_storage_unavailable", "File conflict resolution requires a blob store.");
        await ensureFileBlob(this.transport, this.blobStore, current);
        await this.materializer.putFile(state, current);
      } else if (prior) {
        delete state.files![prior.file_id];
      }
    } else {
      this.queueLocalFileResolution(state, source, currentById, currentAtPath);
    }
    delete state.file_conflicts![fileId];
    await this.writeState(state);
  }

  private queueLocalFileResolution(
    state: MirrorState,
    source: PendingMirrorFileMutation,
    currentById: CollectionFileDescriptor | undefined,
    currentAtPath: CollectionFileDescriptor | undefined
  ): void {
    if (currentById && currentAtPath && currentById.file_id !== currentAtPath.file_id) {
      throw new SyncError(
        "file_resolution_ambiguous",
        "The authority changed this file and another file now occupies the local destination."
      );
    }
    const current = currentById ?? currentAtPath;
    if (current) state.files![current.file_id] = { file: current };
    else if (source.operation !== "upload" || source.file_id) delete state.files![source.file_id!];
    if (source.operation === "delete") {
      if (!current) return;
      state.pending_files!.push({
        operation: "delete",
        mutation_id: this.runtime.randomId(),
        file_id: current.file_id,
        path: current.path,
        base_revision: current.revision
      });
      return;
    }
    if (source.operation === "move") {
      if (!current) {
        throw new SyncError(
          "file_resolution_source_missing",
          "The authority deleted this file; restore it as a new file to keep the local bytes."
        );
      }
      state.pending_files!.push({
        ...source,
        mutation_id: this.runtime.randomId(),
        file_id: current.file_id,
        from_path: current.path,
        base_revision: current.revision
      });
      return;
    }
    if (!current || current.path === source.path) {
      state.pending_files!.push({
        ...source,
        transfer_id: this.runtime.randomId(),
        ...(current
          ? { file_id: current.file_id, base_revision: current.revision }
          : { file_id: undefined, base_revision: undefined })
      });
      return;
    }
    const mutationId = this.runtime.randomId();
    state.pending_files!.push({
      operation: "move",
      mutation_id: mutationId,
      file_id: current.file_id,
      from_path: current.path,
      path: source.path,
      base_revision: current.revision,
      content_digest: current.content_digest,
      size: current.size
    }, {
      ...source,
      transfer_id: this.runtime.randomId(),
      file_id: current.file_id,
      base_revision: current.revision,
      after_mutation_id: mutationId
    });
  }

  private async currentAuthorityFiles(): Promise<CollectionFileDescriptor[]> {
    const session = await openMirrorSnapshot(this.replicaId, this.transport, this.mode);
    const files: CollectionFileDescriptor[] = [];
    await visitFileSnapshotPages(this.transport, session, async (page) => {
      files.push(...page);
    });
    return files;
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
    const pathPolicy = await this.currentRecordPathPolicy(state);
    const localPaths = new Set(pending.map((item) => item.local_path));
    if (current) {
      validateRecordPath(current.path, pathPolicy);
      for (const path of localPaths) {
        validateRecordPath(path, pathPolicy);
        if (path !== current.path && await this.fileSystem.read(path) !== null) {
          await this.fileSystem.remove(path);
        }
      }
      const existing = await this.fileSystem.read(current.path);
      await this.materializer.put(state, current, {
        managedState: state,
        acceptedHash: existing === null ? null : this.runtime.digest(existing)
      });
      return;
    }
    const entry = state.records[recordId];
    if (entry) localPaths.add(entry.path);
    for (const path of localPaths) {
      validateRecordPath(path, pathPolicy);
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
    const queue = (mutation: UnidentifiedSyncMutation, localHash: string | null) => {
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
          base_revision: current.revision
        }, null);
      }
      return queued;
    }
    parseMarkdown(localDocument, localPath);
    const localHash = this.runtime.digest(localDocument);
    if (!current) {
      queue({
        operation: "put",
        record_id: recordId,
        path: localPath,
        document: localDocument
      }, localHash);
      return queued;
    }
    if (localDocument !== current.document) {
      queue({
        operation: "put",
        record_id: recordId,
        base_revision: current.revision,
        path: current.path,
        document: localDocument
      }, localHash);
    }
    if (localPath !== current.path) {
      queue({
        operation: "move",
        record_id: recordId,
        base_revision: current.revision,
        path: localPath
      }, localHash);
    }
    return queued;
  }

  private async captureLocalChanges(state: MirrorState): Promise<void> {
    const pendingBefore = state.pending!.length;
    const pendingFilesBefore = state.pending_files!.length;
    const localIssuesBefore = JSON.stringify(state.local_issues ?? {});
    const { pending, localIssues } = await captureMirrorLocalChanges({
      replicaId: this.replicaId,
      state,
      pathPolicy: await this.currentRecordPathPolicy(state),
      fileSystem: this.fileSystem,
      runtime: this.runtime,
      pathSelected: (path) => pathSelected(this.selectiveSync, path)
    });
    state.local_issues = localIssues;
    state.pending!.push(...pending);
    await captureMirrorLocalFiles({
      state,
      fileSystem: this.fileSystem,
      blobStore: this.blobStore,
      selectiveSync: this.selectiveSync,
      runtime: this.runtime
    });
    if (
      state.pending!.length !== pendingBefore
      || state.pending_files!.length !== pendingFilesBefore
      || JSON.stringify(state.local_issues ?? {}) !== localIssuesBefore
    ) {
      await this.writeState(state);
    }
  }

  private async flushPendingFiles(state: MirrorState): Promise<void> {
    await flushPendingMirrorFiles(
      state,
      this.transport,
      this.blobStore,
      () => this.writeState(state)
    );
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
          await this.materializer.put(state, receipt.record, {
            managedState: state,
            acceptedHash: pending.local_hash
          });
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

  private async readState(): Promise<MirrorState | null> {
    const state = await this.stateStore.read();
    if (state === null) return null;
    try {
      return normalizeMirrorState(state, this.replicaId, this.mode);
    } catch (error) {
      if (error instanceof SyncError) throw error;
      throw new SyncError("invalid_mirror_state", "Mirror metadata is corrupt or belongs to another replica.");
    }
  }

  private async writeState(state: MirrorState): Promise<void> {
    await this.stateStore.write(state);
  }

  private async pruneFileBlobs(): Promise<void> {
    if (!this.blobStore) return;
    const state = await this.readState();
    if (!state) return;
    const retained = new Set<`sha256:${string}`>();
    for (const entry of Object.values(state.files ?? {})) {
      retained.add(entry.file.content_digest);
    }
    for (const pending of state.pending_files ?? []) {
      if ("content_digest" in pending) retained.add(pending.content_digest);
    }
    await this.blobStore.prune(retained);
  }

  private reportProgress(progress: MirrorProgress): void {
    this.onProgress?.(progress);
  }

  private async currentRecordPathPolicy(state: MirrorState): Promise<MirrorRecordPathPolicy> {
    return this.materializer.recordPathPolicy(state);
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.message === "AbortError");
}
