import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";

const execute = promisify(execFile);

export async function verifyControlPlaneDatabaseBounds(databaseUrl) {
  const { openDatabase } = await import("../../services/server/dist/db.js");
  const { isDatabaseTimeoutError } = await import(
    "../../services/server/dist/platform/error-handler.js"
  );
  const pool = await openDatabase(databaseUrl);
  const held = [];
  try {
    for (let index = 0; index < 20; index += 1) held.push(await pool.connect());
    const acquireStarted = Date.now();
    await assert.rejects(
      () => pool.connect(),
      (error) => {
        assert.equal(isDatabaseTimeoutError(error), true);
        return true;
      }
    );
    assert.ok(Date.now() - acquireStarted >= 4_750, "pool acquisition waited for its configured bound");
    for (const client of held.splice(0)) client.release();

    const settings = await pool.query(`
      SELECT current_setting('statement_timeout') AS statement_timeout,
             current_setting('lock_timeout') AS lock_timeout,
             current_setting('idle_in_transaction_session_timeout') AS idle_timeout
    `);
    assert.deepEqual(settings.rows[0], {
      statement_timeout: "15s",
      lock_timeout: "5s",
      idle_timeout: "10s"
    });

    const statement = await pool.connect();
    try {
      await statement.query("BEGIN");
      await statement.query("SET LOCAL statement_timeout = 50");
      await assert.rejects(
        () => statement.query("SELECT pg_sleep(1)"),
        (error) => {
          assert.equal(isDatabaseTimeoutError(error), true);
          assert.equal(error.code, "57014");
          return true;
        }
      );
    } finally {
      await statement.query("ROLLBACK").catch(() => undefined);
      statement.release();
    }

    const table = `control_database_bounds_${randomUUID().replaceAll("-", "")}`;
    await pool.query(`CREATE TABLE ${table} (id INTEGER PRIMARY KEY, value INTEGER NOT NULL)`);
    await pool.query(`INSERT INTO ${table} (id, value) VALUES (1, 0)`);
    const owner = await pool.connect();
    const waiter = await pool.connect();
    try {
      await owner.query("BEGIN");
      await owner.query(`UPDATE ${table} SET value = value + 1 WHERE id = 1`);
      await waiter.query("BEGIN");
      await waiter.query("SET LOCAL lock_timeout = 50");
      await assert.rejects(
        () => waiter.query(`UPDATE ${table} SET value = value + 1 WHERE id = 1`),
        (error) => {
          assert.equal(isDatabaseTimeoutError(error), true);
          assert.equal(error.code, "55P03");
          return true;
        }
      );
    } finally {
      await waiter.query("ROLLBACK").catch(() => undefined);
      await owner.query("ROLLBACK").catch(() => undefined);
      waiter.release();
      owner.release();
      await pool.query(`DROP TABLE ${table}`);
    }
  } finally {
    for (const client of held) client.release();
    await pool.end();
  }
}

export async function verifyHostedProviderDatabaseBounds(databaseUrl, repoRoot) {
  const { stdout = "", stderr = "" } = await execute(
    "cargo",
    [
      "test",
      "-p", "mdbase-connect-hosted-provider",
      "production_pool_waits_and_database_locks_are_bounded",
      "--",
      "--ignored",
      "--nocapture"
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        MDBASE_TEST_DATABASE_BOUNDS_URL: databaseUrl
      },
      maxBuffer: 16 * 1024 * 1024
    }
  );
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
}
