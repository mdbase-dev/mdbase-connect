import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import Fastify from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, type DatabasePool } from "../../db.js";
import { registerErrorHandler } from "../../platform/error-handler.js";
import { renameHostedCollectionForUser } from "../hosted/service.js";
import type { HostedProviderClient } from "../../hosted-provider.js";
import { tokenHash } from "../../security.js";
import { inTransaction } from "./bootstrap-common.js";
import { registerCollectionNameRoutes } from "./collection-name-routes.js";
import { installationCollections } from "./installation-scope.js";
import { queueNextPolicy, registerNextCollection } from "./policy-outbox.js";
import { localGrantFixture } from "./next-fixtures.test-helper.js";
import { registerNextRouteRoutes } from "./route-routes.js";
import { issueApplicationTokens } from "../authorizations/token-service.js";

const testUrl = process.env.MDBASE_CONNECT_TEST_DATABASE_URL;
const approved = process.env.MDBASE_CONNECT_DESTRUCTIVE_TEST_APPROVAL === "I APPROVE MDBASE CONNECT DESTRUCTIVE POSTGRES TESTS";
const describePg = testUrl && approved ? describe : describe.skip;

describePg.each(["cloud_copy", "private"] as const)("%s catalog rename", sync => {
  let db: DatabasePool;
  let admin: pg.Pool;
  let schema: string;
  const app = Fastify();
  const keys = { sign_pk: Buffer.alloc(32, 1), kem_pk: Buffer.alloc(32, 2), noise_pk: Buffer.alloc(32, 3) };
  beforeAll(async () => {
    const url = new URL(testUrl!);
    if (!["localhost", "127.0.0.1", "::1"].includes(url.hostname) || !/test/i.test(url.pathname)) throw new Error("Requires dedicated local test Postgres.");
    schema = `collection_names_${randomUUID().replaceAll("-", "")}`;
    admin = new pg.Pool({ connectionString: url.toString(), max: 2 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    url.searchParams.set("options", `-csearch_path=${schema}`);
    db = await createDatabase(url.toString());
    registerErrorHandler(app);
    registerCollectionNameRoutes(app, db);
    registerNextRouteRoutes(app,{db,publicUrl:"https://connect.test",broker:{request:async () => {throw new Error("Catalog reads must not contact a relay.");}}});
  }, 60_000);
  afterAll(async () => {
    await app.close(); await db?.end();
    if (admin && schema) await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin?.end();
  });
  async function fixture(installation = false, collectionSync: "cloud_copy" | "private" = sync) {
    const user = randomUUID(), connector = randomUUID(), device = randomUUID(), collection = randomUUID();
    const credential = `fixture_${randomUUID()}`;
    const kind = installation ? "app-runtime" as const : "desktop" as const;
    await db.query("INSERT INTO users(id,email,name,account_backend) VALUES($1,$2,'Fixture owner','next')", [user, `${user}@example.test`]);
    await db.query("INSERT INTO connectors(id,user_id,name,token_hash) VALUES($1,$2,'Fixture connector',$3)", [connector, user, tokenHash(installation ? `unused_${randomUUID()}` : credential)]);
    await db.query("INSERT INTO next_devices(id,connector_id,user_id,kind,sign_pk,kem_pk,noise_pk) VALUES($1,$2,$3,$4,$5,$6,$7)", [device, connector, user, kind, keys.sign_pk, keys.kem_pk, keys.noise_pk]);
    await inTransaction(db, client => registerNextCollection(client, {
      collectionId: collection, ownerUserId: user, runtime: "next", sync: collectionSync, rootKeyId: Buffer.alloc(32), displayName: "Initial label",
      ops: [{ op: "genesis", owner: user, root: Buffer.alloc(32), state: collectionSync === "cloud_copy" ? "cloud-copy" : "e2e" },
        { op: "member-set", account: user, role: "owner" },
        { op: "device-enrol", device, account: user, kind, signPublicKey: keys.sign_pk, kemPublicKey: keys.kem_pk, noisePublicKey: keys.noise_pk }]
    }));
    const batch = (await db.query<{id:string}>("INSERT INTO next_policy_batches(collection_id,seq,prev,item,issued_at,state,appended_at) VALUES($1,1,$2,$3,1,'appended',now()) RETURNING id", [collection, Buffer.alloc(32), Buffer.from("fixture item")])).rows[0].id;
    await db.query("UPDATE next_policy_outbox SET batch_id=$2 WHERE collection_id=$1", [collection, batch]);
    if (installation) {
      await db.query(`INSERT INTO installation_device_credentials(pairing_id,connector_id,device_id,installation_id,app_id,app_origin,kind,sign_pk,kem_pk,noise_pk,token_hash)
        VALUES($1,$2,$3,$4,'tasknotes-web','https://app.tasknotes.dev','app-runtime',$5,$6,$7,$8)`, [randomUUID(), connector, device, randomUUID(), keys.sign_pk, keys.kem_pk, keys.noise_pk, tokenHash(credential)]);
      await db.query("INSERT INTO installation_collection_scopes(connector_id,collection_id) VALUES($1,$2)", [connector, collection]);
    }
    return { user, connector, device, collection, batch, headers: { authorization: `Bearer ${credential}` } };
  }
  const rename = (f: Awaited<ReturnType<typeof fixture>>, display_name = "Updated label") => app.inject({ method: "PATCH", url: `/v1/next/collections/${f.collection}/name`, headers: f.headers, payload: { display_name } });
  const name = async (collection: string) => (await db.query<{display_name:string|null}>("SELECT display_name FROM next_collections WHERE collection_id=$1", [collection])).rows[0].display_name;

  it("backfills exact same-owner legacy labels, including private and suspended rows", async () => {
    const owner = await fixture(), foreign = await fixture();
    const hosted = randomUUID(), local = randomUUID(), fresh = randomUUID(), privateOld = randomUUID(), privateFresh = randomUUID();
    for (const [collection, sync] of [[hosted,"cloud_copy"],[local,"cloud_copy"],[fresh,"cloud_copy"],[privateOld,"private"],[privateFresh,"private"]]) {
      await db.query("INSERT INTO next_collections(collection_id,owner_user_id,runtime,sync,root_key_id) VALUES($1,$2,'next',$3,$4)", [collection,owner.user,sync,Buffer.alloc(32)]);
    }
    const legacyTitle = "  Héritage\t  ";
    await db.query("INSERT INTO hosted_collections(id,user_id,display_name,template) VALUES($1,$2,$3,'fixture')", [hosted,owner.user,legacyTitle]);
    await db.query("INSERT INTO hosted_collections(id,user_id,display_name,template) VALUES($1,$2,'Private legacy','fixture')", [privateOld,owner.user]);
    await db.query("INSERT INTO hosted_collections(id,user_id,display_name,template) VALUES($1,$2,'Foreign label','fixture')", [local,foreign.user]);
    const addLocal = async (id:string,user:string,title:string,removed=false) => {
      const connector = randomUUID();
      await db.query("INSERT INTO connectors(id,user_id,name,token_hash) VALUES($1,$2,'Legacy fixture',$3)", [connector,user,`fixture_${connector}`]);
      await db.query("INSERT INTO collections(id,user_id,connector_id,local_id,display_name,spec_version,removed_at,authority_state) VALUES($1,$2,$3,$4,$5,'0.3.0',$6,'retired')", [id,user,connector,local,title,removed?new Date():null]);
    };
    await addLocal("10000000-0000-4000-8000-000000000001",foreign.user,"Foreign local");
    await addLocal("10000000-0000-4000-8000-000000000002",owner.user,"Removed local",true);
    await addLocal("10000000-0000-4000-8000-000000000003",owner.user,"First local");
    await addLocal("10000000-0000-4000-8000-000000000004",owner.user,"Later local");
    await db.query("UPDATE users SET suspended_at=now() WHERE id=$1", [owner.user]);
    const before = (await db.query("SELECT collection_id,owner_user_id,runtime,sync,root_key_id FROM next_collections ORDER BY collection_id")).rows;
    await db.query("ALTER TABLE next_collections DROP COLUMN display_name");
    await db.query(await readFile(new URL("../../../migrations/0064_next_collection_display_name.sql",import.meta.url),"utf8"));
    expect((await db.query("SELECT collection_id,owner_user_id,runtime,sync,root_key_id FROM next_collections ORDER BY collection_id")).rows).toEqual(before);
    expect(await name(hosted)).toBe(legacyTitle);
    expect(await name(local)).toBe("First local");
    expect(await name(fresh)).toBe("New collection");
    expect(await name(privateOld)).toBe("Private legacy");
    expect(await name(privateFresh)).toBeNull();
    expect((await db.query("SELECT display_name FROM hosted_collections WHERE id=$1", [hosted])).rows[0].display_name).toBe(legacyTitle);
    expect((await db.query("SELECT suspended_at IS NOT NULL AS suspended FROM users WHERE id=$1", [owner.user])).rows[0].suspended).toBe(true);
  });

  it.each(sync === "cloud_copy" ? [false, true] : [false])("lets the current %s owner rename only catalog metadata", async installation => {
    const f = await fixture(installation);
    const before = (await db.query("SELECT * FROM next_collections WHERE collection_id=$1", [f.collection])).rows[0];
    const policies = (await db.query("SELECT * FROM next_policy_outbox WHERE collection_id=$1 ORDER BY id", [f.collection])).rows;
    const reply = await rename(f, "  Renamed 📚  ");
    expect(reply.statusCode).toBe(200);
    expect(reply.headers["cache-control"]).toBe("no-store");
    expect(reply.json()).toEqual({ collection_id: f.collection, display_name: "Renamed 📚" });
    const after = (await db.query("SELECT * FROM next_collections WHERE collection_id=$1", [f.collection])).rows[0];
    expect(after).toEqual({ ...before, display_name: "Renamed 📚" });
    expect((await db.query("SELECT * FROM next_policy_outbox WHERE collection_id=$1 ORDER BY id", [f.collection])).rows).toEqual(policies);
    if (installation) expect(await inTransaction(db, client => installationCollections(client, f.user, f.connector, f.device))).toEqual([{collection_id:f.collection,display_name:"Renamed 📚",role:"owner"}]);
  });
  it("never renames retained legacy/provider resources for a next collection", async () => {
    const f = await fixture();
    await db.query("INSERT INTO hosted_collections(id,user_id,display_name,template) VALUES($1,$2,'Retained legacy','fixture')", [f.collection,f.user]);
    let providerCalls = 0;
    const provider = {renameCollection:async () => {providerCalls += 1;}} as unknown as HostedProviderClient;
    await expect(renameHostedCollectionForUser({db,hostedProvider:provider},f.user,f.collection,"Rejected legacy write")).rejects.toMatchObject({code:"next_collection_metadata_required"});
    expect(providerCalls).toBe(0);
    expect((await db.query("SELECT display_name FROM hosted_collections WHERE id=$1",[f.collection])).rows[0].display_name).toBe("Retained legacy");
    expect((await rename(f,"Shared next name")).statusCode).toBe(200);
    expect((await db.query("SELECT display_name FROM hosted_collections WHERE id=$1",[f.collection])).rows[0].display_name).toBe("Retained legacy");
    expect(providerCalls).toBe(0);
  });
  it("uses the shared synced label for grant tokens and app catalog, not a device alias", async () => {
    const id = await localGrantFixture(db);
    await db.query("UPDATE grants SET activated_at=now() WHERE id=$1", [id]);
    await inTransaction(db,client => registerNextCollection(client,{collectionId:id,ownerUserId:id,runtime:"next",sync,rootKeyId:Buffer.alloc(32),displayName:"Shared catalog",ops:[{op:"genesis",owner:id,root:Buffer.alloc(32),state:sync === "cloud_copy" ? "cloud-copy" : "e2e"},{op:"member-set",account:id,role:"owner"}]}));
    const tokens = await issueApplicationTokens(db,undefined,id);
    expect(tokens.collection_name).toBe("Shared catalog");
    const reply = await app.inject({method:"GET",url:"/v1/next/apps/collections",headers:{authorization:`Bearer ${tokens.access_token}`}});
    expect(reply.statusCode).toBe(200);
    expect(reply.json().collections[0].name).toBe("Shared catalog");
    expect((await db.query("SELECT display_name FROM collections WHERE id=$1",[id])).rows[0].display_name).toBe("Fixture collection");
    await db.query("UPDATE next_collections SET left_sync_at=now() WHERE collection_id=$1", [id]);
    const localTokens = await issueApplicationTokens(db, undefined, id);
    expect(localTokens.collection_name).toBe("Fixture collection");
    const localCatalog = await app.inject({method:"GET",url:"/v1/next/apps/collections",headers:{authorization:`Bearer ${localTokens.access_token}`}});
    expect(localCatalog.statusCode).toBe(200);
    expect(localCatalog.json().collections[0].name).toBe("Fixture collection");
    expect((await db.query("SELECT display_name FROM next_collections WHERE collection_id=$1", [id])).rows[0].display_name).toBe("Shared catalog");
  });
  it("uses last committed metadata, allowing duplicate labels", async () => {
    const a = await fixture(), b = await fixture();
    expect((await rename(a, "Shared label")).statusCode).toBe(200);
    expect((await rename(b, "Shared label")).statusCode).toBe(200);
    expect((await rename(a, "Later label")).statusCode).toBe(200);
    expect(await name(a.collection)).toBe("Later label");
    expect(await name(b.collection)).toBe("Shared label");
  });
  it("serializes overlapping renames in commit order without changing policy", async () => {
    const f = await fixture();
    let releaseFirst!: () => void, firstWritten!: () => void, secondStarted!: () => void;
    const gate = new Promise<void>(resolve => { releaseFirst = resolve; });
    const written = new Promise<void>(resolve => { firstWritten = resolve; });
    const started = new Promise<void>(resolve => { secondStarted = resolve; });
    let transactions = 0;
    const racedb: DatabasePool = {
      query: db.query.bind(db), end: db.end.bind(db),
      connect: async () => {
        const connection = await db.connect();
        return {
          release: () => connection.release(),
          query: async <R extends pg.QueryResultRow>(text: string, values?: unknown[]) => {
            if (text === "BEGIN" && ++transactions === 2) secondStarted();
            const result = await connection.query<R>(text, values);
            if (text.startsWith("UPDATE next_collections SET display_name=") && values?.[1] === "First committed") {
              firstWritten(); await gate;
            }
            return result;
          }
        };
      }
    };
    const race = Fastify();
    registerErrorHandler(race); registerCollectionNameRoutes(race, racedb);
    const policies = (await db.query("SELECT ops FROM next_policy_outbox WHERE collection_id=$1 ORDER BY id", [f.collection])).rows;
    try {
      const first = race.inject({method:"PATCH",url:`/v1/next/collections/${f.collection}/name`,headers:f.headers,payload:{display_name:"First committed"}}).then(response => response);
      await written;
      const second = race.inject({method:"PATCH",url:`/v1/next/collections/${f.collection}/name`,headers:f.headers,payload:{display_name:"Second committed"}}).then(response => response);
      await started;
      expect(await name(f.collection)).toBe("Initial label"); // first is still uncommitted
      releaseFirst();
      expect((await first).statusCode).toBe(200);
      expect((await second).statusCode).toBe(200);
      expect(await name(f.collection)).toBe("Second committed");
      expect((await db.query("SELECT ops FROM next_policy_outbox WHERE collection_id=$1 ORDER BY id", [f.collection])).rows).toEqual(policies);
    } finally { releaseFirst(); await race.close(); }
  });
  it("keeps native local-only labels and token metadata device-local", async () => {
    const id = await localGrantFixture(db), f = await fixture();
    await db.query("UPDATE grants SET activated_at=now() WHERE id=$1", [id]);
    expect((await issueApplicationTokens(db, undefined, id)).collection_name).toBe("Fixture collection");
    expect((await rename({...f, collection:id}, "Must not upload local alias")).statusCode).toBe(404);
    expect((await db.query("SELECT display_name FROM collections WHERE id=$1", [id])).rows[0].display_name).toBe("Fixture collection");
    expect((await db.query("SELECT 1 FROM next_collections WHERE collection_id=$1", [id])).rows).toEqual([]);
  });
  it("does not treat create consent as arbitrary rename scope", async () => {
    const f = await fixture(true);
    await db.query("DELETE FROM installation_collection_scopes WHERE connector_id=$1", [f.connector]);
    await db.query("UPDATE installation_device_credentials SET create_collections=true WHERE connector_id=$1", [f.connector]);
    expect((await rename(f)).statusCode).toBe(403);
    expect(await name(f.collection)).toBe("Initial label");
  });
  it("refuses a foreign account and an effective non-owner role", async () => {
    const a = await fixture(), b = await fixture();
    expect((await rename({...a,collection:b.collection})).statusCode).toBe(404);
    await db.query("UPDATE next_policy_outbox SET ops=jsonb_set(ops,'{ops,1,role}','\"editor\"') WHERE collection_id=$1", [a.collection]);
    expect((await rename(a)).statusCode).toBe(403);
    expect(await name(a.collection)).toBe("Initial label");
    expect(await name(b.collection)).toBe("Initial label");
  });
  it.each(["shadow", "left", "suspended", "legacy", "revoked", "removed", "lost", "keys", "deleted"] as const)("refuses %s state without changing the label", async state => {
    const f = await fixture(sync === "cloud_copy");
    if (state === "shadow") await db.query("UPDATE next_collections SET runtime='shadow' WHERE collection_id=$1", [f.collection]);
    if (state === "left") await db.query("UPDATE next_collections SET left_sync_at=now() WHERE collection_id=$1", [f.collection]);
    if (state === "suspended") await db.query("UPDATE users SET suspended_at=now() WHERE id=$1", [f.user]);
    if (state === "legacy") await db.query("UPDATE users SET account_backend='legacy' WHERE id=$1", [f.user]);
    if (state === "revoked") await queueNextPolicy(db, f.collection, [{op:"device-revoke",device:f.device}]);
    if (state === "removed") await queueNextPolicy(db, f.collection, [{op:"member-remove",account:f.user}]);
    if (state === "lost") await db.query("UPDATE next_policy_batches SET lost_at=now() WHERE id=$1", [f.batch]);
    if (state === "keys") await db.query("UPDATE next_devices SET noise_pk=$2 WHERE id=$1", [f.device, Buffer.alloc(32, 9)]);
    if (state === "deleted") await db.query("INSERT INTO next_collection_deletion_facts(collection_id,deletion_id,lifecycle_epoch,authority) VALUES($1,$2,1,'native-registry')", [f.collection, randomUUID()]);
    expect((await rename(f)).statusCode).not.toBe(200);
    expect(await name(f.collection)).toBe("Initial label");
  });
  it("refuses next-only rename while its legacy migration is frozen", async () => {
    const f = await fixture();
    const cohort = `names_${randomUUID()}`;
    await db.query("INSERT INTO next_migration_cohorts(name,frozen_at) VALUES($1,now())", [cohort]);
    await db.query("INSERT INTO next_migration_cohort_members(account_id,cohort) VALUES($1,$2)", [f.user,cohort]);
    const reply = await rename(f);
    expect(reply.statusCode).toBe(409);
    expect(reply.json().error.code).toBe("migration_frozen");
    expect(await name(f.collection)).toBe("Initial label");
    await db.query("UPDATE next_migration_cohorts SET frozen_at=NULL WHERE name=$1", [cohort]);
    expect((await rename(f)).statusCode).toBe(200);
  });
  it.each([false,true])("rechecks the original %s bearer after authentication", async installation => {
    const f = await fixture(installation);
    let rotate = true;
    const racedb: DatabasePool = {
      query: db.query.bind(db), end: db.end.bind(db),
      connect: async () => {
        if (rotate) {
          rotate = false;
          await db.query(installation ? "UPDATE installation_device_credentials SET token_hash=$2 WHERE connector_id=$1" : "UPDATE connectors SET token_hash=$2 WHERE id=$1", [f.connector,tokenHash(`rotated_${randomUUID()}`)]);
        }
        return db.connect();
      }
    };
    const race = Fastify();
    registerErrorHandler(race); registerCollectionNameRoutes(race,racedb);
    try {
      const reply = await race.inject({method:"PATCH",url:`/v1/next/collections/${f.collection}/name`,headers:f.headers,payload:{display_name:"Must not commit"}});
      expect(reply.statusCode).toBe(404);
      expect(await name(f.collection)).toBe("Initial label");
    } finally { await race.close(); }
  });
  it("does not widen cloud-copy installation consent to private metadata writes", async () => {
    const f = await fixture(true, "private");
    const reply = await rename(f);
    expect(reply.statusCode).toBe(403);
    expect(await name(f.collection)).toBe("Initial label");
  });
  it.each(["", "  ", "a\n", "x".repeat(201), "\ud800"])("refuses invalid name #%# without mutation", async invalid => {
    const f = await fixture();
    expect((await rename(f, invalid)).statusCode).toBe(400);
    expect(await name(f.collection)).toBe("Initial label");
  });
});
