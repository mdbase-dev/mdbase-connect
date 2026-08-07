import type { MirrorSyncPlan } from "./mirror-plan.js";
import type { MirrorState, MirrorStatus } from "./mirror-state.js";

export function mirrorStatusFromPlan(
  checkpoint: MirrorStatus,
  plan: MirrorSyncPlan
): MirrorStatus {
  if (["planned", "applying", "cancelled", "stale", "blocked", "failed"].includes(
    checkpoint.state
  )) return checkpoint;
  if (
    checkpoint.conflicts.length > 0
    || checkpoint.local_issues.length > 0
    || plan.summary.blocking_issues > 0
    || plan.summary.conflicts > 0
  ) return { ...checkpoint, state: "attention" };
  return {
    ...checkpoint,
    state: plan.actions.some((action) => action.command !== "advance_checkpoint")
      ? "changes_waiting"
      : "up_to_date"
  };
}

export function checkpointMirrorStatus(
  state: MirrorState | null,
  mode: "read_only" | "read_write"
): MirrorStatus {
  if (!state) {
    return {
      state: "not_initialized",
      mode,
      pending: 0,
      pending_files: 0,
      conflicts: [],
      local_issues: [],
      cursor: null,
      last_synced_at: null
    };
  }
  const conflicts: MirrorStatus["conflicts"] = [];
  for (const [identity, conflict] of Object.entries(state.planned_conflicts ?? {})) {
    const existing = conflicts.findIndex(({ entity, object_id }) =>
      entity === conflict.entity && object_id === identity
    );
    if (existing !== -1) conflicts.splice(existing, 1);
    const path = conflict.local.state === "exact"
      ? conflict.local.object.path
      : conflict.remote.state === "exact"
        ? conflict.remote.object.path
        : null;
    conflicts.push({
      entity: conflict.entity,
      object_id: identity,
      decision_id: conflict.decision_id ?? "",
      path,
      kind: conflict.conflict_kind === "rejected" ? "rejected" : "conflicted",
      message: conflict.conflict_kind === "rejected"
        ? "The authority rejected this local change."
        : "Local and authority changes need a decision."
    });
  }
  const localIssues: MirrorStatus["local_issues"] = [];
  const batchPending = state.batch
    ? state.batch.plan.actions.slice(state.batch.next_action)
      .filter((action) => action.command !== "advance_checkpoint").length
    : 0;
  const batchState: MirrorStatus["state"] | null = state.batch
    ? state.batch.phase === "prepared"
      ? "planned"
      : state.batch.phase === "applying" || state.batch.phase === "effects_complete"
        ? "applying"
        : state.batch.phase === "cancelled"
          ? "cancelled"
          : state.batch.failure?.code === "sync_plan_stale"
            ? "stale"
            : "blocked"
    : null;
  return {
    state: batchState ?? (conflicts.length
      ? "attention"
      : "up_to_date"),
    mode,
    pending: batchPending,
    pending_files: state.batch
      ? state.batch.plan.actions.slice(state.batch.next_action)
        .filter((action) => action.command !== "advance_checkpoint"
          && (("target" in action && action.target.entity === "file")
            || ("source" in action && action.source.entity === "file")
            || ("entity" in action && action.entity === "file"))).length
      : 0,
    conflicts,
    local_issues: localIssues,
    cursor: state.batch?.checkpoint_before.cursor ?? state.cursor,
    last_synced_at: state.last_synced_at ?? null,
    generation: state.generation ?? 0,
    pending_checkpoint: state.batch?.checkpoint_after.cursor ?? null,
    ...(state.batch ? { plan_fingerprint: state.batch.plan.fingerprint } : {}),
    ...(state.last_completed_plan ? { last_completed_plan: state.last_completed_plan } : {}),
    recovery_required: state.batch !== undefined,
    ...(state.batch?.failure ? { failure: state.batch.failure } : {})
  };
}
