// Role-0 log token refresh for an enrolled device of a synced collection (a daemon's
// synced runtime renews its log credential every 15 minutes). Private and cloud-copy
// collections alike. This is a device credential only. It is not membership,
// approval or admission: it never enrols, re-enrols or reactivates anything, and the
// log service enforces the collection's current ACL on every RPC.
//
// POST /v1/next/collections/:id/log-token {device_id, challenge, sig}, with connector
// auth plus the device's signature over
// H("mdbase/v1/collection-log-token", cbor[challenge, connector, device, collection]),
// using a fresh single-use challenge. Everything is checked and the token minted in
// one transaction under share locks (connector, account, device, collection):
// - the connector, account and device are current, with the device's exact keys;
// - the collection is a current synced collection on the next runtime (not left);
// - the account is a current member: its latest effective membership op (outbox
//   order, then op order) is an acknowledged member-set; a member-remove counts even
//   while pending (one projected row, statement-bounded);
// - an enrolment of exactly this device (account, kind, sign/KEM/Noise keys) is in
//   an appended policy batch: acknowledged by the log, not merely queued;
// - no device-revoke for this device exists, appended or pending.
// The answer is only `{token, expires_at}`: no keys, no log URL.
import { verify } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { DatabaseConnection, DatabasePool } from "../../database-types.js";
import { apiError } from "../../platform/http-errors.js";
import { CreateError } from "./bootstrap-common.js";
import { requireInstallationScope } from "./installation-scope.js";
import { requireInstallationDeviceConnector } from "../../platform/request-authentication.js";
import { LOG_TOKEN_LIFETIME_MS, type LogServiceClient } from "./log-service-client.js";
import { ed25519PublicKeyObject } from "./policy-keys.js";
import { domainHash, encodeCbor, uuidBytes, type RegisteredDeviceKind } from "./policy-wire.js";

const NIL = "00000000-0000-0000-0000-000000000000";

interface Body { device_id: string; challenge: string; sig: string }
interface Device { sign_pk: Buffer; kem_pk: Buffer; noise_pk: Buffer; kind: RegisteredDeviceKind }

class Refused extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}

/** `H("mdbase/v1/collection-log-token", cbor[challenge, connector, device, collection])`. */
export function collectionLogTokenDigest(input: { challenge: Uint8Array; connector: string; device: string; collection: string }): Uint8Array {
  return domainHash("mdbase/v1/collection-log-token", encodeCbor([input.challenge, uuidBytes(input.connector), uuidBytes(input.device), uuidBytes(input.collection)]));
}

// Lock and statement timeouts fail closed as a retryable refusal.
const isLockTimeout = (error: unknown) => ["55P03", "57014"].includes(String((error as { code?: unknown } | null)?.code));

export function registerCollectionLogTokenRoute(app: FastifyInstance, options: {
  db: DatabasePool; log: Pick<LogServiceClient, "mintToken">; now?: () => number;
}): void {
  const uuid = { type: "string", pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$" };
  app.post<{ Params: { id: string }; Body: Body }>("/v1/next/collections/:id/log-token", {
    bodyLimit: 4096,
    config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
    schema: {
      params: { type: "object", required: ["id"], properties: { id: uuid } },
      body: {
        type: "object", additionalProperties: false, required: ["device_id", "challenge", "sig"],
        properties: { device_id: uuid, challenge: { type: "string", pattern: "^[0-9a-f]{64}$" }, sig: { type: "string", pattern: "^[0-9a-f]{128}$" } }
      }
    }
  }, async (request, reply) => {
    reply.header("cache-control", "no-store");
    const connector = await requireInstallationDeviceConnector(request, reply, options.db);
    if (!connector) return reply;
    const collection = request.params.id.toLowerCase();
    const device = request.body.device_id.toLowerCase();
    if (collection === NIL || device === NIL) return reply.code(400).send(apiError("invalid_request", "Nil identifiers are not accepted."));
    const client = await options.db.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL lock_timeout = '5s'");
      await client.query("SET LOCAL statement_timeout = '5s'");
      const answer = await refresh(client, connector, collection, device, request.body, options);
      await client.query("COMMIT");
      return answer;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      if (error instanceof Refused || error instanceof CreateError) return reply.code(error.status).send(apiError(error.code, "No log token for this device and collection."));
      if (isLockTimeout(error)) return reply.code(503).send(apiError("busy", "Retry with a fresh proof."));
      throw error;
    } finally {
      client.release();
    }
  });
}

async function refresh(
  client: DatabaseConnection,
  connector: { id: string; user_id: string; installation_device_id?:string },
  collection: string,
  deviceId: string,
  body: Body,
  options: { log: Pick<LogServiceClient, "mintToken">; now?: () => number }
): Promise<{ token: string; expires_at: number }> {
  if (connector.installation_device_id && connector.installation_device_id!==deviceId) throw new Refused(403,"invalid_proof");
  await requireInstallationScope(client,connector,collection);
  // Proof, then the single-use challenge.
  const device = (await client.query<Device>(
    "SELECT sign_pk, kem_pk, noise_pk, kind FROM next_devices WHERE id = $1 AND connector_id = $2 AND user_id = $3",
    [deviceId, connector.id, connector.user_id]
  )).rows[0];
  const challenge = Buffer.from(body.challenge, "hex");
  const digest = collectionLogTokenDigest({ challenge, connector: connector.id, device: deviceId, collection });
  if (!device || !verify(null, digest, ed25519PublicKeyObject(device.sign_pk), Buffer.from(body.sig, "hex"))) {
    throw new Refused(403, "invalid_proof");
  }
  const used = await client.query(
    "UPDATE next_device_challenges SET used_at = now() WHERE challenge = $1 AND connector_id = $2 AND used_at IS NULL AND expires_at > now()",
    [challenge, connector.id]
  );
  if (used.rowCount !== 1) throw new Refused(403, "invalid_proof");
  // Current identity, exact keys, locked through the mint.
  const identity = await client.query(
    `SELECT 1 FROM connectors c JOIN users u ON u.id = c.user_id
       JOIN next_devices d ON d.connector_id = c.id AND d.user_id = u.id
     WHERE c.id = $1 AND u.id = $2 AND d.id = $3 AND c.revoked_at IS NULL AND u.suspended_at IS NULL
       AND d.sign_pk = $4 AND d.kem_pk = $5 AND d.noise_pk = $6 AND d.kind = $7
     FOR SHARE OF c, u, d`,
    [connector.id, connector.user_id, deviceId, device.sign_pk, device.kem_pk, device.noise_pk, device.kind]
  );
  if (!identity.rows.length) throw new Refused(403, "identity_not_current");
  // A current synced collection served by the next runtime.
  const current = await client.query(
    "SELECT 1 FROM next_collections WHERE collection_id = $1 AND runtime = 'next' AND left_sync_at IS NULL FOR SHARE",
    [collection]
  );
  if (!current.rows.length) throw new Refused(409, "not_current");
  // An acknowledged enrolment of exactly this device for this account.
  const tuple = JSON.stringify([{
    op: "device-enrol", device: deviceId, account: connector.user_id, kind: device.kind,
    signPublicKey: { $hex: device.sign_pk.toString("hex") },
    kemPublicKey: { $hex: device.kem_pk.toString("hex") },
    noisePublicKey: { $hex: device.noise_pk.toString("hex") }
  }]);
  const enrolled = await client.query(
    `SELECT 1 FROM next_policy_outbox o JOIN next_policy_batches b ON b.id = o.batch_id
     WHERE o.collection_id = $1 AND b.state = 'appended' AND o.ops->'ops' @> $2::jsonb LIMIT 1`,
    [collection, tuple]
  );
  if (!enrolled.rows.length) throw new Refused(409, "not_enrolled");
  // The account is a current member: its latest effective membership op, in outbox
  // order then op order within the batch, is a member-set acknowledged by the log.
  // A member-remove is effective even while pending; a pending member-set is not.
  // One row at most, projected in SQL.
  const latest = await client.query<{ op: string }>(
    `SELECT e.value->>'op' AS op
       FROM next_policy_outbox o
       LEFT JOIN next_policy_batches b ON b.id = o.batch_id
       CROSS JOIN LATERAL jsonb_array_elements(o.ops->'ops') WITH ORDINALITY AS e(value, ord)
      WHERE o.collection_id = $1
        AND (o.ops->'ops' @> $2::jsonb OR o.ops->'ops' @> $3::jsonb)
        AND e.value->>'account' = $4
        AND (e.value->>'op' = 'member-remove' OR (e.value->>'op' = 'member-set' AND b.state = 'appended'))
      ORDER BY o.id DESC, e.ord DESC
      LIMIT 1`,
    [collection, JSON.stringify([{ op: "member-set", account: connector.user_id }]),
      JSON.stringify([{ op: "member-remove", account: connector.user_id }]), connector.user_id]
  );
  const member = latest.rows[0]?.op === "member-set";
  if (!member) throw new Refused(409, "not_member");
  const revoked = await client.query(
    "SELECT 1 FROM next_policy_outbox WHERE collection_id = $1 AND ops->'ops' @> $2::jsonb LIMIT 1",
    [collection, JSON.stringify([{ op: "device-revoke", device: deviceId }])]
  );
  if (revoked.rows.length) throw new Refused(409, "device_revoked");
  const expiresAt = (options.now ?? Date.now)() + LOG_TOKEN_LIFETIME_MS;
  return {
    token: options.log.mintToken({ device: deviceId, signPublicKey: device.sign_pk, collection, expiresAt }),
    expires_at: expiresAt
  };
}
