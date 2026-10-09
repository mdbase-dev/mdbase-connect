import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDatabase, type DatabasePool } from "./db.js";
import { runAuthAdminCommand } from "./auth-admin.js";
import type { HostedProviderClient } from "./hosted-provider.js";
import { addToCohort, createCohort, setCohortFrozen } from "./features/next/migration-rollout.js";

const testUrl = process.env.MDBASE_CONNECT_TEST_DATABASE_URL;
const approved = process.env.MDBASE_CONNECT_DESTRUCTIVE_TEST_APPROVAL === "I APPROVE MDBASE CONNECT DESTRUCTIVE POSTGRES TESTS";
const describePg = testUrl && approved ? describe : describe.skip;
const sha = "a".repeat(40);
describePg("archive pre-freeze command (dedicated real PG, synthetic provider effects only)", () => {
  let db: DatabasePool, admin: pg.Pool, schema: string, cohort: string;
  const provider = { deleteCollection: vi.fn(async () => undefined), revokeReplica: vi.fn(async () => undefined),
    revokeNotificationGrant: vi.fn(async () => undefined) } as unknown as HostedProviderClient;
  beforeAll(async () => {
    const url = new URL(testUrl!);
    if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || !/test/i.test(url.pathname)) throw new Error("Dedicated local test PostgreSQL required");
    schema = `archive_erasure_${randomUUID().replaceAll("-", "")}`;
    admin = new pg.Pool({ connectionString: url.toString(), max: 2 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    url.searchParams.set("options", `-csearch_path=${schema}`);
    db = await createDatabase(url.toString());
  }, 60_000);
  afterAll(async () => {
    await db?.end();
    if (admin && schema) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin?.end();
  });
  beforeEach(async () => {
    await db.query("DELETE FROM next_migration_deferred_account_deletions");
    await db.query("DELETE FROM provider_collection_deletion_jobs");
    await db.query("DELETE FROM provider_revocation_jobs");
    vi.clearAllMocks();
    cohort = `drain-${randomUUID().slice(0, 8)}`;
    await createCohort(db, cohort, "synthetic");
  });
  const command = (operation = randomUUID(), revision = sha, name = cohort) => runAuthAdminCommand([
    "archive", "drain-deletions", "--cohort", name, "--expected-revision", revision,
    "--operation-id", operation, "--actor", "synthetic", "--reason", "isolated fixture"
  ], { db, defaultRegistrationMode: "closed", runtimeRevision: sha, hostedProvider: provider });
  async function accountQueue(ready: boolean) {
    const id = randomUUID();
    await db.query("INSERT INTO users(id,email,name) VALUES($1,$2,'Synthetic')", [id, `${id}@example.test`]);
    await addToCohort(db, cohort, [id], "synthetic");
    // Models existing committed ready/unready rows only. This SQL fixture is
    // NOT qualification of the readiness writer, nor a new CLI readiness path.
    await db.query(`INSERT INTO next_migration_deferred_account_deletions
      (account_id,cohort,membership_revision,frozen_at,queue_provider_cleanup,ready_at,ready_revision)
      SELECT $1,name,membership_revision,now(),false,
        CASE WHEN $2 THEN now() ELSE NULL END, CASE WHEN $2 THEN membership_revision ELSE NULL END
      FROM next_migration_cohorts WHERE name=$3`, [id, ready, cohort]);
    return id;
  }
  async function deletion(state = "pending", completed = false, future = false) {
    const collection = randomUUID();
    await db.query(`INSERT INTO provider_collection_deletion_jobs
      (id,collection_id,reason,state,completed_at,available_at)
      VALUES($1,$2,'account_deletion',$3,CASE WHEN $4 THEN now() ELSE NULL END,
        CASE WHEN $5 THEN now()+interval '1 day' ELSE now() END)`, [randomUUID(), collection, state, completed, future]);
    return collection;
  }
  it("empty is metadata-only and observes the current unfrozen membership revision", async () => {
    const op = randomUUID();
    expect(await command(op)).toEqual({ schema: "mdbase-archive-erasure-preflight/v1", operation_id: op, runtime_revision: sha,
      membership_revision: "1", unfrozen: true, queues_empty: { deferred_accounts: true, provider_collections: true, provider_revocations: true },
      completed: { accounts: 0, provider_jobs: 0 } });
    expect(provider.deleteCollection).not.toHaveBeenCalled();
  });
  it("existing ready account erasure is reused; no source account identity in output", async () => {
    const user = await accountQueue(true);
    const result = await command();
    expect(result).toMatchObject({ membership_revision: "3", completed: { accounts: 1, provider_jobs: 0 } });
    expect((await db.query("SELECT 1 FROM users WHERE id=$1", [user])).rows).toHaveLength(0);
    expect((await db.query("SELECT 1 FROM next_migration_deferred_account_deletions")).rows).toHaveLength(0);
    expect(JSON.stringify(result)).not.toContain(user);
  });
  it("unready deferred work refuses without forcing readiness or erasing the account", async () => {
    const user = await accountQueue(false);
    await expect(command()).rejects.toThrow("queue_not_empty");
    expect((await db.query("SELECT 1 FROM users WHERE id=$1", [user])).rows).toHaveLength(1);
    expect((await db.query("SELECT ready_at FROM next_migration_deferred_account_deletions")).rows[0].ready_at).toBeNull();
  });
  it("future pending and sending deletion work both count", async () => {
    await deletion("pending", false, true); await deletion("sending", false, true);
    await expect(command()).rejects.toThrow("queue_not_empty");
    expect(provider.deleteCollection).not.toHaveBeenCalled();
  });
  it("future revocation work counts even with no due jobs", async () => {
    await db.query(`INSERT INTO provider_revocation_jobs(id,replica_id,collection_id,reason,state,available_at)
      VALUES($1,$2,$3,'account_deletion','sending',now()+interval '1 day')`, [randomUUID(), randomUUID(), randomUUID()]);
    await expect(command()).rejects.toThrow("queue_not_empty");
    expect(provider.revokeReplica).not.toHaveBeenCalled();
  });
  it.each([["completed", false], ["pending", true]])("inconsistent deletion %s/completed=%s refuses", async (state, completed) => {
    await deletion(state, completed, true);
    await expect(command()).rejects.toThrow("queue_not_empty");
  });
  it("existing provider delivery completes only five jobs, not an unbounded loop", async () => {
    for (let i = 0; i < 6; i++) await deletion();
    await expect(command()).rejects.toThrow("queue_not_empty");
    expect(provider.deleteCollection).toHaveBeenCalledTimes(5);
    const result = await command();
    expect(result).toMatchObject({ completed: { accounts: 0, provider_jobs: 1 } });
    expect(provider.deleteCollection).toHaveBeenCalledTimes(6);
    // Logical job completion only; no assertion of object/version removal.
  });
  it("frozen target and wrong source revision refuse before provider delivery", async () => {
    await deletion();
    await expect(command(randomUUID(), "b".repeat(40))).rejects.toThrow("input_or_revision_invalid");
    await setCohortFrozen(db, cohort, true, "synthetic capture", "synthetic");
    await expect(command()).rejects.toThrow("cohort_frozen");
    expect(provider.deleteCollection).not.toHaveBeenCalled();
  });
  it("same operation ID does not cache an old empty observation; absent target refuses", async () => {
    const op = randomUUID(); await command(op); await deletion("pending", false, true);
    await expect(command(op)).rejects.toThrow("queue_not_empty");
    await expect(command(randomUUID(), sha, "missing-cohort")).rejects.toThrow("observation_invalid");
  });
});
