// What the hosted replica and escrow deployments read from the control plane
// (mdbase-next interface note 2026-10-04-control-hosted-replica.md). Each deployment
// has its own bearer token, accepted only on these routes; neither is the provider's
// internal token.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { DatabaseQueryable } from "../../database-types.js";
import { apiError } from "../../platform/http-errors.js";
import { bearerToken } from "../../platform/request-authentication.js";
import { safeEqual } from "../../security.js";
import { LOG_TOKEN_LIFETIME_MS, type LogServiceClient } from "./log-service-client.js";
import { loadServiceDevice, serviceDeviceWire, type ServiceKind } from "./service-devices.js";

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

export function registerNextHostedRoutes(
  app: FastifyInstance,
  options: { db: DatabaseQueryable; tokens: { hosted?: string; escrow?: string }; log?: LogServiceClient; now?: () => number }
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
    const record = await loadServiceDevice(options.db, id, { kind });
    if (!record) return notCurrent(reply, id, "The collection has no service device of this kind.");
    return serviceDeviceWire(record);
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
    const record = await loadServiceDevice(options.db, collection, { device: device.toLowerCase() });
    if (!record) return notCurrent(reply, collection, "No such service device in this collection.");
    if (record.kind !== caller) return reply.code(403).send(apiError("wrong_service_kind", "This token mints only for its own kind of service device."));
    const expiresAt = (options.now ?? Date.now)() + LOG_TOKEN_LIFETIME_MS;
    return { token: log.mintToken({ device: record.device_id, signPublicKey: record.sign_pk, collection, expiresAt }), expires_at: expiresAt };
  });
}
