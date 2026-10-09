import { generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import Fastify from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, type DatabasePool } from "../../db.js";
import type { DatabaseConnection } from "../../database-types.js";
import { tokenHash } from "../../security.js";
import { localGrantFixture } from "./next-fixtures.test-helper.js";
import { registerLocalTakeoverRoutes } from "./local-takeover.js";
import { registerNextDeviceRoutes } from "./device-routes.js";
import { registerConnectorInventoryRoutes } from "../connectors/inventory-routes.js";
import { deviceRegistrationDigest, issueDeviceChallenge, registerDevice } from "./devices.js";
import { ed25519RawPublicKey } from "./policy-keys.js";

const testUrl = process.env.MDBASE_CONNECT_TEST_DATABASE_URL;
const approved = process.env.MDBASE_CONNECT_DESTRUCTIVE_TEST_APPROVAL === "I APPROVE MDBASE CONNECT DESTRUCTIVE POSTGRES TESTS";
const pgDescribe = testUrl && approved ? describe : describe.skip;
const endpoint = "/v1/next/migration/local-takeover";
const noLog = { controlItemAt: async () => { throw new Error("No log call expected."); } };

pgDescribe("local retirement and enrollment (isolated real Postgres)", () => {
  let admin: pg.Pool; let db: DatabasePool; let schema: string;
  const fences: Array<[string, string]> = [];
  const relay = { fenceConnector: async (id: string, generation: string) => { fences.push([id, generation]); return "closed" as const; } };
  const app = Fastify();
  beforeAll(async () => {
    const url = new URL(testUrl!);
    if (!["localhost", "127.0.0.1", "::1"].includes(url.hostname) || !/test/i.test(url.pathname)) throw new Error("Retirement requires an isolated local test DB.");
    schema = `local_takeover_test_${randomUUID().replaceAll("-", "")}`;
    admin = new pg.Pool({ connectionString: url.toString(), max: 2 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    url.searchParams.set("options", `-csearch_path=${schema}`);
    db = await createDatabase(url.toString());
    registerLocalTakeoverRoutes(app, { db, relay });
    registerNextDeviceRoutes(app, { db, log: noLog });
    registerConnectorInventoryRoutes(app, { db });
    await app.ready();
  }, 60_000);
  afterAll(async () => {
    await app.close(); await db?.end();
    if (admin && schema) await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin?.end();
  }, 60_000);

  async function fixture() {
    const old = await localGrantFixture(db);
    const current = randomUUID(), token = `fixture_native_${current}`, device = randomUUID();
    await db.query("UPDATE users SET account_backend='next' WHERE id=$1", [old]);
    await db.query("INSERT INTO connectors(id,user_id,name,token_hash) VALUES($1,$2,'Current native',$3)", [current, old, tokenHash(token)]);
    await db.query("INSERT INTO next_devices(id,connector_id,user_id,kind,sign_pk,kem_pk,noise_pk) VALUES($1,$2,$3,'desktop',$4,$5,$6)",
      [device, current, old, randomBytes(32), randomBytes(32), randomBytes(32)]);
    await db.query("UPDATE grants SET activated_at=now() WHERE id=$1", [old]);
    const input = { legacy_connector_id: old, legacy_collection_ids: [old], taken_over_at: "2000-01-01T00:00:00Z" };
    return { old, current, token, device, input, headers: { authorization: `Bearer ${token}` } };
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  const post = (f: Fixture, payload: unknown = f.input, target = app) => target.inject({ method: "POST", url: endpoint, headers: f.headers, payload });
  const state = async (f: Fixture) => ({
    connector: (await db.query("SELECT token_hash,revoked_at,relay_generation FROM connectors WHERE id=$1", [f.old])).rows[0],
    rows: (await db.query("SELECT * FROM collections WHERE connector_id=$1 ORDER BY local_id", [f.old])).rows,
    grants: (await db.query("SELECT * FROM grants WHERE collection_id=$1 ORDER BY id", [f.old])).rows,
  });
  async function registration(f: Fixture) {
    const key = generateKeyPairSync("ed25519").privateKey;
    const signPk = ed25519RawPublicKey(key), kemPk = randomBytes(32), noisePk = randomBytes(32), deviceId = randomUUID();
    const { challenge } = await issueDeviceChallenge(db, f.old);
    return { device_id: deviceId, kind: "desktop", challenge,
      sign_pk: Buffer.from(signPk).toString("hex"), kem_pk: kemPk.toString("hex"), noise_pk: noisePk.toString("hex"),
      sig: Buffer.from(sign(null, deviceRegistrationDigest({ challenge: Buffer.from(challenge, "hex"), connectorId: f.old, deviceId, signPk, kemPk, noisePk }), key)).toString("hex") };
  }
  const challengeUsed = async (body: { challenge: string }) => (await db.query("SELECT used_at FROM next_device_challenges WHERE challenge=$1", [Buffer.from(body.challenge, "hex")])).rows[0].used_at;

  it("retires one full legacy inventory with server time, preserves rows/grants, and replays after restart", async () => {
    const f = await fixture(), before = await state(f);
    const first = await post(f); expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ retired: true, legacy_connector_id: f.old });
    const after = await state(f);
    expect(after.connector.revoked_at).not.toBeNull();
    expect(new Date(after.connector.revoked_at).getUTCFullYear()).toBeGreaterThan(2000);
    expect(after.connector.relay_generation).toBe(String(BigInt(before.connector.relay_generation) + 1n));
    expect(after.rows).toEqual(before.rows.map(row => ({ ...row, authority_state: "retired", enabled: false })));
    expect(after.grants).toEqual(before.grants);
    expect(fences.at(-1)).toEqual([f.old, after.connector.relay_generation]);
    const restarted = Fastify(); registerLocalTakeoverRoutes(restarted, { db, relay });
    try { expect((await post(f, f.input, restarted)).json()).toEqual(first.json()); } finally { await restarted.close(); }
    expect(await state(f)).toEqual(after);
  });
  it("includes retired legacy authorities and uses local IDs rather than Connect row IDs", async () => {
    const f = await fixture(), local = randomUUID();
    await db.query("UPDATE collections SET local_id=$2,authority_state='retired',enabled=false WHERE id=$1", [f.old, local]);
    expect((await post(f)).statusCode).toBe(409);
    expect((await post(f, { ...f.input, legacy_collection_ids: [local] })).statusCode).toBe(200);
  });
  it("requires positive exact full inventory and canonicalizes order", async () => {
    const f = await fixture(), extra = randomUUID();
    await db.query("INSERT INTO collections(id,user_id,connector_id,local_id,display_name,spec_version) VALUES($1,$2,$2,$1,'Other','0.3.0')", [extra, f.old]);
    const before = await state(f);
    expect((await post(f)).statusCode).toBe(409); expect(await state(f)).toEqual(before);
    expect((await post(f, { ...f.input, legacy_collection_ids: [extra, f.old] })).statusCode).toBe(200);
    const after = await state(f);
    expect((await post(f, { ...f.input, legacy_collection_ids: [f.old, extra] })).statusCode).toBe(200);
    expect(await state(f)).toEqual(after);
    await db.query("UPDATE collections SET removed_at=now() WHERE connector_id=$1", [f.old]);
    expect((await post(f, { ...f.input, legacy_collection_ids: [f.old, extra] })).statusCode).toBe(409);
  });
  it.each(["no-rows", "not-present", "removed", "foreign", "caller", "next", "historical-next"])("refuses %s without mutation", async change => {
    const f = await fixture(); let payload = f.input;
    if (change === "no-rows") await db.query("DELETE FROM collections WHERE connector_id=$1", [f.old]);
    if (change === "not-present") await db.query("UPDATE collections SET present=false WHERE connector_id=$1", [f.old]);
    if (change === "removed") await db.query("UPDATE collections SET removed_at=now() WHERE connector_id=$1", [f.old]);
    if (change === "foreign") payload = (await fixture()).input;
    if (change === "caller") payload = { ...f.input, legacy_connector_id: f.current };
    if (change === "next" || change === "historical-next") {
      await db.query("INSERT INTO next_devices(id,connector_id,user_id,kind,sign_pk,kem_pk,noise_pk) VALUES($1,$2,$2,'desktop',$3,$4,$5)", [randomUUID(), f.old, randomBytes(32), randomBytes(32), randomBytes(32)]);
      if (change === "historical-next") await db.query("UPDATE connectors SET revoked_at=now() WHERE id=$1", [f.old]);
    }
    const before = await state(f); expect([403,409]).toContain((await post(f, payload)).statusCode); expect(await state(f)).toEqual(before);
  });
  it.each(["backend", "suspended", "revoked", "device", "mobile", "app-runtime"])("rechecks caller %s on replay", async change => {
    const f = await fixture(); expect((await post(f)).statusCode).toBe(200);
    const before = await state(f);
    if (change === "backend") await db.query("UPDATE users SET account_backend='legacy' WHERE id=$1", [f.old]);
    if (change === "suspended") await db.query("UPDATE users SET suspended_at=now() WHERE id=$1", [f.old]);
    if (change === "revoked") await db.query("UPDATE connectors SET revoked_at=now() WHERE id=$1", [f.current]);
    if (change === "device") await db.query("DELETE FROM next_devices WHERE id=$1", [f.device]);
    if (change === "mobile" || change === "app-runtime") await db.query("UPDATE next_devices SET kind=$2 WHERE id=$1", [f.device, change]);
    expect([401,403]).toContain((await post(f)).statusCode); expect(await state(f)).toEqual(before);
  });
  it("rejects duplicate/empty/excess inventory, extras and malformed timestamps before mutation", async () => {
    const f = await fixture(), before = await state(f);
    for (const payload of [{ ...f.input, legacy_collection_ids: [] }, { ...f.input, legacy_collection_ids: [f.old,f.old] },
      { ...f.input, legacy_collection_ids: Array.from({ length: 1001 }, () => randomUUID()) }, { ...f.input, arbitrary: true }, { ...f.input, taken_over_at: "invalid" }]) {
      expect((await post(f, payload)).statusCode).toBe(400);
    }
    expect((await app.inject({ method: "POST", url: endpoint, payload: f.input })).statusCode).toBe(401);
    expect(await state(f)).toEqual(before);
  });
  it("keeps committed retirement when broker closure fails and retries the same generation", async () => {
    const f = await fixture(); const failed = Fastify();
    registerLocalTakeoverRoutes(failed, { db, relay: { fenceConnector: async () => { throw new Error("Unavailable fixture broker."); } } });
    try { expect((await post(f, f.input, failed)).statusCode).toBe(200); } finally { await failed.close(); }
    const before = await state(f); expect((await post(f)).statusCode).toBe(200); expect(await state(f)).toEqual(before);
  });

  async function inventoryFixture(f: Fixture) {
    const token = `fixture_legacy_${f.old}`;
    await db.query("UPDATE connectors SET token_hash=$2 WHERE id=$1", [f.old, tokenHash(token)]);
    return { headers: { authorization: `Bearer ${token}` }, payload: { inventory_revision: 1,
      collections: [{ id: f.old, display_name: "Legacy fixture", spec_version: "0.3.0", enabled: true }] } };
  }
  const inventory = (request: Awaited<ReturnType<typeof inventoryFixture>>, target = app) => target.inject({ method: "POST", url: "/v1/connectors/sync", ...request });
  it("keeps valid stale-inventory accepted:false behavior after fresh authorization", async () => {
    const f = await fixture(), request = await inventoryFixture(f);
    expect((await inventory(request)).json().accepted).toBe(true);
    const before = await state(f), stale = await inventory(request);
    expect(stale.statusCode).toBe(200); expect(stale.json()).toEqual({ accepted: false, inventory_revision: 1, collections: [] });
    expect(await state(f)).toEqual(before);
  });
  it.each((["inventory", "enrollment"] as const).flatMap(operation =>
    (["digest", "revoked", "suspended", "owner"] as const).map(change => ({ operation, change }))
  ))("maps post-authentication $operation/$change to 403 before mutation", async ({ operation, change }) => {
    const f = await fixture(), request = await inventoryFixture(f), body = await registration(f);
    let changed = false;
    const wrapped = new Proxy(db, { get(target, key) {
      if (key === "query") return async (sql: string, parameters?: unknown[]) => {
        const result = await target.query(sql, parameters);
        if (!changed && sql.includes("WHERE c.token_hash = $1")) {
          changed = true;
          if (change === "digest") await db.query("UPDATE connectors SET token_hash=$2 WHERE id=$1", [f.old, tokenHash(`fixture_changed_${f.old}`)]);
          if (change === "revoked") await db.query("UPDATE connectors SET revoked_at=now() WHERE id=$1", [f.old]);
          if (change === "suspended") await db.query("UPDATE users SET suspended_at=now() WHERE id=$1", [f.old]);
          if (change === "owner") await db.query("UPDATE connectors SET user_id=$2 WHERE id=$1", [f.old, (await fixture()).old]);
        }
        return result;
      };
      const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
    } }) as DatabasePool;
    const staleApp = Fastify();
    if (operation === "inventory") registerConnectorInventoryRoutes(staleApp, { db: wrapped });
    else registerNextDeviceRoutes(staleApp, { db: wrapped, log: noLog });
    try {
      const rows = (await state(f)).rows, grants = (await state(f)).grants;
      const response = operation === "inventory" ? await inventory(request, staleApp)
        : await staleApp.inject({ method: "POST", url: "/v1/next/devices", headers: request.headers, payload: body });
      expect(response.statusCode).toBe(403); expect(response.json().error.code).toBe("identity_not_current");
      expect((await state(f)).rows).toEqual(rows); expect((await state(f)).grants).toEqual(grants);
      expect((await db.query("SELECT inventory_revision FROM connectors WHERE id=$1", [f.old])).rows[0].inventory_revision).toBe("0");
      expect(await challengeUsed(body)).toBeNull();
      expect((await db.query("SELECT id FROM next_devices WHERE connector_id=$1", [f.old])).rows).toEqual([]);
    } finally { await staleApp.close(); }
  });
  it("maps enrollment lock timeout to bounded 503 without consuming challenge", async () => {
    const f = await fixture(), request = await inventoryFixture(f), body = await registration(f);
    const blocker = await db.connect();
    try {
      await blocker.query("BEGIN"); await blocker.query("SELECT id FROM connectors WHERE id=$1 FOR UPDATE", [f.old]);
      const response = await app.inject({ method: "POST", url: "/v1/next/devices", headers: request.headers, payload: body });
      expect(response.statusCode).toBe(503); expect(response.json().error.code).toBe("busy");
      expect(await challengeUsed(body)).toBeNull();
      expect((await db.query("SELECT id FROM next_devices WHERE connector_id=$1", [f.old])).rows).toEqual([]);
    } finally { await blocker.query("ROLLBACK"); blocker.release(); }
  }, 10_000);

  function pauseLocked(match: string) {
    let open!: () => void, acquired!: (pid: number) => void;
    const release = new Promise<void>(resolve => { open = resolve; });
    const locked = new Promise<number>(resolve => { acquired = resolve; });
    let consumed = false;
    const wrapped = new Proxy(db, { get(target, key) {
      if (key === "connect") return async () => {
        const connection = await target.connect();
        return new Proxy(connection, { get(c, property) {
          if (property === "query") return async (sql: string, parameters?: unknown[]) => {
            const result = await c.query(sql, parameters);
            if (!consumed && sql.includes(match)) {
              consumed = true;
              const pid = (await c.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
              acquired(pid); await release;
            }
            return result;
          };
          const value = Reflect.get(c, property); return typeof value === "function" ? value.bind(c) : value;
        } }) as DatabaseConnection;
      };
      const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
    } }) as DatabasePool;
    return { db: wrapped, locked, open };
  }
  async function blockedBy(pid: number) {
    for (let i = 0; i < 200; i++) {
      const rows = (await admin.query("SELECT pid FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))", [pid])).rows;
      if (rows.length) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error("Competing transaction did not wait on the real connector lock.");
  }
  it("retirement wins: enrollment blocks then refuses without challenge consumption or insertion", async () => {
    const f = await fixture(), body = await registration(f), gate = pauseLocked("SELECT revoked_at, relay_generation::text");
    const firstApp = Fastify(); registerLocalTakeoverRoutes(firstApp, { db: gate.db, relay });
    const first = post(f, f.input, firstApp);
    const pid = await gate.locked;
    const second = registerDevice(db, { id: f.old, user_id: f.old }, body, f.old).then(value => ({ value }), error => ({ error }));
    try {
      await blockedBy(pid); gate.open(); expect((await first).statusCode).toBe(200);
      expect(await second).toMatchObject({ error: { code: "identity_not_current" } });
      expect(await challengeUsed(body)).toBeNull();
      expect((await db.query("SELECT id FROM next_devices WHERE connector_id=$1", [f.old])).rows).toEqual([]);
    } finally { gate.open(); await firstApp.close(); }
  });
  it("retirement wins: pre-authenticated inventory blocks then refuses without changing retired rows", async () => {
    const f = await fixture(), request = await inventoryFixture(f), gate = pauseLocked("SELECT revoked_at, relay_generation::text");
    const firstApp = Fastify(); registerLocalTakeoverRoutes(firstApp, { db: gate.db, relay });
    const first = post(f, f.input, firstApp), pid = await gate.locked;
    const second = inventory(request);
    try {
      await blockedBy(pid); gate.open(); expect((await first).statusCode).toBe(200);
      const committed = await state(f), refused = await second;
      expect(refused.statusCode).toBe(403); expect(refused.json().error.code).toBe("identity_not_current");
      expect(await state(f)).toEqual(committed);
      expect((await db.query("SELECT inventory_revision FROM connectors WHERE id=$1", [f.old])).rows[0].inventory_revision).toBe("0");
    } finally { gate.open(); await firstApp.close(); }
  });
  it("inventory wins: retirement blocks and checks the newly committed full inventory", async () => {
    const f = await fixture(), request = await inventoryFixture(f), extra = randomUUID(), gate = pauseLocked("AND revoked_at IS NULL FOR UPDATE");
    request.payload.collections.push({ id: extra, display_name: "Added by this inventory", spec_version: "0.3.0", enabled: true });
    const firstApp = Fastify(); registerConnectorInventoryRoutes(firstApp, { db: gate.db });
    const first = inventory(request, firstApp), pid = await gate.locked;
    const second = post(f);
    try {
      await blockedBy(pid); gate.open(); const accepted = await first;
      expect(accepted.statusCode).toBe(200); expect(accepted.json().accepted).toBe(true);
      const committed = await state(f), refused = await second;
      expect(refused.statusCode).toBe(409); expect(refused.json().error.code).toBe("legacy_inventory_mismatch");
      expect(await state(f)).toEqual(committed); expect(committed.connector.revoked_at).toBeNull(); expect(committed.rows).toHaveLength(2);
    } finally { gate.open(); await firstApp.close(); }
  });
  it("enrollment wins: retirement blocks then refuses without legacy/grant mutation", async () => {
    const f = await fixture(), body = await registration(f), before = await state(f), gate = pauseLocked("AND revoked_at IS NULL FOR UPDATE");
    const first = registerDevice(gate.db, { id: f.old, user_id: f.old }, body, f.old);
    const pid = await gate.locked;
    const second = post(f);
    try {
      await blockedBy(pid); gate.open(); expect(await first).toEqual({ device_id: body.device_id });
      const refused = await second; expect(refused.statusCode).toBe(409); expect(refused.json().error.code).toBe("legacy_connector_is_next");
      expect(await state(f)).toEqual(before);
    } finally { gate.open(); }
  });
});
