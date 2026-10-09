import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, type DatabasePool } from "../../db.js";
import { acceptCohortArchive, addToCohort, cohortArchiveBinding, createCohort, releaseCohort,
  setCohortFrozen, setPaused, startAccountMigration } from "./migration-rollout.js";

const testUrl = process.env.MDBASE_CONNECT_TEST_DATABASE_URL;
const approved = process.env.MDBASE_CONNECT_DESTRUCTIVE_TEST_APPROVAL === "I APPROVE MDBASE CONNECT DESTRUCTIVE POSTGRES TESTS";
const describePg = testUrl && approved ? describe : describe.skip;
const DAY = 86_400_000;
const hex = "a".repeat(64);
const sqlFile = new URL("../../../migrations/0065_next_migration_archive_elapsed_retention.sql", import.meta.url);

// Synthetic verifier metadata only: these tests do not capture/restore archives,
// establish byte omission, authenticate a provider, or prove actual removal.
describePg("exact elapsed archive retention (isolated real PostgreSQL)", () => {
  let db: DatabasePool, admin: pg.Pool, schema: string;
  beforeAll(async () => {
    const url = new URL(testUrl!);
    if (!["localhost", "127.0.0.1", "::1"].includes(url.hostname) || !/test/i.test(url.pathname)) throw new Error("Dedicated local test PostgreSQL required");
    schema = `migration_retention_${randomUUID().replaceAll("-", "")}`;
    admin = new pg.Pool({ connectionString: url.toString(), max: 2 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    url.searchParams.set("options", `-csearch_path=${schema}`);
    db = await createDatabase(url.toString());
    await setPaused(db, false, "synthetic test", "synthetic-pg");
  }, 60_000);
  afterAll(async () => {
    await db?.end();
    if (admin && schema) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin?.end();
  });
  function wire(start: string, completion = start) {
    return { schema: "mdbase-recovery-set/v4", environment: "production", bucket: "synthetic-archives",
      prefix: "production/2026/10/08/synthetic", backup_id: "synthetic", complete_sha256: hex,
      manifest_sha256: hex, source_commit: "a".repeat(40),
      migration_batch: { batch_id: "synthetic", membership_revision: "1", membership_digest: hex, membership_changed_at: start },
      archive_created_at: start, archive_completed_at: completion,
      retention: { mode: "GOVERNANCE", days: 116, retain_until: new Date(Date.parse(completion) + 116 * DAY).toISOString(), inventory_digest: hex, count: "3" } };
  }
  async function batch() {
    const account = randomUUID(), name = `r-${randomUUID().slice(0, 8)}`;
    await db.query("INSERT INTO users(id,email,name) VALUES($1,$2,'Synthetic')", [account, `${account}@example.test`]);
    await createCohort(db, name, "synthetic-pg");await addToCohort(db, name, [account], "synthetic-pg");
    await releaseCohort(db, name, "synthetic-pg");await setCohortFrozen(db, name, true, "synthetic capture", "synthetic-pg");
    const now = new Date((await db.query("SELECT date_trunc('milliseconds',clock_timestamp()) AS now")).rows[0].now).toISOString();
    const body = wire(now);body.migration_batch = await cohortArchiveBinding(db, name);
    return { account, name, body, now };
  }
  async function insert(name: string, body: ReturnType<typeof wire>, accepted: string) {
    return db.query(`INSERT INTO next_migration_archive_acceptances(cohort,membership_revision,verified_result,accepted_at)
      VALUES($1,$2::bigint,$3::jsonb,$4::timestamptz)`, [name, body.migration_batch.membership_revision, JSON.stringify(body), accepted]);
  }

  it("applies NOT VALID without rewriting historical120 receipts, and denies their current claims and retries", async () => {
    const { account, name, body, now } = await batch();
    body.retention.days = 120;body.retention.retain_until = new Date(Date.parse(now) + 120 * DAY).toISOString();
    // Rehearse upgrading an already populated isolated schema. Historical SQL
    // files and immutable triggers are never edited or disabled.
    await db.query("ALTER TABLE next_migration_archive_acceptances DROP CONSTRAINT next_migration_archive_elapsed_retention");
    await db.query("DROP FUNCTION next_migration_archive_elapsed_valid(jsonb,timestamptz,timestamptz)");
    await insert(name, body, now);
    const snapshot = () => db.query("SELECT verified_result::text AS receipt,accepted_at FROM next_migration_archive_acceptances WHERE cohort=$1", [name]);
    const before = (await snapshot()).rows[0];
    await db.query(await readFile(sqlFile, "utf8"));
    expect((await snapshot()).rows[0]).toEqual(before);
    expect((await db.query("SELECT convalidated FROM pg_constraint WHERE conrelid='next_migration_archive_acceptances'::regclass AND conname='next_migration_archive_elapsed_retention'")).rows[0].convalidated).toBe(false);
    await expect(startAccountMigration(db, account, "production")).rejects.toMatchObject({ code: "backup_missing" });
    await expect(acceptCohortArchive(db, name, body, "production")).rejects.toMatchObject({ code: "backup_missing" });
    const fresh = structuredClone(body);fresh.retention.days = 116;fresh.retention.retain_until = new Date(Date.parse(now) + 116 * DAY).toISOString();
    await expect(acceptCohortArchive(db, name, fresh, "production")).rejects.toMatchObject({ code: "backup_missing" });
    await expect(db.query("UPDATE next_migration_archive_acceptances SET accepted_at=clock_timestamp() WHERE cohort=$1", [name])).rejects.toThrow(/immutable/);
    await expect(db.query("DELETE FROM next_migration_archive_acceptances WHERE cohort=$1", [name])).rejects.toThrow(/immutable/);
    expect((await snapshot()).rows[0]).toEqual(before);
    expect((await db.query("SELECT started_at FROM next_migration_cohort_members WHERE account_id=$1", [account])).rows[0].started_at).toBeNull();
    expect((await db.query("SELECT 1 FROM audit_events WHERE user_id=$1 AND event_type='next_migration.start'", [account])).rowCount).toBe(0);
  });

  for (const timezone of ["UTC", "America/New_York"]) {
    it(`uses elapsed seconds across both DST directions in ${timezone}`, async () => {
      const client = await db.connect();
      try {
        await client.query("SELECT set_config('TimeZone',$1,false)", [timezone]);
        for (const [start, completed, expiry, drift] of [
          ["2026-10-31T00:00:00.000Z", "2026-11-01T00:00:00.000Z", "2027-02-25T00:00:00.000Z", 3_600_000],
          ["2027-03-12T00:00:00.000Z", "2027-03-13T00:00:00.000Z", "2027-07-07T00:00:00.000Z", -3_600_000]
        ] as const) {
          const body = wire(start, completed);expect(body.retention.retain_until).toBe(expiry);
          const valid = async (value: typeof body) => (await client.query("SELECT next_migration_archive_elapsed_valid($1::jsonb,$2::timestamptz,$2::timestamptz) AS valid", [JSON.stringify(value), completed])).rows[0].valid;
          expect(await valid(body)).toBe(true);
          const calendar = (await client.query("SELECT $1::timestamptz + interval '116 days' AS expiry", [completed])).rows[0].expiry;
          expect(new Date(calendar).getTime() - Date.parse(expiry)).toBe(timezone === "UTC" ? 0 : drift);
          for (const offset of [-1, 1, drift, 4 * DAY]) {
            const wrong = structuredClone(body);wrong.retention.retain_until = new Date(Date.parse(expiry) + offset).toISOString();
            expect(await valid(wrong)).toBe(false);
          }
        }
      } finally { await client.query("SET TimeZone='UTC'");client.release(); }
    });
  }

  it("enforces 24h +/-1ms, chronology, canonical finite times and exact116 in the real function", async () => {
    const start = "2026-10-01T00:00:00.000Z", clock = "2026-10-03T00:00:00.000Z";
    const valid = async (body: unknown, accepted = clock, now = clock) => (await db.query("SELECT next_migration_archive_elapsed_valid($1::jsonb,$2::timestamptz,$3::timestamptz) AS valid", [JSON.stringify(body), accepted, now])).rows[0].valid;
    for (const delta of [-1, 0, 1]) {
      const body = wire(start, new Date(Date.parse(start) + DAY + delta).toISOString());
      expect(await valid(body)).toBe(delta <= 0);
    }
    expect(await valid(wire(start, new Date(Date.parse(start) - 1).toISOString()))).toBe(false);
    for (const invalid of ["infinity", "-infinity", "NaN", "0000-01-01T00:00:00.000Z", "+010000-01-01T00:00:00.000Z", "2026-02-30T00:00:00.000Z", "2026-10-01T00:00:00.0001Z", "2026-10-01T00:00:00.000+00:00"]) {
      expect(await valid({ ...wire(start), archive_created_at: invalid })).toBe(false);
    }
    for (const days of [120, 115, "116", true]) {
      const body = wire(start);expect(await valid({ ...body, retention: { ...body.retention, days } })).toBe(false);
    }
    expect(await valid(wire(start), "infinity")).toBe(false);
    expect(await valid(wire(start), clock, "infinity")).toBe(false);
    expect(await valid(wire(start), "2026-10-03T00:00:00.0001Z")).toBe(false);
    expect(await valid(wire(clock), start, start)).toBe(false);
  });

  it("enforces new-row rejection in SQL before acceptance/claim or audit mutation", async () => {
    for (const failure of ["old120", "extended", "short", "long_capture", "future"] as const) {
      const { account, name, body, now } = await batch();
      if (failure === "old120") body.retention.days = 120;
      if (failure === "extended") body.retention.retain_until = new Date(Date.parse(body.retention.retain_until) + 1).toISOString();
      if (failure === "short") body.retention.retain_until = new Date(Date.parse(body.retention.retain_until) - 1).toISOString();
      if (failure === "long_capture") body.archive_created_at = new Date(Date.parse(now) - DAY - 1).toISOString();
      if (failure === "future") {
        body.archive_created_at = body.archive_completed_at = new Date(Date.parse(now) + DAY).toISOString();
        body.retention.retain_until = new Date(Date.parse(body.archive_completed_at) + 116 * DAY).toISOString();
      }
      await expect(insert(name, body, now)).rejects.toThrow(/next_migration_archive_elapsed_retention/);
      await expect(acceptCohortArchive(db, name, body, "production")).rejects.toMatchObject({ code: "backup_missing" });
      expect((await db.query("SELECT 1 FROM next_migration_archive_acceptances WHERE cohort=$1", [name])).rowCount).toBe(0);
      expect((await db.query("SELECT started_at FROM next_migration_cohort_members WHERE account_id=$1", [account])).rows[0].started_at).toBeNull();
    }
  });

  it("preserves original116 acceptance and atomic currentness across exact retries and a real membership-lock wait", async () => {
    const { account, name, body } = await batch();
    const original = await acceptCohortArchive(db, name, body, "production");
    expect(await acceptCohortArchive(db, name, body, "production")).toEqual(original);
    const claim = await startAccountMigration(db, account, "production");
    expect(await startAccountMigration(db, account, "production")).toEqual(claim);
    const another = randomUUID();await db.query("INSERT INTO users(id,email,name) VALUES($1,$2,'Synthetic')", [another, `${another}@example.test`]);
    const mutation = await db.connect();await mutation.query("BEGIN");
    try {
      await mutation.query("INSERT INTO next_migration_cohort_members(account_id,cohort) VALUES($1,$2)", [another, name]);
      let settled = false;
      const retry = startAccountMigration(db, account, "production").then(() => "started", (error: { code?: string }) => error.code).finally(() => { settled = true; });
      await new Promise((resolve) => setTimeout(resolve, 40));expect(settled).toBe(false);
      await mutation.query("COMMIT");expect(await retry).toBe("backup_missing");
      const stored = (await db.query("SELECT accepted_at FROM next_migration_archive_acceptances WHERE cohort=$1", [name])).rows[0];
      expect(new Date(stored.accepted_at).toISOString()).toBe(original.accepted_at);
      expect((await db.query("SELECT started_at FROM next_migration_cohort_members WHERE account_id=$1", [account])).rows[0].started_at.toISOString()).toBe(claim.started_at);
    } finally { await mutation.query("ROLLBACK").catch(() => undefined);mutation.release(); }
  });
});
