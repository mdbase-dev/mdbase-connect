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

async function promptly<T>(operation: Promise<T>): Promise<T> {
  return Promise.race([
    operation,
    new Promise<never>((_, reject) => setTimeout(
      () => reject(new Error("PostgreSQL reconciliation claim blocked on a row lock.")), 1_000
    ))
  ]);
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
    schema = `mdbase_reconciliation_test_${randomUUID().replaceAll("-", "")}`;
    admin = new pg.Pool({ connectionString: url.toString(), max: 2 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    try {
      db = await createDatabase(schemaUrl(url, schema));
      // Exercise takeover normalization of legacy rows that current constraints
      // prevent newly writing, but that the worker deliberately still repairs.
      const shapeConstraints = await db.query<{ conname: string }>(`SELECT conname
        FROM pg_constraint WHERE conrelid='application_reconciliation_jobs'::regclass
          AND contype='c' AND (pg_get_constraintdef(oid) LIKE '%phase <>%'
            OR pg_get_constraintdef(oid) LIKE '%state <>%completed%')`);
      for (const { conname } of shapeConstraints.rows) {
        await db.query(`ALTER TABLE application_reconciliation_jobs DROP CONSTRAINT "${conname}"`);
      }
    } catch (error) {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      throw error;
    }
  });

  afterEach(async () => {
    if (db && fixtureApplications.length) {
      await db.query("DELETE FROM applications WHERE id=ANY($1::uuid[])",
        [fixtureApplications.splice(0)]);
    }
  });

  afterAll(async () => {
    await db?.end().catch(() => undefined);
    if (admin && schema) {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
    }
    await admin?.end().catch(() => undefined);
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
