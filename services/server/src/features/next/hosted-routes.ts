// What the hosted replica and escrow deployments read from the control plane
// (mdbase-next interface note 2026-10-04-control-hosted-replica.md). Each deployment
// has its own bearer token, accepted only on these routes; neither is the provider's
// internal token.
import { createHash } from "node:crypto";
import { decodeCbor, uuidBytes, type Decoded } from "./policy-wire.js";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { DatabasePool, DatabaseQueryable } from "../../database-types.js";
import { apiError } from "../../platform/http-errors.js";
import { bearerToken } from "../../platform/request-authentication.js";
import { safeEqual } from "../../security.js";
import { LOG_TOKEN_LIFETIME_MS, type LogServiceClient } from "./log-service-client.js";
import { loadServiceDevice, serviceDeviceWire, type ServiceDeviceRecord, type ServiceKind } from "./service-devices.js";

export type CollectionDirectoryState = "standard" | "private" | "local" | "unknown";

export interface CollectionDirectoryEntry {
  collection: string;
  state: CollectionDirectoryState;
  runtime: "shadow" | "next" | null;
}

/**
 * The state of each collection for the hosted replica (§1). `standard` (cloud copy) is
 * the only state that admits a hosted replica. A collection that has left sync, or that
 * Connect doesn't know as synced or local, is `unknown`, which the hosted replica refuses.
 */
export async function collectionDirectory(db: DatabaseQueryable, ids: readonly string[]): Promise<CollectionDirectoryEntry[]> {
  const rows = await db.query<{ id: string; sync: "private" | "cloud_copy" | null; runtime: "shadow" | "next" | null; left: boolean; local: boolean }>(
    `SELECT requested.id::text AS id, next.sync, next.runtime, next.left_sync_at IS NOT NULL AS left,
            EXISTS (SELECT 1 FROM collections local
                    WHERE local.local_id = requested.id
                      AND local.authority_state <> 'retired' AND local.removed_at IS NULL) AS local
     FROM unnest($1::uuid[]) AS requested(id)
     LEFT JOIN next_collections next ON next.collection_id = requested.id`,
    [ids]
  );
  const byId = new Map(rows.rows.map((row) => [row.id, row]));
  return ids.map((id) => {
    const row = byId.get(id);
    // A collection that has left sync is never standard again, even while its local
    // row also exists: the hosted replica must close it at once.
    const state: CollectionDirectoryState = row?.left ? "unknown"
      : row?.sync === "cloud_copy" ? "standard"
        : row?.sync === "private" ? "private"
          : row?.local ? "local" : "unknown";
    return { collection: id, state, runtime: row?.runtime ?? null };
  });
}

/** The service kind whose token the request carries, or null. Constant-time comparison. */
export function serviceKind(request: FastifyRequest, tokens: { hosted?: string; escrow?: string }): ServiceKind | null {
  const presented = bearerToken(request);
  if (!presented) return null;
  if (tokens.hosted && safeEqual(presented, tokens.hosted)) return "hosted";
  if (tokens.escrow && safeEqual(presented, tokens.escrow)) return "escrow";
  return null;
}

/**
 * Run `use` on the current record while its collection row is share-locked, in one
 * transaction. Leaving sync updates that row, so it waits until `use` has finished:
 * a record served or a token minted here was served while the collection was current.
 * Null when there is no current record.
 */
async function withCurrentRecord<T>(
  db: DatabasePool, collection: string, by: { kind: ServiceKind } | { device: string }, use: (record: ServiceDeviceRecord, client: DatabaseQueryable) => T | Promise<T>
): Promise<T | null> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '5s'");
    const record = await loadServiceDevice(client, collection, by);
    const result = record ? await use(record, client) : null;
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

const ORIGINAL_GENESIS_BYTES_MAX = 64 * 1024;
const HOSTED_BOOTSTRAP_BYTES_MAX = 128 * 1024;
class OriginalGenesisUnavailable extends Error {}
/** Structural admission only, not a second crypto verifier. The deployment must
 * verify this ORIGINAL signed item with bundled PolicyPins BEFORE any KMS/keys.
 * Original genesis may predate cloud-copy; it never proves current mode. */
async function originalGenesis(db: DatabaseQueryable, collection: string) {
  const rows = await db.query<{state: string; item: Buffer | null}>(
    `SELECT state, CASE WHEN octet_length(item) BETWEEN 1 AND $2 THEN item ELSE NULL END AS item
     FROM next_policy_batches WHERE collection_id=$1 AND seq=1 ORDER BY id LIMIT 2 FOR SHARE`,
    [collection, ORIGINAL_GENESIS_BYTES_MAX],
  );
  const row = rows.rows[0];
  if (rows.rows.length !== 1 || row?.state !== "appended" || !row.item) throw new OriginalGenesisUnavailable();
  const item = row.item;
  const bytes = (v: Decoded | undefined, n: number): v is Uint8Array => v instanceof Uint8Array && v.length === n;
  const shape = (v: Decoded | undefined, keys: number[]): v is Map<number, Decoded> => v instanceof Map && v.size === keys.length && keys.every(k => v.has(k));
  try {
    const frame = decodeCbor(item, {maxDepth: 32, canonicalStructs: true});
    if (!shape(frame, [0,1,2,3,4,6,11,12]) || frame.get(0) !== 1 || frame.get(1) !== 2 || frame.get(3) !== 1 || !bytes(frame.get(2),16) || !Buffer.from(frame.get(2) as Uint8Array).equals(Buffer.from(uuidBytes(collection))) || !bytes(frame.get(4),32) || (frame.get(4) as Uint8Array).some(v => v !== 0) || !bytes(frame.get(6),16) || !bytes(frame.get(12),64)) throw new OriginalGenesisUnavailable();
    const body = frame.get(11);
    if (!(body instanceof Uint8Array) || !body.length) throw new OriginalGenesisUnavailable();
    const payload = decodeCbor(body, {maxDepth: 32, canonicalStructs: true});
    if (!shape(payload,[0,1,2,3]) || payload.get(0) !== 1 || !Number.isSafeInteger(payload.get(2))) throw new OriginalGenesisUnavailable();
    const cert = payload.get(1), ops = payload.get(3);
    if (!shape(cert,[0,1,2,3,4]) || !bytes(cert.get(0),32) || !Number.isSafeInteger(cert.get(1)) || !Number.isSafeInteger(cert.get(2)) || !bytes(cert.get(3),16) || !bytes(cert.get(4),64) || !Array.isArray(ops) || !ops.length) throw new OriginalGenesisUnavailable();
    const genesis = ops[0];
    if (!shape(genesis,[0,1,2,3]) || genesis.get(0) !== 1 || !bytes(genesis.get(1),16) || !bytes(genesis.get(2),16) || (genesis.get(3) !== 0 && genesis.get(3) !== 1)) throw new OriginalGenesisUnavailable();
  } catch { throw new OriginalGenesisUnavailable(); }
  return {seq: 1 as const, item: item.toString("base64"), hash: createHash("sha256").update(item).digest("hex")};
}

export function registerNextHostedRoutes(
  app: FastifyInstance,
  options: { db: DatabasePool; tokens: { hosted?: string; escrow?: string }; log?: LogServiceClient; now?: () => number }
): void {
  const authorize = (request: FastifyRequest) => serviceKind(request, options.tokens) !== null;
  // The record lookup itself requires a current cloud copy; this only picks the answer
  // for a miss: 409 when the collection is not (or no longer) a cloud copy, else 404.
  const notCurrent = async (reply: FastifyReply, collection: string, missing: string) =>
    (await collectionDirectory(options.db, [collection]))[0]!.state !== "standard"
      ? reply.code(409).send(apiError("collection_not_standard", "The collection is not a cloud copy."))
      : reply.code(404).send(apiError("service_device_not_found", missing));
  app.get("/internal/v1/next/collections/:id/state", async (request, reply) => {
    if (!authorize(request)) return reply.code(401).send(apiError("invalid_internal_token", "Internal token required."));
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    return (await collectionDirectory(options.db, [id]))[0];
  });
  app.post("/internal/v1/next/collections/states", async (request, reply) => {
    if (!authorize(request)) return reply.code(401).send(apiError("invalid_internal_token", "Internal token required."));
    const { ids } = z.object({ ids: z.array(z.uuid()).min(1).max(500) }).strict().parse(request.body);
    return { collections: await collectionDirectory(options.db, [...new Set(ids)]) };
  });

  // A deployment reads only its own kind's record, and only while the collection is
  // standard: a collection that left sync, or never was cloud copy, has no service device.
  app.get("/internal/v1/next/collections/:id/service-devices/:kind", async (request, reply) => {
    const caller = serviceKind(request, options.tokens);
    if (!caller) return reply.code(401).send(apiError("invalid_internal_token", "Internal token required."));
    const { id, kind } = z.object({ id: z.uuid(), kind: z.enum(["hosted", "escrow"]) }).parse(request.params);
    if (kind !== caller) return reply.code(403).send(apiError("wrong_service_kind", "This token reads only its own kind of service device."));
    try {
      const wire = await withCurrentRecord(options.db, id, { kind }, async (record, client) => {
        const result = {...serviceDeviceWire(record), genesis: await originalGenesis(client, id)};
        if (Buffer.byteLength(JSON.stringify(result), "utf8") > HOSTED_BOOTSTRAP_BYTES_MAX) throw new OriginalGenesisUnavailable();
        return result;
      });
      if (!wire) return notCurrent(reply, id, "The collection has no service device of this kind.");
      return wire;
    } catch (e) {
      if (e instanceof OriginalGenesisUnavailable) return reply.code(503).send(apiError("original_genesis_unavailable", "The collection's original registration is not ready."));
      throw e;
    }
  });
  // Role-0 log token for a service device, narrowed to one collection (claim 5) and
  // valid for at most LOG_TOKEN_LIFETIME_MS. The deployment refreshes it by asking again.
  const log = options.log;
  if (log) app.post("/internal/v1/next/service-devices/:device/log-token", async (request, reply) => {
    const caller = serviceKind(request, options.tokens);
    if (!caller) return reply.code(401).send(apiError("invalid_internal_token", "Internal token required."));
    const params = z.object({ device: z.uuid() }).safeParse(request.params);
    const body = z.object({ collection: z.uuid() }).strict().safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send(apiError("invalid_request", "A device and collection are required."));
    const { device } = params.data;
    const { collection } = body.data;
    const minted = await withCurrentRecord(options.db, collection, { device: device.toLowerCase() }, (record) => {
      if (record.kind !== caller) return "wrong_kind" as const;
      const expiresAt = (options.now ?? Date.now)() + LOG_TOKEN_LIFETIME_MS;
      return { token: log.mintToken({ device: record.device_id, signPublicKey: record.sign_pk, collection, expiresAt }), expires_at: expiresAt };
    });
    if (!minted) return notCurrent(reply, collection, "No such service device in this collection.");
    if (minted === "wrong_kind") return reply.code(403).send(apiError("wrong_service_kind", "This token mints only for its own kind of service device."));
    return minted;
  });
}
