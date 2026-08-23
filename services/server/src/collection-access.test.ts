import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createDatabase, type DatabasePool } from "./db.js";
import {
  accessView,
  requireCollectionAction,
  resolveHostedCollectionAccess,
  resolveLocalCollectionAccess
} from "./collection-access.js";
import { createHostedCollectionMembership } from "./collection-policy.js";
import { listHostedCollectionsVisibleToUser } from "./collection-catalog.js";

let database: DatabasePool | undefined;
afterEach(async () => database?.end());

describe("collection access policy", () => {
  it("resolves hosted ownership through a stable logical locator", async () => {
    database = await createDatabase("memory");
    const ownerId = await insertUser(database, "owner@example.com");
    const otherId = await insertUser(database, "other@example.com");
    const collectionId = randomUUID();
    await database.query(
      `INSERT INTO hosted_collections
         (id, user_id, display_name, template, authority_epoch)
       VALUES ($1, $2, 'Shared later', 'mdbase', 7)`,
      [collectionId, ownerId]
    );

    const access = await resolveHostedCollectionAccess(
      database,
      ownerId,
      collectionId
    );
    expect(access?.collection).toMatchObject({
      collectionId,
      authorityKind: "hosted",
      authorityRowId: collectionId,
      ownerUserId: ownerId,
      authorityEpoch: 7
    });
    expect(accessView(access!)).toEqual({
      relationship: "owner",
      role: "owner",
      can_authorize_applications: true,
      can_manage_collection: true,
      can_rename_collection: true,
      can_delete_collection: true,
      can_manage_members: true
    });
    expect(await resolveHostedCollectionAccess(
      database,
      otherId,
      collectionId
    )).toBeNull();
  });

  it("resolves exact viewer and editor policies without granting owner authority", async () => {
    database = await createDatabase("memory");
    const ownerId = await insertUser(database, "owner@example.com");
    const viewerId = await insertUser(database, "viewer@example.com");
    const editorId = await insertUser(database, "editor@example.com");
    const outsiderId = await insertUser(database, "outsider@example.com");
    const collectionId = randomUUID();
    await database.query(
      `INSERT INTO hosted_collections
         (id, user_id, display_name, template, authority_epoch)
       VALUES ($1, $2, 'Shared', 'mdbase', 2)`,
      [collectionId, ownerId]
    );
    await createHostedCollectionMembership(database, {
      collectionId, ownerUserId: ownerId, userId: viewerId, role: "viewer"
    });
    await createHostedCollectionMembership(database, {
      collectionId, ownerUserId: ownerId, userId: editorId, role: "editor"
    });

    const viewer = await resolveHostedCollectionAccess(database, viewerId, collectionId);
    expect(viewer).toMatchObject({
      relationship: "member",
      role: "viewer",
      userId: viewerId,
      policyRevision: 1
    });
    expect(viewer?.operationCeiling.has("read")).toBe(true);
    expect(viewer?.operationCeiling.has("update")).toBe(false);
    expect(viewer?.fileCeiling.actions).toEqual(["list", "read"]);
    expect(accessView(viewer!)).toMatchObject({
      can_authorize_applications: true,
      can_manage_collection: false,
      can_rename_collection: false,
      can_delete_collection: false,
      can_manage_members: false
    });

    const editor = await resolveHostedCollectionAccess(database, editorId, collectionId);
    expect(editor?.actions.has("schema.manage")).toBe(true);
    expect(editor?.actions.has("members.manage")).toBe(true);
    expect(editor?.actions.has("collection.rename")).toBe(true);
    expect(editor?.actions.has("collection.delete")).toBe(false);
    expect(editor?.actions.has("authority.transfer")).toBe(false);
    expect(accessView(editor!)).toMatchObject({
      can_manage_collection: false,
      can_rename_collection: true,
      can_delete_collection: false,
      can_manage_members: true
    });
    await expect(resolveHostedCollectionAccess(database, outsiderId, collectionId))
      .resolves.toBeNull();
  });

  it("unions owned and shared hosted collections while filtering revoked policies", async () => {
    database = await createDatabase("memory");
    const ownerId = await insertUser(database, "owner@example.com");
    const memberId = await insertUser(database, "member@example.com");
    const ownedId = randomUUID();
    const sharedId = randomUUID();
    await database.query(
      `INSERT INTO hosted_collections
         (id, user_id, display_name, template)
       VALUES ($1, $2, 'Zulu owned', 'mdbase'),
              ($3, $4, 'Alpha shared', 'mdbase')`,
      [ownedId, ownerId, sharedId, memberId]
    );
    await createHostedCollectionMembership(database, {
      collectionId: sharedId,
      ownerUserId: memberId,
      userId: ownerId,
      role: "viewer"
    });

    const visible = await listHostedCollectionsVisibleToUser(database, ownerId);
    expect(visible.map(({ locator }) => locator.collectionId)).toEqual([
      sharedId,
      ownedId
    ]);

    await database.query(
      `UPDATE collection_memberships
       SET state = 'revoked', revoked_at = now()
       WHERE collection_id = $1 AND user_id = $2`,
      [sharedId, ownerId]
    );
    const afterRevocation = await listHostedCollectionsVisibleToUser(database, ownerId);
    expect(afterRevocation.map(({ locator }) => locator.collectionId)).toEqual([ownedId]);
  });

  it("does not resolve hosted member access while the authority is inactive", async () => {
    database = await createDatabase("memory");
    const ownerId = await insertUser(database, "owner@example.com");
    const memberId = await insertUser(database, "member@example.com");
    const collectionId = randomUUID();
    await database.query(
      `INSERT INTO hosted_collections
         (id, user_id, display_name, template)
       VALUES ($1, $2, 'Shared', 'mdbase')`,
      [collectionId, ownerId]
    );
    await createHostedCollectionMembership(database, {
      collectionId, ownerUserId: ownerId, userId: memberId, role: "viewer"
    });
    await database.query(
      "UPDATE hosted_collections SET authority_state = 'transferred' WHERE id = $1",
      [collectionId]
    );

    await expect(resolveHostedCollectionAccess(database, memberId, collectionId))
      .resolves.toBeNull();
    await expect(resolveHostedCollectionAccess(database, ownerId, collectionId))
      .resolves.toMatchObject({ relationship: "owner" });
  });

  it("uses local_id as the logical identity of a connector-backed collection", async () => {
    database = await createDatabase("memory");
    const ownerId = await insertUser(database, "local@example.com");
    const connectorId = randomUUID();
    const authorityRowId = randomUUID();
    const logicalId = randomUUID();
    await database.query(
      `INSERT INTO connectors (id, user_id, name, token_hash)
       VALUES ($1, $2, 'Desktop', $3)`,
      [connectorId, ownerId, randomUUID()]
    );
    await database.query(
      `INSERT INTO collections
         (id, user_id, connector_id, local_id, display_name, spec_version)
       VALUES ($1, $2, $3, $4, 'Vault', '0.3.0')`,
      [authorityRowId, ownerId, connectorId, logicalId]
    );

    const access = await resolveLocalCollectionAccess(
      database,
      ownerId,
      authorityRowId
    );
    expect(access?.collection).toMatchObject({
      collectionId: logicalId,
      authorityKind: "local",
      authorityRowId,
      connectorId
    });
    expect(requireCollectionAction(access, "authority.transfer")).toBe(access);
  });

  it("fails closed when an action is absent", async () => {
    database = await createDatabase("memory");
    expect(() => requireCollectionAction(null, "members.manage"))
      .toThrow("members.manage");
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
