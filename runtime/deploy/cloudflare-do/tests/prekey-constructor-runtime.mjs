// Isolated local workerd, actual fresh native SDK and opaque namespace IDs.
// Constructor/denial checks only: no CP network, live nonce or positive witness.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, openSync, closeSync, writeFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
const port = Number(process.env.LOGSVC_TEST_PORT ?? 19374);
const inspector = Number(process.env.LOGSVC_TEST_INSPECTOR_PORT ?? 24574);
const base = `http://127.0.0.1:${port}`;
mkdirSync(".wrangler", { recursive: true });
const dir = mkdtempSync(resolve(".wrangler/runtime-test-prekey-constructor-"));
const log = openSync(resolve(dir, "wrangler.log"), "a", 0o600);
const config = resolve(dir, "wrangler.json");
writeFileSync(config, JSON.stringify({ name: "prekey-constructor-local", main: resolve("tests/prekey-constructor-worker.mjs"),
  compatibility_date: "2026-10-04", durable_objects: { bindings: [
    { name: "LOG", class_name: "Probe" }, { name: "OTHER", class_name: "Other" }, { name: "HOSTED", class_name: "Hosted" },
  ] }, migrations: [{ tag: "v1", new_sqlite_classes: ["Probe", "Other", "Hosted"] }] }), { mode: 0o600 });
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
  const A = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
  const D = "dddddddd-dddd-4ddd-addd-dddddddddddd";
  const NIL = "00000000-0000-0000-0000-000000000000";
  const cases = [
    { collection: A }, { collection: D }, { collection: NIL },
    { collection: "ffffffff-ffff-4fff-afff-ffffffffffff" }, { collection: A, physical: "other" },
    ...["no-roots", "zero-roots", "duplicate-roots", "no-audience", "path-audience", "http-audience",
      "no-binding", "bad-floor", "unknown-field", "duplicate-member", "foreign-namespace", "foreign-object"]
      .map(change => ({ collection: A, change })),
  ];
  for (const q of cases) {
    const response = await fetch(`${base}/check`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(q), signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 200, JSON.stringify(q));
    const result = await response.json();
    const expected = !q.change && !q.physical && [A, D].includes(q.collection)
      ? "prekey_caller_unavailable" : "prekey_context_refused";
    assert.deepEqual(result.exports, ["function", "function", "function", "function"]);
    assert.deepEqual(result.errors, [expected, expected, expected, "prekey_ticket_refused", expected], JSON.stringify(q));
    assert.equal(result.pulls, 0);
    assert.equal(result.privateReads, 0);
    assert.deepEqual(result.serving, [503, 503]);
    assert.deepEqual(result.tables, ["__miniflare_do_name"]);
    assert.equal(result.actualNamespaceDistinct, true);
  }
  console.log(`PASS ${cases.length} actual native SDK constructor/denial cases: four exports, A/D/nil/foreign IDs/public trust refusal/capture/no body/private reads/service SQL; genuine nonce producer unavailable, all serving503`);
  success = true;
} finally {
  if (server.exitCode === null) { const done = once(server, "exit"); process.kill(-server.pid, "SIGTERM"); await done; }
  closeSync(log);
  if (success) rmSync(dir, { recursive: true, force: true });
  else console.error(`Local diagnostics retained at ${dir}/wrangler.log`);
}
