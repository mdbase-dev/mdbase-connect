import {
  MdbaseConnectError,
  connectProblem,
  normalizeConnectProblem,
  type ConnectOperationOutcome,
  type ConnectProblem,
  type KnownConnectProblem,
  type MdbaseDiagnostic,
  type MdbaseOperationEnvelope
} from "@mdbase-dev/connect-protocol";

interface ProblemOptions {
  operationOutcome?: ConnectOperationOutcome;
  traceId?: string;
  status?: number;
  cause?: unknown;
}

export { MdbaseConnectError, connectError, connectProblem, type ConnectErrorContext } from "@mdbase-dev/connect-protocol";

export function unknownConnectProblem(
  serverCode: string,
  message: string,
  options: ProblemOptions & { details?: unknown } = {}
): ConnectProblem {
  return normalizeConnectProblem(serverCode, message, {
    details: options.details,
    operation_outcome: options.operationOutcome,
    trace_id: options.traceId
  });
}

export function serverConnectError(
  serverCode: string,
  message: string,
  options: ProblemOptions & { details?: unknown; status?: number; cause?: unknown } = {}
): MdbaseConnectError {
  const { status, cause, ...problemOptions } = options;
  return new MdbaseConnectError(normalizeConnectProblem(serverCode, message, {
    details: problemOptions.details,
    operation_outcome: problemOptions.operationOutcome,
    trace_id: problemOptions.traceId
  }), { status, cause });
}

export function operationProblem<Result>(
  envelope: MdbaseOperationEnvelope<Result>
): KnownConnectProblem<
  | "collection_configuration_invalid"
  | "collection_invalid"
  | "collection_type_registry_invalid"
  | "collection_version_unsupported"
  | "concurrent_modification"
  | "file_not_found"
  | "invalid_path"
  | "operation_invalid"
> {
  const code = diagnosticProblemCode(envelope.diagnostics);
  const message = diagnosticMessage(envelope.diagnostics);
  // mdbase reports these record conditions as diagnostics; hosted authorities
  // report them as problems. Surface one code for both.
  if (code === "concurrent_modification" || code === "file_not_found" || code === "invalid_path") {
    return connectProblem(code, message, { operationOutcome: "rejected" });
  }
  if (code === "collection_version_unsupported") {
    const versions = diagnosticVersions(envelope.diagnostics);
    return connectProblem(code, message, {
      operationOutcome: "rejected",
      details: versions
    });
  }
  if (code !== "operation_invalid") {
    return connectProblem(code, message, {
      operationOutcome: "rejected",
      details: { diagnostics: envelope.diagnostics }
    });
  }
  return connectProblem(
    code,
    message,
    {
      operationOutcome: "rejected",
      details: {
        diagnostics: envelope.diagnostics,
        partial_result: envelope.result
      }
    }
  );
}

function diagnosticProblemCode(diagnostics: MdbaseDiagnostic[]):
  | "collection_configuration_invalid"
  | "collection_invalid"
  | "collection_type_registry_invalid"
  | "collection_version_unsupported"
  | "concurrent_modification"
  | "file_not_found"
  | "invalid_path"
  | "operation_invalid" {
  const codes = new Set(
    diagnostics
      .filter((diagnostic) => diagnostic.severity === "error")
      .map((diagnostic) => diagnostic.code)
  );
  if (["migration_required", "migration_lossy", "unsupported_version"]
    .some((code) => codes.has(code))) return "collection_version_unsupported";
  if (["invalid_config", "invalid_configuration", "missing_config", "missing_spec_version"]
    .some((code) => codes.has(code))) return "collection_configuration_invalid";
  if ([
    "duplicate_type",
    "invalid_contract_definition",
    "invalid_data_contract",
    "invalid_type_definition",
    "invalid_type_path"
  ].some((code) => codes.has(code))) return "collection_type_registry_invalid";
  if (["collection_invalid", "collection_open_failed"]
    .some((code) => codes.has(code))) return "collection_invalid";
  for (const code of ["concurrent_modification", "file_not_found", "invalid_path"] as const) {
    if (codes.has(code)) return code;
  }
  return "operation_invalid";
}

function diagnosticVersions(diagnostics: MdbaseDiagnostic[]): {
  current_version: string;
  required_version: string;
} {
  const source = diagnostics
    .map((diagnostic) => diagnostic.details)
    .find((details): details is Record<string, unknown> => isRecord(details));
  return {
    current_version: typeof source?.current_version === "string"
      ? source.current_version
      : "0.2.x",
    required_version: typeof source?.required_version === "string"
      ? source.required_version
      : "0.3.0"
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** True only when repeating an operation is safe without asking the user. */
export function isRetryableConnectError(error: unknown): boolean {
  return error instanceof MdbaseConnectError && error.retryable;
}

function diagnosticMessage(diagnostics: MdbaseDiagnostic[]): string {
  return diagnostics
    .filter((item) => item.severity === "error")
    .map((item) => item.message)
    .join(" ")
    || diagnostics.map((item) => item.message).join(" ")
    || "The collection rejected this operation.";
}
