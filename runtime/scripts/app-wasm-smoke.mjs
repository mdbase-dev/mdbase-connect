#!/usr/bin/env node
/** Real dedicated app WASM + actual Node SQLite, same-thread binary bridge.
 * Test-only in-memory backend: NOT OPFS/mobile/power-loss or auth qualification.
 * Usage: npm ci --prefix packages/sdk; node scripts/app-wasm-smoke.mjs <app.wasm>
 */
import assert from "node:assert/strict";
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { appPolicyPinsFixture } from "../packages/sdk/scripts/app-policy-pins-fixture.mjs";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "../packages/sdk/node_modules/esbuild/lib/main.js";

const file = process.argv[2];
if (!file) throw new Error("explicit app-runtime artifact required");
const dir = new URL("../target/app-wasm-smoke/", import.meta.url);
mkdirSync(dir, { recursive: true });
// Bundle source, never silently consume stale installed SDK/index artifacts.
await build({
  stdin: { contents: 'export * from "../../packages/sdk/src/cbor.ts"; export * from "../../packages/obsidian-runtime/src/index/appIndexHost.ts"; export { submitParams, receipt as receiptCodec, recordView } from "../../packages/sdk/src/wire.ts"; export { uuidToBytes } from "../../packages/sdk/src/codec.ts";', resolveDir: new URL(".", dir).pathname },
  // Runtime compatibility reexports resolve to this checkout's canonical engine,
  // even in the standalone WASM lane (SDK dependencies only, no runtime install
  // or SDK dist build). Never fall back to a stale installed SDK artifact.
  alias: { "@mdbase-dev/sdk/app-storage": fileURLToPath(new URL("../packages/sdk/src/app-storage/index.ts", import.meta.url)) },
  bundle: true, platform: "node", format: "esm", outfile: new URL("helpers.mjs", dir).pathname,
});
const { encode, decode, AppBinaryIndexHost, appSqlHost, submitParams, receiptCodec, recordView, uuidToBytes } = await import(new URL("helpers.mjs", dir));
const wasm = readFileSync(file);
const module = await WebAssembly.compile(wasm);
assert(WebAssembly.Module.imports(module).some(i => i.name === "host_app_sql"));
let db = new DatabaseSync(":memory:");
const [major, minor, patch] = db.prepare("select sqlite_version() AS v").get().v.split(".").map(Number);
const version = major * 1_000_000 + minor * 1_000 + patch;
let sqlCalls = 0;
const recordPageReads = [];
const sqlErrorKinds = [];
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
        if (sql.startsWith("SELECT") && sql.includes("FROM st_rec") && (sql.includes("LIMIT") || sql.startsWith("SELECT id, row FROM st_rec WHERE id >="))) recordPageReads.push(sql);
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
// The one fixed account-key fetch proof, as a server would recompute it:
// H("mdbase/v1/account-key-fetch", cbor[challenge, connector, device, account])
// under this fixture's device key (config key 10), connector and device.
const fetchTag = new TextEncoder().encode("mdbase/v1/account-key-fetch");
const fetchKey = createPublicKey(createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.alloc(32, 4)]), format: "der", type: "pkcs8" }));
const fetchInput = (challenge, account) => encode(new Map([[0, challenge], [1, account]]));
const fetchDigest = (challenge, account, connector = new Uint8Array(16).fill(1), device = new Uint8Array(16).fill(3)) =>
  createHash("sha256").update(Uint8Array.of(fetchTag.length)).update(fetchTag).update(encode([challenge, connector, device, account])).digest();
function fetchSign(r, bytes) { return r.take(r.x.rt_app_account_key_fetch_sign(r.put(bytes), bytes.length)); }
async function create() {
  let x;
  const index = new TestIndex(), bridge = new AppBinaryIndexHost(index);
  const run = bridge.run.bind(bridge);
  bridge.run = bytes => { const reply = run(bytes); if (reply[8] === 3) sqlErrorKinds.push(reply[9]); return reply; };
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
  // Real native frame dispatch must answer missing data, not absent methods.
  // API 1.0 hello keeps this regression independent of newer hello metadata.
  const hello = encode(new Map([[0, 0], [1, 1], [2, "hello"], [3, new Map([[0, [[1, 0]]], [1, "app-contract-artifact-test"], [2, "1"]])]]));
  const [session] = decode(a.take(a.x.rt_hello(0, 0, a.put(hello), hello.length)));
  assert(BigInt(session) > 0n, "actual native owner hello refused");
  function method(id, name, params) {
    const input = encode(new Map([[0, 0], [1, id], [2, name], [3, params]]));
    a.x.rt_frame(BigInt(session), a.put(input), input.length);
    const replies = decode(a.take(a.x.rt_poll())).filter(row => BigInt(row[0]) === BigInt(session) && row[1]);
    const response = replies.map(row => decode(row[1])).find(frame => frame.get(0) === 1 && frame.get(1) === id);
    assert(response, `missing actual native response for ${name}`);
    return response;
  }
  const read = method(2, "get_contract_v1", new Map([[0, 1], [1, "missing.md"], [2, "artifact.missing"], [3, "1.0.0"]]));
  assert.equal(read.get(3)?.get(0), "not_found", "get_contract_v1 actual native dispatch");
  const write = method(3, "map_contract_write_v1", new Map([[0, 1], [1, "artifact.missing"], [2, "1.0.0"], [5, new Map()]]));
  assert.equal(write.get(3)?.get(0), "not_found", "map_contract_write_v1 actual native dispatch");
  assert.equal(write.get(3)?.get(3), "data_contract_not_found");
  const filtered = method(4, "query_contract_v1", new Map([[0, 1], [1, "artifact.missing"], [2, "1.0.0"], [5, "true"]]));
  assert.equal(filtered.get(3)?.get(0), "not_found", "query_contract_v1 where actual native dispatch");
  assert.equal(filtered.get(3)?.get(3), "data_contract_not_found");
  const replace = method(5, "open_upload", new Map([[0, new Uint8Array(16).fill(9)], [1, "missing.bin"], [2, 0], [4, new Uint8Array(16).fill(10)]]));
  assert.equal(replace.get(3)?.get(0), "invalid_request", "file replacement requires the original revision");
  assert.equal(replace.get(3)?.get(3), "attachment_replace_requires_revision");
  const promote = method(6, "map_contract_write_v1", new Map([[0, 1], [1, "artifact.missing"], [2, "1.0.0"], [5, new Map()], [7, true]]));
  assert.equal(promote.get(3)?.get(0), "not_found", "contract promote actual native envelope");
  assert.equal(promote.get(3)?.get(3), "data_contract_not_found");
  const pack = method(7, "plan_type_pack_v1", new Map([[0, 1], [1, new Map()], [2, "artifact.native.typepack"]]));
  assert.equal(pack.get(3)?.get(0), "invalid_request", "type pack actual native envelope");
  assert.equal(pack.get(3)?.get(3), "invalid_type_pack_request", "type pack reaches native provision validation, not unknown_method");
  a.x.rt_close(BigInt(session));
  const observation = decode(a.take(a.x.rt_app_observations()));
  assert.equal(observation.get(3), true); // actual typed staging support
  assert.equal(observation.get(4), false); // no reopen fence
  // Account-key fetch proof: this runtime never had a connector bound, so it
  // signs nothing, before or after the log is bound.
  assert.equal(typeof a.x.rt_app_account_key_fetch_sign, "function", "account-key fetch proof export");
  const challenge = new Uint8Array(32).fill(0x31), account = new Uint8Array(16).fill(0x41);
  assert.equal(fetchSign(a, fetchInput(challenge, account)).length, 0, "no proof without a bound connector");
  assert.equal(a.x.rt_app_log_bind(38n, a.put(new Uint8Array(16).fill(1)), 16), 0);
  assert.equal(a.x.rt_app_log_bind(37n, a.put(new Uint8Array(16).fill(1)), 16), 1);
  assert.equal(fetchSign(a, fetchInput(challenge, account)).length, 0, "a log bind is not a connector bind");
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
  // Account-key fetch proof on the actual artifact: one fixed purpose, signed
  // only once the host has bound the connector, with the native connector and
  // device. The caller supplies the server challenge and its account, no more.
  const connector = new Uint8Array(16).fill(6);
  assert.equal(fetchSign(b, fetchInput(challenge, account)).length, 0, "no proof before the connector is bound");
  assert.equal(b.x.rt_app_cp_bind_connector(b.put(connector), 16), 1);
  const fetchProof = fetchSign(b, fetchInput(challenge, account));
  assert.equal(fetchProof.length, 64, "bound runtime signs the fetch proof");
  assert(verify(null, fetchDigest(challenge, account, connector), fetchKey, fetchProof), "proof verifies against the server's digest");
  assert(!verify(null, fetchDigest(challenge, account, new Uint8Array(16).fill(1)), fetchKey, fetchProof), "another connector does not verify");
  assert(!verify(null, fetchDigest(challenge, account, connector, new Uint8Array(16).fill(2)), fetchKey, fetchProof), "another device does not verify");
  const otherAccount = fetchSign(b, fetchInput(challenge, new Uint8Array(16).fill(0x42)));
  assert.equal(otherAccount.length, 64); assert.notDeepEqual(otherAccount, fetchProof);
  assert(!verify(null, fetchDigest(challenge, account, connector), fetchKey, otherAccount));
  const otherChallenge = fetchSign(b, fetchInput(new Uint8Array(32).fill(0x32), account));
  assert.equal(otherChallenge.length, 64); assert.notDeepEqual(otherChallenge, fetchProof);
  // Not a digest or route signer: anything but the exact canonical pair is refused.
  for (const refused of [
    new Uint8Array(32).fill(0x31), new Uint8Array(fetchDigest(challenge, account, connector)), new Uint8Array(0),
    fetchInput(new Uint8Array(31).fill(0x31), account), fetchInput(challenge, new Uint8Array(16)),
    fetchInput(challenge, new Uint8Array(17).fill(0x41)), encode(new Map([[0, challenge], [1, account], [2, "put"]])),
    encode(new Map([[0, challenge], [1, account], [2, connector]])), encode([challenge, account]),
  ]) assert.equal(fetchSign(b, refused).length, 0, "non-canonical fetch proof input refused");
  assert.equal(fetchSign(b, fetchInput(challenge, account)).length, 64, "a refusal does not spend the signer");
  b.x.rt_app_log_retire();
  assert.equal(fetchSign(b, fetchInput(challenge, account)).length, 0, "no fetch proof after retirement");
  assert.equal(b.x.rt_app_shutdown(), 1);
  assert.equal(fetchSign(b, fetchInput(challenge, account)).length, 0, "no fetch proof after shutdown");
  // Exact persisted record_c fixture in an already-owned ephemeral database.
  // The real AppRuntime/TentativeStore open must backfill its unready index;
  // this is not merely a direct Store::records(Page16) call.
  db.exec("BEGIN IMMEDIATE");
  const insert = db.prepare("INSERT INTO st_rec(id,path_key,bucket,row) VALUES(?,?,?,?)");
  const doc = "x".repeat(300_000), revision = new Uint8Array(createHash("sha256").update(doc).digest());
  for (let n = 1; n <= 16; n++) {
    const id = new Uint8Array(16); id[15] = n;
    const path = `large-${String(n).padStart(2, "0")}.md`;
    const row = encode([id, path, path, doc, revision, 0, 0, [[], new Map(), [], [], []]]);
    insert.run(id, path, 0, row);
  }
  db.exec("UPDATE st_qstate SET ready=0; UPDATE st_qraw_state SET ready=0; COMMIT");
  const originalRows = () => {
    const hash = createHash("sha256");
    for (const {row} of db.prepare("SELECT row FROM st_rec ORDER BY id").all()) hash.update(row);
    return hash.digest("hex");
  };
  const originalDigest = originalRows(), pagesBefore = recordPageReads.length;
  const large = await create();
  const largeOpen = large.open(config(1));
  assert(recordPageReads.length > pagesBefore, "must actually reach record-page backfill");
  if (largeOpen) console.error(JSON.stringify({ backfillOpenFailure: largeOpen, indexErrorKinds: sqlErrorKinds,
    backfillQueries: recordPageReads.slice(pagesBefore) }));
  assert.equal(largeOpen, "", "actual app/WASM unready-index open must backfill16x300000 through the real4MiB codec");
  assert.equal(originalRows(), originalDigest, "backfill must not alter original record bytes");
  assert.equal(db.prepare("SELECT ready FROM st_qstate WHERE slot=0").get().ready, 1);
  assert.equal(db.prepare("SELECT ready FROM st_qraw_state WHERE slot=0").get().ready, 1);
  assert.equal(db.prepare("SELECT count(*) AS n FROM st_qrecord").get().n, 16);
  assert.equal(large.bridge.needsRecovery, false);
  assert.equal(large.x.rt_app_shutdown(), 1);
  const readyPages = recordPageReads.length, ready = await create();
  assert.equal(ready.open(config(1)), "");
  assert.equal(recordPageReads.length, readyPages, "a ready reopen must not backfill again");
  assert.equal(ready.x.rt_app_shutdown(), 1);
  console.log(JSON.stringify({ actualAppWasmBackfill: true, records: 16, bytesPerRecord: 300000,
    recordPageReads: readyPages - pagesBefore, unchangedRows: originalDigest, readyReopen: true, physicalDurabilityQualified: false }));
  const wrong = await create(); assert.match(wrong.open(config(1, 7)), /open failed/);
  const malformed = await create(); assert.match(malformed.open(Uint8Array.of(0xa0)), /open failed/);
  const before = sqlCalls; assert.match(malformed.open(config(1)), /module already used/); assert.equal(sqlCalls, before);
  // Stateless setup planning over a caller-read inventory: no open, no SQL.
  const planner = await create(), sqlBefore = sqlCalls;
  const setupManifest = new Map([["id", "org.example.resources"],
    ["requirements", new Map([["configuration", [new Map([["id", "base-format"], ["path", "/settings/record_extensions"], ["predicate", "contains"], ["value", "base"]])]]])],
    ["provisions", new Map([["configuration", [new Map([["requirement", "base-format"], ["path", "/settings/record_extensions"], ["operation", "set_add"], ["value", "base"]])]], ["type_packs", []]])]]);
  const setupRequest = encode([1, 0, setupManifest, null, []]);
  const [setupVersion, setupOk, setupAnswer] = decode(planner.take(planner.x.rt_app_setup_assess(planner.put(setupRequest), setupRequest.length)));
  assert.equal(setupVersion, 1); assert.equal(setupOk, true, "stateless setup assessment refused");
  assert.equal(setupAnswer.get("status"), "provision"); assert.match(setupAnswer.get("assessmentDigest"), /^sha256:[0-9a-f]{64}$/);
  const unordered = encode([1, 0, setupManifest, null, [["b.md", "x"], ["a.md", "y"]]]);
  assert.equal(decode(planner.take(planner.x.rt_app_setup_assess(planner.put(unordered), unordered.length)))[1], false);
  assert.equal(sqlCalls, sqlBefore);
  // Unsynced collection (work before connecting): rt_app_open_local over a
  // fresh actual SQLite database. A local commit confirms on a tick with no
  // log, nothing binds, and the record survives a new module's reopen.
  const syncedSql = sqlCalls;
  db.close(); db = new DatabaseSync(":memory:");
  const localConfig = opened => encode(new Map([[0, 1], [1, new Uint8Array(16).fill(0x21)],
    [2, new Uint8Array(16).fill(0x22)], [3, new Uint8Array(16).fill(0x23)], [12, opened], [13, version]]));
  const openLocal = (h, bytes) => new TextDecoder().decode(h.take(h.x.rt_app_open_local(h.put(bytes), bytes.length)));
  const localSession = h => {
    const [id] = decode(h.take(h.x.rt_hello(0, 0, h.put(hello), hello.length)));
    assert(BigInt(id) > 0n, "unsynced owner hello refused");
    let next = 100;
    return (name, params) => {
      const n = ++next, input = encode(new Map([[0, 0], [1, n], [2, name], [3, params]]));
      h.x.rt_frame(BigInt(id), h.put(input), input.length);
      const frames = decode(h.take(h.x.rt_poll())).filter(row => BigInt(row[0]) === BigInt(id) && row[1]).map(row => decode(row[1]));
      const response = frames.find(frame => frame.get(0) === 1 && frame.get(1) === n);
      assert(response, `missing unsynced response for ${name}`);
      assert.equal(response.get(3), undefined, `${name} refused: ${JSON.stringify([...(response.get(3) ?? new Map())])}`);
      return response.get(2);
    };
  };
  const recordId = "01960000-0000-7000-8000-000000000042", mutationId = "01960000-0000-7000-8000-000000000043";
  const u1 = await create();
  assert.match(openLocal(u1, config()), /open failed/, "a synced bootstrap is refused by the unsynced open");
  const u2 = await create();
  assert.equal(openLocal(u2, localConfig(0)), "");
  assert(sqlCalls > syncedSql, "unsynced open uses the tentative SQL store");
  assert.equal(u2.x.rt_app_log_bind(0n, u2.put(new Uint8Array(16).fill(0x21)), 16), 0, "no log binding");
  assert.equal(fetchSign(u2, fetchInput(new Uint8Array(32).fill(0x31), new Uint8Array(16).fill(0x41))).length, 0, "an unsynced runtime signs no fetch proof");
  assert.equal(decode(u2.take(u2.x.rt_app_log_calls())).length, 0, "no log calls");
  const call = localSession(u2);
  call("submit", submitParams.enc({ ops: [{ kind: "create", id: recordId, path: "first.md", body: "Started before connecting.\n" }], mutationId }));
  u2.x.rt_tick(1_800_000_000_000);
  const receipt = receiptCodec.dec(call("receipt", new Map([[0, uuidToBytes(mutationId)]])));
  assert.equal(receipt.state, "confirmed", "a tick confirms the local commit");
  assert.equal(receipt.mutation, mutationId);
  assert.equal(decode(u2.take(u2.x.rt_app_log_calls())).length, 0, "a local commit makes no log call");
  const byId = () => new Map([[0, uuidToBytes(recordId)], [1, new Map([[1, true]])]]);
  const got = recordView.dec(call("get", byId()));
  assert.equal(got.path, "first.md"); assert.equal(got.body, "Started before connecting.\n");
  assert.equal(u2.x.rt_app_shutdown(), 1);
  const u3 = await create(); assert.equal(openLocal(u3, localConfig(1)), "");
  const again = recordView.dec(localSession(u3)("get", byId()));
  assert.equal(again.body, got.body, "the unsynced record survives a new module's reopen");
  assert.equal(again.revision, got.revision);
  assert.equal(u3.x.rt_app_shutdown(), 1);
  console.log(JSON.stringify({ unsynced: true, localCommitConfirmed: true, logCalls: 0, logBindRefused: true, syncedBootstrapRefused: true, reopened: true }));
  console.log(JSON.stringify({ actualWasm: true, sqliteVersion: version, sqlCalls, metadataRows: meta.length, staging: true, keyringPersisted: false, warmReopen: true, singleUseModule: true, legacyMemStoreRefused: true, staleLogReplyRefused: true, statelessSetup: true, scopedHttpSigner: true, accountKeyFetchProof: true, terminalRetirement: true, physicalDurabilityQualified: false }));
} finally { db.close(); }
