import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { AlarmLifecycle, ALARM_INHIBITOR_KEY } from "../src/alarm-lifecycle.ts";

function storage() {
  const data = new Map(); const calls = []; let alarm = null;
  const s = {
    async get(key) {
      calls.push("get");
      return Array.isArray(key) ? new Map(key.filter(k => data.has(k)).map(k => [k, data.get(k)])) : data.get(key);
    },
    async put(key, value) { calls.push("put"); data.set(key, value); },
    async getAlarm() { calls.push("getAlarm"); return alarm; },
    async setAlarm(at) { calls.push("setAlarm"); alarm = at; },
    async deleteAlarm() { calls.push("deleteAlarm"); alarm = null; },
  };
  return { s, data, calls, alarm: () => alarm };
}

test("inhibition is local before await, durable before cancellation and idempotent", async () => {
  const { s, data, calls, alarm } = storage(); const gate = new AlarmLifecycle(s);
  await s.setAlarm(Date.now() + 60_000); calls.length = 0;
  const pending = gate.inhibit();
  assert.equal(gate.current, false);
  await pending;
  assert.deepEqual(calls, ["get", "put", "deleteAlarm"]);
  assert.equal(data.get(ALARM_INHIBITOR_KEY), true);
  assert.equal(alarm(), null);
  calls.length = 0;
  await gate.inhibit();
  assert.deepEqual(calls, ["get", "deleteAlarm"]);
  assert.equal(await gate.allowed(), false);
});

test("lost cancellation reply/restart retains denial and reconciliation is repeatable", async () => {
  const { s, data, alarm } = storage(); await s.setAlarm(Date.now() + 60_000);
  const cancel = s.deleteAlarm;
  s.deleteAlarm = async () => { await cancel(); throw new Error("lost reply"); };
  await assert.rejects(new AlarmLifecycle(s).inhibit(), /lost reply/);
  assert.equal(data.get(ALARM_INHIBITOR_KEY), true);
  assert.equal(alarm(), null);
  const reopened = new AlarmLifecycle(s);
  assert.equal(await reopened.allowed(), false);
  s.deleteAlarm = cancel;
  await reopened.inhibit(); await reopened.inhibit();
  assert.equal(alarm(), null);
});

test("cancellation failure leaves the scheduled alarm inert across restart", async () => {
  const { s, data, alarm } = storage(); const at = Date.now() + 60_000;
  await s.setAlarm(at);
  s.deleteAlarm = async () => { throw new Error("cancel failed"); };
  await assert.rejects(new AlarmLifecycle(s).inhibit(), /cancel failed/);
  assert.equal(data.get(ALARM_INHIBITOR_KEY), true);
  assert.equal(alarm(), at);
  const restarted = new AlarmLifecycle(s);
  assert.equal(await restarted.allowed(), false);
  await restarted.schedule(at + 60_000, () => true);
  assert.equal(alarm(), at);
});

test("failed persistence never cancels the alarm and locally refuses later scheduling", async () => {
  const { s, calls, alarm } = storage(); const at = Date.now() + 60_000;
  await s.setAlarm(at); calls.length = 0;
  s.put = async () => { calls.push("failed put"); throw new Error("write failed"); };
  const gate = new AlarmLifecycle(s);
  await assert.rejects(gate.inhibit(), /write failed/);
  assert.equal(gate.current, false);
  assert.equal(calls.includes("deleteAlarm"), false);
  await gate.schedule(at + 1, () => true);
  assert.equal(alarm(), at);
});

test("unknown storage state denies without scheduling and fences local continuations", async () => {
  const { s, calls } = storage();
  s.get = async () => { throw new Error("private backend detail"); };
  const gate = new AlarmLifecycle(s);
  await assert.rejects(gate.schedule(Date.now() + 60_000, () => true), /^Error: alarm lifecycle unavailable$/);
  assert.equal(gate.current, false);
  assert.equal(await gate.allowed(), false);
  assert.deepEqual(calls, []);
});

test("all present values deny and are preserved verbatim", async () => {
  for (const marker of [true, false, null, undefined, 0, "bad", { version: 99 }]) {
    const { s, data, calls } = storage(); data.set(ALARM_INHIBITOR_KEY, marker);
    const gate = new AlarmLifecycle(s);
    assert.equal(await gate.allowed(), false);
    await gate.inhibit();
    assert.equal(data.get(ALARM_INHIBITOR_KEY), marker);
    assert.equal(calls.includes("put"), false);
  }
});

test("inhibition never removes migration, locator, identity or denial inventory", async () => {
  const { s, data } = storage();
  const inventory = new Map([
    ["mig_checkpoint", { original: 1 }], ["mig_claim", "claim"],
    ["mig_place", "place"], ["mig_deferred", "deferred"], ["mig_bucket_index", "bucket"],
    ["hosted-replica-id", "replica"], ["service-collection", "collection"],
    ["escrow-collection", "legacy"], ["hosted_upload_locator_v1", "untrusted"],
    ["denial", { originalTuple: "unchanged" }], ["MDBK", "opaque"],
  ]);
  for (const [k, v] of inventory) data.set(k, v);
  await new AlarmLifecycle(s).inhibit();
  for (const [k, v] of inventory) assert.equal(data.get(k), v);
  assert.equal(data.size, inventory.size + 1);
});

test("legacy absence preserves the earlier polling deadline", async () => {
  const { s, alarm } = storage(); const earlier = Date.now() + 5_000;
  await s.setAlarm(earlier);
  const gate = new AlarmLifecycle(s);
  assert.equal(await gate.allowed(), true);
  for (let i = 0; i < 3; i++) await gate.schedule(Date.now() + 60_000, () => true);
  assert.equal(alarm(), earlier);
});

test("a late absent read cannot overwrite concurrent local inhibition", async () => {
  const { s, calls } = storage(); const ordinaryGet = s.get;
  let resolve;
  s.get = () => { s.get = ordinaryGet; return new Promise(r => { resolve = r; }); };
  const gate = new AlarmLifecycle(s);
  const pending = gate.schedule(Date.now() + 60_000, () => true);
  await gate.inhibit(); resolve(new Map()); await pending;
  assert.equal(gate.current, false);
  assert.equal(calls.includes("setAlarm"), false);
});

test("inhibition or engine replacement during getAlarm cannot install an alarm", async () => {
  for (const inhibit of [false, true]) {
    const { s, calls, alarm } = storage(); const gate = new AlarmLifecycle(s); let current = true;
    s.getAlarm = async () => {
      if (inhibit) await gate.inhibit(); else current = false;
      return null;
    };
    await gate.schedule(Date.now() + 60_000, () => current);
    assert.equal(alarm(), null);
    assert.equal(calls.includes("setAlarm"), false);
  }
});

test("invalid deadlines have no storage effects", async () => {
  const { s, calls } = storage(); const gate = new AlarmLifecycle(s);
  for (const at of [NaN, Infinity, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(gate.schedule(at, () => true), /invalid alarm deadline/);
  }
  assert.deepEqual(calls, []);
});

// Exercise the actual adapter methods. Only platform/WASM imports are replaced;
// this is orchestration coverage, not a native drain/currentness certificate.
const compiled = await build({ entryPoints: [new URL("../src/worker.ts", import.meta.url).pathname], bundle: true, write: false, format: "esm", platform: "node", plugins: [{
  name: "platform-test", setup(b) {
    b.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: "platform", namespace: "fake" }));
    b.onResolve({ filter: /hosted\.wasm$/ }, () => ({ path: "wasm", namespace: "fake-wasm" }));
    b.onLoad({ filter: /.*/, namespace: "fake" }, () => ({ contents: "export class DurableObject {}" }));
    b.onLoad({ filter: /.*/, namespace: "fake-wasm" }, () => ({ contents: "export default new WebAssembly.Module(new Uint8Array([0,97,115,109,1,0,0,0]));" }));
  },
}] });
const { HostedCollection } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString("base64")}`);
const collection = "0e0e0e0e-0e0e-4e0e-8e0e-0e0e0e0e0e0e";
function object(escrow) {
  const stored = storage(); const o = Object.create(HostedCollection.prototype);
  Object.assign(o, { escrow, ctx: { storage: stored.s, getWebSockets: () => [] }, env: {},
    logGen: 0, readers: new Map(), lastRefresh: 0 });
  return { o, ...stored };
}

test("restored inhibited identities and late alarm delivery never open custody in either role", async () => {
  for (const escrow of [false, true]) {
    const { o, data, s, calls, alarm } = object(escrow);
    data.set("service-collection", collection); data.set("escrow-collection", collection);
    data.set(ALARM_INHIBITOR_KEY, true); await s.setAlarm(Date.now() + 60_000); calls.length = 0;
    o.custody = { openSealer() { assert.fail("custody opened"); } };
    for (let i = 0; i < 2; i++) await o.alarm();
    await assert.rejects(o.ready(collection), /hosted_alarm_inhibited/);
    assert.equal(alarm(), null);
    assert.equal(calls.includes("put"), false);
    assert.equal(calls.includes("setAlarm"), false);
    assert.equal(data.get("service-collection"), collection);
    assert.equal(data.get("escrow-collection"), collection);
  }
});

test("warm inhibited alarms and sync cannot tick, refresh, pump or deliver", async () => {
  for (const escrow of [false, true]) {
    const { o, data } = object(escrow); data.set(ALARM_INHIBITOR_KEY, false);
    const engine = new Proxy({}, { get() { assert.fail("native effect attempted"); } });
    Object.assign(o, { engine, collection });
    o.log = () => assert.fail("transport attempted");
    await o.alarm(); await o.sync(engine);
  }
});

test("alarm rechecks inhibition after the cold-open await", async () => {
  for (const escrow of [false, true]) {
    const { o, data } = object(escrow); data.set("service-collection", collection);
    o.ready = async () => {
      await o.alarms.inhibit();
      o.collection = collection;
      o.engine = new Proxy({}, { get() { assert.fail("late native effect"); } });
    };
    await o.alarm();
  }
});

test("inhibition during custody open wipes returned keys before engine construction", async () => {
  for (const escrow of [false, true]) {
    const { o, data } = object(escrow); let wiped = 0;
    o.custody = { async openSealer() {
      await o.alarms.inhibit();
      return { zeroize() { wiped++; } };
    } };
    await assert.rejects(o.ready(collection), /hosted_alarm_inhibited/);
    assert.equal(wiped, 1);
    assert.equal(o.engine ?? null, null);
    assert.equal(o.opening, null);
    assert.equal(data.get(ALARM_INHIBITOR_KEY), true);
  }
});

test("real sync cannot reschedule after inhibition during alarm storage await", async () => {
  for (const escrow of [false, true]) {
    const { o, s, alarm } = object(escrow);
    const engine = { logBound: true, logCalls: () => [], poll: () => [], nextWakeup: () => null, attachmentObject: () => null };
    o.engine = engine; o.log = () => ({});
    s.getAlarm = async () => { await o.alarms.inhibit(); return null; };
    await o.sync(engine);
    assert.equal(alarm(), null);
  }
});
