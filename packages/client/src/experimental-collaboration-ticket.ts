import type { CollectionOperation } from "@mdbase-dev/connect-protocol";
import { authorityProofHeaders } from "./authority-proof.js";
import type { GrantKeyStore } from "./crypto.js";
import { MdbaseConnectError, connectError } from "./errors.js";
import { GrantKeyLeaseSet, retainCurrentGrantToken } from "./grant-key-leases.js";
import type {
  ExperimentalCollaborationMode,
  ExperimentalCollaborationTicketRequest,
  ExperimentalCollaborationTicketResult
} from "./hosted-collaboration-internal.js";
import type { StoredToken } from "./internal-types.js";
import { operationTransportError } from "./operation-helpers.js";
import { withCooperativeRequestBudget } from "./request-budget.js";
import { apiError, decodeJsonResponse } from "./runtime-utils.js";

export type {
  ExperimentalCollaborationTicketRequest,
  ExperimentalCollaborationTicketResult
} from "./hosted-collaboration-internal.js";

interface CollaborationTicketIssuer {
  collectionId: string;
  defaultTimeoutMs: number | null;
  keyStore: GrantKeyStore;
  currentToken(): StoredToken | null;
  authorizedToken(signal: AbortSignal): Promise<StoredToken | null>;
  refreshAuthorization(signal: AbortSignal): Promise<StoredToken>;
  grantKeyLeases(): GrantKeyLeaseSet;
}

export async function issueExperimentalCollaborationTicket(
  request: ExperimentalCollaborationTicketRequest,
  issuer: CollaborationTicketIssuer
): Promise<ExperimentalCollaborationTicketResult> {
  const path = request.path;
  const requestedMode = request.mode;
  const expectedEpoch = request.epoch;
  validateCollaborationTicketPath(path);
  if (requestedMode !== undefined
      && requestedMode !== "read_only"
      && requestedMode !== "read_write") {
    throw connectError("invalid_request", "The collaboration mode is invalid.");
  }
  if (expectedEpoch !== undefined
      && (!Number.isSafeInteger(expectedEpoch) || expectedEpoch < 1)) {
    throw connectError("invalid_request", "The collaboration epoch is invalid.");
  }
  return withCooperativeRequestBudget(request, issuer.defaultTimeoutMs, async (budget) => {
    const leases = issuer.grantKeyLeases();
    try {
      let token = await retainCurrentGrantToken(issuer.currentToken, leases, budget.signal);
      requireCollaborationTicketAuthorization(token, issuer.collectionId, requestedMode);
      await issuer.authorizedToken(budget.signal);
      token = await retainCurrentGrantToken(issuer.currentToken, leases, budget.signal);
      let response = await sendCollaborationTicketRequest(
        issuer,
        requireCollaborationTicketAuthorization(token, issuer.collectionId, requestedMode),
        path,
        expectedEpoch,
        budget.signal
      );
      if (response.response.status === 401 && token?.refreshToken) {
        await issuer.refreshAuthorization(budget.signal);
        token = await retainCurrentGrantToken(issuer.currentToken, leases, budget.signal);
        response = await sendCollaborationTicketRequest(
          issuer,
          requireCollaborationTicketAuthorization(token, issuer.collectionId, requestedMode),
          path,
          expectedEpoch,
          budget.signal
        );
      }
      const ticket = await decodeCollaborationTicketResponse(
        response.response,
        response.mode,
        response.providerUrl
      );
      if (expectedEpoch !== undefined && ticket.epoch !== expectedEpoch) {
        throw invalidResponse("The collaboration ticket belongs to a different room epoch.");
      }
      if (!sameCollaborationTicketAuthorization(
        issuer.currentToken(),
        response.authorizationToken
      )) {
        throw connectError(
          "authority_authorization_changed",
          "Reconnect this collection authority before starting collaboration."
        );
      }
      return ticket;
    } catch (error) {
      throw operationTransportError(
        error,
        budget.signal,
        undefined,
        "hosted_provider_unavailable"
      );
    } finally {
      leases.release();
    }
  });
}

async function sendCollaborationTicketRequest(
  issuer: CollaborationTicketIssuer,
  authorization: CollaborationTicketAuthorization,
  path: string,
  expectedEpoch: number | undefined,
  signal: AbortSignal
): Promise<{
  response: Response;
  mode: ExperimentalCollaborationMode;
  providerUrl: URL;
  authorizationToken: CollaborationTicketAuthorization["token"];
}> {
  const { token, ticketUrl, providerUrl, mode } = authorization;
  const body = JSON.stringify({
    path,
    profile: "markdown-body-yjs-v13",
    mode,
    ...(expectedEpoch === undefined ? {} : { epoch: expectedEpoch })
  });
  const proof = await authorityProofHeaders(
    issuer.keyStore,
    token,
    "POST",
    ticketUrl.href,
    body,
    token.authority.accessToken
  );
  if (!sameCollaborationTicketAuthorization(issuer.currentToken(), token)) {
    throw connectError(
      "authority_authorization_changed",
      "Reconnect this collection authority before starting collaboration."
    );
  }
  const response = await fetch(ticketUrl, {
    method: "POST",
    redirect: "error",
    headers: {
      authorization: `Bearer ${token.authority.accessToken}`,
      "content-type": "application/json",
      ...proof
    },
    body,
    signal
  });
  if (!sameCollaborationTicketAuthorization(issuer.currentToken(), token)) {
    throw connectError(
      "authority_authorization_changed",
      "Reconnect this collection authority before starting collaboration."
    );
  }
  return { response, mode, providerUrl, authorizationToken: token };
}

export interface CollaborationTicketAuthorization {
  token: StoredToken & { authority: NonNullable<StoredToken["authority"]> };
  ticketUrl: URL;
  providerUrl: URL;
  mode: ExperimentalCollaborationMode;
}

export function requireCollaborationTicketAuthorization(
  token: StoredToken | null,
  collectionId: string,
  requestedMode: ExperimentalCollaborationMode | undefined
): CollaborationTicketAuthorization {
  if (!token?.authority
      || token.collectionId !== collectionId
      || !token.keyHandle
      || !token.authority.proofPublicKey) {
    throw connectError(
      "authority_authorization_changed",
      "Hosted collection authorization is required for collaboration."
    );
  }
  const capability = token.collaborationCapability;
  if (capability?.contract_version !== 1
      || capability.profiles.length !== 1
      || capability.profiles[0] !== "markdown-body-yjs-v13"
      || token.scope.access !== "full_collection"
      || token.scope.contracts.length !== 0
      || !token.operations.includes("read")) {
    throw collaborationAccessError(token, "This authorization does not allow collaboration.");
  }
  const mode = requestedMode ?? capability.access;
  if (mode === "read_write"
      && (capability.access !== "read_write" || !token.operations.includes("update"))) {
    throw collaborationAccessError(token, "This authorization only allows read-only collaboration.");
  }
  let providerUrl: URL;
  try {
    providerUrl = new URL(token.authority.syncUrl);
  } catch {
    throw changedAuthority("The hosted collection authority is invalid.");
  }
  const expectedPath = `/v1/authorities/${collectionId}/sync`;
  if ((providerUrl.protocol !== "https:"
      && !(providerUrl.protocol === "http:" && isLoopbackHost(providerUrl.hostname)))
      || providerUrl.pathname !== expectedPath
      || providerUrl.username
      || providerUrl.password
      || providerUrl.search
      || providerUrl.hash) {
    throw changedAuthority("The hosted collection authority no longer matches this collection.");
  }
  const ticketUrl = new URL(providerUrl.href);
  ticketUrl.pathname = `${expectedPath.slice(0, -"sync".length)}collaboration/tickets`;
  return {
    token: token as StoredToken & { authority: NonNullable<StoredToken["authority"]> },
    ticketUrl,
    providerUrl,
    mode
  };
}

export function validateCollaborationTicketPath(path: unknown): asserts path is string {
  if (typeof path !== "string"
      || path.length === 0
      || path.includes("\r")
      || path.includes("\0")
      || new TextEncoder().encode(path).byteLength > 1_024) {
    throw connectError(
      "invalid_request",
      "The collaboration path must be nonempty, at most 1024 UTF-8 bytes, and contain no CR or NUL characters."
    );
  }
}

export function sameCollaborationTicketAuthorization(
  current: StoredToken | null,
  expected: StoredToken
): current is StoredToken & { authority: NonNullable<StoredToken["authority"]> } {
  return current !== null
    && current.collectionId === expected.collectionId
    && current.clientId === expected.clientId
    && current.grantId === expected.grantId
    && current.keyHandle === expected.keyHandle
    && current.accessToken === expected.accessToken
    && current.expiresAt === expected.expiresAt
    && JSON.stringify(current.operations) === JSON.stringify(expected.operations)
    && JSON.stringify(current.scope) === JSON.stringify(expected.scope)
    && current.authority?.replicaId === expected.authority?.replicaId
    && current.authority?.accessToken === expected.authority?.accessToken
    && current.authority?.syncUrl === expected.authority?.syncUrl
    && current.authority?.proofPublicKey === expected.authority?.proofPublicKey
    && JSON.stringify(current.collaborationCapability)
      === JSON.stringify(expected.collaborationCapability);
}

export async function decodeCollaborationTicketResponse(
  response: Response,
  requestedMode: ExperimentalCollaborationMode,
  providerUrl: URL
): Promise<ExperimentalCollaborationTicketResult> {
  const body = await decodeJsonResponse(
    response,
    "invalid_operation_response",
    "The collection authority returned an invalid collaboration ticket response."
  );
  if (response.status !== 201) {
    throw apiError(body, "operation_failed", "Collaboration ticket issuance failed.", response.status);
  }
  if (!response.headers.get("cache-control")?.split(",")
    .some((directive) => directive.trim().toLowerCase() === "no-store")) {
    throw invalidResponse("The collaboration ticket response was not marked no-store.");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw invalidResponse();
  const value = body as Record<string, unknown>;
  const fields = ["epoch", "expires_at", "mode", "profile", "ticket", "websocket_endpoint"];
  if (Object.keys(value).sort().join("\n") !== fields.join("\n")
      || typeof value.ticket !== "string"
      || value.ticket.length === 0
      || value.ticket.length > 8_192
      || /[\r\n\0]/.test(value.ticket)
      || typeof value.expires_at !== "string"
      || value.expires_at.length > 64
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u.test(value.expires_at)
      || !Number.isFinite(Date.parse(value.expires_at))
      || Date.parse(value.expires_at) <= Date.now()
      || value.profile !== "markdown-body-yjs-v13"
      || value.mode !== requestedMode
      || !Number.isSafeInteger(value.epoch)
      || (value.epoch as number) < 1
      || typeof value.websocket_endpoint !== "string"
      || value.websocket_endpoint.length === 0
      || value.websocket_endpoint.length > 2_048
      || /[\r\n\0]/.test(value.websocket_endpoint)) {
    throw invalidResponse();
  }
  let endpoint: URL;
  try {
    endpoint = new URL(value.websocket_endpoint as string, providerUrl);
  } catch {
    throw invalidResponse();
  }
  if ((endpoint.protocol !== "http:" && endpoint.protocol !== "https:")
      || endpoint.origin !== providerUrl.origin
      || endpoint.pathname !== "/v1/collaboration"
      || endpoint.username
      || endpoint.password
      || endpoint.search
      || endpoint.hash) {
    throw invalidResponse();
  }
  endpoint.protocol = endpoint.protocol === "https:" ? "wss:" : "ws:";
  return {
    ticket: value.ticket as string,
    webSocketUrl: endpoint.href,
    expiresAt: value.expires_at as string,
    profile: "markdown-body-yjs-v13",
    mode: requestedMode,
    epoch: value.epoch as number
  };
}

function collaborationAccessError(token: StoredToken, message: string): MdbaseConnectError {
  const required: CollectionOperation[] = token.collaborationCapability?.access === "read_only"
    ? ["read"]
    : ["read", "update"];
  return connectError("insufficient_access", message, {
    details: {
      required_operations: required,
      granted_operations: [...token.operations],
      missing_operations: required.filter((operation) => !token.operations.includes(operation))
    }
  });
}

function changedAuthority(message: string): MdbaseConnectError {
  return connectError("authority_authorization_changed", message);
}

function invalidResponse(
  message = "The collection authority returned an invalid collaboration ticket response."
): MdbaseConnectError {
  return connectError("invalid_operation_response", message);
}

function isLoopbackHost(hostname: string): boolean {
  return ["localhost", "127.0.0.1", "[::1]", "::1"].includes(hostname);
}
