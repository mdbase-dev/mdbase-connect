/** Owns the latest single-use cursor, including while an iterator is paused at yield. */
export function queryCursorLease(
  release: (cursor: string) => Promise<void>,
  signal?: AbortSignal,
  initialCursor?: string
) {
  let cursor = initialCursor;
  let inFlight = false;
  const close = () => {
    if (!cursor) return;
    const owned = cursor;
    cursor = undefined;
    // Collection cleanup has an independent bounded budget, never the data signal.
    void release(owned).catch(() => undefined);
  };
  const abort = () => {
    // A consumed token can rotate while the request settles. Release the returned
    // token instead; a paused iterator has no request and closes immediately.
    if (!inFlight) close();
  };
  signal?.addEventListener("abort", abort, { once: true });
  return {
    startRequest() { inFlight = true; },
    finishRequest(nextCursor?: string) {
      if (nextCursor) cursor = nextCursor;
      inFlight = false;
      if (signal?.aborted) close();
    },
    dispose() {
      signal?.removeEventListener("abort", abort);
      close();
    }
  };
}

export function resultCap(value?: number): number {
  if (value === undefined) return Infinity;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("maxResults must be a non-negative safe integer.");
  }
  return value;
}

export function nonNegativeInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : fallback;
}

export function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 1
    ? Math.floor(value)
    : fallback;
}
