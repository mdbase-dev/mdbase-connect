import type {
  CollectionOperation,
  EncryptedRelayOperationRequest
} from "@mdbase-dev/connect-protocol";
import {
  encryptRelayRequest,
  RelayCryptoError,
  type GrantKeyStore
} from "./crypto.js";
import { connectError, serverConnectError } from "./errors.js";
import type { StoredToken } from "./internal-types.js";

export async function freshEncryptedRequest(
  keyStore: GrantKeyStore,
  token: StoredToken,
  operation: CollectionOperation,
  input: unknown,
  deadlineUnixMs?: number
): Promise<EncryptedRelayOperationRequest> {
  if (!token.encryption || !token.grantId || !token.keyHandle) {
    throw connectError(
      "authorization_binding_incompatible",
      "The refreshed authorization no longer supports encrypted connector operations.",
      {
        details: {
          contract: "grant_encryption",
          required: [1],
          supported: token.encryption ? [token.encryption.protocol_version] : [],
          peer: "connector",
          operation
        }
      }
    );
  }
  try {
    return await encryptRelayRequest(
      keyStore,
      token.keyHandle,
      {
        grantId: token.grantId,
        applicationId: token.clientId,
        encryption: token.encryption
      },
      operation,
      input,
      undefined,
      deadlineUnixMs
    );
  } catch (error) {
    if (error instanceof RelayCryptoError) {
      throw serverConnectError(error.code, error.message);
    }
    throw error;
  }
}
