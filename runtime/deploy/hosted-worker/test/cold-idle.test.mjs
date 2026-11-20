// Hermetic orchestration regression: real ready/alarm/sync, AlarmLifecycle and
// CP custody/token cache. Only native/platform/network ports are synthetic.
import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { encode } from "../../../packages/sdk/src/cbor.ts";
import { cpCustody } from "../src/cp-custody.ts";

const collection = "10000000-0000-4000-8000-000000000001";
const device = "20000000-0000-4000-8000-000000000002";
const unfinishedKey = "service-open-unfinished";
const S = 1000, start = 1_000_000_000_000;
const head = [...encode(new Map([[2, "subscribe"], [3, new Map()]]))];
const read = [...encode(new Map([[2, "read"], [3, new Map()]]))];
const compiled = await build({ entryPoints: [new URL("../src/worker.ts", import.meta.url).pathname], bundle: true,
  write: false, format: "esm", platform: "node", plugins: [{ name: "cold-idle-ports", setup(b) {
    b.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: "platform", namespace: "fixture" }));
    b.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: "export class DurableObject {}" }));
    b.onResolve({ filter: /hosted\.wasm$/ }, () => ({ path: "wasm", namespace: "native-module" }));
    b.onLoad({ filter: /.*/, namespace: "native-module" }, () => ({ contents: "export default new WebAssembly.Module(new Uint8Array([0,97,115,109,1,0,0,0]));" }));
    b.onResolve({ filter: /^\.\/engine\.(js|ts)$/ }, () => ({ path: "engine", namespace: "native-port" }));
    b.onLoad({ filter: /.*/, namespace: "native-port" }, () => ({ contents: `export class Engine {
      constructor(storage) { this.f = storage.fixture; this.f.constructs++; this.logBound = false; this.refresh(); }
      open() { this.queued.push({ id: 2, frame: new Uint8Array(${JSON.stringify(read)}) }); }
      noiseKey() { return false; } serving() { return this.f.serving; }
      cacheRecovery() { if (this.f.endFail) throw new Error("synthetic post-sync failure"); return null; }
      appliedHead() { return String(this.f.applied); }
      refresh() { this.queued = [{ id: 1, frame: new Uint8Array(${JSON.stringify(head)}) }]; }
      tick() {} installStatus() { return null; } snapshotDeclined() { return false; } nextWakeup() { return this.f.deadline; } attachmentObject() { return null; } poll() { return []; }
      logBind() { this.logBound = true; return true; } signRpc() { return new Uint8Array(64); }
      logCalls() { const q = this.queued; this.queued = []; return q; }
      logReply(id) { if (id === 2 && this.f.newHead) { this.f.applied++; this.f.newHead = false; } } logFailed() {}
    }` }));
  } }] });
const { HostedCollection } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text + "\n//# sourceURL=cold-idle-worker.mjs").toString("base64")}`);

function state() {
  const data = new Map([["service-collection", collection]]);
  const f = { applied: 5, newHead: false, serving: true, endFail: false, deadline: null, constructs: 0, mints: [], fail: false, duringOpen: null, alarms: [] };
  let alarm = null;
  const storage = { fixture: f,
    get: async k => Array.isArray(k) ? new Map(k.filter(x => data.has(x)).map(x => [x, data.get(x)])) : data.get(k),
    put: async (k, v) => { data.set(k, v); }, delete: async k => data.delete(k),
    sync: async () => {},
    getAlarm: async () => alarm, setAlarm: async at => { f.alarms.push(at); alarm = at; }, deleteAlarm: async () => { alarm = null; },
  };
  return { data, f, storage, alarm: () => alarm, fire: () => { alarm = null; } };
}
function actor(t, escrow) {
  const bytes = n => new Uint8Array(32).fill(n);
  const r = { kind: escrow ? "escrow" : "hosted", deviceId: device, signPk: bytes(1), kemPk: bytes(2), noisePk: bytes(3),
    wrappedKeys: new Uint8Array([1]), kmsKeyArn: "synthetic", genesis: { seq: 1, item: new Uint8Array([1]), hash: bytes(4) } };
  const custody = cpCustody({ kind: r.kind, roots: [bytes(5)], policyPins: new Uint8Array([1]), verifyOriginal: () => true,
    control: { serviceDevice: async () => {
      if (t.f.fail) throw new Error("synthetic open failure");
      if (t.f.duringOpen) { const fn = t.f.duringOpen; t.f.duringOpen = null; await fn(); }
      return r;
    }, logToken: async () => { t.f.mints.push(Date.now()); return { token: "synthetic-held-bearer", expiresAt: Date.now() + 15 * 60 * S }; } },
    unwrap: async () => new Uint8Array(96).fill(1), derive: () => ({ signPk: r.signPk, kemPk: r.kemPk, noisePk: r.noisePk }) });
  const o = Object.create(HostedCollection.prototype);
  const physical = { equals: x => x === physical };
  Object.assign(o, { escrow, env: { COLLECTIONS: { idFromName: () => physical } },
    ctx: { id: physical, storage: t.storage, getWebSockets: () => [] }, custody, logGen: 0,
    readers: new Map(), attachmentWaiters: new Map(), staleAppends: { reserve: () => true, settle() {} }, lastRefresh: 0 });
  o.token = () => custody.logToken(collection, new AbortController().signal);
  o.log = () => ({ fetch: async url => url.endsWith("/v1/nonce") ? new Response("ab".repeat(32)) : new Response(new Uint8Array([1])) });
  return o;
}
function clock(ctx) {
  let now = start;
  ctx.mock.method(Date, "now", () => now);
  ctx.mock.method(Math, "random", () => 0);
  return at => { now = at; };
}

test("actual cold alarm retires its open retry and reaches the idle cap across evictions, both roles", async ctx => {
  const set = clock(ctx);
  for (const escrow of [false, true]) {
    const t = state(); let at = start; const delays = [];
    for (let i = 0; i < 8; i++) {
      set(at); t.fire();
      await actor(t, escrow).alarm(); // New object/custody RAM; same durable storage.
      delays.push((t.alarm() - at) / S);
      assert.equal(t.data.get("service-idle-streak"), Math.min(i + 1, 7));
      at = t.alarm();
    }
    assert.deepEqual(delays, escrow ? [120, 240, 480, 960, 1920, 3600, 3600, 3600] : [60, 120, 240, 480, 960, 1920, 3600, 3600]);
    assert.equal(t.f.constructs, 8); assert.equal(t.f.mints.length, 8, "no credential survives eviction");
    assert.deepEqual([...t.data.keys()].sort(), ["collection-mode-device", "service-collection", "service-idle-streak"]);
    assert.ok(!JSON.stringify([...t.data]).includes("synthetic-held-bearer"));
  }
});

test("a warm idle device reuses its token until the existing TTL-minus-60s boundary", async ctx => {
  const set = clock(ctx);
  for (const escrow of [false, true]) {
    const t = state(); const o = actor(t, escrow);
    for (const seconds of [0, 30, 120, 600, 839]) { set(start + seconds * S); t.fire(); await o.alarm(); }
    assert.deepEqual(t.f.mints, [start]);
    set(start + 840 * S); t.fire(); o.engine.refresh(); await o.alarm();
    assert.deepEqual(t.f.mints, [start, start + 840 * S]);
    assert.equal(t.f.constructs, 1);
  }
});

test("an incomplete native replay is still activity even before applied progress changes", async ctx => {
  const set = clock(ctx); set(start);
  for (const escrow of [false, true]) {
    const t = state(); t.data.set("service-idle-streak", 5); t.f.serving = false;
    await actor(t, escrow).alarm();
    assert.equal(t.data.has("service-idle-streak"), false);
    assert.equal(t.alarm(), start + (escrow ? 60 : 30) * S);
  }
});

test("new native progress during a cold read resets the persisted idle streak", async ctx => {
  const set = clock(ctx); set(start);
  for (const escrow of [false, true]) {
    const t = state(); t.data.set("service-idle-streak", 5); t.f.newHead = true;
    await actor(t, escrow).alarm();
    assert.equal(t.data.has("service-idle-streak"), false);
    assert.equal(t.alarm(), start + (escrow ? 60 : 30) * S);
  }
});

test("caught custody failures clear unfinished attempts and keep retrying at capped backoff", async ctx => {
  const set = clock(ctx); set(start);
  const t = state(); t.f.fail = true;
  t.data.set(unfinishedKey, { version: "", count: 1 });
  for (const [index, seconds] of [60, 60, 120, 240, 480, 960, 960].entries()) {
    t.fire();
    await assert.rejects(actor(t, false).alarm(), /synthetic open failure/);
    assert.equal(t.alarm(), start + seconds * S);
    assert.equal(t.data.has(unfinishedKey), false);
    assert.equal(t.data.get("service-open-failures"), index + 1);
  }
  assert.equal(t.f.mints.length, 0);
});

test("interrupted opens back off, then park until a different version opens", async ctx => {
  clock(ctx);
  const warn = ctx.mock.method(console, "warn", () => {});
  for (const escrow of [false, true]) {
    const t = state();
    for (const [index, seconds] of [30, 60, 120].entries()) {
      const o = actor(t, escrow), entered = Promise.withResolvers();
      o.env.CF_VERSION_METADATA = { id: "one" };
      // Abandon this isolate in open-time sync: neither catch nor finally runs.
      o.sync = () => { entered.resolve(); return new Promise(() => {}); };
      t.fire(); await Promise.race([entered.promise, o.alarm()]);
      assert.deepEqual(t.data.get(unfinishedKey), { version: "one", count: index + 1 });
      assert.equal(t.alarm(), start + seconds * S);
    }
    const parked = actor(t, escrow);
    parked.env.CF_VERSION_METADATA = { id: "one" };
    parked.custody.openSealer = () => assert.fail("parked actor opened custody");
    const priorWarnings = warn.mock.callCount();
    await parked.alarm();
    assert.equal(warn.mock.callCount(), priorWarnings + 1);
    assert.deepEqual(JSON.parse(warn.mock.calls.at(-1).arguments[0]),
      { event: "hosted_open_parked", role: escrow ? "escrow" : "hosted", unfinished: 3, version: "one" });
    assert.equal(t.alarm(), null); assert.equal(t.f.constructs, 3);
    assert.deepEqual(t.data.get(unfinishedKey), { version: "one", count: 3 });
    assert.equal(t.data.has("service-open-failures"), false);
    const token = "s".repeat(40); parked.env.HOSTED_SERVICE_TOKEN = token;
    const post = (path, body) => new Request(`https://w.test/v1/hosted/${path}?collection=${collection}`, {
      method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
    const requests = [post("activate", { collection }), post("collection-mode/ready", { collection, device, epoch: "1", challenge: "a".repeat(64) })];
    if (!escrow) requests.push(new Request(`https://w.test/app?collection=${collection}`, { headers: { upgrade: "websocket" } }));
    for (const request of requests) assert.equal((await parked.fetch(request)).status, 503);
    assert.equal(t.alarm(), null); assert.equal(t.f.constructs, 3);
    const fresh = actor(t, escrow); fresh.env.CF_VERSION_METADATA = { id: "two" };
    t.f.duringOpen = () => {
      assert.deepEqual(t.data.get(unfinishedKey), { version: "two", count: 1 });
      assert.equal(t.alarm(), start + 30 * S);
    };
    await fresh.ready(collection);
    assert.equal(t.data.has(unfinishedKey), false);
  }
});

test("a failing post-sync native open check still has the original failure retry", async ctx => {
  const set = clock(ctx); set(start);
  for (const escrow of [false, true]) {
    const t = state(); t.f.endFail = true; t.f.deadline = start + S;
    await assert.rejects(actor(t, escrow).alarm(), /synthetic post-sync failure/);
    assert.equal(t.alarm(), start + 30 * S);
  }
});

test("successful cold open still honors native deadlines and a different pending alarm", async ctx => {
  const set = clock(ctx); set(start);
  for (const native of [true, false]) {
    const t = state();
    if (native) t.f.deadline = start + 5 * S;
    else t.f.duringOpen = () => t.storage.setAlarm(start + 5 * S);
    await actor(t, false).alarm();
    assert.equal(t.alarm(), start + 5 * S);
  }
});

test("concurrent ready callers share one opener and its retry, not two reservations", async ctx => {
  const set = clock(ctx); set(start);
  const t = state(), o = actor(t, false);
  const engines = await Promise.all([o.ready(collection), o.ready(collection)]);
  assert.equal(engines[0], engines[1]); assert.equal(t.f.constructs, 1);
  assert.equal(t.f.alarms.filter(at => at === start + 30 * S).length, 1);
  assert.equal(t.alarm(), start + 60 * S);
});
