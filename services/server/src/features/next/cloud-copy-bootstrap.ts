// Cloud-copy collection bootstrap on the next control plane. Service-assisted
// keying applies to cloud copies only; private collections never enter these routes.
// Mounted only with MDBASE_NEXT_CLOUD_COPY_BOOTSTRAP=1.
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
import type { FastifyInstance, FastifyReply } from "fastify";
import type { DatabaseConnection, DatabasePool } from "../../database-types.js";
import { apiError } from "../../platform/http-errors.js";
import { requireInstallationDeviceConnector, requireSessionContext, requireUser, type ConnectorIdentity } from "../../platform/request-authentication.js";
import { LOG_TOKEN_LIFETIME_MS, type LogServiceClient } from "./log-service-client.js";
import {
  authenticate, CreateError, currentAccount, currentIdentity, currentMember, currentSession, ENROLMENT, enrolmentKey, enrolOp, exactEnrolment,
  inTransaction, lock, NIL, refuse as refuseCommon, refuseRevoked, SERVICE_ACCOUNT, type Device, type Proof
} from "./bootstrap-common.js";
import { type NextControlPlaneConfig } from "./policy-keys.js";
import { queueNextPolicy, registerNextCollection, type PolicyEmitter } from "./policy-outbox.js";
import { domainHash, encodeCbor, uuidBytes } from "./policy-wire.js";
import { generateServiceDevice, loadServiceDevice, ServiceDeviceError, storeServiceDevice, type ServiceDeviceRecord } from "./service-devices.js";
import { pitrCollection, pitrLabel, pitrLogUrl, pitrDeployments, type LabPitrConfig } from "./lab-pitr-config.js";

import { installationCollections, requireInstallationScope } from "./installation-scope.js";
import { collectionDisplayName, DEFAULT_COLLECTION_DISPLAY_NAME, validateInitialCollectionName } from "./collection-display-name.js";
import { registerCollectionNameRoutes } from "./collection-name-routes.js";
const KINDS = ["hosted", "escrow"] as const;

function refuse(reply: FastifyReply, error: unknown, message: string) {
  if (error instanceof ServiceDeviceError) {
    const status = error.status === 502 ? 503 : error.status;
    return reply.code(status).send(apiError(error.code, message));
  }
  return refuseCommon(reply, error, message);
}

/** `H("mdbase/v1/cloud-copy-create", cbor[challenge, connector, device, collection])`, signed by the owner's device. */
export function cloudCopyCreateDigest(input: { challenge: Uint8Array; connector: string; device: string; collection: string }): Uint8Array {
  return domainHash("mdbase/v1/cloud-copy-create", encodeCbor([input.challenge, uuidBytes(input.connector), uuidBytes(input.device), uuidBytes(input.collection)]));
}

/** `H("mdbase/v1/cloud-copy-join", cbor[challenge, connector, device, collection])`, signed by the joining device. */
export function cloudCopyJoinDigest(input: { challenge: Uint8Array; connector: string; device: string; collection: string }): Uint8Array {
  return domainHash("mdbase/v1/cloud-copy-join", encodeCbor([input.challenge, uuidBytes(input.connector), uuidBytes(input.device), uuidBytes(input.collection)]));
}

/** Whether the collection already exists: false when free, true when this owner's cloud copy, else refused. */
async function existing(client: DatabaseConnection, collection: string, owner: string, pitr?: LabPitrConfig): Promise<boolean> {
  const row = (await client.query<{ owner_user_id: string; sync: string; left: boolean; created_at: Date; display_name: string }>(
    "SELECT owner_user_id, sync, left_sync_at IS NOT NULL AS left, created_at, display_name FROM next_collections WHERE collection_id = $1 FOR UPDATE", [collection]
  )).rows[0];
  if (pitrCollection(pitr,collection) && (owner !== pitr!.owner || (row &&
      (!(row.created_at instanceof Date) || row.created_at.getTime() < pitr!.createdAfter || row.display_name !== pitrLabel(pitr!,collection))))) throw new CreateError(409,"collection_exists");
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

async function currentJoiningCloudCopy(client: DatabaseConnection, collection: string, connector: ConnectorIdentity): Promise<void> {
  if (!connector.installation_device_id) return currentCloudCopy(client,collection,connector.user_id);
  await requireInstallationScope(client,connector,collection);
  const current = await client.query("SELECT 1 FROM next_collections n JOIN users owner ON owner.id=n.owner_user_id WHERE n.collection_id=$1 AND n.runtime='next' AND n.sync='cloud_copy' AND n.left_sync_at IS NULL AND owner.suspended_at IS NULL FOR UPDATE OF n",[collection]);
  if (!current.rows.length) throw new CreateError(409,"not_current_cloud_copy");
  await currentMember(client,collection,connector.user_id);
}

const publicRecord = (record: ServiceDeviceRecord) => ({
  kind: record.kind, device_id: record.device_id,
  sign_pk: record.sign_pk.toString("hex"), kem_pk: record.kem_pk.toString("hex"), noise_pk: record.noise_pk.toString("hex")
});

export function registerCloudCopyRoutes(app: FastifyInstance, options: {
  db: DatabasePool; next: NextControlPlaneConfig; emitter: PolicyEmitter;
  log: Pick<LogServiceClient, "controlItemAt" | "head" | "mintToken">; fetchImpl?: typeof fetch; now?: () => number;
  tailscaleAuth?: boolean;
}): void {
  const deployments = options.next.cloudCopyBootstrap;
  if (!deployments) throw new Error("cloud-copy routes need MDBASE_NEXT_CLOUD_COPY_BOOTSTRAP=1");
  const pitr = options.next.logService.labPitr;
  const existingFor = (client: DatabaseConnection, collection: string, owner: string) => existing(client,collection,owner,pitr);
  const fixtureName = (collection: string, owner: string, name: string) => {
    if (pitrCollection(pitr,collection) && (owner !== pitr!.owner || name !== pitrLabel(pitr!,collection))) throw new CreateError(403,"lab_pitr_fixture_required");
  };
  registerCollectionNameRoutes(app, options.db);
  const rootKeyId = Buffer.from(options.next.policyCert.root_key_id, "hex");
  const uuid = { type: "string", pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$" };
  const proof = { device_id: uuid, challenge: { type: "string", pattern: "^[0-9a-f]{64}$" }, sig: { type: "string", pattern: "^[0-9a-f]{128}$" } };
  const limited = { bodyLimit: 4096, config: { rateLimit: { max: 6, timeWindow: "1 minute" } } };
  /** Each deployment generates its own keys. Nothing is locked while they work. */
  const generateFor = (collection: string) =>
    Promise.all(KINDS.map((kind) => generateServiceDevice(pitrDeployments(deployments, options.next.logService.labPitr, collection)[kind], kind, collection, options.fetchImpl)));

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
    log_url: pitrLogUrl(options.next.logService.url, options.next.logService.labPitr, collection), head: { seq: head.seq, chain: Buffer.from(head.chain).toString("hex") },
    root_public_key: Buffer.from(options.next.rootPublicKey).toString("hex"), policy_cert: options.next.policyCert,
    genesis: { seq: 1, item: genesis.toString("hex") },
    service_devices: records.map(publicRecord)
  });

  const mint = (device: string, signPk: Buffer, collection: string) => {
    const expiresAt = (options.now ?? Date.now)() + LOG_TOKEN_LIFETIME_MS;
    return { device_id: device, token: options.log.mintToken({ device, signPublicKey: signPk, collection, expiresAt }), expires_at: expiresAt };
  };

  // Metadata is installation-scoped, never an account inventory or readiness claim.
  app.get("/v1/next/collections", async (request,reply) => {
    reply.header("cache-control","no-store");
    const connector = await requireInstallationDeviceConnector(request,reply,options.db);
    if (!connector) return reply;
    if (!connector.installation_device_id) return reply.code(403).send(apiError("installation_credential_required","Use an installation credential."));
    try {
      return await inTransaction(options.db,async client=> {
        await requireInstallationScope(client,connector);
        return {collections:await installationCollections(client,connector.user_id,connector.id,connector.installation_device_id)};
      });
    } catch (error) { return refuse(reply,error,"The approved collection list is unavailable."); }
  });

  // ---- Service-created: the account, no device. ----
  app.post<{ Body: { collection_id: string; display_name?: string } }>("/v1/next/collections/cloud-copy/service", {
    ...limited,
    preValidation: validateInitialCollectionName,
    schema: { body: { type: "object", additionalProperties: false, required: ["collection_id"], properties: { collection_id: uuid, display_name: { type: "string" } } } }
  }, async (request, reply) => {
    reply.header("cache-control", "no-store");
    const initialDisplayName = request.body.display_name;
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
      const displayName = collectionDisplayName(initialDisplayName === undefined ? DEFAULT_COLLECTION_DISPLAY_NAME : initialDisplayName);
      fixtureName(collection,user.id,displayName);
      const exists = await inTransaction(options.db, async (client) => {
        await lock(client, collection);
        await current(client);
        return existingFor(client, collection, user.id);
      });
      if (!exists) {
        const generated = await generateFor(collection);
        await inTransaction(options.db, async (client) => {
          await lock(client, collection);
          await current(client);
          if (await existingFor(client, collection, user.id)) throw new CreateError(503, "not_ready");
          await registerNextCollection(client, {
            collectionId: collection, ownerUserId: user.id, runtime: "next", sync: "cloud_copy", rootKeyId, displayName,
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
  app.post<{ Body: Proof & { collection_id: string; display_name?: string } }>("/v1/next/collections/cloud-copy", {
    ...limited,
    preValidation: validateInitialCollectionName,
    schema: { body: {
      type: "object", additionalProperties: false, required: ["collection_id", "device_id", "challenge", "sig"],
      properties: { collection_id: uuid, display_name: { type: "string" }, ...proof }
    } }
  }, async (request, reply) => {
    reply.header("cache-control", "no-store");
    const initialDisplayName = request.body.display_name;
    const connector = await requireInstallationDeviceConnector(request, reply, options.db);
    if (!connector) return reply;
    const body = { ...request.body, collection_id: request.body.collection_id.toLowerCase(), device_id: request.body.device_id.toLowerCase() };
    const collection = body.collection_id;
    if (collection === NIL || body.device_id === NIL) return reply.code(400).send(apiError("invalid_request", "Nil identifiers are not accepted."));
    const digest = (challenge: Uint8Array) => cloudCopyCreateDigest({ challenge, connector: connector.id, device: body.device_id, collection });
    let device: Device;
    try {
      const displayName = collectionDisplayName(initialDisplayName === undefined ? DEFAULT_COLLECTION_DISPLAY_NAME : initialDisplayName);
      fixtureName(collection,connector.user_id,displayName);
      // 1. Proof and ownership, consuming the challenge. No network call holds a lock.
      let exists: boolean;
      ({ device, exists } = await inTransaction(options.db, async (client) => {
        await lock(client, collection);
        const owner = await authenticate(client, body, connector, digest);
        await currentIdentity(client,connector,body.device_id,owner);
        const exists = await existingFor(client, collection, connector.user_id);
        await requireInstallationScope(client,connector,exists?collection:undefined,!exists);
        return { device: owner, exists };
      }));
      if (!exists) {
        const generated = await generateFor(collection);
        // 2. Recheck the identity and the collection, then register genesis and store
        // the records together. The first committed record wins.
        await inTransaction(options.db, async (client) => {
          await lock(client, collection);
          await currentIdentity(client, connector, body.device_id, device);
          await requireInstallationScope(client,connector,undefined,true);
          // Created concurrently: the retry path rechecks the enrolled device.
          if (await existingFor(client, collection, connector.user_id)) throw new CreateError(503, "not_ready");
          await registerNextCollection(client, {
            collectionId: collection, ownerUserId: connector.user_id, runtime: "next", sync: "cloud_copy", rootKeyId, displayName,
            ops: [
              { op: "genesis", owner: connector.user_id, root: rootKeyId, state: "cloud-copy" },
              { op: "member-set", account: connector.user_id, role: "owner" },
              enrolOp(body.device_id, connector.user_id, device),
              ...generated.map((record) => enrolOp(record.device_id, SERVICE_ACCOUNT, record))
            ]
          });
          for (const record of generated) await storeServiceDevice(client, collection, record);
          if (connector.installation_device_id) await client.query("INSERT INTO installation_collection_scopes(connector_id,collection_id) VALUES($1,$2)",[connector.id,collection]);
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
        await requireInstallationScope(client,connector,collection);
        if (connector.installation_device_id) await currentMember(client,collection,connector.user_id);
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
    const connector = await requireInstallationDeviceConnector(request, reply, options.db);
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
        await currentJoiningCloudCopy(client, collection, connector);
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
      // The joining device pins the collection's genesis before it trusts the log:
      // the exact seq-1 bytes the log returns (candidate bytes; it verifies them).
      const genesis = await appendedGenesis(collection);
      return await inTransaction(options.db, async (client) => {
        await currentIdentity(client, connector, body.device_id, device);
        await currentJoiningCloudCopy(client, collection, connector);
        await refuseRevoked(client, collection, body.device_id);
        // Hosted (or escrow) wraps the current epoch key to this device next.
        return {
          collection_id: collection, enrolled_at: batch.seq, log_url: pitrLogUrl(options.next.logService.url, options.next.logService.labPitr, collection),
          genesis: { seq: 1, item: genesis.item.toString("hex") },
          device: mint(body.device_id, device.sign_pk, collection)
        };
      });
    } catch (error) {
      if (error instanceof CreateError && error.status !== 503) return refuse(reply, error, "The cloud copy is not current for this device.");
      return reply.code(503).send(apiError("not_ready", "The enrolment is not verified; retry with a fresh proof."));
    }
  });
}
