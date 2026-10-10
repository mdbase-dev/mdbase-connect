// Real local workerd SQLite/KV/alarm storage, no service/provider/credential
// bindings. The harness tests inhibition, not authenticated import or retirement.
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
    import { AlarmLifecycle, ALARM_INHIBITOR_KEY } from "./src/alarm-lifecycle.ts";
    export class LifecycleHarness extends DurableObject {
      constructor(ctx, env) { super(ctx, env); this.gate = new AlarmLifecycle(ctx.storage); }
      async alarm() {
        if (!await this.gate.allowed()) { await this.gate.inhibit(); return; }
        await this.ctx.storage.put("effect", true);
      }
      async fetch(request) {
        const input = await request.json(); const s = this.ctx.storage;
        if (input.op === "seed") {
          // Import quarantine precedes EVERY restored SQL/KV identity write.
          if (input.inhibited) await this.gate.inhibit();
          s.sql.exec("CREATE TABLE IF NOT EXISTS mig_fixture (id INTEGER PRIMARY KEY, original TEXT)");
          s.sql.exec("INSERT OR IGNORE INTO mig_fixture VALUES (1, 'original checkpoint')");
          await s.put({ "service-collection": "original collection", "hosted-replica-id": "original replica",
            "escrow-collection": "legacy identity", "hosted_upload_locator_v1": "untrusted locator",
            "source-alarm-deadline": input.at });
        }
        if (input.op === "schedule") await this.gate.schedule(input.at, () => true);
        if (input.op === "unsupported") {
          try { await s.put(ALARM_INHIBITOR_KEY, undefined); }
          catch (error) {
            if (!(error instanceof TypeError) || error.message !== "put() called with undefined value.") throw error;
            return Response.json({ rejected: true, present: (await s.get([ALARM_INHIBITOR_KEY])).has(ALARM_INHIBITOR_KEY) });
          }
          throw new Error("undefined was unexpectedly accepted");
        }
        if (input.op === "malformed") await s.put(ALARM_INHIBITOR_KEY, null);
        if (input.op === "inhibit") await this.gate.inhibit();
        if (input.op === "deliver") await this.alarm();
        const inventory = Object.fromEntries(await s.get(["service-collection", "hosted-replica-id",
          "escrow-collection", "hosted_upload_locator_v1", "source-alarm-deadline"]));
        const marker = await s.get([ALARM_INHIBITOR_KEY]);
        return Response.json({ allowed: await this.gate.allowed(), alarm: await s.getAlarm(),
          inhibitorPresent: marker.has(ALARM_INHIBITOR_KEY),
          inhibitorNull: marker.has(ALARM_INHIBITOR_KEY) && marker.get(ALARM_INHIBITOR_KEY) === null,
          effect: await s.get("effect") ?? null, inventory,
          migration: s.sql.exec("SELECT * FROM mig_fixture ORDER BY id").toArray() });
      }
    }
    export default { fetch(request, env) {
      return env.LIFECYCLE.getByName(new URL(request.url).pathname).fetch(request);
    } };
  `,
  resolveDir: fileURLToPath(new URL("../", import.meta.url)), sourcefile: "lifecycle-harness.ts", loader: "ts",
}, bundle: true, write: false, format: "esm", platform: "browser", external: ["cloudflare:workers"] });

async function fixture(run) {
  const prefix = fileURLToPath(new URL("../../../target/hl-", import.meta.url));
  mkdirSync(dirname(prefix), { recursive: true }); const scratch = mkdtempSync(prefix);
  const oldTmp = process.env.TMPDIR; process.env.TMPDIR = scratch;
  let mf; let passed = false;
  const open = () => new Miniflare(convertV4MiniflareOptions({ name: "lifecycle-test", modules: true,
    script: compiled.outputFiles[0].text, compatibilityDate: "2026-10-05",
    durableObjects: { LIFECYCLE: { className: "LifecycleHarness", useSQLite: true } },
    resourcePersistencePath: scratch, resourceTmpPath: scratch, port: 0 }));
  const call = async (name, input) => {
    const response = await mf.dispatchFetch(`http://fixture.test/${name}`, {
      method: "POST", body: JSON.stringify(input),
    });
    if (response.status !== 200) assert.fail(`local fixture response ${response.status}: ${(await response.text()).slice(0, 512)}`);
    return response.json();
  };
  try {
    mf = open();
    await run(call, async () => { await mf.dispose(); mf = open(); });
    passed = true;
  } finally {
    await mf?.dispose();
    if (oldTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = oldTmp;
    if (passed) rmSync(scratch, { recursive: true });
    else console.error(`Retained isolated lifecycle fixture: ${scratch}`);
  }
}

test("real SQLite inhibition survives disposal/restart and duplicate lost-ACK reconciliation", async () => {
  await fixture(async (call, restart) => {
    const at = Date.now() + 3_600_000;
    const original = await call("retire", { op: "seed", at });
    const scheduled = await call("retire", { op: "schedule", at });
    assert.equal(scheduled.alarm, at);
    assert.equal((await call("retire", { op: "schedule", at: at + 1_000 })).alarm, at);
    // Ignore the first successful response, then reconstruct the actual actor.
    await call("retire", { op: "inhibit" }); await restart();
    for (const op of ["inhibit", "deliver", "schedule", "deliver"]) {
      const state = await call("retire", { op, at });
      assert.equal(state.allowed, false); assert.equal(state.alarm, null);
      assert.equal(state.effect, null);
      assert.deepEqual(state.inventory, original.inventory);
      assert.deepEqual(state.migration, original.migration);
    }
  });
});

test("real storage rejects undefined without creating an inhibitor key", async () => {
  await fixture(async (call) => {
    await call("unsupported", { op: "seed", at: Date.now() + 3_600_000 });
    assert.deepEqual(await call("unsupported", { op: "unsupported" }), { rejected: true, present: false });
  });
});

test("real malformed null is present denial and survives reconciliation unchanged", async () => {
  await fixture(async (call, restart) => {
    await call("malformed", { op: "seed", at: Date.now() + 3_600_000 });
    const first = await call("malformed", { op: "malformed" });
    assert.equal(first.inhibitorPresent, true); assert.equal(first.allowed, false);
    await restart();
    const state = await call("malformed", { op: "deliver" });
    assert.equal(state.inhibitorPresent, true); assert.equal(state.allowed, false);
    assert.equal(state.inhibitorNull, true);
    assert.equal(state.effect, null); assert.equal(state.alarm, null);
  });
});

test("empty local target stays inhibited after identity/deadline import and restart", async () => {
  await fixture(async (call, restart) => {
    const at = Date.now() + 3_600_000;
    const source = await call("source", { op: "seed", at });
    assert.equal(source.allowed, true);
    const target = await call("empty-target", { op: "seed", at, inhibited: true });
    assert.equal(target.allowed, false); assert.equal(target.alarm, null);
    assert.deepEqual(target.inventory, source.inventory);
    assert.deepEqual(target.migration, source.migration);
    await restart();
    for (const op of ["deliver", "schedule", "deliver"]) {
      const state = await call("empty-target", { op, at });
      assert.equal(state.allowed, false); assert.equal(state.alarm, null);
      assert.equal(state.effect, null);
      assert.deepEqual(state.inventory, source.inventory);
      assert.deepEqual(state.migration, source.migration);
    }
  });
});
