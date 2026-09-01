import type { StoredToken } from "./internal-types.js";
import {
  isCanonicalGrantScope,
  parseGrantScope,
  parseStored,
  validFileCapability,
  validStoredAuthority,
  validStoredEncryption
} from "./runtime-utils.js";

interface ReadStoredTokenOptions {
  stored: string | null;
  collectionId: string;
  relayEncryption: "required" | "disabled";
  invalidate(
    keyHandle?: string,
    reason?: "invalid_stored_grant" | "legacy_scope_reauthorization_required"
  ): void;
  directCapable(token: StoredToken): boolean;
}

export function readStoredToken({
  stored,
  collectionId,
  relayEncryption,
  invalidate,
  directCapable
}: ReadStoredTokenOptions): StoredToken | null {
  const token = parseStored<StoredToken>(stored);
  const reject = (
    keyHandle?: unknown,
    reason: "invalid_stored_grant" | "legacy_scope_reauthorization_required" = "invalid_stored_grant"
  ): null => {
    invalidate(typeof keyHandle === "string" ? keyHandle : undefined, reason);
    return null;
  };
  if (!token) {
    if (stored) reject();
    return null;
  }
  if (
    token.version !== 1
    || typeof token.accessToken !== "string"
    || token.accessToken.length === 0
    || typeof token.clientId !== "string"
    || token.clientId.length === 0
    || token.collectionId !== collectionId
    || typeof token.collectionName !== "string"
    || token.collectionName.length === 0
    || !Array.isArray(token.operations)
    || token.operations.some((operation) => typeof operation !== "string")
    || typeof token.expiresAt !== "number"
    || !Number.isFinite(token.expiresAt)
    || (
      token.refreshToken !== undefined
      && (typeof token.refreshToken !== "string" || token.refreshToken.length === 0)
    )
    || (
      token.refreshExpiresAt !== undefined
      && (typeof token.refreshExpiresAt !== "number" || !Number.isFinite(token.refreshExpiresAt))
    )
  ) return reject(token.keyHandle);
  const scope = parseGrantScope(token.scope);
  if (!scope) return reject(token.keyHandle);
  if (!isCanonicalGrantScope(scope)) {
    return reject(token.keyHandle, "legacy_scope_reauthorization_required");
  }
  if (token.fileCapability && !validFileCapability(token.fileCapability)) {
    return reject(token.keyHandle);
  }
  if (token.authority && !validStoredAuthority(token.authority, token.collectionId)) {
    return reject(token.keyHandle);
  }
  if (relayEncryption === "required") {
    if (token.authority) {
      if (!token.keyHandle || !token.authority.proofPublicKey) {
        return reject(token.keyHandle);
      }
    } else if (
      !token.grantId
      || !token.keyHandle
      || !validStoredEncryption(token.encryption, token.collectionId)
    ) {
      return reject(token.keyHandle);
    }
  }
  if (token.expiresAt <= Date.now()
      && (!token.refreshToken || (token.refreshExpiresAt ?? 0) <= Date.now())) {
    // The cloud bearer and local grant proof have separate lifetimes. Keep an
    // encrypted local grant usable while the connector still recognizes it.
    if (directCapable(token)) return token;
    invalidate(token.keyHandle);
    return null;
  }
  return token;
}
