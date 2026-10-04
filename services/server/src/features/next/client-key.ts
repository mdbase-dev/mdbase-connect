// Registering an app's Noise static key at consent (mdbase-next interface note
// 2026-10-04-control-client-noise-key-attestation.md). The app signs its key with the
// per-grant signing key that its v5 authorization binding certifies, so a daemon can
// check the chain binding → grant signing key → client_pk, and the control plane
// cannot substitute the key.
import { createPublicKey, verify } from "node:crypto";
import { ApplicationAuthorizationError } from "../../application-authorization.js";
import type { DatabaseQueryable } from "../../database-types.js";
import { weakAgreementKey } from "./devices.js";

const DOMAIN = Buffer.from("mdbase-next client noise key v1\0", "utf8");

/** Refused like any invalid authorization proof: the request is not created. */
export class ClientNoiseKeyError extends ApplicationAuthorizationError {}

export interface ClientNoiseKey {
  publicKey: Buffer;
  signature: Buffer;
}

const field = (bytes: Uint8Array) => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  return Buffer.concat([length, bytes]);
};

/** `"mdbase-next client noise key v1\0" ‖ field(authorization_id) ‖ field(client_pk)`. */
export function clientNoiseKeyMessage(authorizationId: string, publicKey: Uint8Array): Buffer {
  const id = authorizationId.replaceAll("-", "");
  if (!/^[0-9a-f]{32}$/i.test(id)) throw new ClientNoiseKeyError("The authorization ID is invalid.");
  return Buffer.concat([DOMAIN, field(Buffer.from(id, "hex")), field(publicKey)]);
}

function base64url(value: unknown, size: number): Buffer | null {
  if (typeof value !== "string") return null;
  const bytes = Buffer.from(value, "base64url");
  return bytes.length === size && bytes.toString("base64url") === value ? bytes : null;
}

/**
 * Parse and verify the optional `client_noise_key` of an authorization request against
 * its already-verified binding. Returns undefined when absent; throws when present but
 * malformed, weak, or not signed by the binding's grant signing key.
 */
export function verifiedClientNoiseKey(
  raw: string | undefined,
  binding: { authorization_id: string; grant_signing_public_key: string }
): ClientNoiseKey | undefined {
  if (raw === undefined) return undefined;
  let parsed: { public_key?: unknown; signature?: unknown };
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch {
    throw new ClientNoiseKeyError("client_noise_key must be JSON.");
  }
  const publicKey = base64url(parsed.public_key, 32);
  const signature = base64url(parsed.signature, 64);
  if (!publicKey || !signature || Object.keys(parsed).length !== 2) {
    throw new ClientNoiseKeyError("client_noise_key needs a 32-byte public_key and a 64-byte signature.");
  }
  if (weakAgreementKey(publicKey)) throw new ClientNoiseKeyError("The Noise key is weak or low order.");
  let signingKey;
  try {
    const point = Buffer.from(binding.grant_signing_public_key, "base64url");
    if (point.length !== 65 || point[0] !== 4) throw new Error();
    signingKey = createPublicKey({
      key: { kty: "EC", crv: "P-256", x: point.subarray(1, 33).toString("base64url"), y: point.subarray(33, 65).toString("base64url") },
      format: "jwk"
    });
  } catch {
    throw new ClientNoiseKeyError("The binding's grant signing key is invalid.");
  }
  const message = clientNoiseKeyMessage(binding.authorization_id, publicKey);
  if (!verify("sha256", message, { key: signingKey, dsaEncoding: "ieee-p1363" }, signature)) {
    throw new ClientNoiseKeyError("The Noise key attestation does not verify.");
  }
  return { publicKey, signature };
}

export async function storeRequestClientNoiseKey(db: DatabaseQueryable, requestId: string, key: ClientNoiseKey): Promise<void> {
  await db.query(
    "INSERT INTO next_authorization_client_keys (request_id, client_pk, signature) VALUES ($1, $2, $3) ON CONFLICT (request_id) DO NOTHING",
    [requestId, key.publicKey, key.signature]
  );
}

/**
 * At approval, inside its transaction: the grant's key becomes exactly the request's
 * attested key. A grant reactivated by a request without one loses any earlier key.
 */
export async function copyClientNoiseKeyToGrant(db: DatabaseQueryable, requestId: string, grantId: string): Promise<void> {
  await db.query(
    `DELETE FROM next_grant_client_keys
     WHERE grant_id = $2 AND NOT EXISTS (SELECT 1 FROM next_authorization_client_keys WHERE request_id = $1)`,
    [requestId, grantId]
  );
  await db.query(
    `INSERT INTO next_grant_client_keys (grant_id, client_pk, signature)
     SELECT $2, client_pk, signature FROM next_authorization_client_keys WHERE request_id = $1
     ON CONFLICT (grant_id) DO UPDATE SET client_pk = EXCLUDED.client_pk, signature = EXCLUDED.signature, created_at = now()`,
    [requestId, grantId]
  );
}
