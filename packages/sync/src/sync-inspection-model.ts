import type { SelectiveSyncPolicy } from "@mdbase-dev/connect-protocol";
import type {
  ExpectedObjectState,
  SyncObjectRef,
  SyncPlanBoundary
} from "./sync-model.js";

export interface InspectionIssue {
  code: string;
  message: string;
  path?: string;
  blocking: boolean;
}

/**
 * One immutable three-way fact set. Payload bytes live in the separate private
 * payload set and are referenced here only by exact revision.
 */
export interface InspectedObject {
  entity: SyncObjectRef["entity"];
  identity: string;
  base: ExpectedObjectState;
  local: ExpectedObjectState;
  remote: ExpectedObjectState;
  local_target_owner: ExpectedObjectState;
  remote_target_owner: ExpectedObjectState;
  /** Durable operator gate. The planner must not reconcile through this object. */
  frozen_conflict?: {
    local: ExpectedObjectState;
    remote: ExpectedObjectState;
    conflict_kind: "both_changed" | "delete_vs_change" | "path_occupied" | "rejected";
  };
}

export interface InspectionSummary {
  boundary: SyncPlanBoundary;
  mode: "read_only" | "read_write";
  kind: "initial" | "incremental" | "rebuild";
  selective_sync: SelectiveSyncPolicy;
  objects: InspectedObject[];
  issues: InspectionIssue[];
}

export interface ObservedObject {
  object: SyncObjectRef;
  /** Local untracked objects deliberately have no stable identity yet. */
  stable_identity: boolean;
}

export interface ObjectUniverse {
  base: SyncObjectRef[];
  local: ObservedObject[];
  remote: SyncObjectRef[];
}
