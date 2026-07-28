import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createDatabase, type DatabasePool } from "./db.js";
import {
  accessView,
  requireCollectionAction,
  resolveHostedCollectionAccess,
  resolveLocalCollectionAccess
} from "./collection-access.js";

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
      can_manage_members: true
    });
    expect(await resolveHostedCollectionAccess(
      database,
      otherId,
      collectionId
    )).toBeNull();
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
