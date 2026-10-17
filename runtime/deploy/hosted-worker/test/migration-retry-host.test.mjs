// Synthetic native ports exercise the closed host API, not CPP authenticity or
// physical durability. Real SQLite/Driver and workerd tests cover persistence.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { build } from "esbuild";
const bundled = await build({ stdin: { contents: 'export {Engine,decode} from "./src/engine.ts";',
  resolveDir: new URL("../", import.meta.url).pathname, loader: "ts" }, bundle: true, write: false,
  format: "esm", platform: "node", plugins: [{ name: "synthetic-native", setup(b) {
    b.onResolve({ filter: /hosted\.wasm$/ }, () => ({ path: "wasm", namespace: "fake" }));
    b.onLoad({ filter: /.*/, namespace: "fake" }, () => ({ contents: 'export default undefined;' }));
    b.onLoad({ filter: /src\/engine\.ts$/ }, args => ({ contents: readFileSync(args.path, "utf8")
      .replace(/#(cppLive|cppTickets|migrationLive|physicalLive)\b/g, "test_$1"), loader: "ts" }));
  } }] });
const { Engine, decode } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`);
const collection = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa", device = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";
const claim = { collection_id: collection, owner_account: device, started_us: "123", target: {
  root_key_id: "cc".repeat(16), hosted: { device_id: device, sign_pk: "dd".repeat(32), kem_pk: "ee".repeat(32), noise_pk: "ff".repeat(32) } } };
function fixture() {
  const e = Object.create(Engine.prototype), ticket = Object.freeze({ collection, device }), calls = [];
  const memory = new WebAssembly.Memory({ initial: 1 });
  e.test_cppLive = ticket;e.test_cppTickets = new WeakMap([[ticket, { handle: 7, signed: true }]]);
  e.test_migrationLive = null;e.test_physicalLive = null;
  e.ex = { memory, alloc: () => 16, hd_migration_run: () => 0n, hd_cpp_claim_current: h => { calls.push(["current", h]);return 1; },
    hd_migration_open: () => { calls.push(["open"]);return 1; },
    hd_migration_restart: (h, seq, p, n) => { calls.push(["restart", h, seq, decode(new Uint8Array(memory.buffer, p, n))]);return 1; } };
  return { e, ticket, calls };
}
test("retry passes exact expected sequence and the original signed CPP handle, never auto-restarts open", () => {
  const f = fixture();f.e.openMigrationDriver(f.ticket, claim);
  assert.deepEqual(f.calls, [["current", 7], ["open"], ["current", 7]]);f.calls.length = 0;
  f.e.restartMigrationDriver(f.ticket, claim, 1);
  assert.equal(f.calls[1][0], "restart");assert.equal(f.calls[1][1], 7);assert.equal(f.calls[1][2], 1);
  assert.equal(f.calls[1][3][1], "123");assert.deepEqual(f.calls[2], ["current", 7]);
});
test("missing or unavailable run status returns explicit refusal, not a decoder invariant error", () => {
  const f = fixture();assert.throws(() => f.e.migrationRun(0), /migration_run_refused/);
});
test("foreign/unsigned CPP, changed target device, occupied tickets and invalid sequences never enter native retry", () => {
  for (const mutate of [f => f.ticket = { ...f.ticket }, f => f.e.test_cppTickets.get(f.ticket).signed = false,
    f => f.e.test_migrationLive = {}, f => f.e.test_physicalLive = {}]) {
    const f = fixture();mutate(f);assert.throws(() => f.e.restartMigrationDriver(f.ticket, claim, 1), /refused/);
    assert.ok(!f.calls.some(c => c[0] === "restart"));
  }
  const f = fixture();assert.throws(() => f.e.restartMigrationDriver(f.ticket, { ...claim, collection_id: device }, 1), /refused/);
  for (const seq of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    const f = fixture();assert.throws(() => f.e.restartMigrationDriver(f.ticket, claim, seq), /refused/);assert.deepEqual(f.calls, []);
    assert.throws(() => f.e.migrationRun(seq || -1), /refused/);
  }
});
