import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { afterEach, expect, it } from "vitest";
import { createDatabase } from "../../db.js";
import { createHostedCollectionMembership } from "../../collection-policy.js";
import { tokenHash } from "../../security.js";
import { registerPeopleRoutes } from "./people-routes.js";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });

/** `approved` is what the user granted; the application declares both as optional. */
async function fixture(approved: string[] = ["identity", "members"], member = false) {
  const db = await createDatabase("memory");
  cleanup.push(() => db.end());
  const ownerId = randomUUID(), memberId = randomUUID(), collectionId = randomUUID(), applicationId = randomUUID(), grantId = randomUUID();
  for (const [id, name] of [[ownerId, "Owner"], [memberId, "Member"]]) {
    await db.query("INSERT INTO users (id,email,name) VALUES ($1,$2,$3)", [id, `${id}@private.example`, name]);
  }
  await db.query("INSERT INTO hosted_collections (id,user_id,display_name,template) VALUES ($1,$2,'People','mdbase')", [collectionId, ownerId]);
  const policy = await createHostedCollectionMembership(db, { collectionId, ownerUserId: ownerId, userId: memberId, role: "viewer" });
  const digest = "a".repeat(64);
  await db.query(`INSERT INTO applications (id,canonical_identity,name,homepage,redirect_uris,requirements,manifest_digest)
    VALUES ($1,$2,'People test','https://app.example','[]',$3,$4)`,
  [applicationId, randomUUID(), JSON.stringify({ people: { version: 1, optional: ["identity", "members"] } }), digest]);
  await db.query(`INSERT INTO grants (id,user_id,application_id,hosted_collection_id,logical_collection_id,operations,application_authorization,membership_id,membership_policy_id,membership_policy_revision,people_permissions)
    VALUES ($1,$2,$3,$4,$4,'["read"]',$5,$6,$7,$8,$9)`,
  [grantId, member ? memberId : ownerId, applicationId, collectionId,
    JSON.stringify({ binding: { protocol_version: 5, application_manifest_digest: digest } }),
    member ? policy.membershipId : null, member ? policy.id : null, member ? policy.revision : null,
    approved.length ? JSON.stringify(approved) : null]);
  const token = randomUUID();
  await db.query("INSERT INTO access_tokens (id,token_hash,grant_id,expires_at) VALUES ($1,$2,$3,now() + interval '1 hour')", [randomUUID(), tokenHash(token), grantId]);
  const app = Fastify();
  registerPeopleRoutes(app, { db, issuer: "https://id.example", publicUrl: "https://api.example", editorOrigin: "https://editor.example" });
  cleanup.push(() => app.close());
  const get = (resource: "identity" | "members", id = collectionId) => app.inject({ url: `/v1/authorities/${id}/${resource}`, headers: { authorization: `Bearer ${token}` } });
  const subject = async (id: string) => (await db.query<{ public_subject: string }>("SELECT public_subject FROM users WHERE id = $1", [id])).rows[0].public_subject;
  return { db, app, get, ownerId, memberId, collectionId, applicationId, grantId, policy, ownerSubject: await subject(ownerId), memberSubject: await subject(memberId) };
}

it("returns portable account identity and a minimal member directory without private emails", async () => {
  const f = await fixture();
  const identity = await f.get("identity");
  expect(identity.statusCode, identity.body).toBe(200);
  expect(f.ownerSubject).toMatch(/^acct_[0-9a-f]{32}$/);
  expect(f.ownerSubject).not.toContain(f.ownerId.replaceAll("-", ""));
  expect(identity.json()).toEqual({
    issuer: "https://id.example", subject: f.ownerSubject, name: "Owner",
    person_settings_url: `https://editor.example/?server=https%3A%2F%2Fapi.example&collection=${f.collectionId}&surface=settings#your-person`
  });
  expect(identity.headers["cache-control"]).toBe("no-store");
  const directory = await f.get("members");
  expect(directory.statusCode, directory.body).toBe(200);
  expect(directory.json()).toEqual({ members: [
    { issuer: "https://id.example", subject: f.ownerSubject, name: "Owner", role: "owner" },
    { issuer: "https://id.example", subject: f.memberSubject, name: "Member", role: "viewer" }
  ] });
  expect(directory.body).not.toContain("private.example");
});

it("permits a viewer directory access without membership management", async () => {
  const f = await fixture(["identity", "members"], true);
  expect((await f.get("identity")).json().subject).toBe(f.memberSubject);
  expect((await f.get("members")).statusCode).toBe(200);
  await f.db.query("UPDATE collection_memberships SET state = 'revoking' WHERE id = $1", [f.policy.membershipId]);
  expect((await f.get("members")).statusCode).toBe(401);
});

it("discloses only permissions the user approved, not everything the application declared", async () => {
  const old = await fixture([]);
  expect((await old.get("identity")).statusCode).toBe(403);
  expect((await old.get("members")).statusCode).toBe(403);
  const self = await fixture(["identity"]);
  expect((await self.get("identity")).statusCode).toBe(200);
  expect((await self.get("members")).statusCode).toBe(403);
});

it("rejects missing tokens, wrong collections and revoked grants", async () => {
  const f = await fixture();
  expect((await f.app.inject({ url: `/v1/authorities/${f.collectionId}/identity` })).statusCode).toBe(401);
  expect((await f.get("identity", randomUUID())).statusCode).toBe(401);
  await f.db.query("UPDATE grants SET revoked_at = now() WHERE id = $1", [f.grantId]);
  expect((await f.get("identity")).statusCode).toBe(401);
});

it("uses the same identity for a relay collection and returns only its owner", async () => {
  const f = await fixture();
  const { person_settings_url: hostedSettings, ...hostedIdentity } = (await f.get("identity")).json();
  expect(hostedSettings).toContain(f.collectionId);
  const connectorId = randomUUID(), rowId = randomUUID(), localId = randomUUID();
  await f.db.query("INSERT INTO connectors (id,user_id,name,token_hash) VALUES ($1,$2,'Local',$3)", [connectorId, f.ownerId, randomUUID()]);
  await f.db.query("INSERT INTO collections (id,user_id,connector_id,local_id,display_name,spec_version) VALUES ($1,$2,$3,$4,'Local','0.3.0')", [rowId, f.ownerId, connectorId, localId]);
  await f.db.query("UPDATE grants SET hosted_collection_id = NULL, collection_id = $1, logical_collection_id = $2, application_installation_id = $4 WHERE id = $3", [rowId, localId, f.grantId, randomUUID()]);
  const { person_settings_url: localSettings, ...localIdentity } = (await f.get("identity", localId)).json();
  expect(localIdentity).toEqual(hostedIdentity);
  expect(localSettings).toContain(`collection=${localId}`);
  expect((await f.get("members", localId)).json()).toEqual({ members: [{ ...hostedIdentity, role: "owner" }] });
  await f.db.query("UPDATE collections SET enabled = false WHERE id = $1", [rowId]);
  expect((await f.get("identity", localId)).statusCode).toBe(401);
});

it("rejects expired tokens and unbound member grants", async () => {
  const f = await fixture(["identity", "members"], true);
  await f.db.query("UPDATE grants SET membership_id = NULL, membership_policy_id = NULL, membership_policy_revision = NULL WHERE id = $1", [f.grantId]);
  expect((await f.get("members")).statusCode).toBe(401);
  await f.db.query("UPDATE grants SET membership_id = $1, membership_policy_id = $2, membership_policy_revision = $3 WHERE id = $4", [f.policy.membershipId, f.policy.id, f.policy.revision, f.grantId]);
  await f.db.query("UPDATE access_tokens SET expires_at = now() - interval '1 hour' WHERE grant_id = $1", [f.grantId]);
  expect((await f.get("identity")).statusCode).toBe(401);
});

it("rejects suspension, stale manifest evidence and nonactive authorities", async () => {
  const f = await fixture();
  await f.db.query("UPDATE users SET suspended_at = now() WHERE id = $1", [f.ownerId]);
  expect((await f.get("identity")).statusCode).toBe(401);
  await f.db.query("UPDATE users SET suspended_at = NULL WHERE id = $1", [f.ownerId]);
  await f.db.query("UPDATE applications SET manifest_digest = $1 WHERE id = $2", ["b".repeat(64), f.applicationId]);
  expect((await f.get("identity")).statusCode).toBe(401);
  await f.db.query("UPDATE applications SET manifest_digest = $1 WHERE id = $2", ["a".repeat(64), f.applicationId]);
  await f.db.query("UPDATE hosted_collections SET authority_state = 'transferring' WHERE id = $1", [f.collectionId]);
  expect((await f.get("identity")).statusCode).toBe(401);
});
