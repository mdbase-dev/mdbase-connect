import type { ApplicationFileRequirement } from "./files.js";
import {
  isMutatingOperation,
  type CollectionOperation
} from "./operations.js";

export const OPERATION_TRANSPORT_PROTOCOL_VERSION = 3 as const;
export const LEGACY_OPERATION_TRANSPORT_PROTOCOL_VERSION = 2 as const;
export const SUPPORTED_OPERATION_TRANSPORT_PROTOCOL_VERSIONS = [
  OPERATION_TRANSPORT_PROTOCOL_VERSION,
  LEGACY_OPERATION_TRANSPORT_PROTOCOL_VERSION
] as const;
export type OperationTransportProtocolVersion =
  typeof SUPPORTED_OPERATION_TRANSPORT_PROTOCOL_VERSIONS[number];

export const AUTHORIZATION_BINDING_PROTOCOL_VERSION = 5 as const;
export const LEGACY_AUTHORIZATION_BINDING_PROTOCOL_VERSION = 4 as const;
export const SUPPORTED_AUTHORIZATION_BINDING_PROTOCOL_VERSIONS = [
  AUTHORIZATION_BINDING_PROTOCOL_VERSION,
  LEGACY_AUTHORIZATION_BINDING_PROTOCOL_VERSION
] as const;
export type AuthorizationBindingProtocolVersion =
  typeof SUPPORTED_AUTHORIZATION_BINDING_PROTOCOL_VERSIONS[number];
export const SEMANTIC_CAPABILITY_CONTRACT_VERSION = 1 as const;
export const DURABLE_MUTATION_CONTRACT_VERSION = 1 as const;

export interface ConnectContractRequirements {
  operation_transport: number;
  /** Signed, mutation-only transports retained solely for exact outcome recovery. */
  operation_transport_recovery?: number[];
  authorization_binding: number;
  semantic_capabilities: number;
  /** Required only by operations that can durably mutate authority state. */
  durable_mutation?: number;
}

export interface ConnectContractSupport {
  operation_transport: number[];
  authorization_binding: number[];
  semantic_capabilities: number[];
  durable_mutation: number[];
}

export const CONNECT_CONTRACT_SUPPORT: ConnectContractSupport = {
  operation_transport: [...SUPPORTED_OPERATION_TRANSPORT_PROTOCOL_VERSIONS],
  authorization_binding: [...SUPPORTED_AUTHORIZATION_BINDING_PROTOCOL_VERSIONS],
  semantic_capabilities: [SEMANTIC_CAPABILITY_CONTRACT_VERSION],
  durable_mutation: [DURABLE_MUTATION_CONTRACT_VERSION]
};

/**
 * Produce the exact contract ceiling signed during authorization. `sync` is
 * conservatively mutation-capable because its action is selected per request.
 */
export function authorizationContractRequirements(
  operations: readonly CollectionOperation[],
  files?: ApplicationFileRequirement,
  operationTransportRecovery: readonly OperationTransportProtocolVersion[] = []
): ConnectContractRequirements {
  const requirements: ConnectContractRequirements = {
    operation_transport: OPERATION_TRANSPORT_PROTOCOL_VERSION,
    authorization_binding: AUTHORIZATION_BINDING_PROTOCOL_VERSION,
    semantic_capabilities: 1 satisfies typeof SEMANTIC_CAPABILITY_CONTRACT_VERSION
  };
  const recovery = [...new Set(operationTransportRecovery)]
    .filter((version) => version !== OPERATION_TRANSPORT_PROTOCOL_VERSION)
    .sort((left, right) => right - left);
  if (recovery.length > 0) requirements.operation_transport_recovery = recovery;
  if (operations.some((operation) => isMutatingOperation(operation, { action: "mutate" }))
    || files?.actions.some((action) => action !== "list" && action !== "read") === true) {
    requirements.durable_mutation = 1 satisfies typeof DURABLE_MUTATION_CONTRACT_VERSION;
  }
  return requirements;
}

export function supportsContractRequirements(
  required: ConnectContractRequirements,
  supported: ConnectContractSupport,
  durableMutation: boolean
): boolean {
  return supported.operation_transport.includes(required.operation_transport)
    && (required.operation_transport_recovery ?? []).every((version) =>
      supported.operation_transport.includes(version))
    && supported.authorization_binding.includes(required.authorization_binding)
    && supported.semantic_capabilities.includes(required.semantic_capabilities)
    && (!durableMutation
      || (required.durable_mutation !== undefined
        && supported.durable_mutation.includes(required.durable_mutation)));
}

export function isSupportedOperationTransport(
  version: number
): version is OperationTransportProtocolVersion {
  return (SUPPORTED_OPERATION_TRANSPORT_PROTOCOL_VERSIONS as readonly number[])
    .includes(version);
}

export function isSupportedAuthorizationBinding(
  version: number
): version is AuthorizationBindingProtocolVersion {
  return (SUPPORTED_AUTHORIZATION_BINDING_PROTOCOL_VERSIONS as readonly number[])
    .includes(version);
}

export function permitsOperationTransport(
  contracts: ConnectContractRequirements,
  version: number,
  recoveryOnly = false
): boolean {
  return contracts.operation_transport === version
    || (recoveryOnly
      && (contracts.operation_transport_recovery ?? []).includes(version));
}
