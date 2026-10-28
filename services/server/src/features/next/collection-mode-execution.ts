// Native-device execution of durable owner intent. No browser/app credential can
// publish a conversion or report key readiness. Network work never holds DB locks.
import { randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { DatabaseConnection } from "../../database-types.js";
import { localBuild, localDeployment } from "../../local-deployment.js";
import { apiError } from "../../platform/http-errors.js";
import { authenticate, currentIdentity, enrolOp, exactEnrolment, inTransaction, CreateError, refuse, refuseRevoked, SERVICE_ACCOUNT, type Device } from "./bootstrap-common.js";
import { authenticateOwner, ownedMode, type Owner, type Mode } from "./collection-mode-routes.js";
import { collectionModeDigest } from "./collection-mode-proof.js";
import { generateCloudCopyServices, loadCloudCopyRecords, type CloudCopyBootstrapOptions } from "./service-cloud-copy.js";
import { storeServiceDevice, type ServiceDeviceRecord } from "./service-devices.js";
import { serializeOps } from "./policy-outbox.js";
import { migrationDeployments } from "./migration-routing.js";
import { pitrDeployments } from "./lab-pitr-config.js";
import { chainHash, type PolicyOp } from "./policy-wire.js";
import { armModeFloor, ModeDevicesNeedUpdate } from "./collection-mode-capability.js";

const uuid = z.uuid().transform(s => s.toLowerCase()).refine(s => s !== SERVICE_ACCOUNT);
const uint = z.string().regex(/^[1-9][0-9]{0,19}$/u).refine(s => BigInt(s) < 1n << 64n);
const hex32 = z.string().regex(/^[0-9a-f]{64}$/u);
const bodySchema = z.object({ device_id: uuid, challenge: hex32, sig: z.string().regex(/^[0-9a-f]{128}$/u), epoch: uint,
  seq: uint, chain: hex32, members: z.array(uuid).max(1024) }).strict();
type Body = z.infer<typeof bodySchema>;
type Change = { target_mode: Mode; source_mode: Mode; source_epoch: string | null; policy_outbox_id: string | null;
  completed_at: Date | null; rekey_verified_at: Date | null; rekey_seq: string | null; rekey_chain: Buffer | null };
type NativeOwner = Owner & { connector: { id: string; user_id: string }; hash: string };

async function change(client: DatabaseConnection, collection: string, request: string): Promise<Change> {
  const row = (await client.query<Change>("SELECT * FROM next_collection_mode_changes WHERE collection_id=$1 AND request_id=$2 FOR UPDATE", [collection, request])).rows[0];
  if (!row) throw new CreateError(404, "not_found");
  return row;
}
async function currentDevice(client: DatabaseConnection, owner: NativeOwner, collection: string, body: Body, device: Device): Promise<void> {
  await ownedMode(client, owner, collection);
  await currentIdentity(client, owner.connector, body.device_id, device);
  await refuseRevoked(client, collection, body.device_id);
  if (!["desktop", "cli"].includes(device.kind)) throw new CreateError(403, "invalid_device_kind");
  if (!(await client.query(`SELECT 1 FROM next_policy_outbox o JOIN next_policy_batches b ON b.id=o.batch_id
    WHERE o.collection_id=$1 AND b.state='appended' AND b.lost_at IS NULL AND o.ops->'ops' @> $2::jsonb LIMIT 1`,
    [collection, exactEnrolment(body.device_id, owner.account, device)])).rows.length) throw new CreateError(403, "not_enrolled");
}
async function batch(options: CloudCopyBootstrapOptions, collection: string, outbox: string) {
  await options.emitter.drainCollection(collection);
  const row = (await options.db.query<{ seq: string; item: Buffer; prev: Buffer }>(`SELECT b.seq,b.item,b.prev FROM next_policy_outbox o
    JOIN next_policy_batches b ON b.id=o.batch_id WHERE o.id=$1 AND o.collection_id=$2 AND b.state='appended' AND b.lost_at IS NULL`, [outbox, collection])).rows[0];
  if (!row || !Number.isSafeInteger(Number(row.seq))) throw new CreateError(503, "not_ready");
  const actual = await options.log.controlItemAt(collection, Number(row.seq));
  if (!actual || !row.item.equals(Buffer.from(actual))) throw new CreateError(503, "not_ready");
  return row;
}

/** Service HTTP acknowledgements come only from authenticated live native
 * observations (or an idempotent cache retirement), never activation/caught_up. */
async function services(options: CloudCopyBootstrapOptions, collection: string, records: ServiceDeviceRecord[], operation: "ready" | "retire", epoch: string): Promise<void> {
  if (!options.next.cloudCopyBootstrap) throw new CreateError(503, "not_ready");
  const deployments = await migrationDeployments(options.db, pitrDeployments(options.next.cloudCopyBootstrap, options.next.logService.labPitr, collection), options.next.migrationRouting, collection);
  if (!deployments) throw new CreateError(409, "migration_routing_retired");
  for (const record of records) {
    const deployment = deployments[record.kind];
    const url = new URL(`internal/v1/collection-mode/${operation}`, `${deployment.url.replace(/\/+$/u, "")}/`);
    if (deployment.token.length < 32 || (localBuild() ? !localDeployment("local", deployment.url) : url.protocol !== "https:")) throw new CreateError(503,"not_ready");
    const challenge = randomBytes(32).toString("hex");
    const response = await (options.fetchImpl ?? fetch)(url, {
      method: "POST", redirect: "error", headers: { authorization: `Bearer ${deployment.token}`, "content-type": "application/json" },
      body: JSON.stringify({ collection, device: record.device_id, epoch, challenge }), signal: AbortSignal.timeout(30_000)
    });
    const reader = response.body?.getReader(); let size = 0; const parts: Uint8Array[] = [];
    if (!response.ok || !reader) { await response.body?.cancel(); throw new CreateError(503, "not_ready"); }
    for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > 4096) { await reader.cancel(); throw new CreateError(503, "not_ready"); } parts.push(part.value); }
    let answer: unknown; try { answer = JSON.parse(Buffer.concat(parts).toString()); } catch { throw new CreateError(503, "not_ready"); }
    const result = z.object({ collection: uuid, device: uuid, epoch: uint, challenge: hex32, ready: z.literal(true) }).strict().safeParse(answer);
    if (!result.success || result.data.collection !== collection || result.data.device !== record.device_id || result.data.epoch !== epoch || result.data.challenge !== challenge)
      throw new CreateError(503, "not_ready");
  }
}

export function registerCollectionModeExecution(app: FastifyInstance, options: CloudCopyBootstrapOptions & { now?: () => number }): void {
  for (const finish of [false, true]) app.post(`/v1/next/collections/:id/mode/:requestId/${finish ? "finish" : "prepare"}`, {
    bodyLimit: 64 * 1024, config: { rateLimit: { max: 20, timeWindow: "1 minute" } }
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    reply.header("cache-control", "no-store");
    const params = z.object({ id: uuid, requestId: uuid }).safeParse(request.params);
    const parsed = bodySchema.safeParse(request.body);
    if (!params.success || !parsed.success || new Set(parsed.data.members).size !== parsed.data.members.length || (finish && parsed.data.members.length !== 0))
      return reply.code(400).send(apiError("invalid_request", "A native device proof is required."));
    const owner = await authenticateOwner(request, reply, options.db);
    if (!owner) return reply;
    if (!("connector" in owner)) return reply.code(403).send(apiError("device_required", "Use an owner device with this collection's key."));
    const native = owner as NativeOwner, body = parsed.data, { id: collection, requestId } = params.data;
    try {
      const initial = await inTransaction(options.db, async client => {
        await ownedMode(client, native, collection);
        const row = await change(client, collection, requestId);
        const device = await authenticate(client, body, native.connector, challenge => collectionModeDigest({ challenge,
          connector: native.connector.id, device: body.device_id, collection, request: requestId, target: row.target_mode,
          finish, epoch: BigInt(body.epoch), seq: BigInt(body.seq), chain: Buffer.from(body.chain, "hex"), members: body.members }));
        await currentDevice(client, native, collection, body, device);
        return { row, device };
      });
      const current = async (client: DatabaseConnection) => {
        await currentDevice(client, native, collection, body, initial.device);
        return change(client, collection, requestId);
      };
      if (initial.row.completed_at) return { request_id: requestId, phase: "complete" };
      if (!finish) {
        const generated = initial.row.target_mode === "cloud_copy" && initial.row.policy_outbox_id === null
          ? await generateCloudCopyServices(options, collection) : null;
        const waitUntil = await inTransaction(options.db, async client => {
          const row = await current(client);
          if (row.completed_at) return null;
          if (row.policy_outbox_id !== null) {
            if (row.target_mode === "cloud_copy") return null;
            const queued = (await client.query<{ batch_id: string | null }>("SELECT batch_id FROM next_policy_outbox WHERE id=$1 FOR UPDATE", [row.policy_outbox_id])).rows[0];
            // Never replace a sent/uncertain batch. A head-moved batch is released
            // by the existing emitter before native preparation can refresh it.
            if (!queued || queued.batch_id !== null) return null;
          }
          if (row.target_mode === "private") {
            if (!body.members.includes(body.device_id)) throw new CreateError(409, "keyed_owner_required");
            const readyAt = await armModeFloor(client, collection, body.members, (options.now ?? Date.now)());
            if ((options.now ?? Date.now)() < readyAt) return readyAt;
          }
          const mode = await ownedMode(client, native, collection);
          if (mode !== row.source_mode) throw new CreateError(409, "mode_changed");
          let ops: PolicyOp[];
          if (row.target_mode === "private") {
            const records = await loadCloudCopyRecords(client, collection);
            ops = [...records.map(record => ({ op: "device-revoke" as const, device: record.device_id })), { op: "collection-state", state: "e2e" }];
          } else {
            if (!generated) throw new CreateError(503, "not_ready");
            // Composite service FK requires Cloud copy; no genesis/placement changes.
            await client.query("UPDATE next_collections SET sync='cloud_copy' WHERE collection_id=$1", [collection]);
            for (const record of generated) await storeServiceDevice(client, collection, record);
            // Escrow must be enrolled before collection-state becomes cloud-copy.
            ops = [...generated.map(record => enrolOp(record.device_id, SERVICE_ACCOUNT, record)), { op: "collection-state", state: "cloud-copy" }];
          }
          const stored = JSON.parse(serializeOps(ops)) as Record<string, unknown>;
          // Bind the native membership view to the SAME prefix. If anything moves
          // before append, reuse existing head-moved retry with a fresh preflight.
          if (row.target_mode === "private") stored.mode_source_head = { seq: body.seq, chain: body.chain };
          const outbox = row.policy_outbox_id === null
            ? (await client.query<{ id: string }>("INSERT INTO next_policy_outbox(collection_id,ops) VALUES($1,$2) RETURNING id", [collection, JSON.stringify(stored)])).rows[0]!.id
            : row.policy_outbox_id;
          if (row.policy_outbox_id !== null) await client.query("UPDATE next_policy_outbox SET ops=$2 WHERE id=$1", [outbox, JSON.stringify(stored)]);
          await client.query("UPDATE next_collection_mode_changes SET source_epoch=$3,policy_outbox_id=$4 WHERE collection_id=$1 AND request_id=$2", [collection, requestId, body.epoch, outbox]);
          return null;
        });
        if (waitUntil !== null) return reply.code(202).send({ request_id: requestId, phase: "waiting_for_token_expiry", retry_at: new Date(waitUntil).toISOString() });
        await options.emitter.publishCommitted(collection);
        return reply.code(202).send({ request_id: requestId, phase: "finishing" });
      }
      if (!initial.row.policy_outbox_id || !initial.row.source_epoch) throw new CreateError(409, "not_prepared");
      const policy = await batch(options, collection, initial.row.policy_outbox_id);
      const epoch = BigInt(initial.row.source_epoch);
      if (initial.row.target_mode === "private") {
        if (BigInt(body.epoch) !== epoch + 1n || BigInt(body.seq!) !== BigInt(policy.seq) + 1n) throw new CreateError(409, "private_receipt_mismatch");
        const rekey = await options.log.controlItemAt(collection, Number(body.seq));
        if (!rekey || Buffer.from(chainHash(rekey)).toString("hex") !== body.chain) throw new CreateError(503, "not_ready");
        // Signature proves the current owner native device's committed acceptance;
        // it cannot be supplied by a browser, app or service. Native owns validity,
        // unwrap/commitment checks and the frozen-set rule, not a second JS replay.
        await inTransaction(options.db, async client => {
          const row = await current(client); if (row.completed_at) return;
          if (row.rekey_verified_at && (row.rekey_seq !== body.seq || !row.rekey_chain?.equals(Buffer.from(body.chain!, "hex")))) throw new CreateError(409, "private_receipt_mismatch");
          await client.query("UPDATE next_collection_mode_changes SET rekey_verified_at=COALESCE(rekey_verified_at,now()),rekey_seq=$3,rekey_chain=$4 WHERE collection_id=$1 AND request_id=$2", [collection, requestId, body.seq, Buffer.from(body.chain!, "hex")]);
        });
      } else if (BigInt(body.epoch) < epoch) throw new CreateError(409, "source_epoch_changed");
      const records = await inTransaction(options.db, async client => { await current(client); return loadCloudCopyRecords(client, collection); });
      await services(options, collection, records, initial.row.target_mode === "private" ? "retire" : "ready", body.epoch);
      await inTransaction(options.db, async client => {
        const row = await current(client); if (row.completed_at) return;
        const actual = await loadCloudCopyRecords(client, collection);
        if (actual.some((record, i) => record.device_id !== records[i]?.device_id)) throw new CreateError(409, "service_changed");
        if (row.target_mode === "private") {
          if (!row.rekey_verified_at) throw new CreateError(409, "not_ready");
          await client.query("DELETE FROM next_service_devices WHERE collection_id=$1", [collection]);
          await client.query("UPDATE next_collections SET sync='private' WHERE collection_id=$1", [collection]);
        }
        await client.query("UPDATE next_collection_mode_changes SET completed_at=now() WHERE collection_id=$1 AND request_id=$2", [collection, requestId]);
      });
      return { request_id: requestId, phase: "complete" };
    } catch (error) {
      if (error instanceof ModeDevicesNeedUpdate) return reply.code(error.status).send({ ...apiError(error.code, "Update or revoke these devices before switching."), devices: error.devices });
      return refuse(reply, error, "The switch is not finished. Retry from an owner device.");
    }
  });
}
