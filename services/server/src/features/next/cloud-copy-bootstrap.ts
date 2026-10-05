// An owner creates a cloud-copy collection (coordinator decision on sealed-envelope §7.1):
// the control plane asks the hosted and escrow deployments to generate their service
// devices, then registers a cloud-copy genesis that enrols the owner's device and both
// service devices. The owner's desktop then appends the initial rekey itself, with wraps
// for desktop + hosted + escrow. The control plane never holds a collection key, and
// there is no escrow-to-hosted wrap. Mounted only with MDBASE_NEXT_CLOUD_COPY_BOOTSTRAP=1.
//
// A collection is created as a cloud copy here; converting an existing private
// collection is not supported.
import { verify } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { DatabaseConnection, DatabasePool } from "../../database-types.js";
import { apiError } from "../../platform/http-errors.js";
import { requireConnector } from "../../platform/request-authentication.js";
import { LOG_TOKEN_LIFETIME_MS, type LogServiceClient } from "./log-service-client.js";
import { ed25519PublicKeyObject, type NextControlPlaneConfig } from "./policy-keys.js";
import { registerNextCollection, type PolicyEmitter } from "./policy-outbox.js";
import { domainHash, encodeCbor, uuidBytes } from "./policy-wire.js";
import { generateServiceDevice, loadServiceDevice, ServiceDeviceError, storeServiceDevice, type ServiceDeviceRecord } from "./service-devices.js";

/** Service devices belong to no account (policy.md: hosted and escrow enrol with the zero account). */
const SERVICE_ACCOUNT = "00000000-0000-0000-0000-000000000000";
const NIL = SERVICE_ACCOUNT;

interface Body { collection_id: string; device_id: string; challenge: string; sig: string }
interface Device { sign_pk: Buffer; kem_pk: Buffer; noise_pk: Buffer; kind: "desktop" | "cli" }
class CreateError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}

/** `H("mdbase/v1/cloud-copy-create", cbor[challenge, connector, device, collection])`, signed by the owner's device. */
export function cloudCopyCreateDigest(input: { challenge: Uint8Array; connector: string; device: string; collection: string }): Uint8Array {
  return domainHash("mdbase/v1/cloud-copy-create", encodeCbor([input.challenge, uuidBytes(input.connector), uuidBytes(input.device), uuidBytes(input.collection)]));
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

async function authenticate(client: DatabaseConnection, body: Body, connector: { id: string; user_id: string }): Promise<Device> {
  const device = (await client.query<Device>(
    "SELECT sign_pk, kem_pk, noise_pk, kind FROM next_devices WHERE id = $1 AND connector_id = $2 AND user_id = $3",
    [body.device_id, connector.id, connector.user_id]
  )).rows[0];
  const challenge = Buffer.from(body.challenge, "hex");
  const digest = cloudCopyCreateDigest({ challenge, connector: connector.id, device: body.device_id, collection: body.collection_id });
  if (!device || !verify(null, digest, ed25519PublicKeyObject(device.sign_pk), Buffer.from(body.sig, "hex"))) throw new CreateError(403, "invalid_proof");
  const used = await client.query(
    "UPDATE next_device_challenges SET used_at = now() WHERE challenge = $1 AND connector_id = $2 AND used_at IS NULL AND expires_at > now()",
    [challenge, connector.id]
  );
  if (used.rowCount !== 1) throw new CreateError(403, "invalid_proof");
  return device;
}

/**
 * The owner's connector, account and device are still current, with the exact keys
 * authenticated in phase 1; locked until the transaction ends, so a revocation,
 * suspension or device removal either happened before (and is refused here) or waits.
 */
async function currentIdentity(client: DatabaseConnection, connector: { id: string; user_id: string }, deviceId: string, device: Device): Promise<void> {
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

async function inTransaction<T>(db: DatabasePool, run: (client: DatabaseConnection) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
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

export function registerCloudCopyRoutes(app: FastifyInstance, options: {
  db: DatabasePool; next: NextControlPlaneConfig; emitter: PolicyEmitter;
  log: Pick<LogServiceClient, "controlItemAt" | "head" | "mintToken">; fetchImpl?: typeof fetch; now?: () => number;
}): void {
  const deployments = options.next.cloudCopyBootstrap;
  if (!deployments) throw new Error("cloud-copy routes need MDBASE_NEXT_CLOUD_COPY_BOOTSTRAP=1");
  const rootKeyId = Buffer.from(options.next.policyCert.root_key_id, "hex");
  const uuid = { type: "string", pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$" };
  app.post<{ Body: Body }>("/v1/next/collections/cloud-copy", {
    bodyLimit: 4096,
    config: { rateLimit: { max: 6, timeWindow: "1 minute" } },
    schema: { body: {
      type: "object", additionalProperties: false, required: ["collection_id", "device_id", "challenge", "sig"],
      properties: { collection_id: uuid, device_id: uuid, challenge: { type: "string", pattern: "^[0-9a-f]{64}$" }, sig: { type: "string", pattern: "^[0-9a-f]{128}$" } }
    } }
  }, async (request, reply) => {
    reply.header("cache-control", "no-store");
    const connector = await requireConnector(request, reply, options.db);
    if (!connector) return reply;
    const body = { ...request.body, collection_id: request.body.collection_id.toLowerCase(), device_id: request.body.device_id.toLowerCase() };
    const collection = body.collection_id;
    if (collection === NIL || body.device_id === NIL) return reply.code(400).send(apiError("invalid_request", "Nil identifiers are not accepted."));
    let device: Device;
    try {
      // 1. Proof and ownership, consuming the challenge. No network call holds a lock.
      let created: boolean;
      ({ device, created } = await inTransaction(options.db, async (client) => {
        await lock(client, collection);
        const owner = await authenticate(client, body, connector);
        return { device: owner, created: await existing(client, collection, connector.user_id) };
      }));
      if (!created) {
        // 2. Each deployment generates its own keys. Nothing is locked while they work.
        const generated = await Promise.all((["hosted", "escrow"] as const).map((kind) =>
          generateServiceDevice(deployments[kind], kind, collection, options.fetchImpl)));
        // 3. Recheck the owner's identity (revocation, suspension, device removal or
        // key change may have happened meanwhile) and the collection, then register
        // genesis and store the records together. The first committed record wins.
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
              { op: "device-enrol", device: body.device_id, account: connector.user_id, kind: device.kind, signPublicKey: device.sign_pk, kemPublicKey: device.kem_pk, noisePublicKey: device.noise_pk },
              ...generated.map((record) => ({
                op: "device-enrol" as const, device: record.device_id, account: SERVICE_ACCOUNT, kind: record.kind,
                signPublicKey: record.sign_pk, kemPublicKey: record.kem_pk, noisePublicKey: record.noise_pk
              }))
            ]
          });
          for (const record of generated) await storeServiceDevice(client, collection, record);
        });
      }
    } catch (error) {
      if (error instanceof CreateError || error instanceof ServiceDeviceError) {
        const status = error.status === 502 ? 503 : error.status;
        return reply.code(status).send(apiError(error.code, "The cloud copy was not created; retry with a fresh proof."));
      }
      throw error;
    }
    try {
      // 4. Only an appended genesis whose exact bytes the log returns counts as created.
      await options.emitter.drainCollection(collection);
      const genesis = (await options.db.query<{ item: Buffer; state: string }>(
        "SELECT item, state FROM next_policy_batches WHERE collection_id = $1 AND seq = 1 ORDER BY id LIMIT 1", [collection]
      )).rows[0];
      const external = genesis?.state === "appended" ? await options.log.controlItemAt(collection, 1) : null;
      if (!genesis || !external || !genesis.item.equals(Buffer.from(external))) throw new CreateError(503, "not_ready");
      const head = await options.log.head(collection);
      // 5. After every await: the identity, the collection and the enrolment are
      // current, and stay locked until the token is minted.
      const answer = await inTransaction(options.db, async (client) => {
        await currentIdentity(client, connector, body.device_id, device);
        const current = await client.query(
          `SELECT 1 FROM next_collections WHERE collection_id = $1 AND owner_user_id = $2 AND sync = 'cloud_copy' AND left_sync_at IS NULL FOR SHARE`,
          [collection, connector.user_id]
        );
        if (!current.rows.length) throw new CreateError(409, "collection_exists");
        // The requesting device must be the one the genesis enrolled, with the same keys.
        const enrolled = await client.query(
          `SELECT 1 FROM next_policy_outbox WHERE id = (SELECT min(id) FROM next_policy_outbox WHERE collection_id = $1)
             AND ops->'ops' @> $2::jsonb`,
          [collection, JSON.stringify([{ op: "device-enrol", device: body.device_id, account: connector.user_id, signPublicKey: { $hex: device.sign_pk.toString("hex") } }])]
        );
        if (!enrolled.rows.length) throw new CreateError(409, "collection_exists");
        const records: ServiceDeviceRecord[] = [];
        for (const kind of ["hosted", "escrow"] as const) {
          const record = await loadServiceDevice(client, collection, { kind });
          if (!record) throw new CreateError(503, "not_ready");
          records.push(record);
        }
        const expiresAt = (options.now ?? Date.now)() + LOG_TOKEN_LIFETIME_MS;
        return {
          collection_id: collection, state: "cloud-copy", owner_account: connector.user_id,
          log_url: options.next.logService.url, head: { seq: head.seq, chain: Buffer.from(head.chain).toString("hex") },
          root_public_key: Buffer.from(options.next.rootPublicKey).toString("hex"), policy_cert: options.next.policyCert,
          genesis: { seq: 1, item: genesis.item.toString("hex") },
          // Public identities enrolled by the genesis. Keying them is the owner
          // desktop's signed initial rekey; this answer is identity provisioning only.
          rekey_recipients: [body.device_id, ...records.map((record) => record.device_id)],
          service_devices: records.map(publicRecord),
          device: { device_id: body.device_id, token: options.log.mintToken({ device: body.device_id, signPublicKey: device.sign_pk, collection, expiresAt }), expires_at: expiresAt }
        };
      });
      return answer;
    } catch (error) {
      if (error instanceof CreateError && error.status !== 503) {
        return reply.code(error.status).send(apiError(error.code, "The cloud copy is not current for this device."));
      }
      return reply.code(503).send(apiError("not_ready", "The cloud copy outcome is not verified; retry with a fresh proof."));
    }
  });
}
