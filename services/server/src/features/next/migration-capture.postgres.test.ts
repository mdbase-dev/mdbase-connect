import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, type DatabasePool } from "../../db.js";
import { addToCohort, cohortArchiveBinding, createCohort, registerMigrationRolloutRoutes,
  releaseCohort, setCohortFrozen, setPaused, startAccountMigration } from "./migration-rollout.js";

const testUrl = process.env.MDBASE_CONNECT_TEST_DATABASE_URL;
const approved = process.env.MDBASE_CONNECT_DESTRUCTIVE_TEST_APPROVAL === "I APPROVE MDBASE CONNECT DESTRUCTIVE POSTGRES TESTS";
const suite = testUrl && approved ? describe : describe.skip;
const token = "synthetic-capture-token-".repeat(2), actor = "synthetic-capture-test";

suite("pre-acceptance capture-v1 (isolated real PG; metadata is not export authority)", () => {
  let db: DatabasePool, admin: pg.Pool, schema: string;
  beforeAll(async () => {
    const url = new URL(testUrl!);
    if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || !/test/i.test(url.pathname)) throw new Error("Dedicated local test PostgreSQL required");
    schema = `migration_capture_${randomUUID().replaceAll("-", "")}`;
    admin = new pg.Pool({ connectionString: url.toString(), max: 2 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    url.searchParams.set("options", `-csearch_path=${schema}`);
    db = await createDatabase(url.toString());
    await setPaused(db, false, "synthetic capture tests", actor);
  }, 60_000);
  afterAll(async () => {
    await db?.end();
    if (admin && schema) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin?.end();
  });

  async function fixture(count = 3) {
    const accounts = Array.from({ length: count }, () => randomUUID());
    const name = `test-capture-${randomUUID().slice(0, 8)}`;
    await db.query(`INSERT INTO users(id,email,name)
      SELECT id,id::text || '@example.test','Synthetic' FROM unnest($1::uuid[]) AS id`, [accounts]);
    const collections = [randomUUID(), randomUUID()].sort();
    if (count) {
      await db.query(`INSERT INTO hosted_collections(id,user_id,display_name,template)
        SELECT id,$2,'Synthetic','mdbase' FROM unnest($1::uuid[]) AS id`, [collections, accounts[0]]);
      await db.query("UPDATE users SET suspended_at=now() WHERE id=$1", [accounts[0]]);
    }
    await createCohort(db, name, actor);
    if (count) await addToCohort(db, name, accounts, actor);
    await releaseCohort(db, name, actor);
    return { accounts, collections, name };
  }
  const front = (environment = "staging", database = db) => {
    const app = Fastify();
    registerMigrationRolloutRoutes(app, { db: database, token, environment });
    return app;
  };
  const request = (app: ReturnType<typeof front>, name: string, query = "?view=capture-v1", credential = token) => app.inject({
    method: "GET", url: `/internal/v1/next/migration/cohorts/${name}/archive-binding${query}`,
    headers: { authorization: `Bearer ${credential}` }
  });

  it.each(["lab", "staging"])("returns the same full pre-freeze metadata without accepting an archive or starting accounts: %s", async environment => {
    const f = await fixture(), app = front(environment);
    try {
      const response = await request(app, f.name);
      expect(response.statusCode, response.body).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store");
      const result = response.json();
      expect(Object.keys(result).sort()).toEqual(["binding", "frozen_at", "members", "observed_at", "schema"]);
      expect(result.schema).toBe("mdbase-migration-capture/1");
      expect(result.frozen_at).toBeNull();
      expect(result.members.map((member: any) => member.view.account_id)).toEqual([...f.accounts].sort());
      const owner = result.members.find((member: any) => member.view.account_id === f.accounts[0]);
      expect(owner).toMatchObject({ suspended: true, export_collections: f.collections,
        view: { started: false, backend: "legacy", hosted_collections: f.collections } });
      expect(result.members.filter((member: any) => member.view.account_id !== f.accounts[0])
        .every((member: any) => member.export_collections.length === 0)).toBe(true);
      expect((await db.query("SELECT 1 FROM next_migration_archive_acceptances WHERE cohort=$1", [f.name])).rowCount).toBe(0);
      expect((await db.query("SELECT 1 FROM next_migration_cohort_members WHERE cohort=$1 AND started_at IS NOT NULL", [f.name])).rowCount).toBe(0);
      await expect(startAccountMigration(db, f.accounts[0]!, environment)).rejects.toMatchObject({ code: "backup_missing" });
      expect((await request(app, f.name, "?view=receiving-v1")).statusCode).toBe(409);
      expect((await request(app, f.name, "")).statusCode).toBe(409);
    } finally { await app.close(); }
  });

  it("preserves exact frozen binding while selecting no terminal account payloads", async () => {
    const f = await fixture(), app = front();
    try {
      await setCohortFrozen(db, f.name, true, "synthetic freeze", actor);
      const binding = await cohortArchiveBinding(db, f.name);
      await db.query("UPDATE next_migration_cohort_members SET terminal_excluded_at=now() WHERE account_id=$1", [f.accounts[0]]);
      const response = await request(app, f.name);
      expect(response.statusCode, response.body).toBe(200);
      const result = response.json();
      expect(result.binding).toEqual(binding);
      expect(result.frozen_at).toEqual(expect.any(String));
      const terminal = result.members.find((member: any) => member.view.account_id === f.accounts[0]);
      expect(terminal.view.hosted_collections).toEqual(f.collections);
      expect(terminal.view.terminal_excluded).toBe(true);
      expect(terminal.terminal_excluded_at).toEqual(expect.any(String));
      expect(terminal.export_collections).toEqual([]);
      expect((await db.query("SELECT suspended_at FROM users WHERE id=$1", [f.accounts[0]])).rows[0].suspended_at).not.toBeNull();
    } finally { await app.close(); }
  });

  it("never includes another account's collection or transferred source in the selected scope", async () => {
    const f = await fixture(), other = randomUUID(), foreign = randomUUID(), app = front();
    try {
      await db.query("INSERT INTO users(id,email,name) VALUES($1,$2,'Outside')", [other, `${other}@example.test`]);
      await db.query("INSERT INTO hosted_collections(id,user_id,display_name,template) VALUES($1,$2,'Outside','mdbase')", [foreign, other]);
      await db.query("UPDATE hosted_collections SET authority_state='transferred' WHERE id=$1", [f.collections[0]]);
      const response = await request(app, f.name);
      expect(response.statusCode, response.body).toBe(200);
      const selected = response.json().members.flatMap((member: any) => member.export_collections);
      expect(selected).toEqual([f.collections[1]]);
      expect(response.body).not.toContain(other);
      expect(response.body).not.toContain(foreign);
    } finally { await app.close(); }
  });

  it("returns all 850 accounts rather than a candidates-page subset", async () => {
    const f = await fixture(850), app = front();
    try {
      const response = await request(app, f.name);
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().members.map((member: any) => member.view.account_id)).toEqual([...f.accounts].sort());
    } finally { await app.close(); }
  });

  it.each([0, 851])("refuses unsupported member counts without truncation: %s", async count => {
    const f = await fixture(count), app = front();
    try { expect((await request(app, f.name)).statusCode).toBe(503); } finally { await app.close(); }
  });

  it("refuses more than 1000 hosted collections", async () => {
    const f = await fixture(), app = front();
    try {
      await db.query(`INSERT INTO hosted_collections(id,user_id,display_name,template)
        SELECT id,$2,'Synthetic','mdbase' FROM unnest($1::uuid[]) AS id`,
        [Array.from({ length: 999 }, () => randomUUID()), f.accounts[0]]);
      expect((await request(app, f.name)).statusCode).toBe(503);
    } finally { await app.close(); }
  });

  it.each(["", "session", "wrong"])("denies credentials outside the dedicated migration role: %s", async credential => {
    const f = await fixture(), app = front();
    try { expect((await request(app, f.name, undefined, credential)).statusCode).toBe(401); } finally { await app.close(); }
  });
  it.each(["production", ""])("never opens capture for another environment: %s", async environment => {
    const f = await fixture(), app = front(environment);
    try { expect((await request(app, f.name)).statusCode).toBe(503); } finally { await app.close(); }
  });
  it.each(["?view=capture-v1&limit=1", "?view=capture-v1&view=capture-v1", "?view=capture-v1&account=other"])("refuses caller narrowing/selectors: %s", async query => {
    const f = await fixture(), app = front();
    try { expect((await request(app, f.name, query)).statusCode).toBe(400); } finally { await app.close(); }
  });
});
