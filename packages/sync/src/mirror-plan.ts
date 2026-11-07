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
    conflicts: checkpoint.conflicts.length,
    issues: plan.issues,
    ...(failure ? { failure } : {})
  };
}

/** The longest `mdbase-mirror watch` waits between passes that make no progress. */
const MAX_WATCH_BACKOFF_MS = 5 * 60 * 1000;

/**
 * Paces `mdbase-mirror watch`. Each pass that fails without progress (a kept
 * batch blocked at the same action, or an error before any result) doubles
 * the wait, up to five minutes. Progress or a local change resets it.
 */
export class WatchBackoff {
  private failures = 0;
  private lastFailure: string | undefined;

  constructor(private readonly interval: number) {}

  /** Record one pass, `undefined` if it threw, and return the wait before the next. */
  next(result: MirrorApplyResult | undefined): number {
    if (result && result.status !== "failed") {
      this.reset();
      return this.interval;
    }
    const failure = result ? `${result.plan_fingerprint}:${result.applied}` : "error";
    this.failures = failure === this.lastFailure ? this.failures + 1 : 1;
    this.lastFailure = failure;
    return Math.min(
      this.interval * 2 ** Math.min(this.failures - 1, 20),
      Math.max(MAX_WATCH_BACKOFF_MS, this.interval)
    );
  }

  /** Forget past failures, and report whether the watch was backing off. */
  reset(): boolean {
    const backingOff = this.failures > 1;
    this.failures = 0;
    this.lastFailure = undefined;
    return backingOff;
  }
}
