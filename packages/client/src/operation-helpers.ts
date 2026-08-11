import {
  isMutatingOperation,
  mutationFingerprint,
  type CollectionOperation,
  type ConnectProblem,
  type EncryptedRelayOperationRequest
} from "@mdbase-dev/connect-protocol";
import { MdbaseConnectError, connectError, serverConnectError } from "./errors.js";
import type { StoredToken } from "./internal-types.js";
import type {
  DeleteInput,
  DeletePreflightResult,
  MutationEstimate,
  RenameInput,
  RenamePreflightResult
} from "./operation-types.js";

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
  return isMutatingOperation(operation, input);
}

export function withOperationDeadline(
  request: EncryptedRelayOperationRequest,
  deadlineUnixMs?: number
): EncryptedRelayOperationRequest {
  if (request.deadline_unix_ms === deadlineUnixMs) return request;
  const { deadline_unix_ms: _previousDeadline, ...identity } = request;
  return {
    ...identity,
    ...(deadlineUnixMs === undefined ? {} : { deadline_unix_ms: deadlineUnixMs })
  };
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
  throw connectError(
    "operation_cancelled",
    "The operation was cancelled before it changed the collection.",
    { operationOutcome: "not_sent", cause: signal.reason }
  );
}

export function operationTransportError(
  error: unknown,
  signal: AbortSignal | undefined,
  pendingRequestId: string | undefined,
  unavailableCode: "hosted_provider_unavailable" | "relay_unavailable"
): Error {
  // Problems raised before transport dispatch already describe the
  // authoritative outcome. Do not overwrite them merely because an older
  // pending mutation also exists in storage.
  if (error instanceof MdbaseConnectError) return error;
  if (signal?.aborted) {
    if (pendingRequestId) return unknownMutationOutcome(pendingRequestId, error);
    if (signal.reason instanceof MdbaseConnectError) return signal.reason;
    return connectError(
      "operation_cancelled",
      "The operation was cancelled before it changed the collection.",
      { operationOutcome: "not_sent", cause: error }
    );
  }
  if (pendingRequestId) {
    return unknownMutationOutcome(pendingRequestId, error);
  }
  if (error instanceof TypeError) {
    return connectError(
      unavailableCode,
      unavailableCode === "hosted_provider_unavailable"
        ? "The hosted collection provider is unavailable."
        : "The Connect relay is unavailable.",
      { cause: error }
    );
  }
  return error instanceof Error ? error : new Error(String(error));
}

export function encryptedOperationError(problem: ConnectProblem): MdbaseConnectError {
  return serverConnectError(
    problem.code === "unknown" ? problem.server_code : problem.code,
    problem.message,
    {
      details: problem.details,
      operationOutcome: problem.operation_outcome ?? "rejected",
      traceId: problem.trace_id
    }
  );
}

export function fetchOperationRequest(
  url: string,
  accessToken: string,
  proof: Record<string, string>,
  body: string,
  signal?: AbortSignal
): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
      ...proof
    },
    body,
    signal
  });
}

export function isCancellation(error: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true
    || (error instanceof MdbaseConnectError && error.code === "operation_cancelled");
}

export function assertRenamePreview(input: RenameInput, preview: RenamePreflightResult): void {
  if (preview.dryRun !== true || preview.wouldRename !== true
      || preview.from !== input.from || preview.to !== input.to) {
    throw connectError(
      "invalid_preflight",
      "The rename preview does not match this mutation. Run the preview again."
    );
  }
}

export function assertDeletePreview(input: DeleteInput, preview: DeletePreflightResult): void {
  if (preview.dryRun !== true || preview.wouldDelete !== true || preview.path !== input.path) {
    throw connectError(
      "invalid_preflight",
      "The delete preview does not match this mutation. Run the preview again."
    );
  }
}

export function renameEstimate(input: RenameInput, preview: RenamePreflightResult): MutationEstimate {
  if (input.updateRefs === false) {
    return { affectedRecords: 0, totalUnits: 1, warnings: 0 };
  }
  const references = preview.referencesAffected ?? [];
  return {
    affectedRecords: new Set(references.map((reference) => reference.path)).size,
    totalUnits: 1 + references.length,
    warnings: preview.warnings?.length ?? 0
  };
}

export function deleteEstimate(preview: DeletePreflightResult): MutationEstimate {
  return {
    affectedRecords: new Set((preview.brokenLinks ?? []).map((reference) => reference.path)).size,
    totalUnits: 1,
    warnings: 0
  };
}

export async function operationFingerprint(
  operation: CollectionOperation,
  input: unknown
): Promise<string> {
  return mutationFingerprint(operation, input ?? {});
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

export function unknownMutationOutcome(requestId: string, cause: unknown): MdbaseConnectError {
  return connectError(
    "operation_outcome_unknown",
    "The write may have completed, but mdbase could not recover its authoritative result. Retry the exact same write to recover safely.",
    { operationOutcome: "unknown", details: { request_id: requestId }, cause }
  );
}
