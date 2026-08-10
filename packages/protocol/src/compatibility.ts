import type { ApplicationFileRequirement } from "./files.js";
import {
  isMutatingOperation,
  type CollectionOperation
} from "./operations.js";

export const OPERATION_TRANSPORT_PROTOCOL_VERSION = 3 as const;
export const AUTHORIZATION_BINDING_PROTOCOL_VERSION = 4 as const;
export const SEMANTIC_CAPABILITY_CONTRACT_VERSION = 1 as const;
export const DURABLE_MUTATION_CONTRACT_VERSION = 1 as const;

export interface ConnectContractRequirements {
  operation_transport: number;
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
  operation_transport: [OPERATION_TRANSPORT_PROTOCOL_VERSION],
  authorization_binding: [AUTHORIZATION_BINDING_PROTOCOL_VERSION],
  semantic_capabilities: [SEMANTIC_CAPABILITY_CONTRACT_VERSION],
  durable_mutation: [DURABLE_MUTATION_CONTRACT_VERSION]
};

/**
 * Produce the exact contract ceiling signed during authorization. `sync` is
 * conservatively mutation-capable because its action is selected per request.
 */
export function authorizationContractRequirements(
  operations: readonly CollectionOperation[],
  files?: ApplicationFileRequirement
): ConnectContractRequirements {
  const requirements: ConnectContractRequirements = {
    operation_transport: OPERATION_TRANSPORT_PROTOCOL_VERSION,
    authorization_binding: AUTHORIZATION_BINDING_PROTOCOL_VERSION,
    semantic_capabilities: 1 satisfies typeof SEMANTIC_CAPABILITY_CONTRACT_VERSION
  };
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
    && supported.authorization_binding.includes(required.authorization_binding)
    && supported.semantic_capabilities.includes(required.semantic_capabilities)
    && (!durableMutation
      || (required.durable_mutation !== undefined
        && supported.durable_mutation.includes(required.durable_mutation)));
}
