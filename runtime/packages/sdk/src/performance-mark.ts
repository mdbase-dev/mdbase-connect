import type { AppOpeningProgress } from "./app-host/opening-progress.js";

/** Local User Timing only: fixed names, no identifiers or detail payloads. */
export function performanceMark(name: "mdbase:open:requested" | "mdbase:open:approved" | "mdbase:open:ready" | `mdbase:open:stage:${AppOpeningProgress}` | "mdbase:query:first-result"): void {
  if (typeof performance !== "undefined") performance.mark(name);
}
