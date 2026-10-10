import { describe, expect, it, vi } from "vitest";
import { fromHex, toHex } from "../src/cbor.js";
import { uuidToBytes } from "../src/codec.js";
import { connect } from "../src/index.js";
import { clientPrologue, generateKeyPair } from "../src/transport/noise.js";
import { MessageCarrier, WebSocketLike } from "../src/transport/noise-session.js";
import { relayConnector } from "../src/transport/relay.js";
import { MemoryReplica, serveNoise } from "../src/testing/index.js";
import { uuidv7 } from "../src/values.js";

type Behaviour = { close?: [number, string]; pipeClose?: string; chunk?: number };

/** A fake Connect relay (`/v1/next/relay/client`) bridging pipes to a Noise responder. */
function fakeRelay(onPipe: (c: MessageCarrier) => void, auths: unknown[], b: Behaviour = {}) {
  return (url: string): WebSocketLike => {
    const ws: WebSocketLike = {
      binaryType: "blob",
      readyState: 0,
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
      send: (d) => queueMicrotask(() => fromClient(d)),
      close: () => queueMicrotask(() => ws.onclose?.({ code: 1000 })),
    };
    let buf = new Uint8Array(0);
    let opened = false;
    // The daemon side of the pipe: whole Noise messages.
    const daemon: MessageCarrier = {
      onmessage: null,
      onclose: null,
      send: (m) => {
        const f = new Uint8Array(4 + m.length);
        new DataView(f.buffer).setUint32(0, m.length);
        f.set(m, 4);
        // Optionally re-chunk to check the client tolerates it.
        const step = b.chunk ?? f.length;
        for (let o = 0; o < f.length; o += step) {
          const part = f.slice(o, o + step);
          queueMicrotask(() => ws.onmessage?.({ data: part.buffer }));
        }
      },
      close: () => queueMicrotask(() => ws.onclose?.({ code: 1000 })),
    };
    const fromClient = (d: Uint8Array | string) => {
      if (typeof d === "string") {
        const m = JSON.parse(d) as { type: string };
        auths.push({ url, ...m });
        if (b.close) return ws.onclose?.({ code: b.close[0], reason: b.close[1] });
        if (b.pipeClose) return ws.onmessage?.({ data: JSON.stringify({ type: "pipe_close", reason: b.pipeClose }) });
        opened = true;
        onPipe(daemon);
        ws.onmessage?.({ data: JSON.stringify({ type: "pipe_opened", pipe_id: uuidv7() }) });
        return;
      }
      if (!opened) throw new Error("binary before pipe_opened");
      const nb = new Uint8Array(buf.length + d.length);
      nb.set(buf);
      nb.set(d, buf.length);
      let off = 0;
      while (nb.length - off >= 4) {
        const len = new DataView(nb.buffer, off, 4).getUint32(0);
        if (nb.length - off - 4 < len) break;
        daemon.onmessage?.(nb.slice(off + 4, off + 4 + len));
        off += 4 + len;
      }
      buf = nb.slice(off);
    };
    queueMicrotask(() => ws.onopen?.({}));
    return ws;
  };
}

describe("relay Noise pipe (Connect #596)", () => {
  const device = uuidv7();
  const grant = uuidv7();
  const key = generateKeyPair();

  function setup(b: Behaviour = {}) {
    const replica = new MemoryReplica({ confirmDelayMs: 0 });
    const auths: Record<string, unknown>[] = [];
    const prologue = clientPrologue(uuidToBytes(replica.collection), uuidToBytes(grant), uuidToBytes(device));
    const ws = fakeRelay((c) => serveNoise(c, replica.connector(), { staticKey: key, prologue }), auths, b);
    const connector = relayConnector({
      collection: replica.collection,
      grant,
      staticKey: generateKeyPair(),
      webSocket: ws,
      resolveRoute: async () => ({
        url: "wss://connect.test/v1/next/relay/client",
        targetDevice: device,
        noisePublicKey: key.publicKey,
        pipe: { collection: "col_local_1", accessToken: "tok_abc" },
      }),
    });
    return { replica, auths, connector };
  }

  it("authenticates in the first text frame, then runs Noise over u32be-framed binary", async () => {
    const { replica, auths, connector } = setup({ chunk: 7 });
    const c = await connect({ app: { name: "t", version: "0" }, connector, reconnect: false });
    expect(auths).toEqual([
      {
        url: "wss://connect.test/v1/next/relay/client",
        type: "pipe_auth",
        access_token: "tok_abc",
        collection: "col_local_1",
        grant,
        device,
        device_noise_pk: toHex(key.publicKey),
      },
    ]);
    expect(fromHex((auths[0]!.device_noise_pk as string))).toEqual(key.publicKey);
    const w = await c.create({ path: "a.md", body: "x".repeat(150_000) });
    await w.confirmed;
    expect(replica.allRecords).toHaveLength(1);
    c.close();
  });

  for (const [code, reason, want] of [
    [4401, "unauthenticated", { code: "unauthenticated" }],
    [4403, "grant_inactive", { code: "forbidden" }],
    [4404, "connector_offline", { code: "unavailable", reason: "no_device_online" }],
    [4429, "connector_busy", { code: "rate_limited" }],
    [4000, "device_key_mismatch", { code: "unauthenticated", reason: "device_key_mismatch" }],
    [4000, "device_mismatch", { code: "unavailable", reason: "device_mismatch" }],
  ] as const) {
    it(`close ${code} ${reason} → ${want.code}`, async () => {
      const { connector } = setup({ close: [code, reason] });
      await expect(connect({ app: { name: "t", version: "0" }, connector, reconnect: false })).rejects.toMatchObject(want);
    });
  }

  it("pipe_close from the daemon before opening is an error with its reason", async () => {
    const { connector } = setup({ pipeClose: "not_served" });
    await expect(connect({ app: { name: "t", version: "0" }, connector, reconnect: false })).rejects.toMatchObject({
      code: "unavailable",
      reason: "not_served",
    });
  });
});

describe("relay pipe preconditions", () => {
  const base = { accessToken: "t", collection: "c", grant: "g", device: "d", devicePublicKey: new Uint8Array(32) };
  it("refuses ws: and grantless pipes before opening anything", async () => {
    const { relayPipeCarrier } = await import("../src/transport/relay-pipe.js");
    let opened = 0;
    const ws = () => {
      opened++;
      throw new Error("must not open");
    };
    await expect(relayPipeCarrier("ws://relay/v1/next/relay/client", base, ws)).rejects.toMatchObject({ reason: "relay_insecure" });
    await expect(relayPipeCarrier("wss://relay/x", { ...base, grant: "" }, ws)).rejects.toMatchObject({ reason: "grant_required" });
    expect(opened).toBe(0);
  });
});

describe("control route (Connect #600)", () => {
  it("rejects non-HTTPS and ambiguous origins before token access or fetch", async () => {
    const { controlRouteResolver } = await import("../src/transport/control-route.js");
    let tokens = 0;
    let requests = 0;
    for (const server of ["http://cp", "ws://cp", "file:///cp", "/relative", "https://u:p@cp", "https://cp/path", "https://cp?q=1", "https://cp#fragment"]) {
      expect(() => controlRouteResolver({
        server, collection: "c", accessToken: () => { tokens++; return "token"; },
        fetch: (async () => { requests++; throw new Error("must not fetch"); }) as typeof fetch,
      })).toThrowError(expect.objectContaining({ code: "invalid_request" }));
    }
    expect(tokens).toBe(0);
    expect(requests).toBe(0);
  });

  it("snapshots the HTTPS destination and refuses redirects", async () => {
    const { controlRouteResolver } = await import("../src/transport/control-route.js");
    let seen: { url: string; init: RequestInit | undefined } | undefined;
    const options = {
      server: "https://cp/", collection: "c", accessToken: () => "token",
      fetch: (async (url, init) => {
        seen = { url: String(url), init };
        return new Response(JSON.stringify({ targets: [] }));
      }) as typeof fetch,
    };
    const resolve = controlRouteResolver(options);
    options.server = "http://untrusted";
    options.collection = "foreign";
    await resolve();
    expect(seen?.url).toBe("https://cp/v1/next/collections/c/route");
    expect(seen?.init?.redirect).toBe("error");
  });

  it("uses the original native GlobalScope receiver without copying transport error text", async () => {
    const { controlRouteResolver } = await import("../src/transport/control-route.js");
    const request = vi.spyOn(globalThis, "fetch").mockImplementation(function(this: unknown) {
      expect(this).toBe(globalThis);
      return Promise.reject(Error("private transport content must not escape"));
    });
    try {
      await expect(controlRouteResolver({ server: "https://cp", collection: "c", accessToken: () => "token" })()).rejects.toMatchObject({ code: "unavailable", reason: "control_unreachable", message: "cannot reach the control plane" });
      expect(request).toHaveBeenCalledOnce();
    } finally { request.mockRestore(); }
  });

  it("maps targets to relay routes and refusals to the 15 codes", async () => {
    const { controlRouteResolver, routeFromControl } = await import("../src/transport/control-route.js");
    const pk = "ab".repeat(32);
    const body = {
      collection: "c",
      grant: "g",
      targets: [{ kind: "daemon", device: "d1", noise_pk: pk, url: "wss://r/v1/next/relay/client", relay_collection: "rc" }],
    };
    const r = routeFromControl(body, "tok")!;
    expect(r.pipe).toEqual({ collection: "rc", accessToken: "tok" });
    expect(r.targetDevice).toBe("d1");
    expect(routeFromControl({ ...body, targets: [] }, "t")).toBeNull();
    const seen: string[] = [];
    const resp = (status: number, json: unknown) =>
      (async (url: string, init: RequestInit) => {
        seen.push(`${url} ${(init.headers as Record<string, string>).authorization}`);
        return new Response(JSON.stringify(json), { status });
      }) as unknown as typeof fetch;
    const mk = (f: typeof fetch) => controlRouteResolver({ server: "https://cp/", collection: "c 1", accessToken: () => "tok", fetch: f });
    await expect(mk(resp(200, body))()).resolves.toMatchObject({ targetDevice: "d1" });
    expect(seen[0]).toBe("https://cp/v1/next/collections/c%201/route Bearer tok");
    await expect(mk(resp(200, { ...body, targets: [], reason: "no_device_registered" }))()).rejects.toMatchObject({ reason: "no_device_registered" });
    await expect(mk(resp(200, { ...body, targets: [] }))()).resolves.toBeNull();
    await expect(mk(resp(409, {}))()).rejects.toMatchObject({ code: "unauthenticated", reason: "client_key_required" });
    await expect(mk(resp(401, {}))()).rejects.toMatchObject({ code: "unauthenticated" });
  });
});
