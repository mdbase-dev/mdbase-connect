import type {
  ConnectProblem,
  ConnectProblemCode,
  MdbaseDiagnostic
} from "@mdbase/connect-protocol";
import { CONNECT_PROBLEM_CATALOG } from "@mdbase/connect-protocol";
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
  | "authorization_expired"
  | "collection_access_denied"
  | "connector_identity_changed"
  | "connector_offline"
  | "connector_upgrade_required"
  | "direct_operation_rejected"
  | "direct_outcome_unknown"
  | "encryption_required"
  | "hosted_provider_unavailable"
  | "insufficient_access"
  | "invalid_encrypted_response"
  | "invalid_operation_response"
  | "invalid_request"
  | "missing_grant_key"
  | "not_authorized"
  | "operation_cancelled"
  | "operation_failed"
  | "rate_limited"
  | "relay_authorization_expired"
  | "relay_unavailable"
  | "temporarily_unavailable"
  | "timeout";

export const COMMON_OPERATION_PROBLEM_CODES = [
  "authorization_expired",
  "collection_access_denied",
  "connector_identity_changed",
  "connector_offline",
  "connector_upgrade_required",
  "direct_operation_rejected",
  "direct_outcome_unknown",
  "encryption_required",
  "hosted_provider_unavailable",
  "insufficient_access",
  "invalid_encrypted_response",
  "invalid_operation_response",
  "invalid_request",
  "missing_grant_key",
  "not_authorized",
  "operation_cancelled",
  "operation_failed",
  "rate_limited",
  "relay_authorization_expired",
  "relay_unavailable",
  "temporarily_unavailable",
  "timeout"
] as const satisfies readonly CommonOperationProblemCode[];

export const ALL_CONNECT_PROBLEM_CODES = Object.keys(
  CONNECT_PROBLEM_CATALOG
) as ConnectProblemCode[];

export type CollectionReadProblemCode = CommonOperationProblemCode | "invalid_path" | "operation_invalid";
export type CollectionQueryProblemCode =
  | CollectionReadProblemCode
  | "query_snapshot_changed"
  | "sandbox_unsupported";
export type CollectionMutationProblemCode =
  | CollectionReadProblemCode
  | "concurrent_modification"
  | "invalid_preflight"
  | "pending_mutation_unresolved";
export type CollectionChangesProblemCode = CommonOperationProblemCode | "change_cursor_reset";
export type CollectionTypeProblemCode = CollectionMutationProblemCode | "type_pack_provision_failed";

export const COLLECTION_READ_PROBLEM_CODES = [
  ...COMMON_OPERATION_PROBLEM_CODES,
  "invalid_path",
  "operation_invalid"
] as const satisfies readonly CollectionReadProblemCode[];

export const COLLECTION_QUERY_PROBLEM_CODES = [
  ...COLLECTION_READ_PROBLEM_CODES,
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
  ...COMMON_OPERATION_PROBLEM_CODES,
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
