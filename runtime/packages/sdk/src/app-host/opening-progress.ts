/** Display-only opening boundaries. Never payloads, errors, keys or authority. */
export type AppOpeningProgress =
  | "joining"
  | "opening_store"
  | "connecting_log"
  | "syncing"
  | "loading_snapshot"
  | "replaying"
  | "waiting_for_key"
  | "verifying_read"
  | "checking_setup";

const stages: readonly AppOpeningProgress[] = ["joining", "opening_store", "connecting_log", "syncing", "loading_snapshot", "replaying", "waiting_for_key", "verifying_read", "checking_setup"];
export function isAppOpeningProgress(value: unknown): value is AppOpeningProgress {
  return typeof value === "string" && stages.includes(value as AppOpeningProgress);
}
