import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDatabase, type DatabasePool } from "./db.js";
import type { HostedProviderClient } from "./hosted-provider.js";
import { ProviderRevocationWorker } from "./hosted-capability-lifecycle.js";
import {
  changeHostedCollectionMembershipRole,
  revokeHostedCollectionMembership
} from "./collection-membership-lifecycle.js";
import {
  createHostedCollectionMembership,
  resolveActiveMembershipPolicy
} from "./collection-policy.js";

let database: DatabasePool | undefined;
afterEach(async () => database?.end());

describe("hosted collection membership lifecycle", () => {
  it("changes an unused membership immediately with a new immutable policy", async () => {
    database = await createDatabase("memory");
    const fixture = await membershipFixture(database, "editor");

    const changed = await changeHostedCollectionMembershipRole(database, {
      collectionId: fixture.collectionId,
      actorUserId: fixture.ownerId,
      membershipId: fixture.policy.membershipId,
      role: "viewer",
      collaboration: true
    });

    expect(changed).toMatchObject({
      state: "active",
      policyRevision: 2,
      pendingProviderRevocations: 0
    });
    await expect(resolveActiveMembershipPolicy(database, {
      collectionId: fixture.collectionId,
      ownerUserId: fixture.ownerId,
      userId: fixture.memberId
    })).resolves.toMatchObject({
      role: "viewer",
      revision: 2,
      collaborationCeiling: { access: "read_only" }
    });
  });

  it("blocks access while changing and activates the new role after provider cleanup", async () => {
    database = await createDatabase("memory");
    const fixture = await membershipFixture(database, "editor");
    const applicationId = randomUUID();
    const replicaId = randomUUID();
    const grantId = randomUUID();
    await database.query(
      `INSERT INTO applications
         (id, canonical_identity, name, homepage, redirect_uris)
       VALUES ($1, $2, 'Editor', 'https://editor.example', '[]'::jsonb)`,
      [applicationId, `https://editor.example/${applicationId}`]
    );
    await database.query(
      `INSERT INTO hosted_replicas
         (id, collection_id, authorized_user_id, name, purpose, mode,
          membership_id, membership_policy_id, membership_policy_revision)
       VALUES ($1, $2, $3, 'Editor', 'application', 'read_write', $4, $5, 1)`,
      [replicaId, fixture.collectionId, fixture.memberId,
        fixture.policy.membershipId, fixture.policy.id]
    );
    await database.query(
      `INSERT INTO grants
         (id, user_id, application_id, hosted_collection_id,
          hosted_replica_id, logical_collection_id, operations, scope,
          membership_id, membership_policy_id, membership_policy_revision)
       VALUES ($1, $2, $3, $4, $5, $4, '["read","update"]'::jsonb,
               '{"access":"full_collection","contracts":[]}'::jsonb,
               $6, $7, 1)`,
      [grantId, fixture.memberId, applicationId, fixture.collectionId,
        replicaId, fixture.policy.membershipId, fixture.policy.id]
    );
    await database.query(
      `INSERT INTO access_tokens (id, token_hash, grant_id, expires_at)
       VALUES ($1, $2, $3, now() + interval '1 hour')`,
      [randomUUID(), `access-${randomUUID()}`, grantId]
    );
    await database.query(
      `INSERT INTO refresh_tokens (id, token_hash, grant_id, expires_at)
       VALUES ($1, $2, $3, now() + interval '1 hour')`,
      [randomUUID(), `refresh-${randomUUID()}`, grantId]
    );

    const changed = await changeHostedCollectionMembershipRole(database, {
      collectionId: fixture.collectionId,
      actorUserId: fixture.ownerId,
      membershipId: fixture.policy.membershipId,
      role: "viewer"
    });
    expect(changed).toMatchObject({ state: "changing", pendingProviderRevocations: 1 });
    await expect(resolveActiveMembershipPolicy(database, {
      collectionId: fixture.collectionId,
      ownerUserId: fixture.ownerId,
      userId: fixture.memberId
    })).resolves.toBeNull();
    const revoked = await database.query<{
      grant_revoked: string | null;
      replica_revoked: string | null;
      access_revoked: string | null;
      refresh_revoked: string | null;
    }>(
      `SELECT grant_record.revoked_at AS grant_revoked,
              replica.revoked_at AS replica_revoked,
              access_token.revoked_at AS access_revoked,
              refresh_token.revoked_at AS refresh_revoked
       FROM grants grant_record
       JOIN hosted_replicas replica ON replica.id = grant_record.hosted_replica_id
       JOIN access_tokens access_token ON access_token.grant_id = grant_record.id
       JOIN refresh_tokens refresh_token ON refresh_token.grant_id = grant_record.id
       WHERE grant_record.id = $1`,
      [grantId]
    );
    expect(revoked.rows[0]).toMatchObject({
      grant_revoked: expect.anything(),
      replica_revoked: expect.anything(),
      access_revoked: expect.anything(),
      refresh_revoked: expect.anything()
    });

    const revokeReplica = vi.fn();
    const revokeNotificationGrant = vi.fn();
    const worker = new ProviderRevocationWorker(database, {
      revokeReplica,
      revokeNotificationGrant
    } as unknown as HostedProviderClient);
    await expect(worker.drain()).resolves.toBe(1);
    expect(revokeReplica).toHaveBeenCalledWith(replicaId);
    expect(revokeNotificationGrant).toHaveBeenCalledWith(fixture.collectionId, grantId);
    await expect(resolveActiveMembershipPolicy(database, {
      collectionId: fixture.collectionId,
      ownerUserId: fixture.ownerId,
      userId: fixture.memberId
    })).resolves.toMatchObject({ role: "viewer", revision: 2 });
  });

  it("keeps revocation pending until every member replica is removed", async () => {
    database = await createDatabase("memory");
    const fixture = await membershipFixture(database, "viewer");
    const replicaIds = [randomUUID(), randomUUID()];
    for (const replicaId of replicaIds) {
      await database.query(
        `INSERT INTO hosted_replicas
           (id, collection_id, authorized_user_id, name, purpose, mode,
            membership_id, membership_policy_id, membership_policy_revision)
         VALUES ($1, $2, $3, 'Mirror', 'mirror', 'read_only', $4, $5, 1)`,
        [replicaId, fixture.collectionId, fixture.memberId,
          fixture.policy.membershipId, fixture.policy.id]
      );
    }

    const result = await revokeHostedCollectionMembership(database, {
      collectionId: fixture.collectionId,
      actorUserId: fixture.ownerId,
      membershipId: fixture.policy.membershipId
    });
    expect(result).toMatchObject({ state: "revoking", pendingProviderRevocations: 2 });
    await expect(resolveActiveMembershipPolicy(database, {
      collectionId: fixture.collectionId,
      ownerUserId: fixture.ownerId,
      userId: fixture.memberId
    })).resolves.toBeNull();

    const revokeReplica = vi.fn();
    const worker = new ProviderRevocationWorker(database, {
      revokeReplica,
      revokeNotificationGrant: vi.fn()
    } as unknown as HostedProviderClient);
    await expect(worker.drain(1)).resolves.toBe(1);
    const pending = await database.query<{ state: string; revoked_at: string | null }>(
      "SELECT state, revoked_at FROM collection_memberships WHERE id = $1",
      [fixture.policy.membershipId]
    );
    expect(pending.rows[0]).toEqual({ state: "revoking", revoked_at: null });

    await expect(worker.drain()).resolves.toBe(1);
    const completed = await database.query<{ state: string; revoked_at: string | null }>(
      "SELECT state, revoked_at FROM collection_memberships WHERE id = $1",
      [fixture.policy.membershipId]
    );
    expect(completed.rows[0]?.state).toBe("revoked");
    expect(completed.rows[0]?.revoked_at).not.toBeNull();
    expect(new Set(revokeReplica.mock.calls.map(([id]) => id)))
      .toEqual(new Set(replicaIds));
  });

  it("reconciles a transition after a crash following durable job completion", async () => {
    database = await createDatabase("memory");
    const fixture = await membershipFixture(database, "viewer");
    await database.query(
      `INSERT INTO hosted_replicas
         (id, collection_id, authorized_user_id, name, purpose, mode,
          membership_id, membership_policy_id, membership_policy_revision)
       VALUES ($1, $2, $3, 'Mirror', 'mirror', 'read_only', $4, $5, 1)`,
      [randomUUID(), fixture.collectionId, fixture.memberId,
        fixture.policy.membershipId, fixture.policy.id]
    );
    await revokeHostedCollectionMembership(database, {
      collectionId: fixture.collectionId,
      actorUserId: fixture.ownerId,
      membershipId: fixture.policy.membershipId
    });
    await database.query(
      `UPDATE provider_revocation_jobs
       SET state = 'completed', completed_at = now()`
    );

    const worker = new ProviderRevocationWorker(database, {
      revokeReplica: vi.fn(),
      revokeNotificationGrant: vi.fn()
    } as unknown as HostedProviderClient);
    await expect(worker.drain()).resolves.toBe(0);
    await expect(database.query<{ state: string }>(
      "SELECT state FROM collection_memberships WHERE id = $1",
      [fixture.policy.membershipId]
    )).resolves.toMatchObject({ rows: [{ state: "revoked" }] });
  });

  it("allows an editor to manage another member but denies an outsider", async () => {
    database = await createDatabase("memory");
    const ownerId = await insertUser(database, "owner@example.com");
    const editorId = await insertUser(database, "editor@example.com");
    const viewerId = await insertUser(database, "viewer@example.com");
    const outsiderId = await insertUser(database, "outsider@example.com");
    const collectionId = await insertHostedCollection(database, ownerId);
    await createHostedCollectionMembership(database, {
      collectionId, ownerUserId: ownerId, userId: editorId, role: "editor"
    });
    const viewer = await createHostedCollectionMembership(database, {
      collectionId, ownerUserId: ownerId, userId: viewerId, role: "viewer"
    });

    await expect(changeHostedCollectionMembershipRole(database, {
      collectionId,
      actorUserId: outsiderId,
      membershipId: viewer.membershipId,
      role: "editor"
    })).rejects.toThrow("members.manage");
    await expect(changeHostedCollectionMembershipRole(database, {
      collectionId,
      actorUserId: editorId,
      membershipId: viewer.membershipId,
      role: "editor"
    })).resolves.toMatchObject({ state: "active", policyRevision: 2 });
  });
});

async function membershipFixture(
  db: DatabasePool,
  role: "viewer" | "editor"
) {
  const ownerId = await insertUser(db, `${randomUUID()}@owner.example`);
  const memberId = await insertUser(db, `${randomUUID()}@member.example`);
  const collectionId = await insertHostedCollection(db, ownerId);
  const policy = await createHostedCollectionMembership(db, {
    collectionId,
    ownerUserId: ownerId,
    userId: memberId,
    role
  });
  return { ownerId, memberId, collectionId, policy };
}

async function insertUser(db: DatabasePool, email: string): Promise<string> {
  const id = randomUUID();
  await db.query(
    "INSERT INTO users (id, email, name) VALUES ($1, $2, 'User')",
    [id, email]
  );
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
