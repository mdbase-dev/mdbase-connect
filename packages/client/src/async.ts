export function abortableDelay(
  milliseconds: number,
  signal?: AbortSignal
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
      return;
    }
    const cleanup = () => signal?.removeEventListener("abort", abort);
    const timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, milliseconds);
    const abort = () => {
      clearTimeout(timeout);
      cleanup();
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

/** How long `watch` waits between polls while the page is hidden. */
const HIDDEN_POLL_INTERVAL_MS = 60_000;

/**
 * Wait before the next change poll. In a hidden browser tab, wait at least
 * {@link HIDDEN_POLL_INTERVAL_MS} instead, but return as soon as the tab
 * becomes visible so a returning user sees current data immediately.
 */
export function pollDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  const page = typeof document === "undefined" ? undefined : document;
  if (page?.visibilityState !== "hidden") return abortableDelay(milliseconds, signal);
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      return;
    }
    const cleanup = () => {
      clearTimeout(timeout);
      page.removeEventListener("visibilitychange", visible);
      signal?.removeEventListener("abort", abort);
    };
    const visible = () => {
      if (page.visibilityState === "hidden") return;
      cleanup();
      resolve();
    };
    const abort = () => {
      cleanup();
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    const timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, Math.max(milliseconds, HIDDEN_POLL_INTERVAL_MS));
    page.addEventListener("visibilitychange", visible);
    signal?.addEventListener("abort", abort, { once: true });
  });
}
