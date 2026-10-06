import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import Fastify from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CONNECT_CONTRACT_SUPPORT, NEXT_ACCOUNT_CAPABILITY, POLICY_FRESHNESS_LEASE_CAPABILITY } from "@mdbase-dev/connect-protocol";
import { createDatabase, type DatabasePool } from "../../db.js";
import { canonicalJson, canonicalSha256 } from "../../canonical-json.js";
import { buildPolicySnapshot } from "../../relay-policy.js";
import { projectActivationGrant } from "../../relay-routing.js";
import { registerConnectorPairingRoutes } from "../connectors/pairing-routes.js";
import { tokenHash } from "../../security.js";
import { localGrantFixture } from "./next-fixtures.test-helper.js";

const testUrl = process.env.MDBASE_CONNECT_TEST_DATABASE_URL;
const approved = process.env.MDBASE_CONNECT_DESTRUCTIVE_TEST_APPROVAL === "I APPROVE MDBASE CONNECT DESTRUCTIVE POSTGRES TESTS";
const describePostgres = testUrl && approved ? describe : describe.skip;
const capabilities = [NEXT_ACCOUNT_CAPABILITY, "next_device_v1", POLICY_FRESHNESS_LEASE_CAPABILITY];

describePostgres("negotiated account wire (dedicated PostgreSQL)", () => {
  let db: DatabasePool;
  let admin: pg.Pool;
  let schema: string;
  beforeAll(async () => {
    const url = new URL(testUrl!);
    if (!["localhost", "127.0.0.1", "::1"].includes(url.hostname) || !/test/i.test(url.pathname)) throw new Error("Account wire tests require a dedicated local test database.");
    schema = `mdbase_account_wire_${randomUUID().replaceAll("-", "")}`;
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

  async function grant() {
    const id = await localGrantFixture(db);
    await db.query("UPDATE grants SET activated_at = now() WHERE id = $1", [id]);
    return id;
  }
  async function otherAccount() {
    const id = randomUUID();
    await db.query("INSERT INTO users(id,email,name) VALUES($1,$2,'Other account')", [id, `${id}@example.test`]);
    return id;
  }

  it("pairs to the authenticated approved account, not connector identity, with no account on pending/error", async () => {
    const user = await otherAccount();
    const pairing = randomUUID();
    const secret = "test-pairing-account-wire-secret";
    await db.query("INSERT INTO pairing_requests(id,secret_hash,connector_name,expires_at) VALUES($1,$2,'Fixture',now()+interval '1 hour')", [pairing, tokenHash(secret)]);
    const app = Fastify();
    registerConnectorPairingRoutes(app, { db, publicUrl: "https://connect.example" });
    const request = () => app.inject({ method: "POST", url: `/v1/pairing-requests/${pairing}/exchange`, headers: { authorization: `Bearer ${secret}` } });
    try {
      const pending = await request();
      expect(pending.statusCode).toBe(202);
      expect(pending.json()).toEqual({ status: "pending" });
      await db.query("UPDATE pairing_requests SET user_id=$2,approved_at=now() WHERE id=$1", [pairing, user]);
      const paired = await request();
      expect(paired.statusCode).toBe(200);
      expect(paired.json().account_id).toBe(user);
      expect(paired.json().connector.id).not.toBe(user);
      const consumed = await request();
      expect(consumed.statusCode).toBe(409);
      expect(consumed.json()).not.toHaveProperty("account_id");
    } finally { await app.close(); }
  });

  it("preserves legacy and existing-next-device grants byte-for-byte; only negotiated account changes raw revision", async () => {
    const id = await grant();
    const build = (nextDevice: boolean, nextAccount: boolean) => buildPolicySnapshot(db, id, 55_000, "1", () => true, "lease_v1", false, nextDevice, nextAccount);
    const legacyBefore = (await build(false, false))!.grants;
    const nextBefore = (await build(true, false))!.grants;
    const consenting = await otherAccount();
    await db.query("UPDATE grants SET user_id=$2 WHERE id=$1", [id, consenting]);
    expect(canonicalJson((await build(false, false))!.grants)).toBe(canonicalJson(legacyBefore));
    expect(canonicalJson((await build(true, false))!.grants)).toBe(canonicalJson(nextBefore));
    const snapshot = (await build(true, true))!;
    expect(snapshot.grants[0]!.account_id).toBe(consenting);
    expect(snapshot.grants[0]!.account_id).not.toBe(id); // never substitute collection creator/device account
    if (!("sequence" in snapshot)) throw new Error("Expected a lease snapshot.");
    const body = { connector_id: snapshot.connector_id, sequence: snapshot.sequence, lease_issued_at_ms: snapshot.lease_issued_at_ms,
      lease_expires_at_ms: snapshot.lease_expires_at_ms, grants: snapshot.grants };
    expect(canonicalSha256(body)).toBe(snapshot.revision);
    expect(canonicalSha256({ ...body, grants: snapshot.grants.map((g) => ({ ...g, account_id: id })) })).not.toBe(snapshot.revision);
    await expect(buildPolicySnapshot(db, id, 55_000, "1", () => true, "legacy_ack_v0", false, true, true)).rejects.toMatchObject({ code: "capability_contract_incompatible" });
    await expect(build(false, true)).rejects.toMatchObject({ code: "capability_contract_incompatible" });
  });

  it("refuses a nil persisted identity without committing a new lease sequence", async () => {
    const id = await grant();
    const nil = "00000000-0000-0000-0000-000000000000";
    await db.query("INSERT INTO users(id,email,name) VALUES($1,'nil-account@example.test','Nil fixture')", [nil]);
    await db.query("UPDATE grants SET user_id=$2 WHERE id=$1", [id, nil]);
    const before = await db.query("SELECT policy_sequence FROM connectors WHERE id=$1", [id]);
    await expect(buildPolicySnapshot(db, id, 55_000, "1", () => true, "lease_v1", false, true, true)).rejects.toMatchObject({ code: "capability_contract_incompatible" });
    expect((await db.query("SELECT policy_sequence FROM connectors WHERE id=$1", [id])).rows[0]).toEqual(before.rows[0]);
  });

  it("carries database consenting identity into activation, never client/creator identity, and strips it in old modes", async () => {
    const id = await grant();
    const consenting = await otherAccount();
    await db.query("UPDATE grants SET user_id=$2 WHERE id=$1", [id, consenting]);
    const fixture = JSON.parse(readFileSync(new URL("../../../../../test-fixtures/protocol-v1-policy-canonical.json", import.meta.url), "utf8"));
    const wireGrant = { ...fixture.normalized_wire_body.grants[0], id, collection_id: id, account_id: id };
    const command = { version: 1 as const, kind: "deliver" as const, message: { type: "authorization_activation_request", grant: wireGrant } };
    const session = (caps: string[]) => ({ capabilities: caps, contractSupport: CONNECT_CONTRACT_SUPPORT, mode: "lease_v1" as const });
    const current = await projectActivationGrant(db, id, command, session(capabilities));
    expect(current.ok).toBe(true);
    if (current.ok) expect((current.command.message as { grant: { account_id: string } }).grant.account_id).toBe(consenting);
    for (const caps of [[], ["next_device_v1", POLICY_FRESHNESS_LEASE_CAPABILITY]]) {
      const old = await projectActivationGrant(db, id, command, session(caps));
      expect(old.ok).toBe(true);
      if (old.ok) expect((old.command.message as { grant: object }).grant).not.toHaveProperty("account_id");
    }
    expect((await projectActivationGrant(db, id, command, session([NEXT_ACCOUNT_CAPABILITY]))).ok).toBe(false);
    expect((await projectActivationGrant(db, id, command, { ...session(capabilities), mode: "legacy_ack_v0" })).ok).toBe(false);
    expect((await projectActivationGrant(db, randomUUID(), command, session(capabilities))).ok).toBe(false);
    await db.query("UPDATE grants SET revoked_at=now() WHERE id=$1", [id]);
    expect((await projectActivationGrant(db, id, command, session(capabilities))).ok).toBe(false);
  });
});
