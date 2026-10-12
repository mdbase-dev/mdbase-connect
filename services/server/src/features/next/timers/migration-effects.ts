import type { DatabaseQueryable } from "../../../database-types.js";
import { InvitationMigrationPending, requireCompletedAccountMigration } from "../migration-sharing.js";

/** Called in the mutation's original transaction, before policy/timer locks.
 * Origin classifies only: original grant/registries bind the collection to its
 * OWNER, not its member. Original ledger participation survives timer pruning
 * and generation changes; an orphan event cannot silently become ordinary.
 */
export async function requireTimerMigrationEffects(db: DatabaseQueryable, grantId: string): Promise<void> {
  const imported = (await db.query(
    "SELECT 1 FROM next_timers WHERE grant_id=$1 AND legacy_import_origin IS NOT NULL LIMIT 1", [grantId]
  )).rows.length > 0;
  const facts = (await db.query<{
    collection: string | null; owner: string | null; registry_owner: string | null;
  }>(
    `SELECT h.id::text AS collection,h.user_id::text AS owner,n.owner_user_id::text AS registry_owner
     FROM grants g LEFT JOIN hosted_collections h ON h.id=g.hosted_collection_id
     LEFT JOIN next_collections n ON n.collection_id=h.id WHERE g.id=$1`, [grantId]
  )).rows[0];
  if (!facts) {
    // Native installation grants are a distinct authority, never a fallback
    // for an imported legacy grant whose original binding is unavailable.
    if (imported || !(await db.query("SELECT id FROM next_background_grants WHERE id=$1", [grantId])).rows.length) {
      throw new InvitationMigrationPending();
    }
    return;
  }
  if (!facts.collection || !facts.owner) {
    if (imported) throw new InvitationMigrationPending();
    return;
  }
  const participation = await db.query(
    `SELECT 1 FROM next_migration_cohort_members WHERE account_id=$1
     UNION SELECT 1 FROM next_migration_account_flips WHERE account_id=$1
     UNION SELECT 1 FROM next_migration_collections WHERE collection_id=$2 AND account_id=$1
     LIMIT 1`, [facts.owner, facts.collection]
  );
  if (!imported && participation.rows.length === 0) return;
  if (facts.registry_owner !== facts.owner) throw new InvitationMigrationPending();
  await requireCompletedAccountMigration(db, facts.collection, facts.owner);
}
