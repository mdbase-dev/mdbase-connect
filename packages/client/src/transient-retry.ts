import { abortableDelay } from "./async.js";
import { MdbaseConnectError, connectError } from "./errors.js";
import type { OperationAttempt, PendingMutation } from "./internal-types.js";

export const MAX_CONNECTOR_BUSY_RETRIES = 8;
export const MAX_TRANSIENT_CHUNK_ATTEMPTS = 10;

export function isConnectorBusy(error: unknown): error is MdbaseConnectError {
  return error instanceof MdbaseConnectError && error.code === "connector_busy";
}

export async function retryExplicitConnectorBusy<Result>(options: {
  error: unknown;
  attempt: OperationAttempt;
  completedRetries: number;
  signal?: AbortSignal;
  knownRejectedMutationRetry: boolean;
  clearPending(requestId: string): void;
  retry(pending: PendingMutation | undefined, knownRejected: boolean): Promise<Result>;
}): Promise<{ retried: false } | { retried: true; result: Result }> {
  if (!isConnectorBusy(options.error)
      || options.completedRetries >= MAX_CONNECTOR_BUSY_RETRIES) {
    return { retried: false };
  }
  try {
    await waitForConnectorAvailability(options.completedRetries, options.signal);
  } catch (error) {
    if (options.attempt.pendingMutation
        && (options.knownRejectedMutationRetry || !options.attempt.resumingMutation)) {
      options.clearPending(options.attempt.requestId);
    }
    throw error;
  }
  return {
    retried: true,
    result: await options.retry(
      options.attempt.pendingMutationRecord,
      options.knownRejectedMutationRetry
        || (options.attempt.pendingMutation === true && !options.attempt.resumingMutation)
    )
  };
}

export async function isExplicitConnectorBusyResponse(
  response: Response
): Promise<boolean> {
  if (response.status !== 502 && response.status !== 503) return false;
  const body = await response.clone().json().catch(() => null) as {
    error?: string | { code?: unknown };
  } | null;
  return body?.error === "connector_busy"
    || (typeof body?.error === "object"
      && body.error?.code === "connector_busy");
}

export function waitForConnectorAvailability(
  retryIndex: number,
  signal?: AbortSignal
): Promise<void> {
  return retryDelay(jitteredBackoff(50, 800, retryIndex), signal);
}

export function waitForTransientChunkRetry(
  completedAttempt: number,
  signal?: AbortSignal
): Promise<void> {
  return retryDelay(jitteredBackoff(100, 1_000, completedAttempt - 1), signal);
}

async function retryDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  try {
    await abortableDelay(milliseconds, signal);
  } catch (cause) {
    if (signal?.aborted) {
      if (signal.reason instanceof MdbaseConnectError) throw signal.reason;
      throw connectError(
        "operation_cancelled",
        "The operation was cancelled while waiting for connector capacity.",
        { operationOutcome: "not_sent", cause }
      );
    }
    throw cause;
  }
}

function jitteredBackoff(base: number, cap: number, exponent: number): number {
  const bounded = Math.min(cap, base * (2 ** Math.max(0, exponent)));
  return Math.max(1, Math.round(bounded * (0.75 + Math.random() * 0.5)));
}
