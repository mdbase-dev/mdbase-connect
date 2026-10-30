// Erasure after migration, at the hosted actor: once custody says the collection
// is permanently not served (CP holds no current service device after a
// collection/account deletion or leaving sync, or this deployment's KMS does not
// serve it), the Durable Object stops being a background actor for it. It cancels
// its alarm instead of re-arming a backed-off retry, drops the live engine and its
// sessions, and drops the rebuildable st_* cache. Transient refusals keep the
// existing retry behaviour. Same harness as activation.test.mjs: the real Worker
// methods with only platform/WASM imports replaced.
import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

const collection = "0e0e0e0e-0e0e-4e0e-8e0e-0e0e0e0e0e0e";
const PERMANENT = ["custody_collection_gone", "custody_collection_not_allowed"];
const TRANSIENT = ["custody_unavailable", "offline"];

const compiled = await build({ entryPoints: [new URL("../src/worker.ts", import.meta.url).pathname], bundle: true, write: false, format: "esm", platform: "node", plugins: [{
  name: "platform-test", setup(b) {
    b.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: "platform", namespace: "fake" }));
    b.onLoad({ filter: /.*/, namespace: "fake" }, () => ({ contents: "export class DurableObject {}" }));
    b.onResolve({ filter: /hosted\.wasm$/ }, () => ({ path: "hosted.wasm", namespace: "synthetic-wasm" }));
    b.onLoad({ filter: /hosted\.wasm$/ }, () => ({ contents: "export default new WebAssembly.Module(new Uint8Array([0,97,115,109,1,0,0,0]));" }));
  },
}] });
const { HostedCollection } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text + "\n//# sourceURL=custody-verdict-worker.mjs").toString("base64")}`);

function object(escrow = false) {
  const data = new Map(); let alarm = null;
  // The st_* store cache plus a non-cache table that must survive (migration ledger).
  const tables = new Set(["st_records", "st_meta", "migration_run"]);
  const sql = { exec(query) {
    if (query.startsWith("SELECT name FROM sqlite_master")) return { toArray: () => [...tables].filter(n => n.startsWith("st_")).map(name => ({ name })) };
    const drop = /^DROP TABLE IF EXISTS "([^"]+)"$/.exec(query);
    if (drop) { tables.delete(drop[1]); return { toArray: () => [] }; }
    throw new Error(`unexpected SQL: ${query}`);
  } };
  const storage = {
    get: async (k) => Array.isArray(k) ? new Map(k.filter(key => data.has(key)).map(key => [key, data.get(key)])) : data.get(k),
    put: async (k, v) => { data.set(k, v); }, delete: async (k) => data.delete(k),
    getAlarm: async () => alarm, setAlarm: async (at) => { alarm = at; }, deleteAlarm: async () => { alarm = null; },
    sql, transactionSync: (fn) => fn(),
  };
  const o = Object.create(HostedCollection.prototype);
  const physical = { equals: expected => expected === collection };
  Object.assign(o, { escrow, ctx: { id: physical, storage, getWebSockets: () => [] }, env: { COLLECTIONS: { idFromName: name => name } },
    logGen: 0, readers: new Map(), staleAppends: {}, lastRefresh: 0, attachmentWaiters: new Map() });
  // Bounded custody retry for the test clock (production budget is 45 s).
  o.custodyRetryOptions = () => ({ budgetMs: 1 });
  return { o, data, tables, alarm: () => alarm, setAlarm: (at) => { alarm = at; } };
}

function coldWake(escrow, code) {
  const t = object(escrow); let opens = 0;
  t.data.set("service-collection", collection);
  t.o.custody = { async openSealer(id) { assert.equal(id, collection); opens++; throw new Error(code); } };
  return { ...t, opens: () => opens };
}

function warmEngine(t) {
  const calls = []; let wiped = 0;
  const engine = { appliedHead: () => "cached", logBound: false, logCalls: () => [], poll: () => [], nextWakeup: () => null, attachmentObject: () => null,
    tick() { calls.push("tick"); }, refresh() { calls.push("refresh"); } };
  Object.assign(t.o, { engine, collection, live: { admitted: true }, log: () => ({}) });
  t.o.readers.set("reader", { wipe() { wiped++; } });
  t.data.set("service-collection", collection);
  return { engine, calls, wiped: () => wiped };
}

test("permanent custody verdict on a cold wake cancels the alarm instead of re-arming a retry", async () => {
  for (const escrow of [false, true]) for (const code of PERMANENT) {
    const t = coldWake(escrow, code);
    t.data.set("service-open-failures", 4); // a long-refused collection, as on LAB
    // The firing alarm has already been consumed by the platform.
    await t.o.alarm(); // returns normally: no platform alarm retry either
    assert.equal(t.alarm(), null, `${code}: no wake may remain armed for a refused collection`);
    assert.equal(t.opens(), 1, `${code}: a verdict is not retried within the wake`);
    assert.equal(t.data.has("service-open-failures"), false);
    assert.equal(t.o.engine ?? null, null);
    assert.deepEqual([...t.tables], ["migration_run"], `${code}: st_* cache dropped, ledger kept`);
  }
});

test("transient custody refusals on a cold wake keep the backed-off retry alarm and the cache", async () => {
  for (const escrow of [false, true]) for (const code of TRANSIENT) {
    const t = coldWake(escrow, code);
    const before = Date.now();
    await assert.rejects(t.o.alarm(), new RegExp(code));
    assert.ok(t.alarm() >= before + 30_000, `${code}: retry alarm armed`);
    assert.equal(t.data.get("service-open-failures"), 1);
    assert.deepEqual([...t.tables].sort(), ["migration_run", "st_meta", "st_records"]);
  }
});

test("deletion after open: the warm engine's next token verdict retires the actor and nothing reopens it on a timer", async () => {
  for (const escrow of [false, true]) {
    const t = object(escrow); const w = warmEngine(t);
    t.setAlarm(Date.now() + 30_000); // armed by the last successful sync
    let tokens = 0;
    t.o.token = async () => { tokens++; throw new Error("custody_collection_gone"); };
    const generation = t.o.logGen;
    await t.o.alarm();
    assert.deepEqual(w.calls, ["tick", "refresh"]);
    assert.equal(tokens, 1, "no log call goes out without a token");
    assert.equal(t.o.engine, null, "the engine stops serving");
    assert.equal(t.o.live, null);
    assert.equal(t.o.logGen, generation + 1, "in-flight continuations are fenced");
    assert.equal(w.wiped(), 1); assert.equal(t.o.readers.size, 0);
    assert.equal(t.alarm(), null, "no further wake");
    assert.deepEqual([...t.tables], ["migration_run"]);
    // A later request (app connect, LAB status, activation) asks custody again:
    // it is refused, no engine is served from the dropped cache, and still no alarm.
    let opens = 0;
    t.o.custody = { async openSealer() { opens++; throw new Error("custody_collection_gone"); } };
    await assert.rejects(t.o.ready(collection), /custody_collection_gone/);
    assert.equal(opens, 1); assert.equal(t.o.engine, null); assert.equal(t.alarm(), null);
  }
});

test("a transient token refusal on a warm engine keeps the engine, cache and poll alarm", async () => {
  for (const escrow of [false, true]) {
    const t = object(escrow); const w = warmEngine(t);
    const armed = Date.now() + 30_000; t.setAlarm(armed);
    t.o.token = async () => { throw new Error("custody_unavailable"); };
    await assert.rejects(t.o.alarm(), /custody_unavailable/);
    assert.equal(t.o.engine, w.engine);
    assert.equal(w.wiped(), 0);
    assert.equal(t.alarm(), armed);
    assert.deepEqual([...t.tables].sort(), ["migration_run", "st_meta", "st_records"]);
  }
});

test("re-activation after a verdict re-evaluates custody and re-arms only on success", async () => {
  const t = coldWake(false, "custody_collection_gone");
  await t.o.alarm();
  assert.equal(t.alarm(), null);
  // CP re-enables the collection and activates it: the open retry alarm is armed
  // before custody (as for any first open); custody now answers transiently.
  t.o.custody = { async openSealer() { throw new Error("custody_unavailable"); } };
  await assert.rejects(t.o.ready(collection), /custody_unavailable/);
  assert.ok(t.alarm() > Date.now(), "a re-activated collection is retried again");
  assert.equal(t.data.get("service-open-failures"), 1, "backoff restarts from zero after a verdict");
});

test("CP activation of a refused collection gets a definite 409 answer, not an uncaught 500", async () => {
  const token = "s".repeat(40);
  const activate = () => new Request(`https://w.test/v1/hosted/activate?collection=${collection}`, {
    method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ collection }) });
  for (const code of PERMANENT) {
    const t = object(false);
    t.o.env = { ...t.o.env, HOSTED_SERVICE_TOKEN: token };
    t.o.ready = async (id) => { assert.equal(id, collection); throw new Error(code); };
    const response = await t.o.fetch(activate());
    assert.equal(response.status, 409, `${code}: an answer, not a 5xx the CP would log as a failure`);
    assert.deepEqual(await response.json(), { error: code });
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
  // A transient refusal is still a failure the CP retries.
  const t = object(false);
  t.o.env = { ...t.o.env, HOSTED_SERVICE_TOKEN: token };
  t.o.ready = async () => { throw new Error("custody_unavailable"); };
  await assert.rejects(t.o.fetch(activate()), /custody_unavailable/);
});

test("activation of a warm engine whose fresh token carries a verdict answers 409 and retires the actor", async () => {
  const token = "s".repeat(40);
  const activate = () => new Request(`https://w.test/v1/hosted/activate?collection=${collection}`, {
    method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ collection }) });
  for (const code of PERMANENT) {
    const t = object(false); const w = warmEngine(t);
    t.o.env = { ...t.o.env, HOSTED_SERVICE_TOKEN: token };
    t.setAlarm(Date.now() + 30_000);
    let tokens = 0;
    t.o.token = async () => { tokens++; throw new Error(code); };
    const response = await t.o.fetch(activate());
    assert.equal(response.status, 409, `${code}: a definite answer, not a 5xx`);
    assert.deepEqual(await response.json(), { error: code });
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(tokens, 1);
    assert.equal(t.o.engine, null, "the engine stops serving");
    assert.equal(w.wiped(), 1);
    assert.equal(t.alarm(), null, "no further wake");
  }
  // A transient token refusal is still a failure the CP retries; the engine stays.
  const t = object(false); const w = warmEngine(t);
  t.o.env = { ...t.o.env, HOSTED_SERVICE_TOKEN: token };
  t.o.token = async () => { throw new Error("custody_unavailable"); };
  await assert.rejects(t.o.fetch(activate()), /custody_unavailable/);
  assert.equal(t.o.engine, w.engine);
});
