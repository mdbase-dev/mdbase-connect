// Regressions for membership authorization and lifecycle boundaries.
import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { deleteAccountLocally } from "./account-management.js";
import { buildApp } from "./app.js";
import { createDatabase } from "./db.js";
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
import type { HostedProviderClient } from "./hosted-provider.js";
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});
async function fixture(role: "viewer" | "editor" = "viewer", hostedSharing = true) {
  const db = await createDatabase("memory");
  cleanup.push(() => db.end());
  const provider = {
    url: "https://provider.example",
    ready: vi.fn(),
    upsertAccount: vi.fn().mockResolvedValue({}),
    createCollection: vi.fn(),
    registerReplica: vi.fn(),
    revokeReplica: vi.fn(),
    rotateReplicaToken: vi.fn(),
    revokeNotificationGrant: vi.fn()
  };
  const { app } = await buildApp({
    db,
    devAuth: true,
    hostedCollections: true,
    hostedSharing,
    hostedProvider: provider as unknown as HostedProviderClient,
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
  const created = await app.inject({
    method: "POST",
    url: "/v1/hosted/collections",
    headers: { cookie: owner.cookie },
    payload: { display_name: "Review sharing", template: "mdbase", timezone: "Australia/Melbourne" }
  });
  expect(created.statusCode, created.body).toBe(201);
  const collectionId = created.json().collection.id as string;
  const policy = await createHostedCollectionMembership(db, {
    collectionId,
    ownerUserId: owner.id,
    userId: member.id,
    role
  });
  return { db, app, provider, owner, member, collectionId, policy, user };
}
it("denies a viewer writable mirror authority", async () => {
  const f = await fixture();
  const response = await f.app.inject({
    method: "POST",
    url: `/v1/hosted/collections/${f.collectionId}/replicas`,
    headers: { cookie: f.member.cookie },
    payload: { name: "Viewer writable mirror", mode: "read_write" }
  });
  expect(response.statusCode, response.body).toBe(403);
  expect(f.provider.registerReplica).not.toHaveBeenCalled();
});
async function boundReplica(f: Awaited<ReturnType<typeof fixture>>) {
  const id = randomUUID();
  await f.db.query(
    `INSERT INTO hosted_replicas (id, collection_id, authorized_user_id, name, purpose, mode, membership_id, membership_policy_id, membership_policy_revision) VALUES ($1,$2,$3,'Bound','mirror','read_write',$4,$5,1)`,
    [id, f.collectionId, f.member.id, f.policy.membershipId, f.policy.id]
  );
  return id;
}
it("deletes member accounts without losing provider cleanup", async () => {
  const f = await fixture("editor");
  const replicaId = await boundReplica(f);
  await expect(
    deleteAccountLocally(f.db, {
      userId: f.member.id,
      sessionId: randomUUID(),
      authorized: true,
      queueProviderCleanup: true
    })
  ).resolves.toMatchObject({ crossAccountReplicasRevoked: 1 });
  expect((await f.db.query("SELECT id FROM users WHERE id = $1", [f.member.id])).rows).toEqual([]);
  expect(
    (
      await f.db.query(
        "SELECT replica_id FROM provider_revocation_jobs WHERE replica_id = $1 AND completed_at IS NULL",
        [replicaId]
      )
    ).rows
  ).toHaveLength(1);
});
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

it("binds a viewer's read-only mirror and denies renewal after removal", async () => {
  const f = await fixture();
  const created = await f.app.inject({
    method: "POST",
    url: `/v1/hosted/collections/${f.collectionId}/replicas`,
    headers: { cookie: f.member.cookie },
    payload: { name: "Viewer mirror", mode: "read_only" }
  });
  expect(created.statusCode, created.body).toBe(201);
  const replicaId = created.json().replica.id;
  expect(
    (
      await f.db.query(
        "SELECT membership_id, membership_policy_id, membership_policy_revision FROM hosted_replicas WHERE id=$1",
        [replicaId]
      )
    ).rows[0]
  ).toEqual({
    membership_id: f.policy.membershipId,
    membership_policy_id: f.policy.id,
    membership_policy_revision: 1
  });
  const rotate = () =>
    f.app.inject({
      method: "POST",
      url: `/v1/hosted/replicas/${replicaId}/token`,
      headers: { cookie: f.member.cookie }
    });
  expect((await rotate()).statusCode).toBe(200);
  expect(f.provider.rotateReplicaToken).toHaveBeenCalledTimes(1);
  await revokeHostedCollectionMembership(f.db, {
    collectionId: f.collectionId,
    actorUserId: f.owner.id,
    membershipId: f.policy.membershipId
  });
  expect((await rotate()).statusCode).toBe(404);
  expect(f.provider.rotateReplicaToken).toHaveBeenCalledTimes(1);
  expect(
    (
      await f.db.query(
        "SELECT replica_id FROM provider_revocation_jobs WHERE replica_id=$1 AND completed_at IS NULL",
        [replicaId]
      )
    ).rows
  ).toHaveLength(1);
});

it.each(["read_only", "read_write"] as const)(
  "enforces viewer ceilings throughout %s pairing",
  async (mode) => {
    const f = await fixture();
    const created = await f.app.inject({
      method: "POST",
      url: "/v1/mirror-pairing-requests",
      payload: { mirror_name: "Paired mirror", mode }
    });
    expect(created.statusCode).toBe(201);
    const { pairing_id: pairingId, pairing_secret: secret } = created.json();
    const path = `/v1/mirror-pairing-requests/${pairingId}`;
    const view = await f.app.inject({ url: path, headers: { cookie: f.member.cookie } });
    expect(view.statusCode, view.body).toBe(200);
    expect(view.json().collections).toHaveLength(mode === "read_only" ? 1 : 0);
    const approval = await f.app.inject({
      method: "POST",
      url: `${path}/approve`,
      headers: { cookie: f.member.cookie },
      payload: { collection_id: f.collectionId }
    });
    expect(approval.statusCode, approval.body).toBe(mode === "read_only" ? 200 : 403);
    if (mode === "read_write") {
      expect(f.provider.registerReplica).not.toHaveBeenCalled();
      return;
    }
    const exchange = await f.app.inject({
      method: "POST",
      url: `${path}/exchange`,
      headers: { authorization: `Bearer ${secret}` }
    });
    expect(exchange.statusCode, exchange.body).toBe(200);
    expect(
      (
        await f.db.query("SELECT membership_id FROM hosted_replicas WHERE collection_id=$1", [
          f.collectionId
        ])
      ).rows
    ).toEqual([{ membership_id: f.policy.membershipId }]);
    const renew = () =>
      f.app.inject({
        method: "POST",
        url: `${path}/renew`,
        headers: { authorization: `Bearer ${secret}` }
      });
    expect((await renew()).statusCode).toBe(200);
    await revokeHostedCollectionMembership(f.db, {
      collectionId: f.collectionId,
      actorUserId: f.owner.id,
      membershipId: f.policy.membershipId
    });
    expect((await renew()).statusCode).toBe(404);
    expect(f.provider.rotateReplicaToken).toHaveBeenCalledTimes(1);
  }
);

it("compensates pairing registration when the provider response is lost", async () => {
  const f = await fixture();
  const created = await f.app.inject({
    method: "POST", url: "/v1/mirror-pairing-requests",
    payload: { mirror_name: "Interrupted mirror", mode: "read_only" }
  });
  const { pairing_id: pairingId, pairing_secret: secret } = created.json();
  const path = `/v1/mirror-pairing-requests/${pairingId}`;
  const approval = await f.app.inject({
    method: "POST", url: `${path}/approve`, headers: { cookie: f.member.cookie },
    payload: { collection_id: f.collectionId }
  });
  expect(approval.statusCode).toBe(200);
  f.provider.registerReplica.mockRejectedValueOnce(new Error("Registration response lost"));
  f.provider.revokeReplica.mockResolvedValue(undefined);
  const exchange = await f.app.inject({
    method: "POST", url: `${path}/exchange`, headers: { authorization: `Bearer ${secret}` }
  });
  expect(exchange.statusCode).toBe(500);
  const replicaId = f.provider.registerReplica.mock.calls[0]![1].id;
  expect(f.provider.revokeReplica).toHaveBeenCalledWith(replicaId);
  expect((await f.db.query("SELECT id FROM hosted_replicas WHERE id=$1", [replicaId])).rows).toEqual([]);
  expect((await f.db.query("SELECT consumed_at FROM mirror_pairing_requests WHERE id=$1", [pairingId])).rows[0].consumed_at).toBeNull();
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

it.each([false, true])(
  "retains the seat after member deletion with prior cleanup=%s",
  async (pending) => {
    const f = await fixture("editor");
    await f.db.query("UPDATE entitlement_profiles SET max_collection_member_seats=1");
    await f.db.query(
      `INSERT INTO account_collection_member_seats(id,owner_user_id,membership_id,collection_id,member_user_id)
    VALUES($1,$2,$3,$4,$5)`,
      [randomUUID(), f.owner.id, f.policy.membershipId, f.collectionId, f.member.id]
    );
    const replicaId = await boundReplica(f);
    if (pending)
      await changeHostedCollectionMembershipRole(f.db, {
        collectionId: f.collectionId,
        actorUserId: f.owner.id,
        membershipId: f.policy.membershipId,
        role: "viewer"
      });
    await deleteAccountLocally(f.db, {
      userId: f.member.id,
      sessionId: randomUUID(),
      authorized: true,
      queueProviderCleanup: true
    });
    const target = await f.user("next-member@example.com");
    const code = await createCollectionInvitationCode(f.db, target.id);
    const invitation = await createHostedCollectionInvitation(f.db, {
      collectionId: f.collectionId,
      actorUserId: f.owner.id,
      role: "viewer",
      target: { inviteeCode: code.code }
    });
    await expect(
      acceptHostedCollectionInvitation(f.db, { userId: target.id, token: invitation.token })
    ).rejects.toMatchObject({ code: "collection_member_seat_unavailable" });
    await f.db.query("UPDATE provider_revocation_jobs SET completed_at=now() WHERE replica_id=$1", [
      replicaId
    ]);
    await expect(
      acceptHostedCollectionInvitation(f.db, { userId: target.id, token: invitation.token })
    ).resolves.toMatchObject({ role: "viewer" });
  }
);

it("blocks hosted-to-local transfer until shared members are removed", async () => {
  const f = await fixture();
  const pairing = await f.app.inject({
    method: "POST",
    url: "/v1/mirror-pairing-requests",
    payload: { mirror_name: "Owner folder", mode: "read_write" }
  });
  const { pairing_id: id, pairing_secret: secret } = pairing.json();
  const headers = { authorization: `Bearer ${secret}` };
  const approved = await f.app.inject({
    method: "POST",
    url: `/v1/mirror-pairing-requests/${id}/approve`,
    headers: { cookie: f.owner.cookie },
    payload: { collection_id: f.collectionId }
  });
  expect(approved.statusCode, approved.body).toBe(200);
  expect(
    (
      await f.app.inject({
        method: "POST",
        url: `/v1/mirror-pairing-requests/${id}/exchange`,
        headers
      })
    ).statusCode
  ).toBe(200);
  const requested = await f.app.inject({
    method: "POST",
    url: `/v1/mirror-pairing-requests/${id}/authority-transfers`,
    headers,
    payload: {}
  });
  expect(requested.statusCode, requested.body).toBe(201);
  const transferId = requested.json().transfer.id;
  const approval = await f.app.inject({
    method: "POST",
    url: `/v1/authority-transfers/${transferId}/approve`,
    headers: { cookie: f.owner.cookie },
    payload: {}
  });
  expect(approval.statusCode, approval.body).toBe(200);
  const prepare = await f.app.inject({
    method: "POST",
    url: `/v1/authority-transfers/${transferId}/prepare`,
    headers,
    payload: {}
  });
  expect(prepare.statusCode, prepare.body).toBe(409);
  expect(prepare.json().error.code).toBe("authority_transfer_shared_collection");
  expect(
    (
      await f.db.query("SELECT authority_state FROM hosted_collections WHERE id=$1", [
        f.collectionId
      ])
    ).rows[0].authority_state
  ).toBe("active");
});
