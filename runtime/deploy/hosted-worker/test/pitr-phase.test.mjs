import assert from "node:assert/strict";
import test from "node:test";
import { PITR_RUN, parsePitrPhase, readPitrPhase } from "../src/pitr-phase.ts";

const A = "11111111-1111-4111-8111-111111111111";
const D = "22222222-2222-4222-8222-222222222222";
const NIL = "00000000-0000-0000-0000-000000000000";
const NS = "a".repeat(32), HOSTED = "b".repeat(32);
function binding() {
  return { run: PITR_RUN, active: A, deleted: D, codeConfigSha256: "c".repeat(64), members: [
    { kind: "log", collection: A, namespace: NS, object: "1".repeat(64) },
    { kind: "log", collection: D, namespace: NS, object: "2".repeat(64) },
    { kind: "registry", collection: NIL, namespace: NS, object: "3".repeat(64) },
    { kind: "hosted", collection: A, namespace: HOSTED, object: "4".repeat(64) },
    { kind: "hosted", collection: D, namespace: HOSTED, object: "5".repeat(64) },
  ] };
}
function record() {
  return { schema: "mdbn-lab-pitr-phase/1", binding: binding(), epoch: 7,
    phase: "mutate", issuedAt: 1000, expiresAt: 2000 };
}
function parse(r = record(), b = binding(), now = 1500, epoch = 7) {
  return parsePitrPhase(JSON.stringify(r), b, now, epoch);
}
function object(bytes, size = bytes.length) {
  return { size, body: new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } }) };
}
const encode = r => new TextEncoder().encode(JSON.stringify(r));

test("exact fixed run/five objects roundtrip, independently reconstructed", () => {
  const r = record(), b = binding();
  assert.deepEqual(parse(r, b), r);
  const parsed = parse(r, b); b.members[0].object = "f".repeat(64);
  assert.equal(parsed.binding.members[0].object, "1".repeat(64));
});
test("all declared phases (including CLOSED) parse but confer no CP permission", () => {
  for (const phase of ["closed", "seed", "mutate", "authority", "readback"]) {
    const r = record(); r.phase = phase; assert.equal(parse(r).phase, phase);
  }
});
test("membership ordering is not identity", () => {
  const r = record(); r.binding.members.reverse(); assert.ok(parse(r));
});
for (const [name, mutate] of [
  ["run", r => { r.binding.run = "other-run"; }],
  ["original collection", r => { r.binding.active = "33333333-3333-4333-8333-333333333333"; }],
  ["code/config", r => { r.binding.codeConfigSha256 = "d".repeat(64); }],
  ["actual object", r => { r.binding.members[0].object = "9".repeat(64); }],
  ["actual namespace", r => { r.binding.members[0].namespace = "d".repeat(32); }],
  ["extra escrow actor", r => { r.binding.members.push({ ...r.binding.members[4], kind: "escrow" }); }],
  ["missing member", r => { r.binding.members.pop(); }],
  ["duplicate member", r => { r.binding.members[4] = { ...r.binding.members[3] }; }],
  ["caller permit", r => { r.currentCpVerified = true; }],
  ["member extension", r => { r.binding.members[0].allow = true; }],
  ["future issuance", r => { r.issuedAt = 1501; }],
  ["expired", r => { r.expiresAt = 1500; }],
  ["over two-hour window", r => { r.expiresAt = r.issuedAt + 7200001; }],
  ["old epoch", r => { r.epoch = 6; }],
  ["fractional epoch", r => { r.epoch = 7.5; }],
  ["unknown phase", r => { r.phase = "serve-anything"; }],
  ["malformed role", r => { r.binding.members[0].kind = { toString: null, valueOf: null }; }],
]) test(`refuses ${name}`, () => { const r = record(); mutate(r); assert.equal(parse(r), null); });
test("invalid runtime binding never reads R2", async () => {
  const b = binding(); b.members[2].collection = A;
  let reads = 0;
  assert.equal(await readPitrPhase(async () => { reads++; return object(encode(record())); }, b, () => 1500, () => 7), null);
  assert.equal(reads, 0);
});
test("missing/malformed/oversize records and unsafe clock/epoch stay closed", () => {
  for (const text of [null, "{", "null", "[]", " ".repeat(4097)]) assert.equal(parsePitrPhase(text, binding(), 1500, 7), null);
  for (const now of [NaN, Infinity, -1, 1500.1]) assert.equal(parse(record(), binding(), now), null);
  for (const epoch of [NaN, 0, -1, 1.5]) assert.equal(parse(record(), binding(), 1500, epoch), null);
});
test("R2 absence/read rejection/invalid UTF-8/length mismatch stay closed", async () => {
  for (const get of [async () => null, async () => { throw new Error("synthetic unavailable"); },
    async () => object(new Uint8Array([255])), async () => object(encode(record()), 0),
    async () => object(new Uint8Array(4097))]) {
    assert.equal(await readPitrPhase(get, binding(), () => 1500, () => 7), null);
  }
});
test("clock and external minimum epoch are checked AFTER asynchronous body read", async () => {
  const bytes = encode(record()); let now = 1500, epoch = 7;
  const get = async () => { now = 2000; return object(bytes); };
  assert.equal(await readPitrPhase(get, binding(), () => now, () => epoch), null);
  now = 1500;
  assert.equal(await readPitrPhase(async () => { epoch = 8; return object(bytes); }, binding(), () => now, () => epoch), null);
});
test("R2 size claim cannot bypass streaming cap", async () => {
  let cancelled = false;
  const body = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(4097)); }, cancel() { cancelled = true; } });
  assert.equal(await readPitrPhase(async () => ({ size: 100, body }), binding(), () => 1500, () => 7), null);
  assert.equal(cancelled, true);
});
test("bounded R2 read returns exact metadata only", async () => {
  assert.deepEqual(await readPitrPhase(async () => object(encode(record())), binding(), () => 1500, () => 7), record());
});
test("configured binding cannot drift with a matching body during get", async () => {
  const b = binding(), r = record();
  assert.equal(await readPitrPhase(async () => {
    b.codeConfigSha256 = r.binding.codeConfigSha256 = "d".repeat(64);
    return object(encode(r));
  }, b, () => 1500, () => 7), null);
});
test("binding snapshot rejects drift during body I/O and final clock evaluation", async () => {
  for (const atClock of [false, true]) {
    const b = binding(), bytes = encode(record());
    const body = new ReadableStream({ pull(c) {
      if (!atClock) b.members[0].object = "f".repeat(64);
      c.enqueue(bytes); c.close();
    } });
    const clock = () => { if (atClock) b.members[0].object = "f".repeat(64); return 1500; };
    assert.equal(await readPitrPhase(async () => ({ size: bytes.length, body }), b, clock, () => 7), null);
  }
});
test("empty chunks have fixed read-work and cleanup bounds", async () => {
  let pulls = 0, cancelled = false;
  const body = new ReadableStream({ pull(c) { pulls++; c.enqueue(new Uint8Array()); }, cancel() { cancelled = true; } });
  assert.equal(await readPitrPhase(async () => ({ size: 0, body }), binding(), () => 1500, () => 7), null);
  assert.ok(pulls <= 65, "64 reads plus at most one stream-prefetch");
  assert.equal(cancelled, true); assert.equal(body.locked, false);
});
test("metadata rejection cancels its unused body", async () => {
  let cancelled = false;
  const body = new ReadableStream({ cancel() { cancelled = true; } });
  assert.equal(await readPitrPhase(async () => ({ size: 4097, body }), binding(), () => 1500, () => 7), null);
  assert.equal(cancelled, true); assert.equal(body.locked, false);
});
const turn = () => new Promise(resolve => setImmediate(resolve));
test("get timeout aborts transport and cancels an eventual late body", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let signal, finish, cancelled = false;
  const pending = new Promise(resolve => { finish = resolve; });
  const result = readPitrPhase(s => { signal = s; return pending; }, binding(), () => 1500, () => 7);
  t.mock.timers.tick(5000);
  assert.equal(await result, null); assert.equal(signal.aborted, true);
  const body = new ReadableStream({ cancel() { cancelled = true; } });
  finish({ size: 1, body }); await turn();
  assert.equal(cancelled, true);
});
test("body timeout closes, cancels and releases the reader", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let cancelled = false;
  const body = new ReadableStream({ cancel() { cancelled = true; } });
  const result = readPitrPhase(async () => ({ size: 1, body }), binding(), () => 1500, () => 7);
  await turn(); t.mock.timers.tick(5000);
  assert.equal(await result, null); assert.equal(cancelled, true); assert.equal(body.locked, false);
});
test("cleanup uses the same deadline, never waits indefinitely", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let cancelled = false;
  const body = new ReadableStream({ cancel() { cancelled = true; return new Promise(() => {}); } });
  const result = readPitrPhase(async () => ({ size: 4097, body }), binding(), () => 1500, () => 7);
  await turn(); assert.equal(cancelled, true); t.mock.timers.tick(5000);
  assert.equal(await result, null); assert.equal(body.locked, false);
});
