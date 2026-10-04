import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApplicationAuthorizationProof } from "@mdbase-dev/connect-protocol";
import { MdbaseConnect } from "./index.js";
import { MemoryGrantKeyStore } from "./crypto.js";
import { MemoryApplicationIdentityStore } from "./application-identity.js";
import { MemoryStorage } from "./runtime-utils.js";
import type { MdbaseConnectOptions } from "./connect-options.js";
import { configureNextClientKey, nextAuthorizationFields, nextClientKeyMessage } from "./next-client-key.js";

const UUID = "0192f3a4-6000-7abc-8def-0123456789ab";
// RFC 7748 Alice public key: a test key, not a newly minted/public-only consent key.
const PUBLIC_KEY = new Uint8Array(Buffer.from("8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a", "hex"));

function oracleMessage(id: string, key: Uint8Array): Uint8Array {
  return new Uint8Array(Buffer.concat([
    Buffer.from("mdbase-next client noise key v1\0", "utf8"), Buffer.from("00000010", "hex"),
    Buffer.from(id.replaceAll("-", ""), "hex"), Buffer.from("00000020", "hex"), Buffer.from(key)
  ]));
}

function fixture(portable: boolean, nextClientKey?: MdbaseConnectOptions["nextClientKey"]) {
  const forms: Array<{ raw: string; form: URLSearchParams; proof: ApplicationAuthorizationProof }> = [];
  const keyStore = new MemoryGrantKeyStore();
  const storage = new MemoryStorage();
  const navigate = vi.fn();
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    if (String(url).endsWith("/v1/apps/register")) return Response.json({ application: {
      id: "00000000-0000-0000-0000-000000000001", family_identity: "bundle:dev.next.key.test", manifest_digest: "a".repeat(64),
      name: "Next key test", distribution: portable ? "portable" : "web", requirements: { contracts: [], access: "full_collection" }
    } });
    const raw = String(init?.body);
    const form = new URLSearchParams(raw);
    const proof = JSON.parse(form.get("application_authorization")!) as ApplicationAuthorizationProof;
    forms.push({ raw, form, proof });
    if (portable) return Response.json({ error: "access_denied" }, { status: 400 });
    return Response.json({ authorization_id: proof.binding.authorization_id,
      authorization_uri: "https://connect.example/oauth/authorize", expires_in: 600 });
  });
  const client = new MdbaseConnect({
    serverUrl: "https://connect.example", manifest: {
      manifest_version: 1, id: "dev.next.key.test", name: "Next key test", distribution: portable ? "portable" : "web",
      homepage: "https://app.example/", redirect_uris: ["https://app.example/callback"],
      requirements: { contracts: [], access: "full_collection" }
    }, redirectUri: "https://app.example/callback", storage, keyStore,
    identityStore: new MemoryApplicationIdentityStore(), navigate, nextClientKey
  });
  return { client, forms, fetch, keyStore, storage, navigate };
}

afterEach(() => { vi.restoreAllMocks(); });

describe("opt-in Next client key attestation", () => {
  it("validates only opt-in HTTPS control origins before accessing public keys", () => {
    const provider = vi.fn(() => PUBLIC_KEY);
    for (const origin of ["http://cp", "ws://cp", "/relative", "https://u:p@cp", "https://cp/path", "https://cp?q=1", "https://cp?", "https://cp#f", "https://cp#", "https://CP", "https://cp/%2e"]) {
      expect(() => configureNextClientKey(provider, origin)).toThrow();
      expect(configureNextClientKey(undefined, origin)).toBeUndefined(); // unchanged legacy constructor behavior
    }
    expect(configureNextClientKey(provider, "https://cp/")).toBe(provider);
    expect(provider).not.toHaveBeenCalled();
  });

  it("matches the control message domain, UUID bytes and big-endian lengths", () => {
    expect(nextClientKeyMessage(UUID, PUBLIC_KEY)).toEqual(oracleMessage(UUID, PUBLIC_KEY));
    expect(() => nextClientKeyMessage("not-a-uuid", PUBLIC_KEY)).toThrow();
    expect(() => nextClientKeyMessage(UUID, new Uint8Array(31))).toThrow();
  });

  it("leaves old fields byte-identical and never accesses the private signer when absent", async () => {
    const proof = { binding: { protocol_version: 4, authorization_id: UUID }, signature: "old-proof" } as unknown as ApplicationAuthorizationProof;
    const grant = Object.defineProperty({}, "signingPrivateKey", { get: () => { throw new Error("must not sign"); } }) as { signingPrivateKey: CryptoKey };
    const fields = await nextAuthorizationFields(proof, grant, undefined);
    expect(fields).toEqual({ application_authorization: JSON.stringify(proof) });
    expect(new URLSearchParams(fields).toString()).toBe(new URLSearchParams({ application_authorization: JSON.stringify(proof) }).toString());
  });

  it.each([false, true])("keeps the complete old OAuth form and signing count unchanged (portable=%s)", async (portable) => {
    const sign = vi.spyOn(crypto.subtle, "sign");
    const test = fixture(portable);
    await test.client.authorize();
    const { raw, form, proof } = test.forms[0];
    expect(proof.binding.requested_operations).toEqual(["describe", "changes", "read", "query"]);
    expect(Object.keys(proof.binding)).toEqual([
      "protocol_version", "authorization_id", "application_id", "application_declaration_id", "application_manifest_digest",
      "application_installation_id", "installation_signing_public_key", "grant_agreement_public_key", "grant_signing_public_key",
      "flow", "authorization_nonce", "issued_at", "expires_at",
      ...(portable ? ["code_challenge"] : ["redirect_uri", "state", "code_challenge"]), "contracts", "requested_operations"
    ]);
    const expected = portable ? {
      client_id: form.get("client_id")!, operations: form.get("operations")!,
      code_challenge: form.get("code_challenge")!, code_challenge_method: "S256", application_authorization: JSON.stringify(proof)
    } : {
      client_id: form.get("client_id")!, redirect_uri: "https://app.example/callback",
      code_challenge: form.get("code_challenge")!, code_challenge_method: "S256", state: form.get("state")!,
      operations: form.get("operations")!, application_authorization: JSON.stringify(proof)
    };
    expect(raw).toBe(new URLSearchParams(expected).toString());
    expect(form.has("client_noise_key")).toBe(false);
    expect(sign).toHaveBeenCalledTimes(1); // only the existing installation/binding signature
  });

  it.each([false, true])("attests with the per-grant signer, not installation signer (portable=%s)", async (portable) => {
    const supplied = PUBLIC_KEY.slice();
    const provider = vi.fn(() => supplied);
    const test = fixture(portable, provider);
    await test.client.authorize();
    const { form, proof } = test.forms[0];
    expect(provider).toHaveBeenCalledWith(); // never receives the private signer
    expect(supplied).toEqual(PUBLIC_KEY);
    expect(proof.binding.protocol_version).toBe(5);
    const attestation = JSON.parse(form.get("client_noise_key")!) as { public_key: string; signature: string };
    expect(Object.keys(attestation)).toEqual(["public_key", "signature"]);
    expect(attestation.public_key).toBe(Buffer.from(PUBLIC_KEY).toString("base64url"));
    expect(attestation.signature).not.toContain("=");
    const signature = new Uint8Array(Buffer.from(attestation.signature, "base64url"));
    expect(signature.length).toBe(64);
    const importKey = (point: string) => crypto.subtle.importKey("raw", Buffer.from(point, "base64url"), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    const message = oracleMessage(proof.binding.authorization_id, PUBLIC_KEY);
    expect(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, await importKey(proof.binding.grant_signing_public_key), signature, message as BufferSource)).toBe(true);
    expect(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, await importKey(proof.binding.installation_signing_public_key), signature, message as BufferSource)).toBe(false);
    expect(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, await importKey(proof.binding.grant_signing_public_key), signature, oracleMessage(UUID, PUBLIC_KEY) as BufferSource)).toBe(false);
  });

  it("snapshots public bytes before asynchronous signing", async () => {
    const supplied = PUBLIC_KEY.slice();
    const store = new MemoryGrantKeyStore();
    const grant = await store.create("test-grant");
    const original = crypto.subtle.sign.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, "sign").mockImplementation((algorithm, key, data) => {
      supplied.fill(0);
      return original(algorithm, key, data);
    });
    const proof = { binding: { protocol_version: 5, authorization_id: UUID }, signature: "proof" } as unknown as ApplicationAuthorizationProof;
    const fields = await nextAuthorizationFields(proof, grant, () => supplied);
    expect(JSON.parse(fields.client_noise_key!).public_key).toBe(Buffer.from(PUBLIC_KEY).toString("base64url"));
  });

  it.each([new Uint8Array(31), new Uint8Array(33), new Uint8Array(32)])("refuses malformed/zero keys without an OAuth request", async (key) => {
    const test = fixture(false, () => key);
    const create = vi.spyOn(test.keyStore, "create");
    const outcome = await test.client.authorize();
    expect(outcome).toMatchObject({ ok: false, problem: { code: "invalid_application_authorization" } });
    expect(test.forms).toEqual([]);
    expect(test.navigate).not.toHaveBeenCalled();
    expect(test.fetch.mock.calls.some(([url]) => String(url).includes("/oauth/"))).toBe(false);
    const grant = await create.mock.results[0].value;
    expect(await test.keyStore.get(grant.handle)).toBeNull();
  });

  it("refuses an unexpected signature format rather than guessing a conversion", async () => {
    const grant = await new MemoryGrantKeyStore().create("format-test");
    vi.spyOn(crypto.subtle, "sign").mockResolvedValue(new ArrayBuffer(63));
    const proof = { binding: { protocol_version: 5, authorization_id: UUID }, signature: "proof" } as unknown as ApplicationAuthorizationProof;
    await expect(nextAuthorizationFields(proof, grant, () => PUBLIC_KEY)).rejects.toMatchObject({ code: "invalid_application_authorization" });
  });

  it("refuses future binding versions before calling the public-key provider", async () => {
    const provider = vi.fn(() => PUBLIC_KEY);
    const proof = { binding: { protocol_version: 6, authorization_id: UUID }, signature: "proof" } as unknown as ApplicationAuthorizationProof;
    await expect(nextAuthorizationFields(proof, {} as { signingPrivateKey: CryptoKey }, provider)).rejects.toMatchObject({ code: "invalid_application_authorization" });
    expect(provider).not.toHaveBeenCalled();
  });
});
