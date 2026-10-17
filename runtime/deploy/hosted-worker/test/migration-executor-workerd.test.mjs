// Kill-and-resume of the migration executor in real local workerd: DO SQLite,
// DO storage (run record), storage.sync, the real Connect client over a
// service binding. The native Driver is the ledger-faithful fake
// (`fixtures/migration-fake-native.ts`); the native outstanding/ticket rules
// themselves are covered by the Rust tests and `migration-journal-workerd.mjs`.
// The process is killed (Miniflare disposed) at every step boundary of every
// action; the resumed instance must never repeat a side effect, and an action
// whose outcome is unknown must stop the run for an operator.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

const compiled = await build({ stdin: {
  contents: `
    import { DurableObject } from "cloudflare:workers";
    import { MigrationExecutor } from "./src/migration-executor.ts";
    import { newRun, storageRunStore, STEP } from "./src/migration-run.ts";
    import { gen0Plan, gen0Source } from "./test/fixtures/migration-fake-source.mjs";
    import { connectClient } from "./src/migration-connect.ts";
    import { FakeNative, providerPlan, HOLD } from "./test/fixtures/migration-fake-native.ts";
    export class Harness extends DurableObject {
      constructor(ctx, env) {
        super(ctx, env);
        const sql = ctx.storage.sql;
        sql.exec("CREATE TABLE IF NOT EXISTS fake_native (k INTEGER PRIMARY KEY, v TEXT NOT NULL)");
        const store = {
          read: () => { const row = sql.exec("SELECT v FROM fake_native WHERE k=0").toArray()[0]; return row ? JSON.parse(row.v) : null; },
          write: s => { sql.exec("INSERT INTO fake_native(k,v) VALUES(0,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", JSON.stringify(s)); },
          sync: () => ctx.storage.sync(),
        };
        const ctl = async (path, name, kind) => { await (await env.CTL.fetch("http://ctl/" + path + "?name=" + name + "&kind=" + kind)).text(); };
        this.native = new FakeNative(env.GEN0 ? gen0Plan(STEP.created, STEP.routed) : providerPlan(), store,
          { boundary: (n, k) => ctl("boundary", n, k), effect: (n, k) => ctl("effect", n, k) });
        this.runs = storageRunStore(ctx.storage);
        this.executor = new MigrationExecutor({ collection: this.native.collection, host: this.native,
          connect: () => connectClient({ url: "https://cp.test", token: "t".repeat(40) }, (url, init) => env.CTL.fetch(url, init)),
          source: async () => { if (env.GEN0) return gen0Source(() => ctl("boundary", "record-read", 4)); throw new Error("no_source"); }, store: this.runs, sleep: async () => {} });
      }
      async fetch(request) {
        const op = new URL(request.url).pathname;
        if (op === "/start") { await this.runs.save(newRun(this.native.collection, HOLD, Date.now())); return Response.json({}); }
        if (op === "/wake") return Response.json(await this.executor.wake(new AbortController().signal));
        return new Response("not found", { status: 404 });
      }
    }
    export default { fetch(request, env) { return env.HARNESS.getByName("c").fetch(request); } };
  `,
  resolveDir: fileURLToPath(new URL("../", import.meta.url)), sourcefile: "executor-harness.ts", loader: "ts",
}, bundle: true, write: false, format: "esm", platform: "browser", external: ["cloudflare:workers"] });

const MIGRATION = "3c2b1a09-8f7e-4d6c-9b5a-4f3e2d1c0b9a";
/** The externally visible effect each action (or hook) makes. */
const EFFECT = { 11: "fence", 14: "revoke", 15: "cutover-policy", 19: "cutover", 6: "log-append" };
const KINDS = [0, 1, 10, 11, 12, 6, 13, 14, 15, 8, 19];
const routes = [
  [/\/accounts\/[^/]+$/, "account", () => ({ account: true })],
  [/\/fence$/, "fence", () => ({ migration_id: MIGRATION })],
  [/\/source$/, "source", () => ({ migration_id: MIGRATION, drained: true })],
  [/\/replicas\/revoke$/, "revoke", () => ({ revoked: ["r1"] })],
  [/\/replicas$/, "replicas", () => ({ replicas: ["r1"] })],
  [/\/members-policy$/, "members-policy", () => ({ queued: 0 })],
  [/\/cutover-policy$/, "cutover-policy", () => ({ created: true })],
  [/\/cutover$/, "cutover", () => ({ routed: true })],
];

/** Run one scenario: kill at `target` ({at, kind} or {effect, nth}), resume, finish. */
async function scenario(target, gen0 = false) {
  const prefix = fileURLToPath(new URL("../.test-state/executor-", import.meta.url));
  mkdirSync(dirname(prefix), { recursive: true });
  const scratch = mkdtempSync(prefix);
  const effects = [];
  let armed = target, onKill = () => {}, matched = 0;
  const killNow = () => { armed = null; onKill(); return new Promise(() => {}); };
  const CTL = async request => {
    const url = new URL(request.url);
    if (url.hostname === "ctl") {
      const name = url.searchParams.get("name"), kind = Number(url.searchParams.get("kind"));
      if (url.pathname === "/effect") effects.push(name);
      if (armed?.at === (url.pathname === "/effect" ? "effect" : name) && armed.kind === kind && ++matched === (armed.nth ?? 1)) return killNow();
      return new Response("ok");
    }
    assert.equal(request.headers.get("authorization"), `Bearer ${"t".repeat(40)}`);
    const route = routes.find(([re]) => re.test(url.pathname));
    if (!route) return Response.json({ error: "not_found" }, { status: 404 });
    effects.push(route[1]);
    if (armed?.at === "effect" && EFFECT[armed.kind] === route[1]) return killNow();
    if (armed?.at === "members" && effects.filter(e => e === "members-policy").length === armed.nth) return killNow();
    return Response.json(route[2]());
  };
  const open = () => new Miniflare(convertV4MiniflareOptions({ name: "executor-crash", modules: true,
    script: compiled.outputFiles[0].text, compatibilityDate: "2026-10-05",
    durableObjects: { HARNESS: { className: "Harness", useSQLite: true } }, serviceBindings: { CTL }, bindings: { GEN0: gen0 },
    resourcePersistencePath: scratch, resourceTmpPath: scratch, port: 0 }));
  let mf = open(), passed = false;
  const drive = async () => {
    for (let i = 0; i < 40; i++) {
      const killed = new Promise(resolve => { onKill = () => resolve(null); });
      const reply = await Promise.race([mf.dispatchFetch("http://h.test/wake").then(r => r.json()), killed]).catch(() => null);
      if (reply === null) return null;
      if (reply.state === "stopped" || reply.state === "done") return reply;
    }
    throw new Error("executor did not finish");
  };
  try {
    await mf.dispatchFetch("http://h.test/start");
    const first = await drive();
    if (target) assert.equal(first, null, `kill point ${JSON.stringify(target)} was reached`);
    await mf.dispose().catch(() => undefined);
    mf = open();
    const result = first ?? await drive();
    passed = true;
    return { result, effects };
  } finally {
    await mf.dispose().catch(() => undefined);
    if (passed) rmSync(scratch, { recursive: true, force: true });
  }
}

const count = (effects, e) => effects.filter(x => x === e).length;
function assertNoDuplicates(effects) {
  for (const e of [...Object.values(EFFECT), "cutover"]) assert.ok(count(effects, e) <= 1, `${e} at most once: ${effects}`);
}
function assertComplete(result, effects) {
  assert.equal(result.state, "done", JSON.stringify(result));
  for (const e of Object.values(EFFECT)) assert.equal(count(effects, e), 1, `${e} exactly once: ${effects}`);
}

test("an uninterrupted run routes with every effect once", async () => {
  const { result, effects } = await scenario(null);
  assertComplete(result, effects);
  assert.equal(count(effects, "members-policy"), 1);
});

for (const kind of KINDS) {
  test(`kill after action ${kind} is prepared: UNKNOWN, operator stop, no effect`, async () => {
    const { result, effects } = await scenario({ at: "prepared", kind });
    assert.deepEqual([result.state, result.reason], ["stopped", `outstanding_unknown:${kind}`]);
    if (EFFECT[kind]) assert.equal(count(effects, EFFECT[kind]), 0);
    assertNoDuplicates(effects);
  });
  if (EFFECT[kind]) {
    test(`kill after action ${kind}'s effect landed, reply lost: operator stop, effect exactly once`, async () => {
      const { result, effects } = await scenario({ at: "effect", kind });
      assert.deepEqual([result.state, result.reason], ["stopped", `outstanding_unknown:${kind}`]);
      assert.equal(count(effects, EFFECT[kind]), 1);
      assertNoDuplicates(effects);
    });
  }
  test(`kill after action ${kind}'s settlement is written, before sync: either outcome, no duplicate`, async () => {
    const { result, effects } = await scenario({ at: "written", kind });
    if (result.state === "stopped") assert.equal(result.reason, `outstanding_unknown:${kind}`);
    else assertComplete(result, effects);
    assertNoDuplicates(effects);
  });
  test(`kill after action ${kind}'s settlement is confirmed: resumes, no duplicate`, async () => {
    const { result, effects } = await scenario({ at: "settled", kind });
    assertComplete(result, effects);
  });
}

test("kill during members-policy: it is asked again (idempotent), the run completes", async () => {
  const { result, effects } = await scenario({ at: "members", nth: 1 });
  assertComplete(result, effects);
  assert.equal(count(effects, "members-policy"), 2);
});

test("uninterrupted multi-window gen0 streams >8 MiB with each chunk uploaded once", async () => {
  const { result, effects } = await scenario(null, true);
  assert.equal(result.state, "done");
  assert.equal(count(effects, "file-put"), 2);
  assert.equal(count(effects, "window-put"), 4);
});

// The first two puts are resource windows, then two attachment chunks, then
// bucket windows. Kill real workerd while each original action is pending.
for (const [at, nth, files, windows] of [
  ["prepared", 2, 0, 1], ["sealed", 2, 0, 1], ["uploaded", 2, 0, 2],
  ["sealed", 3, 0, 2], ["effect", 3, 1, 2], ["uploaded", 3, 1, 2],
  ["sealed", 4, 1, 2], ["effect", 4, 2, 2], ["uploaded", 4, 2, 2],
  ["uploaded", 5, 2, 3],
  ["record-read", 1, 2, 3], ["record-read", 8, 2, 3], ["record-read", 16, 2, 3],
  ["sealed", 6, 2, 3], ["uploaded", 6, 2, 4],
]) {
  test(`gen0 kill at ${at}:${nth}: pending is UNKNOWN, no window/chunk replay`, async () => {
    const { result, effects } = await scenario({ at, nth, kind: 4 }, true);
    assert.deepEqual([result.state, result.reason], ["stopped", "outstanding_unknown:4"]);
    assert.equal(count(effects, "file-put"), files);
    assert.equal(count(effects, "window-put"), windows);
  });
}

test("gen0 kill before first resource settlement sync never replays a landed window", async () => {
  const { result, effects } = await scenario({ at: "written", kind: 4 }, true);
  assert.equal(result.state, "stopped");
  assert.ok(["outstanding_unknown:4", "source_read_lost"].includes(result.reason), JSON.stringify(result));
  assert.equal(count(effects, "window-put"), 1);
  assert.equal(count(effects, "file-put"), 0);
});
