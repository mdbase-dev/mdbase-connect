import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, type DatabasePool } from "../../db.js";
import { acceptCohortArchive, addToCohort, cohortArchiveBinding, createCohort, releaseCohort,
  setCohortFrozen, setPaused, startAccountMigration } from "./migration-rollout.js";

const testUrl = process.env.MDBASE_CONNECT_TEST_DATABASE_URL;
const approved = process.env.MDBASE_CONNECT_DESTRUCTIVE_TEST_APPROVAL === "I APPROVE MDBASE CONNECT DESTRUCTIVE POSTGRES TESTS";
const suite = testUrl && approved ? describe : describe.skip;
const actor = "synthetic-lab-archive-pg";

suite("LAB archive acceptance/start (real isolated PG, synthetic verifier DATA only)", () => {
  let db: DatabasePool, admin: pg.Pool, schema: string;
  beforeAll(async () => {
    const url = new URL(testUrl!);
    if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname) || !/test/i.test(url.pathname)) {
      throw new Error("Dedicated local test PostgreSQL required");
    }
    schema = `lab_archive_${randomUUID().replaceAll("-", "")}`;
    admin = new pg.Pool({ connectionString: url.toString(), max: 2 }); await admin.query(`CREATE SCHEMA "${schema}"`);
    url.searchParams.set("options", `-csearch_path=${schema}`); db = await createDatabase(url.toString());
  }, 60_000);
  afterAll(async () => {
    await db?.end(); if (admin && schema) await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin?.end();
  });
  async function fixture() {
    const account = randomUUID(), collection = randomUUID(), cohort = `lab-${randomUUID().slice(0, 8)}`;
    await db.query("INSERT INTO users(id,email,name) VALUES($1,$2,'Synthetic LAB')", [account, `${account}@example.test`]);
    await db.query("INSERT INTO hosted_collections(id,user_id,display_name,template) VALUES($1,$2,'Source','mdbase')", [collection, account]);
    await createCohort(db, cohort, actor); await addToCohort(db, cohort, [account], actor);
    await setCohortFrozen(db, cohort, true, "synthetic verifier fixture", actor);
    await releaseCohort(db, cohort, actor); await setPaused(db, false, "synthetic start fixture", actor);
    const binding = await cohortArchiveBinding(db, cohort);
    const clock = new Date((await db.query("SELECT date_trunc('milliseconds',clock_timestamp()) AS now")).rows[0].now).toISOString();
    const component = (name: string, hex: string) => ({ commit: hex.repeat(40), image_digest: `sha256:${hex.repeat(64)}`, service_id: `srv-synthetic${name}` });
    const body = { schema: "mdbase-recovery-set/lab-cohort-v1", environment: "lab", bucket: "synthetic-archives",
      prefix: `legacy-archive/lab/2026/10/10/${cohort}`, backup_id: cohort,
      complete_sha256: "a".repeat(64), manifest_sha256: "b".repeat(64), source_commit: "f".repeat(40),
      migration_batch: binding, archive_created_at: clock, archive_completed_at: clock,
      retention: { mode: "GOVERNANCE", days: 116, retain_until: new Date(Date.parse(clock) + 116 * 86_400_000).toISOString(), inventory_digest: "c".repeat(64), count: "1" },
      runtime_provenance: { connect: component("connect", "a"), hosted_provider: component("provider", "b"), relay: component("relay", "c"), mcp: component("mcp", "d") } };
    return { account, collection, cohort, body };
  }
  it("stores exact mixed provenance at frozen revision and rechecks acceptance on start/retry", async () => {
    const f = await fixture(); await db.query("UPDATE users SET suspended_at=now() WHERE id=$1", [f.account]);
    await expect(startAccountMigration(db, f.account, "lab")).rejects.toMatchObject({ code: "backup_missing" });
    const accepted = await acceptCohortArchive(db, f.cohort, f.body, "lab");
    expect(await acceptCohortArchive(db, f.cohort, f.body, "lab")).toEqual(accepted);
    const saved = (await db.query("SELECT verified_result,membership_revision::text AS revision FROM next_migration_archive_acceptances WHERE cohort=$1", [f.cohort])).rows[0];
    expect(saved).toEqual({ verified_result: f.body, revision: f.body.migration_batch.membership_revision });
    const started = await startAccountMigration(db, f.account, "lab");
    expect(await startAccountMigration(db, f.account, "lab")).toEqual(started);
    expect((await db.query("SELECT account_backend,suspended_at FROM users WHERE id=$1", [f.account])).rows[0])
      .toMatchObject({ account_backend: "legacy", suspended_at: expect.any(Date) });
    await expect(startAccountMigration(db, f.account, "production")).rejects.toMatchObject({ code: "backup_missing" });
    await expect(db.query("UPDATE next_migration_archive_acceptances SET verified_result=verified_result-'runtime_provenance' WHERE cohort=$1", [f.cohort]))
      .rejects.toThrow("immutable");
    expect(await startAccountMigration(db, f.account, "lab")).toEqual(started);
  });
  it("refuses replacement provenance at the same frozen revision without rewriting acceptance age", async () => {
    const f = await fixture(), accepted = await acceptCohortArchive(db, f.cohort, f.body, "lab");
    await expect(acceptCohortArchive(db, f.cohort, { ...f.body, runtime_provenance: { ...f.body.runtime_provenance,
      connect: { ...f.body.runtime_provenance.connect, commit: "e".repeat(40) } } }, "lab")).rejects.toMatchObject({ code: "backup_conflict" });
    expect(await acceptCohortArchive(db, f.cohort, f.body, "lab")).toEqual(accepted);
  });
  it("keeps the existing v4 production profile and exact timing validator unchanged", async () => {
    const f = await fixture();
    const { runtime_provenance: _unused, ...common } = f.body;
    const body = { ...common, schema: "mdbase-recovery-set/v4", environment: "production", prefix: `production/2026/10/10/${f.cohort}` };
    await acceptCohortArchive(db, f.cohort, body, "production");
    await expect(startAccountMigration(db, f.account, "production")).resolves.toMatchObject({ account_id: f.account });
  });
  it("refuses malformed LAB profile and timing in direct SQL before any start or audit mutation", async () => {
    const f = await fixture(), accepted = f.body.archive_completed_at;
    const { connect: _omitted, ...missingComponent } = f.body.runtime_provenance;
    for (const body of [
      { ...f.body, schema: "mdbase-recovery-set/v3" }, { ...f.body, schema: null },
      { ...f.body, environment: "production" }, { ...f.body, runtime_provenance: undefined },
      { ...f.body, runtime_provenance: null }, { ...f.body, runtime_provenance: [] },
      { ...f.body, runtime_provenance: missingComponent },
      { ...f.body, runtime_provenance: { ...f.body.runtime_provenance, extra: {} } },
      { ...f.body, retention: { ...f.body.retention, days: 120 } },
      { ...f.body, retention: { ...f.body.retention, retain_until: new Date(Date.parse(f.body.retention.retain_until) + 1).toISOString() } },
      { ...f.body, archive_completed_at: new Date(Date.parse(accepted) + 1).toISOString() }
    ]) {
      expect((await db.query("SELECT next_migration_archive_elapsed_valid($1::jsonb,$2::timestamptz,$2::timestamptz) AS valid",
        [JSON.stringify(body), accepted])).rows[0].valid).toBe(false);
      await expect(db.query(`INSERT INTO next_migration_archive_acceptances(cohort,membership_revision,verified_result,accepted_at)
        VALUES($1,$2::bigint,$3::jsonb,$4::timestamptz)`, [f.cohort, f.body.migration_batch.membership_revision, JSON.stringify(body), accepted]))
        .rejects.toThrow(/next_migration_archive_(acceptances_verified_result_check|elapsed_retention)/);
    }
    await expect(startAccountMigration(db, f.account, "lab")).rejects.toMatchObject({ code: "backup_missing" });
    expect((await db.query("SELECT 1 FROM next_migration_archive_acceptances WHERE cohort=$1", [f.cohort])).rowCount).toBe(0);
    expect((await db.query("SELECT started_at FROM next_migration_cohort_members WHERE account_id=$1", [f.account])).rows[0].started_at).toBeNull();
    expect((await db.query("SELECT 1 FROM audit_events WHERE user_id=$1 AND event_type='next_migration.start'", [f.account])).rowCount).toBe(0);
  });
  it.each(["UTC", "America/New_York"])("keeps both profiles on the same elapsed validator across DST in %s", async timezone => {
    const f = await fixture(), client = await db.connect();
    try {
      await client.query("SELECT set_config('TimeZone',$1,false)", [timezone]);
      for (const completed of ["2026-11-01T00:00:00.000Z", "2027-03-13T00:00:00.000Z"]) {
        const created = new Date(Date.parse(completed) - 86_400_000).toISOString();
        const lab = { ...f.body, archive_created_at: created, archive_completed_at: completed,
          retention: { ...f.body.retention, retain_until: new Date(Date.parse(completed) + 116 * 86_400_000).toISOString() } };
        const { runtime_provenance: _unused, ...common } = lab;
        const v4 = { ...common, schema: "mdbase-recovery-set/v4", environment: "production" };
        for (const profile of [lab, v4]) {
          const valid = async (value: unknown) => (await client.query("SELECT next_migration_archive_elapsed_valid($1::jsonb,$2::timestamptz,$2::timestamptz) AS valid",
            [JSON.stringify(value), completed])).rows[0].valid;
          expect(await valid(profile)).toBe(true);
          for (const offset of [-1, 1, -3_600_000, 3_600_000]) {
            expect(await valid({ ...profile, retention: { ...profile.retention,
              retain_until: new Date(Date.parse(profile.retention.retain_until) + offset).toISOString() } })).toBe(false);
          }
          expect(await valid({ ...profile, archive_created_at: new Date(Date.parse(created) - 1).toISOString() })).toBe(false);
        }
      }
    } finally { await client.query("SET TimeZone='UTC'"); client.release(); }
  });
  it("upgrades the actual v4-only validator without rewriting historical receipts or disabling immutability", async () => {
    const f = await fixture(), accepted = f.body.archive_completed_at;
    const { runtime_provenance: _unused, ...common } = f.body;
    const historical = { ...common, schema: "mdbase-recovery-set/v4", environment: "production",
      prefix: `production/2026/10/10/${f.cohort}`, retention: { ...common.retention, days: 120,
        retain_until: new Date(Date.parse(accepted) + 120 * 86_400_000).toISOString() } };
    // Rehearse old immutable history and the real 0065 policy in this owned schema.
    await db.query("ALTER TABLE next_migration_archive_acceptances DROP CONSTRAINT next_migration_archive_elapsed_retention");
    await db.query("DROP FUNCTION next_migration_archive_elapsed_valid(jsonb,timestamptz,timestamptz)");
    await db.query(`INSERT INTO next_migration_archive_acceptances(cohort,membership_revision,verified_result,accepted_at)
      VALUES($1,$2::bigint,$3::jsonb,$4::timestamptz)`, [f.cohort, f.body.migration_batch.membership_revision, JSON.stringify(historical), accepted]);
    await db.query(await readFile(new URL("../../../migrations/0065_next_migration_archive_elapsed_retention.sql", import.meta.url), "utf8"));
    const snapshot = async () => (await db.query("SELECT verified_result::text AS receipt,accepted_at FROM next_migration_archive_acceptances WHERE cohort=$1", [f.cohort])).rows[0];
    const before = await snapshot();
    expect((await db.query("SELECT next_migration_archive_elapsed_valid($1::jsonb,$2::timestamptz,$2::timestamptz) AS valid", [JSON.stringify(f.body), accepted])).rows[0].valid).toBe(false);
    await db.query(await readFile(new URL("../../../migrations/0067_next_migration_lab_archive_profile.sql", import.meta.url), "utf8"));
    expect(await snapshot()).toEqual(before);
    expect((await db.query("SELECT convalidated FROM pg_constraint WHERE conrelid='next_migration_archive_acceptances'::regclass AND conname='next_migration_archive_acceptances_verified_result_check'")).rows[0].convalidated).toBe(false);
    expect((await db.query("SELECT next_migration_archive_elapsed_valid($1::jsonb,$2::timestamptz,$2::timestamptz) AS valid", [JSON.stringify(f.body), accepted])).rows[0].valid).toBe(true);
    await expect(startAccountMigration(db, f.account, "production")).rejects.toMatchObject({ code: "backup_missing" });
    await expect(db.query("UPDATE next_migration_archive_acceptances SET accepted_at=clock_timestamp() WHERE cohort=$1", [f.cohort])).rejects.toThrow(/immutable/);
    await expect(db.query("DELETE FROM next_migration_archive_acceptances WHERE cohort=$1", [f.cohort])).rejects.toThrow(/immutable/);
    expect(await snapshot()).toEqual(before);
  });
  it.each(["mdbase-recovery-set/v3", "mdbase-recovery-set/v4"])("never accepts global/%s data as LAB cohort evidence", async schemaName => {
    const f = await fixture();
    await expect(acceptCohortArchive(db, f.cohort, { ...f.body, schema: schemaName }, "lab")).rejects.toMatchObject({ code: "backup_missing" });
    expect((await db.query("SELECT 1 FROM next_migration_archive_acceptances WHERE cohort=$1", [f.cohort])).rowCount).toBe(0);
  });
});
