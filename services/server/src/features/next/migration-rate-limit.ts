// Rate limiting for the migration-token and hosted-role fronts. Their callers
// (the hosted Worker's migration executor, one Durable Object per collection,
// and the fence-first Driver) share Cloudflare egress addresses, so a per-IP
// limit is one budget for every running collection together. A request
// carrying the route's own credential counts against a per-route service
// bucket instead; anything else keeps the per-IP limit.
//
// Sizing: besides the claim routes (one read per executor action; see
// migration-provider.ts), each of these routes is called at most a few times
// per collection run: fence, source, target, source-witness, the replica and
// policy steps, and cutover. The staging envelope is at most 850 accounts and
// 10,000 hosted collections. The executor's per-collection rate is bounded by
// latency at about 300 actions a minute and a run is at least 20 fixed
// actions, so with the rollout plan's 8 workers at most about 120 runs finish
// a minute: a few hundred requests a minute per route, with retries and
// idempotent replays included. 4,800 a minute per route keeps more than ten
// times headroom over that ceiling and matches the claim budget, so no one
// route becomes the run's bottleneck.
import { normalizeIP } from "@fastify/rate-limit";
import type { FastifyRequest } from "fastify";
import { bearerToken } from "../../platform/request-authentication.js";
import { safeEqual } from "../../security.js";

const MIGRATION_IP_REQUESTS_PER_MINUTE = 20;
const MIGRATION_SERVICE_REQUESTS_PER_MINUTE = 4_800;

/** Route `config.rateLimit`: `token` holders share `bucket`; others are per-IP. */
export function migrationServiceRateLimit(token: string, bucket: string) {
  return {
    timeWindow: "1 minute",
    keyGenerator(request: FastifyRequest): string {
      const presented = bearerToken(request);
      return presented && safeEqual(presented, token) ? bucket : normalizeIP(request.ip);
    },
    max: (_request: FastifyRequest, key: string): number =>
      key === bucket ? MIGRATION_SERVICE_REQUESTS_PER_MINUTE : MIGRATION_IP_REQUESTS_PER_MINUTE
  };
}
