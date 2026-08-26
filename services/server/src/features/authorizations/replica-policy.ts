import type {
  CollectionContractDescriptor,
  FileCapability,
  ReplicaCollaborationCapability
} from "@mdbase-dev/connect-protocol";

import type { AwarenessPresentationIdentity } from "../../hosted-provider.js";

/**
 * The complete application replica capability payload shared by replica
 * registration and later policy updates on the hosted provider.
 */
export interface ApplicationReplicaPolicy {
  grantId: string;
  mode: "read_only" | "read_write";
  allowedTypes: string[];
  contractScope: CollectionContractDescriptor[];
  fullCollection: boolean;
  allowedOperations: string[];
  operationTransportProtocol: number;
  operationTransportRecoveryProtocols: number[];
  fileCapability?: FileCapability;
  collaborationCapability?: ReplicaCollaborationCapability;
  awarenessIdentity?: AwarenessPresentationIdentity;
  allowedOrigin: string | undefined;
  proofPublicKey: string;
  applicationDeclarationId: string;
  applicationDeclarationDigest: string;
}

export interface ApplicationReplicaPolicyInput {
  grantId: string;
  replicaMode: "read_only" | "read_write";
  allowedTypes: string[];
  scope: CollectionContractDescriptor[];
  fullCollection: boolean;
  operations: string[];
  operationTransportProtocol: number;
  operationTransportRecoveryProtocols?: number[];
  fileCapability?: FileCapability;
  collaborationCapability?: ReplicaCollaborationCapability;
  awarenessIdentity?: AwarenessPresentationIdentity;
  allowedOrigin: string | undefined;
  proofPublicKey: string;
  applicationDeclarationId: string;
  applicationDeclarationDigest: string;
}

/**
 * Build the provider-facing replica policy from a grant plan plus the signed
 * authorization binding.
 */
export function buildApplicationReplicaPolicy(
  input: ApplicationReplicaPolicyInput
): ApplicationReplicaPolicy {
  return {
    grantId: input.grantId,
    mode: input.replicaMode,
    allowedTypes: input.allowedTypes,
    contractScope: input.scope,
    fullCollection: input.fullCollection,
    allowedOperations: input.operations,
    operationTransportProtocol: input.operationTransportProtocol,
    operationTransportRecoveryProtocols: input.operationTransportRecoveryProtocols ?? [],
    ...(input.fileCapability ? { fileCapability: input.fileCapability } : {}),
    ...(input.collaborationCapability
      ? { collaborationCapability: input.collaborationCapability }
      : {}),
    ...(input.awarenessIdentity ? { awarenessIdentity: input.awarenessIdentity } : {}),
    allowedOrigin: input.allowedOrigin,
    proofPublicKey: input.proofPublicKey,
    applicationDeclarationId: input.applicationDeclarationId,
    applicationDeclarationDigest: input.applicationDeclarationDigest
  };
}
