import { randomUUID } from "node:crypto";
import type { CollectionOperation } from "@mdbase-dev/connect-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { testApplicationAuthorization } from "../../application-authorization.test-helper.js";
import type { CollectionAccessContext } from "../../collection-access.js";
import { createDatabase, type DatabasePool } from "../../db.js";
import type { HostedProviderClient } from "../../hosted-provider.js";
import { pkceChallenge } from "../../security.js";
import { approveHostedAuthorization } from "./approval-service.js";

const databases: DatabasePool[] = [];

afterEach(async () => {
  while (databases.length > 0) await databases.pop()!.end();
});

describe("approveHostedAuthorization retained replica recovery", () => {
  it("restores the complete prior provider policy after a later approval failure", async () => {
    const fixture = await retainedReplicaFixture();
    const originalError = new Error("notification policy update failed");
    const updateApplicationReplica = vi.fn().mockResolvedValue(undefined);
    const revokeReplica = vi.fn().mockResolvedValue(undefined);
    const provider = providerStub({
      updateApplicationReplica,
      revokeReplica,
      revokeNotificationGrant: vi.fn().mockRejectedValue(originalError)
    });

    await expect(approveHostedAuthorization(fixture.db, provider, fixture.input))
      .rejects.toBe(originalError);

    expect(updateApplicationReplica).toHaveBeenCalledTimes(2);
    expect(updateApplicationReplica.mock.calls[1]).toEqual([
      fixture.replicaId,
      fixture.priorPolicy
    ]);
    expect(revokeReplica).not.toHaveBeenCalled();
  });

  it("restores after the first provider update takes effect but its response is lost", async () => {
    const fixture = await retainedReplicaFixture();
    const originalError = new Error("provider update response lost");
    const updateApplicationReplica = vi.fn()
      .mockRejectedValueOnce(originalError)
      .mockResolvedValueOnce(undefined);
    const revokeReplica = vi.fn().mockResolvedValue(undefined);
    const provider = providerStub({
      updateApplicationReplica,
      revokeReplica,
      revokeNotificationGrant: vi.fn()
    });

    await expect(approveHostedAuthorization(fixture.db, provider, fixture.input))
      .rejects.toBe(originalError);

    expect(updateApplicationReplica).toHaveBeenCalledTimes(2);
    expect(updateApplicationReplica.mock.calls[1]).toEqual([
      fixture.replicaId,
      fixture.priorPolicy
    ]);
    expect(revokeReplica).not.toHaveBeenCalled();
  });

  it("revokes after a lost first update response when exact restoration fails", async () => {
    const fixture = await retainedReplicaFixture();
    const originalError = new Error("provider update response lost");
    const restoreError = new Error("provider policy restore failed");
    const updateApplicationReplica = vi.fn()
      .mockRejectedValueOnce(originalError)
      .mockRejectedValueOnce(restoreError);
    const revokeReplica = vi.fn().mockResolvedValue(undefined);
    const provider = providerStub({
      updateApplicationReplica,
      revokeReplica,
      revokeNotificationGrant: vi.fn()
    });

    await expect(approveHostedAuthorization(fixture.db, provider, fixture.input))
      .rejects.toBe(originalError);

    expect(updateApplicationReplica).toHaveBeenCalledTimes(2);
    expect(updateApplicationReplica.mock.calls[1]).toEqual([
      fixture.replicaId,
      fixture.priorPolicy
    ]);
    expect(revokeReplica).toHaveBeenCalledOnce();
    expect(revokeReplica).toHaveBeenCalledWith(fixture.replicaId);
  });

  it("restores no allowed origin for a prior custom-scheme authorization", async () => {
    const fixture = await retainedReplicaFixture({
      priorFlow: "authorization_code",
      priorRedirectUri: "dev.mdbase.restore-test://auth/mdbase/callback",
      priorApplicationOrigin: "https://homepage.example"
    });
    const originalError = new Error("notification policy update failed");
    const updateApplicationReplica = vi.fn().mockResolvedValue(undefined);
    const revokeReplica = vi.fn().mockResolvedValue(undefined);
    const provider = providerStub({
      updateApplicationReplica,
      revokeReplica,
      revokeNotificationGrant: vi.fn().mockRejectedValue(originalError)
    });

    await expect(approveHostedAuthorization(fixture.db, provider, fixture.input))
      .rejects.toBe(originalError);

    expect(updateApplicationReplica.mock.calls[1]).toEqual([
      fixture.replicaId,
      { ...fixture.priorPolicy, allowedOrigin: undefined }
    ]);
    expect(revokeReplica).not.toHaveBeenCalled();
  });

  it.each(["proof", "declaration"])("revokes without masking the original error when retained %s is unavailable", async (missing) => {
    const fixture = await retainedReplicaFixture();
    if (missing === "proof") {
      await fixture.db.query(
        "UPDATE grants SET application_authorization = NULL WHERE id = $1",
        [fixture.grantId]
      );
    } else {
      await fixture.db.query(
        "UPDATE applications SET application_declaration = NULL WHERE id = $1",
        [fixture.oldProof.binding.application_id]
      );
    }
    const originalError = new Error("notification policy update failed");
    const updateApplicationReplica = vi.fn().mockResolvedValue(undefined);
    const revokeReplica = vi.fn().mockRejectedValue(new Error("replica revoke failed"));
    const provider = providerStub({
      updateApplicationReplica,
      revokeReplica,
      revokeNotificationGrant: vi.fn().mockRejectedValue(originalError)
    });

    await expect(approveHostedAuthorization(fixture.db, provider, fixture.input))
      .rejects.toBe(originalError);

    expect(updateApplicationReplica).toHaveBeenCalledOnce();
    expect(revokeReplica).toHaveBeenCalledWith(fixture.replicaId);
  });
});

function providerStub(overrides: {
  updateApplicationReplica: ReturnType<typeof vi.fn>;
  revokeReplica: ReturnType<typeof vi.fn>;
  revokeNotificationGrant: ReturnType<typeof vi.fn>;
}): HostedProviderClient {
  return {
    provisionApplicationSetup: vi.fn(),
    registerReplica: vi.fn(),
    upsertNotificationGrant: vi.fn(),
    ...overrides
  } as unknown as HostedProviderClient;
}

async function retainedReplicaFixture(options: {
  priorFlow?: "authorization_code" | "device_code";
  priorRedirectUri?: string;
  priorApplicationOrigin?: string;
} = {}) {
  const db = await createDatabase("memory");
  databases.push(db);
  const userId = randomUUID();
  const applicationId = randomUUID();
  const collectionId = randomUUID();
  const replicaId = randomUUID();
  const grantId = randomUUID();
  const requestId = randomUUID();
  const manifestDigest = "a".repeat(64);
  const familyIdentity = "bundle:dev.mdbase.restore-test";
  const oldProof = await testApplicationAuthorization({
    applicationId,
    applicationDeclarationId: "dev.mdbase.restore-test",
    applicationManifestDigest: manifestDigest,
    flow: options.priorFlow ?? "device_code",
    codeChallenge: pkceChallenge("old-policy-verifier-that-is-long-enough-0001"),
    requestedOperations: ["describe", "query", "sync"],
    operationTransportRecovery: [2],
    ...(options.priorRedirectUri
      ? { redirectUri: options.priorRedirectUri }
      : {}),
    ...(options.priorFlow === "authorization_code"
      ? { state: "prior-state" }
      : {})
  });
  const operations: CollectionOperation[] = [
    "describe", "changes", "read", "query", "list_views", "execute_view",
    "read_view_source", "validate", "read_type"
  ];
  const newProof = await testApplicationAuthorization({
    applicationId,
    applicationDeclarationId: "dev.mdbase.restore-test",
    applicationManifestDigest: manifestDigest,
    flow: "device_code",
    codeChallenge: pkceChallenge("new-policy-verifier-that-is-long-enough-0002"),
    requestedOperations: operations
  });
  const requirements = {
    contracts: [],
    access: "full_collection",
    collection_kind: "hosted",
    capabilities: {
      contract_version: 2,
      required: ["collection.read"]
    }
  };

  const declaration = { id: "dev.mdbase.restore-test", requirements,
    provisions: { type_packs: [], configuration: [] }, notifications: { criteria: [] } };
  await db.query(
    "INSERT INTO users (id, email, name) VALUES ($1, $2, 'Policy owner')",
    [userId, `${userId}@example.test`]
  );
  await db.query(
    `INSERT INTO hosted_collections (id, user_id, display_name, template)
     VALUES ($1, $2, 'Policy collection', 'mdbase')`,
    [collectionId, userId]
  );
  await db.query(
    `INSERT INTO applications
       (id, canonical_identity, family_identity, manifest_digest, distribution,
        name, homepage, redirect_uris, requirements, provisions, notifications, application_declaration)
     VALUES ($1, $2, $3, $4, 'portable', 'Policy app', '', '[]'::jsonb,
             $5::jsonb, '{"type_packs":[],"configuration":[]}'::jsonb,
             '{"criteria":[]}'::jsonb, $6::jsonb)`,
    [
      applicationId,
      `${familyIdentity}:sha256:${manifestDigest}`,
      familyIdentity,
      manifestDigest,
      JSON.stringify(requirements),
      JSON.stringify(declaration)
    ]
  );
  await db.query(
    `INSERT INTO hosted_replicas
       (id, collection_id, authorized_user_id, name, purpose, mode, allowed_types)
     VALUES ($1, $2, $3, 'Retained app replica', 'application', 'read_only', '[]'::jsonb)`,
    [replicaId, collectionId, userId]
  );
  await db.query(
    `INSERT INTO grants
       (id, user_id, application_id, hosted_collection_id, hosted_replica_id,
        operations, scope, file_capability, proof_public_key, application_origin,
        application_authorization, application_installation_id)
     VALUES ($1, $2, $3, $4, $5, '["describe","query","sync"]'::jsonb,
             '{"access":"full_collection","contracts":[]}'::jsonb, NULL, $6,
             $7, $8::jsonb, NULL)`,
    [
      grantId,
      userId,
      applicationId,
      collectionId,
      replicaId,
      oldProof.binding.grant_signing_public_key,
      options.priorApplicationOrigin ?? "https://old.example",
      JSON.stringify(oldProof)
    ]
  );
  await db.query(
    `INSERT INTO authorization_requests
       (id, user_id, application_id, flow, requested_operations, collection_id,
        operation_transport_protocol, application_agreement_public_key,
        application_signing_public_key, application_authorization,
        application_installation_id, device_origin, expires_at)
     VALUES ($1, $2, $3, 'device_code', $4::jsonb, $5,
             $6, $7, $8, $9::jsonb, $10, 'https://new.example',
             now() + interval '10 minutes')`,
    [
      requestId,
      userId,
      applicationId,
      JSON.stringify(operations),
      collectionId,
      newProof.binding.contracts.operation_transport,
      newProof.binding.grant_agreement_public_key,
      newProof.binding.grant_signing_public_key,
      JSON.stringify(newProof),
      newProof.binding.application_installation_id
    ]
  );
  const access: CollectionAccessContext = {
    collection: {
      collectionId,
      authorityKind: "hosted",
      authorityRowId: collectionId,
      ownerUserId: userId,
      authorityEpoch: 1,
      authorityState: "active",
      displayName: "Policy collection"
    },
    userId,
    relationship: "owner",
    role: "owner",
    policyId: null,
    policyRevision: 1,
    actions: new Set(["application.authorize", "schema.manage"]),
    operationCeiling: new Set(operations)
  };

  return {
    db,
    grantId,
    replicaId,
    oldProof,
    priorPolicy: {
      grantId,
      mode: "read_only",
      allowedTypes: [],
      contractScope: [],
      fullCollection: true,
      allowedOperations: ["describe", "query"],
      operationTransportProtocol: oldProof.binding.contracts.operation_transport,
      operationTransportRecoveryProtocols: [2],
      allowedOrigin: "https://old.example",
      proofPublicKey: oldProof.binding.grant_signing_public_key,
      applicationDeclarationId: "dev.mdbase.restore-test",
      applicationDeclarationDigest: `sha256:${manifestDigest}`,
      applicationDeclaration: declaration,
      applicationAuthorization: oldProof
    },
    input: {
      requestId,
      userId,
      collectionId,
      operations,
      contracts: [],
      contractSetups: [],
      access
    }
  };
}
