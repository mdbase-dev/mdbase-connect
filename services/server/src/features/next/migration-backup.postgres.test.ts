import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import Fastify from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, type DatabasePool } from "../../db.js";
import { acceptCohortArchive, addToCohort, cohortArchiveBinding, createCohort, migrationMembershipDigest,
  flipAccountBackend, flipEvidenceDigest, registerMigrationRolloutRoutes, releaseCohort, setCohortFrozen, setPaused, startAccountMigration, type ArchiveBinding } from "./migration-rollout.js";
import { completeMigrationBatch } from "./migration-topology.js";
import { ZERO_HOSTED_ARCHIVE_SCHEMA } from "./migration-archive-profile.js";

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

  it("refuses a frozen empty cohort before acceptance while preserving its original empty header and receipts", async () => {
    const name = await batch([]), binding = await cohortArchiveBinding(db, name), body = await metadata(name, binding);
    expect(binding.membership_digest).toBe(migrationMembershipDigest([]));
    expect(Object.keys(binding).sort()).toEqual(["batch_id", "membership_changed_at", "membership_digest", "membership_revision"]);
    const before = (await db.query("SELECT count(*)::text AS count FROM audit_events WHERE event_type='next_migration.backup_accept'")).rows;
    await expect(acceptCohortArchive(db, name, body, "production")).rejects.toMatchObject({ code: "backup_missing" });
    expect((await db.query("SELECT 1 FROM next_migration_archive_acceptances WHERE cohort=$1", [name])).rows).toHaveLength(0);
    expect((await db.query("SELECT count(*)::text AS count FROM audit_events WHERE event_type='next_migration.backup_accept'")).rows).toEqual(before);
    expect(await cohortArchiveBinding(db, name)).toEqual(binding);
    // Retained receipts are not rewritten to hide an empty historical cohort.
    await db.query(`INSERT INTO next_migration_archive_acceptances(cohort,membership_revision,verified_result,accepted_at)
      VALUES($1,$2::bigint,$3::jsonb,date_trunc('milliseconds',clock_timestamp()))`, [name, binding.membership_revision, JSON.stringify(body)]);
    const stored = () => db.query("SELECT verified_result::text AS receipt,accepted_at::text AS accepted FROM next_migration_archive_acceptances WHERE cohort=$1", [name]);
    const original = (await stored()).rows;
    await expect(acceptCohortArchive(db, name, body, "production")).rejects.toMatchObject({ code: "backup_missing" });
    expect((await stored()).rows).toEqual(original);
    expect(await cohortArchiveBinding(db, name)).toEqual(binding);
  });

  it.each(["lab", "staging", "production"])("accepts the named zero-hosted profile through start, empty flip and completion in %s", async environment => {
    const account = await user(), name = await batch([account]), base = await metadata(name);
    const body = { ...base, schema: ZERO_HOSTED_ARCHIVE_SCHEMA, environment,
      prefix: `legacy-archive/${environment}/2026/10/08/${name}`, retention: { ...base.retention, count: "2" } };
    // Synthetic trusted-verifier DATA only; this fixture does not sign an archive.
    const accepted = await acceptCohortArchive(db, name, body, environment);
    expect(await acceptCohortArchive(db, name, body, environment)).toEqual(accepted);
    expect(await startAccountMigration(db, account, environment)).toMatchObject({ account_id: account });
    expect(await flipAccountBackend(db, account, [], flipEvidenceDigest([]), { enabled: true }, environment)).toMatchObject({ backend: "next" });
    const completed = (await db.query("SELECT completed_at,completed_revision::text AS revision FROM next_migration_cohorts WHERE name=$1", [name])).rows[0];
    expect(completed.completed_at).not.toBeNull();
    expect(completed.revision).toBe(body.migration_batch.membership_revision);
    expect((await db.query("SELECT collections,evidence_digest FROM next_migration_account_flips WHERE account_id=$1", [account])).rows[0])
      .toEqual({ collections: [], evidence_digest: flipEvidenceDigest([]) });
    expect((await db.query("SELECT verified_result FROM next_migration_archive_acceptances WHERE cohort=$1", [name])).rows[0].verified_result).toEqual(body);
  });

  it("an account with only a missing-provider quarantine takes the ordinary zero-hosted path", async () => {
    const account = await user(), missing = await collection(account);
    await db.query("UPDATE hosted_collections SET quarantined_at=now(),quarantine_reason='provider_collection_missing' WHERE id=$1", [missing]);
    const before = (await db.query("SELECT * FROM hosted_collections WHERE id=$1", [missing])).rows;
    const name = await batch([account]), base = await metadata(name);
    expect(base.migration_batch.membership_digest).toBe(migrationMembershipDigest([[account, []]]));
    const body = { ...base, schema: ZERO_HOSTED_ARCHIVE_SCHEMA, environment: "staging",
      prefix: `legacy-archive/staging/2026/10/08/${name}`, retention: { ...base.retention, count: "2" } };
    await acceptCohortArchive(db, name, body, "staging");
    await startAccountMigration(db, account, "staging");
    expect(await flipAccountBackend(db, account, [], flipEvidenceDigest([]), { enabled: true }, "staging")).toMatchObject({ backend: "next" });
    expect((await db.query("SELECT completed_at FROM next_migration_cohorts WHERE name=$1", [name])).rows[0].completed_at).not.toBeNull();
    expect((await db.query("SELECT * FROM hosted_collections WHERE id=$1", [missing])).rows).toEqual(before);
    expect((await db.query("SELECT 1 FROM next_migration_collections WHERE collection_id=$1", [missing])).rows).toEqual([]);
  });

  it("supersedes an accepted never-started zero-hosted revision on unfreeze, keeps its receipt, and refuses once started", async () => {
    const account = await user(), name = await batch([account]);
    const zero = async () => {
      const base = await metadata(name);
      return { ...base, schema: ZERO_HOSTED_ARCHIVE_SCHEMA, environment: "staging",
        prefix: `legacy-archive/staging/2026/10/08/${name}`, retention: { ...base.retention, count: "2" } };
    };
    const receipts = async () => (await db.query(`SELECT membership_revision::text AS revision,verified_result::text AS receipt,accepted_at::text AS accepted
      FROM next_migration_archive_acceptances WHERE cohort=$1 ORDER BY membership_revision`, [name])).rows;
    const revision = async () => (await db.query("SELECT membership_revision::text AS r FROM next_migration_cohorts WHERE name=$1", [name])).rows[0].r;
    const first = await zero();
    await acceptCohortArchive(db, name, first, "staging");
    const original = await receipts();
    expect(await setCohortFrozen(db, name, false, "rerun accepted, never started", OP)).toEqual({ frozen_at: null });
    expect(await revision()).toBe(String(BigInt(first.migration_batch.membership_revision) + 1n));
    expect(await receipts()).toEqual(original);
    expect((await db.query(`SELECT metadata FROM audit_events WHERE event_type='next_migration.unfreeze' AND metadata->>'cohort'=$1`, [name])).rows[0].metadata)
      .toMatchObject({ membership_revision: first.migration_batch.membership_revision, superseded_acceptance: true, next_membership_revision: await revision() });
    expect(await startedAt(account)).toBeNull();
    await expect(startAccountMigration(db, account, "staging")).rejects.toMatchObject({ code: "backup_missing" });
    // The normal rerun: fresh freeze, the old receipt is not current, a new archive is accepted.
    await setCohortFrozen(db, name, true, "rerun capture", OP);
    await expect(startAccountMigration(db, account, "staging")).rejects.toMatchObject({ code: "backup_missing" });
    await expect(acceptCohortArchive(db, name, first, "staging")).rejects.toThrow();
    const second = await zero();
    expect(second.migration_batch.membership_revision).toBe(await revision());
    await acceptCohortArchive(db, name, second, "staging");
    expect(await startAccountMigration(db, account, "staging")).toMatchObject({ account_id: account });
    await expect(setCohortFrozen(db, name, false, "after start", OP)).rejects.toMatchObject({ code: "migration_frozen" });
    expect(await revision()).toBe(second.migration_batch.membership_revision);
    expect((await receipts()).map(row => row.revision)).toEqual([first.migration_batch.membership_revision, second.migration_batch.membership_revision]);
    expect((await receipts())[0]).toEqual(original[0]);
  });

  it("keeps refusing unfreeze of an accepted zero-hosted revision when a member is not legacy or a v4 revision", async () => {
    const zeroBody = async (name: string) => {
      const base = await metadata(name);
      return { ...base, schema: ZERO_HOSTED_ARCHIVE_SCHEMA, environment: "staging",
        prefix: `legacy-archive/staging/2026/10/08/${name}`, retention: { ...base.retention, count: "2" } };
    };
    const a = await user(), b = await user(), mixed = await batch([a, b]);
    await acceptCohortArchive(db, mixed, await zeroBody(mixed), "staging");
    await db.query("UPDATE users SET account_backend='next' WHERE id=$1", [b]);
    await expect(setCohortFrozen(db, mixed, false, "member is next", OP)).rejects.toMatchObject({ code: "migration_frozen" });
    const c = await user(), v4 = await batch([c]);
    await acceptCohortArchive(db, v4, await metadata(v4), "production");
    await expect(setCohortFrozen(db, v4, false, "v4 accepted", OP)).rejects.toMatchObject({ code: "migration_frozen" });
    for (const name of [mixed, v4]) expect((await db.query("SELECT frozen_at FROM next_migration_cohorts WHERE name=$1", [name])).rows[0].frozen_at).not.toBeNull();
  });

  it("preserves SQL elapsed/immutability guards and refuses unknown environments or false zero-profile artifact counts", async () => {
    const account = await user(), name = await batch([account]), base = await metadata(name);
    const valid = { ...base, schema: ZERO_HOSTED_ARCHIVE_SCHEMA, environment: "staging",
      prefix: `legacy-archive/staging/2026/10/08/${name}`, retention: { ...base.retention, count: "2" } };
    const elapsed = async (body: unknown) => (await db.query("SELECT next_migration_archive_elapsed_valid($1::jsonb,$2::timestamptz,$2::timestamptz) AS valid", [JSON.stringify(body), base.archive_completed_at])).rows[0].valid;
    expect(await elapsed(valid)).toBe(true);
    expect(await elapsed(base)).toBe(true); // Existing non-empty v4 semantics stay unchanged.
    for (const body of [
      { ...valid, environment: "unknown" },
      { ...valid, environment: null },
      ...["0", "1", "3", 2].map(count => ({ ...valid, retention: { ...valid.retention, count } })),
      { ...valid, retention: { ...valid.retention, retain_until: new Date(Date.parse(valid.retention.retain_until) + 1).toISOString() } }
    ]) {
      expect(await elapsed(body)).toBe(false);
      await expect(db.query(`INSERT INTO next_migration_archive_acceptances(cohort,membership_revision,verified_result,accepted_at)
        VALUES($1,$2::bigint,$3::jsonb,date_trunc('milliseconds',clock_timestamp()))`, [name, valid.migration_batch.membership_revision, JSON.stringify(body)])).rejects.toThrow();
    }
    const accepted = await acceptCohortArchive(db, name, valid, "staging");
    await expect(db.query("UPDATE next_migration_archive_acceptances SET accepted_at=clock_timestamp() WHERE cohort=$1", [name])).rejects.toThrow(/immutable/);
    expect(await acceptCohortArchive(db, name, valid, "staging")).toEqual(accepted);
  });

  it("upgrades the same SQL guard without rewriting a historical accepted receipt", async () => {
    const account = await user(), name = await batch([account]), base = await metadata(name);
    await acceptCohortArchive(db, name, base, "production");
    const stored = () => db.query("SELECT verified_result::text AS receipt,accepted_at::text AS accepted FROM next_migration_archive_acceptances WHERE cohort=$1", [name]);
    const original = (await stored()).rows;
    const previous = await readFile(new URL("../../../migrations/0082_next_migration_scoped_archive.sql", import.meta.url), "utf8");
    const upgrade = await readFile(new URL("../../../migrations/0085_managed_migration_archive_profiles.sql", import.meta.url), "utf8");
    const zero = { ...base, schema: ZERO_HOSTED_ARCHIVE_SCHEMA,
      prefix: `legacy-archive/production/2026/10/08/${name}`, retention: { ...base.retention, count: "2" } };
    const elapsed = async () => (await db.query("SELECT next_migration_archive_elapsed_valid($1::jsonb,$2::timestamptz,$2::timestamptz) AS valid",
      [JSON.stringify(zero), base.archive_completed_at])).rows[0].valid;
    try {
      await db.query(previous);
      expect(await elapsed()).toBe(false);
      await db.query(upgrade);
      expect(await elapsed()).toBe(true);
      expect((await stored()).rows).toEqual(original);
    } finally { await db.query(upgrade); }
  });

  it.each(["lab", "staging", "production"])("returns a complete frozen zero-only capture, refuses unauthenticated/unfrozen/mixed views: %s", async environment => {
    const a = await user(), b = await user(), name = await batch([a, b]);
    await db.query("UPDATE users SET suspended_at=now() WHERE id=$1", [b]);
    const app = Fastify(); registerMigrationRolloutRoutes(app, { db, token, environment });
    const url = `/internal/v1/next/migration/cohorts/${name}/archive-binding?view=zero-hosted-v1`, headers = { authorization: `Bearer ${token}` };
    try {
      expect((await app.inject({ method: "GET", url })).statusCode).toBe(401);
      const response = await app.inject({ method: "GET", url, headers });
      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store");
      const capture = response.json();
      expect(capture.schema).toBe("mdbase-migration-capture/1");
      expect(capture.frozen_at).not.toBeNull();
      expect(capture.members.map((m: {view: {account_id: string; hosted_collections: string[]}}) => [m.view.account_id, m.view.hosted_collections]))
        .toEqual([[a, []], [b, []]].sort((x, y) => String(x[0]).localeCompare(String(y[0]))));
      expect(capture.members.find((m: {view: {account_id: string}}) => m.view.account_id === b).suspended).toBe(true);
      await collection(a);
      expect((await app.inject({ method: "GET", url, headers })).statusCode).toBe(409);
      const unfrozen = `u-${randomUUID().slice(0, 8)}`;
      await createCohort(db, unfrozen, OP); await addToCohort(db, unfrozen, [await user()], OP);
      expect((await app.inject({ method: "GET", url: url.replace(name, unfrozen), headers })).statusCode).toBe(409);
      const empty = await batch([]);
      expect((await app.inject({ method: "GET", url: url.replace(name, empty), headers })).statusCode).toBe(409);
    } finally { await app.close(); }
    const unknown = Fastify(); registerMigrationRolloutRoutes(unknown, { db, token, environment: "unknown" });
    try { expect((await unknown.inject({ method: "GET", url, headers })).statusCode).toBe(503); }
    finally { await unknown.close(); }
  });

  it("refuses zero-hosted acceptance, current start and completion when any current member holds hosted data", async () => {
    const account = await user(), name = await batch([account]), base = await metadata(name);
    const body = { ...base, schema: ZERO_HOSTED_ARCHIVE_SCHEMA, environment: "lab",
      prefix: `legacy-archive/lab/2026/10/08/${name}`, retention: { ...base.retention, count: "2" } };
    await acceptCohortArchive(db, name, body, "lab");
    await collection(account); // Privileged isolated fault injection; ordinary topology writes are frozen.
    await expect(startAccountMigration(db, account, "lab")).rejects.toMatchObject({ code: "backup_missing" });
    expect(await startedAt(account)).toBeNull();
    const current = { ...body, migration_batch: await cohortArchiveBinding(db, name) };
    await expect(acceptCohortArchive(db, name, current, "lab")).rejects.toMatchObject({ code: "backup_missing" });
    // Even a forged privileged ledger cannot make the completion path accept a non-empty scope.
    await db.query(`INSERT INTO next_migration_archive_acceptances(cohort,membership_revision,verified_result,accepted_at)
      VALUES($1,$2::bigint,$3::jsonb,date_trunc('milliseconds',clock_timestamp()))`, [name, current.migration_batch.membership_revision, JSON.stringify(current)]);
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const frozen = (await client.query("SELECT frozen_at FROM next_migration_cohorts WHERE name=$1 FOR UPDATE", [name])).rows[0].frozen_at;
      await expect(completeMigrationBatch(client, name, current.migration_batch.membership_revision, frozen, "lab")).rejects.toThrow("Zero-hosted archive scope changed before completion.");
    } finally { await client.query("ROLLBACK"); client.release(); }
    expect((await db.query("SELECT completed_at FROM next_migration_cohorts WHERE name=$1", [name])).rows[0].completed_at).toBeNull();
  });

  it("counts distinct frozen accounts including collectionless and suspended members without narrowing complete coverage", async () => {
    const collectionless = await user(), suspended = await user();
    await db.query("UPDATE users SET suspended_at=now() WHERE id=$1", [suspended]);
    const first = await collection(suspended), second = await collection(suspended), name = await batch([collectionless, suspended]);
    const binding = await cohortArchiveBinding(db, name);
    expect(binding.membership_digest).toBe(migrationMembershipDigest([[collectionless, []], [suspended, [first, second]]]));
    const body = await metadata(name, binding), original = JSON.stringify(body);
    const accepted = await acceptCohortArchive(db, name, body, "production");
    expect(await acceptCohortArchive(db, name, body, "production")).toEqual(accepted);
    expect(JSON.stringify(body)).toBe(original);
    expect((await db.query("SELECT verified_result FROM next_migration_archive_acceptances WHERE cohort=$1", [name])).rows[0].verified_result).toEqual(body);
    expect((await db.query("SELECT suspended_at FROM users WHERE id=$1", [suspended])).rows[0].suspended_at).not.toBeNull();
  });

  it("admits namespaced legacy metadata through currentness/start without changing the stored physical prefix", async () => {
    const account = await user(), name = await batch([account]), body = await metadata(name);
    body.prefix = `legacy-archive/${body.prefix}`;
    const accepted = await acceptCohortArchive(db, name, body, "production");
    expect(await acceptCohortArchive(db, name, body, "production")).toEqual(accepted);
    expect((await db.query("SELECT verified_result FROM next_migration_archive_acceptances WHERE cohort=$1", [name])).rows[0].verified_result).toEqual(body);
    expect(await startAccountMigration(db, account, "production")).toMatchObject({ account_id: account });
  });
  it("preserves historical receipt text/time on retries and refuses namespace relabel or routine admission", async () => {
    const account = await user(), name = await batch([account]), body = await metadata(name);
    const accepted = await acceptCohortArchive(db, name, body, "production");
    const stored = () => db.query("SELECT verified_result::text AS receipt, accepted_at::text AS accepted FROM next_migration_archive_acceptances WHERE cohort=$1", [name]);
    const original = (await stored()).rows;
    expect(await acceptCohortArchive(db, name, body, "production")).toEqual(accepted);
    await expect(acceptCohortArchive(db, name, { ...body, prefix: `legacy-archive/${body.prefix}` }, "production")).rejects.toMatchObject({ code: "backup_conflict" });
    await expect(acceptCohortArchive(db, name, { ...body, prefix: `routine/${body.prefix}` }, "production")).rejects.toMatchObject({ code: "backup_missing" });
    expect((await stored()).rows).toEqual(original);
    const other = await user(), fresh = await batch([other]), routine = await metadata(fresh);
    await expect(acceptCohortArchive(db, fresh, { ...routine, prefix: `routine/${routine.prefix}` }, "production")).rejects.toMatchObject({ code: "backup_missing" });
    expect((await db.query("SELECT 1 FROM next_migration_archive_acceptances WHERE cohort=$1", [fresh])).rows).toHaveLength(0);
    expect(await startedAt(other)).toBeNull();
  });
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
    // A full-cohort acceptance exceeds 4 KiB: it reaches the handler instead of the transport bound.
    expect((await app.inject({ method: "POST", url: `${base}/backup-accept`, headers: auth, payload: { unknown: "x".repeat(256 * 1024) } })).statusCode).not.toBe(413);
    expect((await app.inject({ method: "POST", url: `${base}/backup-accept`, headers: auth, payload: { unknown: "x".repeat(1024 * 1024) } })).statusCode).toBe(413);
    expect((await app.inject({ method: "POST", url: `${base}/backup-accept`, headers: auth, payload: await metadata(name) })).statusCode).toBe(200);
    await app.close();
  });
});
