import type {
  ConnectProblem,
  ConnectProblemCode,
  MdbaseDiagnostic
} from "@mdbase-dev/connect-protocol";
import { CONNECT_PROBLEM_CATALOG } from "@mdbase-dev/connect-protocol";
import { MdbaseConnectError, unknownConnectProblem } from "./errors.js";

export type ConnectSuccess<Value> = {
  ok: true;
  value: Value;
  diagnostics: MdbaseDiagnostic[];
};

export type ConnectFailure<Code extends ConnectProblemCode = ConnectProblemCode> = {
  ok: false;
  problem: ConnectProblem<Code>;
};

/**
 * Every expected failure from the public SDK is data. Exceptions are reserved
 * for programming errors and broken SDK invariants.
 */
export type ConnectOutcome<
  Value,
  Code extends ConnectProblemCode = ConnectProblemCode
> = ConnectSuccess<Value> | ConnectFailure<Code>;

export type CommonOperationProblemCode =
  | "access_denied"
  | "access_paused"
  | "authorization_binding_incompatible"
  | "authorization_expired"
  | "capability_contract_incompatible"
  | "collection_access_denied"
  | "connector_identity_changed"
  | "connector_offline"
  | "connector_upgrade_required"
  | "direct_operation_rejected"
  | "durable_mutation_unsupported"
  | "operation_outcome_unknown"
  | "encryption_required"
  | "encrypted_relay_rejected"
  | "hosted_provider_unavailable"
  | "insufficient_access"
  | "invalid_encrypted_response"
  | "invalid_operation_response"
  | "invalid_request"
  | "missing_grant_key"
  | "mutation_recovery_expired"
  | "mutation_request_conflict"
  | "not_authorized"
  | "operation_cancelled"
  | "operation_failed"
  | "rate_limited"
  | "relay_authorization_expired"
  | "relay_unavailable"
  | "temporarily_unavailable"
  | "timeout"
  | "transport_protocol_incompatible"
  | "unsupported_operation";

export const COMMON_OPERATION_PROBLEM_CODES = [
  "access_denied",
  "access_paused",
  "authorization_binding_incompatible",
  "authorization_expired",
  "capability_contract_incompatible",
  "collection_access_denied",
  "connector_identity_changed",
  "connector_offline",
  "connector_upgrade_required",
  "direct_operation_rejected",
  "durable_mutation_unsupported",
  "operation_outcome_unknown",
  "encryption_required",
  "encrypted_relay_rejected",
  "hosted_provider_unavailable",
  "insufficient_access",
  "invalid_encrypted_response",
  "invalid_operation_response",
  "invalid_request",
  "missing_grant_key",
  "mutation_recovery_expired",
  "mutation_request_conflict",
  "not_authorized",
  "operation_cancelled",
  "operation_failed",
  "rate_limited",
  "relay_authorization_expired",
  "relay_unavailable",
  "temporarily_unavailable",
  "timeout",
  "transport_protocol_incompatible",
  "unsupported_operation"
] as const satisfies readonly CommonOperationProblemCode[];

export const ALL_CONNECT_PROBLEM_CODES = Object.keys(
  CONNECT_PROBLEM_CATALOG
) as ConnectProblemCode[];

export type RegistrationProblemCode =
  | "discovery_failed"
  | "invalid_operation_response"
  | "invalid_application_manifest"
  | "invalid_request"
  | "manifest_load_failed"
  | "rate_limited"
  | "temporarily_unavailable"
  | "timeout";

export const REGISTRATION_PROBLEM_CODES = [
  "discovery_failed",
  "invalid_operation_response",
  "invalid_application_manifest",
  "invalid_request",
  "manifest_load_failed",
  "rate_limited",
  "temporarily_unavailable",
  "timeout"
] as const satisfies readonly RegistrationProblemCode[];

export type AuthorizationProblemCode =
  | RegistrationProblemCode
  | "access_denied"
  | "application_identity_unavailable"
  | "approval_window_blocked"
  | "authorization_binding_incompatible"
  | "authorization_cancelled"
  | "authorization_replayed"
  | "browser_required"
  | "capability_contract_incompatible"
  | "collection_access_denied"
  | "collection_configuration_invalid"
  | "collection_contracts_missing"
  | "collection_incompatible"
  | "collection_invalid"
  | "collection_kind_unsupported"
  | "collection_mismatch"
  | "collection_not_found"
  | "collection_type_registry_invalid"
  | "collection_version_unsupported"
  | "connector_identity_changed"
  | "connector_offline"
  | "connector_upgrade_required"
  | "device_authorization_failed"
  | "durable_mutation_unsupported"
  | "encryption_required"
  | "expired_token"
  | "invalid_application_authorization"
  | "invalid_callback"
  | "invalid_device_authorization_response"
  | "invalid_token_response"
  | "scope_denied"
  | "reconnect_required"
  | "token_exchange_failed"
  | "transport_protocol_incompatible";

export const AUTHORIZATION_PROBLEM_CODES = [
  ...REGISTRATION_PROBLEM_CODES,
  "access_denied",
  "application_identity_unavailable",
  "approval_window_blocked",
  "authorization_binding_incompatible",
  "authorization_cancelled",
  "authorization_replayed",
  "browser_required",
  "capability_contract_incompatible",
  "collection_access_denied",
  "collection_configuration_invalid",
  "collection_contracts_missing",
  "collection_incompatible",
  "collection_invalid",
  "collection_kind_unsupported",
  "collection_mismatch",
  "collection_not_found",
  "collection_type_registry_invalid",
  "collection_version_unsupported",
  "connector_identity_changed",
  "connector_offline",
  "connector_upgrade_required",
  "device_authorization_failed",
  "durable_mutation_unsupported",
  "encryption_required",
  "expired_token",
  "invalid_application_authorization",
  "invalid_callback",
  "invalid_device_authorization_response",
  "invalid_token_response",
  "scope_denied",
  "reconnect_required",
  "token_exchange_failed",
  "transport_protocol_incompatible"
] as const satisfies readonly AuthorizationProblemCode[];

export type NotificationProblemCode =
  | RegistrationProblemCode
  | "authorization_expired"
  | "invalid_operation_response"
  | "invalid_push_subscription"
  | "managed_fcm_not_declared"
  | "not_authorized"
  | "notification_criterion_not_declared"
  | "notification_reauthorization_required"
  | "notification_registration_failed"
  | "notification_unregistration_failed"
  | "notifications_not_declared"
  | "notifications_unavailable";

export const NOTIFICATION_PROBLEM_CODES = [
  ...REGISTRATION_PROBLEM_CODES,
  "authorization_expired",
  "invalid_operation_response",
  "invalid_push_subscription",
  "managed_fcm_not_declared",
  "not_authorized",
  "notification_criterion_not_declared",
  "notification_reauthorization_required",
  "notification_registration_failed",
  "notification_unregistration_failed",
  "notifications_not_declared",
  "notifications_unavailable"
] as const satisfies readonly NotificationProblemCode[];

export type DirectAccessProblemCode =
  | "connector_offline"
  | "connector_upgrade_required"
  | "invalid_operation_response"
  | "not_authorized"
  | "operation_failed"
  | "temporarily_unavailable"
  | "timeout";

export const DIRECT_ACCESS_PROBLEM_CODES = [
  "connector_offline",
  "connector_upgrade_required",
  "invalid_operation_response",
  "not_authorized",
  "operation_failed",
  "temporarily_unavailable",
  "timeout"
] as const satisfies readonly DirectAccessProblemCode[];

export type SessionProblemCode =
  | AuthorizationProblemCode
  | "collection_not_ready"
  | "collection_not_selected"
  | "unknown_collection";

export const SESSION_PROBLEM_CODES = [
  ...AUTHORIZATION_PROBLEM_CODES,
  "collection_not_ready",
  "collection_not_selected",
  "unknown_collection"
] as const satisfies readonly SessionProblemCode[];

export type CollectionSetupProblemCode =
  | "collection_configuration_invalid"
  | "collection_invalid"
  | "collection_type_registry_invalid"
  | "collection_version_unsupported";
export type CollectionDescriptionProblemCode = CommonOperationProblemCode | CollectionSetupProblemCode;
export type CollectionReadProblemCode =
  | CollectionDescriptionProblemCode
  | "invalid_path"
  | "operation_invalid";
export type CollectionQueryProblemCode =
  | CollectionReadProblemCode
  | "cursor_capacity_exhausted"
  | "generation_expired"
  | "invalid_read_cursor"
  | "query_snapshot_changed"
  | "sandbox_unsupported";
export type CollectionMutationProblemCode =
  | CollectionReadProblemCode
  | "concurrent_modification"
  | "invalid_preflight"
  | "pending_mutation_unresolved";
export type CollectionChangesProblemCode = CollectionDescriptionProblemCode | "change_cursor_reset";
export type CollectionTypeProblemCode = CollectionMutationProblemCode | "type_pack_provision_failed";

export const COLLECTION_SETUP_PROBLEM_CODES = [
  "collection_configuration_invalid",
  "collection_invalid",
  "collection_type_registry_invalid",
  "collection_version_unsupported"
] as const satisfies readonly CollectionSetupProblemCode[];

export const COLLECTION_DESCRIPTION_PROBLEM_CODES = [
  ...COMMON_OPERATION_PROBLEM_CODES,
  ...COLLECTION_SETUP_PROBLEM_CODES
] as const satisfies readonly CollectionDescriptionProblemCode[];

export const COLLECTION_READ_PROBLEM_CODES = [
  ...COLLECTION_DESCRIPTION_PROBLEM_CODES,
  "invalid_path",
  "operation_invalid"
] as const satisfies readonly CollectionReadProblemCode[];

export const COLLECTION_QUERY_PROBLEM_CODES = [
  ...COLLECTION_READ_PROBLEM_CODES,
  "cursor_capacity_exhausted",
  "generation_expired",
  "invalid_read_cursor",
  "query_snapshot_changed",
  "sandbox_unsupported"
] as const satisfies readonly CollectionQueryProblemCode[];

export const COLLECTION_MUTATION_PROBLEM_CODES = [
  ...COLLECTION_READ_PROBLEM_CODES,
  "concurrent_modification",
  "invalid_preflight",
  "pending_mutation_unresolved"
] as const satisfies readonly CollectionMutationProblemCode[];

export const COLLECTION_CHANGES_PROBLEM_CODES = [
  ...COLLECTION_DESCRIPTION_PROBLEM_CODES,
  "change_cursor_reset"
] as const satisfies readonly CollectionChangesProblemCode[];

export const COLLECTION_TYPE_PROBLEM_CODES = [
  ...COLLECTION_MUTATION_PROBLEM_CODES,
  "type_pack_provision_failed"
] as const satisfies readonly CollectionTypeProblemCode[];

export function connectSuccess<Value>(
  value: Value,
  diagnostics: MdbaseDiagnostic[] = []
): ConnectSuccess<Value> {
  return { ok: true, value, diagnostics };
}

export function connectFailure<Code extends ConnectProblemCode>(
  problem: ConnectProblem<Code>
): ConnectFailure<Code> {
  return { ok: false, problem };
}

export async function captureConnectOutcome<
  Value,
  Code extends ConnectProblemCode
>(
  operation: () => Promise<Value>,
  allowedCodes: readonly Code[]
): Promise<ConnectOutcome<Value, Code>> {
  try {
    return connectSuccess(await operation());
  } catch (error) {
    if (!(error instanceof MdbaseConnectError)) throw error;
    const problem = error.problem;
    if (problem.code === "unknown" || allowedCodes.includes(problem.code as Code)) {
      return connectFailure(problem as ConnectProblem<Code>);
    }
    return connectFailure(unknownConnectProblem(
      problem.code,
      problem.message,
      {
        details: problem.details,
        operationOutcome: problem.operation_outcome,
        traceId: problem.trace_id
      }
    )) as ConnectOutcome<Value, Code>;
  }
}

export class ConnectOutcomeError extends Error {
  constructor(public readonly problem: ConnectProblem) {
    super(problem.message);
    this.name = "ConnectOutcomeError";
  }
}

/** Explicitly opt back into exception flow for scripts and narrow adapters. */
export function unwrapConnectOutcome<Value>(outcome: ConnectOutcome<Value>): Value {
  if (!outcome.ok) throw new ConnectOutcomeError(outcome.problem);
  return outcome.value;
}
