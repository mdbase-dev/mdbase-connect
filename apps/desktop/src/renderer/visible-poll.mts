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

/**
 * Runs `task` now and every `intervalMs` while the page is visible. A window
 * closed to the tray or minimised is hidden, so it makes no calls; becoming
 * visible again runs `task` once at once and resumes the interval. Returns the
 * function that stops it.
 */
export function pollWhileVisible(
  task: () => void,
  intervalMs: number,
  page: VisibilitySource = document,
  timers: IntervalTimers = window
): () => void {
  let timer: unknown = null;
  const follow = () => {
    if (page.visibilityState === "visible") {
      if (timer !== null) return;
      task();
      timer = timers.setInterval(task, intervalMs);
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
