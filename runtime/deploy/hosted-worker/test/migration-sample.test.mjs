// The read-only migration digest sample: request bounds and authentication, the
// native reply checked against the request, and the actual DO handler gated on
// native step verified..routed. Synthetic platform/native ports only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { decode, encode } from "../../../packages/sdk/src/cbor.ts";
import { migrationSampleBody, migrationSampleRequest, nativeSampleRequest } from "../src/migration-sample.ts";

const VERIFIED = "af000101782431303030303030302d303030302d343030302d383030302d3030303030303030303030310208070409f50a110e00140015f5165820a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1175820a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a11818061819185b181a03181b1a0002bf3a";
const collection = "10000000-0000-4000-8000-000000000001";
const r1 = "30000000-0000-4000-8000-000000000001", r2 = "30000000-0000-4000-8000-000000000002";
const f1 = "40000000-0000-4000-8000-000000000001";
const token = "synthetic-service-token".repeat(3);
const id = u => new Uint8Array(Buffer.from(u.replaceAll("-", ""), "hex"));
const post = (body, auth = token, path = "https://hosted.test/internal/v1/migration/sample") =>
  new Request(path, { method: "POST", headers: { authorization: `Bearer ${auth}` }, body: typeof body === "string" ? body : JSON.stringify(body) });

test("requests are service-authenticated, exact and bounded to 5 records and 1 file", async () => {
  const ok = await migrationSampleRequest(post({ collection, records: [r1, r2], files: [f1] }), token);
  assert.deepEqual(ok, { collection, records: [r1, r2], files: [f1] });
  assert.deepEqual(await migrationSampleRequest(post({ collection, records: [], files: [f1] }), token), { collection, records: [], files: [f1] });
  assert.equal((await migrationSampleRequest(post({ collection, records: [r1], files: [] }, "wrong".repeat(10)), token)).status, 401);
  assert.equal((await migrationSampleRequest(new Request("https://h.test/", { method: "GET" }), token)).status, 405);
  const many = Array.from({ length: 6 }, (_, i) => `30000000-0000-4000-8000-00000000000${i}`);
  for (const bad of [
    { collection, records: [], files: [] },
    { collection, records: many, files: [] },
    { collection, records: [], files: [f1, r1] },
    { collection, records: [r1, r1], files: [] },
    { collection, records: ["3000000a-0000-4000-8000-00000000000b".toUpperCase()], files: [] },
    { collection, records: ["00000000-0000-0000-0000-000000000000"], files: [] },
    { collection, records: [r1] },
    { collection, records: [r1], files: [], extra: 1 },
    { collection: "nope", records: [r1], files: [] },
    [collection], "not json", "x".repeat(2048),
  ]) {
    const r = await migrationSampleRequest(post(bad), token);
    assert.ok(r instanceof Response && r.status === 400, JSON.stringify(bad).slice(0, 80));
  }
});

test("the native request is ID bytes only and the reply must answer exactly what was asked", () => {
  const input = { collection, records: [r1, r2], files: [f1] };
  assert.deepEqual(decode(nativeSampleRequest(input)), [[id(r1), id(r2)], [id(f1)]]);
  const digest = new Uint8Array(32).fill(0xc3);
  const reply = [[[id(r1), 1, digest, 12], [id(r2), 0, null, null]], [[id(f1), 2, null, null]]];
  assert.deepEqual(migrationSampleBody(input, 13, reply), {
    collection, step: 13,
    records: [{ id: r1, state: "present", digest: `sha256:${"c3".repeat(32)}`, size: 12 },
      { id: r2, state: "missing", digest: null, size: null }],
    files: [{ id: f1, state: "unsupported", digest: null, size: null }],
  });
  for (const bad of [
    [[[id(r2), 1, digest, 12], [id(r1), 0, null, null]], [[id(f1), 2, null, null]]], // order/ID mismatch
    [[[id(r1), 1, digest, 12]], [[id(f1), 2, null, null]]], // a record missing
    [[[id(r1), 1, null, 12], [id(r2), 0, null, null]], [[id(f1), 2, null, null]]], // present without digest
    [[[id(r1), 0, digest, null], [id(r2), 0, null, null]], [[id(f1), 2, null, null]]], // missing with a digest
    [[[id(r1), 3, null, null], [id(r2), 0, null, null]], [[id(f1), 2, null, null]]], // unknown state
    [[[id(r1), 1, digest, -1], [id(r2), 0, null, null]], [[id(f1), 2, null, null]]],
    [[[id(r1), 1, digest, 12, "extra"], [id(r2), 0, null, null]], [[id(f1), 2, null, null]]],
    "junk",
  ]) assert.throws(() => migrationSampleBody(input, 13, bad), /migration_sample_invalid/);
});

// Actual DO handler with synthetic ports.
const compiled = await build({ entryPoints: [new URL("../src/worker.ts", import.meta.url).pathname], bundle: true,
  write: false, format: "esm", platform: "node", plugins: [{ name: "platform-test", setup(b) {
    b.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: "platform", namespace: "fake" }));
    b.onLoad({ filter: /.*/, namespace: "fake" }, () => ({ contents: "export class DurableObject {}" }));
    b.onResolve({ filter: /hosted\.wasm$/ }, () => ({ path: "hosted.wasm", namespace: "native-test" }));
    b.onLoad({ filter: /hosted\.wasm$/, namespace: "native-test" }, () => ({ contents: "export default new WebAssembly.Module(new Uint8Array([0,97,115,109,1,0,0,0]));" }));
  } }] });
const { HostedCollection } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString("base64")}`);

function checkpoint(step) {
  const m = new Map(decode(new Uint8Array(Buffer.from(VERIFIED, "hex"))));
  m.set(2, step);
  return encode(m);
}

function actor({ step = 13, sample = () => encode([[[id(r1), 1, new Uint8Array(32).fill(7), 5]], []]), ready } = {}) {
  const calls = [];
  const o = Object.create(HostedCollection.prototype);
  const engine = { migrationSample: bytes => { calls.push(["sample", decode(bytes)]); return decode(sample()); } };
  const cp = step === null ? null : checkpoint(step);
  Object.assign(o, { escrow: false, env: { HOSTED_SERVICE_TOKEN: token }, requirePhysicalCollection: () => calls.push(["physical"]),
    ready: ready ?? (async c => { calls.push(["ready", c]); return engine; }),
    ctx: { storage: { sql: { exec: (q, name) => ({ toArray: () => {
      if (q.includes("sqlite_master")) return name === "mig_checkpoint" && cp ? [{ 1: 1 }] : [];
      if (q.includes("FROM mig_checkpoint")) return cp ? [{ v: cp.buffer.slice(cp.byteOffset, cp.byteOffset + cp.byteLength) }] : [];
      return [];
    } }) } } } });
  return { o, calls };
}
const local = (body, auth) => post(body, auth, `https://hosted.test/v1/hosted/migration/sample?collection=${collection}`);

test("the DO answers digests from native once verified, and refuses before, after rollback, or foreign", async () => {
  const { o, calls } = actor();
  const response = await o.fetch(local({ collection, records: [r1], files: [] }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { collection, step: 13,
    records: [{ id: r1, state: "present", digest: `sha256:${"07".repeat(32)}`, size: 5 }], files: [] });
  assert.deepEqual(calls, [["physical"], ["ready", collection], ["sample", [[id(r1)], []]]]);

  for (const step of [null, 7, 20, 21, 22]) {
    const { o, calls } = actor({ step });
    const r = await o.fetch(local({ collection, records: [r1], files: [] }));
    assert.equal(r.status, 409, `step ${step}`);
    assert.deepEqual(await r.json(), { error: "migration_not_verified" });
    assert.ok(!calls.some(([c]) => c === "ready" || c === "sample"), "no engine before the gate");
  }
  const foreign = actor();
  assert.equal((await foreign.o.fetch(local({ collection: r2, records: [r1], files: [] }))).status, 400);
  assert.equal((await foreign.o.fetch(local({ collection, records: [r1], files: [] }, "bad".repeat(20)))).status, 401);
  assert.deepEqual(foreign.calls, []);

  // Native refusal or a reply that does not match: a finite 503, no detail.
  for (const sample of [() => { throw new Error("migration_sample_refused"); }, () => encode([[], []])]) {
    const { o } = actor({ sample });
    const r = await o.fetch(local({ collection, records: [r1], files: [] }));
    assert.equal(r.status, 503);
    assert.deepEqual(await r.json(), { error: "migration_sample_unavailable" });
  }
  const escrow = actor();
  escrow.o.escrow = true;
  assert.equal((await escrow.o.fetch(local({ collection, records: [r1], files: [] }))).status, 404);
});
