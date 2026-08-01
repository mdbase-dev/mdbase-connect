import type {
  MdbaseDiagnostic,
  MdbaseOperationEnvelope
} from "@mdbase-dev/connect-protocol";

export type MdbaseRecoveryAction = "retry" | "reauthorize" | "refresh" | "resolve_outcome" | "fix_request" | "none";

export interface MdbaseConnectErrorOptions {
  status?: number;
  retryable?: boolean;
  requiresAuthorization?: boolean;
  outcomeUnknown?: boolean;
  recovery?: MdbaseRecoveryAction;
  details?: unknown;
  cause?: unknown;
}

export class MdbaseConnectError extends Error {
  readonly status?: number;
  readonly retryable: boolean;
  readonly requiresAuthorization: boolean;
  readonly outcomeUnknown: boolean;
  readonly recovery: MdbaseRecoveryAction;
  readonly details?: unknown;

  constructor(public readonly code: string, message: string, options: MdbaseConnectErrorOptions = {}) {
    super(message);
    this.name = "MdbaseConnectError";
    const classification = classifyConnectError(code, options.status);
    this.status = options.status;
    this.retryable = options.retryable ?? classification.retryable;
    this.requiresAuthorization = options.requiresAuthorization ?? classification.requiresAuthorization;
    this.outcomeUnknown = options.outcomeUnknown ?? classification.outcomeUnknown;
    this.recovery = options.recovery ?? classification.recovery;
    this.details = options.details;
    if (options.cause !== undefined) Object.defineProperty(this, "cause", { value: options.cause, configurable: true });
  }
}

export class MdbaseOperationValidationError<Result = unknown> extends Error {
  readonly code = "operation_invalid";

  constructor(
    public readonly diagnostics: MdbaseDiagnostic[],
    public readonly result: Result
  ) {
    super(diagnostics.filter((item) => item.severity === "error").map((item) => item.message).join(" ")
      || diagnostics.map((item) => item.message).join(" ")
      || "The collection rejected this operation.");
    this.name = "MdbaseOperationValidationError";
  }
}

/** Return a valid operation result or throw while preserving every diagnostic. */
export function unwrapOperation<Result>(envelope: MdbaseOperationEnvelope<Result>): Result {
  if (!envelope.valid) throw new MdbaseOperationValidationError(envelope.diagnostics, envelope.result);
  return envelope.result;
}

/** True only when repeating a read/poll is safe without asking the user. */
export function isRetryableConnectError(error: unknown): boolean {
  if (error instanceof MdbaseConnectError) return error.retryable && !error.outcomeUnknown;
  return error instanceof TypeError;
}

function classifyConnectError(code: string, status?: number): Required<Pick<
  MdbaseConnectErrorOptions,
  "retryable" | "requiresAuthorization" | "outcomeUnknown" | "recovery"
>> {
  const authorizationCodes = new Set([
    "authorization_expired",
    "direct_operation_rejected",
    "encryption_required",
    "insufficient_access",
    "missing_grant_key",
    "not_authorized",
    "relay_authorization_expired"
  ]);
  const outcomeUnknown = code === "direct_outcome_unknown" || code === "pending_mutation_unresolved";
  const requiresAuthorization = authorizationCodes.has(code) || status === 401;
  const retryableCodes = new Set([
    "connector_offline",
    "discovery_failed",
    "relay_unavailable",
    "sync_failed",
    "temporarily_unavailable",
    "timeout"
  ]);
  const retryableStatus = status === 408 || status === 425 || status === 429 || (status !== undefined && status >= 500);
  const retryable = !outcomeUnknown && !requiresAuthorization && (retryableCodes.has(code) || retryableStatus);
  const recovery: MdbaseRecoveryAction = outcomeUnknown
    ? "resolve_outcome"
    : requiresAuthorization
      ? "reauthorize"
      : code === "change_cursor_reset"
        ? "refresh"
        : retryable
          ? "retry"
          : status !== undefined && status >= 400 && status < 500
            ? "fix_request"
            : "none";
  return { retryable, requiresAuthorization, outcomeUnknown, recovery };
}
