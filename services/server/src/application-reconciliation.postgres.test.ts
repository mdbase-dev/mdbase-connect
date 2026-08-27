import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { claimApplicationReconciliationJob } from "./application-reconciliation-claim.js";
import { createDatabase, type DatabaseConnection, type DatabasePool } from "./db.js";

const TEST_URL_ENV = "MDBASE_CONNECT_TEST_DATABASE_URL";
const APPROVAL_ENV = "MDBASE_CONNECT_DESTRUCTIVE_TEST_APPROVAL";
// Required verbatim alongside a dedicated local PostgreSQL URL. This test
// creates and unconditionally drops only its own unique schema.
const REQUIRED_APPROVAL = "I APPROVE MDBASE CONNECT DESTRUCTIVE POSTGRES TESTS";
const testUrl = process.env[TEST_URL_ENV];
const approved = process.env[APPROVAL_ENV] === REQUIRED_APPROVAL;
const describePostgres = testUrl && approved ? describe : describe.skip;

let admin: pg.Pool | undefined;
let db: DatabasePool | undefined;
let schema: string | undefined;
let sentinelSchema: string | undefined;
const sentinelBytes = Buffer.from("migration-isolation-sentinel\u0000unchanged");
const fixtureApplications: string[] = [];

function safeTestUrl(value: string): URL {
  const url = new URL(value);
  const database = url.pathname.slice(1);
  if (!(["localhost", "127.0.0.1", "::1"].includes(url.hostname))
    || !database || ["postgres", "template0", "template1"].includes(database)
    || !/test/i.test(database)) {
    throw new Error(`${TEST_URL_ENV} must name a dedicated local test database.`);
  }
  return url;
}

function schemaUrl(url: URL, name: string): string {
  const scoped = new URL(url);
  scoped.searchParams.set("options", `-csearch_path=${name}`);
  return scoped.toString();
}

async function bounded<T>(operation: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      })
    ]);
  } finally { if (timer) clearTimeout(timer); }
}

async function promptly<T>(operation: Promise<T>): Promise<T> {
  return bounded(operation, 1_000,
    "PostgreSQL reconciliation claim blocked on a row lock.");
}

async function addApplication(): Promise<string> {
  const id = randomUUID(); fixtureApplications.push(id);
  await db!.query(`INSERT INTO applications
    (id,canonical_identity,family_identity,name,homepage,redirect_uris,requirements,notifications,manifest_digest)
    VALUES ($1,$2,$3,'Postgres claim test','https://example.test','[]','{"contracts":[]}',
      '{"criteria":[]}',$4)`, [id, `https://example.test/${id}`, `bundle:${id}`, "a".repeat(64)]);
  return id;
}

async function addJob(values = "'pending','scan',now(),NULL,NULL,NULL,0") {
  const application = await addApplication();
  await db!.query(`INSERT INTO application_reconciliation_jobs
    (application_id,state,phase,available_at,lease_token,lease_expires_at,cursor_grant_id,attempts)
    VALUES ($1,${values})`, [application]);
  return application;
}

async function rollbackRelease(connection: DatabaseConnection | undefined) {
  if (!connection) return;
  await connection.query("ROLLBACK").catch(() => undefined);
  connection.release();
}

describePostgres("application reconciliation PostgreSQL locking", () => {
  beforeAll(async () => {
    const url = safeTestUrl(testUrl!);
    const suffix = randomUUID().replaceAll("-", "");
    schema = `mdbase_reconciliation_test_${suffix}`;
    sentinelSchema = `mdbase_reconciliation_sentinel_${suffix}`;
    admin = new pg.Pool({ connectionString: url.toString(), max: 2 });
    await admin.query(`CREATE SCHEMA "${sentinelSchema}"`);
    await admin.query(`CREATE TABLE "${sentinelSchema}".sentinel (id integer PRIMARY KEY, payload bytea NOT NULL)`);
    await admin.query(`INSERT INTO "${sentinelSchema}".sentinel VALUES (1,$1)`, [sentinelBytes]);
    await admin.query(`CREATE SCHEMA "${schema}"`);
    try {
      const migrated = await createDatabase(schemaUrl(url, schema));
      db = migrated;
      // Exercise takeover normalization of legacy rows that current constraints
      // prevent newly writing, but that the worker deliberately still repairs.
      const shapeConstraints = await migrated.query<{ conname: string }>(`SELECT conname
        FROM pg_constraint WHERE conrelid='application_reconciliation_jobs'::regclass
          AND contype='c' AND (pg_get_constraintdef(oid) LIKE '%phase <>%'
            OR pg_get_constraintdef(oid) LIKE '%state <>%completed%')`);
      for (const { conname } of shapeConstraints.rows) {
        await migrated.query(`ALTER TABLE application_reconciliation_jobs DROP CONSTRAINT "${conname}"`);
      }
    } catch (error) {
      await db?.end().catch(() => undefined); db = undefined;
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
      throw error;
    }
  }, 60_000);

  afterEach(async () => {
    if (db && fixtureApplications.length) {
      await db.query("DELETE FROM applications WHERE id=ANY($1::uuid[])",
        [fixtureApplications.splice(0)]);
    }
  });

  afterAll(async () => {
    if (db) await bounded(db.end(), 15_000, "Timed out closing the test database.").catch(() => undefined);
    db = undefined;
    if (admin && schema) {
      await bounded(admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`), 15_000,
        "Timed out dropping the reconciliation test schema.").catch(() => undefined);
    }
    if (admin && sentinelSchema) {
      await bounded(admin.query(`DROP SCHEMA IF EXISTS "${sentinelSchema}" CASCADE`), 15_000,
        "Timed out dropping the sentinel test schema.").catch(() => undefined);
    }
    if (admin) await bounded(admin.end(), 15_000, "Timed out closing the admin pool.").catch(() => undefined);
    admin = undefined;
  }, 60_000);

  it("keeps migrations and their ledger inside the configured schema", async () => {
    const ledger = await db!.query<{ current_schema: string; migrations: number }>(
      "SELECT current_schema(),(SELECT count(*)::integer FROM schema_migrations) AS migrations"
    );
    expect(ledger.rows[0].current_schema).toBe(schema);
    expect(ledger.rows[0].migrations).toBeGreaterThan(1);
    const sentinel = await admin!.query<{ payload: Buffer }>(
      `SELECT payload FROM "${sentinelSchema}".sentinel WHERE id=1`
    );
    expect(sentinel.rows).toHaveLength(1);
    expect(sentinel.rows[0].payload.equals(sentinelBytes)).toBe(true);
    const sentinelTables = await admin!.query<{ table_name: string }>(`SELECT table_name
      FROM information_schema.tables WHERE table_schema=$1 ORDER BY table_name`, [sentinelSchema]);
    expect(sentinelTables.rows).toEqual([{ table_name: "sentinel" }]);
  });

  it("allows exactly one of two simultaneous workers to claim one due job", async () => {
    const application = await addJob("'pending','scan',now()-interval '1 second',NULL,NULL,NULL,3");
    let first: DatabaseConnection | undefined; let second: DatabaseConnection | undefined;
    let start!: () => void;
    const barrier = new Promise<void>((resolve) => { start = resolve; });
    try {
      first = await db!.connect(); second = await db!.connect();
      const claims = [first, second].map(async (connection) => {
        await barrier;
        return claimApplicationReconciliationJob(connection, [], 60_000);
      });
      start();
      const results = await bounded(Promise.all(claims), 2_000,
        "Simultaneous one-job claims did not complete.");
      const winners = results.filter((claim) => claim !== null);
      expect(winners).toHaveLength(1);
      expect(winners[0]!.applicationId).toBe(application);
      const persisted = (await db!.query<{ state: string; attempts: number; lease_token: string }>(
        "SELECT state,attempts,lease_token FROM application_reconciliation_jobs WHERE application_id=$1",
        [application])).rows[0];
      expect(persisted).toMatchObject({ state: "leased", attempts: 4,
        lease_token: winners[0]!.token });
    } finally { first?.release(); second?.release(); }
  });

  it("allows two simultaneous workers to claim two distinct due jobs without blocking", async () => {
    const applications = [
      await addJob("'pending','scan',now()-interval '2 seconds',NULL,NULL,NULL,0"),
      await addJob("'pending','scan',now()-interval '1 second',NULL,NULL,NULL,0")
    ];
    let first: DatabaseConnection | undefined; let second: DatabaseConnection | undefined;
    let start!: () => void;
    const barrier = new Promise<void>((resolve) => { start = resolve; });
    try {
      first = await db!.connect(); second = await db!.connect();
      const claims = [first, second].map(async (connection) => {
        await barrier;
        return claimApplicationReconciliationJob(connection, [], 60_000);
      });
      start();
      const results = await bounded(Promise.all(claims), 2_000,
        "Simultaneous two-job claims did not complete.");
      expect(results.every((claim) => claim !== null)).toBe(true);
      expect(new Set(results.map((claim) => claim!.applicationId))).toEqual(new Set(applications));
      expect(new Set(results.map((claim) => claim!.token)).size).toBe(2);
      const persisted = await db!.query<{ application_id: string; attempts: number; lease_token: string }>(
        "SELECT application_id,attempts,lease_token FROM application_reconciliation_jobs WHERE application_id=ANY($1::uuid[])",
        [applications]);
      expect(persisted.rows).toHaveLength(2);
      expect(persisted.rows.every((row) => row.attempts === 1)).toBe(true);
      for (const row of persisted.rows) {
        expect(row.lease_token).toBe(results.find(
          (claim) => claim!.applicationId === row.application_id)!.token);
      }
    } finally { first?.release(); second?.release(); }
  });

  it("skips a due row rescheduled under lock and claims unrelated ready work promptly", async () => {
    const locked = await addJob("'pending','scan',now()-interval '2 seconds',NULL,NULL,NULL,0");
    const other = await addJob("'pending','scan',now()-interval '1 second',NULL,NULL,NULL,0");
    let a: DatabaseConnection | undefined;
    try {
      a = await db!.connect(); await a.query("BEGIN");
      await a.query("SELECT 1 FROM application_reconciliation_jobs WHERE application_id=$1 FOR UPDATE", [locked]);
      await a.query("UPDATE application_reconciliation_jobs SET available_at=now()+interval '1 hour' WHERE application_id=$1", [locked]);
      const claimed = await promptly(claimApplicationReconciliationJob(db!, [], 60_000));
      expect(claimed?.applicationId).toBe(other);
      await a.query("COMMIT"); a.release(); a = undefined;
      const row = (await db!.query("SELECT state,attempts FROM application_reconciliation_jobs WHERE application_id=$1", [locked])).rows[0];
      expect(row).toMatchObject({ state: "pending", attempts: 0 });
    } finally { await rollbackRelease(a); }
  });

  it("returns no one-job claim promptly and leaves the committed future job untouched", async () => {
    const locked = await addJob("'pending','retry',now()-interval '1 second',NULL,NULL,NULL,4");
    let a: DatabaseConnection | undefined;
    try {
      a = await db!.connect(); await a.query("BEGIN");
      await a.query("SELECT 1 FROM application_reconciliation_jobs WHERE application_id=$1 FOR UPDATE", [locked]);
      await a.query("UPDATE application_reconciliation_jobs SET available_at=now()+interval '1 hour' WHERE application_id=$1", [locked]);
      expect(await promptly(claimApplicationReconciliationJob(db!, [], 60_000))).toBeNull();
      await a.query("COMMIT"); a.release(); a = undefined;
      expect(await claimApplicationReconciliationJob(db!, [], 60_000)).toBeNull();
      const row = (await db!.query("SELECT state,attempts,lease_token FROM application_reconciliation_jobs WHERE application_id=$1", [locked])).rows[0];
      expect(row).toMatchObject({ state: "pending", attempts: 4, lease_token: null });
    } finally { await rollbackRelease(a); }
  });

  it("covers eligibility, exclusions, ordering, state reset, tokens, attempts, and uniqueness", async () => {
    const cursorPending = randomUUID(); const cursorExpired = randomUUID(); const cursorCompleted = randomUUID();
    const pending = await addJob(`'pending','scan',now()-interval '3 seconds',NULL,NULL,'${cursorPending}',2`);
    const expired = await addJob(`'leased','scan',now()-interval '2 seconds','${randomUUID()}',now()-interval '1 second','${cursorExpired}',5`);
    const completed = await addJob(`'completed','retry',now()-interval '1 second',NULL,NULL,'${cursorCompleted}',7`);
    await db!.query("UPDATE application_reconciliation_jobs SET next_scan_at=now()-interval '1 second' WHERE application_id=$1", [completed]);
    await addJob("'pending','scan',now()+interval '1 hour',NULL,NULL,NULL,0");
    await addJob(`'leased','scan',now()-interval '1 hour','${randomUUID()}',now()+interval '1 hour',NULL,0`);
    const notDueCompleted = await addJob("'completed','scan',now()-interval '1 hour',NULL,NULL,NULL,0");
    await db!.query("UPDATE application_reconciliation_jobs SET next_scan_at=now()+interval '1 hour' WHERE application_id=$1", [notDueCompleted]);

    const first = await claimApplicationReconciliationJob(db!, [pending], 60_000);
    expect(first).toMatchObject({ applicationId: expired, phase: "scan", cursorGrantId: cursorExpired });
    const expiredRow = (await db!.query("SELECT attempts,lease_token FROM application_reconciliation_jobs WHERE application_id=$1", [expired])).rows[0];
    expect(expiredRow.attempts).toBe(6); expect(expiredRow.lease_token).toBe(first!.token);

    const second = await claimApplicationReconciliationJob(db!, [], 60_000);
    expect(second).toMatchObject({ applicationId: pending, phase: "scan", cursorGrantId: cursorPending });
    expect(second!.token).not.toBe(first!.token);

    const third = await claimApplicationReconciliationJob(db!, [], 60_000);
    expect(third).toMatchObject({ applicationId: completed, phase: "scan", cursorGrantId: null });
    const completedRow = (await db!.query("SELECT attempts,phase,cursor_grant_id FROM application_reconciliation_jobs WHERE application_id=$1", [completed])).rows[0];
    expect(completedRow).toMatchObject({ attempts: 8, phase: "scan", cursor_grant_id: null });
    expect(await claimApplicationReconciliationJob(db!, [], 60_000)).toBeNull();
  });
});
