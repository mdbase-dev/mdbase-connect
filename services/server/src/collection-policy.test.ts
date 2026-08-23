import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { COLLECTION_OPERATIONS } from "@mdbase-dev/connect-protocol";
import { createDatabase, type DatabasePool } from "./db.js";
import type { HostedProviderClient } from "./hosted-provider.js";
import { issueApplicationTokens } from "./features/authorizations/token-service.js";
import {
  createHostedCollectionMembership,
  membershipPolicyPreset,
  resolveActiveMembershipPolicy
} from "./collection-policy.js";

let database: DatabasePool | undefined;
afterEach(async () => database?.end());

describe("collection membership policy", () => {
  it("freezes exact viewer and editor ceilings without owner authority", () => {
    const viewer = membershipPolicyPreset("viewer");
    expect(viewer.actions).toEqual([
      "collection.discover",
      "record.read",
      "application.authorize",
      "mirror.enroll"
    ]);
    expect(viewer.operations).not.toContain("update");
    expect(viewer.operations).not.toContain("apply_collection_setup");
    expect(viewer.operations).toContain("read_type");
    expect(viewer.operations).toContain("assess_collection_setup");
    expect(viewer.fileCeiling.actions).toEqual(["list", "read"]);
    expect(viewer.presetVersion).toBe(2);
    expect(viewer.collaborationCeiling).toEqual({
      contract_version: 1,
      profiles: ["markdown-body-yjs-v13"],
      access: "read_only"
    });

    const editor = membershipPolicyPreset("editor");
    expect(editor.operations).toEqual(COLLECTION_OPERATIONS);
    expect(editor.actions).toEqual([
      "collection.discover",
      "record.read",
      "application.authorize",
      "mirror.enroll",
      "record.write",
      "schema.manage",
      "collection.rename",
      "members.manage"
    ]);
    expect(editor.actions).not.toContain("collection.delete");
    expect(editor.actions).not.toContain("authority.transfer");
    expect(editor.fileCeiling.actions).toEqual([
      "list", "read", "add", "replace", "move", "delete"
    ]);
    expect(editor.collaborationCeiling?.access).toBe("read_write");
  });

  it("creates and resolves one immutable hosted membership policy", async () => {
    database = await createDatabase("memory");
    const ownerId = await insertUser(database, "owner@example.com");
    const memberId = await insertUser(database, "member@example.com");
    const collectionId = await insertHostedCollection(database, ownerId);

    const created = await createHostedCollectionMembership(database, {
      collectionId,
      ownerUserId: ownerId,
      userId: memberId,
      role: "editor"
    });
    const resolved = await resolveActiveMembershipPolicy(database, {
      collectionId,
      ownerUserId: ownerId,
      userId: memberId
    });

    expect(resolved).toEqual(created);
    expect(resolved?.role).toBe("editor");
    expect(resolved?.operations).toEqual(COLLECTION_OPERATIONS);
    const stored = await database.query<{
      current_policy_id: string;
      current_policy_revision: number;
    }>(
      `SELECT current_policy_id, current_policy_revision
       FROM collection_memberships WHERE id = $1`,
      [created.membershipId]
    );
    expect(stored.rows[0]).toEqual({
      current_policy_id: created.id,
      current_policy_revision: 1
    });
    await database.query(
      "UPDATE collection_membership_policies SET collaboration_ceiling = NULL WHERE id = $1",
      [created.id]
    );
    await expect(resolveActiveMembershipPolicy(database, {
      collectionId,
      ownerUserId: ownerId,
      userId: memberId
    })).resolves.toMatchObject({ collaborationCeiling: null });
  });

  it("rejects owner memberships, duplicate active memberships, and inactive authorities", async () => {
    database = await createDatabase("memory");
    const ownerId = await insertUser(database, "owner@example.com");
    const memberId = await insertUser(database, "member@example.com");
    const collectionId = await insertHostedCollection(database, ownerId);

    await expect(createHostedCollectionMembership(database, {
      collectionId,
      ownerUserId: ownerId,
      userId: ownerId,
      role: "editor"
    })).rejects.toMatchObject({ code: "owner_is_not_member" });

    await createHostedCollectionMembership(database, {
      collectionId,
      ownerUserId: ownerId,
      userId: memberId,
      role: "viewer"
    });
    await expect(createHostedCollectionMembership(database, {
      collectionId,
      ownerUserId: ownerId,
      userId: memberId,
      role: "editor"
    })).rejects.toMatchObject({ code: "membership_exists" });

    await database.query(
      "UPDATE hosted_collections SET authority_state = 'transferring' WHERE id = $1",
      [collectionId]
    );
    await expect(createHostedCollectionMembership(database, {
      collectionId,
      ownerUserId: ownerId,
      userId: await insertUser(database, "later@example.com"),
      role: "viewer"
    })).rejects.toMatchObject({ code: "collection_unavailable" });
  });

  it("fails closed for revoked, stale, malformed, or owner-mismatched policies", async () => {
    database = await createDatabase("memory");
    const ownerId = await insertUser(database, "owner@example.com");
    const otherOwnerId = await insertUser(database, "other-owner@example.com");
    const memberId = await insertUser(database, "member@example.com");
    const collectionId = await insertHostedCollection(database, ownerId);
    const policy = await createHostedCollectionMembership(database, {
      collectionId,
      ownerUserId: ownerId,
      userId: memberId,
      role: "viewer"
    });

    await database.query(
      "UPDATE collection_memberships SET current_policy_revision = 2 WHERE id = $1",
      [policy.membershipId]
    );
    await expect(resolveActiveMembershipPolicy(database, {
      collectionId, ownerUserId: ownerId, userId: memberId
    })).resolves.toBeNull();
    await database.query(
      "UPDATE collection_memberships SET current_policy_revision = 1 WHERE id = $1",
      [policy.membershipId]
    );
    await database.query(
      `UPDATE collection_membership_policies
       SET operations = '["future_operation"]'::jsonb WHERE id = $1`,
      [policy.id]
    );
    await expect(resolveActiveMembershipPolicy(database, {
      collectionId, ownerUserId: ownerId, userId: memberId
    })).resolves.toBeNull();

    await database.query(
      "UPDATE collection_membership_policies SET operations = $2::jsonb WHERE id = $1",
      [policy.id, JSON.stringify(membershipPolicyPreset("viewer").operations)]
    );
    await database.query(
      "UPDATE collection_identities SET owner_user_id = $2 WHERE id = $1",
      [collectionId, otherOwnerId]
    );
    await expect(resolveActiveMembershipPolicy(database, {
      collectionId, ownerUserId: ownerId, userId: memberId
    })).resolves.toBeNull();

    await database.query(
      "UPDATE collection_identities SET owner_user_id = $2 WHERE id = $1",
      [collectionId, ownerId]
    );
    await database.query(
      `UPDATE collection_memberships
       SET state = 'revoked', revoked_at = now() WHERE id = $1`,
      [policy.membershipId]
    );
    await expect(resolveActiveMembershipPolicy(database, {
      collectionId, ownerUserId: ownerId, userId: memberId
    })).resolves.toBeNull();
  });

  it("relationally binds hosted grants and replicas to one user, collection, and policy", async () => {
    database = await createDatabase("memory");
    const ownerId = await insertUser(database, "owner@example.com");
    const memberId = await insertUser(database, "member@example.com");
    const otherId = await insertUser(database, "other@example.com");
    const collectionId = await insertHostedCollection(database, ownerId);
    const otherCollectionId = await insertHostedCollection(database, ownerId);
    const applicationId = randomUUID();
    await database.query(
      `INSERT INTO applications
         (id, canonical_identity, name, homepage, redirect_uris)
       VALUES ($1, $2, 'Editor', 'https://editor.example', '[]'::jsonb)`,
      [applicationId, `https://editor.example/${applicationId}`]
    );
    const policy = await createHostedCollectionMembership(database, {
      collectionId,
      ownerUserId: ownerId,
      userId: memberId,
      role: "editor"
    });
    const replicaId = randomUUID();
    await database.query(
      `INSERT INTO hosted_replicas
         (id, collection_id, authorized_user_id, name, purpose, mode,
          membership_id, membership_policy_id, membership_policy_revision)
       VALUES ($1, $2, $3, 'Editor', 'application', 'read_write',
               $4, $5, $6)`,
      [
        replicaId,
        collectionId,
        memberId,
        policy.membershipId,
        policy.id,
        policy.revision
      ]
    );
    await expect(database.query(
      `INSERT INTO grants
         (id, user_id, application_id, hosted_collection_id,
          hosted_replica_id, logical_collection_id, operations, scope,
          membership_id, membership_policy_id, membership_policy_revision)
       VALUES ($1, $2, $3, $4, $5, $4, '["read"]'::jsonb,
               '{"access":"full_collection","contracts":[]}'::jsonb,
               $6, $7, $8)`,
      [
        randomUUID(),
        memberId,
        applicationId,
        collectionId,
        replicaId,
        policy.membershipId,
        policy.id,
        policy.revision
      ]
    )).resolves.toBeDefined();

    await expect(database.query(
      `INSERT INTO grants
         (id, user_id, application_id, hosted_collection_id,
          hosted_replica_id, logical_collection_id, operations, scope,
          membership_id, membership_policy_id, membership_policy_revision)
       VALUES ($1, $2, $3, $4, $5, $4, '["read"]'::jsonb,
               '{"access":"full_collection","contracts":[]}'::jsonb,
               $6, $7, $8)`,
      [
        randomUUID(),
        otherId,
        applicationId,
        collectionId,
        replicaId,
        policy.membershipId,
        policy.id,
        policy.revision
      ]
    )).rejects.toThrow();

    await expect(database.query(
      `INSERT INTO grants
         (id, user_id, application_id, hosted_collection_id,
          hosted_replica_id, logical_collection_id, operations, scope,
          membership_id, membership_policy_id, membership_policy_revision)
       VALUES ($1, $2, $3, $4, $5, $4, '["read"]'::jsonb,
               '{"access":"full_collection","contracts":[]}'::jsonb,
               $6, $7, $8)`,
      [
        randomUUID(),
        memberId,
        applicationId,
        otherCollectionId,
        replicaId,
        policy.membershipId,
        policy.id,
        policy.revision
      ]
    )).rejects.toThrow();

    await expect(database.query(
      `INSERT INTO hosted_replicas
         (id, collection_id, authorized_user_id, name, purpose, mode,
          membership_id, membership_policy_id, membership_policy_revision)
       VALUES ($1, $2, $3, 'Wrong user', 'application', 'read_write',
               $4, $5, $6)`,
      [
        randomUUID(),
        collectionId,
        otherId,
        policy.membershipId,
        policy.id,
        policy.revision
      ]
    )).rejects.toThrow();
  });

  it("refuses token issuance after the membership policy revision changes", async () => {
    database = await createDatabase("memory");
    const ownerId = await insertUser(database, "owner@example.com");
    const memberId = await insertUser(database, "member@example.com");
    const collectionId = await insertHostedCollection(database, ownerId);
    const applicationId = randomUUID();
    await database.query(
      `INSERT INTO applications
         (id, canonical_identity, name, homepage, redirect_uris)
       VALUES ($1, $2, 'Editor', 'https://editor.example', '[]'::jsonb)`,
      [applicationId, `https://editor.example/${applicationId}`]
    );
    const policy = await createHostedCollectionMembership(database, {
      collectionId,
      ownerUserId: ownerId,
      userId: memberId,
      role: "editor"
    });
    const replicaId = randomUUID();
    const grantId = randomUUID();
    await database.query(
      `INSERT INTO hosted_replicas
         (id, collection_id, authorized_user_id, name, purpose, mode,
          membership_id, membership_policy_id, membership_policy_revision)
       VALUES ($1, $2, $3, 'Editor', 'application', 'read_write',
               $4, $5, $6)`,
      [replicaId, collectionId, memberId, policy.membershipId, policy.id, policy.revision]
    );
    await database.query(
      `INSERT INTO grants
         (id, user_id, application_id, hosted_collection_id,
          hosted_replica_id, logical_collection_id, operations, scope,
          membership_id, membership_policy_id, membership_policy_revision)
       VALUES ($1, $2, $3, $4, $5, $4, '["read","update"]'::jsonb,
               '{"access":"full_collection","contracts":[]}'::jsonb,
               $6, $7, $8)`,
      [grantId, memberId, applicationId, collectionId, replicaId,
        policy.membershipId, policy.id, policy.revision]
    );
    const rotateReplicaToken = vi.fn();
    const provider = { rotateReplicaToken } as unknown as HostedProviderClient;

    await expect(issueApplicationTokens(database, provider, grantId))
      .resolves.toMatchObject({ collection_id: collectionId, grant_id: grantId });
    expect(rotateReplicaToken).toHaveBeenCalledTimes(1);

    const replacementId = randomUUID();
    const viewer = membershipPolicyPreset("viewer");
    await database.query(
      `INSERT INTO collection_membership_policies
         (id, membership_id, revision, role, preset_version, actions,
          operations, scope_ceiling, file_ceiling)
       VALUES ($1, $2, 2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb)`,
      [replacementId, policy.membershipId, viewer.role, viewer.presetVersion,
        JSON.stringify(viewer.actions), JSON.stringify(viewer.operations),
        JSON.stringify(viewer.scopeCeiling), JSON.stringify(viewer.fileCeiling)]
    );
    await database.query(
      `UPDATE collection_memberships
       SET current_policy_id = $2, current_policy_revision = 2
       WHERE id = $1`,
      [policy.membershipId, replacementId]
    );

    await expect(issueApplicationTokens(database, provider, grantId))
      .rejects.toThrow("no longer matches");
    expect(rotateReplicaToken).toHaveBeenCalledTimes(1);
  });

  it("enforces viewer/editor roles and one active membership in the database", async () => {
    database = await createDatabase("memory");
    const ownerId = await insertUser(database, "owner@example.com");
    const memberId = await insertUser(database, "member@example.com");
    const collectionId = await insertHostedCollection(database, ownerId);
    const policy = await createHostedCollectionMembership(database, {
      collectionId,
      ownerUserId: ownerId,
      userId: memberId,
      role: "viewer"
    });

    await expect(database.query(
      `INSERT INTO collection_membership_policies
         (id, membership_id, revision, role, preset_version, actions,
          operations, scope_ceiling, file_ceiling)
       SELECT $1, membership_id, 2, 'owner', 1, actions, operations,
              scope_ceiling, file_ceiling
       FROM collection_membership_policies WHERE id = $2`,
      [randomUUID(), policy.id]
    )).rejects.toThrow();

    await database.query(
      `UPDATE collection_memberships
       SET state = 'revoked', revoked_at = now() WHERE id = $1`,
      [policy.membershipId]
    );
    await expect(createHostedCollectionMembership(database, {
      collectionId,
      ownerUserId: ownerId,
      userId: memberId,
      role: "editor"
    })).resolves.toMatchObject({ role: "editor", revision: 1 });
  });
});

async function insertUser(db: DatabasePool, email: string): Promise<string> {
  const id = randomUUID();
  await db.query(
    "INSERT INTO users (id, email, name) VALUES ($1, $2, 'User')",
    [id, email]
  );
  return id;
}

async function insertHostedCollection(
  db: DatabasePool,
  ownerId: string
): Promise<string> {
  const id = randomUUID();
  await db.query(
    `INSERT INTO hosted_collections
       (id, user_id, display_name, template, provider_url, authority_state)
     VALUES ($1, $2, 'Shared collection', 'mdbase',
             'https://provider.example', 'active')`,
    [id, ownerId]
  );
  return id;
}
