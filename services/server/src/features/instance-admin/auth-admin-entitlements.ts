import type { DatabasePool } from "../../db.js";
import {
  effectiveEntitlement,
  FREE_ENTITLEMENT_PROFILE,
  grantOperatorEntitlement
} from "../account/entitlements.js";

export async function inspectAccountEntitlements(
  db: DatabasePool,
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
  return {
    user: { id: user.id, email: user.email, name: user.name },
    effective: entitlement,
    storage_account: storage.rows[0] ?? null,
    provider_usage: null,
    grants: grants.rows
  };
}

/**
 * Grant the free plan to active accounts that never held it, at most `limit` per run.
 * Each grant goes through `grantOperatorEntitlement`, which is idempotent, creates the
 * storage account and records an audit event. Run it until `remaining` is 0.
 */
export async function backfillFreeEntitlement(
  db: DatabasePool,
  input: { operationId: string; actor: string; reason: string; limit: string | undefined }
): Promise<{ operation_id: string; granted: number; remaining: number }> {
  const limit = input.limit === undefined ? 500 : Number(input.limit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 5000) throw new RangeError("--limit must be between 1 and 5000.");
  // Only accounts that never held the profile, in any state: an operator's revocation
  // or an expiry is never undone by a rerun, and each account is granted at most once,
  // so reruns with one operation ID terminate. Suspended accounts are skipped.
  const missing = `FROM users WHERE users.suspended_at IS NULL AND NOT EXISTS (
       SELECT 1 FROM account_entitlement_grants entitlement_grant
       WHERE entitlement_grant.user_id = users.id
         AND entitlement_grant.profile_code = $1)`;
  const batch = await db.query<{ id: string }>(
    `SELECT id ${missing} ORDER BY id LIMIT $2`,
    [FREE_ENTITLEMENT_PROFILE, limit]
  );
  for (const user of batch.rows) {
    await grantOperatorEntitlement(db, {
      userId: user.id,
      profileCode: FREE_ENTITLEMENT_PROFILE,
      operationId: `${input.operationId}:free:${user.id}`,
      actor: input.actor,
      reason: input.reason
    });
  }
  const left = await db.query<{ count: string }>(`SELECT count(*) AS count ${missing}`, [FREE_ENTITLEMENT_PROFILE]);
  return { operation_id: input.operationId, granted: batch.rows.length, remaining: Number(left.rows[0]?.count ?? 0) };
}
