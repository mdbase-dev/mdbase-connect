import { afterEach, describe, expect, it, vi } from "vitest";
import { MdbaseConnect, MdbaseConnectError } from "./index.js";
import { accountBackend } from "./control.js";
import { MemoryGrantKeyStore } from "./crypto.js";
import { MemoryStorage } from "./runtime-utils.js";
import { verifyAuthorityRequestProof } from "../../../services/server/src/authority-proof.js";

const COLLECTION = "0192f3a4-6000-7abc-8def-0123456789ab";
const GRANT = "0192f3a4-6000-7abc-8def-0123456789ad";
const ACCOUNT = "0192f3a4-6000-7abc-8def-0123456789af";
const SERVER = "https://cp.example.test";
const MANIFEST = "https://app.example.test/.well-known/mdbase-app.json";
const HANDLE = "synthetic-grant-key";
const CREDENTIAL = "public-synthetic-token";
const PATH = "/v1/account/backend";
const response = (backend = "next") => Response.json({ account_id: ACCOUNT, backend });
async function fixture(server = SERVER) {
  const storage = new MemoryStorage();
  const keyStore = new MemoryGrantKeyStore();
  const key = await keyStore.create(HANDLE);
  const token = {
    version: 1, accessToken: CREDENTIAL, clientId: "0192f3a4-6000-7abc-8def-0123456789a1",
    collectionId: COLLECTION, collectionName: "test", operations: ["query"],
    scope: { contracts: [], access: "full_collection" }, expiresAt: Date.now() + 3_600_000,
    grantId: GRANT, keyHandle: HANDLE, applicationOrigin: "https://app.example.test", savedAt: 1
  };
  const storageKey = `mdbase-connect:${server}:${MANIFEST}:token:${COLLECTION}`;
  storage.setItem(storageKey, JSON.stringify(token));
  const client = new MdbaseConnect({ serverUrl: server, manifest: MANIFEST, redirectUri: "https://app.example.test/",
    storage, keyStore, directAccess: "disabled", relayEncryption: "disabled" });
  const connection = client.connection(COLLECTION)!;
  expect(connection).toBeTruthy();
  const release = vi.fn();
  const internals = client["internals"];
  const original = internals.acquireGrantKeyLease.bind(internals);
  vi.spyOn(internals, "acquireGrantKeyLease").mockImplementation(async (...args) => {
    const action = await original(...args);
    return () => { release(); action(); };
  });
  return { client, connection, storage, storageKey, token, keyStore, key, release };
}
afterEach(() => vi.restoreAllMocks());

describe("bare retained accountBackend", () => {
  it.each(["legacy", "next"])("signs the fixed empty GET even without token.authority (%s)", async backend => {
    const f = await fixture();
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      expect(String(url)).toBe(SERVER + PATH);
      expect(init?.method).toBe("GET");
      expect(init?.body).toBeUndefined();
      expect(init?.redirect).toBe("error");
      expect(init?.credentials).toBe("omit");
      expect(init?.cache).toBe("no-store");
      const headers = init!.headers as Record<string, string>;
      expect(headers.authorization).toBe(`Bearer ${CREDENTIAL}`);
      // Actual receiver verifier, not a mock signer or mirror signature check.
      const input = { method: "GET", target: PATH, credential: CREDENTIAL };
      expect(() => verifyAuthorityRequestProof(headers, f.key.signingPublicKey, input)).not.toThrow();
      for (const delta of [{ target: PATH + "?x=1" }, { body: "x" }, { credential: "different" }, { method: "POST" }]) {
        expect(() => verifyAuthorityRequestProof(headers, f.key.signingPublicKey, { ...input, ...delta })).toThrow();
      }
      return response(backend);
    });
    const result = await accountBackend(f.connection);
    expect(result).toEqual({ accountId: ACCOUNT, backend });
    expect(Object.isFrozen(result)).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1); // No describe, setup, refresh or fallback.
    expect(f.release).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain(CREDENTIAL);
  });
  it("rejects unsafe CP before credentials or key access", async () => {
    const f = await fixture("http://localhost");
    const current = vi.spyOn(f.connection["transport"], "currentToken");
    const key = vi.spyOn(f.keyStore, "get");
    const fetch = vi.spyOn(globalThis, "fetch");
    await expect(accountBackend(f.connection)).rejects.toBeInstanceOf(MdbaseConnectError);
    expect(current).not.toHaveBeenCalled(); expect(key).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });
  it("never falls back when the proof key is missing", async () => {
    const f = await fixture();
    await f.keyStore.delete(HANDLE);
    const fetch = vi.spyOn(globalThis, "fetch");
    await expect(accountBackend(f.connection)).rejects.toMatchObject({ code: "missing_grant_key" });
    expect(fetch).not.toHaveBeenCalled(); expect(f.release).toHaveBeenCalledTimes(1);
  });
  it.each([401, 403, 404, 503])("status %i is an opening failure, not legacy selection", async status => {
    const f = await fixture();
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("private error ignored", { status }));
    await expect(accountBackend(f.connection)).rejects.toMatchObject({ status });
    expect(fetch).toHaveBeenCalledTimes(1); expect(f.release).toHaveBeenCalledTimes(1);
  });
  it.each([
    { account_id: ACCOUNT, backend: "unknown" },
    { account_id: ACCOUNT.toUpperCase(), backend: "next" },
    { account_id: "00000000-0000-0000-0000-000000000000", backend: "next" },
    { account_id: ACCOUNT, backend: "next", token: CREDENTIAL },
    { backend: "legacy" }, [], null
  ])("strictly refuses malformed or uncorrelated metadata %#", async value => {
    const f = await fixture();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(value));
    await expect(accountBackend(f.connection)).rejects.toMatchObject({ code: "invalid_operation_response" });
    expect(f.release).toHaveBeenCalledTimes(1);
  });
  it("rejects an oversized response and cancels its reader", async () => {
    const f = await fixture(); const cancelled = vi.fn();
    const body = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(4097)); }, cancel: cancelled });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(body, { headers: { "content-type": "application/json" } }));
    await expect(accountBackend(f.connection)).rejects.toMatchObject({ code: "invalid_operation_response" });
    expect(cancelled).toHaveBeenCalledTimes(1); expect(f.release).toHaveBeenCalledTimes(1);
  });
  it("fails closed on a grant/account-context switch while fetch awaits", async () => {
    const f = await fixture();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      f.storage.setItem(f.storageKey, JSON.stringify({ ...f.token, grantId: ACCOUNT }));
      return response();
    });
    await expect(accountBackend(f.connection)).rejects.toMatchObject({ code: "authority_authorization_changed" });
    expect(f.release).toHaveBeenCalledTimes(1);
  });
  it("pins before lease acquisition and does not adopt a replacement grant", async () => {
    const f = await fixture();
    vi.spyOn(f.client["internals"], "acquireGrantKeyLease").mockImplementation(async () => {
      f.storage.setItem(f.storageKey, JSON.stringify({ ...f.token, accessToken: "replacement" }));
      return f.release;
    });
    const fetch = vi.spyOn(globalThis, "fetch");
    await expect(accountBackend(f.connection)).rejects.toMatchObject({ code: "authority_authorization_changed" });
    expect(fetch).not.toHaveBeenCalled(); expect(f.release).toHaveBeenCalledTimes(1);
  });
  it.each([undefined, null, 30_000])("caps metadata timeoutMs=%s at 10s with reader/lease cleanup", async timeoutMs => {
    const f = await fixture(); let enter!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const cancelled = vi.fn();
    vi.useFakeTimers();
    try {
      vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
        enter(); return new Response(new ReadableStream({ cancel: cancelled }));
      });
      const pending = accountBackend(f.connection, { timeoutMs });
      const rejected = expect(pending).rejects.toMatchObject({ code: "timeout" });
      await entered;
      await vi.advanceTimersByTimeAsync(9_999); expect(cancelled).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1); await rejected;
      expect(cancelled).toHaveBeenCalledTimes(1); expect(f.release).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });
  it("pre-abort prevents signing, leases and requests", async () => {
    const f = await fixture(); const controller = new AbortController(); controller.abort();
    const get = vi.spyOn(f.keyStore, "get"); const fetch = vi.spyOn(globalThis, "fetch");
    await expect(accountBackend(f.connection, { signal: controller.signal })).rejects.toMatchObject({ code: "operation_cancelled" });
    expect(get).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled(); expect(f.release).not.toHaveBeenCalled();
  });
  it("abort during response body cancels and joins cleanup before rejecting", async () => {
    const f = await fixture(); const controller = new AbortController(); const cancelled = vi.fn();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      const stream = new ReadableStream({ start(c) {
        c.enqueue(new TextEncoder().encode('{"account_id":'));
        queueMicrotask(() => controller.abort());
      }, cancel: cancelled });
      return new Response(stream, { headers: { "content-type": "application/json" } });
    });
    await expect(accountBackend(f.connection, { signal: controller.signal })).rejects.toMatchObject({ code: "operation_cancelled" });
    expect(cancelled).toHaveBeenCalledTimes(1); expect(f.release).toHaveBeenCalledTimes(1);
  });
  it("late key work after caller abort cannot dispatch or resurrect a result", async () => {
    const f = await fixture(); const controller = new AbortController();
    let resume!: () => void; let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const blocked = new Promise<void>(resolve => { resume = resolve; });
    const original = f.keyStore.get.bind(f.keyStore);
    vi.spyOn(f.keyStore, "get").mockImplementation(async handle => {
      entered(); await blocked; return original(handle);
    });
    const fetch = vi.spyOn(globalThis, "fetch");
    const pending = accountBackend(f.connection, { signal: controller.signal });
    await started; controller.abort(); resume();
    await expect(pending).rejects.toMatchObject({ code: "operation_cancelled" });
    expect(fetch).not.toHaveBeenCalled(); expect(f.release).toHaveBeenCalledTimes(1);
  });
  it("does not return a late body from a removed grant", async () => {
    const f = await fixture();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(new ReadableStream({
      pull(c) {
        f.storage.removeItem(f.storageKey);
        c.enqueue(new TextEncoder().encode(JSON.stringify({ account_id: ACCOUNT, backend: "next" })));
        c.close();
      }
    }), { headers: { "content-type": "application/json" } }));
    await expect(accountBackend(f.connection)).rejects.toMatchObject({ code: "authority_authorization_changed" });
    expect(f.release).toHaveBeenCalledTimes(1);
  });
  it("rejects noncanonical signing points before any request", async () => {
    const f = await fixture();
    vi.spyOn(f.keyStore, "get").mockResolvedValue({ ...f.key, signingPublicKey: f.key.signingPublicKey + "=" });
    const fetch = vi.spyOn(globalThis, "fetch");
    await expect(accountBackend(f.connection)).rejects.toMatchObject({ code: "invalid_operation_response" });
    expect(fetch).not.toHaveBeenCalled(); expect(f.release).toHaveBeenCalledTimes(1);
  });
  it("sanitizes unexpected transport errors to a strict Connect error", async () => {
    const f = await fixture();
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error(CREDENTIAL));
    await expect(accountBackend(f.connection)).rejects.toMatchObject({ code: "operation_failed", message: "Account backend metadata could not be read." });
    expect(f.release).toHaveBeenCalledTimes(1);
  });
});
