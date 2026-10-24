import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { build } from "esbuild";
import { migrationAdmissionRequest, migrationAdmissionObservation } from "../src/migration-admission.ts";

// Platform/native observer mocks: routing/output/lifecycle orchestration ONLY,
// not native proof, cryptographic custody or deletion/activation qualification.
const token = "synthetic".repeat(5);
const collection = "0e0e0e0e-0e0e-4e0e-8e0e-0e0e0e0e0e0e";
const device = "0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f";
const challenge = Buffer.alloc(32, 17).toString("base64");
const input = { collection, challenge };
const U64 = (1n << 64n) - 1n;
const bytes = s => Uint8Array.from(Buffer.from(s.replaceAll("-", ""), "hex"));
const key = n => new Uint8Array(32).fill(n);
const rootPk = key(6);
const rootId = new Uint8Array(createHash("sha256").update(rootPk).digest().subarray(0, 16));
function encoded() {
  return [1, new Map([[0, bytes(collection)], [1, bytes(device)], [2, key(1)], [3, key(2)], [4, key(3)],
    [5, U64], [6, U64], [7, U64], [8, [U64, key(4)]], [9, [U64, key(4)]],
    [10, rootId], [11, rootPk], [12, key(5)], [13, bytes(device)], [14, U64]])];
}
const post = (body = input, auth = `Bearer ${token}`, path = "/internal/v1/migration-admission") => new Request(`https://hosted.test${path}`, {
  method: "POST", headers: { authorization: auth }, body: JSON.stringify(body),
});
const compiled = await build({ entryPoints: [new URL("../src/worker.ts", import.meta.url).pathname], bundle: true, write: false, format: "esm", platform: "node", plugins: [{
  name: "platform-test", setup(b) {
    b.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: "platform", namespace: "fake" }));
    b.onLoad({ filter: /.*/, namespace: "fake" }, () => ({ contents: "export class DurableObject {}" }));
    b.onLoad({ filter: /hosted\.wasm$/ }, () => ({ contents: "export default new WebAssembly.Module(new Uint8Array([0,97,115,109,1,0,0,0]));" }));
  },
}] });
const { HostedCollection, default: worker } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString("base64")}`);
async function object() {
  const o = Object.create(HostedCollection.prototype);
  const wire = encoded();
  const engine = { admission: () => wire, wakeInstance: () => U64, noiseMatches: pk => Buffer.from(pk).equals(Buffer.from(key(3))) };
  const forbidden = () => { throw new Error("observation attempted side effect"); };
  Object.assign(o, { engine, collection, opening: null, escrow: false, env: { HOSTED_SERVICE_TOKEN: token },
    ready: forbidden, sync: forbidden, custody: { openSealer: forbidden }, ctx: { storage: new Proxy({}, { get: forbidden }) } });
  o.live = await o.liveAdmission(engine, collection, { device, publicKeys: { signPk: key(1), kemPk: key(2), noisePk: key(3) }, roots: [rootPk] });
  return { o, wire, engine };
}
const internal = () => post(input, `Bearer ${token}`, `/v1/hosted/migration-admission?collection=${collection}`);

test("request guard authenticates before body read; missing/short token and wrong method deny", async () => {
  for (const configured of [undefined, "short", token]) {
    let reads = 0;
    const req = new Request("https://hosted.test/internal/v1/migration-admission", { method: "POST", headers: { authorization: "Bearer wrong" },
      body: new ReadableStream({ pull() { reads++; } }, { highWaterMark: 0 }), duplex: "half" });
    assert.equal((await migrationAdmissionRequest(req, configured)).status, 401);
    assert.equal(reads, 0);
  }
  assert.equal((await migrationAdmissionRequest(new Request("https://hosted.test"), token)).status, 405);
});
test("exact bounded schema/challenge required, no caller authority or noncanonical base64", async () => {
  assert.deepEqual(await migrationAdmissionRequest(post(), token), input);
  for (const body of [{ collection }, { ...input, epoch: "1" }, { ...input, endpoint: "https://other.test" },
    { ...input, collection: collection.toUpperCase() }, { ...input, collection: "00000000-0000-0000-0000-000000000000" },
    { ...input, challenge: challenge.slice(0, -1) }, { ...input, challenge: "A".repeat(42) + "B=" },
    { ...input, challenge: Buffer.alloc(31).toString("base64") }, []]) {
    assert.equal((await migrationAdmissionRequest(post(body), token)).status, 400);
  }
});
test("request streams accept exact1024 and cancel/release at first oversized chunk", async () => {
  const json = JSON.stringify(input);
  const exact = new Request("https://hosted.test", { method: "POST", headers: { authorization: `Bearer ${token}` }, body: json + " ".repeat(1024 - json.length) });
  assert.deepEqual(await migrationAdmissionRequest(exact, token), input);
  let cancelled = 0;
  const oversized = new Request("https://hosted.test", { method: "POST", headers: { authorization: `Bearer ${token}` },
    body: new ReadableStream({ start(c) { c.enqueue(new Uint8Array(1024)); c.enqueue(new Uint8Array(1)); }, cancel() { cancelled++; } }), duplex: "half" });
  assert.equal((await migrationAdmissionRequest(oversized, token)).status, 400);
  assert.equal(cancelled, 1); assert.equal(oversized.body.locked, false);
});
test("invalid UTF8 or failed body read is a noncacheable refusal", async () => {
  for (const body of [new Uint8Array([0xff]), new ReadableStream({ start(c) { c.error(new Error("synthetic")); } })]) {
    const req = new Request("https://hosted.test", { method: "POST", headers: { authorization: `Bearer ${token}` }, body, duplex: "half" });
    const result = await migrationAdmissionRequest(req, token);
    assert.equal(result.status, 400); assert.equal(result.headers.get("cache-control"), "no-store");
  }
});
test("projection preserves fullu64 decimal and exact public schema without native/custody secrets", () => {
  const observed = migrationAdmissionObservation(encoded(), input, device);
  assert.deepEqual(observed, { schema: "mdbn-migration-admission/1", collection, device_id: device,
    epoch: U64.toString(), wake: U64.toString(), fault_generation: U64.toString(),
    applied_head: { seq: U64.toString(), chain: "04".repeat(32) }, authenticated_head: { seq: U64.toString(), chain: "04".repeat(32) },
    control_chain: "05".repeat(32), challenge });
});
test("projection denies Deny/bootstrap/identity drift/malformed/unsafe scalars and unequal heads", () => {
  for (const wire of [[0, 1], [2, encoded()[1]], null, [1, new Map()]]) assert.equal(migrationAdmissionObservation(wire, input, device), null);
  for (const [field, value] of [[5, 0], [5, Number(U64)], [6, -1n], [7, U64 + 1n], [8, [U64 - 1n, key(4)]], [9, [U64, key(7)]], [12, key(0)]]) {
    const wire = encoded(); wire[1].set(field, value);
    assert.equal(migrationAdmissionObservation(wire, input, device), null);
  }
  assert.equal(migrationAdmissionObservation(encoded(), input, collection), null);
});
test("Worker routes exact authenticated collection/challenge only, discarding caller Content-Length", async () => {
  const seen = []; const { o } = await object();
  const env = { HOSTED_SERVICE_TOKEN: token, COLLECTIONS: { idFromName(id) { assert.equal(id, collection); return id; },
    get() { return { async fetch(request) { seen.push(request); assert.equal(request.headers.get("content-length"), null); return o.fetch(request); } }; } } };
  const request = post(); request.headers.set("content-length", "900");
  const response = await worker.fetch(request, env);
  assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal((await response.json()).challenge, challenge); assert.equal(seen.length, 1);
  assert.equal(new URL(seen[0].url).pathname, "/v1/hosted/migration-admission");
  assert.equal((await worker.fetch(post({}, "Bearer wrong"), env)).status, 401); assert.equal(seen.length, 1);
});
test("escrow Worker/DO refuse observations before lookup/native/custody effects", async () => {
  const { o } = await object(); o.escrow = true;
  assert.equal((await o.fetch(internal())).status, 404);
  const forbidden = () => { throw Error("unexpected lookup"); };
  assert.equal((await worker.fetch(post(), { SERVICE_KIND: "escrow", COLLECTIONS: { idFromName: forbidden, get: forbidden } })).status, 404);
});
test("DO independently authenticates/binds collection and emits from current native observer without opening", async () => {
  const { o } = await object();
  assert.equal((await o.fetch(internal())).status, 200);
  assert.equal((await o.fetch(post(input, "Bearer wrong", `/v1/hosted/migration-admission?collection=${collection}`))).status, 401);
  assert.equal((await o.fetch(post({ ...input, collection: device }, `Bearer ${token}`, `/v1/hosted/migration-admission?collection=${collection}`))).status, 400);
});
test("cold/opening/reset/replaced Engine and absent live custody fail closed without ready/sync", async () => {
  for (const mutate of [o => { o.engine = null; }, o => { o.opening = Promise.resolve(); }, o => { o.live = null; },
    o => { o.engine = {}; }, o => { o.collection = device; }]) {
    const { o } = await object(); mutate(o);
    const response = await o.fetch(internal());
    assert.equal(response.status, 503); assert.equal(response.headers.get("cache-control"), "no-store");
  }
});
test("fault/epoch/wake/root/Noise/custody/head drift refuses immediately", async () => {
  for (const mutate of [w => { w[0] = 0; }, w => { w[1].set(5, U64 - 1n); }, w => { w[1].set(7, 0); },
    w => { w[1].set(11, key(9)); }, w => { w[1].set(4, key(9)); }, w => { w[1].set(2, key(9)); },
    w => { w[1].set(9, [U64 - 1n, key(4)]); }]) {
    const { o, wire } = await object(); mutate(wire);
    assert.equal((await o.fetch(internal())).status, 503);
  }
});
test("retirement during authenticated body await is observed before output", async () => {
  const { o } = await object();
  const request = new Request(`https://hosted.test/v1/hosted/migration-admission?collection=${collection}`, { method: "POST", headers: { authorization: `Bearer ${token}` },
    body: new ReadableStream({ pull(c) { o.engine = null; o.live = null; c.enqueue(new TextEncoder().encode(JSON.stringify(input))); c.close(); } }, { highWaterMark: 0 }), duplex: "half" });
  assert.equal((await o.fetch(request)).status, 503);
});
