import { SyncError } from "./sync-error.js";
import type { MirrorRuntime, MirrorState } from "./mirror-state.js";
import type { ReconciliationPlan } from "./sync-planner.js";
import type { SyncJournalStore } from "./sync-journal.js";
import { requireBatch } from "./sync-journal.js";

/** The sole production authority for publishing a completed checkpoint. */
export async function advanceSyncCheckpoint(
  state: MirrorState,
  runtime: MirrorRuntime,
  store: SyncJournalStore
): Promise<string> {
  const batch = requireBatch(state);
  if (batch.phase !== "effects_complete") {
    throw new SyncError(
      "invalid_mirror_state",
      "A checkpoint cannot advance before every prepared effect is durable."
    );
  }
  const action = batch.plan.actions[batch.next_action];
  if (!action || action.command !== "advance_checkpoint") {
    throw new SyncError("invalid_mirror_state", "Prepared checkpoint action is missing.");
  }
  if (
    action.expected.generation !== batch.checkpoint_before.generation
    || action.expected.cursor !== batch.checkpoint_before.cursor
    || action.next.generation !== batch.checkpoint_after.generation
    || action.next.cursor !== batch.checkpoint_after.cursor
  ) {
    throw new SyncError("invalid_mirror_state", "Prepared checkpoint boundary is inconsistent.");
  }
  const fingerprint = batch.plan.fingerprint;
  state.generation = action.next.generation;
  state.cursor = action.next.cursor ?? 0;
  state.last_completed_plan = fingerprint;
  state.last_synced_at = runtime.now();
  delete state.batch;
  await store.write(state);
  return fingerprint;
}

/** Publish a revalidated checkpoint when the plan contains no effects to journal. */
export async function advanceEmptySyncCheckpoint(
  state: MirrorState,
  plan: ReconciliationPlan,
  runtime: MirrorRuntime,
  store: SyncJournalStore
): Promise<string> {
  const [action] = plan.actions;
  if (
    plan.actions.length !== 1
    || !action
    || action.command !== "advance_checkpoint"
    || action.expected.generation !== (state.generation ?? 0)
    || action.expected.cursor !== state.cursor
    || action.next.generation !== (state.generation ?? 0) + 1
    || action.next.cursor !== plan.authority_cursor
    || state.batch !== undefined
  ) {
    throw new SyncError("invalid_mirror_state", "Empty checkpoint plan is inconsistent.");
  }
  state.generation = action.next.generation;
  state.cursor = action.next.cursor ?? 0;
  state.last_completed_plan = plan.fingerprint;
  state.last_synced_at = runtime.now();
  await store.write(state);
  return plan.fingerprint;
}
