// Regressions for membership authorization and lifecycle boundaries.
import { randomUUID } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { buildApp } from "../../app.js";
import { createDatabase } from "../../db.js";
import { createHostedCollectionMembership } from "./collection-policy.js";
import {
  changeHostedCollectionMembershipRole,
  revokeHostedCollectionMembership
} from "./collection-membership-lifecycle.js";
import {
  createCollectionInvitationCode,
  createHostedCollectionInvitation,
  acceptHostedCollectionInvitation
} from "./collection-invitations.js";
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});
async function fixture(role: "viewer" | "editor" = "viewer", hostedSharing = true) {
  const db = await createDatabase("memory");
  cleanup.push(() => db.end());
  const { app } = await buildApp({
    db,
    devAuth: true,
    hostedCollections: true,
    hostedSharing,
    publicUrl: "http://connect.test"
  });
  cleanup.push(() => app.close());
  async function user(email: string) {
    const session = await app.inject({
      method: "POST",
      url: "/v1/dev/session",
      payload: { name: email, email }
    });
    expect(session.statusCode).toBe(200);
    const raw = session.headers["set-cookie"]!;
    const cookie = (Array.isArray(raw) ? raw[0]! : raw).split(";")[0]!;
    const rows = await db.query<{ id: string }>("SELECT id FROM users WHERE email = $1", [email]);
    return { id: rows.rows[0]!.id, cookie };
  }
  const owner = await user("owner@example.com");
  const member = await user("member@example.com");
  const collectionId = randomUUID();
  await db.query(
    `INSERT INTO hosted_collections (id, user_id, display_name, template, contracts, authority_state)
     VALUES ($1, $2, 'Review sharing', 'mdbase', '[]'::jsonb, 'active')`,
    [collectionId, owner.id]
  );
  const policy = await createHostedCollectionMembership(db, {
    collectionId,
    ownerUserId: owner.id,
    userId: member.id,
    role
  });
  return { db, app, owner, member, collectionId, policy, user };
}
async function boundReplica(f: Awaited<ReturnType<typeof fixture>>) {
  const id = randomUUID();
  await f.db.query(
    `INSERT INTO hosted_replicas (id, collection_id, authorized_user_id, name, purpose, mode, membership_id, membership_policy_id, membership_policy_revision) VALUES ($1,$2,$3,'Bound','mirror','read_write',$4,$5,1)`,
    [id, f.collectionId, f.member.id, f.policy.membershipId, f.policy.id]
  );
  return id;
}
it("lets removal supersede a pending downgrade idempotently", async () => {
  const f = await fixture("editor");
  await boundReplica(f);
  expect(
    await changeHostedCollectionMembershipRole(f.db, {
      collectionId: f.collectionId,
      actorUserId: f.owner.id,
      membershipId: f.policy.membershipId,
      role: "viewer"
    })
  ).toMatchObject({ state: "changing" });
  for (let attempt = 0; attempt < 2; attempt++)
    expect(
      await revokeHostedCollectionMembership(f.db, {
        collectionId: f.collectionId,
        actorUserId: f.owner.id,
        membershipId: f.policy.membershipId
      })
    ).toMatchObject({ state: "revoking", pendingProviderRevocations: 1 });
  expect(
    (
      await f.db.query("SELECT pending_policy_id FROM collection_memberships WHERE id = $1", [
        f.policy.membershipId
      ])
    ).rows[0].pending_policy_id
  ).toBeNull();
});
it("rejects invitations from a removed legacy editor", async () => {
  const f = await fixture("editor");
  await f.db.query("UPDATE collection_membership_policies SET actions = $2::jsonb WHERE id = $1", [
    f.policy.id,
    JSON.stringify([...new Set([...f.policy.actions, "members.manage"])])
  ]);
  const target = await f.user("target@example.com");
  const code = await createCollectionInvitationCode(f.db, target.id);
  const invitation = await createHostedCollectionInvitation(f.db, {
    collectionId: f.collectionId,
    actorUserId: f.member.id,
    role: "editor",
    target: { inviteeCode: code.code }
  });
  expect(
    await revokeHostedCollectionMembership(f.db, {
      collectionId: f.collectionId,
      actorUserId: f.owner.id,
      membershipId: f.policy.membershipId
    })
  ).toMatchObject({ state: "revoked" });
  await expect(
    acceptHostedCollectionInvitation(f.db, { userId: target.id, token: invitation.token })
  ).rejects.toMatchObject({ code: "invalid_collection_invitation" });
});

it("keeps cleanup and existing read access available with new sharing disabled", async () => {
  const f = await fixture("viewer", false);
  const overview = await f.app.inject({ url: "/v1/me", headers: { cookie: f.owner.cookie } });
  expect(overview.statusCode, overview.body).toBe(200);
  expect(overview.json()).toMatchObject({ collection_sharing_available: false });
  expect(overview.json().hosted_collections[0].access.can_manage_members).toBe(true);
  const code = await f.app.inject({
    method: "POST",
    url: "/v1/hosted/collection-invitation-codes",
    headers: { cookie: f.member.cookie }
  });
  expect(code.statusCode).toBe(404);
  const membersPath = `/v1/hosted/collections/${f.collectionId}/members`;
  expect(
    (await f.app.inject({ url: membersPath, headers: { cookie: f.owner.cookie } })).statusCode
  ).toBe(200);
  const upgrade = await f.app.inject({
    method: "PATCH",
    url: `${membersPath}/${f.policy.membershipId}`,
    headers: { cookie: f.owner.cookie },
    payload: { role: "editor" }
  });
  expect(upgrade.statusCode).toBe(404);
  const remove = await f.app.inject({
    method: "DELETE",
    url: `${membersPath}/${f.policy.membershipId}`,
    headers: { cookie: f.owner.cookie }
  });
  expect(remove.statusCode, remove.body).toBe(200);
  const after = await f.app.inject({ url: "/v1/me", headers: { cookie: f.owner.cookie } });
  expect(after.json().hosted_collections[0].access.can_manage_members).toBe(false);
});
