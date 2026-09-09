import { APPLICATION_AUTHORIZATION_V2_ISSUANCE_CAPABILITY } from "@mdbase-dev/connect-protocol";
import { MdbaseConnectError, connectError } from "./errors.js";

export async function assertFreshV2AuthorizationSupport(
  serverUrl: string,
  signal?: AbortSignal
): Promise<void> {
  const response = await fetch(`${serverUrl}/health`, { signal, cache: "no-store" });
  const health = await response.json().catch(() => null) as { capabilities?: unknown } | null;
  if (!response.ok || !Array.isArray(health?.capabilities)
      || !health.capabilities.every((value) => typeof value === "string")
      || !health.capabilities.includes(APPLICATION_AUTHORIZATION_V2_ISSUANCE_CAPABILITY)) {
    throw connectError("capability_contract_incompatible", "This server does not support new version-2 application authorizations.", {
      details: { contract: "fresh_application_authorization", required: [2], supported: [], peer: "server" }
    });
  }
}

export function declarationIdFromFamilyIdentity(familyIdentity: string): string {
  const prefix = "bundle:";
  if (!familyIdentity.startsWith(prefix) || familyIdentity.length === prefix.length) {
    throw new Error("The registered application has no valid declaration identity.");
  }
  return familyIdentity.slice(prefix.length);
}

export function authorizationAbort(
  signal: AbortSignal,
  message: string,
  cause?: unknown
): MdbaseConnectError {
  if (signal.reason instanceof MdbaseConnectError) return signal.reason;
  return connectError("authorization_cancelled", message, { cause });
}
