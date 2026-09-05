import { randomUUID } from "node:crypto";
import { LEGACY_READ_CAPABILITIES, LEGACY_READ_OPERATIONS } from "../../legacy-issuance.test-helper.js";
import { operationsForApplicationCapabilities, type CollectionOperation } from "@mdbase-dev/connect-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { testApplicationAuthorization } from "../../application-authorization.test-helper.js";
import type { CollectionAccessContext } from "../../collection-access.js";
import { createDatabase, type DatabasePool } from "../../db.js";
import type { HostedProviderClient } from "../../hosted-provider.js";
import { pkceChallenge } from "../../security.js";
import type { RelayHub } from "../../relay.js";
import { approveHostedAuthorization, approvePortalAuthorization } from "./approval-service.js";

const databases: DatabasePool[] = [];
const providers: HostedProviderClient[] = [];

afterEach(async () => {
  while (databases.length > 0) await databases.pop()!.end();
  for (const provider of providers.splice(0)) expect(provider.registerReplica).not.toHaveBeenCalled();
});

describe("fresh issuance policy for seeded pending requests", () => {
  it.each(["local", "hosted"] as const)("denies pending v2 %s approval before any cleanup or provider effects", async (kind) => {
    const fixture = await retainedReplicaFixture({ version: 2 });
    if (kind === "local") {
      await fixture.db.query(
        "UPDATE authorization_requests SET grant_id = $2, activation_started_at = now() - interval '2 minutes' WHERE id = $1",
        [fixture.input.requestId, fixture.grantId]
      );
    }
    const before = await fixture.db.query("SELECT * FROM grants");
    const pendingBefore = await fixture.db.query("SELECT * FROM authorization_requests");
    const provider = providerStub({ updateApplicationReplica: vi.fn(), revokeReplica: vi.fn(), revokeNotificationGrant: vi.fn() });
    const relay = { pushPolicy: vi.fn(), activateGrant: vi.fn() };
    const connection = await fixture.db.connect();
    const queries = vi.spyOn(connection, "query");
    const connect = vi.spyOn(fixture.db, "connect").mockResolvedValueOnce(connection);
    const approval = kind === "hosted"
      ? approveHostedAuthorization(fixture.db, provider, fixture.input)
      : approvePortalAuthorization(fixture.db, relay as unknown as RelayHub, { ...fixture.input, offerId: randomUUID() });
    await expect(approval).rejects.toThrow("Fresh application authorization issuance is disabled for semantic capability contract version 2.");
    expect(queries.mock.calls.map(([sql]) => String(sql).trim().split(/\s+/)[0])).toEqual(["BEGIN", "SELECT", "ROLLBACK"]);
    queries.mockRestore();
    connect.mockRestore();
    expect((await fixture.db.query("SELECT * FROM grants")).rows).toEqual(before.rows);
    expect((await fixture.db.query("SELECT * FROM authorization_requests")).rows).toEqual(pendingBefore.rows);
    for (const method of Object.values(provider)) expect(method).not.toHaveBeenCalled();
    for (const method of Object.values(relay)) expect(method).not.toHaveBeenCalled();
  });
});

// Semantic-neutral fault coverage uses genuine v1 old and replacement policies.
// Retained v2 evidence validation is tested directly in hosted-replica-policy.test.ts.
describe("approveHostedAuthorization prelude v1 retained replica recovery", () => {
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

  it("revokes without masking the original error when retained v1 proof is unavailable", async () => {
    const fixture = await retainedReplicaFixture();
    await fixture.db.query(
      "UPDATE grants SET application_authorization = NULL WHERE id = $1",
      [fixture.grantId]
    );
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
  const provider = {
    provisionApplicationSetup: vi.fn(),
    registerReplica: vi.fn(),
    upsertNotificationGrant: vi.fn(),
    ...overrides
  } as unknown as HostedProviderClient;
  providers.push(provider);
  return provider;
}

async function retainedReplicaFixture(options: {
  version?: 1 | 2;
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
  const version = options.version ?? 1;
  const priorOperations: CollectionOperation[] = version === 1 ? ["describe", "query", "sync"]
    : operationsForApplicationCapabilities({ contract_version: 2, required: ["collection.read", "offline.replica"] });
  const oldProof = await testApplicationAuthorization({
    applicationId,
    applicationDeclarationId: "dev.mdbase.restore-test",
    applicationManifestDigest: manifestDigest,
    flow: options.priorFlow ?? "device_code",
    codeChallenge: pkceChallenge("old-policy-verifier-that-is-long-enough-0001"),
    requestedOperations: priorOperations,
    operationTransportRecovery: [2],
    semanticCapabilityContractVersion: version,
    ...(options.priorRedirectUri
      ? { redirectUri: options.priorRedirectUri }
      : {}),
    ...(options.priorFlow === "authorization_code"
      ? { state: "prior-state" }
      : {})
  });
  const operations: CollectionOperation[] = version === 1 ? LEGACY_READ_OPERATIONS : [
    "describe", "changes", "read", "query", "list_views", "execute_view",
    "read_view_source", "validate", "read_type"
  ];
  const newProof = await testApplicationAuthorization({
    applicationId,
    applicationDeclarationId: "dev.mdbase.restore-test",
    applicationManifestDigest: manifestDigest,
    flow: "device_code",
    codeChallenge: pkceChallenge("new-policy-verifier-that-is-long-enough-0002"),
    requestedOperations: operations,
    semanticCapabilityContractVersion: version
  });
  const requirements = {
    contracts: [],
    access: "full_collection",
    collection_kind: "hosted",
    capabilities: {
      contract_version: version,
      required: version === 1 ? LEGACY_READ_CAPABILITIES : ["collection.read"],
      optional: version === 1 ? ["sync.offline-replica"] : ["offline.replica"]
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
     VALUES ($1, $2, $3, $4, $5, $9::jsonb,
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
      JSON.stringify(oldProof),
      JSON.stringify(priorOperations)
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
      allowedOperations: priorOperations.filter((operation) => operation !== "sync"),
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
