/**
 * The one status an app shows for the open collection (`replica-client-api.md`
 * §7): whether changes reach the cloud copy, what is still waiting, and what
 * needs the person. `summarizeSync` derives it from the replica's status, the
 * write ledger and what the host knows about the network, so an app shows
 * `sync.state` and does not combine those itself.
 *
 * - **local-only** (no log): a write is confirmed when it is in the files.
 *   The connection is `"local"` and the state is `"saved"` or `"saving"`.
 * - **synced**: a write is confirmed at a log position. Until then it is
 *   pending: `"saving"` while it can be delivered, `"saved_on_device"` while it
 *   cannot.
 * Holds and conflicts are counted separately so edits never look silently stuck.
 */
import type { Receipt } from "./plain.js";
import type { Incident, SyncStatus } from "./wire.js";
import type { WriteLedgerSnapshot } from "./write-ledger.js";

/** Why the log cannot be reached right now, from the last failed request. */
export type TransportHealthKind = "offline" | "unreachable" | "server_busy" | "rate_limited" | "auth";
export interface TransportHealth {
  readonly kind: TransportHealthKind;
  readonly retryAfterMs?: number | null;
}

/** The service will not sync this collection or account until something changes. */
const REFUSALS = ["collection_not_yet_migrated", "collection_migrating", "update_required", "account_suspended"] as const satisfies readonly SyncAttention[];

/**
 * What an indicator shows: the first of these that applies.
 * - `attention`: something needs the person; `attention` lists what.
 * - `saved_on_device`: changes are kept here and sync once the service can be
 *   reached.
 * - `offline`: this device has no network, and nothing is waiting.
 * - `reconnecting`: the network is there but the service is not answering yet.
 * - `saving`: changes are on their way.
 * - `catching_up`: other devices' changes are still arriving.
 * - `saved`: everything made here is confirmed.
 */
export type SyncState = "attention" | "saved_on_device" | "offline" | "reconnecting" | "saving" | "catching_up" | "saved";

/**
 * One thing that needs the person, most pressing first in `MdbaseSync.attention`:
 * a refusal by the service, a write it rejected (`writes.rejected`), a conflict
 * to resolve, an edit held for their choice, an incident stalling the replica
 * (`incidents`), or pending changes on storage the browser may clear.
 */
export type SyncAttention =
  | "collection_not_yet_migrated" | "collection_migrating" | "update_required" | "account_suspended"
  | "rejected" | "conflicts" | "held" | "incident" | "storage_may_be_evicted";

export interface MdbaseSync {
  readonly state: SyncState;
  /** Whether changes reach the cloud copy. `"local"`: this collection has none. */
  readonly connection: "online" | "reconnecting" | "offline" | "local";
  /** Why the service is not being reached, from the last failed request, or null. */
  readonly health: TransportHealthKind | null;
  /** False while other devices' changes are not arriving live; they appear when
   * the app is focused or shown again, or comes back online. Null when unknown
   * or local-only. */
  readonly live: boolean | null;
  /** Changes made here that are not confirmed yet. */
  readonly pending: number;
  /**
   * How long changes have been waiting without a break. `"moment"`: under two
   * seconds, in which most saves finish, so an indicator need not change.
   * `"long"`: over thirty seconds. Null with nothing pending.
   */
  readonly pendingFor: "moment" | "while" | "long" | null;
  /** The pending and rejected writes one by one, or null without a ledger. */
  readonly writes: WriteLedgerSnapshot | null;
  /** What needs the person, most pressing first. Empty unless `state` is `"attention"`. */
  readonly attention: readonly SyncAttention[];
  /** Conflicts waiting to be resolved. */
  readonly conflicts: number;
  /** Edits held for the person's choice. */
  readonly holds: number;
  /** What is stalling the replica, as it reports them. */
  readonly incidents: readonly Incident[];
}

/** After this long a save is worth showing; after `LONG_PENDING_MS` it is slow. */
export const BRIEF_PENDING_MS = 2_000;
export const LONG_PENDING_MS = 30_000;

export interface SyncInput {
  /** `client.status`. */
  readonly status: SyncStatus;
  /** `client.ledger.getSnapshot()`. */
  readonly writes?: WriteLedgerSnapshot | null;
  /** `client.link`: the app's own link to the replica. While it is not open
   * the status is the last one heard. */
  readonly link?: "open" | "reconnecting" | "closed";
  /** The application snapshot's `problem`, so a refusal by the service shows as one. */
  readonly problem?: string | null;
  /** What the last failed request to the log says, or null after one succeeded. */
  readonly transport?: TransportHealth | null;
  /** Whether other devices' changes arrive live. */
  readonly live?: boolean | null;
  /** `navigator.onLine`. Only `false` is believed: `true` proves nothing. */
  readonly online?: boolean;
  /** How long changes have been pending without a break. Left out, a pending
   * change counts as waiting a while. */
  readonly pendingForMs?: number;
  /** Pending changes sit on storage the browser may clear. */
  readonly storageWarning?: boolean;
}

export function summarizeSync(input: SyncInput): MdbaseSync {
  const s = input.status, local = s.mode === "local_only";
  const writes = input.writes ?? null;
  const pending = Math.max(s.pending, writes?.pending.length ?? 0);
  const health = !local && input.transport ? input.transport.kind : null;
  const linked = input.link === undefined || input.link === "open";
  const connection: MdbaseSync["connection"] =
    !linked ? "reconnecting"
    : local ? "local"
    : input.online === false || health === "offline" ? "offline"
    : health ? "reconnecting"
    : s.connection === "offline" ? "offline"
    : s.connection === "connecting" ? "reconnecting"
    : "online";
  const attention: SyncAttention[] = [];
  const refusal = local ? undefined : REFUSALS.find((r) => r === input.problem);
  if (refusal) attention.push(refusal);
  if (writes?.rejected.length) attention.push("rejected");
  if (s.unresolved > 0) attention.push("conflicts");
  if (s.holds > 0) attention.push("held");
  if (s.incidents.length) attention.push("incident");
  if (pending > 0 && input.storageWarning) attention.push("storage_may_be_evicted");
  // Delivery is known to be failing: no network, or the last request failed. A
  // replica that is only connecting delivers as soon as it is through.
  const undeliverable = connection === "offline" || health !== null || !linked;
  const state: SyncState =
    attention.length ? "attention"
    : pending > 0 && undeliverable ? "saved_on_device"
    : connection === "offline" ? "offline"
    : connection === "reconnecting" ? "reconnecting"
    : pending > 0 ? "saving"
    : !local && (s.installing !== undefined || s.resyncing !== undefined || s.confirmedThrough < s.headKnown) ? "catching_up"
    : "saved";
  const age = input.pendingForMs;
  return {
    state,
    connection,
    health,
    live: local || typeof input.live !== "boolean" ? null : input.live,
    pending,
    pendingFor: pending === 0 ? null : age === undefined ? "while" : age < BRIEF_PENDING_MS ? "moment" : age < LONG_PENDING_MS ? "while" : "long",
    writes,
    attention,
    conflicts: s.unresolved,
    holds: s.holds,
    incidents: s.incidents,
  };
}

/**
 * True once a write is durable: confirmed at a log position (synced), or committed to
 * the files with no position (local-only). Never inspect `seq` to decide this.
 */
export function isConfirmed(r: Receipt): boolean {
  return r.state === "confirmed";
}
