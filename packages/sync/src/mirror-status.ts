import type { MirrorSyncPlan } from "./mirror-plan.js";
import type { MirrorState, MirrorStatus } from "./mirror-state.js";

export function mirrorStatusFromPlan(
  checkpoint: MirrorStatus,
  plan: MirrorSyncPlan
): MirrorStatus {
  if (
    checkpoint.conflicts.length > 0
    || checkpoint.file_conflicts.length > 0
    || checkpoint.local_issues.length > 0
    || plan.summary.blocking_issues > 0
    || plan.summary.conflicts > 0
  ) return { ...checkpoint, state: "attention" };
  return {
    ...checkpoint,
    state: plan.actions.length > 0 ? "changes_waiting" : "up_to_date"
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
      file_conflicts: [],
      local_issues: [],
      cursor: null,
      last_synced_at: null
    };
  }
  const conflicts: MirrorStatus["conflicts"] = [];
  for (const [recordId, receipt] of Object.entries(state.conflicts ?? {})) {
    const entry = state.records[recordId];
    const pending = state.pending?.find((item) => item.mutation.record_id === recordId);
    if (receipt.status === "conflicted") {
      conflicts.push({
        record_id: recordId,
        path: pending?.local_path ?? entry?.path ?? receipt.conflict.current?.path ?? null,
        kind: "conflicted",
        message: "Local and remote changes need a decision."
      });
    } else if (receipt.status === "rejected") {
      conflicts.push({
        record_id: recordId,
        path: pending?.local_path ?? entry?.path ?? null,
        kind: "rejected",
        message: receipt.error.message
      });
    }
  }
  const localIssues = Object.values(state.local_issues ?? {})
    .map(({ path, code, message }) => ({ path, code, message }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const pending = state.pending?.length ?? 0;
  const pendingFiles = state.pending_files?.length ?? 0;
  const fileConflicts = Object.values(state.file_conflicts ?? {})
    .sort((left, right) => left.path.localeCompare(right.path));
  return {
    state: conflicts.length || fileConflicts.length || localIssues.length
      ? "attention"
      : pending || pendingFiles
        ? "changes_waiting"
        : "up_to_date",
    mode,
    pending: pending + pendingFiles,
    pending_files: pendingFiles,
    conflicts,
    file_conflicts: fileConflicts,
    local_issues: localIssues,
    cursor: state.cursor,
    last_synced_at: state.last_synced_at ?? null
  };
}
