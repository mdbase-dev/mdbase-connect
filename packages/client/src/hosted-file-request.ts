import { connectError } from "./errors.js";
import type { StoredToken } from "./internal-types.js";
import { apiError, decodeJsonResponse } from "./runtime-utils.js";

type ProofHeaders = (
  token: StoredToken,
  method: "GET" | "POST" | "DELETE",
  url: string,
  body: string | undefined,
  credential: string
) => Promise<Record<string, string>>;

export async function sendHostedFileRequest(
  token: StoredToken,
  method: "GET" | "POST" | "DELETE",
  path: string,
  input: unknown,
  signal: AbortSignal | undefined,
  proofHeaders: ProofHeaders
): Promise<Response> {
  if (!token.authority) {
    throw connectError(
      "not_remote_authority",
      "This authorization has no remote authority endpoint."
    );
  }
  const suffix = path === "" || path.startsWith("?") ? path : `/${path}`;
  const url = `${token.authority.filesUrl}${suffix}`;
  const body = input === undefined ? undefined : JSON.stringify(input);
  const proof = await proofHeaders(
    token,
    method,
    url,
    body,
    token.authority.accessToken
  );
  return fetch(url, {
    method,
    redirect: "error",
    headers: {
      authorization: `Bearer ${token.authority.accessToken}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...proof
    },
    ...(body === undefined ? {} : { body }),
    ...(signal ? { signal } : {})
  });
}

export async function performHostedFileRequest<Result>(
  token: StoredToken,
  method: "GET" | "POST" | "DELETE",
  path: string,
  input: unknown,
  signal: AbortSignal | undefined,
  refresh: () => Promise<StoredToken>,
  proofHeaders: ProofHeaders
): Promise<Result> {
  let active = token;
  let response = await sendHostedFileRequest(
    active, method, path, input, signal, proofHeaders
  );
  if (response.status === 401 && active.refreshToken) {
    active = await refresh();
    if (!active.authority || !active.fileCapability) {
      throw connectError(
        "authority_authorization_changed",
        "Reconnect this collection before accessing its files."
      );
    }
    response = await sendHostedFileRequest(
      active, method, path, input, signal, proofHeaders
    );
  }
  const body = await decodeJsonResponse(
    response,
    "invalid_operation_response",
    "The hosted authority returned an invalid file response."
  );
  if (!response.ok) {
    throw apiError(
      body,
      "operation_failed",
      "Collection file request failed.",
      response.status
    );
  }
  return body as Result;
}

export async function performHostedFilePartRequest(
  token: StoredToken,
  path: string,
  expectedLength: number,
  signal: AbortSignal | undefined,
  refresh: () => Promise<StoredToken>,
  proofHeaders: ProofHeaders
): Promise<ReadableStream<Uint8Array>> {
  let active = token;
  let response = await sendHostedFileRequest(
    active, "GET", path, undefined, signal, proofHeaders
  );
  if (response.status === 401 && active.refreshToken) {
    active = await refresh();
    if (!active.authority || !active.fileCapability) {
      throw connectError(
        "authority_authorization_changed",
        "Reconnect this collection before accessing its files."
      );
    }
    response = await sendHostedFileRequest(
      active, "GET", path, undefined, signal, proofHeaders
    );
  }
  if (!response.ok) {
    const body = await decodeJsonResponse(
      response,
      "invalid_operation_response",
      "The hosted authority returned an invalid file range error response."
    );
    throw apiError(
      body,
      "operation_failed",
      "Collection file range request failed.",
      response.status
    );
  }
  const contentLength = response.headers.get("content-length");
  if (contentLength === null || !/^(0|[1-9][0-9]*)$/u.test(contentLength)
      || Number(contentLength) !== expectedLength) {
    await response.body?.cancel().catch(() => undefined);
    throw connectError(
      "invalid_operation_response",
      "The hosted file response declared an unexpected byte length."
    );
  }
  if (!response.body) {
    throw connectError(
      "invalid_operation_response",
      "The hosted file response did not contain a byte stream."
    );
  }
  return response.body;
}
