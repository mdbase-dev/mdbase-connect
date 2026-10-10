import { createPrivateKey, sign, verify, createPublicKey } from "node:crypto";
import { readFileSync } from "node:fs";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { configuredClaimAudience, serviceClaimReadDigest, type ServiceClaimFacts } from "./migration-claim-auth.js";
import { registerMigrationProviderRoutes } from "./migration-provider.js";
import type { DatabasePool } from "../../database-types.js";

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
});
