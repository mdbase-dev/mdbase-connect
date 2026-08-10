import type { GrantKeyStore } from "./crypto.js";
import type { StoredToken } from "./internal-types.js";
import type { ResolvedConnectTimeouts } from "./request-budget.js";

export interface ConnectionTransportInternals {
  readonly relayEncryption: "required" | "disabled";
  removeToken(
    collectionId: string,
    keyHandle?: string,
    reason?: "not_authorized" | "authorization_lost" | "invalid_stored_grant",
    discardPending?: boolean
  ): void;
  storeTokenResponse(body: any, clientId: string, keyHandle?: string): StoredToken;
  tokenKey(collectionId: string): string;
  pendingMutationKey(collectionId: string): string;
  directPreferenceKey(): string;
}

export interface ConnectionTransportOptions {
  serverUrl: string;
  storage: Storage;
  keyStore: GrantKeyStore;
  directAccessMode: "auto" | "disabled";
  loopbackUrl: string;
  collectionId: string;
  internals: ConnectionTransportInternals;
  onChange(): void;
  timeouts: ResolvedConnectTimeouts;
}
