import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acceptHostedCollectionInvitation,
  CollectionInvitationError,
  createCollectionInvitationCode,
  createHostedCollectionInvitation,
  listHostedCollectionInvitations,
  listHostedCollectionMembers,
  revokeHostedCollectionInvitation
} from "./collection-invitations.js";
import { createHostedCollectionMembership } from "./collection-policy.js";
import { revokeHostedCollectionMembership } from "./collection-membership-lifecycle.js";
import { createDatabase, type DatabasePool } from "./db.js";
import { effectiveEntitlement } from "./entitlements.js";
import { tokenHash } from "./security.js";
import { ProviderRevocationWorker } from "./hosted-capability-lifecycle.js";
import type { HostedProviderClient } from "./hosted-provider.js";

let database: DatabasePool | undefined;
afterEach(async () => database?.end());

describe("hosted collection invitations", () => {
  it("returns indistinguishable invitation results for known and unknown email targets", async () => {
    database = await createDatabase("memory");
    const ownerId = await insertAccount(database, "owner@example.com", true);
    const memberId = await insertAccount(database, "member@example.com");
    const collectionId = await insertHostedCollection(database, ownerId);

    const known = await createHostedCollectionInvitation(database, {
      collectionId,
      actorUserId: ownerId,
      role: "viewer",
      target: { email: " Member@Example.com " }
    });
    const unknown = await createHostedCollectionInvitation(database, {
      collectionId,
      actorUserId: ownerId,
      role: "viewer",
      target: { email: "unknown@example.com" }
    });

    expect(publicShape(known)).toEqual(publicShape(unknown));
    expect(known.submittedEmail).toBe("member@example.com");
    const stored = await database.query<{
      id: string;
      target_user_id: string | null;
      token_hash: string;
    }>(
      `SELECT id, target_user_id, token_hash FROM collection_invitations
       ORDER BY created_at, id`
    );
    expect(stored.rows.find((row) => row.id === known.id)?.target_user_id).toBe(memberId);
    expect(stored.rows.find((row) => row.id === unknown.id)?.target_user_id).toBeNull();
    expect(stored.rows.map((row) => row.token_hash)).toContain(tokenHash(known.token));
    expect(JSON.stringify(stored.rows)).not.toContain(known.token);
  });

  it("accepts only as the bound verified user and copies the invitation policy snapshot", async () => {
    database = await createDatabase("memory");
    const ownerId = await insertAccount(database, "owner@example.com", true);
    const memberId = await insertAccount(database, "member@example.com");
    const outsiderId = await insertAccount(database, "outsider@example.com");
    const collectionId = await insertHostedCollection(database, ownerId);
    const invitation = await createHostedCollectionInvitation(database, {
      collectionId,
      actorUserId: ownerId,
      role: "editor",
      target: { email: "member@example.com" }
    });
    await database.query(
      `UPDATE collection_invitations
       SET operations = '["read"]'::jsonb,
           actions = '["collection.discover","record.read","application.authorize","mirror.enroll"]'::jsonb
       WHERE id = $1`,
      [invitation.id]
    );

    await expect(effectiveEntitlement(database, ownerId)).resolves.toMatchObject({
      maxCollectionMemberSeats: 10
    });
    await expect(acceptHostedCollectionInvitation(database, {
      userId: outsiderId,
      token: invitation.token
    })).rejects.toMatchObject({ code: "invalid_collection_invitation" });
    const accepted = await acceptHostedCollectionInvitation(database, {
      userId: memberId,
      token: invitation.token
    });
    expect(accepted).toMatchObject({ collectionId, role: "editor" });
    const materialized = await database.query<{
      operations: string[];
      actions: string[];
    }>(
      `SELECT policy.operations, policy.actions
       FROM collection_memberships membership
       JOIN collection_membership_policies policy
         ON policy.id = membership.current_policy_id
       WHERE membership.id = $1`,
      [accepted.membershipId]
    );
    expect(materialized.rows[0]).toMatchObject({
      operations: ["read"],
      actions: [
        "collection.discover",
        "record.read",
        "application.authorize",
        "mirror.enroll"
      ]
    });
    const seats = await database.query<{ count: string | number }>(
      `SELECT count(*) AS count FROM account_collection_member_seats
       WHERE membership_id = $1 AND released_at IS NULL`,
      [accepted.membershipId]
    );
    expect(Number(seats.rows[0]?.count)).toBe(1);
    await expect(acceptHostedCollectionInvitation(database, {
      userId: memberId,
      token: invitation.token
    })).rejects.toMatchObject({ code: "invalid_collection_invitation" });
  });

  it("allocates the final owner-funded seat transactionally", async () => {
    database = await createDatabase("memory");
    const ownerId = await insertAccount(database, "owner@example.com", true);
    const firstId = await insertAccount(database, "first@example.com");
    const secondId = await insertAccount(database, "second@example.com");
    const collectionId = await insertHostedCollection(database, ownerId);
    await database.query(
      "UPDATE entitlement_profiles SET max_collection_member_seats = 1 WHERE code = 'beta_v1'"
    );
    const first = await createHostedCollectionInvitation(database, {
      collectionId,
      actorUserId: ownerId,
      role: "viewer",
      target: { email: "first@example.com" }
    });
    const second = await createHostedCollectionInvitation(database, {
      collectionId,
      actorUserId: ownerId,
      role: "viewer",
      target: { email: "second@example.com" }
    });
    await acceptHostedCollectionInvitation(database, {
      userId: firstId,
      token: first.token
    });

    await expect(acceptHostedCollectionInvitation(database, {
      userId: secondId,
      token: second.token
    })).rejects.toMatchObject({ code: "collection_member_seat_unavailable" });
    const pending = await database.query<{ state: string }>(
      "SELECT state FROM collection_invitations WHERE id = $1",
      [second.id]
    );
    expect(pending.rows[0]?.state).toBe("pending");
  });

  it("retains a seat until provider-backed membership revocation completes", async () => {
    database = await createDatabase("memory");
    const ownerId = await insertAccount(database, "owner@example.com", true);
    const memberId = await insertAccount(database, "member@example.com");
    const collectionId = await insertHostedCollection(database, ownerId);
    const invitation = await createHostedCollectionInvitation(database, {
      collectionId,
      actorUserId: ownerId,
      role: "viewer",
      target: { email: "member@example.com" }
    });
    const accepted = await acceptHostedCollectionInvitation(database, {
      userId: memberId,
      token: invitation.token
    });
    const policy = await database.query<{ current_policy_id: string }>(
      `SELECT current_policy_id FROM collection_memberships WHERE id = $1`,
      [accepted.membershipId]
    );
    const replicaId = randomUUID();
    await database.query(
      `INSERT INTO hosted_replicas
         (id, collection_id, authorized_user_id, name, purpose, mode,
          membership_id, membership_policy_id, membership_policy_revision)
       VALUES ($1, $2, $3, 'Mirror', 'mirror', 'read_only', $4, $5, 1)`,
      [replicaId, collectionId, memberId, accepted.membershipId,
        policy.rows[0]!.current_policy_id]
    );

    await expect(revokeHostedCollectionMembership(database, {
      collectionId,
      actorUserId: ownerId,
      membershipId: accepted.membershipId
    })).resolves.toMatchObject({ state: "revoking" });
    const pending = await database.query<{ released_at: Date | string | null }>(
      `SELECT released_at FROM account_collection_member_seats
       WHERE membership_id = $1`,
      [accepted.membershipId]
    );
    expect(pending.rows[0]?.released_at).toBeNull();

    const worker = new ProviderRevocationWorker(database, {
      revokeReplica: vi.fn(),
      revokeNotificationGrant: vi.fn()
    } as unknown as HostedProviderClient);
    await expect(worker.drain()).resolves.toBe(1);
    const released = await database.query<{ released_at: Date | string | null }>(
      `SELECT released_at FROM account_collection_member_seats
       WHERE membership_id = $1`,
      [accepted.membershipId]
    );
    expect(released.rows[0]?.released_at).not.toBeNull();
  });

  it("binds a one-use invitee-generated code without exposing account ids", async () => {
    database = await createDatabase("memory");
    const ownerId = await insertAccount(database, "owner@example.com", true);
    const memberId = await insertAccount(database, "member@example.com");
    const collectionId = await insertHostedCollection(database, ownerId);
    const generated = await createCollectionInvitationCode(database, memberId);
    const invitation = await createHostedCollectionInvitation(database, {
      collectionId,
      actorUserId: ownerId,
      role: "viewer",
      target: { inviteeCode: generated.code.toLowerCase() }
    });
    expect(invitation.targetMode).toBe("invitee_code");
    expect(invitation.submittedEmail).toBeNull();
    expect(invitation).not.toHaveProperty("targetUserId");
    await expect(createHostedCollectionInvitation(database, {
      collectionId,
      actorUserId: ownerId,
      role: "viewer",
      target: { inviteeCode: generated.code }
    })).rejects.toMatchObject({ code: "invalid_collection_invitation_code" });
    await expect(acceptHostedCollectionInvitation(database, {
      userId: memberId,
      token: invitation.token
    })).resolves.toMatchObject({ role: "viewer" });
  });

  it("does not block invited-account deletion with sharing history", async () => {
    database = await createDatabase("memory");
    const ownerId = await insertAccount(database, "owner@example.com", true);
    const memberId = await insertAccount(database, "member@example.com");
    const collectionId = await insertHostedCollection(database, ownerId);
    const invitation = await createHostedCollectionInvitation(database, {
      collectionId,
      actorUserId: ownerId,
      role: "viewer",
      target: { email: "member@example.com" }
    });
    await acceptHostedCollectionInvitation(database, {
      userId: memberId,
      token: invitation.token
    });

    await expect(database.query("DELETE FROM users WHERE id = $1", [memberId]))
      .resolves.toMatchObject({ rowCount: 1 });
    await expect(database.query(
      "SELECT id FROM account_collection_member_seats WHERE member_user_id = $1",
      [memberId]
    )).resolves.toMatchObject({ rows: [] });
    await expect(database.query(
      "SELECT id FROM collection_invitations WHERE id = $1",
      [invitation.id]
    )).resolves.toMatchObject({ rows: [] });
  });

  it("preserves invitation history when an inviter leaves and permits code-owner deletion", async () => {
    database = await createDatabase("memory");
    const ownerId = await insertAccount(database, "owner@example.com", true);
    const editorId = await insertAccount(database, "editor@example.com");
    const targetId = await insertAccount(database, "target@example.com");
    const codeTargetId = await insertAccount(database, "code-target@example.com");
    const collectionId = await insertHostedCollection(database, ownerId);
    await createHostedCollectionMembership(database, {
      collectionId,
      ownerUserId: ownerId,
      userId: editorId,
      role: "editor"
    });
    const emailInvitation = await createHostedCollectionInvitation(database, {
      collectionId,
      actorUserId: editorId,
      role: "viewer",
      target: { email: "target@example.com" }
    });
    await database.query("DELETE FROM users WHERE id = $1", [editorId]);
    await expect(database.query<{
      invited_by_user_id: string | null;
      target_user_id: string | null;
    }>(
      "SELECT invited_by_user_id, target_user_id FROM collection_invitations WHERE id = $1",
      [emailInvitation.id]
    )).resolves.toMatchObject({
      rows: [{ invited_by_user_id: null, target_user_id: targetId }]
    });

    const generated = await createCollectionInvitationCode(database, codeTargetId);
    const codeInvitation = await createHostedCollectionInvitation(database, {
      collectionId,
      actorUserId: ownerId,
      role: "viewer",
      target: { inviteeCode: generated.code }
    });
    await expect(database.query("DELETE FROM users WHERE id = $1", [codeTargetId]))
      .resolves.toMatchObject({ rowCount: 1 });
    await expect(database.query(
      "SELECT id FROM collection_invitations WHERE id = $1",
      [codeInvitation.id]
    )).resolves.toMatchObject({ rows: [] });
  });

  it("allows editors to manage invitations and returns privacy-safe lists", async () => {
    database = await createDatabase("memory");
    const ownerId = await insertAccount(database, "owner@example.com", true);
    const editorId = await insertAccount(database, "editor@example.com");
    const targetId = await insertAccount(database, "target@example.com");
    const outsiderId = await insertAccount(database, "outsider@example.com");
    const collectionId = await insertHostedCollection(database, ownerId);
    await createHostedCollectionMembership(database, {
      collectionId,
      ownerUserId: ownerId,
      userId: editorId,
      role: "editor"
    });
    const invitation = await createHostedCollectionInvitation(database, {
      collectionId,
      actorUserId: editorId,
      role: "viewer",
      target: { email: "target@example.com" }
    });

    const invitations = await listHostedCollectionInvitations(
      database,
      editorId,
      collectionId
    );
    expect(invitations).toEqual([
      expect.objectContaining({
        id: invitation.id,
        submitted_email: "target@example.com",
        role: "viewer",
        state: "pending"
      })
    ]);
    expect(JSON.stringify(invitations)).not.toContain(targetId);
    await expect(listHostedCollectionMembers(database, outsiderId, collectionId))
      .rejects.toMatchObject({ code: "collection_sharing_not_found" });
    await expect(revokeHostedCollectionInvitation(database, {
      collectionId,
      actorUserId: editorId,
      invitationId: invitation.id
    })).resolves.toBe(true);
    await expect(acceptHostedCollectionInvitation(database, {
      userId: targetId,
      token: invitation.token
    })).rejects.toBeInstanceOf(CollectionInvitationError);
  });
});

function publicShape(invitation: {
  targetMode: string;
  role: string;
  state: string;
  expiresAt: Date;
}) {
  return {
    targetMode: invitation.targetMode,
    role: invitation.role,
    state: invitation.state,
    expiresInDays: Math.round(
      (invitation.expiresAt.getTime() - Date.now()) / (24 * 60 * 60 * 1_000)
    )
  };
}

async function insertAccount(
  db: DatabasePool,
  email: string,
  entitled = false
): Promise<string> {
  const id = randomUUID();
  await db.query(
    "INSERT INTO users (id, email, name) VALUES ($1, $2, $3)",
    [id, email, email.split("@")[0]]
  );
  await db.query(
    `INSERT INTO email_identities
       (id, user_id, email, normalized_email, verified_at, is_primary)
     VALUES ($1, $2, $3, $3, now(), true)`,
    [randomUUID(), id, email]
  );
  if (entitled) {
    await db.query(
      `INSERT INTO account_entitlement_grants
         (id, user_id, profile_code, source, source_reference)
       VALUES ($1, $2, 'beta_v1', 'operator', $3)`,
      [randomUUID(), id, `test-${id}`]
    );
    await db.query(
      `INSERT INTO account_storage_accounts (user_id, provider_account_id)
       VALUES ($1, $2)`,
      [id, randomUUID()]
    );
  }
  return id;
}

async function insertHostedCollection(db: DatabasePool, ownerId: string): Promise<string> {
  const id = randomUUID();
  await db.query(
    `INSERT INTO hosted_collections
       (id, user_id, display_name, template, provider_url, authority_state)
     VALUES ($1, $2, 'Shared', 'mdbase', 'https://provider.example', 'active')`,
    [id, ownerId]
  );
  return id;
}
