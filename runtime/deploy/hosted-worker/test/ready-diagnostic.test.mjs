import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { readyDiagnostic, READY_STAGES, READY_ERROR_NAMES, READY_ERROR_CODES } from "../src/ready-diagnostic.ts";

// Actual ready()/RUN handler; synthetic native/platform ports, not native proof.
const compiled = await build({ entryPoints: [new URL("../src/worker.ts", import.meta.url).pathname], bundle: true,
  write: false, format: "esm", platform: "node", plugins: [{ name: "ready-ports", setup(b) {
    b.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: "platform", namespace: "platform-test" }));
    b.onLoad({ filter: /.*/, namespace: "platform-test" }, () => ({ contents: "export class DurableObject {}" }));
    b.onResolve({ filter: /hosted\.wasm$/ }, () => ({ path: "hosted.wasm", namespace: "native-test" }));
    b.onLoad({ filter: /.*/, namespace: "native-test" }, () => ({ contents: "export default new WebAssembly.Module(new Uint8Array([0,97,115,109,1,0,0,0]));" }));
    b.onResolve({ filter: /^\.\/engine\.(?:js|ts)$/ }, () => ({ path: "engine", namespace: "engine-test" }));
    b.onLoad({ filter: /.*/, namespace: "engine-test" }, () => ({ contents: `export class Engine {
      constructor(storage) { this.storage=storage; storage.fixture.hit('engine_construct'); }
      open() { this.storage.fixture.hit('engine_open'); }
      openForCppClaim() { this.storage.fixture.hit('engine_cpp_open'); }
      noiseKey() { this.storage.fixture.hit('engine_noise_key'); return true; }
      serving() { this.storage.fixture.hit('timing_snapshot'); return false; }
      needsReset() { this.storage.fixture.hit('engine_reset'); return false; }
    }` }));
  } }] });
const { HostedCollection } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text + "\n//# sourceURL=ready-diagnostic-worker.mjs").toString("base64")}`);
const collection = "10000000-0000-4000-8000-000000000001", hold = "20000000-0000-4000-8000-000000000002";
const token = "synthetic-ready-token".repeat(3);
const request = () => new Request(`https://hosted.test/v1/hosted/migration/run?collection=${collection}`, {
  method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ collection, backup_hold: hold })
});
function fixture(fault, error = new Error("private sentinel"), cleanupError) {
  const o = Object.create(HostedCollection.prototype), events = [];
  const hit = stage => { events.push(stage); if (stage === fault) throw error; };
  const storage = { fixture: { hit },
    get: async key => { hit(key === "service-open-failures" ? "open_retry_read" : "pin_marker_read"); return key === "service-open-failures" ? 1 : undefined; },
    put: async key => { hit(key === "service-collection" ? "service_collection_persist" : key === "service-open-failures" ? "failure_bookkeeping" : key === "collection-mode-device" ? "mode_device_persist" : "run_save"); },
    delete: async () => hit("open_failure_clear"), sync: async () => hit("run_sync"),
    sql: { exec: () => ({ toArray: () => [] }) } };
  const keys = { replicaId: collection, deviceId: collection, roots: [new Uint8Array(32)], signers: [],
    signSk: new Uint8Array(32), kemSk: new Uint8Array(32), noiseSk: new Uint8Array(32), policyPins: new Uint8Array([1]),
    originalGenesis: new Uint8Array([1]), genesisSha256: new Uint8Array(32), publicKeys: { signPk: new Uint8Array(32), kemPk: new Uint8Array(32), noisePk: new Uint8Array(32) },
    zeroize: () => { events.push("custody_zeroize"); if (cleanupError) throw cleanupError; } };
  Object.assign(o, { escrow: false, env: { HOSTED_SERVICE_TOKEN: token }, ctx: { storage }, cppControl: {},
    requireBackground: async () => hit("background_guard"), requirePhysicalCollection: () => hit("physical_collection_guard"),
    migrationConfigured: () => true, custody: { openSealer: async () => { hit("custody_open_sealer"); return keys; } },
    liveAdmission: async () => { hit("live_admission"); return null; }, sync: async () => hit("sync") });
  Object.defineProperty(o, "alarms", { value: { current: true, schedule: async () => hit("open_retry_schedule") } });
  return { o, events, keys, error };
}

test("actual ready/RUN labels synthetic substep failures, cleanup and retained bookkeeping without run save", async () => {
  for (const stage of ["background_guard", "physical_collection_guard", "service_collection_persist", "open_retry_read", "open_retry_schedule",
    "custody_open_sealer", "mode_device_persist", "engine_construct", "engine_cpp_open", "engine_noise_key", "pin_marker_read", "live_admission", "sync", "timing_snapshot", "engine_reset", "open_failure_clear"]) {
    const { o, events } = fixture(stage);
    const response = await o.fetch(request());
    assert.equal(response.status, 500, stage);
    assert.deepEqual(await response.json(), { error: "migration_run_ready_failed", stage, error_name: "Error", error_class: "error", error_code: "unknown" }, stage);
    assert.ok(!events.includes("run_save"), stage);
    if (["mode_device_persist", "engine_construct", "engine_cpp_open", "engine_noise_key"].includes(stage)) assert.ok(events.includes("custody_zeroize"), stage);
  }
  const { o } = fixture("engine_cpp_open", new Error("private open failure"), new TypeError("private cleanup"));
  const response = await o.fetch(request());
  assert.deepEqual(await response.json(), { error: "migration_run_ready_failed", stage: "custody_zeroize", error_name: "TypeError", error_class: "type_error", error_code: "unknown" });
});

test("successful ready keeps the existing side-effect order and cached-engine fast path", async () => {
  const { o, events } = fixture();
  const engine = await o.ready(collection);
  assert.deepEqual(events, ["background_guard", "physical_collection_guard", "service_collection_persist", "open_retry_read",
    "open_retry_schedule", "custody_open_sealer", "background_guard", "physical_collection_guard", "mode_device_persist", "background_guard", "physical_collection_guard", "engine_construct",
    "engine_cpp_open", "engine_noise_key", "custody_zeroize", "pin_marker_read", "live_admission", "background_guard",
    "sync", "timing_snapshot", "engine_reset", "open_failure_clear"]);
  assert.equal(await o.ready(collection), engine);
  assert.equal(events.filter(value => value === "custody_open_sealer").length, 1);
  assert.equal(o.opening, null); assert.equal(o.openingTrace, null);
});

test("same cached-opening failure labels both waiters and rethrows original, not a replacement", async () => {
  const { o, events } = fixture();
  let rejectOpen, opened = 0;
  const pending = new Promise((_, reject) => { rejectOpen = reject; });
  o.custody.openSealer = () => { opened++; return pending; };
  const firstDetails = [], secondDetails = [];
  const first = o.ready(collection, value => firstDetails.push(value));
  for (let i = 0; i < 100 && !opened; i++) await Promise.resolve();
  assert.equal(opened, 1);
  const second = o.ready(collection, value => secondDetails.push(value));
  for (let i = 0; i < 100 && events.filter(value => value === "service_collection_persist").length < 2; i++) await Promise.resolve();
  assert.equal(events.filter(value => value === "service_collection_persist").length, 2);
  // Both waiters share the reservation as well as the exact cached opener.
  await Promise.resolve(); await Promise.resolve();
  assert.equal(events.filter(value => value === "open_retry_schedule").length, 1);
  const original = new Error("private opening error"); rejectOpen(original);
  const results = await Promise.allSettled([first, second]);
  assert.equal(opened, 1);
  for (const result of results) { assert.equal(result.status, "rejected"); assert.equal(result.reason, original); }
  for (const details of [firstDetails, secondDetails]) assert.equal(details[0].stage, "custody_open_sealer");
  assert.equal(o.opening, null); assert.equal(o.openingTrace, null);
});

test("PinParked remains its original class and primitive failures still have a stage", async () => {
  const { o } = fixture(); o.pinParked = true;
  let detail;
  await assert.rejects(o.ready(collection, value => { detail = value; }), error => error.constructor.name === "PinParked");
  assert.equal(detail.stage, "collection_guard"); assert.equal(detail.error_code, "hosted_pin_parked");
  const primitive = fixture("custody_open_sealer", "private primitive");
  const response = await primitive.o.fetch(request());
  assert.deepEqual(await response.json(), { error: "migration_run_ready_failed", stage: "custody_open_sealer", error_name: "other", error_class: "other", error_code: "unknown" });
});

test("finite wire never exposes hostile names, codes, tails, getters, stack or cause", () => {
  assert.equal(READY_STAGES.length, 25); assert.equal(READY_ERROR_NAMES.length, 6); assert.equal(READY_ERROR_CODES.length, 24);
  for (const error of [new Error("postgres://private:secret@host"), Object.assign(new Error("custody_unavailable private tail"), { name: "private name", code: "private_code" }), new Error("__proto__"), "private value"]) {
    const result = readyDiagnostic("private stage", error), text = JSON.stringify(result);
    assert.equal(result.stage, "unknown"); assert.equal(result.error_code, "unknown"); assert.ok(!/private|secret|postgres/.test(text));
  }
  const getters = new Error("private");
  for (const key of ["name", "message", "code"]) Object.defineProperty(getters, key, { get() { throw new Error("private getter"); } });
  assert.deepEqual(readyDiagnostic("engine_cpp_open", getters), { stage: "engine_cpp_open", error_name: "other", error_class: "other", error_code: "unknown" });
  assert.equal(readyDiagnostic("custody_open_sealer", new Error("custody_unavailable")).error_code, "custody_unavailable");
  assert.equal(readyDiagnostic("collection_guard", new Error("collection mismatch")).error_code, "collection_mismatch");
});
