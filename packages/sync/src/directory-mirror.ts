import type { JsonObject, SyncRecord } from "@mdbase-dev/connect-protocol";
import type { SyncTransport } from "./sync-types.js";
import { SyncError } from "./sync-error.js";
import {
  MemoryMirrorLease,
  normalizeMirrorState,
  portableMirrorRuntime,
  type AuthorityPromotionManifest,
  type DirectoryMirrorOptions,
  type MirrorBlobStore,
  type MirrorFileSystem,
  type MirrorInitializationPreview,
  type MirrorLease,
  type MirrorRuntime,
  type MirrorState,
  type MirrorStateStore,
  type MirrorStatus
} from "./mirror-state.js";
import { MirrorMaterializer } from "./mirror-materializer.js";
import { normalizeSelectiveSyncPolicy, ensureFileBlob } from "./mirror-files.js";
import { buildAuthorityPromotionManifest } from "./mirror-promotion.js";
import type { MirrorRecordPathPolicy } from "./mirror-path-policy.js";
import {
  mirrorApplyResult,
  type MirrorApplyResult,
  type MirrorPlanIssue,
  type MirrorSyncPlan
} from "./mirror-plan.js";
import { checkpointMirrorStatus, mirrorStatusFromPlan } from "./mirror-status.js";
import {
  PlanOnlyMirrorInspector,
  type PlanOnlyInspection
} from "./sync-inspector.js";
import { PlanOnlySyncExecutor } from "./sync-executor.js";
import { PlanRevalidator } from "./sync-revalidator.js";
import {
  abandonStaleBatch,
  prepareSyncBatch,
  type SyncJournalStore
} from "./sync-journal.js";
import { advanceEmptySyncCheckpoint, advanceSyncCheckpoint } from "./sync-checkpoint.js";
import { loadMirrorSnapshot } from "./sync-snapshot-loader.js";

export class DirectoryMirror<Frontmatter extends JsonObject = JsonObject> {
  private readonly stateStore: MirrorStateStore;
  private readonly fileSystem: MirrorFileSystem;
  private readonly blobStore?: MirrorBlobStore;
  private readonly selectiveSync;
  private readonly lease: MirrorLease;
  private readonly runtime: MirrorRuntime;
  private readonly materializer: MirrorMaterializer;
  private readonly onProgress?: DirectoryMirrorOptions["onProgress"];

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
      let state = await this.readState();
      if (state?.batch?.phase === "blocked" && state.batch.failure?.code === "sync_plan_stale") {
        await abandonStaleBatch(state, this.journalStore());
        state = await this.readState();
      }
      if (state?.batch) return this.executePrepared(state, options.signal);
      const inspection = await this.inspectDetailed(state);
      return this.applyInspection(inspection, options.signal);
    });
  }

  /** Inspect exact state without persisting payloads, effects, or checkpoints. */
  async inspect(): Promise<MirrorSyncPlan> {
    return this.lease.runExclusive(async () => {
      const state = await this.readState();
      return state?.batch?.plan ?? (await this.inspectDetailed(state)).plan;
    });
  }

  /** Apply this exact decision or reject it stale; never substitute a new plan. */
  async apply(
    plan: MirrorSyncPlan,
    options: { signal?: AbortSignal } = {}
  ): Promise<MirrorApplyResult> {
    return this.lease.runExclusive(async () => {
      const state = await this.readState();
      if (state?.batch) {
        if (state.batch.plan.fingerprint !== plan.fingerprint) {
          throw new SyncError(
            "mirror_recovery_required",
            "A different prepared plan must recover before this plan can apply."
          );
        }
        return this.executePrepared(state, options.signal);
      }
      const inspection = await this.inspectDetailed(state);
      if (inspection.plan.fingerprint !== plan.fingerprint) {
        return mirrorApplyResult(
          "stale",
          plan,
          checkpointMirrorStatus(inspection.prior, this.mode),
          0,
          {
            code: "sync_plan_stale",
            message: "The local folder or authority changed. Inspect the sync plan again."
          }
        );
      }
      return this.applyInspection(inspection, options.signal);
    });
  }

  private async applyInspection(
    inspection: PlanOnlyInspection<Frontmatter>,
    signal?: AbortSignal
  ): Promise<MirrorApplyResult> {
    const plan = inspection.plan;
    if (plan.issues.some((issue) => issue.blocking)) {
      return mirrorApplyResult(
        "attention",
        plan,
        checkpointMirrorStatus(inspection.prior, this.mode),
        0
      );
    }
    if (signal?.aborted) {
      return mirrorApplyResult(
        "cancelled",
        plan,
        checkpointMirrorStatus(inspection.prior, this.mode),
        0,
        { code: "sync_cancelled", message: "Sync cancelled before preparation." }
      );
    }
    try {
      await new PlanRevalidator(this.fileSystem, this.runtime)
        .validate(plan, inspection.prior);
    } catch (error) {
      const value = error instanceof Error ? error : new Error(String(error));
      const code = error && typeof error === "object" && "code" in error
        && typeof error.code === "string" ? error.code : "sync_revalidation_failed";
      return mirrorApplyResult(
        code === "sync_plan_stale" ? "stale" : "failed",
        plan,
        checkpointMirrorStatus(inspection.prior, this.mode),
        0,
        { code, message: value.message }
      );
    }
    if (
      inspection.prior
      && plan.actions.length === 1
      && plan.actions[0]?.command === "advance_checkpoint"
    ) {
      await advanceEmptySyncCheckpoint(
        inspection.prior,
        plan,
        this.runtime,
        this.journalStore()
      );
      return mirrorApplyResult(
        "applied",
        plan,
        checkpointMirrorStatus(inspection.prior, this.mode),
        0
      );
    }
    const state = await prepareSyncBatch(
      inspection.prior,
      plan,
      inspection.durable_payloads,
      this.journalStore()
    );
    return this.executePrepared(state, signal);
  }

  private async executePrepared(
    state: MirrorState,
    signal?: AbortSignal
  ): Promise<MirrorApplyResult> {
    const batch = state.batch!;
    const result = await new PlanOnlySyncExecutor({
      transport: this.transport,
      fileSystem: this.fileSystem,
      blobStore: this.blobStore,
      runtime: this.runtime,
      mode: this.mode,
      store: this.journalStore(),
      onProgress: (completed, total) => this.onProgress?.({
        phase: "applying",
        completed,
        total,
        done: completed === total
      })
    }).execute(state, signal);
    if (result.status !== "effects_complete") {
      const checkpoint = checkpointMirrorStatus(state, this.mode);
      return mirrorApplyResult(
        result.status === "blocked" ? "failed" : result.status,
        batch.plan,
        checkpoint,
        result.completed,
        result.failure
      );
    }
    const plan = batch.plan;
    await advanceSyncCheckpoint(state, this.runtime, this.journalStore());
    await this.pruneFileBlobs();
    const checkpoint = checkpointMirrorStatus(state, this.mode);
    const attention = checkpoint.conflicts.length > 0
      || checkpoint.file_conflicts.length > 0
      || checkpoint.local_issues.length > 0
      || plan.summary.conflicts > 0;
    return mirrorApplyResult(
      attention ? "attention" : "applied",
      plan,
      checkpoint,
      result.completed
    );
  }

  private inspectDetailed(state?: MirrorState | null): Promise<PlanOnlyInspection<Frontmatter>> {
    return new PlanOnlyMirrorInspector(
      this.replicaId,
      this.transport,
      this.mode,
      this.fileSystem,
      this.blobStore,
      this.selectiveSync,
      this.runtime,
      () => this.readState(),
      (state) => this.currentRecordPathPolicy(state)
    ).inspect(state);
  }

  async status(): Promise<MirrorStatus> {
    const checkpoint = await this.checkpointStatus();
    if (checkpoint.state === "not_initialized") return checkpoint;
    return mirrorStatusFromPlan(checkpoint, await this.inspect());
  }

  async checkpointStatus(): Promise<MirrorStatus> {
    return this.lease.runExclusive(() => this.checkpointStatusUnlocked());
  }

  private async checkpointStatusUnlocked(): Promise<MirrorStatus> {
    return checkpointMirrorStatus(await this.readState(), this.mode);
  }

  async authorityPromotionManifest(): Promise<AuthorityPromotionManifest> {
    return this.lease.runExclusive(async () => {
      if (this.mode !== "read_write") {
        throw new SyncError(
          "promotion_requires_writable_mirror",
          "Only a read-write mirror can prove an authority promotion source."
        );
      }
      const state = await this.readState();
      if (!state) throw new SyncError("mirror_not_initialized", "Synchronize this mirror first.");
      if (state.batch || Object.keys(state.planned_conflicts ?? {}).length > 0) {
        throw new SyncError(
          "promotion_mirror_not_clean",
          "Finish the prepared batch and resolve conflicts before promotion."
        );
      }
      const manifest = await buildAuthorityPromotionManifest({
        state,
        selectiveSync: this.selectiveSync,
        fileSystem: this.fileSystem,
        pathPolicy: await this.currentRecordPathPolicy(state),
        digest: this.runtime.digest
      });
      const plan = (await this.inspectDetailed(state)).plan;
      if (plan.actions.some((action) => action.command !== "advance_checkpoint")) {
        throw new SyncError(
          "promotion_mirror_not_clean",
          "Synchronize this mirror immediately before promotion."
        );
      }
      return manifest;
    });
  }

  async previewInitialization(): Promise<MirrorInitializationPreview> {
    const plan = await this.inspect();
    const uploads = plan.actions.filter((action) =>
      action.command === "put_remote"
      || action.command === "move_remote"
      || action.command === "delete_remote"
    );
    const downloads = plan.actions.filter((action) =>
      action.command === "write_local"
      || action.command === "move_local"
      || action.command === "delete_local"
    );
    return {
      already_initialized: plan.kind === "incremental",
      download_documents: downloads.filter((action) =>
        "target" in action && action.target.entity !== "file"
        || "source" in action && action.source.entity !== "file"
      ).length,
      upload_documents: uploads.filter((action) =>
        "target" in action && action.target.entity === "record"
        || "source" in action && action.source.entity === "record"
      ).length,
      unchanged_documents: 0,
      download_files: downloads.filter((action) =>
        "target" in action && action.target.entity === "file"
        || "source" in action && action.source.entity === "file"
      ).length,
      upload_files: uploads.filter((action) =>
        "target" in action && action.target.entity === "file"
        || "source" in action && action.source.entity === "file"
      ).length,
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

  async resolveConflict(identity: string, resolution: "local" | "remote"): Promise<void> {
    await this.lease.runExclusive(() => this.resolveConflictUnlocked(identity, "record", resolution));
  }

  async resolveFileConflict(identity: string, resolution: "local" | "remote"): Promise<void> {
    await this.lease.runExclusive(() => this.resolveConflictUnlocked(identity, "file", resolution));
  }

  private async resolveConflictUnlocked(
    identity: string,
    entity: "record" | "file",
    resolution: "local" | "remote"
  ): Promise<void> {
    if (this.mode !== "read_write") {
      throw new SyncError("mirror_read_only", "Receive-only mirrors have no writable conflicts.");
    }
    const state = await this.readState();
    if (!state || state.batch) {
      throw new SyncError("mirror_recovery_required", "Finish sync recovery before resolving conflicts.");
    }
    const planned = state.planned_conflicts?.[identity];
    if (!planned) {
      throw new SyncError("mirror_conflict_not_found", "Writable mirror conflict was not found.");
    }
    if (resolution === "remote") {
      const snapshot = await loadMirrorSnapshot(
        this.replicaId,
        this.transport,
        this.mode,
        this.selectiveSync,
        this.runtime
      );
      if (entity === "record") {
        const current = snapshot.records.find(({ record }) => record.record_id === identity)?.record;
        await this.installRemoteRecord(state, identity, current);
      } else {
        const current = snapshot.files.find((file) => file.file_id === identity);
        await this.installRemoteFile(state, identity, current);
      }
    }
    delete state.planned_conflicts?.[identity];
    if (resolution === "remote") delete state.local_bindings?.[identity];
    await this.writeState(state);
  }

  private async installRemoteRecord(
    state: MirrorState,
    identity: string,
    current: SyncRecord<Frontmatter> | undefined
  ): Promise<void> {
    if (current) {
      const conflict = state.planned_conflicts?.[identity];
      const acceptedDocument = await this.fileSystem.read(current.path);
      const pathBelongsToIdentity = state.records[identity]?.path === current.path
        || (conflict?.local.state === "exact" && conflict.local.object.path === current.path);
      await this.materializer.put(state, current, {
        inspectionPreflighted: false,
        ...(pathBelongsToIdentity && acceptedDocument !== null
          ? { acceptedHash: this.runtime.digest(acceptedDocument) }
          : {})
      });
      return;
    }
    const conflict = state.planned_conflicts?.[identity];
    const path = conflict?.local.state === "exact"
      ? conflict.local.object.path
      : state.records[identity]?.path;
    if (path && await this.fileSystem.read(path) !== null) await this.fileSystem.remove(path);
    delete state.records[identity];
  }

  private async installRemoteFile(
    state: MirrorState,
    identity: string,
    current: import("@mdbase-dev/connect-protocol").CollectionFileDescriptor | undefined
  ): Promise<void> {
    if (current) {
      if (!this.blobStore) throw new SyncError("file_storage_unavailable", "File resolution needs a blob store.");
      await ensureFileBlob(this.transport, this.blobStore, current);
      const conflict = state.planned_conflicts?.[identity];
      const acceptedLocal = conflict?.local.state === "exact"
        ? {
            content_digest: conflict.local.object.payload_revision as `sha256:${string}`,
            size: conflict.local.object.size ?? 0
          }
        : undefined;
      const localPath = state.local_bindings?.[identity]?.path;
      await this.materializer.putFile(state, current, state, acceptedLocal);
      if (localPath && localPath !== current.path) await this.fileSystem.remove(localPath);
      return;
    }
    const conflict = state.planned_conflicts?.[identity];
    const path = conflict?.local.state === "exact"
      ? conflict.local.object.path
      : state.files?.[identity]?.file.path;
    if (path && await this.fileSystem.inspectBinary(path) !== null) await this.fileSystem.remove(path);
    delete state.files?.[identity];
  }

  private async readState(): Promise<MirrorState | null> {
    const state = await this.stateStore.read();
    if (state === null) return null;
    try {
      return normalizeMirrorState(state, this.replicaId, this.mode);
    } catch (error) {
      if (error instanceof SyncError) throw error;
      throw new SyncError(
        "invalid_mirror_state",
        "Mirror metadata is corrupt or belongs to another replica."
      );
    }
  }

  private writeState(state: MirrorState): Promise<void> {
    return this.stateStore.write(state);
  }

  private journalStore(): SyncJournalStore {
    const journaled = this.stateStore as MirrorStateStore & {
      appendJournal?: SyncJournalStore["appendJournal"];
    };
    return {
      write: (state) => this.writeState(state),
      ...(journaled.appendJournal
        ? { appendJournal: (event) => journaled.appendJournal!(event) }
        : {})
    };
  }

  private async pruneFileBlobs(): Promise<void> {
    if (!this.blobStore) return;
    const state = await this.readState();
    if (!state) return;
    const retained = new Set<`sha256:${string}`>();
    for (const entry of Object.values(state.files ?? {})) retained.add(entry.file.content_digest);
    for (const file of Object.values(state.batch?.payloads.files ?? {})) {
      retained.add(file.content_digest);
    }
    for (const file of Object.values(state.batch?.payloads.local_files ?? {})) {
      retained.add(file.content_digest);
    }
    await this.blobStore.prune(retained);
  }

  private currentRecordPathPolicy(state: MirrorState): Promise<MirrorRecordPathPolicy> {
    return this.materializer.recordPathPolicy(state);
  }

}
