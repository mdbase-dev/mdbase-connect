import type { DatabaseConnection, DatabaseQueryable } from "../../database-types.js";
import { RequestValidationError } from "../../platform/http-errors.js";

/** Read-only legacy-missing classification; freeze permission is a separate
 * locked check below. Kept here so cleanup never depends on rollout commands.
 */
export async function accountMigrating(db: DatabaseQueryable, account: string): Promise<boolean> {
  const row = (await db.query<{ migrating: boolean }>(
    `SELECT u.account_backend = 'next' OR m.started_at IS NOT NULL AS migrating
     FROM users u LEFT JOIN next_migration_cohort_members m ON m.account_id = u.id WHERE u.id = $1`, [account]
  )).rows[0];
  return Boolean(row?.migrating);
}

/** Local to this transaction: provider operations are bounded at 14s (requests
 * at 15s). Guarded idle18s < existing HTTP request35s. Allow bounded
 * awaits/compensation without the pool's 10s idle expiry;
 * repeated provider loops must query this same client between operations.
 * Lock/statement/query timeouts and the pool defaults remain unchanged.
 */
export async function configureTopologyTransaction(client: DatabaseQueryable): Promise<void> {
  await client.query("SET LOCAL lock_timeout = '5s'");
  await client.query("SET LOCAL idle_in_transaction_session_timeout = '18s'");
}

/** Caller holds the cohort FOR UPDATE; commit readiness before erasure cascades. */
export async function releaseDeferredDeletions(client: DatabaseQueryable, name: string, revision: string, frozenAt: Date): Promise<void> {
  await client.query(
    `UPDATE next_migration_deferred_account_deletions SET ready_at=now(),ready_revision=$2::bigint
     WHERE cohort=$1 AND ready_at IS NULL AND membership_revision<=$2::bigint AND frozen_at=$3`, [name, revision, frozenAt]
  );
}

/** Under the same parent lock as acceptance/flip: exclusion is terminal work,
 * never a migration or archive-membership edit. Pre-acceptance cancellation
 * still requires audited unfreeze; no incomplete capture is discarded here.
 */
export async function completeMigrationBatch(client: DatabaseQueryable, name: string, revision: string, frozenAt: Date): Promise<void> {
  if (!(await client.query(
    "SELECT 1 FROM next_migration_archive_acceptances WHERE cohort=$1 AND membership_revision=$2::bigint", [name, revision]
  )).rows.length) return;
  const unfinished = (await client.query(
    `SELECT 1 FROM next_migration_cohort_members m JOIN users u ON u.id=m.account_id
     LEFT JOIN next_migration_account_flips f ON f.account_id=m.account_id
     WHERE m.cohort=$1 AND m.terminal_excluded_at IS NULL
       AND (u.account_backend<>'next' OR f.account_id IS NULL) LIMIT 1`, [name]
  )).rows.length;
  if (!unfinished) await releaseDeferredDeletions(client, name, revision, frozenAt);
}

/**
 * Call on the mutation's actual transaction client BEFORE provider effects,
 * publication or long awaits; retain the transaction through effects/commit.
 * Supply BOTH actual transfer owners together, not merely the requesting member.
 * User/current-member locks serialize assignment/moves, including absent
 * membership (assignment locks the user FOR UPDATE). Cohorts lock in name order.
 * FOR UPDATE up front avoids a SHARE->UPDATE upgrade when 0062's revision
 * triggers update the same parent AFTER effects. Inspect state AFTER locking;
 * a frozen-state WHERE predicate would incorrectly treat refusal as absence.
 */
export async function requireAccountNotMigrationFrozen(client: DatabaseConnection, accountId: string, ...otherAccountIds: string[]): Promise<void> {
  const accounts = [...new Set([accountId, ...otherAccountIds])].sort();
  try {
    await configureTopologyTransaction(client);
    await client.query("SELECT id FROM users WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE", [accounts]);
    const members = (await client.query<{ cohort: string }>(
      "SELECT cohort FROM next_migration_cohort_members WHERE account_id = ANY($1::uuid[]) ORDER BY account_id FOR SHARE", [accounts]
    )).rows;
    const names = [...new Set(members.map((m) => m.cohort))].sort();
    if (!names.length) return;
    const cohorts = (await client.query<{ name: string; frozen_at: Date | null }>(
      "SELECT name, frozen_at FROM next_migration_cohorts WHERE name = ANY($1::text[]) ORDER BY name FOR UPDATE", [names]
    )).rows;
    if (cohorts.length !== names.length) throw new Error("Migration membership has no cohort.");
    if (cohorts.some((c) => c.frozen_at !== null)) throw new RequestValidationError("Migration topology is frozen.", {
      statusCode: 409, code: "migration_frozen"
    });
  } catch (error) {
    if (["55P03", "40P01", "40001", "57014"].includes(String((error as { code?: string } | null)?.code))) {
      throw new RequestValidationError("Busy; retry.", { statusCode: 409, code: "busy" });
    }
    throw error;
  }
}

/** Resolve actual ownership before child locks, then validate it after locking.
 * The optional accounts are actual source/destination owners, never a substitute
 * for the hosted owner. A missing collection grants no provider authority.
 */
export async function requireHostedCollectionNotMigrationFrozen(
  client: DatabaseConnection, collectionId: string, ...otherOwnerIds: string[]
): Promise<string | null> {
  const owner = (await client.query<{ user_id: string }>(
    "SELECT user_id FROM hosted_collections WHERE id = $1", [collectionId]
  )).rows[0];
  if (!owner) return null;
  await requireAccountNotMigrationFrozen(client, owner.user_id, ...otherOwnerIds);
  const held = (await client.query<{ user_id: string }>(
    "SELECT user_id FROM hosted_collections WHERE id = $1 FOR UPDATE", [collectionId]
  )).rows[0];
  if (!held || held.user_id !== owner.user_id) throw new RequestValidationError("Busy; retry.", { statusCode: 409, code: "busy" });
  return held.user_id;
}
