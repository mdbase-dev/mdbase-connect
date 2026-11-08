// Moving a migrated hosted collection off the migration Worker onto this control
// plane's own hosted deployment, keeping its hosted service device. The operator
// tool re-wraps the device's keys from the migration Worker's KMS key to the CP
// hosted key (KMS ReEncrypt; the plaintext never leaves KMS) and drives these steps:
//
//   mark    → `moving`, only for a collection routed to the migration Worker and
//             still on the expected source key: migrationRoute() refuses every
//             hosted caller, so neither Worker can mint a log token, read the
//             record or take app sockets. Then release the deployment it is
//             leaving: its ordinary activation re-mints the log token, is refused,
//             and the actor drops its engine, so held app sockets close on their
//             next frame instead of taking writes it can no longer append.
//   status  → the hosted record, and whether the fence window has passed: the
//             last log token minted before the mark has expired, plus clock skew.
//   store   → after the fence, a CAS of `wrapped_keys`/`kms_key_arn` in the same
//             transaction as `moving → moved` (or, re-wrapped back, the row's
//             removal). The new key is itself a fence: the old Worker cannot open it.
//   verify  → wake the CP hosted deployment: it opens the collection and syncs it.
//   reverse → `moved → moving` with a fresh fence and a release of the CP
//             deployment, then store re-wrapped back.
//   clear   → end a `moving` mark without re-wrapping: route to whichever
//             Worker's key the record names.
//
// One-off: removed with the migration routing once every collection has moved.
import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { DatabasePool, DatabaseQueryable } from "../../database-types.js";
import { apiError } from "../../platform/http-errors.js";
import { bearerToken } from "../../platform/request-authentication.js";
import { safeEqual } from "../../security.js";
import { CreateError, inTransaction } from "./bootstrap-common.js";
import { LOG_TOKEN_LIFETIME_MS } from "./log-service-client.js";
import { migrationServiceRateLimit } from "./migration-rate-limit.js";
import { migrationRoute, type MigrationRouting } from "./migration-routing.js";
import { collectionRegion } from "./policy-outbox.js";
import { activationOutcome, type Outcome } from "./service-activation.js";
import { MAX_WRAPPED_KEYS_BYTES } from "./service-devices.js";

/** The last token minted before the mark lasts LOG_TOKEN_LIFETIME_MS; allow for CP/log clock skew. */
export const HOSTING_MOVE_FENCE_MS = LOG_TOKEN_LIFETIME_MS + 2 * 60_000;
const ACTIVATE_TIMEOUT_MS = 30_000;

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const HEX64 = z.string().regex(/^[0-9a-f]{64}$/u);
const ARN = z.string().min(1).max(2048).regex(/^arn:[!-~]+$/u);
const BASE64 = z.string().min(4).max(Math.ceil(MAX_WRAPPED_KEYS_BYTES / 3) * 4).regex(/^[A-Za-z0-9+/]+={0,2}$/u);

type MoveRow = { state: "moving" | "moved"; from_kms_key_arn_sha256: string; to_kms_key_arn_sha256: string; moving_at: Date; moved_at: Date | null;
  released_at: Date | null; phase: string; fence_at: Date; fence_elapsed: boolean };
type Deployment = { url: string; token: string };
type HostedRow = { device_id: string; wrapped_keys: Buffer; kms_key_arn: string };

async function moveRow(db: DatabaseQueryable, collection: string, forUpdate = false): Promise<MoveRow | undefined> {
  return (await db.query<MoveRow>(
    `SELECT state, from_kms_key_arn_sha256, to_kms_key_arn_sha256, moving_at, moved_at, released_at, moving_at::text AS phase,
       moving_at + make_interval(secs => $2::double precision) AS fence_at,
       now() >= moving_at + make_interval(secs => $2::double precision) AS fence_elapsed
     FROM next_hosting_moves WHERE collection_id = $1 ${forUpdate ? "FOR UPDATE" : ""}`,
    [collection, HOSTING_MOVE_FENCE_MS / 1000])).rows[0];
}

async function hostedRecord(db: DatabaseQueryable, collection: string, forUpdate = false): Promise<HostedRow> {
  const row = (await db.query<HostedRow>(
    `SELECT device_id::text, wrapped_keys, kms_key_arn FROM next_service_devices
     WHERE collection_id = $1 AND kind = 'hosted' ${forUpdate ? "FOR UPDATE" : ""}`, [collection])).rows[0];
  if (!row) throw new CreateError(404, "service_device_not_found");
  return row;
}

function view(collection: string, record: HostedRow, move: MoveRow | undefined) {
  return {
    collection_id: collection,
    state: move?.state ?? null,
    from_kms_key_arn_sha256: move?.from_kms_key_arn_sha256 ?? null,
    to_kms_key_arn_sha256: move?.to_kms_key_arn_sha256 ?? null,
    moving_at: move?.moving_at.toISOString() ?? null,
    moved_at: move?.moved_at?.toISOString() ?? null,
    fence_at: move?.state === "moving" ? move.fence_at.toISOString() : null,
    fence_elapsed: move?.state === "moving" ? move.fence_elapsed : null,
    released: move?.state === "moving" ? move.released_at !== null : null,
    record: { device_id: record.device_id, kms_key_arn: record.kms_key_arn, kms_key_arn_sha256: sha256(record.kms_key_arn),
      wrapped_keys: record.wrapped_keys.toString("base64") },
  };
}
export type HostingMoveStatus = ReturnType<typeof view>;

export async function hostingMoveStatus(db: DatabaseQueryable, collection: string): Promise<HostingMoveStatus> {
  return view(collection, await hostedRecord(db, collection), await moveRow(db, collection));
}

/** Hosted service devices by KMS key, with move progress. With a key hash, also
 * that key's collections plus every collection that has a move row. */
export async function hostingMoveInventory(db: DatabaseQueryable, keyHash?: string) {
  const groups = (await db.query<{ kms_key_arn: string; devices: number; moving: number; moved: number }>(
    `SELECT device.kms_key_arn, count(*)::int AS devices,
       count(*) FILTER (WHERE move.state = 'moving')::int AS moving, count(*) FILTER (WHERE move.state = 'moved')::int AS moved
     FROM next_service_devices device LEFT JOIN next_hosting_moves move ON move.collection_id = device.collection_id
     WHERE device.kind = 'hosted' GROUP BY device.kms_key_arn ORDER BY device.kms_key_arn`)).rows
    .map(group => ({ ...group, kms_key_arn_sha256: sha256(group.kms_key_arn) }));
  if (!keyHash) return { groups };
  const collections = (await db.query<{ collection_id: string; kms_key_arn_sha256: string; state: string | null; current: boolean }>(
    `SELECT device.collection_id::text, encode(sha256(convert_to(device.kms_key_arn, 'UTF8')), 'hex') AS kms_key_arn_sha256, move.state,
       (parent.sync = 'cloud_copy' AND parent.left_sync_at IS NULL) AS current
     FROM next_service_devices device
     JOIN next_collections parent ON parent.collection_id = device.collection_id
     LEFT JOIN next_hosting_moves move ON move.collection_id = device.collection_id
     WHERE device.kind = 'hosted' AND (encode(sha256(convert_to(device.kms_key_arn, 'UTF8')), 'hex') = $1 OR move.collection_id IS NOT NULL)
     ORDER BY device.collection_id`, [keyHash])).rows;
  return { groups, collections };
}

/** No row → `moving`, for a migration-routed collection whose record is on `from`.
 * Idempotent while moving between the same keys. */
export async function markHostingMove(db: DatabasePool, routing: MigrationRouting, collection: string, from: string, to: string): Promise<HostingMoveStatus> {
  if (from === to) throw new CreateError(400, "invalid_request");
  return inTransaction(db, async client => {
    const record = await hostedRecord(client, collection, true);
    const move = await moveRow(client, collection, true);
    if (move?.state === "moved") throw new CreateError(409, "hosting_move_moved");
    if (move && (move.from_kms_key_arn_sha256 !== from || move.to_kms_key_arn_sha256 !== to)) throw new CreateError(409, "hosting_move_conflict");
    if (!move) {
      // A CP-native or retired collection must never be marked: it would go dark.
      if (sha256(record.kms_key_arn) !== from) throw new CreateError(409, "hosting_move_wrong_key");
      if (await migrationRoute(client, routing, collection) !== "migration") throw new CreateError(409, "hosting_move_not_migration_routed");
      await client.query(`INSERT INTO next_hosting_moves(collection_id, state, from_kms_key_arn_sha256, to_kms_key_arn_sha256)
        VALUES($1, 'moving', $2, $3)`, [collection, from, to]);
    }
    return view(collection, record, await moveRow(client, collection));
  });
}

/** `moved → moving` with a fresh fence: the CP Worker stops minting before a re-wrap back. Idempotent while moving. */
export async function reverseHostingMove(db: DatabasePool, collection: string): Promise<HostingMoveStatus> {
  return inTransaction(db, async client => {
    const record = await hostedRecord(client, collection, true);
    const move = await moveRow(client, collection, true);
    if (!move) throw new CreateError(409, "hosting_move_not_found");
    if (move.state === "moved") await client.query(
      "UPDATE next_hosting_moves SET state = 'moving', moving_at = now(), moved_at = NULL, released_at = NULL WHERE collection_id = $1", [collection]);
    return view(collection, record, await moveRow(client, collection));
  });
}

/** End a `moving` mark without re-wrapping: route to the Worker whose key the record names. */
export async function clearHostingMove(db: DatabasePool, collection: string): Promise<HostingMoveStatus> {
  return inTransaction(db, async client => {
    const record = await hostedRecord(client, collection, true);
    const move = await moveRow(client, collection, true);
    if (move?.state === "moved") throw new CreateError(409, "hosting_move_moved");
    if (move) {
      const current = sha256(record.kms_key_arn);
      if (current === move.from_kms_key_arn_sha256) await client.query("DELETE FROM next_hosting_moves WHERE collection_id = $1", [collection]);
      else if (current === move.to_kms_key_arn_sha256) await client.query(
        "UPDATE next_hosting_moves SET state = 'moved', moved_at = now() WHERE collection_id = $1", [collection]);
      else throw new CreateError(409, "hosting_move_unknown_key");
    }
    return view(collection, record, await moveRow(client, collection));
  });
}

/** MDBK v1 AWS-KMS envelope naming exactly `arn` (hosted-worker custody/envelope.ts). */
function envelopeNames(envelope: Buffer, arn: string): boolean {
  if (envelope.length < 12 || envelope.subarray(0, 6).toString("latin1") !== "MDBK\x01\x01") return false;
  const reference = envelope.readUInt16BE(6), ciphertext = envelope.readUInt32BE(8);
  return reference > 0 && ciphertext > 0 && envelope.length === 12 + reference + ciphertext
    && envelope.subarray(12, 12 + reference).toString("latin1") === arn;
}

export interface HostingMoveRecord { wrapped_keys: string; kms_key_arn: string }

/** After the fence: CAS the hosted record from `expected` to `next` and settle the
 * route in the same transaction (`moved` on the destination key, no row back on the source). */
export async function storeHostingMove(db: DatabasePool, collection: string, expected: HostingMoveRecord, next: HostingMoveRecord): Promise<HostingMoveStatus> {
  const wrapped = Buffer.from(next.wrapped_keys, "base64"), prior = Buffer.from(expected.wrapped_keys, "base64");
  if (!envelopeNames(wrapped, next.kms_key_arn) || wrapped.length > MAX_WRAPPED_KEYS_BYTES) throw new CreateError(400, "invalid_wrapped_keys");
  return inTransaction(db, async client => {
    await hostedRecord(client, collection, true); // Same lock order as every other step.
    const move = await moveRow(client, collection, true);
    if (move?.state !== "moving") throw new CreateError(409, "hosting_move_not_moving");
    if (!move.released_at) throw new CreateError(409, "hosting_move_not_released");
    if (!move.fence_elapsed) throw new CreateError(409, "hosting_move_fence_pending");
    const target = sha256(next.kms_key_arn);
    if (target === sha256(expected.kms_key_arn) || ![move.from_kms_key_arn_sha256, move.to_kms_key_arn_sha256].includes(target))
      throw new CreateError(409, "hosting_move_unknown_key");
    const updated = await client.query(
      `UPDATE next_service_devices SET wrapped_keys = $4, kms_key_arn = $5
       WHERE collection_id = $1 AND kind = 'hosted' AND wrapped_keys = $2 AND kms_key_arn = $3`,
      [collection, prior, expected.kms_key_arn, wrapped, next.kms_key_arn]);
    if (updated.rowCount !== 1) throw new CreateError(409, "hosting_move_record_changed");
    if (target === move.to_kms_key_arn_sha256) await client.query(
      "UPDATE next_hosting_moves SET state = 'moved', moved_at = now() WHERE collection_id = $1", [collection]);
    else await client.query("DELETE FROM next_hosting_moves WHERE collection_id = $1", [collection]);
    return view(collection, await hostedRecord(client, collection), await moveRow(client, collection));
  });
}

/** The deployment's ordinary activation for the collection (what policy batches send). */
async function activate(db: DatabaseQueryable, deployment: Deployment, collection: string, fetchImpl: typeof fetch): Promise<Outcome> {
  const region = await collectionRegion(db, collection);
  const url = new URL("internal/v1/collections/activate", `${deployment.url.replace(/\/+$/u, "")}/`);
  try {
    return await activationOutcome(await fetchImpl(url, { method: "POST", redirect: "manual",
      headers: { authorization: `Bearer ${deployment.token}`, "content-type": "application/json" },
      body: JSON.stringify({ collection, ...(region ? { region } : {}) }), signal: AbortSignal.timeout(ACTIVATE_TIMEOUT_MS) }));
  } catch { return { kind: "unknown" }; }
}

/** While `moving`: activate the deployment the collection is leaving (the one whose key
 * the record names). Its fresh log-token mint is refused, so it answers with a custody
 * verdict and drops its engine; only that answer records the release. Idempotent. */
export async function releaseHostingMove(db: DatabasePool, deployments: { migration: Deployment; hosted: Deployment }, collection: string,
  fetchImpl: typeof fetch = fetch): Promise<HostingMoveStatus> {
  const move = await moveRow(db, collection), record = await hostedRecord(db, collection);
  if (move?.state === "moving" && !move.released_at) {
    const leaving = sha256(record.kms_key_arn) === move.from_kms_key_arn_sha256 ? deployments.migration : deployments.hosted;
    if ((await activate(db, leaving, collection, fetchImpl)).kind === "refused") await db.query(
      "UPDATE next_hosting_moves SET released_at = now() WHERE collection_id = $1 AND state = 'moving' AND moving_at::text = $2 AND released_at IS NULL",
      [collection, move.phase]);
  }
  return hostingMoveStatus(db, collection);
}

/** Wake the CP hosted deployment for a moved collection: a cold open from the log, then sync. */
export async function verifyHostingMove(db: DatabaseQueryable, hosted: Deployment, collection: string,
  fetchImpl: typeof fetch = fetch): Promise<{ activated: true }> {
  if ((await moveRow(db, collection))?.state !== "moved") throw new CreateError(409, "hosting_move_not_moved");
  const result = await activate(db, hosted, collection, fetchImpl);
  if (result.kind === "accepted") return { activated: true };
  throw new CreateError(result.kind === "refused" ? 409 : 503, result.kind === "refused" ? result.reason : "hosting_move_not_ready");
}

/** `/internal/v1/next/migration/hosting-moves…`: the migration token only. Mount only with
 * migration routing: without it migrationRoute() never reads a move. */
export function registerHostingMoveRoutes(app: FastifyInstance, options: {
  db: DatabasePool; token: string; routing: MigrationRouting; hosted: Deployment; fetchImpl?: typeof fetch;
}): void {
  const base = "/internal/v1/next/migration/hosting-moves";
  const config = { rateLimit: migrationServiceRateLimit(options.token, "service:migration:hosting-move") };
  const id = z.object({ id: z.uuid() }).strict();
  const record = z.object({ wrapped_keys: BASE64, kms_key_arn: ARN }).strict();
  const bodies = {
    mark: z.object({ from_kms_key_arn_sha256: HEX64, to_kms_key_arn_sha256: HEX64 }).strict(),
    store: z.object({ expected: record, record }).strict(),
    clear: z.object({}).strict(), reverse: z.object({}).strict(), verify: z.object({}).strict(),
  };
  const handle = async (request: FastifyRequest, reply: FastifyReply, run: () => Promise<unknown>) => {
    reply.header("cache-control", "no-store");
    const token = bearerToken(request);
    if (!token || !safeEqual(token, options.token)) return reply.code(401).send(apiError("invalid_internal_token", "The migration token is required."));
    try { return await run(); } catch (error) {
      if (error instanceof CreateError) return reply.code(error.status).send(apiError(error.code, "The hosting move step was refused."));
      if (["55P03", "57014", "40P01", "40001"].includes(String((error as { code?: unknown })?.code))) return reply.code(503).send(apiError("busy", "Busy; retry."));
      throw error;
    }
  };
  const invalid = () => { throw new CreateError(400, "invalid_request"); };
  app.get(base, { config }, (request, reply) => handle(request, reply, async () => {
    const q = z.object({ kms_key_arn_sha256: HEX64.optional() }).strict().safeParse(request.query);
    if (!q.success) invalid();
    return hostingMoveInventory(options.db, q.data!.kms_key_arn_sha256);
  }));
  app.get(`${base}/:id`, { config }, (request, reply) => handle(request, reply, async () => {
    const p = id.safeParse(request.params);
    if (!p.success) invalid();
    return hostingMoveStatus(options.db, p.data!.id);
  }));
  for (const step of ["mark", "store", "clear", "reverse", "verify"] as const) {
    app.post(`${base}/:id/${step}`, { bodyLimit: 2 * MAX_WRAPPED_KEYS_BYTES + 8192, config }, (request, reply) => handle(request, reply, async () => {
      const p = id.safeParse(request.params), b = bodies[step].safeParse(request.body ?? {});
      if (!p.success || !b.success) invalid();
      const collection = p.data!.id;
      const deployments = { migration: options.routing.hosted, hosted: options.hosted };
      if (step === "mark") {
        const body = b.data as z.infer<typeof bodies.mark>;
        await markHostingMove(options.db, options.routing, collection, body.from_kms_key_arn_sha256, body.to_kms_key_arn_sha256);
        return releaseHostingMove(options.db, deployments, collection, options.fetchImpl);
      }
      if (step === "store") { const body = b.data as z.infer<typeof bodies.store>; return storeHostingMove(options.db, collection, body.expected, body.record); }
      if (step === "clear") return clearHostingMove(options.db, collection);
      if (step === "reverse") {
        await reverseHostingMove(options.db, collection);
        return releaseHostingMove(options.db, deployments, collection, options.fetchImpl);
      }
      return verifyHostingMove(options.db, options.hosted, collection, options.fetchImpl);
    }));
  }
}
