/** The page's visibility, as `document` reports it. */
export interface VisibilitySource {
  readonly visibilityState: DocumentVisibilityState;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
}

export interface IntervalTimers {
  setInterval(task: () => void, ms: number): unknown;
  clearInterval(timer: unknown): void;
}

/** Share a read in progress. After a mutation, wait for it and request fresh data. */
export function singleFlight(task: () => Promise<void>) {
  let current: Promise<void> | undefined;
  const run = () => current ??= task().finally(() => { current = undefined; });
  return async (fresh = false) => {
    if (fresh) await current;
    await run();
  };
}

/**
 * Runs `task` now and every `intervalMs` while the page is visible, skipping
 * ticks while the previous request is in flight. A window
 * closed to the tray or minimised is hidden, so it makes no calls; becoming
 * visible again runs `task` once at once and resumes the interval. Returns the
 * function that stops it.
 */
export function pollWhileVisible(
  task: () => void | Promise<void>,
  intervalMs: number,
  page: VisibilitySource = document,
  timers: IntervalTimers = window
): () => void {
  let timer: unknown = null;
  let running = false;
  const tick = () => {
    if (running) return;
    const result = task();
    if (result) {
      running = true;
      void result.then(() => { running = false; }, () => { running = false; });
    }
  };
  const follow = () => {
    if (page.visibilityState === "visible") {
      if (timer !== null) return;
      tick();
      timer = timers.setInterval(tick, intervalMs);
    } else if (timer !== null) {
      timers.clearInterval(timer);
      timer = null;
    }
  };
  follow();
  page.addEventListener("visibilitychange", follow);
  return () => {
    page.removeEventListener("visibilitychange", follow);
    if (timer !== null) timers.clearInterval(timer);
  };
}
