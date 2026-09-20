import { randomUUID } from "node:crypto";
import type { DatabaseConnection, DatabasePool } from "./db.js";
import { effectiveEntitlement, reconcileHostedAccountCollections } from "./entitlements.js";
import {
  HostedProviderResponseError,
  type HostedAccountUsage,
  type HostedProviderClient
} from "./hosted-provider.js";
import { quarantineMissingHostedCollection } from "./hosted-capability-lifecycle.js";
import {
  InstanceAdminConflictError,
  type OperatorMutation
} from "./instance-admin.js";

export async function inspectAccountEntitlements(
  db: DatabasePool,
  provider: HostedProviderClient | undefined,
  user: { id: string; email: string | null; name: string }
): Promise<unknown> {
  const entitlement = await effectiveEntitlement(db, user.id);
  const storage = await db.query(
    `SELECT provider_account_id, entitlement_revision, provider_revision,
            created_at, updated_at
     FROM account_storage_accounts WHERE user_id = $1`,
    [user.id]
  );
  const grants = await db.query(
    `SELECT profile_code, source, source_reference, starts_at, ends_at,
            revoked_at, created_at
     FROM account_entitlement_grants WHERE user_id = $1
     ORDER BY created_at, id`,
    [user.id]
  );
  let providerUsage: HostedAccountUsage | null = null;
  if (provider && storage.rows[0]) {
    try {
      providerUsage = await provider.accountUsage(storage.rows[0].provider_account_id);
    } catch (error) {
      // Signup commits the control-plane account before the first hosted
      // operation provisions it at the provider. Keep that state inspectable,
      // but do not hide a missing previously reconciled account or an outage.
      if (!(error instanceof HostedProviderResponseError
        && error.status === 404
        && error.code === "hosted_account_not_found"
        && Number(storage.rows[0].provider_revision) === 0)) {
        throw error;
      }
    }
  }
  return {
    user: { id: user.id, email: user.email, name: user.name },
    effective: entitlement,
    storage_account: storage.rows[0] ?? null,
    provider_usage: providerUsage,
    grants: grants.rows
  };
}

interface ActiveHostedReconciliationOutput {
  operation_id: string;
  scope: "active_hosted";
  reconciled_accounts: number;
  hosted_collections: number;
  reconciled_collections: number;
  users_inspected: number;
}

interface ActiveHostedReconciliationState {
  state: "running";
  selected_user_ids: string[];
  completed_user_ids: string[];
  hosted_collections: number;
  reconciled_collections: number;
  users_inspected: number;
}

interface StoredOperatorOperation {
  action: string;
  target_type: string;
  target_id: string;
  actor: string;
  reason: string;
  result: unknown;
}

const ACTIVE_HOSTED_RECONCILIATION_LOCK = [1835295329, 1936028278] as const;

export async function reconcileActiveHostedEntitlements(
  db: DatabasePool,
  provider: HostedProviderClient,
  mutation: OperatorMutation
): Promise<ActiveHostedReconciliationOutput> {
  const connection = await db.connect();
  let locked = false;
  try {
    const lock = await connection.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock($1, $2) AS acquired",
      [...ACTIVE_HOSTED_RECONCILIATION_LOCK]
    );
    locked = lock.rows[0]?.acquired === true;
    if (!locked) {
      throw new InstanceAdminConflictError(
        "Another active-hosted entitlement reconciliation is already running."
      );
    }

    const stored = await connection.query<StoredOperatorOperation>(
      `SELECT action, target_type, target_id, actor, reason, result
       FROM operator_operations WHERE operation_id = $1`,
      [mutation.operationId]
    );
    const existing = stored.rows[0];
    if (existing) {
      assertOperation(existing, mutation);
      if (isOutput(existing.result, mutation.operationId)) return existing.result;
    }

    let state = existing
      ? runningState(existing.result)
      : await createOperation(connection, mutation);

    for (const userId of state.selected_user_ids) {
      if (state.completed_user_ids.includes(userId)) continue;
      const reconciled = await reconcileHostedAccountCollections(
        connection,
        provider,
        userId,
        {
          onMissingCollection: async (collectionId) => {
            await quarantineMissingHostedCollection(db, collectionId);
          }
        }
      );
      state = await completeAccount(
        connection,
        mutation,
        state,
        userId,
        reconciled.entitlementRevision,
        reconciled.reconciledCollections
      );
    }

    const output: ActiveHostedReconciliationOutput = {
      operation_id: mutation.operationId,
      scope: "active_hosted",
      reconciled_accounts: state.completed_user_ids.length,
      hosted_collections: state.hosted_collections,
      reconciled_collections: state.reconciled_collections,
      users_inspected: state.users_inspected
    };
    await connection.query(
      `UPDATE operator_operations SET result = $2::jsonb
       WHERE operation_id = $1`,
      [mutation.operationId, JSON.stringify(output)]
    );
    return output;
  } finally {
    if (locked) {
      await connection.query(
        "SELECT pg_advisory_unlock($1, $2)",
        [...ACTIVE_HOSTED_RECONCILIATION_LOCK]
      ).catch(() => undefined);
    }
    connection.release();
  }
}

async function createOperation(
  connection: DatabaseConnection,
  mutation: OperatorMutation
): Promise<ActiveHostedReconciliationState> {
  const users = await connection.query<{
    id: string;
    hosted_collections: string | number;
  }>(
    `SELECT u.id, count(c.id) AS hosted_collections
     FROM users u
     JOIN hosted_collections c ON c.user_id = u.id
     WHERE u.suspended_at IS NULL AND c.quarantined_at IS NULL
     GROUP BY u.id
     ORDER BY u.id`
  );
  const inspected = await connection.query<{ count: string | number }>(
    "SELECT count(*) AS count FROM users"
  );
  const state: ActiveHostedReconciliationState = {
    state: "running",
    selected_user_ids: users.rows.map((row) => row.id),
    completed_user_ids: [],
    hosted_collections: users.rows.reduce(
      (sum, row) => sum + Number(row.hosted_collections),
      0
    ),
    reconciled_collections: 0,
    users_inspected: Number(inspected.rows[0]?.count ?? 0)
  };
  await connection.query(
    `INSERT INTO operator_operations
       (operation_id, action, target_type, target_id, actor, reason, result)
     VALUES ($1, 'entitlements.reconcile.active-hosted',
       'entitlement_scope', 'active-hosted', $2, $3, $4::jsonb)`,
    [mutation.operationId, mutation.actor, mutation.reason, JSON.stringify(state)]
  );
  return state;
}

async function completeAccount(
  connection: DatabaseConnection,
  mutation: OperatorMutation,
  state: ActiveHostedReconciliationState,
  userId: string,
  entitlementRevision: number,
  reconciledCollections: number
): Promise<ActiveHostedReconciliationState> {
  const next: ActiveHostedReconciliationState = {
    ...state,
    completed_user_ids: [...state.completed_user_ids, userId],
    reconciled_collections: state.reconciled_collections + reconciledCollections
  };
  await connection.query("BEGIN");
  try {
    await connection.query(
      `INSERT INTO audit_events
         (id, user_id, event_type, subject_id, metadata)
       VALUES ($1, $2, 'entitlement.reconciled', $4, $3::jsonb)`,
      [
        randomUUID(),
        userId,
        JSON.stringify({
          actor: mutation.actor,
          reason: mutation.reason,
          operation_id: mutation.operationId,
          entitlement_revision: entitlementRevision,
          reconciled_collections: reconciledCollections
        }),
        userId
      ]
    );
    await connection.query(
      `UPDATE operator_operations SET result = $2::jsonb
       WHERE operation_id = $1`,
      [mutation.operationId, JSON.stringify(next)]
    );
    await connection.query("COMMIT");
    return next;
  } catch (error) {
    await connection.query("ROLLBACK");
    throw error;
  }
}

function assertOperation(
  stored: StoredOperatorOperation,
  mutation: OperatorMutation
): void {
  if (
    stored.action !== "entitlements.reconcile.active-hosted"
    || stored.target_type !== "entitlement_scope"
    || stored.target_id !== "active-hosted"
    || stored.actor !== mutation.actor
    || stored.reason !== mutation.reason
  ) {
    throw new InstanceAdminConflictError(
      "Operation ID was already used for a different request."
    );
  }
}

function runningState(value: unknown): ActiveHostedReconciliationState {
  const candidate = value as Partial<ActiveHostedReconciliationState> | null;
  if (
    !candidate
    || typeof candidate !== "object"
    || candidate.state !== "running"
    || !stringArray(candidate.selected_user_ids)
    || !stringArray(candidate.completed_user_ids)
    || new Set(candidate.selected_user_ids).size !== candidate.selected_user_ids.length
    || new Set(candidate.completed_user_ids).size !== candidate.completed_user_ids.length
    || candidate.completed_user_ids.some(
      (userId) => !candidate.selected_user_ids!.includes(userId)
    )
    || !nonNegativeInteger(candidate.hosted_collections)
    || !nonNegativeInteger(candidate.reconciled_collections)
    || !nonNegativeInteger(candidate.users_inspected)
  ) {
    throw new Error("Stored active-hosted reconciliation state is invalid.");
  }
  return candidate as ActiveHostedReconciliationState;
}

function isOutput(
  value: unknown,
  operationId: string
): value is ActiveHostedReconciliationOutput {
  const candidate = value as Partial<ActiveHostedReconciliationOutput> | null;
  return Boolean(
    candidate
    && typeof candidate === "object"
    && candidate.operation_id === operationId
    && candidate.scope === "active_hosted"
    && nonNegativeInteger(candidate.reconciled_accounts)
    && nonNegativeInteger(candidate.hosted_collections)
    && nonNegativeInteger(candidate.reconciled_collections)
    && nonNegativeInteger(candidate.users_inspected)
  );
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}
