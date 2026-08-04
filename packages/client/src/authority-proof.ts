import {
  RelayCryptoError,
  signAuthorityRequest,
  type GrantKeyStore
} from "./crypto.js";
import { connectError, serverConnectError } from "./errors.js";
import type { StoredToken } from "./internal-types.js";

export async function authorityProofHeaders(
  keyStore: GrantKeyStore,
  token: StoredToken,
  method: string,
  url: string,
  body: string | undefined,
  credential: string
): Promise<Record<string, string>> {
  if (!token.authority?.proofPublicKey) return {};
  if (!token.keyHandle) {
    throw connectError(
      "missing_grant_key",
      "Reconnect this application to restore remote authority request signing."
    );
  }
  try {
    const target = new URL(url);
    return await signAuthorityRequest(
      keyStore,
      token.keyHandle,
      token.authority.proofPublicKey,
      {
        method,
        target: `${target.pathname}${target.search}`,
        body,
        credential
      }
    );
  } catch (error) {
    if (error instanceof RelayCryptoError) {
      throw serverConnectError(error.code, error.message);
    }
    throw error;
  }
}
