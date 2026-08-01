import type { FastifyRequest } from "fastify";
import { OriginDeniedError } from "./http-errors.js";

export function requireSameOrigin(
  request: FastifyRequest,
  publicUrl: string,
  additionalOrigins: readonly string[] = []
): void {
  const allowed = new Set([
    new URL(publicUrl).origin,
    ...additionalOrigins.map((origin) => new URL(origin).origin)
  ]);
  if (!request.headers.origin || !allowed.has(request.headers.origin)) {
    throw new OriginDeniedError();
  }
}
