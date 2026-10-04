// The old daemon's takeover gate. Mounted only with the next control plane.
// Initial delivery is deliberately closed for every account: opening a cohort
// requires a separately reviewed rollout change, never a caller-supplied switch.
import type { FastifyInstance } from "fastify";
import type { DatabasePool } from "../../database-types.js";
import { requireConnector } from "../../platform/request-authentication.js";

export function registerNextRolloutRoutes(app: FastifyInstance, db: DatabasePool): void {
  app.get("/v1/next/rollout", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (request, reply) => {
    const connector = await requireConnector(request, reply, db);
    if (!connector) return reply;
    reply.header("cache-control", "no-store");
    return { local_takeover: false };
  });
}
