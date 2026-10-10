import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, type DatabasePool } from "../../db.js";
import { HostedProviderResponseError, type LegacyMigrationDrain, type LegacyMigrationFence } from "../../hosted-provider.js";
import { registerMigrationProviderRoutes } from "./migration-provider.js";

const testUrl = process.env.MDBASE_CONNECT_TEST_DATABASE_URL;
const approved = process.env.MDBASE_CONNECT_DESTRUCTIVE_TEST_APPROVAL === "I APPROVE MDBASE CONNECT DESTRUCTIVE POSTGRES TESTS";
const suite = testUrl && approved ? describe : describe.skip;
const token = "synthetic-migration-token-".repeat(2);

suite("migration provider fronts (isolated real PostgreSQL, synthetic provider)", () => {
  let db: DatabasePool, admin: pg.Pool, schema: string;
  beforeAll(async () => {
    const url = new URL(testUrl!);
    if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || !/test/i.test(url.pathname)) throw new Error("Dedicated local test PostgreSQL required");
    schema = `migration_provider_${randomUUID().replaceAll("-", "")}`;
    admin = new pg.Pool({ connectionString: url.toString(), max: 2 }); await admin.query(`CREATE SCHEMA "${schema}"`);
    url.searchParams.set("options", `-csearch_path=${schema}`); db = await createDatabase(url.toString());
  }, 60000);
  afterAll(async () => { await db?.end(); if (admin && schema) await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin?.end(); });

  async function fixture(started = true) {
    const account = randomUUID(), collection = randomUUID(), run = randomUUID(), cohort = `c-${randomUUID().slice(0, 8)}`;
    await db.query("INSERT INTO users(id,email,name) VALUES($1,$2,'Test')", [account, `${account}@example.test`]);
    await db.query("INSERT INTO hosted_collections(id,user_id,display_name,template) VALUES($1,$2,'Source','mdbase')", [collection, account]);
    await db.query("INSERT INTO next_migration_cohorts(name,released_at,frozen_at) VALUES($1,now(),now())", [cohort]);
    await db.query("INSERT INTO next_migration_cohort_members(account_id,cohort,started_at) VALUES($1,$2,CASE WHEN $3 THEN now() ELSE NULL END)", [account, cohort, started]);
    const source: LegacyMigrationDrain = { collection_id: collection, state: "active", migration_id: null, head: 42,
      started_at: null, retain_until: null, in_flight: 2, unresolved: 3, applied_unreceipted: 2 };
    const fenced: LegacyMigrationFence = { collection_id: collection, state: "migrating", migration_id: run,
      started_at: new Date().toISOString(), retain_until: null, restored: [] };
    let reads = 0, fences = 0, readAwait: (() => Promise<void>) | undefined, fenceAwait: (() => Promise<void>) | undefined, unavailable = false;
    const app = Fastify();
    registerMigrationProviderRoutes(app, { db, token, provider: {
      legacyMigrationDrain: async (id, options) => { expect(id).toBe(collection); expect(options?.deadline).toBeGreaterThan(Date.now()); reads++; await readAwait?.(); if (unavailable) throw new HostedProviderResponseError(503, "synthetic", "private-provider-error"); return { ...source }; },
      legacyMigrationFence: async (id, options) => { expect(id).toBe(collection); expect(options?.deadline).toBeGreaterThan(Date.now()); fences++; Object.assign(source, fenced); await fenceAwait?.(); return { ...fenced }; }
    } });
    const request = (fence = true, authorization = `Bearer ${token}`, body: unknown = {}) => app.inject({
      method: fence ? "POST" : "GET", url: `/internal/v1/next/migration/collections/${collection}/${fence ? "fence" : "source"}`,
      headers: { authorization }, ...(fence ? { payload: body } : {})
    });
    return { account, collection, app, request, source, fenced, get reads() { return reads; }, get fences() { return fences; },
      set readAwait(value: (() => Promise<void>) | undefined) { readAwait = value; }, set fenceAwait(value: (() => Promise<void>) | undefined) { fenceAwait = value; },
      set unavailable(value: boolean) { unavailable = value; } };
  }
  it("uses current claim, fences once per request, and preserves exact provider drain/run evidence on retry", async () => {
    const f = await fixture(); try {
      const first = await f.request(); expect(first.statusCode, first.body).toBe(200); expect(first.json()).toEqual(f.fenced);
      expect(first.headers["cache-control"]).toBe("no-store");
      const retry = await f.request(); expect(retry.statusCode, retry.body).toBe(200); expect(retry.json()).toEqual(f.fenced);
      const read = await f.request(false); expect(read.statusCode, read.body).toBe(200); expect(read.json()).toEqual(f.source);
      expect(read.json()).toMatchObject({ in_flight: 2, unresolved: 3, applied_unreceipted: 2 });
      expect(f.fences).toBe(2);
      expect((await db.query("SELECT event_type FROM audit_events WHERE subject_id=$1 ORDER BY created_at", [f.collection])).rows)
        .toEqual([{ event_type: "next_migration.fence" }, { event_type: "next_migration.fence" }, { event_type: "next_migration.source" }]);
    } finally { await f.app.close(); }
  });
  it("refuses ordinary credentials, caller facts, and unstarted claims before provider calls", async () => {
    const f = await fixture(false); try {
      for (const credential of ["session", "app", "hosted-service", ""]) expect((await f.request(true, `Bearer ${credential}`)).statusCode).toBe(401);
      for (const body of [{ state: "active" }, { reverse_verified: true }, { head: 42 }, { restore_replica_ids: [] }]) expect((await f.request(true, undefined, body)).statusCode).toBe(400);
      expect((await f.request()).statusCode).toBe(409); expect(f.reads).toBe(0); expect(f.fences).toBe(0);
    } finally { await f.app.close(); }
  });
  const deny = async (f: Awaited<ReturnType<typeof fixture>>, change: string) => {
    if (change === "account-delete") await db.query("DELETE FROM users WHERE id=$1", [f.account]);
    if (change === "collection-delete") await db.query("DELETE FROM hosted_collections WHERE id=$1", [f.collection]);
    if (change === "backend-flip") await db.query("UPDATE users SET account_backend='next' WHERE id=$1", [f.account]);
    if (change === "claim-change") await db.query("UPDATE next_migration_cohort_members SET started_at=started_at+interval '1 microsecond' WHERE account_id=$1", [f.account]);
    if (change === "terminal-excluded") await db.query("UPDATE next_migration_cohort_members SET terminal_excluded_at=now() WHERE account_id=$1", [f.account]);
    if (change === "quarantine") await db.query("UPDATE hosted_collections SET quarantined_at=now() WHERE id=$1", [f.collection]);
    if (change === "transfer") await db.query("UPDATE hosted_collections SET authority_state='transferred' WHERE id=$1", [f.collection]);
    if (change === "deletion-floor") await db.query("INSERT INTO next_collection_deletion_facts(collection_id,deletion_id,lifecycle_epoch,authority) VALUES($1,$2,1,'native-registry')", [f.collection, randomUUID()]);
    if (change === "cutover") await db.query("INSERT INTO next_migration_collections(collection_id,account_id,s_final,cutover_seq,barrier_f,final_digest) VALUES($1,$2,42,2,2,$3)", [f.collection, f.account, "ab".repeat(32)]);
  };
  for (const boundary of ["before", "read-await", "fence-await"]) {
    it.each(["account-delete", "collection-delete", "backend-flip", "claim-change", "terminal-excluded", "quarantine", "transfer", "deletion-floor", "cutover"])(
      `denies changed claims at ${boundary}: %s`, async change => {
        const f = await fixture(); try {
          if (boundary === "before") await deny(f, change);
          if (boundary === "read-await") f.readAwait = () => deny(f, change);
          if (boundary === "fence-await") f.fenceAwait = () => deny(f, change);
          const result = await f.request();
          // A changed claim can be detected only by comparison, not initial eligibility.
          expect(result.statusCode, result.body).toBe(boundary === "before" && change === "claim-change" ? 200 : 409);
          if (boundary !== "fence-await" && !(boundary === "before" && change === "claim-change")) expect(f.fences).toBe(0);
        } finally { await f.app.close(); }
      });
  }
  it.each(["migrated", "retained", "missing-run", "missing-start", "foreign-source", "unavailable"])("refuses unqualified provider sources: %s", async mode => {
    const f = await fixture(); try {
      f.source.state = "migrating"; f.source.migration_id = f.fenced.migration_id; f.source.started_at = f.fenced.started_at;
      if (mode === "migrated") f.source.state = "migrated";
      if (mode === "retained") f.source.retain_until = new Date().toISOString();
      if (mode === "missing-run") f.source.migration_id = null;
      if (mode === "missing-start") f.source.started_at = null;
      if (mode === "foreign-source") f.source.collection_id = randomUUID();
      if (mode === "unavailable") f.unavailable = true;
      const result = await f.request(); expect(result.statusCode, result.body).toBe(["foreign-source", "unavailable"].includes(mode) ? 503 : 409);
      expect(f.fences).toBe(0); expect(result.body).not.toContain("private-provider-error");
    } finally { await f.app.close(); }
  });
  it("allows started internal migration while preserving suspension and every user access denial", async () => {
    const f = await fixture(); try {
      await db.query("UPDATE users SET suspended_at=now() WHERE id=$1", [f.account]);
      const result = await f.request(); expect(result.statusCode, result.body).toBe(200);
      expect((await db.query("SELECT suspended_at,account_backend FROM users WHERE id=$1", [f.account])).rows[0])
        .toMatchObject({ suspended_at: expect.any(Date), account_backend: "legacy" });
    } finally { await f.app.close(); }
  });
});
