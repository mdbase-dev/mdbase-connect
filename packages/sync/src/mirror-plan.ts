export type MirrorPlanEntity = "record" | "file" | "resource";
export type MirrorPlanDirection = "local_to_authority" | "authority_to_local";
export type MirrorPlanOperation = "put" | "move" | "delete";

/** A content-free, deterministic description of one reconciliation effect. */
export interface MirrorPlanAction {
  entity: MirrorPlanEntity;
  direction: MirrorPlanDirection;
  operation: MirrorPlanOperation;
  path: string;
  previous_path?: string;
  identity?: string;
  revision?: string;
  size?: number;
  reason: "initial" | "rebuild" | "local_change" | "remote_change" | "pending";
  outcome: "ready" | "conflict";
}

export interface MirrorPlanIssue {
  code: string;
  message: string;
  path?: string;
  blocking: boolean;
}

export interface MirrorSyncPlan {
  plan_version: 1;
  fingerprint: string;
  replica_id: string;
  mode: "read_only" | "read_write";
  kind: "initial" | "incremental" | "rebuild";
  base_cursor: number | null;
  authority_cursor: number;
  scope_epoch: number;
  actions: MirrorPlanAction[];
  issues: MirrorPlanIssue[];
  summary: {
    uploads: number;
    downloads: number;
    conflicts: number;
    blocking_issues: number;
  };
}

export interface MirrorApplyResult {
  status: "applied" | "attention" | "cancelled";
  plan_fingerprint: string;
  applied: number;
  pending: number;
  checkpoint_cursor: number | null;
  conflicts: number;
  issues: MirrorPlanIssue[];
}

export function mirrorApplyResult(
  status: MirrorApplyResult["status"],
  plan: MirrorSyncPlan,
  checkpoint: MirrorStatus,
  applied: number
): MirrorApplyResult {
  return {
    status,
    plan_fingerprint: plan.fingerprint,
    applied,
    pending: checkpoint.pending,
    checkpoint_cursor: checkpoint.cursor,
    conflicts: checkpoint.conflicts.length + checkpoint.file_conflicts.length,
    issues: plan.issues
  };
}

export function finalizeMirrorPlan(
  plan: Omit<MirrorSyncPlan, "fingerprint" | "summary">,
  digest: (value: string) => string
): MirrorSyncPlan {
  const actions = [...plan.actions].sort(compareAction);
  const issues = [...plan.issues].sort((left, right) =>
    `${left.path ?? ""}\0${left.code}\0${left.message}`
      .localeCompare(`${right.path ?? ""}\0${right.code}\0${right.message}`)
  );
  const summary = {
    uploads: actions.filter((action) => action.direction === "local_to_authority").length,
    downloads: actions.filter((action) => action.direction === "authority_to_local").length,
    conflicts: actions.filter((action) => action.outcome === "conflict").length,
    blocking_issues: issues.filter((issue) => issue.blocking).length
  };
  const stable = { ...plan, actions, issues, summary };
  return {
    ...stable,
    fingerprint: `sha256:${digest(JSON.stringify(stable))}`
  };
}

function compareAction(left: MirrorPlanAction, right: MirrorPlanAction): number {
  return [
    left.entity,
    left.path,
    left.direction,
    left.operation,
    left.previous_path ?? "",
    left.identity ?? "",
    left.revision ?? ""
  ].join("\0").localeCompare([
    right.entity,
    right.path,
    right.direction,
    right.operation,
    right.previous_path ?? "",
    right.identity ?? "",
    right.revision ?? ""
  ].join("\0"));
}
import type { MirrorStatus } from "./mirror-state.js";
