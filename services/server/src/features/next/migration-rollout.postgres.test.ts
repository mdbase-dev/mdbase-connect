import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, type DatabasePool } from "../../db.js";
import {
  accountMigrationView, addToCohort, createCohort, flipAccountBackend, FlipRefused, migrationCandidates,
  registerMigrationRolloutRoutes, releaseCohort, rolloutState, setPaused
} from "./migration-rollout.js";

const testUrl = process.env.MDBASE_CONNECT_TEST_DATABASE_URL;
const approved = process.env.MDBASE_CONNECT_DESTRUCTIVE_TEST_APPROVAL === "I APPROVE MDBASE CONNECT DESTRUCTIVE POSTGRES TESTS";
const describePg = testUrl && approved ? describe : describe.skip;
const tokens = { hosted: "h".repeat(40), escrow: "e".repeat(40) };
const evidence = "a".repeat(64);

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

  it("starts paused with no cohorts, and only released legacy accounts are candidates", async () => {
    expect((await rolloutState(db)).paused).toBe(true);
    const a = await account(), b = await account();
    const cohort = `c-${randomUUID().slice(0, 8)}`;
    await createCohort(db, cohort);
    expect(await addToCohort(db, cohort, [a.user, b.user, randomUUID()])).toHaveLength(2);
    expect(await migrationCandidates(db, 100)).not.toContain(a.user);
    await setPaused(db, false, "start internal cohort");
    expect(await migrationCandidates(db, 100)).not.toContain(a.user); // not released
    expect(await releaseCohort(db, cohort)).toBe(true);
    expect(await releaseCohort(db, cohort)).toBe(false);
    expect(await migrationCandidates(db, 100)).toEqual(expect.arrayContaining([a.user, b.user]));
    const view = (await accountMigrationView(db, a.user))!;
    expect(view).toMatchObject({ backend: "legacy", cohort, released: true, paused: false, may_start: true, hosted_collections: a.ids, unsettled_collections: [] });
    // Pause stops new accounts from starting.
    await setPaused(db, true, "incident");
    expect(await migrationCandidates(db, 100)).toEqual([]);
    expect((await accountMigrationView(db, a.user))!.may_start).toBe(false);
    await expect(setPaused(db, false, "  ")).rejects.toThrow();
  });

  it("flips only with exactly the settled hosted collections, idempotently, even while paused", async () => {
    const a = await account(["active", "active", "transferred"]);
    const cohort = `c-${randomUUID().slice(0, 8)}`;
    await createCohort(db, cohort);
    const refuse = async (collections: string[], code: string, digest = evidence) => {
      const e = await flipAccountBackend(db, a.user, collections, digest).catch((error: unknown) => error);
      expect(e).toBeInstanceOf(FlipRefused);
      expect((e as FlipRefused).code).toBe(code);
    };
    await refuse(a.ids, "account_not_released");
    await addToCohort(db, cohort, [a.user]);
    await releaseCohort(db, cohort);
    await setPaused(db, true, "paused mid-cutover");
    await refuse(a.ids.slice(1), "collections_mismatch");
    await refuse([...a.ids, randomUUID()], "collections_mismatch");
    await refuse([a.ids[0]!, a.ids[0]!], "collections_duplicated");
    const flipped = await flipAccountBackend(db, a.user, [...a.ids].reverse(), evidence);
    expect(flipped.backend).toBe("next");
    expect((await db.query("SELECT account_backend FROM users WHERE id=$1", [a.user])).rows[0].account_backend).toBe("next");
    // A retry with the same evidence returns the same flip; other evidence is refused.
    expect((await flipAccountBackend(db, a.user, a.ids, evidence)).flipped_at).toBe(flipped.flipped_at);
    await refuse(a.ids, "account_already_next", "b".repeat(64));
    // A flipped account is no longer a candidate and cannot join another cohort.
    await setPaused(db, false, "resume");
    expect(await migrationCandidates(db, 100)).not.toContain(a.user);
    expect(await addToCohort(db, cohort, [a.user])).toEqual([]);
  });

  it("refuses while a hosted collection is mid import or transfer", async () => {
    const a = await account(["active", "transferring"]);
    const cohort = `c-${randomUUID().slice(0, 8)}`;
    await createCohort(db, cohort); await addToCohort(db, cohort, [a.user]); await releaseCohort(db, cohort);
    expect((await accountMigrationView(db, a.user))!.unsettled_collections).toHaveLength(1);
    const e = await flipAccountBackend(db, a.user, a.ids, evidence).catch((error: unknown) => error);
    expect((e as FlipRefused).code).toBe("collections_unsettled");
    // An account with no hosted collections flips with an empty list.
    const empty = await account([]);
    await addToCohort(db, cohort, [empty.user]);
    expect((await flipAccountBackend(db, empty.user, [], evidence)).backend).toBe("next");
  });

  it("serves the hosted migrator only", async () => {
    const app = Fastify();
    registerMigrationRolloutRoutes(app, { db, tokens });
    const a = await account(["active"]);
    const cohort = `c-${randomUUID().slice(0, 8)}`;
    await createCohort(db, cohort); await addToCohort(db, cohort, [a.user]); await releaseCohort(db, cohort);
    const get = (url: string, token?: string) => app.inject({ method: "GET", url, headers: token ? { authorization: `Bearer ${token}` } : {} });
    expect((await get("/internal/v1/next/migration/rollout")).statusCode).toBe(401);
    expect((await get("/internal/v1/next/migration/rollout", tokens.escrow)).statusCode).toBe(401);
    expect((await get("/internal/v1/next/migration/rollout", tokens.hosted)).json()).toHaveProperty("paused");
    expect((await get(`/internal/v1/next/migration/accounts/${a.user}`, tokens.hosted)).json()).toMatchObject({ released: true, hosted_collections: a.ids });
    expect((await get(`/internal/v1/next/migration/accounts/${randomUUID()}`, tokens.hosted)).statusCode).toBe(404);
    expect((await get("/internal/v1/next/migration/candidates?limit=1000", tokens.hosted)).statusCode).toBe(400);
    const flip = (body: unknown) => app.inject({ method: "POST", url: `/internal/v1/next/migration/accounts/${a.user}/flip`, headers: { authorization: `Bearer ${tokens.hosted}` }, payload: body as object });
    expect((await flip({ collections: a.ids })).statusCode).toBe(400);
    expect((await flip({ collections: [], evidence_digest: evidence })).statusCode).toBe(409);
    const ok = await flip({ collections: a.ids, evidence_digest: evidence });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ backend: "next" });
    await app.close();
  });
});
