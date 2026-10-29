import { ensureDevelopmentEntitlement } from "../../entitlements.js";
import { randomBytes, randomUUID } from "node:crypto";
import Fastify from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { capabilityOperations } from "@mdbase-dev/connect-protocol";
import { createDatabase, type DatabasePool } from "../../db.js";
import { LocalRelayBroker } from "../../relay-broker.js";
import { buildPolicySnapshot, type LeasePolicySnapshot } from "../../relay-policy.js";
import { tokenHash } from "../../security.js";
import { carryOverLegacyGrants, carryOverLegacyLocalGrants } from "./legacy-grant-carry-over.js";
import { registerNextCollection } from "./policy-outbox.js";
import { registerNextRouteRoutes } from "./route-routes.js";

const testUrl = process.env.MDBASE_CONNECT_TEST_DATABASE_URL;
const approved = process.env.MDBASE_CONNECT_DESTRUCTIVE_TEST_APPROVAL === "I APPROVE MDBASE CONNECT DESTRUCTIVE POSTGRES TESTS";
const describePostgres = testUrl && approved ? describe : describe.skip;
const ROOT = Buffer.alloc(16, 7);
const OPERATIONS: string[] = [...capabilityOperations("collection.read")];

describePostgres("legacy grant carry-over to a Private collection (real Postgres)", () => {
  let admin: pg.Pool;
  let db: DatabasePool;
  let schema: string;
  const app = Fastify();
  const broker = new LocalRelayBroker();

  beforeAll(async () => {
    const url = new URL(testUrl!);
    if (!["localhost", "127.0.0.1", "::1"].includes(url.hostname) || !/test/i.test(url.pathname)) throw new Error("Carry-over tests require a dedicated local test database.");
    schema = `mdbase_carry_over_test_${randomUUID().replaceAll("-", "")}`;
    admin = new pg.Pool({ connectionString: url.toString(), max: 2 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    url.searchParams.set("options", `-csearch_path=${schema}`);
    db = await createDatabase(url.toString());
    registerNextRouteRoutes(app, { db, publicUrl: "https://connect.example", broker,
      carryOver: (collection) => carryOverLegacyGrants({ db }, collection) });
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await broker.close();
    await db?.end();
    if (admin && schema) await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin?.end();
  }, 60_000);

  /** A next account whose old Connect connector registered `collection`, now taken over (retired). */
  async function takenOver() {
    const owner = randomUUID();
    const collection = randomUUID();
    const legacyConnector = randomUUID();
    const legacyRow = randomUUID();
    await db.query("INSERT INTO users(id,email,name,account_backend) VALUES($1,$2,'Owner','next')", [owner, `${owner}@example.test`]);
    await ensureDevelopmentEntitlement(db, owner);
    await db.query("INSERT INTO connectors(id,user_id,name,token_hash,relay_generation,revoked_at) VALUES($1,$2,'Old Connect',$3,2,now())", [legacyConnector, owner, randomUUID()]);
    await db.query(`INSERT INTO collections(id,user_id,connector_id,local_id,display_name,spec_version,present,enabled,authority_state)
      VALUES($1,$2,$3,$4,'Journal','0.3.0',true,false,'retired')`, [legacyRow, owner, legacyConnector, collection]);
    // The new desktop: its own connector and device.
    const connector = randomUUID();
    const device = randomUUID();
    await db.query("INSERT INTO connectors(id,user_id,name,token_hash,relay_generation) VALUES($1,$2,'Desktop',$3,1)", [connector, owner, randomUUID()]);
    const keys = { sign_pk: randomBytes(32), kem_pk: randomBytes(32), noise_pk: randomBytes(32) };
    await db.query("INSERT INTO next_devices(id,connector_id,user_id,kind,sign_pk,kem_pk,noise_pk) VALUES($1,$2,$3,'desktop',$4,$5,$6)",
      [device, connector, owner, keys.sign_pk, keys.kem_pk, keys.noise_pk]);
    const turnOnPrivate = async () => {
      await registerNextCollection(db, { collectionId: collection, ownerUserId: owner, runtime: "next", sync: "private", rootKeyId: ROOT, displayName: "Journal",
        ops: [{ op: "genesis", owner, root: ROOT, state: "e2e" }, { op: "member-set", account: owner, role: "owner" },
          { op: "device-enrol", device, account: owner, kind: "desktop", signPublicKey: keys.sign_pk, kemPublicKey: keys.kem_pk, noisePublicKey: keys.noise_pk }] });
      await appendPending(collection);
    };
    return { owner, collection, legacyRow, connector, turnOnPrivate };
  }

  async function appendPending(collection: string) {
    const seq = Number((await db.query<{ n: string }>("SELECT count(*) AS n FROM next_policy_batches WHERE collection_id = $1", [collection])).rows[0]!.n) + 1;
    const batch = await db.query<{ id: string }>(
      "INSERT INTO next_policy_batches(collection_id,seq,prev,item,issued_at,state,appended_at) VALUES($1,$2,$3,$4,$5,'appended',now()) RETURNING id",
      [collection, seq, Buffer.alloc(32), Buffer.from([seq]), seq]
    );
    await db.query("UPDATE next_policy_outbox SET batch_id = $1 WHERE collection_id = $2 AND batch_id IS NULL", [batch.rows[0]!.id, collection]);
  }

  /** An app's active legacy grant on the old Connect collection row, with an access token. */
  async function legacyGrant(account: string, legacyRow: string, collection: string, overrides: { semantic?: number; key?: boolean; installation?: string } = {}) {
    const grant = randomUUID();
    await db.query("INSERT INTO applications(id,canonical_identity,name,homepage,redirect_uris) VALUES($1::uuid,$1::text,'Journal','https://journal.example','[]')", [grant]);
    await db.query("UPDATE applications SET application_declaration = '{\"id\":\"dev.mdbase.journal\"}'::jsonb WHERE id = $1", [grant]);
    await db.query(`INSERT INTO grants(id,user_id,application_id,collection_id,logical_collection_id,operations,scope,file_capability,encryption,application_installation_id,application_authorization,activated_at)
      VALUES($1,$2,$1,$3,$4,$5::jsonb,'{"access":"full_collection","contracts":[]}',
      '{"kind":"files","protocol_version":1,"actions":["list","read"],"scope":{"kind":"collection"}}','{"protocol_version":1}',$6,$7::jsonb,now())`,
    [grant, account, legacyRow, collection, JSON.stringify(OPERATIONS), overrides.installation ?? randomUUID(),
      JSON.stringify({ binding: { protocol_version: 5, application_declaration_id: "dev.mdbase.journal",
        contracts: { semantic_capabilities: overrides.semantic ?? 2 } } })]);
    if (overrides.key !== false) await db.query("INSERT INTO next_grant_client_keys(grant_id, client_pk) VALUES($1,$2)", [grant, randomBytes(32)]);
    const token = `at_${randomUUID()}`;
    await db.query("INSERT INTO access_tokens(id,token_hash,grant_id,expires_at) VALUES($1,$2,$3,now() + interval '1 hour')", [randomUUID(), tokenHash(token), grant]);
    const route = async () => (await app.inject({ method: "GET", url: `/v1/next/collections/${collection}/route`, headers: { authorization: `Bearer ${token}` } })).json();
    return { grant, token, route };
  }

  const target = async (grant: string) => (await db.query<{ collection_id: string | null; next_collection_id: string | null; encryption: unknown; binding: string | null }>(
    `SELECT g.collection_id, g.next_collection_id, g.encryption, b.log_grant_id AS binding
     FROM grants g LEFT JOIN next_grant_bindings b ON b.grant_id = g.id AND b.active WHERE g.id = $1`, [grant])).rows[0]!;

  it("moves the owner's key-bound grant once Private sync is on, keeping its id and tokens", async () => {
    const fixture = await takenOver();
    const app1 = await legacyGrant(fixture.owner, fixture.legacyRow, fixture.collection);
    // Not Private yet: nothing to move to.
    expect(await carryOverLegacyLocalGrants(db, fixture.collection)).toEqual([]);
    expect((await target(app1.grant)).collection_id).toBe(fixture.legacyRow);
    await fixture.turnOnPrivate();
    expect(await carryOverLegacyLocalGrants(db, fixture.collection)).toEqual([app1.grant]);
    const moved = await target(app1.grant);
    expect(moved).toMatchObject({ collection_id: null, next_collection_id: fixture.collection, encryption: null });
    expect(moved.binding).toMatch(/^[0-9a-f-]{36}$/);
    // Idempotent.
    expect(await carryOverLegacyLocalGrants(db, fixture.collection)).toEqual([]);
    const ops = (await db.query<{ ops: { ops: Array<Record<string, unknown>> } }>("SELECT ops FROM next_policy_outbox WHERE collection_id=$1 ORDER BY id", [fixture.collection])).rows.flatMap(r => r.ops.ops);
    expect(ops.filter(op => op.op === "grant")).toEqual([expect.objectContaining({ grant: moved.binding, account: fixture.owner, appId: "dev.mdbase.journal" })]);
    // The same token now routes natively, and the serving desktop's policy feed offers it.
    await appendPending(fixture.collection);
    const route = await app1.route();
    expect(route).toMatchObject({ collection: fixture.collection, grant: moved.binding, authorization_grant: app1.grant });
    expect(route.availability).not.toEqual({ state: "unavailable", reason: "sync_required" });
    const snapshot = await buildPolicySnapshot(db, fixture.connector, 55_000, undefined, () => true, "lease_v1", true, true, true) as LeasePolicySnapshot;
    expect(snapshot.grants.map(g => String(g.id))).toContain(moved.binding);
    const audit = await db.query("SELECT 1 FROM audit_events WHERE event_type='grant.carried_over' AND subject_id=$1", [app1.grant]);
    expect(audit.rows).toHaveLength(1);
  });

  it("leaves grants it cannot serve as approved, which still need a fresh approval", async () => {
    const fixture = await takenOver();
    await fixture.turnOnPrivate();
    const keyless = await legacyGrant(fixture.owner, fixture.legacyRow, fixture.collection, { key: false });
    const unbound = await legacyGrant(fixture.owner, fixture.legacyRow, fixture.collection, { semantic: 1 });
    const member = randomUUID();
    await db.query("INSERT INTO users(id,email,name,account_backend) VALUES($1,$2,'Someone','next')", [member, `${member}@example.test`]);
    const other = await legacyGrant(member, fixture.legacyRow, fixture.collection);
    const good = await legacyGrant(fixture.owner, fixture.legacyRow, fixture.collection);
    expect(await carryOverLegacyLocalGrants(db, fixture.collection)).toEqual([good.grant]);
    for (const left of [keyless, unbound, other]) {
      expect((await target(left.grant))).toMatchObject({ collection_id: fixture.legacyRow, next_collection_id: null, binding: null });
    }
    // The route still explains that the app must be set up again.
    expect(await unbound.route()).toMatchObject({ availability: { state: "unavailable", reason: "sync_required" } });
  });

  it("skips an installation that already has a native grant on the collection", async () => {
    const fixture = await takenOver();
    await fixture.turnOnPrivate();
    const installation = randomUUID();
    const first = await legacyGrant(fixture.owner, fixture.legacyRow, fixture.collection, { installation });
    expect(await carryOverLegacyLocalGrants(db, fixture.collection)).toEqual([first.grant]);
    // A second legacy grant for the same app installation (same application id).
    const second = randomUUID();
    await db.query(`INSERT INTO grants(id,user_id,application_id,collection_id,operations,scope,file_capability,application_installation_id,application_authorization,activated_at)
      SELECT $1,user_id,application_id,$2,operations,scope,file_capability,application_installation_id,application_authorization,now() FROM grants WHERE id=$3`,
    [second, fixture.legacyRow, first.grant]);
    await db.query("INSERT INTO next_grant_client_keys(grant_id, client_pk) VALUES($1,$2)", [second, randomBytes(32)]);
    expect(await carryOverLegacyLocalGrants(db, fixture.collection)).toEqual([]);
    expect((await target(second)).collection_id).toBe(fixture.legacyRow);
  });

  it("moves a grant when its app next asks for a route, if Private sync was turned on earlier", async () => {
    const fixture = await takenOver();
    const app1 = await legacyGrant(fixture.owner, fixture.legacyRow, fixture.collection);
    await fixture.turnOnPrivate();
    const route = await app1.route();
    const moved = await target(app1.grant);
    expect(moved.next_collection_id).toBe(fixture.collection);
    expect(route).toMatchObject({ collection: fixture.collection, grant: moved.binding, authorization_grant: app1.grant });
  });
});
