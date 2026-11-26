import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createDatabase, type DatabasePool } from "../../db.js";
import {
  changeHostedCollectionMembershipRole
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
      role: "viewer"
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
    })).resolves.toMatchObject({ role: "viewer", revision: 2 });
  });

  it("reserves membership management for the owner", async () => {
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
    })).rejects.toThrow("members.manage");
    await expect(changeHostedCollectionMembershipRole(database, {
      collectionId, actorUserId: ownerId, membershipId: viewer.membershipId, role: "editor"
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
