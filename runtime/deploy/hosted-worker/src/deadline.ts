/**
 * A timeout signal whose timer is stopped once the bounded work settles.
 *
 * A pending `AbortSignal.timeout` timer holds a Durable Object invocation open,
 * and billed, until it fires, long after the work it bounded has finished: every
 * idle hosted alarm finished its sync in about 2.5 s and then stayed awake 20 s
 * more for the custody attempt timeout. Use `withDeadline`, or `deadline` with
 * `clear()` in a finally, instead of `AbortSignal.timeout`.
 */
export function deadline(ms: number): { signal: AbortSignal; clear: () => void } {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(new DOMException("The operation was aborted due to timeout", "TimeoutError")), ms);
  return { signal: abort.signal, clear: () => clearTimeout(timer) };
}

/** Runs `work` bounded by `ms` (and by `parent`, when given), then stops the timer. */
export async function withDeadline<T>(ms: number, work: (signal: AbortSignal) => Promise<T>, parent?: AbortSignal): Promise<T> {
  const timeout = deadline(ms);
  try { return await work(parent ? AbortSignal.any([parent, timeout.signal]) : timeout.signal); }
  finally { timeout.clear(); }
}
