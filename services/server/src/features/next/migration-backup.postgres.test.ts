import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, type DatabasePool } from "../../db.js";
import { acceptCohortArchive, addToCohort, cohortArchiveBinding, createCohort, migrationMembershipDigest,
  registerMigrationRolloutRoutes, releaseCohort, setCohortFrozen, setPaused, startAccountMigration, type ArchiveBinding } from "./migration-rollout.js";

const testUrl = process.env.MDBASE_CONNECT_TEST_DATABASE_URL;
const approved = process.env.MDBASE_CONNECT_DESTRUCTIVE_TEST_APPROVAL === "I APPROVE MDBASE CONNECT DESTRUCTIVE POSTGRES TESTS";
const describePg = testUrl && approved ? describe : describe.skip;
const hex = (n: number) => n.toString(16).padStart(64, "0");
const token = "h0-test-migration-token";
const OP = "synthetic-local-pg";

describePg("H0 acceptance/currentness (isolated local PostgreSQL; synthetic verifier metadata only)", () => {
  let db: DatabasePool, admin: pg.Pool, schema: string;
  beforeAll(async () => {
    const url = new URL(testUrl!);
    if (!["localhost", "127.0.0.1", "::1"].includes(url.hostname) || !/test/i.test(url.pathname)) throw new Error("Dedicated local test PostgreSQL required");
    schema = `migration_backup_${randomUUID().replaceAll("-", "")}`;
    admin = new pg.Pool({ connectionString: url.toString(), max: 2 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    url.searchParams.set("options", `-csearch_path=${schema}`);
    db = await createDatabase(url.toString());
    await setPaused(db, false, "synthetic test", OP);
  }, 60_000);
  afterAll(async () => {
    await db?.end();
    if (admin && schema) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin?.end();
  });
  async function user() {
    const id = randomUUID();
    await db.query("INSERT INTO users(id,email,name) VALUES($1,$2,'Synthetic')", [id, `${id}@example.test`]);
    return id;
  }
  async function batch(users: string[]) {
    const name = `b-${randomUUID().slice(0, 8)}`;
    await createCohort(db, name, OP); await addToCohort(db, name, users, OP); await releaseCohort(db, name, OP);
    await setCohortFrozen(db, name, true, "synthetic archive capture", OP);
    return name;
  }
  async function collection(owner: string) {
    const id = randomUUID();
    await db.query("INSERT INTO hosted_collections(id,user_id,display_name,template,authority_state) VALUES($1,$2,'Synthetic','mdbase','active')", [id, owner]);
    return id;
  }
  async function metadata(name: string, binding?: ArchiveBinding) {
    const clock = new Date((await db.query("SELECT date_trunc('milliseconds', clock_timestamp()) AS now")).rows[0].now).toISOString();
    return {
      schema: "mdbase-recovery-set/v4", environment: "production", bucket: "synthetic-archives",
      prefix: `production/2026/10/08/${name}`, backup_id: name,
      complete_sha256: hex(1), manifest_sha256: hex(2), source_commit: "a".repeat(40),
      migration_batch: binding ?? await cohortArchiveBinding(db, name),
      archive_created_at: clock, archive_completed_at: clock,
      retention: { mode: "GOVERNANCE", days: 116, retain_until: new Date(Date.parse(clock) + 116 * 86_400_000).toISOString(), inventory_digest: hex(3), count: "3" }
    };
  }
  const startedAt = async (account: string) => (await db.query("SELECT started_at FROM next_migration_cohort_members WHERE account_id=$1", [account])).rows[0]?.started_at;

  it("refuses absent/v3/wrong-environment evidence before a claim/audit mutation", async () => {
    const account = await user(), name = await batch([account]);
    await expect(startAccountMigration(db, account, "production")).rejects.toMatchObject({ code: "backup_missing" });
    const body = await metadata(name);
    await expect(acceptCohortArchive(db, name, { ...body, schema: "mdbase-recovery-set/v3" }, "production")).rejects.toMatchObject({ code: "backup_missing" });
    await expect(acceptCohortArchive(db, name, body, undefined)).rejects.toMatchObject({ code: "backup_missing" });
    await expect(acceptCohortArchive(db, name, body, "staging")).rejects.toMatchObject({ code: "backup_missing" });
    expect(await startedAt(account)).toBeNull();
    expect((await db.query("SELECT 1 FROM audit_events WHERE event_type='next_migration.start' AND user_id=$1", [account])).rowCount).toBe(0);
  });

  it("preserves accepted_at and started_at on exact retries; rejects conflicting/SQL-mutated acceptance and recycled batch names", async () => {
    const account = await user(), name = await batch([account]), body = await metadata(name);
    const accepted = await acceptCohortArchive(db, name, body, "production");
    expect(await acceptCohortArchive(db, name, body, "production")).toEqual(accepted);
    const claim = await startAccountMigration(db, account, "production");
    await setPaused(db, true, "pause after claim", OP);
    expect(await startAccountMigration(db, account, "production")).toEqual(claim);
    await setPaused(db, false, "resume test", OP);
    await expect(acceptCohortArchive(db, name, { ...body, complete_sha256: hex(4) }, "production")).rejects.toMatchObject({ code: "backup_conflict" });
    await expect(db.query("UPDATE next_migration_archive_acceptances SET accepted_at=clock_timestamp() WHERE cohort=$1", [name])).rejects.toThrow(/immutable/);
    await expect(db.query("DELETE FROM next_migration_archive_acceptances WHERE cohort=$1", [name])).rejects.toThrow(/immutable/);
    const empty = await batch([]);
    await expect(db.query("DELETE FROM next_migration_cohorts WHERE name=$1", [empty])).rejects.toThrow(/immutable/);
    // No members/acceptance/FK protects this empty batch: name identity itself
    // must be permanent. An unchanged UPDATE remains legal and inert.
    const binding = await cohortArchiveBinding(db, empty);
    await expect(db.query("UPDATE next_migration_cohorts SET name=$1 WHERE name=$2", [`${empty}-renamed`, empty])).rejects.toThrow(/immutable/);
    await db.query("UPDATE next_migration_cohorts SET name=name WHERE name=$1", [empty]);
    expect(await cohortArchiveBinding(db, empty)).toEqual(binding);
  });

  it("keeps BIGINT revisions lossless and refuses revision overflow instead of wrapping", async () => {
    const account = await user(), name = await batch([account]);
    await db.query("UPDATE next_migration_cohorts SET membership_revision=9223372036854775807 WHERE name=$1", [name]);
    const binding = await cohortArchiveBinding(db, name);
    expect(binding.membership_revision).toBe("9223372036854775807");
    await acceptCohortArchive(db, name, await metadata(name, binding), "production");
    await startAccountMigration(db, account, "production");
    const another = await user();
    await expect(addToCohort(db, name, [another], OP)).rejects.toMatchObject({ code: "migration_frozen" });
    // Privileged raw-SQL fault injection still exercises the H0 overflow guard.
    await expect(db.query("INSERT INTO next_migration_cohort_members(account_id,cohort) VALUES($1,$2)", [another, name])).rejects.toThrow(/out of range/);
    expect((await cohortArchiveBinding(db, name)).membership_revision).toBe(binding.membership_revision);
  });

  it("invalidates on new members even for started-account retries, without resetting old acceptance or claim", async () => {
    const account = await user(), name = await batch([account]), body = await metadata(name);
    const accepted = await acceptCohortArchive(db, name, body, "production");
    const claim = await startAccountMigration(db, account, "production");
    const another = await user();
    await expect(addToCohort(db, name, [another], OP)).rejects.toMatchObject({ code: "migration_frozen" });
    // H0 remains fail-closed even on privileged out-of-band topology drift.
    await db.query("INSERT INTO next_migration_cohort_members(account_id,cohort) VALUES($1,$2)", [another, name]);
    await expect(startAccountMigration(db, account, "production")).rejects.toMatchObject({ code: "backup_missing" });
    expect(new Date(await startedAt(account)).toISOString()).toBe(claim.started_at);
    const stored = (await db.query("SELECT accepted_at FROM next_migration_archive_acceptances WHERE cohort=$1", [name])).rows[0];
    expect(new Date(stored.accepted_at).toISOString()).toBe(accepted.accepted_at);
    const revised = await metadata(name);
    await acceptCohortArchive(db, name, revised, "production");
    expect(await startAccountMigration(db, account, "production")).toEqual(claim);
    expect((await db.query("SELECT 1 FROM next_migration_archive_acceptances WHERE cohort=$1", [name])).rowCount).toBe(2);
  });

  it("covers zero-hosted accounts, full ownership, transferred exclusions, bulk changes and unchanged updates", async () => {
    const a = await user(), b = await user(), name = await batch([a, b]);
    const before = await cohortArchiveBinding(db, name);
    const id = await collection(a);
    const withCollection = await cohortArchiveBinding(db, name);
    expect(withCollection.membership_digest).toBe(migrationMembershipDigest([[a, [id]], [b, []]]));
    expect(BigInt(withCollection.membership_revision)).toBeGreaterThan(BigInt(before.membership_revision));
    await db.query("UPDATE hosted_collections SET user_id=user_id, authority_state='transferring' WHERE id=$1", [id]);
    expect(await cohortArchiveBinding(db, name)).toEqual(withCollection);
    await db.query("UPDATE next_migration_cohort_members SET added_at=added_at WHERE cohort=$1", [name]);
    expect(await cohortArchiveBinding(db, name)).toEqual(withCollection);
    await db.query("UPDATE hosted_collections SET user_id=$1 WHERE id=$2", [b, id]);
    const moved = await cohortArchiveBinding(db, name);
    expect(moved.membership_digest).toBe(migrationMembershipDigest([[a, []], [b, [id]]]));
    expect(moved.membership_revision).not.toBe(withCollection.membership_revision);
    await db.query("UPDATE hosted_collections SET authority_state='transferred' WHERE id=$1", [id]);
    expect((await cohortArchiveBinding(db, name)).membership_digest).toBe(before.membership_digest);
    await db.query("DELETE FROM users WHERE id=ANY($1::uuid[])", [[a, b]]);
    const empty = await cohortArchiveBinding(db, name);
    expect(empty.membership_digest).toBe(migrationMembershipDigest([]));
    expect(BigInt(empty.membership_revision)).toBeGreaterThan(BigInt(moved.membership_revision));
  });

  it("invalidates both batches on an ownership transfer and on account cascading deletion", async () => {
    const a = await user(), b = await user(), left = await batch([a]), right = await batch([b]), id = await collection(a);
    await acceptCohortArchive(db, left, await metadata(left), "production");
    await acceptCohortArchive(db, right, await metadata(right), "production");
    const lb = await cohortArchiveBinding(db, left), rb = await cohortArchiveBinding(db, right);
    await db.query("UPDATE hosted_collections SET user_id=$1 WHERE id=$2", [b, id]);
    expect((await cohortArchiveBinding(db, left)).membership_revision).not.toBe(lb.membership_revision);
    expect((await cohortArchiveBinding(db, right)).membership_revision).not.toBe(rb.membership_revision);
    await expect(startAccountMigration(db, a, "production")).rejects.toMatchObject({ code: "backup_missing" });
    await expect(startAccountMigration(db, b, "production")).rejects.toMatchObject({ code: "backup_missing" });
    await db.query("DELETE FROM users WHERE id=$1", [b]);
    await expect(startAccountMigration(db, b, "production")).rejects.toMatchObject({ code: "account_not_found" });
  });

  it("rechecks membership after a real parent-lock wait for both capture and start", async () => {
    const account = await user(), name = await batch([account]);
    await acceptCohortArchive(db, name, await metadata(name), "production");
    const another = await user(), mutation = await db.connect();
    await mutation.query("BEGIN");
    try {
      await mutation.query("INSERT INTO next_migration_cohort_members(account_id,cohort) VALUES($1,$2)", [another, name]);
      let settled = false;
      const capture = cohortArchiveBinding(db, name).finally(() => { settled = true; });
      const claim = startAccountMigration(db, account, "production").then(() => "started", (e: { code?: string }) => e.code);
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(settled).toBe(false);
      await mutation.query("COMMIT");
      expect((await capture).membership_digest).toBe(migrationMembershipDigest([[account, []], [another, []]]));
      expect(await claim).toBe("backup_missing");
      expect(await startedAt(account)).toBeNull();
    } finally { await mutation.query("ROLLBACK").catch(() => undefined); mutation.release(); }
  });

  it("refuses expired/future stored metadata on every start regardless of recent acceptance", async () => {
    for (const offset of [-8 * 86_400_000, 86_400_000]) {
      const account = await user(), name = await batch([account]);
      const clock = Date.now(), changed = new Date(clock - 9 * 86_400_000).toISOString();
      await db.query("UPDATE next_migration_cohorts SET membership_changed_at=$1 WHERE name=$2", [changed, name]);
      const binding = await cohortArchiveBinding(db, name), body = await metadata(name, binding);
      body.archive_created_at = new Date(clock + offset).toISOString();
      body.archive_completed_at = body.archive_created_at;
      body.retention.retain_until = new Date(clock + offset + 116 * 86_400_000).toISOString();
      const insert = () => db.query(`INSERT INTO next_migration_archive_acceptances(cohort,membership_revision,verified_result,accepted_at)
        VALUES($1,$2::bigint,$3::jsonb,date_trunc('milliseconds',clock_timestamp()))`, [name, binding.membership_revision, JSON.stringify(body)]);
      if (offset > 0) await expect(insert()).rejects.toThrow(/next_migration_archive_elapsed_retention/);
      else await insert();
      await expect(startAccountMigration(db, account, "production")).rejects.toMatchObject({ code: "backup_missing" });
      expect(await startedAt(account)).toBeNull();
    }
  });

  it("locks and rereads a membership move before the parent/claim instead of using an unlocked join snapshot", async () => {
    const account = await user(), old = await batch([account]), current = await batch([]);
    await acceptCohortArchive(db, old, await metadata(old), "production");
    const mutation = await db.connect();
    await mutation.query("BEGIN");
    try {
      await mutation.query("UPDATE next_migration_cohort_members SET cohort=$1 WHERE account_id=$2", [current, account]);
      let settled = false;
      const claim = startAccountMigration(db, account, "production").then(() => "started", (e: { code?: string }) => e.code).finally(() => { settled = true; });
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(settled).toBe(false);
      await mutation.query("COMMIT");
      expect(await claim).toBe("backup_missing");
      expect(await startedAt(account)).toBeNull();
    } finally { await mutation.query("ROLLBACK").catch(() => undefined); mutation.release(); }
  });

  it("authenticates before metadata access and bounds the verifier POST body", async () => {
    const account = await user(), name = await batch([account]), app = Fastify();
    registerMigrationRolloutRoutes(app, { db, token, environment: "production" });
    const base = `/internal/v1/next/migration/cohorts/${name}`;
    expect((await app.inject({ method: "GET", url: `${base}/archive-binding` })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: `${base}/backup-accept`, headers: { authorization: "Bearer app-session" }, payload: {} })).statusCode).toBe(401);
    const auth = { authorization: `Bearer ${token}` };
    const response = await app.inject({ method: "GET", url: `${base}/archive-binding`, headers: auth });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(Object.keys(response.json()).sort()).toEqual(["batch_id", "membership_changed_at", "membership_digest", "membership_revision"]);
    expect((await app.inject({ method: "POST", url: `${base}/backup-accept`, headers: auth, payload: { unknown: "x".repeat(4096) } })).statusCode).toBe(413);
    expect((await app.inject({ method: "POST", url: `${base}/backup-accept`, headers: auth, payload: await metadata(name) })).statusCode).toBe(200);
    await app.close();
  });
});
