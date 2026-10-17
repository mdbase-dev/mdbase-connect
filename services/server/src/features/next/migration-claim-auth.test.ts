import { createPrivateKey, sign, verify, createPublicKey } from "node:crypto";
import { readFileSync } from "node:fs";
import rateLimit from "@fastify/rate-limit";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { configuredClaimAudience, issueServiceClaimChallenge, serviceClaimReadDigest, type ServiceClaimFacts } from "./migration-claim-auth.js";
import { registerMigrationProviderRoutes } from "./migration-provider.js";
import type { DatabaseConnection, DatabasePool } from "../../database-types.js";

const golden = JSON.parse(readFileSync(new URL("./fixtures/migration-claim-read-v1.json", import.meta.url), "utf8")) as Record<string, string>;
const facts: ServiceClaimFacts = { collection_id: golden.collection_id!, owner_account: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", started_us: "1791655200123456",
  target: { runtime: "shadow", root_key_id: golden.root_key_id!, hosted: {
    device_id: golden.device_id!, sign_pk: golden.sign_pk!, kem_pk: golden.kem_pk!, noise_pk: golden.noise_pk!
  } } };
const audience = golden.audience!;
const key = createPrivateKey({ format: "der", type: "pkcs8", key: Buffer.concat([
  Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.alloc(32, 0x43)
]) });

describe("closed hosted migration claim authentication DATA", () => {
  it("matches the shared native/CP canonical golden digest and deterministic signature", () => {
    const digest = serviceClaimReadDigest(audience, facts, Buffer.from(golden.challenge!, "hex"));
    expect(Buffer.from(digest).toString("hex")).toBe(golden.digest_hex);
    const sig = sign(null, digest, key);
    expect(sig.toString("hex")).toBe(golden.sig_hex);
    expect(verify(null, digest, createPublicKey(key), sig)).toBe(true);
  });
  it.each(["http://cp.test", "https://CP.test", "https://cp.test/", "https://cp.test:443", "https://user@cp.test", "https://cp.test?q=1", "https://cp.test#x", "https://[::1]", "https://cp.test\n"])("refuses noncanonical/untrusted origin shape %s", value => {
    expect(() => configuredClaimAudience(value)).toThrow();
  });
  it.each(["https://cp.test", "https://127.0.0.1:8443"])("accepts explicit owned canonical origin %s", value => {
    expect(configuredClaimAudience(value)).toBe(value);
  });
  it("binds audience, native collection path/UUID, current tuple and nonce", () => {
    const nonce = Buffer.from(golden.challenge!, "hex"), sig = Buffer.from(golden.sig_hex!, "hex");
    for (const [origin, input, challenge] of [
      ["https://other.test", facts, nonce],
      [audience, { ...facts, collection_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }, nonce],
      [audience, { ...facts, target: { ...facts.target!, root_key_id: "14".repeat(16) } }, nonce],
      [audience, facts, Buffer.alloc(32, 0x56)]
    ] as const) expect(verify(null, serviceClaimReadDigest(origin, input, challenge), createPublicKey(key), sig)).toBe(false);
    expect(() => serviceClaimReadDigest(audience, { ...facts, target: null }, nonce)).toThrow();
    expect(() => serviceClaimReadDigest(audience, facts, Buffer.alloc(33))).toThrow();
    expect(() => serviceClaimReadDigest(audience, { ...facts, started_us: "1\n" }, nonce)).toThrow();
    expect(() => serviceClaimReadDigest(audience, { ...facts, target: { ...facts.target!, hosted: { ...facts.target!.hosted, sign_pk: golden.sign_pk + "\n" } } }, nonce)).toThrow();
  });
  it.each([20, 21])("refuses an excessive unconsumed-live aggregate of %i without issuing a nonce", async n => {
    // The production partial unique index allows only one unused nonce/subject.
    // Exercise the defensive aggregate bound without weakening that SQL index.
    const query = vi.fn().mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ n }], rowCount: 1 });
    const client = { query, release() {} } as DatabaseConnection;
    await expect(issueServiceClaimChallenge(client, audience, facts, facts.target!.hosted.device_id))
      .rejects.toMatchObject({ status: 429, code: "challenge_rate_limited" });
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[1]![0]).toContain("AND used_at IS NULL AND expires_at > clock_timestamp()");
  });
  it("keeps the one-live-nonce refusal below the aggregate bound", async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ n: 1 }], rowCount: 1 });
    await expect(issueServiceClaimChallenge({ query, release() {} } as DatabaseConnection, audience, facts, facts.target!.hosted.device_id))
      .rejects.toMatchObject({ status: 409, code: "challenge_pending" });
    expect(query).toHaveBeenCalledTimes(2);
  });
  it("authenticates the hosted role before JSON parsing or database work", async () => {
    const forbidden = async () => { throw new Error("unauthenticated database access"); };
    const db = { query: forbidden, connect: forbidden, end: forbidden } as DatabasePool;
    const app = Fastify();
    registerMigrationProviderRoutes(app, { db, token: "operator-only", hostedRead: { token: "hosted-only", audience } });
    try {
      for (const credential of [undefined, "operator-only", "escrow", "app", "session"]) {
        const result = await app.inject({ method: "POST", url: `/internal/v1/next/migration/collections/${facts.collection_id}/claim/read`,
          headers: { "content-type": "application/json", ...(credential ? { authorization: `Bearer ${credential}` } : {}) }, payload: "malformed json" });
        expect(result.statusCode).toBe(401); expect(result.headers["cache-control"]).toBe("no-store");
      }
    } finally { await app.close(); }
  });
  it("refuses migration-admin credential reuse as the hosted role", async () => {
    const db = {} as DatabasePool, app = Fastify();
    expect(() => registerMigrationProviderRoutes(app, { db, token: "same", hostedRead: { token: "same", audience } })).toThrow();
    await app.close();
  });
  it("counts hosted-role claim calls against one service budget, not the caller's IP", async () => {
    const forbidden = async () => { throw new Error("no database work expected"); };
    const db = { query: forbidden, connect: forbidden, end: forbidden } as DatabasePool;
    const app = Fastify();
    await app.register(rateLimit, { global: true, max: 600, timeWindow: "1 minute" });
    registerMigrationProviderRoutes(app, { db, token: "operator-only", hostedRead: { token: "hosted-only", audience } });
    const challenge = (credential: string | undefined, remoteAddress: string) => app.inject({
      method: "POST", url: `/internal/v1/next/migration/collections/${facts.collection_id}/claim/challenge`, remoteAddress,
      headers: { "content-type": "application/json", ...(credential ? { authorization: `Bearer ${credential}` } : {}) }, payload: {}
    });
    try {
      // A malformed body is refused after the limiter and before any database work.
      for (let i = 0; i < 4_800; i++) expect((await challenge("hosted-only", i % 2 ? "10.0.0.1" : "10.0.0.2")).statusCode).toBe(400);
      const over = await challenge("hosted-only", "10.0.0.3");
      expect(over.statusCode).toBe(429);
      expect(Number(over.headers["x-ratelimit-limit"])).toBe(4_800);
      // Without the hosted role credential: refused before the limiter, never in the service bucket.
      for (const credential of [undefined, "operator-only", "hosted-only-x"]) {
        const refused = await challenge(credential, "10.0.0.1");
        expect(refused.statusCode).toBe(401); expect(refused.headers["x-ratelimit-limit"]).toBeUndefined();
      }
      // The read route keeps its own bucket.
      const read = await app.inject({ method: "POST", url: `/internal/v1/next/migration/collections/${facts.collection_id}/claim/read`,
        headers: { "content-type": "application/json", authorization: "Bearer hosted-only" }, payload: {} });
      expect(read.statusCode).toBe(400); expect(Number(read.headers["x-ratelimit-remaining"])).toBe(4_799);
    } finally { await app.close(); }
  });
});
