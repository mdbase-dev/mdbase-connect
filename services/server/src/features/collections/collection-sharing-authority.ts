import type { DatabaseConnection, DatabaseQueryable } from "../../database-types.js";
import { requireCollectionNotDeleted } from "../next/collection-deletion.js";

export interface CollectionSharingAuthority {
  kind: "native" | "hosted";
  id: string;
  user_id: string;
  created_at: Date | string;
}

export async function resolveCollectionSharingAuthority(
  db: DatabaseQueryable,
  collectionId: string
): Promise<CollectionSharingAuthority | null> {
  return readAuthority(db, collectionId, "");
}

export async function lockCollectionSharingAuthority(
  db: DatabaseConnection,
  collectionId: string
): Promise<CollectionSharingAuthority | null> {
  const discovered = await resolveCollectionSharingAuthority(db, collectionId);
  if (!discovered) return null;
  const held = await readAuthority(db, collectionId, " FOR UPDATE");
  if (!held || held.user_id !== discovered.user_id || held.kind !== discovered.kind) return null;
  return held;
}

export async function lockCollectionInvitationAcceptance(
  db: DatabaseConnection,
  collectionId: string
): Promise<CollectionSharingAuthority | null> {
  return lockCollectionSharingAuthority(db, collectionId);
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
  const legacy = (await db.query<Omit<CollectionSharingAuthority, "kind">>(
    `SELECT id, user_id, created_at FROM hosted_collections
     WHERE id = $1 AND authority_state = 'active' AND quarantined_at IS NULL${lock}`,
    [collectionId]
  )).rows[0];
  if (native && legacy?.user_id !== native.owner_user_id) return null;
  return legacy ? { kind: "hosted", ...legacy } : null;
}
