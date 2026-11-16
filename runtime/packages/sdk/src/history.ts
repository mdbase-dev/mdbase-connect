/**
 * Record history (`replica-client-api.md` §4.4, API 1.4): the versions of one
 * record that the collection log still retains, newest first, and one
 * version's exact document. Both need the `history.read` capability.
 *
 * Restoring a version needs no method: write its document back with an
 * ordinary revision-checked update.
 */
import { enumOf, hash, int, list, struct, tstr, uint, uuid } from "./codec.js";
import { deviceKind, type DeviceKind } from "./private.js";
import type { Uuid } from "./wire.js";

/** How an entry changed the record. */
export type VersionKind = "created" | "edited" | "moved" | "deleted";

/** Who wrote a version. Policy is never compacted, so revoked devices and
 * grants still resolve. */
export interface AuthorRef {
  /** The signing device's account; the all-zero service account when the
   * hosted device signed. */
  account: Uuid;
  /** The signing device. */
  device: Uuid;
  /** The app grant the write went through. */
  grant?: Uuid;
  /** The grant's account, only when the hosted device signed. */
  grantAccount?: Uuid;
}

export interface HistoryVersion {
  /** The entry's log position: pass it to `history.version`. */
  seq: number;
  /** The writer's capture time (ms). It can disagree with log order. */
  time: number;
  author: AuthorRef;
  kind: VersionKind;
  /** The path after the entry (before it, for a deletion). */
  path: string;
  /** SHA-256 of the document written; absent for a deletion. */
  revision?: string;
  /** `external`: an edit observed in the folder, outside mdbase. */
  source: "api" | "external";
  /** The signing device's kind; `unknown` for a kind this SDK predates. */
  deviceKind: DeviceKind | "unknown";
  /** The grant's app ID. */
  app?: string;
}

export interface RecordHistory {
  /** Newest first. */
  versions: HistoryVersion[];
  /** The lowest log position read. */
  from: number;
  /** The capture time (ms) of the oldest readable entry at or above `from`. */
  fromTime?: number;
  /** Present while older versions may exist: pass it as `before`. When it is
   * absent and the oldest version is not `created`, the record's earlier
   * history is no longer retained. */
  next?: number;
}

export interface RecordVersion {
  /** The record's path at that version. */
  path: string;
  /** Its exact text. */
  document: string;
}

/** @internal */
export interface RecordHistoryParams {
  record: Uuid;
  before?: number;
  limit?: number;
}

/** @internal */
export interface RecordVersionParams {
  record: Uuid;
  seq: number;
}

/** @internal */
export const recordHistoryParams = struct<RecordHistoryParams>("record-history-params", [
  [0, "record", uuid],
  [1, "before", uint, "opt"],
  [2, "limit", uint, "opt"],
]);

/** @internal */
export const recordVersionParams = struct<RecordVersionParams>("record-version-params", [
  [0, "record", uuid],
  [1, "seq", uint],
]);

const authorRef = struct<AuthorRef>("author-ref", [
  [0, "account", uuid],
  [1, "device", uuid],
  [2, "grant", uuid, "opt"],
  [3, "grantAccount", uuid, "opt"],
]);

const historyVersion = struct<HistoryVersion>("history-version", [
  [0, "seq", uint],
  [1, "time", int],
  [2, "author", authorRef],
  [3, "kind", enumOf<VersionKind>("version-kind", ["created", "edited", "moved", "deleted"])],
  [4, "path", tstr],
  [5, "revision", hash, "opt"],
  [6, "source", enumOf("source", ["api", "external"] as const)],
  [7, "deviceKind", deviceKind],
  [8, "app", tstr, "opt"],
]);

/** @internal */
export const recordHistory = struct<RecordHistory>("record-history", [
  [0, "versions", list(historyVersion)],
  [1, "from", uint],
  [2, "fromTime", int, "opt"],
  [3, "next", uint, "opt"],
]);

/** @internal */
export const recordVersion = struct<RecordVersion>("record-version", [
  [0, "path", tstr],
  [1, "document", tstr],
]);
