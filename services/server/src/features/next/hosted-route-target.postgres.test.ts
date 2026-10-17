import { generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import Fastify from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { APPLICATION_CAPABILITY_DEFINITIONS } from "@mdbase-dev/connect-protocol";
import { createDatabase, type DatabasePool } from "../../db.js";
import { tokenHash } from "../../security.js";
import { createHostedCollectionMembership } from "../../collection-policy.js";
import { LocalRelayBroker } from "../../relay-broker.js";
import { localGrantFixture } from "./next-fixtures.test-helper.js";
import { registerNextRouteRoutes } from "./route-routes.js";
import { queueNextGrantPolicy } from "./grant-policy.js";
import { parseServiceDevice, storeServiceDevice } from "./service-devices.js";
import { queueNextPolicy, registerNextCollection } from "./policy-outbox.js";
import { certDigest, chainHash, keyId, signPolicyItem, type PolicyOp } from "./policy-wire.js";
import { ed25519RawPublicKey } from "./policy-keys.js";
import { migrationRoute, registerMigrationRouteRetireRoute, type MigrationRouting } from "./migration-routing.js";
import { activatePendingServices } from "./service-activation.js";
import { registerNextHostedRoutes } from "./hosted-routes.js";

const testUrl = process.env.MDBASE_CONNECT_TEST_DATABASE_URL;
const approved = process.env.MDBASE_CONNECT_DESTRUCTIVE_TEST_APPROVAL === "I APPROVE MDBASE CONNECT DESTRUCTIVE POSTGRES TESTS";
const suite = testUrl && approved ? describe : describe.skip;
const now = 1_800_000_000_000;
const root = generateKeyPairSync("ed25519"); const policy = generateKeyPairSync("ed25519");
const unsigned = { policyPublicKey: ed25519RawPublicKey(policy.publicKey), root: keyId(ed25519RawPublicKey(root.publicKey)), notBefore: now - 1000, notAfter: now + 100_000 };
const signer = { privateKey: policy.privateKey, cert: { ...unsigned, signature: sign(null, certDigest(unsigned), root.privateKey) } };

suite("hosted Noise discovery (real Postgres, not serving qualification)", () => {
  let admin: pg.Pool; let db: DatabasePool; let schema: string;
  const app = Fastify(); const broker = new LocalRelayBroker();
  beforeAll(async () => {
    const url = new URL(testUrl!);
    if (!["localhost", "127.0.0.1", "::1"].includes(url.hostname) || !/test/i.test(url.pathname)) throw new Error("Hosted route tests require a dedicated local test database.");
    schema = `hosted_route_test_${randomUUID().replaceAll("-", "")}`;
    admin = new pg.Pool({ connectionString: url.toString(), max: 2 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    url.searchParams.set("options", `-csearch_path=${schema}`);
    db = await createDatabase(url.toString());
    registerNextRouteRoutes(app, { db, publicUrl: "https://connect.example", broker, hostedClientUrl: "https://hosted.example" });
  }, 60_000);
  afterAll(async () => {
    await app.close(); await broker.close(); await db?.end();
    if (admin && schema) await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin?.end();
  }, 60_000);

  async function append(id: string, seq: number, ops: PolicyOp[], state = "appended") {
    const previous = (await db.query<{ item: Buffer }>("SELECT item FROM next_policy_batches WHERE collection_id=$1 AND seq=$2 ORDER BY id DESC LIMIT 1", [id, seq - 1])).rows[0];
    const prev = previous ? Buffer.from(chainHash(previous.item)) : Buffer.alloc(32);
    const batch = (await db.query<{ id: string }>("INSERT INTO next_policy_batches(collection_id,seq,prev,item,issued_at,state) VALUES($1,$2,$3,$4,$5,$6) RETURNING id", [
      id, seq, prev, Buffer.from(signPolicyItem(signer, { collection: id, seq, prev, issuedAt: now + seq, previousIssuedAt: now + seq - 1, ops })), now + seq, state
    ])).rows[0]!.id;
    await db.query("UPDATE next_policy_outbox SET batch_id=$2 WHERE collection_id=$1 AND batch_id IS NULL", [id, batch]);
    return batch;
  }
  async function fixture(options: { hostedOnly?: boolean; sync?: "private" | "cloud_copy"; runtime?: "shadow" | "next"; appended?: boolean; daemon?: boolean; narrowable?: boolean } = {}) {
    const id = await localGrantFixture(db); const token = `at_${randomUUID()}`;
    await db.query("UPDATE grants SET activated_at=now(), operations=$2, file_capability=$3, application_installation_id=$4, application_authorization=$5 WHERE id=$1", [id,
      JSON.stringify(APPLICATION_CAPABILITY_DEFINITIONS["collection.read"]), JSON.stringify({ kind: "files", protocol_version: 1, actions: ["list", "read"], scope: { kind: "collection" } }), randomUUID(),
      JSON.stringify({ binding: { application_declaration_id: "dev.example.reader", contracts: { semantic_capabilities: 2 } } })]);
    await db.query("UPDATE collections SET enabled=true,present=true,authority_state='active' WHERE id=$1", [id]);
    if (options.hostedOnly) {
      await db.query("INSERT INTO hosted_collections(id,user_id,display_name,template,authority_state) VALUES($1,$1,'Hosted fixture','mdbase','active')", [id]);
      await db.query("UPDATE grants SET collection_id=NULL,hosted_collection_id=$1,logical_collection_id=$1 WHERE id=$1", [id]);
    }
    await db.query("INSERT INTO next_grant_client_keys(grant_id,client_pk) VALUES($1,$2)", [id, randomBytes(32)]);
    await db.query("INSERT INTO access_tokens(id,token_hash,grant_id,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')", [randomUUID(), tokenHash(token), id]);
    const record = parseServiceDevice({ kind: "hosted", device_id: randomUUID(), sign_pk: "03".repeat(32), kem_pk: "04".repeat(32), noise_pk: "05".repeat(32), wrapped_keys: Buffer.from("isolated-test-wrapped").toString("base64"), kms_key_arn: "arn:aws:kms:eu-west-1:000000000000:key/test" });
    const sync = options.sync ?? "cloud_copy";
    const ops: PolicyOp[] = [{ op: "genesis", owner: id, root: unsigned.root, state: sync === "private" ? "e2e" : "cloud-copy" }];
    if (sync === "cloud_copy") ops.push({ op: "device-enrol", device: record.device_id, account: "00000000-0000-0000-0000-000000000000", kind: "hosted", signPublicKey: record.sign_pk, kemPublicKey: record.kem_pk, noisePublicKey: record.noise_pk });
    await registerNextCollection(db, { collectionId: id, ownerUserId: id, runtime: options.runtime ?? "next", sync, rootKeyId: unsigned.root, ops });
    if (sync === "cloud_copy") await storeServiceDevice(db, id, record);
    const batch = await append(id, 1, ops, options.appended === false ? "sending" : "appended");
    if (options.narrowable) await db.query("UPDATE grants SET operations=$2,file_capability=$3 WHERE id=$1", [id,
      JSON.stringify([...APPLICATION_CAPABILITY_DEFINITIONS["collection.read"], ...APPLICATION_CAPABILITY_DEFINITIONS["records.create"]]),
      JSON.stringify({ kind: "files", protocol_version: 1, actions: ["list", "read", "add"], scope: { kind: "collection" } })]);
    const logGrant = await queueNextGrantPolicy(db, id);
    const daemon = randomUUID();
    if (options.daemon) await db.query("INSERT INTO next_devices(id,connector_id,user_id,kind,sign_pk,kem_pk,noise_pk) VALUES($1,$2,$2,'desktop',$3,$4,$5)", [daemon, id, randomBytes(32), randomBytes(32), randomBytes(32)]);
    const route = (collection = id, bearer = token) => app.inject({ method: "GET", url: `/v1/next/collections/${collection}/route`, headers: { authorization: `Bearer ${bearer}` } });
    return { id, token, record, batch, daemon, logGrant, route };
  }

  it("selects only released frozen nonterminal DB members and retains routing across start/flip/pause", async () => {
    const own = await fixture({ hostedOnly: true }), outside = await fixture({ hostedOnly: true });
    const cohort = `routing-${randomUUID().slice(0, 8)}`;
    const routing: MigrationRouting = { environment: "lab", accounts: new Set(), hosted: { url: "https://mdbase-next-hosted-mig-lab.example.workers.dev", token: "m".repeat(40) }, inboundToken: "i".repeat(40) };
    const scoped = Fastify(), normalToken = "H".repeat(40);
    registerNextRouteRoutes(scoped, { db, publicUrl: "https://connect.example", broker, hostedClientUrl: "https://hosted.example", migrationRouting: routing });
    registerNextHostedRoutes(scoped, { db, tokens: { hosted: normalToken }, migrationRouting: routing });
    const route = () => scoped.inject({ method: "GET", url: `/v1/next/collections/${own.id}/route`, headers: { authorization: `Bearer ${own.token}` } });
    const state = (ids: string[], token: string) => scoped.inject({ method: "POST", url: "/internal/v1/next/collections/states", headers: { authorization: `Bearer ${token}` }, payload: { ids } });
    try {
      expect(await migrationRoute(db, routing, own.id)).toBe("default");
      await db.query("INSERT INTO next_migration_cohorts(name) VALUES($1)", [cohort]);
      await db.query("INSERT INTO next_migration_cohort_members(account_id,cohort) VALUES($1,$2)", [own.id, cohort]);
      expect(await migrationRoute(db, routing, own.id)).toBe("default");
      await db.query("UPDATE next_migration_cohorts SET released_at=now() WHERE name=$1", [cohort]);
      expect(await migrationRoute(db, routing, own.id)).toBe("default");
      await db.query("UPDATE next_migration_cohorts SET frozen_at=now() WHERE name=$1", [cohort]);
      expect(await migrationRoute(db, routing, own.id)).toBe("migration");
      expect(await migrationRoute(db, routing, randomUUID(), own.id)).toBe("migration");
      await expect(migrationRoute(db, routing, own.id, outside.id)).rejects.toThrow("foreign_collection_owner");
      expect((await route()).json().targets[0].url).toContain("mdbase-next-hosted-mig-lab");
      expect((await state([own.id], routing.inboundToken)).statusCode).toBe(200);
      expect((await state([own.id], normalToken)).statusCode).toBe(403);
      for (const credential of [normalToken, routing.inboundToken]) expect((await state([own.id, outside.id], credential)).statusCode).toBe(403);
      // Deployment choice is not an unpaused rollout/start or a Legacy marker.
      await db.query("UPDATE next_migration_cohort_members SET started_at=now() WHERE account_id=$1", [own.id]);
      await db.query("UPDATE users SET account_backend='next' WHERE id=$1", [own.id]);
      await db.query("UPDATE next_migration_rollout SET paused=true WHERE singleton");
      expect((await route()).json().targets[0].url).toContain("mdbase-next-hosted-mig-lab");
      await db.query("UPDATE next_migration_cohort_members SET terminal_excluded_at=now() WHERE account_id=$1", [own.id]);
      expect(await migrationRoute(db, routing, own.id)).toBe("default");
      expect((await route()).json().targets[0].url).toContain("hosted.example");
      expect((await state([own.id], routing.inboundToken)).statusCode).toBe(403);
      expect((await state([own.id], normalToken)).statusCode).toBe(200);
    } finally { await scoped.close(); }
  });
  async function releasedFrozenMember(account: string) {
    const cohort = `routing-${randomUUID().slice(0, 8)}`;
    await db.query("INSERT INTO next_migration_cohorts(name,released_at,frozen_at) VALUES($1,now(),now())", [cohort]);
    await db.query("INSERT INTO next_migration_cohort_members(account_id,cohort) VALUES($1,$2)", [account, cohort]);
  }
  const normalDeployments = { hosted: { url: "https://hosted-cp.example", token: "n".repeat(40) }, escrow: { url: "https://escrow.example", token: "e".repeat(40) } };
  async function wakes(routing: MigrationRouting, collection: string) {
    const seen: string[] = [];
    await db.query("UPDATE next_service_devices SET activation_batch_id=0, activation_attempt_batch_id=0, activation_next_at=now() WHERE collection_id=$1", [collection]);
    await activatePendingServices(db, normalDeployments, async url => { seen.push(new URL(String(url)).origin); return Response.json({ activated: true }); }, collection, undefined, routing);
    return seen;
  }

  it("staging: routes a migrated owner's app sessions, wakes and record reads to the staging migration Worker after the flip", async () => {
    const own = await fixture({ hostedOnly: true });
    const routing: MigrationRouting = { environment: "staging", accounts: new Set(), hosted: { url: "https://mdbase-next-hosted-mig-staging.example.workers.dev", token: "m".repeat(40) }, inboundToken: "i".repeat(40) };
    const scoped = Fastify(), normalToken = "H".repeat(40);
    registerNextRouteRoutes(scoped, { db, publicUrl: "https://connect-staging.mdbase.dev", broker, hostedClientUrl: "https://hosted.example", migrationRouting: routing });
    registerNextHostedRoutes(scoped, { db, tokens: { hosted: normalToken }, migrationRouting: routing });
    const route = () => scoped.inject({ method: "GET", url: `/v1/next/collections/${own.id}/route`, headers: { authorization: `Bearer ${own.token}` } });
    const state = (token: string) => scoped.inject({ method: "GET", url: `/internal/v1/next/collections/${own.id}/state`, headers: { authorization: `Bearer ${token}` } });
    try {
      await releasedFrozenMember(own.id);
      // Started, flipped to the next backend, and the global rollout paused: still served by the migration Worker.
      await db.query("UPDATE next_migration_cohort_members SET started_at=now() WHERE account_id=$1", [own.id]);
      await db.query("UPDATE users SET account_backend='next' WHERE id=$1", [own.id]);
      await db.query("UPDATE next_migration_rollout SET paused=true WHERE singleton");
      expect(await migrationRoute(db, routing, own.id)).toBe("migration");
      expect((await route()).json().targets[0].url).toBe(`wss://mdbase-next-hosted-mig-staging.example.workers.dev/v1/hosted/app?collection=${own.id}`);
      expect(await wakes(routing, own.id)).toEqual([routing.hosted.url]);
      expect((await state(routing.inboundToken)).statusCode).toBe(200);
      expect((await state(normalToken)).statusCode).toBe(403);
    } finally {
      await db.query("UPDATE next_migration_rollout SET paused=false WHERE singleton");
      await scoped.close();
    }
  });

  it("LAB cleanup retires a disposed fixture's migration route: no app route, wake or record read remains", async () => {
    const own = await fixture({ hostedOnly: true }), outside = await fixture({ hostedOnly: true });
    const routing: MigrationRouting = { environment: "lab", accounts: new Set(), hosted: { url: "https://mdbase-next-hosted-mig-lab.example.workers.dev", token: "m".repeat(40) }, inboundToken: "i".repeat(40) };
    const scoped = Fastify(), normalToken = "H".repeat(40), migrationToken = "M".repeat(40);
    registerNextRouteRoutes(scoped, { db, publicUrl: "https://connect-lab.mdbase.dev", broker, hostedClientUrl: "https://hosted.example", migrationRouting: routing });
    registerNextHostedRoutes(scoped, { db, tokens: { hosted: normalToken }, migrationRouting: routing });
    registerMigrationRouteRetireRoute(scoped, { db, token: migrationToken, routing });
    const route = () => scoped.inject({ method: "GET", url: `/v1/next/collections/${own.id}/route`, headers: { authorization: `Bearer ${own.token}` } });
    const state = (token: string) => scoped.inject({ method: "GET", url: `/internal/v1/next/collections/${own.id}/state`, headers: { authorization: `Bearer ${token}` } });
    const retire = (id: string, token = migrationToken) => scoped.inject({ method: "POST", url: `/internal/v1/next/migration/collections/${id}/routing/retire`,
      headers: { authorization: `Bearer ${token}` }, payload: { actor: "lab-cleanup", reason: "fixture disposed" } });
    try {
      await releasedFrozenMember(own.id);
      expect((await route()).json().targets[0].url).toContain("mdbase-next-hosted-mig-lab");
      expect(await wakes(routing, own.id)).toEqual([routing.hosted.url]);
      expect((await retire(own.id, normalToken)).statusCode).toBe(401);
      expect((await retire(own.id, routing.inboundToken)).statusCode).toBe(401);
      expect((await retire(outside.id)).json()).toMatchObject({ error: { code: "not_migration_routed" } });
      expect((await retire(randomUUID())).statusCode).toBe(409);
      const first = await retire(own.id);
      expect(first.statusCode, first.body).toBe(200);
      expect(first.json()).toMatchObject({ collection_id: own.id });
      const again = await retire(own.id);
      expect(again.json()).toEqual(first.json());
      expect((await db.query("SELECT 1 FROM audit_events WHERE event_type='next_migration.routing_retired' AND subject_id=$1", [own.id])).rows).toHaveLength(1);
      expect(await migrationRoute(db, routing, own.id)).toBe("retired");
      // No fallback to the default hosted deployment, and no wake of either deployment.
      expect((await route()).statusCode).toBe(401);
      expect(await wakes(routing, own.id)).toEqual([]);
      expect((await state(routing.inboundToken)).statusCode).toBe(403);
      expect((await state(normalToken)).statusCode).toBe(403);
      // Other routed and unrouted collections are untouched.
      expect(await wakes(routing, outside.id)).toEqual([normalDeployments.hosted.url]);
    } finally { await scoped.close(); }
  });

  it("the cleanup route is mounted in LAB only", async () => {
    const own = await fixture({ hostedOnly: true });
    await releasedFrozenMember(own.id);
    const routing: MigrationRouting = { environment: "staging", accounts: new Set(), hosted: { url: "https://mdbase-next-hosted-mig-staging.example.workers.dev", token: "m".repeat(40) }, inboundToken: "i".repeat(40) };
    const scoped = Fastify();
    registerMigrationRouteRetireRoute(scoped, { db, token: "M".repeat(40), routing });
    try {
      expect((await scoped.inject({ method: "POST", url: `/internal/v1/next/migration/collections/${own.id}/routing/retire`,
        headers: { authorization: `Bearer ${"M".repeat(40)}` }, payload: { actor: "a", reason: "r" } })).statusCode).toBe(404);
      expect(await migrationRoute(db, routing, own.id)).toBe("migration");
    } finally { await scoped.close(); }
  });

  it("puts the exact fixed-path hosted target first and preserves daemon fallback; online remains false", async () => {
    const f = await fixture({ daemon: true });
    const response = await f.route(f.id.toUpperCase());
    expect(response.statusCode).toBe(200);
    expect(response.json().targets.map((target: { kind: string }) => target.kind)).toEqual(["hosted", "desktop"]);
    expect(response.json().targets[0]).toEqual({ kind: "hosted", device: f.record.device_id, noise_pk: f.record.noise_pk.toString("hex"), url: `wss://hosted.example/v1/hosted/app?collection=${f.id}`, online: false });
    await db.query("UPDATE next_service_devices SET activated_at=now(),activation_batch_id=$2 WHERE collection_id=$1", [f.id, f.batch]);
    expect((await f.route()).json().targets[0].online).toBe(false);
  });

  it("routes only the authoritative rehearsal owner; account spoof and foreign grants cannot redirect", async () => {
    const own = await fixture({ hostedOnly: true });
    const other = await fixture({ hostedOnly: true });
    const routing: MigrationRouting = { environment: "lab", accounts: new Set([own.id]), hosted: { url: "https://mdbase-next-hosted-mig-lab.example.workers.dev", token: "m".repeat(40) }, inboundToken: "i".repeat(40) };
    const scoped = Fastify();
    registerNextRouteRoutes(scoped, { db, publicUrl: "https://connect.example", broker, hostedClientUrl: "https://hosted.example", migrationRouting: routing });
    try {
      const route = (id: string, token: string, query = "") => scoped.inject({ method: "GET", url: `/v1/next/collections/${id}/route${query}`, headers: { authorization: `Bearer ${token}` } });
      expect((await route(own.id, own.token)).json().targets[0].url).toBe(`wss://mdbase-next-hosted-mig-lab.example.workers.dev/v1/hosted/app?collection=${own.id}`);
      expect((await route(other.id, other.token, `?account=${own.id}`)).json().targets[0].url).toBe(`wss://hosted.example/v1/hosted/app?collection=${other.id}`);
      expect((await route(other.id, own.token)).statusCode).toBe(401);
      expect((await route(own.id, other.token)).statusCode).toBe(401);
      expect(await migrationRoute(db, routing, own.id)).toBe("migration");
      expect(await migrationRoute(db, routing, other.id)).toBe("default");
      await expect(migrationRoute(db, routing, other.id, own.id)).rejects.toThrow("foreign_collection_owner");
    } finally { await scoped.close(); }
  });

  it("isolates real authoritative inbound state batches by deployment credential", async () => {
    const own = await fixture({ hostedOnly: true });
    const other = await fixture({ hostedOnly: true });
    const routing: MigrationRouting = { environment: "lab", accounts: new Set([own.id]), hosted: { url: "https://mdbase-next-hosted-mig-lab.example.workers.dev", token: "m".repeat(40) }, inboundToken: "i".repeat(40) };
    const scoped = Fastify();
    const normalToken = "H".repeat(40);
    registerNextHostedRoutes(scoped, { db, tokens: { hosted: normalToken }, migrationRouting: routing });
    try {
      const state = (ids: string[], token: string) => scoped.inject({ method: "POST", url: "/internal/v1/next/collections/states", headers: { authorization: `Bearer ${token}` }, payload: { ids } });
      expect((await state([own.id], routing.inboundToken)).statusCode).toBe(200);
      expect((await state([other.id], normalToken)).statusCode).toBe(200);
      for (const token of [normalToken, routing.inboundToken]) expect((await state([own.id, other.id], token)).statusCode).toBe(403);
      expect((await state([other.id], routing.inboundToken)).statusCode).toBe(403);
      expect((await state([own.id], normalToken)).statusCode).toBe(403);
    } finally { await scoped.close(); }
  });

  it("routes multiple allowlisted owners and refuses mixed deployment-scope state batches", async () => {
    const a = await fixture({ hostedOnly: true }), b = await fixture({ hostedOnly: true }), outside = await fixture({ hostedOnly: true });
    const routing: MigrationRouting = { environment: "lab", accounts: new Set([a.id, b.id]), hosted: { url: "https://mdbase-next-hosted-mig-lab.example.workers.dev", token: "m".repeat(40) }, inboundToken: "i".repeat(40) };
    const app = Fastify(), normalToken = "H".repeat(40);
    registerNextRouteRoutes(app, { db, publicUrl: "https://connect.example", broker, hostedClientUrl: undefined, migrationRouting: routing });
    registerNextHostedRoutes(app, { db, tokens: { hosted: normalToken }, migrationRouting: routing });
    try {
      for (const f of [a, b]) {
        const response = await app.inject({ method: "GET", url: `/v1/next/collections/${f.id}/route`, headers: { authorization: `Bearer ${f.token}` } });
        expect(response.statusCode, response.body).toBe(200);
        expect(response.json().targets[0].url).toBe(`wss://mdbase-next-hosted-mig-lab.example.workers.dev/v1/hosted/app?collection=${f.id}`);
      }
      expect((await app.inject({ method: "GET", url: `/v1/next/collections/${outside.id}/route`, headers: { authorization: `Bearer ${outside.token}` } })).statusCode).toBe(401);
      const state = (ids: string[], credential: string) => app.inject({ method: "POST", url: "/internal/v1/next/collections/states", headers: { authorization: `Bearer ${credential}` }, payload: { ids } });
      expect((await state([a.id, b.id], routing.inboundToken)).statusCode).toBe(200);
      expect((await state([a.id, b.id], normalToken)).statusCode).toBe(403);
      for (const credential of [routing.inboundToken, normalToken]) expect((await state([a.id, outside.id], credential)).statusCode).toBe(403);
    } finally { await app.close(); }
  });

  it("supports hosted-only grants without a daemon authority row", async () => {
    const f = await fixture({ hostedOnly: true });
    const response = await f.route();
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ collection: f.id, grant: f.logGrant, authorization_grant: f.id, targets: [{ kind: "hosted", device: f.record.device_id }] });
    await db.query("UPDATE hosted_collections SET authority_state='transferring' WHERE id=$1", [f.id]);
    expect((await f.route()).statusCode).toBe(401);
  });

  it("hosted-only routes require an active binding and return only the replacement log UUID after narrowing", async () => {
    const f = await fixture({ hostedOnly: true, narrowable: true });
    expect((await f.route()).json()).toMatchObject({ grant: f.logGrant, authorization_grant: f.id });
    const client = await db.connect(); let narrowed: string | null;
    try {
      await client.query("BEGIN");
      await client.query("UPDATE grants SET operations=$2,file_capability=$3 WHERE id=$1", [f.id,
        JSON.stringify(APPLICATION_CAPABILITY_DEFINITIONS["collection.read"]),
        JSON.stringify({ kind: "files", protocol_version: 1, actions: ["list", "read"], scope: { kind: "collection" } })]);
      narrowed = await queueNextGrantPolicy(client, f.id);
      await client.query("COMMIT");
    } finally { await client.query("ROLLBACK"); client.release(); }
    expect(narrowed!).not.toBe(f.logGrant);
    const response = await f.route();
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ grant: narrowed!, authorization_grant: f.id, targets: [{ kind: "hosted" }] });
    expect(response.json().grant).not.toBe(f.logGrant);
    expect((await f.route(f.id, f.logGrant!)).statusCode).toBe(401);
    const outbox = (await db.query<{ ops: { ops: { op: string; grant: string }[] } }>("SELECT ops FROM next_policy_outbox WHERE collection_id=$1 ORDER BY id DESC LIMIT 1", [f.id])).rows[0]!;
    expect(outbox.ops.ops.map(({ op, grant }) => ({ op, grant }))).toEqual([{ op: "grant-revoke", grant: f.logGrant }, { op: "grant", grant: narrowed! }]);
    await db.query("UPDATE next_grant_bindings SET active=false WHERE grant_id=$1", [f.id]);
    expect((await f.route()).statusCode).toBe(409);
    expect((await f.route()).json().error.code).toBe("application_reauthorization_required");
    await db.query("DELETE FROM next_grant_bindings WHERE grant_id=$1", [f.id]);
    expect((await f.route()).statusCode).toBe(409);
  });

  it("a recorded/pending/lost enrolment does not create a target, and a later appended revoke removes it", async () => {
    const f = await fixture({ appended: false, daemon: true });
    expect((await f.route()).json().targets.map((target: { kind: string }) => target.kind)).toEqual(["desktop"]);
    await db.query("UPDATE next_policy_batches SET state='appended' WHERE id=$1", [f.batch]);
    expect((await f.route()).json().targets[0].kind).toBe("hosted");
    await db.query("UPDATE next_policy_batches SET lost_at=now() WHERE id=$1", [f.batch]);
    expect((await f.route()).json().targets.map((target: { kind: string }) => target.kind)).toEqual(["desktop"]);
    await db.query("UPDATE next_policy_batches SET lost_at=NULL WHERE id=$1", [f.batch]);
    const ops: PolicyOp[] = [{ op: "device-revoke", device: f.record.device_id }];
    await queueNextPolicy(db, f.id, ops); await append(f.id, 2, ops);
    expect((await f.route()).json().targets.map((target: { kind: string }) => target.kind)).toEqual(["desktop"]);
  });

  it("private, shadow and left-sync collections never disclose a hosted target", async () => {
    for (const options of [{ sync: "private" as const }, { runtime: "shadow" as const }]) {
      const f = await fixture({ ...options, daemon: true });
      expect((await f.route()).json().targets.every((target: { kind: string }) => target.kind !== "hosted")).toBe(true);
    }
    const f = await fixture({ daemon: true });
    await db.query("UPDATE next_collections SET left_sync_at=now() WHERE collection_id=$1", [f.id]);
    expect((await f.route()).json().targets.every((target: { kind: string }) => target.kind !== "hosted")).toBe(true);
  });

  it("requires the exact live token/grant/account/key and denies other collections", async () => {
    const f = await fixture({ hostedOnly: true });
    expect((await f.route(randomUUID())).statusCode).toBe(401);
    expect((await f.route(f.id, "unknown-token")).statusCode).toBe(401);
    await db.query("DELETE FROM next_grant_client_keys WHERE grant_id=$1", [f.id]);
    expect((await f.route()).statusCode).toBe(409);
    await db.query("INSERT INTO next_grant_client_keys(grant_id,client_pk) VALUES($1,$2)", [f.id, randomBytes(32)]);
    await db.query("UPDATE users SET suspended_at=now() WHERE id=$1", [f.id]);
    expect((await f.route()).statusCode).toBe(401);
    await db.query("UPDATE users SET suspended_at=NULL WHERE id=$1", [f.id]);
    await db.query("UPDATE access_tokens SET revoked_at=now() WHERE token_hash=$1", [tokenHash(f.token)]);
    expect((await f.route()).statusCode).toBe(401);
  });

  it("shared grants require the exact active member-policy binding and an unsuspended owner", async () => {
    const f = await fixture({ hostedOnly: true }); const member = randomUUID();
    await db.query("INSERT INTO users(id,email,name) VALUES($1,$2,'Member')", [member, `${member}@example.test`]);
    const policy = await createHostedCollectionMembership(db, { collectionId: f.id, ownerUserId: f.id, userId: member, role: "viewer" });
    await db.query("UPDATE grants SET user_id=$2,membership_id=$3,membership_policy_id=$4,membership_policy_revision=$5 WHERE id=$1", [f.id, member, policy.membershipId, policy.id, policy.revision]);
    expect((await f.route()).json().targets[0].kind).toBe("hosted");
    const nextPolicy = randomUUID();
    await db.query(`INSERT INTO collection_membership_policies
      (id,membership_id,revision,role,preset_version,actions,operations,scope_ceiling,file_ceiling)
      SELECT $2,membership_id,2,role,preset_version,actions,operations,scope_ceiling,file_ceiling
      FROM collection_membership_policies WHERE id=$1`, [policy.id, nextPolicy]);
    await db.query("UPDATE collection_memberships SET current_policy_id=$2,current_policy_revision=2 WHERE id=$1", [policy.membershipId, nextPolicy]);
    expect((await f.route()).statusCode).toBe(401);
    await db.query("UPDATE collection_memberships SET current_policy_id=$2,current_policy_revision=$3 WHERE id=$1", [policy.membershipId, policy.id, policy.revision]);
    await db.query("UPDATE collection_memberships SET state='revoking' WHERE id=$1", [policy.membershipId]);
    expect((await f.route()).statusCode).toBe(401);
    await db.query("UPDATE collection_memberships SET state='active' WHERE id=$1", [policy.membershipId]);
    await db.query("UPDATE users SET suspended_at=now() WHERE id=$1", [f.id]);
    expect((await f.route()).statusCode).toBe(401);
  });

  it("waits behind a cloud-copy transition and never returns pre-lock metadata after leave commits", async () => {
    const f = await fixture({ daemon: true }); const lock = await db.connect(); let pending: ReturnType<typeof f.route> | undefined;
    try {
      await lock.query("BEGIN");
      const pid = (await lock.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
      await lock.query("UPDATE next_collections SET left_sync_at=now() WHERE collection_id=$1", [f.id]);
      pending = f.route();
      const deadline = Date.now() + 4000; let blocked = false;
      while (Date.now() < deadline) {
        const rows = await admin.query("SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))", [pid]);
        if (rows.rowCount) { blocked = true; break; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(blocked).toBe(true);
      await lock.query("COMMIT");
      expect((await pending).json().targets.map((target: { kind: string }) => target.kind)).toEqual(["desktop"]);
    } finally { await lock.query("ROLLBACK"); lock.release(); await pending; }
  });

  it("never uses a mismatched/zero service key or an unappended replacement as a current target", async () => {
    const f = await fixture({ daemon: true });
    await db.query("UPDATE next_service_devices SET noise_pk=$2 WHERE collection_id=$1", [f.id, Buffer.alloc(32)]);
    expect((await f.route()).json().targets.map((target: { kind: string }) => target.kind)).toEqual(["desktop"]);
    await db.query("UPDATE next_service_devices SET noise_pk=$2 WHERE collection_id=$1", [f.id, randomBytes(32)]);
    expect((await f.route()).json().targets.map((target: { kind: string }) => target.kind)).toEqual(["desktop"]);
    const noise = randomBytes(32);
    await db.query("UPDATE next_service_devices SET noise_pk=$2 WHERE collection_id=$1", [f.id, noise]);
    const ops: PolicyOp[] = [{ op: "device-enrol", device: f.record.device_id, account: "00000000-0000-0000-0000-000000000000", kind: "hosted", signPublicKey: f.record.sign_pk, kemPublicKey: f.record.kem_pk, noisePublicKey: noise }];
    await queueNextPolicy(db, f.id, ops); const replacement = await append(f.id, 2, ops, "sending");
    expect((await f.route()).json().targets.map((target: { kind: string }) => target.kind)).toEqual(["desktop"]);
    await db.query("UPDATE next_policy_batches SET state='appended' WHERE id=$1", [replacement]);
    expect((await f.route()).json().targets[0].noise_pk).toBe(noise.toString("hex"));
  });
});
