import { afterEach, describe, expect, it, vi } from "vitest";
import { MdbaseConnect } from "./index.js";
import { MemoryStorage } from "./runtime-utils.js";
import { appTimers } from "./control-timers.js";
import type { Application } from "./internal-types.js";
const SERVER = "https://cp.example.test", MANIFEST = "https://app.example.test/app.json";
const COLLECTION = "0192f3a4-6000-7abc-8def-0123456789ab", GRANT = "0192f3a4-6000-7abc-8def-0123456789ad";
const CHANNEL = "0192f3a4-6000-7abc-8def-0123456789af";
function fixture() {
  const storage = new MemoryStorage();
  const key = `mdbase-connect:${SERVER}:${MANIFEST}:token:${COLLECTION}`;
  const token = { version: 1, accessToken: "public-synthetic-token", clientId: GRANT, collectionId: COLLECTION,
    collectionName: "test", operations: ["query"], scope: { contracts: [], access: "full_collection" },
    expiresAt: Date.now() + 3_600_000, grantId: GRANT, keyHandle: "synthetic-key", applicationOrigin: "https://app.example.test", savedAt: 1 };
  storage.setItem(key, JSON.stringify(token));
  const client = new MdbaseConnect({ serverUrl: SERVER, manifest: MANIFEST, redirectUri: "https://app.example.test/",
    storage, directAccess: "disabled", relayEncryption: "disabled" });
  const connection = client.connection(COLLECTION)!;
  const port = appTimers(connection), release = vi.fn();
  vi.spyOn(client["internals"], "acquireGrantKeyLease").mockResolvedValue(release);
  return { client, connection, port, storage, key, token, release };
}
afterEach(() => vi.restoreAllMocks());
describe("fixed retained app timer HTTP port", () => {
  it("uses the real timer namespace routes, not Frames or old rawOperation", async () => {
    const f = fixture(), prefix = `${SERVER}/v1/next/collections/${COLLECTION}/timers/ns`;
    const calls: [string, string, unknown][] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      calls.push([String(url), init?.method ?? "GET", init?.body ? JSON.parse(String(init.body)) : undefined]);
      expect(init?.redirect).toBe("error"); expect(init?.credentials).toBe("omit");
      return Response.json({});
    });
    await f.port.list("ns", {});
    await f.port.put("ns", "a:b", { criterion_id: "test.fire", fire_at: "2026-10-06T10:00:00Z" }, {});
    await f.port.cancel("ns", "a:b", 3, {});
    await f.port.reconcile("ns", { criterion_id: "test.fire", timers: [] }, {});
    expect(calls).toEqual([[prefix, "GET", undefined], [prefix + "/a%3Ab", "PUT", { criterion_id: "test.fire", fire_at: "2026-10-06T10:00:00Z" }],
      [prefix + "/a%3Ab?generation=3", "DELETE", undefined], [prefix + "/reconcile", "POST", { criterion_id: "test.fire", timers: [] }]]);
    expect(f.release).toHaveBeenCalledTimes(4);
  });
  it("snapshots content-free desired timer bodies before an async lease", async () => {
    const f = fixture(); let resume!: () => void;
    const gate = new Promise<void>(resolve => { resume = resolve; });
    vi.spyOn(f.client["internals"], "acquireGrantKeyLease").mockImplementation(async () => { await gate; return f.release; });
    const body = { criterion_id: "test.fire", timers: [{ id: "a", fire_at: "2026-10-06T10:00:00Z" }] };
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_, init) => {
      expect(JSON.parse(String(init?.body))).toEqual({ criterion_id: "test.fire", timers: [{ id: "a", fire_at: "2026-10-06T10:00:00Z" }] });
      return Response.json({});
    });
    const pending = f.port.reconcile("ns", body, {});
    body.timers[0]!.id = "replacement"; resume(); await pending;
  });
  it("refuses a different grant between calls without adopting authority", async () => {
    const f = fixture(); f.storage.setItem(f.key, JSON.stringify({ ...f.token, grantId: CHANNEL }));
    const fetch = vi.spyOn(globalThis, "fetch");
    await expect(f.port.list("ns", {})).rejects.toMatchObject({ code: "not_authorized" }); expect(fetch).not.toHaveBeenCalled();
  });
  it("read currentness failures suppress old data; write currentness failures are unknown", async () => {
    for (const write of [false, true]) {
      const f = fixture();
      vi.spyOn(globalThis, "fetch").mockImplementation(async () => { f.storage.removeItem(f.key); return Response.json({}); });
      const operation = write ? f.port.cancel("ns", "a", undefined, {}) : f.port.list("ns", {});
      await expect(operation).rejects.toMatchObject(write ? { problem: { operation_outcome: "unknown" } } : { code: "authority_authorization_changed" });
      expect(f.release).toHaveBeenCalledTimes(1); vi.restoreAllMocks();
    }
  });
  it.each([500, 503])("uncertain status %i never reports a write rejected or replays it", async status => {
    const f = fixture(), fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ignored", { status }));
    await expect(f.port.cancel("ns", "a", undefined, {})).rejects.toMatchObject({ problem: { operation_outcome: "unknown" } });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("401 is explicit rejection, not a backend/auth fallback", async () => {
    const f = fixture(), fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ignored", { status: 401 }));
    await expect(f.port.cancel("ns", "a", undefined, {})).rejects.toMatchObject({ problem: { operation_outcome: "rejected" }, code: "not_authorized" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("network loss after PUT dispatch is unknown", async () => {
    const f = fixture(), fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("network"));
    await expect(f.port.put("ns", "a", { criterion_id: "fire", fire_at: "2026-10-06T10:00:00Z" }, {})).rejects.toMatchObject({ problem: { operation_outcome: "unknown" } });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("port close cancels a pending reader, releases once and prevents future requests", async () => {
    const f = fixture(), cancel = vi.fn();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      const stream = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("{")); queueMicrotask(() => f.port.close()); }, cancel });
      return new Response(stream, { headers: { "content-type": "application/json" } });
    });
    await expect(f.port.list("ns", {})).rejects.toMatchObject({ code: "operation_cancelled" });
    expect(cancel).toHaveBeenCalledTimes(1); expect(f.release).toHaveBeenCalledTimes(1);
    await expect(f.port.list("ns", {})).rejects.toMatchObject({ code: "operation_cancelled" });
  });
  it("a late browser subscription after close is unsubscribed and cannot register a channel", async () => {
    const f = fixture(); const unsubscribe = vi.fn(async () => true);
    vi.spyOn(f.client["internals"], "register").mockResolvedValue({ notifications: { criteria: [{ id: "test.fire" }] } } as unknown as Application);
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ public_key: Buffer.from([4, ...new Uint8Array(64)]).toString("base64url") }));
    const worker = { pushManager: {
      getSubscription: async () => null,
      subscribe: async () => { f.port.close(); return { unsubscribe, toJSON: () => ({ endpoint: "https://push.example.test", keys: { auth: "synthetic", p256dh: "synthetic" } }) }; }
    } } as unknown as ServiceWorkerRegistration;
    await expect(f.port.registerWebPush({ serviceWorker: worker })).rejects.toMatchObject({ code: "operation_cancelled" });
    expect(unsubscribe).toHaveBeenCalledTimes(1); expect(fetch).toHaveBeenCalledTimes(1);
    expect(f.release).toHaveBeenCalledTimes(1);
  });
  it("FCM registration keeps the opaque installation for uncertain outcome recovery, not the token", async () => {
    const f = fixture();
    vi.spyOn(f.client["internals"], "register").mockResolvedValue({ notifications: {
      criteria: [{ id: "test.fire" }], native_delivery: { mode: "managed_fcm" }
    } } as unknown as Application);
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("network"));
    await expect(f.port.registerFcm({ token: "synthetic-fcm", installationId: "stable-install" })).rejects.toMatchObject({ problem: { operation_outcome: "unknown" } });
    const stored = Array.from({ length: f.storage.length }, (_, i) => f.storage.getItem(f.storage.key(i)!)).join(" ");
    expect(stored).toContain("stable-install"); expect(stored).not.toContain("synthetic-fcm");
    await expect(f.port.unregisterFcm({})).rejects.toMatchObject({ problem: { operation_outcome: "unknown" } });
    expect(fetch).toHaveBeenCalledTimes(1); // No fake remote-delete success.
  });
  it("registers FCM on the existing fixed channel route with declared metadata", async () => {
    const f = fixture();
    vi.spyOn(f.client["internals"], "register").mockResolvedValue({ notifications: {
      criteria: [{ id: "test.fire" }], native_delivery: { mode: "managed_fcm" }
    } } as unknown as Application);
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      expect(String(url)).toBe(SERVER + "/v1/notifications/channels");
      expect(JSON.parse(String(init?.body))).toEqual({ installation_id: "installation", criteria: ["test.fire"], transport: "fcm", token: "synthetic-fcm" });
      return Response.json({ channel_id: CHANNEL });
    });
    expect(await f.port.registerFcm({ token: "synthetic-fcm", installationId: "installation" })).toEqual({ channelId: CHANNEL, installationId: "installation", criteria: ["test.fire"], transport: "fcm" });
    expect(JSON.stringify([...Array(f.storage.length)].map((_, i) => f.storage.getItem(f.storage.key(i)!)))).not.toContain("synthetic-fcm");
  });
});
