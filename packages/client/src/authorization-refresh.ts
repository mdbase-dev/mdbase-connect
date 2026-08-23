import { authorityProofHeaders } from "./authority-proof.js";
import type { GrantKeyStore } from "./crypto.js";
import { apiError, decodeJsonResponse, oauthErrorCode } from "./runtime-utils.js";
import { connectError } from "./errors.js";
import type { StoredToken } from "./internal-types.js";

interface AuthorizationRefreshOptions {
  current: StoredToken | null;
  serverUrl: string;
  keyStore: GrantKeyStore;
  signal?: AbortSignal;
  currentToken(): StoredToken | null;
  directCapable(token: StoredToken): boolean;
  removeToken(keyHandle?: string): void;
  storeTokenResponse(body: any, clientId: string, keyHandle?: string): StoredToken;
}

export async function performAuthorizationRefresh(
  options: AuthorizationRefreshOptions
): Promise<StoredToken> {
  const current = options.current;
  if (!current?.refreshToken) {
    throw connectError("not_authorized", "Reconnect this application to continue.");
  }
  if ((current.refreshExpiresAt ?? 0) <= Date.now()) {
    throw connectError(
      "relay_authorization_expired",
      "Direct access is still available on this computer, but using the relay requires reconnecting this application."
    );
  }
  const attemptedRefreshToken = current.refreshToken;
  const refreshUrl = `${options.serverUrl}/oauth/token`;
  const refreshBody = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: current.refreshToken,
    client_id: current.clientId
  }).toString();
  const proof = current.authority
    ? await authorityProofHeaders(
        options.keyStore,
        current,
        "POST",
        refreshUrl,
        refreshBody,
        current.refreshToken
      )
    : {};
  const response = await fetch(refreshUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...proof },
    body: refreshBody,
    signal: options.signal
  });
  const body = await decodeJsonResponse(
    response,
    "invalid_token_response",
    "The authorization service returned an invalid token response."
  );
  if (!response.ok) {
    const latest = options.currentToken();
    if (latest?.refreshToken && latest.refreshToken !== attemptedRefreshToken) return latest;
    if (!options.directCapable(current)) options.removeToken(current.keyHandle);
    if ((oauthErrorCode(body) ?? body?.error?.code) === "invalid_grant") {
      throw connectError(
        "authorization_expired",
        body?.error_description ?? body?.error?.message ?? "Reconnect this application to continue.",
        { status: response.status }
      );
    }
    throw apiError(body, "authorization_expired", "Reconnect this application to continue.", response.status);
  }
  return options.storeTokenResponse(body, current.clientId, current.keyHandle);
}
