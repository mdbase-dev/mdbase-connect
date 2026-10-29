// Takeover -> grant carry-over -> fenced local rollback, end to end on real
// Postgres: every app whose grant was carried over to the Private collection is
// back on its legacy binding, which the old connector's policy feed serves.
import { randomBytes, randomUUID } from "node:crypto";
import Fastify from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { capabilityOperations, RELAY_ENCRYPTION_SUITE } from "@mdbase-dev/connect-protocol";
import { createDatabase, type DatabasePool } from "../../db.js";
import { ensureDevelopmentEntitlement } from "../../entitlements.js";
import { buildPolicySnapshot, type LeasePolicySnapshot } from "../../relay-policy.js";
import { tokenHash } from "../../security.js";
import { carryOverLegacyGrants, carryOverLegacyLocalGrants } from "./legacy-grant-carry-over.js";
import { registerLocalRollbackBindingRoutes } from "./local-rollback-bindings.js";
import { registerLocalTakeoverRoutes } from "./local-takeover.js";
import { registerNextCollection } from "./policy-outbox.js";

const testUrl = process.env.MDBASE_CONNECT_TEST_DATABASE_URL;
const approved = process.env.MDBASE_CONNECT_DESTRUCTIVE_TEST_APPROVAL === "I APPROVE MDBASE CONNECT DESTRUCTIVE POSTGRES TESTS";
const describePostgres = testUrl && approved ? describe : describe.skip;
const ROOT = Buffer.alloc(16, 9);
const OPERATIONS: string[] = [...capabilityOperations("collection.read")];

describePostgres("carried-over grants through a fenced local rollback (real Postgres)", () => {
  let admin: pg.Pool;
  let db: DatabasePool;
  let schema: string;
  const app = Fastify();
  const relay = { fenceConnector: async () => "closed" as const };

  beforeAll(async () => {
    const url = new URL(testUrl!);
    if (!["localhost", "127.0.0.1", "::1"].includes(url.hostname) || !/test/i.test(url.pathname)) throw new Error("Rollback tests require a dedicated local test database.");
    schema = `mdbase_carry_rollback_test_${randomUUID().replaceAll("-", "")}`;
    admin = new pg.Pool({ connectionString: url.toString(), max: 2 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    url.searchParams.set("options", `-csearch_path=${schema}`);
    db = await createDatabase(url.toString());
    registerLocalTakeoverRoutes(app, { db, relay });
    registerLocalRollbackBindingRoutes(app, db);
    await app.ready();
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await db?.end();
    if (admin && schema) await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin?.end();
  }, 60_000);

  /** A next account whose old connector still serves `collection`, plus its new desktop. */
  async function account() {
    const owner = randomUUID();
    const collection = randomUUID();
    const legacyConnector = randomUUID();
    const legacyRow = randomUUID();
    const connectorKey = randomBytes(65).toString("base64url");
    await db.query("INSERT INTO users(id,email,name,account_backend) VALUES($1,$2,'Owner','next')", [owner, `${owner}@example.test`]);
    await ensureDevelopmentEntitlement(db, owner);
    await db.query("INSERT INTO connectors(id,user_id,name,token_hash,relay_generation,relay_public_key) VALUES($1,$2,'Old Connect',$3,2,$4)",
      [legacyConnector, owner, randomUUID(), connectorKey]);
    await db.query(`INSERT INTO collections(id,user_id,connector_id,local_id,display_name,spec_version,present,enabled,authority_state)
      VALUES($1,$2,$3,$4,'Journal','0.3.0',true,true,'active')`, [legacyRow, owner, legacyConnector, collection]);
    const connector = randomUUID();
    const token = `native_${connector}`;
    const device = randomUUID();
    await db.query("INSERT INTO connectors(id,user_id,name,token_hash,relay_generation) VALUES($1,$2,'Desktop',$3,1)", [connector, owner, tokenHash(token)]);
    const keys = { sign_pk: randomBytes(32), kem_pk: randomBytes(32), noise_pk: randomBytes(32) };
    await db.query("INSERT INTO next_devices(id,connector_id,user_id,kind,sign_pk,kem_pk,noise_pk) VALUES($1,$2,$3,'desktop',$4,$5,$6)",
      [device, connector, owner, keys.sign_pk, keys.kem_pk, keys.noise_pk]);
    await registerNextCollection(db, { collectionId: collection, ownerUserId: owner, runtime: "next", sync: "private", rootKeyId: ROOT, displayName: "Journal",
      ops: [{ op: "genesis", owner, root: ROOT, state: "e2e" }, { op: "member-set", account: owner, role: "owner" },
        { op: "device-enrol", device, account: owner, kind: "desktop", signPublicKey: keys.sign_pk, kemPublicKey: keys.kem_pk, noisePublicKey: keys.noise_pk }] });
    const headers = { authorization: `Bearer ${token}` };
    const takeover = () => app.inject({ method: "POST", url: "/v1/next/migration/local-takeover", headers,
      payload: { legacy_connector_id: legacyConnector, legacy_collection_ids: [collection], taken_over_at: new Date().toISOString() } });
    const rollbackId = randomUUID();
    const rollback = () => app.inject({ method: "POST", url: "/v1/next/migration/local-rollback/rotate-bindings", headers,
      payload: { legacy_connector_id: legacyConnector, legacy_collection_ids: [collection], collection_id: collection, rollback_id: rollbackId } });
    /** What the rollback driver does after rotation: the old connector serves again. */
    const restartOldConnector = async () => {
      await db.query("UPDATE connectors SET revoked_at = NULL WHERE id = $1", [legacyConnector]);
      await db.query("UPDATE collections SET authority_state = 'active', enabled = true WHERE id = $1", [legacyRow]);
      return await buildPolicySnapshot(db, legacyConnector, 55_000, undefined, () => true, "lease_v1", true) as LeasePolicySnapshot;
    };
    return { owner, collection, legacyConnector, legacyRow, connectorKey, takeover, rollback, restartOldConnector };
  }

  /** An app's active legacy grant as portal approval leaves it: relay binding, signed authorization and client key. */
  async function legacyGrant(f: Awaited<ReturnType<typeof account>>) {
    const grant = randomUUID();
    const appKey = randomBytes(65).toString("base64url");
    await db.query("INSERT INTO applications(id,canonical_identity,name,homepage,redirect_uris,application_declaration) VALUES($1::uuid,$1::text,'Journal','https://journal.example','[]','{\"id\":\"dev.mdbase.journal\"}'::jsonb)", [grant]);
    const encryption = { protocol_version: 1, suite: RELAY_ENCRYPTION_SUITE, key_id: `enc_${randomUUID()}`, scope_epoch: 3,
      connector_id: f.legacyConnector, collection_id: f.collection, application_agreement_public_key: appKey, connector_agreement_public_key: f.connectorKey };
    await db.query(`INSERT INTO grants(id,user_id,application_id,collection_id,operations,scope,file_capability,encryption,application_installation_id,application_authorization,activated_at)
      VALUES($1,$2,$1,$3,$4::jsonb,'{"access":"full_collection","contracts":[]}',
      '{"kind":"files","protocol_version":1,"actions":["list","read"],"scope":{"kind":"collection"}}',$5::jsonb,$6,$7::jsonb,now())`,
    [grant, f.owner, f.legacyRow, JSON.stringify(OPERATIONS), JSON.stringify(encryption), randomUUID(),
      JSON.stringify({ binding: { protocol_version: 5, application_declaration_id: "dev.mdbase.journal", grant_agreement_public_key: appKey,
        contracts: { semantic_capabilities: 2 } } })]);
    await db.query("INSERT INTO next_grant_client_keys(grant_id, client_pk) VALUES($1,$2)", [grant, randomBytes(32)]);
    return { grant, encryption };
  }

  const row = async (grant: string) => (await db.query<{ collection_id: string | null; next_collection_id: string | null; encryption: Record<string, unknown> | null; revoked: boolean; native_active: boolean | null; log_grant_id: string | null }>(
    `SELECT g.collection_id, g.next_collection_id, g.encryption, g.revoked_at IS NOT NULL AS revoked, b.active AS native_active, b.log_grant_id
     FROM grants g LEFT JOIN next_grant_bindings b ON b.grant_id = g.id WHERE g.id = $1`, [grant])).rows[0]!;
  const revokedLogGrants = async (collection: string) => (await db.query<{ ops: { ops: Array<{ op: string; grant: string }> } }>(
    "SELECT ops FROM next_policy_outbox WHERE collection_id = $1 ORDER BY id", [collection])).rows
    .flatMap(r => r.ops.ops).filter(op => op.op === "grant-revoke").map(op => op.grant);
  /** A grant carried over by a server that did not keep the legacy binding. */
  const asCarriedByEarlierServer = async (grant: string) => {
    await db.query("UPDATE grants SET legacy_collection_id = NULL, legacy_encryption = NULL WHERE id = $1", [grant]);
  };

  it("returns every carried-over app to its legacy binding, which the old connector serves again", async () => {
    const f = await account();
    const apps = [await legacyGrant(f), await legacyGrant(f)];
    const revoked = await legacyGrant(f);
    expect((await f.takeover()).statusCode).toBe(200);
    for (const { grant } of [...apps, revoked]) {
      expect(await row(grant)).toMatchObject({ collection_id: null, next_collection_id: f.collection, encryption: null, native_active: true });
    }
    // The user removes one app while on Private sync: rollback must not bring it back.
    await db.query("UPDATE grants SET revoked_at = now() WHERE id = $1", [revoked.grant]);
    await db.query("UPDATE account_entitlement_grants SET revoked_at = now() WHERE user_id = $1", [f.owner]);

    const response = await f.rollback();
    expect(response.statusCode).toBe(200);
    const result = response.json();
    const expected = [...apps].sort((a, b) => a.grant.localeCompare(b.grant));
    expect(result.bindings).toEqual(expected.map(({ grant }) => ({ grant_id: grant, key_id: expect.stringMatching(/^enc_/), scope_epoch: 4 })));
    for (const [index, { grant, encryption }] of expected.entries()) {
      const binding = result.bindings[index];
      expect(binding.key_id).not.toBe(encryption.key_id);
      const restored = await row(grant);
      expect(restored).toMatchObject({ collection_id: f.legacyRow, next_collection_id: null, revoked: false, native_active: false,
        encryption: { ...encryption, key_id: binding.key_id, scope_epoch: 4 } });
      expect(await revokedLogGrants(f.collection)).toContain(restored.log_grant_id);
    }
    expect(await row(revoked.grant)).toMatchObject({ collection_id: null, revoked: true });

    // Carry-over does not take the apps back while the rollback finishes, and a
    // retry of the same rollback returns the same result.
    expect(await carryOverLegacyLocalGrants(db, f.collection)).toEqual([]);
    expect((await f.rollback()).json()).toEqual(result);

    const snapshot = await f.restartOldConnector();
    const served = new Map(snapshot.grants.map(g => [String(g.id), g.encryption]));
    expect([...served.keys()].sort()).toEqual(expected.map(a => a.grant));
    for (const [index, { grant, encryption }] of expected.entries()) {
      expect(served.get(grant)).toEqual({ ...encryption, key_id: result.bindings[index].key_id, scope_epoch: 4 });
    }
  });

  it("recovers the legacy binding of a grant carried over before the binding was kept", async () => {
    const f = await account();
    const app1 = await legacyGrant(f);
    const revoked = await legacyGrant(f);
    const noEvidence = await legacyGrant(f);
    expect((await f.takeover()).statusCode).toBe(200);
    for (const { grant } of [app1, revoked, noEvidence]) await asCarriedByEarlierServer(grant);
    await db.query("UPDATE grants SET revoked_at = now() WHERE id = $1", [revoked.grant]);
    await db.query("DELETE FROM audit_events WHERE event_type = 'grant.carried_over' AND subject_id = $1", [noEvidence.grant]);

    const response = await f.rollback();
    expect(response.statusCode).toBe(200);
    const result = response.json();
    // The relay binding is rebuilt from the carry-over audit record, the grant's
    // signed authorization and the old connector: a fresh key ID, epoch 1, rotated.
    expect(result.bindings).toEqual([{ grant_id: app1.grant, key_id: expect.stringMatching(/^enc_/), scope_epoch: 2 }]);
    expect(await row(app1.grant)).toMatchObject({ collection_id: f.legacyRow, next_collection_id: null, native_active: false,
      encryption: { ...app1.encryption, key_id: result.bindings[0].key_id, scope_epoch: 2 } });
    const recovered = await db.query("SELECT metadata FROM audit_events WHERE event_type = 'grant.legacy_binding_recovered' AND subject_id = $1", [app1.grant]);
    expect(recovered.rows).toEqual([{ metadata: { legacy_collection_row: f.legacyRow, rollback_id: expect.any(String) } }]);
    // Never resurrected; without carry-over evidence it stays native and needs a fresh approval.
    expect(await row(revoked.grant)).toMatchObject({ collection_id: null, revoked: true });
    expect(await row(noEvidence.grant)).toMatchObject({ collection_id: null, next_collection_id: f.collection, native_active: true });
    expect((await f.rollback()).json()).toEqual(result);

    const snapshot = await f.restartOldConnector();
    expect(snapshot.grants.map(g => String(g.id))).toEqual([app1.grant]);
  });

  it("still carries grants over when the collection is turned on later, keeping the binding", async () => {
    const f = await account();
    const app1 = await legacyGrant(f);
    await carryOverLegacyGrants({ db }, f.collection); // not retired yet: nothing moves
    expect(await row(app1.grant)).toMatchObject({ collection_id: f.legacyRow });
    expect((await f.takeover()).statusCode).toBe(200);
    const kept = await db.query("SELECT legacy_collection_id, legacy_encryption FROM grants WHERE id = $1", [app1.grant]);
    expect(kept.rows[0]).toEqual({ legacy_collection_id: f.legacyRow, legacy_encryption: app1.encryption });
  });
});
