import { MdbaseConnectError, connectError } from "./errors.js";

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
