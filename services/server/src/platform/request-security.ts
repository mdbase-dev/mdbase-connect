import type { FastifyRequest } from "fastify";
import { OriginDeniedError } from "./http-errors.js";

export function requireSameOrigin(
  request: FastifyRequest,
  publicUrl: string
): void {
  if (request.headers.origin !== new URL(publicUrl).origin) {
    throw new OriginDeniedError();
  }
}
