import type { FastifyInstance } from "fastify";
import { apiError, OriginDeniedError } from "../../platform/http-errors.js";

interface BetaAccessRoutesOptions {
  allowedOrigin: string;
}

export function registerBetaAccessRoutes(
  app: FastifyInstance,
  options: BetaAccessRoutesOptions
): void {
  app.post("/v1/beta-access-requests", {
    config: { rateLimit: { max: 30, timeWindow: "1 minute" } }
  }, (request, reply) => {
    reply.header("cache-control", "no-store");
    if (request.headers.origin !== options.allowedOrigin) {
      throw new OriginDeniedError();
    }
    return reply.code(410).send(apiError(
      "beta_access_closed",
      "Beta access requests are closed. Public signup is opening soon."
    ));
  });
}
