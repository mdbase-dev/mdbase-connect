import type { SelectiveSyncPolicy } from "@mdbase-dev/connect-protocol";
import { SyncError } from "./sync-error.js";
import type {
  MirrorEntry,
  MirrorFileEntry,
  DurableSyncPayloads,
  DurableSyncReceipt,
  MirrorState
} from "./mirror-state.js";
import type { ReconciliationPlan } from "./sync-planner.js";
import type { SyncFailure } from "./sync-model.js";

export interface SyncJournalStore {
  write(state: MirrorState): Promise<void>;
  appendJournal?(event: SyncJournalEvent): Promise<void>;
}

interface ActionStateDelta {
  records?: Record<string, MirrorEntry | null>;
  resources?: Record<string, MirrorEntry | null>;
  files?: Record<string, MirrorFileEntry | null>;
  planned_conflicts?: Record<string, NonNullable<MirrorState["planned_conflicts"]>[string] | null>;
  local_bindings?: Record<string, NonNullable<MirrorState["local_bindings"]>[string] | null>;
}

export type SyncJournalEvent =
  | { type: "phase"; plan_fingerprint: string; phase: "applying" | "cancelled" | "blocked"; failure?: SyncFailure }
  | { type: "receipt"; plan_fingerprint: string; receipt: DurableSyncReceipt; delta: ActionStateDelta }
  | { type: "effects_complete"; plan_fingerprint: string };

export async function prepareSyncBatch(
  prior: MirrorState | null,
  plan: ReconciliationPlan,
  payloads: DurableSyncPayloads,
  store: SyncJournalStore
): Promise<MirrorState> {
  if (prior?.batch) {
    if (prior.batch.plan.fingerprint !== plan.fingerprint) {
      throw new SyncError(
        "mirror_recovery_required",
        "A different prepared sync batch must recover before this plan can apply."
      );
    }
    return prior;
  }
  const state = prior ? structuredClone(prior) : emptyState(
    plan.replica_id,
    plan.scope_epoch,
    plan.mode,
    plan.selective_sync
  );
  state.scope_epoch = plan.scope_epoch;
  state.selective_sync = plan.selective_sync;
  state.batch = {
    phase: "prepared",
    plan,
    next_action: 0,
    receipts: [],
    payloads,
    checkpoint_before: {
      generation: plan.checkpoint_generation,
      cursor: plan.base_cursor
    },
    checkpoint_after: {
      generation: plan.checkpoint_generation + 1,
      cursor: plan.authority_cursor
    }
  };
  await store.write(state);
  return state;
}

export async function beginApplying(
  state: MirrorState,
  store: SyncJournalStore
): Promise<void> {
  const batch = requireBatch(state);
  if (batch.phase === "effects_complete") return;
  batch.phase = "applying";
  delete batch.failure;
  await appendOrWrite(state, {
    type: "phase",
    plan_fingerprint: batch.plan.fingerprint,
    phase: "applying"
  }, store);
}

export async function recordActionReceipt(
  state: MirrorState,
  receipt: DurableSyncReceipt,
  store: SyncJournalStore
): Promise<void> {
  const batch = requireBatch(state);
  const action = batch.plan.actions[batch.next_action];
  if (!action || action.action_id !== receipt.action_id) {
    throw new SyncError(
      "invalid_mirror_state",
      "The durable sync receipt does not match the next prepared action."
    );
  }
  const event: SyncJournalEvent = {
    type: "receipt",
    plan_fingerprint: batch.plan.fingerprint,
    receipt: structuredClone(receipt),
    delta: captureActionDelta(state, action)
  };
  batch.receipts.push(structuredClone(receipt));
  batch.next_action += 1;
  await appendOrWrite(state, event, store);
}

export async function markEffectsComplete(
  state: MirrorState,
  store: SyncJournalStore
): Promise<void> {
  const batch = requireBatch(state);
  const next = batch.plan.actions[batch.next_action];
  if (!next || next.command !== "advance_checkpoint") {
    throw new SyncError(
      "invalid_mirror_state",
      "Sync effects cannot complete before the checkpoint action is next."
    );
  }
  batch.phase = "effects_complete";
  await appendOrWrite(state, {
    type: "effects_complete",
    plan_fingerprint: batch.plan.fingerprint
  }, store);
}

export async function markBatchInterrupted(
  state: MirrorState,
  phase: "cancelled" | "blocked",
  failure: SyncFailure,
  store: SyncJournalStore
): Promise<void> {
  const batch = requireBatch(state);
  batch.phase = phase;
  batch.failure = failure;
  await appendOrWrite(state, {
    type: "phase",
    plan_fingerprint: batch.plan.fingerprint,
    phase,
    failure
  }, store);
}

export function applySyncJournalEvent(state: MirrorState, event: SyncJournalEvent): void {
  const batch = state.batch;
  if (!batch || batch.plan.fingerprint !== event.plan_fingerprint) return;
  if (event.type === "phase") {
    batch.phase = event.phase;
    if (event.failure) batch.failure = structuredClone(event.failure);
    else delete batch.failure;
    return;
  }
  if (event.type === "effects_complete") {
    batch.phase = "effects_complete";
    return;
  }
  const action = batch.plan.actions[batch.next_action];
  if (!action) return;
  if (action.action_id !== event.receipt.action_id) {
    if (batch.receipts.some(({ action_id }) => action_id === event.receipt.action_id)) return;
    throw new SyncError("invalid_mirror_state", "Mirror journal receipts are out of order.");
  }
  applyDelta(state, event.delta);
  batch.receipts.push(structuredClone(event.receipt));
  batch.next_action += 1;
}

async function appendOrWrite(
  state: MirrorState,
  event: SyncJournalEvent,
  store: SyncJournalStore
): Promise<void> {
  if (store.appendJournal) await store.appendJournal(event);
  else await store.write(state);
}

function captureActionDelta(
  state: MirrorState,
  action: NonNullable<MirrorState["batch"]>["plan"]["actions"][number]
): ActionStateDelta {
  const identity = "identity" in action
    ? action.identity
    : "target" in action
      ? action.target.identity
      : "source" in action
        ? action.source.identity
        : null;
  if (identity === null) return {};
  const entity = "entity" in action
    ? action.entity
    : "target" in action
      ? action.target.entity
      : "source" in action
        ? action.source.entity
        : null;
  if (entity === null) return {};
  const delta: ActionStateDelta = {
    planned_conflicts: { [identity]: cloneEntry(state.planned_conflicts?.[identity]) },
    local_bindings: { [identity]: cloneEntry(state.local_bindings?.[identity]) }
  };
  if (entity === "record") delta.records = { [identity]: cloneEntry(state.records[identity]) };
  else if (entity === "resource") {
    delta.resources = { [identity]: cloneEntry(state.resources?.[identity]) };
  } else delta.files = { [identity]: cloneEntry(state.files?.[identity]) };
  return delta;
}

function cloneEntry<Value>(value: Value | undefined): Value | null {
  return value === undefined ? null : structuredClone(value);
}

function applyDelta(state: MirrorState, delta: ActionStateDelta): void {
  applyMapDelta(state.records, delta.records);
  state.resources ??= {};
  applyMapDelta(state.resources, delta.resources);
  state.files ??= {};
  applyMapDelta(state.files, delta.files);
  state.planned_conflicts ??= {};
  applyMapDelta(state.planned_conflicts, delta.planned_conflicts);
  state.local_bindings ??= {};
  applyMapDelta(state.local_bindings, delta.local_bindings);
}

function applyMapDelta<Value>(
  target: Record<string, Value>,
  delta: Record<string, Value | null> | undefined
): void {
  for (const [key, value] of Object.entries(delta ?? {})) {
    if (value === null) delete target[key];
    else target[key] = structuredClone(value);
  }
}

export function requireBatch(state: MirrorState): NonNullable<MirrorState["batch"]> {
  if (!state.batch) {
    throw new SyncError("invalid_mirror_state", "The mirror has no prepared sync batch.");
  }
  return state.batch;
}

/**
 * A stale batch can be abandoned only at a journal boundary: every earlier
 * effect has a durable receipt and no action is in flight. The old cursor is
 * retained so the next inspection observes all remote consequences again.
 */
export async function abandonStaleBatch(
  state: MirrorState,
  store: SyncJournalStore
): Promise<void> {
  const batch = requireBatch(state);
  if (batch.phase !== "blocked" || batch.failure?.code !== "sync_plan_stale") {
    throw new SyncError(
      "mirror_recovery_required",
      "Only a stale batch at a durable action boundary can be abandoned."
    );
  }
  delete state.batch;
  await store.write(state);
}

function emptyState(
  replicaId: string,
  scopeEpoch: number,
  mode: "read_only" | "read_write",
  selectiveSync: SelectiveSyncPolicy
): MirrorState {
  return {
    protocol_version: 1,
    engine_version: 3,
    generation: 0,
    replica_id: replicaId,
    scope_epoch: scopeEpoch,
    cursor: 0,
    records: {},
    resources: {},
    files: {},
    selective_sync: selectiveSync,
    mode,
    planned_conflicts: {}
  };
}
