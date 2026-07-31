import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import {
  AuthRateLimiter,
  type AuthRateLimitRule
} from "../../auth-rate-limit.js";
import { BetaAccessRequestService } from "../../beta-access.js";
import type { DatabasePool } from "../../database-types.js";
import { normalizeEmailAddress } from "../../email-identity.js";
import { apiError, OriginDeniedError } from "../../platform/http-errors.js";

const EMAIL_LIMIT: AuthRateLimitRule = {
  maxAttempts: 5,
  windowSeconds: 24 * 60 * 60,
  baseBlockSeconds: 60 * 60,
  maxBlockSeconds: 24 * 60 * 60
};
const IP_LIMIT: AuthRateLimitRule = {
  maxAttempts: 20,
  windowSeconds: 60 * 60,
  baseBlockSeconds: 60 * 60,
  maxBlockSeconds: 24 * 60 * 60
};
const GLOBAL_LIMIT: AuthRateLimitRule = {
  maxAttempts: 300,
  windowSeconds: 60 * 60,
  baseBlockSeconds: 15 * 60,
  maxBlockSeconds: 60 * 60
};

interface BetaAccessRoutesOptions {
  db: DatabasePool;
  allowedOrigin: string;
  rateLimitSecret: string;
}

export function registerBetaAccessRoutes(
  app: FastifyInstance,
  options: BetaAccessRoutesOptions
): void {
  const requests = new BetaAccessRequestService(options.db);
  const limiter = new AuthRateLimiter(options.db, options.rateLimitSecret);

  app.post("/v1/beta-access-requests", {
    config: { rateLimit: { max: 30, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    reply.header("cache-control", "no-store");
    if (request.headers.origin !== options.allowedOrigin) {
      throw new OriginDeniedError();
    }
    const input = z.object({
      email: z.string().trim().pipe(z.email().max(320)),
      website: z.string().max(500).optional()
    }).strict().parse(request.body);
    if (input.website?.trim()) {
      return reply.code(202).send({ accepted: true });
    }
    const normalizedEmail = normalizeEmailAddress(input.email);
    const allowed = await consumeLimits(limiter, [
      {
        scope: "beta_access.email",
        key: normalizedEmail,
        rule: EMAIL_LIMIT
      },
      {
        scope: "beta_access.ip",
        key: request.ip,
        rule: IP_LIMIT
      },
      {
        scope: "beta_access.global",
        key: "global",
        rule: GLOBAL_LIMIT
      }
    ], reply);
    if (!allowed) return;
    await requests.request(input.email);
    return reply.code(202).send({ accepted: true });
  });
}

async function consumeLimits(
  limiter: AuthRateLimiter,
  attempts: Array<{
    scope: string;
    key: string;
    rule: AuthRateLimitRule;
  }>,
  reply: FastifyReply
): Promise<boolean> {
  let retryAfterSeconds = 0;
  for (const attempt of attempts) {
    const decision = await limiter.consume(
      attempt.scope,
      attempt.key,
      attempt.rule
    );
    if (!decision.allowed) {
      retryAfterSeconds = Math.max(
        retryAfterSeconds,
        decision.retryAfterSeconds
      );
    }
  }
  if (retryAfterSeconds === 0) return true;
  reply.header("retry-after", String(retryAfterSeconds));
  reply.code(429).send(apiError(
    "rate_limited",
    "Too many access requests. Please try again later."
  ));
  return false;
}
