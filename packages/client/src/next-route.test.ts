import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StoredToken } from "./internal-types.js";
import { connectionNext, type NextRouteTarget } from "./next-route.js";

const COLLECTION = "0192f3a4-6000-7abc-8def-0123456789ab";
const RELAY_COLLECTION = "0192f3a4-6000-7abc-8def-0123456789ac";
const GRANT = "0192f3a4-6000-7abc-8def-0123456789ad";
const DEVICE = "0192f3a4-6000-7abc-8def-0123456789ae";
const PIPE = "0192f3a4-6000-7abc-8def-0123456789af";
const NOISE = "ab".repeat(32);
const SERVER = "https://cp.example.test";
const RELAY = "wss://cp.example.test/v1/next/relay/client";
const SECRET = "secret-access-token";

function token(over: Partial<StoredToken> = {}): StoredToken {
  return {
    version: 1, accessToken: SECRET, clientId: "client", collectionId: COLLECTION, collectionName: "c",
    operations: [], scope: "full_collection" as StoredToken["scope"], expiresAt: Date.now() + 3_600_000,
    grantId: GRANT, applicationOrigin: "https://app.example.test", keyHandle: "key-1", savedAt: 1, ...over
  };
}

function routeBody(over: Record<string, unknown> = {}, target: Record<string, unknown> = {}) {
  return {
    collection: COLLECTION, grant: GRANT,
    targets: [{ kind: "desktop", device: DEVICE, noise_pk: NOISE, url: RELAY, relay_collection: RELAY_COLLECTION, ...target }],
    ...over
  };
}

class FakeSocket {
  static all: FakeSocket[] = [];
  binaryType = "blob";
  bufferedAmount = 0;
  sent: Array<string | Uint8Array> = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) { FakeSocket.all.push(this); }
  send(data: string | Uint8Array) { this.sent.push(data); }
  close() { this.closed = true; }
  open() { this.onopen?.(); }
  text(data: string) { this.onmessage?.({ data }); }
  binary(bytes: number[]) { this.onmessage?.({ data: new Uint8Array(bytes).buffer }); }
  shut(code: number, reason = "") { this.onclose?.({ code, reason }); }
}

async function tick() { for (let i = 0; i < 5; i += 1) await Promise.resolve(); await new Promise(r => setTimeout(r, 0)); }

describe("Next route and relay pipe", () => {
  let current: StoredToken | null;
  let leases: number;
  let releases: number;
  let routes: Array<() => unknown>;
  const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
    expect(String(url)).toBe(`${SERVER}/v1/next/collections/${COLLECTION}/route`);
    expect(init?.redirect).toBe("error");
    expect(init?.credentials).toBe("omit");
    expect((init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${SECRET}`);
    const next = routes.shift();
    return Response.json(next ? next() : routeBody());
  });

  function bridge(serverUrl = SERVER) {
    return connectionNext({
      serverUrl, collection: COLLECTION, current: () => current,
      lease: async () => { leases += 1; return { token: current!, release: () => { releases += 1; } }; }
    });
  }

  async function opened() {
    const next = bridge();
    const route = await next.route(COLLECTION);
    const pending = next.openPipe(COLLECTION, route.targets[0]!);
    await tick();
    const socket = FakeSocket.all.at(-1)!;
    socket.open();
    socket.text(JSON.stringify({ type: "pipe_opened", pipe_id: PIPE }));
    return { next, route, pipe: await pending, socket };
  }

  beforeEach(() => {
    current = token(); leases = 0; releases = 0; routes = []; FakeSocket.all = [];
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("WebSocket", FakeSocket);
  });
  afterEach(() => { vi.unstubAllGlobals(); fetchMock.mockClear(); });

  it("refuses a non-HTTPS control plane before any token lease or network", async () => {
    await expect(bridge("http://cp.example.test").route(COLLECTION)).rejects.toThrow();
    await expect(bridge().route("not-a-uuid")).rejects.toThrow();
    expect(leases).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("validates the route against the grant, collection and pinned relay", async () => {
    for (const bad of [
      routeBody({ grant: DEVICE }), routeBody({ collection: DEVICE }),
      routeBody({}, { url: "wss://evil.example.test/v1/next/relay/client" }),
      routeBody({}, { noise_pk: "0".repeat(64) }), routeBody({}, { relay_collection: undefined }),
      routeBody({}, { kind: ["desktop"] }), routeBody({}, { kind: "laptop" })
    ]) {
      routes.push(() => bad);
      await expect(bridge().route(COLLECTION)).rejects.toThrow();
    }
    expect(releases).toBe(leases);
    const ok = await bridge().route(COLLECTION);
    expect(ok.targets[0]!.device).toBe(DEVICE);
    expect(JSON.stringify(ok)).not.toContain(SECRET);
  });

  it("opens only a target it routed, sends pipe_auth first and admits on pipe_opened", async () => {
    const forged: NextRouteTarget = { kind: "desktop", device: DEVICE, noise_pk: NOISE, url: RELAY, relay_collection: RELAY_COLLECTION };
    await expect(bridge().openPipe(COLLECTION, forged)).rejects.toThrow();
    const { pipe, socket } = await opened();
    expect(socket.url).toBe(RELAY);
    expect(socket.sent).toHaveLength(1);
    const auth = JSON.parse(socket.sent[0] as string);
    expect(auth).toEqual({ type: "pipe_auth", access_token: SECRET, collection: RELAY_COLLECTION,
      grant: GRANT, device: DEVICE, device_noise_pk: NOISE });
    expect(Object.keys(pipe)).not.toContain("accessToken");
    // Bytes that arrive before a listener are kept; the duplex sends raw chunks.
    socket.binary([0, 0, 0, 1, 9]);
    const got: number[][] = [];
    pipe.onmessage = bytes => got.push([...bytes]);
    expect(got).toEqual([[0, 0, 0, 1, 9]]);
    pipe.send(new Uint8Array([1, 2, 3]));
    expect([...(socket.sent[1] as Uint8Array)]).toEqual([1, 2, 3]);
    expect(releases).toBe(leases - 1);
    pipe.close();
    pipe.close();
    expect(releases).toBe(leases);
  });

  it("delivers the terminal close with a sanitized reason, once, even to a late listener", async () => {
    const { pipe, socket } = await opened();
    socket.shut(4000, "device_key_mismatch");
    const seen: unknown[] = [];
    pipe.onclose = event => seen.push(event);
    expect(seen).toEqual([{ code: 4000, reason: "device_key_mismatch" }]);
    expect(() => pipe.send(new Uint8Array([1]))).toThrow();
    expect(releases).toBe(leases);
    const second = await opened();
    second.socket.shut(4000, "secretword");
    const later: unknown[] = [];
    second.pipe.onclose = event => later.push(event);
    expect(later).toEqual([{ code: 4000 }]);
  });

  it("fails closed when the re-fetched route changed grant or target, releasing once", async () => {
    const next = bridge();
    const route = await next.route(COLLECTION);
    routes.push(() => routeBody({}, { noise_pk: "cd".repeat(32) }));
    await expect(next.openPipe(COLLECTION, route.targets[0]!)).rejects.toThrow();
    expect(FakeSocket.all).toHaveLength(0);
    expect(releases).toBe(leases);
  });

  it("rejects binary or malformed admission and refused sockets without leaking the lease", async () => {
    const next = bridge();
    const route = await next.route(COLLECTION);
    const pending = next.openPipe(COLLECTION, route.targets[0]!);
    await tick();
    const socket = FakeSocket.all.at(-1)!;
    socket.open();
    socket.binary([1, 2]);
    await expect(pending).rejects.toThrow();
    expect(socket.closed).toBe(true);
    const again = next.openPipe(COLLECTION, route.targets[0]!);
    await tick();
    FakeSocket.all.at(-1)!.shut(4404, "connector_offline");
    await expect(again).rejects.toMatchObject({ cause: { code: 4404, reason: "connector_offline" } });
    expect(releases).toBe(leases);
  });

  it("closes the pipe when the retained grant binding changes", async () => {
    const { pipe } = await opened();
    current = token({ keyHandle: "key-2" });
    const seen: unknown[] = [];
    pipe.onclose = event => seen.push(event);
    expect(() => pipe.send(new Uint8Array([1]))).toThrow();
    expect(seen).toHaveLength(1);
    expect(releases).toBe(leases);
  });

  it("closes an admitted pipe when the caller's own signal aborts later", async () => {
    const next = bridge();
    const route = await next.route(COLLECTION);
    const controller = new AbortController();
    const pending = next.openPipe(COLLECTION, route.targets[0]!, { signal: controller.signal });
    await tick();
    const socket = FakeSocket.all.at(-1)!;
    socket.open();
    socket.text(JSON.stringify({ type: "pipe_opened", pipe_id: PIPE }));
    const pipe = await pending;
    const seen: unknown[] = [];
    pipe.onclose = event => seen.push(event);
    controller.abort();
    expect(seen).toHaveLength(1);
    expect(socket.closed).toBe(true);
    expect(releases).toBe(leases);
    // A late open/admission on a dead socket sends nothing.
    socket.open();
    expect(socket.sent).toHaveLength(1);
  });
});

