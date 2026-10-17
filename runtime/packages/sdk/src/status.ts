/**
 * What a UI shows for sync status (`replica-client-api.md` §7), in every collection
 * state:
 * - **local-only** (no log): writes are confirmed when committed to the
 *   files, receipts carry no `seq`, and `confirmed_through`/`head_known` are 0. Show
 *   "Saved on this device".
 * - **synced**: "Synced through N", "catching up" while `confirmed_through <
 *   head_known`, plus "k changes waiting" when `pending > 0`.
 * Holds and conflicts are counted separately so edits never look silently stuck.
 */
import type { Receipt, SyncStatus } from "./wire.js";

export type StatusKind = "local" | "synced" | "catching_up" | "offline" | "installing"
  | "collection_migrating" | "update_required" | "account_suspended";
const SERVER: Readonly<Record<string, string>> = {
  collection_migrating: "Your collection is being upgraded; changes will sync when it's done",
  update_required: "Update the app to keep syncing",
  account_suspended: "Syncing is paused: your account is suspended",
};

/** Why the log cannot be reached right now, from the last failed request. */
export type TransportHealthKind = "offline" | "unreachable" | "server_busy" | "rate_limited" | "auth";
export interface TransportHealth {
  readonly kind: TransportHealthKind;
  readonly retryAfterMs?: number | null;
}
const HEALTH: Readonly<Record<TransportHealthKind, string>> = {
  offline: "You're offline",
  unreachable: "Can't reach the sync service",
  server_busy: "The sync service is busy; trying again shortly",
  rate_limited: "Syncing is paused for a moment",
  auth: "Sign in again to keep syncing",
};

export interface StatusSummary {
  kind: StatusKind;
  /** Plain English; apps may use their own text keyed on `kind`. */
  text: string;
  pending: number;
  holds: number;
  conflicts: number;
  /** Highest confirmed log position, or null in a local-only collection. */
  confirmedThrough: number | null;
  /** Why syncing is not getting through right now, or null. Changes keep
   * being saved on this device meanwhile. */
  health: TransportHealthKind | null;
  /** False while other devices' changes are not arriving live; they appear when
   * the app is focused or shown again, or comes back online. Null when unknown
   * or local-only. */
  live: boolean | null;
}

/**
 * Pass the application snapshot's `problem` as `problem` so a live server
 * refusal (collection_migrating, update_required, account_suspended) shows as
 * that, not as offline or catching up.
 */
export function summarizeStatus(s: SyncStatus, problem?: string | null, transport?: TransportHealth | null, live?: boolean | null): StatusSummary {
  const health = s.mode !== "local_only" && transport && Object.hasOwn(HEALTH, transport.kind) ? transport.kind : null;
  const base = {
    pending: s.pending,
    holds: s.holds,
    conflicts: s.unresolved,
    confirmedThrough: s.mode === "local_only" ? null : s.confirmedThrough,
    health,
    live: s.mode === "local_only" || typeof live !== "boolean" ? null : live,
  };
  const waiting = s.pending > 0 ? `, ${s.pending} change${s.pending === 1 ? "" : "s"} waiting` : "";
  if (s.mode === "local_only") {
    return { ...base, kind: "local", text: s.pending ? `Saving${waiting}` : "Saved on this device" };
  }
  if (problem && Object.hasOwn(SERVER, problem)) {
    return { ...base, kind: problem as StatusKind, text: `${SERVER[problem]}${waiting}` };
  }
  if (s.installing) {
    return { ...base, kind: "installing", text: `Loading the collection (${s.installing.done}/${s.installing.total})` };
  }
  if (health) {
    const saved = s.pending ? `. ${s.pending} change${s.pending === 1 ? " is" : "s are"} saved on this device and will sync later` : "";
    return { ...base, kind: health === "offline" || health === "unreachable" ? "offline" : s.confirmedThrough < s.headKnown ? "catching_up" : "synced", text: `${HEALTH[health]}${saved}` };
  }
  if (s.connection !== "online") {
    return { ...base, kind: "offline", text: `Offline; synced through ${s.confirmedThrough}${waiting}` };
  }
  if (s.confirmedThrough < s.headKnown) {
    return { ...base, kind: "catching_up", text: `Catching up (${s.confirmedThrough}/${s.headKnown})${waiting}` };
  }
  const paused = base.live === false ? ". Live updates are paused; changes from other devices appear when you come back to this app" : "";
  return { ...base, kind: "synced", text: `Synced through ${s.confirmedThrough}${waiting}${paused}` };
}

/**
 * True once a write is durable: confirmed at a log position (synced), or committed to
 * the files with no position (local-only). Never inspect `seq` to decide this.
 */
export function isConfirmed(r: Receipt): boolean {
  return r.state === "confirmed";
}
