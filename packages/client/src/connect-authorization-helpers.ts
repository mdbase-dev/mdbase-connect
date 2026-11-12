import {
  APPLICATION_AUTHORIZATION_V2_ISSUANCE_CAPABILITY,
  normalizeApplicationManifest,
  type MdbaseApplicationManifest
} from "@mdbase-dev/connect-protocol";
import { MdbaseConnectError, connectError } from "./errors.js";
import type { Application } from "./internal-types.js";
import { canonicalJson } from "./operation-helpers.js";

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

/**
 * The registered application, bound to the manifest this client sent. Connect
 * assigns the application ID; the declaration, and so the authorization ceiling
 * signed from it, stays the bundled manifest. A registration that digests any
 * other declaration is refused.
 */
export async function registeredApplication(
  manifest: MdbaseApplicationManifest,
  registered: unknown
): Promise<Application> {
  const declaration = normalizeApplicationManifest(manifest);
  const digest = new Uint8Array(await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalJson(declaration))
  ));
  const application = registered as Partial<Application> | null | undefined;
  if (
    typeof application?.id !== "string"
    || application.id.length === 0
    || application.family_identity !== `bundle:${declaration.id}`
    || application.manifest_digest !== Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")
  ) {
    throw connectError(
      "invalid_operation_response",
      "Connect registered a different application declaration than this application sent."
    );
  }
  return {
    ...application as Application,
    distribution: declaration.distribution === "portable" ? "portable" : "web",
    requirements: declaration.requirements as Application["requirements"],
    provisions: declaration.provisions as Application["provisions"],
    notifications: declaration.notifications
  };
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
