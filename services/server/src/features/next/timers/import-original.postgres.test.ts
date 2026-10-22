import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, type DatabasePool } from "../../../db.js";
import { legacyTimerGrantResolver } from "./grants.js";
import { cancelTimer, eraseTimerData, importTimer, putTimer, reconcileTimers } from "./store.js";
import { registerNextCollection } from "../policy-outbox.js";
import { timerEventId, TimerWorker } from "./worker.js";
import { validateTimerImport } from "./import-original.js";

const testUrl = process.env.MDBASE_CONNECT_TEST_DATABASE_URL;
const approved = process.env.MDBASE_CONNECT_DESTRUCTIVE_TEST_APPROVAL ===
  "I APPROVE MDBASE CONNECT DESTRUCTIVE POSTGRES TESTS";
const suite = testUrl && approved ? describe : describe.skip;
const schema = `timer_import_test_${randomUUID().replaceAll("-", "")}`;
let admin: pg.Pool;
let db: DatabasePool;

suite("original timer import on isolated PostgreSQL", () => {
  beforeAll(async () => {
    const url = new URL(testUrl!);
    if (!["localhost", "127.0.0.1", "::1"].includes(url.hostname) || !/test/i.test(url.pathname)) {
      throw new Error("Timer import tests require a dedicated local test database.");
    }
    admin = new pg.Pool({ connectionString: url.toString() });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    url.searchParams.set("options", `-csearch_path=${schema}`);
    url.searchParams.set("application_name", schema);
    db = await createDatabase(url.toString());
  }, 60_000);
  afterAll(async () => {
    await db?.end();
    if (admin) await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin?.end();
  });
  async function fixture(hosted = false) {
    const [user, connector, collection, application, grantId] = Array.from({ length: 5 }, () => randomUUID());
    await db.query("INSERT INTO users(id,email,name) VALUES($1,$2,'User')", [user, `${user}@example.test`]);
    await db.query("INSERT INTO connectors(id,user_id,name,token_hash) VALUES($1,$2,'Test',$3)", [connector, user, randomUUID()]);
    await db.query("INSERT INTO collections(id,user_id,connector_id,local_id,display_name,spec_version,enabled) VALUES($1,$2,$3,$4,'Test','0.3.0',true)", [collection, user, connector, randomUUID()]);
    await db.query("INSERT INTO applications(id,canonical_identity,manifest_version,name,homepage,redirect_uris) VALUES($1,$2,1,'Test','https://app.example.test','[]'::jsonb)", [application, `bundle:test:${application}`]);
    await db.query(`INSERT INTO grants(id,user_id,application_id,collection_id,operations,scope,application_origin,application_authorization,application_installation_id)
      VALUES($1,$2,$3,$4,'["reconcile_timers"]'::jsonb,'{"contracts":[]}'::jsonb,'https://app.example.test','{"binding":{"protocol_version":4}}'::jsonb,$5)`, [grantId, user, application, collection, randomUUID()]);
    if (hosted) {
      await db.query("INSERT INTO hosted_collections(id,user_id,display_name,template,provider_url,authority_state) VALUES($1,$2,'Synthetic original','mdbase','https://provider.example','active')", [collection,user]);
      await db.query("UPDATE grants SET collection_id=NULL,hosted_collection_id=$2 WHERE id=$1", [grantId,collection]);
      await registerNextCollection(db, { collectionId: collection, ownerUserId: user, runtime: "shadow", sync: "cloud_copy", rootKeyId: Buffer.alloc(16,17), ops: [{ op: "genesis", owner: user, root: Buffer.alloc(16,17), state: "cloud-copy" }, { op: "member-set", account: user, role: "owner" }] });
    }
    const grant = await legacyTimerGrantResolver.resolve(db, grantId);
    if (!grant) throw new Error("Fixture grant missing");
    const timer = {
      grant_id: grantId, namespace: "notifications", id: randomUUID(), criterion_id: "task.reminder",
      fire_at: "2030-01-01T00:00:00.000Z", data: null,
      generation: "7", status: "scheduled", created_at: "2020-01-01T00:00:00.000Z",
      updated_at: "2020-01-02T00:00:00.000Z", fired_at: null
    };
    const runtime_namespace = `connect-hosted:${collection}:notifications`;
    const runtime_id = `scoped:${timer.id}`;
    const record = {
      id: runtime_id, generation: 7, status: timer.status, fire_at: timer.fire_at,
      created_at: timer.created_at, updated_at: timer.updated_at, fired_at: timer.fired_at,
      event_contract: { id: "io.mdbase.timer.fired", version: "1.0.0", digest: "sha256:example" },
      event_source: { application: "connect", implementation: "notifications", version: "1.0.0" },
      source_uri: "urn:test:timer", subject: null,
      data: { grant_id: grantId, criterion_id: timer.criterion_id, namespace: timer.namespace, timer_id: timer.id, data: timer.data }
    };
    return { grant, collection, record, timer: { ...timer, runtime_namespace, runtime_id, record_json: JSON.stringify(record) } };
  }
  async function transaction<T>(body: (connection: Awaited<ReturnType<DatabasePool["connect"]>>) => Promise<T>): Promise<T> {
    const connection = await db.connect();
    try {
      await connection.query("BEGIN");
      const result = await body(connection);
      await connection.query("COMMIT");
      return result;
    } catch (error) {
      await connection.query("ROLLBACK");
      throw error;
    } finally { connection.release(); }
  }
  it("does not cancel, fire, receipt or prune imported timers on repeated preflip wakes", async () => {
    const { grant, timer, record } = await fixture(true);
    const fire_at = "2020-01-03T00:00:00.000Z";
    const input = { ...timer, fire_at, record_json: JSON.stringify({ ...record, fire_at }) };
    await transaction(connection => importTimer(connection, grant, input));
    await db.query("UPDATE grants SET revoked_at=now() WHERE id=$1", [grant.grantId]);
    const eventId = timerEventId(grant.grantId,timer.namespace,timer.id,6);
    await db.query(`INSERT INTO next_timer_events(event_id,grant_id,criterion_id,namespace,timer_id,generation,scheduled_for,fired_at,late_by_ms,created_at)
      VALUES($1,$2,$3,$4,$5,6,$6,$6,0,'2020-01-03')`, [eventId,grant.grantId,timer.criterion_id,timer.namespace,timer.id,fire_at]);
    let handled = 0;
    const worker = new TimerWorker(db,[{ name: "test", async handle() { handled++; } }]);
    await worker.tick(); await worker.tick();
    expect(handled).toBe(0);
    expect((await db.query("SELECT status,generation,legacy_import_origin FROM next_timers WHERE grant_id=$1", [grant.grantId])).rows).toEqual([expect.objectContaining({ status:"scheduled",generation:"7",legacy_import_origin:validateTimerImport(input).origin })]);
    expect((await db.query("SELECT event_id FROM next_timer_events WHERE grant_id=$1", [grant.grantId])).rows).toEqual([{event_id:eventId}]);
    expect((await db.query("SELECT event_id FROM next_timer_event_receipts WHERE event_id=$1", [eventId])).rows).toHaveLength(0);
  });
  it("refuses API intents and omission cancellations before original account completion", async () => {
    const { grant, timer } = await fixture(true);
    await transaction(connection => importTimer(connection, grant, timer));
    const intents = (await db.query("SELECT * FROM next_timer_namespace_intents WHERE grant_id=$1", [grant.grantId])).rows;
    await expect(transaction(connection => cancelTimer(connection,grant,timer.namespace,timer.id))).rejects.toMatchObject({code:"collection_migrating"});
    await expect(transaction(connection => reconcileTimers(connection,grant,timer.namespace,timer.criterion_id,[]))).rejects.toMatchObject({code:"collection_migrating"});
    await expect(transaction(connection => putTimer(connection,grant,timer.namespace,timer.criterion_id,{id:timer.id,fireAt:new Date(timer.fire_at),data:null}))).rejects.toMatchObject({code:"collection_migrating"});
    expect((await db.query("SELECT * FROM next_timer_namespace_intents WHERE grant_id=$1", [grant.grantId])).rows).toEqual(intents);
    expect((await db.query("SELECT status FROM next_timers WHERE grant_id=$1", [grant.grantId])).rows[0].status).toBe("scheduled");
  });
  it("refuses an old imported terminal row's immediate preflip pruning", async () => {
    const { grant, timer, record } = await fixture(true);
    const input = { ...timer, status:"cancelled", record_json:JSON.stringify({...record,status:"cancelled"}) };
    await transaction(connection => importTimer(connection,grant,input));
    await new TimerWorker(db,[]).prune();
    expect((await db.query("SELECT status FROM next_timers WHERE grant_id=$1", [grant.grantId])).rows).toEqual([{status:"cancelled"}]);
  });
  it("refuses an over-cap origin with a typed error before any target row", async () => {
    const { grant, timer } = await fixture();
    await expect(transaction((connection) => importTimer(connection, grant, { ...timer, runtime_namespace: "x".repeat(2048) }))).rejects.toMatchObject({ statusCode: 409, code: "timer_import_invalid" });
    expect((await db.query("SELECT count(*)::int AS count FROM next_timers WHERE grant_id=$1", [grant.grantId])).rows[0].count).toBe(0);
  });
  it.each(["雪", "\\\"\n"])("reserves the actual JSONB erasure budget for %s metadata", async (unit) => {
    const { grant, collection, timer, record } = await fixture();
    const input = (length: number) => {
      const runtime_id = unit.repeat(length);
      return { ...timer, runtime_id, record_json: JSON.stringify({ ...record, id: runtime_id }) };
    };
    let low = 1;
    let high = 4096;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      try { validateTimerImport(input(mid)); low = mid; }
      catch (error) {
        expect(error).toMatchObject({ statusCode: 409, code: "timer_import_invalid" });
        high = mid - 1;
      }
    }
    const accepted = input(low);
    const origin = validateTimerImport(accepted).origin;
    await transaction((connection) => importTimer(connection, grant, accepted));
    const row = (await db.query(`SELECT legacy_import_origin,
      octet_length((legacy_import_origin || '{"data_erased":true}'::jsonb)::text) AS erased_bytes
      FROM next_timers WHERE grant_id=$1`, [grant.grantId])).rows[0];
    expect(row.legacy_import_origin).toEqual(origin);
    expect(row.erased_bytes).toBeLessThanOrEqual(2048);
    expect(row.erased_bytes).toBeGreaterThan(2038);
    expect(() => validateTimerImport(input(low + 1))).toThrow();
    await transaction((connection) => eraseTimerData(connection, collection));
    const erased = (await db.query("SELECT data,legacy_import_origin FROM next_timers WHERE grant_id=$1", [grant.grantId])).rows[0];
    expect(erased.data).toBeNull();
    expect(erased.legacy_import_origin.data_erased).toBe(true);
    expect(erased.legacy_import_origin.record_sha256).toBe(origin.record_sha256);
  });
  it("does not reset original generation or creation/update times", async () => {
    const { grant, timer } = await fixture();
    await transaction((connection) => importTimer(connection, grant, timer));
    const row = (await db.query("SELECT generation,status,created_at,updated_at FROM next_timers WHERE grant_id=$1 AND namespace=$2 AND timer_id=$3", [grant.grantId, timer.namespace, timer.id])).rows[0];
    expect(String(row.generation)).toBe(timer.generation);
    expect(row.status).toBe(timer.status);
    expect(new Date(row.created_at).toISOString()).toBe(timer.created_at);
    expect(new Date(row.updated_at).toISOString()).toBe(timer.updated_at);
  });
  it("rejects a conflicting existing timer rather than treating it as imported", async () => {
    const { grant, timer, record } = await fixture();
    await transaction((connection) => importTimer(connection, grant, timer));
    const fire_at = "2030-01-02T00:00:00.000Z";
    await expect(transaction((connection) => importTimer(connection, grant, {
      ...timer, fire_at, record_json: JSON.stringify({ ...record, fire_at })
    }))).rejects.toMatchObject({ code: "timer_import_conflict" });
  });
  it("accepts only an identical re-import and never restores erased origins", async () => {
    const { grant, collection, timer } = await fixture();
    expect(await transaction((connection) => importTimer(connection, grant, timer))).toBe(true);
    expect(await transaction((connection) => importTimer(connection, grant, timer))).toBe(false);
    await transaction((connection) => eraseTimerData(connection, collection));
    await expect(transaction((connection) => importTimer(connection, grant, timer))).rejects.toMatchObject({ code: "timer_import_conflict" });
  });
  it("stores floored scheduled/fired nanoseconds and original timestamp metadata without firing", async () => {
    for (const status of ["scheduled", "fired"] as const) {
      const { grant, timer, record } = await fixture();
      const fire_at = "2030-01-01T00:00:00.123456789Z";
      const fired_at = status === "fired" ? "2030-01-01T00:00:01.999999999Z" : null;
      const updated_at = status === "fired" ? fired_at! : timer.updated_at;
      const imported = { ...timer, status, fire_at, fired_at, updated_at,
        record_json: JSON.stringify({ ...record, status, fire_at, fired_at, updated_at }) };
      await transaction((connection) => importTimer(connection, grant, imported));
      const row = (await db.query(`SELECT status, generation, legacy_import_origin,
        to_char(fire_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS fire,
        to_char(fired_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS fired
        FROM next_timers WHERE grant_id=$1 AND namespace=$2 AND timer_id=$3`, [grant.grantId, timer.namespace, timer.id])).rows[0];
      expect(row.status).toBe(status);
      expect(String(row.generation)).toBe("7");
      expect(row.fire).toBe("2030-01-01T00:00:00.123456Z");
      expect(row.fired).toBe(status === "fired" ? "2030-01-01T00:00:01.999999Z" : null);
      expect(row.legacy_import_origin.exact_timestamps.fire_at).toBe(fire_at);
      if (fired_at) expect(row.legacy_import_origin.exact_timestamps.fired_at).toBe(fired_at);
      expect(row.legacy_import_origin).not.toHaveProperty("data");
      expect(await transaction((connection) => importTimer(connection, grant, imported))).toBe(false);
      expect((await db.query("SELECT count(*) AS count FROM next_timer_events WHERE grant_id=$1", [grant.grantId])).rows[0].count).toBe("0");
    }
  });
});
