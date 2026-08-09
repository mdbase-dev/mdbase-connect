import type { ConnectProblem } from "@mdbase-dev/connect-protocol";
import { normalizeConnectProblem } from "@mdbase-dev/connect-protocol";

export class RelayUnavailableError extends Error {
  constructor() {
    super("The computer hosting this collection is offline.");
  }
}

export class ConnectorOperationError extends Error {
  readonly problem: ConnectProblem;
  readonly details: unknown;

  constructor(
    public readonly code: string,
    message: string,
    problem?: ConnectProblem,
    details?: unknown
  ) {
    super(message);
    this.problem = problem ?? normalizeConnectProblem(code, message);
    this.details = details;
  }

  static fromProblem(problem: ConnectProblem): ConnectorOperationError {
    return new ConnectorOperationError(
      problem.code === "unknown" ? problem.server_code : problem.code,
      problem.message,
      problem
    );
  }
}
