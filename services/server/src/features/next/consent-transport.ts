import type { ApplicationAuthorizationProof, NextNoiseAuthorization } from "@mdbase-dev/connect-protocol";
import type { DatabaseQueryable } from "../../database-types.js";
import { RequestValidationError } from "../../platform/http-errors.js";
import { verifiedClientNoiseKey } from "./client-key.js";
import { weakAgreementKey } from "./devices.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
function invalid(): never { throw new RequestValidationError("The Noise device authorization is unavailable or no longer current."); }

/** A persisted marker is authoritative; malformed/missing dependencies never fall back. */
export function parseNextNoiseAuthorization(value: unknown): NextNoiseAuthorization {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  const r = value as Record<string, unknown>;
  if (Object.keys(r).length !== 5 || r.protocol_version !== 1
      || ![r.connector_id, r.device_id, r.collection_id].every(v => typeof v === "string" && UUID.test(v))
      || typeof r.device_noise_pk !== "string" || !/^[0-9a-f]{64}$/u.test(r.device_noise_pk)
      || weakAgreementKey(Buffer.from(r.device_noise_pk, "hex"))) return invalid();
  return { protocol_version: 1, connector_id: r.connector_id as string, device_id: r.device_id as string,
    device_noise_pk: r.device_noise_pk, collection_id: r.collection_id as string };
}

/** Validate the original tuple, never reconstruct a grant from a replacement registration. */
export async function currentNextNoiseAuthorization(db: DatabaseQueryable, value: unknown,
  accountId: string, collectionId: string): Promise<NextNoiseAuthorization> {
  const descriptor = parseNextNoiseAuthorization(value);
  if (!UUID.test(accountId) || descriptor.collection_id !== collectionId) return invalid();
  const row = (await db.query<{ noise_pk: Buffer }>(
    `SELECT d.noise_pk FROM next_devices d JOIN connectors c ON c.id = d.connector_id
     JOIN users u ON u.id = d.user_id
     WHERE d.id = $1 AND c.id = $2 AND d.user_id = $3 AND c.user_id = $3
       AND d.kind IN ('desktop', 'cli') AND c.revoked_at IS NULL AND u.suspended_at IS NULL
       AND u.account_backend = 'next'`,
    [descriptor.device_id, descriptor.connector_id, accountId]
  )).rows[0];
  if (!row || !row.noise_pk.equals(Buffer.from(descriptor.device_noise_pk, "hex"))) return invalid();
  return descriptor;
}

/** Ordinary consent transaction, after exact offer/account/authority checks. */
export async function nextNoiseConsentBinding(db: DatabaseQueryable, input: {
  deviceId: string; connectorId: string; accountId: string; collectionId: string;
  authorizationId: string; proof: ApplicationAuthorizationProof;
}): Promise<NextNoiseAuthorization> {
  const row = (await db.query<{ noise_pk: Buffer; client_pk: Buffer; signature: Buffer }>(
    `SELECT d.noise_pk, k.client_pk, k.signature
     FROM next_devices d JOIN connectors c ON c.id = d.connector_id
     JOIN users u ON u.id = c.user_id
     JOIN next_authorization_client_keys k ON k.request_id = $4
     WHERE d.id = $1 AND c.id = $2 AND d.user_id = $3 AND c.user_id = $3
       AND d.kind IN ('desktop', 'cli') AND c.revoked_at IS NULL AND u.suspended_at IS NULL
       AND u.account_backend = 'next' FOR SHARE OF d, c, u, k`,
    [input.deviceId, input.connectorId, input.accountId, input.authorizationId]
  )).rows[0];
  if (!row || input.proof.binding.authorization_id !== input.authorizationId
      || input.proof.binding.protocol_version !== 5
      || input.proof.binding.contracts.semantic_capabilities !== 2) return invalid();
  // Recheck the exact stored attestation; missing legacy encryption is not Noise authority.
  if (!verifiedClientNoiseKey(JSON.stringify({
    public_key: row.client_pk.toString("base64url"), signature: row.signature.toString("base64url")
  }), input.proof.binding)) return invalid();
  return parseNextNoiseAuthorization({ protocol_version: 1, connector_id: input.connectorId,
    device_id: input.deviceId, device_noise_pk: row.noise_pk.toString("hex"), collection_id: input.collectionId });
}
