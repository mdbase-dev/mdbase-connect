/**
 * Hold UX: a held file reads as
 * "mdbase protected your edit", never "sync is stuck". This module turns the §8 wire
 * `Hold` into a plain-language cause, the resolve actions that apply, and the shared
 * sync-status line; the daemon tray, the Obsidian plugin and the TaskNotes app all use
 * the same vocabulary (wire `HoldReason` / `HoldResolution` values verbatim, no parallel
 * enum) and the same compare hand-off link.
 */
import type { Hold, HoldReason, HoldResolution, SyncStatus } from "./wire.js";

export const HOLD_TITLE = "mdbase protected your edit";

/** What the user can do about a hold. `compare` opens the app's merge view; the rest map to `resolve_hold`. */
export type HoldAction = HoldResolution | "compare";

export interface HoldActionOption {
  action: HoldAction;
  /** Button text. */
  label: string;
  /** One sentence on what happens. */
  description: string;
  /** The `resolve_hold` resolution, absent for `compare`. */
  resolution?: HoldResolution;
  /** The capability `resolve_hold` needs for it. */
  needs?: "records.edit" | "records.delete";
  /** True when the user's held bytes are not kept anywhere by this action (offer "keep both" next to it). */
  discardsMine: boolean;
}

export interface HoldPresentation {
  id: Hold["id"];
  path: string;
  reason: HoldReason;
  title: typeof HOLD_TITLE;
  /** Plain-language cause, one sentence. */
  cause: string;
  /** What mdbase did about it, one sentence. */
  detail: string;
  since: number;
  /** Saves the user made while the hold stood. */
  saves: number;
  /** Whether a confirmed version exists to compare against (absent when deleted elsewhere). */
  hasTheirs: boolean;
  actions: HoldActionOption[];
  /** Every resolution is an ordinary mutation in the log, so the record's previous version stays in history. */
  reversible: true;
  reversibleNote: string;
  /** The compare hand-off (`mdbase://hold/compare?...`), when a merge view can be opened. */
  compareLink: string | null;
}

const CAUSES: Record<HoldReason, { cause: string; detail: string }> = {
  conflict: {
    cause: "This file was also changed on another device while you were editing it.",
    detail: "Your version is kept here and is not synced until you choose what to keep.",
  },
  unknown_provenance: {
    cause: "This file changed on disk in a way mdbase could not trace to an app or a sync.",
    detail: "The bytes on disk are kept here and are not synced until you confirm them.",
  },
  deleted_elsewhere: {
    cause: "This file was deleted on another device after you edited it.",
    detail: "Your version is kept here; nothing is deleted until you choose.",
  },
  read_only: {
    cause: "You do not have permission to change this file in this collection.",
    detail: "Your edit is kept on this device and is not synced.",
  },
  editor_busy: {
    cause: "An editor still has this file open with unsaved changes.",
    detail: "mdbase waits so that it never overwrites what you are typing.",
  },
  suspect_write: {
    cause: "The last write to this file looked incomplete, for example after a crash.",
    detail: "The file is kept aside and is not synced until you confirm it.",
  },
};

const OPTIONS: Record<HoldResolution | "compare", Omit<HoldActionOption, "action">> = {
  keep_mine: { label: "Keep mine", description: "Sync the version on this device.", resolution: "keep_mine", needs: "records.edit", discardsMine: false },
  take_theirs: { label: "Take theirs", description: "Replace this file with the synced version.", resolution: "take_theirs", needs: "records.edit", discardsMine: true },
  keep_both: { label: "Keep both", description: "Save your version as a copy next to the synced one.", resolution: "keep_both", needs: "records.edit", discardsMine: false },
  delete: { label: "Delete", description: "Accept the deletion and remove this file here too.", resolution: "delete", needs: "records.delete", discardsMine: true },
  use: { label: "Use merged", description: "Sync the document you merged.", resolution: "use", needs: "records.edit", discardsMine: false },
  compare: { label: "Compare side by side", description: "Open both versions to merge them.", discardsMine: false },
};

/** Which actions apply to each reason, in display order. `compare` and `take_theirs` need a confirmed version. */
const ACTIONS: Record<HoldReason, HoldAction[]> = {
  conflict: ["keep_mine", "take_theirs", "compare", "keep_both"],
  unknown_provenance: ["keep_mine", "take_theirs", "compare", "keep_both"],
  deleted_elsewhere: ["keep_mine", "delete"],
  read_only: ["take_theirs", "keep_both", "compare"],
  editor_busy: ["keep_mine", "take_theirs", "compare"],
  suspect_write: ["keep_mine", "take_theirs", "compare", "keep_both"],
};

export const HOLD_COMPARE_SCHEME = "mdbase://hold/compare";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The compare hand-off the daemon tray opens and apps register: `mdbase://hold/compare?collection=<uuid>&id=<uuid>`. */
export function holdCompareLink(collectionId: string, id: string): string {
  if (!UUID.test(collectionId) || !UUID.test(id)) throw new Error("holdCompareLink: collection and id are UUIDs");
  return `${HOLD_COMPARE_SCHEME}?collection=${collectionId.toLowerCase()}&id=${id.toLowerCase()}`;
}

/** Parse a compare hand-off; `null` for anything else (never throws on untrusted input). */
export function parseHoldCompareLink(url: string): { collectionId: string; id: string } | null {
  if (typeof url !== "string" || url.length > 512 || !url.startsWith(`${HOLD_COMPARE_SCHEME}?`)) return null;
  const q = new URLSearchParams(url.slice(HOLD_COMPARE_SCHEME.length + 1));
  const collectionId = q.get("collection") ?? "";
  const id = q.get("id") ?? "";
  if (!UUID.test(collectionId) || !UUID.test(id)) return null;
  return { collectionId: collectionId.toLowerCase(), id: id.toLowerCase() };
}

export interface DescribeHoldOptions {
  /** The collection, for the compare link. */
  collectionId: string;
  /** Whether this app can open a merge view (default: true when a confirmed version exists). */
  canCompare?: boolean;
  /** The caller's capabilities, to drop actions it cannot perform (default: all). */
  capabilities?: readonly string[];
}

/** Present one hold: cause, detail, applicable actions and the compare link. */
export function describeHold(h: Hold, o: DescribeHoldOptions): HoldPresentation {
  const hasTheirs = h.theirs !== undefined;
  const canCompare = (o.canCompare ?? true) && hasTheirs;
  const can = (needs?: HoldActionOption["needs"]) => !needs || !o.capabilities || o.capabilities.includes(needs);
  const actions = ACTIONS[h.reason]
    .filter((a) => (a === "compare" ? canCompare : a === "take_theirs" ? hasTheirs : true))
    .map((action) => ({ action, ...OPTIONS[action] }))
    .filter((a) => can(a.needs));
  const text = CAUSES[h.reason];
  return {
    id: h.id,
    path: h.path,
    reason: h.reason,
    title: HOLD_TITLE,
    cause: text.cause,
    detail: text.detail,
    since: h.since,
    saves: h.saves,
    hasTheirs,
    actions,
    reversible: true,
    reversibleNote: "You can change your mind later: resolving is an ordinary change, and the previous version stays in the collection's history. Keep both if you want your version kept as a file as well.",
    compareLink: canCompare ? holdCompareLink(o.collectionId, h.id) : null,
  };
}

/** Banner text for a list of holds, or `null` when there are none. */
export function holdNotice(holds: readonly Hold[]): string | null {
  if (!holds.length) return null;
  if (holds.length === 1) return `${HOLD_TITLE}: ${holds[0]!.path} is waiting for your choice.`;
  return `${HOLD_TITLE}: ${holds.length} files are waiting for your choice.`;
}

/**
 * The sync status line every client shows: "Confirmed through N, plus P pending, plus H
 * held". Holds are never "stuck"; they are the user's pending choices.
 */
export function syncStatusText(s: SyncStatus): string {
  const n = (count: number, word: string) => `${count} ${word}`;
  const tail = `, plus ${n(s.pending, "pending")}, plus ${n(s.holds, "held")}`;
  if (s.mode === "local_only") return `Saved on this device${tail}`;
  return `Confirmed through ${s.confirmedThrough}${tail}`;
}
