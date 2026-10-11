// Discovery and relay admission for application grants on a Private native
// collection (grants.next_collection_id). The CP grant is only an offer: the
// collection's replica on the serving device admits the app only under the
// device-signed grant approval. These checks decide where the app may connect.
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
 * The collection is still a synced Private collection, not deleted, and the
 * account is a current member. False means the grant can no longer be served
 * as granted and the app must be set up again for it.
 */
export async function nativeGrantCurrent(db: DatabaseQueryable, collection: string, account: string): Promise<boolean> {
  const current = await db.query(
    `SELECT 1 FROM next_collections WHERE collection_id = $1
     AND runtime = 'next' AND sync = 'private' AND left_sync_at IS NULL`,
    [collection]
  );
  if (!current.rows.length) return false;
  try {
    await requireCollectionNotDeleted(db, collection);
    await currentMember(db, collection, account);
  } catch (error) {
    if (error instanceof CreateError || (error instanceof Error && error.message === "collection_deleted")) return false;
    throw error;
  }
  return true;
}

/**
 * Desktop and CLI devices of `account` on live connectors whose exact enrolment
 * in the collection is appended to the log and never revoked (SEC-047: only the
 * granting account's own devices).
 */
export async function nativeDevices(db: DatabaseQueryable, collection: string, account: string): Promise<NativeDevice[]> {
  const devices = await db.query<NativeDevice & { sign_pk: Buffer; kem_pk: Buffer }>(
    `SELECT d.id AS device_id, d.kind, d.sign_pk, d.kem_pk, d.noise_pk,
            c.id AS connector_id, c.relay_generation::text AS relay_generation,
            (extract(epoch FROM c.last_seen_at) * 1000)::double precision AS last_active_ms,
            (c.incompatibility_code IS NOT NULL) AS update_required
     FROM next_devices d
     JOIN connectors c ON c.id = d.connector_id AND c.revoked_at IS NULL
     WHERE d.user_id = $1 AND d.kind IN ('desktop', 'cli')
     ORDER BY d.id`,
    [account]
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
  if (!await nativeGrantCurrent(db, collection, row.user_id)) return null;
  const target = (await nativeDevices(db, collection, row.user_id)).find((candidate) => candidate.device_id === device);
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
