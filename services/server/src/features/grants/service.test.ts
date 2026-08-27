import type {
  ApplicationAuthorizationProof,
  GrantSummary,
  NotificationCriterion
} from "@mdbase-dev/connect-protocol";
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  createDatabase,
  type DatabasePool,
  type DatabaseQueryable
} from "../../db.js";
import {
  HostedProviderResponseError,
  type HostedProviderClient
} from "../../hosted-provider.js";
import type { RelayHub } from "../../relay.js";
import {
  reconcileApplicationGrants,
  syncHostedNotificationGrant
} from "./service.js";

const collectionId = "00000000-0000-4000-8000-000000000001";
const grantId = "00000000-0000-4000-8000-000000000002";
const applicationId = "00000000-0000-4000-8000-000000000003";
const applicationManifestDigest = "a".repeat(64);

const notificationCriteria: NotificationCriterion[] = [{
  id: "task.reminder",
  event: {
    id: "mdbase.runtime.timer.fired",
    version: "1.0.0",
    digest: `sha256:${"4".repeat(64)}`
  },
  presentation: {
    title: "Task reminder",
    body: "Open TaskNotes to view your task."
  }
}];

const applicationAuthorization = {
  binding: {
    protocol_version: 4,
    authorization_id: "00000000-0000-4000-8000-000000000004",
    application_id: applicationId,
    application_declaration_id: "dev.tasknotes.app",
    application_manifest_digest: applicationManifestDigest,
    application_installation_id: "00000000-0000-4000-8000-000000000005",
    installation_signing_public_key: "i".repeat(80),
    grant_agreement_public_key: "a".repeat(80),
    grant_signing_public_key: "s".repeat(80),
    flow: "authorization_code",
    authorization_nonce: "nonce",
    issued_at: "2026-08-05T20:00:00.000Z",
    expires_at: "2026-08-05T20:10:00.000Z",
    redirect_uri: "https://app.tasknotes.dev/auth/mdbase/callback",
    code_challenge: "c".repeat(43),
    contracts: {
      operation_transport: 2,
      authorization_binding: 4,
      semantic_capabilities: 1,
      durable_mutation: 1
    },
    requested_operations: ["query"]
  },
  signature: "signature"
} satisfies ApplicationAuthorizationProof;

describe("hosted notification grant synchronization", () => {
  it("sends the exact approved application identity required by the provider", async () => {
    const query = vi.fn(async () => ({
      rows: [{
        id: grantId,
        application_id: applicationId,
        application_name: "TaskNotes",
        application_distribution: "web" as const,
        application_homepage: "https://app.tasknotes.dev/",
        application_project_url: null,
        application_origin: "https://app.tasknotes.dev",
        application_icon: "https://app.tasknotes.dev/icon.png",
        collection_id: collectionId,
        collection_name: "Tasks",
        operations: ["query"],
        scope: { contracts: [], access: "full_collection" as const },
        notification_criteria: notificationCriteria,
        file_capability: null,
        created_at: new Date("2026-08-05T20:00:00.000Z"),
        application_authorization: applicationAuthorization
      }],
      rowCount: 1
    }));
    const upsertNotificationGrant = vi.fn(async () => undefined);
    const db = { query } as unknown as DatabaseQueryable;
    const provider = { upsertNotificationGrant } as unknown as HostedProviderClient;

    await syncHostedNotificationGrant(db, provider, grantId);

    expect(query).toHaveBeenCalledWith(expect.stringContaining(
      "a.distribution AS application_distribution"
    ), [grantId]);
    expect(upsertNotificationGrant).toHaveBeenCalledOnce();
    expect(upsertNotificationGrant).toHaveBeenCalledWith(
      collectionId,
      expect.objectContaining({
        application_declaration_id: "dev.tasknotes.app",
        application_manifest_digest: applicationManifestDigest,
        application_distribution: "web"
      }) satisfies Partial<GrantSummary>
    );
  });

  it("quarantines a confirmed missing collection without blocking another account", async () => {
    const fixture = await reconciliationFixture(2);
    try {
      const upsertNotificationGrant = vi.fn(async (candidateCollectionId: string) => {
        if (candidateCollectionId === fixture.collectionIds[0]) {
          throw new HostedProviderResponseError(
            404,
            "hosted_collection_not_found",
            "Hosted collection not found."
          );
        }
      });
      const provider = { upsertNotificationGrant } as unknown as HostedProviderClient;

      await expect(reconcileApplicationGrants(
        fixture.db,
        { pushPolicy: vi.fn() } as unknown as RelayHub,
        provider,
        fixture.application
      )).resolves.toBeUndefined();

      expect(upsertNotificationGrant).toHaveBeenCalledTimes(2);
      const grants = await fixture.db.query<{ id: string; revoked_at: Date | null }>(
        "SELECT id, revoked_at FROM grants ORDER BY id"
      );
      expect(grants.rows.find(({ id }) => id === fixture.grantIds[0])?.revoked_at)
        .toBeTruthy();
      expect(grants.rows.find(({ id }) => id === fixture.grantIds[1])?.revoked_at)
        .toBeNull();
      expect((await fixture.db.query(
        `SELECT quarantine_reason FROM hosted_collections
         WHERE id = $1 AND quarantined_at IS NOT NULL`,
        [fixture.collectionIds[0]]
      )).rows).toEqual([{
        quarantine_reason: "provider_collection_missing"
      }]);
      expect((await fixture.db.query("SELECT id FROM provider_revocation_jobs")).rows)
        .toEqual([]);
    } finally {
      await fixture.db.end();
    }
  });

  it("quarantines a confirmed missing replica without blocking registration", async () => {
    const fixture = await reconciliationFixture(1);
    try {
      await fixture.db.query(
        `UPDATE hosted_replicas SET allowed_types = '["stale"]'::jsonb
         WHERE collection_id = $1`,
        [fixture.collectionIds[0]]
      );
      const provider = {
        upsertNotificationGrant: vi.fn(async () => undefined),
        updateApplicationReplica: vi.fn(async () => {
          throw new HostedProviderResponseError(
            404,
            "replica_not_found",
            "Active application capability not found."
          );
        })
      } as unknown as HostedProviderClient;

      await expect(reconcileApplicationGrants(
        fixture.db,
        { pushPolicy: vi.fn() } as unknown as RelayHub,
        provider,
        fixture.application
      )).resolves.toBeUndefined();
      const grant = await fixture.db.query<{ revoked_at: Date | null }>(
        "SELECT revoked_at FROM grants WHERE id = $1",
        [fixture.grantIds[0]]
      );
      expect(grant.rows[0].revoked_at).toBeTruthy();
      expect((await fixture.db.query(
        "SELECT reason FROM provider_revocation_jobs"
      )).rows).toEqual([{ reason: "hosted_resource_missing" }]);
    } finally {
      await fixture.db.end();
    }
  });

  it("rejects malformed persisted proof through production reconciliation", async () => {
    const fixture = await reconciliationFixture(1);
    try {
      await fixture.db.query("UPDATE grants SET application_authorization='{}'::jsonb WHERE id=$1", [fixture.grantIds[0]]);
      await expect(reconcileApplicationGrants(
        fixture.db, { pushPolicy: vi.fn() } as unknown as RelayHub,
        { upsertNotificationGrant: vi.fn() } as unknown as HostedProviderClient,
        fixture.application, fixture.grantIds[0]
      )).rejects.toMatchObject({ name: "MalformedPersistedApplicationAuthorizationError" });
    } finally { await fixture.db.end(); }
  });

  it("does not reinterpret an ownership conflict as a missing collection", async () => {
    const fixture = await reconciliationFixture(1);
    try {
      const provider = {
        upsertNotificationGrant: vi.fn(async () => {
          throw new HostedProviderResponseError(
            409,
            "hosted_collection_account_conflict",
            "Hosted collection belongs to another account."
          );
        })
      } as unknown as HostedProviderClient;

      await expect(reconcileApplicationGrants(
        fixture.db,
        { pushPolicy: vi.fn() } as unknown as RelayHub,
        provider,
        fixture.application
      )).rejects.toMatchObject({ code: "hosted_collection_account_conflict" });
      const grant = await fixture.db.query<{ revoked_at: Date | null }>(
        "SELECT revoked_at FROM grants WHERE id = $1",
        [fixture.grantIds[0]]
      );
      expect(grant.rows[0].revoked_at).toBeNull();
      expect((await fixture.db.query("SELECT id FROM provider_revocation_jobs")).rows)
        .toEqual([]);
    } finally {
      await fixture.db.end();
    }
  });
});

async function reconciliationFixture(accountCount: number): Promise<{
  db: DatabasePool;
  collectionIds: string[];
  grantIds: string[];
  application: Parameters<typeof reconcileApplicationGrants>[3];
}> {
  const db = await createDatabase("memory");
  const applicationId = randomUUID();
  await db.query(
    `INSERT INTO applications
       (id, canonical_identity, family_identity, name, homepage, redirect_uris,
        requirements, notifications, manifest_digest)
     VALUES ($1, 'https://app.example', 'bundle:dev.tasknotes.app', 'Shared app',
             'https://app.example', '[]'::jsonb, $2::jsonb, $3::jsonb, $4)`,
    [
      applicationId,
      JSON.stringify({
        configuration: [],
        contracts: [],
        access: "full_collection",
        collection_kind: "hosted"
      }),
      JSON.stringify({ criteria: notificationCriteria }),
      applicationManifestDigest
    ]
  );
  const collectionIds: string[] = [];
  const grantIds: string[] = [];
  for (let index = 0; index < accountCount; index += 1) {
    const userId = randomUUID();
    const collectionId = randomUUID();
    const replicaId = randomUUID();
    const grantId = randomUUID();
    collectionIds.push(collectionId);
    grantIds.push(grantId);
    await db.query(
      "INSERT INTO users (id, email, name) VALUES ($1, $2, 'User')",
      [userId, `${userId}@example.com`]
    );
    await db.query(
      `INSERT INTO hosted_collections
         (id, user_id, display_name, template, contracts)
       VALUES ($1, $2, 'Hosted collection', 'mdbase', '[]'::jsonb)`,
      [collectionId, userId]
    );
    await db.query(
      `INSERT INTO hosted_replicas
         (id, collection_id, authorized_user_id, name, purpose, mode,
          allowed_types)
       VALUES ($1, $2, $3, 'Application', 'application', 'read_only',
               '[]'::jsonb)`,
      [replicaId, collectionId, userId]
    );
    await db.query(
      `INSERT INTO grants
         (id, user_id, application_id, hosted_collection_id,
          hosted_replica_id, operations, scope, notification_criteria,
          application_origin, proof_public_key, application_authorization)
       VALUES ($1, $2, $3, $4, $5, '["query"]'::jsonb,
               '{"contracts":[],"access":"full_collection"}'::jsonb,
               $6::jsonb, 'https://app.example', 'proof-key', $7::jsonb)`,
      [
        grantId,
        userId,
        applicationId,
        collectionId,
        replicaId,
        JSON.stringify(notificationCriteria),
        JSON.stringify(applicationAuthorization)
      ]
    );
  }
  return {
    db,
    collectionIds,
    grantIds,
    application: {
      id: applicationId,
      family_identity: "bundle:dev.tasknotes.app",
      manifest_digest: applicationManifestDigest,
      requirements: {
        configuration: [],
        contracts: [],
        access: "full_collection",
        collection_kind: "hosted"
      },
      notifications: { criteria: notificationCriteria }
    }
  };
}
