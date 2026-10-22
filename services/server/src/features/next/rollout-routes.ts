// The daemon's automatic local-takeover gate: GET /v1/next/rollout.
//
// - Only an active connector credential (the old connector or the new daemon,
//   both paired through connector pairing) is accepted. App installation
//   credentials, sessions and anonymous callers get 401.
// - The account comes only from the credential; query parameters and headers
//   never select an account or open the gate.
// - Response shape is frozen: deployed daemons reject unknown fields; extend via a new endpoint/version.
// - The answer is exactly the daemon contract `{local_takeover, account_backend}`
//   from `localTakeoverAllowed`, which is true only for an account on the next
//   backend (a flipped migration or a new next account), and is never cached.
import type { FastifyInstance } from "fastify";
import type { DatabasePool } from "../../database-types.js";
import { requireConnector } from "../../platform/request-authentication.js";
import { localTakeoverAllowed } from "./migration-rollout.js";

export function registerNextRolloutRoutes(app: FastifyInstance, db: DatabasePool): void {
  app.get("/v1/next/rollout", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (request, reply) => {
    reply.header("cache-control", "no-store");
    const connector = await requireConnector(request, reply, db);
    if (!connector) return reply;
    const { local_takeover, account_backend } = await localTakeoverAllowed(db, connector.user_id);
    return { local_takeover, account_backend };
  });
}
