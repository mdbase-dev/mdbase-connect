import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, openDatabase, type DatabasePool } from "../../db.js";
import { assertControlPlaneMigrationsCurrent, runControlPlaneMigrations } from "../../migrations.js";

const testUrl = process.env.MDBASE_CONNECT_TEST_DATABASE_URL;
const approved = process.env.MDBASE_CONNECT_DESTRUCTIVE_TEST_APPROVAL ===
  "I APPROVE MDBASE CONNECT DESTRUCTIVE POSTGRES TESTS";
const suite = testUrl && approved ? describe : describe.skip;
const lockId = 1_291_842_019;
const schemaKey = (schema: string) => createHash("sha256").update(schema).digest().readInt32BE(0);

suite("isolated PostgreSQL migration locks", () => {
  let admin: pg.Pool;
  let base: URL;
  const schemas: string[] = [];
  const pools: DatabasePool[] = [];
  const scoped = (schema: string) => {
    const url = new URL(base);
    url.searchParams.set("options", `-csearch_path=${schema}`);
    return url.toString();
  };
  const freshSchema = async () => {
    const schema = `appserver_lock_${randomUUID().replaceAll("-", "")}`;
    await admin.query(`CREATE SCHEMA "${schema}"`);
    schemas.push(schema);
    return schema;
  };
  const bootstrap = async (schema: string) => {
    const pool = await createDatabase(scoped(schema));
    pools.push(pool);
    return pool;
  };
  // Wait for an observed PostgreSQL lock queue, not an arbitrary sleep race.
  const waiters = async (namespace: number, key: number, count: number) => {
    for (let attempt = 0; attempt < 200; attempt++) {
      const result = await admin.query<{ count: number }>(
        `SELECT count(*)::integer AS count FROM pg_locks
         WHERE locktype='advisory' AND classid=$1::oid AND objid=$2::oid AND NOT granted`,
        [namespace, key >>> 0]
      );
      if (result.rows[0]?.count === count) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error("Expected migration advisory-lock waiters were not observed.");
  };
  const assertReleased = async (schema: string) => {
    const connection = await admin.connect();
    try {
      const result = await connection.query(
        "SELECT pg_try_advisory_lock($1::integer,$2::integer) AS acquired", [lockId, schemaKey(schema)]
      );
      expect(result.rows).toEqual([{ acquired: true }]);
      await connection.query("SELECT pg_advisory_unlock($1::integer,$2::integer)", [lockId, schemaKey(schema)]);
    } finally { connection.release(); }
  };

  beforeAll(() => {
    base = new URL(testUrl!);
    if (!["localhost", "127.0.0.1", "[::1]"].includes(base.hostname)
      || !/test/i.test(base.pathname) || base.searchParams.has("options")) {
      throw new Error("Migration lock tests require a dedicated local test database without options.");
    }
    admin = new pg.Pool({ connectionString: base.toString(), max: 4 });
  });

  afterAll(async () => {
    await Promise.all(pools.map(pool => pool.end()));
    if (admin) {
      try {
        for (const schema of schemas) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      } finally { await admin.end(); }
    }
  }, 60_000);

  it("bootstraps two different schemas while the production-wide lock is held", async () => {
    const connection = await admin.connect();
    const fresh = await Promise.all([freshSchema(), freshSchema()]);
    try {
      await connection.query("SELECT pg_advisory_lock($1::bigint)", [lockId]);
      const migrated = await Promise.all(fresh.map(bootstrap));
      const ledgers = [];
      for (const pool of migrated) {
        await assertControlPlaneMigrationsCurrent(pool);
        ledgers.push((await pool.query("SELECT id,checksum FROM schema_migrations ORDER BY id")).rows);
      }
      expect(ledgers[0]!.length).toBeGreaterThan(1);
      expect(ledgers[1]).toEqual(ledgers[0]);
      for (const schema of fresh) await assertReleased(schema);
    } finally {
      await connection.query("SELECT pg_advisory_unlock($1::bigint)", [lockId]);
      connection.release();
    }
  });

  it("serializes two bootstraps of the SAME fresh schema and releases its lock", async () => {
    const schema = await freshSchema();
    const connection = await admin.connect();
    let pending: Promise<DatabasePool[]> | undefined;
    try {
      await connection.query("SELECT pg_advisory_lock($1::integer,$2::integer)", [lockId, schemaKey(schema)]);
      pending = Promise.all([bootstrap(schema), bootstrap(schema)]);
      // Attach a rejection handler while waiting; the assertion still awaits the original promise.
      void pending.catch(() => undefined);
      await waiters(lockId, schemaKey(schema), 2);
    } finally {
      await connection.query("SELECT pg_advisory_unlock($1::integer,$2::integer)", [lockId, schemaKey(schema)]);
      connection.release();
    }
    const migrated = await pending!;
    for (const pool of migrated) await assertControlPlaneMigrationsCurrent(pool);
    expect((await migrated[0]!.query("SELECT id FROM schema_migrations ORDER BY id")).rows)
      .toEqual((await migrated[1]!.query("SELECT id FROM schema_migrations ORDER BY id")).rows);
    await assertReleased(schema);
  });

  it("leaves the default migration runner on the existing one-bigint global lock", async () => {
    const schema = await freshSchema();
    const pool = await openDatabase(scoped(schema));
    pools.push(pool);
    const connection = await admin.connect();
    await connection.query("SELECT pg_advisory_lock($1::bigint)", [lockId]);
    const pending = runControlPlaneMigrations(pool, { lock: true });
    void pending.catch(() => undefined);
    try {
      await waiters(0, lockId, 1);
    } finally {
      await connection.query("SELECT pg_advisory_unlock($1::bigint)", [lockId]);
      connection.release();
    }
    await pending;
    await assertControlPlaneMigrationsCurrent(pool);
  });

  it("releases the schema lock after a failing SQL migration", async () => {
    const schema = await freshSchema();
    const pool = await bootstrap(schema);
    const directory = await mkdtemp(join(import.meta.dirname, ".migration-lock-fixture-"));
    try {
      await writeFile(join(directory, "9999_lock_failure.sql"), "SELECT * FROM missing_lock_fixture;\n");
      await expect(runControlPlaneMigrations(pool, { lock: true, isolatedTestSchema: true, directory }))
        .rejects.toThrow("missing_lock_fixture");
      await assertReleased(schema);
      await assertControlPlaneMigrationsCurrent(pool);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
