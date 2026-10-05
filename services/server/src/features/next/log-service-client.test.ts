import { createHash, createPrivateKey, generateKeyPairSync, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { LogServiceClient, LogServiceError } from "./log-service-client.js";
import { ed25519PublicKeyObject, ed25519RawPublicKey } from "./policy-keys.js";
import { decodeCbor, encodeCbor } from "./policy-wire.js";

// Independent reference to3809 Rust auth::http_digest + actual Worker call site:
// method is the LS method, not HTTP POST; raw token/body/collection/nonce bound.
const sha = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest();
function transcript(method: string, path: string, collection: Uint8Array, token: string, body: Uint8Array, nonce: Uint8Array) {
  const tag = Buffer.from("mdbase/v1/ls-http");
  return sha(Buffer.concat([Buffer.of(tag.length), tag, Buffer.from(method), Buffer.of(0), Buffer.from(path), Buffer.of(0),
    collection, sha(token), sha(body), nonce]));
}
const response = (code: string, reason?: string) => new Response(encodeCbor({ struct: [[0, 1], [1, 0], [3, { struct: [[0, code], [1, reason]] }]] }),
  { headers: { "content-type": "application/vnd.mdbase.v1+cbor" } });

function fixture() {
  const issuer = generateKeyPairSync("ed25519").privateKey;
  const transport = generateKeyPairSync("ed25519").privateKey;
  const nonce = Buffer.alloc(32, 7);
  let request: { method: string; path: string; collection: Uint8Array; token: string; body: Buffer; signature: Buffer };
  const fetcher: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path === "/v1/nonce") return new Response(nonce.toString("hex"));
    expect(init?.method).toBe("POST");
    const headers = new Headers(init!.headers);
    const body = Buffer.from(init!.body as Buffer);
    const frame = decodeCbor(body) as Map<number, unknown>;
    const collection = (frame.get(3) as Map<number, Uint8Array>).get(0)!;
    const token = headers.get("authorization")!.slice("Bearer ".length);
    const signature = Buffer.from(headers.get("x-mdbase-sig")!, "hex");
    const method = frame.get(2) as string;
    request = { method, path, collection, token, body, signature };
    return verify(null, transcript(method, path, collection, token, body, nonce), transport, signature)
      ? response("not_found") : response("unauthenticated", "possession");
  };
  const client = new LogServiceClient({ url: "https://log.example.test", tokenIssuerKeyPem: issuer.export({ format: "pem", type: "pkcs8" }).toString(),
    transportKeyPem: transport.export({ format: "pem", type: "pkcs8" }).toString() }, fetcher, () => 1_000_000);
  return { client, issuer, transport, nonce, request: () => request };
}

describe("log HTTP PoP client interoperability", () => {
  it("matches the independently generated public3809 Rust/Python conformance vector byte-for-byte", async () => {
    const vector = JSON.parse(readFileSync(new URL("./fixtures/log-http-public-vector.json", import.meta.url), "utf8"));
    const transport = createPrivateKey({ format: "der", type: "pkcs8", key: Buffer.concat([
      Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(vector.PUBLIC_fixture_seed_hex, "hex")
    ]) }); // explicitly public, nonoperational test seed; never LAB material
    const publicKey = ed25519PublicKeyObject(Buffer.from(vector.sign_pk_hex, "hex"));
    const nonce = Buffer.from(vector.nonce_hex, "hex");
    const collection = Buffer.from(vector.request_params_key_0_hex, "hex");
    const body = Buffer.from(vector.body_cbor_hex, "hex");
    expect(transcript(vector.method, vector.path, collection, vector.token_utf8, body, nonce).toString("hex")).toBe(vector.digest_hex);
    expect(verify(null, Buffer.from(vector.digest_hex, "hex"), publicKey, Buffer.from(vector.signature_hex, "hex"))).toBe(true);
    let matched = false;
    const fetcher: typeof fetch = async (_input, init) => {
      if (init?.method === "GET") return new Response(vector.nonce_hex);
      const headers = new Headers(init.headers);
      expect(Buffer.from(init.body as Buffer).toString("hex")).toBe(vector.body_cbor_hex);
      expect(headers.get("authorization")).toBe(`Bearer ${vector.token_utf8}`);
      expect(headers.get("x-mdbase-nonce")).toBe(vector.nonce_hex);
      expect(headers.get("x-mdbase-sig")).toBe(vector.signature_hex);
      matched = true;
      return response("not_found");
    };
    const pem = transport.export({ format: "pem", type: "pkcs8" }).toString();
    const client = new LogServiceClient({ url: "https://log.example.test", tokenIssuerKeyPem: pem, transportKeyPem: pem }, fetcher);
    const token = vi.spyOn(client as any, "controlPlaneToken").mockReturnValue(vector.token_utf8);
    try { await expect(client.head("22222222-2222-2222-2222-222222222222")).rejects.toMatchObject({ code: "not_found" }); }
    finally { token.mockRestore(); }
    expect(matched).toBe(true);
  });
  it("authenticates the actual head request using the Worker transcript, keeping token claims/signature unchanged", async () => {
    const f = fixture();
    await expect(f.client.head("11111111-1111-4111-8111-111111111111")).rejects.toMatchObject({ code: "not_found" });
    const request = f.request();
    const [claimsHex, signatureHex] = request.token.split(".");
    const claims = Buffer.from(claimsHex!, "hex");
    const tag = Buffer.from("mdbase/v1/ls-token");
    expect(verify(null, sha(Buffer.concat([Buffer.of(tag.length), tag, claims])), f.issuer, Buffer.from(signatureHex!, "hex"))).toBe(true);
    const decoded = decodeCbor(claims) as Map<number, unknown>;
    expect(decoded.get(0)).toBe(1);
    expect(decoded.get(4)).toBe("mdbase-log");
    expect(Buffer.from(decoded.get(2) as Uint8Array)).toEqual(Buffer.from(ed25519RawPublicKey(f.transport)));
  });
  it("binds LS method, path, collection, exact token/body and raw nonce independently", async () => {
    const f = fixture();
    await expect(f.client.head("11111111-1111-4111-8111-111111111111")).rejects.toBeInstanceOf(LogServiceError);
    const r = f.request();
    const check = (method = r.method, path = r.path, collection = r.collection, token = r.token, body = r.body, nonce: Uint8Array = f.nonce) =>
      verify(null, transcript(method, path, collection, token, body, nonce), f.transport, r.signature);
    expect(check()).toBe(true);
    expect(check("POST")).toBe(false);
    expect(check("read")).toBe(false);
    expect(check(r.method, "/v1/other")).toBe(false);
    expect(check(r.method, r.path, Buffer.alloc(16))).toBe(false);
    expect(check(r.method, r.path, r.collection, r.token + "0")).toBe(false);
    expect(check(r.method, r.path, r.collection, r.token, Buffer.concat([r.body, Buffer.of(0)]))).toBe(false);
    expect(check(r.method, r.path, r.collection, r.token, r.body, Buffer.alloc(32))).toBe(false);
  });
  it.each(["create_log", "append", "read", "set_quota", "delete_log"])("uses the same transcript for %s", async (method) => {
    const f = fixture();
    const id = "22222222-2222-4222-8222-222222222222";
    const call = method === "create_log" ? () => f.client.createLog(id, Buffer.of(1))
      : method === "append" ? () => f.client.append(id, 0, Buffer.alloc(32), [Buffer.of(1)])
      : method === "read" ? () => f.client.controlItemAt(id, 1)
      : method === "set_quota" ? () => f.client.setQuota(id, { storageBytes: 1, itemsPerSecond: 1, bytesPerSecond: 1, burstItems: 1 })
      : () => f.client.deleteLog(id);
    await expect(call()).rejects.toMatchObject({ code: "not_found" });
    expect(f.request().method).toBe(method);
  });
});
