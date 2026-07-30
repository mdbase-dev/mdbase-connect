import type {
  JsonObject,
  SyncMutation,
  SyncRecord
} from "@mdbase/connect-protocol";
import type { SyncTransport } from "./sync-types.js";
import { SyncError } from "./sync-error.js";
import {
  MirrorDivergenceError,
  MirrorInitializationConflictError,
  WritableMirrorConflictError,
  WritableMirrorRejectedError
} from "./mirror-errors.js";
import {
  authorityDocumentHash,
  authorityManifestDigest,
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
  type MirrorEntry,
  type MirrorFileSystem,
  type MirrorInitializationPreview,
  type MirrorLease,
  type MirrorLocalIssue,
  type MirrorProgress,
  type MirrorRuntime,
  type MirrorState,
  type MirrorStateStore,
  type MirrorStatus,
  type PendingMirrorMutation,
  type StoredMirrorLocalIssue
} from "./mirror-state.js";
import {
  defaultRecordPathPolicy,
  filterRecordPaths,
  recordPathPolicy,
  validateRecordPath,
  validateSnapshotResources,
  type MirrorRecordPathPolicy
} from "./mirror-path-policy.js";
import {
  MirrorSnapshotValidator,
  withoutSnapshotDocument,
  visitSnapshotPages,
  type ValidatedSnapshotRecord
} from "./mirror-snapshot-validator.js";

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
    return {
      state: conflicts.length || localIssues.length
        ? "attention"
        : pending
          ? "changes_waiting"
          : "up_to_date",
      mode: this.mode,
      pending,
      conflicts,
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
    if (
      (state.pending?.length ?? 0) > 0
      || Object.keys(state.conflicts ?? {}).length > 0
      || Object.keys(state.local_issues ?? {}).length > 0
    ) {
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
          identity: "",
          document_hash: authorityDocumentHash(entry.hash)
        })),
        ...Object.entries(state.records).map(([recordId, entry]) => ({
          kind: "record" as const,
          path: entry.path,
          identity: recordId,
          document_hash: authorityDocumentHash(entry.hash)
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
        collisions: [],
        local_issues: []
      };
    }
    const session = await this.openSnapshot();
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
        await compareDocument(record.record.path, record.document);
      }
    });
    const localMarkdown = await this.fileSystem.listMarkdown(new Set(resources.map((resource) => resource.path)));
    const localIssues: MirrorLocalIssue[] = [];
    let uploadDocuments = 0;
    if (this.mode === "read_write") {
      const localRecords = filterRecordPaths(localMarkdown, pathPolicy);
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
    }
    return {
      already_initialized: false,
      download_documents: downloadDocuments,
      upload_documents: uploadDocuments,
      unchanged_documents: unchangedDocuments,
      collisions,
      local_issues: localIssues.sort((left, right) => left.path.localeCompare(right.path))
    };
  }

  private async rebuild(prior?: MirrorState): Promise<void> {
    const session = await this.openSnapshot();
    const resources = session.resources.documents ?? [];
    const pathPolicy = validateSnapshotResources(resources);
    const snapshotValidator = new MirrorSnapshotValidator<Frontmatter>(
      pathPolicy,
      resources,
      this.runtime.digest
    );
    const state: MirrorState = {
      protocol_version: 1,
      replica_id: this.replicaId,
      scope_epoch: session.scope_epoch,
      cursor: session.head,
      records: {},
      resources: {},
      mode: this.mode,
      pending: [],
      conflicts: {},
      local_issues: {}
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
    const records: Array<ValidatedSnapshotRecord<Frontmatter>> = [];
    const remoteRecordIds = prior ? new Set<string>() : null;
    await visitSnapshotPages(this.transport, session, async (pageRecords) => {
      for (const snapshotRecord of pageRecords) {
        const prepared = snapshotValidator.validate(snapshotRecord);
        const { document, record } = prepared;
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
        records.push(prepared);
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

  private async put(
    state: MirrorState,
    record: SyncRecord<Frontmatter>,
    managedState: MirrorState | undefined = state,
    acceptedHash?: string | null,
    preserveAcceptedDocument = false,
    materialized?: { document: string; hash: string }
  ): Promise<void> {
    validateRecordPath(record.path, await this.currentRecordPathPolicy(state));
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
      ...(this.mode === "read_write"
        ? { record: withoutSnapshotDocument(record) }
        : {})
    };
  }

  private async remove(state: MirrorState, recordId: string, pathValue: string): Promise<void> {
    const entry = state.records[recordId];
    const path = entry?.path ?? pathValue;
    validateRecordPath(path, await this.currentRecordPathPolicy(state));
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
    const pathPolicy = await this.currentRecordPathPolicy(state);
    const resourcePaths = new Set(Object.keys(state.resources ?? {}));
    for (const [path, entry] of Object.entries(state.resources ?? {})) {
      const value = await this.fileSystem.read(path);
      if (value === null || this.runtime.digest(value) !== entry.hash) {
        throw new MirrorDivergenceError(`resource:${path}`, path);
      }
    }
    const files = filterRecordPaths(
      await this.fileSystem.listMarkdown(resourcePaths),
      pathPolicy
    );
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
    const localIssues: Record<string, StoredMirrorLocalIssue> = {};
    const parseLocal = (
      document: string,
      path: string,
      hash: string
    ): { frontmatter: JsonObject; body: string } | null => {
      try {
        return parseMarkdown(document, path);
      } catch (error) {
        const issue = mirrorLocalIssue(error, path);
        if (!issue) throw error;
        localIssues[path] = { ...issue, hash };
        return null;
      }
    };
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
      const parsed = parseLocal(value.document!, entry.path, value.hash);
      if (!parsed) continue;
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
      const parsed = parseLocal(value.document!, path, value.hash);
      if (!parsed) continue;
      queue({
        operation: "create",
        record_id: this.runtime.randomId(),
        input: { path, frontmatter: parsed.frontmatter, body: parsed.body }
      }, path, value.hash);
    }
    state.local_issues = localIssues;
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

  private reportProgress(progress: MirrorProgress): void {
    this.onProgress?.(progress);
  }

  private async assertUndiverged(state: MirrorState): Promise<void> {
    const pathPolicy = await this.currentRecordPathPolicy(state);
    for (const [recordId, entry] of Object.entries(state.records)) {
      validateRecordPath(entry.path, pathPolicy);
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
  private async currentRecordPathPolicy(state: MirrorState): Promise<MirrorRecordPathPolicy> {
    if (Object.keys(state.resources ?? {}).length === 0) {
      return defaultRecordPathPolicy(new Set());
    }
    const configuration = await this.fileSystem.read("mdbase.yaml");
    if (configuration === null) throw new SyncError(
      "invalid_mirror_state", "Mirror collection configuration is missing."
    );
    return recordPathPolicy(configuration, new Set(Object.keys(state.resources ?? {})));
  }
}
