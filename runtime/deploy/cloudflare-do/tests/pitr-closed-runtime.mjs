// Local workerd only; no login/profile/provider/custody or PITR APIs.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, openSync, closeSync, writeFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
const port = Number(process.env.LOGSVC_TEST_PORT ?? 18793);
const inspector = Number(process.env.LOGSVC_TEST_INSPECTOR_PORT ?? 19235);
const base = `http://127.0.0.1:${port}`;
mkdirSync(".wrangler", { recursive: true });
const dir = mkdtempSync(resolve(".wrangler/runtime-test-pitr-closed-"));
const log = openSync(resolve(dir, "wrangler.log"), "a", 0o600);
const config = resolve(dir, "wrangler.json");
writeFileSync(config, JSON.stringify({ name: "pitr-log-closed-local", main: resolve("tests/pitr-closed-worker.mjs"),
  compatibility_date: "2026-10-04", durable_objects: { bindings: [{ name: "LOG", class_name: "LogCollection" }] },
  migrations: [{ tag: "v1", new_sqlite_classes: ["LogCollection"] }] }), { mode: 0o600 });
const server = spawn(process.execPath, [resolve("node_modules/wrangler/bin/wrangler.js"), "dev", "--config", config,
  "--local", "--ip", "127.0.0.1", "--port", String(port), "--inspector-port", String(inspector),
  "--persist-to", resolve(dir, "state"), "--show-interactive-dev-session=false"], {
  detached: true, stdio: ["ignore", log, log], env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
});
let success = false;
try {
  let ready = false;
  for (let i = 0; i < 150; i++) {
    assert.equal(server.exitCode, null, "local workerd startup failed; diagnostics retained");
    try { ready = (await fetch(`${base}/health`, { signal: AbortSignal.timeout(1000) })).ok; } catch { /* startup only */ }
    if (ready) break;
    await delay(100);
  }
  assert.ok(ready, "local workerd readiness deadline");
  const call = async (path, body) => {
    const r = await fetch(`${base}/${path}`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
    assert.equal(r.status, 200); return r.json();
  };
  const members = ["aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa", "dddddddd-dddd-4ddd-addd-dddddddddddd", "00000000-0000-0000-0000-000000000000"];
  for (const collection of members) {
    for (const scope of [{ required: true }, ...["LOGSVC_PITR_REQUIRED", "PITR_BINDING", "PITR_MINIMUM_EPOCH", "PITR_PHASE", "PITR_AUTHORITY_TOKEN", "PITR_ESCROW_SERVICE_TOKEN"].map(flag => ({ flag }))]) {
      const r = await call("instrument", { collection, ...scope });
      assert.deepEqual(r, { status: 503, cache: "no-store", bytes: 0, outer: [503, 503], outerCors: [null, null], alarm: 200, reads: 0, bodies: 0, closes: 3, alarms: 1, auto: 1 });
    }
    const r = await call("actor", { collection });
    // Local runtime creates its name-mapping table before the application ctor.
    // Exact inventory allows only that one observed table, never service schema.
    assert.deepEqual(r, { status: 503, tables: ["__miniflare_do_name"], alarm: null, alarmProbe: { status: 200, alarm: null } });
  }
  const origin = "*";
  assert.deepEqual(await call("ordinary-cors", {}), [
    { status: 204, origin, credentials: null },
    { status: 204, origin, credentials: null },
    { status: 200, origin, credentials: null },
    { status: 401, origin, credentials: null },
  ]);
  console.log("PASS isolated native LOG/registry: 21 instrumented profiles +3 actual local SQLite actors; no service construction/body/keys/CORS/bindings/schema/attachment/output, alarms deleted; ordinary CORS 4-case composition PASS");
  success = true;
} finally {
  if (server.exitCode === null) { const done = once(server, "exit"); process.kill(-server.pid, "SIGTERM"); await done; }
  closeSync(log);
  if (success) rmSync(dir, { recursive: true, force: true });
  else console.error(`Local diagnostics retained at ${dir}/wrangler.log`);
}
