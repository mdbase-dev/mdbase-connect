import assert from "node:assert/strict";
import test from "node:test";
import { pitrFactory } from "../src/pitr-factory.ts";
import { parsePitrBinding, PITR_RUN } from "../src/pitr-phase.ts";
import { distinctServiceTokens, generateServiceDevice } from "../src/service-devices.ts";

const A = "11111111-1111-4111-8111-111111111111", D = "22222222-2222-4222-8222-222222222222";
const binding = { run: PITR_RUN, active: A, deleted: D, codeConfigSha256: "c".repeat(64), members: [
  { kind: "log", collection: A, namespace: "a".repeat(32), object: "1".repeat(64) },
  { kind: "log", collection: D, namespace: "a".repeat(32), object: "2".repeat(64) },
  { kind: "registry", collection: "00000000-0000-0000-0000-000000000000", namespace: "a".repeat(32), object: "3".repeat(64) },
  { kind: "hosted", collection: A, namespace: "b".repeat(32), object: "4".repeat(64) },
  { kind: "hosted", collection: D, namespace: "b".repeat(32), object: "5".repeat(64) }
] };
const settings = { LAB: "1", SERVICE_KIND: "hosted", PITR_BINDING: JSON.stringify(binding), PITR_MINIMUM_EPOCH: "7" };
const token = "h".repeat(40), escrowToken = "e".repeat(40);
const request = (collection = A, credential = token) => new Request("https://synthetic.test/internal/v1/service-devices", {
  method: "POST", headers: { authorization: `Bearer ${credential}` }, body: JSON.stringify({ collection })
});
function record(phase = "seed", epoch = 7) {
  const now = Date.now();
  return { schema: "mdbn-lab-pitr-phase/1", binding, epoch, phase, issuedAt: now - 1, expiresAt: now + 60000 };
}
function object(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return { size: bytes.length, body: new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } }) };
}
function fixture(get = async () => object(record())) {
  const keys = { secret: new Uint8Array(96).fill(23), signPk: new Uint8Array(32).fill(2), kemPk: new Uint8Array(32).fill(3), noisePk: new Uint8Array(32).fill(4) };
  let generated = 0, wrapped = 0, reads = 0;
  const bucket = { async get(key) { reads++; assert.equal(key, `${PITR_RUN}/phase.json`); return get(); } };
  const factory = pitrFactory(settings, bucket);
  const deps = { serviceToken: token, kind: "escrow", allowed: factory.seedGuard(),
    generate() { generated++; return keys; }, // Synthetic keys: routing/wiping test, NOT real engine qualification.
    wrapper: { async wrapDeviceKeys() { wrapped++; return { envelope: new Uint8Array([1, 2]), kmsKeyArn: "arn:synthetic:lab" }; } }
  };
  return { deps, keys, bucket, counts: () => ({ generated, wrapped, reads }) };
}
test("deployment binding parses only exact bounded fixed-five configuration and freezes it", () => {
  const b = parsePitrBinding(settings.PITR_BINDING);
  assert.deepEqual(b, binding); assert.ok(Object.isFrozen(b)); assert.ok(Object.isFrozen(b.members[0]));
  for (const text of [undefined, "{", "null", " ".repeat(4097), JSON.stringify({ ...binding, extra: true })]) assert.equal(parsePitrBinding(text), null);
});
for (const [name, change] of [
  ["non-LAB", { LAB: "0" }], ["escrow actor deployment", { SERVICE_KIND: "escrow" }],
  ["fixture custody", { LAB_HOSTED_CONFIG: "" }], ["missing binding", { PITR_BINDING: undefined }],
  ["missing floor", { PITR_MINIMUM_EPOCH: undefined }], ["zero floor", { PITR_MINIMUM_EPOCH: "0" }],
  ["unsafe floor", { PITR_MINIMUM_EPOCH: "9007199254740992" }]
]) test(`refuses ${name} without R2 I/O`, () => {
  const f = fixture(); assert.equal(pitrFactory({ ...settings, ...change }, f.bucket), null); assert.equal(f.counts().reads, 0);
});
test("missing R2 store and indistinguishable/short role tokens close", () => {
  assert.equal(pitrFactory(settings, undefined), null);
  assert.equal(distinctServiceTokens(token, token), false);
  assert.equal(distinctServiceTokens(token, "short"), false);
  assert.equal(distinctServiceTokens(undefined, escrowToken), false);
  assert.equal(distinctServiceTokens(token, escrowToken), true);
});
for (const phase of ["closed", "mutate", "authority", "readback"]) test(`valid ${phase} is not seed admission`, async () => {
  const f = fixture(async () => object(record(phase)));
  assert.equal((await generateServiceDevice(request(), f.deps)).status, 503);
  assert.deepEqual(f.counts(), { generated: 0, wrapped: 0, reads: 1 });
});
for (const [name, get] of [["null", async () => null], ["metadata only", async () => ({ size: 1 })],
  ["unavailable", async () => { throw Error("synthetic"); }], ["old epoch", async () => object(record("seed", 6))],
  ["expired", async () => object({ ...record(), expiresAt: Date.now() - 1 })]]) test(`R2 ${name} closes before generation`, async () => {
  const f = fixture(get); assert.equal((await generateServiceDevice(request(), f.deps)).status, 503);
  assert.equal(f.counts().generated, 0);
});
test("wrong role token and foreign/nil UUID never generate keys or read R2", async () => {
  for (const [collection, credential, status] of [[A, escrowToken, 401], [D, "wrong", 401], ["00000000-0000-0000-0000-000000000000", token, 503], ["33333333-3333-4333-8333-333333333333", token, 503]]) {
    const f = fixture(); assert.equal((await generateServiceDevice(request(collection, credential), f.deps)).status, status);
    assert.deepEqual(f.counts(), { generated: 0, wrapped: 0, reads: 0 });
  }
});
test("seed uses canonical wrapping/wiping, returns the original role and performs two fresh reads", async () => {
  const f = fixture(); const response = await generateServiceDevice(request(), f.deps);
  assert.equal(response.status, 200); assert.equal((await response.json()).kind, "escrow");
  assert.deepEqual(f.counts(), { generated: 1, wrapped: 1, reads: 2 }); assert.ok(f.keys.secret.every(v => v === 0));
});
for (const final of [record("closed"), record("seed", 8)]) test(`phase/epoch drift after wrap withholds record (epoch ${final.epoch})`, async () => {
  let reads = 0; const f = fixture(async () => object(++reads === 1 ? record() : final));
  assert.equal((await generateServiceDevice(request(), f.deps)).status, 503);
  assert.ok(f.keys.secret.every(v => v === 0)); assert.equal(f.counts().wrapped, 1);
});
test("unavailable final check withholds the already-wiped wrapped record", async () => {
  let reads = 0; const f = fixture(async () => ++reads === 1 ? object(record()) : null);
  assert.equal((await generateServiceDevice(request(), f.deps)).status, 503); assert.ok(f.keys.secret.every(v => v === 0));
});
test("a per-request seed guard cannot switch collection identity", async () => {
  const f = fixture(); assert.equal(await f.deps.allowed(A), true); assert.equal(await f.deps.allowed(D), false);
});
