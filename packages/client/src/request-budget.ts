import { MdbaseConnectError, connectError } from "./errors.js";
import type { ConnectRequestOptions } from "./operation-types.js";
import type { MdbaseConnectTimeouts } from "./connect-options.js";

export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
export const DEFAULT_STARTUP_TIMEOUT_MS = 10_000;
export const DEFAULT_UPLOAD_TIMEOUT_MS = 120_000;
export const DEFAULT_SYNC_TIMEOUT_MS = 60_000;

export interface ResolvedConnectTimeouts {
  requestMs: number | null;
  watchStartMs: number | null;
  uploadMs: number | null;
  syncMs: number | null;
}

export function resolveConnectTimeouts(
  timeouts: MdbaseConnectTimeouts = {}
): ResolvedConnectTimeouts {
  return {
    requestMs: configuredTimeout(timeouts.requestMs, DEFAULT_REQUEST_TIMEOUT_MS, "requestMs"),
    watchStartMs: configuredTimeout(timeouts.watchStartMs, DEFAULT_STARTUP_TIMEOUT_MS, "watchStartMs"),
    uploadMs: configuredTimeout(timeouts.uploadMs, DEFAULT_UPLOAD_TIMEOUT_MS, "uploadMs"),
    syncMs: configuredTimeout(timeouts.syncMs, DEFAULT_SYNC_TIMEOUT_MS, "syncMs")
  };
}

export interface RequestBudget {
  readonly signal: AbortSignal;
  readonly deadline: number | null;
  remainingMs(): number | null;
  dispose(): void;
}

export function createRequestBudget(
  options: ConnectRequestOptions = {},
  defaultTimeoutMs: number | null = DEFAULT_REQUEST_TIMEOUT_MS,
  now: () => number = Date.now
): RequestBudget {
  const configured = options.timeoutMs === undefined ? defaultTimeoutMs : options.timeoutMs;
  const timeoutMs = configured === null ? null : validTimeout(configured);
  const controller = new AbortController();
  const deadline = timeoutMs === null ? null : now() + timeoutMs;
  const abortFromCaller = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) abortFromCaller();
  else options.signal?.addEventListener("abort", abortFromCaller, { once: true });
  const timer = timeoutMs === null
    ? undefined
    : setTimeout(() => controller.abort(connectError(
        "timeout",
        "The operation exceeded its request deadline.",
        { operationOutcome: "not_sent" }
      )), timeoutMs);
  let disposed = false;
  return {
    signal: controller.signal,
    deadline,
    remainingMs: () => deadline === null ? null : Math.max(0, deadline - now()),
    dispose: () => {
      if (disposed) return;
      disposed = true;
      if (timer !== undefined) clearTimeout(timer);
      options.signal?.removeEventListener("abort", abortFromCaller);
    }
  };
}

export async function withRequestBudget<Result>(
  options: ConnectRequestOptions | undefined,
  defaultTimeoutMs: number | null,
  operation: (budget: RequestBudget) => Promise<Result>
): Promise<Result> {
  const budget = createRequestBudget(options, defaultTimeoutMs);
  let rejectOnAbort: ((reason: unknown) => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectOnAbort = reject;
  });
  const abort = () => rejectOnAbort?.(requestAbortReason(budget.signal));
  budget.signal.addEventListener("abort", abort, { once: true });
  try {
    if (budget.signal.aborted) throw requestAbortReason(budget.signal);
    return await Promise.race([operation(budget), aborted]);
  } finally {
    budget.signal.removeEventListener("abort", abort);
    budget.dispose();
  }
}

/**
 * Budget an operation whose transport cooperates with AbortSignal and must run
 * its own bounded cleanup/recovery before the public promise settles.
 */
export async function withCooperativeRequestBudget<Result>(
  options: ConnectRequestOptions | undefined,
  defaultTimeoutMs: number | null,
  operation: (budget: RequestBudget) => Promise<Result>
): Promise<Result> {
  const budget = createRequestBudget(options, defaultTimeoutMs);
  try {
    if (budget.signal.aborted) throw requestAbortReason(budget.signal);
    return await operation(budget);
  } finally {
    budget.dispose();
  }
}

export function requestAbortReason(signal: AbortSignal): unknown {
  if (signal.reason instanceof MdbaseConnectError) return signal.reason;
  return connectError(
    "operation_cancelled",
    "The operation was cancelled before it changed the collection.",
    { operationOutcome: "not_sent", cause: signal.reason }
  );
}

function validTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError("timeoutMs must be a positive safe integer or null.");
  }
  return value;
}

function configuredTimeout(
  value: number | null | undefined,
  fallback: number,
  name: string
): number | null {
  if (value === undefined) return fallback;
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer or null.`);
  }
  return value;
}
