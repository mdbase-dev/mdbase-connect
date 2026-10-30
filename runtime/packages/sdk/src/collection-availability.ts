/**
 * Whether a collection can be opened right now, as the control plane reports it: for a
 * Private collection served by one of the account's devices (`/v1/next/apps/collections`
 * and `/v1/next/collections/:id/route`) and for a listed cloud copy
 * (`/v1/next/collections`, where an absent value means available). Advisory only: the serving replica decides
 * access. `opening` is SDK-side: a session is being established.
 */
import { mdbaseError, MdbaseError } from "./errors.js";

export const COLLECTION_UNAVAILABLE_REASONS = [
  "device_offline",
  "desktop_update_required",
  "old_connector_running",
  "approval_required",
  "sync_required",
  "no_device_registered",
  "access_removed",
  "collection_migrating",
  "collection_not_yet_migrated",
  "collection_deleted",
] as const;

export type CollectionUnavailableReason = (typeof COLLECTION_UNAVAILABLE_REASONS)[number];

export type CollectionAvailability =
  | { readonly state: "available" }
  | { readonly state: "opening" }
  | { readonly state: "unavailable"; readonly reason: CollectionUnavailableReason };

const REASONS: ReadonlySet<string> = new Set(COLLECTION_UNAVAILABLE_REASONS);

export function isCollectionUnavailableReason(value: unknown): value is CollectionUnavailableReason {
  return typeof value === "string" && REASONS.has(value);
}

/**
 * Parse a server `availability` object. Unknown states or reasons become
 * `unavailable/device_offline` rather than `available`: never open on a guess.
 * Returns `null` when the field is absent.
 */
export function parseCollectionAvailability(value: unknown): CollectionAvailability | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) return Object.freeze({ state: "unavailable", reason: "device_offline" });
  const v = value as { state?: unknown; reason?: unknown };
  if (v.state === "available") return Object.freeze({ state: "available" });
  if (v.state === "unavailable" && isCollectionUnavailableReason(v.reason)) return Object.freeze({ state: "unavailable", reason: v.reason });
  return Object.freeze({ state: "unavailable", reason: "device_offline" });
}

/**
 * The error that opening an unavailable collection fails with. `reason` is the
 * availability reason; `describeError` gives the copy. `sync_required` means the app
 * must be given access again and `access_removed` that the account left the
 * collection (both `forbidden`). Deletion is terminal (`forbidden`, no recovery).
 * Every other reason clears by itself or by
 * an action on the serving computer (`unavailable`, retried).
 */
export function collectionUnavailableError(reason: CollectionUnavailableReason): MdbaseError {
  const details = new Map([["availability", reason]]);
  if (reason === "collection_deleted") {
    return new MdbaseError({ code: "forbidden", message: "this collection was deleted", reason, recovery: "none", details });
  }
  if (reason === "access_removed") {
    return mdbaseError("forbidden", "this account no longer has access to this collection", { reason, details });
  }
  if (reason === "sync_required") {
    return mdbaseError("forbidden", "this collection must be set up again for this app", { reason, details });
  }
  return mdbaseError("unavailable", `this collection can't be opened now (${reason})`, { reason, details });
}
