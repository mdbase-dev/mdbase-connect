import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

// Actual HTTP handler, synthetic platform/native ports only: no custody or native proof.
const compiled = await build({ entryPoints: [new URL("../src/worker.ts", import.meta.url).pathname], bundle: true,
  write: false, format: "esm", platform: "node", plugins: [{ name: "platform-test", setup(b) {
    b.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: "platform", namespace: "fake" }));
    b.onLoad({ filter: /.*/, namespace: "fake" }, () => ({ contents: "export class DurableObject {}" }));
    b.onResolve({ filter: /hosted\.wasm$/ }, () => ({ path: "hosted.wasm", namespace: "native-test" }));
    b.onLoad({ filter: /hosted\.wasm$/, namespace: "native-test" }, () => ({ contents: "export default new WebAssembly.Module(new Uint8Array([0,97,115,109,1,0,0,0]));" }));
  } }] });
const { HostedCollection } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString("base64")}`);
const collection = "10000000-0000-4000-8000-000000000001";
const hold = "20000000-0000-4000-8000-000000000002";
const token = "synthetic-service-token".repeat(3);
const request = (path, body, auth = token) => new Request(`https://hosted.test/v1/hosted/migration/${path}?collection=${collection}`, {
  method: "POST", headers: { authorization: `Bearer ${auth}` }, body: JSON.stringify(body)
});
function fixture(error) {
  const o = Object.create(HostedCollection.prototype), calls = [], stored = new Map();
  Object.assign(o, { escrow: false, env: { HOSTED_SERVICE_TOKEN: token }, migrationConfigured: () => true,
    ready: async () => { calls.push("ready"); if (error !== undefined) throw error; return {}; },
    requirePhysicalCollection: () => {},
    ctx: { storage: { get: async key => { calls.push("get"); return stored.get(key); },
      put: async (key, value) => { calls.push("put"); stored.set(key, value); },
      sync: async () => { calls.push("sync"); }, sql: { exec: () => ({ toArray: () => [] }) } } }
  });
  Object.defineProperty(o, "alarms", { value: { current: true, schedule: async () => { calls.push("alarm"); } } });
  return { o, calls, stored };
}

test("ready/engine-open exceptions return a finite typed 500 before any run save or scheduling", async () => {
  for (const [error, errorClass] of [[new Error("postgres://owner:secret@host"), "error"],
    [new TypeError("private credential"), "type_error"], [new RangeError("private bytes"), "range_error"],
    [new DOMException("private timeout", "TimeoutError"), "timeout_error"],
    [new DOMException("private abort", "AbortError"), "abort_error"],
    [Object.assign(new Error("private message"), { name: "private name" }), "other"], ["secret", "other"]]) {
    const { o, calls, stored } = fixture(error);
    const result = await o.fetch(request("run", { collection, backup_hold: hold }));
    assert.equal(result.status, 500);
    assert.equal(result.headers.get("cache-control"), "no-store");
    const errorName = { error: "Error", type_error: "TypeError", range_error: "RangeError", timeout_error: "TimeoutError", abort_error: "AbortError", other: "other" }[errorClass];
    assert.deepEqual(await result.json(), { error: "migration_run_ready_failed", error_class: errorClass,
      stage: "unknown", error_name: errorName, error_code: "unknown" });
    assert.deepEqual(calls, ["ready"]);
    assert.equal(stored.size, 0);
    const observed = await o.fetch(request("status", { collection }));
    assert.equal(observed.status, 200);
    assert.deepEqual(await observed.json(), { verification: null, run: null, native: { run_sequence: null, checkpoint: null, outstanding: null } });
    assert.equal(calls.filter(call => call === "ready").length, 1);
  }
});

test("literal LAB ready failures include only message and stack in the JSON reply", async () => {
  const error = Object.assign(new Error("synthetic ready failure"), { stack: "synthetic stack", cause: "not captured" });
  for (const lab of ["1", "0", "lab", "true", undefined]) {
    const { o, calls } = fixture(error);
    o.env.LAB = lab;
    const response = await o.fetch(request("run", { collection, backup_hold: hold }));
    const body = await response.json();
    assert.equal(response.status, 500);
    assert.deepEqual(body.raw_error, lab === "1" ? { message: error.message, stack: error.stack } : undefined);
    assert.equal(body.error, "migration_run_ready_failed");
    assert.equal(body.stage, "unknown");
    assert.deepEqual(calls, ["ready"]);
  }
});

test("post-ready run failure is LAB JSON only; other environments rethrow the same error", async () => {
  const error = Object.assign(new Error("synthetic run store failure"), { stack: "synthetic run stack" });
  for (const lab of ["1", "0", undefined]) {
    const { o, calls } = fixture();
    o.env.LAB = lab;
    o.ctx.storage.get = async () => { calls.push("get-failed"); throw error; };
    const run = () => o.fetch(request("run", { collection, backup_hold: hold }));
    if (lab === "1") {
      const response = await run();
      assert.equal(response.status, 500);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.deepEqual(await response.json(), { error: "migration_run_failed", raw_error: { message: error.message, stack: error.stack } });
    } else await assert.rejects(run, thrown => thrown === error);
    assert.deepEqual(calls, ["ready", "get-failed"]);
  }
});

test("LAB raw diagnostics do not bypass authorization or expose arbitrary properties", async () => {
  const error = Object.defineProperties({}, { message: { get() { throw new Error("getter failed"); } }, stack: { get() { throw new Error("getter failed"); } } });
  const { o, calls } = fixture(error);
  o.env.LAB = "1";
  assert.equal((await o.fetch(request("run", { collection, backup_hold: hold }, "wrong"))).status, 401);
  assert.deepEqual(calls, []);
  const response = await o.fetch(request("run", { collection, backup_hold: hold }));
  assert.deepEqual((await response.json()).raw_error, { message: null, stack: null });
});

test("successful run saves/syncs once before scheduling; diagnostic handling does not bypass auth", async () => {
  const { o, calls, stored } = fixture();
  assert.equal((await o.fetch(request("run", { collection, backup_hold: hold }, "wrong"))).status, 401);
  assert.deepEqual(calls, []);
  const result = await o.fetch(request("run", { collection, backup_hold: hold }));
  assert.equal(result.status, 202);
  assert.equal((await result.json()).run.backup_hold, hold);
  assert.equal(stored.size, 1);
  assert.deepEqual(calls.slice(0, 5), ["ready", "get", "put", "sync", "alarm"]);
});
