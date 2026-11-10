import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deleteAccountLocally } from "../account/account-management.js";
import { createDatabase, type DatabasePool } from "../../db.js";
import { inTransaction } from "./bootstrap-common.js";
import { recordCollectionDeletionIntent } from "./collection-deletion.js";
import { activatePendingServices } from "./service-activation.js";

const testUrl = process.env.MDBASE_CONNECT_TEST_DATABASE_URL;
const approved = process.env.MDBASE_CONNECT_DESTRUCTIVE_TEST_APPROVAL === "I APPROVE MDBASE CONNECT DESTRUCTIVE POSTGRES TESTS";
const describePg = testUrl && approved ? describe : describe.skip;
const deployments = { hosted: { url: "https://hosted.test", token: "h".repeat(40) }, escrow: { url: "https://escrow.test", token: "e".repeat(40) } };

describePg("service activation persisted retries (dedicated local Postgres)", () => {
  let db: DatabasePool; let admin: pg.Pool; let schema: string;
  beforeAll(async () => {
    const url = new URL(testUrl!);
    if (!["localhost", "127.0.0.1", "::1"].includes(url.hostname) || !/test/i.test(url.pathname)) throw new Error("Dedicated local test Postgres required");
    schema = `service_activation_${randomUUID().replaceAll("-", "")}`;
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
  async function fixture(state = "appended") {
    const user = randomUUID(), collection = randomUUID();
    await db.query("INSERT INTO users(id,email,name) VALUES($1,$2,'Test')", [user, `${user}@example.test`]);
    await db.query("INSERT INTO next_collections(collection_id,owner_user_id,runtime,sync,root_key_id) VALUES($1,$2,'next','cloud_copy',$3)", [collection,user,Buffer.alloc(16)]);
    await db.query("INSERT INTO next_policy_batches(collection_id,seq,prev,item,issued_at,state) VALUES($1,1,$2,$3,1,$4)", [collection,Buffer.alloc(32),Buffer.from([1]),state]);
    for (const kind of ["hosted", "escrow"]) {
      await db.query(`INSERT INTO next_service_devices(collection_id,kind,device_id,sign_pk,kem_pk,noise_pk,wrapped_keys,kms_key_arn)
        VALUES($1,$2,$3,$4,$4,$4,$5,'arn:test:key')`, [collection,kind,randomUUID(),Buffer.alloc(32,1),Buffer.from([1])]);
    }
    return collection;
  }
  it("foreground scope bypasses an older unrelated catch-up queue", async () => {
    const backlog = await Promise.all([fixture(),fixture(),fixture()]);
    for (const id of backlog) await db.query("UPDATE next_service_devices SET activation_next_at=now()-interval '1 day' WHERE collection_id=$1",[id]);
    const target=await fixture();
    const sent:string[]=[];
    await activatePendingServices(db,deployments,async (_url,init)=> {
      sent.push(JSON.parse(String(init?.body)).collection as string);return Response.json({activated:true});
    },target);
    expect(sent).toEqual([target,target]);
    expect((await db.query("SELECT 1 FROM next_service_devices WHERE collection_id=$1 AND activation_batch_id>0",[target])).rows).toHaveLength(2);
    for (const id of backlog) expect((await db.query("SELECT 1 FROM next_service_devices WHERE collection_id=$1 AND activation_batch_id=0",[id])).rows).toHaveLength(2);
    // Keep independent test fixtures quiet after proving the exact scope.
    for (const id of backlog) await activatePendingServices(db,deployments,async()=>Response.json({activated:true}),id);
  });
  it("only activates after appended genesis and acknowledges each role once", async () => {
    const collection = await fixture("sending"); let calls = 0;
    const fetcher: typeof fetch = async () => { calls++; return Response.json({ activated: true }); };
    await activatePendingServices(db,deployments,fetcher); expect(calls).toBe(0);
    await db.query("UPDATE next_policy_batches SET state='appended' WHERE collection_id=$1", [collection]);
    await activatePendingServices(db,deployments,fetcher); expect(calls).toBe(2);
    expect((await db.query("SELECT 1 FROM next_service_devices WHERE collection_id=$1 AND activated_at IS NOT NULL", [collection])).rows).toHaveLength(2);
    await activatePendingServices(db,deployments,fetcher); expect(calls).toBe(2);
  });
  it("unknown outcome persists backoff across a new poll and retries only unacknowledged role", async () => {
    const collection = await fixture(); const seen: string[] = [];
    const fetcher: typeof fetch = async (input) => {
      const kind = new URL(String(input)).hostname; seen.push(kind);
      if (kind === "escrow.test") throw new Error("network outcome unknown");
      return Response.json({ activated: true });
    };
    await activatePendingServices(db,deployments,fetcher);
    const retry = (await db.query<{ activation_attempts: number; future: boolean; pending: boolean }>(
      "SELECT activation_attempts,activation_next_at > now() AS future,activated_at IS NULL AS pending FROM next_service_devices WHERE collection_id=$1 AND kind='escrow'", [collection])).rows[0]!;
    expect(retry).toEqual({ activation_attempts: 1, future: true, pending: true });
    await activatePendingServices(db,deployments,async () => { throw new Error("not due yet"); });
    await db.query("UPDATE next_service_devices SET activation_next_at=now()-interval '1 second' WHERE collection_id=$1", [collection]);
    const resumed: string[] = [];
    await activatePendingServices(db,deployments,async (input) => { resumed.push(new URL(String(input)).hostname); return Response.json({ activated: true }); });
    expect(resumed).toEqual(["escrow.test"]);
    expect(seen.sort()).toEqual(["escrow.test", "hosted.test"]);
  });
  async function batch(collection: string, seq: number, state = "appended") {
    return (await db.query<{ id: string }>(`INSERT INTO next_policy_batches(collection_id,seq,prev,item,issued_at,state)
      VALUES($1,$2,$3,$4,$2,$5) RETURNING id::text`, [collection,seq,Buffer.alloc(32),Buffer.from([2]),state])).rows[0]!.id;
  }
  it("wakes on committed enrolment and on a repaired batch at a reused log position", async () => {
    const collection = await fixture(); let calls = 0;
    const fetcher: typeof fetch = async () => { calls++; return Response.json({ activated: true }); };
    await activatePendingServices(db,deployments,fetcher); expect(calls).toBe(2);
    const pending = await batch(collection,3,"sending");
    await activatePendingServices(db,deployments,fetcher); expect(calls).toBe(2);
    await db.query("UPDATE next_policy_batches SET state='appended' WHERE id=$1", [pending]);
    await activatePendingServices(db,deployments,fetcher); expect(calls).toBe(4);
    await db.query("UPDATE next_policy_batches SET lost_at=now() WHERE id=$1", [pending]);
    await batch(collection,3);
    await activatePendingServices(db,deployments,fetcher); expect(calls).toBe(6);
    await activatePendingServices(db,deployments,fetcher); expect(calls).toBe(6);
  });
  it("legacy one-time acknowledgments catch up to a captured batch once", async () => {
    const collection = await fixture();
    await db.query("UPDATE next_service_devices SET activated_at=now() WHERE collection_id=$1",[collection]);
    await batch(collection,3); let calls=0;
    const fetcher: typeof fetch = async () => { calls++; return Response.json({activated:true}); };
    await activatePendingServices(db,deployments,fetcher); expect(calls).toBe(2);
    await activatePendingServices(db,deployments,fetcher); expect(calls).toBe(2);
  });
  it("a new committed batch bypasses previous-generation backoff", async () => {
    const collection = await fixture();
    await activatePendingServices(db,deployments,async () => new Response(null,{status:503}));
    await db.query("UPDATE next_service_devices SET activation_next_at=now()+interval '5 minutes' WHERE collection_id=$1", [collection]);
    const id = await batch(collection,3);
    let calls = 0;
    await activatePendingServices(db,deployments,async () => { calls++; return Response.json({ activated: true }); });
    expect(calls).toBe(2);
    expect((await db.query<{ ack: string; activation_attempts: number }>(
      "SELECT activation_batch_id::text AS ack,activation_attempts FROM next_service_devices WHERE collection_id=$1", [collection])).rows)
      .toEqual([{ack:id,activation_attempts:0},{ack:id,activation_attempts:0}]);
  });
  it.each([true,false])("an old HTTP completion (%s) cannot acknowledge or back off a newer batch", async (ok) => {
    const collection = await fixture();
    let release!: () => void; let entered!: () => void; let calls = 0;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const old = activatePendingServices(db,deployments,async () => {
      if (++calls===2) entered();
      await gate;
      return ok ? Response.json({activated:true}) : new Response(null,{status:503});
    });
    await ready;
    const id = await batch(collection,3);
    await activatePendingServices(db,deployments,async () => Response.json({ activated: true }));
    release(); await old;
    expect((await db.query<{ ack: string; attempt: string; activation_attempts: number }>(
      "SELECT activation_batch_id::text AS ack,activation_attempt_batch_id::text AS attempt,activation_attempts FROM next_service_devices WHERE collection_id=$1", [collection])).rows)
      .toEqual([{ack:id,attempt:id,activation_attempts:0},{ack:id,attempt:id,activation_attempts:0}]);
  });
  describe("retire wakes", () => {
    const gone: typeof fetch = async () => Response.json({ error: "custody_collection_gone" }, { status: 409 });
    const owner = async (collection: string) => (await db.query<{ owner: string }>(
      "SELECT owner_user_id::text AS owner FROM next_collections WHERE collection_id=$1", [collection])).rows[0]!.owner;
    const wakes = async (collection: string) => (await db.query<{ kind: string; attempts: number; due: boolean }>(
      "SELECT kind,attempts,next_at <= now() AS due FROM next_service_retire_wakes WHERE collection_id=$1 ORDER BY kind", [collection])).rows;
    /** A cloud copy whose services are activated and idle: nothing pending. */
    async function activated() {
      const collection = await fixture();
      await activatePendingServices(db, deployments, async () => Response.json({ activated: true }), collection);
      return collection;
    }
    /** Every wake request the poll sends for `collection`, by deployment host. */
    async function poll(collection: string, reply: typeof fetch = gone) {
      const sent: Array<{ host: string; body: unknown }> = [];
      await activatePendingServices(db, deployments, async (input, init) => {
        const body = JSON.parse(String(init?.body)) as { collection: string };
        if (body.collection === collection) sent.push({ host: new URL(String(input)).hostname, body });
        return reply(input, init);
      }, collection);
      return sent.sort((a, b) => a.host.localeCompare(b.host));
    }
    const both = (collection: string) => [
      { host: "escrow.test", body: { collection } }, { host: "hosted.test", body: { collection } }];

    it("collection deletion wakes both service copies until they answer with their verdict", async () => {
      const collection = await activated();
      expect(await poll(collection)).toEqual([]);
      await inTransaction(db, async (client) => { await recordCollectionDeletionIntent(client, collection, await owner(collection)); });
      expect(await wakes(collection)).toEqual([{ kind: "escrow", attempts: 0, due: true }, { kind: "hosted", attempts: 0, due: true }]);
      expect(await poll(collection)).toEqual(both(collection));
      expect(await wakes(collection)).toEqual([]);
      expect(await poll(collection)).toEqual([]);
    });
    it("leaving cloud copy (switch to Private) wakes both service copies", async () => {
      const collection = await activated();
      // The switch's final commit (collection-mode-execution.ts, and its abandonment).
      await inTransaction(db, async (client) => {
        await client.query("DELETE FROM next_service_devices WHERE collection_id=$1", [collection]);
        await client.query("UPDATE next_collections SET sync='private' WHERE collection_id=$1", [collection]);
      });
      expect(await poll(collection)).toEqual(both(collection));
      expect(await wakes(collection)).toEqual([]);
    });
    it("account deletion wakes the owner's service copies after their rows cascade away", async () => {
      const collection = await activated();
      await deleteAccountLocally(db, { userId: await owner(collection), sessionId: randomUUID(), authorized: true, queueProviderCleanup: false });
      expect((await db.query("SELECT 1 FROM next_service_devices WHERE collection_id=$1", [collection])).rows).toHaveLength(0);
      expect(await poll(collection)).toEqual(both(collection));
      expect(await wakes(collection)).toEqual([]);
    });
    it("an unknown outcome retries on the activation backoff until a definite answer", async () => {
      const collection = await activated();
      await inTransaction(db, async (client) => { await recordCollectionDeletionIntent(client, collection, await owner(collection)); });
      expect(await poll(collection, async () => { throw new Error("network outcome unknown"); })).toEqual(both(collection));
      expect(await wakes(collection)).toEqual([{ kind: "escrow", attempts: 1, due: false }, { kind: "hosted", attempts: 1, due: false }]);
      const delays = (await db.query<{ seconds: number }>(
        "SELECT round(extract(epoch FROM next_at - now()))::int AS seconds FROM next_service_retire_wakes WHERE collection_id=$1", [collection])).rows;
      expect(delays.every(({ seconds }) => seconds >= 1 && seconds <= 2)).toBe(true);
      expect(await poll(collection)).toEqual([]); // not due yet
      await db.query("UPDATE next_service_retire_wakes SET next_at=now()-interval '1 second' WHERE collection_id=$1", [collection]);
      expect(await poll(collection, async () => new Response(null, { status: 503 }))).toEqual(both(collection));
      expect((await wakes(collection)).map(({ attempts }) => attempts)).toEqual([2, 2]);
      await db.query("UPDATE next_service_retire_wakes SET next_at=now()-interval '1 second' WHERE collection_id=$1", [collection]);
      expect(await poll(collection)).toEqual(both(collection));
      expect(await wakes(collection)).toEqual([]);
    });
    it("an answer to an earlier wake cannot clear a wake queued again while it was in flight", async () => {
      const collection = await activated();
      await inTransaction(db, async (client) => { await recordCollectionDeletionIntent(client, collection, await owner(collection)); });
      let release!: () => void; let entered!: () => void; let calls = 0;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const ready = new Promise<void>((resolve) => { entered = resolve; });
      const old = poll(collection, async (input, init) => { if (++calls === 2) entered(); await gate; return gone(input, init); });
      await ready;
      await db.query("DELETE FROM next_service_devices WHERE collection_id=$1", [collection]);
      release(); await old;
      expect(await wakes(collection)).toEqual([{ kind: "escrow", attempts: 0, due: true }, { kind: "hosted", attempts: 0, due: true }]);
      expect(await poll(collection)).toEqual(both(collection));
      expect(await wakes(collection)).toEqual([]);
    });
    it("a wake queued over 24 hours ago is dropped unsent, whatever its outcome so far", async () => {
      const collection = await activated();
      await inTransaction(db, async (client) => { await recordCollectionDeletionIntent(client, collection, await owner(collection)); });
      await db.query("UPDATE next_service_retire_wakes SET queued_at=now()-interval '25 hours', attempts=9 WHERE collection_id=$1 AND kind='hosted'", [collection]);
      expect(await poll(collection)).toEqual([{ host: "escrow.test", body: { collection } }]);
      expect(await wakes(collection)).toEqual([]);
    });
    it("one call sends at most 20 retire wakes; the rest follow on the next call", async () => {
      const limit = 20; // RETIRE_LIMIT
      await db.query("DELETE FROM next_service_retire_wakes");
      const collections = await Promise.all(Array.from({ length: limit / 2 + 1 }, () => activated()));
      for (const collection of collections) {
        await inTransaction(db, async (client) => { await recordCollectionDeletionIntent(client, collection, await owner(collection)); });
      }
      const drain = async () => {
        let sent = 0;
        await activatePendingServices(db, deployments, async (input, init) => {
          if (collections.includes((JSON.parse(String(init?.body)) as { collection: string }).collection)) sent += 1;
          return gone(input, init);
        });
        return sent;
      };
      expect(await drain()).toBe(limit);
      expect((await db.query("SELECT 1 FROM next_service_retire_wakes")).rows).toHaveLength(2);
      expect(await drain()).toBe(2);
      expect((await db.query("SELECT 1 FROM next_service_retire_wakes")).rows).toHaveLength(0);
    });
  });
  it("left-sync and lost-genesis rows never activate", async () => {
    const left = await fixture(), lost = await fixture();
    await db.query("UPDATE next_collections SET left_sync_at=now() WHERE collection_id=$1", [left]);
    await db.query("UPDATE next_policy_batches SET lost_at=now() WHERE collection_id=$1", [lost]);
    let calls = 0;
    await activatePendingServices(db,deployments,async () => { calls++; return Response.json({ activated: true }); });
    expect(calls).toBe(0);
  });
});
