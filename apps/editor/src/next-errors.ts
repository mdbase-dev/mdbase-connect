import { MdbaseConnectError } from "@mdbase-dev/connect";
import { connectError } from "@mdbase-dev/connect/advanced";
import type { ErrorCode, MdbaseError } from "@mdbase-dev/sdk";

/**
 * Maps the mdbase-next SDK's 15 error codes (replica-client-api.md §9) onto the
 * editor's existing error and recovery UI, which is keyed on Connect problems.
 *
 * Type-only SDK import: the default Connect bundle never loads the SDK.
 */

export function isNextError(error: unknown): error is MdbaseError {
  return error instanceof Error && error.name === "MdbaseError" && typeof (error as MdbaseError).code === "string";
}

/** The waiting state for end-to-end collections, not a failure. */
export function isWaitingForDevice(error: unknown): boolean {
  return isNextError(error) && error.code === "unavailable" && error.reason === "no_device_online";
}

export const WAITING_FOR_DEVICE = "Waiting for one of your devices to come online. The collection opens as soon as one is reachable.";

const MESSAGES: Record<ErrorCode, string> = {
  invalid_request: "mdbase couldn’t accept this request. Check it and try again.",
  invalid_record: "This note doesn’t match its type.",
  not_found: "This note no longer exists.",
  conflict: "This note changed elsewhere. Review the latest version before saving again.",
  unauthenticated: "This collection needs authorization again. Choose the collection to continue.",
  forbidden: "This app isn’t allowed to do that in this collection. Authorize it again with the access it needs.",
  collection_invalid: "The collection’s configuration or types can’t be loaded. Repair them, then try again.",
  unavailable: "The collection can’t be reached right now. Changes stay pending and retry automatically.",
  rate_limited: "Too many requests. Try again in a moment.",
  quota_exceeded: "This collection is over its storage quota. Free up space so new changes can sync.",
  too_large: "This is larger than mdbase allows.",
  upgrade_required: "This version of the editor is out of date. Reload the page to update it.",
  outcome_unknown: "mdbase couldn’t confirm whether this change was saved. Review the note before trying again.",
  cancelled: "The operation was cancelled.",
  internal: "Something went wrong in mdbase. Try again; if it keeps happening, contact support."
};

const REASONS: Partial<Record<string, string>> = {
  "conflict/path_taken": "A note or file already exists at that path.",
  "conflict/duplicate_value": "Another note already uses that value.",
  "conflict/renamed": "This note was renamed elsewhere. Reopen it from the list.",
  "not_found/transfer_expired": "The upload expired. Start it again.",
  "invalid_request/digest_mismatch": "The file changed while it was uploading. Try again.",
  "invalid_request/size_mismatch": "The file changed while it was uploading. Try again.",
  "unavailable/no_device_online": WAITING_FOR_DEVICE
};

/** App text for an SDK error, keyed on `code` and `reason` (never the developer `message`). */
export function nextErrorMessage(error: MdbaseError): string {
  const specific = error.reason ? REASONS[`${error.code}/${error.reason}`] : undefined;
  if (specific) return specific;
  if (error.code === "invalid_record" && error.issues?.length) {
    return `${MESSAGES.invalid_record} ${error.issues.map((issue) => issue.message).join(" ")}`;
  }
  return MESSAGES[error.code] ?? MESSAGES.internal;
}

function diagnostics(error: MdbaseError): Array<Record<string, unknown>> {
  return (error.issues ?? [{ code: error.reason ?? error.code, severity: "error" as const, message: error.message }])
    .map((issue) => ({ code: issue.code, severity: issue.severity, message: issue.message }));
}

/**
 * The equivalent Connect problem, so the record session, recovery toasts and
 * reauthorization flows keep working. The SDK error stays as `cause`.
 */
export function toConnectError(error: MdbaseError, mutationId?: string): MdbaseConnectError {
  const message = nextErrorMessage(error);
  const cause = error;
  switch (error.code) {
    case "invalid_request":
      return connectError("invalid_request", message, { cause });
    case "invalid_record":
    case "too_large":
      return connectError("operation_invalid", message, { cause, details: { diagnostics: diagnostics(error) } });
    case "not_found":
      // The record session treats a missing record as deleted elsewhere.
      return connectError("file_not_found", message, { cause });
    case "conflict":
      return error.reason === "path_taken"
        ? connectError("path_occupied", message, { cause })
        : connectError("concurrent_modification", message, { cause });
    case "unauthenticated":
    case "forbidden":
      return connectError("not_authorized", message, { cause });
    case "collection_invalid":
      return connectError("collection_invalid", message, { cause, details: { diagnostics: diagnostics(error) } });
    case "unavailable":
      return error.reason === "no_device_online"
        ? connectError("connector_offline", message, { cause, details: {} })
        : connectError("temporarily_unavailable", message, { cause });
    case "rate_limited":
      return connectError("rate_limited", message, {
        cause, details: error.retryAfterMs === undefined ? {} : { retry_after_ms: error.retryAfterMs }
      });
    case "upgrade_required":
      return connectError("connector_upgrade_required", message, { cause });
    case "outcome_unknown":
      return mutationId
        ? connectError("operation_outcome_unknown", message, { cause, operationOutcome: "unknown", details: { request_id: mutationId } })
        : connectError("operation_failed", message, { cause, operationOutcome: "unknown" });
    case "cancelled":
      return connectError("operation_cancelled", message, { cause });
    case "quota_exceeded":
    case "internal":
    default:
      return connectError("operation_failed", message, { cause });
  }
}

/** Rethrow SDK errors as Connect errors; leave everything else alone. */
export function connectFailureFrom(error: unknown, mutationId?: string): unknown {
  return isNextError(error) ? toConnectError(error, mutationId) : error;
}

export function notAvailable(feature: string): MdbaseConnectError {
  return connectError("unsupported_operation", `${feature} isn’t available with the mdbase-next backend yet.`);
}
