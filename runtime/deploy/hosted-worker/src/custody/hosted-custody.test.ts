import assert from "node:assert/strict";
import test from "node:test";
import { HostedCustody, type HostedControlPort, type HostedDeviceRecord } from "./hosted-custody.ts";
import { encodeEnvelope } from "./envelope.ts";

// Non-deployable unit data; mocks are not a LAB identity/crypto/KMS fixture.
const COL = "11111111-1111-4111-8111-111111111111";
const DEV = "22222222-2222-4222-8222-222222222222";
const ROOT = "44444444-4444-4444-8444-444444444444";
const ARN = "arn:aws:kms:us-east-1:000000000000:key/33333333-3333-4333-8333-333333333333";
const NOW = Date.UTC(2026, 9, 6);
const token = "ab".repeat(50) + "." + "cd".repeat(64);
const config = () => ({ collection: COL, replicaId: COL, keyArn: ARN, roots: [new Uint8Array(32).fill(4)], policyPins: Uint8Array.of(0x80), signers: [ROOT] });
const record = (): HostedDeviceRecord => ({ kind: "hosted", deviceId: DEV, signPk: new Uint8Array(32).fill(1), kemPk: new Uint8Array(32).fill(2), noisePk: new Uint8Array(32).fill(3), wrappedKeys: encodeEnvelope(ARN, Uint8Array.of(1, 2)), kmsKeyArn: ARN, genesis: { seq: 1, item: Uint8Array.of(0xa0), hash: new Uint8Array(32).fill(5) } });
const signal = () => new AbortController().signal;
const secret = () => Uint8Array.from([...new Uint8Array(32).fill(11), ...new Uint8Array(32).fill(12), ...new Uint8Array(32).fill(13)]);
function setup(options: {
  read?: () => Promise<HostedDeviceRecord>;
  unwrap?: () => Promise<Uint8Array>;
  derive?: () => HostedDeviceRecord | null;
  issue?: () => Promise<{token: string; expiresAt: number}>;
  now?: () => number;
  verify?: () => boolean;
} = {}) {
  let forgets = 0, reads = 0, unwraps = 0, issues = 0;
  const plain = secret();
  const control: HostedControlPort = {
    serviceDevice: async collection => { assert.equal(collection, COL); reads++; return options.read ? options.read() : record(); },
    logToken: async (device, collection) => { assert.equal(device, DEV); assert.equal(collection, COL); issues++; return options.issue ? options.issue() : {token, expiresAt: NOW + 900_000}; },
    forget: collection => { assert.equal(collection, COL); forgets++; },
  };
  const custody = new HostedCustody(config(), control, { unwrapDeviceKeys: async (collection, device, envelope, arn) => {
    assert.equal(collection, COL); assert.equal(device, DEV); assert.equal(arn, ARN); assert.deepEqual(envelope, record().wrappedKeys);
    unwraps++; return options.unwrap ? options.unwrap() : plain;
  } }, () => options.derive ? options.derive() : record(), () => options.verify ? options.verify() : true, options.now ?? (() => NOW));
  return { custody, plain, counts: () => ({forgets, reads, unwraps, issues}) };
}

test("open rechecks CP tuple, wipes raw96, returns one wipeable key lease with Noise", async () => {
  const {custody, plain, counts} = setup();
  const keys = await custody.openSealer(COL, signal());
  assert.equal(keys.deviceId, DEV);
  assert.deepEqual(keys.signSk, new Uint8Array(32).fill(11));
  assert.deepEqual(keys.kemSk, new Uint8Array(32).fill(12));
  assert.deepEqual(keys.noiseSk, new Uint8Array(32).fill(13));
  assert(plain.every(b => b === 0));
  assert.equal(counts().reads, 2);
  await assert.rejects(custody.openSealer(COL, signal()), /custody_unavailable/);
  keys.zeroize(); keys.zeroize();
  assert(keys.signSk.every(b => b === 0) && keys.kemSk.every(b => b === 0) && keys.noiseSk.every(b => b === 0));
});

test("public native refusal prevents unwrap, derivation and token mint", async () => {
  let verifies = 0, derives = 0;
  const s = setup({ verify: () => { verifies++; return false; }, derive: () => { derives++; return record(); } });
  await assert.rejects(s.custody.openSealer(COL, signal()), /custody_invalid_record/);
  await assert.rejects(s.custody.logToken(COL, signal()));
  assert.equal(verifies, 2); assert.equal(derives, 0);
  assert.equal(s.counts().unwraps, 0); assert.equal(s.counts().issues, 0);
});

test("original witness is owned and cannot change across KMS await", async () => {
  const shared = record();
  const s = setup({ read: async () => shared, unwrap: async () => { shared.genesis.item[0] ^= 1; return s.plain; } });
  await assert.rejects(s.custody.openSealer(COL, signal()), /custody_record_changed/);
  assert(s.plain.every(b => b === 0));
});

test("every derived tuple component must match; failure wipes raw secret", async () => {
  for (const field of ["signPk", "kemPk", "noisePk"] as const) {
    const {custody, plain} = setup({derive: () => ({...record(), [field]: new Uint8Array(32).fill(9)})});
    await assert.rejects(custody.openSealer(COL, signal()), /custody_identity_mismatch/);
    assert(plain.every(b => b === 0));
  }
});

test("wrong role, zero Noise, foreign ARN and malformed envelope never unwrap", async () => {
  for (const value of [
    {...record(), kind: "escrow"}, {...record(), noisePk: new Uint8Array(32)},
    {...record(), kmsKeyArn: "foreign"}, {...record(), wrappedKeys: Uint8Array.of(1)},
  ]) {
    const {custody, counts} = setup({read: async () => value as HostedDeviceRecord});
    await assert.rejects(custody.openSealer(COL, signal()));
    assert.equal(counts().unwraps, 0);
  }
});

test("async record/identity change refuses handoff and clears secrets", async () => {
  let reads = 0;
  const {custody, plain} = setup({read: async () => ++reads === 1 ? record() : {...record(), deviceId: ROOT}});
  await assert.rejects(custody.openSealer(COL, signal()), /custody_record_changed/);
  assert(plain.every(b => b === 0));
});

test("CP owns byte arrays cannot mutate first tuple across unwrap await", async () => {
  const shared = record();
  let reads = 0;
  const {custody, plain} = setup({read: async () => { reads++; return shared; }, unwrap: async () => {
    shared.signPk.fill(9); return plain;
  }});
  await assert.rejects(custody.openSealer(COL, signal()), /custody_record_changed/);
  assert.equal(reads, 2);
  assert(plain.every(b => b === 0));
});

test("close during await prevents handoff; close wipes outstanding lease", async () => {
  let release!: (plain: Uint8Array) => void;
  const deferred = new Promise<Uint8Array>(resolve => { release = resolve; });
  const s = setup({unwrap: () => deferred});
  const open = s.custody.openSealer(COL, signal());
  await new Promise(resolve => setImmediate(resolve));
  s.custody.close(); release(s.plain);
  await assert.rejects(open, /custody_aborted/);
  assert(s.plain.every(b => b === 0));
  const other = setup();
  const keys = await other.custody.openSealer(COL, signal());
  other.custody.close();
  assert(keys.signSk.every(b => b === 0) && keys.kemSk.every(b => b === 0) && keys.noiseSk.every(b => b === 0));
  await assert.rejects(other.custody.logToken(COL, signal()));
});

test("terminal close aborts CP work and immediately wipes pending raw keys", async () => {
  let reads = 0, seen!: AbortSignal, release!: () => void;
  const deferred = new Promise<void>(resolve => {release = resolve;});
  const raw = secret();
  const control: HostedControlPort = {
    serviceDevice: async (_, sig) => {seen = sig; if (++reads === 2) await deferred; return record();},
    logToken: async () => ({token, expiresAt: NOW + 900_000}), forget: () => {},
  };
  const custody = new HostedCustody(config(), control, {unwrapDeviceKeys: async () => raw}, () => record(), () => true);
  const work = custody.openSealer(COL, signal());
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reads, 2); assert.equal(raw[0], 11);
  custody.close(); assert(seen.aborted); assert(raw.every(b => b === 0));
  release(); await assert.rejects(work, /custody_aborted/);
});

test("fail closed on abort, bad secret length, unavailable ports and raw error data", async () => {
  const short = new Uint8Array(95).fill(4);
  const bad = setup({unwrap: async () => short});
  await assert.rejects(bad.custody.openSealer(COL, signal()), /custody_secret_invalid/);
  assert(short.every(b => b === 0));
  const controller = new AbortController();
  const s = setup({unwrap: async () => {controller.abort(); return s.plain;}});
  await assert.rejects(s.custody.openSealer(COL, controller.signal), /custody_aborted/);
  assert(s.plain.every(b => b === 0));
  const throwing = setup({read: async () => { throw new Error("SENSITIVE_BODY"); }});
  await assert.rejects(throwing.custody.openSealer(COL, signal()), (e: Error) => e.message === "custody_unavailable");
});

test("token checks device/current tuple and expiry at completion, never adapter-cached", async () => {
  const {custody, counts} = setup();
  assert.equal(await custody.logToken(COL, signal()), token);
  assert.equal(await custody.logToken(COL, signal()), token);
  assert.deepEqual(counts(), {reads: 4, issues: 2, unwraps: 0, forgets: 2});
  for (const result of [
    {token, expiresAt: NOW + 59_999}, {token, expiresAt: NOW + 2_000_000},
    {token: "x".repeat(8193), expiresAt: NOW + 900_000}, {token: "malformed", expiresAt: NOW + 900_000},
  ]) {
    const s = setup({issue: async () => result});
    await assert.rejects(s.custody.logToken(COL, signal()), /custody_unavailable/);
    assert.equal(s.counts().forgets, 1);
  }
  let time = NOW, reads = 0;
  const late = setup({now: () => time, read: async () => {if (++reads === 2) time += 899_000; return record();}});
  await assert.rejects(late.custody.logToken(COL, signal()));
});

test("token lookup disappearance or changed identity never issues stale authority", async () => {
  let reads = 0;
  const s = setup({read: async () => {if (++reads === 2) throw new Error("revoked"); return record();}});
  await assert.rejects(s.custody.logToken(COL, signal()));
  assert.equal(s.counts().forgets, 1);
});

test("public winner remains bound after key handoff; replacement cannot mint another token", async () => {
  let replacement = false;
  const s = setup({read: async () => replacement ? {...record(), deviceId: ROOT} : record()});
  (await s.custody.openSealer(COL, signal())).zeroize();
  replacement = true;
  await assert.rejects(s.custody.logToken(COL, signal()));
  assert.equal(s.counts().issues, 0);
  await assert.rejects(s.custody.openSealer(COL, signal()), /custody_record_changed/);
});

test("one scoped call at a time, no waiting queue or cross-collection work", async () => {
  let release!: () => void;
  const deferred = new Promise<void>(resolve => {release = resolve;});
  const s = setup({read: async () => {await deferred; return record();}});
  const open = s.custody.openSealer(COL, signal());
  await assert.rejects(s.custody.logToken(COL, signal()), /custody_unavailable/);
  await assert.rejects(s.custody.openSealer(ROOT, signal()), /custody_unavailable/);
  release(); (await open).zeroize();
});

test("independent roots/signers are copied, nonempty and bounded", async () => {
  for (const cfg of [{...config(), roots: []}, {...config(), signers: []}, {...config(), roots: Array.from({length: 65}, () => new Uint8Array(32).fill(1))}]) {
    assert.throws(() => new HostedCustody(cfg, {} as HostedControlPort, {unwrapDeviceKeys: async () => secret()}, () => record(), () => true));
  }
  const cfg = config();
  const control: HostedControlPort = { serviceDevice: async () => record(), logToken: async () => ({token, expiresAt: NOW + 900_000}), forget: () => {} };
  const custody = new HostedCustody(cfg, control, {unwrapDeviceKeys: async () => secret()}, () => record(), () => true);
  cfg.roots[0].fill(0); cfg.signers[0] = DEV;
  const keys = await custody.openSealer(COL, signal());
  assert(keys.roots[0].every(b => b === 4)); assert.deepEqual(keys.signers, [ROOT]);
  keys.zeroize();
});
