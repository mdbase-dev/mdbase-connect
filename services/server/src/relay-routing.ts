import type {
  ApplicationProvisions, ApplicationRequirements, CollectionOperation, ConnectProblem, EncryptedRelayEnvelope,
  EncryptedRelayOperationResponse, GrantPolicy, ConnectContractSupport
} from "@mdbase-dev/connect-protocol";
import {
  APPLICATION_DECLARATION_EVIDENCE_CAPABILITY, NEXT_ACCOUNT_CAPABILITY, CONTRACT_SETUP_CAPABILITY, isMutatingOperation, normalizeConnectProblem,
  RECORD_EXTENSIONS_CONFIGURATION_PATH, YAML_DOCUMENT_RECORDS_CAPABILITY
} from "@mdbase-dev/connect-protocol";
import type { RelayBrokerReply, RelayBrokerCommand } from "./relay-broker.js";
import type { DatabaseQueryable } from "./database-types.js";
import { nextAccountNegotiated, relaySupportsContracts } from "./relay-compatibility.js";
import { withAccountId } from "./features/next/devices.js";
import { ConnectorOperationError } from "./relay-errors.js";

/** Exact projection at the serving owner, including cross-instance activation. */
export async function projectActivationGrant(
  db: DatabaseQueryable, connectorId: string, command: RelayBrokerCommand,
  session: { capabilities: string[]; contractSupport: ConnectContractSupport; mode?: "lease_v1" | "legacy_ack_v0" }
): Promise<{ ok: true; command: RelayBrokerCommand } | { ok: false; reply: RelayBrokerReply }> {
  const activation = command.message as { grant?: GrantPolicy };
  const grant = activation.grant;
  const refused = () => ({ ok: false as const, reply: brokerError("connector", "capability_contract_incompatible", "The selected authority cannot activate this exact authorization contract.") });
  if (!grant?.application_authorization
      || !relaySupportsContracts(session, grant.application_authorization.binding.contracts)
      || (grant.application_authorization.binding.contracts.semantic_capabilities === 2 && grant.application_declaration == null)) return refused();
  if (session.capabilities.includes(NEXT_ACCOUNT_CAPABILITY)
      && (!nextAccountNegotiated(session.capabilities) || session.mode !== "lease_v1")) return refused();
  const { account_id: _untrusted, application_declaration, ...legacyGrant } = grant;
  let projected: GrantPolicy = session.capabilities.includes(APPLICATION_DECLARATION_EVIDENCE_CAPABILITY)
    ? { ...legacyGrant, ...(application_declaration === undefined ? {} : { application_declaration }) } : legacyGrant;
  if (nextAccountNegotiated(session.capabilities)) {
    const row = await db.query<{ user_id: string }>(
      `SELECT g.user_id FROM grants g JOIN collections c ON c.id = g.collection_id
       WHERE g.id = $1 AND c.connector_id = $2 AND c.local_id = $3 AND g.revoked_at IS NULL`,
      [grant.id, connectorId, grant.collection_id]);
    try { projected = withAccountId(projected, row.rows[0]?.user_id); }
    catch (error) { if (error instanceof ConnectorOperationError) return refused(); throw error; }
  }
  return { ok: true, command: { ...command, message: { ...activation, grant: projected } } };
}

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

/**
 * The upgrade a connector needs before it can activate this message, or
 * `undefined` when its advertised capabilities suffice. Contract setup needs
 * `contract-setup-v1`; an application declaration that requires or adds `base`
 * record extensions needs an engine that reads `.base` files as YAML document
 * records rather than Markdown.
 */
export function connectorUpgradeError(
  message: unknown,
  capabilities: readonly string[]
): RelayBrokerReply | undefined {
  if (typeof message !== "object" || message === null || Array.isArray(message)) return undefined;
  const activation = message as {
    type?: unknown;
    contract_setups?: unknown;
    grant?: {
      application_declaration?: { requirements?: ApplicationRequirements; provisions?: ApplicationProvisions } | null;
    };
  };
  if (activation.type !== "authorization_activation_request") return undefined;
  const declaration = activation.grant?.application_declaration;
  const addsBaseRecords = [
    ...declaration?.requirements?.configuration ?? [],
    ...declaration?.provisions?.configuration ?? []
  ].some(({ path, value }) => path === RECORD_EXTENSIONS_CONFIGURATION_PATH && value === "base");
  if (addsBaseRecords && !capabilities.includes(YAML_DOCUMENT_RECORDS_CAPABILITY)) {
    return brokerError(
      "connector",
      "connector_upgrade_required",
      "Update mdbase connect on the collection computer before approving an application that stores Obsidian Bases as records."
    );
  }
  if (Array.isArray(activation.contract_setups) && activation.contract_setups.length > 0
      && !capabilities.includes(CONTRACT_SETUP_CAPABILITY)) {
    return brokerError(
      "connector",
      "connector_upgrade_required",
      "Update mdbase connect on the collection computer before approving contract setup."
    );
  }
  return undefined;
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
