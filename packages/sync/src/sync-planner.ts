import type { SelectiveSyncPolicy } from "@mdbase-dev/connect-protocol";
import type {
  InspectionIssue,
  InspectionSummary,
  InspectedObject,
  ObjectUniverse
} from "./sync-inspection-model.js";
import {
  MIRROR_ENGINE_PROFILE,
  MIRROR_PLANNER_POLICY,
  MIRROR_PROJECTION_POLICY,
  type AdvanceCheckpointAction,
  type DeleteLocalAction,
  type DeleteRemoteAction,
  type ExpectedObjectState,
  type MoveLocalAction,
  type MoveRemoteAction,
  type PutRemoteAction,
  type RecordConflictAction,
  type SyncAction,
  type SyncObjectRef,
  type WriteLocalAction
} from "./sync-model.js";
import { canonicalSyncJson, syncFingerprint } from "./sync-plan-codec.js";

export interface ReconciliationPlan {
  plan_version: 1;
  engine_profile: typeof MIRROR_ENGINE_PROFILE;
  protocol_profile: "exact_document_v1";
  planner_policy: typeof MIRROR_PLANNER_POLICY;
  projection_policy: typeof MIRROR_PROJECTION_POLICY;
  fingerprint: string;
  replica_id: string;
  mode: "read_only" | "read_write";
  kind: "initial" | "incremental" | "rebuild";
  base_cursor: number | null;
  authority_cursor: number;
  scope_epoch: number;
  checkpoint_generation: number;
  selective_sync: SelectiveSyncPolicy;
  actions: SyncAction[];
  issues: InspectionIssue[];
  summary: {
    uploads: number;
    downloads: number;
    conflicts: number;
    blocking_issues: number;
  };
}

/** Stable identity matching is reconciliation policy and therefore stays pure. */
export function identifyInspectedObjects(
  universe: ObjectUniverse,
  identitySeed: string,
  digest: (value: string) => string
): InspectedObject[] {
  const base = new Map(universe.base.map((object) => [object.identity, object]));
  const remote = new Map(universe.remote.map((object) => [object.identity, object]));
  const local = new Map<string, SyncObjectRef>();
  const untracked = new Map(
    universe.local.map((observed) => [observed.object.path, observed])
  );

  // Explicit bindings (managed objects and durable conflicts) outrank all
  // path/content heuristics. This preserves identity across rename conflicts.
  for (const observed of universe.local) {
    if (!observed.stable_identity || observed.object.identity === "") continue;
    local.set(observed.object.identity, observed.object);
    untracked.delete(observed.object.path);
  }

  for (const [identity, baseObject] of base) {
    const atPriorPath = untracked.get(baseObject.path);
    if (atPriorPath) {
      local.set(identity, { ...atPriorPath.object, identity });
      untracked.delete(baseObject.path);
    }
  }
  for (const [identity, remoteObject] of remote) {
    if (local.has(identity)) continue;
    const atRemotePath = untracked.get(remoteObject.path);
    if (atRemotePath && atRemotePath.object.entity === remoteObject.entity) {
      local.set(identity, { ...atRemotePath.object, identity });
      untracked.delete(remoteObject.path);
    }
  }
  for (const [identity, baseObject] of base) {
    if (local.has(identity)) continue;
    const candidates = [...untracked.values()].filter((observed) =>
      observed.object.entity === baseObject.entity
      && observed.object.payload_revision === baseObject.payload_revision
    );
    if (candidates.length !== 1) continue;
    const candidate = candidates[0]!;
    local.set(identity, {
      ...candidate.object,
      identity,
      revision: candidate.object.payload_revision === baseObject.payload_revision
        ? baseObject.revision
        : candidate.object.revision
    });
    untracked.delete(candidate.object.path);
  }
  for (const observed of untracked.values()) {
    const identity = observed.stable_identity
      ? observed.object.identity
      : deterministicIdentity(identitySeed, observed.object, digest);
    local.set(identity, { ...observed.object, identity });
  }

  const identities = new Set([...base.keys(), ...local.keys(), ...remote.keys()]);
  const localAtPath = new Map([...local.values()].map((object) => [object.path, object]));
  const remoteAtPath = new Map([...remote.values()].map((object) => [object.path, object]));
  return [...identities].sort().map((identity): InspectedObject => {
    const baseObject = base.get(identity);
    const localObject = local.get(identity);
    const remoteObject = remote.get(identity);
    const localTargetPath = remoteObject?.path ?? localObject?.path ?? baseObject!.path;
    const remoteTargetPath = localObject?.path ?? remoteObject?.path ?? baseObject!.path;
    return {
      entity: (localObject ?? remoteObject ?? baseObject)!.entity,
      identity,
      base: objectState(baseObject),
      local: objectState(localObject),
      remote: objectState(remoteObject),
      local_target_owner: objectState(localAtPath.get(localTargetPath)),
      remote_target_owner: objectState(remoteAtPath.get(remoteTargetPath))
    };
  });
}

type ActionDraft = SyncAction extends infer Action
  ? Action extends SyncAction
    ? Omit<Action, "action_id" | "depends_on"> & {
      key: string;
      depends_on_keys: string[];
    }
    : never
  : never;

/** The only production constructor for reconciliation actions. Pure; no I/O. */
export function planReconciliation(
  inspection: InspectionSummary,
  digest: (value: string) => string
): ReconciliationPlan {
  const drafts: ActionDraft[] = [];
  for (const object of [...inspection.objects].sort(compareObject)) {
    planObject(inspection, object, drafts);
  }
  const effectKeys = drafts.map((draft) => draft.key);
  drafts.push({
    key: "checkpoint",
    depends_on_keys: effectKeys,
    command: "advance_checkpoint",
    reason: inspection.kind === "incremental" ? "remote_change" : inspection.kind,
    expected: inspection.boundary.checkpoint,
    next: {
      generation: inspection.boundary.checkpoint.generation + 1,
      cursor: inspection.boundary.authority_cursor
    }
  } satisfies ActionDraft);

  const ids = new Map<string, string>();
  for (const draft of drafts) {
    const { key, depends_on_keys: _, ...semantic } = draft;
    ids.set(key, syncFingerprint({ key, ...semantic }, digest));
  }
  const actions = drafts.map((draft): SyncAction => {
    const { key, depends_on_keys, ...semantic } = draft;
    const action = {
      ...semantic,
      action_id: ids.get(key)!,
      depends_on: depends_on_keys.map((dependency) => ids.get(dependency)!)
    } as SyncAction;
    if (
      action.command === "put_remote"
      || action.command === "move_remote"
      || action.command === "delete_remote"
    ) {
      action.idempotency_key = action.action_id;
    }
    if (action.command === "move_remote" && action.depends_on.length > 0) {
      action.revision_from_dependency = action.depends_on.at(-1);
    }
    return action;
  });
  const issues = [...inspection.issues].sort(compareIssue);
  const summary = {
    uploads: actions.filter(isUpload).length,
    downloads: actions.filter(isDownload).length,
    conflicts: actions.filter((action) => action.command === "record_conflict").length,
    blocking_issues: issues.filter((issue) => issue.blocking).length
  };
  const stable = {
    plan_version: 1 as const,
    engine_profile: MIRROR_ENGINE_PROFILE,
    protocol_profile: "exact_document_v1" as const,
    planner_policy: MIRROR_PLANNER_POLICY,
    projection_policy: MIRROR_PROJECTION_POLICY,
    replica_id: inspection.boundary.replica_id,
    mode: inspection.mode,
    kind: inspection.kind,
    base_cursor: inspection.boundary.checkpoint.cursor,
    authority_cursor: inspection.boundary.authority_cursor,
    scope_epoch: inspection.boundary.scope_epoch,
    checkpoint_generation: inspection.boundary.checkpoint.generation,
    selective_sync: inspection.selective_sync,
    actions,
    issues,
    summary
  };
  return { ...stable, fingerprint: syncFingerprint(stable, digest) };
}

function planObject(
  inspection: InspectionSummary,
  object: InspectedObject,
  drafts: ActionDraft[]
): void {
  if (object.frozen_conflict) {
    drafts.push({
      key: `${object.identity}:conflict`,
      depends_on_keys: [],
      command: "record_conflict",
      reason: "pending",
      identity: object.identity,
      entity: object.entity as "record" | "file",
      ...object.frozen_conflict
    } satisfies ActionDraft & Omit<RecordConflictAction, "action_id" | "depends_on">);
    return;
  }
  const localChanged = !sameState(object.local, object.base);
  const remoteChanged = !sameState(object.remote, object.base);
  if (!localChanged && !remoteChanged) return;
  if (object.entity === "resource") {
    if (localChanged) return;
    planRemoteToLocal(object, drafts);
    return;
  }
  if (inspection.mode === "read_only") {
    if (!localChanged) planRemoteToLocal(object, drafts);
    return;
  }
  if (localChanged && remoteChanged) {
    if (sameState(object.local, object.remote)) return;
    drafts.push(conflictDraft(object));
    return;
  }
  if (localChanged) planLocalToRemote(object, drafts);
  else planRemoteToLocal(object, drafts);
}

function planRemoteToLocal(object: InspectedObject, drafts: ActionDraft[]): void {
  if (object.remote.state === "absent") {
    if (object.local.state === "exact") {
      drafts.push({
        key: `${object.identity}:delete-local`,
        depends_on_keys: [],
        command: "delete_local",
        reason: "remote_change",
        target: object.local.object,
        expected_local: object.local,
        expected_path_owner: object.local_target_owner
      } satisfies ActionDraft & Omit<DeleteLocalAction, "action_id" | "depends_on">);
    }
    return;
  }
  const remote = object.remote.object;
  if (object.local.state === "absent") {
    drafts.push(writeLocal(object, remote, []));
    return;
  }
  const local = object.local.object;
  let dependency: string | undefined;
  if (local.path !== remote.path) {
    const key = `${object.identity}:move-local`;
    drafts.push({
      key,
      depends_on_keys: [],
      command: "move_local",
      reason: "remote_change",
      source: local,
      target_path: remote.path,
      expected_source_owner: object.local,
      expected_target_owner: object.local_target_owner
    } satisfies ActionDraft & Omit<MoveLocalAction, "action_id" | "depends_on">);
    dependency = key;
  }
  if (local.revision !== remote.revision) {
    drafts.push(writeLocal(object, remote, dependency ? [dependency] : []));
  }
}

function writeLocal(
  object: InspectedObject,
  target: SyncObjectRef,
  depends_on_keys: string[]
): ActionDraft & Omit<WriteLocalAction, "action_id" | "depends_on"> {
  return {
    key: `${object.identity}:write-local`,
    depends_on_keys,
    command: "write_local",
    reason: "remote_change",
    target,
    payload_revision: target.payload_revision,
    expected_local: depends_on_keys.length > 0
      ? { state: "exact", object: {
        ...target,
        revision: exact(object.local).revision,
        payload_revision: exact(object.local).payload_revision,
        ...(exact(object.local).size === undefined ? {} : { size: exact(object.local).size })
      } }
      : object.local,
    expected_path_owner: depends_on_keys.length > 0
      ? { state: "exact", object: {
        ...target,
        revision: exact(object.local).revision,
        payload_revision: exact(object.local).payload_revision,
        ...(exact(object.local).size === undefined ? {} : { size: exact(object.local).size })
      } }
      : object.local_target_owner
  };
}

function planLocalToRemote(object: InspectedObject, drafts: ActionDraft[]): void {
  if (object.local.state === "absent") {
    if (object.remote.state === "exact") {
      drafts.push({
        key: `${object.identity}:delete-remote`,
        depends_on_keys: [],
        command: "delete_remote",
        reason: "local_change",
        target: object.remote.object,
        expected_remote: object.remote,
        expected_local: object.local,
        idempotency_key: ""
      } satisfies ActionDraft & Omit<DeleteRemoteAction, "action_id" | "depends_on">);
    }
    return;
  }
  const local = object.local.object;
  if (object.remote.state === "absent") {
    drafts.push(putRemote(object, local, []));
    return;
  }
  const remote = object.remote.object;
  let dependency: string | undefined;
  if (local.revision !== remote.revision) {
    const put = putRemote(object, { ...local, path: remote.path }, []);
    drafts.push(put);
    dependency = put.key;
  }
  if (local.path !== remote.path) {
    drafts.push({
      key: `${object.identity}:move-remote`,
      depends_on_keys: dependency ? [dependency] : [],
      command: "move_remote",
      reason: "local_change",
      source: dependency ? { ...remote, revision: local.revision } : remote,
      target_path: local.path,
      expected_source_owner: dependency
        ? { state: "exact", object: { ...remote, revision: local.revision } }
        : object.remote,
      expected_target_owner: object.remote_target_owner,
      expected_local: object.local,
      idempotency_key: ""
    } satisfies ActionDraft & Omit<MoveRemoteAction, "action_id" | "depends_on">);
  }
}

function putRemote(
  object: InspectedObject,
  target: SyncObjectRef,
  depends_on_keys: string[]
): ActionDraft & Omit<PutRemoteAction, "action_id" | "depends_on"> {
  return {
    key: `${object.identity}:put-remote`,
    depends_on_keys,
    command: "put_remote",
    reason: "local_change",
    target,
    payload_revision: exact(object.local).payload_revision,
    expected_remote: object.remote,
    expected_local: object.local,
    idempotency_key: ""
  };
}

function conflictDraft(object: InspectedObject): ActionDraft & Omit<RecordConflictAction, "action_id" | "depends_on"> {
  return {
    key: `${object.identity}:conflict`,
    depends_on_keys: [],
    command: "record_conflict",
    reason: "remote_change",
    identity: object.identity,
    entity: object.entity as "record" | "file",
    local: object.local,
    remote: object.remote,
    conflict_kind: object.local.state === "absent" || object.remote.state === "absent"
      ? "delete_vs_change"
      : "both_changed"
  };
}

function exact(state: ExpectedObjectState): SyncObjectRef {
  if (state.state !== "exact") throw new Error("Planner invariant: expected exact object state.");
  return state.object;
}

function objectState(object: SyncObjectRef | undefined): ExpectedObjectState {
  return object ? { state: "exact", object } : { state: "absent" };
}

function deterministicIdentity(
  seed: string,
  object: SyncObjectRef,
  digest: (value: string) => string
): string {
  const hex = digest(`${seed}\0${object.entity}\0${object.path}\0${object.revision}`);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function sameState(left: ExpectedObjectState, right: ExpectedObjectState): boolean {
  return canonicalSyncJson(left) === canonicalSyncJson(right);
}

function compareObject(left: InspectedObject, right: InspectedObject): number {
  return `${left.entity}\0${left.identity}`.localeCompare(`${right.entity}\0${right.identity}`);
}

function compareIssue(left: InspectionIssue, right: InspectionIssue): number {
  return `${left.path ?? ""}\0${left.code}\0${left.message}`
    .localeCompare(`${right.path ?? ""}\0${right.code}\0${right.message}`);
}

function isUpload(action: SyncAction): boolean {
  return action.command === "put_remote"
    || action.command === "move_remote"
    || action.command === "delete_remote";
}

function isDownload(action: SyncAction): boolean {
  return action.command === "write_local"
    || action.command === "move_local"
    || action.command === "delete_local";
}
