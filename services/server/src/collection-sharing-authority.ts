import type { DatabaseConnection, DatabaseQueryable } from "./database-types.js";
import { requireCollectionNotDeleted } from "./features/next/collection-deletion.js";
import { requireAccountNotMigrationFrozen } from "./features/next/migration-topology.js";

export interface CollectionSharingAuthority {
  kind: "native" | "hosted";
  id: string;
  user_id: string;
  created_at: Date | string;
}

/** Native authority replaces the legacy row only after cutover. An unavailable
 * native row never falls back to a retained legacy authority. */
export async function resolveCollectionSharingAuthority(
  db: DatabaseQueryable,
  collectionId: string
): Promise<CollectionSharingAuthority | null> {
  return readAuthority(db, collectionId, "");
}

/** Account/freeze locks precede collection locks; revalidate discovered ownership
 * before any invitation, membership, seat or policy publication. */
export async function lockCollectionSharingAuthority(
  db: DatabaseConnection,
  collectionId: string
): Promise<CollectionSharingAuthority | null> {
  const discovered = await resolveCollectionSharingAuthority(db, collectionId);
  if (!discovered) return null;
  await requireAccountNotMigrationFrozen(db, discovered.user_id);
  const held = await readAuthority(db, collectionId, " FOR UPDATE");
  if (!held || held.user_id !== discovered.user_id) return null;
  return held;
}

async function readAuthority(
  db: DatabaseQueryable,
  collectionId: string,
  lock: "" | " FOR UPDATE"
): Promise<CollectionSharingAuthority | null> {
  const native = (await db.query<{
    collection_id: string; owner_user_id: string; created_at: Date | string;
    runtime: string; sync: string; left_sync_at: Date | string | null;
  }>(
    `SELECT collection_id, owner_user_id, created_at, runtime, sync, left_sync_at
     FROM next_collections WHERE collection_id = $1${lock}`,
    [collectionId]
  )).rows[0];
  if (native?.runtime === "next") {
    if (native.left_sync_at !== null || !["private", "cloud_copy"].includes(native.sync)) return null;
    // Collection runtime owns this decision; account backend flips separately.
    // Migration topology is still frozen by lockCollectionSharingAuthority.
    const owner = await db.query(
      `SELECT id FROM users WHERE id = $1 AND suspended_at IS NULL${lock}`,
      [native.owner_user_id]
    );
    if (!owner.rows.length) return null;
    try {
      await requireCollectionNotDeleted(db, collectionId);
    } catch (error) {
      if (error instanceof Error && error.message === "collection_deleted") return null;
      throw error;
    }
    return { kind: "native", id: native.collection_id, user_id: native.owner_user_id, created_at: native.created_at };
  }
  // Shadow collections retain their existing hosted authority until cutover.
  const legacy = (await db.query<Omit<CollectionSharingAuthority, "kind">>(
    `SELECT id, user_id, created_at FROM hosted_collections
     WHERE id = $1 AND authority_state = 'active' AND quarantined_at IS NULL${lock}`,
    [collectionId]
  )).rows[0];
  if (native && legacy?.user_id !== native.owner_user_id) return null;
  return legacy ? { kind: "hosted", ...legacy } : null;
}
