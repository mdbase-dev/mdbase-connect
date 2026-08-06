import type { MirrorStatus } from "./mirror-state.js";
import type { InspectionIssue } from "./sync-inspection-model.js";
import type { SyncAction, SyncOutcomeStatus } from "./sync-model.js";
import type { ReconciliationPlan } from "./sync-planner.js";

export type MirrorPlanAction = SyncAction;
export type MirrorPlanIssue = InspectionIssue;
export type MirrorSyncPlan = ReconciliationPlan;

export interface MirrorApplyResult {
  status: SyncOutcomeStatus;
  plan_fingerprint: string;
  applied: number;
  pending: number;
  checkpoint_cursor: number | null;
  conflicts: number;
  issues: MirrorPlanIssue[];
  failure?: { code: string; message: string; action_id?: string };
}

export function mirrorApplyResult(
  status: MirrorApplyResult["status"],
  plan: MirrorSyncPlan,
  checkpoint: MirrorStatus,
  applied: number,
  failure?: MirrorApplyResult["failure"]
): MirrorApplyResult {
  return {
    status,
    plan_fingerprint: plan.fingerprint,
    applied,
    pending: checkpoint.pending,
    checkpoint_cursor: checkpoint.cursor,
    conflicts: checkpoint.conflicts.length + checkpoint.file_conflicts.length,
    issues: plan.issues,
    ...(failure ? { failure } : {})
  };
}
