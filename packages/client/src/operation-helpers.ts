import type { CollectionOperation } from "@mdbase/connect-protocol";
import { MdbaseConnectError } from "./errors.js";
import type { StoredToken } from "./internal-types.js";
import type {
  DeleteInput,
  DeletePreflightResult,
  MutationEstimate,
  RenameInput,
  RenamePreflightResult
} from "./operation-types.js";
import { bytesToBase64Url } from "./base64.js";

export type LoopbackRequestInit = RequestInit & {
  targetAddressSpace?: "loopback";
};

export function loopbackRequest(init: RequestInit): LoopbackRequestInit {
  return { ...init, credentials: "omit", targetAddressSpace: "loopback" };
}

export async function localNetworkPermission(): Promise<PermissionState | null> {
  if (typeof navigator === "undefined" || !navigator.permissions?.query) return null;
  try {
    const status = await navigator.permissions.query({
      name: "local-network-access" as PermissionName
    });
    return status.state;
  } catch {
    return null;
  }
}

export function directFallbackStatus(status: number): boolean {
  return status === 404 || status === 405 || status === 426 || status >= 500;
}

export function isMutation(operation: CollectionOperation, input?: unknown): boolean {
  if (input && typeof input === "object" && !Array.isArray(input)
      && (input as Record<string, unknown>).dry_run === true) return false;
  return (operation === "sync"
      && input !== null
      && typeof input === "object"
      && !Array.isArray(input)
      && (input as Record<string, unknown>).action === "mutate")
    || operation === "create"
    || operation === "update"
    || operation === "delete"
    || operation === "rename"
    || operation === "create_type"
    || operation === "update_type"
    || operation === "install_type_pack"
    || operation === "put_timer"
    || operation === "cancel_timer"
    || operation === "reconcile_timers";
}

export function uniqueOperations(operations: CollectionOperation[]): CollectionOperation[] {
  return [...new Set(operations)];
}

export function sameAuthorization(left: StoredToken, right: StoredToken): boolean {
  if (left.grantId || right.grantId) {
    return left.grantId === right.grantId
      && left.keyHandle === right.keyHandle
      && left.encryption?.key_id === right.encryption?.key_id;
  }
  return left.accessToken === right.accessToken;
}

export function throwIfCancelled(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw new MdbaseConnectError(
    "operation_cancelled",
    "The operation was cancelled before it changed the collection.",
    { recovery: "none", cause: signal.reason }
  );
}

export function operationTransportError(
  error: unknown,
  signal: AbortSignal | undefined,
  outcomeUnknown: boolean
): Error {
  if (signal?.aborted) {
    return new MdbaseConnectError(
      "operation_cancelled",
      outcomeUnknown
        ? "Waiting was cancelled after the mutation was sent. Resume the pending mutation to recover its authoritative result."
        : "The operation was cancelled before it changed the collection.",
      {
        outcomeUnknown,
        recovery: outcomeUnknown ? "resolve_outcome" : "none",
        cause: error
      }
    );
  }
  if (outcomeUnknown) {
    if (error instanceof MdbaseConnectError && error.outcomeUnknown) return error;
    return uncertainDirectMutation(error);
  }
  return error instanceof Error ? error : new Error(String(error));
}

export function isCancellation(error: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true
    || (error instanceof MdbaseConnectError && error.code === "operation_cancelled");
}

export function assertRenamePreview(input: RenameInput, preview: RenamePreflightResult): void {
  if (preview.dry_run !== true || preview.would_rename !== true
      || preview.from !== input.from || preview.to !== input.to) {
    throw new MdbaseConnectError(
      "invalid_preflight",
      "The rename preview does not match this mutation. Run the preview again.",
      { recovery: "fix_request" }
    );
  }
}

export function assertDeletePreview(input: DeleteInput, preview: DeletePreflightResult): void {
  if (preview.dry_run !== true || preview.would_delete !== true || preview.path !== input.path) {
    throw new MdbaseConnectError(
      "invalid_preflight",
      "The delete preview does not match this mutation. Run the preview again.",
      { recovery: "fix_request" }
    );
  }
}

export function renameEstimate(input: RenameInput, preview: RenamePreflightResult): MutationEstimate {
  if (input.update_refs === false) {
    return { affectedRecords: 0, totalUnits: 1, warnings: 0 };
  }
  const references = preview.references_affected ?? [];
  return {
    affectedRecords: new Set(references.map((reference) => reference.path)).size,
    totalUnits: 1 + references.length,
    warnings: preview.warnings?.length ?? 0
  };
}

export function deleteEstimate(preview: DeletePreflightResult): MutationEstimate {
  return {
    affectedRecords: new Set((preview.broken_links ?? []).map((reference) => reference.path)).size,
    totalUnits: 1,
    warnings: 0
  };
}

export async function operationFingerprint(
  operation: CollectionOperation,
  input: unknown
): Promise<string> {
  const encoded = new TextEncoder().encode(`${operation}\0${canonicalJson(input ?? {})}`);
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  return bytesToBase64Url(new Uint8Array(digest));
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

export function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => sortJson(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([key, item]) => [key, sortJson(item)])
    );
  }
  return value;
}

export function uncertainDirectMutation(cause: unknown): MdbaseConnectError {
  return new MdbaseConnectError(
    "direct_outcome_unknown",
    "The direct write may have completed, and mdbase could not recover its receipt through the relay. Retry the exact same write to recover safely.",
    { cause }
  );
}
