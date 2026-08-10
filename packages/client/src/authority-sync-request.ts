import { authorityProofHeaders } from "./authority-proof.js";
import type { GrantKeyStore } from "./crypto.js";
import { connectError } from "./errors.js";
import type { StoredToken } from "./internal-types.js";

export async function sendAuthoritySyncRequest(
  keyStore: GrantKeyStore,
  token: StoredToken,
  method: "GET" | "POST",
  path: string,
  input: unknown,
  signal: AbortSignal
): Promise<Response> {
  if (!token.authority) {
    throw connectError("not_remote_authority", "This authorization has no remote authority endpoint.");
  }
  const url = `${token.authority.syncUrl}/${path}`;
  const body = input === undefined ? undefined : JSON.stringify(input);
  const proof = await authorityProofHeaders(
    keyStore,
    token,
    method,
    url,
    body,
    token.authority.accessToken
  );
  return fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${token.authority.accessToken}`,
      ...(input === undefined ? {} : { "content-type": "application/json" }),
      ...proof
    },
    ...(body === undefined ? {} : { body }),
    signal
  });
}
