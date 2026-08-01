import {
  CONNECT_PROBLEM_CATALOG,
  CONNECT_PROBLEM_VERSION,
  normalizeConnectProblem,
  type ConnectOperationOutcome,
  type ConnectProblem,
  type ConnectProblemCode,
  type ConnectProblemDetailsByCode,
  type KnownConnectProblem,
  type MdbaseDiagnostic,
  type MdbaseOperationEnvelope
} from "@mdbase/connect-protocol";

interface ProblemOptions {
  operationOutcome?: ConnectOperationOutcome;
  traceId?: string;
  status?: number;
  cause?: unknown;
}

type ProblemOptionsFor<Code extends ConnectProblemCode> =
  ConnectProblemDetailsByCode[Code] extends undefined
    ? ProblemOptions & { details?: never }
    : {} extends ConnectProblemDetailsByCode[Code]
      ? ProblemOptions & { details?: ConnectProblemDetailsByCode[Code] }
      : ProblemOptions & { details: ConnectProblemDetailsByCode[Code] };

type ProblemArguments<Code extends ConnectProblemCode> =
  ConnectProblemDetailsByCode[Code] extends undefined
    ? [options?: ProblemOptionsFor<Code>]
    : {} extends ConnectProblemDetailsByCode[Code]
      ? [options?: ProblemOptionsFor<Code>]
      : [options: ProblemOptionsFor<Code>];

export interface ConnectErrorContext {
  status?: number;
  cause?: unknown;
}

/** Internal carrier used while adapting throwing transports into public outcomes. */
export class MdbaseConnectError extends Error {
  readonly code: ConnectProblem["code"];
  readonly status?: number;

  constructor(
    public readonly problem: ConnectProblem,
    context: ConnectErrorContext = {}
  ) {
    super(problem.message, context.cause === undefined ? undefined : { cause: context.cause });
    this.name = "MdbaseConnectError";
    this.code = problem.code;
    this.status = context.status;
  }

  get retryable(): boolean {
    return this.problem.recovery === "retry"
      && this.problem.operation_outcome !== "unknown";
  }

  get requiresAuthorization(): boolean {
    return this.problem.category === "authorization";
  }

  get outcomeUnknown(): boolean {
    return this.problem.operation_outcome === "unknown";
  }

  get recovery() {
    return this.problem.recovery;
  }

  get details(): unknown {
    return this.problem.details;
  }
}

export function connectProblem<Code extends ConnectProblemCode>(
  code: Code,
  message: string,
  ...[options = {} as ProblemOptionsFor<Code>]: ProblemArguments<Code>
): KnownConnectProblem<Code> {
  const definition = CONNECT_PROBLEM_CATALOG[code];
  return {
    problem_version: CONNECT_PROBLEM_VERSION,
    code,
    category: definition.category,
    recovery: definition.recovery,
    message,
    ...(options.details === undefined ? {} : { details: options.details }),
    ...(options.operationOutcome === undefined
      ? {}
      : { operation_outcome: options.operationOutcome }),
    ...(options.traceId === undefined ? {} : { trace_id: options.traceId })
  } as KnownConnectProblem<Code>;
}

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

export function connectError<Code extends ConnectProblemCode>(
  code: Code,
  message: string,
  ...args: ProblemArguments<Code>
): MdbaseConnectError {
  const options = args[0];
  return new MdbaseConnectError(connectProblem(code, message, ...args), {
    status: options?.status,
    cause: options?.cause
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
): KnownConnectProblem<"operation_invalid"> {
  return connectProblem(
    "operation_invalid",
    diagnosticMessage(envelope.diagnostics),
    {
      operationOutcome: "rejected",
      details: {
        diagnostics: envelope.diagnostics,
        partial_result: envelope.result
      }
    }
  );
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
