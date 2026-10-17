import assert from "node:assert/strict";
import test from "node:test";
import { HostedCustody, type HostedControlPort, type HostedDeviceRecord } from "./hosted-custody.ts";
import { encodeEnvelope } from "./envelope.ts";
import { cpCustody } from "../cp-custody.ts";
import { ControlError } from "../control.ts";
import { labRawError, readyDiagnostic } from "../ready-diagnostic.ts";
import { LiveAdmission, type LiveHostedEvidence } from "../admission/live-admission.ts";

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
  signers?: string[];
  labRawErrors?: boolean;
} = {}) {
  let forgets = 0, reads = 0, unwraps = 0, issues = 0;
  const plain = secret();
  const control: HostedControlPort = {
    serviceDevice: async collection => { assert.equal(collection, COL); reads++; return options.read ? options.read() : record(); },
    logToken: async (device, collection) => { assert.equal(device, DEV); assert.equal(collection, COL); issues++; return options.issue ? options.issue() : {token, expiresAt: NOW + 900_000}; },
    forget: collection => { assert.equal(collection, COL); forgets++; },
  };
  const custody = new HostedCustody({ ...config(), signers: options.signers ?? config().signers, labRawErrors: options.labRawErrors }, control, { unwrapDeviceKeys: async (collection, device, envelope, arn) => {
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

test("empty-signer KMS and CP custody have identical key/admission handoffs without CP signer authority", async () => {
  // Structural custody/admission regression, not a cryptographic native proof.
  const kms = setup({signers: []});
  const cp = cpCustody({ kind: "hosted", roots: config().roots, policyPins: config().policyPins,
    verifyOriginal: () => true, derive: () => record(),
    control: { serviceDevice: async () => ({...record(), signers: ["untrusted-CP-data"]}),
      logToken: async () => ({token}) }, unwrap: async () => secret() });
  const leases = [await kms.custody.openSealer(COL, signal()), await cp.openSealer(COL, signal())];
  for (const name of ["deviceId", "signSk", "kemSk", "noiseSk", "roots", "signers", "policyPins", "originalGenesis", "genesisSha256"] as const) {
    assert.deepEqual(leases[0][name], leases[1][name], name);
  }
  assert.deepEqual(leases[0].signers, []);
  for (const lease of leases) {
    const identity = {collection: COL, device: DEV, signPk: record().signPk, kemPk: record().kemPk, noisePk: record().noisePk,
      roots: [{id: ROOT, pk: lease.roots[0]}]};
    const ctx = {collection: COL, op: "call" as const, grant: ROOT, clientPk: new Uint8Array(32).fill(9)};
    assert.equal(new LiveAdmission(identity).recheck(ctx), "deny", "opening keys cannot bypass admission");
    let evidence: LiveHostedEvidence | null = {...identity, kind: "verified", wake: 1n, generation: 0n, epoch: 1n,
      applied: {seq: 5n, chain: new Uint8Array(32).fill(5)}, authenticated: {seq: 5n, chain: new Uint8Array(32).fill(5)},
      rootId: ROOT, rootPk: lease.roots[0], controlChain: new Uint8Array(32).fill(6), keyDeliveryDevice: DEV, keyDeliverySeq: 4n};
    const admission = new LiveAdmission(identity, {observe: () => evidence, wake: () => 1n, noiseMatches: () => true, authorizeApp: () => true});
    assert.equal(admission.recheck(ctx), "allow");
    evidence = null; assert.equal(admission.recheck(ctx), "deny", "revocation still requires a fresh live proof");
    lease.zeroize();
  }
  const denied = setup({signers: [], verify: () => false});
  await assert.rejects(denied.custody.openSealer(COL, signal()), /custody_invalid_record/);
  assert.equal(denied.counts().unwraps, 0);
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

test("LAB retains bounded failed CP/KMS call details privately without changing sanitized errors", async () => {
  for (const phase of ["read", "unwrap"] as const) {
    for (const labRawErrors of [false, true]) {
      const original = Object.assign(new Error(`synthetic ${phase} failure`), { stack: `synthetic ${phase} stack` });
      const s = setup({ labRawErrors, [phase]: async () => { throw original; } });
      let collapsed: Error | undefined;
      await assert.rejects(s.custody.openSealer(COL, signal()), (error: Error) => {
        collapsed = error;
        assert.equal(error.message, "custody_unavailable");
        assert.equal(error.cause, undefined);
        assert.equal(JSON.stringify(error), "{}");
        assert.equal(error.stack?.includes(original.message), false);
        assert.deepEqual(labRawError("1", error).raw_error, { message: labRawErrors ? `${error.message}; ${phase === "read" ? "control_service_device_first" : "kms_unwrap"}: Error: ${original.message}` : error.message, stack: error.stack,
          ...(labRawErrors ? { sub_cause: { call: phase === "read" ? "control_service_device_first" : "kms_unwrap", name: "Error", message: original.message } } : {}) });
        assert.deepEqual(labRawError("0", error), {});
        assert.equal(readyDiagnostic("custody_open_sealer", error).error_code, "custody_unavailable");
        return true;
      });
      assert.ok(collapsed);
      assert.deepEqual(labRawError("1", new Error("other")).raw_error?.message, "other");
      assert.equal(s.counts().forgets, 1);
      assert.equal(s.counts().reads, 1);
      assert.equal(s.counts().unwraps, phase === "read" ? 0 : 1);
    }
  }
});

test("LAB logToken catch retains the failed call with bounded UTF8 text and no cross-error leak", async () => {
  const original = Object.assign(new Error("🦉".repeat(5000)), { name: "🦉".repeat(1000) });
  const s = setup({ labRawErrors: true, issue: async () => { throw original; } });
  await assert.rejects(s.custody.logToken(COL, signal()), (error: Error) => {
    assert.equal(error.message, "custody_unavailable");
    const raw = labRawError("1", error).raw_error!;
    assert.equal(raw.sub_cause?.call, "control_log_token");
    assert.ok(Buffer.byteLength(raw.sub_cause!.name!, "utf8") <= 128);
    assert.ok(Buffer.byteLength(raw.sub_cause!.message!, "utf8") <= 4096);
    assert.deepEqual(labRawError("lab", error), {});
    assert.equal(JSON.stringify(error), "{}");
    return true;
  });
  assert.deepEqual(s.counts(), { reads: 1, unwraps: 0, issues: 1, forgets: 1 });
  assert.equal(labRawError("1", new Error("other")).raw_error?.sub_cause, undefined);
});

test("LAB labels recheck and local derive separately, never the preceding successful port", async () => {
  let reads = 0;
  const original = new Error("synthetic recheck failure");
  const s = setup({ labRawErrors: true, read: async () => { if (++reads === 2) throw original; return record(); } });
  await assert.rejects(s.custody.openSealer(COL, signal()), (error: Error) => {
    assert.equal(labRawError("1", error).raw_error?.sub_cause?.call, "control_service_device_recheck"); return true;
  });
  assert.ok(s.plain.every(byte => byte === 0));
  const local = setup({ labRawErrors: true, derive: () => { throw new Error("synthetic derive failure"); } });
  await assert.rejects(local.custody.openSealer(COL, signal()), (error: Error) => {
    assert.equal(labRawError("1", error).raw_error?.sub_cause?.call, "derive"); return true;
  });
  assert.ok(local.plain.every(byte => byte === 0));
});

test("token checks device/current tuple and expiry at completion; a held token is reused with no CP call", async () => {
  const {custody, counts} = setup();
  assert.equal(await custody.logToken(COL, signal()), token);
  assert.equal(await custody.logToken(COL, signal()), token);
  assert.deepEqual(counts(), {reads: 2, issues: 1, unwraps: 0, forgets: 1});
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

test("one scoped call at a time: a later call waits for the in-flight one; no cross-collection work", async () => {
  let release!: () => void;
  const deferred = new Promise<void>(resolve => {release = resolve;});
  const s = setup({read: async () => {await deferred; return record();}});
  const order: string[] = [];
  const open = s.custody.openSealer(COL, signal()).then(keys => { order.push("open"); return keys; });
  const minted = s.custody.logToken(COL, signal()).then(t => { order.push("token"); return t; });
  await assert.rejects(s.custody.openSealer(ROOT, signal()), /custody_unavailable/);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(s.counts().issues, 0, "the waiting call has not started");
  release();
  (await open).zeroize();
  assert.equal(await minted, token);
  assert.deepEqual(order, ["open", "token"]);
  assert.equal(s.counts().reads, 4);
});

test("a waiting call that aborts leaves the chain intact for the calls behind it", async () => {
  let release!: () => void;
  const deferred = new Promise<void>(resolve => {release = resolve;});
  let reads = 0;
  const s = setup({read: async () => {if (reads++ < 2) await deferred; return record();}});
  const first = s.custody.logToken(COL, signal());
  const abort = new AbortController();
  const second = s.custody.logToken(COL, abort.signal);
  const third = s.custody.logToken(COL, signal());
  abort.abort();
  await assert.rejects(second, (e: Error) => e.message === "custody_aborted");
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(s.counts().issues, 0, "the third call still waits for the first");
  release();
  assert.equal(await first, token);
  assert.equal(await third, token);
  assert.equal(s.counts().issues, 1, "the waiter reuses the token the first call minted");
});

test("a second open that waited is refused once the first holds the key lease", async () => {
  let release!: () => void;
  const deferred = new Promise<void>(resolve => {release = resolve;});
  const s = setup({read: async () => {await deferred; return record();}});
  const open = s.custody.openSealer(COL, signal());
  const again = s.custody.openSealer(COL, signal());
  release();
  const keys = await open;
  await assert.rejects(again, (e: Error) => e.message === "custody_unavailable");
  keys.zeroize();
  (await s.custody.openSealer(COL, signal())).zeroize();
});

test("the wait is bounded: beyond the queue limit a call is refused at once", async () => {
  let release!: () => void;
  const deferred = new Promise<void>(resolve => {release = resolve;});
  const s = setup({read: async () => {await deferred; return record();}});
  const calls = Array.from({length: 17}, () => s.custody.logToken(COL, signal()));
  await assert.rejects(s.custody.logToken(COL, signal()), (e: Error) => e.message === "custody_unavailable");
  release();
  assert.deepEqual(await Promise.all(calls), Array(17).fill(token));
});

test("close aborts calls waiting for the custody", async () => {
  let release!: () => void;
  const deferred = new Promise<void>(resolve => {release = resolve;});
  const s = setup({read: async () => {await deferred; return record();}});
  const first = s.custody.logToken(COL, signal());
  const waiting = s.custody.logToken(COL, signal());
  s.custody.close();
  await assert.rejects(waiting, (e: Error) => e.message === "custody_aborted");
  release();
  await assert.rejects(first, (e: Error) => e.message === "custody_aborted");
});

test("independent roots remain nonempty; local signers may be empty but must be valid and bounded", async () => {
  for (const cfg of [{...config(), roots: []}, {...config(), signers: ["bad"]}, {...config(), signers: ["00000000-0000-0000-0000-000000000000"]}, {...config(), signers: Array(17).fill(ROOT)}, {...config(), roots: Array.from({length: 65}, () => new Uint8Array(32).fill(1))}]) {
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

test("CP 404/409 (deleted, left sync) is a gone verdict for open and token; other CP failures stay transient", async () => {
  for (const code of ["not_found", "not_standard"] as const) {
    const open = setup({read: async () => {throw new ControlError(code, "x");}});
    await assert.rejects(open.custody.openSealer(COL, signal()), (e: Error) => e.message === "custody_collection_gone");
    assert.equal(open.counts().unwraps, 0);
    const token = setup({issue: async () => {throw new ControlError(code, "x");}});
    await assert.rejects(token.custody.logToken(COL, signal()), (e: Error) => e.message === "custody_collection_gone");
  }
  for (const code of ["unavailable", "refused", "invalid"] as const) {
    const s = setup({read: async () => {throw new ControlError(code, "x");}});
    await assert.rejects(s.custody.openSealer(COL, signal()), (e: Error) => e.message === "custody_unavailable");
    await assert.rejects(s.custody.logToken(COL, signal()), (e: Error) => e.message === "custody_unavailable");
  }
  // An aborted call is never upgraded to a verdict.
  const aborted = new AbortController(); aborted.abort();
  const s = setup({read: async () => {throw new ControlError("not_found", "x");}});
  await assert.rejects(s.custody.logToken(COL, aborted.signal), (e: Error) => e.message === "custody_aborted");
});

test("CP 403 (collection routed to another deployment) is a not-allowed verdict for open and token, never retried as an outage", async () => {
  const open = setup({read: async () => {throw new ControlError("wrong_scope", "control plane answered 403");}});
  await assert.rejects(open.custody.openSealer(COL, signal()), (e: Error) => e.message === "custody_collection_not_allowed");
  assert.equal(open.counts().unwraps, 0);
  const read = setup({read: async () => {throw new ControlError("wrong_scope", "control plane answered 403");}});
  await assert.rejects(read.custody.logToken(COL, signal()), (e: Error) => e.message === "custody_collection_not_allowed");
  const token = setup({issue: async () => {throw new ControlError("wrong_scope", "control plane answered 403");}});
  await assert.rejects(token.custody.logToken(COL, signal()), (e: Error) => e.message === "custody_collection_not_allowed");
  const aborted = new AbortController(); aborted.abort();
  const late = setup({read: async () => {throw new ControlError("wrong_scope", "x");}});
  await assert.rejects(late.custody.logToken(COL, aborted.signal), (e: Error) => e.message === "custody_aborted");
});

test("a KMS that does not serve the collection is a verdict, not a retryable outage", async () => {
  const s = setup({unwrap: async () => {throw new Error("kms_collection_not_allowed");}});
  await assert.rejects(s.custody.openSealer(COL, signal()), (e: Error) => e.message === "custody_collection_not_allowed");
  const transient = setup({unwrap: async () => {throw new Error("kms_unavailable");}});
  await assert.rejects(transient.custody.openSealer(COL, signal()), (e: Error) => e.message === "custody_unavailable");
});

// Held log token (LogTokenCache): reuse, margin, bound and every drop path.
function clocked(start = NOW) {
  let time = start;
  let expiresAt = NOW + 900_000;
  let replaced = false;
  let refuse: Error | null = null;
  const s = setup({
    now: () => time,
    issue: async () => { if (refuse) throw refuse; return {token, expiresAt}; },
    read: async () => { if (refuse) throw refuse; return replaced ? {...record(), deviceId: ROOT} : record(); },
  });
  return { ...s, set: (t: number) => { time = t; }, expire: (at: number) => { expiresAt = at; },
    replace: () => { replaced = true; }, refuse: (e: Error | null) => { refuse = e; } };
}

test("held token: a hit makes no CP call, a miss reads, mints and rechecks", async () => {
  const s = clocked();
  assert.equal(await s.custody.logToken(COL, signal()), token);
  assert.deepEqual(s.counts(), {reads: 2, issues: 1, unwraps: 0, forgets: 1});
  for (let i = 0; i < 5; i++) assert.equal(await s.custody.logToken(COL, signal()), token);
  assert.deepEqual(s.counts(), {reads: 2, issues: 1, unwraps: 0, forgets: 1}, "hits read no record and mint nothing");
});

test("held token: reused only while more than 60 s remain", async () => {
  const s = clocked();
  await s.custody.logToken(COL, signal());
  s.set(NOW + 900_000 - 60_001);
  await s.custody.logToken(COL, signal());
  assert.equal(s.counts().issues, 1, "60.001 s left: still a hit");
  s.set(NOW + 900_000 - 60_000);
  s.expire(NOW + 900_000 - 60_000 + 900_000);
  await s.custody.logToken(COL, signal());
  assert.equal(s.counts().issues, 2, "exactly 60 s left: minted again");
  assert.equal(s.counts().reads, 4);
});

test("held token: bounded at 16 min from the mint and dropped if the clock runs backwards", async () => {
  // The issuer may answer up to 16 min (15 + margin); the hold never outlasts it.
  const s = clocked();
  s.expire(NOW + 16 * 60_000);
  await s.custody.logToken(COL, signal());
  s.set(NOW + 15 * 60_000 - 1);
  await s.custody.logToken(COL, signal());
  assert.equal(s.counts().issues, 1);
  s.set(NOW + 15 * 60_000);
  s.expire(NOW + 30 * 60_000);
  await s.custody.logToken(COL, signal());
  assert.equal(s.counts().issues, 2);
  s.set(NOW + 15 * 60_000 - 1);
  s.expire(NOW + 30 * 60_000 - 1);
  await s.custody.logToken(COL, signal());
  assert.equal(s.counts().issues, 3, "a clock before the mint began is not trusted");
});

test("held token: invalidateLogToken (engine reset, CP activation, log 401/403) makes the next call mint", async () => {
  const s = clocked();
  await s.custody.logToken(COL, signal());
  s.custody.invalidateLogToken();
  await s.custody.logToken(COL, signal());
  assert.deepEqual(s.counts(), {reads: 4, issues: 2, unwraps: 0, forgets: 2});
});

test("held token: every CP refusal or verdict drops it; nothing stale is handed out afterwards", async () => {
  for (const error of [new ControlError("not_found", "gone"), new ControlError("not_standard", "left sync"),
    new ControlError("wrong_scope", "other deployment"), new ControlError("unavailable", "outage"), new ControlError("refused", "401")]) {
    const s = clocked();
    await s.custody.logToken(COL, signal());
    s.custody.invalidateLogToken();
    s.refuse(error);
    await assert.rejects(s.custody.logToken(COL, signal()));
    s.refuse(null);
    const issues = s.counts().issues;
    await s.custody.logToken(COL, signal());
    assert.equal(s.counts().issues, issues + 1, `${error.code}: the next call asks the CP again`);
  }
});

test("held token: an open that fails drops it", async () => {
  const s = clocked();
  await s.custody.logToken(COL, signal());
  s.refuse(new ControlError("unavailable", "outage"));
  await assert.rejects(s.custody.openSealer(COL, signal()));
  s.refuse(null);
  await s.custody.logToken(COL, signal());
  assert.equal(s.counts().issues, 2);
});

test("held token: no stale token after rekey (record replaced) or retire (close)", async () => {
  const rekey = clocked();
  (await rekey.custody.openSealer(COL, signal())).zeroize();
  await rekey.custody.logToken(COL, signal());
  // A rekey is a policy batch: the CP activates, which drops the token.
  rekey.custody.invalidateLogToken();
  rekey.replace();
  await assert.rejects(rekey.custody.logToken(COL, signal()), /custody_unavailable/);
  await assert.rejects(rekey.custody.logToken(COL, signal()), /custody_unavailable/, "the replaced record keeps refusing; no held token");
  assert.equal(rekey.counts().issues, 1);

  const retire = clocked();
  await retire.custody.logToken(COL, signal());
  retire.custody.close();
  await assert.rejects(retire.custody.logToken(COL, signal()), /custody_unavailable/);
  assert.equal(retire.counts().issues, 1);
});

test("held token: an aborted caller is refused, not handed the held token", async () => {
  const s = clocked();
  await s.custody.logToken(COL, signal());
  const abort = new AbortController(); abort.abort();
  await assert.rejects(s.custody.logToken(COL, abort.signal), /custody_aborted/);
});

test("CP custody (LAB escrow) holds tokens with an expiry and drops them on invalidation and refusals", async () => {
  let reads = 0, issues = 0, forgets = 0, refuse: Error | null = null;
  const cp = cpCustody({ kind: "hosted", roots: config().roots, policyPins: config().policyPins,
    verifyOriginal: () => true, derive: () => record(),
    control: { serviceDevice: async () => { reads++; if (refuse) throw refuse; return record(); },
      logToken: async () => { issues++; return {token, expiresAt: Date.now() + 900_000}; }, forget: () => { forgets++; } },
    unwrap: async () => secret() });
  await cp.logToken(COL, signal());
  await cp.logToken(COL, signal());
  assert.deepEqual({reads, issues}, {reads: 2, issues: 1});
  cp.invalidateLogToken!(COL);
  assert.equal(forgets, 1, "the client's own token cache is forgotten too");
  await cp.logToken(COL, signal());
  assert.deepEqual({reads, issues}, {reads: 4, issues: 2}, "invalidation also re-reads the record");
  cp.invalidateLogToken!(COL);
  refuse = new ControlError("not_found", "gone");
  await assert.rejects(cp.logToken(COL, signal()), /custody_collection_gone/);
  refuse = null;
  await cp.logToken(COL, signal());
  assert.equal(issues, 3);
});
