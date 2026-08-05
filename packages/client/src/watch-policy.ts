import type { WatchOptions } from "./operation-types.js";

export interface ResolvedWatchRetryOptions {
  initialDelayMs: number;
  maxDelayMs: number;
  multiplier: number;
  maxAttempts?: number;
}

export function watchRetryPolicy(
  options: WatchOptions["retry"]
): ResolvedWatchRetryOptions | undefined {
  if (options === false) return undefined;
  return {
    initialDelayMs: Math.max(0, options?.initialDelayMs ?? 500),
    maxDelayMs: Math.max(0, options?.maxDelayMs ?? 15_000),
    multiplier: Math.max(1, options?.multiplier ?? 2),
    ...(options?.maxAttempts === undefined
      ? {}
      : { maxAttempts: Math.max(0, options.maxAttempts) })
  };
}
