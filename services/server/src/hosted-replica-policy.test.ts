import { randomUUID } from "node:crypto";
import { operationsForApplicationCapabilities } from "@mdbase-dev/connect-protocol";
import { describe, expect, it, vi } from "vitest";
import { testApplicationAuthorization } from "./application-authorization.test-helper.js";
import { pkceChallenge } from "./security.js";
import { registerApplicationManifest } from "./manifest.js";
import { hostedReplicaCollectionOperations, retainedReplicaPolicy } from "./hosted-replica-policy.js";

describe("hosted replica policy", () => {
  it.each(["complete", "proof", "declaration"] as const)("restores committed v2 policy only with complete evidence: %s", async (missing) => {
    // Test-only precommitted proof; no pending request or fresh authority issuance.
    const capabilities = { contract_version: 2 as const, required: ["collection.read", "offline.replica"] as const };
    const operations = operationsForApplicationCapabilities(capabilities);
    const { manifest: declaration, digest } = registerApplicationManifest({
      manifest_version: 1, distribution: "portable", id: "dev.mdbase.retained",
      name: "Retained policy fixture",
      requirements: { contracts: [], access: "full_collection", capabilities }
    });
    const proof = await testApplicationAuthorization({
      applicationId: randomUUID(), applicationDeclarationId: "dev.mdbase.retained",
      applicationManifestDigest: digest, flow: "device_code",
      codeChallenge: pkceChallenge("retained-policy-verifier-long-enough-000001"),
      requestedOperations: operations,
      semanticCapabilityContractVersion: 2, operationTransportRecovery: [2]
    });
    const retained = {
      id: randomUUID(), hosted_replica_id: randomUUID(), application_installation_id: proof.binding.application_installation_id,
      scope: { access: "full_collection" as const, contracts: [] }, operations,
      file_capability: null, application_origin: "https://prior.example", proof_public_key: proof.binding.grant_signing_public_key,
      application_authorization: missing === "proof" ? null : proof,
      application_family_identity: "bundle:dev.mdbase.retained", application_manifest_digest: digest,
      application_declaration: missing === "declaration" ? null : declaration,
      replica_mode: "read_only" as const, allowed_types: []
    };
    const provider = { updateApplicationReplica: vi.fn().mockResolvedValue(undefined), revokeReplica: vi.fn().mockRejectedValue(new Error("revoke response lost")) };
    await expect(retainedReplicaPolicy.compensation(provider, retained.hosted_replica_id, retained)()).resolves.toBeUndefined();
    if (missing === "complete") {
      expect(provider.revokeReplica).not.toHaveBeenCalled();
      expect(provider.updateApplicationReplica).toHaveBeenCalledExactlyOnceWith(retained.hosted_replica_id, {
        applicationDeclaration: declaration, applicationAuthorization: proof, grantId: retained.id,
        mode: "read_only", allowedTypes: [], contractScope: [], fullCollection: true,
        allowedOperations: operations.filter((operation) => operation !== "sync"), operationTransportProtocol: proof.binding.contracts.operation_transport,
        operationTransportRecoveryProtocols: [2], fileCapability: undefined, allowedOrigin: "https://prior.example",
        proofPublicKey: proof.binding.grant_signing_public_key, applicationDeclarationId: "dev.mdbase.retained",
        applicationDeclarationDigest: `sha256:${digest}`
      });
    } else {
      expect(provider.updateApplicationReplica).not.toHaveBeenCalled();
      expect(provider.revokeReplica).toHaveBeenCalledExactlyOnceWith(retained.hosted_replica_id);
    }
  });
  it("keeps transport capabilities on the grant side of the provider boundary", () => {
    const grantOperations = ["read", "sync", "changes", "update"];

    expect(hostedReplicaCollectionOperations(grantOperations)).toEqual([
      "read",
      "changes",
      "update"
    ]);
    expect(grantOperations).toEqual(["read", "sync", "changes", "update"]);
  });
});
