import { randomBytes, randomUUID } from "node:crypto";
import Fastify from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, type DatabasePool } from "../../db.js";
import { registerErrorHandler } from "../../platform/error-handler.js";
import { tokenHash } from "../../security.js";
import { localGrantFixture } from "./next-fixtures.test-helper.js";
import { registerNextRouteRoutes } from "./route-routes.js";
import { LocalRelayBroker } from "../../relay-broker.js";
import { createHostedCollectionMembership } from "../../collection-policy.js";

const testUrl = process.env.MDBASE_CONNECT_TEST_DATABASE_URL;
const approved = process.env.MDBASE_CONNECT_DESTRUCTIVE_TEST_APPROVAL === "I APPROVE MDBASE CONNECT DESTRUCTIVE POSTGRES TESTS";
const describePostgres = testUrl && approved ? describe : describe.skip;

describePostgres("mdbase-next route endpoint", () => {
  let admin: pg.Pool;
  let db: DatabasePool;
  let schema: string;
  const app = Fastify();
  const hostedApp = Fastify();
  const broker = new LocalRelayBroker();

  beforeAll(async () => {
    const url = new URL(testUrl!);
    if (!["localhost", "127.0.0.1", "::1"].includes(url.hostname) || !/test/i.test(url.pathname)) throw new Error("Route tests require a dedicated local test database.");
    schema = `mdbase_next_route_test_${randomUUID().replaceAll("-", "")}`;
    admin = new pg.Pool({ connectionString: url.toString(), max: 2 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    url.searchParams.set("options", `-csearch_path=${schema}`);
    db = await createDatabase(url.toString());
    registerErrorHandler(app);
    registerNextRouteRoutes(app, { db, publicUrl: "https://connect.example", broker });
    registerErrorHandler(hostedApp);
    registerNextRouteRoutes(hostedApp, { db, publicUrl: "https://connect.example", broker, hostedClientUrl: "https://hosted.example" });
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await hostedApp.close();
    await broker.close();
    await db?.end();
    if (admin && schema) await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin?.end();
  }, 60_000);

  async function grantWithToken() {
    const id = await localGrantFixture(db);
    await db.query("UPDATE grants SET activated_at = now() WHERE id = $1", [id]);
    await db.query("UPDATE collections SET enabled = true, present = true, authority_state = 'active' WHERE id = $1", [id]);
    const token = `at_${randomUUID()}`;
    await db.query("INSERT INTO access_tokens(id,token_hash,grant_id,expires_at) VALUES($1,$2,$3,now() + interval '1 hour')", [randomUUID(), tokenHash(token), id]);
    const route = () => app.inject({ method: "GET", url: `/v1/next/collections/${id}/route`, headers: { authorization: `Bearer ${token}` } });
    return { id, token, route };
  }

  async function legacyHostedGrant() {
    const { id, token } = await grantWithToken();
    await db.query("INSERT INTO hosted_collections(id,user_id,display_name,template) VALUES($1,$1,'Legacy hosted','mdbase')", [id]);
    await db.query("INSERT INTO hosted_replicas(id,collection_id,authorized_user_id,name,purpose,mode) VALUES($1,$1,$1,'Application','application','read_only')", [id]);
    await db.query("UPDATE grants SET collection_id=NULL,hosted_collection_id=$1,hosted_replica_id=$1,logical_collection_id=$1 WHERE id=$1", [id]);
    const route = (collection = id, bearer = token) => Promise.all([app, hostedApp].map((server) => server.inject({
      method: "GET", url: `/v1/next/collections/${collection}/route`, headers: { authorization: `Bearer ${bearer}` }
    })));
    return { id, route };
  }

  it("returns legacy discovery only for a live hosted grant to an unmigrated collection", async () => {
    const f = await legacyHostedGrant();
    expect((await f.route()).map((response) => response.statusCode)).toEqual([404, 404]);
    expect((await f.route(randomUUID())).map((response) => response.statusCode)).toEqual([401, 401]);
    expect((await f.route(f.id, "invalid-token")).map((response) => response.statusCode)).toEqual([401, 401]);
    await db.query("INSERT INTO next_collections(collection_id,owner_user_id,runtime,sync,root_key_id) VALUES($1,$1,'shadow','cloud_copy',$2)", [f.id, Buffer.alloc(16)]);
    expect((await f.route()).map((response) => response.statusCode)).toEqual([401, 401]);
  });

  it.each([
    ["expired token", "UPDATE access_tokens SET expires_at=now()-interval '1 hour' WHERE grant_id=$1"],
    ["revoked token", "UPDATE access_tokens SET revoked_at=now() WHERE grant_id=$1"],
    ["revoked grant", "UPDATE grants SET revoked_at=now() WHERE id=$1"],
    ["unactivated grant", "UPDATE grants SET activated_at=NULL WHERE id=$1"],
    ["revoked replica", "UPDATE hosted_replicas SET revoked_at=now() WHERE id=$1"],
    ["quarantined collection", "UPDATE hosted_collections SET quarantined_at=now() WHERE id=$1"],
    ["transferring collection", "UPDATE hosted_collections SET authority_state='transferring' WHERE id=$1"],
    ["suspended account", "UPDATE users SET suspended_at=now() WHERE id=$1"]
  ])("does not offer legacy discovery for a %s", async (_name, mutation) => {
    const f = await legacyHostedGrant();
    await db.query(mutation, [f.id]);
    expect((await f.route()).map((response) => response.statusCode)).toEqual([401, 401]);
  });

  it("requires the current member-policy binding for legacy hosted discovery", async () => {
    const f = await legacyHostedGrant();
    const member = randomUUID();
    await db.query("INSERT INTO users(id,email,name) VALUES($1,$2,'Member')", [member, `${member}@example.test`]);
    const policy = await createHostedCollectionMembership(db, { collectionId: f.id, ownerUserId: f.id, userId: member, role: "viewer" });
    await db.query("UPDATE grants SET hosted_replica_id=NULL WHERE id=$1", [f.id]);
    await db.query("UPDATE hosted_replicas SET authorized_user_id=$2,membership_id=$3,membership_policy_id=$4,membership_policy_revision=$5 WHERE id=$1", [f.id, member, policy.membershipId, policy.id, policy.revision]);
    await db.query("UPDATE grants SET hosted_replica_id=$1,user_id=$2,membership_id=$3,membership_policy_id=$4,membership_policy_revision=$5 WHERE id=$1", [f.id, member, policy.membershipId, policy.id, policy.revision]);
    expect((await f.route()).map((response) => response.statusCode)).toEqual([404, 404]);
    const nextPolicy = randomUUID();
    await db.query(`INSERT INTO collection_membership_policies
      (id,membership_id,revision,role,preset_version,actions,operations,scope_ceiling,file_ceiling)
      SELECT $2,membership_id,2,role,preset_version,actions,operations,scope_ceiling,file_ceiling
      FROM collection_membership_policies WHERE id=$1`, [policy.id, nextPolicy]);
    await db.query("UPDATE collection_memberships SET current_policy_id=$2,current_policy_revision=2 WHERE id=$1", [policy.membershipId, nextPolicy]);
    expect((await f.route()).map((response) => response.statusCode)).toEqual([401, 401]);
    await db.query("UPDATE collection_memberships SET current_policy_id=$2,current_policy_revision=$3 WHERE id=$1", [policy.membershipId, policy.id, policy.revision]);
    await db.query("UPDATE collection_memberships SET state='revoking' WHERE id=$1", [policy.membershipId]);
    expect((await f.route()).map((response) => response.statusCode)).toEqual([401, 401]);
  });

  it("routes a keyed grant to its daemon through the relay", async () => {
    const { id, route } = await grantWithToken();
    await db.query("INSERT INTO next_grant_client_keys(grant_id, client_pk) VALUES($1,$2)", [id, randomBytes(32)]);
    expect((await route()).json()).toMatchObject({error:{code:"collection_not_yet_migrated"}});
    const device = randomUUID();
    const noisePk = randomBytes(32);
    await db.query("INSERT INTO next_devices(id, connector_id, user_id, kind, sign_pk, kem_pk, noise_pk) VALUES($1,$2,$3,'desktop',$4,$5,$6)",
      [device, id, id, randomBytes(32), randomBytes(32), noisePk]);
    expect((await route()).json()).toEqual({
      collection: id, grant: id,
      targets: [{ kind: "desktop", device, noise_pk: noisePk.toString("hex"), url: "wss://connect.example/v1/next/relay/client", online: false, relay_collection: id }],
      availability: { state: "unavailable", reason: "device_offline" }
    });
    await db.query("UPDATE connectors SET latest_policy_ack_at = now(), latest_policy_ack_generation = relay_generation WHERE id = $1", [id]);
    // A recent policy ACK is not proof that this device's Noise socket is bound.
    expect((await route()).json().targets[0].online).toBe(false);
    const generation = (await db.query("SELECT relay_generation FROM connectors WHERE id = $1", [id])).rows[0].relay_generation;
    const owner = await broker.bind({ connectorId: id, generation: String(generation),
      handle: async (command) => ({ version: 1, ok: true, value: command.kind === "device_presence" && (command.message as { device_id: string }).device_id === device }),
      handleBinary: async () => ({ version: 1, ok: true, value: new Uint8Array() }), replaced: () => {} });
    expect((await route()).json()).toMatchObject({ targets: [{ online: true }], availability: { state: "available" } });
    await db.query("UPDATE connectors SET relay_generation = relay_generation + 1 WHERE id = $1", [id]);
    expect((await route()).json().targets[0].online).toBe(false);
    await owner.close();
  });

  it("never routes to a device of another account (SEC-047)", async () => {
    const { id, route } = await grantWithToken();
    await db.query("INSERT INTO next_grant_client_keys(grant_id, client_pk) VALUES($1,$2)", [id, randomBytes(32)]);
    const stranger = randomUUID();
    await db.query("INSERT INTO users(id,email,name) VALUES($1,$2,'Stranger')", [stranger, `${stranger}@example.test`]);
    await db.query("INSERT INTO next_devices(id, connector_id, user_id, kind, sign_pk, kem_pk, noise_pk) VALUES($1,$2,$3,'desktop',$4,$5,$6)",
      [randomUUID(), id, stranger, randomBytes(32), randomBytes(32), randomBytes(32)]);
    expect((await route()).json()).toMatchObject({ targets: [], reason: "no_device_registered" });
  });

  it("refuses grants without a client key, other collections, and revoked grants or tokens", async () => {
    const { id, token, route } = await grantWithToken();
    // A next local-only desktop still needs a client key; this is not legacy.
    await db.query("INSERT INTO next_devices(id,connector_id,user_id,kind,sign_pk,kem_pk,noise_pk) VALUES($1,$2,$2,\'desktop\',$3,$4,$5)",
      [randomUUID(),id,randomBytes(32),randomBytes(32),randomBytes(32)]);
    const unkeyed = await route();
    expect([unkeyed.statusCode, unkeyed.json().error.code]).toEqual([409, "client_key_required"]);
    const other = await app.inject({ method: "GET", url: `/v1/next/collections/${randomUUID()}/route`, headers: { authorization: `Bearer ${token}` } });
    expect(other.statusCode).toBe(401);
    await db.query("INSERT INTO next_grant_client_keys(grant_id, client_pk) VALUES($1,$2)", [id, randomBytes(32)]);
    await db.query("UPDATE grants SET revoked_at = now() WHERE id = $1", [id]);
    expect((await route()).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: `/v1/next/collections/${id}/route` })).statusCode).toBe(401);
  });

  it("lists the installation's collections for switching (C2)", async () => {
    const { id, token } = await grantWithToken();
    const second = await localGrantFixture(db);
    // A second grant of the same user, app and installation, on another collection.
    await db.query(`UPDATE grants SET user_id = $2, application_id = $2, activated_at = now() WHERE id = $1`, [second, id]);
    await db.query(`UPDATE collections SET user_id = $2, enabled = true, present = true, authority_state = 'active' WHERE id = $1`, [second, id]);
    await db.query("INSERT INTO next_grant_client_keys(grant_id, client_pk) VALUES($1,$2)", [second, randomBytes(32)]);
    await db.query("INSERT INTO next_collections(collection_id, owner_user_id, runtime, sync, root_key_id) VALUES($1,$2,'next','private',$3)", [second, id, Buffer.alloc(16)]);
    // Synced discovery requires a published log-grant binding as well as a key.
    await db.query("INSERT INTO next_grant_bindings(grant_id,collection_id,log_grant_id,terms_digest) VALUES($1,$1,$1,$2)", [second, Buffer.alloc(32)]);
    // Another installation's grant is not listed.
    const other = await localGrantFixture(db);
    await db.query(`UPDATE grants SET user_id = $2, application_id = $2, application_installation_id = 'other-installation', activated_at = now() WHERE id = $1`, [other, id]);
    const response = await app.inject({ method: "GET", url: "/v1/next/apps/collections", headers: { authorization: `Bearer ${token}` } });
    expect(response.statusCode).toBe(200);
    const collections = response.json().collections as Array<Record<string, unknown>>;
    expect(collections.map((entry) => entry.grant).sort()).toEqual([id, second].sort());
    expect(collections.find((entry) => entry.grant === second)).toMatchObject({ collection: second, state: "synced_e2e", routable: true });
    expect(collections.find((entry) => entry.grant === id)).toMatchObject({ collection: id, state: "local", routable: false,
      availability:{state:"unavailable",reason:"collection_not_yet_migrated"} });
    expect((await app.inject({ method: "GET", url: "/v1/next/apps/collections" })).statusCode).toBe(401);
  });

  it("refuses a keyed legacy collection before routing, without leaking state to other or revoked tokens",async()=>{
    const {id,token,route}=await grantWithToken();
    await db.query("INSERT INTO next_grant_client_keys(grant_id,client_pk) VALUES($1,$2)",[id,randomBytes(32)]);
    const response=await route();
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({error:{code:"collection_not_yet_migrated",
      message:"This collection will appear here once you update the mdbase desktop app on the computer that holds it."}});
    expect(response.headers["retry-after"]).toBeUndefined();
    expect(response.json().targets).toBeUndefined();
    const inventory=await app.inject({method:"GET",url:"/v1/next/apps/collections",headers:{authorization:`Bearer ${token}`}});
    expect(inventory.json().collections).toMatchObject([{routable:false,availability:{state:"unavailable",reason:"collection_not_yet_migrated"}}]);
    const other=await grantWithToken();
    expect((await app.inject({method:"GET",url:`/v1/next/collections/${id}/route`,headers:{authorization:`Bearer ${other.token}`}})).statusCode).toBe(401);
    await db.query("UPDATE access_tokens SET revoked_at=now() WHERE grant_id=$1",[id]);
    expect((await route()).statusCode).toBe(401);
  });

  it("lists hosted collections only while they are active and not quarantined", async () => {
    const { id, token } = await grantWithToken();
    const hosted = async (state: string, quarantined: boolean) => {
      const collection = randomUUID();
      await db.query(`INSERT INTO hosted_collections (id, user_id, display_name, template, authority_state, quarantined_at, quarantine_reason)
        VALUES ($1, $2, 'Hosted', 'mdbase', $3, $4, $5)`, [collection, id, state, quarantined ? new Date() : null, quarantined ? "provider_collection_missing" : null]);
      const grant = randomUUID();
      await db.query(`INSERT INTO grants (id, user_id, application_id, hosted_collection_id, operations, application_installation_id, activated_at)
        VALUES ($1, $2, $2, $3, '["read"]', 'fixture-installation', now())`, [grant, id, collection]);
      return grant;
    };
    const active = await hosted("active", false);
    const quarantined = await hosted("active", true);
    const transferring = await hosted("transferring", false);
    const response = await app.inject({ method: "GET", url: "/v1/next/apps/collections", headers: { authorization: `Bearer ${token}` } });
    const grants = (response.json().collections as Array<{ grant: string }>).map((entry) => entry.grant);
    expect(grants).toContain(active);
    expect(grants).not.toContain(quarantined);
    expect(grants).not.toContain(transferring);
  });
});
