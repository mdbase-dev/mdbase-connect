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
  type ClearConflictAction,
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
  let drafts: ActionDraft[] = [];
  for (const object of [...inspection.objects].sort(compareObject)) {
    planObject(inspection, object, drafts);
  }
  drafts = orderLocalPathTransitions(drafts, inspection.objects, digest);
  drafts = orderRemotePathTransitions(drafts, inspection.objects);
  const requiresCheckpoint = drafts.length > 0
    || inspection.kind !== "incremental"
    || inspection.boundary.checkpoint.cursor !== inspection.boundary.authority_cursor;
  if (requiresCheckpoint) {
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
  }

  const ids = new Map<string, string>();
  for (const draft of drafts) {
    const { key, depends_on_keys: _, ...semantic } = draft;
    ids.set(key, syncFingerprint({
      action_scope: {
        replica_id: inspection.boundary.replica_id,
        scope_epoch: inspection.boundary.scope_epoch,
        generation: inspection.boundary.checkpoint.generation
      },
      key,
      ...semantic
    }, digest));
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
    if (action.command === "move_remote") {
      const receiptDependency = depends_on_keys.find(
        (dependency) => dependency === `${action.source.identity}:put-remote`
      );
      if (receiptDependency) action.revision_from_dependency = ids.get(receiptDependency);
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

/** Remote path occupancy is also policy. Acyclic moves depend on the action
 * that vacates their destination. Since v1 has no atomic remote staging
 * primitive, cycles are explicit path conflicts rather than executor retries. */
function orderRemotePathTransitions(
  initial: ActionDraft[],
  objects: readonly InspectedObject[]
): ActionDraft[] {
  if (!initial.some((draft) => draft.command === "move_remote")) return initial;
  let drafts = [...initial];
  const blocked = new Set<string>();
  for (const cycle of remoteMoveCycles(drafts)) {
    for (const key of cycle) {
      const draft = drafts.find((candidate) => candidate.key === key);
      if (draft?.command === "move_remote") blocked.add(draft.source.identity);
    }
  }
  const vacaters = remoteVacaters(drafts);
  const draftsByKey = new Map(drafts.map((draft) => [draft.key, draft]));
  let changed = true;
  while (changed) {
    changed = false;
    for (const draft of drafts) {
      if (draft.command !== "move_remote") continue;
      const owner = draft.expected_target_owner;
      if (owner.state !== "exact" || owner.object.identity === draft.source.identity) continue;
      const vacater = draftsByKey.get(vacaters.get(ownerKey(owner.object)) ?? "");
      const vacaterIdentity = vacater && remoteEffectIdentity(vacater);
      if ((!vacater || (vacaterIdentity && blocked.has(vacaterIdentity)))
        && !blocked.has(draft.source.identity)) {
        blocked.add(draft.source.identity);
        changed = true;
      }
    }
  }
  if (blocked.size > 0) {
    drafts = drafts.filter((draft) => {
      const identity = remoteEffectIdentity(draft);
      return !identity || !blocked.has(identity)
        || (draft.command !== "put_remote" && draft.command !== "move_remote");
    });
    const objectsByIdentity = new Map(objects.map((object) => [object.identity, object]));
    for (const identity of [...blocked].sort()) {
      const object = objectsByIdentity.get(identity);
      if (!object || object.entity === "resource") continue;
      drafts.push({
        key: `${identity}:conflict`,
        depends_on_keys: [],
        command: "record_conflict",
        reason: "local_change",
        identity,
        entity: object.entity,
        local: object.local,
        remote: object.remote,
        conflict_kind: "path_occupied"
      });
    }
  }
  const finalVacaters = remoteVacaters(drafts);
  for (const draft of drafts) {
    if (draft.command !== "move_remote") continue;
    const owner = draft.expected_target_owner;
    if (owner.state !== "exact" || owner.object.identity === draft.source.identity) continue;
    const dependency = finalVacaters.get(ownerKey(owner.object));
    if (!dependency || dependency === draft.key) continue;
    if (!draft.depends_on_keys.includes(dependency)) draft.depends_on_keys.push(dependency);
    draft.expected_target_owner = { state: "absent" };
  }
  return stableTopologicalOrder(drafts);
}

function remoteMoveCycles(drafts: readonly ActionDraft[]): string[][] {
  const moves = drafts.filter(
    (draft): draft is Extract<ActionDraft, { command: "move_remote" }> =>
      draft.command === "move_remote"
  );
  const byKey = new Map(moves.map((draft) => [draft.key, draft]));
  const vacaters = remoteVacaters(drafts);
  const cycles = new Map<string, string[]>();
  for (const start of moves) {
    const path: string[] = [];
    const indices = new Map<string, number>();
    let cursor: typeof start | undefined = start;
    while (cursor) {
      const prior = indices.get(cursor.key);
      if (prior !== undefined) {
        const cycle = path.slice(prior);
        cycles.set([...cycle].sort().join("\0"), cycle);
        break;
      }
      indices.set(cursor.key, path.length);
      path.push(cursor.key);
      const owner: ExpectedObjectState = cursor.expected_target_owner;
      cursor = owner.state === "exact"
        ? byKey.get(vacaters.get(ownerKey(owner.object)) ?? "")
        : undefined;
    }
  }
  return [...cycles.values()];
}

function remoteVacaters(drafts: readonly ActionDraft[]): Map<string, string> {
  const result = new Map<string, string>();
  for (const draft of drafts) {
    if (draft.command === "move_remote") result.set(ownerKey(draft.source), draft.key);
    else if (draft.command === "delete_remote") result.set(ownerKey(draft.target), draft.key);
  }
  return result;
}

function remoteEffectIdentity(draft: ActionDraft): string | undefined {
  if (draft.command === "move_remote") return draft.source.identity;
  if (draft.command === "put_remote" || draft.command === "delete_remote") {
    return draft.target.identity;
  }
  return undefined;
}

/**
 * Local path transitions are a graph, not independent per-object operations.
 * A destination must be vacated before it is used; a cycle is broken with one
 * deterministic staging move. The returned order is a stable topological
 * order, so an executor never has to discover an overwrite policy.
 */
function orderLocalPathTransitions(
  initial: ActionDraft[],
  objects: readonly InspectedObject[],
  digest: (value: string) => string
): ActionDraft[] {
  if (!initial.some((draft) =>
    draft.command === "move_local" || draft.command === "write_local"
  )) return initial;
  let drafts = [...initial];
  const occupiedPaths = new Set<string>();
  for (const object of objects) {
    if (object.base.state === "exact") occupiedPaths.add(object.base.object.path);
    if (object.local.state === "exact") occupiedPaths.add(object.local.object.path);
    if (object.remote.state === "exact") occupiedPaths.add(object.remote.object.path);
  }

  while (true) {
    const cycle = localMoveCycle(drafts);
    if (!cycle) break;
    const selectedKey = [...cycle].sort()[0]!;
    const selectedIndex = drafts.findIndex((draft) => draft.key === selectedKey);
    const selected = drafts[selectedIndex];
    if (!selected || selected.command !== "move_local") {
      throw new Error("Planner invariant: local path cycle contains a non-move action.");
    }
    const temporaryPath = stagingPath(selected.source, selected.target_path, occupiedPaths, digest);
    occupiedPaths.add(temporaryPath);
    const stagedSource = { ...selected.source, path: temporaryPath };
    const stage: ActionDraft = {
      key: `${selected.source.identity}:stage-local`,
      depends_on_keys: [...selected.depends_on_keys],
      command: "move_local",
      reason: selected.reason,
      source: selected.source,
      target_path: temporaryPath,
      expected_source_owner: selected.expected_source_owner,
      expected_target_owner: { state: "absent" }
    };
    selected.source = stagedSource;
    selected.expected_source_owner = { state: "exact", object: stagedSource };
    selected.depends_on_keys = [stage.key];
    drafts.splice(selectedIndex, 0, stage);
  }

  const vacaters = localVacaters(drafts);
  const objectsByIdentity = new Map(objects.map((object) => [object.identity, object]));
  const blocked = new Set<string>();
  const draftsByKey = new Map(drafts.map((draft) => [draft.key, draft]));
  let changed = true;
  while (changed) {
    changed = false;
    for (const draft of drafts) {
      const expected = localTargetOwner(draft);
      const subject = localTargetIdentity(draft);
      if (expected?.state !== "exact" || expected.object.identity === subject) continue;
      const vacater = draftsByKey.get(vacaters.get(ownerKey(expected.object)) ?? "");
      const vacaterIdentity = vacater && localTargetIdentity(vacater);
      if ((!vacater || (vacaterIdentity && blocked.has(vacaterIdentity)))
        && !blocked.has(subject)) {
        blocked.add(subject);
        changed = true;
      }
    }
  }
  if (blocked.size > 0) {
    drafts = drafts.filter((draft) =>
      !blocked.has(localTargetIdentity(draft))
      || (draft.command !== "move_local" && draft.command !== "write_local")
    );
    for (const identity of [...blocked].sort()) {
      const object = objectsByIdentity.get(identity);
      if (!object || object.entity === "resource") continue;
      drafts.push({
        key: `${identity}:conflict`,
        depends_on_keys: [],
        command: "record_conflict",
        reason: "remote_change",
        identity,
        entity: object.entity,
        local: object.local,
        remote: object.remote,
        conflict_kind: "path_occupied"
      });
    }
  }

  const finalVacaters = localVacaters(drafts);
  for (const draft of drafts) {
    const expected = localTargetOwner(draft);
    const subject = localTargetIdentity(draft);
    if (expected?.state !== "exact" || expected.object.identity === subject) continue;
    const dependency = finalVacaters.get(ownerKey(expected.object));
    if (!dependency || dependency === draft.key) continue;
    if (!draft.depends_on_keys.includes(dependency)) draft.depends_on_keys.push(dependency);
    setLocalTargetOwner(draft, { state: "absent" });
  }
  return stableTopologicalOrder(drafts);
}

function localMoveCycle(drafts: readonly ActionDraft[]): string[] | undefined {
  const moves = drafts.filter(
    (draft): draft is Extract<ActionDraft, { command: "move_local" }> =>
      draft.command === "move_local"
  );
  const byKey = new Map(moves.map((draft) => [draft.key, draft]));
  const vacaters = localVacaters(drafts);
  for (const start of moves) {
    const path: string[] = [];
    const indices = new Map<string, number>();
    let cursor: typeof start | undefined = start;
    while (cursor) {
      const prior = indices.get(cursor.key);
      if (prior !== undefined) return path.slice(prior);
      indices.set(cursor.key, path.length);
      path.push(cursor.key);
      const owner: ExpectedObjectState = cursor.expected_target_owner;
      cursor = owner.state === "exact"
        ? byKey.get(vacaters.get(ownerKey(owner.object)) ?? "")
        : undefined;
    }
  }
  return undefined;
}

function localVacaters(drafts: readonly ActionDraft[]): Map<string, string> {
  const result = new Map<string, string>();
  for (const draft of drafts) {
    if (draft.command === "move_local") {
      result.set(ownerKey(draft.source), draft.key);
    } else if (draft.command === "delete_local") {
      result.set(ownerKey(draft.target), draft.key);
    }
  }
  return result;
}

function localTargetOwner(draft: ActionDraft): ExpectedObjectState | undefined {
  if (draft.command === "move_local") return draft.expected_target_owner;
  if (draft.command === "write_local") return draft.expected_path_owner;
  return undefined;
}

function setLocalTargetOwner(draft: ActionDraft, owner: ExpectedObjectState): void {
  if (draft.command === "move_local") draft.expected_target_owner = owner;
  else if (draft.command === "write_local") draft.expected_path_owner = owner;
}

function localTargetIdentity(draft: ActionDraft): string {
  if (draft.command === "move_local") return draft.source.identity;
  if (draft.command === "write_local") return draft.target.identity;
  if (draft.command === "delete_local") return draft.target.identity;
  return "";
}

function ownerKey(object: SyncObjectRef): string {
  return `${object.entity}\0${object.identity}\0${object.path}`;
}

function stagingPath(
  source: SyncObjectRef,
  targetPath: string,
  occupied: ReadonlySet<string>,
  digest: (value: string) => string
): string {
  const slash = source.path.lastIndexOf("/");
  const directory = slash < 0 ? "" : source.path.slice(0, slash + 1);
  const basename = slash < 0 ? source.path : source.path.slice(slash + 1);
  const dot = basename.lastIndexOf(".");
  const extension = dot > 0 ? basename.slice(dot) : "";
  for (let attempt = 0; ; attempt += 1) {
    const hash = digest(`${source.entity}\0${source.identity}\0${source.path}\0${targetPath}\0${attempt}`);
    const candidate = `${directory}.mdbase-sync-stage-${hash.slice(0, 16)}${extension}`;
    if (!occupied.has(candidate)) return candidate;
  }
}

function stableTopologicalOrder(drafts: readonly ActionDraft[]): ActionDraft[] {
  const pending = [...drafts];
  const emitted = new Set<string>();
  const ordered: ActionDraft[] = [];
  while (pending.length > 0) {
    const index = pending.findIndex((draft) =>
      draft.depends_on_keys.every((dependency) => emitted.has(dependency))
    );
    if (index < 0) throw new Error("Planner invariant: action dependency graph contains a cycle.");
    const [draft] = pending.splice(index, 1);
    ordered.push(draft!);
    emitted.add(draft!.key);
  }
  return ordered;
}

function planObject(
  inspection: InspectionSummary,
  object: InspectedObject,
  drafts: ActionDraft[]
): void {
  if (object.frozen_conflict) {
    drafts.push(sameConflictContent(object.frozen_conflict.local, object.frozen_conflict.remote)
      ? {
          key: `${object.identity}:clear-conflict`,
          depends_on_keys: [],
          command: "clear_conflict",
          reason: "pending",
          identity: object.identity,
          entity: object.entity as "record" | "file",
          expected_local: object.frozen_conflict.local,
          expected_remote: object.frozen_conflict.remote
        } satisfies ActionDraft & Omit<ClearConflictAction, "action_id" | "depends_on">
      : {
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

function sameConflictContent(left: ExpectedObjectState, right: ExpectedObjectState): boolean {
  if (left.state === "absent" || right.state === "absent") return left.state === right.state;
  return left.object.entity === right.object.entity
    && left.object.identity === right.object.identity
    && left.object.path === right.object.path
    && left.object.payload_revision === right.object.payload_revision
    && left.object.size === right.object.size;
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
