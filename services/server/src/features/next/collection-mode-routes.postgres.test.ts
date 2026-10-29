import { randomUUID } from "node:crypto";
import cookie from "@fastify/cookie";
import Fastify from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, type DatabasePool } from "../../db.js";
import { ensureDevelopmentEntitlement } from "../../entitlements.js";
import { registerErrorHandler } from "../../platform/error-handler.js";
import { tokenHash } from "../../security.js";
import { inTransaction, lock } from "./bootstrap-common.js";
import { recordCollectionDeletionIntent } from "./collection-deletion.js";
import { registerCollectionNameRoutes } from "./collection-name-routes.js";
import { registerNextCollection } from "./policy-outbox.js";

const testUrl = process.env.MDBASE_CONNECT_TEST_DATABASE_URL;
const approved = process.env.MDBASE_CONNECT_DESTRUCTIVE_TEST_APPROVAL === "I APPROVE MDBASE CONNECT DESTRUCTIVE POSTGRES TESTS";
const describePg = testUrl && approved ? describe : describe.skip;

describePg("durable owner mode intent", () => {
  let db: DatabasePool, admin: pg.Pool, schema: string;
  const keys = { sign_pk: Buffer.alloc(32, 1), kem_pk: Buffer.alloc(32, 2), noise_pk: Buffer.alloc(32, 3) };
  const server = async (pool = db) => {
    const app = Fastify(); await app.register(cookie); registerErrorHandler(app);
    registerCollectionNameRoutes(app, pool); return app;
  };
  let app: Awaited<ReturnType<typeof server>>;
  beforeAll(async () => {
    const url = new URL(testUrl!);
    if (!["localhost", "127.0.0.1", "::1"].includes(url.hostname) || !/test/i.test(url.pathname)) throw new Error("Requires dedicated local test Postgres.");
    schema = `collection_modes_${randomUUID().replaceAll("-", "")}`;
    admin = new pg.Pool({ connectionString: url.toString(), max: 2 });
    await admin.query(`CREATE SCHEMA "${schema}"`); url.searchParams.set("options", `-csearch_path=${schema}`);
    db = await createDatabase(url.toString()); app = await server();
  }, 60_000);
  afterAll(async () => {
    await app?.close(); await db?.end();
    if (admin && schema) await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin?.end();
  });
  async function fixture(sync: "private" | "cloud_copy" = "cloud_copy") {
    const user = randomUUID(), connector = randomUUID(), device = randomUUID(), collection = randomUUID(), session = randomUUID();
    const token = randomUUID(), browser = randomUUID();
    await db.query("INSERT INTO users(id,email,name,account_backend) VALUES($1,$2,'Owner','next')", [user, `${user}@example.test`]);
    await ensureDevelopmentEntitlement(db, user);
    await db.query("INSERT INTO sessions(id,user_id,token_hash,provider,account_session_epoch,expires_at) VALUES($1,$2,$3,'password',1,now()+interval '1 day')", [session, user, tokenHash(browser)]);
    await db.query("INSERT INTO connectors(id,user_id,name,token_hash) VALUES($1,$2,'Owner device',$3)", [connector, user, tokenHash(token)]);
    await db.query("INSERT INTO next_devices(id,connector_id,user_id,kind,sign_pk,kem_pk,noise_pk) VALUES($1,$2,$3,'desktop',$4,$5,$6)", [device, connector, user, keys.sign_pk, keys.kem_pk, keys.noise_pk]);
    await inTransaction(db, client => registerNextCollection(client, { collectionId: collection, ownerUserId: user, runtime: "next", sync, rootKeyId: Buffer.alloc(32), displayName: "Notes",
      ops: [{ op: "genesis", owner: user, root: Buffer.alloc(32), state: sync === "private" ? "e2e" : "cloud-copy" },
        { op: "member-set", account: user, role: "owner" },
        { op: "device-enrol", device, account: user, kind: "desktop", signPublicKey: keys.sign_pk, kemPublicKey: keys.kem_pk, noisePublicKey: keys.noise_pk }] }));
    const batch = (await db.query<{ id: string }>("INSERT INTO next_policy_batches(collection_id,seq,prev,item,issued_at,state,appended_at) VALUES($1,1,$2,$3,1,'appended',now()) RETURNING id", [collection, Buffer.alloc(32), Buffer.from("genesis fixture")])).rows[0].id;
    await db.query("UPDATE next_policy_outbox SET batch_id=$2 WHERE collection_id=$1", [collection, batch]);
    return { user, connector, device, collection, session, sync, batch,
      headers: { authorization: `Bearer ${token}` } as Record<string, string>, browserHeaders: { cookie: `mdbase_session=${browser}` } };
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  const start = (f: Fixture, requestId = randomUUID(), target = f.sync === "private" ? "cloud_copy" : "private", instance = app) =>
    instance.inject({ method: "POST", url: `/v1/next/collections/${f.collection}/mode`, headers: f.headers, payload: { request_id: requestId, target_mode: target } });
  const get = (f: Fixture, request: string, instance = app) => instance.inject({ method: "GET", url: `/v1/next/collections/${f.collection}/mode/${request}`, headers: f.headers });
  const changes = async (f: Fixture) => (await db.query("SELECT * FROM next_collection_mode_changes WHERE collection_id=$1", [f.collection])).rows;

  it.each(["private", "cloud_copy"] as const)("accepts %s owner intent without prematurely changing policy, keys or catalog", async sync => {
    const f = await fixture(sync), request = randomUUID();
    const before = (await db.query("SELECT ops FROM next_policy_outbox WHERE collection_id=$1", [f.collection])).rows;
    for (const headers of [f.headers, f.browserHeaders]) {
      const response = await start({ ...f, headers }, request);
      expect(response.statusCode, response.body).toBe(202);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.json()).toEqual({ collection_id: f.collection, request_id: request, source_mode: sync,
        target_mode: sync === "private" ? "cloud_copy" : "private", current_mode: sync, phase: "waiting_for_device" });
    }
    expect(await changes(f)).toHaveLength(1);
    expect((await db.query("SELECT sync FROM next_collections WHERE collection_id=$1", [f.collection])).rows[0].sync).toBe(sync);
    expect((await db.query("SELECT ops FROM next_policy_outbox WHERE collection_id=$1", [f.collection])).rows).toEqual(before);
  });

  it("recovers the same request after process restart and a lost success response", async () => {
    const f = await fixture(), request = randomUUID();
    let lost = true;
    const uncertain: DatabasePool = { query: db.query.bind(db), end: db.end.bind(db), connect: async () => {
      const c = await db.connect(); return { release: () => c.release(), query: async <R extends pg.QueryResultRow>(sql: string, values?: unknown[]) => {
        const result = await c.query<R>(sql, values);
        if (sql === "COMMIT" && lost) { lost = false; throw new Error("lost response after commit"); }
        return result;
      } };
    } };
    const old = await server(uncertain);
    try { expect((await start(f, request, "private", old)).statusCode).toBe(500); } finally { await old.close(); }
    const restarted = await server();
    try {
      expect((await get(f, request, restarted)).json().phase).toBe("waiting_for_device");
      expect((await start(f, request, "private", restarted)).statusCode).toBe(202);
      expect(await changes(f)).toHaveLength(1);
    } finally { await restarted.close(); }
  });

  it("rolls back intent if the transaction fails before commit", async () => {
    const f = await fixture(), request = randomUUID();
    const failed: DatabasePool = { query: db.query.bind(db), end: db.end.bind(db), connect: async () => {
      const c = await db.connect(); return { release: () => c.release(), query: async <R extends pg.QueryResultRow>(sql: string, values?: unknown[]) => {
        if (sql === "COMMIT") throw new Error("crash before commit");
        return c.query<R>(sql, values);
      } };
    } };
    const crashed = await server(failed);
    try { expect((await start(f, request, "private", crashed)).statusCode).toBe(500); } finally { await crashed.close(); }
    expect(await changes(f)).toEqual([]);
    expect((await start(f, request)).statusCode).toBe(202);
  });

  it("serializes duplicate, conflicting and concurrent requests", async () => {
    const f = await fixture(), request = randomUUID();
    const duplicate = await Promise.all([start(f, request), start(f, request)]);
    expect(duplicate.map(r => r.statusCode)).toEqual([202, 202]);
    expect((await start(f, request, "cloud_copy")).json().error.code).toBe("mode_request_conflict");
    expect((await start(f, randomUUID(), "cloud_copy")).json().error.code).toBe("mode_change_in_progress");
    const g = await fixture();
    const replies = await Promise.all([start(g), start(g)]);
    expect(replies.map(r => r.statusCode).sort()).toEqual([202, 409]);
    expect(await changes(f)).toHaveLength(1); expect(await changes(g)).toHaveLength(1);
  });

  it("uses the outbox batch ledger for status, never treating sending, parked or lost as completion", async () => {
    const f = await fixture(), request = randomUUID(); await start(f, request);
    // Synthetic ledger states test classification only, not policy/key readiness.
    const batch = (await db.query<{ id: string }>("INSERT INTO next_policy_batches(collection_id,seq,prev,item,issued_at,state) VALUES($1,2,$2,$3,2,'sending') RETURNING id", [f.collection, Buffer.alloc(32), Buffer.from("transition fixture")])).rows[0].id;
    const outbox = (await db.query<{ id: string }>("INSERT INTO next_policy_outbox(collection_id,ops,batch_id) VALUES($1,'{\"ops\":[]}', $2) RETURNING id", [f.collection, batch])).rows[0].id;
    await db.query("UPDATE next_collection_mode_changes SET policy_outbox_id=$2 WHERE collection_id=$1", [f.collection, outbox]);
    for (const state of ["sending", "parked", "appended"]) {
      await db.query("UPDATE next_policy_batches SET state=$2 WHERE id=$1", [batch, state]);
      expect((await get(f, request)).json().phase).toBe(state === "appended" ? "finishing" : "publishing_policy");
    }
    await db.query("UPDATE next_policy_batches SET lost_at=now() WHERE id=$1", [batch]);
    expect((await get(f, request)).json().phase).toBe("publishing_policy");
  });

  it("refuses non-owner and stale sessions on every read/retry", async () => {
    const f = await fixture(), foreign = await fixture(), request = randomUUID();
    expect((await start({ ...foreign, collection: f.collection }, request)).statusCode).toBe(404);
    expect((await start(f, request)).statusCode).toBe(202);
    expect((await get({ ...foreign, collection: f.collection }, request)).statusCode).toBe(404);
    await db.query("UPDATE sessions SET revoked_at=now() WHERE id=$1", [f.session]);
    expect((await start({ ...f, headers: f.browserHeaders }, request)).statusCode).toBe(401);
    await db.query("UPDATE next_policy_outbox SET ops=jsonb_set(ops,'{ops,1,role}','\"editor\"') WHERE collection_id=$1", [f.collection]);
    expect((await get(f, request)).statusCode).toBe(403);
    expect((await start(f, request)).statusCode).toBe(403);
  });

  it.each(["left", "deleted", "shadow"] as const)("refuses %s collections before intent and on retry/status", async state => {
    const f = await fixture(), request = randomUUID();
    await start(f, request);
    if (state === "left") await db.query("UPDATE next_collections SET left_sync_at=now() WHERE collection_id=$1", [f.collection]);
    if (state === "shadow") await db.query("UPDATE next_collections SET runtime='shadow' WHERE collection_id=$1", [f.collection]);
    if (state === "deleted") await db.query("INSERT INTO next_collection_deletion_facts(collection_id,deletion_id,lifecycle_epoch,authority) VALUES($1,$2,1,'cp-intent')", [f.collection, randomUUID()]);
    expect((await start(f, request)).statusCode).toBe(404);
    expect((await get(f, request)).statusCode).toBe(404);
    expect(await changes(f)).toHaveLength(1);
  });

  it("denies invalid bearer rather than downgrading to the ambient owner session", async () => {
    const f = await fixture();
    expect((await start({ ...f, headers: { ...f.browserHeaders, authorization: "Bearer not-a-device" } })).statusCode).toBe(401);
    expect(await changes(f)).toEqual([]);
  });

  it.each(["leave", "delete"] as const)("waits for an overlapping %s transaction and refuses its terminal state", async action => {
    const f = await fixture();
    const terminal = await db.connect();
    await terminal.query("BEGIN"); await lock(terminal, f.collection);
    if (action === "leave") await terminal.query("UPDATE next_collections SET left_sync_at=now() WHERE collection_id=$1", [f.collection]);
    else await recordCollectionDeletionIntent(terminal, f.collection, f.user);
    let attempted!: () => void;
    const reachedLock = new Promise<void>(resolve => { attempted = resolve; });
    const racedb: DatabasePool = { query: db.query.bind(db), end: db.end.bind(db), connect: async () => {
      const c = await db.connect(); return { release: () => c.release(), query: async <R extends pg.QueryResultRow>(sql: string, values?: unknown[]) => {
        if (sql.includes("pg_advisory_xact_lock")) attempted();
        return c.query<R>(sql, values);
      } };
    } };
    const race = await server(racedb);
    try {
      const reply = start(f, randomUUID(), "private", race).then(r => r);
      await reachedLock; await terminal.query("COMMIT");
      expect((await reply).statusCode).toBe(404);
      expect(await changes(f)).toEqual([]);
    } finally { await terminal.query("ROLLBACK"); terminal.release(); await race.close(); }
  });

  it("allows owner deletion after intent and never revives it on retry", async () => {
    const f = await fixture(), request = randomUUID(); await start(f, request);
    const deleted = await app.inject({ method: "DELETE", url: `/v1/next/collections/${f.collection}`, headers: f.headers, payload: { confirm_name: "Notes" } });
    expect(deleted.statusCode).toBe(200);
    expect((await get(f, request)).statusCode).toBe(404);
    expect((await start(f, request)).statusCode).toBe(404);
  });

  it("recovers active status without retaining the request identifier on this client", async () => {
    const f = await fixture();
    const read = () => app.inject({ method: "GET", url: `/v1/next/collections/${f.collection}/mode`, headers: f.browserHeaders });
    expect((await read()).json()).toEqual({ collection_id: f.collection, current_mode: "cloud_copy", change: null });
    const request = randomUUID(); await start(f, request);
    expect((await read()).json().change).toMatchObject({ request_id: request, phase: "waiting_for_device" });
  });

  it("does not accept a request for the current mode or malformed identifiers", async () => {
    const f = await fixture();
    expect((await start(f, randomUUID(), "cloud_copy")).json().error.code).toBe("mode_already_current");
    expect((await start(f, "not-a-uuid")).statusCode).toBe(400);
    expect((await get(f, randomUUID())).statusCode).toBe(404);
    expect(await changes(f)).toEqual([]);
  });
});
