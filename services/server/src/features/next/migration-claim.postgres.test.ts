import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, type DatabasePool } from "../../db.js";
import { registerMigrationProviderRoutes } from "./migration-provider.js";

const testUrl = process.env.MDBASE_CONNECT_TEST_DATABASE_URL;
const approved = process.env.MDBASE_CONNECT_DESTRUCTIVE_TEST_APPROVAL === "I APPROVE MDBASE CONNECT DESTRUCTIVE POSTGRES TESTS";
const suite = testUrl && approved ? describe : describe.skip;
const token = "synthetic-migration-claim-".repeat(2);

// Real isolated SQL/currentness; no native permission, cryptographic authority,
// provider effect, managed CPP transport or H1 completion is modeled here.
suite("read-only migration claim (isolated PostgreSQL)", () => {
  let db: DatabasePool, admin: pg.Pool, schema: string;
  beforeAll(async () => {
    const url = new URL(testUrl!);
    if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || !/test/i.test(url.pathname)) {
      throw new Error("Dedicated local test PostgreSQL required");
    }
    schema = `migration_claim_${randomUUID().replaceAll("-", "")}`;
    admin = new pg.Pool({ connectionString: url.toString(), max: 2 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    url.searchParams.set("options", `-csearch_path=${schema}`);
    db = await createDatabase(url.toString());
  }, 60000);
  afterAll(async () => {
    await db?.end();
    if (admin && schema) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin?.end();
  });

  async function fixture(target = true) {
    const account = randomUUID(), collection = randomUUID(), device = randomUUID();
    const root = Buffer.alloc(16, 7), publicKey = Buffer.alloc(32, 8);
    const cohort = `c-${randomUUID().slice(0, 8)}`;
    await db.query("INSERT INTO users(id,email,name) VALUES($1,$2,'Test')", [account, `${account}@example.test`]);
    await db.query("INSERT INTO hosted_collections(id,user_id,display_name,template) VALUES($1,$2,'Source','mdbase')", [collection, account]);
    await db.query("INSERT INTO next_migration_cohorts(name,released_at,frozen_at) VALUES($1,now(),now())", [cohort]);
    await db.query("INSERT INTO next_migration_cohort_members(account_id,cohort,started_at) VALUES($1,$2,'2026-10-10T18:00:00.123456Z')", [account, cohort]);
    if (target) {
      await db.query("INSERT INTO next_collections(collection_id,owner_user_id,runtime,sync,root_key_id) VALUES($1,$2,'shadow','cloud_copy',$3)", [collection, account, root]);
      await db.query(
        "INSERT INTO next_service_devices(collection_id,kind,device_id,sign_pk,kem_pk,noise_pk,wrapped_keys,kms_key_arn) VALUES($1,'hosted',$2,$3,$3,$3,$4,'synthetic-private-kms-label')",
        [collection, device, publicKey, Buffer.from("synthetic-private-wrapped-label")]
      );
    }
    const app = Fastify();
    const forbidden = async () => { throw new Error("claim attempted provider effect"); };
    registerMigrationProviderRoutes(app, { db, token, provider: { legacyMigrationDrain: forbidden, legacyMigrationFence: forbidden } });
    const request = (authorization = `Bearer ${token}`, suffix = "") => app.inject({
      method: "GET", url: `/internal/v1/next/migration/collections/${collection}/claim${suffix}`, headers: { authorization }
    });
    return { account, collection, device, root, publicKey, app, request };
  }

  it("returns exact current owner/start/public SHADOW tuple without provider/bootstrap/audit effects", async () => {
    const f = await fixture();
    try {
      const response = await f.request();
      expect(response.statusCode, response.body).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.json()).toEqual({ schema: "mdbase-migration-claim/1", collection_id: f.collection,
        owner_account: f.account, started_us: "1791655200123456", target: {
          runtime: "shadow", root_key_id: f.root.toString("hex"), hosted: {
            device_id: f.device, sign_pk: f.publicKey.toString("hex"),
            kem_pk: f.publicKey.toString("hex"), noise_pk: f.publicKey.toString("hex")
          }
        } });
      expect(response.body).not.toContain("synthetic-private");
      expect((await db.query("SELECT count(*)::int AS n FROM audit_events WHERE subject_id=$1", [f.collection])).rows[0].n).toBe(0);
      expect((await db.query("SELECT count(*)::int AS n FROM next_policy_outbox WHERE collection_id=$1", [f.collection])).rows[0].n).toBe(0);
      expect((await db.query("SELECT count(*)::int AS n FROM next_service_devices WHERE collection_id=$1", [f.collection])).rows[0].n).toBe(1);
    } finally { await f.app.close(); }
  });
  it("returns honest missing-target DATA before bootstrap, without creating a target", async () => {
    const f = await fixture(false);
    try {
      const response = await f.request();
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().target).toBeNull();
      expect((await db.query("SELECT count(*)::int AS n FROM next_collections WHERE collection_id=$1", [f.collection])).rows[0].n).toBe(0);
    } finally { await f.app.close(); }
  });
  it("rejects ordinary credentials and caller selectors", async () => {
    const f = await fixture();
    try {
      for (const auth of ["", "Bearer session", "Bearer app", "Bearer hosted-service", "Bearer wrong"]) {
        expect((await f.request(auth)).statusCode).toBe(401);
      }
      for (const query of ["?owner=other", "?started_us=1", "?runtime=next", "?verified=true", "?driver_id=other"]) {
        expect((await f.request(undefined, query)).statusCode).toBe(400);
      }
      expect((await f.app.inject({ method: "POST", url: `/internal/v1/next/migration/collections/${f.collection}/claim`, headers: { authorization: `Bearer ${token}` }, payload: {} })).statusCode).toBe(404);
      for (const id of ["00000000-0000-0000-0000-000000000000", "A0000000-0000-4000-8000-000000000001", "invalid"]) {
        expect((await f.app.inject({ method: "GET", url: `/internal/v1/next/migration/collections/${id}/claim`, headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(400);
      }
      expect((await f.app.inject({ method: "GET", url: `/internal/v1/next/migration/collections/${f.collection}/claim`, headers: { authorization: `Bearer ${token}` }, payload: { verified: true } })).statusCode).toBe(400);
    } finally { await f.app.close(); }
  });
  it("preserves each microsecond and does not renew or change the started claim", async () => {
    const f = await fixture();
    try {
      const first = (await f.request()).json();
      expect((await f.request()).json()).toEqual(first);
      await db.query("UPDATE next_migration_cohort_members SET started_at=started_at+interval '1 microsecond' WHERE account_id=$1", [f.account]);
      expect((await f.request()).json().started_us).toBe("1791655200123457");
    } finally { await f.app.close(); }
  });
  it("preserves microseconds beyond JavaScript safe integers without a Date/number conversion", async () => {
    const f = await fixture();
    try {
      await db.query("UPDATE next_migration_cohort_members SET started_at='2300-01-01T00:00:00.000001Z' WHERE account_id=$1", [f.account]);
      expect((await f.request()).json().started_us).toBe("10413792000000001");
    } finally { await f.app.close(); }
  });
  it.each(["root-length", "nil-device"])("refuses malformed persisted target DATA: %s", async mode => {
    const f = await fixture();
    try {
      if (mode === "root-length") await db.query("UPDATE next_collections SET root_key_id=$2 WHERE collection_id=$1", [f.collection, Buffer.alloc(17)]);
      if (mode === "nil-device") await db.query("UPDATE next_service_devices SET device_id='00000000-0000-0000-0000-000000000000' WHERE collection_id=$1", [f.collection]);
      expect((await f.request()).statusCode).toBe(mode === "root-length" ? 409 : 503);
    } finally { await f.app.close(); }
  });
  it("preserves internal suspension rather than enabling user access", async () => {
    const f = await fixture();
    try {
      await db.query("UPDATE users SET suspended_at=now() WHERE id=$1", [f.account]);
      expect((await f.request()).statusCode).toBe(200);
      expect((await db.query("SELECT suspended_at,account_backend FROM users WHERE id=$1", [f.account])).rows[0])
        .toMatchObject({ suspended_at: expect.any(Date), account_backend: "legacy" });
    } finally { await f.app.close(); }
  });
  it.each(["unstarted", "account-delete", "source-delete", "backend", "terminal", "quarantine", "transferred", "deletion", "cutover", "flipped"])("refuses noncurrent source: %s", async mode => {
    const f = await fixture();
    try {
      if (mode === "unstarted") await db.query("UPDATE next_migration_cohort_members SET started_at=NULL WHERE account_id=$1", [f.account]);
      if (mode === "account-delete") await db.query("DELETE FROM users WHERE id=$1", [f.account]);
      if (mode === "source-delete") await db.query("DELETE FROM hosted_collections WHERE id=$1", [f.collection]);
      if (mode === "backend") await db.query("UPDATE users SET account_backend='next' WHERE id=$1", [f.account]);
      if (mode === "terminal") await db.query("UPDATE next_migration_cohort_members SET terminal_excluded_at=now() WHERE account_id=$1", [f.account]);
      if (mode === "quarantine") await db.query("UPDATE hosted_collections SET quarantined_at=now() WHERE id=$1", [f.collection]);
      if (mode === "transferred") await db.query("UPDATE hosted_collections SET authority_state='transferred' WHERE id=$1", [f.collection]);
      if (mode === "deletion") await db.query("INSERT INTO next_collection_deletion_facts(collection_id,deletion_id,lifecycle_epoch,authority) VALUES($1,$2,1,'native-registry')", [f.collection, randomUUID()]);
      if (mode === "cutover") await db.query("INSERT INTO next_migration_collections(collection_id,account_id,s_final,cutover_seq,barrier_f,final_digest) VALUES($1,$2,42,2,2,$3)", [f.collection, f.account, "ab".repeat(32)]);
      if (mode === "flipped") await db.query("INSERT INTO next_migration_account_flips(account_id,collections,evidence_digest) VALUES($1,$2,$3)", [f.account, [f.collection], "ab".repeat(32)]);
      expect((await f.request()).statusCode).toBe(409);
    } finally { await f.app.close(); }
  });
  it.each(["owner", "next", "private", "left", "missing-hosted"])("refuses conflicting or incomplete target: %s", async mode => {
    const f = await fixture();
    try {
      if (mode === "owner") {
        const other = randomUUID();
        await db.query("INSERT INTO users(id,email,name) VALUES($1,$2,'Other')", [other, `${other}@example.test`]);
        await db.query("UPDATE next_collections SET owner_user_id=$2 WHERE collection_id=$1", [f.collection, other]);
      }
      if (mode === "next") await db.query("UPDATE next_collections SET runtime='next' WHERE collection_id=$1", [f.collection]);
      if (mode === "private") {
        await db.query("DELETE FROM next_service_devices WHERE collection_id=$1", [f.collection]);
        await db.query("UPDATE next_collections SET sync='private' WHERE collection_id=$1", [f.collection]);
      }
      if (mode === "left") await db.query("UPDATE next_collections SET left_sync_at=now() WHERE collection_id=$1", [f.collection]);
      if (mode === "missing-hosted") await db.query("DELETE FROM next_service_devices WHERE collection_id=$1", [f.collection]);
      expect((await f.request()).statusCode).toBe(mode === "missing-hosted" ? 503 : 409);
    } finally { await f.app.close(); }
  });
  it("rechecks deletion after target SQL awaits before returning any facts", async () => {
    const f = await fixture();
    let inserted = false;
    const wrapped: DatabasePool = { query: db.query.bind(db), end: db.end.bind(db), connect: async () => {
      const client = await db.connect();
      return { release: client.release.bind(client), query: async <R extends pg.QueryResultRow>(text: string, values?: unknown[]) => {
        const result = await client.query<R>(text, values);
        if (!inserted && text.includes("FROM next_service_devices device")) {
          inserted = true;
          await db.query("INSERT INTO next_collection_deletion_facts(collection_id,deletion_id,lifecycle_epoch,authority) VALUES($1,$2,1,'native-registry')", [f.collection, randomUUID()]);
        }
        return result;
      } };
    } };
    const app = Fastify(); registerMigrationProviderRoutes(app, { db: wrapped, token });
    try {
      const result = await app.inject({ method: "GET", url: `/internal/v1/next/migration/collections/${f.collection}/claim`, headers: { authorization: `Bearer ${token}` } });
      expect(inserted).toBe(true); expect(result.statusCode, result.body).toBe(409);
    } finally { await app.close(); await f.app.close(); }
  });
});
