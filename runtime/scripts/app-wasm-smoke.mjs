#!/usr/bin/env node
/** Real dedicated app WASM + actual Node SQLite, same-thread binary bridge.
 * Test-only in-memory backend: NOT OPFS/mobile/power-loss or auth qualification.
 * Usage: npm ci --prefix packages/sdk; node scripts/app-wasm-smoke.mjs <app.wasm>
 */
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { appPolicyPinsFixture } from "../packages/sdk/scripts/app-policy-pins-fixture.mjs";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, mkdirSync } from "node:fs";
import { build } from "../packages/sdk/node_modules/esbuild/lib/main.js";

const file = process.argv[2];
if (!file) throw new Error("explicit app-runtime artifact required");
const dir = new URL("../target/app-wasm-smoke/", import.meta.url);
mkdirSync(dir, { recursive: true });
// Bundle source, never silently consume stale installed SDK/index artifacts.
await build({ stdin: { contents: 'export * from "../../packages/sdk/src/cbor.ts"; export * from "../../packages/obsidian-runtime/src/index/appIndexHost.ts";', resolveDir: new URL(".", dir).pathname }, bundle: true, platform: "node", format: "esm", outfile: new URL("helpers.mjs", dir).pathname });
const { encode, decode, AppBinaryIndexHost, appSqlHost } = await import(new URL("helpers.mjs", dir));
const wasm = readFileSync(file);
const module = await WebAssembly.compile(wasm);
assert(WebAssembly.Module.imports(module).some(i => i.name === "host_app_sql"));
const db = new DatabaseSync(":memory:");
const [major, minor, patch] = db.prepare("select sqlite_version() AS v").get().v.split(".").map(Number);
const version = major * 1_000_000 + minor * 1_000 + patch;
let sqlCalls = 0;
class TestIndex {
  needsRecovery = false;
  fence() { this.needsRecovery = true; }
  run(batch, limits) {
    ++sqlCalls;
    const transaction = batch.mode === "Transaction";
    if (transaction) db.exec("BEGIN IMMEDIATE");
    try {
      let rows = 0;
      const out = batch.stmts.map(({ sql, params }) => {
        const stmt = db.prepare(sql); stmt.setReadBigInts(true);
        const args = params.map(p => p.kind === "Null" ? null : p.value);
        const names = stmt.columns().map(c => c.name);
        if (!names.length) {
          const info = stmt.run(...args);
          return { columns: 0, values: [], changes: BigInt(info.changes), lastInsertRowid: BigInt(info.lastInsertRowid) };
        }
        assert(names.length <= limits.maxColumns);
        const values = [];
        for (const row of stmt.iterate(...args)) {
          assert(++rows <= limits.maxRows);
          for (const name of names) {
            const v = row[name];
            values.push(v === null ? { kind: "Null" } : typeof v === "bigint" ? { kind: "Integer", value: v } : typeof v === "number" ? { kind: "Real", value: v } : typeof v === "string" ? { kind: "Text", value: v } : { kind: "Blob", value: new Uint8Array(v) });
          }
        }
        return { columns: names.length, values, changes: 0n, lastInsertRowid: 0n };
      });
      if (transaction) db.exec("COMMIT");
      return out;
    } catch (e) {
      if (transaction) { try { db.exec("ROLLBACK"); } catch {} }
      this.fence(); throw e;
    }
  }
}
// Explicit ephemeral TEST context, never environment release defaults.
const rootPk = new Uint8Array(generateKeyPairSync("ed25519").publicKey.export({format:"der",type:"spki"}).subarray(-32));
const policyPk = new Uint8Array(generateKeyPairSync("ed25519").publicKey.export({format:"der",type:"spki"}).subarray(-32));
const pins = appPolicyPinsFixture(rootPk, policyPk, encode);
const config = (opened = 0, replica = 2) => encode(new Map([
  [0, 3], [1, new Uint8Array(16).fill(1)], [2, new Uint8Array(16).fill(replica)], [3, new Uint8Array(16).fill(3)],
  [4, 37], [5, [rootPk]], [6, [new Uint8Array(16).fill(3)]], [7, new Uint8Array(32).fill(8)],
  [8, 0], [9, false], [10, new Uint8Array(32).fill(4)], [11, new Uint8Array(32).fill(5)], [12, opened], [13, version], [16, pins],
]));
async function create() {
  let x;
  const index = new TestIndex(), bridge = new AppBinaryIndexHost(index);
  const sql = appSqlHost(bridge, () => x);
  const instance = await WebAssembly.instantiate(module, { env: {
    host_app_sql: sql, host_now_ms: () => 1_800_000_000_000,
    host_random: (p, n) => { for (let at = 0; at < n; at += 65_536) crypto.getRandomValues(new Uint8Array(x.memory.buffer, p + at, Math.min(65_536, n - at))); },
    host_default_zone: (p) => { new Uint8Array(x.memory.buffer, p, 3).set(new TextEncoder().encode("UTC")); return 3; },
    host_local_date: (ms, _p, _n, out) => { new Uint8Array(x.memory.buffer, out, 10).set(new TextEncoder().encode(new Date(ms).toISOString().slice(0, 10))); return 10; },
  } });
  x = instance.exports;
  const put = bytes => { const p = x.alloc(bytes.length); new Uint8Array(x.memory.buffer, p, bytes.length).set(bytes); return p; };
  const take = packed => { const u = BigInt.asUintN(64, packed), p = Number(u >> 32n), n = Number(u & 0xffff_ffffn); const out = new Uint8Array(x.memory.buffer, p, n).slice(); x.dealloc(p, n); return out; };
  // Inputs are consumed/freed: do not dereference their freed allocation to
  // infer a wipe (allocator metadata can overwrite it). Native tests inspect
  // decode_consuming's still-owned buffer; every WASM path uses that operation.
  function open(bytes) { const p = put(bytes); return new TextDecoder().decode(take(x.rt_app_open(p, bytes.length))); }
  return { x, index, bridge, put, take, open };
}
try {
  const a = await create();
  const bytes = config(); const p = a.put(bytes);
  assert.match(new TextDecoder().decode(a.take(a.x.rt_open(p, bytes.length))), /MemStore open refused/);
  assert.equal(sqlCalls, 0);
  assert.equal(a.open(config()), "");
  assert(sqlCalls > 0);
  const observation = decode(a.take(a.x.rt_app_observations()));
  assert.equal(observation.get(3), true); // actual typed staging support
  assert.equal(observation.get(4), false); // no reopen fence
  assert.equal(a.x.rt_app_log_bind(38n, a.put(new Uint8Array(16).fill(1)), 16), 0);
  assert.equal(a.x.rt_app_log_bind(37n, a.put(new Uint8Array(16).fill(1)), 16), 1);
  const calls = decode(a.take(a.x.rt_app_log_calls())); assert(calls.length > 0);
  const frame = decode(calls[0].get(1)), id = BigInt(frame.get(1));
  assert.equal(frame.get(2), "head"); // native HTTP adapter; engine scope remains Subscribe
  assert.equal(a.x.rt_app_log_generation(), 1n);
  const relabelled = new Map(frame); relabelled.set(2, "subscribe");
  const wrongProof = encode(new Map([[0, encode(relabelled)], [1, "public-fixture-token"], [2, new Uint8Array(32).fill(0x11)]]));
  assert.equal(a.take(a.x.rt_app_log_http_sign(37n, 1n, id, a.put(wrongProof), wrongProof.length)).length, 0);
  const proof = encode(new Map([[0, calls[0].get(1)], [1, "public-fixture-token"], [2, new Uint8Array(32).fill(0x11)]]));
  assert.equal(a.take(a.x.rt_app_log_http_sign(37n, 1n, id, a.put(proof), proof.length)).length, 64);
  assert.equal(a.take(a.x.rt_app_log_http_sign(37n, 2n, id, a.put(proof), proof.length)).length, 0);
  a.x.rt_app_log_retire();
  assert.equal(a.x.rt_app_log_generation(), 0n);
  assert.equal(a.take(a.x.rt_app_log_http_sign(37n, 1n, id, a.put(proof), proof.length)).length, 0);
  assert.equal(a.x.rt_app_log_bind(37n, a.put(new Uint8Array(16).fill(1)), 16), 0);
  assert.equal(a.x.rt_app_log_reply(id, a.put(Uint8Array.of(0)), 1), 0);
  const meta = db.prepare("SELECT k FROM st_meta").all();
  assert(meta.length > 0); assert(!meta.some(r => /keyring/i.test(r.k)));
  assert.equal(a.x.rt_app_shutdown(), 1);
  assert.match(a.open(config(1)), /module already used/);
  // New module, same actual SQLite database. No erase or RAM replacement.
  const b = await create(); assert.equal(b.open(config(1)), "");
  assert.equal(db.prepare("SELECT count(*) AS n FROM st_meta").get().n, meta.length);
  assert.equal(b.x.rt_app_shutdown(), 1);
  const wrong = await create(); assert.match(wrong.open(config(1, 7)), /open failed/);
  const malformed = await create(); assert.match(malformed.open(Uint8Array.of(0xa0)), /open failed/);
  const before = sqlCalls; assert.match(malformed.open(config(1)), /module already used/); assert.equal(sqlCalls, before);
  console.log(JSON.stringify({ actualWasm: true, sqliteVersion: version, sqlCalls, metadataRows: meta.length, staging: true, keyringPersisted: false, warmReopen: true, singleUseModule: true, legacyMemStoreRefused: true, staleLogReplyRefused: true, scopedHttpSigner: true, terminalRetirement: true, physicalDurabilityQualified: false }));
} finally { db.close(); }
