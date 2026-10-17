/** Initial sync: whether an opened collection's replica has caught up with the
 * log at least once, distinct from "current" (open, owned and readable). An app
 * that assesses setup or shows an empty state before this holds stale data. */
import type { SyncStatus } from "../wire.js";

/** Why the first catch-up has not finished yet. */
export type AppInitialSyncWait =
  /** No log turn has succeeded since the collection opened. */
  | "first_turn"
  /** The replica cannot open sealed entries until its key grant arrives. */
  | "waiting_for_key"
  | "installing"
  | "resyncing"
  | "offline"
  /** The log head has not been read yet. */
  | "head_unknown"
  /** Entries up to the known head are not all applied yet. */
  | "behind"
  /** The native status could not be read. */
  | "unavailable";

/** Null once the replica holds everything up to the known log head. */
export function initialSyncWait(status: SyncStatus): AppInitialSyncWait | null {
  if (status.mode === "local_only") return null;
  if (status.incidents.some(incident => incident.kind === "waiting_for_key")) return "waiting_for_key";
  if (status.installing) return "installing";
  if (status.resyncing) return "resyncing";
  if (status.connection === "offline") return "offline";
  // Every collection log holds at least the entries that granted this device
  // its key, so a readable replica never legitimately knows a zero head.
  if (status.headKnown === 0) return "head_unknown";
  if (status.confirmedThrough < status.headKnown) return "behind";
  return null;
}

/** Diagnostics for a `waiting_for_key` wait: the replica's read-ahead reason
 * (`no_grant`, `grant_void`, `blocked`, ...) and positions, tokens and integers
 * only. Null when not waiting for a key. */
export function keyWaitDetail(status: SyncStatus): Record<string, string | number> | null {
  const found = status.incidents.find(incident => incident.kind === "waiting_for_key");
  if (!found) return null;
  const out: Record<string, string | number> = {through: status.confirmedThrough, head: status.headKnown};
  const d = found.details as unknown;
  const get = (k: string): unknown => d instanceof Map ? d.get(k) : d && typeof d === "object" ? (d as Record<string, unknown>)[k] : undefined;
  const reason = get("reason");
  if (typeof reason === "string" && /^[a-z_]{1,32}$/.test(reason)) out.key = reason;
  for (const k of ["position", "at"]) {
    const v = get(k);
    if (typeof v === "number" || typeof v === "bigint") out[k] = Number(v);
  }
  return out;
}
