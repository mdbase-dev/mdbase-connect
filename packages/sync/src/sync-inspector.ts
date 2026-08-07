import type {
  CollectionFileDescriptor,
  JsonObject,
  SelectiveSyncPolicy,
  SyncChange,
  SyncRecord,
  SyncResourceDocument
} from "@mdbase-dev/connect-protocol";
import { SyncError } from "./sync-error.js";
import {
  ensureFileBlob,
  fileSelected,
  normalizeSelectiveSyncPolicy,
  pathFileSelected,
  pathSelected,
  validateCollectionFileDescriptor,
  verifiedBinaryBytes
} from "./mirror-files.js";
import {
  filterRecordPaths,
  validateSnapshotResources,
  type MirrorRecordPathPolicy
} from "./mirror-path-policy.js";
import { assertNoPhysicalPathAliases } from "./mirror-physical-path.js";
import { loadMirrorSnapshot, type LoadedMirrorSnapshot } from "./sync-snapshot-loader.js";
import type {
  DurableSyncPayloads,
  MirrorBlobStore,
  MirrorFileSystem,
  MirrorRuntime,
  MirrorState
} from "./mirror-state.js";
import type { SyncTransport } from "./sync-types.js";
import {
  identifyInspectedObjects,
  planReconciliation,
  type ReconciliationPlan
} from "./sync-planner.js";
import type {
  InspectionIssue,
  InspectionSummary,
  ObservedObject
} from "./sync-inspection-model.js";
import {
  MIRROR_ENGINE_PROFILE,
  MIRROR_PLANNER_POLICY,
  MIRROR_PROJECTION_POLICY,
  type SyncObjectRef
} from "./sync-model.js";
import { syncFingerprint } from "./sync-plan-codec.js";
import { assertRecordSyncChange } from "./record-sync-change.js";

export interface PlanOnlyInspection<Frontmatter extends JsonObject> {
  summary: InspectionSummary;
  plan: ReconciliationPlan;
  /** Private revision-bound payload capabilities sealed by this inspection. */
  durable_payloads: DurableSyncPayloads;
  prior: MirrorState | null;
  snapshot?: LoadedMirrorSnapshot<Frontmatter>;
  remote_records: ReadonlyMap<string, SyncRecord<Frontmatter>>;
  remote_files: ReadonlyMap<string, CollectionFileDescriptor>;
}

interface LocalInspection {
  observations: ObservedObject[];
  documents: Map<string, string>;
  binary: Map<string, { size: number; content_digest: `sha256:${string}` }>;
  issues: InspectionIssue[];
}

export class PlanOnlyMirrorInspector<Frontmatter extends JsonObject = JsonObject> {
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

  async inspect(suppliedState?: MirrorState | null): Promise<PlanOnlyInspection<Frontmatter>> {
    const state = suppliedState === undefined ? await this.readState() : suppliedState;
    if (!state) return this.inspectSnapshot("initial", null);
    if (state.batch) {
      throw new SyncError(
        "mirror_recovery_required",
        "The prepared sync batch must recover before a new inspection can be planned."
      );
    }
    if (JSON.stringify(state.selective_sync) !== JSON.stringify(this.selectiveSync)) {
      return this.inspectSnapshot("rebuild", state);
    }
    return this.inspectIncremental(state);
  }

  private async inspectSnapshot(
    kind: "initial" | "rebuild",
    prior: MirrorState | null
  ): Promise<PlanOnlyInspection<Frontmatter>> {
    const snapshot = await loadMirrorSnapshot(
      this.replicaId,
      this.transport,
      this.mode,
      this.selectiveSync,
      this.runtime
    );
    const pathPolicy = validateSnapshotResources(snapshot.resources);
    const local = await this.inspectLocal(prior, snapshot.resources, pathPolicy);
    const remoteRecords = new Map(
      snapshot.records.map(({ record }) => [record.record_id, record])
    );
    const remoteFiles = new Map(snapshot.files.map((file) => [file.file_id, file]));
    return this.finish({
      kind,
      prior,
      authorityCursor: snapshot.session.head,
      scopeEpoch: snapshot.session.scope_epoch,
      local,
      remoteRecords,
      remoteResources: snapshot.resources,
      remoteFiles,
      snapshot
    });
  }

  private async inspectIncremental(
    state: MirrorState
  ): Promise<PlanOnlyInspection<Frontmatter>> {
    const remoteRecords = new Map<string, SyncRecord<Frontmatter>>();
    for (const [identity, entry] of Object.entries(state.records)) {
      if (entry.record) remoteRecords.set(identity, entry.record as SyncRecord<Frontmatter>);
    }
    const remoteFiles = new Map(
      Object.entries(state.files ?? {}).map(([identity, entry]) => [identity, entry.file])
    );
    const remoteRefs = new Map<string, SyncObjectRef>(baseRefs(state).map((ref) => [key(ref), ref]));
    let cursor = state.cursor;
    let previousSequence = state.cursor;
    while (true) {
      const requestedAfter = cursor;
      const page = await this.transport.changes(requestedAfter, 200);
      if (
        page.scope_epoch !== state.scope_epoch
        || page.cursor < requestedAfter
        || page.cursor > page.head
        || (page.has_more && page.cursor === requestedAfter)
      ) {
        throw new SyncError("invalid_change_page", "Authority returned an invalid change boundary.");
      }
      if (page.reset_required) return this.inspectSnapshot("rebuild", state);
      for (const event of page.events) {
        if (event.sequence <= previousSequence || event.sequence > page.cursor) {
          throw new SyncError("invalid_change_page", "Authority change events are not strictly ordered.");
        }
        previousSequence = event.sequence;
        this.applyRemoteObservation(remoteRefs, remoteRecords, remoteFiles, event);
      }
      cursor = page.cursor;
      if (!page.has_more) break;
    }
    const resources = Object.values(state.resources ?? {}).map((entry): SyncResourceDocument => ({
      path: entry.path,
      kind: resourceKind(entry.path),
      revision: entry.revision,
      document: ""
    }));
    const local = await this.inspectLocal(
      state,
      resources,
      await this.currentRecordPathPolicy(state)
    );
    return this.finish({
      kind: "incremental",
      prior: state,
      authorityCursor: cursor,
      scopeEpoch: state.scope_epoch,
      local,
      remoteRecords,
      remoteResources: [],
      remoteFiles,
      remoteRefs: [...remoteRefs.values()]
    });
  }

  private applyRemoteObservation(
    refs: Map<string, SyncObjectRef>,
    records: Map<string, SyncRecord<Frontmatter>>,
    files: Map<string, CollectionFileDescriptor>,
    event: SyncChange<Frontmatter>
  ): void {
    if (event.type === "put") {
      assertRecordSyncChange(event);
      const identity = event.record.record_id;
      if (pathSelected(this.selectiveSync, event.record.path)) {
        refs.set(`record:${identity}`, recordRef(event.record));
        records.set(identity, event.record);
      } else {
        refs.delete(`record:${identity}`);
        records.delete(identity);
      }
      return;
    }
    if (event.type === "remove") {
      refs.delete(`record:${event.record_id}`);
      records.delete(event.record_id);
      return;
    }
    if (event.type === "file_put") {
      validateCollectionFileDescriptor(event.file);
      const identity = event.file.file_id;
      if (fileSelected(this.selectiveSync, event.file)) {
        refs.set(`file:${identity}`, fileRef(event.file));
        files.set(identity, event.file);
      } else {
        refs.delete(`file:${identity}`);
        files.delete(identity);
      }
      return;
    }
    refs.delete(`file:${event.file_id}`);
    files.delete(event.file_id);
  }

  private async inspectLocal(
    state: MirrorState | null,
    resources: SyncResourceDocument[],
    pathPolicy: MirrorRecordPathPolicy
  ): Promise<LocalInspection> {
    const observations: ObservedObject[] = [];
    const documents = new Map<string, string>();
    const binary = new Map<string, { size: number; content_digest: `sha256:${string}` }>();
    const issues: InspectionIssue[] = [];
    const priorRecordsByPath = new Map(
      Object.entries(state?.records ?? {}).map(([identity, entry]) => [entry.path, [identity, entry] as const])
    );
    const recordConflictsByPath = new Map(
      Object.entries(state?.planned_conflicts ?? {})
        .filter(([, conflict]) => conflict.entity === "record" && conflict.local.state === "exact")
        .map(([identity, conflict]) => [
          conflict.local.state === "exact" ? conflict.local.object.path : "",
          identity
        ])
    );
    const recordBindingsByPath = new Map(
      Object.entries(state?.local_bindings ?? {})
        .filter(([, binding]) => binding.entity === "record")
        .map(([identity, binding]) => [binding.path, identity])
    );
    const resourcePaths = new Set([
      ...Object.keys(state?.resources ?? {}),
      ...resources.map((resource) => resource.path)
    ]);
    for (const path of resourcePaths) {
      const document = await this.fileSystem.read(path);
      const prior = state?.resources?.[path];
      if (document === null) continue;
      const revision = `sha256:${this.runtime.digest(document)}`;
      observations.push({
        stable_identity: true,
        object: textRef("resource", path, path, revision)
      });
      documents.set(path, document);
      const authority = resources.find((resource) => resource.path === path);
      if (!prior && authority && authority.revision !== revision) {
        issues.push({
          code: "local_collision",
          message: `${path} differs locally from the exact authority document.`,
          path,
          blocking: true
        });
      } else if (prior && prior.revision !== revision) {
        issues.push({
          code: "mirror_diverged",
          message: `Authority-owned resource ${path} changed locally.`,
          path,
          blocking: true
        });
      }
    }

    const managedRecordPaths = new Set(Object.values(state?.records ?? {}).map((entry) => entry.path));
    const recordPaths = filterRecordPaths(
      await this.fileSystem.listMarkdown(resourcePaths),
      pathPolicy
    ).filter((path) => pathSelected(this.selectiveSync, path) || managedRecordPaths.has(path));
    for (const path of recordPaths) {
      const document = await this.fileSystem.read(path);
      if (document === null) continue;
      const revision = `sha256:${this.runtime.digest(document)}`;
      const conflictIdentity = recordConflictsByPath.get(path);
      const boundIdentity = recordBindingsByPath.get(path);
      const priorIdentity = priorRecordsByPath.get(path)?.[0];
      const identity = conflictIdentity ?? boundIdentity ?? priorIdentity ?? "";
      observations.push({
        stable_identity: identity !== "",
        object: textRef("record", identity, path, revision)
      });
      documents.set(path, document);
    }

    if (this.selectiveSync.file_classes.length > 0) {
      if (!this.fileSystem.listBinary) {
        throw new SyncError("file_storage_unavailable", "Selected files require binary enumeration.");
      }
      const managedFilePaths = new Set(Object.values(state?.files ?? {}).map((entry) => entry.file.path));
      const priorFilesByPath = new Map(
        Object.entries(state?.files ?? {}).map(([identity, entry]) => [entry.file.path, [identity, entry] as const])
      );
      const fileConflictsByPath = new Map(
        Object.entries(state?.planned_conflicts ?? {})
          .filter(([, conflict]) => conflict.entity === "file" && conflict.local.state === "exact")
          .map(([identity, conflict]) => [
            conflict.local.state === "exact" ? conflict.local.object.path : "",
            identity
          ])
      );
      const fileBindingsByPath = new Map(
        Object.entries(state?.local_bindings ?? {})
          .filter(([, binding]) => binding.entity === "file")
          .map(([identity, binding]) => [binding.path, identity])
      );
      const paths = (await this.fileSystem.listBinary(resourcePaths))
        .filter((path) => pathFileSelected(this.selectiveSync, path) || managedFilePaths.has(path));
      for (const path of paths) {
        const info = await this.fileSystem.inspectBinary(path);
        if (!info) continue;
        const conflictIdentity = fileConflictsByPath.get(path);
        const boundIdentity = fileBindingsByPath.get(path);
        const prior = priorFilesByPath.get(path);
        const identity = conflictIdentity ?? boundIdentity ?? prior?.[0] ?? "";
        observations.push({
          stable_identity: identity !== "",
          object: {
            entity: "file",
            identity,
            path,
            revision: prior && prior[1].file.content_digest === info.content_digest
              ? prior[1].file.revision
              : info.content_digest,
            payload_revision: info.content_digest,
            size: info.size
          }
        });
        binary.set(path, info);
      }
    }
    try {
      assertNoPhysicalPathAliases([
        ...resourcePaths,
        ...recordPaths,
        ...binary.keys()
      ]);
    } catch (error) {
      const value = error instanceof Error ? error : new Error(String(error));
      issues.push({
        code: errorCode(error),
        message: value.message,
        blocking: true
      });
    }
    return { observations, documents, binary, issues };
  }

  private async finish(options: {
    kind: "initial" | "incremental" | "rebuild";
    prior: MirrorState | null;
    authorityCursor: number;
    scopeEpoch: number;
    local: LocalInspection;
    remoteRecords: Map<string, SyncRecord<Frontmatter>>;
    remoteResources: SyncResourceDocument[];
    remoteFiles: Map<string, CollectionFileDescriptor>;
    remoteRefs?: SyncObjectRef[];
    snapshot?: LoadedMirrorSnapshot<Frontmatter>;
  }): Promise<PlanOnlyInspection<Frontmatter>> {
    const { prior, local } = options;
    const remoteRefs = options.remoteRefs ?? [
      ...options.remoteResources.map(resourceRef),
      ...[...options.remoteRecords.values()].map(recordRef),
      ...[...options.remoteFiles.values()].map(fileRef)
    ];
    const objects = identifyInspectedObjects({
      base: prior ? baseRefs(prior) : [],
      local: local.observations,
      remote: remoteRefs
    }, `${this.replicaId}\0${options.scopeEpoch}\0${prior?.generation ?? 0}`, this.runtime.digest);
    for (const object of objects) {
      const frozen = prior?.planned_conflicts?.[object.identity];
      if (!frozen || frozen.entity !== object.entity) continue;
      object.frozen_conflict = {
        local: frozen.local,
        remote: frozen.remote,
        conflict_kind: frozen.conflict_kind
      };
    }
    const issues = [...local.issues];
    for (const object of objects) {
      if (
        (options.kind === "initial" || options.kind === "rebuild")
        && object.base.state === "absent"
        && object.local.state === "exact"
        && object.remote.state === "exact"
        && !sameObjectState(object.local, object.remote)
      ) {
        issues.push({
          code: "local_collision",
          message: `${object.remote.object.path} differs locally from the exact authority object.`,
          path: object.remote.object.path,
          blocking: this.mode !== "read_write" || object.entity === "resource"
        });
      }
      if (
        object.remote.state === "exact"
        && object.local_target_owner.state === "exact"
        && object.remote.object.identity !== object.local_target_owner.object.identity
      ) {
        issues.push({
          code: "local_collision",
          message: `${object.remote.object.path} is owned by different local bytes.`,
          path: object.remote.object.path,
          blocking: true
        });
      }
    }
    try {
      assertNoPhysicalPathAliases([
        ...remoteRefs.map((ref) => ref.path),
        ...local.observations.map(({ object }) => object.path)
      ]);
    } catch (error) {
      const value = error instanceof Error ? error : new Error(String(error));
      issues.push({ code: errorCode(error), message: value.message, blocking: true });
    }
    if (this.mode === "read_only") {
      for (const object of objects) {
        if (object.entity !== "resource" && !sameObjectState(object.local, object.base)) {
          const path = statePath(object.local, object.base);
          if (issues.some((issue) => issue.blocking && issue.path === path)) continue;
          issues.push({
            code: "mirror_diverged",
            message: `${path} changed in a receive-only mirror.`,
            path,
            blocking: true
          });
        }
      }
    }
    const selectiveSyncFingerprint = syncFingerprint(
      normalizeSelectiveSyncPolicy(this.selectiveSync),
      this.runtime.digest
    );
    const summary: InspectionSummary = {
      boundary: {
        engine_profile: MIRROR_ENGINE_PROFILE,
        protocol_profile: "exact_document_v1",
        planner_policy: MIRROR_PLANNER_POLICY,
        projection_policy: MIRROR_PROJECTION_POLICY,
        replica_id: this.replicaId,
        scope_epoch: options.scopeEpoch,
        authority_cursor: options.authorityCursor,
        checkpoint: {
          generation: prior?.generation ?? 0,
          cursor: prior?.cursor ?? null
        },
        selective_sync_fingerprint: selectiveSyncFingerprint
      },
      mode: this.mode,
      kind: options.kind,
      selective_sync: normalizeSelectiveSyncPolicy(this.selectiveSync),
      objects,
      issues: deduplicateIssues(issues)
    };
    const plan = planReconciliation(summary, this.runtime.digest);
    const durable = await this.bindPayloads(
      plan,
      local,
      options.remoteRecords,
      options.remoteResources,
      options.remoteFiles
    );
    return {
      summary,
      plan,
      durable_payloads: durable,
      prior,
      snapshot: options.snapshot,
      remote_records: options.remoteRecords,
      remote_files: options.remoteFiles
    };
  }

  private async bindPayloads(
    plan: ReconciliationPlan,
    local: LocalInspection,
    remoteRecords: Map<string, SyncRecord<Frontmatter>>,
    remoteResources: SyncResourceDocument[],
    remoteFiles: Map<string, CollectionFileDescriptor>
  ): Promise<DurableSyncPayloads> {
    const payloads: DurableSyncPayloads = {
      documents: {},
      records: {},
      resources: {},
      files: {},
      local_files: {},
      mutations: {}
    };
    const resources = new Map(remoteResources.map((resource) => [resource.path, resource]));
    for (const action of plan.actions) {
      if (action.command === "put_remote") {
        const localPath = action.expected_local.state === "exact"
          ? action.expected_local.object.path
          : action.target.path;
        if (action.target.entity === "file") {
          const info = local.binary.get(localPath);
          if (!info) throw missingPayload(action.action_id);
          await this.stageLocalBinary(localPath, info);
          payloads.local_files[action.action_id] = { path: localPath, ...info };
        } else {
          const document = local.documents.get(localPath);
          if (document === undefined || `sha256:${this.runtime.digest(document)}` !== action.payload_revision) {
            throw missingPayload(action.action_id);
          }
          payloads.documents[action.action_id] = document;
        }
        if (action.target.entity === "record") {
          payloads.mutations[action.action_id] = {
            operation: "put",
            mutation_id: uuidFromAction(action.action_id),
            replica_id: this.replicaId,
            scope_epoch: plan.scope_epoch,
            record_id: action.target.identity,
            ...(action.expected_remote.state === "exact"
              ? { base_revision: action.expected_remote.object.revision }
              : {}),
            path: action.target.path,
            document: payloads.documents[action.action_id]!,
            created_at: this.runtime.now()
          };
        }
      } else if (action.command === "write_local") {
        if (action.target.entity === "record") {
          const record = remoteRecords.get(action.target.identity);
          if (!record || record.revision !== action.target.revision) throw missingPayload(action.action_id);
          payloads.records[action.action_id] = record;
        } else if (action.target.entity === "resource") {
          const resource = resources.get(action.target.path);
          if (!resource || resource.revision !== action.target.revision) throw missingPayload(action.action_id);
          payloads.resources[action.action_id] = resource;
        } else {
          const file = remoteFiles.get(action.target.identity);
          if (!file || file.revision !== action.target.revision || !this.blobStore) {
            throw missingPayload(action.action_id);
          }
          await ensureFileBlob(this.transport, this.blobStore, file);
          payloads.files[action.action_id] = file;
        }
      } else if (action.command === "record_conflict" && action.remote.state === "exact") {
        if (action.entity === "record") {
          const record = remoteRecords.get(action.identity);
          if (!record || record.revision !== action.remote.object.revision) {
            throw missingPayload(action.action_id);
          }
          payloads.records[action.action_id] = record;
        } else {
          const file = remoteFiles.get(action.identity);
          if (!file || file.revision !== action.remote.object.revision) {
            throw missingPayload(action.action_id);
          }
          payloads.files[action.action_id] = file;
        }
      } else if (action.command === "move_remote" && action.source.entity === "record") {
        payloads.mutations[action.action_id] = {
          operation: "move",
          mutation_id: uuidFromAction(action.action_id),
          replica_id: this.replicaId,
          scope_epoch: plan.scope_epoch,
          record_id: action.source.identity,
          base_revision: action.expected_source_owner.state === "exact"
            ? action.expected_source_owner.object.revision
            : action.source.revision,
          path: action.target_path,
          created_at: this.runtime.now()
        };
      } else if (action.command === "delete_remote" && action.target.entity === "record") {
        payloads.mutations[action.action_id] = {
          operation: "delete",
          mutation_id: uuidFromAction(action.action_id),
          replica_id: this.replicaId,
          scope_epoch: plan.scope_epoch,
          record_id: action.target.identity,
          base_revision: action.expected_remote.state === "exact"
            ? action.expected_remote.object.revision
            : action.target.revision,
          created_at: this.runtime.now()
        };
      }
    }
    return payloads;
  }

  private async stageLocalBinary(
    path: string,
    info: { size: number; content_digest: `sha256:${string}` }
  ): Promise<void> {
    if (!this.blobStore || !this.fileSystem.readBinary) {
      throw new SyncError(
        "writable_file_storage_unavailable",
        "Writable files require streaming filesystem and blob-store adapters."
      );
    }
    if (await this.blobStore.has(info.content_digest)) return;
    const source = await this.fileSystem.readBinary(path);
    if (!source) throw new SyncError("sync_plan_stale", `${path} disappeared during inspection.`);
    await this.blobStore.write(
      info.content_digest,
      verifiedBinaryBytes(source, info, path)
    );
  }
}

function deduplicateIssues(issues: InspectionIssue[]): InspectionIssue[] {
  const unique = new Map<string, InspectionIssue>();
  for (const issue of issues) {
    unique.set(`${issue.code}\0${issue.path ?? ""}\0${issue.message}\0${issue.blocking}`, issue);
  }
  return [...unique.values()];
}

function baseRefs(state: MirrorState): SyncObjectRef[] {
  return [
    ...Object.entries(state.resources ?? {}).map(([identity, entry]) =>
      textRef("resource", identity, entry.path, entry.revision)
    ),
    ...Object.entries(state.records).map(([identity, entry]) =>
      textRef("record", identity, entry.path, entry.revision)
    ),
    ...Object.entries(state.files ?? {}).map(([identity, entry]) => fileRef({
      ...entry.file,
      file_id: identity
    }))
  ];
}

function recordRef(record: SyncRecord): SyncObjectRef {
  return textRef("record", record.record_id, record.path, record.revision);
}

function resourceRef(resource: SyncResourceDocument): SyncObjectRef {
  return textRef("resource", resource.path, resource.path, resource.revision);
}

function textRef(
  entity: "record" | "resource",
  identity: string,
  path: string,
  revision: string
): SyncObjectRef {
  return { entity, identity, path, revision, payload_revision: revision };
}

function fileRef(file: CollectionFileDescriptor): SyncObjectRef {
  return {
    entity: "file",
    identity: file.file_id,
    path: file.path,
    revision: file.revision,
    payload_revision: file.content_digest,
    size: file.size
  };
}

function key(ref: SyncObjectRef): string {
  return `${ref.entity}:${ref.identity}`;
}

function sameObjectState(
  left: import("./sync-model.js").ExpectedObjectState,
  right: import("./sync-model.js").ExpectedObjectState
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function statePath(
  preferred: import("./sync-model.js").ExpectedObjectState,
  fallback: import("./sync-model.js").ExpectedObjectState
): string {
  if (preferred.state === "exact") return preferred.object.path;
  if (fallback.state === "exact") return fallback.object.path;
  return "mirror";
}

function missingPayload(actionId: string): SyncError {
  return new SyncError(
    "sync_payload_incomplete",
    `Inspected action ${actionId} has no revision-bound payload.`
  );
}

function errorCode(error: unknown): string {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : "sync_inspection_failed";
}

function resourceKind(path: string): SyncResourceDocument["kind"] {
  if (path === "mdbase.yaml") return "configuration";
  if (path.endsWith("lock.yaml")) return "lock";
  if (path.startsWith("_types/")) return "type";
  if (path.startsWith("_contracts/")) return "contract";
  if (path.startsWith("_views/")) return "view";
  return "schema";
}

function uuidFromAction(actionId: string): string {
  const hex = actionId.replace(/^sha256:/u, "");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
