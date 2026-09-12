import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, type DatabasePool } from "../../db.js";
import { readConnectLifecycleWork } from "./lifecycle-diagnostics.js";

const TEST_URL_ENV = "MDBASE_CONNECT_TEST_DATABASE_URL";
const APPROVAL_ENV = "MDBASE_CONNECT_DESTRUCTIVE_TEST_APPROVAL";
const REQUIRED_APPROVAL = "I APPROVE MDBASE CONNECT DESTRUCTIVE POSTGRES TESTS";
const testUrl = process.env[TEST_URL_ENV];
const approved = process.env[APPROVAL_ENV] === REQUIRED_APPROVAL;
const describePostgres = testUrl && approved ? describe : describe.skip;
let admin: pg.Pool | undefined;
let db: DatabasePool | undefined;
let schema: string | undefined;

function approvedLoopbackUrl(value: string): URL {
  const url = new URL(value);
  const database = url.pathname.slice(1);
  if (!["localhost", "127.0.0.1", "::1"].includes(url.hostname)
    || !database || !/test/i.test(database)
    || ["postgres", "template0", "template1"].includes(database)) {
    throw new Error(`${TEST_URL_ENV} must name a disposable loopback test database.`);
  }
  return url;
}

function scopedUrl(url: URL, searchPath: string): string {
  const scoped = new URL(url);
  scoped.searchParams.set("options", `-csearch_path=${searchPath}`);
  return scoped.toString();
}

async function addApplication(): Promise<string> {
  const id = randomUUID();
  await db!.query(`INSERT INTO applications
    (id,canonical_identity,family_identity,name,homepage,redirect_uris,requirements,notifications,manifest_digest)
    VALUES ($1,$2,$3,'Lifecycle fixture','https://example.test','[]','{"contracts":[]}',
      '{"criteria":[]}',$4)`, [id, `https://example.test/${id}`, `bundle:${id}`, "d".repeat(64)]);
  return id;
}

async function addJob(application: string, shape: string): Promise<void> {
  await db!.query(`INSERT INTO application_reconciliation_jobs
    (application_id,state,phase,available_at,lease_token,lease_expires_at,cursor_grant_id,
      next_scan_at,updated_at) VALUES ($1,${shape})`, [application]);
}

describePostgres("Connect lifecycle diagnostics PostgreSQL aggregates", () => {
  beforeAll(async () => {
    const url = approvedLoopbackUrl(testUrl!);
    schema = `mdbase_lifecycle_diag_${randomUUID().replaceAll("-", "")}`;
    admin = new pg.Pool({ connectionString: url.toString(), max: 2 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    try {
      db = await createDatabase(scopedUrl(url, schema));
      const constraints = await db.query<{ conname: string }>(`SELECT conname FROM pg_constraint
        WHERE conrelid='application_reconciliation_jobs'::regclass AND contype='c'`);
      for (const { conname } of constraints.rows) {
        await db.query(`ALTER TABLE application_reconciliation_jobs DROP CONSTRAINT "${conname}"`);
      }
    } catch (error) {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      throw error;
    }
  });

  afterAll(async () => {
    await db?.end().catch(() => undefined);
    if (admin && schema) await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin?.end();
  });

  it("uses production SQL for zero and nonzero cleanup and reconciliation matrices", async () => {
    expect(await readConnectLifecycleWork(db!)).toEqual({
      cleanup: { open: 0, stale: 0, poison: 0, reclaimable_sending: 0,
        impossible: 0, oldest_open_seconds: null },
      application_reconciliation: { due: 0, stale_due: 0, expired_leases: 0,
        applications_missing_jobs: 0, retryable_results: 0,
        quarantined_active_grants: 0, impossible: 0, oldest_due_seconds: null }
    });

    const privateError = "fixture error /private/customer/path";
    const cleanupValues = [
      ["provider_revocation_jobs", "'pending',0,now(),NULL,NULL,now()"],
      ["provider_collection_deletion_jobs", "'sending',5,now()-interval '1 second',$$fixture error /private/customer/path$$,NULL,now()-interval '20 minutes'"],
      ["provider_revocation_jobs", "'pending',0,now(),NULL,NULL,now()-interval '15 minutes'"],
      ["provider_collection_deletion_jobs", "'completed',1,now(),NULL,now(),now()-interval '1 hour'"],
      ["provider_revocation_jobs", "'completed',1,now(),$$impossible private error$$,now(),now()-interval '1 hour'"],
      ["provider_collection_deletion_jobs", "'pending',0,now(),NULL,now(),now()-interval '1 hour'"]
    ] as const;
    for (const [table, values] of cleanupValues) {
      const id = randomUUID();
      if (table === "provider_revocation_jobs") {
        await db!.query(`INSERT INTO ${table}
          (id,replica_id,collection_id,reason,state,attempts,available_at,last_error,completed_at,created_at)
          VALUES ($1,$2,$3,'test',${values})`, [id, randomUUID(), randomUUID()]);
      } else {
        await db!.query(`INSERT INTO ${table}
          (id,collection_id,reason,state,attempts,available_at,last_error,completed_at,created_at)
          VALUES ($1,$2,'account_deletion',${values})`, [id, randomUUID()]);
      }
    }

    const missing = await addApplication();
    const pending = await addApplication();
    const expired = await addApplication();
    const completedDue = await addApplication();
    const completedFuture = await addApplication();
    const malformedLease = await addApplication();
    const malformedRetry = await addApplication();
    const malformedCompleted = await addApplication();
    await addJob(pending, "'pending','scan',now()-interval '20 minutes',NULL,NULL,NULL,NULL,now()-interval '20 minutes'");
    await addJob(expired, `'leased','scan',now()-interval '20 minutes','${randomUUID()}',now()-interval '15 minutes',NULL,NULL,now()-interval '20 minutes'`);
    await addJob(completedDue, "'completed','scan',now(),NULL,NULL,NULL,now()-interval '12 minutes',now()-interval '20 minutes'");
    await addJob(completedFuture, "'completed','scan',now(),NULL,NULL,NULL,now()+interval '1 hour',now()");
    await addJob(malformedLease, "'leased','scan',now()+interval '1 hour',NULL,NULL,NULL,NULL,now()");
    await addJob(malformedRetry, `'pending','retry',now()+interval '1 hour',NULL,NULL,'${randomUUID()}',NULL,now()`);
    await addJob(malformedCompleted, "'completed','retry',now()+interval '1 hour',NULL,NULL,NULL,NULL,now()");

    const user = randomUUID(); const collection = randomUUID();
    await db!.query("INSERT INTO users (id,email,name) VALUES ($1,$2,'Lifecycle user')",
      [user, `${user}@example.test`]);
    await db!.query(`INSERT INTO hosted_collections (id,user_id,display_name,template)
      VALUES ($1,$2,'Lifecycle collection','blank')`, [collection, user]);
    const activeGrant = randomUUID(); const inactiveGrant = randomUUID();
    await db!.query(`INSERT INTO grants
      (id,user_id,application_id,hosted_collection_id,operations,activated_at,revoked_at)
      VALUES ($1,$2,$3,$4,'[]',now(),NULL),($5,$2,$3,$4,'[]',now(),now())`,
    [activeGrant, user, pending, collection, inactiveGrant]);
    await db!.query(`INSERT INTO application_reconciliation_results
      (application_id,grant_id,status,error_class,consecutive_attempts,next_retry_at)
      VALUES ($1,$2,'quarantined','ownership',5,now()),
             ($1,$3,'quarantined','ownership',5,now())`,
    [pending, activeGrant, inactiveGrant]);
    // The primary key permits one status per grant: retain retryable on another active grant.
    const retryGrant = randomUUID();
    await db!.query(`INSERT INTO grants
      (id,user_id,application_id,hosted_collection_id,operations) VALUES ($1,$2,$3,$4,'[]')`,
    [retryGrant, user, pending, collection]);
    await db!.query(`INSERT INTO application_reconciliation_results
      (application_id,grant_id,status,error_class,consecutive_attempts,next_retry_at)
      VALUES ($1,$2,'retryable','provider',1,now())`, [pending, retryGrant]);

    const result = await readConnectLifecycleWork(db!);
    expect(result.cleanup).toMatchObject({
      open: 3, stale: 2, poison: 1, reclaimable_sending: 1, impossible: 2
    });
    expect(result.cleanup.oldest_open_seconds).toBeGreaterThanOrEqual(1_199);
    expect(result.application_reconciliation).toMatchObject({
      due: 3, stale_due: 3, expired_leases: 1, applications_missing_jobs: 1,
      retryable_results: 1, quarantined_active_grants: 1, impossible: 3
    });
    expect(result.application_reconciliation.oldest_due_seconds).toBeGreaterThanOrEqual(1_199);
    const serialized = JSON.stringify(result);
    for (const privateValue of [missing, privateError, "/private/customer/path", user, collection]) {
      expect(serialized).not.toContain(privateValue);
    }
  });
});
