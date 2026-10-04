// What the hosted replica and escrow deployments read from the control plane
// (mdbase-next interface note 2026-10-04-control-hosted-replica.md). Each deployment
// has its own bearer token, accepted only on these routes; neither is the provider's
// internal token.
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { DatabaseQueryable } from "../../database-types.js";
import { apiError } from "../../platform/http-errors.js";
import { bearerToken } from "../../platform/request-authentication.js";
import { safeEqual } from "../../security.js";

export type ServiceKind = "hosted" | "escrow";
export type CollectionDirectoryState = "standard" | "private" | "local" | "unknown";

export interface CollectionDirectoryEntry {
  collection: string;
  state: CollectionDirectoryState;
  runtime: "shadow" | "next" | null;
}

/**
 * The state of each collection for the hosted replica (§1). `standard` (cloud copy) is
 * the only state that admits a hosted replica; anything Connect doesn't know as synced
 * or local is `unknown`, which the hosted replica refuses.
 */
export async function collectionDirectory(db: DatabaseQueryable, ids: readonly string[]): Promise<CollectionDirectoryEntry[]> {
  const rows = await db.query<{ id: string; sync: "private" | "cloud_copy" | null; runtime: "shadow" | "next" | null; local: boolean }>(
    `SELECT requested.id::text AS id, next.sync, next.runtime,
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
    const state: CollectionDirectoryState = row?.sync === "cloud_copy" ? "standard"
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
  options: { db: DatabaseQueryable; tokens: { hosted?: string; escrow?: string } }
): void {
  const authorize = (request: FastifyRequest) => serviceKind(request, options.tokens) !== null;
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
}
