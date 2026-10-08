// Discovery only: the hosted Worker decides live Noise/policy/key admission.
import type { DatabaseQueryable } from "../../database-types.js";
import type { RegisteredDeviceKind } from "./policy-wire.js";

export interface RouteTarget {
  kind: RegisteredDeviceKind | "hosted";
  device: string;
  noise_pk: string;
  url: string;
  /** Relay presence hint only; hosted discovery always returns false. */
  online: boolean;
  /** For relay targets: the collection ID `pipe_auth` names. */
  relay_collection?: string;
}

/** Operator-configured origin, never a request-selected destination or URL prefix. */
export function hostedClientOrigin(value: string): string {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new Error("MDBASE_NEXT_HOSTED_CLIENT_URL must be an HTTPS/WSS origin."); }
  if (!["https:", "wss:"].includes(url.protocol) || url.username || url.password
      || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("MDBASE_NEXT_HOSTED_CLIENT_URL must be an HTTPS/WSS origin without credentials, path, query or fragment.");
  }
  url.protocol = "wss:";
  return url.origin;
}

interface HostedRouteGrant {
  grant_id: string;
  has_client_key: boolean;
  hosted_device: string | null;
  hosted_noise_pk: Buffer | null;
}

/** Snapshot metadata under the current cloud-copy row's share lock. Neither a
 * recorded service device, an appended enrolment nor an activation ACK is readiness.
 * The last appended device op must still be enrolment of this exact hosted key.
 */
export async function hostedRouteTarget(db: DatabaseQueryable, tokenDigest: string, collection: string, origin: string): Promise<{ grant: HostedRouteGrant; target: RouteTarget | null } | null> {
  const rows = await db.query<HostedRouteGrant>(
    `SELECT g.id AS grant_id, (key.grant_id IS NOT NULL) AS has_client_key,
            CASE WHEN enrolled.op->>'op' = 'device-enrol' AND enrolled.op->>'kind' = 'hosted'
                   AND enrolled.op->'noisePublicKey'->>'$hex' = encode(device.noise_pk, 'hex')
                 THEN device.device_id::text END AS hosted_device,
            CASE WHEN enrolled.op->>'op' = 'device-enrol' AND enrolled.op->>'kind' = 'hosted'
                   AND enrolled.op->'noisePublicKey'->>'$hex' = encode(device.noise_pk, 'hex')
                 THEN device.noise_pk END AS hosted_noise_pk
     FROM access_tokens tok JOIN grants g ON g.id = tok.grant_id
     JOIN users caller ON caller.id = g.user_id AND caller.suspended_at IS NULL
     LEFT JOIN collections col ON col.id = g.collection_id
     LEFT JOIN connectors connector ON connector.id = col.connector_id
     LEFT JOIN hosted_collections hc ON hc.id = g.hosted_collection_id
     JOIN next_collections parent ON parent.collection_id::text = COALESCE(col.local_id::text, hc.id::text)
     JOIN users owner ON owner.id = parent.owner_user_id AND owner.suspended_at IS NULL
     LEFT JOIN next_grant_client_keys key ON key.grant_id = g.id
     LEFT JOIN next_service_devices device ON device.collection_id = parent.collection_id AND device.kind = 'hosted'
     LEFT JOIN LATERAL (
       SELECT entry.op FROM next_policy_outbox queued
       JOIN next_policy_batches batch ON batch.id = queued.batch_id AND batch.state = 'appended' AND batch.lost_at IS NULL
       CROSS JOIN LATERAL jsonb_array_elements(queued.ops->'ops') WITH ORDINALITY AS entry(op, ordinal)
       WHERE queued.collection_id = parent.collection_id AND queued.ops->>'version' = '1'
         AND entry.op->>'device' = device.device_id::text
         AND entry.op->>'op' IN ('device-enrol', 'device-revoke')
       ORDER BY batch.seq DESC, queued.id DESC, entry.ordinal DESC LIMIT 1
     ) enrolled ON true
     WHERE tok.token_hash = $1 AND tok.expires_at > now() AND tok.revoked_at IS NULL
       AND g.revoked_at IS NULL AND g.activated_at IS NOT NULL
       AND parent.collection_id = $2 AND parent.runtime = 'next' AND parent.sync = 'cloud_copy' AND parent.left_sync_at IS NULL
       AND (g.collection_id IS NULL OR (col.enabled = true AND col.present = true AND col.authority_state = 'active' AND connector.revoked_at IS NULL))
       AND (g.hosted_collection_id IS NULL OR (hc.authority_state = 'active' AND hc.quarantined_at IS NULL))
       AND ((g.user_id = parent.owner_user_id AND g.membership_id IS NULL AND g.membership_policy_id IS NULL AND g.membership_policy_revision IS NULL)
         OR EXISTS (
           SELECT 1 FROM collection_memberships membership
           JOIN collection_identities identity ON identity.id = membership.collection_id AND identity.owner_user_id = parent.owner_user_id
           JOIN collection_membership_policies policy ON policy.id = membership.current_policy_id
             AND policy.membership_id = membership.id AND policy.revision = membership.current_policy_revision
           WHERE membership.id = g.membership_id AND membership.user_id = g.user_id AND membership.state = 'active' AND membership.revoked_at IS NULL
             AND membership.collection_id = g.logical_collection_id AND policy.id = g.membership_policy_id AND policy.revision = g.membership_policy_revision
         ))
     FOR SHARE OF parent`, [tokenDigest, collection]
  );
  const grant = rows.rows[0];
  if (!grant) return null;
  const pk = grant.hosted_noise_pk;
  if (!grant.hosted_device || /^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(grant.hosted_device)
      || !pk || pk.length !== 32 || pk.every(byte => byte === 0)) return { grant, target: null };
  const url = new URL("/v1/hosted/app", hostedClientOrigin(origin));
  url.searchParams.set("collection", collection.toLowerCase());
  return { grant, target: { kind: "hosted", device: grant.hosted_device, noise_pk: pk.toString("hex"), url: url.toString(), online: false } };
}
