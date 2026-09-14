import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { afterEach, expect, it } from "vitest";
import { createDatabase } from "../../db.js";
import { createHostedCollectionMembership } from "../../collection-policy.js";
import { tokenHash } from "../../security.js";
import { registerPeopleRoutes } from "./people-routes.js";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });

async function fixture(permissions: string[] = ["identity", "members"], member = false) {
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
  [applicationId, randomUUID(), JSON.stringify(permissions.length ? { people: { version: 1, permissions } } : {}), digest]);
  await db.query(`INSERT INTO grants (id,user_id,application_id,hosted_collection_id,logical_collection_id,operations,application_authorization,membership_id,membership_policy_id,membership_policy_revision)
    VALUES ($1,$2,$3,$4,$4,'["read"]',$5,$6,$7,$8)`,
  [grantId, member ? memberId : ownerId, applicationId, collectionId,
    JSON.stringify({ binding: { protocol_version: 5, application_manifest_digest: digest } }),
    member ? policy.membershipId : null, member ? policy.id : null, member ? policy.revision : null]);
  const token = randomUUID();
  await db.query("INSERT INTO access_tokens (id,token_hash,grant_id,expires_at) VALUES ($1,$2,$3,now() + interval '1 hour')", [randomUUID(), tokenHash(token), grantId]);
  const app = Fastify();
  registerPeopleRoutes(app, { db, publicUrl: "https://connect.example/" });
  cleanup.push(() => app.close());
  const get = (resource: "identity" | "members", id = collectionId) => app.inject({ url: `/v1/authorities/${id}/${resource}`, headers: { authorization: `Bearer ${token}` } });
  return { db, app, get, ownerId, memberId, collectionId, applicationId, grantId, policy };
}

it("returns portable account identity and a minimal member directory without private emails", async () => {
  const f = await fixture();
  const identity = await f.get("identity");
  expect(identity.statusCode, identity.body).toBe(200);
  expect(identity.json()).toEqual({ issuer: "https://connect.example", subject: f.ownerId, name: "Owner" });
  expect(identity.headers["cache-control"]).toBe("no-store");
  const directory = await f.get("members");
  expect(directory.statusCode, directory.body).toBe(200);
  expect(directory.json()).toEqual({ members: [
    { issuer: "https://connect.example", subject: f.ownerId, name: "Owner", role: "owner" },
    { issuer: "https://connect.example", subject: f.memberId, name: "Member", role: "viewer" }
  ] });
  expect(directory.body).not.toContain("private.example");
});

it("permits a viewer directory access without membership management", async () => {
  const f = await fixture(["identity", "members"], true);
  expect((await f.get("identity")).json().subject).toBe(f.memberId);
  expect((await f.get("members")).statusCode).toBe(200);
  await f.db.query("UPDATE collection_memberships SET state = 'revoking' WHERE id = $1", [f.policy.membershipId]);
  expect((await f.get("members")).statusCode).toBe(401);
});

it("does not grant people access to old applications or infer members permission from self identity", async () => {
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
  const hostedIdentity = (await f.get("identity")).json();
  const connectorId = randomUUID(), rowId = randomUUID(), localId = randomUUID();
  await f.db.query("INSERT INTO connectors (id,user_id,name,token_hash) VALUES ($1,$2,'Local',$3)", [connectorId, f.ownerId, randomUUID()]);
  await f.db.query("INSERT INTO collections (id,user_id,connector_id,local_id,display_name,spec_version) VALUES ($1,$2,$3,$4,'Local','0.3.0')", [rowId, f.ownerId, connectorId, localId]);
  await f.db.query("UPDATE grants SET hosted_collection_id = NULL, collection_id = $1, logical_collection_id = $2, application_installation_id = $4 WHERE id = $3", [rowId, localId, f.grantId, randomUUID()]);
  expect((await f.get("identity", localId)).json()).toEqual(hostedIdentity);
  expect((await f.get("members", localId)).json()).toEqual({ members: [{ ...hostedIdentity, role: "owner" }] });
  await f.db.query("UPDATE collections SET enabled = false WHERE id = $1", [rowId]);
  expect((await f.get("identity", localId)).statusCode).toBe(401);
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
