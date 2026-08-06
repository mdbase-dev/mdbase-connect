import type {
  CollectionFileDescriptor,
  JsonObject,
  SelectiveSyncPolicy,
  SyncChange,
  SyncChangesPage
} from "@mdbase-dev/connect-protocol";
import type { SyncTransport } from "./sync-types.js";
import { MirrorDivergenceError } from "./mirror-errors.js";
import { parseMarkdown } from "./mirror-format.js";
import type {
  MirrorBlobStore,
  MirrorFileSystem,
  MirrorRuntime,
  MirrorState,
  PendingMirrorFileMutation,
  PendingMirrorMutation
} from "./mirror-state.js";
import {
  filterRecordPaths,
  validateSnapshotResources,
  type MirrorRecordPathPolicy
} from "./mirror-path-policy.js";
import { assertMirrorUndiverged } from "./mirror-integrity.js";
import { captureMirrorLocalChanges } from "./mirror-local-changes.js";
import { captureMirrorLocalFiles } from "./mirror-local-files.js";
import {
  assertNoPhysicalPathAliases,
  preflightChangePhysicalPaths,
  projectedPhysicalPaths
} from "./mirror-physical-path.js";
import {
  loadMirrorSnapshot,
  type LoadedMirrorSnapshot
} from "./mirror-rebuild.js";
import {
  fileSelected,
  pathFileSelected,
  pathSelected,
  sameBinaryInfo,
  validateVisibleCollectionPath,
  visitFileSnapshotPages
} from "./mirror-files.js";
import {
  finalizeMirrorPlan,
  type MirrorPlanAction,
  type MirrorPlanIssue,
  type MirrorSyncPlan
} from "./mirror-plan.js";

export interface MirrorInspection<Frontmatter extends JsonObject> {
  plan: MirrorSyncPlan;
  snapshot?: LoadedMirrorSnapshot<Frontmatter>;
  incremental?: {
    state: MirrorState;
    pages: Array<SyncChangesPage<Frontmatter>>;
    stageFiles: boolean;
    localRecordIds: Set<string>;
    localFileIds: Set<string>;
  };
}

export class DirectoryMirrorPlanner<Frontmatter extends JsonObject> {
  constructor(
    private readonly replicaId: string,
    private readonly transport: SyncTransport<Frontmatter>,
    private readonly mode: "read_only" | "read_write",
    private readonly fileSystem: MirrorFileSystem,
    private readonly blobStore: MirrorBlobStore | undefined,
    private readonly selectiveSync: SelectiveSyncPolicy,
    private readonly runtime: MirrorRuntime,
    private readonly readState: () => Promise<MirrorState | null>,
    private readonly currentRecordPathPolicy: (
      state: MirrorState
    ) => Promise<MirrorRecordPathPolicy>
  ) {}

  async inspect(): Promise<MirrorSyncPlan> {
    return (await this.inspectDetailed()).plan;
  }

  async inspectDetailed(): Promise<MirrorInspection<Frontmatter>> {
    const state = await this.readState();
    if (!state) return this.inspectSnapshot("initial");
    if (JSON.stringify(state.selective_sync) !== JSON.stringify(this.selectiveSync)) {
      return this.inspectSnapshot("rebuild", state);
    }
    return this.inspectIncremental(state);
  }

  private async inspectSnapshot(
    kind: "initial" | "rebuild",
    prior?: MirrorState
  ): Promise<MirrorInspection<Frontmatter>> {
    const snapshot = await loadMirrorSnapshot(
      this.replicaId,
      this.transport,
      this.mode,
      this.selectiveSync,
      this.runtime
    );
    const { session, resources, records, files } = snapshot;
    const pathPolicy = validateSnapshotResources(resources);
    const actions: MirrorPlanAction[] = [];
    const issues: MirrorPlanIssue[] = [];
    const remotePaths = new Set<string>();
    const remoteRecordIds = new Set<string>();
    const remoteFileIds = new Set<string>();
    const reason = kind;
    const compareText = async (
      entity: "record" | "resource",
      path: string,
      document: string,
      identity: string,
      revision: string,
      priorEntry?: { path: string; hash: string }
    ): Promise<void> => {
      remotePaths.add(path);
      const local = await this.fileSystem.read(path);
      if (local === document) return;
      if (local !== null && (
        kind === "initial"
        || !priorEntry
        || this.runtime.digest(local) !== priorEntry.hash
      )) {
        issues.push({
          code: "local_collision",
          message: `${path} differs locally from the exact authority document.`,
          path,
          blocking: true
        });
        return;
      }
      if (priorEntry && priorEntry.path !== path) {
        actions.push({
          entity,
          direction: "authority_to_local",
          operation: "move",
          path,
          previous_path: priorEntry.path,
          identity,
          revision,
          reason,
          outcome: "ready"
        });
      }
      actions.push({
        entity,
        direction: "authority_to_local",
        operation: "put",
        path,
        identity,
        revision,
        reason,
        outcome: "ready"
      });
    };
    for (const resource of resources) {
      await compareText(
        "resource",
        resource.path,
        resource.document,
        resource.path,
        resource.revision,
        prior?.resources?.[resource.path]
      );
    }
    for (const { record } of records) {
        remoteRecordIds.add(record.record_id);
        await compareText(
          "record",
          record.path,
          record.document,
          record.record_id,
          record.revision,
          prior?.records[record.record_id]
        );
    }
    for (const file of files) {
        remotePaths.add(file.path);
        remoteFileIds.add(file.file_id);
        const local = await this.fileSystem.inspectBinary(file.path);
        if (local && sameBinaryInfo(local, file)) continue;
        const priorFile = prior?.files?.[file.file_id]?.file;
        if (local && (
          kind === "initial"
          || !priorFile
          || !sameBinaryInfo(local, priorFile)
        )) {
          issues.push({
            code: "local_collision",
            message: `${file.path} differs locally from the exact authority file.`,
            path: file.path,
            blocking: true
          });
          continue;
        }
        if (priorFile && priorFile.path !== file.path) {
          actions.push(filePlanAction("authority_to_local", "move", file.path, reason, file, {
            previous_path: priorFile.path
          }));
        }
        actions.push(filePlanAction("authority_to_local", "put", file.path, reason, file));
    }
    if (prior) {
      for (const [recordId, entry] of Object.entries(prior.records)) {
        if (!remoteRecordIds.has(recordId)) {
          actions.push({
            entity: "record",
            direction: "authority_to_local",
            operation: "delete",
            path: entry.path,
            identity: recordId,
            revision: entry.revision,
            reason,
            outcome: "ready"
          });
        }
      }
      for (const [fileId, entry] of Object.entries(prior.files ?? {})) {
        if (!remoteFileIds.has(fileId)) {
          actions.push(filePlanAction(
            "authority_to_local",
            "delete",
            entry.file.path,
            reason,
            entry.file
          ));
        }
      }
    }
    if (this.mode === "read_write") {
      await this.inspectUntrackedSnapshotFiles(
        remotePaths,
        pathPolicy,
        actions,
        issues,
        reason
      );
    }
    try {
      assertNoPhysicalPathAliases(remotePaths);
    } catch (error) {
      issues.push(planIssue(error, undefined, true));
    }
    const plan = finalizeMirrorPlan({
      plan_version: 1,
      replica_id: this.replicaId,
      mode: this.mode,
      kind,
      base_cursor: prior?.cursor ?? null,
      authority_cursor: session.head,
      scope_epoch: session.scope_epoch,
      actions,
      issues
    }, this.runtime.digest);
    return { plan, snapshot };
  }

  private async inspectUntrackedSnapshotFiles(
    remotePaths: Set<string>,
    pathPolicy: MirrorRecordPathPolicy,
    actions: MirrorPlanAction[],
    issues: MirrorPlanIssue[],
    reason: "initial" | "rebuild"
  ): Promise<void> {
    const resourcePaths = new Set(remotePaths);
    let localRecords: string[] = [];
    try {
      localRecords = filterRecordPaths(
        await this.fileSystem.listMarkdown(resourcePaths),
        pathPolicy
      ).filter((path) => pathSelected(this.selectiveSync, path));
      for (const path of localRecords) {
        if (remotePaths.has(path)) continue;
        const document = await this.fileSystem.read(path);
        if (document === null) continue;
        try {
          parseMarkdown(document, path);
          actions.push({
            entity: "record",
            direction: "local_to_authority",
            operation: "put",
            path,
            revision: `sha256:${this.runtime.digest(document)}`,
            reason,
            outcome: "ready"
          });
        } catch (error) {
          issues.push(planIssue(error, path, false));
        }
      }
      if (this.fileSystem.listBinary) {
        const localFiles = (await this.fileSystem.listBinary(resourcePaths))
          .filter((path) => pathFileSelected(this.selectiveSync, path));
        for (const path of localFiles) {
          if (remotePaths.has(path)) continue;
          validateVisibleCollectionPath(path, false);
          const info = await this.fileSystem.inspectBinary(path);
          if (!info) continue;
          actions.push({
            entity: "file",
            direction: "local_to_authority",
            operation: "put",
            path,
            revision: info.content_digest,
            size: info.size,
            reason,
            outcome: "ready"
          });
        }
        assertNoPhysicalPathAliases([...remotePaths, ...localRecords, ...localFiles]);
      } else {
        assertNoPhysicalPathAliases([...remotePaths, ...localRecords]);
      }
    } catch (error) {
      issues.push(planIssue(error, undefined, true));
    }
  }

  private async inspectIncremental(state: MirrorState): Promise<MirrorInspection<Frontmatter>> {
    const working = cloneMirrorStateForPlan(state);
    const actions: MirrorPlanAction[] = [];
    const issues: MirrorPlanIssue[] = [];
    const localRecordIds = new Set<string>();
    const localFileIds = new Set<string>();
    for (const pending of state.pending ?? []) {
      localRecordIds.add(pending.mutation.record_id);
      actions.push(recordMutationAction(pending, "pending", this.runtime.digest, state));
    }
    for (const pending of state.pending_files ?? []) {
      localFileIds.add(pendingFileIdentity(pending));
      actions.push(fileMutationAction(pending, "pending"));
    }
    let stageFiles = false;
    if (this.mode === "read_write") {
      try {
        const hasPending = (state.pending?.length ?? 0) > 0
          || (state.pending_files?.length ?? 0) > 0;
        // Durable pending work is one reviewable batch. Edits made after that
        // batch was journaled appear in the next plan rather than being
        // performed invisibly by this apply.
        if (!hasPending) {
          stageFiles = true;
          const captured = await captureMirrorLocalChanges({
            replicaId: this.replicaId,
            state: working,
            pathPolicy: await this.currentRecordPathPolicy(working),
            fileSystem: this.fileSystem,
            runtime: this.runtime,
            pathSelected: (path) => pathSelected(this.selectiveSync, path)
          });
          working.pending!.push(...captured.pending);
          working.local_issues = captured.localIssues;
          for (const pending of captured.pending) {
            localRecordIds.add(pending.mutation.record_id);
            actions.push(recordMutationAction(pending, "local_change", this.runtime.digest, state));
          }
          issues.push(...Object.values(captured.localIssues).map((issue) => ({
            code: issue.code,
            message: issue.message,
            path: issue.path,
            blocking: false
          })));
          await captureMirrorLocalFiles({
            state: working,
            fileSystem: this.fileSystem,
            blobStore: this.blobStore,
            selectiveSync: this.selectiveSync,
            runtime: this.runtime,
            stageBlobs: false
          });
          for (const pending of working.pending_files ?? []) {
            localFileIds.add(pendingFileIdentity(pending));
            actions.push(fileMutationAction(pending, "local_change"));
          }
        }
      } catch (error) {
        issues.push(planIssue(
          error,
          error instanceof MirrorDivergenceError ? error.path : undefined,
          true
        ));
      }
    } else {
      try {
        await assertMirrorUndiverged(
          state,
          await this.currentRecordPathPolicy(state),
          this.fileSystem,
          this.runtime.digest
        );
      } catch (error) {
        issues.push(planIssue(
          error,
          error instanceof MirrorDivergenceError ? error.path : undefined,
          true
        ));
      }
    }
    let cursor = state.cursor;
    const remoteEvents: Array<SyncChange<Frontmatter>> = [];
    const pages: Array<SyncChangesPage<Frontmatter>> = [];
    while (true) {
      const page = await this.transport.changes(cursor, 200);
      pages.push(page);
      if (page.scope_epoch !== state.scope_epoch || page.reset_required) {
        return this.inspectSnapshot("rebuild", state);
      }
      for (const event of page.events) {
        remoteEvents.push(event);
        if (event.type === "put") {
          if (!pathSelected(this.selectiveSync, event.record.path)) continue;
          const prior = state.records[event.record.record_id];
          const outcome = localRecordIds.has(event.record.record_id) ? "conflict" : "ready";
          if (prior && prior.path !== event.record.path) {
            actions.push({
              entity: "record",
              direction: "authority_to_local",
              operation: "move",
              path: event.record.path,
              previous_path: prior.path,
              identity: event.record.record_id,
              revision: event.record.revision,
              reason: "remote_change",
              outcome
            });
          }
          if (!prior || prior.revision !== event.record.revision) {
            actions.push({
              entity: "record",
              direction: "authority_to_local",
              operation: "put",
              path: event.record.path,
              identity: event.record.record_id,
              revision: event.record.revision,
              reason: "remote_change",
              outcome
            });
          }
        } else if (event.type === "remove") {
          const prior = state.records[event.record_id];
          if (prior) actions.push({
            entity: "record",
            direction: "authority_to_local",
            operation: "delete",
            path: event.previous_path,
            identity: event.record_id,
            revision: event.revision,
            reason: "remote_change",
            outcome: localRecordIds.has(event.record_id) ? "conflict" : "ready"
          });
        } else if (event.type === "file_put") {
          if (!fileSelected(this.selectiveSync, event.file)) continue;
          const prior = state.files?.[event.file.file_id]?.file;
          const outcome = localFileIds.has(event.file.file_id) ? "conflict" : "ready";
          if (prior && prior.path !== event.file.path) {
            actions.push(filePlanAction(
              "authority_to_local", "move", event.file.path, "remote_change", event.file,
              { previous_path: prior.path, outcome }
            ));
          }
          if (!prior || !sameBinaryInfo(prior, event.file)) {
            actions.push(filePlanAction(
              "authority_to_local", "put", event.file.path, "remote_change", event.file,
              { outcome }
            ));
          }
        } else {
          const prior = state.files?.[event.file_id]?.file;
          if (prior) actions.push({
            entity: "file",
            direction: "authority_to_local",
            operation: "delete",
            path: event.previous_path,
            identity: event.file_id,
            revision: event.revision,
            reason: "remote_change",
            outcome: localFileIds.has(event.file_id) ? "conflict" : "ready"
          });
        }
      }
      cursor = page.cursor;
      if (!page.has_more) break;
    }
    try {
      const recordEvents = remoteEvents.filter(
        (event): event is Extract<SyncChange<Frontmatter>, { type: "put" | "remove" }> =>
          event.type === "remove"
          || (event.type === "put" && pathSelected(this.selectiveSync, event.record.path))
      );
      if (recordEvents.length > 0) {
        preflightChangePhysicalPaths(
          recordEvents,
          await this.currentRecordPathPolicy(state),
          state
        );
      }
      if (remoteEvents.length > 0) {
        preflightProjectedPaths(state, remoteEvents, this.selectiveSync);
      }
    } catch (error) {
      issues.push(planIssue(error, undefined, true));
    }
    for (const action of actions) {
      if (
        (action.entity === "record" && action.identity && localRecordIds.has(action.identity))
        || (action.entity === "file" && action.identity && localFileIds.has(action.identity))
      ) {
        const remoteTouchesIdentity = actions.some((candidate) =>
          candidate.direction === "authority_to_local"
          && candidate.entity === action.entity
          && candidate.identity === action.identity
        );
        if (remoteTouchesIdentity) action.outcome = "conflict";
      }
    }
    issues.push(...this.persistedPlanIssues(state));
    const plan = finalizeMirrorPlan({
      plan_version: 1,
      replica_id: this.replicaId,
      mode: this.mode,
      kind: "incremental",
      base_cursor: state.cursor,
      authority_cursor: cursor,
      scope_epoch: state.scope_epoch,
      actions,
      issues
    }, this.runtime.digest);
    return {
      plan,
      incremental: {
        state: working,
        pages,
        stageFiles,
        localRecordIds,
        localFileIds
      }
    };
  }

  private persistedPlanIssues(state: MirrorState): MirrorPlanIssue[] {
    const issues: MirrorPlanIssue[] = [];
    for (const [recordId, receipt] of Object.entries(state.conflicts ?? {})) {
      const path = state.pending?.find((item) => item.mutation.record_id === recordId)?.local_path
        ?? state.records[recordId]?.path;
      issues.push({
        code: receipt.status === "rejected" ? receipt.error.code : "record_conflict",
        message: receipt.status === "rejected"
          ? receipt.error.message
          : "Local and authority document changes need a decision.",
        ...(path ? { path } : {}),
        blocking: false
      });
    }
    for (const conflict of Object.values(state.file_conflicts ?? {})) {
      issues.push({
        code: conflict.code,
        message: conflict.message,
        path: conflict.path,
        blocking: false
      });
    }
    return issues;
  }

}

function cloneMirrorStateForPlan(state: MirrorState): MirrorState {
  return {
    ...state,
    records: Object.fromEntries(
      Object.entries(state.records).map(([id, entry]) => [id, { ...entry }])
    ),
    resources: Object.fromEntries(
      Object.entries(state.resources ?? {}).map(([path, entry]) => [path, { ...entry }])
    ),
    files: Object.fromEntries(
      Object.entries(state.files ?? {}).map(([id, entry]) => [
        id,
        { ...entry, file: { ...entry.file } }
      ])
    ),
    pending: structuredClone(state.pending ?? []),
    pending_files: structuredClone(state.pending_files ?? []),
    conflicts: structuredClone(state.conflicts ?? {}),
    file_conflicts: structuredClone(state.file_conflicts ?? {}),
    local_issues: structuredClone(state.local_issues ?? {})
  };
}

export function preflightProjectedPaths<Frontmatter extends JsonObject>(
  state: MirrorState,
  events: Array<SyncChange<Frontmatter>>,
  selectiveSync: SelectiveSyncPolicy
): void {
  const records = new Map<string, string | null>();
  const files = new Map<string, string | null>();
  for (const event of events) {
    if (event.type === "put") {
      if (pathSelected(selectiveSync, event.record.path)) {
        records.set(event.record.record_id, event.record.path);
      } else records.set(event.record.record_id, null);
    } else if (event.type === "remove") records.set(event.record_id, null);
    else if (event.type === "file_put") {
      if (fileSelected(selectiveSync, event.file)) {
        files.set(event.file.file_id, event.file.path);
      } else files.set(event.file.file_id, null);
    } else files.set(event.file_id, null);
  }
  assertNoPhysicalPathAliases(projectedPhysicalPaths(state, records, files));
}

function recordMutationAction(
  pending: PendingMirrorMutation,
  reason: "pending" | "local_change",
  digest: (value: string) => string,
  state: MirrorState
): MirrorPlanAction {
  const mutation = pending.mutation;
  return {
    entity: "record",
    direction: "local_to_authority",
    operation: mutation.operation,
    path: mutation.operation === "move" || mutation.operation === "put"
      ? mutation.path
      : pending.local_path,
    ...(mutation.operation === "move"
      ? { previous_path: state.records[mutation.record_id]?.path ?? pending.local_path }
      : {}),
    ...(
      mutation.operation === "put" && mutation.base_revision === undefined
        ? {}
        : { identity: mutation.record_id }
    ),
    ...(mutation.operation === "put"
      ? { revision: `sha256:${digest(mutation.document)}` }
      : { revision: mutation.base_revision }),
    reason,
    outcome: "ready"
  };
}

function fileMutationAction(
  pending: PendingMirrorFileMutation,
  reason: "pending" | "local_change"
): MirrorPlanAction {
  return {
    entity: "file",
    direction: "local_to_authority",
    operation: pending.operation === "upload" ? "put" : pending.operation,
    path: pending.path,
    ...(pending.operation === "move" ? { previous_path: pending.from_path } : {}),
    ...(pending.operation === "upload" && !pending.file_id
      ? {}
      : { identity: pending.file_id }),
    ...(pending.operation === "delete"
      ? { revision: pending.base_revision }
      : { revision: pending.content_digest, size: pending.size }),
    reason,
    outcome: "ready"
  };
}

function pendingFileIdentity(pending: PendingMirrorFileMutation): string {
  if (pending.operation === "upload") return pending.file_id ?? `new:${pending.path}`;
  return pending.file_id;
}

function filePlanAction(
  direction: MirrorPlanAction["direction"],
  operation: MirrorPlanAction["operation"],
  path: string,
  reason: MirrorPlanAction["reason"],
  file: CollectionFileDescriptor,
  options: { previous_path?: string; outcome?: MirrorPlanAction["outcome"] } = {}
): MirrorPlanAction {
  return {
    entity: "file",
    direction,
    operation,
    path,
    ...(options.previous_path ? { previous_path: options.previous_path } : {}),
    identity: file.file_id,
    revision: file.revision,
    size: file.size,
    reason,
    outcome: options.outcome ?? "ready"
  };
}

function planIssue(error: unknown, path: string | undefined, blocking: boolean): MirrorPlanIssue {
  const value = error instanceof Error ? error : new Error(String(error));
  const code = error && typeof error === "object" && "code" in error
    && typeof error.code === "string"
    ? error.code
    : "sync_inspection_failed";
  return {
    code,
    message: value.message,
    ...(path ? { path } : {}),
    blocking
  };
}
