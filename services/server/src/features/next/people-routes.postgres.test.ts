import { randomBytes, randomUUID } from "node:crypto";
import Fastify from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, type DatabasePool } from "../../db.js";
import { createHostedCollectionMembership } from "../../collection-policy.js";
import { tokenHash } from "../../security.js";
import { registerPeopleRoutes } from "../account/people-routes.js";

const testUrl = process.env.MDBASE_CONNECT_TEST_DATABASE_URL;
const approved = process.env.MDBASE_CONNECT_DESTRUCTIVE_TEST_APPROVAL === "I APPROVE MDBASE CONNECT DESTRUCTIVE POSTGRES TESTS";
const suite = testUrl && approved ? describe : describe.skip;

suite("next people account IDs and current grant gates (real Postgres)", () => {
  let db: DatabasePool; let admin: pg.Pool; let schema: string;
  const app = Fastify();
  beforeAll(async () => {
    const url = new URL(testUrl!);
    if (!["localhost", "127.0.0.1", "::1"].includes(url.hostname) || !/test/i.test(url.pathname)) throw new Error("Requires dedicated local test Postgres.");
    schema = `next_people_test_${randomUUID().replaceAll("-", "")}`;
    admin = new pg.Pool({ connectionString: url.toString(), max: 2 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    url.searchParams.set("options", `-csearch_path=${schema}`);
    db = await createDatabase(url.toString());
    registerPeopleRoutes(app, { db, issuer: "https://id.example", publicUrl: "https://connect.example" });
  }, 60_000);
  afterAll(async () => {
    await app.close(); await db?.end();
    if (admin && schema) await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin?.end();
  });
  async function fixture(permissions = ["identity", "members"], memberGrant = false) {
    const owner = randomUUID(), member = randomUUID(), collection = randomUUID(), application = randomUUID(), grant = randomUUID(), token = randomUUID();
    for (const [id, name] of [[owner, "Owner"], [member, "Member"]]) await db.query("INSERT INTO users(id,email,name,account_backend) VALUES($1,$2,$3,'next')", [id, `${id}@private.example`, name]);
    await db.query("INSERT INTO hosted_collections(id,user_id,display_name,template) VALUES($1,$2,'People','mdbase')", [collection, owner]);
    const policy = await createHostedCollectionMembership(db, { collectionId: collection, ownerUserId: owner, userId: member, role: "viewer" });
    const digest = "a".repeat(64);
    await db.query("INSERT INTO applications(id,canonical_identity,name,homepage,redirect_uris,manifest_digest) VALUES($1,$2,'People','https://app.example','[]',$3)", [application, randomUUID(), digest]);
    await db.query(`INSERT INTO grants(id,user_id,application_id,hosted_collection_id,logical_collection_id,operations,application_authorization,people_permissions,membership_id,membership_policy_id,membership_policy_revision,activated_at)
      VALUES($1,$2,$3,$4,$4,'["read"]',$5,$6,$7,$8,$9,now())`, [grant, memberGrant ? member : owner, application, collection, JSON.stringify({ binding: { protocol_version: 5, application_manifest_digest: digest } }), JSON.stringify(permissions), memberGrant ? policy.membershipId : null, memberGrant ? policy.id : null, memberGrant ? policy.revision : null]);
    await db.query("INSERT INTO access_tokens(id,token_hash,grant_id,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')", [randomUUID(), tokenHash(token), grant]);
    await db.query("INSERT INTO next_collections(collection_id,owner_user_id,runtime,sync,root_key_id) VALUES($1,$2,'next','cloud_copy',$3)", [collection, owner, randomBytes(16)]);
    const logGrant = randomUUID();
    await db.query("INSERT INTO next_grant_bindings(grant_id,collection_id,log_grant_id,terms_digest) VALUES($1,$2,$3,$4)", [grant, collection, logGrant, randomBytes(32)]);
    const get = (resource: "identity" | "members", id = collection, bearer = token) => app.inject({ method: "GET", url: `/v1/authorities/${id}/${resource}`, headers: { authorization: `Bearer ${bearer}` } });
    return { owner, member, collection, application, grant, policy, get };
  }
  it("keeps issuer/subject/name and supplies exact policy account UUIDs without private profiles", async () => {
    const f = await fixture();
    const identity = await f.get("identity");
    expect(identity.statusCode).toBe(200);
    expect(identity.json()).toMatchObject({ account_id: f.owner, issuer: "https://id.example", name: "Owner" });
    expect(identity.json().subject).toMatch(/^acct_[0-9a-f]{32}$/);
    const members = await f.get("members");
    expect(members.statusCode).toBe(200);
    expect(members.json().members.map((value: { account_id: string; role: string }) => ({ account_id: value.account_id, role: value.role }))).toEqual([{ account_id: f.owner, role: "owner" }, { account_id: f.member, role: "viewer" }]);
    expect(members.body).not.toContain("private.example");
    expect(members.headers["cache-control"]).toBe("no-store");
  });
  it("requires the exact user-approved people permission and active immutable grant binding", async () => {
    const f = await fixture(["identity"]);
    expect((await f.get("identity")).statusCode).toBe(200);
    expect((await f.get("members")).statusCode).toBe(403);
    await db.query("UPDATE next_grant_bindings SET active=false WHERE grant_id=$1", [f.grant]);
    expect((await f.get("identity")).statusCode).toBe(401);
    await db.query("DELETE FROM next_grant_bindings WHERE grant_id=$1", [f.grant]);
    expect((await f.get("identity")).statusCode).toBe(401);
  });
  it("rejects wrong collections, stale manifests, revoked grants, and owner or caller suspension", async () => {
    const f = await fixture(["identity", "members"], true);
    expect((await f.get("identity")).json().account_id).toBe(f.member);
    expect((await f.get("identity", randomUUID())).statusCode).toBe(401);
    await db.query("UPDATE users SET suspended_at=now() WHERE id=$1", [f.owner]);
    expect((await f.get("identity")).statusCode).toBe(401);
    expect((await f.get("members")).statusCode).toBe(401);
    await db.query("UPDATE users SET suspended_at=NULL WHERE id=$1", [f.owner]);
    await db.query("UPDATE applications SET manifest_digest=$2 WHERE id=$1", [f.application, "b".repeat(64)]);
    expect((await f.get("identity")).statusCode).toBe(401);
    await db.query("UPDATE applications SET manifest_digest=$2 WHERE id=$1", [f.application, "a".repeat(64)]);
    await db.query("UPDATE collection_memberships SET state='revoking' WHERE id=$1", [f.policy.membershipId]);
    expect((await f.get("identity")).statusCode).toBe(401);
    await db.query("UPDATE collection_memberships SET state='active' WHERE id=$1", [f.policy.membershipId]);
    await db.query("UPDATE users SET suspended_at=now() WHERE id=$1", [f.member]);
    expect((await f.get("identity")).statusCode).toBe(401);
    await db.query("UPDATE users SET suspended_at=NULL WHERE id=$1", [f.member]);
    await db.query("UPDATE grants SET revoked_at=now() WHERE id=$1", [f.grant]);
    expect((await f.get("members")).statusCode).toBe(401);
  });
});
