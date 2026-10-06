// The account key (AK1, mdbase-next docs/ship/interfaces/2026-10-06-private-account-key.md
// §5): per-account storage for private (e2e) multi-device enrolment. Mounted only with
// MDBASE_NEXT_PRIVATE_BOOTSTRAP=1 and an authentication rate-limit secret.
//
// - `GET /v1/next/account-key`: the account's mode and, in password mode, its sealed
//   bundle. The device proof travels in headers (a GET has no body). Rate-limited per
//   account (persistent, escalating) as well as per IP: the bundle is guessable offline
//   if the password is weak, so fetches are scarce and audited.
// - `PUT /v1/next/account-key`: create, re-wrap (same key id: a password change) or,
//   only from strict mode or with no bundle, rotate (a new key id). Compare-and-set on
//   the version.
// - `POST /v1/next/account-key/strict`: delete the bundle, record strict mode, and queue a
//   `device-revoke` for every active recovery device of the account in every current
//   private collection. Each collection's keyed devices then rekey it out (replica).
// - `POST /v1/next/collections/:id/private/account-key-device`: enrol the account's
//   recovery device of that collection (kind `recovery`, all-zero Noise key) for a
//   member account (any role: a viewer's devices need the key to read), with a
//   proof of possession over the complete public tuple by the recovery signing key.
//
// The server never sees the account secret or the password, never decrypts a bundle,
// and never keys a device: a device keys itself from the account key, in the log.
import { verify } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { AuthRateLimiter, type AuthRateLimitRule } from "../../auth-rate-limit.js";
import type { DatabaseConnection, DatabasePool } from "../../database-types.js";
import { apiError } from "../../platform/http-errors.js";
import { requireConnector } from "../../platform/request-authentication.js";
import {
  authenticate, CreateError, currentIdentity, currentMember, ENROLMENT, enrolmentKey, inTransaction, lock, NIL, refuse, refuseRevoked,
  type Connector, type Device, type Proof
} from "./bootstrap-common.js";
import type { LogServiceClient } from "./log-service-client.js";
import { ed25519PublicKeyObject, type NextControlPlaneConfig } from "./policy-keys.js";
import { queueNextPolicy, type PolicyEmitter } from "./policy-outbox.js";
import { decodeCbor, domainHash, encodeCbor, uuidBytes, type Decoded } from "./policy-wire.js";

const MAX_BUNDLE_BYTES = 512;
const ZERO_NOISE = Buffer.alloc(32);
/** Ten fetches an hour per account, then blocks from 15 minutes doubling to a day. */
export const ACCOUNT_KEY_FETCH_LIMIT: AuthRateLimitRule = { maxAttempts: 10, windowSeconds: 3600, baseBlockSeconds: 900, maxBlockSeconds: 86_400 };
/** Writes (re-wrap, rotate, strict) are rarer still. */
export const ACCOUNT_KEY_WRITE_LIMIT: AuthRateLimitRule = { maxAttempts: 10, windowSeconds: 86_400, baseBlockSeconds: 3600, maxBlockSeconds: 86_400 };

/** `H("mdbase/v1/account-key-fetch", cbor[challenge, connector, device, account])`. */
export function accountKeyFetchDigest(i: { challenge: Uint8Array; connector: string; device: string; account: string }): Uint8Array {
  return domainHash("mdbase/v1/account-key-fetch", encodeCbor([i.challenge, uuidBytes(i.connector), uuidBytes(i.device), uuidBytes(i.account)]));
}

/** `H("mdbase/v1/account-key-put", cbor[challenge, connector, device, account, expected_version, key_id, bundle])`. */
export function accountKeyPutDigest(i: {
  challenge: Uint8Array; connector: string; device: string; account: string; expectedVersion: number; keyId: Uint8Array; bundle: Uint8Array;
}): Uint8Array {
  return domainHash("mdbase/v1/account-key-put", encodeCbor([
    i.challenge, uuidBytes(i.connector), uuidBytes(i.device), uuidBytes(i.account), i.expectedVersion, i.keyId, i.bundle
  ]));
}

/** `H("mdbase/v1/account-key-strict", cbor[challenge, connector, device, account, expected_version])`. */
export function accountKeyStrictDigest(i: { challenge: Uint8Array; connector: string; device: string; account: string; expectedVersion: number }): Uint8Array {
  return domainHash("mdbase/v1/account-key-strict", encodeCbor([
    i.challenge, uuidBytes(i.connector), uuidBytes(i.device), uuidBytes(i.account), i.expectedVersion
  ]));
}

/** `H("mdbase/v1/account-key-device", cbor[challenge, connector, device, collection, recovery_device, sign_pk, kem_pk])`, by the caller's device. */
export function accountKeyDeviceDigest(i: {
  challenge: Uint8Array; connector: string; device: string; collection: string; recoveryDevice: string; signPk: Uint8Array; kemPk: Uint8Array;
}): Uint8Array {
  return domainHash("mdbase/v1/account-key-device", encodeCbor([
    i.challenge, uuidBytes(i.connector), uuidBytes(i.device), uuidBytes(i.collection), uuidBytes(i.recoveryDevice), i.signPk, i.kemPk
  ]));
}

/**
 * Proof of possession, by the recovery signing key, over the complete recovery tuple:
 * `H("mdbase/v1/account-key-enrol", cbor[challenge, collection, recovery_device, account, sign_pk, kem_pk, noise_pk])`.
 */
export function accountKeyEnrolDigest(i: {
  challenge: Uint8Array; collection: string; recoveryDevice: string; account: string; signPk: Uint8Array; kemPk: Uint8Array;
}): Uint8Array {
  return domainHash("mdbase/v1/account-key-enrol", encodeCbor([
    i.challenge, uuidBytes(i.collection), uuidBytes(i.recoveryDevice), uuidBytes(i.account), i.signPk, i.kemPk, ZERO_NOISE
  ]));
}

/** The recovery device ID of a collection: first 16 bytes of `H("mdbase/v1/recovery-id", collection ‖ sign_pk)`. */
export function recoveryDeviceId(collection: string, signPk: Uint8Array): string {
  const h = Buffer.from(domainHash("mdbase/v1/recovery-id", Buffer.concat([uuidBytes(collection), signPk]))).subarray(0, 16).toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * The closed AK1 v1 bundle shape (sizes only; the server cannot and does not check the
 * ciphertext): `{0: 1, 1: [1, m, t, p, salt16], 2: nonce24, 3: ct48, 4: key_id32}`.
 */
export function checkBundleShape(bundle: Uint8Array, keyId: Uint8Array): boolean {
  if (bundle.length < 1 || bundle.length > MAX_BUNDLE_BYTES || keyId.length !== 32) return false;
  let value: Decoded;
  try {
    value = decodeCbor(bundle);
  } catch {
    return false;
  }
  if (!(value instanceof Map) || value.size !== 5 || [...value.keys()].join() !== "0,1,2,3,4") return false;
  const bytes = (v: Decoded | undefined, n: number) => v instanceof Uint8Array && v.length === n;
  const kdf = value.get(1);
  const int = (v: Decoded | undefined) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
  return value.get(0) === 1
    && Array.isArray(kdf) && kdf.length === 5 && kdf[0] === 1 && int(kdf[1]) && int(kdf[2]) && int(kdf[3]) && bytes(kdf[4], 16)
    && bytes(value.get(2), 24) && bytes(value.get(3), 48) && bytes(value.get(4), 32)
    && Buffer.from(value.get(4) as Uint8Array).equals(Buffer.from(keyId));
}

type Row = { mode: "password" | "strict"; version: string; key_id: Buffer | null; bundle: Buffer | null };
const accountRow = (client: DatabaseConnection, user: string, lockMode: "UPDATE" | "SHARE") =>
  client.query<Row>(`SELECT mode, version, key_id, bundle FROM next_account_keys WHERE user_id = $1 FOR ${lockMode}`, [user]).then((r) => r.rows[0]);

async function currentPrivate(client: DatabaseConnection, collection: string): Promise<void> {
  const current = await client.query(
    "SELECT 1 FROM next_collections WHERE collection_id = $1 AND sync = 'private' AND runtime = 'next' AND left_sync_at IS NULL FOR SHARE",
    [collection]
  );
  if (!current.rows.length) throw new CreateError(409, "not_current_private");
}

/** The exact recovery enrolment tuple. */
const exactRecoveryEnrolment = (device: string, account: string, signPk: Buffer, kemPk: Buffer) => JSON.stringify([{
  op: "device-enrol", device, account, kind: "recovery",
  signPublicKey: { $hex: signPk.toString("hex") }, kemPublicKey: { $hex: kemPk.toString("hex") }, noisePublicKey: { $hex: ZERO_NOISE.toString("hex") }
}]);

/** Active recovery devices of `account` in current private collections (enrolled, never revoked). */
const ACTIVE_RECOVERY = `SELECT DISTINCT o.collection_id::text AS collection, e.value->>'device' AS device
   FROM next_policy_outbox o
   JOIN next_collections c ON c.collection_id = o.collection_id
   CROSS JOIN LATERAL jsonb_array_elements(o.ops->'ops') e(value)
  WHERE c.sync = 'private' AND c.runtime = 'next' AND c.left_sync_at IS NULL
    AND e.value->>'op' = 'device-enrol' AND e.value->>'kind' = 'recovery' AND e.value->>'account' = $1
    AND NOT EXISTS (SELECT 1 FROM next_policy_outbox r WHERE r.collection_id = o.collection_id
                     AND r.ops->'ops' @> jsonb_build_array(jsonb_build_object('op', 'device-revoke', 'device', e.value->>'device')))
  ORDER BY 1, 2`;

export function registerAccountKeyRoutes(app: FastifyInstance, options: {
  db: DatabasePool; next: NextControlPlaneConfig; emitter: PolicyEmitter; rateLimitSecret: string;
  log: Pick<LogServiceClient, "controlItemAt">;
}): void {
  if (!options.next.privateBootstrap) throw new Error("account key routes need MDBASE_NEXT_PRIVATE_BOOTSTRAP=1");
  const limiter = new AuthRateLimiter(options.db, options.rateLimitSecret);
  const uuid = { type: "string", pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$" };
  const hex32 = { type: "string", pattern: "^[0-9a-f]{64}$" };
  const proof = { device_id: uuid, challenge: hex32, sig: { type: "string", pattern: "^[0-9a-f]{128}$" } };
  const version = { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
  const limited = { bodyLimit: 4096, config: { rateLimit: { max: 6, timeWindow: "1 minute" } } };

  /** Consume one attempt of `rule` for the account; answers 429 when blocked. */
  async function allowed(scope: string, account: string, rule: AuthRateLimitRule): Promise<number | null> {
    const decision = await limiter.consume(scope, account, rule);
    return decision.allowed ? null : decision.retryAfterSeconds;
  }

  /** Proof, current connector/account/device; the device must be the caller's own. */
  async function proven(client: DatabaseConnection, body: Proof, connector: Connector, digest: (c: Uint8Array) => Uint8Array): Promise<Device> {
    const device = await authenticate(client, body, connector, digest);
    await currentIdentity(client, connector, body.device_id, device);
    return device;
  }

  // ---- Fetch: the proof is in headers; a GET has no body. ----
  app.get("/v1/next/account-key", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (request, reply) => {
    reply.header("cache-control", "no-store");
    const connector = await requireConnector(request, reply, options.db);
    if (!connector) return reply;
    const h = (name: string) => {
      const v = request.headers[name];
      return typeof v === "string" ? v.toLowerCase() : "";
    };
    const body = { device_id: h("x-mdbase-device-id"), challenge: h("x-mdbase-challenge"), sig: h("x-mdbase-signature") };
    if (!/^[0-9a-f-]{36}$/.test(body.device_id) || !/^[0-9a-f]{64}$/.test(body.challenge) || !/^[0-9a-f]{128}$/.test(body.sig) || body.device_id === NIL) {
      return reply.code(400).send(apiError("invalid_request", "A device proof is required in the x-mdbase-* headers."));
    }
    const account = connector.user_id;
    const digest = (challenge: Uint8Array) => accountKeyFetchDigest({ challenge, connector: connector.id, device: body.device_id, account });
    try {
      // The proof is checked (and its challenge consumed) first, so only a signed-in
      // device of the account spends the account's fetch budget.
      const device = await inTransaction(options.db, (client) => proven(client, body, connector, digest));
      const retry = await allowed("next-account-key-fetch", account, ACCOUNT_KEY_FETCH_LIMIT);
      if (retry !== null) {
        reply.header("retry-after", String(retry));
        return reply.code(429).send(apiError("rate_limited", "Too many account key fetches; try again later."));
      }
      const row = await inTransaction(options.db, async (client) => {
        await currentIdentity(client, connector, body.device_id, device);
        return accountRow(client, account, "SHARE");
      });
      request.log.info({ event: "next_account_key_fetch", account, device: body.device_id, mode: row?.mode ?? "none" }, "account key fetched");
      if (!row) return { mode: "none", version: 0 };
      return {
        mode: row.mode, version: Number(row.version),
        ...(row.mode === "password" ? { key_id: row.key_id!.toString("hex"), bundle: row.bundle!.toString("hex") } : {})
      };
    } catch (error) {
      return refuse(reply, error, "The account key was not fetched; retry with a fresh proof.");
    }
  });

  // ---- Put: create, re-wrap (same key id) or rotate (only from strict or none). ----
  app.put<{ Body: Proof & { expected_version: number; key_id: string; bundle: string } }>("/v1/next/account-key", {
    ...limited,
    schema: { body: {
      type: "object", additionalProperties: false, required: ["device_id", "challenge", "sig", "expected_version", "key_id", "bundle"],
      properties: { ...proof, expected_version: version, key_id: hex32, bundle: { type: "string", pattern: "^([0-9a-f]{2}){1,512}$" } }
    } }
  }, async (request, reply) => {
    reply.header("cache-control", "no-store");
    const connector = await requireConnector(request, reply, options.db);
    if (!connector) return reply;
    const body = { ...request.body, device_id: request.body.device_id.toLowerCase() };
    const keyId = Buffer.from(body.key_id, "hex");
    const bundle = Buffer.from(body.bundle, "hex");
    if (body.device_id === NIL) return reply.code(400).send(apiError("invalid_request", "Nil identifiers are not accepted."));
    if (!checkBundleShape(bundle, keyId)) return reply.code(400).send(apiError("invalid_bundle", "Not an AK1 v1 account key bundle for this key id."));
    const account = connector.user_id;
    const digest = (challenge: Uint8Array) => accountKeyPutDigest({
      challenge, connector: connector.id, device: body.device_id, account, expectedVersion: body.expected_version, keyId, bundle
    });
    try {
      const device = await inTransaction(options.db, (client) => proven(client, body, connector, digest));
      const retry = await allowed("next-account-key-write", account, ACCOUNT_KEY_WRITE_LIMIT);
      if (retry !== null) {
        reply.header("retry-after", String(retry));
        return reply.code(429).send(apiError("rate_limited", "Too many account key changes; try again later."));
      }
      const next = await inTransaction(options.db, async (client) => {
        await currentIdentity(client, connector, body.device_id, device);
        const row = await accountRow(client, account, "UPDATE");
        const current = row ? Number(row.version) : 0;
        if (current !== body.expected_version) throw new CreateError(409, "version_conflict");
        // A new key id while recovery devices of the old one may still be active is a
        // rotation without revocation: only from strict mode (or the first setup).
        if (row?.mode === "password" && !row.key_id!.equals(keyId)) throw new CreateError(409, "rotate_requires_strict");
        const version = current + 1;
        await client.query(
          `INSERT INTO next_account_keys (user_id, mode, version, key_id, bundle, updated_at) VALUES ($1, 'password', $2, $3, $4, now())
           ON CONFLICT (user_id) DO UPDATE SET mode = 'password', version = $2, key_id = $3, bundle = $4, updated_at = now()`,
          [account, version, keyId, bundle]
        );
        return version;
      });
      request.log.info({ event: "next_account_key_put", account, device: body.device_id, version: next }, "account key stored");
      return { mode: "password", version: next, key_id: body.key_id };
    } catch (error) {
      return refuse(reply, error, "The account key was not stored; fetch the current version and retry with a fresh proof.");
    }
  });

  // ---- Strict: no bundle, recovery devices revoked everywhere. ----
  app.post<{ Body: Proof & { expected_version: number } }>("/v1/next/account-key/strict", {
    ...limited,
    schema: { body: {
      type: "object", additionalProperties: false, required: ["device_id", "challenge", "sig", "expected_version"],
      properties: { ...proof, expected_version: version }
    } }
  }, async (request, reply) => {
    reply.header("cache-control", "no-store");
    const connector = await requireConnector(request, reply, options.db);
    if (!connector) return reply;
    const body = { ...request.body, device_id: request.body.device_id.toLowerCase() };
    if (body.device_id === NIL) return reply.code(400).send(apiError("invalid_request", "Nil identifiers are not accepted."));
    const account = connector.user_id;
    const digest = (challenge: Uint8Array) => accountKeyStrictDigest({
      challenge, connector: connector.id, device: body.device_id, account, expectedVersion: body.expected_version
    });
    let result: { version: number; revocations: Array<{ collection: string; device: string }> };
    try {
      const device = await inTransaction(options.db, (client) => proven(client, body, connector, digest));
      const retry = await allowed("next-account-key-write", account, ACCOUNT_KEY_WRITE_LIMIT);
      if (retry !== null) {
        reply.header("retry-after", String(retry));
        return reply.code(429).send(apiError("rate_limited", "Too many account key changes; try again later."));
      }
      result = await inTransaction(options.db, async (client) => {
        await currentIdentity(client, connector, body.device_id, device);
        const row = await accountRow(client, account, "UPDATE");
        const current = row ? Number(row.version) : 0;
        if (current !== body.expected_version) throw new CreateError(409, "version_conflict");
        const version = current + 1;
        await client.query(
          `INSERT INTO next_account_keys (user_id, mode, version, key_id, bundle, updated_at) VALUES ($1, 'strict', $2, NULL, NULL, now())
           ON CONFLICT (user_id) DO UPDATE SET mode = 'strict', version = $2, key_id = NULL, bundle = NULL, updated_at = now()`,
          [account, version]
        );
        // Enrolment of new recovery devices is refused from here on (mode check), so
        // this set cannot grow while the revocations are queued.
        const active = (await client.query<{ collection: string; device: string }>(ACTIVE_RECOVERY, [account])).rows;
        // Collection locks in a fixed order (the query's), as every route takes them.
        for (const collection of [...new Set(active.map((r) => r.collection))]) await lock(client, collection);
        for (const r of active) {
          if (!(await queueNextPolicy(client, r.collection, [{ op: "device-revoke", device: r.device }]))) {
            throw new CreateError(409, "not_current_private");
          }
        }
        return { version, revocations: active };
      });
    } catch (error) {
      return refuse(reply, error, "Strict mode was not set; fetch the current version and retry with a fresh proof.");
    }
    request.log.info({ event: "next_account_key_strict", account, device: body.device_id, revoked: result.revocations.length }, "account key strict mode");
    // Best effort: the outbox is durable and the emitter drains it regardless.
    for (const collection of new Set(result.revocations.map((r) => r.collection))) await options.emitter.drainCollection(collection).catch(() => undefined);
    return {
      mode: "strict", version: result.version,
      revocations: result.revocations.map((r) => ({ collection_id: r.collection, device_id: r.device }))
    };
  });

  // ---- Recovery-device enrolment for one private collection. ----
  app.post<{ Params: { id: string }; Body: Proof & { recovery_device: string; sign_pk: string; kem_pk: string; pop: string } }>(
    "/v1/next/collections/:id/private/account-key-device", {
      ...limited,
      schema: {
        params: { type: "object", required: ["id"], properties: { id: uuid } },
        body: {
          type: "object", additionalProperties: false, required: ["device_id", "challenge", "sig", "recovery_device", "sign_pk", "kem_pk", "pop"],
          properties: { ...proof, recovery_device: uuid, sign_pk: hex32, kem_pk: hex32, pop: { type: "string", pattern: "^[0-9a-f]{128}$" } }
        }
      }
    }, async (request, reply) => {
      reply.header("cache-control", "no-store");
      const connector = await requireConnector(request, reply, options.db);
      if (!connector) return reply;
      const collection = request.params.id.toLowerCase();
      const body = { ...request.body, device_id: request.body.device_id.toLowerCase(), recovery_device: request.body.recovery_device.toLowerCase() };
      const signPk = Buffer.from(body.sign_pk, "hex");
      const kemPk = Buffer.from(body.kem_pk, "hex");
      const account = connector.user_id;
      if (collection === NIL || body.device_id === NIL) return reply.code(400).send(apiError("invalid_request", "Nil identifiers are not accepted."));
      if (recoveryDeviceId(collection, signPk) !== body.recovery_device) {
        return reply.code(400).send(apiError("invalid_recovery_device", "The recovery device ID is not derived from its signing key."));
      }
      const challenge = Buffer.from(body.challenge, "hex");
      const pop = accountKeyEnrolDigest({ challenge, collection, recoveryDevice: body.recovery_device, account, signPk, kemPk });
      let popOk = false;
      try {
        popOk = verify(null, pop, ed25519PublicKeyObject(signPk), Buffer.from(body.pop, "hex"));
      } catch {
        popOk = false;
      }
      if (!popOk) return reply.code(403).send(apiError("invalid_proof", "The recovery key's proof of possession does not verify."));
      const digest = (c: Uint8Array) => accountKeyDeviceDigest({
        challenge: c, connector: connector.id, device: body.device_id, collection, recoveryDevice: body.recovery_device, signPk, kemPk
      });
      const exact = exactRecoveryEnrolment(body.recovery_device, account, signPk, kemPk);
      const checks = async (client: DatabaseConnection, d: Device) => {
        await currentIdentity(client, connector, body.device_id, d);
        await currentPrivate(client, collection);
        await currentMember(client, collection, account);
        await refuseRevoked(client, collection, body.device_id);
        await refuseRevoked(client, collection, body.recovery_device);
        const row = await accountRow(client, account, "SHARE");
        if (row?.mode !== "password") throw new CreateError(409, row ? "strict_mode" : "no_account_key");
      };
      let device: Device;
      try {
        device = await inTransaction(options.db, async (client) => {
          await lock(client, collection);
          const caller = await authenticate(client, body, connector, digest);
          await checks(client, caller);
          const prior = (await client.query(ENROLMENT, [collection, enrolmentKey(body.recovery_device)])).rows[0];
          if (prior) {
            if (!(await client.query(ENROLMENT, [collection, exact])).rows.length) throw new CreateError(409, "device_enrolled_differently");
          } else if (!(await queueNextPolicy(client, collection, [{
            op: "device-enrol", device: body.recovery_device, account, kind: "recovery",
            signPublicKey: signPk, kemPublicKey: kemPk, noisePublicKey: ZERO_NOISE
          }]))) {
            throw new CreateError(409, "not_current_private");
          }
          return caller;
        });
      } catch (error) {
        return refuse(reply, error, "The account key device was not enrolled; retry with a fresh proof.");
      }
      try {
        await options.emitter.drainCollection(collection);
        const row = (await options.db.query<{ seq: string | null; item: Buffer | null; state: string | null }>(ENROLMENT, [collection, exact])).rows[0];
        const seq = row?.seq === null || row?.seq === undefined ? null : Number(row.seq);
        const external = seq !== null && row?.state === "appended" ? await options.log.controlItemAt(collection, seq) : null;
        if (seq === null || !row?.item || !external || !row.item.equals(Buffer.from(external))) throw new CreateError(503, "not_ready");
        return await inTransaction(options.db, async (client) => {
          await checks(client, device);
          // Appended is not keyed: the caller keys it in the log after checking the
          // enrolment carries exactly the keys it derived (SEC-014).
          return { collection_id: collection, device_id: body.recovery_device, enrolled_at: seq };
        });
      } catch (error) {
        if (error instanceof CreateError && error.status !== 503) return refuse(reply, error, "The private collection is not current for this device.");
        return reply.code(503).send(apiError("not_ready", "The enrolment is not verified; retry with a fresh proof."));
      }
    });
}

