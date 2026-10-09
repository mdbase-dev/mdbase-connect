import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, type DatabasePool } from "../../db.js";
import { quarantineMissingHostedCollection } from "../../hosted-capability-lifecycle.js";
import { insertLegacyHostedCollection as insertOnClient } from "../hosted/service.js";
import {
  acceptCohortArchive, cohortArchiveBinding, accountMigrationView, addToCohort, collectionMigrationRecord, localTakeoverAllowed, createCohort, flipAccountBackend, flipEvidenceDigest, migrationCandidates,
  migrationsInProgress, recordCollectionCutover, registerMigrationRolloutRoutes, releaseCohort, RolloutRefused,
  rolloutState, setCohortFrozen, setPaused, startAccountMigration as claimAccountMigration
} from "./migration-rollout.js";

const testUrl = process.env.MDBASE_CONNECT_TEST_DATABASE_URL;
const approved = process.env.MDBASE_CONNECT_DESTRUCTIVE_TEST_APPROVAL === "I APPROVE MDBASE CONNECT DESTRUCTIVE POSTGRES TESTS";
const describePg = testUrl && approved ? describe : describe.skip;
const token = "m".repeat(40);
const OP = "test-operator";
const digest = (n: number) => n.toString(16).padStart(64, "0");
const facts = (barrier: number, final: string) => ({ s_final: 3, cutover_seq: barrier, barrier_f: barrier, final_digest: final });
const startAccountMigration = (db: DatabasePool, account: string) => claimAccountMigration(db, account, "production");

describePg("staged hosted migration rollout (dedicated local Postgres)", () => {
  let db: DatabasePool; let admin: pg.Pool; let schema: string;
  beforeAll(async () => {
    const url = new URL(testUrl!);
    if (!["localhost", "127.0.0.1", "::1"].includes(url.hostname) || !/test/i.test(url.pathname)) throw new Error("Dedicated local test Postgres required");
    schema = `migration_rollout_${randomUUID().replaceAll("-", "")}`;
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

  async function account(collections: string[] = ["active", "active"]) {
    const user = randomUUID();
    await db.query("INSERT INTO users(id,email,name) VALUES($1,$2,'Test')", [user, `${user}@example.test`]);
    const ids: string[] = [];
    for (const state of collections) {
      const id = randomUUID();
      await db.query("INSERT INTO hosted_collections(id,user_id,display_name,template,authority_state) VALUES($1,$2,'C','mdbase',$3)", [id, user, state]);
      if (state !== "transferred") ids.push(id);
    }
    return { user, ids: ids.sort() };
  }
  /** The control plane's cloud copy with the preserved id (H1). */
  async function cloudCopy(collection: string, owner: string) {
    await db.query("INSERT INTO next_collections(collection_id,owner_user_id,runtime,sync,root_key_id) VALUES($1,$2,'shadow','cloud_copy',$3)", [collection, owner, Buffer.alloc(16)]);
  }
  async function released(users: string[]) {
    const cohort = `c-${randomUUID().slice(0, 8)}`;
    await createCohort(db, cohort, OP);
    await addToCohort(db, cohort, users, OP);
    await releaseCohort(db, cohort, OP);
    await setCohortFrozen(db, cohort, true, "synthetic archive capture", OP);
    // Synthetic trusted-verifier metadata only: these PG tests do not execute
    // Sigstore/provider/archive verification, which belongs to the ONE verifier.
    const binding = await cohortArchiveBinding(db, cohort);
    const clock = new Date((await db.query("SELECT date_trunc('milliseconds', clock_timestamp()) AS now")).rows[0].now).toISOString();
    await acceptCohortArchive(db, cohort, {
      schema: "mdbase-recovery-set/v4", environment: "production", bucket: "test-migration-archives",
      prefix: `production/2026/10/08/${cohort}`, backup_id: cohort,
      complete_sha256: digest(90), manifest_sha256: digest(91), source_commit: "a".repeat(40),
      migration_batch: binding, archive_created_at: clock, archive_completed_at: clock,
      retention: { mode: "GOVERNANCE", days: 116,
        retain_until: new Date(Date.parse(clock) + 116 * 86_400_000).toISOString(), inventory_digest: digest(92), count: "3" }
    }, "production");
    return cohort;
  }
  const code = async (p: Promise<unknown>) => {
    const e = await p.catch((error: unknown) => error);
    expect(e).toBeInstanceOf(RolloutRefused);
    return (e as RolloutRefused).code;
  };
  /** Cut over every collection of `a` and return the evidence digest. */
  async function cutAll(a: { user: string; ids: string[] }) {
    const records = [];
    for (const [i, id] of a.ids.entries()) {
      await cloudCopy(id, a.user);
      await recordCollectionCutover(db, id, facts(10 + i, digest(i + 1)));
      records.push({ collection_id: id, barrier_f: 10 + i, final_digest: digest(i + 1) });
    }
    return flipEvidenceDigest(records);
  }

  it("starts paused; start is an atomic claim that the pause refuses; started accounts ignore the pause", async () => {
    expect((await rolloutState(db)).paused).toBe(true);
    const a = await account(), b = await account();
    await released([a.user, b.user]);
    expect(await migrationCandidates(db, 100)).not.toContain(a.user);
    expect(await code(startAccountMigration(db, a.user))).toBe("migration_paused");
    await setPaused(db, false, "start internal cohort", OP);
    expect(await migrationCandidates(db, 100)).toEqual(expect.arrayContaining([a.user, b.user]));
    await startAccountMigration(db, a.user);
    expect(await migrationCandidates(db, 100)).not.toContain(a.user);
    await setPaused(db, true, "incident", OP);
    expect(await migrationCandidates(db, 100)).toEqual([]);
    expect(await code(startAccountMigration(db, b.user))).toBe("migration_paused");
    // In progress whatever the pause; a repeated start is idempotent.
    expect(await migrationsInProgress(db, 100)).toContain(a.user);
    expect(await migrationsInProgress(db, 100)).not.toContain(b.user);
    expect((await startAccountMigration(db, a.user)).account_id).toBe(a.user);
    expect((await accountMigrationView(db, a.user))!).toMatchObject({ started: true, paused: true, hosted_collections: a.ids });
    await expect(setPaused(db, false, "  ", OP)).rejects.toThrow();
    await expect(setPaused(db, false, "x", " ")).rejects.toThrow();
    const audited = await db.query("SELECT event_type FROM audit_events WHERE event_type LIKE 'next_migration.%'");
    expect(audited.rows.map((r) => r.event_type)).toEqual(expect.arrayContaining([
      "next_migration.pause", "next_migration.resume", "next_migration.cohort_create", "next_migration.cohort_add",
      "next_migration.cohort_release", "next_migration.start"
    ]));
  });

  it("flips only with every hosted collection cut over and verified evidence, even while paused", async () => {
    const a = await account(["active", "active", "transferred"]);
    await released([a.user]);
    await setPaused(db, false, "go", OP);
    expect(await code(flipAccountBackend(db, a.user, a.ids, digest(0)))).toBe("account_not_started");
    expect(await code(recordCollectionCutover(db, a.ids[0]!, facts(10, digest(1))))).toBe("account_not_started");
    await startAccountMigration(db, a.user);
    await setPaused(db, true, "paused mid-cutover", OP);
    // A cutover needs the control plane's cloud copy with the preserved id.
    expect(await code(recordCollectionCutover(db, a.ids[0]!, facts(10, digest(1))))).toBe("next_collection_missing");
    // One collection cut over is not enough.
    await cloudCopy(a.ids[0]!, a.user);
    await recordCollectionCutover(db, a.ids[0]!, facts(10, digest(1)));
    expect(await code(recordCollectionCutover(db, a.ids[0]!, facts(11, digest(1))))).toBe("cutover_conflict");
    expect(await collectionMigrationRecord(db, a.ids[0]!, a.user)).toMatchObject({ ids_preserved: true, s_final: "3", cutover_seq: "10", barrier_f: "10" });
    expect(await localTakeoverAllowed(db, a.user)).toEqual({ local_takeover: false, account_backend: "legacy" });
    expect(await code(flipAccountBackend(db, a.user, a.ids, digest(0)))).toBe("collections_not_cut_over");
    await cloudCopy(a.ids[1]!, a.user);
    await recordCollectionCutover(db, a.ids[1]!, facts(11, digest(2)));
    expect((await db.query("SELECT runtime FROM next_collections WHERE collection_id=$1", [a.ids[1]])).rows[0].runtime).toBe("next");
    const evidence = flipEvidenceDigest([
      { collection_id: a.ids[0]!, barrier_f: 10, final_digest: digest(1) },
      { collection_id: a.ids[1]!, barrier_f: 11, final_digest: digest(2) }
    ]);
    expect(await code(flipAccountBackend(db, a.user, a.ids.slice(1), evidence))).toBe("collections_mismatch");
    expect(await code(flipAccountBackend(db, a.user, [a.ids[0]!, a.ids[0]!], evidence))).toBe("collections_duplicated");
    expect(await code(flipAccountBackend(db, a.user, a.ids, digest(7)))).toBe("evidence_mismatch");
    const flipped = await flipAccountBackend(db, a.user, [...a.ids].reverse(), evidence);
    expect(flipped.backend).toBe("next");
    expect((await flipAccountBackend(db, a.user, a.ids, evidence)).flipped_at).toBe(flipped.flipped_at);
    expect(await code(flipAccountBackend(db, a.user, a.ids, digest(9)))).toBe("account_already_next");
    expect(await migrationsInProgress(db, 100)).not.toContain(a.user);
    expect(await localTakeoverAllowed(db, a.user)).toEqual({ local_takeover: true, account_backend: "next" });
    expect(await localTakeoverAllowed(db, randomUUID())).toEqual({ local_takeover: false, account_backend: null });
    expect((await db.query("SELECT 1 FROM audit_events WHERE event_type='next_migration.flip' AND user_id=$1", [a.user])).rows).toHaveLength(1);
  });

  it("refuses unsettled collections; an empty account flips once started", async () => {
    const a = await account(["active", "transferring"]);
    const empty = await account([]);
    await released([a.user, empty.user]);
    await setPaused(db, false, "go", OP);
    await startAccountMigration(db, a.user);
    await startAccountMigration(db, empty.user);
    expect((await accountMigrationView(db, a.user))!.unsettled_collections).toHaveLength(1);
    expect(await code(flipAccountBackend(db, a.user, a.ids, digest(0)))).toBe("collections_unsettled");
    expect((await flipAccountBackend(db, empty.user, [], flipEvidenceDigest([]))).backend).toBe("next");
  });

  it("a deleted account is terminal mid-migration; a migrating account is never quarantined", async () => {
    const a = await account(["active"]);
    await released([a.user]);
    await setPaused(db, false, "go", OP);
    await startAccountMigration(db, a.user);
    // The provider's freeze answers like a missing collection to old paths: never quarantine.
    const q = await quarantineMissingHostedCollection(db, a.ids[0]!);
    expect(q).toEqual({ changed: false, grantsRevoked: 0, replicasRevoked: 0 });
    expect((await db.query("SELECT quarantined_at FROM hosted_collections WHERE id=$1", [a.ids[0]])).rows[0].quarantined_at).toBeNull();
    // Account deletion during migration is immediate and terminal.
    await db.query("DELETE FROM users WHERE id=$1", [a.user]);
    expect(await migrationsInProgress(db, 100)).not.toContain(a.user);
    expect(await accountMigrationView(db, a.user)).toBeNull();
    expect(await code(startAccountMigration(db, a.user))).toBe("account_not_found");
    expect(await code(flipAccountBackend(db, a.user, [], flipEvidenceDigest([])))).toBe("account_not_found");
    expect(await code(recordCollectionCutover(db, a.ids[0]!, facts(1, digest(1))))).toBe("collection_not_found");
  });

  it("serves the dedicated migration token only", async () => {
    const app = Fastify();
    registerMigrationRolloutRoutes(app, { db, token, environment: "production" });
    const a = await account(["active"]);
    await released([a.user]);
    await setPaused(db, false, "go", OP);
    const call = (method: "GET" | "POST", url: string, auth?: string, payload?: object) =>
      app.inject({ method, url, headers: auth ? { authorization: `Bearer ${auth}` } : {}, ...(payload ? { payload } : {}) });
    expect((await call("GET", "/internal/v1/next/migration/rollout")).statusCode).toBe(401);
    expect((await call("GET", "/internal/v1/next/migration/rollout", "h".repeat(40))).statusCode).toBe(401);
    expect((await call("GET", "/internal/v1/next/migration/rollout", token)).json()).toHaveProperty("paused");
    expect((await call("GET", "/internal/v1/next/migration/candidates?limit=1000", token)).statusCode).toBe(400);
    expect((await call("GET", `/internal/v1/next/migration/accounts/${randomUUID()}`, token)).statusCode).toBe(404);
    expect((await call("POST", `/internal/v1/next/migration/accounts/${a.user}/start`, token)).statusCode).toBe(200);
    expect((await call("GET", "/internal/v1/next/migration/in-progress", token)).json().accounts).toContain(a.user);
    const evidence = await cutAll(a);
    expect((await call("POST", `/internal/v1/next/migration/accounts/${a.user}/flip`, token, { collections: a.ids })).statusCode).toBe(400);
    expect((await call("POST", `/internal/v1/next/migration/accounts/${a.user}/flip`, token, { collections: a.ids, evidence_digest: digest(5) })).statusCode).toBe(409);
    expect((await call("POST", `/internal/v1/next/migration/collections/${a.ids[0]}/cutover`, token, { barrier_f: 1, final_digest: digest(1) })).statusCode).toBe(400);
    const ok = await call("POST", `/internal/v1/next/migration/accounts/${a.user}/flip`, token, { collections: a.ids, evidence_digest: evidence });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ backend: "next" });
    await app.close();
  });

  async function insertLegacyHostedCollection(db: DatabasePool, row: Parameters<typeof insertOnClient>[1]) {
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const result = await insertOnClient(client, row);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }

  it("a legacy collection create racing a flip never lands on a next account", async () => {
    const a = await account([]);
    const row = (id: string) => ({ id, userId: a.user, displayName: "C", template: "mdbase", providerUrl: null, contracts: "[]" });
    // A flip in progress holds the user row for update.
    const flip = await db.connect();
    await flip.query("BEGIN");
    await flip.query("SELECT 1 FROM users WHERE id=$1 FOR UPDATE", [a.user]);
    const racing = insertLegacyHostedCollection(db, row(randomUUID())).then(() => "inserted", (e: unknown) => String(e));
    await new Promise((r) => setTimeout(r, 200));
    await flip.query("UPDATE users SET account_backend='next' WHERE id=$1", [a.user]);
    await flip.query("COMMIT");
    flip.release();
    expect(await racing).toMatch(/moved to mdbase-next/);
    expect((await db.query("SELECT count(*)::int AS n FROM hosted_collections WHERE user_id=$1", [a.user])).rows[0].n).toBe(0);
    // And after the flip, plainly refused.
    await expect(insertLegacyHostedCollection(db, row(randomUUID()))).rejects.toThrow(/moved to mdbase-next/);
    // The other order: the create commits first, then the flip sees the collection
    // (and, with no recorded cutover, refuses).
    const b = await account([]);
    await insertLegacyHostedCollection(db, { ...row(randomUUID()), userId: b.user });
    await released([b.user]);
    await setPaused(db, false, "go", OP);
    await startAccountMigration(db, b.user);
    expect(await code(flipAccountBackend(db, b.user, [], flipEvidenceDigest([])))).toBe("collections_mismatch");
  });
});
