import { createPublicKey, verify } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { keyPairFromSecret, type KeyPair, type MdbaseClient } from "@mdbase-dev/sdk";
import type { GrantKeyRecord, GrantKeyStore } from "@mdbase-dev/connect/crypto";
import { LEGACY, NextGateway, type NextConnection } from "./next-gateway.js";
import { clientKeyAttachMessage, clientNoiseKeyMessage, type NoiseKeyStore } from "./next-keys.js";

const connection: NextConnection = {
  id: "conn-1", upstream_url: "https://connect.example/v1/hosted/app", collection_id: "col-1",
  display_name: "Notes", operations: ["query"], key_handle: "gk-1"
};
const grantId = "4c18af2e-b04a-4b77-b83e-493c3695962e", authorizationId = "0b8f6a7e-3c1d-4e2f-9a0b-1c2d3e4f5a6b";

async function fixture(routes: Array<{ status: number; body: unknown }>, attachStatus = 200) {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const grantKey = { handle: "gk-1", signingPrivateKey: pair.privateKey, signingPublicKey: "" } as GrantKeyRecord;
  const verifier = createPublicKey({ key: await crypto.subtle.exportKey("jwk", pair.publicKey) as never, format: "jwk" });
  let stored: KeyPair | null = null;
  const noise = {
    get: async () => stored,
    create: async () => (stored = keyPairFromSecret(new Uint8Array(32).fill(7)))
  } as unknown as NoiseKeyStore;
  const calls: Array<{ url: string; body?: Record<string, string> }> = [];
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
    if (url.endsWith("/v1/next/grants/client-key")) return new Response("{}", { status: attachStatus });
    const next = routes.shift()!;
    return new Response(JSON.stringify(next.body), { status: next.status });
  });
  const client = { query: vi.fn(async () => ({ records: [], complete: true, asOf: 1 })), close: vi.fn() } as unknown as MdbaseClient;
  const open = vi.fn(async () => client);
  const gateway = new NextGateway({ keyStore: { get: async () => grantKey } as unknown as GrantKeyStore, noise, version: "test", fetch: fetch as typeof globalThis.fetch, open });
  return { gateway, calls, open, verifier, noiseKey: () => stored };
}

const keyRequired = { status: 409, body: { error: { code: "client_key_required", details: { grant_id: grantId, authorization_id: authorizationId } } } };
const routed = { status: 200, body: { collection: "col-1", grant: "log-grant", targets: [{ kind: "hosted" }] } };

describe("NextGateway", () => {
  it("attaches a Noise key signed by the grant key when the route asks for one, then opens the session", async () => {
    const f = await fixture([keyRequired, routed]);
    expect(await f.gateway.run(connection, "access", "query", {}, "req-1")).toEqual({ results: [], meta: { has_more: false } });
    expect(f.calls.map((call) => new URL(call.url).pathname)).toEqual([
      "/v1/next/collections/col-1/route", "/v1/next/grants/client-key", "/v1/next/collections/col-1/route"
    ]);
    const body = f.calls[1].body!, pk = Buffer.from(body.public_key, "base64url");
    expect(pk.equals(Buffer.from(f.noiseKey()!.publicKey))).toBe(true);
    expect(body.grant_id).toBe(grantId);
    const ok = (message: Buffer, signature: string) => verify("sha256", message, { key: f.verifier, dsaEncoding: "ieee-p1363" }, Buffer.from(signature, "base64url"));
    expect(ok(clientNoiseKeyMessage(authorizationId, pk), body.attestation)).toBe(true);
    expect(ok(clientKeyAttachMessage(grantId, pk, body.expires_at, Buffer.from(body.nonce, "base64url")), body.signature)).toBe(true);
    expect(Date.parse(body.expires_at) - Date.now()).toBeLessThanOrEqual(5 * 60_000);
    expect(f.open).toHaveBeenCalledWith(expect.objectContaining({ grant: "log-grant" }));
  });

  it("asks for re-approval when the attach is refused or the grant still needs a key", async () => {
    const refused = await fixture([keyRequired], 409);
    await expect(refused.gateway.run(connection, "access", "query", {}, "req-1")).rejects.toMatchObject({ code: "reconnect_required" });
    const again = await fixture([keyRequired, keyRequired]);
    await expect(again.gateway.run(connection, "access", "query", {}, "req-1")).rejects.toMatchObject({ code: "reconnect_required" });
    expect(again.calls.filter((call) => call.url.endsWith("/client-key"))).toHaveLength(1);
  });

  it("falls back to the legacy authority without a next control plane or route target", async () => {
    for (const route of [{ status: 404, body: {} }, { status: 405, body: {} }, { status: 200, body: { collection: "col-1", grant: "g", targets: [] } }]) {
      const f = await fixture([route]);
      expect(await f.gateway.run(connection, "access", "query", {}, "req-1")).toBe(LEGACY);
      expect(await f.gateway.run(connection, "access", "query", {}, "req-2")).toBe(LEGACY);
      expect(f.calls).toHaveLength(1); // cached
      expect(f.open).not.toHaveBeenCalled();
    }
  });

  it("maps an expired access token to the refresh path", async () => {
    const f = await fixture([{ status: 401, body: {} }]);
    await expect(f.gateway.run(connection, "access", "query", {}, "req-1")).rejects.toMatchObject({ code: "authority_authentication_expired" });
  });
});

describe("Noise key messages", () => {
  it("are byte-identical to the control plane's (pinned in client-key-attach.postgres.test.ts)", () => {
    const message = clientKeyAttachMessage("4c18af2e-b04a-4b77-b83e-493c3695962e", Buffer.alloc(32, 0x0c), "2026-10-12T00:00:00.000Z", Buffer.alloc(32, 0x0d));
    expect(message.toString("hex")).toBe(
      Buffer.from("mdbase-next client noise key attach v1\0").toString("hex")
      + "00000010" + "4c18af2eb04a4b77b83e493c3695962e"
      + "00000020" + "0c".repeat(32)
      + "00000018" + Buffer.from("2026-10-12T00:00:00.000Z").toString("hex")
      + "00000020" + "0d".repeat(32)
    );
    expect(clientNoiseKeyMessage(grantId, Buffer.alloc(32, 1)).subarray(0, 32).toString()).toBe("mdbase-next client noise key v1\0");
  });
});
