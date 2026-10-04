import type { FastifyInstance } from "fastify";
import type { DatabasePool } from "../../database-types.js";
import { apiError } from "../../platform/http-errors.js";
import { requireConnector } from "../../platform/request-authentication.js";
import type { PolicyEmitter } from "./policy-outbox.js";

export function registerPolicyRecoveryRoutes(app: FastifyInstance, db: DatabasePool, emitter: PolicyEmitter): void {
  app.post<{ Params: { id: string } }>("/v1/next/collections/:id/lost-policy", {
    config: { rateLimit: { max: 6, timeWindow: "1 minute" } },
    schema: {
      params: { type: "object", required: ["id"], properties: { id: { type: "string", format: "uuid" } } },
      body: {
        type: "object", additionalProperties: false, required: ["from_seq", "to_seq", "ops_digest"],
        properties: {
          from_seq: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
          to_seq: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
          ops_digest: { type: "string", pattern: "^[0-9a-f]{64}$" }
        }
      }
    }
  }, async (request, reply) => {
    const connector = await requireConnector(request, reply, db);
    if (!connector) return reply;
    // Owner-only hints for now; all collections are also checked periodically.
    // No caller account ID, digest or seq range controls a reissue.
    const owned = await db.query("SELECT 1 FROM next_collections WHERE collection_id = $1 AND owner_user_id = $2", [request.params.id, connector.user_id]);
    if (!owned.rows.length) return reply.code(404).send(apiError("not_found", "Collection not found."));
    emitter.hintLostPolicy(request.params.id);
    return reply.code(202).send({ accepted: true });
  });
  // Keep existing readiness behavior unchanged when the feature is disabled.
  app.addHook("preHandler", async (request, reply) => {
    if (request.routeOptions.url !== "/ready") return;
    const parked = await db.query("SELECT 1 FROM next_policy_batches WHERE state = 'parked' LIMIT 1");
    if (parked.rows.length) return reply.code(503).send({ ok: false, service: "mdbase-connect", next_policy: "parked" });
  });
}
