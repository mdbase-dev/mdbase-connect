import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { build } from "esbuild";

// Actual RUN handler and supersede path; synthetic native state, claim and engine ports.
const compiled = await build({ entryPoints: [new URL("../src/worker.ts", import.meta.url).pathname], bundle: true,
  write: false, format: "esm", platform: "node", plugins: [{ name: "supersede-ports", setup(b) {
    b.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: "platform", namespace: "platform-test" }));
    b.onLoad({ filter: /.*/, namespace: "platform-test" }, () => ({ contents: "export class DurableObject {}" }));
    b.onResolve({ filter: /hosted\.wasm$/ }, () => ({ path: "hosted.wasm", namespace: "native-test" }));
    b.onLoad({ filter: /.*/, namespace: "native-test" }, () => ({ contents: "export default new WebAssembly.Module(new Uint8Array([0,97,115,109,1,0,0,0]));" }));
    b.onLoad({ filter: /src\/migration-run\.ts$/ }, args => ({ loader: "ts", contents: readFileSync(args.path, "utf8")
      .replace("export function readNativeState(sql: Sql): NativeState {",
        "export function readNativeState(sql: Sql): NativeState { if ((sql as any).native) return (sql as any).native;") }));
    b.onLoad({ filter: /src\/worker\.ts$/ }, args => ({ loader: "ts", contents: readFileSync(args.path, "utf8")
      .replace(/#migrationOperatorRunning\b/g, "test_migrationOperatorRunning") }));
  } }] });
const { HostedCollection } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString("base64")}`);
const collection = "10000000-0000-4000-8000-000000000001";
const oldHold = "20000000-0000-4000-8000-000000000002", newHold = "30000000-0000-4000-8000-000000000003";
const token = "synthetic-supersede-token".repeat(3);
const request = hold => new Request(`https://hosted.test/v1/hosted/migration/run?collection=${collection}`, {
  method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ collection, backup_hold: hold }) });
const cp = (step, fenced = false) => ({ step, fenced, revoked: [], cutoverSeq: null, failure: null, baseSeq: null, sFinal: null });
const rolledBack = { runSequence: 1, checkpoint: cp(21), outstanding: null };

function fixture({ state = "stopped", reason = "terminal:21", native = rolledBack, refuse = false, priorStart = "1" } = {}) {
  const o = Object.create(HostedCollection.prototype), events = [];
  const values = new Map([["migration-run", { v: 1, collection, backupHold: oldHold, pauseBeforeCutover: false, resumeRunSequence: null,
    state, reason, migrationId: null, owner: null, startedUs: null, membersBase: false, membersFinal: false, last: null, refusals: 0,
    startedAt: 1, updatedAt: 1 }]]);
  const storage = { get: async key => values.get(key), put: async (key, value) => { events.push(["save", value.backupHold, value.state]); values.set(key, value); },
    sync: async () => events.push(["sync"]), sql: { native, exec: () => ({ toArray: () => [] }) } };
  const engine = {
    supersedeMigrationDriver: (_cpp, claim, sequence) => { events.push(["supersede", claim.started_us, sequence]); if (refuse) throw new Error("migration_run_refused"); },
    openMigrationDriver: (_cpp, claim) => { events.push(["open", claim.started_us]); if (refuse) throw new Error("migration_run_refused"); },
    migrationRun: sequence => { events.push(["run", sequence]); return [sequence, new Uint8Array(16), new Uint8Array(16), new Uint8Array(16), priorStart]; },
  };
  Object.assign(o, { escrow: false, env: { HOSTED_SERVICE_TOKEN: token }, ctx: { storage }, migrationConfigured: () => true,
    requirePhysicalCollection: () => {}, ready: async () => engine,
    ownedMigrationClaim: async (_signal, use, open) => { events.push(["claim", open]); return use(engine, 0, {}, { started_us: "2" }, () => {}); } });
  Object.defineProperty(o, "alarms", { value: { current: true, schedule: async () => events.push(["alarm"]) } });
  return { o, events, values };
}
const run = f => f.values.get("migration-run");

test("a new hold supersedes a fully rolled-back run without opening the old binding", async () => {
  const f = fixture();
  const response = await f.o.fetch(request(newHold));
  assert.equal(response.status, 202);
  assert.deepEqual(f.events, [["claim", false], ["supersede", "2", 1], ["sync"], ["save", newHold, "running"], ["sync"], ["alarm"]]);
  assert.equal((await response.json()).run.backup_hold, newHold);
  // An identical retry is the same-hold reply: no second claim or native run.
  f.events.length = 0;
  const retry = await f.o.fetch(request(newHold));
  assert.equal(retry.status, 200);
  assert.equal((await retry.json()).run.backup_hold, newHold);
  assert.deepEqual(f.events, [["alarm"]]);
});

test("a committed supersede whose record was lost reopens under the same claim", async () => {
  const f = fixture({ native: { runSequence: 2, checkpoint: cp(0), outstanding: null } });
  assert.equal((await f.o.fetch(request(newHold))).status, 202);
  assert.deepEqual(f.events, [["claim", false], ["open", "2"], ["run", 1], ["sync"], ["save", newHold, "running"], ["sync"], ["alarm"]]);
});

test("a lost operator restart under the same start is not taken for a supersede", async () => {
  const f = fixture({ native: { runSequence: 2, checkpoint: cp(0), outstanding: null }, priorStart: "2" }), before = structuredClone(run(f));
  const response = await f.o.fetch(request(newHold));
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error, "migration_run_exists");
  assert.deepEqual(run(f), before);
  assert.ok(!f.events.some(e => e[0] === "save" || e[0] === "alarm"));
});

test("anything short of a settled rollback keeps the stored run and answers migration_run_exists", async () => {
  for (const options of [
    { state: "running", reason: null }, { state: "waiting", reason: null },
    { native: { ...rolledBack, checkpoint: cp(21, true) } },
    { native: { ...rolledBack, outstanding: { sequence: 3, kind: 21 } } },
    { native: { ...rolledBack, checkpoint: cp(20) } },
    { state: "done", reason: null, native: { ...rolledBack, checkpoint: cp(13, true) } },
    { native: { runSequence: 1, checkpoint: cp(0), outstanding: null } },
    { native: { runSequence: null, checkpoint: null, outstanding: null } },
    { refuse: true },
  ]) {
    const f = fixture(options), before = structuredClone(run(f));
    const response = await f.o.fetch(request(newHold));
    assert.equal(response.status, 409, JSON.stringify(options));
    assert.equal((await response.json()).error, "migration_run_exists");
    assert.deepEqual(run(f), before);
    assert.ok(!f.events.some(e => e[0] === "save" || e[0] === "alarm"), JSON.stringify(options));
  }
  const busy = fixture();
  busy.o.test_migrationOperatorRunning = true;
  busy.o.ownedMigrationClaim = async () => { throw new Error("concurrent operator"); };
  assert.equal((await busy.o.fetch(request(newHold))).status, 409);
});

test("the same hold keeps the existing idempotent RUN reply", async () => {
  const f = fixture();
  const response = await f.o.fetch(request(oldHold));
  assert.equal(response.status, 200);
  assert.deepEqual(f.events, []);
});
