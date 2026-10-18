// Discovery and relay admission for application grants on a Private native
// collection (grants.next_collection_id). Account consent is the only user
// approval. The serving device materializes the exact signed grant and sealed
// Private folder scope automatically; these checks locate that account's device.
import type { DatabaseQueryable } from "../../database-types.js";
import { CreateError, DEVICE_REVOCATIONS, currentMember } from "./bootstrap-common.js";
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
  return (await nativeDevicesByCollection(db, [collection], account, only)).get(collection.toLowerCase())!;
}

/** Same serving-device discovery in one read for a bounded management inventory.
 * Returned map keys are canonical PostgreSQL UUIDs, including empty inventories. */
export async function nativeDevicesByCollection(db: DatabaseQueryable, collections: readonly string[], account: string, only?: string): Promise<ReadonlyMap<string, NativeDevice[]>> {
  const ids = [...new Set(collections.map(id => id.toLowerCase()))];
  const current = new Map(ids.map(id => [id, [] as NativeDevice[]]));
  if (ids.length === 0) return current;
  const devices = await db.query<NativeDevice & { collection_id: string }>(
    `WITH devices AS (
       SELECT d.id AS device_id,d.kind,d.sign_pk,d.kem_pk,d.noise_pk,
         c.id AS connector_id,c.relay_generation::text AS relay_generation,
         (extract(epoch FROM c.last_seen_at)*1000)::double precision AS last_active_ms,
         (c.incompatibility_code IS NOT NULL) AS update_required
       FROM next_devices d JOIN connectors c ON c.id=d.connector_id AND c.revoked_at IS NULL
       WHERE d.user_id=$2::uuid AND d.kind IN ('desktop','cli') AND ($3::uuid IS NULL OR d.id=$3::uuid)
     ), policy_ops AS (
       SELECT o.collection_id,o.id AS outbox_id,e.ord,e.value FROM next_policy_outbox o
       CROSS JOIN LATERAL jsonb_array_elements(o.ops->'ops') WITH ORDINALITY AS e(value,ord)
       WHERE o.collection_id=ANY($1::uuid[])
     ), first_enrolment AS (
       SELECT DISTINCT ON (p.collection_id,d.device_id) p.collection_id,d.device_id,p.outbox_id
       FROM policy_ops p JOIN devices d ON p.value @> jsonb_build_object(
         'op','device-enrol','device',d.device_id::text,'account',$2::uuid::text,'kind',d.kind,
         'signPublicKey',jsonb_build_object('$hex',encode(d.sign_pk,'hex')),
         'kemPublicKey',jsonb_build_object('$hex',encode(d.kem_pk,'hex')),
         'noisePublicKey',jsonb_build_object('$hex',encode(d.noise_pk,'hex')))
       ORDER BY p.collection_id,d.device_id,p.outbox_id
     ), revoked AS (${DEVICE_REVOCATIONS})
     SELECT enrolled.collection_id,d.device_id,d.kind,d.noise_pk,d.connector_id,
       d.relay_generation,d.last_active_ms,d.update_required
     FROM first_enrolment enrolled JOIN devices d ON d.device_id=enrolled.device_id
     JOIN next_policy_outbox o ON o.id=enrolled.outbox_id
     JOIN next_policy_batches b ON b.id=o.batch_id AND b.lost_at IS NULL AND b.state='appended'
     WHERE NOT EXISTS (SELECT 1 FROM revoked r WHERE r.collection_id=enrolled.collection_id AND r.device_id=d.device_id::text)
     ORDER BY enrolled.collection_id,d.device_id`,
    [ids, account, only ?? null]
  );
  for (const { collection_id, ...device } of devices.rows) current.get(collection_id)!.push(device);
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
 * Positive current local authority on a legacy connector, for this exact owner
 * and collection. This is the same registration distinction used by local
 * takeover: next enrollment disqualifies a legacy connector. Missing next rows,
 * socket presence and account backend alone never establish legacy authority.
 * Shadow/next collection rows are deliberately excluded (migration/readiness
 * have their own outcomes). Callers still own request/grant authorization.
 */
export async function unmigratedLocalCollection(db: DatabaseQueryable, collection: string, account: string): Promise<boolean> {
  const result = await db.query<{ unmigrated: boolean }>(
    `SELECT true AS unmigrated FROM collections col
     JOIN connectors c ON c.id = col.connector_id AND c.user_id = col.user_id
     JOIN users u ON u.id = col.user_id
     LEFT JOIN next_devices d ON d.connector_id = c.id
     LEFT JOIN next_collections n ON n.collection_id = col.local_id
     WHERE col.local_id = $1 AND col.user_id = $2
       AND col.present = true AND col.enabled = true AND col.removed_at IS NULL
       AND col.authority_state = 'active' AND c.revoked_at IS NULL AND u.suspended_at IS NULL
       AND d.id IS NULL AND n.collection_id IS NULL LIMIT 1`,
    [collection, account]
  );
  return result.rows[0]?.unmigrated === true;
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
