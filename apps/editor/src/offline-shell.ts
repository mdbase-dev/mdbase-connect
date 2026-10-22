/**
 * Registers the SDK's offline-shell service worker once the Editor is usable.
 *
 * On a first visit the worker installs by precaching the whole shell, which
 * competed with first render when the SDK's build plugin registered it from
 * the document head. The plugin now builds with `register: false`, and the
 * Editor registers the same worker, with the same scope and module type, after
 * its first usable render, or after a fallback delay on screens that never
 * open a collection (sign-in, grant callback, errors).
 */

interface OfflineShellEnvironment {
  serviceWorker?: Pick<ServiceWorkerContainer, "register">;
  requestIdle?: (callback: () => void, timeoutMs: number) => void;
  setTimer?: (callback: () => void, delayMs: number) => unknown;
  warn?: (message: string) => void;
}

const OFFLINE_SHELL_WORKER = "mdbase-shell-sw.js";
const IDLE_TIMEOUT_MS = 2_000;
// After first usable the Editor still opens the selected note and loads its
// editor chunk; let that settle before the install's precache competes with it.
const SETTLE_DELAY_MS = 3_000;
const FALLBACK_DELAY_MS = 8_000;

export function offlineShellScheduler(base: string, environment: OfflineShellEnvironment) {
  let state: "waiting" | "scheduled" | "registered" = "waiting";
  const register = () => {
    if (state === "registered") return;
    state = "registered";
    void environment.serviceWorker?.register(`${base}${OFFLINE_SHELL_WORKER}`, { scope: base, type: "module" })
      .catch(() => environment.warn?.("Offline app support could not start."));
  };
  const whenIdle = () => {
    if (environment.requestIdle) environment.requestIdle(register, IDLE_TIMEOUT_MS);
    else register();
  };
  const schedule = (delayMs: number) => {
    if (state !== "waiting" || !environment.serviceWorker) return;
    state = "scheduled";
    if (environment.setTimer) environment.setTimer(whenIdle, delayMs);
    else whenIdle();
  };
  return {
    /** The Editor has rendered something usable: register once it settles and the main thread is idle. */
    ready: () => schedule(SETTLE_DELAY_MS),
    /** Screens that never become ready still get the offline shell, later. */
    start: () => { environment.setTimer?.(() => schedule(0), FALLBACK_DELAY_MS); }
  };
}

const browser: OfflineShellEnvironment = typeof window === "undefined" ? {} : {
  // The worker exists only in production builds; the plugin never emits it in development.
  serviceWorker: import.meta.env.PROD && "serviceWorker" in navigator ? navigator.serviceWorker : undefined,
  requestIdle: typeof window.requestIdleCallback === "function"
    ? (callback, timeout) => { window.requestIdleCallback(callback, { timeout }); }
    : undefined,
  setTimer: (callback, delay) => window.setTimeout(callback, delay),
  warn: (message) => console.warn(message)
};

export const offlineShell = offlineShellScheduler(import.meta.env.BASE_URL, browser);
