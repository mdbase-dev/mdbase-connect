// Actual local workerd namespace/physical State IDs; no provider/login/PITR API.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, openSync, closeSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
const port = Number(process.env.LOGSVC_TEST_PORT ?? 18794);
const inspector = Number(process.env.LOGSVC_TEST_INSPECTOR_PORT ?? 19234);
const base = `http://127.0.0.1:${port}`;
mkdirSync(".wrangler", { recursive: true });
const dir = mkdtempSync(resolve(".wrangler/runtime-test-backend-nil-"));
const log = openSync(resolve(dir, "wrangler.log"), "a", 0o600);
const config = resolve(dir, "wrangler.json");
writeFileSync(config, JSON.stringify({ name: "backend-nil-local", main: resolve("tests/backend-nil-worker.mjs"),
  compatibility_date: "2026-10-04", vars: { INSECURE_TEST_KEYS: "1", TESTKIT_CP: "conformance", PUBLIC_BASE: base },
  durable_objects: { bindings: [{ name: "LOG", class_name: "Bound" }, { name: "OTHER", class_name: "Misbound" }] },
  r2_buckets: [{ binding: "OBJECTS", bucket_name: "backend-nil-local-only" }],
  migrations: [{ tag: "v1", new_sqlite_classes: ["Bound", "Misbound"] }] }), { mode: 0o600 });
const server = spawn(process.execPath, [resolve("node_modules/wrangler/bin/wrangler.js"), "dev", "--config", config,
  "--local", "--ip", "127.0.0.1", "--port", String(port), "--inspector-port", String(inspector),
  "--persist-to", resolve(dir, "state"), "--show-interactive-dev-session=false"], {
  detached: true, stdio: ["ignore", log, log], env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
});
try {
  let ready = false;
  for (let i = 0; i < 150; i++) {
    assert.equal(server.exitCode, null, "local startup failed; diagnostics retained");
    try { ready = (await fetch(`${base}/health`, { signal: AbortSignal.timeout(1000) })).ok; } catch { /* startup only */ }
    if (ready) break;
    await delay(100);
  }
  assert.ok(ready, "readiness deadline");
  const call = async q => {
    const r = await fetch(`${base}/case`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(q), signal: AbortSignal.timeout(5000) });
    assert.equal(r.status, 200); return r.json();
  };
  const nil = "00000000-0000-0000-0000-000000000000";
  const active = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
  const deleted = "dddddddd-dddd-4ddd-addd-dddddddddddd";
  for (const target of [active, deleted]) {
    const valid = await call({ actor: nil, target });
    assert.deepEqual(valid, { status: 200, bytes: [0x83, 1, 0x50, ...target.replaceAll("-", "").match(/../g).map(x => parseInt(x, 16)), 0xf6] });
  }
  for (const q of [{ actor: active, target: active }, { actor: deleted, target: deleted }, { actor: nil, target: active, other: true }]) {
    const denied = await call(q);
    assert.ok(denied.refused === true || (denied.status === 500 && denied.bytes.length === 0), "wrong physical receiver/namespace must refuse");
  }
  assert.deepEqual(await call({ public: true, target: active }), { status: 404 }, "ordinary public Worker cannot expose the private floor route");
  console.log("PASS backend-nil: 2 genuine namespace nil replies, 2 wrong physical receivers, 1 foreign namespace, private route public404; no CP/device principal conversion");
} finally {
  const done = server.exitCode === null ? once(server, "exit") : Promise.resolve();
  if (server.exitCode === null) process.kill(-server.pid, "SIGTERM");
  const timer = setTimeout(() => { try { process.kill(-server.pid, "SIGKILL"); } catch {} }, 5000);
  try { await done; } finally {
    clearTimeout(timer);
    // Match the ordinary harness: parent exit is not full owned-group drain.
    try { process.kill(-server.pid, "SIGKILL"); } catch (e) { if (e.code !== "ESRCH") throw e; }
    let settled = false;
    for (let i = 0; i < 100; i++) {
      try { process.kill(-server.pid, 0); } catch (e) { if (e.code === "ESRCH") { settled = true; break; } throw e; }
      await delay(50);
    }
    closeSync(log);
    assert.ok(settled, "owned namespace-test process group did not settle");
  }
  console.log(`Local namespace evidence retained at ${dir}/wrangler.log`);
}
