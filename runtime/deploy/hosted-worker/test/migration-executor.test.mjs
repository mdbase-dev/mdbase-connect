import { test } from "node:test";
import assert from "node:assert/strict";
import { MigrationExecutor, IDLE, PAGE_LIMITS, MAX_REFUSALS } from "../src/migration-executor.ts";
import { PAUSE_REASON, STEP, newRun } from "../src/migration-run.ts";
import { LegacySourceError } from "../src/legacy-source/source.ts";
import { FakeNative, mapStore, providerPlan, HOLD } from "./fixtures/migration-fake-native.ts";
import { LARGE_RECORD_TEXT, fakeSource, placement, gen0Source, gen0Plan, fileRow as file, recordRow as record } from "./fixtures/migration-fake-source.mjs";

const MIGRATION = "3c2b1a09-8f7e-4d6c-9b5a-4f3e2d1c0b9a";
const ok = body => ({ status: 200, code: null, body });
const err = (status, code) => ({ status, code, body: { error: code } });

function connect(overrides = {}) {
  const calls = [];
  let cutoverQueued = false;
  const base = {
    account: async () => ok({ account: true }),
    fence: async () => ok({ migration_id: MIGRATION }),
    source: async () => ok({ migration_id: MIGRATION, drained: true }),
    replicas: async () => ok({ replicas: ["r1"] }),
    revoke: async () => ok({ revoked: ["r1"] }),
    // As Connect: member changes are refused once the cutover is queued.
    membersPolicy: async () => cutoverQueued ? err(409, "migration_cutover_queued") : ok({ queued: 0 }),
    cutoverPolicy: async () => { cutoverQueued = true; return ok({ created: true }); },
    cutover: async () => ok({ routed: true }),
    rollback: async () => ok({ fixture: "original-full-receipt" }),
    rollbackReceipt: async () => ok({ fixture: "original-full-receipt" }),
  };
  const client = {};
  for (const name of Object.keys(base)) {
    client[name] = async (...args) => { calls.push(name); return (overrides[name] ?? base[name])(...args, calls); };
  }
  return { client, calls };
}

function setup({ plan = providerPlan(), overrides, source, pause = false } = {}) {
  const store = mapStore(), native = new FakeNative(plan, store), c = connect(overrides);
  let run = newRun(native.collection, HOLD, 1, pause);
  const runStore = { load: async () => run && structuredClone(run), save: async r => { run = structuredClone(r); } };
  const executor = new MigrationExecutor({ collection: native.collection, host: native, connect: () => c.client,
    source: async () => source, store: runStore, sleep: async () => {} });
  return { native, store, connect: c, executor, runStore, run: () => run };
}

/** Wake until the run stops or finishes (waits are skipped in time). */
async function drive(executor, max = 40) {
  const seen = [];
  for (let i = 0; i < max; i++) {
    const r = await executor.wake(new AbortController().signal);
    seen.push(r.reason);
    if (r.state === "stopped" || r.state === "done") return { ...r, seen };
  }
  throw new Error("did not settle");
}

test("drives the fence-first order to routed, waiting on one-shot not-yet answers", async () => {
  const s = setup();
  const r = await drive(s.executor);
  assert.equal(r.state, "done");
  assert.ok(r.seen.includes("paused") && r.seen.includes("draining"), "one-shot Wait answers wait, then ask again");
  assert.equal(s.store.saved.step, STEP.routed);
  for (const effect of ["fence", "revoke", "cutoverPolicy", "cutover"]) {
    assert.equal(s.connect.calls.filter(c => c === effect).length, 1, effect);
  }
  // Once, after the fence and base append; never after the cutover is queued.
  assert.equal(s.connect.calls.filter(c => c === "membersPolicy").length, 1);
  const firstMembers = s.connect.calls.indexOf("membersPolicy");
  assert.ok(firstMembers > s.connect.calls.indexOf("fence") && firstMembers < s.connect.calls.indexOf("replicas"));
  assert.equal(s.run().migrationId, MIGRATION);
  // Only cutover-stage log actions ask the push-less log for its head.
  assert.ok(s.native.heads.includes(15) && s.native.heads.every(k => [15, 16, 17, 18].includes(k)), String(s.native.heads));
  assert.deepEqual(s.native.results.find(x => x.kind === 0).result, { kind: "backup", hold_id: HOLD });
  const route = s.native.results.find(x => x.kind === 19);
  assert.equal(route.result.kind, "cutover");
});

test("requested pause stops at verified H1 before revoke/intent, survives reopen, and only current-run resume progresses", async () => {
  const s = setup({ pause: true });
  assert.equal((await drive(s.executor)).reason, PAUSE_REASON);
  assert.equal(s.store.saved.step, STEP.verified);
  assert.equal(s.store.saved.outstanding, null);
  assert.equal(s.native.calls.includes("prepare:14"), false);
  assert.equal(s.connect.calls.includes("revoke"), false);
  const reopened = new MigrationExecutor({ collection: s.native.collection, host: s.native, connect: () => s.connect.client,
    source: async () => undefined, store: s.runStore });
  assert.equal((await reopened.wake(new AbortController().signal)).reason, PAUSE_REASON);
  const run = s.run();
  run.state = "running"; run.reason = null; run.resumeRunSequence = 2;
  await s.runStore.save(run);
  assert.equal((await drive(reopened)).reason, PAUSE_REASON, "foreign run resume cannot consume pause");
  run.resumeRunSequence = 1;
  await s.runStore.save(run);
  assert.equal((await drive(reopened)).state, "done");
  assert.equal(s.run().pauseBeforeCutover, true, "request mode stays immutable after resume");
});

test("pause requested past H1 refuses before another prepare", async () => {
  const s = setup({ pause: true });
  s.store.saved = { index: 8, seq: 8, step: STEP.revoked, fenced: true, attempts: 0, baseSeq: 21,
    revoked: [], outstanding: null, idleUsed: 0 };
  assert.equal((await drive(s.executor)).reason, "migration_pause_point_passed");
  assert.deepEqual(s.native.calls, []);
});

test("a saved action this instance holds no ticket for is UNKNOWN: operator stop, no replay", async () => {
  const s = setup();
  s.store.saved = { index: 3, seq: 4, step: STEP.created, attempts: 0, baseSeq: null, revoked: [], outstanding: { seq: 4, kind: 11 }, idleUsed: 0 };
  const r = await drive(s.executor);
  assert.equal(r.state, "stopped");
  assert.equal(r.reason, "outstanding_unknown:11");
  assert.deepEqual(s.connect.calls, []);
  // A stopped run stays stopped.
  assert.equal((await s.executor.wake(new AbortController().signal)).reason, "outstanding_unknown:11");
});

test("a lost reply to an effect stops for an operator; a lost read reply is asked again", async () => {
  let fences = 0;
  const s = setup({ overrides: { fence: async () => { fences++; throw new Error("network"); } } });
  const r = await drive(s.executor);
  assert.equal(r.reason, "effect_unknown:11");
  assert.equal(fences, 1);
  assert.deepEqual(s.store.saved.outstanding, { seq: 4, kind: 11 }, "the RAM ticket was released; the saved action stays UNKNOWN");
  let reads = 0;
  const t = setup({ overrides: { source: async () => (++reads === 1 ? Promise.reject(new Error("network")) : ok({ migration_id: MIGRATION })) } });
  assert.equal((await drive(t.executor)).state, "done");
  assert.equal(reads, 2);
});

test("members-policy: not queued is queued then retried, 503 waits, refusals stop", async () => {
  const s = setup({ overrides: { cutoverPolicy: async (_c, _b, _r, _s, _sig, calls) =>
    calls.filter(c => c === "cutoverPolicy").length === 1 ? err(409, "migration_members_not_queued") : ok({ created: true }) } });
  assert.equal((await drive(s.executor)).state, "done");
  const at = s.connect.calls.indexOf("cutoverPolicy");
  assert.deepEqual(s.connect.calls.slice(at, at + 3), ["cutoverPolicy", "membersPolicy", "cutoverPolicy"]);

  let n = 0;
  const w = setup({ overrides: { membersPolicy: async () => (++n === 1 ? err(503, "unavailable") : ok({})) } });
  const r = await drive(w.executor);
  assert.equal(r.state, "done");
  assert.ok(r.seen.includes("members_unavailable"));

  for (const code of ["migration_policy_blocked", "migration_members_over_cap", "migration_members_invalid"]) {
    const x = setup({ overrides: { membersPolicy: async () => err(409, code) } });
    const stopped = await drive(x.executor);
    assert.equal(stopped.reason, code);
    assert.equal(x.store.saved.step, STEP.baseAppended, "stopped before the next action");
    assert.equal(x.connect.calls.includes("replicas"), false);
  }
});

test("members-policy is never asked after cutover-policy succeeds", async () => {
  const s = setup();
  assert.equal((await drive(s.executor)).state, "done");
  const calls = s.connect.calls;
  assert.equal(calls.slice(calls.indexOf("cutoverPolicy")).includes("membersPolicy"), false);
  assert.ok(s.native.results.some(x => x.kind === 8));
});

test("log evidence not yet present waits on the held ticket; Unsupported refusals are bounded", async () => {
  const s = setup();
  s.native.refuseOnce.add(8);
  assert.equal((await drive(s.executor)).state, "done");

  const r = setup({ plan: [{ kind: 0, step: STEP.backupHeld, settle: "provider", idleBefore: Array(MAX_REFUSALS + 1).fill(IDLE.refused) }] });
  const stopped = await drive(r.executor);
  assert.equal(stopped.reason, "native_refused");
  assert.equal(stopped.seen.filter(x => x === "native_refused").length, MAX_REFUSALS + 1);
});

test("a gated rebuild reopens over an empty cache, then retries the prepare", async () => {
  const s = setup({ plan: [{ kind: 0, step: STEP.routed, settle: "provider", idleBefore: [IDLE.rebuildGated] }] });
  assert.equal((await drive(s.executor)).state, "done");
  assert.equal(s.native.resets, 1);
});

test("qualified rollback restores once then reads the ORIGINAL receipt for Unfence", async () => {
  const s = setup({ plan: [{ kind: 20, step: STEP.rollingBack, settle: "rollback" }, { kind: 21, step: STEP.rolledBack, settle: "rollback" }] });
  s.store.saved = { index: 0, seq: 0, step: STEP.rollingBack, attempts: 5, baseSeq: null, revoked: ["r1"], fenced: true, outstanding: null, idleUsed: 0 };
  assert.equal((await drive(s.executor)).reason, `terminal:${STEP.rolledBack}`);
  assert.deepEqual(s.connect.calls, ["rollback", "rollbackReceipt"]);
  assert.equal(s.store.saved.fenced,false); assert.deepEqual(s.store.saved.revoked,[]);
  const u = setup();
  u.store.saved = { index: 0, seq: 0, step: STEP.failed, attempts: 5, baseSeq: null, revoked: [], outstanding: null, idleUsed: 0 };
  assert.equal((await drive(u.executor)).reason, `terminal:${STEP.failed}`);
});

test("lost rollback reply and missing original receipt stop UNKNOWN without replay", async () => {
  for (const kind of [20,21]) {
    const s = setup({ plan: [{ kind, step: STEP.rolledBack, settle: "rollback" }],
      overrides: { rollback: async()=>{throw Error("lost");}, rollbackReceipt:async()=>err(404,"legacy_rollback_receipt_unknown") } });
    const result = await drive(s.executor);
    assert.equal(result.state,"stopped");
    assert.deepEqual(s.connect.calls,[kind === 20 ? "rollback" : "rollbackReceipt"]);
    assert.equal(s.store.saved.outstanding.kind,kind);
    await s.executor.wake(new AbortController().signal);
    assert.equal(s.connect.calls.length,1);
  }
});

test("reads are fenced-first; native-selected gen0 keys are hydrated and file refs consumed page by page", async () => {
  const source = fakeSource({ resources: [[{ path: "p", kind: "type", revision: "r", document: new Uint8Array(1) }]],
    files: [[file("f1")], [file("f2")]], records: [[record("a"), record("b")]] });
  const plan = [
    { kind: 2, fields: [0, 40], step: STEP.created, settle: "source" },
    { kind: 3, fields: [0, 2, null, 500, 1 << 30], step: STEP.created, settle: "source" },
    { kind: 4, fields: [0, null, null], placements: [placement(0, "p")], step: STEP.created, settle: "gen0" },
    { kind: 4, fields: [0, 0, null], placements: [placement(1, "a"), placement(1, "b"), placement(2, "f1"), placement(2, "f2")], step: STEP.created, settle: "gen0" },
    { kind: 5, step: STEP.routed, settle: "gen0" },
  ];
  const s = setup({ plan, source });
  assert.equal((await drive(s.executor)).state, "done");
  assert.deepEqual(source.calls[0], ["open", 40, "migrating", HOLD]);
  assert.deepEqual(source.calls[1], ["page", "records", null, PAGE_LIMITS.maxRecords, PAGE_LIMITS.maxDecodedBytes]);
  assert.ok(source.calls.filter(c => c[0] === "page").every(c => c[3] <= 64 && c[4] <= 1 << 20));
  // f1 is streamed and uploaded before the second files page is read.
  const order = source.calls.map(c => c.join(":"));
  assert.ok(order.indexOf("stream:ref-f1") < order.indexOf("hydrate:files:f2:64:1048576"));
  assert.deepEqual(s.native.calls.filter(c => c.startsWith("gen0")), ["gen0Window:1", "gen0FileChunk:f1:0:3", "gen0FileChunk:f2:0:3", "gen0Window:2"]);
  assert.equal(source.calls.filter(c => c[0] === "page" && c[1] !== "records").length, 0, "gen0 never rescans whole tables");
  assert.deepEqual(source.calls.at(-1), ["close", "s1"]);
});

test("unfenced reads and source refusals stop with typed codes", async () => {
  const open = setup({ plan: [{ kind: 2, fields: [0, null], step: STEP.created, settle: "source" }], source: fakeSource({}) });
  assert.equal((await drive(open.executor)).reason, "source_open_unfenced_unsupported");
  const refused = fakeSource({});
  refused.openCheckpoint = async () => { throw new LegacySourceError("head_moved", "moved"); };
  const r = setup({ plan: [{ kind: 2, fields: [0, 40], step: STEP.created, settle: "source" }], source: refused });
  assert.equal((await drive(r.executor)).reason, "source_refused:head_moved");
});

test("resource/bucket continuations use only native-selected keys; >8 MiB file chunks upload in order", async () => {
  const source = gen0Source(), s = setup({ plan: gen0Plan(STEP.created, STEP.routed), source });
  assert.equal((await drive(s.executor)).state, "done");
  assert.deepEqual(source.calls.filter(c => c[0] === "hydrate").map(c => [c[1], c[2]]), [
    ["resources", "p"], ["resources", "q"], ["files", "f1"], ["records", "a"], ["records", "b"],
  ]);
  assert.deepEqual(s.native.calls.filter(c => c.startsWith("gen0") || c.startsWith("put:")), [
    "gen0Window:1", "put:2", "gen0Window:1", "put:2", "gen0FileChunk:f1:0:8388608", "put:1",
    "gen0FileChunk:f1:8388608:17", "put:1", "gen0Window:1", "put:2", "gen0Window:1", "put:2",
  ]);
});

test("1 MiB referenced record is consumed byte-exactly before sealing its native-selected singleton", async () => {
  const source = gen0Source(), s = setup({ plan: gen0Plan(STEP.created, STEP.routed), source });
  const seal = s.native.gen0Window.bind(s.native);
  let saw = false;
  s.native.gen0Window = (ticket, input) => {
    const record = input.rows.find(r => "record" in r && r.record.recordId === "b")?.record;
    if (record) {
      assert.equal(input.rows.length, 1);
      assert.equal(record.document, LARGE_RECORD_TEXT);
      assert.equal(new TextEncoder().encode(record.document).length, 1 << 20);
      assert.equal(record.contentRef, null);
      saw = true;
    }
    return seal(ticket, input);
  };
  assert.equal((await drive(s.executor)).state, "done");
  assert.ok(saw);
  assert.equal(source.calls.filter(c => c[0] === "stream-record").length, 1);
});

test("record stream failures leave UNKNOWN, wipe consumed bytes, cancel and never replay", async () => {
  for (const failure of ["short", "extra", "chunk", "utf8", "read"]) {
    const source = gen0Source();
    let cancelled = false, consumed;
    source.streamRecord = async () => {
      let at = 0;
      return new ReadableStream({ pull(c) {
        if (failure === "read" && at) { c.error(new Error("read_lost")); return; }
        const total = (1 << 20) + (failure === "extra" ? 1 : failure === "short" ? -1 : 0);
        if (at === total) {
          if (failure === "extra") return new Promise(() => {}); // cancel remains observable after the excess byte
          c.close(); return;
        }
        const n = Math.min(total - at, failure === "chunk" ? (64 << 10) + 1 : 64 << 10);
        consumed = new Uint8Array(n).fill(failure === "utf8" ? 0xff : 0x78);
        at += n; c.enqueue(consumed);
      }, cancel() { cancelled = true; } }, { highWaterMark: 0 });
    };
    const s = setup({ plan: gen0Plan(STEP.created, STEP.routed), source });
    assert.equal((await drive(s.executor)).state, "stopped", failure);
    assert.equal(s.store.saved.outstanding.kind, 4);
    assert.ok(consumed.every(b => b === 0), failure);
    if (["extra", "chunk"].includes(failure)) assert.ok(cancelled, failure);
    const calls = s.native.calls.length;
    await s.executor.wake(new AbortController().signal);
    assert.equal(s.native.calls.length, calls);
  }
});

test("completed window re-upload/missing-object retries retain the original sealed output, never reseal", async () => {
  for (const failure of ["put", "has", "missing"]) {
    const s = setup({ plan: [{ kind: 2, fields: [0, 40], step: STEP.created, settle: "source" },
      { kind: 4, fields: [1, 0, "prior"], placements: [], step: STEP.routed, settle: "gen0" }], source: fakeSource({}) });
    let first = true;
    const put = s.native.putObject.bind(s.native);
    s.native.putObject = async (...args) => {
      if (failure === "put" && first) { first = false; throw new Error("migration_object_put_unavailable"); }
      return put(...args);
    };
    s.native.hasObjects = async (_c, addresses) => {
      if (failure !== "put" && first) { first = false; if (failure === "has") throw new Error("migration_object_has_unavailable"); return addresses.map(() => false); }
      return addresses.map(() => true);
    };
    assert.equal((await drive(s.executor)).state, "done", failure);
    assert.equal(s.native.calls.filter(c => c.startsWith("gen0Window")).length, 1, failure);
  }
});

test("a partial file upload failure is UNKNOWN, stops, closes the source and never replays chunks", async () => {
  const source = gen0Source(), s = setup({ plan: gen0Plan(STEP.created, STEP.routed), source });
  const put = s.native.putObject.bind(s.native), seal = s.native.gen0FileChunk.bind(s.native);
  let input;
  s.native.gen0FileChunk = (t, chunk) => { input = chunk.bytes; return seal(t,chunk); };
  s.native.putObject = async (c, object, signal) => {
    await put(c, object, signal);
    if (object.kind === 1) throw new Error("migration_object_commit_unavailable");
  };
  const result = await drive(s.executor);
  assert.deepEqual([result.state, result.reason], ["stopped", "gen0_window_unknown:migration_object_commit_unavailable"]);
  assert.equal(s.native.calls.filter(c => c.startsWith("gen0FileChunk")).length, 1);
  assert.equal(s.store.saved.outstanding.kind, 4);
  assert.ok(input.every(b => b === 0), "consumed plaintext is wiped on partial upload failure");
  const before = s.native.calls.length;
  await s.executor.wake(new AbortController().signal);
  assert.equal(s.native.calls.length, before);
  assert.deepEqual(source.calls.at(-1), ["close", "s1"]);
});

test("mid-stream read failure after an uploaded chunk stops instead of restarting the file", async () => {
  for (const error of [new Error("source_transport_lost"), new LegacySourceError("object_unavailable", "503")]) {
    const source = gen0Source();
    source.streamContent = async () => {
      let remaining = 8 << 20;
      return new ReadableStream({ pull(c) {
        if (!remaining) { c.error(error); return; }
        remaining -= 1 << 20; c.enqueue(new Uint8Array(1 << 20).fill(0x5c));
      } });
    };
    const s = setup({ plan: gen0Plan(STEP.created, STEP.routed), source });
    const result = await drive(s.executor);
    assert.equal(result.state, "stopped");
    assert.equal(s.native.calls.filter(c => c.startsWith("gen0FileChunk")).length,1);
    assert.equal(s.store.saved.outstanding.kind,4);
    const calls = s.native.calls.length;
    await s.executor.wake(new AbortController().signal);
    assert.equal(s.native.calls.length,calls);
    assert.deepEqual(source.calls.at(-1),["close","s1"]);
  }
});

test("empty files seal once; short/long streams and over-policy files never settle their window", async () => {
  for (const [size, actual, expected] of [[0,0,"done"], [3,2,"gen0_file_size_mismatch"], [3,4,"gen0_file_size_mismatch"], [(1 << 30)+1,0,"gen0_file_policy_unsupported"]]) {
    const source = fakeSource({ files: [[file("f1",size)]] });
    source.streamContent = async () => new ReadableStream({ start(c) { if (actual) c.enqueue(new Uint8Array(actual)); c.close(); } });
    const s = setup({ plan: [{ kind: 2, fields: [0,40], step: STEP.created, settle: "source" },
      { kind: 4, fields: [1,0,null], placements: [placement(2,"f1")], step: STEP.routed, settle: "gen0" }], source });
    const result = await drive(s.executor);
    if (expected === "done") {
      assert.equal(result.state, "done");
      assert.deepEqual(s.native.calls.filter(c => c.startsWith("gen0FileChunk")), ["gen0FileChunk:f1:0:0"]);
    } else { assert.equal(result.reason, expected); assert.equal(s.native.results.filter(r => r.kind === 4).length,0); }
  }
});
