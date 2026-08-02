import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { DatabasePool } from "./database-types.js";
import { createDatabase } from "./db.js";
import {
  attachInvitationEntitlement,
  BETA_ENTITLEMENT_PROFILE,
  effectiveEntitlement,
  materializeInvitationEntitlement
} from "./entitlements.js";

const resources: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (resources.length) await resources.pop()?.();
});

describe("account entitlements", () => {
  it("materializes one permanent Beta grant from an invitation", async () => {
    const { db, userId, invitationId } = await fixture();
    await attachInvitationEntitlement(
      db,
      invitationId,
      BETA_ENTITLEMENT_PROFILE
    );

    const first = await materializeInvitationEntitlement(
      db,
      userId,
      invitationId,
      BETA_ENTITLEMENT_PROFILE
    );
    const replay = await materializeInvitationEntitlement(
      db,
      userId,
      invitationId,
      BETA_ENTITLEMENT_PROFILE
    );

    expect(replay).toEqual(first);
    const grants = await db.query(
      "SELECT id FROM account_entitlement_grants WHERE user_id = $1",
      [userId]
    );
    expect(grants.rowCount).toBe(1);
    expect(await effectiveEntitlement(db, userId)).toEqual({
      profileCodes: ["beta_v1"],
      hostedStorageBytes: 1_073_741_824,
      retainedFileBytes: 2_147_483_648,
      maxDocumentBytes: 2_097_152,
      maxSingleFileBytes: 262_144_000,
      maxReplicasPerCollection: 10,
      maxHostedCollections: 10,
      maxFilesPerCollection: 10_000
    });
  });

  it("takes the maximum active limit and retains the Beta floor", async () => {
    const { db, userId, invitationId } = await fixture();
    await materializeInvitationEntitlement(
      db,
      userId,
      invitationId,
      BETA_ENTITLEMENT_PROFILE
    );
    await db.query(
      `INSERT INTO entitlement_profiles
         (code, hosted_storage_bytes, retained_file_bytes, max_document_bytes,
          max_single_file_bytes, max_replicas_per_collection,
          max_hosted_collections, max_files_per_collection)
       VALUES ('plus_test', 10737418240, 21474836480, 2097152,
               1073741824, 20, 100, 50000)`
    );
    const paidGrantId = randomUUID();
    await db.query(
      `INSERT INTO account_entitlement_grants
         (id, user_id, profile_code, source, source_reference)
       VALUES ($1, $2, 'plus_test', 'subscription', 'test-subscription')`,
      [paidGrantId, userId]
    );
    expect((await effectiveEntitlement(db, userId))?.hostedStorageBytes)
      .toBe(10_737_418_240);

    await db.query(
      `UPDATE account_entitlement_grants SET ends_at = now()
       WHERE id = $1`,
      [paidGrantId]
    );
    expect((await effectiveEntitlement(db, userId))?.hostedStorageBytes)
      .toBe(1_073_741_824);
  });

  it("rejects an unknown invitation profile", async () => {
    const { db, invitationId } = await fixture();
    await expect(attachInvitationEntitlement(db, invitationId, "missing_v1"))
      .rejects.toThrow("Unknown entitlement profile");
  });
});

async function fixture(): Promise<{
  db: DatabasePool;
  userId: string;
  invitationId: string;
}> {
  const db = await createDatabase("memory");
  resources.push(() => db.end());
  const userId = randomUUID();
  const invitationId = randomUUID();
  await db.query(
    "INSERT INTO users (id, email, name) VALUES ($1, NULL, 'Beta user')",
    [userId]
  );
  await db.query(
    `INSERT INTO invitations
       (id, email, normalized_email, token_hash, created_by, expires_at)
     VALUES ($1, 'beta@example.com', 'beta@example.com', $2,
             'operator:test', now() + interval '1 day')`,
    [invitationId, `hash-${invitationId}`]
  );
  return { db, userId, invitationId };
}
