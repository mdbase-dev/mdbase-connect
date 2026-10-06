import { afterEach, describe, expect, it, vi } from "vitest";
import { MdbaseConnect } from "./index.js";
import { MemoryGrantKeyStore } from "./crypto.js";
import { MemoryStorage } from "./runtime-utils.js";
import { appTimers } from "./control-timers.js";
import { verifyAuthorityRequestProof } from "../../../services/server/src/authority-proof.js";
const SERVER = "https://cp.example.test", MANIFEST = "https://app.example.test/app.json";
const COLLECTION = "0192f3a4-6000-7abc-8def-0123456789ab", GRANT = "0192f3a4-6000-7abc-8def-0123456789ad";
const OP = "0192f3a4-6000-7abc-8def-0123456789af", CREDENTIAL = "public-synthetic-token";
const PATH = `/v1/next/collections/${COLLECTION}/timers/tasks`;
const body = () => ({ criterion_id: "task.fire", timers: [{ id: "task:one", fire_at: "2026-10-06T00:00:00.000Z" }],
  recovery: { protocol_version: 1 as const, operation_id: OP, expected_revision: 4 } });
async function fixture() {
  const storage = new MemoryStorage(), keyStore = new MemoryGrantKeyStore(), key = await keyStore.create("synthetic-proof-key");
  const token = { version: 1, accessToken: CREDENTIAL, clientId: GRANT, collectionId: COLLECTION, collectionName: "test", operations: ["query"],
    scope: { contracts: [], access: "full_collection" }, expiresAt: Date.now() + 3_600_000, grantId: GRANT, keyHandle: key.handle,
    applicationOrigin: "https://app.example.test", savedAt: 1 };
  const storageKey = `mdbase-connect:${SERVER}:${MANIFEST}:token:${COLLECTION}`; storage.setItem(storageKey, JSON.stringify(token));
  const client = new MdbaseConnect({ serverUrl: SERVER, manifest: MANIFEST, redirectUri: "https://app.example.test/", storage, keyStore, directAccess: "disabled", relayEncryption: "disabled" });
  const connection = client.connection(COLLECTION)!, port = appTimers(connection), release = vi.fn();
  const internals = client["internals"], original = internals.acquireGrantKeyLease.bind(internals);
  vi.spyOn(internals, "acquireGrantKeyLease").mockImplementation(async (...args) => { const done = await original(...args); return () => { release(); done(); }; });
  return { client, port, token, storage, storageKey, keyStore, key, release };
}
afterEach(() => vi.restoreAllMocks());
describe("fixed signed original timer operation routes", () => {
  it("signs exact POST original bytes and read-only GET with the actual receiver verifier", async () => {
    const f = await fixture(), methods: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const target = new URL(String(url)).pathname, method = init!.method!, rawBody = init!.body as string | undefined;
      expect(target).toBe(method === "POST" ? PATH + "/reconcile" : PATH + "/operations/" + OP);
      expect(init!.redirect).toBe("error"); expect(init!.credentials).toBe("omit"); expect(init!.cache).toBe("no-store");
      const binding = { method, target, body: rawBody, credential: CREDENTIAL };
      expect(() => verifyAuthorityRequestProof(init!.headers as Record<string, string>, f.key.signingPublicKey, binding)).not.toThrow();
      for (const delta of [{ target: target + "?x=1" }, { body: (rawBody ?? "") + "x" }, { credential: "other" }])
        expect(() => verifyAuthorityRequestProof(init!.headers as Record<string, string>, f.key.signingPublicKey, { ...binding, ...delta })).toThrow();
      if (method === "POST") expect(JSON.parse(rawBody!)).toEqual(body()); else expect(rawBody).toBeUndefined();
      methods.push(method); return Response.json({});
    });
    await f.port.reconcileWithReceipt("tasks", body(), {}); await f.port.lookupOperation("tasks", OP, {});
    expect(methods).toEqual(["POST", "GET"]); expect(f.release).toHaveBeenCalledTimes(2);
  });
  it("snapshots ID, revision and desired bytes before awaiting its lease", async () => {
    const f = await fixture(); let resume!: () => void;
    const gate = new Promise<void>(r => { resume = r; });
    vi.spyOn(f.client["internals"], "acquireGrantKeyLease").mockImplementation(async () => { await gate; return f.release; });
    const input = body(); const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => { expect(JSON.parse(String(init!.body))).toEqual(body()); return Response.json({}); });
    const pending = f.port.reconcileWithReceipt("tasks", input, {}); input.recovery.operation_id = GRANT; input.recovery.expected_revision = 8; input.timers[0]!.id = "other";
    resume(); await pending; expect(fetch).toHaveBeenCalledOnce();
  });
  it("missing/noncanonical private proof key cannot dispatch", async () => {
    for (const point of [undefined, "not-a-point"]) {
      const f = await fixture(); vi.spyOn(f.keyStore, "get").mockResolvedValue({ ...f.key, signingPublicKey: point } as never);
      const fetch = vi.spyOn(globalThis, "fetch"); await expect(f.port.lookupOperation("tasks", OP, {})).rejects.toBeDefined();
      expect(fetch).not.toHaveBeenCalled(); expect(f.release).toHaveBeenCalledOnce(); vi.restoreAllMocks();
    }
  });
  it("does not adopt changed credentials between original operation and lookup", async () => {
    const f = await fixture(), fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({}));
    await f.port.reconcileWithReceipt("tasks", body(), {});
    f.storage.setItem(f.storageKey, JSON.stringify({ ...f.token, accessToken: "different" }));
    await expect(f.port.lookupOperation("tasks", OP, {})).rejects.toMatchObject({ problem: { operation_outcome: "unknown" } }); expect(fetch).toHaveBeenCalledOnce();
  });
  it("expiry after proof-key await refuses before HTTP and releases once", async () => {
    const f = await fixture(), original = f.keyStore.get.bind(f.keyStore); let clock = Date.now(); vi.spyOn(Date, "now").mockImplementation(() => clock);
    vi.spyOn(f.keyStore, "get").mockImplementation(async handle => { const key = await original(handle); clock = f.token.expiresAt + 1; return key; });
    const fetch = vi.spyOn(globalThis, "fetch"); await expect(f.port.lookupOperation("tasks", OP, {})).rejects.toMatchObject({ problem: { operation_outcome: "unknown" } });
    expect(fetch).not.toHaveBeenCalled(); expect(f.release).toHaveBeenCalledOnce();
  });
  it.each([409, 500])("status %s keeps ORIGINAL outcome unknown and never replays", async status => {
    const f = await fixture(), fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ error: "operation_not_admitted" }, { status }));
    await expect(f.port.reconcileWithReceipt("tasks", body(), {})).rejects.toMatchObject({ problem: { operation_outcome: "unknown" } }); expect(fetch).toHaveBeenCalledOnce();
  });
  it("response loss is unknown; lookup performs no POST or implicit retry", async () => {
    const f = await fixture(), fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("synthetic socket loss"));
    await expect(f.port.reconcileWithReceipt("tasks", body(), {})).rejects.toMatchObject({ problem: { operation_outcome: "unknown" } });
    fetch.mockResolvedValue(Response.json({ outcome: "unknown", namespace: "tasks", operation_id: OP }));
    await f.port.lookupOperation("tasks", OP, {}); expect(fetch.mock.calls.map(([, init]) => init!.method)).toEqual(["POST", "GET"]);
  });
  it("close during proof signing cannot dispatch a late request", async () => {
    const f = await fixture(), original = crypto.subtle.sign.bind(crypto.subtle); let resume!: () => void;
    const gate = new Promise<void>(r => { resume = r; });
    vi.spyOn(crypto.subtle, "sign").mockImplementation(async (...args) => { await gate; return original(...args); });
    const fetch = vi.spyOn(globalThis, "fetch"), pending = f.port.lookupOperation("tasks", OP, {});
    await vi.waitFor(() => expect(crypto.subtle.sign).toHaveBeenCalled()); f.port.close(); resume();
    await expect(pending).rejects.toBeDefined(); expect(fetch).not.toHaveBeenCalled(); expect(f.release).toHaveBeenCalledOnce();
  });
  it("validates UUIDv7 and safe revision before acquiring keys or dispatching", async () => {
    const f = await fixture(), fetch = vi.spyOn(globalThis, "fetch");
    expect(() => f.port.lookupOperation("tasks", OP.replace("7abc", "4abc"), {})).toThrow();
    const input = body(); input.recovery.expected_revision = Number.MAX_SAFE_INTEGER;
    expect(() => f.port.reconcileWithReceipt("tasks", input, {})).toThrow(); expect(fetch).not.toHaveBeenCalled(); expect(f.release).not.toHaveBeenCalled();
  });
});
