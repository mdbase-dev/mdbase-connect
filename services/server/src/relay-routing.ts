import type {
  CollectionOperation, ConnectProblem, EncryptedRelayEnvelope,
  EncryptedRelayOperationResponse
} from "@mdbase-dev/connect-protocol";
import {
  isMutatingOperation, normalizeConnectProblem
} from "@mdbase-dev/connect-protocol";
import type { RelayBrokerReply } from "./relay-broker.js";

export type ExpectedRelayResponse =
  | "operation_response"
  | "authorization_offer_response"
  | "authorization_activation_response"
  | "policy_applied";

export function relayExecutionTimeoutProblem(
  request: EncryptedRelayEnvelope | undefined,
  requestId: string
): ConnectProblem {
  if (request && encryptedOperationMayMutate(request.operation)) {
    return normalizeConnectProblem(
      "operation_outcome_unknown",
      "The durable mutation may have completed after its caller's deadline expired. Retry the same mutation identity to recover its result.",
      {
        operation_outcome: "unknown",
        details: { request_id: requestId }
      }
    );
  }
  return normalizeConnectProblem(
    "operation_cancelled",
    "The connector operation exceeded its execution deadline.",
    { operation_outcome: "not_sent" }
  );
}

function encryptedOperationMayMutate(operation: EncryptedRelayEnvelope["operation"]): boolean {
  return operation === "file_control"
    || operation === "sync"
    || isMutatingOperation(operation, {});
}

export function validProtocolUsageEntries(
  value: unknown
): value is Array<{ axis: "operation_transport"; version: number; count: number }> {
  return Array.isArray(value)
    && value.length > 0
    && value.length <= 4
    && value.every((entry) => {
      if (!entry || typeof entry !== "object") return false;
      const candidate = entry as Record<string, unknown>;
      return Object.keys(candidate).length === 3
        && candidate.axis === "operation_transport"
        && Number.isInteger(candidate.version)
        && (candidate.version as number) > 0
        && Number.isSafeInteger(candidate.count)
        && (candidate.count as number) > 0
        && (candidate.count as number) <= 100_000;
    });
}

export function requestIdFromMessage(message: unknown): string | null {
  if (typeof message !== "object" || message === null || Array.isArray(message)) return null;
  const requestId = (message as { request_id?: unknown }).request_id;
  return typeof requestId === "string" && requestId.length > 0 ? requestId : null;
}

export function isContractSetupCommand(message: unknown): boolean {
  if (typeof message !== "object" || message === null || Array.isArray(message)) return false;
  const candidate = message as { type?: unknown; contract_setups?: unknown };
  return candidate.type === "authorization_activation_request"
    && Array.isArray(candidate.contract_setups)
    && candidate.contract_setups.length > 0;
}

export function encryptedRequestFromMessage(
  message: unknown
): EncryptedRelayEnvelope | undefined {
  if (typeof message !== "object" || message === null || Array.isArray(message)) return undefined;
  return (message as { type?: unknown }).type === "encrypted_operation_request"
    ? message as EncryptedRelayEnvelope
    : undefined;
}

export function relayMessageMayMutate(message: unknown): boolean {
  if (typeof message !== "object" || message === null || Array.isArray(message)) return false;
  const candidate = message as {
    type?: unknown;
    operation?: unknown;
    input?: unknown;
  };
  if (candidate.type === "encrypted_operation_request"
      && typeof candidate.operation === "string") {
    return encryptedOperationMayMutate(
      candidate.operation as EncryptedRelayEnvelope["operation"]
    );
  }
  return candidate.type === "operation_request"
    && typeof candidate.operation === "string"
    && isMutatingOperation(
      candidate.operation as CollectionOperation,
      candidate.input ?? {}
    );
}

export function expectedResponseType(message: unknown): ExpectedRelayResponse | undefined {
  if (typeof message !== "object" || message === null || Array.isArray(message)) return undefined;
  switch ((message as { type?: unknown }).type) {
    case "operation_request":
      return "operation_response";
    case "authorization_offer_request":
      return "authorization_offer_response";
    case "authorization_activation_request":
      return "authorization_activation_response";
    case "policy_snapshot":
      return "policy_applied";
    default:
      return undefined;
  }
}

export function brokerError(
  kind: "unavailable" | "connector" | "internal",
  code: string,
  message: string
): RelayBrokerReply {
  if (kind === "connector") {
    return brokerProblem(normalizeConnectProblem(code, message));
  }
  return { version: 1, ok: false, error: { kind, code, message } };
}

export function brokerProblem(problem: ConnectProblem, details?: unknown): RelayBrokerReply {
  const error = { kind: "connector" as const, problem, ...(details === undefined ? {} : { details }) };
  return { version: 1, ok: false, error };
}

export function matchesEncryptedMetadata(
  response: Partial<EncryptedRelayOperationResponse>,
  request: EncryptedRelayEnvelope
): response is EncryptedRelayOperationResponse {
  return response?.protocol_version === request.protocol_version
    && response.suite === request.suite
    && response.request_id === request.request_id
    && response.grant_id === request.grant_id
    && response.application_id === request.application_id
    && response.connector_id === request.connector_id
    && response.collection_id === request.collection_id
    && response.operation === request.operation
    && response.scope_epoch === request.scope_epoch
    && response.key_id === request.key_id
    && response.counter === request.counter
    && typeof response.ciphertext === "string";
}
