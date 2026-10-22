// One-time Noise key attach for an existing grant (mdbase-next cutover).
//
// Grants approved before an app sent `client_noise_key` have no client key, so
// `/v1/next/collections/:id/route` answers 409 `client_key_required`. A server-side
// client that still holds the grant's own signing key (the MCP connector) can attach
// a key without asking the user to consent again:
//
// - `attestation` is the ordinary client-key attestation over
//   (authorization_id, client_pk), so daemons verify the stored chain unchanged;
// - `signature` binds this request to grant_id, client_pk, expires_at and nonce,
//   so it cannot be replayed against another grant or key, nor after expiry;
// - a grant that already has a key is refused, which makes attach single-use and
//   needs no nonce ledger. Anything else (rotation, lost key) goes through consent.
import { createPublicKey, verify } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { DatabasePool } from "../../database-types.js";
import { apiError } from "../../platform/http-errors.js";
import { audit } from "../../platform/audit-events.js";
import { bearerToken } from "../../platform/request-authentication.js";
import { tokenHash } from "../../security.js";
import { ClientNoiseKeyError, verifiedClientNoiseKey } from "./client-key.js";
import { queueNextGrantPolicy } from "./grant-policy.js";

const DOMAIN = Buffer.from("mdbase-next client noise key attach v1\0", "utf8");
const ATTACH_MAX_LIFETIME_MS = 5 * 60_000;

const field = (bytes: Uint8Array) => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  return Buffer.concat([length, bytes]);
};

/** `DOMAIN ‖ field(grant_id) ‖ field(client_pk) ‖ field(expires_at) ‖ field(nonce)`. */
export function clientKeyAttachMessage(grantId: string, publicKey: Uint8Array, expiresAt: string, nonce: Uint8Array): Buffer {
  const id = grantId.replaceAll("-", "");
  if (!/^[0-9a-f]{32}$/i.test(id)) throw new ClientNoiseKeyError("The grant ID is invalid.");
  return Buffer.concat([DOMAIN, field(Buffer.from(id, "hex")), field(publicKey), field(Buffer.from(expiresAt, "utf8")), field(nonce)]);
}

const bodySchema = z.object({
  grant_id: z.uuid(),
  public_key: z.string().max(64),
  attestation: z.string().max(128),
  nonce: z.string().max(64),
  expires_at: z.iso.datetime(),
  signature: z.string().max(128)
}).strict();

function signingKey(point64: string) {
  const point = Buffer.from(point64, "base64url");
  if (point.length !== 65 || point[0] !== 4) throw new ClientNoiseKeyError("The binding's grant signing key is invalid.");
  return createPublicKey({
    key: { kty: "EC", crv: "P-256", x: point.subarray(1, 33).toString("base64url"), y: point.subarray(33, 65).toString("base64url") },
    format: "jwk"
  });
}

export function registerClientKeyAttachRoute(app: FastifyInstance, options: { db: DatabasePool; now?: () => number }): void {
  const now = options.now ?? Date.now;
  app.post("/v1/next/grants/client-key", {
    config: { rateLimit: { max: 20, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    const token = bearerToken(request);
    if (!token) return reply.code(401).send(apiError("invalid_token", "Bearer token required."));
    const parsed = bodySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send(apiError("invalid_request", "Invalid client key attach request."));
    const input = parsed.data;
    const expires = Date.parse(input.expires_at), at = now();
    if (!(expires > at) || expires - at > ATTACH_MAX_LIFETIME_MS) {
      return reply.code(400).send(apiError("attach_expired", "The attach request is expired or too long-lived."));
    }
    const nonce = Buffer.from(input.nonce, "base64url");
    if (nonce.length !== 32 || nonce.toString("base64url") !== input.nonce) {
      return reply.code(400).send(apiError("invalid_request", "The nonce must be 32 random bytes."));
    }
    const connection = await options.db.connect();
    let committed = false;
    try {
      await connection.query("BEGIN");
      // The token's own grant only: active, not revoked, of a non-suspended user.
      const grant = (await connection.query<{ id: string; user_id: string; authorization_id: string | null; signing_key: string | null; has_key: boolean }>(
        `SELECT g.id, g.user_id,
                g.application_authorization->'binding'->>'authorization_id' AS authorization_id,
                g.application_authorization->'binding'->>'grant_signing_public_key' AS signing_key,
                EXISTS (SELECT 1 FROM next_grant_client_keys k WHERE k.grant_id = g.id) AS has_key
         FROM access_tokens tok
         JOIN grants g ON g.id = tok.grant_id
         JOIN users u ON u.id = g.user_id
         WHERE tok.token_hash = $1 AND tok.expires_at > now() AND tok.revoked_at IS NULL
           AND g.id = $2 AND g.revoked_at IS NULL AND g.activated_at IS NOT NULL
           AND u.suspended_at IS NULL
         FOR UPDATE OF g`,
        [tokenHash(token), input.grant_id]
      )).rows[0];
      if (!grant) return reply.code(401).send(apiError("invalid_token", "Access token is invalid or expired for this grant."));
      if (grant.has_key) return reply.code(409).send(apiError("client_key_present", "This grant already has a Noise key; authorize the app again to replace it."));
      if (!grant.authorization_id || !grant.signing_key) {
        return reply.code(409).send(apiError("application_reauthorization_required", "This grant cannot attach a key; authorize the app again."));
      }
      let key;
      try {
        key = verifiedClientNoiseKey(JSON.stringify({ public_key: input.public_key, signature: input.attestation }), {
          authorization_id: grant.authorization_id, grant_signing_public_key: grant.signing_key
        })!;
        const signature = Buffer.from(input.signature, "base64url");
        const message = clientKeyAttachMessage(grant.id, key.publicKey, input.expires_at, nonce);
        if (signature.length !== 64 || !verify("sha256", message, { key: signingKey(grant.signing_key), dsaEncoding: "ieee-p1363" }, signature)) {
          throw new ClientNoiseKeyError("The attach request signature does not verify.");
        }
      } catch (error) {
        if (error instanceof ClientNoiseKeyError) return reply.code(400).send(apiError("invalid_client_key", error.message));
        throw error;
      }
      const inserted = await connection.query(
        "INSERT INTO next_grant_client_keys (grant_id, client_pk, signature) VALUES ($1, $2, $3) ON CONFLICT (grant_id) DO NOTHING RETURNING grant_id",
        [grant.id, key.publicKey, key.signature]
      );
      if (!inserted.rows[0]) return reply.code(409).send(apiError("client_key_present", "This grant already has a Noise key."));
      await queueNextGrantPolicy(connection, grant.id);
      await audit(connection, grant.user_id, "grant.client_key_attached", grant.id, {});
      await connection.query("COMMIT");
      committed = true;
      return reply.header("cache-control", "no-store").send({ ok: true, grant_id: grant.id });
    } finally {
      try {
        if (!committed) await connection.query("ROLLBACK");
      } finally {
        connection.release();
      }
    }
  });
}
