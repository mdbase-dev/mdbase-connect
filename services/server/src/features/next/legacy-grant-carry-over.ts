// Carry an owner's app grants from a taken-over desktop collection to its Private
// native collection, so apps that used the collection through mdbase Connect keep
// working once Private sync is on, without the user approving them again.
//
// Only grants the native path can serve exactly as approved move: the owner's own
// active, key-bound grants whose signed authorization is a native protocol and
// whose terms project to a native policy grant (queueNextGrantPolicy refuses the
// rest, which then stay where they are and need a fresh approval). The grant keeps
// its id, so the app's existing tokens and client key remain valid. The serving
// desktop approves the published policy grant as it does any owner grant. The
// legacy target and relay binding are kept on the grant for a fenced local
// rollback (local-rollback-bindings.ts), which restores them.
import type { DatabaseConnection, DatabasePool } from "../../database-types.js";
import { audit } from "../../platform/audit-events.js";
import { lockCollectionSharingAuthority } from "../../collection-sharing-authority.js";
import { inTransaction } from "./bootstrap-common.js";
import { requireCollectionNotDeleted } from "./collection-deletion.js";
import { queueNextGrantPolicy } from "./grant-policy.js";
import type { PolicyEmitter } from "./policy-outbox.js";

/** At most this many grants move per call; the next call continues. */
const BATCH = 200;

async function carryOver(client: DatabaseConnection, collection: string): Promise<string[]> {
  // Account and collection authority first, the same order as a native approval.
  const authority = await lockCollectionSharingAuthority(client, collection);
  if (!authority || authority.kind !== "native") return [];
  const owner = authority.user_id;
  const current = await client.query(
    `SELECT 1 FROM next_collections WHERE collection_id = $1 AND owner_user_id = $2
       AND runtime = 'next' AND sync = 'private' AND left_sync_at IS NULL`,
    [collection, owner]
  );
  if (!current.rows.length) return [];
  await requireCollectionNotDeleted(client, collection);
  const candidates = await client.query<{ id: string; legacy_row: string }>(
    `SELECT g.id, col.id AS legacy_row
     FROM grants g
     JOIN collections col ON col.id = g.collection_id
     JOIN users u ON u.id = g.user_id
     WHERE col.local_id = $1 AND col.user_id = $2 AND col.authority_state = 'retired'
       AND col.present = true AND col.removed_at IS NULL
       AND g.user_id = $2 AND g.membership_id IS NULL AND g.hosted_replica_id IS NULL
       AND g.revoked_at IS NULL AND g.activated_at IS NOT NULL AND g.reauthorization_required_at IS NULL
       AND u.suspended_at IS NULL AND u.account_backend = 'next'
       AND g.application_installation_id IS NOT NULL
       AND g.application_authorization->'binding'->>'protocol_version' IN ('4', '5')
       AND EXISTS (SELECT 1 FROM next_grant_client_keys k WHERE k.grant_id = g.id)
       -- A fenced local rollback returned this collection's apps to the old
       -- connector: they stay there (a later move needs a fresh approval).
       AND NOT EXISTS (SELECT 1 FROM next_local_rollback_bindings r WHERE r.collection_id = $1 AND r.user_id = $2)
       AND NOT EXISTS (
         SELECT 1 FROM grants n WHERE n.next_collection_id = $1 AND n.user_id = g.user_id
           AND n.application_id = g.application_id
           AND n.application_installation_id = g.application_installation_id
           AND n.revoked_at IS NULL)
     ORDER BY g.id LIMIT ${BATCH} FOR UPDATE OF g`,
    [collection, owner]
  );
  const moved: string[] = [];
  for (const grant of candidates.rows) {
    await client.query("SAVEPOINT carry_over");
    try {
      await client.query(
        `UPDATE grants SET legacy_collection_id = collection_id, legacy_encryption = encryption,
           collection_id = NULL, next_collection_id = $1, logical_collection_id = $1, encryption = NULL
         WHERE id = $2`,
        [collection, grant.id]
      );
      // Publishes the exact native terms, or refuses (unrepresentable terms,
      // a semantic1 grant without a prior native binding): then nothing moves.
      if (!await queueNextGrantPolicy(client, grant.id)) throw new Error("not publishable");
    } catch {
      await client.query("ROLLBACK TO SAVEPOINT carry_over");
      continue;
    }
    await client.query("RELEASE SAVEPOINT carry_over");
    await audit(client, owner, "grant.carried_over", grant.id, { next_collection_id: collection, legacy_collection_row: grant.legacy_row });
    moved.push(grant.id);
  }
  return moved;
}

/**
 * Move every eligible grant (see the file comment) to the Private collection.
 * Idempotent: a moved grant no longer matches, and a second app installation
 * grant is skipped while one is active on the collection. Returns moved grant ids.
 */
export async function carryOverLegacyLocalGrants(db: DatabasePool, collection: string): Promise<string[]> {
  const moved: string[] = [];
  for (;;) {
    const batch = await inTransaction(db, client => carryOver(client, collection));
    moved.push(...batch);
    if (batch.length < BATCH) return moved;
  }
}

/** The same, never throwing: publication is woken for moved grants and a failure
 * is only logged (the caller's outcome never depends on it). */
export async function carryOverLegacyGrants(
  options: { db: DatabasePool; emitter?: Pick<PolicyEmitter, "publishCommitted"> },
  collection: string,
  log?: { warn(details: object, message: string): void }
): Promise<number> {
  try {
    const moved = await carryOverLegacyLocalGrants(options.db, collection);
    if (moved.length) options.emitter?.publishCommitted(collection).catch(() => undefined);
    return moved.length;
  } catch (error) {
    log?.warn({ err: error, collection }, "legacy grant carry-over deferred");
    return 0;
  }
}
