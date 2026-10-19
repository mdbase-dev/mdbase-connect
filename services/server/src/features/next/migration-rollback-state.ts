// Whether a started account's upgrade was rolled back, for user-facing copy only.
//
// A receipted pre-cutover rollback (migration-replicas.ts) unfences the legacy
// source, but the account keeps its start claim (`started_at`): an operator
// restart reuses that claim, the native MayFence check requires `started`, and a
// replayed rollback-receipt read must still find the same claim. Clearing it
// would break all three, so the claim is never reset here.
//
// Instead this derives the state from the audited migration steps. For each of
// the account's current hosted collections that has not cut over, the latest
// provider step decides: a recorded rollback or unfence that no later fence has
// superseded means that collection is back on legacy Connect and nothing is
// migrating it. One such collection is enough: the account cannot finish its
// upgrade until that collection is migrated again.
//
// Never authority: no migration route reads this.
import type { DatabaseQueryable } from "../../database-types.js";

const ROLLED_BACK_EVENTS = ["next_migration.rollback", "next_migration.unfence"] as const;
const FENCE_EVENT = "next_migration.fence";

export async function accountUpgradeRolledBack(db: DatabaseQueryable, account: string): Promise<boolean> {
  const row = (await db.query<{ rolled_back: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM hosted_collections h
       WHERE h.user_id = $1 AND h.authority_state <> 'transferred'
         AND NOT EXISTS (SELECT 1 FROM next_migration_collections c WHERE c.collection_id = h.id)
         AND (SELECT a.event_type FROM audit_events a
              WHERE a.user_id = $1 AND a.subject_id = h.id::text
                AND a.event_type = ANY($2::text[])
              ORDER BY a.created_at DESC, (a.event_type = $3) DESC
              LIMIT 1) <> $3
     ) AS rolled_back`,
    [account, [...ROLLED_BACK_EVENTS, FENCE_EVENT], FENCE_EVENT]
  )).rows[0];
  return row?.rolled_back === true;
}
