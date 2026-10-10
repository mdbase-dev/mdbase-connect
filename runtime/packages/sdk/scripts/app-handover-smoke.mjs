#!/usr/bin/env node
/** Actual source SDK + app WASM + SQLite + verified signed policy/rekey.
 * Explicit public fixture/artifact, not CP/OPFS/provider/platform acceptance. */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, mkdirSync } from "node:fs";
import { build } from "../node_modules/esbuild/lib/main.js";
const [artifact, fixtureFile, policyPinsFile] = process.argv.slice(2); if (!artifact || !fixtureFile || !policyPinsFile) throw Error("explicit actual app artifact, native-generated signed fixture and matching public PolicyPins CBOR required");
const policyPins = new Uint8Array(readFileSync(policyPinsFile));
const out = new URL("../../../target/app-handover-smoke/", import.meta.url); mkdirSync(out, { recursive: true });
await build({ stdin: { contents: 'export * from "./src/app-host/index.ts"; export * from "./src/cbor.ts"; export { uuid, hash } from "./src/codec.ts"; export { MdbaseClient } from "./src/client.ts"; export * from "../obsidian-runtime/src/index/appIndexHost.ts";', resolveDir: new URL("../", import.meta.url).pathname }, bundle: true, platform: "node", format: "esm", outfile: new URL("helpers.mjs", out).pathname });
const { AppWasmRuntime, AppBinaryIndexHost, appSqlHost, MdbaseClient, verifyAppHandover, encode, decode, uuid, hash } = await import(new URL("helpers.mjs", out));
const bytesToUuid = b => uuid.dec(b), bytesToHash = b => hash.dec(b);
const fixture = decode(readFileSync(fixtureFile)), db = new DatabaseSync(":memory:"), wasm = readFileSync(artifact);
const collection = bytesToUuid(fixture.get(0)), deviceId = bytesToUuid(fixture.get(1)), signedWitness = fixture.get(6), head = fixture.get(5);
const v = db.prepare("SELECT sqlite_version() AS v").get().v.split(".").map(Number), version = v[0] * 1_000_000 + v[1] * 1_000 + v[2]; let turns = 0;
const backend = { needsRecovery: false, fence() { this.needsRecovery = true; }, run(batch, limits) {
  ++turns; const tx = batch.mode === "Transaction"; if (tx) db.exec("BEGIN IMMEDIATE");
  try { let rows = 0; const results = batch.stmts.map(({ sql, params }) => {
    const s = db.prepare(sql); s.setReadBigInts(true); const args = params.map(v => v.kind === "Null" ? null : v.value), names = s.columns().map(c => c.name);
    if (!names.length) { const r = s.run(...args); return { columns: 0, values: [], changes: BigInt(r.changes), lastInsertRowid: BigInt(r.lastInsertRowid) }; }
    assert(names.length <= limits.maxColumns); const values = [];
    for (const row of s.iterate(...args)) { assert(++rows <= limits.maxRows); for (const name of names) { const v = row[name]; values.push(v === null ? { kind: "Null" } : typeof v === "bigint" ? { kind: "Integer", value: v } : typeof v === "number" ? { kind: "Real", value: v } : typeof v === "string" ? { kind: "Text", value: v } : { kind: "Blob", value: new Uint8Array(v) }); } }
    return { columns: names.length, values, changes: 0n, lastInsertRowid: 0n };
  }); if (tx) db.exec("COMMIT"); return results;
  } catch (e) { if (tx) { try { db.exec("ROLLBACK"); } catch {} } this.fence(); throw e; }
} };
const bridge = new AppBinaryIndexHost(backend), sql = { import: x => appSqlHost(bridge, x), fence: () => bridge.fence(), get needsRecovery() { return bridge.needsRecovery; } };
let rt, client;
try {
  rt = await AppWasmRuntime.create(wasm, sql);
  rt.openAppConsuming({ collection, replicaId: "01010101-0101-0101-0101-010101010101", deviceId, endpoint: 37, trustedRoots: [fixture.get(2)], policyPins, trustedSigners: [], expectedGenesis: bytesToHash(fixture.get(3)), state: "cloud_copy", cloudCopyOptIn: true, signSecretKey: new Uint8Array(32).fill(1), kemSecretKey: new Uint8Array(32).fill(1), opened: "fresh", sqliteVersion: version });
  const pump = rt.bindLogTransport({ endpoint: 37, collection, isCurrent: () => true, send: async call => {
    const request = decode(call.frame), method = request.get(2), params = request.get(3); let result;
    if (method === "read") result = new Map([[0, fixture.get(4).filter(i => BigInt(i[0]) > BigInt(params.get(1)))], [1, head.get(0)], [2, head.get(1)], [3, 1], [4, false], [6, false]]);
    else if (method === "subscribe") result = new Map([[0, head.get(0)], [1, head.get(1)]]);
    else if (method === "head") result = new Map([[0, head.get(0)], [1, head.get(1)], [2, 1]]);
    else throw Error("public static control-log fixture does not implement this method");
    return encode(new Map([[0, 1], [1, request.get(1)], [2, result]]));
  } });
  await pump.pump(); rt.tick(); await pump.pump();
  assert.equal(rt.observations().keyringRebuilding, false); assert.equal(rt.observations().keyringRebuildFailed, false);
  const port = rt.connect();
  client = await MdbaseClient.connect({ app: { name: "public-handover-smoke", version: "1" }, connector: { description: "actual same-WASM fixture port", open: async hello => new Promise(resolve => { port.onframe = response => resolve({ port, helloResponse: response }); port.send(hello); }) }, reconnect: false });
  const source = { collection, deviceId, isCurrent: () => true };
  const verified = rt.verifyHandover(port, source, signedWitness); assert(verified, "actual verified signed-policy + retained-prefix consumer must qualify");
  assert.equal(verified.seq, head.get(0)); assert.equal(verified.chain, bytesToHash(head.get(1)));
  const tampered = new Uint8Array(signedWitness); tampered[tampered.length - 1] ^= 1; assert.equal(rt.verifyHandover(port, source, tampered), null);
  assert.equal(rt.verifyHandover(port, { ...source, deviceId: "77777777-7777-7777-7777-777777777777" }, signedWitness), null);
  const hosted = { authenticatedDevice: deviceId, hello: { collection, headWitness: signedWitness, status: { confirmedHead: verified } } };
  const evidence = await verifyAppHandover({ runtime: rt, localPort: port, localClient: client, hostedClient: hosted, source, isCurrent: () => true }, new AbortController().signal);
  assert(evidence, "actual source SDK applied_prefix RPC + native verification must qualify"); assert(evidence.isCurrent()); evidence.dispose(); assert(!evidence.isCurrent());
  client.close(); client = null; assert.equal(rt.verifyHandover(port, source, signedWitness), null);
  assert.equal(await rt.close(), true); assert.equal(sql.needsRecovery, false);
  assert(!db.prepare("SELECT k FROM st_meta").all().some(r => /keyring/i.test(r.k)));
  console.log(JSON.stringify({ actualSdk: true, actualWasm: true, actualSqlite: version, turns, productionSignedPolicy: true, productionHpkeRekey: true, signerFromVerifiedPolicy: true, signatureVerified: true, actualAppliedPrefixRpc: true, staleClosedSessionRefused: true, tamperedUnknownSignerRefused: true, handoverEvidence: true, providerActivationQualified: false }));
} finally { client?.close(); if (rt) await rt.close(); db.close(); }
