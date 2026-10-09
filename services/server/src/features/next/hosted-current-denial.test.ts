import { generateKeyPairSync } from "node:crypto";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import type { DatabasePool } from "../../database-types.js";
import { registerErrorHandler } from "../../platform/error-handler.js";
import { registerNextHostedRoutes } from "./hosted-routes.js";
import { LogServiceClient } from "./log-service-client.js";

const collection = "11111111-1111-4111-8111-111111111111";
const device = "22222222-2222-4222-8222-222222222222";
const token = "h".repeat(40);

async function fixture(failure?: "lock" | "denial" | "revocation") {
  const queries: string[] = [];
  let minted = 0, released = 0;
  const db = {
    async query() { return { rows: [{ id: collection, sync: "cloud_copy", runtime: "next", left: false, denied: false, local: false }] }; },
    async connect() {
      return {
        async query(text: string) {
          queries.push(text);
          if ((failure === "lock" && text.includes("pg_advisory_xact_lock")) ||
              (failure === "denial" && text.includes("next_collection_deletion_facts")) ||
              (failure === "revocation" && text.includes("next_policy_outbox"))) throw new Error("synthetic authority unavailable");
          if (text.includes("FROM next_service_devices")) return { rows: [{ kind: "hosted", device_id: device, sign_pk: Buffer.alloc(32, 1), kem_pk: Buffer.alloc(32, 2), noise_pk: Buffer.alloc(32, 3), wrapped_keys: Buffer.from("synthetic wrapped record"), kms_key_arn: "arn:test" }] };
          return { rows: [] };
        },
        release() { released++; }
      };
    },
    async end() {}
  } as unknown as DatabasePool;
  const key = generateKeyPairSync("ed25519").privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  const log = new LogServiceClient({ url: "https://log.example.test", tokenIssuerKeyPem: key, transportKeyPem: key }, async () => { throw new Error("no network"); });
  const mint = log.mintToken.bind(log);
  log.mintToken = claims => { minted++; return mint(claims); };
  const app = Fastify();
  registerErrorHandler(app);
  registerNextHostedRoutes(app, { db, tokens: { hosted: token }, log });
  const request = (authorization = `Bearer ${token}`) => app.inject({method: "POST", url: `/internal/v1/next/service-devices/${device}/log-token`, headers: {authorization}, payload: {collection}});
  return { app, request, queries, counts: () => ({minted, released}) };
}

describe("current hosted CP read ordering", () => {
  it("authenticates before any authority read", async () => {
    const f = await fixture();
    try {
      const response = await f.request("Bearer wrong");
      expect(response.statusCode).toBe(401);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(f.queries).toEqual([]);
      expect(f.counts()).toEqual({minted: 0, released: 0});
    } finally { await f.app.close(); }
  });

  it.each(["lock", "denial", "revocation"] as const)("keeps %s authority failures closed with rollback and no credential", async failure => {
    const f = await fixture(failure);
    try {
      const response = await f.request();
      expect(response.statusCode).toBe(500);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.json()).not.toHaveProperty("token");
      expect(response.body).not.toContain("synthetic authority unavailable");
      expect(response.body).not.toContain("synthetic wrapped record");
      expect(f.queries.at(-1)).toBe("ROLLBACK");
      expect(f.counts()).toEqual({minted: 0, released: 1});
    } finally { await f.app.close(); }
  });

  it("checks deletion before loading the record and revocation before mint/commit", async () => {
    const f = await fixture();
    try {
      const response = await f.request();
      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store");
      const denial = f.queries.findIndex(q => q.includes("next_collection_deletion_facts"));
      const record = f.queries.findIndex(q => q.includes("FROM next_service_devices"));
      const revocation = f.queries.findIndex(q => q.includes("next_policy_outbox"));
      expect(denial).toBeGreaterThan(-1);
      expect(record).toBeGreaterThan(denial);
      expect(revocation).toBeGreaterThan(record);
      expect(f.queries.at(-1)).toBe("COMMIT");
      expect(f.counts()).toEqual({minted: 1, released: 1});
    } finally { await f.app.close(); }
  });
});
