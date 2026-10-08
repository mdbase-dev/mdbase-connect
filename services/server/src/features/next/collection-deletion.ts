// CP denial/journal foundation only. No HTTP delete endpoint, Deleted ACK,
// startup-positive permit, purge or physical-erasure claim is supplied here.
import { randomUUID } from "node:crypto";
import type { DatabaseConnection, DatabasePool, DatabaseQueryable } from "../../database-types.js";

export interface CollectionDeletionFact { collection: string; deletionId: string; lifecycleEpoch: bigint }
export interface CollectionDeletionPage {
  generation: bigint; rows: readonly CollectionDeletionFact[]; after: string | null; done: boolean;
}
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const NIL = "00000000-0000-0000-0000-000000000000";
const U64 = (1n << 64n) - 1n;
function uuid(value: unknown): string {
  if (typeof value !== "string" || value.length !== 36 || value === NIL || !UUID.test(value)) throw new Error("invalid_collection_deletion_uuid");
  return value;
}
function checked(fact: CollectionDeletionFact): CollectionDeletionFact {
  const { collection, deletionId, lifecycleEpoch } = fact;
  uuid(collection); uuid(deletionId);
  if (typeof lifecycleEpoch !== "bigint" || lifecycleEpoch < 1n || lifecycleEpoch > U64)
    throw new Error("invalid_collection_deletion_epoch");
  return { collection, deletionId, lifecycleEpoch };
}
interface Row { collection_id: string; deletion_id: string; epoch: string }
const rowFact = (row: Row): CollectionDeletionFact => checked({collection:row.collection_id,deletionId:row.deletion_id,lifecycleEpoch:BigInt(row.epoch)});

/** Immutable CP request journal. Caller MUST authorize/confirm the exact owner
 * and use its collection-locked transaction. First terminal epoch advances the
 * previously untracked lifecycle from zero to one, never a policy-key epoch.
 * Existing native denial is returned without manufacturing a replacement intent.
 * Returning a fact is NOT a Deleted acknowledgement or a native authority read. */
export async function recordCollectionDeletionIntent(client: DatabaseConnection, collection: string, actor: string): Promise<CollectionDeletionFact> {
  uuid(collection); uuid(actor);
  await client.query(`INSERT INTO next_collection_deletion_facts(collection_id,deletion_id,lifecycle_epoch,authority,actor_id)
    SELECT $1,$2,1,'cp-intent',$3 WHERE NOT EXISTS
    (SELECT 1 FROM next_collection_deletion_facts WHERE collection_id=$1) ON CONFLICT DO NOTHING`,[collection,randomUUID(),actor]);
  const result = await client.query<Row>(`SELECT collection_id,deletion_id,lifecycle_epoch::text AS epoch
    FROM next_collection_deletion_facts WHERE collection_id=$1
    ORDER BY lifecycle_epoch DESC,authority DESC,deletion_id LIMIT 1`,[collection]);
  if (!result.rows[0]) throw new Error("collection_deletion_intent_missing");
  return rowFact(result.rows[0]);
}

/** Only the authenticated current nil-registry scanner may call this. Fully
 * validate its bounded page BEFORE any insert; caller owns the page transaction.
 * Union never erases a local intent or older/higher denial fact. Conflicting
 * identities remain denied; none is an optimistic successful remote receipt. */
export async function mergeCollectionDeletionFloors(client: DatabaseConnection, facts: readonly CollectionDeletionFact[]): Promise<void> {
  if (!Array.isArray(facts) || facts.length > 128) throw new Error("invalid_collection_deletion_page");
  const page = facts.map(checked);
  const seen = new Set<string>();
  for (const fact of page) {
    if (seen.has(fact.collection)) throw new Error("duplicate_collection_deletion_floor");
    seen.add(fact.collection);
  }
  for (const fact of page) await client.query(`INSERT INTO next_collection_deletion_facts
    (collection_id,deletion_id,lifecycle_epoch,authority) VALUES($1,$2,$3,'native-registry')
    ON CONFLICT DO NOTHING`,[fact.collection,fact.deletionId,fact.lifecycleEpoch.toString()]);
}

/** Durably union a bounded current registry traversal before startup consumers.
 * A returned revision is NOT a permit: Gone/status and effect-time fences are
 * separate. Any error leaves the caller closed and prior page denials intact. */
export async function reconcileCollectionDeletionFloors(db: DatabasePool, registry: {registryCollectionDeletions(after: string | null, expected: bigint | null): Promise<CollectionDeletionPage>}): Promise<bigint> {
  let after: string | null = null, generation: bigint | null = null, confirming = false;
  for (let pageNumber = 0; pageNumber < 4096 || confirming; pageNumber++) {
    // The public structural peer is not runtime admission. Capture only these
    // fields and validate/copy the entire page before any database await.
    const {generation: observed, after: cursor, done, rows: inputRows} = await registry.registryCollectionDeletions(after,generation);
    if (typeof observed !== "bigint" || observed < 0n || observed > U64) throw new Error("invalid_collection_deletion_generation");
    if (generation !== null && observed !== generation) throw new Error("collection_deletion_generation_drift");
    if (cursor !== null) uuid(cursor);
    if (!Array.isArray(inputRows) || inputRows.length > 128 || typeof done !== "boolean") throw new Error("invalid_collection_deletion_page");
    const rows = inputRows.map(checked);
    let previous: string | null = after;
    for (const row of rows) {
      if (previous !== null && row.collection <= previous) throw new Error("invalid_collection_deletion_page");
      previous = row.collection;
    }
    if (cursor !== previous || done !== (rows.length < 128)) throw new Error("invalid_collection_deletion_page");
    if (confirming) {
      if (!done || rows.length !== 0) throw new Error("collection_deletion_generation_drift");
      return observed;
    }
    generation = observed;
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await mergeCollectionDeletionFloors(client,rows);
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
    after = cursor;
    confirming = done;
  }
  throw new Error("collection_deletion_scan_limit");
}

/** A denial check, not a cached liveness proof. Registration/key/routing callers
 * must integrate it into their existing locked transaction before publication. */
export async function requireCollectionNotDeleted(client: DatabaseQueryable, collection: string): Promise<void> {
  uuid(collection);
  const found = await client.query("SELECT 1 FROM next_collection_deletion_facts WHERE collection_id=$1 LIMIT 1",[collection]);
  if (found.rows[0]) throw new Error("collection_deleted");
}
