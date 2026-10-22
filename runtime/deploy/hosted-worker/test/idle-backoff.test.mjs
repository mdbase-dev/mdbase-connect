// Idle back-off of the socket-free polling, held-token drops at engine resets and
// CP activations: the real Worker sync/alarm/activation methods with platform
// and WASM imports replaced, a fake engine and a fake log.
import { mock, test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { encode } from "../../../packages/sdk/src/cbor.ts";

const collection = "0e0e0e0e-0e0e-4e0e-8e0e-0e0e0e0e0e0e";
const token = "s".repeat(40);
const S = 1000;
const compiled = await build({ entryPoints: [new URL("../src/worker.ts", import.meta.url).pathname], bundle: true, write: false, format: "esm", platform: "node", plugins: [{
  name: "platform-test", setup(b) {
    b.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: "platform", namespace: "fake" }));
    b.onLoad({ filter: /.*/, namespace: "fake" }, () => ({ contents: "export class DurableObject {}" }));
    b.onResolve({ filter: /hosted\.wasm$/ }, () => ({ path: "hosted.wasm", namespace: "synthetic-wasm" }));
    b.onLoad({ filter: /hosted\.wasm$/ }, () => ({ contents: "export default new WebAssembly.Module(new Uint8Array([0,97,115,109,1,0,0,0]));" }));
  },
}] });
const { HostedCollection } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString("base64")}`);


function object(escrow = false, data = new Map()) {
  let alarm = null;
  const storage = {
    get: async (k) => Array.isArray(k) ? new Map(k.filter((key) => data.has(key)).map((key) => [key, data.get(key)])) : data.get(k),
    put: async (k, v) => { data.set(k, v); }, delete: async (k) => data.delete(k),
    getAlarm: async () => alarm, setAlarm: async (at) => { alarm = at; }, deleteAlarm: async () => { alarm = null; },
  };
  let sockets = [];
  const o = Object.create(HostedCollection.prototype);
  const invalidated = [];
  Object.assign(o, { escrow, collection, wakeId: "wake-1", ctx: { id: { equals: (e) => e === collection }, storage, getWebSockets: () => sockets },
    env: { HOSTED_SERVICE_TOKEN: token, COLLECTIONS: { idFromName: (n) => n } }, logGen: 0, readers: new Map(), staleAppends: {}, lastRefresh: 0,
    attachmentWaiters: new Map(), custody: { invalidateLogToken: (c) => invalidated.push(c) } });
  o.token = async () => "t";
  o.staleAppends = { reserve: () => true, settle() {} };
  return { o, data, invalidated, alarm: () => alarm, fired: () => { alarm = null; }, sockets: (s) => { sockets = s; } };
}

const frame = (method) => encode(new Map([[2, method], [3, new Map()]]));
/** A bound engine that queues `methods` once per sync (refresh() re-arms it). */
function engine(methods = [], outputs = []) {
  let queued = [];
  const e = { logBound: true, nextWakeup: () => null, attachmentObject: () => null, signRpc: () => new Uint8Array(64),
    logCalls: () => { const q = queued; queued = []; return q; }, logBind: () => true,
    logReply() {}, logFailed() {}, poll: () => { const out = outputs; outputs = []; return out; },
    arm(next = methods) { queued = next.map((m, id) => ({ id, frame: frame(m) })); } };
  e.arm();
  return e;
}
function logReplying(status = 200) {
  return () => ({ async fetch(url) { return url.endsWith("/v1/nonce") ? new Response("ab".repeat(32)) : new Response(new Uint8Array([1]), { status }); } });
}

/** Run one alarm-like sync at `at` and return the delay it scheduled. */
async function syncAt(t, at, e = engine(["subscribe"])) {
  mock.method(Date, "now", () => at);
  t.fired();
  t.o.engine = e;
  await t.o.sync(e);
  return t.alarm() - at;
}

test("idle syncs double the poll from the base up to 10 min, for both roles", async (ctx) => {
  for (const [escrow, expected] of [[false, [60, 120, 240, 480, 600, 600, 600]], [true, [120, 240, 480, 600, 600, 600]]]) {
    const t = object(escrow); t.o.log = logReplying();
    let at = 1_000_000_000_000;
    const delays = [];
    for (let i = 0; i < expected.length; i++) { delays.push(await syncAt(t, at) / S); at += 11 * 60 * S; }
    assert.deepEqual(delays, expected, escrow ? "escrow" : "hosted");
    mock.restoreAll();
  }
});

test("the streak is persisted: an evicted actor keeps backing off", async (ctx) => {
  const data = new Map();
  const first = object(false, data); first.o.log = logReplying();
  let at = 1_000_000_000_000;
  for (let i = 0; i < 3; i++) { await syncAt(first, at); at += 11 * 60 * S; }
  assert.equal(data.get("service-idle-streak"), 3);
  const evicted = object(false, data); evicted.o.log = logReplying();
  assert.equal(await syncAt(evicted, at) / S, 480);
  mock.restoreAll();
});

test("syncs moments apart are one look: a cold open's sync plus the alarm's sync step once", async (ctx) => {
  const t = object(); t.o.log = logReplying();
  const at = 1_000_000_000_000;
  await syncAt(t, at);
  assert.equal(await syncAt(t, at + 2 * S) / S, 60, "still one doubling");
  mock.restoreAll();
});

async function backedOff(ctx) {
  const t = object(); t.o.log = logReplying();
  let at = 1_000_000_000_000;
  for (let i = 0; i < 4; i++) { await syncAt(t, at); at += 11 * 60 * S; }
  assert.equal(t.data.get("service-idle-streak"), 4);
  return { t, at };
}

test("activity resets to the base interval: activation/client request, open client, new head or write, output, failure", async (ctx) => {
  const cases = {
    "activity noted (activation, client message, socket upgrade)": (t) => { t.o.noteActivity(); return engine(["subscribe"]); },
    "an open client socket": (t) => { t.sockets([{ readyState: 1, deserializeAttachment: () => ({ wake: "wake-1" }) }]); return engine(["subscribe"]); },
    "a new remote head (reads)": () => engine(["subscribe", "read"]),
    "a local write (append)": () => engine(["append"]),
    "output delivered": () => engine(["subscribe"], [{ session: 1, frame: null }]),
  };
  for (const [name, arrange] of Object.entries(cases)) {
    const { t, at } = await backedOff(ctx);
    assert.equal(await syncAt(t, at, arrange(t)) / S, 30, name);
    assert.equal(t.data.has("service-idle-streak"), false, `${name}: the reset is persisted`);
    mock.restoreAll();
  }
  const { t, at } = await backedOff(ctx);
  t.o.log = logReplying(503);
  assert.equal(await syncAt(t, at) / S, 30, "a failed call is retried at the base rate");
  mock.restoreAll();
});

test("a socket from an earlier wake or already closed does not hold the base rate", async (ctx) => {
  const { t, at } = await backedOff(ctx);
  t.sockets([{ readyState: 1, deserializeAttachment: () => ({ wake: "wake-0" }) }, { readyState: 3, deserializeAttachment: () => ({ wake: "wake-1" }) }]);
  assert.equal(await syncAt(t, at) / S, 600);
  mock.restoreAll();
});

test("an earlier engine wakeup still wins over the backed-off poll", async (ctx) => {
  const { t, at } = await backedOff(ctx);
  const e = engine(["subscribe"]); e.nextWakeup = () => at + 5 * S;
  assert.equal(await syncAt(t, at, e) / S, 5);
  mock.restoreAll();
});

test("a CP activation drops the held token and resets the back-off before it syncs", async (ctx) => {
  const { t, at } = await backedOff(ctx);
  mock.method(Date, "now", () => at);
  t.fired();
  const e = engine(["subscribe"]); e.refresh = () => e.arm();
  t.o.engine = e; t.o.pitrClosed = false;
  t.o.ready = async () => e;
  const response = await t.o.fetch(new Request(`https://w.test/v1/hosted/activate?collection=${collection}`, {
    method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ collection }) }));
  assert.equal(response.status, 200);
  assert.deepEqual(t.invalidated, [collection]);
  assert.equal(t.alarm() - at, 30 * S);
  mock.restoreAll();
});

test("an engine reset drops the held token", () => {
  const t = object();
  t.o.engineReset("custody_verdict");
  assert.deepEqual(t.invalidated, [collection]);
});

test("a log 401/403 during sync drops the held token", async (ctx) => {
  const t = object(); t.o.log = logReplying(401);
  await syncAt(t, 1_000_000_000_000, engine(["read"]));
  assert.deepEqual(t.invalidated, [collection]);
  mock.restoreAll();
});
