import type { DatabaseConnection, DatabaseQueryable } from "../../database-types.js";
import { audit } from "../../platform/audit-events.js";
import { RequestValidationError } from "../../platform/http-errors.js";
import { InvitationMigrationPending, LAB_COMPLETION_EVENT, labCohortCompletionEvidence, requireCompletedNextAccountMigration } from "./migration-sharing.js";
import { isCurrentZeroHostedCohort, ZERO_HOSTED_ARCHIVE_SCHEMA } from "./migration-archive-profile.js";

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
 *
 * A cohort completes on an accepted archive for this revision. Only in
 * environment `lab`, a LAB-profile cohort with no acceptance completes instead
 * on its verified flips (labCohortCompletionEvidence), recorded by an audit
 * event that the completion readback requires. No other environment reaches it.
 */
export async function completeMigrationBatch(client: DatabaseQueryable, name: string, revision: string, frozenAt: Date, environment?: string): Promise<void> {
  const batch = (await client.query<{ frozen_at: Date | null; completed_at: Date | null }>(
    "SELECT frozen_at,completed_at FROM next_migration_cohorts WHERE name=$1 FOR UPDATE", [name]
  )).rows[0];
  if (!batch?.frozen_at || new Date(batch.frozen_at).getTime() !== new Date(frozenAt).getTime()) throw new Error("Migration completion freeze changed.");
  const archive = (await client.query<{ verified_result: { schema?: unknown } }>(
    "SELECT verified_result FROM next_migration_archive_acceptances WHERE cohort=$1 AND membership_revision=$2::bigint", [name, revision]
  )).rows[0];
  if (archive?.verified_result.schema === ZERO_HOSTED_ARCHIVE_SCHEMA && !await isCurrentZeroHostedCohort(client, name)) {
    throw new Error("Zero-hosted archive scope changed before completion.");
  }
  if (!batch.completed_at) {
    const accepted = archive !== undefined;
    if (!accepted && environment !== "lab") return;
    const unfinished = (await client.query(
      `SELECT 1 FROM next_migration_cohort_members m JOIN users u ON u.id=m.account_id
       LEFT JOIN next_migration_account_flips f ON f.account_id=m.account_id
       WHERE m.cohort=$1 AND m.terminal_excluded_at IS NULL
         AND (u.account_backend<>'next' OR f.account_id IS NULL) LIMIT 1`, [name]
    )).rows.length;
    if (unfinished) return;
    const lab = accepted ? null : await labCohortCompletionEvidence(client, name, revision);
    if (!accepted && !lab) return;
    await client.query("UPDATE next_migration_cohorts SET completed_at=now(),completed_revision=$2::bigint WHERE name=$1", [name, revision]);
    if (lab) await audit(client, null, LAB_COMPLETION_EVENT, name, { cohort: name, membership_revision: revision, ...lab });
  }
  // Completion remains durable when earlier erasures increment membership
  // revision. Late requests in this same freeze never need a future flip.
  await releaseDeferredDeletions(client, name, revision, frozenAt);
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
  await lockAccountsNotMigrationFrozen(client, [accountId, ...otherAccountIds], false);
}

/** Next authority may proceed after durable batch completion and this account's
 * actual flip. The legacy/archive freeze itself is never cleared or bypassed.
 * Returns whether the completed-migration exception was used. */
export async function requireNextAccountNotMigrationFrozen(client: DatabaseConnection, accountId: string, ...otherAccountIds: string[]): Promise<boolean> {
  return lockAccountsNotMigrationFrozen(client, [accountId, ...otherAccountIds], true);
}

/** Read-only UI projection of the SAME next-authority policy. Mutations must
 * acquire the ordered account/member/cohort locks through the guard above. */
export async function nextAccountsMigrationFrozen(db: DatabaseQueryable, accounts: readonly string[]): Promise<boolean> {
  const rows = (await db.query<{
    account_id: string; account_backend: string; started_at: Date | null; terminal_excluded_at: Date | null;
    completed_at: Date | null; completed_revision: string | null; flipped_at: Date | null;
  }>(
    `SELECT u.id::text AS account_id,u.account_backend,m.started_at,m.terminal_excluded_at,c.completed_at,c.completed_revision,f.flipped_at
     FROM next_migration_cohort_members m JOIN users u ON u.id=m.account_id
     JOIN next_migration_cohorts c ON c.name=m.cohort
     LEFT JOIN next_migration_account_flips f ON f.account_id=u.id
     WHERE m.account_id=ANY($1::uuid[]) AND c.frozen_at IS NOT NULL`, [accounts]
  )).rows;
  if (rows.some(row => row.account_backend !== "next" || row.started_at === null || row.terminal_excluded_at !== null
    || row.completed_at === null || row.completed_revision === null || row.flipped_at === null
    || new Date(row.flipped_at).getTime() < new Date(row.started_at).getTime()
    || new Date(row.flipped_at).getTime() > new Date(row.completed_at).getTime())) return true;
  for (const row of rows) {
    try { await requireCompletedNextAccountMigration(db, row.account_id); }
    catch (error) { if (error instanceof InvitationMigrationPending) return true; throw error; }
  }
  return false;
}

async function lockAccountsNotMigrationFrozen(client: DatabaseConnection, accountIds: readonly string[], nextAuthority: boolean): Promise<boolean> {
  const accounts = [...new Set(accountIds)].sort();
  try {
    await configureTopologyTransaction(client);
    await client.query("SELECT id FROM users WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE", [accounts]);
    const members = (await client.query<{ cohort: string }>(
      "SELECT cohort FROM next_migration_cohort_members WHERE account_id = ANY($1::uuid[]) ORDER BY account_id FOR SHARE", [accounts]
    )).rows;
    const names = [...new Set(members.map((m) => m.cohort))].sort();
    if (!names.length) return false;
    const cohorts = (await client.query<{ name: string; frozen_at: Date | null }>(
      "SELECT name, frozen_at FROM next_migration_cohorts WHERE name = ANY($1::text[]) ORDER BY name FOR UPDATE", [names]
    )).rows;
    if (cohorts.length !== names.length) throw new Error("Migration membership has no cohort.");
    const frozen = cohorts.some((c) => c.frozen_at !== null);
    if (frozen && (!nextAuthority || await nextAccountsMigrationFrozen(client, accounts))) throw new RequestValidationError("Migration topology is frozen.", {
      statusCode: 409, code: "migration_frozen"
    });
    return frozen;
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
