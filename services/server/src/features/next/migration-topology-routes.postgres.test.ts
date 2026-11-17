import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildApp } from "../../app.js";
import { scheduleStarterCollection } from "../onboarding/account-onboarding.js";
import { createDatabase, type DatabasePool } from "../../db.js";
import type { HostedProviderClient } from "../hosted/hosted-provider.js";
import { addToCohort, createCohort, setCohortFrozen } from "./migration-rollout.js";

const testUrl = process.env.MDBASE_CONNECT_TEST_DATABASE_URL;
const approved = process.env.MDBASE_CONNECT_DESTRUCTIVE_TEST_APPROVAL === "I APPROVE MDBASE CONNECT DESTRUCTIVE POSTGRES TESTS";
const suite = testUrl && approved ? describe : describe.skip;
const operator = "synthetic-local-test";

// Synthetic local account-management authentication only. No LAB accounts,
// installed native credentials, migration admission or real provider effects.
suite("topology freeze actual route aliases on isolated PostgreSQL", () => {
  let db: DatabasePool, admin: pg.Pool, schema: string;
  beforeAll(async () => {
    const url = new URL(testUrl!);
    if (!["localhost", "127.0.0.1", "::1"].includes(url.hostname) || !/test/i.test(url.pathname)) throw new Error("Dedicated local test PostgreSQL required");
    schema = `topology_routes_${randomUUID().replaceAll("-", "")}`;
    admin = new pg.Pool({ connectionString: url.toString() });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    url.searchParams.set("options", `-csearch_path=${schema}`);
    db = await createDatabase(url.toString());
  }, 60_000);
  afterAll(async () => {
    await db?.end();
    if (admin && schema) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin?.end();
  });
  async function account(app: Awaited<ReturnType<typeof buildApp>>["app"]) {
    const email = `${randomUUID()}@example.test`;
    const session = await app.inject({ method: "POST", url: "/v1/dev/session", payload: { name: "Synthetic", email } });
    expect(session.statusCode).toBe(200);
    const cookie = String(session.headers["set-cookie"]).split(";")[0]!;
    const id = (await db.query<{ id: string }>("SELECT id FROM users WHERE email=$1", [email])).rows[0]!.id;
    const cohort = `route-${randomUUID()}`;
    await createCohort(db, cohort, operator); await addToCohort(db, cohort, [id], operator);
    return { id, cohort, cookie };
  }
  async function freeze(cohort: string, value: boolean) {
    await setCohortFrozen(db, cohort, value, value ? "synthetic capture" : "cancel before acceptance", operator);
  }

  it("fences account/connector create, rename, delete and onboarding before provider/compensation effects", async () => {
    const create = vi.fn(async () => undefined), rename = vi.fn(async () => undefined), erase = vi.fn(async () => undefined);
    const upsert = vi.fn(async () => ({}));
    const { app } = await buildApp({ db, devAuth: true, hostedCollections: true, hostedProvider: {
      url: "https://synthetic.example.test", upsertAccount: upsert, createCollection: create, renameCollection: rename, deleteCollection: erase
    } as unknown as HostedProviderClient });
    try {
      const a = await account(app);
      const connector = await app.inject({ method: "POST", url: "/v1/connectors", headers: { cookie: a.cookie }, payload: { name: "Synthetic" } });
      expect(connector.statusCode).toBe(201);
      const nativeHeaders = { authorization: `Bearer ${connector.json().token}` };
      const created = await app.inject({ method: "POST", url: "/v1/hosted/collections", headers: { cookie: a.cookie }, payload: { display_name: "Synthetic", template: "mdbase", timezone: "UTC" } });
      expect(created.statusCode).toBe(201);
      const collection = created.json().collection.id as string;
      const starter = await scheduleStarterCollection(db, a.id);
      await freeze(a.cohort, true);
      create.mockClear(); upsert.mockClear();
      const requests = [
        { method: "POST" as const, url: "/v1/hosted/collections", headers: { cookie: a.cookie }, payload: { display_name: "Refused", template: "mdbase", timezone: "UTC" } },
        { method: "POST" as const, url: "/v1/connectors/hosted/collections", headers: nativeHeaders, payload: { display_name: "Refused", template: "mdbase", timezone: "UTC" } },
        { method: "POST" as const, url: "/v1/onboarding/starter-collection", headers: { cookie: a.cookie }, payload: {} },
        ...["/v1/hosted/collections", "/v1/connectors/hosted/collections"].flatMap((root, index) => [
          { method: "PATCH" as const, url: `${root}/${collection}`, headers: index ? nativeHeaders : { cookie: a.cookie }, payload: { display_name: "Refused" } },
          { method: "DELETE" as const, url: `${root}/${collection}`, headers: index ? nativeHeaders : { cookie: a.cookie } }
        ])
      ];
      for (const request of requests) {
        const result = await app.inject(request); expect(result.statusCode).toBe(409); expect(result.json().error.code).toBe("migration_frozen");
      }
      for (const effect of [create, rename, erase, upsert]) expect(effect).not.toHaveBeenCalled();
      expect((await db.query("SELECT display_name FROM hosted_collections WHERE id=$1", [collection])).rows[0].display_name).toBe("Synthetic");
      expect((await db.query("SELECT 1 FROM hosted_collections WHERE id=$1", [starter])).rowCount).toBe(0);
      await freeze(a.cohort, false);
      expect((await app.inject({ method: "POST", url: "/v1/onboarding/starter-collection", headers: { cookie: a.cookie }, payload: {} })).statusCode).toBe(200);
      expect(create).toHaveBeenCalledOnce(); expect(erase).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
});
