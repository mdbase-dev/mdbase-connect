import type { StoredToken } from "./internal-types.js";
import { loopbackRequest } from "./operation-helpers.js";
import { decodeJsonResponse } from "./runtime-utils.js";

export function tokenSupportsDirectAccess(
  token: StoredToken | null,
  mode: "auto" | "disabled"
): boolean {
  if (!token || token.authority || !token.encryption || !token.grantId || !token.keyHandle) {
    return false;
  }
  if (mode === "disabled") return false;
  return typeof location === "undefined"
    || !token.applicationOrigin
    || token.applicationOrigin === location.origin;
}

export async function probeLoopbackAccess(
  loopbackUrl: string,
  expectedOperationProtocol: number,
  signal?: AbortSignal
): Promise<boolean> {
  try {
    const response = await fetch(`${loopbackUrl}/v1/ready`, loopbackRequest({
      method: "GET",
      cache: "no-store",
      signal
    }));
    const body = await decodeJsonResponse(
      response,
      "invalid_operation_response",
      "The connector returned an invalid readiness response."
    ).catch(() => null);
    return response.ok
      && body?.service === "mdbase-connect"
      && body?.loopback_protocol_version === 1
      && body?.operation_transport_protocol_version === expectedOperationProtocol;
  } catch {
    return false;
  }
}
