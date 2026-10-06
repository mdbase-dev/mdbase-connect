import { afterEach, describe, expect, it, vi } from "vitest";
import { MdbaseConnect } from "./index.js";
import { MemoryStorage } from "./runtime-utils.js";
import { appTimers } from "./control-timers.js";
import type { Application } from "./internal-types.js";
const SERVER = "https://cp.example.test", MANIFEST = "https://app.example.test/app.json";
const COLLECTION = "0192f3a4-6000-7abc-8def-0123456789ab", GRANT = "0192f3a4-6000-7abc-8def-0123456789ad";
const CHANNEL = "0192f3a4-6000-7abc-8def-0123456789af";
function fixture(refreshable = false) {
  const storage = new MemoryStorage();
  const key = `mdbase-connect:${SERVER}:${MANIFEST}:token:${COLLECTION}`;
  const token = { version: 1, accessToken: "public-synthetic-token", clientId: GRANT, collectionId: COLLECTION,
    collectionName: "test", operations: ["query"], scope: { contracts: [], access: "full_collection" },
    expiresAt: Date.now() + 3_600_000, grantId: GRANT, keyHandle: "synthetic-key", applicationOrigin: "https://app.example.test", savedAt: 1,
    ...(refreshable ? { refreshToken: "public-synthetic-refresh", refreshExpiresAt: Date.now() + 7_200_000 } : {}) };
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
  it.each(["lease", "response", "body"])("refuses known access expiry after %s even with refreshable consent", async phase => {
    let clock = Date.now(); vi.spyOn(Date, "now").mockImplementation(() => clock);
    const f = fixture(true);
    vi.spyOn(f.client["internals"], "acquireGrantKeyLease").mockImplementation(async () => {
      await Promise.resolve(); if (phase === "lease") clock = f.token.expiresAt + 1; return f.release;
    });
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      if (phase === "response") clock = f.token.expiresAt + 1;
      if (phase !== "body") return Response.json({ namespace: "ns", timers: [] });
      return new Response(new ReadableStream({ pull(controller) {
        clock = f.token.expiresAt + 1;
        controller.enqueue(new TextEncoder().encode('{"namespace":"ns","timers":[]}')); controller.close();
      } }), { headers: { "content-type": "application/json" } });
    });
    await expect(f.port.list("ns", {})).rejects.toMatchObject({ code: "authority_authorization_changed" });
    expect(fetch).toHaveBeenCalledTimes(phase === "lease" ? 0 : 1);
    expect(f.release).toHaveBeenCalledTimes(1);
    expect(f.storage.getItem(f.key)).toContain("public-synthetic-refresh"); // No refresh/adoption.
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
  it.each([undefined, null, 30_000])("enforces the 10s CP metadata cap for timeoutMs=%s", async timeoutMs => {
    vi.useFakeTimers();
    try {
      const f = fixture(); let aborted = false;
      vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => new Promise((_resolve, reject) => {
        init!.signal!.addEventListener("abort", () => { aborted = true; reject(init!.signal!.reason); }, { once: true });
      }));
      const request = f.port.list("tasks", { timeoutMs });
      const rejected = expect(request).rejects.toMatchObject({ code: "timeout" });
      await vi.advanceTimersByTimeAsync(9_999); expect(aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1); await rejected;
      expect(aborted).toBe(true); expect(f.release).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
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
  it("requires acknowledged unregistration before another installation and fences uncertain replacements", async () => {
    const f = fixture();
    vi.spyOn(f.client["internals"], "register").mockResolvedValue({ notifications: {
      criteria: [{ id: "test.fire" }], native_delivery: { mode: "managed_fcm" }
    } } as unknown as Application);
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(Response.json({ channel_id: CHANNEL }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockRejectedValueOnce(new TypeError("response lost after new channel admitted"));
    await f.port.registerFcm({ token: "old-synthetic", installationId: "old-install" });
    for (const installationId of ["new-install", "third-install"]) {
      await expect(f.port.registerFcm({ token: "replacement-synthetic", installationId })).rejects.toMatchObject({ problem: { operation_outcome: "not_sent" } });
    }
    expect(fetch).toHaveBeenCalledTimes(1); // OLD acknowledgement cannot be overwritten.
    await f.port.unregisterFcm({});
    expect(fetch.mock.calls[1]![0]).toBe(`${SERVER}/v1/notifications/channels/${CHANNEL}`);
    await expect(f.port.registerFcm({ token: "new-synthetic", installationId: "new-install" })).rejects.toMatchObject({ problem: { operation_outcome: "unknown" } });
    await expect(f.port.unregisterFcm({})).rejects.toMatchObject({ problem: { operation_outcome: "unknown" } });
    await expect(f.port.registerFcm({ token: "third-synthetic", installationId: "third-install" })).rejects.toMatchObject({ problem: { operation_outcome: "unknown" } });
    expect(fetch).toHaveBeenCalledTimes(3); // No old-target DELETE, no unknown retry.
    const stored = Array.from({ length: f.storage.length }, (_, i) => f.storage.getItem(f.storage.key(i)!)).join(" ");
    expect(stored).toContain("new-install"); expect(stored).not.toContain("old-install");
    for (const credential of ["old-synthetic", "new-synthetic", "third-synthetic"]) expect(stored).not.toContain(credential);
    expect(stored).not.toContain("third-install");
  });
  it("a paused WebPush registration cannot overwrite a concurrently unknown target", async () => {
    const f = fixture();
    vi.spyOn(f.client["internals"], "register").mockResolvedValue({ notifications: { criteria: [{ id: "test.fire" }] } } as unknown as Application);
    const worker = { pushManager: { getSubscription: async () => ({ toJSON: () => ({
      endpoint: "https://push.example.test", keys: { auth: "synthetic", p256dh: "synthetic" }
    }) }) } } as unknown as ServiceWorkerRegistration;
    const vapid = () => Response.json({ public_key: Buffer.from([4, ...new Uint8Array(64)]).toString("base64url") });
    let started!: () => void, resume!: (response: Response) => void, keys = 0;
    const entered = new Promise<void>(resolve => { started = resolve; });
    const pending = new Promise<Response>(resolve => { resume = resolve; });
    const postTargets: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      if (String(url).endsWith("vapid-public-key")) { if (++keys === 2) { started(); return pending; } return vapid(); }
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      const body = JSON.parse(String(init?.body)); postTargets.push(body.installation_id);
      if (body.installation_id === "new-install") throw new TypeError("new admitted; response lost");
      return Response.json({ channel_id: CHANNEL });
    });
    await f.port.registerWebPush({ serviceWorker: worker, installationId: "old-install" });
    const paused = f.port.registerWebPush({ serviceWorker: worker, installationId: "old-install" });
    await entered;
    await f.port.unregisterWebPush(undefined, {});
    await expect(f.port.registerWebPush({ serviceWorker: worker, installationId: "new-install" })).rejects.toMatchObject({ problem: { operation_outcome: "unknown" } });
    resume(vapid());
    await expect(paused).rejects.toMatchObject({ code: "authority_authorization_changed", problem: { operation_outcome: "not_sent" } });
    expect(postTargets).toEqual(["old-install", "new-install"]);
    const key = `${f.client["internals"].notificationKey(COLLECTION, "web_push")}:control-timers`;
    expect(f.storage.getItem(key)).toContain("new-install"); expect(f.storage.getItem(key)).not.toContain("old-install");
  });
  it("a late DELETE ACK cannot erase a concurrently uncertain registration", async () => {
    const f = fixture();
    vi.spyOn(f.client["internals"], "register").mockResolvedValue({ notifications: {
      criteria: [{ id: "test.fire" }], native_delivery: { mode: "managed_fcm" }
    } } as unknown as Application);
    let started!: () => void, resume!: (response: Response) => void, posts = 0;
    const entered = new Promise<void>(resolve => { started = resolve; });
    const deletion = new Promise<Response>(resolve => { resume = resolve; });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      if (init?.method === "DELETE") { started(); return deletion; }
      if (++posts === 1) return Response.json({ channel_id: CHANNEL });
      throw new TypeError("replacement admitted; response lost");
    });
    await f.port.registerFcm({ token: "synthetic", installationId: "same-install" });
    const removing = f.port.unregisterFcm({}); await entered;
    await expect(f.port.registerFcm({ token: "replacement", installationId: "same-install" })).rejects.toMatchObject({ problem: { operation_outcome: "unknown" } });
    const key = `${f.client["internals"].notificationKey(COLLECTION, "fcm")}:control-timers`;
    const retained = f.storage.getItem(key); resume(new Response(null, { status: 204 }));
    await expect(removing).rejects.toMatchObject({ problem: { operation_outcome: "unknown" } });
    expect(f.storage.getItem(key)).toBe(retained); expect(retained).toContain("same-install");
  });
  it("does not erase a previous experimental multi-target acknowledgement", async () => {
    const f = fixture();
    vi.spyOn(f.client["internals"], "register").mockResolvedValue({ notifications: {
      criteria: [{ id: "test.fire" }], native_delivery: { mode: "managed_fcm" }
    } } as unknown as Application);
    const key = `${f.client["internals"].notificationKey(COLLECTION, "fcm")}:control-timers`;
    const retained = JSON.stringify({ grantId: GRANT, channelId: CHANNEL, installationId: "current",
      previousTarget: { channelId: "0192f3a4-6000-7abc-8def-0123456789b0", installationId: "previous" } });
    f.storage.setItem(key, retained); const fetch = vi.spyOn(globalThis, "fetch");
    await expect(f.port.unregisterFcm({})).rejects.toMatchObject({ problem: { operation_outcome: "unknown" } });
    await expect(f.port.registerFcm({ token: "synthetic", installationId: "current" })).rejects.toMatchObject({ problem: { operation_outcome: "unknown" } });
    expect(fetch).not.toHaveBeenCalled(); expect(f.storage.getItem(key)).toBe(retained);
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
