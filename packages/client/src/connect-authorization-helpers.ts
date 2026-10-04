import { APPLICATION_AUTHORIZATION_PROTOCOL_VERSION, APPLICATION_AUTHORIZATION_V2_ISSUANCE_CAPABILITY } from "@mdbase-dev/connect-protocol";
import { MdbaseConnectError, connectError } from "./errors.js";
import { applicationInstallationId, type ApplicationIdentity } from "./application-identity.js";
import { randomBase64Url } from "./base64.js";
import type { GrantKeyRecord } from "./crypto.js";
import type { Application } from "./internal-types.js";

/** Shared v5 prefix in the original web/device field order. No pipeline duplication. */
export async function authorizationBindingBase(
  application: Application, installation: ApplicationIdentity, grant: GrantKeyRecord,
  authorizationId: string, flow: "authorization_code" | "device_code", issuedAt: Date
) {
  return {
    protocol_version: APPLICATION_AUTHORIZATION_PROTOCOL_VERSION,
    authorization_id: authorizationId,
    application_id: application.id,
    application_declaration_id: declarationIdFromFamilyIdentity(application.family_identity),
    application_manifest_digest: application.manifest_digest,
    application_installation_id: await applicationInstallationId(installation),
    installation_signing_public_key: installation.signingPublicKey,
    grant_agreement_public_key: grant.agreementPublicKey,
    grant_signing_public_key: grant.signingPublicKey,
    flow,
    authorization_nonce: randomBase64Url(32),
    issued_at: issuedAt.toISOString(),
    expires_at: new Date(issuedAt.getTime() + 10 * 60 * 1_000).toISOString()
  };
}

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
