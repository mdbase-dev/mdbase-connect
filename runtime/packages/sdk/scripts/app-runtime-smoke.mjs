#!/usr/bin/env node
/** Actual optional SDK loader + dedicated WASM + Node SQLite. Test data only.
 * Explicit artifact required; no fake credentials/network or platform qualification.
 */
import assert from "node:assert/strict";
import { appPolicyPinsFixture } from "./app-policy-pins-fixture.mjs";
import { DatabaseSync } from "node:sqlite";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { readFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "../node_modules/esbuild/lib/main.js";
const file = process.argv[2]; if (!file) throw new Error("explicit app-runtime.wasm required");
const out = new URL("../../../target/app-sdk-smoke/", import.meta.url); mkdirSync(out, { recursive: true });
await build({ stdin: { contents: 'export * from "./src/app-host/wasm-runtime.ts"; export * from "./src/app-host/cp-authority.ts"; export { uuidToBytes } from "./src/codec.ts"; export * from "./src/cbor.ts"; export { ed25519 } from "@noble/curves/ed25519.js"; export { sha256 } from "@noble/hashes/sha2.js"; export * from "../obsidian-runtime/src/index/appIndexHost.ts";', resolveDir: new URL("../", import.meta.url).pathname }, bundle: true, platform: "node", format: "esm", outfile: new URL("helpers.mjs", out).pathname });
const { AppWasmRuntime, AppCpLogAuthority, AppBinaryIndexHost, appSqlHost, encode, decode, uuidToBytes, ed25519, sha256 } = await import(new URL("helpers.mjs", out));
const bytes = readFileSync(file), db = new DatabaseSync(":memory:");
const v = db.prepare("SELECT sqlite_version() AS v").get().v.split(".").map(Number);
const version = v[0] * 1_000_000 + v[1] * 1_000 + v[2]; let turns = 0;
function index() {
  const backend = { needsRecovery: false, fence() { this.needsRecovery = true; }, run(batch, limits) {
    ++turns; const tx = batch.mode === "Transaction"; if (tx) db.exec("BEGIN IMMEDIATE");
    try {
      let rows = 0;
      const results = batch.stmts.map(({ sql, params }) => {
        const s = db.prepare(sql); s.setReadBigInts(true); const args = params.map(v => v.kind === "Null" ? null : v.value), names = s.columns().map(c => c.name);
        if (!names.length) { const r = s.run(...args); return { columns: 0, values: [], changes: BigInt(r.changes), lastInsertRowid: BigInt(r.lastInsertRowid) }; }
        assert(names.length <= limits.maxColumns); const values = [];
        for (const row of s.iterate(...args)) { assert(++rows <= limits.maxRows); for (const name of names) { const v = row[name]; values.push(v === null ? { kind: "Null" } : typeof v === "bigint" ? { kind: "Integer", value: v } : typeof v === "number" ? { kind: "Real", value: v } : typeof v === "string" ? { kind: "Text", value: v } : { kind: "Blob", value: new Uint8Array(v) }); } }
        return { columns: names.length, values, changes: 0n, lastInsertRowid: 0n };
      });
      if (tx) db.exec("COMMIT"); return results;
    } catch (e) { if (tx) { try { db.exec("ROLLBACK"); } catch {} } this.fence(); throw e; }
  } };
  const bridge = new AppBinaryIndexHost(backend);
  return { import: x => appSqlHost(bridge, x), fence: () => bridge.fence(), get needsRecovery() { return bridge.needsRecovery; } };
}
const collection = "0192f3a4-6000-7abc-8def-0123456789ab";
// Optional EXPLICIT shared-build-generated public trust module. No older/fixture
// fallback when it is supplied but malformed. This is Node fixture qualification,
// NOT a runtime authority importer or authenticated production release pipeline.
const trustModule = process.argv[3];
let roots, pins;
if (trustModule) {
  const { appReleaseTrust } = await import(pathToFileURL(resolve(trustModule)).href);
  const trust = appReleaseTrust(); assert.equal(trust.schema, "mdbn-app-trust/release/1");
  assert.match(trust.assetSha256, /^[0-9a-f]{64}$/); assert(trust.trustedRoots.length > 0);
  roots = trust.trustedRoots; pins = trust.policyPins;
} else {
  const rootPk = ed25519.getPublicKey(new Uint8Array(32).fill(9)); roots = [rootPk];
  pins = appPolicyPinsFixture(rootPk, ed25519.getPublicKey(new Uint8Array(32).fill(10)), encode);
}
function config(opened = "fresh") { return { collection, replicaId: "0192f3a4-6000-7abc-8def-0123456789ac", deviceId: "0192f3a4-6000-7abc-8def-0123456789ad", endpoint: 37, trustedRoots: roots, policyPins: pins, trustedSigners: [], expectedGenesis: `sha256:${"08".repeat(32)}`, state: "e2e", cloudCopyOptIn: false, signSecretKey: new Uint8Array(32).fill(4), kemSecretKey: new Uint8Array(32).fill(5), opened, sqliteVersion: version }; }
let cpServer;
try {
  if (trustModule) {
    const wrong = await AppWasmRuntime.create(bytes, index()), mismatch = config();
    mismatch.trustedRoots = [ed25519.getPublicKey(new Uint8Array(32).fill(0x33))];
    const before = turns; assert.throws(() => wrong.openAppConsuming(mismatch));
    assert.equal(turns, before); assert(mismatch.signSecretKey.every(b => b === 0) && mismatch.kemSecretKey.every(b => b === 0));
    await wrong.close();
  }
  const sql = index(), rt = await AppWasmRuntime.create(bytes, sql), c = config();
  rt.openAppConsuming(c); assert(c.signSecretKey.every(b => b === 0) && c.kemSecretKey.every(b => b === 0));
  const observed = rt.observations(); assert.equal(observed.status.mode, "synced"); assert.equal(observed.snapshotInstallAvailable, true); assert.equal(observed.requiresReopen, false);
  assert.deepEqual(rt.takeLogCalls(), []);
  // Actual CP protocol over loopback HTTP, verifying the actual WASM signature.
  // Public test account/device fixture only: not deployed CP/PG/enrolment acceptance.
  const connectorId = "66666666-6666-6666-6666-666666666666", deviceId = c.deviceId;
  const challenges = new Set(); let minted = 0;
  assert.throws(() => rt.signCpLogToken(new Uint8Array(32)));
  cpServer = createServer(async (req, res) => {
    try {
      assert.equal(req.headers.authorization, "Bearer public-connector-bearer"); assert.equal(req.method, "POST");
      if (req.url === "/v1/next/devices/challenge") {
        const challenge = randomBytes(32).toString("hex"); challenges.add(challenge);
        res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ challenge, expires_at: Date.now() + 60_000 })); return;
      }
      assert.equal(req.url, `/v1/next/collections/${collection}/log-token`);
      let body = ""; for await (const b of req) { body += b; assert(body.length <= 4096); }
      const parsed = JSON.parse(body); assert.equal(parsed.device_id, deviceId); assert(challenges.delete(parsed.challenge));
      const domain = Buffer.from("mdbase/v1/collection-log-token"), tuple = encode([Buffer.from(parsed.challenge, "hex"), uuidToBytes(connectorId), uuidToBytes(deviceId), uuidToBytes(collection)]);
      const digest = sha256(Buffer.concat([Buffer.from([domain.length]), domain, tuple]));
      assert(ed25519.verify(Buffer.from(parsed.sig, "hex"), digest, ed25519.getPublicKey(new Uint8Array(32).fill(4)))); ++minted;
      res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ token: "public-fixture-token", expires_at: Date.now() + 15 * 60_000 }));
    } catch { res.statusCode = 403; res.end("{}"); }
  });
  await new Promise(r => cpServer.listen(0, "127.0.0.1", r));
  const authority = new AppCpLogAuthority(rt, { connectorId, deviceId, collection, endpoint: 37, cpOrigin: `http://127.0.0.1:${cpServer.address().port}`, logOrigin: "https://fixture.invalid", directOrigins: [], isCurrent: () => true, connectorBearer: async () => "public-connector-bearer" }, { allowLoopbackHttp: true });
  assert.throws(() => authority.logTransport());
  assert.equal(await authority.accessToken({ signal: new AbortController().signal }), "public-fixture-token"); assert.equal(minted, 1);
  assert.equal(authority.isCurrent(), true); rt.bindLogTransport(authority.logTransport());
  const calls = rt.takeLogCalls(); assert(calls.length > 0);
  const call = calls[0], frame = decode(call.frame), id = BigInt(frame.get(1)), token = "public-fixture-token", nonce = new Uint8Array(32).fill(0x11);
  const proof = { endpoint: 37, collection, path: "/v1/rpc", originalCallId: id, frame: call.frame, token, nonce, method: frame.get(2), bodyHash: new Uint8Array(32), tokenHash: new Uint8Array(32), digest: new Uint8Array(32) };
  // JS digest metadata is deliberately wrong: protected WASM constructs the
  // fixed transcript from its captured original, never signs a supplied digest.
  const signature = rt.signLogHttp(proof);
  const body = Buffer.concat([Buffer.from([17]), Buffer.from("mdbase/v1/ls-http"), Buffer.from(frame.get(2)), Buffer.from([0]), Buffer.from("/v1/rpc"), Buffer.from([0]), frame.get(3).get(0), sha256(Buffer.from(token)), sha256(call.frame), nonce]);
  assert(ed25519.verify(signature, sha256(body), ed25519.getPublicKey(new Uint8Array(32).fill(4)))); signature.fill(0);
  assert.throws(() => rt.signLogHttp({ ...proof, originalCallId: id + 1n }));
  rt.logNoResponse(id); assert.throws(() => rt.signLogHttp(proof));
  calls.forEach(c => { c.frame.fill(0); c.sidecar?.fill(0); });
  assert.equal(await rt.close(), true); authority.close(); assert.throws(() => rt.signCpLogToken(new Uint8Array(32))); assert.equal(sql.needsRecovery, false); assert.equal(rt.acceptLogReply(1n, new Uint8Array()), false);
  assert.throws(() => rt.openAppConsuming(config("existing")));
  const warm = await AppWasmRuntime.create(bytes, index()); warm.openAppConsuming(config("existing")); assert.equal(warm.observations().requiresReopen, false); assert.equal(await warm.close(), true);
  assert(!db.prepare("SELECT k FROM st_meta").all().some(r => /keyring/i.test(r.k)));
  console.log(JSON.stringify({ actualSdk: true, actualAppWasm: true, actualSqlite: version, turns, keyBuffersConsumed: true, warmReopen: true, scopedLogBind: true, protectedHttpSigner: true, actualCpHttpFixture: true, actualCpWasmProof: true, explicitBuildTrustFixture: Boolean(trustModule), exactNativeRootPins: true, tokenBeforeBind: true, callerDigestIgnored: true, consumedScopeRefused: true, drainedShutdown: true, activationQualified: false }));
} finally { if (cpServer) { cpServer.closeAllConnections(); await new Promise(r => cpServer.close(r)); } db.close(); }
