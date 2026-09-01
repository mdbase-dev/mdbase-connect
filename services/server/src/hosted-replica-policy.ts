import type {
  ApplicationAuthorizationProof,
  GrantPolicy,
  GrantScope
} from "@mdbase-dev/connect-protocol";
import type { DatabaseConnection } from "./db.js";
import { declarationIdFromFamilyIdentity } from "./features/applications/identity.js";

interface RetainedReplicaPolicySource {
  id: string;
  hosted_replica_id: string;
  application_installation_id: string | null;
  scope: GrantScope;
  operations: string[];
  file_capability: GrantPolicy["file_capability"] | null;
  application_origin: string;
  proof_public_key: string | null;
  application_authorization: ApplicationAuthorizationProof | null;
  application_family_identity: string;
  application_manifest_digest: string | null;
  replica_mode: "read_only" | "read_write";
  allowed_types: string[];
}

interface ApplicationReplicaPolicy {
  grantId: string;
  mode: "read_only" | "read_write";
  allowedTypes: string[];
  contractScope: GrantScope["contracts"];
  fullCollection: boolean;
  allowedOperations: string[];
  operationTransportProtocol: number;
  operationTransportRecoveryProtocols: number[];
  fileCapability?: NonNullable<GrantPolicy["file_capability"]>;
  allowedOrigin: string | undefined;
  proofPublicKey: string;
  applicationDeclarationId: string;
  applicationDeclarationDigest: string;
}

interface ReplicaPolicyProvider {
  updateApplicationReplica(
    replicaId: string,
    policy: ApplicationReplicaPolicy
  ): Promise<void>;
  revokeReplica(replicaId: string): Promise<void>;
}

export const retainedReplicaPolicy = {
  loadCandidates: loadRetainedReplicaPolicyCandidates,
  compensation: retainedReplicaPolicyCompensation
};

async function loadRetainedReplicaPolicyCandidates(
  connection: DatabaseConnection,
  input: {
    userId: string;
    applicationId: string;
    collectionId: string;
    applicationInstallationId: string;
  }
) {
  return connection.query<RetainedReplicaPolicySource>(
    `SELECT g.id, g.hosted_replica_id, g.application_installation_id,
            g.scope, g.operations, g.file_capability, g.application_origin,
            g.proof_public_key, g.application_authorization,
            a.family_identity AS application_family_identity,
            a.manifest_digest AS application_manifest_digest,
            replica.mode AS replica_mode, replica.allowed_types
     FROM grants g
     JOIN applications a ON a.id = g.application_id
     JOIN hosted_replicas replica ON replica.id = g.hosted_replica_id
     WHERE g.user_id = $1 AND g.application_id = $2
       AND g.hosted_collection_id = $3 AND g.revoked_at IS NULL
       AND g.hosted_replica_id IS NOT NULL
       AND (g.application_installation_id = $4 OR g.application_installation_id IS NULL)
     ORDER BY (g.application_installation_id = $4) DESC, g.created_at ASC
     FOR UPDATE`,
    [
      input.userId,
      input.applicationId,
      input.collectionId,
      input.applicationInstallationId
    ]
  );
}

/**
 * Application grants may include transport capabilities that are meaningful to
 * the SDK but are not executable collection operations at the hosted provider.
 *
 * Hosted sync authorizes each snapshot, change read, and mutation through its
 * underlying collection operation, so forwarding `sync` as an allowed
 * operation both duplicates that policy and violates the provider contract.
 */
export function hostedReplicaCollectionOperations(
  grantOperations: readonly string[]
): string[] {
  return grantOperations.filter((operation) => operation !== "sync");
}

/**
 * Capture the complete provider policy before a retained replica is updated.
 * The returned compensation revokes the replica whenever exact restoration is
 * impossible, and absorbs provider errors so the approval's original failure
 * remains the one observed by the caller.
 */
function retainedReplicaPolicyCompensation(
  provider: ReplicaPolicyProvider,
  replicaId: string,
  retained: RetainedReplicaPolicySource
): () => Promise<void> {
  const priorPolicy = completeRetainedReplicaPolicy(retained);
  return async () => {
    if (priorPolicy) {
      try {
        await provider.updateApplicationReplica(replicaId, priorPolicy);
        return;
      } catch {
        // Fall through to revocation when exact restoration fails.
      }
    }
    await provider.revokeReplica(replicaId).catch(() => undefined);
  };
}

function completeRetainedReplicaPolicy(
  retained: RetainedReplicaPolicySource
): ApplicationReplicaPolicy | null {
  if (
    !retained.application_authorization
    || !retained.proof_public_key
    || !retained.application_family_identity
    || !retained.application_manifest_digest
  ) {
    return null;
  }
  return {
    grantId: retained.id,
    mode: retained.replica_mode,
    allowedTypes: retained.allowed_types,
    contractScope: retained.scope.contracts,
    fullCollection: retained.scope.access === "full_collection",
    allowedOperations: hostedReplicaCollectionOperations(retained.operations),
    operationTransportProtocol:
      retained.application_authorization.binding.contracts.operation_transport,
    operationTransportRecoveryProtocols:
      retained.application_authorization.binding.contracts
        .operation_transport_recovery ?? [],
    fileCapability: retained.file_capability ?? undefined,
    allowedOrigin: priorAllowedOrigin(
      retained.application_authorization.binding,
      retained.application_origin
    ),
    proofPublicKey: retained.proof_public_key,
    applicationDeclarationId: declarationIdFromFamilyIdentity(
      retained.application_family_identity
    ),
    applicationDeclarationDigest:
      `sha256:${retained.application_manifest_digest}`
  };
}

function priorAllowedOrigin(
  binding: ApplicationAuthorizationProof["binding"],
  storedApplicationOrigin: string
): string | undefined {
  if (binding.flow === "device_code") return storedApplicationOrigin;
  const redirect = new URL(binding.redirect_uri!);
  return ["http:", "https:"].includes(redirect.protocol)
    ? redirect.origin
    : undefined;
}
