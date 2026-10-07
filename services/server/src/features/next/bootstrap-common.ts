// Shared pieces of the next control plane's collection bootstrap routes (cloud copy
// and private): device proofs, current-identity and membership checks under locks,
// bounded transactions, enrolment lookups and refusals.
import { verify } from "node:crypto";
import type { FastifyReply } from "fastify";
import type { DatabaseConnection, DatabasePool } from "../../database-types.js";
import { apiError } from "../../platform/http-errors.js";
import { ed25519PublicKeyObject } from "./policy-keys.js";
import type { PolicyOp, RegisteredDeviceKind } from "./policy-wire.js";

/** Service devices belong to no account (policy.md: hosted and escrow enrol with the zero account). */
export const SERVICE_ACCOUNT = "00000000-0000-0000-0000-000000000000";
export const NIL = SERVICE_ACCOUNT;

export interface Proof { device_id: string; challenge: string; sig: string }
export interface Device { sign_pk: Buffer; kem_pk: Buffer; noise_pk: Buffer; kind: RegisteredDeviceKind }
export type Connector = { id: string; user_id: string };
/** PostgreSQL lock_timeout or statement_timeout: answer busy (fail closed), never the driver error. */
export const isLockTimeout = (error: unknown) => ["55P03", "57014"].includes(String((error as { code?: unknown } | null)?.code));

export class CreateError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}

export const lock = (client: DatabaseConnection, collection: string) =>
  client.query("SELECT pg_advisory_xact_lock(hashtextextended($1::uuid::text, 20261005))", [collection]);

/** Verify a device's signature over `digest` and consume its challenge. */
export async function authenticate(client: DatabaseConnection, body: Proof, connector: Connector, digest: (challenge: Uint8Array) => Uint8Array): Promise<Device> {
  const device = (await client.query<Device>(
    "SELECT sign_pk, kem_pk, noise_pk, kind FROM next_devices WHERE id = $1 AND connector_id = $2 AND user_id = $3",
    [body.device_id, connector.id, connector.user_id]
  )).rows[0];
  const challenge = Buffer.from(body.challenge, "hex");
  if (!device || !verify(null, digest(challenge), ed25519PublicKeyObject(device.sign_pk), Buffer.from(body.sig, "hex"))) throw new CreateError(403, "invalid_proof");
  const used = await client.query(
    "UPDATE next_device_challenges SET used_at = now() WHERE challenge = $1 AND connector_id = $2 AND used_at IS NULL AND expires_at > now()",
    [challenge, connector.id]
  );
  if (used.rowCount !== 1) throw new CreateError(403, "invalid_proof");
  return device;
}

/**
 * The connector, account and device are still current, with the exact keys
 * authenticated in phase 1; locked until the transaction ends, so a revocation,
 * suspension or device removal either happened before (and is refused here) or waits.
 */
export async function currentIdentity(client: DatabaseConnection, connector: Connector, deviceId: string, device: Device): Promise<void> {
  const row = await client.query(
    `SELECT 1 FROM connectors c JOIN users u ON u.id = c.user_id
       JOIN next_devices d ON d.connector_id = c.id AND d.user_id = u.id
     WHERE c.id = $1 AND u.id = $2 AND d.id = $3 AND c.revoked_at IS NULL AND u.suspended_at IS NULL
       AND d.sign_pk = $4 AND d.kem_pk = $5 AND d.noise_pk = $6 AND d.kind = $7
     FOR SHARE OF c, u, d`,
    [connector.id, connector.user_id, deviceId, device.sign_pk, device.kem_pk, device.noise_pk, device.kind]
  );
  if (!row.rows.length) throw new CreateError(403, "identity_not_current");
}

/**
 * The signed-in session is still the account's current credential (not revoked, not
 * expired, same session epoch, account not suspended); share-locked until the
 * transaction ends, so a sign-out or suspension either happened before or waits.
 */
export async function currentSession(client: DatabaseConnection, session: string, user: string): Promise<void> {
  const row = await client.query(
    `SELECT 1 FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.id = $1 AND u.id = $2 AND s.revoked_at IS NULL AND s.expires_at > now()
       AND u.suspended_at IS NULL AND s.account_session_epoch = u.session_epoch
     FOR SHARE OF s, u`,
    [session, user]
  );
  if (!row.rows.length) throw new CreateError(403, "identity_not_current");
}

/** The account is still active; share-locked until the transaction ends. */
export async function currentAccount(client: DatabaseConnection, user: string): Promise<void> {
  const row = await client.query("SELECT 1 FROM users WHERE id = $1 AND suspended_at IS NULL FOR SHARE", [user]);
  if (!row.rows.length) throw new CreateError(403, "identity_not_current");
}

export async function inTransaction<T>(db: DatabasePool, run: (client: DatabaseConnection) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    // Bounded: no request waits on another's locks for long. Network calls never run
    // inside these transactions.
    await client.query("SET LOCAL lock_timeout = '5s'");
    // Every statement is bounded too: no history scan holds share locks for long.
    await client.query("SET LOCAL statement_timeout = '5s'");
    const result = await run(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export const enrolOp = (device: string, account: string, d: { kind: RegisteredDeviceKind | "hosted" | "escrow"; sign_pk: Buffer; kem_pk: Buffer; noise_pk: Buffer }): PolicyOp => ({
  op: "device-enrol", device, account, kind: d.kind, signPublicKey: d.sign_pk, kemPublicKey: d.kem_pk, noisePublicKey: d.noise_pk
});

/** The outbox row that enrols `device` in `collection`, if any (any keys, any account). */
export const ENROLMENT = `SELECT o.ops, b.seq, b.item, b.state FROM next_policy_outbox o
  LEFT JOIN next_policy_batches b ON b.id = o.batch_id
  WHERE o.collection_id = $1 AND o.ops->'ops' @> $2::jsonb ORDER BY o.id LIMIT 1`;
export const enrolmentKey = (device: string) => JSON.stringify([{ op: "device-enrol", device }]);
/** The whole immutable enrolment tuple: device, account, kind and all three keys. */
export const exactEnrolment = (device: string, account: string, d: Device) => JSON.stringify([{
  op: "device-enrol", device, account, kind: d.kind,
  signPublicKey: { $hex: d.sign_pk.toString("hex") },
  kemPublicKey: { $hex: d.kem_pk.toString("hex") },
  noisePublicKey: { $hex: d.noise_pk.toString("hex") }
}]);

/** A historical enrolment is never current once the device has been revoked. */
export async function refuseRevoked(client: DatabaseConnection, collection: string, device: string): Promise<void> {
  const revoked = await client.query(
    "SELECT 1 FROM next_policy_outbox WHERE collection_id = $1 AND ops->'ops' @> $2::jsonb LIMIT 1",
    [collection, JSON.stringify([{ op: "device-revoke", device }])]
  );
  if (revoked.rows.length) throw new CreateError(409, "device_revoked");
}

export function refuse(reply: FastifyReply, error: unknown, message: string) {
  if (error instanceof CreateError) {
    const status = error.status === 502 ? 503 : error.status;
    return reply.code(status).send(apiError(error.code, message));
  }
  if (isLockTimeout(error)) return reply.code(503).send(apiError("busy", message));
  throw error;
}

/**
 * The account is a current member of the collection: its latest effective membership
 * op (outbox order, then op order within the batch) is a member-set acknowledged by
 * the log. A member-remove is effective even while pending; a pending member-set is
 * not. One row at most, projected in SQL.
 */
export async function currentMember(client: DatabaseConnection, collection: string, account: string): Promise<void> {
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
    [collection, JSON.stringify([{ op: "member-set", account }]), JSON.stringify([{ op: "member-remove", account }]), account]
  );
  if (latest.rows[0]?.op !== "member-set") throw new CreateError(409, "not_member");
}
