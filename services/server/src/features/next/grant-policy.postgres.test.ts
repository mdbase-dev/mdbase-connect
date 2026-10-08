import { generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import Fastify from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { APPLICATION_CAPABILITY_DEFINITIONS, type FileCapability } from "@mdbase-dev/connect-protocol";
import { createDatabase, type DatabasePool, type DatabaseQueryable } from "../../db.js";
import { tokenHash } from "../../security.js";
import { registerAuthorizationRoutes } from "../authorizations/routes.js";
import type { AuthorizationRouteOptions } from "../authorizations/route-options.js";
import { queueLocalGrantRevocations } from "../../local-grant-revocation.js";
import { localGrantFixture } from "./next-fixtures.test-helper.js";
import { exactNextGrantCapabilities, queueNextGrantPolicy } from "./grant-policy.js";
import { registerNextRouteRoutes } from "./route-routes.js";
import { clientKeyDigest, grantApprovalReportDigest, grantDeviceApproval, reportGrantApproval } from "./grant-approval.js";
import { ed25519RawPublicKey } from "./policy-keys.js";
import { encodeCbor, uuidBytes } from "./policy-wire.js";

const testUrl = process.env.MDBASE_CONNECT_TEST_DATABASE_URL;
const approved = process.env.MDBASE_CONNECT_DESTRUCTIVE_TEST_APPROVAL === "I APPROVE MDBASE CONNECT DESTRUCTIVE POSTGRES TESTS";
const pgDescribe = testUrl && approved ? describe : describe.skip;
const READ = [...APPLICATION_CAPABILITY_DEFINITIONS["collection.read"]];
const EDIT = [...APPLICATION_CAPABILITY_DEFINITIONS["records.edit"]];
const SCHEDULE = [...APPLICATION_CAPABILITY_DEFINITIONS["background.schedule"]];
const files = (actions = ["list", "read"], folders?: string[]): FileCapability => ({
  kind: "files", protocol_version: 1, actions: actions as FileCapability["actions"],
  scope: folders ? { kind: "selected_folders", folders } : { kind: "collection" }
});

pgDescribe("next grant policy lifecycle (real Postgres)", () => {
  let admin: pg.Pool; let db: DatabasePool; let schema: string;
  beforeAll(async () => {
    const url = new URL(testUrl!);
    if (!["localhost", "127.0.0.1", "::1"].includes(url.hostname) || !/test/i.test(url.pathname)) throw new Error("Grant policy tests require a dedicated local test database.");
    schema = `next_grant_policy_test_${randomUUID().replaceAll("-", "")}`;
    admin = new pg.Pool({ connectionString: url.toString(), max: 2 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    url.searchParams.set("options", `-csearch_path=${schema}`);
    db = await createDatabase(url.toString());
  }, 60_000);
  afterAll(async () => {
    await db?.end();
    if (admin && schema) await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin?.end();
  }, 60_000);

  async function transaction<T>(fn: (c: DatabaseQueryable) => Promise<T>): Promise<T> {
    const c = await db.connect();
    try { await c.query("BEGIN"); const value = await fn(c); await c.query("COMMIT"); return value; }
    catch (error) { await c.query("ROLLBACK"); throw error; }
    finally { c.release(); }
  }
  async function fixture(sync = "cloud_copy", operations = [...READ, ...SCHEDULE], capability: FileCapability | null = files()) {
    const id = await localGrantFixture(db);
    const installation = randomUUID(); const clientPk = randomBytes(32);
    await db.query(`UPDATE grants SET activated_at = now(), operations=$2, file_capability=$3,
      application_installation_id=$4, application_authorization=$5 WHERE id=$1`,
      [id, JSON.stringify(operations), capability ? JSON.stringify(capability) : null, installation,
        JSON.stringify({ binding: { application_declaration_id: "dev.example.reader", contracts: { semantic_capabilities: 2 } } })]);
    await db.query("UPDATE collections SET enabled=true, present=true, authority_state='active' WHERE id=$1", [id]);
    await db.query("INSERT INTO next_grant_client_keys(grant_id,client_pk) VALUES($1,$2)", [id, clientPk]);
    if (sync !== "local") await db.query("INSERT INTO next_collections(collection_id,owner_user_id,runtime,sync,root_key_id) VALUES($1,$1,'next',$2,$3)", [id, sync, Buffer.alloc(16)]);
    return { id, installation, clientPk };
  }
  const pending = async (id: string) => (await db.query<{ ops: { version: number; ops: Array<Record<string, unknown>> } }>(
    "SELECT ops FROM next_policy_outbox WHERE collection_id=$1 ORDER BY id", [id]
  )).rows.flatMap(r => r.ops.ops);

  it("publishes exact consent once and keeps the Connect ID separate", async () => {
    const { id, installation, clientPk } = await fixture();
    const logId = await transaction(c => queueNextGrantPolicy(c, id));
    expect(logId).toMatch(/^[0-9a-f-]{36}$/); expect(logId).not.toBe(id);
    expect(await transaction(c => queueNextGrantPolicy(c, id))).toBe(logId);
    expect(await pending(id)).toEqual([{ op: "grant", grant: logId, installation,
      appId: "dev.example.reader", account: id, capabilities: ["background.schedule", "collection.read"],
      clientPublicKey: { $hex: clientPk.toString("hex") } }]);
  });

  it("narrows by revoke+new identity in ONE outbox row", async () => {
    const { id } = await fixture();
    const old = await transaction(c => queueNextGrantPolicy(c, id));
    const next = await transaction(async c => {
      await c.query("UPDATE grants SET operations=$2 WHERE id=$1", [id, JSON.stringify(READ)]);
      return queueNextGrantPolicy(c, id);
    });
    expect(next).not.toBe(old);
    const rows = (await db.query("SELECT ops FROM next_policy_outbox WHERE collection_id=$1 ORDER BY id", [id])).rows;
    expect(rows).toHaveLength(2);
    expect(rows[1].ops.ops).toMatchObject([{ op: "grant-revoke", grant: old }, { op: "grant", grant: next, capabilities: ["collection.read"] }]);
  });

  it("never broadens independent file/record approvals or partial groups", async () => {
    for (const [operations, capability] of [[READ, null], [[...READ, ...EDIT], files()], [READ, files(["list"])], [["read"], files()], [[...READ, "sync"], files()]] as Array<[string[], FileCapability | null]>) {
      const { id } = await fixture("cloud_copy", operations, capability);
      await expect(transaction(c => queueNextGrantPolicy(c, id))).rejects.toMatchObject({ statusCode: 409, code: "application_reauthorization_required" });
      expect(await pending(id)).toEqual([]);
      expect((await db.query("SELECT * FROM next_grant_bindings WHERE grant_id=$1", [id])).rows).toEqual([]);
    }
    expect(exactNextGrantCapabilities(2, [...READ, ...EDIT], files(["list", "read", "replace", "move"]))).toEqual(["collection.read", "records.edit"]);
  });

  it("does not emit for legacy/local/shadow, unactivated, or revoked grants", async () => {
    const { id } = await fixture("local", ["read"], null);
    expect(await transaction(c => queueNextGrantPolicy(c, id))).toBeNull();
    const shadow = await fixture();
    await db.query("UPDATE next_collections SET runtime='shadow' WHERE collection_id=$1", [shadow.id]);
    expect(await transaction(c => queueNextGrantPolicy(c, shadow.id))).toBeNull();
    const left = await fixture();
    await db.query("UPDATE next_collections SET left_sync_at=now() WHERE collection_id=$1", [left.id]);
    expect(await transaction(c => queueNextGrantPolicy(c, left.id))).toBeNull();
    const inactive = await fixture();
    await db.query("UPDATE grants SET activated_at=NULL WHERE id=$1", [inactive.id]);
    expect(await transaction(c => queueNextGrantPolicy(c, inactive.id))).toBeNull();
    await db.query("UPDATE grants SET activated_at=now(),revoked_at=now() WHERE id=$1", [inactive.id]);
    expect(await transaction(c => queueNextGrantPolicy(c, inactive.id))).toBeNull();
  });

  it("refuses missing key/v1/invalid installation without issuing authority", async () => {
    for (const sql of ["DELETE FROM next_grant_client_keys WHERE grant_id=$1", "UPDATE grants SET application_authorization='{}' WHERE id=$1", "UPDATE grants SET application_installation_id='legacy' WHERE id=$1"]) {
      const { id } = await fixture(); await db.query(sql, [id]);
      await expect(transaction(c => queueNextGrantPolicy(c, id))).rejects.toMatchObject({ code: "application_reauthorization_required" });
      expect(await pending(id)).toEqual([]);
    }
  });

  it("keeps private folders sealed but publishes cloud-copy folder scope", async () => {
    const a = await fixture("private", READ, files(undefined, ["Private"]));
    await transaction(c => queueNextGrantPolicy(c, a.id));
    const b = await fixture("cloud_copy", READ, files(undefined, ["Photos"]));
    await transaction(c => queueNextGrantPolicy(c, b.id));
    expect(await pending(a.id)).toMatchObject([{ folderScoped: true }]);
    expect(JSON.stringify(await pending(a.id))).not.toContain("Private");
    expect(await pending(b.id)).toMatchObject([{ fileFolders: ["Photos"] }]);
  });

  it("rolls activation/narrowing and policy back together", async () => {
    const { id } = await fixture();
    await expect(transaction(async c => { await queueNextGrantPolicy(c, id); throw new Error("rollback"); })).rejects.toThrow("rollback");
    expect(await pending(id)).toEqual([]);
    const old = await transaction(c => queueNextGrantPolicy(c, id));
    await expect(transaction(async c => {
      await c.query("UPDATE grants SET operations=$2 WHERE id=$1", [id, JSON.stringify(READ)]);
      await queueNextGrantPolicy(c, id); throw new Error("rollback");
    })).rejects.toThrow("rollback");
    expect(await transaction(c => queueNextGrantPolicy(c, id))).toBe(old);
    expect(await pending(id)).toHaveLength(1);
  });

  it("serializes concurrent publications on the stable grant row", async () => {
    const { id } = await fixture();
    const ids = await Promise.all([transaction(c => queueNextGrantPolicy(c, id)), transaction(c => queueNextGrantPolicy(c, id))]);
    expect(ids[0]).toBe(ids[1]); expect(await pending(id)).toHaveLength(1);
  });

  it("raw bulk revocation, duplicate revoke and cascading deletion enqueue once", async () => {
    const a = await fixture(); const b = await fixture();
    const first = await transaction(c => queueNextGrantPolicy(c, a.id));
    const second = await transaction(c => queueNextGrantPolicy(c, b.id));
    await db.query("UPDATE grants SET revoked_at=now() WHERE id=ANY($1::uuid[])", [[a.id, b.id]]);
    await db.query("UPDATE grants SET revoked_at=now() WHERE id=ANY($1::uuid[])", [[a.id, b.id]]);
    expect(await pending(a.id)).toMatchObject([{ op: "grant" }, { op: "grant-revoke", grant: first }]);
    expect(await pending(b.id)).toMatchObject([{ op: "grant" }, { op: "grant-revoke", grant: second }]);
    const c = await fixture(); const third = await transaction(tx => queueNextGrantPolicy(tx, c.id));
    await db.query("DELETE FROM applications WHERE id=$1", [c.id]);
    expect(await pending(c.id)).toMatchObject([{ op: "grant" }, { op: "grant-revoke", grant: third }]);
  });

  it("cascading member-account cleanup revokes a grant on a surviving collection", async () => {
    const { id } = await fixture(); const member = randomUUID();
    await db.query("INSERT INTO users(id,email,name) VALUES($1,$2,'Member')", [member, `${member}@example.test`]);
    await db.query("UPDATE grants SET user_id=$2 WHERE id=$1", [id, member]);
    const logId = await transaction(c => queueNextGrantPolicy(c, id));
    await db.query("DELETE FROM users WHERE id=$1", [member]);
    expect((await db.query("SELECT id FROM grants WHERE id=$1", [id])).rows).toEqual([]);
    expect(await pending(id)).toMatchObject([{ op: "grant" }, { op: "grant-revoke", grant: logId }]);
  });

  it("the existing local revoke flow and rollback share the same atomic hook", async () => {
    const { id } = await fixture(); const logId = await transaction(c => queueNextGrantPolicy(c, id));
    await expect(transaction(async c => { await c.query("UPDATE grants SET revoked_at=now() WHERE id=$1", [id]); throw new Error("rollback"); })).rejects.toThrow("rollback");
    expect(await pending(id)).toHaveLength(1);
    await queueLocalGrantRevocations(db, id, [id]);
    expect(await pending(id)).toMatchObject([{ op: "grant" }, { op: "grant-revoke", grant: logId }]);
    await db.query("DELETE FROM grants WHERE id=$1", [id]);
    expect(await pending(id)).toHaveLength(2);
  });

  it("retained reactivation never reuses a revoked log identity", async () => {
    const { id } = await fixture(); const old = await transaction(c => queueNextGrantPolicy(c, id));
    await db.query("UPDATE grants SET revoked_at=now() WHERE id=$1", [id]);
    const next = await transaction(async c => { await c.query("UPDATE grants SET revoked_at=NULL WHERE id=$1", [id]); return queueNextGrantPolicy(c, id); });
    expect(next).not.toBe(old); expect(await pending(id)).toMatchObject([{ op: "grant" }, { op: "grant-revoke", grant: old }, { op: "grant", grant: next }]);
  });

  it("the real portal PATCH hook rotates a binding and refuses inexact narrowing", async () => {
    const { id } = await fixture(); const old = await transaction(c => queueNextGrantPolicy(c, id));
    await db.query("UPDATE applications SET provisions='{\"type_packs\":[]}', notifications='{\"criteria\":[]}', requirements=$2 WHERE id=$1", [id, JSON.stringify({ access: "full_collection", contracts: [],
      capabilities: { contract_version: 2, required: ["collection.read"], optional: ["background.schedule"] } })]);
    const app = Fastify();
    registerAuthorizationRoutes(app, { db, publicUrl: "http://localhost", tailscaleAuth: true,
      relay: { registerAuthorizationHandler: () => {}, pushPolicy: async () => {} } as unknown as AuthorizationRouteOptions["relay"],
      drainProviderRevocations: async () => {} });
    try {
      const patch = (operations: string[]) => app.inject({ method: "PATCH", url: `/v1/grants/${id}`,
        headers: { "tailscale-user-login": `${id}@example.test` }, payload: { operations } });
      const narrowed = await patch(READ);
      expect(narrowed.statusCode, narrowed.body).toBe(200);
      expect(await pending(id)).toMatchObject([{ op: "grant" }, { op: "grant-revoke", grant: old }, { op: "grant", capabilities: ["collection.read"] }]);
      expect((await patch(["read"])).statusCode).toBe(409);
      expect(await pending(id)).toHaveLength(3);
      expect((await db.query("SELECT operations FROM grants WHERE id=$1", [id])).rows[0].operations).toEqual(READ);
    } finally { await app.close(); }
  });

  it("private reports sign the actual log UUID, not the OAuth ID; narrowing invalidates old approval", async () => {
    const { id, clientPk } = await fixture("private");
    const old = (await transaction(c => queueNextGrantPolicy(c, id)))!;
    const device = randomUUID(); const { privateKey } = generateKeyPairSync("ed25519");
    await db.query("INSERT INTO next_devices(id,connector_id,user_id,kind,sign_pk,kem_pk,noise_pk) VALUES($1,$2,$2,'desktop',$3,$4,$5)",
      [device, id, Buffer.from(ed25519RawPublicKey(privateKey)), randomBytes(32), randomBytes(32)]);
    const fp = clientKeyDigest(clientPk); const capabilities = ["collection.read"];
    const report = (signedId: string) => ({ device_id: device, seq: 9, capabilities, client_fp: Buffer.from(fp).toString("hex"),
      sig: sign(null, grantApprovalReportDigest(id, signedId, 9, capabilities, fp), privateKey).toString("hex") });
    const log = { controlItemAt: async () => encodeCbor({ struct: [[0,1],[1,6],[2,uuidBytes(id)],[6,uuidBytes(device)]] }) };
    await expect(reportGrantApproval(db, log, { id }, old, report(id))).rejects.toMatchObject({ code: "invalid_signature" });
    expect(await reportGrantApproval(db, log, { id }, old, report(old))).toMatchObject({ grant_id: old });
    expect(await grantDeviceApproval(db, id)).toMatchObject({ approved: true });
    const next = (await transaction(async c => {
      await c.query("UPDATE grants SET operations=$2 WHERE id=$1", [id, JSON.stringify(READ)]);
      return queueNextGrantPolicy(c, id);
    }))!;
    expect(await grantDeviceApproval(db, id)).toMatchObject({ approved: false });
    await expect(reportGrantApproval(db, log, { id }, old, report(old))).rejects.toMatchObject({ code: "grant_not_found" });
    await expect(reportGrantApproval(db, log, { id }, next, report(old))).rejects.toMatchObject({ code: "invalid_signature" });
    expect(await reportGrantApproval(db, log, { id }, id, report(next))).toMatchObject({ grant_id: next });
    expect(await grantDeviceApproval(db, id)).toMatchObject({ approved: true });
  });

  it("discovery exposes only the current log UUID and stable control reference", async () => {
    const { id } = await fixture();
    const token = `at_${randomUUID()}`;
    await db.query("INSERT INTO access_tokens(id,token_hash,grant_id,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')", [randomUUID(), tokenHash(token), id]);
    const app = Fastify();
    registerNextRouteRoutes(app, { db, publicUrl: "https://connect.example", broker: { request: async () => ({ version: 1, ok: true, value: false }) } });
    try {
      const route = () => app.inject({ method: "GET", url: `/v1/next/collections/${id}/route`, headers: { authorization: `Bearer ${token}` } });
      expect((await route()).statusCode).toBe(409);
      const logId = await transaction(c => queueNextGrantPolicy(c, id));
      expect((await route()).json()).toMatchObject({ grant: logId, authorization_grant: id });
      await db.query("UPDATE grants SET revoked_at=now() WHERE id=$1", [id]);
      expect((await route()).statusCode).toBe(401);
    } finally { await app.close(); }
  });
});
