import { randomBytes, randomUUID } from "node:crypto";
import Fastify from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RELAY_ENCRYPTION_SUITE } from "@mdbase-dev/connect-protocol";
import { createDatabase, type DatabasePool } from "../../db.js";
import { tokenHash } from "../../security.js";
import { localGrantFixture } from "./next-fixtures.test-helper.js";
import { registerLocalRollbackBindingRoutes } from "./local-rollback-bindings.js";

const testUrl = process.env.MDBASE_CONNECT_TEST_DATABASE_URL;
const approved = process.env.MDBASE_CONNECT_DESTRUCTIVE_TEST_APPROVAL === "I APPROVE MDBASE CONNECT DESTRUCTIVE POSTGRES TESTS";
const pgDescribe = testUrl && approved ? describe : describe.skip;
const endpoint = "/v1/next/migration/local-rollback/rotate-bindings";

pgDescribe("fenced local rollback bindings (isolated real Postgres)", () => {
  let admin: pg.Pool; let db: DatabasePool; let schema: string;
  const app = Fastify();
  beforeAll(async () => {
    const url = new URL(testUrl!);
    if (!["localhost", "127.0.0.1", "::1"].includes(url.hostname) || !/test/i.test(url.pathname)) {
      throw new Error("Rollback tests require a dedicated local test database.");
    }
    schema = `local_rollback_test_${randomUUID().replaceAll("-", "")}`;
    admin = new pg.Pool({ connectionString: url.toString(), max: 2 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    url.searchParams.set("options", `-csearch_path=${schema}`);
    db = await createDatabase(url.toString());
    registerLocalRollbackBindingRoutes(app, db);
    await app.ready();
  }, 60_000);
  afterAll(async () => {
    await app.close(); await db?.end();
    if (admin && schema) await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin?.end();
  }, 60_000);

  async function fixture() {
    const old = await localGrantFixture(db);
    const current = randomUUID(); const token = `fixture_native_${current}`;
    await db.query("UPDATE users SET account_backend='next' WHERE id=$1", [old]);
    await db.query("INSERT INTO connectors(id,user_id,name,token_hash) VALUES($1,$2,'New native',$3)", [current, old, tokenHash(token)]);
    const device = randomUUID();
    await db.query("INSERT INTO next_devices(id,connector_id,user_id,kind,sign_pk,kem_pk,noise_pk) VALUES($1,$2,$3,'desktop',$4,$5,$6)",
      [device, current, old, randomBytes(32), randomBytes(32), randomBytes(32)]);
    const encryption = { protocol_version: 1, suite: RELAY_ENCRYPTION_SUITE, key_id: `enc_${randomUUID()}`,
      scope_epoch: 3, connector_id: old, collection_id: old,
      application_agreement_public_key: randomBytes(32).toString("base64url"),
      connector_agreement_public_key: randomBytes(32).toString("base64url") };
    await db.query("UPDATE grants SET activated_at=now(), encryption=$2::jsonb WHERE id=$1", [old, JSON.stringify(encryption)]);
    const input = { legacy_connector_id: old, legacy_collection_ids: [old], collection_id: old, rollback_id: randomUUID() };
    const headers = { authorization: `Bearer ${token}` };
    return { old, current, device, input, headers, encryption };
  }
  const post = (f: Awaited<ReturnType<typeof fixture>>, payload: unknown = f.input) => app.inject({ method: "POST", url: endpoint, headers: f.headers, payload });
  const encryption = async (id: string) => (await db.query("SELECT encryption FROM grants WHERE id=$1", [id])).rows[0].encryption;

  it("commits one rotation and exact replay after response loss/restart", async () => {
    const f = await fixture();
    await db.query("UPDATE connectors SET revoked_at=now() WHERE id=$1", [f.old]);
    await db.query("UPDATE collections SET authority_state='retired',enabled=false WHERE connector_id=$1", [f.old]);
    const first = await post(f); expect(first.statusCode).toBe(200);
    const result = first.json();
    expect(result).toEqual({ collection_id: f.old, rollback_id: f.input.rollback_id,
      bindings: [{ grant_id: f.old, key_id: expect.stringMatching(/^enc_/), scope_epoch: 4 }] });
    const rotated = await encryption(f.old);
    expect(rotated).toEqual({ ...f.encryption, key_id: result.bindings[0].key_id, scope_epoch: 4 });
    const restarted = Fastify(); registerLocalRollbackBindingRoutes(restarted, db);
    try {
      // Treat the first response as lost; another process retries the SAME ID.
      const replay = await restarted.inject({ method: "POST", url: endpoint, headers: f.headers, payload: f.input });
      expect(replay.statusCode).toBe(200); expect(replay.json()).toEqual(result);
    } finally { await restarted.close(); }
    expect(await encryption(f.old)).toEqual(rotated);
    expect((await db.query("SELECT count(*) FROM next_local_rollback_bindings WHERE collection_id=$1", [f.old])).rows[0].count).toBe("1");
    expect((await db.query("SELECT account_backend FROM users WHERE id=$1", [f.old])).rows[0].account_backend).toBe("next");
    expect((await db.query("SELECT revoked_at FROM connectors WHERE id=$1", [f.old])).rows[0].revoked_at).not.toBeNull();
  });
  it("serializes concurrent same-ID requests without rotating twice", async () => {
    const f = await fixture(); const replies = await Promise.all([post(f), post(f)]);
    expect(replies.map(r => r.statusCode)).toEqual([200, 200]);
    expect(replies[0].json()).toEqual(replies[1].json()); expect((await encryption(f.old)).scope_epoch).toBe(4);
  });
  it("requires exact inventory, rejects partial/duplicate/foreign/caller identity", async () => {
    const f = await fixture(); const extra = randomUUID();
    await db.query("INSERT INTO collections(id,user_id,connector_id,local_id,display_name,spec_version) VALUES($1,$2,$2,$1,'Other','0.2.0')", [extra, f.old]);
    expect((await post(f)).statusCode).toBe(409);
    expect((await post(f, { ...f.input, legacy_collection_ids: [f.old, f.old] })).statusCode).toBe(400);
    expect((await post(f, { ...f.input, legacy_connector_id: f.current })).statusCode).toBe(409);
    const foreign = await fixture();
    expect((await post(f, foreign.input)).statusCode).toBe(403);
    expect(await encryption(f.old)).toEqual(f.encryption);
    const full = { ...f.input, legacy_collection_ids: [extra, f.old].reverse() };
    const success = await post(f, full); expect(success.statusCode).toBe(200);
    expect((await post(f, { ...full, legacy_collection_ids: [...full.legacy_collection_ids].reverse() })).json()).toEqual(success.json());
    // Reuse for a different canonical inventory must not produce another result.
    await db.query("UPDATE collections SET present=false, removed_at=now() WHERE local_id=$1", [extra]);
    const conflict = await post(f); expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe("rollback_id_conflict");
    expect((await encryption(f.old)).scope_epoch).toBe(4);
  });
  it("rechecks native credential/account/device eligibility on each replay", async () => {
    for (const change of ["backend", "suspended", "revoked", "device"] as const) {
      const f = await fixture(); expect((await post(f)).statusCode).toBe(200);
      if (change === "backend") await db.query("UPDATE users SET account_backend='legacy' WHERE id=$1", [f.old]);
      if (change === "suspended") await db.query("UPDATE users SET suspended_at=now() WHERE id=$1", [f.old]);
      if (change === "revoked") await db.query("UPDATE connectors SET revoked_at=now() WHERE id=$1", [f.current]);
      if (change === "device") await db.query("DELETE FROM next_devices WHERE id=$1", [f.device]);
      expect([401,403]).toContain((await post(f)).statusCode);
      expect((await encryption(f.old)).scope_epoch).toBe(4);
    }
    const f = await fixture(); await db.query("UPDATE next_devices SET kind='app-runtime' WHERE id=$1", [f.device]);
    expect((await post(f)).statusCode).toBe(403); expect(await encryption(f.old)).toEqual(f.encryption);
  });
  it("refuses changed active bindings on replay without changing the receipt", async () => {
    for (const change of ["revoke", "narrow", "new"] as const) {
      const f = await fixture(); const first = (await post(f)).json();
      if (change === "revoke") await db.query("UPDATE grants SET revoked_at=now() WHERE id=$1", [f.old]);
      if (change === "narrow") await db.query("UPDATE grants SET encryption=jsonb_set(encryption,'{scope_epoch}','5') WHERE id=$1", [f.old]);
      if (change === "new") await db.query(`INSERT INTO grants(id,user_id,application_id,collection_id,operations,encryption,activated_at)
        VALUES($1,$2,$2,$2,'[]',$3::jsonb,now())`, [randomUUID(), f.old, JSON.stringify(f.encryption)]);
      const replay = await post(f); expect(replay.statusCode).toBe(409);
      expect(replay.json().error.code).toBe("rollback_bindings_changed");
      expect((await db.query("SELECT response FROM next_local_rollback_bindings WHERE collection_id=$1 AND rollback_id=$2", [f.old, f.input.rollback_id])).rows[0].response).toEqual(first);
    }
  });
  it("empty active set means no binding, never grant reactivation", async () => {
    const f = await fixture(); await db.query("UPDATE grants SET revoked_at=now() WHERE id=$1", [f.old]);
    const response = await post(f); expect(response.statusCode).toBe(200);
    expect(response.json().bindings).toEqual([]);
    expect((await post(f)).json()).toEqual(response.json()); expect(await encryption(f.old)).toEqual(f.encryption);
    expect((await db.query("SELECT revoked_at FROM grants WHERE id=$1", [f.old])).rows[0].revoked_at).not.toBeNull();
  });
  it("malformed or exhausted legacy binding aborts atomically", async () => {
    const f = await fixture();
    const other = randomUUID();
    await db.query(`INSERT INTO grants(id,user_id,application_id,collection_id,operations,encryption,activated_at)
      VALUES($1,$2,$2,$2,'[]',$3::jsonb,now())`, [other, f.old, JSON.stringify({ ...f.encryption, scope_epoch: Number.MAX_SAFE_INTEGER })]);
    expect((await post(f)).statusCode).toBe(409); expect(await encryption(f.old)).toEqual(f.encryption);
    expect((await db.query("SELECT count(*) FROM next_local_rollback_bindings WHERE collection_id=$1", [f.old])).rows[0].count).toBe("0");
  });
  it("scoped installation credential and unauthenticated requests cannot rotate", async () => {
    const f = await fixture(); const credential = `fixture_app_${f.current}`;
    const keys = (await db.query("SELECT sign_pk,kem_pk,noise_pk FROM next_devices WHERE id=$1", [f.device])).rows[0];
    await db.query("UPDATE next_devices SET kind='app-runtime' WHERE id=$1", [f.device]);
    await db.query(`INSERT INTO installation_device_credentials(pairing_id,connector_id,device_id,installation_id,app_id,app_origin,kind,sign_pk,kem_pk,noise_pk,token_hash)
      VALUES($1,$2,$3,$4,'fixture-app','https://example.test','app-runtime',$5,$6,$7,$8)`,
      [randomUUID(), f.current, f.device, randomUUID(), keys.sign_pk, keys.kem_pk, keys.noise_pk, tokenHash(credential)]);
    const response = await app.inject({ method:"POST",url:endpoint,headers:{ authorization:`Bearer ${credential}` },payload:f.input });
    expect(response.statusCode).toBe(401);
    expect((await app.inject({ method:"POST",url:endpoint,payload:f.input })).statusCode).toBe(401);
    expect(await encryption(f.old)).toEqual(f.encryption);
  });
});
