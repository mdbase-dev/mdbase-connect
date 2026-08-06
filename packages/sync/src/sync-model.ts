export const MIRROR_ENGINE_PROFILE = "exact_document_plan_only_v1" as const;
export const MIRROR_PLANNER_POLICY = "three_way_exact_document_v1" as const;
export const MIRROR_PROJECTION_POLICY = "portable_mirror_projection_v1" as const;

export type SyncObjectKind = "record" | "resource" | "file";
export type SyncPlanReason = "initial" | "rebuild" | "local_change" | "remote_change" | "pending";

export interface SyncObjectRef {
  entity: SyncObjectKind;
  identity: string;
  path: string;
  revision: string;
  /** Exact bytes capability: document revision for text, content digest for files. */
  payload_revision: string;
  size?: number;
}

/** Absence is an explicit compare-and-swap state, never a missing check. */
export type ExpectedObjectState =
  | { state: "absent" }
  | { state: "exact"; object: SyncObjectRef };

export interface SyncCheckpoint {
  generation: number;
  cursor: number | null;
}

export interface SyncPlanBoundary {
  engine_profile: typeof MIRROR_ENGINE_PROFILE;
  protocol_profile: "exact_document_v1";
  planner_policy: typeof MIRROR_PLANNER_POLICY;
  projection_policy: typeof MIRROR_PROJECTION_POLICY;
  replica_id: string;
  scope_epoch: number;
  authority_cursor: number;
  checkpoint: SyncCheckpoint;
  selective_sync_fingerprint: string;
}

interface SyncActionBase {
  action_id: string;
  depends_on: string[];
  reason: SyncPlanReason;
}

export interface WriteLocalAction extends SyncActionBase {
  command: "write_local";
  target: SyncObjectRef;
  payload_revision: string;
  expected_local: ExpectedObjectState;
  expected_path_owner: ExpectedObjectState;
}

export interface DeleteLocalAction extends SyncActionBase {
  command: "delete_local";
  target: SyncObjectRef;
  expected_local: ExpectedObjectState;
  expected_path_owner: ExpectedObjectState;
}

export interface MoveLocalAction extends SyncActionBase {
  command: "move_local";
  source: SyncObjectRef;
  target_path: string;
  expected_source_owner: ExpectedObjectState;
  expected_target_owner: ExpectedObjectState;
}

export interface PutRemoteAction extends SyncActionBase {
  command: "put_remote";
  target: SyncObjectRef;
  payload_revision: string;
  expected_remote: ExpectedObjectState;
  expected_local: ExpectedObjectState;
  idempotency_key: string;
}

export interface DeleteRemoteAction extends SyncActionBase {
  command: "delete_remote";
  target: SyncObjectRef;
  expected_remote: ExpectedObjectState;
  expected_local: ExpectedObjectState;
  idempotency_key: string;
}

export interface MoveRemoteAction extends SyncActionBase {
  command: "move_remote";
  source: SyncObjectRef;
  target_path: string;
  expected_source_owner: ExpectedObjectState;
  expected_target_owner: ExpectedObjectState;
  expected_local: ExpectedObjectState;
  /** Opaque authority revisions produced by a prior command are receipt-bound. */
  revision_from_dependency?: string;
  idempotency_key: string;
}

export interface RecordConflictAction extends SyncActionBase {
  command: "record_conflict";
  identity: string;
  entity: "record" | "file";
  local: ExpectedObjectState;
  remote: ExpectedObjectState;
  conflict_kind:
    | "both_changed"
    | "delete_vs_change"
    | "path_occupied"
    | "rejected";
}

export interface AdvanceCheckpointAction extends SyncActionBase {
  command: "advance_checkpoint";
  expected: SyncCheckpoint;
  next: SyncCheckpoint;
}

export type SyncAction =
  | WriteLocalAction
  | DeleteLocalAction
  | MoveLocalAction
  | PutRemoteAction
  | DeleteRemoteAction
  | MoveRemoteAction
  | RecordConflictAction
  | AdvanceCheckpointAction;

export type SyncBatchPhase =
  | "prepared"
  | "applying"
  | "effects_complete"
  | "cancelled"
  | "blocked";

export interface SyncFailure {
  code: string;
  message: string;
  action_id?: string;
  precondition?: string;
}

export type SyncOutcomeStatus =
  | "applied"
  | "attention"
  | "cancelled"
  | "stale"
  | "blocked"
  | "failed";

export function isEffectAction(
  action: SyncAction
): action is Exclude<SyncAction, AdvanceCheckpointAction | RecordConflictAction> {
  return action.command !== "advance_checkpoint" && action.command !== "record_conflict";
}
