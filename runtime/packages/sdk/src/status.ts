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

export type StatusKind = "local" | "synced" | "catching_up" | "offline" | "installing";

export interface StatusSummary {
  kind: StatusKind;
  /** Plain English; apps may use their own text keyed on `kind`. */
  text: string;
  pending: number;
  holds: number;
  conflicts: number;
  /** Highest confirmed log position, or null in a local-only collection. */
  confirmedThrough: number | null;
}

export function summarizeStatus(s: SyncStatus): StatusSummary {
  const base = {
    pending: s.pending,
    holds: s.holds,
    conflicts: s.unresolved,
    confirmedThrough: s.mode === "local_only" ? null : s.confirmedThrough,
  };
  const waiting = s.pending > 0 ? `, ${s.pending} change${s.pending === 1 ? "" : "s"} waiting` : "";
  if (s.mode === "local_only") {
    return { ...base, kind: "local", text: s.pending ? `Saving${waiting}` : "Saved on this device" };
  }
  if (s.installing) {
    return { ...base, kind: "installing", text: `Loading the collection (${s.installing.done}/${s.installing.total})` };
  }
  if (s.connection !== "online") {
    return { ...base, kind: "offline", text: `Offline; synced through ${s.confirmedThrough}${waiting}` };
  }
  if (s.confirmedThrough < s.headKnown) {
    return { ...base, kind: "catching_up", text: `Catching up (${s.confirmedThrough}/${s.headKnown})${waiting}` };
  }
  return { ...base, kind: "synced", text: `Synced through ${s.confirmedThrough}${waiting}` };
}

/**
 * True once a write is durable: confirmed at a log position (synced), or committed to
 * the files with no position (local-only). Never inspect `seq` to decide this.
 */
export function isConfirmed(r: Receipt): boolean {
  return r.state === "confirmed";
}
