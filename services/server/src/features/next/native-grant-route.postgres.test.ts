import { createHash, randomBytes, randomUUID } from "node:crypto";
import cookie from "@fastify/cookie";
import Fastify from "fastify";
import { capabilityOperations } from "@mdbase-dev/connect-protocol";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, type DatabasePool } from "../../db.js";
import { LocalRelayBroker, type RelayBrokerReply } from "../../relay-broker.js";
import { tokenHash } from "../../security.js";
import { grantApprovalTerms } from "./grant-approval.js";
import { nativeAdmission } from "./native-grant-target.js";
import { queueNextPolicy, registerNextCollection } from "./policy-outbox.js";
import { registerNextRouteRoutes } from "./route-routes.js";
import { legacyTimerGrantResolver } from "./timers/grants.js";
import { createHostedCollectionMembership } from "../../collection-policy.js";
import { revokeHostedCollectionMembership } from "../../collection-membership-lifecycle.js";
import { createTestApplicationIdentity, testApplicationAuthorization } from "../../application-authorization.test-helper.js";
import { registerApplicationManifest } from "../../manifest.js";
import { registerAuthorizationRoutes } from "../authorizations/routes.js";
import { registerErrorHandler } from "../../platform/error-handler.js";
import type { RelayHub } from "../../relay.js";
import { pkceChallenge } from "../../security.js";

const testUrl = process.env.MDBASE_CONNECT_TEST_DATABASE_URL;
const approved = process.env.MDBASE_CONNECT_DESTRUCTIVE_TEST_APPROVAL === "I APPROVE MDBASE CONNECT DESTRUCTIVE POSTGRES TESTS";
const describePostgres = testUrl && approved ? describe : describe.skip;
const ROOT = Buffer.alloc(16, 5);
const OPERATIONS: string[] = [...capabilityOperations("collection.read")];

describePostgres("Private native collection grants", () => {
  let admin: pg.Pool;
  let db: DatabasePool;
  let schema: string;
  const app = Fastify();
  const portal = Fastify();
  const broker = new LocalRelayBroker();

  beforeAll(async () => {
    const url = new URL(testUrl!);
    if (!["localhost", "127.0.0.1", "::1"].includes(url.hostname) || !/test/i.test(url.pathname)) throw new Error("Native grant tests require a dedicated local test database.");
    schema = `mdbase_native_grant_test_${randomUUID().replaceAll("-", "")}`;
    admin = new pg.Pool({ connectionString: url.toString(), max: 2 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    url.searchParams.set("options", `-csearch_path=${schema}`);
    db = await createDatabase(url.toString());
    registerNextRouteRoutes(app, { db, publicUrl: "https://connect.example", broker });
    await portal.register(cookie);
    registerErrorHandler(portal);
    const relay = { registerAuthorizationHandler: () => {}, authorizationOffers: async () => ({ paused: false, collections: [] }) };
    registerAuthorizationRoutes(portal, { db, relay: relay as unknown as RelayHub, publicUrl: "https://connect.example", nextClientKeys: true, drainProviderRevocations: async () => {} });
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await portal.close();
    await broker.close();
    await db?.end();
    if (admin && schema) await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin?.end();
  }, 60_000);

  async function user() {
    const id = randomUUID();
    await db.query("INSERT INTO users(id,email,name) VALUES($1,$2,'Fixture')", [id, `${id}@example.test`]);
    return id;
  }

  /** A desktop device of `account` on its own connector. */
  async function device(account: string) {
    const connector = randomUUID();
    const id = randomUUID();
    const keys = { sign_pk: randomBytes(32), kem_pk: randomBytes(32), noise_pk: randomBytes(32) };
    await db.query("INSERT INTO connectors(id,user_id,name,token_hash,relay_generation) VALUES($1,$2,'Desktop',$3,1)", [connector, account, randomUUID()]);
    await db.query("INSERT INTO next_devices(id,connector_id,user_id,kind,sign_pk,kem_pk,noise_pk) VALUES($1,$2,$3,'desktop',$4,$5,$6)",
      [id, connector, account, keys.sign_pk, keys.kem_pk, keys.noise_pk]);
    return { id, connector, account, ...keys };
  }
  type Device = Awaited<ReturnType<typeof device>>;
  const enrol = (d: Device) => ({ op: "device-enrol" as const, device: d.id, account: d.account, kind: "desktop" as const,
    signPublicKey: d.sign_pk, kemPublicKey: d.kem_pk, noisePublicKey: d.noise_pk });

  async function appendPending(collection: string) {
    const seq = Number((await db.query<{ n: string }>("SELECT count(*) AS n FROM next_policy_batches WHERE collection_id = $1", [collection])).rows[0]!.n) + 1;
    const batch = await db.query<{ id: string }>(
      "INSERT INTO next_policy_batches(collection_id,seq,prev,item,issued_at,state,appended_at) VALUES($1,$2,$3,$4,$5,'appended',now()) RETURNING id",
      [collection, seq, Buffer.alloc(32), Buffer.from([seq]), seq]
    );
    await db.query("UPDATE next_policy_outbox SET batch_id = $1 WHERE collection_id = $2 AND batch_id IS NULL", [batch.rows[0]!.id, collection]);
  }

  /** A Private collection owned by `owner`, enrolling `devices`, appended to the log. */
  async function privateCollection(owner: string, devices: Device[]) {
    const collection = randomUUID();
    await registerNextCollection(db, { collectionId: collection, ownerUserId: owner, runtime: "next", sync: "private", rootKeyId: ROOT, displayName: "Journal",
      ops: [{ op: "genesis", owner, root: ROOT, state: "e2e" }, { op: "member-set", account: owner, role: "owner" }, ...devices.map(enrol)] });
    await appendPending(collection);
    return collection;
  }

  /** An activated, keyed native grant with a published binding and an access token. */
  async function nativeGrant(account: string, collection: string) {
    const grant = randomUUID();
    const clientPk = randomBytes(32);
    await db.query("INSERT INTO applications(id,canonical_identity,name,homepage,redirect_uris) VALUES($1::uuid,$1::text,'Journal','https://journal.example','[]')", [grant]);
    await db.query(`INSERT INTO grants(id,user_id,application_id,next_collection_id,operations,scope,file_capability,application_installation_id,application_authorization,activated_at)
      VALUES($1,$2,$1,$3,$4::jsonb,'{"access":"full_collection","contracts":[]}',
      '{"kind":"files","protocol_version":1,"actions":["list","read"],"scope":{"kind":"collection"}}','installation-1',
      '{"binding":{"protocol_version":4,"application_declaration_id":"dev.mdbase.journal","contracts":{"semantic_capabilities":2}}}',now())`,
    [grant, account, collection, JSON.stringify(OPERATIONS)]);
    await db.query("INSERT INTO next_grant_client_keys(grant_id, client_pk) VALUES($1,$2)", [grant, clientPk]);
    const logGrant = randomUUID();
    await db.query("INSERT INTO next_grant_bindings(grant_id,collection_id,log_grant_id,terms_digest) VALUES($1,$2,$3,$4)", [grant, collection, logGrant, Buffer.alloc(32)]);
    const token = `at_${randomUUID()}`;
    await db.query("INSERT INTO access_tokens(id,token_hash,grant_id,expires_at) VALUES($1,$2,$3,now() + interval '1 hour')", [randomUUID(), tokenHash(token), grant]);
    const route = async () => (await app.inject({ method: "GET", url: `/v1/next/collections/${collection}/route`, headers: { authorization: `Bearer ${token}` } }));
    const list = async () => (await app.inject({ method: "GET", url: "/v1/next/apps/collections", headers: { authorization: `Bearer ${token}` } })).json().collections as Array<Record<string, unknown>>;
    /** What a device reports after signing the grant approval into the log. */
    const approve = async (by: Device) => {
      const files = (await db.query("SELECT file_capability FROM grants WHERE id = $1", [grant])).rows[0].file_capability;
      const terms = createHash("sha256").update(JSON.stringify([logGrant, grant, [...OPERATIONS].sort(), files, clientPk.toString("hex")])).digest();
      await db.query("INSERT INTO next_grant_approvals(grant_id,device_id,approved_seq,capabilities,terms_digest,signature) VALUES($1,$2,9,'{}',$3,$4)",
        [grant, by.id, terms, Buffer.alloc(64)]);
    };
    return { grant, logGrant, token, route, list, approve };
  }

  /** The relay owner for `d` answers presence (online, optionally with a legacy connector still running). */
  async function online(d: Device, detail?: Record<string, unknown>) {
    return broker.bind({ connectorId: d.connector, generation: "1",
      handle: async (command): Promise<RelayBrokerReply> => ({ version: 1, ok: true,
        value: command.kind === "device_presence" && (command.message as { device_id: string }).device_id === d.id, ...(detail ? { detail } : {}) }),
      handleBinary: async () => ({ version: 1, ok: true, value: new Uint8Array() }), replaced: () => {} });
  }

  it("gives every grant exactly one target", async () => {
    const owner = await user();
    const collection = await privateCollection(owner, []);
    await db.query("INSERT INTO applications(id,canonical_identity,name,homepage,redirect_uris) VALUES($1::uuid,$1::text,'App','https://app.example','[]')", [owner]);
    const insert = (target: string) => db.query(`INSERT INTO grants(id,user_id,application_id,${target},operations,application_installation_id,application_authorization)
      VALUES($1,$2,$2,$3,'["read"]','i','{"binding":{"protocol_version":4}}')`, [randomUUID(), owner, collection]);
    await expect(insert("next_collection_id")).resolves.toBeDefined();
    await expect(db.query(`INSERT INTO grants(id,user_id,application_id,operations) VALUES($1,$2,$2,'["read"]')`, [randomUUID(), owner])).rejects.toThrow(/grants_collection_target_check/);
    // A native grant always carries a signed application authorization.
    await expect(db.query(`INSERT INTO grants(id,user_id,application_id,next_collection_id,operations) VALUES($1,$2,$2,$3,'["read"]')`,
      [randomUUID(), owner, collection])).rejects.toThrow(/grants_next_application_authorization_required/);
  });

  it("lists and routes a Private collection to the account's enrolled desktop through the relay", async () => {
    const owner = await user();
    const desktop = await device(owner);
    const collection = await privateCollection(owner, [desktop]);
    const g = await nativeGrant(owner, collection);
    const binding = await online(desktop);
    try {
      // The device has not approved the grant yet: the replica would refuse the app.
      expect((await g.route()).json().availability).toEqual({ state: "unavailable", reason: "approval_required" });
      await g.approve(desktop);
      expect((await g.route()).json()).toEqual({
        collection, grant: g.logGrant, authorization_grant: g.grant,
        targets: [{ kind: "desktop", device: desktop.id, noise_pk: desktop.noise_pk.toString("hex"), url: "wss://connect.example/v1/next/relay/client", online: true, relay_collection: collection }],
        availability: { state: "available" }
      });
      expect(await g.list()).toEqual([expect.objectContaining({ collection, name: "Journal", state: "synced_e2e", routable: true, availability: { state: "available" } })]);
      // Relay admission opens the pipe on that device's connector only.
      expect(await nativeAdmission(db, tokenHash(g.token), collection, g.logGrant, desktop.id)).toBe(desktop.connector);
    } finally {
      await binding.close();
    }
  });

  it("reports an offline desktop, an outdated desktop and a legacy connector still running", async () => {
    const owner = await user();
    const desktop = await device(owner);
    const collection = await privateCollection(owner, [desktop]);
    const g = await nativeGrant(owner, collection);
    await g.approve(desktop);
    const offline = (await g.route()).json();
    expect(offline.availability).toEqual({ state: "unavailable", reason: "device_offline" });
    expect(offline.targets[0]).toMatchObject({ device: desktop.id, online: false });
    // The relay refused its last connection as an incompatible version.
    await db.query(`UPDATE connectors SET incompatibility_code = 'connector_upgrade_required', last_incompatible_at = now(),
      minimum_connector_version = '9.0.0', connector_update_url = 'https://mdbase.example/download' WHERE id = $1`, [desktop.connector]);
    expect((await g.route()).json().availability).toEqual({ state: "unavailable", reason: "desktop_update_required" });
    await db.query("UPDATE connectors SET incompatibility_code = NULL, last_incompatible_at = NULL WHERE id = $1", [desktop.connector]);
    const binding = await online(desktop, { old_connector_running: true });
    try {
      expect((await g.route()).json().availability).toEqual({ state: "unavailable", reason: "old_connector_running" });
    } finally {
      await binding.close();
    }
  });

  it("refuses other accounts' devices, unenrolled devices, revoked devices and non-members", async () => {
    const owner = await user();
    const desktop = await device(owner);
    const unenrolled = await device(owner);
    const stranger = await user();
    const strangerDesktop = await device(stranger);
    const collection = await privateCollection(owner, [desktop, strangerDesktop]);
    const g = await nativeGrant(owner, collection);
    const devices = (await g.route()).json().targets.map((target: { device: string }) => target.device);
    expect(devices).toEqual([desktop.id]);
    for (const other of [unenrolled, strangerDesktop]) {
      expect(await nativeAdmission(db, tokenHash(g.token), collection, g.logGrant, other.id)).toBeNull();
    }
    // A token for this grant opens nothing on another collection.
    const other = await privateCollection(owner, [desktop]);
    expect((await app.inject({ method: "GET", url: `/v1/next/collections/${other}/route`, headers: { authorization: `Bearer ${g.token}` } })).statusCode).toBe(401);
    expect(await nativeAdmission(db, tokenHash(g.token), other, g.logGrant, desktop.id)).toBeNull();
    // A revoked device is never a target again.
    await queueNextPolicy(db, collection, [{ op: "device-revoke", device: desktop.id }]);
    expect((await g.route()).json()).toMatchObject({ targets: [], availability: { state: "unavailable", reason: "no_device_registered" } });
    expect(await nativeAdmission(db, tokenHash(g.token), collection, g.logGrant, desktop.id)).toBeNull();
    // A grant of an account that is no longer a member must be set up again.
    const member = await user();
    const memberDesktop = await device(member);
    const shared = await privateCollection(owner, [memberDesktop]);
    await queueNextPolicy(db, shared, [{ op: "member-set", account: member, role: "editor" }]);
    await appendPending(shared);
    const memberGrant = await nativeGrant(member, shared);
    expect((await memberGrant.route()).json().targets).toHaveLength(1);
    await queueNextPolicy(db, shared, [{ op: "member-remove", account: member }]);
    expect((await memberGrant.route()).json()).toMatchObject({ targets: [], availability: { state: "unavailable", reason: "access_removed" } });
    expect(await nativeAdmission(db, tokenHash(memberGrant.token), shared, memberGrant.logGrant, memberDesktop.id)).toBeNull();
  });

  it("asks to set up again a grant whose legacy collection was taken over", async () => {
    const owner = await user();
    const legacy = randomUUID();
    await db.query("INSERT INTO connectors(id,user_id,name,token_hash,relay_generation,revoked_at) VALUES($1,$2,'Old',$3,1,now())", [legacy, owner, randomUUID()]);
    const collection = await privateCollection(owner, []);
    const row = randomUUID();
    await db.query(`INSERT INTO collections(id,user_id,connector_id,local_id,display_name,spec_version,enabled,present,authority_state)
      VALUES($1,$2,$3,$4,'Journal','0.3.0',false,true,'retired')`, [row, owner, legacy, collection]);
    await db.query("INSERT INTO applications(id,canonical_identity,name,homepage,redirect_uris) VALUES($1::uuid,$1::text,'Journal','https://journal.example','[]')", [row]);
    await db.query(`INSERT INTO grants(id,user_id,application_id,collection_id,operations,application_installation_id,application_authorization,activated_at)
      VALUES($1,$2,$1,$1,'["read"]','installation-1','{"binding":{"protocol_version":4}}',now())`, [row, owner]);
    const token = `at_${randomUUID()}`;
    await db.query("INSERT INTO access_tokens(id,token_hash,grant_id,expires_at) VALUES($1,$2,$3,now() + interval '1 hour')", [randomUUID(), tokenHash(token), row]);
    const response = await app.inject({ method: "GET", url: `/v1/next/collections/${collection}/route`, headers: { authorization: `Bearer ${token}` } });
    expect([response.statusCode, response.json()]).toEqual([200, { collection, grant: row, targets: [], availability: { state: "unavailable", reason: "sync_required" } }]);
    const listed = (await app.inject({ method: "GET", url: "/v1/next/apps/collections", headers: { authorization: `Bearer ${token}` } })).json().collections;
    expect(listed).toEqual([expect.objectContaining({ collection, routable: false, availability: { state: "unavailable", reason: "sync_required" } })]);
  });

  it("gives a device of the granting account the approval terms, and nobody else", async () => {
    const owner = await user();
    const desktop = await device(owner);
    const collection = await privateCollection(owner, [desktop]);
    const g = await nativeGrant(owner, collection);
    const terms = await grantApprovalTerms(db, { id: desktop.connector, user_id: owner }, g.logGrant);
    expect(terms).toMatchObject({ grant: g.logGrant, authorization_grant: g.grant, collection, app: { name: "Journal", declaration_id: "dev.mdbase.journal" }, folders: null, capabilities: ["collection.read"] });
    expect(terms!.client_fp).toMatch(/^[0-9a-f]{64}$/);
    const stranger = await user();
    const strangerDesktop = await device(stranger);
    expect(await grantApprovalTerms(db, { id: strangerDesktop.connector, user_id: stranger }, g.logGrant)).toBeNull();
  });

  /** A registered web app that asks for read access, and its consent requests. */
  let apps = 0;
  async function webApp() {
    const declaration = `dev.mdbase.private-web${++apps}`;
    const files = { actions: ["list", "read"] as Array<"list" | "read">, scope: { kind: "collection" as const } };
    const manifest = registerApplicationManifest({ manifest_version: 1, id: declaration, name: "Private web", distribution: "web", homepage: "https://app.example", redirect_uris: ["https://app.example/callback"],
      requirements: { contracts: [], access: "full_collection", files: { required: ["list", "read"], scope: files.scope },
        capabilities: { contract_version: 2, required: ["collection.read"] } } });
    const application = randomUUID();
    await db.query(`INSERT INTO applications (id, canonical_identity, family_identity, manifest_digest, distribution, name, homepage, redirect_uris,
      requirements, provisions, notifications, application_declaration)
      VALUES ($1, $2, $6, $3, 'web', 'Private web', 'https://app.example', '["https://app.example/callback"]'::jsonb,
      $4::jsonb, '{"type_packs":[],"configuration":[]}'::jsonb, '{"criteria":[]}'::jsonb, $5::jsonb)`,
    [application, `bundle:${declaration}:sha256:${manifest.digest}`, manifest.digest, JSON.stringify(manifest.manifest.requirements), JSON.stringify(manifest.manifest), `bundle:${declaration}`]);
    // One browser profile of the app: every request comes from the same installation.
    const installationIdentity = createTestApplicationIdentity();
    return async (account: string, collection: string) => {
      const proof = await testApplicationAuthorization({ installationIdentity, applicationId: application, applicationDeclarationId: declaration,
        applicationManifestDigest: manifest.digest, flow: "authorization_code", redirectUri: "https://app.example/callback", state: "s",
        codeChallenge: pkceChallenge("private-web-verifier-0000000000000000000000000"), requestedOperations: OPERATIONS as never,
        semanticCapabilityContractVersion: 2, requestedFiles: { ...files, actions: [...files.actions] } });
      const id = proof.binding.authorization_id;
      await db.query(`INSERT INTO authorization_requests (id, user_id, application_id, flow, redirect_uri, state, code_challenge, requested_operations,
        operation_transport_protocol, application_agreement_public_key, application_signing_public_key, application_authorization,
        application_installation_id, expires_at)
        VALUES ($1, $2, $3, 'authorization_code', 'https://app.example/callback', 's', $4, $5::jsonb, $6, $7, $8, $9::jsonb, $10, now() + interval '10 minutes')`,
      [id, account, application, proof.binding.code_challenge, JSON.stringify(OPERATIONS), proof.binding.contracts.operation_transport,
        proof.binding.grant_agreement_public_key, proof.binding.grant_signing_public_key, JSON.stringify(proof), proof.binding.application_installation_id]);
      await db.query("INSERT INTO next_authorization_client_keys (request_id, client_pk, signature) VALUES ($1, $2, $3)", [id, randomBytes(32), randomBytes(64)]);
      const session = randomUUID();
      await db.query(`INSERT INTO sessions (id, user_id, token_hash, provider, account_session_epoch, expires_at)
        VALUES ($1, $2, $3, 'password', COALESCE((SELECT session_epoch FROM users WHERE id = $2), 1), now() + interval '1 day')`, [randomUUID(), account, tokenHash(session)]);
      const headers = { cookie: `mdbase_session=${session}` };
      return {
        id,
        view: () => portal.inject({ method: "GET", url: `/v1/authorization-requests/${id}`, headers }),
        approve: () => portal.inject({ method: "POST", url: `/v1/authorization-requests/${id}/approve`, headers,
          payload: { collection_id: collection, operations: OPERATIONS, file_actions: ["list", "read"] } })
      };
    };
  }

  it("approves a web app on a Private collection as an offer, for members only", async () => {
    const owner = await user();
    const desktop = await device(owner);
    const collection = await privateCollection(owner, [desktop]);
    const request = await webApp();

    // Someone who is not a member neither sees nor can approve the collection.
    const stranger = await request(await user(), collection);
    const strangerView = await stranger.view();
    expect(strangerView.json().collections, strangerView.body).toEqual([]);
    expect((await stranger.approve()).statusCode).toBe(404);
    expect((await db.query("SELECT 1 FROM grants WHERE next_collection_id = $1", [collection])).rows).toHaveLength(0);

    const consent = await request(owner, collection);
    const view = await consent.view();
    expect(view.statusCode, view.body).toBe(200);
    expect(view.json().collections).toEqual([expect.objectContaining({ id: collection, kind: "private", display_name: "Journal",
      authorization: expect.objectContaining({ available: true }) })]);
    const approved = await consent.approve();
    expect(approved.statusCode, approved.body).toBe(200);
    const grant = (await db.query("SELECT g.id, b.log_grant_id, b.active FROM grants g JOIN next_grant_bindings b ON b.grant_id = g.id WHERE g.next_collection_id = $1", [collection])).rows;
    expect(grant).toEqual([expect.objectContaining({ active: true })]);
    // The policy log carries the grant offer; folders never travel in clear.
    const ops = (await db.query("SELECT ops FROM next_policy_outbox WHERE collection_id = $1 AND ops->'ops' @> $2::jsonb", [collection,
      JSON.stringify([{ op: "grant", grant: grant[0].log_grant_id }])])).rows;
    expect(ops).toHaveLength(1);
    expect(JSON.stringify(ops[0].ops)).not.toContain("fileFolders");
    // Approving again replaces the grant: one live grant per installation and collection.
    expect((await (await request(owner, collection)).approve()).statusCode).toBe(200);
    expect((await db.query("SELECT id FROM grants WHERE next_collection_id = $1 AND revoked_at IS NULL", [collection])).rows).toHaveLength(1);
    const live = (await db.query("SELECT * FROM grants WHERE next_collection_id = $1 AND revoked_at IS NULL", [collection])).rows[0];
    await expect(db.query(`INSERT INTO grants(id,user_id,application_id,next_collection_id,operations,application_installation_id,application_authorization)
      VALUES($1,$2,$3,$4,'["read"]',$5,$6::jsonb)`, [randomUUID(), owner, live.application_id, collection, live.application_installation_id, live.application_authorization]))
      .rejects.toThrow(/grants_active_next_application_installation_idx/);
  });

  it("revokes a member's grant with the membership; re-adding the member needs new consent", async () => {
    const owner = await user();
    const member = await user();
    const memberDesktop = await device(member);
    const collection = await privateCollection(owner, [memberDesktop]);
    const membership = await createHostedCollectionMembership(db, { collectionId: collection, ownerUserId: owner, userId: member, role: "editor" });
    await appendPending(collection);
    const request = await webApp();
    expect((await (await request(member, collection)).approve()).statusCode).toBe(200);
    const [first] = (await db.query("SELECT id, membership_id FROM grants WHERE next_collection_id = $1", [collection])).rows;
    expect(first.membership_id).toBe(membership.membershipId);

    await revokeHostedCollectionMembership(db, { collectionId: collection, actorUserId: owner, membershipId: membership.membershipId });
    const revoked = (await db.query("SELECT revoked_at FROM grants WHERE id = $1", [first.id])).rows[0];
    expect(revoked.revoked_at).not.toBeNull();
    // The grant-revoke reaches the collection's log.
    const binding = (await db.query("SELECT log_grant_id FROM next_grant_bindings WHERE grant_id = $1", [first.id])).rows[0];
    expect((await db.query("SELECT 1 FROM next_policy_outbox WHERE collection_id = $1 AND ops->'ops' @> $2::jsonb", [collection,
      JSON.stringify([{ op: "grant-revoke", grant: binding.log_grant_id }])])).rows).toHaveLength(1);

    // Re-adding the member does not revive the old grant.
    await createHostedCollectionMembership(db, { collectionId: collection, ownerUserId: owner, userId: member, role: "editor" });
    await appendPending(collection);
    expect((await db.query("SELECT revoked_at FROM grants WHERE id = $1", [first.id])).rows[0].revoked_at).not.toBeNull();
    expect((await db.query("SELECT 1 FROM grants WHERE next_collection_id = $1 AND revoked_at IS NULL", [collection])).rows).toHaveLength(0);
    expect((await (await request(member, collection)).approve()).statusCode).toBe(200);
    expect((await db.query("SELECT id FROM grants WHERE next_collection_id = $1 AND revoked_at IS NULL", [collection])).rows)
      .toEqual([expect.not.objectContaining({ id: first.id })]);
  });

  it("never lets reminders use a native grant before the device approval", async () => {
    const owner = await user();
    const desktop = await device(owner);
    const collection = await privateCollection(owner, [desktop]);
    const g = await nativeGrant(owner, collection);
    for (const id of [g.grant, g.logGrant]) {
      expect(await legacyTimerGrantResolver.resolve(db, id)).toMatchObject({ grantId: g.grant, state: "e2e", usable: false, collectionIds: [collection] });
    }
  });
});
