import type { FastifyReply, FastifyRequest } from "fastify";
import { CreateError, refuse } from "./bootstrap-common.js";

export const DEFAULT_COLLECTION_DISPLAY_NAME = "New collection";

/** Inspect raw names before JSON-schema coercion; null/numbers are not names. */
export async function validateInitialCollectionName(request: FastifyRequest, reply: FastifyReply) {
  if (request.body && typeof request.body === "object" && "display_name" in request.body) {
    try { collectionDisplayName(request.body.display_name); }
    catch (error) { return refuse(reply, error, "Use a single-line name of 1–200 UTF-16 units."); }
  }
}

/** Display-only metadata: trim edges, but do not repair Unicode or normalize names. */
export function collectionDisplayName(value: unknown): string {
  if (typeof value !== "string" || /[\ud800-\udfff]/u.test(value) || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value)) {
    throw new CreateError(400, "invalid_display_name");
  }
  const name = value.trim();
  // Match the existing public naming limit: JavaScript UTF-16 code units.
  if (name.length === 0 || name.length > 200) throw new CreateError(400, "invalid_display_name");
  return name;
}
