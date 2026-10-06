// Cloud-copy collections on the next control plane (Callum's decision of 2026-10-06,
// which replaces the owner-only §7.1 keying for CLOUD COPY only; private collections
// are unchanged and never get here). Mounted only with MDBASE_NEXT_CLOUD_COPY_BOOTSTRAP=1.
//
// - Service-created (`POST /v1/next/collections/cloud-copy/service`): an account with
//   no user device gets a cloud copy. Genesis enrols the hosted and escrow service
//   devices only; hosted, the first member, generates the epoch key and wraps it for
//   hosted and escrow.
// - Owner-device (`POST /v1/next/collections/cloud-copy`): an owner's registered device
//   creates it; genesis also enrols that device, whose initial rekey keys everyone.
// - Device join (`POST /v1/next/collections/:id/devices`): a device registered under the
//   owner's authenticated connector is enrolled (control-signed); hosted, or escrow,
//   then wraps the current epoch key to it. Refused for anything but a current cloud
//   copy, so a private collection never enrols a device this way.
//
// The control plane never holds a collection key. Each deployment generates its own
// service device; the first committed record wins, and nothing is ever deleted on a
// failure path.
import { verify } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { DatabaseConnection, DatabasePool } from "../../database-types.js";
import { apiError } from "../../platform/http-errors.js";
import { requireConnector, requireSessionContext, requireUser } from "../../platform/request-authentication.js";
import { LOG_TOKEN_LIFETIME_MS, type LogServiceClient } from "./log-service-client.js";
import { ed25519PublicKeyObject, type NextControlPlaneConfig } from "./policy-keys.js";
import { queueNextPolicy, registerNextCollection, type PolicyEmitter } from "./policy-outbox.js";
import { domainHash, encodeCbor, uuidBytes, type PolicyOp } from "./policy-wire.js";
import { generateServiceDevice, loadServiceDevice, ServiceDeviceError, storeServiceDevice, type ServiceDeviceRecord } from "./service-devices.js";

/** Service devices belong to no account (policy.md: hosted and escrow enrol with the zero account). */
const SERVICE_ACCOUNT = "00000000-0000-0000-0000-000000000000";
const NIL = SERVICE_ACCOUNT;
const KINDS = ["hosted", "escrow"] as const;

interface Proof { device_id: string; challenge: string; sig: string }
interface Device { sign_pk: Buffer; kem_pk: Buffer; noise_pk: Buffer; kind: "desktop" | "cli" }
type Connector = { id: string; user_id: string };
/** PostgreSQL lock_timeout: another request holds the rows; answer busy, never the driver error. */
const isLockTimeout = (error: unknown) => (error as { code?: unknown } | null)?.code === "55P03";

class CreateError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}

/** `H("mdbase/v1/cloud-copy-create", cbor[challenge, connector, device, collection])`, signed by the owner's device. */
export function cloudCopyCreateDigest(input: { challenge: Uint8Array; connector: string; device: string; collection: string }): Uint8Array {
  return domainHash("mdbase/v1/cloud-copy-create", encodeCbor([input.challenge, uuidBytes(input.connector), uuidBytes(input.device), uuidBytes(input.collection)]));
}

/** `H("mdbase/v1/cloud-copy-join", cbor[challenge, connector, device, collection])`, signed by the joining device. */
export function cloudCopyJoinDigest(input: { challenge: Uint8Array; connector: string; device: string; collection: string }): Uint8Array {
  return domainHash("mdbase/v1/cloud-copy-join", encodeCbor([input.challenge, uuidBytes(input.connector), uuidBytes(input.device), uuidBytes(input.collection)]));
}

const lock = (client: DatabaseConnection, collection: string) =>
  client.query("SELECT pg_advisory_xact_lock(hashtextextended($1::uuid::text, 20261005))", [collection]);

/** Whether the collection already exists: false when free, true when this owner's cloud copy, else refused. */
async function existing(client: DatabaseConnection, collection: string, owner: string): Promise<boolean> {
  const row = (await client.query<{ owner_user_id: string; sync: string; left: boolean }>(
    "SELECT owner_user_id, sync, left_sync_at IS NOT NULL AS left FROM next_collections WHERE collection_id = $1 FOR UPDATE", [collection]
  )).rows[0];
  if (row && (row.owner_user_id !== owner || row.sync !== "cloud_copy" || row.left)) throw new CreateError(409, "collection_exists");
  if (!row) {
    // A local collection with this logical ID that belongs to someone else is never adopted.
    const other = await client.query("SELECT 1 FROM collections WHERE local_id = $1 AND user_id <> $2 AND removed_at IS NULL", [collection, owner]);
    if (other.rows.length) throw new CreateError(409, "collection_exists");
  }
  return Boolean(row);
}

/** The collection is still `owner`'s current cloud copy; share-locked until the transaction ends. */
async function currentCloudCopy(client: DatabaseConnection, collection: string, owner: string): Promise<void> {
  const current = await client.query(
    `SELECT 1 FROM next_collections WHERE collection_id = $1 AND owner_user_id = $2 AND sync = 'cloud_copy' AND left_sync_at IS NULL FOR SHARE`,
    [collection, owner]
  );
  if (!current.rows.length) throw new CreateError(409, "not_current_cloud_copy");
}

/** Verify a device's signature over `digest` and consume its challenge. */
async function authenticate(client: DatabaseConnection, body: Proof, connector: Connector, digest: (challenge: Uint8Array) => Uint8Array): Promise<Device> {
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
async function currentIdentity(client: DatabaseConnection, connector: Connector, deviceId: string, device: Device): Promise<void> {
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
async function currentSession(client: DatabaseConnection, session: string, user: string): Promise<void> {
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
async function currentAccount(client: DatabaseConnection, user: string): Promise<void> {
  const row = await client.query("SELECT 1 FROM users WHERE id = $1 AND suspended_at IS NULL FOR SHARE", [user]);
  if (!row.rows.length) throw new CreateError(403, "identity_not_current");
}

async function inTransaction<T>(db: DatabasePool, run: (client: DatabaseConnection) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    // Bounded: no request waits on another's locks for long. Network calls never run
    // inside these transactions.
    await client.query("SET LOCAL lock_timeout = '5s'");
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

const publicRecord = (record: ServiceDeviceRecord) => ({
  kind: record.kind, device_id: record.device_id,
  sign_pk: record.sign_pk.toString("hex"), kem_pk: record.kem_pk.toString("hex"), noise_pk: record.noise_pk.toString("hex")
});

const enrolOp = (device: string, account: string, d: { kind: "desktop" | "cli" | "hosted" | "escrow"; sign_pk: Buffer; kem_pk: Buffer; noise_pk: Buffer }): PolicyOp => ({
  op: "device-enrol", device, account, kind: d.kind, signPublicKey: d.sign_pk, kemPublicKey: d.kem_pk, noisePublicKey: d.noise_pk
});

/** The outbox row that enrols `device` in `collection`, if any (any keys, any account). */
const ENROLMENT = `SELECT o.ops, b.seq, b.item, b.state FROM next_policy_outbox o
  LEFT JOIN next_policy_batches b ON b.id = o.batch_id
  WHERE o.collection_id = $1 AND o.ops->'ops' @> $2::jsonb ORDER BY o.id LIMIT 1`;
const enrolmentKey = (device: string) => JSON.stringify([{ op: "device-enrol", device }]);
/** The whole immutable enrolment tuple: device, account, kind and all three keys. */
const exactEnrolment = (device: string, account: string, d: Device) => JSON.stringify([{
  op: "device-enrol", device, account, kind: d.kind,
  signPublicKey: { $hex: d.sign_pk.toString("hex") },
  kemPublicKey: { $hex: d.kem_pk.toString("hex") },
  noisePublicKey: { $hex: d.noise_pk.toString("hex") }
}]);

/** A historical enrolment is never current once the device has been revoked. */
async function refuseRevoked(client: DatabaseConnection, collection: string, device: string): Promise<void> {
  const revoked = await client.query(
    "SELECT 1 FROM next_policy_outbox WHERE collection_id = $1 AND ops->'ops' @> $2::jsonb LIMIT 1",
    [collection, JSON.stringify([{ op: "device-revoke", device }])]
  );
  if (revoked.rows.length) throw new CreateError(409, "device_revoked");
}

function refuse(reply: FastifyReply, error: unknown, message: string) {
  if (error instanceof CreateError || error instanceof ServiceDeviceError) {
    const status = error.status === 502 ? 503 : error.status;
    return reply.code(status).send(apiError(error.code, message));
  }
  if (isLockTimeout(error)) return reply.code(503).send(apiError("busy", message));
  throw error;
}

export function registerCloudCopyRoutes(app: FastifyInstance, options: {
  db: DatabasePool; next: NextControlPlaneConfig; emitter: PolicyEmitter;
  log: Pick<LogServiceClient, "controlItemAt" | "head" | "mintToken">; fetchImpl?: typeof fetch; now?: () => number;
  tailscaleAuth?: boolean;
}): void {
  const deployments = options.next.cloudCopyBootstrap;
  if (!deployments) throw new Error("cloud-copy routes need MDBASE_NEXT_CLOUD_COPY_BOOTSTRAP=1");
  const rootKeyId = Buffer.from(options.next.policyCert.root_key_id, "hex");
  const uuid = { type: "string", pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$" };
  const proof = { device_id: uuid, challenge: { type: "string", pattern: "^[0-9a-f]{64}$" }, sig: { type: "string", pattern: "^[0-9a-f]{128}$" } };
  const limited = { bodyLimit: 4096, config: { rateLimit: { max: 6, timeWindow: "1 minute" } } };
  /** Each deployment generates its own keys. Nothing is locked while they work. */
  const generateFor = (collection: string) =>
    Promise.all(KINDS.map((kind) => generateServiceDevice(deployments[kind], kind, collection, options.fetchImpl)));

  /** The exact bytes of a policy batch, as the log returns them at its position. */
  async function appendedBatch(collection: string, batch: { seq: string | number | null; item: Buffer | null; state: string | null } | undefined) {
    const seq = batch?.seq === null || batch?.seq === undefined ? null : Number(batch.seq);
    const external = seq !== null && batch?.state === "appended" ? await options.log.controlItemAt(collection, seq) : null;
    if (seq === null || !batch?.item || !external || !batch.item.equals(Buffer.from(external))) throw new CreateError(503, "not_ready");
    return { seq, item: batch.item };
  }

  async function appendedGenesis(collection: string) {
    await options.emitter.drainCollection(collection);
    const genesis = (await options.db.query<{ seq: string; item: Buffer; state: string }>(
      "SELECT seq, item, state FROM next_policy_batches WHERE collection_id = $1 AND seq = 1 ORDER BY id LIMIT 1", [collection]
    )).rows[0];
    return appendedBatch(collection, genesis);
  }

  async function loadRecords(client: DatabaseConnection, collection: string): Promise<ServiceDeviceRecord[]> {
    const records: ServiceDeviceRecord[] = [];
    for (const kind of KINDS) {
      const record = await loadServiceDevice(client, collection, { kind });
      if (!record) throw new CreateError(503, "not_ready");
      records.push(record);
    }
    return records;
  }

  const created = (collection: string, owner: string, head: { seq: number; chain: Uint8Array }, genesis: Buffer, records: ServiceDeviceRecord[]) => ({
    collection_id: collection, state: "cloud-copy", owner_account: owner,
    log_url: options.next.logService.url, head: { seq: head.seq, chain: Buffer.from(head.chain).toString("hex") },
    root_public_key: Buffer.from(options.next.rootPublicKey).toString("hex"), policy_cert: options.next.policyCert,
    genesis: { seq: 1, item: genesis.toString("hex") },
    service_devices: records.map(publicRecord)
  });

  const mint = (device: string, signPk: Buffer, collection: string) => {
    const expiresAt = (options.now ?? Date.now)() + LOG_TOKEN_LIFETIME_MS;
    return { device_id: device, token: options.log.mintToken({ device, signPublicKey: signPk, collection, expiresAt }), expires_at: expiresAt };
  };

  // ---- Service-created: the account, no device. ----
  app.post<{ Body: { collection_id: string } }>("/v1/next/collections/cloud-copy/service", {
    ...limited,
    schema: { body: { type: "object", additionalProperties: false, required: ["collection_id"], properties: { collection_id: uuid } } }
  }, async (request, reply) => {
    reply.header("cache-control", "no-store");
    // Session credentials are rechecked after every await; Tailscale identities have
    // no session row, so for them the account itself is.
    let user: { id: string };
    let current: (client: DatabaseConnection) => Promise<void>;
    if (options.tailscaleAuth) {
      const u = await requireUser(request, reply, options.db, true);
      if (!u) return reply;
      user = u;
      current = (client) => currentAccount(client, u.id);
    } else {
      const context = await requireSessionContext(request, reply, options.db);
      if (!context) return reply;
      user = context.user;
      current = (client) => currentSession(client, context.sessionId, context.user.id);
    }
    const collection = request.body.collection_id.toLowerCase();
    if (collection === NIL) return reply.code(400).send(apiError("invalid_request", "Nil identifiers are not accepted."));
    try {
      const exists = await inTransaction(options.db, async (client) => {
        await lock(client, collection);
        await current(client);
        return existing(client, collection, user.id);
      });
      if (!exists) {
        const generated = await generateFor(collection);
        await inTransaction(options.db, async (client) => {
          await lock(client, collection);
          await current(client);
          if (await existing(client, collection, user.id)) throw new CreateError(503, "not_ready");
          await registerNextCollection(client, {
            collectionId: collection, ownerUserId: user.id, runtime: "next", sync: "cloud_copy", rootKeyId,
            ops: [
              { op: "genesis", owner: user.id, root: rootKeyId, state: "cloud-copy" },
              { op: "member-set", account: user.id, role: "owner" },
              ...generated.map((record) => enrolOp(record.device_id, SERVICE_ACCOUNT, record))
            ]
          });
          for (const record of generated) await storeServiceDevice(client, collection, record);
        });
      }
    } catch (error) {
      return refuse(reply, error, "The cloud copy was not created; retry.");
    }
    try {
      const genesis = await appendedGenesis(collection);
      const head = await options.log.head(collection);
      return await inTransaction(options.db, async (client) => {
        await current(client);
        await currentCloudCopy(client, collection, user.id);
        // Hosted is the first member: it generates the epoch key and wraps it for
        // hosted and escrow. No user device is enrolled here.
        return { ...created(collection, user.id, head, genesis.item, await loadRecords(client, collection)), first_member: "hosted" };
      });
    } catch (error) {
      if (error instanceof CreateError && error.status !== 503) return refuse(reply, error, "The cloud copy is not current for this account.");
      return reply.code(503).send(apiError("not_ready", "The cloud copy outcome is not verified; retry."));
    }
  });

  // ---- Owner-device: a registered device of the owner creates it. ----
  app.post<{ Body: Proof & { collection_id: string } }>("/v1/next/collections/cloud-copy", {
    ...limited,
    schema: { body: {
      type: "object", additionalProperties: false, required: ["collection_id", "device_id", "challenge", "sig"],
      properties: { collection_id: uuid, ...proof }
    } }
  }, async (request, reply) => {
    reply.header("cache-control", "no-store");
    const connector = await requireConnector(request, reply, options.db);
    if (!connector) return reply;
    const body = { ...request.body, collection_id: request.body.collection_id.toLowerCase(), device_id: request.body.device_id.toLowerCase() };
    const collection = body.collection_id;
    if (collection === NIL || body.device_id === NIL) return reply.code(400).send(apiError("invalid_request", "Nil identifiers are not accepted."));
    const digest = (challenge: Uint8Array) => cloudCopyCreateDigest({ challenge, connector: connector.id, device: body.device_id, collection });
    let device: Device;
    try {
      // 1. Proof and ownership, consuming the challenge. No network call holds a lock.
      let exists: boolean;
      ({ device, exists } = await inTransaction(options.db, async (client) => {
        await lock(client, collection);
        const owner = await authenticate(client, body, connector, digest);
        return { device: owner, exists: await existing(client, collection, connector.user_id) };
      }));
      if (!exists) {
        const generated = await generateFor(collection);
        // 2. Recheck the identity and the collection, then register genesis and store
        // the records together. The first committed record wins.
        await inTransaction(options.db, async (client) => {
          await lock(client, collection);
          await currentIdentity(client, connector, body.device_id, device);
          // Created concurrently: the retry path rechecks the enrolled device.
          if (await existing(client, collection, connector.user_id)) throw new CreateError(503, "not_ready");
          await registerNextCollection(client, {
            collectionId: collection, ownerUserId: connector.user_id, runtime: "next", sync: "cloud_copy", rootKeyId,
            ops: [
              { op: "genesis", owner: connector.user_id, root: rootKeyId, state: "cloud-copy" },
              { op: "member-set", account: connector.user_id, role: "owner" },
              enrolOp(body.device_id, connector.user_id, device),
              ...generated.map((record) => enrolOp(record.device_id, SERVICE_ACCOUNT, record))
            ]
          });
          for (const record of generated) await storeServiceDevice(client, collection, record);
        });
      }
    } catch (error) {
      return refuse(reply, error, "The cloud copy was not created; retry with a fresh proof.");
    }
    try {
      // 3. Only an appended genesis whose exact bytes the log returns counts as created.
      const genesis = await appendedGenesis(collection);
      const head = await options.log.head(collection);
      // 4. After every await: the identity, the collection and the enrolment are
      // current, and stay locked until the token is minted.
      return await inTransaction(options.db, async (client) => {
        await currentIdentity(client, connector, body.device_id, device);
        await currentCloudCopy(client, collection, connector.user_id);
        await refuseRevoked(client, collection, body.device_id);
        // The requesting device must be the one the genesis enrolled, with the same keys.
        const enrolled = await client.query(
          `SELECT 1 FROM next_policy_outbox WHERE id = (SELECT min(id) FROM next_policy_outbox WHERE collection_id = $1)
             AND ops->'ops' @> $2::jsonb`,
          [collection, exactEnrolment(body.device_id, connector.user_id, device)]
        );
        if (!enrolled.rows.length) throw new CreateError(409, "collection_exists");
        const records = await loadRecords(client, collection);
        return {
          ...created(collection, connector.user_id, head, genesis.item, records),
          // Public identities enrolled by the genesis; advisory. Consumers compute the
          // legal recipient set from the verified log.
          rekey_recipients: [body.device_id, ...records.map((record) => record.device_id)],
          device: mint(body.device_id, device.sign_pk, collection)
        };
      });
    } catch (error) {
      if (error instanceof CreateError && error.status !== 503) return refuse(reply, error, "The cloud copy is not current for this device.");
      return reply.code(503).send(apiError("not_ready", "The cloud copy outcome is not verified; retry with a fresh proof."));
    }
  });

  // ---- Device join: the owner's registered device, approved by the authenticated account. ----
  app.post<{ Params: { id: string }; Body: Proof }>("/v1/next/collections/:id/devices", {
    ...limited,
    schema: {
      params: { type: "object", required: ["id"], properties: { id: uuid } },
      body: { type: "object", additionalProperties: false, required: ["device_id", "challenge", "sig"], properties: proof }
    }
  }, async (request, reply) => {
    reply.header("cache-control", "no-store");
    const connector = await requireConnector(request, reply, options.db);
    if (!connector) return reply;
    const collection = request.params.id.toLowerCase();
    const body = { ...request.body, device_id: request.body.device_id.toLowerCase() };
    if (collection === NIL || body.device_id === NIL) return reply.code(400).send(apiError("invalid_request", "Nil identifiers are not accepted."));
    const digest = (challenge: Uint8Array) => cloudCopyJoinDigest({ challenge, connector: connector.id, device: body.device_id, collection });
    let device: Device;
    try {
      device = await inTransaction(options.db, async (client) => {
        await lock(client, collection);
        const joining = await authenticate(client, body, connector, digest);
        // The connector, account and device are current and stay locked until the
        // enrolment commits: a revocation racing this request waits or wins.
        await currentIdentity(client, connector, body.device_id, joining);
        // Cloud copy only: a private collection, or one that has left sync, refuses
        // before any policy op exists.
        await currentCloudCopy(client, collection, connector.user_id);
        await refuseRevoked(client, collection, body.device_id);
        const prior = (await client.query<{ ops: { ops: Array<Record<string, unknown>> } }>(ENROLMENT, [collection, enrolmentKey(body.device_id)])).rows[0];
        if (prior) {
          const same = (await client.query(ENROLMENT, [collection, exactEnrolment(body.device_id, connector.user_id, joining)])).rows.length > 0;
          if (!same) throw new CreateError(409, "device_enrolled_differently");
        } else if (!(await queueNextPolicy(client, collection, [enrolOp(body.device_id, connector.user_id, joining)]))) {
          throw new CreateError(409, "not_current_cloud_copy");
        }
        return joining;
      });
    } catch (error) {
      return refuse(reply, error, "The device was not enrolled; retry with a fresh proof.");
    }
    try {
      await options.emitter.drainCollection(collection);
      const row = (await options.db.query<{ seq: string | null; item: Buffer | null; state: string | null }>(
        ENROLMENT, [collection, exactEnrolment(body.device_id, connector.user_id, device)]
      )).rows[0];
      const batch = await appendedBatch(collection, row);
      return await inTransaction(options.db, async (client) => {
        await currentIdentity(client, connector, body.device_id, device);
        await currentCloudCopy(client, collection, connector.user_id);
        await refuseRevoked(client, collection, body.device_id);
        // Hosted (or escrow) wraps the current epoch key to this device next.
        return { collection_id: collection, enrolled_at: batch.seq, device: mint(body.device_id, device.sign_pk, collection) };
      });
    } catch (error) {
      if (error instanceof CreateError && error.status !== 503) return refuse(reply, error, "The cloud copy is not current for this device.");
      return reply.code(503).send(apiError("not_ready", "The enrolment is not verified; retry with a fresh proof."));
    }
  });
}
