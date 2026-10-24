import rateLimit from "@fastify/rate-limit";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerMigrationProviderRoutes } from "./migration-provider.js";
import { registerMigrationReplicaRoutes } from "./migration-replicas.js";
import type { DatabasePool } from "../../database-types.js";

const collection = "11111111-1111-4111-8111-111111111111";

describe("migration-token route rate limits", () => {
  it("counts migration-token calls against a service budget, not the caller's IP", async () => {
    const forbidden = async () => { throw new Error("no database work expected"); };
    const db = { query: forbidden, connect: forbidden, end: forbidden } as unknown as DatabasePool;
    const app = Fastify();
    await app.register(rateLimit, { global: true, max: 600, timeWindow: "1 minute" });
    registerMigrationProviderRoutes(app, { db, token: "migration-only" });
    registerMigrationReplicaRoutes(app, { db, token: "migration-only" });
    // A malformed body is refused after the limiter and before any database work.
    const call = (kind: string, credential: string, remoteAddress: string) => app.inject({
      method: "POST", url: `/internal/v1/next/migration/collections/${collection}/${kind}`, remoteAddress,
      headers: { "content-type": "application/json", authorization: "Bearer " + credential }, payload: { unexpected: true }
    });
    try {
      for (const kind of ["fence", "replicas"]) {
        for (let i = 0; i < 30; i++) {
          const result = await call(kind, "migration-only", "10.0.0.1");
          expect(result.statusCode).toBe(400);
          expect(Number(result.headers["x-ratelimit-limit"])).toBe(4_800);
        }
      }
      // A wrong token keeps the per-IP limit: 20 refusals from one address, then 429.
      for (let i = 0; i < 20; i++) expect((await call("fence", "migration-only-x", "10.0.0.2")).statusCode).toBe(401);
      const over = await call("fence", "migration-only-x", "10.0.0.2");
      expect(over.statusCode).toBe(429);
      expect(Number(over.headers["x-ratelimit-limit"])).toBe(20);
    } finally { await app.close(); }
  });
});
