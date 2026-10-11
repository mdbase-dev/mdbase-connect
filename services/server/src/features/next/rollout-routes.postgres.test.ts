import { randomBytes, randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, type DatabasePool } from "../../db.js";
import { tokenHash } from "../../security.js";
import { provisionNewAccountBackend } from "./account-backend-flip.js";
import {
  acceptCohortArchive, addToCohort, cohortArchiveBinding, createCohort, flipAccountBackend, flipEvidenceDigest,
  recordCollectionCutover, releaseCohort, setCohortFrozen, setPaused, startAccountMigration
} from "./migration-rollout.js";
import { registerNextRolloutRoutes } from "./rollout-routes.js";

const testUrl = process.env.MDBASE_CONNECT_TEST_DATABASE_URL;
const approved = process.env.MDBASE_CONNECT_DESTRUCTIVE_TEST_APPROVAL === "I APPROVE MDBASE CONNECT DESTRUCTIVE POSTGRES TESTS";
const describePg = testUrl && approved ? describe : describe.skip;
const OP = "test-operator";
const digest = (n: number) => n.toString(16).padStart(64, "0");
const url = "/v1/next/rollout";

describePg("GET /v1/next/rollout (dedicated local Postgres)", () => {
  let db: DatabasePool; let admin: pg.Pool; let schema: string; let app: FastifyInstance;
  beforeAll(async () => {
    const u = new URL(testUrl!);
    if (!["localhost", "127.0.0.1", "::1"].includes(u.hostname) || !/test/i.test(u.pathname)) throw new Error("Dedicated local test Postgres required");
    schema = `next_rollout_${randomUUID().replaceAll("-", "")}`;
    admin = new pg.Pool({ connectionString: u.toString(), max: 2 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    u.searchParams.set("options", `-csearch_path=${schema}`);
    db = await createDatabase(u.toString());
    app = Fastify();
    registerNextRolloutRoutes(app, db);
    await app.ready();
  }, 60_000);
  afterAll(async () => {
    await app?.close();
    await db?.end();
    if (admin && schema) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin?.end();
  });

  /** An account with `hosted` active hosted collections and one connector credential. */
  async function account(hosted = 0) {
    const user = randomUUID(), connector = randomUUID(), token = `connector_${randomUUID()}`;
    await db.query("INSERT INTO users(id,email,name) VALUES($1,$2,'Test')", [user, `${user}@example.test`]);
    await db.query("INSERT INTO connectors(id,user_id,name,token_hash) VALUES($1,$2,'Computer',$3)", [connector, user, tokenHash(token)]);
    const ids: string[] = [];
    for (let i = 0; i < hosted; i++) {
      const id = randomUUID();
      await db.query("INSERT INTO hosted_collections(id,user_id,display_name,template,authority_state) VALUES($1,$2,'C','mdbase','active')", [id, user]);
      ids.push(id);
    }
    return { user, connector, token, ids: ids.sort() };
  }
  async function released(users: string[]) {
    const cohort = `c-${randomUUID().slice(0, 8)}`;
    await createCohort(db, cohort, OP);
    await addToCohort(db, cohort, users, OP);
    await releaseCohort(db, cohort, OP);
    await setCohortFrozen(db, cohort, true, "synthetic archive capture", OP);
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
  }
  async function cutOver(user: string, id: string, n: number) {
    await db.query("INSERT INTO next_collections(collection_id,owner_user_id,runtime,sync,root_key_id) VALUES($1,$2,'shadow','cloud_copy',$3)", [id, user, Buffer.alloc(16)]);
    await recordCollectionCutover(db, id, { s_final: 3, cutover_seq: 10 + n, barrier_f: 10 + n, final_digest: digest(n + 1) });
    return { collection_id: id, barrier_f: 10 + n, final_digest: digest(n + 1) };
  }
  const get = (token?: string, extra: Record<string, string> = {}, path = url) =>
    app.inject({ method: "GET", url: path, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra } });
  async function answer(token: string) {
    const response = await get(token);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    const body = response.json();
    // Exactly the daemon's deny-unknown-fields contract; nothing identifying.
    expect(Object.keys(body).sort()).toEqual(["account_backend", "local_takeover"]);
    return body;
  }

  it("keeps a legacy account closed", async () => {
    const a = await account(1);
    expect(await answer(a.token)).toEqual({ local_takeover: false, account_backend: "legacy" });
  });

  it("opens a new next-backend account that has a flip record but no cohort membership", async () => {
    const a = await account();
    await provisionNewAccountBackend(db, a.user, "next");
    expect((await db.query("SELECT 1 FROM next_migration_cohort_members WHERE account_id=$1", [a.user])).rows).toHaveLength(0);
    expect((await db.query("SELECT 1 FROM next_migration_account_flips WHERE account_id=$1", [a.user])).rows).toHaveLength(1);
    expect(await answer(a.token)).toEqual({ local_takeover: true, account_backend: "next" });
  });

  it("stays closed through release, start and partial cutover; opens only after the verified flip", async () => {
    const a = await account(2);
    await released([a.user]);
    expect(await answer(a.token)).toEqual({ local_takeover: false, account_backend: "legacy" });
    await setPaused(db, false, "start test cohort", OP);
    await startAccountMigration(db, a.user, "production");
    const first = await cutOver(a.user, a.ids[0]!, 0);
    expect(await answer(a.token)).toEqual({ local_takeover: false, account_backend: "legacy" });
    const second = await cutOver(a.user, a.ids[1]!, 1);
    // Every collection cut over but not flipped: still closed.
    expect(await answer(a.token)).toEqual({ local_takeover: false, account_backend: "legacy" });
    await flipAccountBackend(db, a.user, a.ids, flipEvidenceDigest([first, second]));
    expect(await answer(a.token)).toEqual({ local_takeover: true, account_backend: "next" });
    await setPaused(db, true, "test done", OP);
  });

  it("answers only for the credential's own account; caller-supplied selectors are ignored", async () => {
    const legacy = await account(), next = await account();
    await provisionNewAccountBackend(db, next.user, "next");
    for (const path of [
      `${url}?account=${next.user}&account_id=${next.user}&local_takeover=true&account_backend=next`,
      `${url}/../rollout?user_id=${next.user}`
    ]) {
      const response = await get(legacy.token, { "x-account-id": next.user, "x-mdbase-account": next.user }, path);
      if (response.statusCode === 200) expect(response.json()).toEqual({ local_takeover: false, account_backend: "legacy" });
      else expect(response.statusCode).toBe(404);
      expect(response.body).not.toContain(next.user);
      expect(response.body).not.toContain(legacy.user);
    }
    // The opened account's answer does not leak into the other.
    expect(await answer(next.token)).toEqual({ local_takeover: true, account_backend: "next" });
    expect(await answer(legacy.token)).toEqual({ local_takeover: false, account_backend: "legacy" });
  });

  it("refuses anonymous, malformed, session, app installation, revoked and suspended callers with an uncached 401", async () => {
    const a = await account();
    await provisionNewAccountBackend(db, a.user, "next");
    const refused = async (response: Awaited<ReturnType<typeof get>>) => {
      expect(response.statusCode).toBe(401);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.body).not.toContain("local_takeover");
      expect(response.body).not.toContain(a.user);
    };
    await refused(await get());
    await refused(await get("invalid"));
    await refused(await app.inject({ method: "GET", url, headers: { authorization: `Basic ${a.token}` } }));
    await refused(await app.inject({ method: "GET", url, headers: { authorization: `bearer ${a.token}` } }));
    // A browser session for the same account is not a connector credential.
    const session = `session_${randomUUID()}`;
    await db.query("INSERT INTO sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,now() + interval '1 hour')", [randomUUID(), a.user, tokenHash(session)]);
    await refused(await get(session));
    await refused(await app.inject({ method: "GET", url, headers: { cookie: `mdbase_session=${session}` } }));
    // An app installation credential on this account's connector is app-scoped, not a daemon.
    const device = randomUUID(), app_token = `fixture_app_${randomUUID()}`;
    const keys = [randomBytes(32), randomBytes(32), randomBytes(32)];
    await db.query("INSERT INTO next_devices(id,connector_id,user_id,kind,sign_pk,kem_pk,noise_pk) VALUES($1,$2,$3,'app-runtime',$4,$5,$6)",
      [device, a.connector, a.user, ...keys]);
    await db.query(`INSERT INTO installation_device_credentials(pairing_id,connector_id,device_id,installation_id,app_id,app_origin,kind,sign_pk,kem_pk,noise_pk,token_hash)
      VALUES($1,$2,$3,$4,'fixture-app','https://example.test','app-runtime',$5,$6,$7,$8)`,
      [randomUUID(), a.connector, device, randomUUID(), ...keys, tokenHash(app_token)]);
    await refused(await get(app_token));
    // The connector itself still works, then stops when suspended or revoked.
    expect(await answer(a.token)).toEqual({ local_takeover: true, account_backend: "next" });
    await db.query("UPDATE users SET suspended_at = now() WHERE id = $1", [a.user]);
    await refused(await get(a.token));
    await db.query("UPDATE users SET suspended_at = NULL WHERE id = $1", [a.user]);
    await db.query("UPDATE connectors SET revoked_at = now() WHERE id = $1", [a.connector]);
    await refused(await get(a.token));
  });

  it("serves only GET", async () => {
    const a = await account();
    for (const method of ["POST", "PUT", "PATCH", "DELETE"] as const) {
      const response = await app.inject({ method, url, headers: { authorization: `Bearer ${a.token}` }, payload: { local_takeover: true } });
      expect(response.statusCode).toBe(404);
    }
    expect((await db.query("SELECT account_backend FROM users WHERE id=$1", [a.user])).rows[0].account_backend).toBe("legacy");
  });
});
