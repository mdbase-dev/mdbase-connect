import { describe, expect, it, vi } from "vitest";
import { toHex } from "../src/cbor.js";
import { uuidToBytes } from "../src/codec.js";
import { connect, MdbaseClient } from "../src/index.js";
import { clientPrologue, generateKeyPair } from "../src/transport/noise.js";
import type { MessageCarrier } from "../src/transport/noise-session.js";
import {
  type AuthenticatedRelayByteDuplex,
  duplexCarrier,
  type NextBridge,
  type NextRouteResponse,
  type NextRouteTarget,
  nextRelayConnector,
  orderTargets,
} from "../src/transport/next-relay.js";
import { MemoryReplica, serveNoise } from "../src/testing/index.js";
import { uuidv7 } from "../src/values.js";
import { receipt as receiptCodec } from "../src/wire.js";

const app = { name: "t", version: "0" };

/** A duplex pair: the app end (what `openPipe` returns) and the daemon's whole messages. */
function pipe(chunk?: number) {
  let closed = false;
  const app: AuthenticatedRelayByteDuplex & { sent: Uint8Array[] } = {
    sent: [],
    onmessage: null,
    onclose: null,
    send(b) {
      if (closed) throw new Error("closed");
      app.sent.push(b);
      queueMicrotask(() => fromApp(b));
    },
    close() {
      if (closed) return;
      closed = true;
      queueMicrotask(() => daemon.onclose?.());
    },
  };
  let buf = new Uint8Array(0);
  const daemon: MessageCarrier = {
    onmessage: null,
    onclose: null,
    send(m) {
      const f = new Uint8Array(4 + m.length);
      new DataView(f.buffer).setUint32(0, m.length);
      f.set(m, 4);
      const step = chunk ?? f.length;
      for (let o = 0; o < f.length; o += step) {
        const part = f.slice(o, o + step);
        queueMicrotask(() => !closed && app.onmessage?.(part));
      }
    },
    close() {
      if (closed) return;
      closed = true;
      queueMicrotask(() => app.onclose?.({ code: 4000, reason: "pipe_closed" }));
    },
  };
  const fromApp = (d: Uint8Array) => {
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
  const end = (code: number, reason?: string) => {
    closed = true;
    app.onclose?.({ code, ...(reason ? { reason } : {}) });
  };
  return { app, daemon, end };
}

interface Device {
  id: string;
  replica: MemoryReplica;
  key: ReturnType<typeof generateKeyPair>;
  online: boolean;
  pipes: ReturnType<typeof pipe>[];
}

/** A fake Connect bridge in front of device replicas of one collection. */
function world(n = 1, chunk?: number) {
  const collection = uuidv7();
  const relayCollection = uuidv7();
  const grant = uuidv7();
  const devices: Device[] = Array.from({ length: n }, () => ({
    id: uuidv7(),
    replica: new MemoryReplica({ collection, confirmDelayMs: 0 }),
    key: generateKeyPair(),
    online: true,
    pipes: [],
  }));
  const opened: string[] = [];
  const target = (d: Device): NextRouteTarget => ({
    kind: "desktop",
    device: d.id,
    noise_pk: toHex(d.key.publicKey),
    url: "wss://cp.test/v1/next/relay/client",
    relay_collection: relayCollection,
    online: d.online,
  });
  const next: NextBridge = {
    route: async (c) => ({ collection: c, grant, targets: devices.filter((d) => d.online).map(target) }) satisfies NextRouteResponse,
    openPipe: async (c, t) => {
      expect(c).toBe(collection);
      const d = devices.find((x) => x.id === t.device)!;
      if (!d.online) throw Object.assign(new Error("offline"), { code: "invalid_operation_response" });
      opened.push(d.id);
      const p = pipe(chunk);
      d.pipes.push(p);
      // The daemon binds the relay collection, grant and its own device.
      const prologue = clientPrologue(uuidToBytes(relayCollection), uuidToBytes(grant), uuidToBytes(d.id));
      serveNoise(p.daemon, d.replica.connector(), { staticKey: d.key, prologue });
      return p.app;
    },
  };
  return { collection, grant, devices, next, opened };
}

describe("duplexCarrier", () => {
  it("frames once and reassembles arbitrary chunks", () => {
    const p = pipe();
    const c = duplexCarrier(p.app);
    const got: number[][] = [];
    c.onmessage = (m) => got.push([...m]);
    p.app.onmessage!(new Uint8Array([0, 0, 0, 2, 7]));
    p.app.onmessage!(new Uint8Array([8, 0, 0]));
    p.app.onmessage!(new Uint8Array([0, 0]));
    expect(got).toEqual([[7, 8], []]);
    c.send(new Uint8Array([1, 2, 3]));
    expect([...p.app.sent[0]!]).toEqual([0, 0, 0, 3, 1, 2, 3]);
  });

  it("ends the pipe on an oversized message and maps relay closes", () => {
    const p = pipe();
    const c = duplexCarrier(p.app);
    const errs: unknown[] = [];
    c.onclose = (e) => errs.push(e);
    p.app.onmessage!(new Uint8Array([0, 1, 0, 0]));
    expect(errs).toMatchObject([{ code: "unavailable", reason: "invalid_frame" }]);
    const q = pipe();
    const d = duplexCarrier(q.app);
    const e2: unknown[] = [];
    d.onclose = (e) => e2.push(e);
    q.end(4000, "device_key_mismatch");
    expect(e2).toMatchObject([{ code: "unauthenticated", reason: "device_key_mismatch" }]);
    expect(() => d.send(new Uint8Array(1))).toThrow();
  });
});

describe("nextRelayConnector", () => {
  it("routes, opens one pipe and runs Noise bound to relay collection, grant and device", async () => {
    const w = world(1, 5);
    const connector = nextRelayConnector({ next: w.next, collection: w.collection, staticKey: generateKeyPair() });
    const c = await connect({ app, connector, reconnect: false });
    const write = await c.create({ path: "a.md", body: "hello" });
    await write.confirmed;
    expect((await c.get({ path: "a.md" })).path).toBe("a.md");
    expect(w.opened).toEqual([w.devices[0]!.id]);
    expect(connector.target).toBe(w.devices[0]!.id);
    c.close();
  });

  it("fails the handshake when the daemon binds another grant", async () => {
    const w = world(1);
    const bad: NextBridge = { ...w.next, route: async (c) => ({ ...(await w.next.route(c)), grant: uuidv7() }) };
    const connector = nextRelayConnector({ next: bad, collection: w.collection, staticKey: generateKeyPair() });
    await expect(connect({ app, connector, reconnect: false })).rejects.toBeDefined();
  });

  it("reports no device, a mismatched route and Connect errors as SDK errors", async () => {
    const w = world(1);
    w.devices[0]!.online = false;
    const key = generateKeyPair();
    await expect(
      connect({ app, connector: nextRelayConnector({ next: w.next, collection: w.collection, staticKey: key }), reconnect: false }),
    ).rejects.toMatchObject({ code: "unavailable", reason: "no_device_online" });
    const other: NextBridge = { ...w.next, route: async () => ({ collection: uuidv7(), grant: w.grant, targets: [] }) };
    await expect(
      connect({ app, connector: nextRelayConnector({ next: other, collection: w.collection, staticKey: key }), reconnect: false }),
    ).rejects.toMatchObject({ code: "unauthenticated", reason: "route_mismatch" });
    const denied: NextBridge = {
      ...w.next,
      route: async () => {
        throw Object.assign(new Error("x"), { code: "not_authorized" });
      },
    };
    await expect(
      connect({ app, connector: nextRelayConnector({ next: denied, collection: w.collection, staticKey: key }), reconnect: false }),
    ).rejects.toMatchObject({ code: "unauthenticated" });
  });

  it("orders targets sticky-first, then online hints, and skips invalid ones", () => {
    const t = (device: string, online?: boolean, pk = "ab".repeat(32)): NextRouteTarget => ({
      kind: "desktop",
      device,
      noise_pk: pk,
      url: "wss://x/v1/next/relay/client",
      relay_collection: "0192f3a4-6000-7abc-8def-0123456789ac",
      ...(online === undefined ? {} : { online }),
    });
    const [a, b, c] = [uuidv7(), uuidv7(), uuidv7()];
    const route = { collection: "c", grant: "g", targets: [t(a), t(b, true), t(c, false, "zz")] };
    expect(orderTargets(route, null).map((x) => x.device)).toEqual([b, a]);
    expect(orderTargets(route, a).map((x) => x.device)).toEqual([a]);
    expect(orderTargets(route, c).map((x) => x.device)).toEqual([b, a]);
  });
});

describe("read fence across a failover (sticky target + confirmed_through)", () => {
  async function failover() {
    const w = world(2);
    const [a, b] = w.devices as [Device, Device];
    b.online = false;
    const connector = nextRelayConnector({ next: w.next, collection: w.collection, staticKey: generateKeyPair() });
    const c = await connect({ app, connector, reconnect: { minDelayMs: 1, maxDelayMs: 5 } });
    for (const i of [1, 2, 3]) await (await c.create({ path: `n${i}.md`, body: "x" })).confirmed;
    // A goes away; B (behind) comes online.
    a.online = false;
    b.online = true;
    a.pipes.at(-1)!.end(4000, "pipe_closed");
    await waitFor(() => w.opened.includes(b.id) && c.link === "open");
    return { w, a, b, c, connector };
  }

  it("stays on the reached device and holds reads until the new replica catches up", async () => {
    const { b, c, connector } = await failover();
    expect(connector.target).toBe(b.id);
    expect(c.readFenced).toBe(true);
    let read = false;
    const reading = c.query({}).then(() => (read = true));
    // Writes are not fenced.
    await (await c.create({ path: "during.md", body: "y" })).confirmed;
    await new Promise((r) => setTimeout(r, 10));
    expect(read).toBe(false);
    // B catches up (another writer brings it to A's position).
    const other = await connect({ app, connector: b.replica.connector(), reconnect: false });
    for (const i of [1, 2, 3]) await (await other.create({ path: `b${i}.md`, body: "z" })).confirmed;
    await reading;
    expect(c.readFenced).toBe(false);
    other.close();
    c.close();
  });

  it("does not fence a reconnect to a replica that is not behind", async () => {
    const w = world(1);
    const connector = nextRelayConnector({ next: w.next, collection: w.collection, staticKey: generateKeyPair() });
    const c: MdbaseClient = await connect({ app, connector, reconnect: { minDelayMs: 1, maxDelayMs: 5 } });
    await (await c.create({ path: "a.md", body: "x" })).confirmed;
    w.devices[0]!.pipes.at(-1)!.end(4000, "idle");
    await waitFor(() => w.opened.length === 2 && c.link === "open");
    expect(c.readFenced).toBe(false);
    expect((await c.get({ path: "a.md" })).path).toBe("a.md");
    c.close();
  });
});


describe("bridge scope and session regressions", () => {
  it("duplexCarrier buffers early messages for a late consumer, and purges them on close", () => {
    const p = pipe();
    const c = duplexCarrier(p.app);
    p.app.onmessage!(new Uint8Array([0, 0, 0, 1, 5]));
    const got: number[][] = [];
    c.onmessage = (m) => got.push([...m]);
    expect(got).toEqual([[5]]);
    const q = pipe();
    const d = duplexCarrier(q.app);
    q.app.onmessage!(new Uint8Array([0, 0, 0, 1, 5, 0, 0, 0, 1, 6]));
    q.end(4404, "connector_offline");
    const late: number[][] = [];
    d.onmessage = (m) => late.push([...m]);
    const errs: unknown[] = [];
    d.onclose = (e) => errs.push(e);
    expect(late).toEqual([]);
    expect(errs).toMatchObject([{ code: "unavailable", reason: "no_device_online" }]);
  });

  it("a pipe closed during key agreement fails the connect without unhandled rejections", async () => {
    const w = world(1);
    const closing: NextBridge = {
      ...w.next,
      openPipe: async (c, t, o) => {
        const p = await w.next.openPipe(c, t, o);
        // Terminal before the Noise consumer attaches.
        p.onclose?.({ code: 4000, reason: "handshake_timeout" });
        const d = w.devices[0]!.pipes.at(-1)!;
        d.end(4000, "handshake_timeout");
        return p;
      },
    };
    await expect(
      connect({ app, connector: nextRelayConnector({ next: closing, collection: w.collection, staticKey: generateKeyPair() }), reconnect: false }),
    ).rejects.toBeDefined();
  });

  it("maps a refused admission's close code from the Connect error", async () => {
    const w = world(1);
    const refusing: NextBridge = {
      ...w.next,
      openPipe: async () => {
        throw Object.assign(new Error("x"), { code: "invalid_operation_response", cause: { code: 4429, reason: "connector_busy" } });
      },
    };
    await expect(
      connect({ app, connector: nextRelayConnector({ next: refusing, collection: w.collection, staticKey: generateKeyPair() }), reconnect: false }),
    ).rejects.toMatchObject({ code: "rate_limited" });
  });

  it("propagates the connect signal to route and openPipe and stops after abort", async () => {
    const w = world(1);
    const controller = new AbortController();
    const seen: (AbortSignal | undefined)[] = [];
    let opened = 0;
    const next: NextBridge = {
      route: async (c, o) => {
        seen.push(o?.signal);
        const r = await w.next.route(c);
        controller.abort();
        return r;
      },
      openPipe: async (c, t, o) => {
        opened++;
        return w.next.openPipe(c, t, o);
      },
    };
    const connector = nextRelayConnector({ next, collection: w.collection, staticKey: generateKeyPair() });
    await expect(connect({ app, connector, reconnect: false, signal: controller.signal })).rejects.toMatchObject({ code: "cancelled" });
    expect(seen[0]).toBe(controller.signal);
    expect(opened).toBe(0);
  });

  it("a fenced read can be aborted, and close wakes every fenced read", async () => {
    const { c } = await failoverClient();
    expect(c.readFenced).toBe(true);
    const ac = new AbortController();
    const aborted = c.get({ path: "n1.md" }, undefined, ac.signal);
    ac.abort();
    await expect(aborted).rejects.toMatchObject({ code: "cancelled" });
    const pending = c.query({});
    c.close();
    await expect(pending).rejects.toMatchObject({ code: "unavailable" });
  });

  it("a second failover to a caught-up replica serves held reads, lives and change feeds once", async () => {
    const { w, a, b, c } = await failoverClient();
    const live = c.live({});
    const batches: number[] = [];
    const stop = c.watchChanges(undefined, (x) => batches.push(x.changes.length));
    const read = c.get({ path: "n1.md" });
    expect(c.readFenced).toBe(true);
    // B dies while behind; A returns (it has everything).
    b.online = false;
    a.online = true;
    b.pipes.at(-1)!.end(4000, "pipe_closed");
    await waitFor(() => w.opened.filter((d) => d === a.id).length === 2 && c.link === "open");
    expect((await read).path).toBe("n1.md");
    await live.ready;
    expect(live.records.length).toBe(3);
    expect(c.readFenced).toBe(false);
    stop();
    c.close();
  });

  it("a read and a file stream started while reconnecting wait for the fence on the new session", async () => {
    const { w, a, b, c } = await failoverClient();
    // Drop B too: the client is reconnecting with the fence up.
    b.online = false;
    b.pipes.at(-1)!.end(4000, "pipe_closed");
    await waitFor(() => c.link === "reconnecting");
    const read = c.get({ path: "n2.md" });
    const stream = c.files.downloadStream({ path: "missing.bin" } as never);
    a.online = true;
    await waitFor(() => c.link === "open" && w.opened.filter((d) => d === a.id).length === 2);
    expect((await read).path).toBe("n2.md");
    await expect(stream.file).rejects.toBeDefined();
    c.close();
  });
});

describe("next-relay-only consistency policy", () => {
  it.each(["receipt", "await", "submit"] as const)("confirmed %s RPC advances the next-relay failover floor", async (source) => {
    const w = world(2), [a, b] = w.devices as [Device, Device]; b.online = false;
    const c = await connect({ app, connector: nextRelayConnector({ next: w.next, collection: w.collection, staticKey: generateKeyPair() }), reconnect: { minDelayMs: 1, maxDelayMs: 5 } });
    const writer = await connect({ app, connector: a.replica.connector(), reconnect: false });
    try {
      const done = await (await writer.create({ path: "confirmed.md", body: "seen" })).confirmed;
      const observed = source === "receipt" ? await c.receipt(done.mutation)
        : source === "await" ? await c.awaitReceipt(done.mutation)
        : (await c.create({ path: "confirmed.md", body: "seen" }, { mutationId: done.mutation })).receipt;
      expect(observed.state).toBe("confirmed"); expect(observed.seq).toBe(1);
      // No status subscription or original mutation submitted by this session.
      a.online = false; b.online = true; a.pipes.at(-1)!.end(4000, "pipe_closed");
      await waitFor(() => c.link === "open" && w.opened.includes(b.id));
      expect(c.readFenced).toBe(true);
    } finally { c.close(); writer.close(); }
  });
  it.each([true, false])("uses the original receipt codec despite pending options mutation (original=%s)", async (original) => {
    const w = world(2), [a, b] = w.devices as [Device, Device]; b.online = false;
    const c = await connect({ app, connector: nextRelayConnector({ next: w.next, collection: w.collection, staticKey: generateKeyPair() }), reconnect: { minDelayMs: 1, maxDelayMs: 5 } });
    const writer = await connect({ app, connector: a.replica.connector(), reconnect: false });
    const otherCodec = { ...receiptCodec }, options = { codec: original ? receiptCodec : otherCodec };
    let release!: () => void, held = false;
    const gate = new Promise<void>(r => { release = r; });
    const session = c.currentSession(), request = session.request.bind(session);
    const mock = vi.spyOn(session, "request").mockImplementation(async (name, p, selected) => {
      const result = await request(name, p, selected);
      if (name === "receipt") { held = true; await gate; }
      return result;
    });
    try {
      const done = await (await writer.create({ path: "codec.md", body: "seen" })).confirmed;
      const pending = c.call("receipt", new Map([[0, uuidToBytes(done.mutation)]]), options);
      await waitFor(() => held);
      expect(mock.mock.calls.at(-1)![2]!.codec).toBe(original ? receiptCodec : otherCodec);
      options.codec = original ? otherCodec : receiptCodec;
      release(); expect((await pending).state).toBe("confirmed");
      a.online = false; b.online = true; a.pipes.at(-1)!.end(4000, "pipe_closed");
      await waitFor(() => c.link === "open" && w.opened.includes(b.id));
      expect(c.readFenced).toBe(original);
    } finally { release(); mock.mockRestore(); c.close(); writer.close(); }
  });
  it.each(["receipt", "await"] as const)("late %s reply cannot contribute a retired session's floor", async (method) => {
    const w = world(2), [a, b] = w.devices as [Device, Device]; b.online = false;
    const c = await connect({ app, connector: nextRelayConnector({ next: w.next, collection: w.collection, staticKey: generateKeyPair() }), reconnect: { minDelayMs: 1, maxDelayMs: 5 } });
    const writer = await connect({ app, connector: a.replica.connector(), reconnect: false });
    let release!: () => void, held = false;
    const gate = new Promise<void>(r => { release = r; });
    const session = c.currentSession(), request = session.request.bind(session);
    const mock = vi.spyOn(session, "request").mockImplementation(async (name, p, options) => {
      const result = await request(name, p, options);
      if(name === method) { held = true; await gate; }
      return result;
    });
    try {
      const done = await (await writer.create({ path: "late.md", body: "seen" })).confirmed;
      const late = method === "receipt" ? c.receipt(done.mutation) : c.awaitReceipt(done.mutation);
      await waitFor(() => held);
      a.online = false; b.online = true; a.pipes.at(-1)!.end(4000, "pipe_closed");
      await waitFor(() => c.link === "open" && w.opened.includes(b.id));
      expect(c.readFenced).toBe(false);
      release(); expect((await late).state).toBe("confirmed");
      // Reconnect again to another session still at zero: a retired reply must
      // not have raised hidden bookkeeping for this subsequent replacement.
      const previous = w.opened.length; b.pipes.at(-1)!.end(4000, "pipe_closed");
      await waitFor(() => c.link === "open" && w.opened.length > previous);
      expect(c.readFenced).toBe(false);
    } finally { release(); mock.mockRestore(); c.close(); writer.close(); }
  });
  it("does not enable the fence from descriptions or on other connector identities", async () => {
    const w = world(2);
    const [a, b] = w.devices as [Device, Device];
    b.online = false;
    const relay = nextRelayConnector({ next: w.next, collection: w.collection, staticKey: generateKeyPair() });
    // A custom connector retains pre-existing SDK behavior, even with this label.
    const other = { description: relay.description, open: relay.open };
    const c = await connect({ app, connector: other, reconnect: { minDelayMs: 1, maxDelayMs: 5 } });
    try {
      await (await c.create({ path: "old.md", body: "x" })).confirmed;
      a.online = false; b.online = true; a.pipes.at(-1)!.end(4000, "pipe_closed");
      await waitFor(() => w.opened.includes(b.id) && c.link === "open");
      expect(c.readFenced).toBe(false);
      expect((await c.query({})).records).toHaveLength(0);
    } finally { c.close(); }
  });

  it("pins collection and bridge methods before route awaits", async () => {
    const w = world();
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(r => { entered = r; });
    const gate = new Promise<void>(r => { release = r; });
    const next: NextBridge = { ...w.next, route: async (c, o) => { entered(); await gate; return w.next.route(c, o); } };
    const opts = { next, collection: w.collection, staticKey: generateKeyPair() };
    const connector = nextRelayConnector(opts);
    const opening = connect({ app, connector, reconnect: false });
    await started;
    opts.collection = uuidv7();
    opts.next = { route: async () => { throw Error("foreign fixture"); }, openPipe: async () => { throw Error("foreign fixture"); } };
    next.openPipe = opts.next.openPipe;
    release();
    const c = await opening;
    expect(c.collection).toBe(w.collection);
    c.close();
  });

  it("holds typed catalog and file-stream reads while status/receipt/proof probes stay usable", async () => {
    const { c } = await failoverClient();
    try {
      const ac = new AbortController();
      const typed = c.describeTyping(["task"], ["due"], ac.signal);
      const stream = c.files.downloadStream({ path: "missing.bin" } as never, { signal: ac.signal });
      await c.getStatus();
      const observed = await c.receipt(uuidv7()).catch(e => e);
      expect(observed).toBeDefined();
      const proof = await c.appliedPrefix(0).catch(e => e);
      expect(proof).toBeDefined();
      ac.abort();
      await expect(typed).rejects.toMatchObject({ code: "cancelled" });
      await expect(stream.file).rejects.toMatchObject({ code: "cancelled" });
    } finally { c.close(); }
  });

  it("rejects non-retrying stale reads and retries idempotent reads on the current session", async () => {
    const w = world(2);
    const [a, b] = w.devices as [Device, Device]; b.online = false;
    const connector = nextRelayConnector({ next: w.next, collection: w.collection, staticKey: generateKeyPair() });
    const c = await connect({ app, connector, reconnect: { minDelayMs: 1, maxDelayMs: 5 } });
    await (await c.create({ path: "n.md", body: "x" })).confirmed;
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const s = c.currentSession(), request = s.request.bind(s);
    let held = 0;
    const mock = vi.spyOn(s, "request").mockImplementation(async (method, p, opts) => {
      const result = await request(method, p, opts);
      if (method === "query") { held++; await gate; }
      return result;
    });
    try {
      const retry = c.query({});
      const once = c.call("query", new Map(), { retry: false });
      // Observe expected rejection before releasing both old-session replies.
      const refused = expect(once).rejects.toMatchObject({ code: "unavailable", reason: "reconnecting" });
      await waitFor(() => held === 2);
      a.online = false; b.online = true; a.pipes.at(-1)!.end(4000, "pipe_closed");
      await waitFor(() => c.readFenced && c.link === "open");
      release(); await refused;
      b.online = false; a.online = true; b.pipes.at(-1)!.end(4000, "pipe_closed");
      await waitFor(() => !c.readFenced && c.link === "open");
      expect((await retry).records).toHaveLength(1);
    } finally { release(); mock.mockRestore(); c.close(); }
  });

  it("a late get-status reply cannot lift the new session's fence", async () => {
    const w = world(2);
    const [a, b] = w.devices as [Device, Device]; b.online = false;
    const c = await connect({ app, connector: nextRelayConnector({ next: w.next, collection: w.collection, staticKey: generateKeyPair() }), reconnect: { minDelayMs: 1, maxDelayMs: 5 } });
    await (await c.create({ path: "n.md", body: "x" })).confirmed;
    let release!: () => void, held = false;
    const gate = new Promise<void>(r => { release = r; });
    const s = c.currentSession(), request = s.request.bind(s);
    const mock = vi.spyOn(s, "request").mockImplementation(async (method, p, opts) => {
      const result = await request(method, p, opts);
      if (method === "get_status") { held = true; await gate; }
      return result;
    });
    try {
      const status = c.getStatus(); await waitFor(() => held);
      a.online = false; b.online = true; a.pipes.at(-1)!.end(4000, "pipe_closed");
      await waitFor(() => c.readFenced && c.link === "open");
      release();
      expect((await status).confirmedThrough).toBe(0);
      expect(c.readFenced).toBe(true);
    } finally { release(); mock.mockRestore(); c.close(); }
  });
});

async function failoverClient() {
  const w = world(2);
  const [a, b] = w.devices as [Device, Device];
  b.online = false;
  const connector = nextRelayConnector({ next: w.next, collection: w.collection, staticKey: generateKeyPair() });
  const c = await connect({ app, connector, reconnect: { minDelayMs: 1, maxDelayMs: 5 } });
  for (const i of [1, 2, 3]) await (await c.create({ path: `n${i}.md`, body: "x" })).confirmed;
  a.online = false;
  b.online = true;
  a.pipes.at(-1)!.end(4000, "pipe_closed");
  await waitFor(() => w.opened.includes(b.id) && c.link === "open");
  return { w, a, b, c };
}

async function waitFor(f: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 2));
  }
}
