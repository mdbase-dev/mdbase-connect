import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { ACCOUNT_COLLECTION_QUOTA_MESSAGE } from "../../platform/collection-quota-copy.generated.js";
import { CreateError, refuse } from "./bootstrap-common.js";

describe("collection quota refusal", () => {
  it("uses the shared actionable copy rather than a route-specific deletion instruction", async () => {
    const server = Fastify();
    server.get("/", (_request, reply) => refuse(reply, new CreateError(429, "account_collection_quota_exceeded"), "Delete a synced collection before creating another."));
    try {
      const response = await server.inject("/");
      expect(response.statusCode).toBe(429);
      expect(response.json().error).toMatchObject({ code: "account_collection_quota_exceeded", message: ACCOUNT_COLLECTION_QUOTA_MESSAGE });
    } finally {
      await server.close();
    }
  });
});
