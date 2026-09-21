// Executed in a child process by database-bounds.mjs: an unhandled pg error
// must fail this regression without killing the system runner or its cleanup.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { openDatabase } from "../../services/server/dist/db.js";
import { registerErrorHandler } from "../../services/server/dist/platform/error-handler.js";

const databaseUrl = process.env.MDBASE_TEST_DATABASE_BOUNDS_URL;
const target = new URL(databaseUrl);
assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(target.hostname), "local disposable database required");
const require = createRequire(new URL("../../services/server/package.json", import.meta.url));
const app = require("fastify")();
await app.register(require("@fastify/cors"), { origin: "https://application.example.test" });
registerErrorHandler(app);
const db = await openDatabase(databaseUrl);
const admin = await openDatabase(databaseUrl);
const table = `connection_failure_${randomUUID().replaceAll("-", "")}`;
const metrics = [];
const originalWarn = console.warn;
console.warn = (...args) => {
  metrics.push(args);
};
const remoteResponse = Promise.withResolvers();
const remoteStarted = Promise.withResolvers();
const transactionStarted = Promise.withResolvers();
const remote = createServer(async (_request, response) => {
  remoteStarted.resolve();
  await remoteResponse.promise;
  response.end("ok");
});
await new Promise((resolve) => remote.listen(0, "127.0.0.1", resolve));
const remoteUrl = `http://127.0.0.1:${remote.address().port}/`;
let request;

async function until(check, message) {
  const end = Date.now() + 15_000;
  do {
    if (await check()) return;
    await delay(20);
  } while (Date.now() < end);
  throw new Error(message);
}
function failureCount() {
  return metrics.filter(([, fields]) => fields?.metric === "database_connection_failure").length;
}

try {
  await db.query(`CREATE TABLE ${table} (value integer NOT NULL)`);
  app.get("/health", async () => ({ ok: true }));
  app.post("/delayed-remote", async () => {
    const connection = await db.connect();
    try {
      await connection.query("BEGIN");
      await connection.query(`INSERT INTO ${table} VALUES (1)`);
      const result = await connection.query("SELECT pg_backend_pid() AS pid");
      transactionStarted.resolve(result.rows[0].pid);
      // Keep the actual production 10-second idle timeout. The remote response
      // is released only after PostgreSQL has terminated this transaction.
      await fetch(remoteUrl, { signal: AbortSignal.timeout(15_000) });
      await connection.query("COMMIT");
      return { ok: true };
    } catch (error) {
      await connection.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      connection.release();
    }
  });
  request = app.inject({
    method: "POST", url: "/delayed-remote",
    headers: { origin: "https://application.example.test" }
  }).then((response) => response);
  const pid = await transactionStarted.promise;
  await remoteStarted.promise;
  await until(() => metrics.some(([, fields]) => fields?.failure_class === "idle_transaction_timeout"),
    "idle transaction was not terminated at its production deadline");
  assert.equal((await app.inject("/health")).statusCode, 200);
  remoteResponse.resolve();
  const response = await request;
  assert.equal(response.statusCode, 500);
  assert.equal(response.headers["access-control-allow-origin"], "https://application.example.test");
  assert.equal((await db.query(`SELECT count(*)::int AS count FROM ${table}`)).rows[0].count, 0,
    "the disconnected transaction must not commit its pending write");
  assert.notEqual((await db.query("SELECT pg_backend_pid() AS pid")).rows[0].pid, pid,
    "a broken checked-out client must not be reused");

  // Disconnect a released client too: pg-pool forwards these through the
  // pool's error event, a separate process-crash boundary from checkout.
  const idle = await db.connect();
  const idlePid = (await idle.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
  idle.release();
  const beforeIdle = failureCount();
  await admin.query("SELECT pg_terminate_backend($1)", [idlePid]);
  await until(() => failureCount() > beforeIdle, "idle pool error was not observed");
  assert.notEqual((await db.query("SELECT pg_backend_pid() AS pid")).rows[0].pid, idlePid);

  // During a query the driver's promise, not the event listener, owns failure.
  const active = await db.connect();
  try {
    const activePid = (await active.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    const failed = assert.rejects(active.query("SELECT pg_sleep(20)"));
    await until(async () => (await admin.query(
      "SELECT wait_event FROM pg_stat_activity WHERE pid = $1", [activePid]
    )).rows[0]?.wait_event === "PgSleep", "query did not start");
    await admin.query("SELECT pg_terminate_backend($1)", [activePid]);
    await failed;
  } finally {
    active.release();
  }
  assert.equal((await app.inject("/health")).statusCode, 200);
  assert.equal((await db.query("SELECT 1 AS value")).rows[0].value, 1);
  for (const [message, fields] of metrics) {
    assert.equal(message, "privacy-safe Connect metric");
    assert.deepEqual(Object.keys(fields).sort(), ["failure_class", "metric"]);
    assert.ok(["idle_transaction_timeout", "connection_failure"].includes(fields.failure_class));
  }
  process.stdout.write("database client failure containment passed\n");
} finally {
  remoteResponse.resolve();
  await request?.catch(() => undefined);
  remote.closeAllConnections();
  await new Promise((resolve) => remote.close(resolve));
  await app.close();
  await admin.query(`DROP TABLE IF EXISTS ${table}`);
  await db.end();
  await admin.end();
  console.warn = originalWarn;
}
