import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { DatabasePool } from "../../database-types.js";
import { LogServiceClient } from "./log-service-client.js";
import { PolicyEmitter } from "./policy-outbox.js";
import { certToJson, ed25519RawPublicKey } from "./policy-keys.js";
import { certDigest, keyId, type PolicySigner } from "./policy-wire.js";

const collection = "00000000-0000-4000-8000-000000000001";
const pem = (key: KeyObject) => key.export({ format: "pem", type: "pkcs8" }).toString();
function config() {
  const root = generateKeyPairSync("ed25519").privateKey, policy = generateKeyPairSync("ed25519").privateKey;
  const cert = { policyPublicKey: ed25519RawPublicKey(policy), root: keyId(ed25519RawPublicKey(root)), notBefore: Date.now() - 60_000, notAfter: Date.now() + 30 * 86_400_000 };
  return { rootPublicKey: ed25519RawPublicKey(root), policyPrivateKeyPem: pem(policy), policyCert: certToJson({ ...cert, signature: sign(null, certDigest(cert), root) }),
    serviceTokens: { hosted: "h".repeat(40), escrow: "e".repeat(40) },
    logService: { url: "https://private-target.invalid/secret-token", tokenIssuerKeyPem: pem(policy), transportKeyPem: pem(policy) } };
}
function reset() {
  const error = new TypeError(`fetch failed ${collection} Bearer secret-token https://private-target.invalid`, {
    cause: Object.assign(new Error("read ECONNRESET private-target.invalid"), { code: "ECONNRESET" })
  });
  error.stack = `TypeError: secret-token ${collection}\n    at LogServiceClient.fetchBytes (/private/${collection}/log-service-client.ts:187:9)\n    at async PolicyEmitter.sendStep (file:///secret-token/policy-outbox.js:337:7)\n    at secret-token (https://private-target.invalid/untrusted.js:22:3)`;
  return Object.freeze(error);
}
function client(error: unknown, step: "nonce" | "rpc", bodyFailure = false) {
  const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
    if (step === "rpc" && init?.method === "GET") return new Response("00".repeat(32));
    if (bodyFailure) return new Response(new ReadableStream({ start(controller) { controller.error(error); } }));
    throw error;
  });
  return { log: new LogServiceClient(config().logService, fetcher), fetcher };
}
const methods = ["head", "control-item", "create_log", "append"] as const;
async function call(log: LogServiceClient, phase: typeof methods[number]) {
  switch (phase) {
    case "head": return log.head(collection);
    case "control-item": return log.controlItemAt(collection, 1);
    case "create_log": return log.createLog(collection, Uint8Array.of(1));
    case "append": return log.append(collection, 1, new Uint8Array(32), [Uint8Array.of(1)]);
  }
}

describe("policy failure attribution", () => {
  for (const phase of methods) for (const step of ["nonce", "rpc"] as const) {
    it(`attributes ${phase}/${step} without changing the original frozen error or leaking context`, async () => {
      const error = reset(), { log, fetcher } = client(error, step);
      await expect(call(log, phase)).rejects.toBe(error);
      const details = LogServiceClient.failureDetails(error);
      expect(details).toEqual({ callback_phase: phase, transport_step: step, route: `/v1/${step}`,
        error_code: "ECONNRESET", stack_summary: ["log-service-client.ts:187:9", "policy-outbox.js:337:7"] });
      expect(fetcher).toHaveBeenCalledTimes(step === "nonce" ? 1 : 2);
      const serialized = JSON.stringify(details);
      for (const secret of [collection, "secret-token", "private-target", "Bearer", "/private/"]) expect(serialized).not.toContain(secret);
      expect(Object.isFrozen(error)).toBe(true);
    });
  }

  it.each(["nonce", "rpc"] as const)("attributes %s body-read rejection even when the runtime has no owned stack frame", async step => {
    const error = Object.assign(new TypeError("fetch failed", { cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }) }),
      { stack: "TypeError: fetch failed\n    at TLSWrap.onStreamRead (node:internal/stream_base_commons:218:20)" });
    const { log } = client(error, step, true);
    await expect(log.head(collection)).rejects.toBe(error);
    expect(LogServiceClient.failureDetails(error)).toEqual({ callback_phase: "head", transport_step: step, route: `/v1/${step}`, error_code: "ECONNRESET", stack_summary: [] });
  });

  it.each(["TimeoutError", "AbortError"])("reports the standard %s name without its potentially sensitive message", async name => {
    const error = new DOMException(`secret-token ${collection}`, name), { log } = client(error, "nonce");
    await expect(log.head(collection)).rejects.toBe(error);
    expect(LogServiceClient.failureDetails(error).error_code).toBe(name);
    expect(JSON.stringify(LogServiceClient.failureDetails(error))).not.toContain("secret-token");
  });

  it("marks recovery context and reports the same original error to onError", async () => {
    const error = reset(), { log } = client(error, "rpc"), report = vi.fn();
    const release = vi.fn();
    const db = { query: vi.fn(async (sql: string) => ({ rows: sql.includes("SELECT DISTINCT") ? [{ collection_id: collection }] : [] })),
      connect: async () => ({ release, query: async (sql: string) => ({ rows:
        sql.includes("pg_locks") ? [{ owned: true }] : sql.includes("pg_advisory_unlock") ? [{ unlocked: true }]
          : sql.includes("next_collections") ? [{ collection_id: collection }] : [] }) }) } as unknown as DatabasePool;
    const emitter = new PolicyEmitter(db, log, {} as PolicySigner, report);
    try {
      expect(await emitter.drain()).toBe(0);
      expect(report).toHaveBeenCalledExactlyOnceWith(error, collection, { callback_phase: "recover", transport_step: "rpc", route: "/v1/rpc",
        error_code: "ECONNRESET", stack_summary: ["log-service-client.ts:187:9", "policy-outbox.js:337:7"] });
      expect(release).toHaveBeenCalledOnce();
    } finally { await emitter.close(); }
  });

  it("does not echo arbitrary codes, messages, primitive failures or unowned frames", async () => {
    const error = Object.assign(new Error(`Bearer secret-token ${collection}`), { code: "secret-token", stack: "secret-token\n at external (https://private-target.invalid/secret-token:1:2)" });
    expect(LogServiceClient.failureDetails(error)).toEqual({ callback_phase: "unknown", transport_step: "unknown", route: undefined, error_code: "unknown", stack_summary: [] });
    expect(JSON.stringify(LogServiceClient.failureDetails("Bearer secret-token"))).not.toContain("secret-token");
    expect(LogServiceClient.failureDetails(Object.assign(new Error("SQL message with identifiers"), { code: "25P03" })).error_code).toBe("25P03");
  });

  it("actual app wiring logs only sanitized facts at error level, never raw err or collectionId", async () => {
    const { buildApp } = await import("../../app.js"), { createDatabase } = await import("../../db.js");
    let captured!: { onError(error: unknown, id: string, facts: Record<string, unknown>): void };
    const start = vi.spyOn(PolicyEmitter.prototype, "start").mockImplementation(function (this: PolicyEmitter) {
      captured = this as unknown as typeof captured;
    });
    const db = await createDatabase("memory");
    const { app } = await buildApp({ db, nextControlPlane: config() });
    const logged = vi.spyOn(app.log, "error");
    const facts = { callback_phase: "head", transport_step: "nonce", route: "/v1/nonce", error_code: "ECONNRESET", stack_summary: [] };
    try {
      captured.onError(reset(), collection, facts);
      expect(logged).toHaveBeenCalledExactlyOnceWith(facts, "mdbase-next policy emission failed");
      expect(JSON.stringify(logged.mock.calls)).not.toContain(collection);
      expect(JSON.stringify(logged.mock.calls)).not.toContain("secret-token");
    } finally { await app.close(); await db.end(); logged.mockRestore(); start.mockRestore(); }
  });
});
