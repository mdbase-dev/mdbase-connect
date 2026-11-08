import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { DatabasePool } from "./database-types.js";
import { createDatabase } from "./db.js";
import {
  attachInvitationEntitlement,
  BETA_ENTITLEMENT_PROFILE,
  effectiveEntitlement,
  FREE_ENTITLEMENT_PROFILE,
  materializeInvitationEntitlement,
  materializePublicSignupEntitlement,
  OPEN_BETA_ENTITLEMENT_PROFILE,
  reconcileHostedAccountCollections
} from "./entitlements.js";
import {
  HostedProviderResponseError,
  type HostedAccountLimits,
  type HostedAccountUsage,
  type HostedProviderClient
} from "./hosted-provider.js";

const resources: Array<() => Promise<void>> = [];
const TRIAL_ENTITLEMENT_PROFILE = "trial_v1";

const FREE_LIMITS = {
  hostedStorageBytes: 262_144_000,
  retainedFileBytes: 524_288_000,
  maxDocumentBytes: 2_097_152,
  maxSingleFileBytes: 104_857_600,
  maxMirrorReplicasPerCollection: 10,
  maxApplicationReplicasPerCollection: 50,
  maxHostedCollections: 1,
  maxFilesPerCollection: 10_000,
  maxCollectionMemberSeats: 1
};

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
      maxMirrorReplicasPerCollection: 10,
      maxApplicationReplicasPerCollection: 50,
      maxHostedCollections: 10,
      maxFilesPerCollection: 10_000,
      maxCollectionMemberSeats: 10,
      trial: null
    });
  });

  it("grants a public signup the permanent free plan and a 30-day storage trial", async () => {
    const { db, userId } = await fixture();

    const { trialEndsAt } = await materializePublicSignupEntitlement(db, userId);

    const days = (trialEndsAt.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29.99);
    expect(days).toBeLessThanOrEqual(30);
    const grants = await db.query<{ profile_code: string; ends_at: Date | null }>(
      `SELECT profile_code, ends_at FROM account_entitlement_grants
       WHERE user_id = $1 ORDER BY profile_code`,
      [userId]
    );
    expect(grants.rows).toEqual([
      { profile_code: FREE_ENTITLEMENT_PROFILE, ends_at: null },
      { profile_code: TRIAL_ENTITLEMENT_PROFILE, ends_at: trialEndsAt }
    ]);
    expect(await effectiveEntitlement(db, userId)).toEqual({
      ...FREE_LIMITS,
      profileCodes: [FREE_ENTITLEMENT_PROFILE, TRIAL_ENTITLEMENT_PROFILE],
      hostedStorageBytes: 5_368_709_120,
      retainedFileBytes: 5_368_709_120,
      trial: { endsAt: trialEndsAt, hostedStorageBytesAfter: 262_144_000 }
    });
    await expect(materializePublicSignupEntitlement(db, userId)).rejects.toThrow();
  });

  it("falls back to the free plan when the storage trial ends", async () => {
    const { db, userId } = await fixture();
    await materializePublicSignupEntitlement(db, userId);

    await db.query(
      `UPDATE account_entitlement_grants
       SET starts_at = now() - interval '31 days', ends_at = now() - interval '1 day'
       WHERE user_id = $1 AND profile_code = $2`,
      [userId, TRIAL_ENTITLEMENT_PROFILE]
    );

    expect(await effectiveEntitlement(db, userId)).toEqual({
      ...FREE_LIMITS,
      profileCodes: [FREE_ENTITLEMENT_PROFILE],
      trial: null
    });
  });

  it("reports no trial when another grant already holds at least its storage", async () => {
    const { db, userId } = await fixture();
    await materializePublicSignupEntitlement(db, userId);
    await db.query(
      `UPDATE entitlement_profiles SET hosted_storage_bytes = 5368709120,
         retained_file_bytes = 10737418240
       WHERE code = $1`,
      [OPEN_BETA_ENTITLEMENT_PROFILE]
    );
    await db.query(
      `INSERT INTO account_entitlement_grants
         (id, user_id, profile_code, source, source_reference)
       VALUES ($1, $2, $3, 'operator', 'test')`,
      [randomUUID(), userId, OPEN_BETA_ENTITLEMENT_PROFILE]
    );

    expect((await effectiveEntitlement(db, userId))?.trial).toBeNull();
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
          max_single_file_bytes, max_mirror_replicas_per_collection,
          max_application_replicas_per_collection,
          max_hosted_collections, max_files_per_collection)
       VALUES ('plus_test', 10737418240, 21474836480, 2097152,
               1073741824, 20, 75, 100, 50000)`
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

  it("isolates only a typed missing collection during batch reconciliation", async () => {
    const { db, userId, invitationId } = await fixture();
    await materializeInvitationEntitlement(
      db,
      userId,
      invitationId,
      BETA_ENTITLEMENT_PROFILE
    );
    const collectionId = randomUUID();
    await db.query(
      `INSERT INTO hosted_collections (id, user_id, display_name, template)
       VALUES ($1, $2, 'Missing provider collection', 'blank')`,
      [collectionId, userId]
    );
    const missing: string[] = [];
    const result = await reconcileHostedAccountCollections(
      db,
      reconciliationProvider(() => {
        throw new HostedProviderResponseError(
          404,
          "hosted_collection_not_found",
          "Hosted collection not found."
        );
      }),
      userId,
      { onMissingCollection: async (id) => { missing.push(id); } }
    );
    expect(result.reconciledCollections).toBe(0);
    expect(missing).toEqual([collectionId]);
  });

  it("keeps collection ownership conflicts visible during reconciliation", async () => {
    const { db, userId, invitationId } = await fixture();
    await materializeInvitationEntitlement(
      db,
      userId,
      invitationId,
      BETA_ENTITLEMENT_PROFILE
    );
    await db.query(
      `INSERT INTO hosted_collections (id, user_id, display_name, template)
       VALUES ($1, $2, 'Conflicting provider collection', 'blank')`,
      [randomUUID(), userId]
    );
    await expect(reconcileHostedAccountCollections(
      db,
      reconciliationProvider(() => {
        throw new HostedProviderResponseError(
          409,
          "hosted_collection_account_conflict",
          "The hosted collection belongs to another account."
        );
      }),
      userId,
      { onMissingCollection: async () => undefined }
    )).rejects.toMatchObject({ code: "hosted_collection_account_conflict" });
  });

  it("rejects an unknown invitation profile", async () => {
    const { db, invitationId } = await fixture();
    await expect(attachInvitationEntitlement(db, invitationId, "missing_v1"))
      .rejects.toThrow("Unknown entitlement profile");
  });
});

function reconciliationProvider(
  reconcile: () => void | Promise<void>
): HostedProviderClient {
  let usage: HostedAccountUsage | undefined;
  return {
    async upsertAccount(
      accountId: string,
      entitlementRevision: number,
      limits: HostedAccountLimits
    ) {
      usage = {
        account_id: accountId,
        entitlement_revision: entitlementRevision,
        collection_count: 0,
        live_content_bytes: 0,
        live_file_bytes: 0,
        retained_file_bytes: 0,
        limits
      };
      return usage;
    },
    async reconcileCollectionAccount() {
      await reconcile();
    },
    async accountUsage() {
      if (!usage) throw new Error("Hosted account was not reconciled.");
      return usage;
    }
  } as unknown as HostedProviderClient;
}

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
