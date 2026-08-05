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
import {
  WritableMirrorConflictError,
  WritableMirrorRejectedError
} from "./mirror-errors.js";
import {
  frontmatterPatch,
  mirrorLocalIssue,
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
  type MirrorLocalIssue,
  type MirrorProgress,
  type MirrorRuntime,
  type MirrorState,
  type MirrorStateStore,
  type MirrorStatus,
  type PendingMirrorFileMutation,
  type PendingMirrorMutation
} from "./mirror-state.js";
import {
  filterRecordPaths,
  validateRecordPath,
  validateSnapshotResources,
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
  assertNoPhysicalPathAliases,
  physicalMirrorPathKey,
  preflightChangePhysicalPaths,
  projectedPhysicalPaths
} from "./mirror-physical-path.js";
import { openMirrorSnapshot, rebuildMirror } from "./mirror-rebuild.js";
import {
  ensureFileBlob,
  fileSelected,
  normalizeSelectiveSyncPolicy,
  pathFileSelected,
  pathSelected,
  sameBinaryInfo,
  validateCollectionFileDescriptor,
  validateVisibleCollectionPath,
  visitFileSnapshotPages
} from "./mirror-files.js";
import {
  MirrorSnapshotValidator,
  visitSnapshotPages
} from "./mirror-snapshot-validator.js";

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

  async sync(): Promise<void> {
    await this.lease.runExclusive(async () => {
      await this.syncUnlocked();
      await this.pruneFileBlobs();
    });
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
      await this.rebuild(state);
      return;
    }
    if (this.mode === "read_write") {
      await this.flushPending(state);
      await this.flushPendingFiles(state);
      await this.captureLocalChanges(state);
      await this.flushPending(state);
      await this.flushPendingFiles(state);
    } else {
      await assertMirrorUndiverged(
        state,
        await this.currentRecordPathPolicy(state),
        this.fileSystem,
        this.runtime.digest
      );
    }
    let appliedDocuments = 0;
    while (true) {
      const page = await this.transport.changes(state.cursor, 200);
      if (page.scope_epoch !== state.scope_epoch || page.reset_required) {
        await this.rebuild(state);
        return;
      }
      for (const event of page.events) {
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
      if (page.events.length > 0) this.preflightProjectedPaths(state, page.events);
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
        if (event.type === "file_put") {
          if (fileSelected(this.selectiveSync, event.file)) {
            await this.materializer.putFile(state, event.file);
          } else {
            await this.materializer.removeFile(state, event.file.file_id);
          }
          appliedDocuments += 1;
          this.reportProgress({ phase: "applying", completed: appliedDocuments, total: null, done: false });
          continue;
        }
        if (event.type === "file_remove") {
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
        if (alreadyApplied) {
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
        pending_files: 0,
        conflicts: [],
        file_conflicts: [],
        local_issues: [],
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
          message: "Local and remote changes need a decision."
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
    const localIssues = Object.values(state.local_issues ?? {})
      .map(({ path, code, message }) => ({ path, code, message }))
      .sort((left, right) => left.path.localeCompare(right.path));
    const pending = state.pending?.length ?? 0;
    const pendingFiles = state.pending_files?.length ?? 0;
    const fileConflicts = Object.values(state.file_conflicts ?? {})
      .sort((left, right) => left.path.localeCompare(right.path));
    return {
      state: conflicts.length || fileConflicts.length || localIssues.length
        ? "attention"
        : pending || pendingFiles
          ? "changes_waiting"
          : "up_to_date",
      mode: this.mode,
      pending: pending + pendingFiles,
      pending_files: pendingFiles,
      conflicts,
      file_conflicts: fileConflicts,
      local_issues: localIssues,
      cursor: state.cursor,
      last_synced_at: state.last_synced_at ?? null
    };
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
    if (await this.readState()) {
      return {
        already_initialized: true,
        download_documents: 0,
        upload_documents: 0,
        unchanged_documents: 0,
        download_files: 0,
        upload_files: 0,
        unchanged_files: 0,
        collisions: [],
        local_issues: []
      };
    }
    const session = await openMirrorSnapshot(
      this.replicaId,
      this.transport,
      this.mode
    );
    const resources = session.resources.documents ?? [];
    const pathPolicy = validateSnapshotResources(resources);
    const snapshotValidator = new MirrorSnapshotValidator<Frontmatter>(
      pathPolicy,
      resources,
      this.runtime.digest
    );
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
    await visitSnapshotPages(this.transport, session, async (pageRecords) => {
      for (const snapshotRecord of pageRecords) {
        const record = snapshotValidator.validate(snapshotRecord);
        if (!pathSelected(this.selectiveSync, record.record.path)) continue;
        await compareDocument(record.record.path, record.document);
      }
    });
    let downloadFiles = 0;
    let uploadFiles = 0;
    let unchangedFiles = 0;
    await visitFileSnapshotPages(this.transport, session, async (files) => {
      for (const file of files) {
        if (!fileSelected(this.selectiveSync, file)) continue;
        remotePaths.add(file.path);
        const local = await this.fileSystem.inspectBinary(file.path);
        if (local === null) downloadFiles += 1;
        else if (sameBinaryInfo(local, file)) unchangedFiles += 1;
        else collisions.push(file.path);
      }
    });
    assertNoPhysicalPathAliases(remotePaths);
    const localMarkdown = (await this.fileSystem.listMarkdown(
      new Set(resources.map((resource) => resource.path))
    )).filter((path) => pathSelected(this.selectiveSync, path));
    const localIssues: MirrorLocalIssue[] = [];
    let uploadDocuments = 0;
    if (this.mode === "read_write") {
      const localRecords = filterRecordPaths(localMarkdown, pathPolicy);
      assertNoPhysicalPathAliases([...remotePaths, ...localRecords]);
      for (const path of localRecords.filter((candidate) => !remotePaths.has(candidate))) {
        const document = await this.fileSystem.read(path);
        if (document === null) continue;
        try {
          parseMarkdown(document, path);
          uploadDocuments += 1;
        } catch (error) {
          const issue = mirrorLocalIssue(error, path);
          if (!issue) throw error;
          localIssues.push(issue);
        }
      }
      if (this.fileSystem.listBinary) {
        const excluded = new Set([
          ...resources.map((resource) => resource.path),
          ...remotePaths
        ]);
        const localFiles = (await this.fileSystem.listBinary(excluded))
          .filter((path) => pathFileSelected(this.selectiveSync, path));
        for (const path of localFiles) {
          validateVisibleCollectionPath(path, false);
          if (!remotePaths.has(path)) uploadFiles += 1;
        }
        assertNoPhysicalPathAliases([...remotePaths, ...localRecords, ...localFiles]);
      }
    }
    return {
      already_initialized: false,
      download_documents: downloadDocuments,
      upload_documents: uploadDocuments,
      unchanged_documents: unchangedDocuments,
      download_files: downloadFiles,
      upload_files: uploadFiles,
      unchanged_files: unchangedFiles,
      collisions,
      local_issues: localIssues.sort((left, right) => left.path.localeCompare(right.path))
    };
  }

  private async rebuild(prior?: MirrorState): Promise<void> {
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
      prior
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
            acceptedHash: pending.local_hash,
            preserveAcceptedDocument: true
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

  private preflightProjectedPaths(
    state: MirrorState,
    events: Array<SyncChange<Frontmatter>>
  ): void {
    const records = new Map<string, string | null>();
    const files = new Map<string, string | null>();
    for (const event of events) {
      if (event.type === "put") {
        if (pathSelected(this.selectiveSync, event.record.path)) {
          records.set(event.record.record_id, event.record.path);
        } else records.set(event.record.record_id, null);
      } else if (event.type === "remove") records.set(event.record_id, null);
      else if (event.type === "file_put") {
        if (fileSelected(this.selectiveSync, event.file)) files.set(event.file.file_id, event.file.path);
        else files.set(event.file.file_id, null);
      } else files.set(event.file_id, null);
    }
    assertNoPhysicalPathAliases(projectedPhysicalPaths(state, records, files));
  }
}
