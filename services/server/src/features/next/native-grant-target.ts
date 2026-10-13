// Discovery and relay admission for application grants on a Private native
// collection (grants.next_collection_id). Account consent is the only user
// approval. The serving device materializes the exact signed grant and sealed
// Private folder scope automatically; these checks locate that account's device.
import type { DatabaseQueryable } from "../../database-types.js";
import { CreateError, ENROLMENT, currentMember, exactEnrolment, refuseRevoked } from "./bootstrap-common.js";
import { requireCollectionNotDeleted } from "./collection-deletion.js";
import type { RegisteredDeviceKind } from "./policy-wire.js";

export interface NativeGrant {
  grant_id: string;
  authorization_grant: string;
  user_id: string;
  policy_active: boolean;
  has_client_key: boolean;
}

export interface NativeDevice {
  device_id: string;
  kind: RegisteredDeviceKind;
  noise_pk: Buffer;
  connector_id: string;
  relay_generation: string;
  last_active_ms: number | null;
  /** The device's last relay connection was refused as an incompatible version. */
  update_required: boolean;
}

/** The active native grant this access token holds for `collection`, if any. */
export async function nativeGrant(db: DatabaseQueryable, tokenHash: string, collection: string): Promise<NativeGrant | null> {
  const result = await db.query<NativeGrant>(
    `SELECT COALESCE(binding.log_grant_id, g.id) AS grant_id, g.id AS authorization_grant, g.user_id,
            COALESCE(binding.active, false) AS policy_active, (k.grant_id IS NOT NULL) AS has_client_key
     FROM access_tokens tok
     JOIN grants g ON g.id = tok.grant_id
     JOIN users u ON u.id = g.user_id
     LEFT JOIN next_grant_client_keys k ON k.grant_id = g.id
     LEFT JOIN next_grant_bindings binding ON binding.grant_id = g.id
     WHERE tok.token_hash = $1 AND tok.expires_at > now() AND tok.revoked_at IS NULL
       AND g.revoked_at IS NULL AND g.activated_at IS NOT NULL AND u.suspended_at IS NULL
       AND g.next_collection_id = $2`,
    [tokenHash, collection]
  );
  return result.rows[0] ?? null;
}

/**
 * Whether the grant can still be served as granted: `current` when the collection is
 * still a synced, undeleted Private collection and the account a current member;
 * `access_removed` when the account is no longer a member; otherwise
 * `sync_required` (the collection left Private sync or was deleted).
 */
export async function nativeGrantStanding(db: DatabaseQueryable, collection: string, account: string): Promise<"current" | "access_removed" | "sync_required"> {
  const current = await db.query(
    `SELECT 1 FROM next_collections WHERE collection_id = $1
     AND runtime = 'next' AND sync = 'private' AND left_sync_at IS NULL`,
    [collection]
  );
  if (!current.rows.length) return "sync_required";
  try {
    await requireCollectionNotDeleted(db, collection);
  } catch (error) {
    if (error instanceof Error && error.message === "collection_deleted") return "sync_required";
    throw error;
  }
  try {
    await currentMember(db, collection, account);
  } catch (error) {
    if (error instanceof CreateError) return "access_removed";
    throw error;
  }
  return "current";
}

/**
 * Desktop and CLI devices of `account` on live connectors whose exact enrolment
 * in the collection is appended to the log and never revoked (SEC-047: only the
 * granting account's own devices).
 */
export async function nativeDevices(db: DatabaseQueryable, collection: string, account: string, only?: string): Promise<NativeDevice[]> {
  const devices = await db.query<NativeDevice & { sign_pk: Buffer; kem_pk: Buffer }>(
    `SELECT d.id AS device_id, d.kind, d.sign_pk, d.kem_pk, d.noise_pk,
            c.id AS connector_id, c.relay_generation::text AS relay_generation,
            (extract(epoch FROM c.last_seen_at) * 1000)::double precision AS last_active_ms,
            (c.incompatibility_code IS NOT NULL) AS update_required
     FROM next_devices d
     JOIN connectors c ON c.id = d.connector_id AND c.revoked_at IS NULL
     WHERE d.user_id = $1 AND d.kind IN ('desktop', 'cli') AND ($2::uuid IS NULL OR d.id = $2::uuid)
     ORDER BY d.id`,
    [account, only ?? null]
  );
  const current: NativeDevice[] = [];
  for (const { sign_pk, kem_pk, ...device } of devices.rows) {
    const enrolment = await db.query<{ state: string | null }>(ENROLMENT,
      [collection, exactEnrolment(device.device_id, account, { sign_pk, kem_pk, noise_pk: device.noise_pk, kind: device.kind })]);
    if (enrolment.rows[0]?.state !== "appended") continue;
    try { await refuseRevoked(db, collection, device.device_id); }
    catch (error) {
      if (error instanceof CreateError) continue;
      throw error;
    }
    current.push(device);
  }
  return current;
}

/**
 * Relay admission for a native grant: the connector of the requested device when
 * it is a current serving device of the grant's account. Null refuses.
 */
export async function nativeAdmission(db: DatabaseQueryable, tokenHash: string, collection: string, grant: string, device: string): Promise<string | null> {
  const row = await nativeGrant(db, tokenHash, collection);
  if (!row || row.grant_id !== grant || !row.has_client_key || !row.policy_active) return null;
  if (await nativeGrantStanding(db, collection, row.user_id) !== "current") return null;
  if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(device)) return null;
  // Only the pinned device is checked, at admission and on every revalidation.
  const target = (await nativeDevices(db, collection, row.user_id, device)).find((candidate) => candidate.device_id === device);
  return target?.connector_id ?? null;
}

/**
 * A still-active grant whose local-connector collection has been taken over by a
 * native collection (the legacy row is retired or disabled). The app must be
 * set up again for the native collection.
 */
export async function supersededLegacyGrant(db: DatabaseQueryable, tokenHash: string, collection: string): Promise<{ grant_id: string; authorization_grant: string } | null> {
  const result = await db.query<{ grant_id: string; authorization_grant: string }>(
    `SELECT COALESCE(binding.log_grant_id, g.id) AS grant_id, g.id AS authorization_grant
     FROM access_tokens tok
     JOIN grants g ON g.id = tok.grant_id
     JOIN users u ON u.id = g.user_id
     JOIN collections col ON col.id = g.collection_id
     JOIN next_collections nc ON nc.collection_id = col.local_id
     LEFT JOIN next_grant_bindings binding ON binding.grant_id = g.id
     WHERE tok.token_hash = $1 AND tok.expires_at > now() AND tok.revoked_at IS NULL
       AND g.revoked_at IS NULL AND g.activated_at IS NOT NULL AND u.suspended_at IS NULL
       AND col.local_id = $2 AND col.authority_state = 'retired'
       AND nc.runtime = 'next'
     LIMIT 1`,
    [tokenHash, collection]
  );
  return result.rows[0] ?? null;
}
