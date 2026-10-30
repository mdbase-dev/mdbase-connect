import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { PIN_MISMATCH, PIN_RESET_KEY, pinsDigest } from "../src/pin-reset.ts";

// The actual open/sync orchestration with the native engine replaced: `open`
// throws `globalThis.pinTest.open` (if set) and `pinState` maps its native state.
const compiled = await build({ entryPoints: [new URL("../src/worker.ts", import.meta.url).pathname], bundle: true, write: false, format: "esm", platform: "node", plugins: [{
  name: "platform-test", setup(b) {
    b.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: "platform", namespace: "fake" }));
    b.onResolve({ filter: /hosted\.wasm$/ }, () => ({ path: "wasm", namespace: "fake-wasm" }));
    b.onResolve({ filter: /^\.\/engine\.js$/ }, () => ({ path: "engine", namespace: "fake-engine" }));
    b.onLoad({ filter: /.*/, namespace: "fake" }, () => ({ contents: "export class DurableObject {}" }));
    b.onLoad({ filter: /.*/, namespace: "fake-wasm" }, () => ({ contents: "export default new WebAssembly.Module(new Uint8Array([0,97,115,109,1,0,0,0]));" }));
    b.onLoad({ filter: /.*/, namespace: "fake-engine" }, () => ({ contents: `
      export class Engine {
        constructor() { this.logBound = true; globalThis.pinTest.opened++; }
        open() { if (globalThis.pinTest.open) throw new Error(globalThis.pinTest.open); }
        pinState() { return [null, "inconsistent", "rebuilding", "rebuilt"][globalThis.pinTest.state]; }
        appliedHead() { return "cached"; } serving() { return false; } needsReset() { return false; }
        logCalls() { return []; } poll() { return []; } nextWakeup() { return null; } attachmentObject() { return null; }
      }` }));
  },
}] });
const { HostedCollection } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text + "\n//# sourceURL=pin-reset-worker.mjs").toString("base64")}`);

const collection = "0e0e0e0e-0e0e-4e0e-8e0e-0e0e0e0e0e0e";
const pinBytes = Uint8Array.of(0x81, 1, 2, 3);

function object(escrow = false) {
  const data = new Map(); let alarm = null; const dropped = [];
  const storage = {
    async get(key) { return Array.isArray(key) ? new Map(key.filter(k => data.has(k)).map(k => [k, data.get(k)])) : data.get(key); },
    async put(key, value) { data.set(key, value); },
    async delete(key) { return data.delete(key); },
    async getAlarm() { return alarm; },
    async setAlarm(at) { alarm = at; },
    async deleteAlarm() { alarm = null; },
    sql: { exec(query) {
      if (/^SELECT name FROM sqlite_master/.test(query)) return { toArray: () => [{ name: "st_meta" }, { name: "st_log" }] };
      const drop = /^DROP TABLE IF EXISTS "(st_[a-z_]+)"$/.exec(query);
      if (drop) { dropped.push(drop[1]); return { toArray: () => [] }; }
      throw new Error(`unexpected sql ${query}`);
    } },
    transactionSync(f) { return f(); },
  };
  const o = Object.create(HostedCollection.prototype);
  const physical = { equals(other) { return other === physical; } };
  Object.assign(o, { escrow, ctx: { id: physical, storage, getWebSockets: () => [] },
    env: { COLLECTIONS: { idFromName: () => physical } }, logGen: 0, readers: new Map(), lastRefresh: 0 });
  o.custody = { async openSealer() { return { policyPins: pinBytes.slice(), roots: [], signers: [], replicaId: collection, deviceId: collection,
    signSk: new Uint8Array(32), kemSk: new Uint8Array(32), originalGenesis: new Uint8Array(1), genesisSha256: new Uint8Array(32), zeroize() {} }; } };
  o.log = () => ({}); o.token = async () => "t";
  data.set("service-collection", collection);
  return { o, data, dropped, alarm: () => alarm };
}

async function logs(f) {
  const lines = []; const warn = console.warn;
  console.warn = (line) => { lines.push(JSON.parse(line)); };
  try { await f(); } finally { console.warn = warn; }
  return lines.filter(l => l.event === "next_service_pin").map(l => `${l.role}:${l.phase}:${l.collection_tag.length}`);
}

test("a store built under unpinned keys is dropped once, rebuilt from the log, then forgotten", async () => {
  for (const escrow of [false, true]) {
    const role = escrow ? "escrow" : "hosted";
    globalThis.pinTest = { opened: 0, open: PIN_MISMATCH, state: 2 };
    const { o, data, dropped, alarm } = object(escrow);
    data.set("service-open-failures", 5);
    const before = Date.now();
    assert.deepEqual(await logs(() => assert.rejects(o.ready(collection), /reset after pin mismatch/)), [`${role}:pin_reset:24`]);
    assert.deepEqual(dropped, ["st_meta", "st_log"]);
    assert.equal(data.get(PIN_RESET_KEY), await pinsDigest(pinBytes));
    assert.ok(alarm() <= before + 31_000, "the rebuild is retried soon, not after the 16 min backoff");
    // The rebuild opens over the empty cache; the marker is cleared once it reaches the head.
    globalThis.pinTest.open = null;
    await o.ready(collection);
    assert.equal(data.has(PIN_RESET_KEY), true);
    globalThis.pinTest.state = 3;
    assert.deepEqual(await logs(() => o.sync(o.engine)), [`${role}:pin_rebuilt:24`]);
    assert.equal(data.has(PIN_RESET_KEY), false);
    assert.ok(alarm() !== null);
  }
});

test("a log that fails the pins parks the DO with no alarm", async () => {
  // After the drop, the state applied from the log fails the pin check.
  globalThis.pinTest = { opened: 0, open: null, state: 1 };
  const { o, data, alarm } = object();
  data.set(PIN_RESET_KEY, await pinsDigest(pinBytes));
  assert.deepEqual(await logs(async () => { await o.alarm(); }), ["hosted:pin_parked:24"]);
  assert.equal(alarm(), null); assert.equal(o.engine, null);
  // Later wakes in this isolate open nothing and arm nothing.
  const opened = globalThis.pinTest.opened;
  await o.alarm();
  await assert.rejects(o.ready(collection), /hosted_pin_parked/);
  assert.equal(globalThis.pinTest.opened, opened); assert.equal(alarm(), null);

  // A new isolate: the reopened store refuses with the same pins, so it parks again.
  globalThis.pinTest = { opened: 0, open: PIN_MISMATCH, state: 2 };
  const again = object(); again.data.set(PIN_RESET_KEY, await pinsDigest(pinBytes));
  assert.deepEqual(await logs(async () => { await again.o.alarm(); }), ["hosted:pin_parked:24"]);
  assert.deepEqual(again.dropped, []); assert.equal(again.alarm(), null);
});

test("no other open failure or mismatch discards the store", async () => {
  for (const message of [
    'hosted engine open: Mismatch("store was built from a different genesis than the pinned one")',
    'hosted engine open: Mismatch("store belongs to another collection or replica")',
    `${PIN_MISMATCH} `, `x${PIN_MISMATCH}`, 'hosted engine open: Corrupt("policy state: bad")',
  ]) {
    globalThis.pinTest = { opened: 0, open: message, state: 1 };
    const { o, data, dropped, alarm } = object();
    assert.deepEqual(await logs(() => assert.rejects(o.ready(collection))), []);
    assert.deepEqual(dropped, []); assert.equal(data.has(PIN_RESET_KEY), false);
    assert.ok(alarm() !== null, "the ordinary retry alarm stays");
  }
  // Without a drop of its own, a running store is never parked on the pin state.
  globalThis.pinTest = { opened: 0, open: null, state: 1 };
  const { o, alarm } = object();
  await o.ready(collection);
  assert.ok(o.engine); assert.ok(alarm() !== null);
});
