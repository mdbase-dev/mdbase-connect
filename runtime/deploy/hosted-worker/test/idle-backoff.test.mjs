// Idle back-off of the socket-free polling, held-token drops at engine resets and
// CP activations: the real Worker sync/alarm/activation methods with platform
// and WASM imports replaced, a fake engine and a fake log.
import { mock, test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { encode } from "../../../packages/sdk/src/cbor.ts";
import { INSTALL_WAKE_MS, installRetryMs } from "../src/install-retry.ts";

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
const worker = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text + "\n//# sourceURL=idle-backoff-worker.mjs").toString("base64")}`);
const { HostedCollection } = worker;

// Cloudflare lists an exported function as a named handler, and a code-only Worker
// publication refuses any change to that list, so a new helper belongs in its own module.
test("the Worker entry adds no export", () => {
  assert.deepEqual(Object.keys(worker).sort(), ["HostedCollection", "default", "idlePollMs"]);
});


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
  let queued = [], applied = 0, sent = [];
  const e = { appliedHead: () => String(applied), logBound: true, nextWakeup: () => null, installStatus: () => null, snapshotDeclined: () => false, attachmentObject: () => null, signRpc: () => new Uint8Array(64),
    logCalls: () => { const q = queued; queued = []; return q; }, logBind: () => true,
    logReply(id) { if (sent[id] === "read") applied++; }, logFailed() {}, poll: () => { const out = outputs; outputs = []; return out; },
    arm(next = methods) { sent = next; queued = next.map((m, id) => ({ id, frame: frame(m) })); } };
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

test("a declined snapshot build reports once, with no identifiers or counts", async () => {
  const lines = [];
  mock.method(console, "info", (line) => lines.push(JSON.parse(line)));
  const t = object(); t.o.log = logReplying();
  const at = 1_000_000_000_000;
  const e = engine(["get_object"]);
  let declined = true;
  e.snapshotDeclined = () => { const was = declined; declined = false; return was; };
  await syncAt(t, at, e);
  e.arm(["get_object"]);
  await syncAt(t, at + 40 * S, e);
  assert.deepEqual(lines.filter(l => l.event === "hosted_snapshot_declined"), [{ event: "hosted_snapshot_declined", role: "hosted" }]);
  mock.restoreAll();
});

test("a Wasm trap logs one line with no identifiers and still fails the alarm", async () => {
  const lines = [];
  mock.method(console, "info", (line) => lines.push(JSON.parse(line)));
  const t = object(true);
  t.o.runAlarm = async () => { throw new WebAssembly.RuntimeError("unreachable"); };
  await assert.rejects(t.o.alarm(), WebAssembly.RuntimeError);
  assert.deepEqual(lines, [{ event: "hosted_wasm_trap", role: "escrow" }]);
  t.o.runAlarm = async () => { throw new Error("other"); };
  await assert.rejects(t.o.alarm(), /other/);
  assert.equal(lines.length, 1, "only a trap");
  mock.restoreAll();
});

test("a running snapshot install wakes at once, reports counts only, then falls back to the poll", async (ctx) => {
  const lines = [];
  mock.method(console, "info", (line) => lines.push(JSON.parse(line)));
  const t = object(); t.o.log = logReplying();
  const at = 1_000_000_000_000;
  const e = engine(["get_object"]);
  let status = { done: 64, total: 600 };
  e.installStatus = () => status;
  assert.equal(await syncAt(t, at, e), INSTALL_WAKE_MS);
  assert.deepEqual(lines, [{ event: "hosted_install_progress", role: "hosted", done: 64, total: 600 }]);
  status = null;
  e.arm(["get_object"]);
  assert.equal(await syncAt(t, at + 40 * S, e) / S, 30, "installed: back to the base poll");
  assert.equal(lines.length, 1);
  mock.restoreAll();
});

test("an install whose object keeps failing backs off to 5 min and survives an eviction", async (ctx) => {
  mock.method(console, "info", () => {});
  const t = object(); t.o.log = logReplying(503);
  const at = 1_000_000_000_000;
  const e = engine(["get_object"]);
  e.installStatus = () => ({ done: 64, total: 600 });
  const delays = [];
  for (let i = 0; i < 12; i++) {
    e.arm(["get_object"]);
    delays.push(await syncAt(t, at + i * 1_000 * S, e) / S);
  }
  assert.deepEqual(delays, [1, 2, 4, 8, 16, 32, 64, 128, 256, 300, 300, 300]);
  assert.equal(installRetryMs(1000), 300 * S);

  const evicted = object(false, t.data); evicted.o.log = logReplying(503);
  e.arm(["get_object"]);
  assert.equal(await syncAt(evicted, at + 2_000 * S, e) / S, 300, "the delay survives an eviction");
  mock.restoreAll();
});

test("an install only clears its back-off past the point that failed", async (ctx) => {
  mock.method(console, "info", () => {});
  const t = object(); t.o.log = logReplying(503);
  const at = 1_000_000_000_000;
  const e = engine(["get_object"]);
  let status = { done: 64, total: 600 };
  e.installStatus = () => status;
  for (let i = 0; i < 4; i++) { e.arm(["get_object"]); await syncAt(t, at + i * 100 * S, e); }
  assert.deepEqual(t.data.get("service-install-retry"), { failures: 4, done: 64 });

  // Evicted: the install starts over, and catching up must not wait.
  const evicted = object(false, t.data); evicted.o.log = logReplying();
  status = { done: 10, total: 600 };
  e.arm(["get_object"]);
  assert.equal(await syncAt(evicted, at + 1_000 * S, e), INSTALL_WAKE_MS);
  assert.deepEqual(t.data.get("service-install-retry"), { failures: 4, done: 64 }, "catching up is not progress");
  evicted.o.log = logReplying(503);
  status = { done: 64, total: 600 };
  e.arm(["get_object"]);
  assert.equal(await syncAt(evicted, at + 1_100 * S, e) / S, 16, "the same object failing keeps the count");

  evicted.o.log = logReplying();
  status = { done: 128, total: 600 };
  e.arm(["get_object"]);
  assert.equal(await syncAt(evicted, at + 1_200 * S, e), INSTALL_WAKE_MS);
  assert.equal(t.data.has("service-install-retry"), false, "past the failure: cleared and persisted");

  evicted.o.log = logReplying(503);
  status = { done: 192, total: 600 };
  e.arm(["get_object"]);
  assert.equal(await syncAt(evicted, at + 1_300 * S, e), INSTALL_WAKE_MS, "a new failure starts from the first retry");
  status = null;
  evicted.o.log = logReplying();
  e.arm(["get_object"]);
  assert.equal(await syncAt(evicted, at + 1_400 * S, e) / S, 30, "finished: back to the poll");
  assert.equal(t.data.has("service-install-retry"), false, "finished: cleared");
  mock.restoreAll();
});

test("a healthy install never touches back-off storage", async (ctx) => {
  mock.method(console, "info", () => {});
  const t = object(); t.o.log = logReplying();
  const at = 1_000_000_000_000;
  const e = engine(["get_object"]);
  let done = 0;
  e.installStatus = () => done < 300 ? { done, total: 300 } : null;
  for (let i = 0; i < 6; i++) { done += 64; e.arm(["get_object"]); await syncAt(t, at + i * 100 * S, e); }
  assert.equal(t.data.has("service-install-retry"), false);
  mock.restoreAll();
});

test("a refused session logs counts only, whichever role refused it", async () => {
  for (const escrow of [false, true]) {
    const lines = [];
    mock.method(console, "info", (line) => lines.push(JSON.parse(line)));
    const t = object(escrow); t.o.wakeId = "wake-1";
    const closed = [];
    const e = engine();
    Object.assign(e, { hello: () => ({ session: null, response: new Uint8Array(1) }), serving: () => false, installStatus: () => ({ done: 64, total: 600 }) });
    t.o.engine = e;
    await t.o.webSocketMessage({ deserializeAttachment: () => ({ wake: "wake-1" }), send() {}, close: (...c) => closed.push(c) }, new ArrayBuffer(1));
    assert.deepEqual(closed, [[1008, "refused"]]);
    assert.deepEqual(lines, [{ event: "hosted_session_refused", role: escrow ? "escrow" : "hosted", serving: false, installing: true }]);
    mock.restoreAll();
  }
});

test("the install wake stays ahead of any earlier engine deadline", async (ctx) => {
  mock.method(console, "info", () => {});
  const t = object(); t.o.log = logReplying();
  const at = 1_000_000_000_000;
  const e = engine(["get_object"]);
  e.installStatus = () => ({ done: 1, total: 2 });
  e.nextWakeup = () => at + 200;
  assert.equal(await syncAt(t, at, e), 200);
  mock.restoreAll();
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

/** LAB only: the same actor with the LAB deployment var set. */
function labObject(escrow = false, data = new Map()) {
  const t = object(escrow, data);
  t.o.env.LAB = "1";
  t.o.log = logReplying();
  return t;
}
/** A serving engine (LAB checks `serving()` when idle). */
const servingEngine = (...args) => Object.assign(engine(...args), { serving: () => true });

test("LAB: idle syncs back off to 1 h, for both roles", async (ctx) => {
  for (const [escrow, expected] of [[false, [60, 120, 240, 480, 960, 1920, 3600, 3600]], [true, [120, 240, 480, 960, 1920, 3600, 3600]]]) {
    mock.method(console, "info", () => {});
    const t = labObject(escrow);
    let at = 1_000_000_000_000;
    const delays = [];
    for (let i = 0; i < expected.length; i++) { delays.push(await syncAt(t, at, servingEngine(["subscribe"])) / S); at += 61 * 60 * S; }
    assert.deepEqual(delays, expected, escrow ? "escrow" : "hosted");
    mock.restoreAll();
  }
});

test("LAB: answered calls that move nothing do not reset; progress, output, failures and clients still do", async (ctx) => {
  mock.method(console, "info", () => {});
  const t = labObject(true);
  let at = 1_000_000_000_000;
  const delays = [];
  for (let i = 0; i < 4; i++) { delays.push(await syncAt(t, at, servingEngine(["put_object", "subscribe"])) / S); at += 61 * 60 * S; }
  assert.deepEqual(delays, [120, 240, 480, 960], "a refused upload repeats without resetting");
  const cases = {
    "a new remote head (reads)": () => servingEngine(["subscribe", "read"]),
    "output delivered": () => servingEngine(["subscribe"], [{ session: 1, frame: null }]),
    "activity noted": (t) => { t.o.noteActivity(); return servingEngine(["put_object"]); },
  };
  for (const [name, arrange] of Object.entries(cases)) {
    t.o.idleStreak = 4; t.o.idleDecidedAt = 0;
    assert.equal(await syncAt(t, at, arrange(t)) / S, 60, name);
    at += 61 * 60 * S;
  }
  t.o.idleStreak = 4; t.o.idleDecidedAt = 0; t.o.log = logReplying(503);
  assert.equal(await syncAt(t, at, servingEngine(["put_object"])) / S, 60, "a transport failure is retried at the base rate");
  mock.restoreAll();
});

test("LAB: an idle replica that is not serving waits for the poll, not its stall probe", async (ctx) => {
  mock.method(console, "info", () => {});
  const at = 1_000_000_000_000;
  const stalled = (serving) => { const e = engine(["read"]); e.logReply = () => {}; e.serving = () => serving; e.nextWakeup = () => at + S; return e; };
  const t = labObject(true);
  assert.equal(await syncAt(t, at, stalled(false)) / S, 120, "LAB: stalled, idle");
  const serving = labObject(true);
  assert.equal(await syncAt(serving, at, stalled(true)) / S, 1, "LAB: a serving engine's wakeup still wins");
  const prod = object(true); prod.o.log = logReplying();
  assert.equal(await syncAt(prod, at, stalled(false)) / S, 1, "outside LAB the stall probe is unchanged");
  mock.restoreAll();
});
