import type {
  CollectionOperation,
  EncryptedRelayOperationRequest,
  EncryptedRelayOperationResponse,
  JsonObject,
  MdbaseOperationRequest
} from "@mdbase-dev/connect-protocol";
import {
  CONTROL_PROTOCOL_VERSION,
  ENCRYPTED_RELAY_PROTOCOL_VERSION
} from "@mdbase-dev/connect-protocol";
import {
  decryptRelayResponse,
  encryptRelayRequest,
  RelayCryptoError,
  signAuthorityRequest,
  type GrantKeyStore
} from "./crypto.js";
import { MdbaseConnectError } from "./errors.js";
import type {
  OperationAttempt,
  PendingMutation,
  StoredToken
} from "./internal-types.js";
import type {
  DirectAccessStatus,
  MdbaseConnectionRoute
} from "./connection-types.js";
import type {
  OperationRequestOptions,
  PendingMutationSummary
} from "./operation-types.js";
import {
  directFallbackStatus,
  isMutation,
  localNetworkPermission,
  loopbackRequest,
  operationFingerprint,
  operationTransportError,
  sameAuthorization,
  throwIfCancelled,
  uncertainDirectMutation
} from "./operation-helpers.js";
import {
  apiError,
  parseGrantScope,
  parseStored,
  validStoredAuthority,
  validStoredEncryption
} from "./runtime-utils.js";

export interface ConnectionTransportInternals {
  readonly relayEncryption: "required" | "disabled";
  removeToken(
    collectionId: string,
    keyHandle?: string,
    reason?: "not_authorized" | "authorization_lost" | "invalid_stored_grant"
  ): void;
  storeTokenResponse(body: any, clientId: string, keyHandle?: string): StoredToken;
  tokenKey(collectionId: string): string;
  notificationKey(collectionId: string, transport?: "web_push" | "fcm"): string;
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
}

export class ConnectionTransport {
  private readonly serverUrl: string;
  private readonly storage: Storage;
  private readonly keyStore: GrantKeyStore;
  private readonly directAccessMode: "auto" | "disabled";
  private readonly loopbackUrl: string;
  private readonly collectionId: string;
  private readonly internals: ConnectionTransportInternals;
  private readonly onChange: () => void;
  private refreshPromise: Promise<StoredToken> | null = null;
  private directStatus: DirectAccessStatus;
  private currentRoute: MdbaseConnectionRoute = "relay";
  private directFailures = 0;
  private directRetryAt = 0;

  constructor(options: ConnectionTransportOptions) {
    this.serverUrl = options.serverUrl;
    this.storage = options.storage;
    this.keyStore = options.keyStore;
    this.directAccessMode = options.directAccessMode;
    this.loopbackUrl = options.loopbackUrl;
    this.collectionId = options.collectionId;
    this.internals = options.internals;
    this.onChange = options.onChange;
    this.directStatus = this.directAccessMode === "disabled"
      ? "disabled"
      : "unavailable";
  }

  get directAccess(): DirectAccessStatus {
    return this.currentToken()?.authority ? "disabled" : this.directStatus;
  }

  get route(): MdbaseConnectionRoute {
    return this.currentToken()?.authority ? "remote" : this.currentRoute;
  }

  notifyStorageChanged(): void {
    this.emitConnection();
  }

  async checkDirectAccess(): Promise<DirectAccessStatus> {
    const token = this.currentToken();
    if (!this.directEligible(token)) return this.setDirectStatus("disabled");
    const permission = await localNetworkPermission();
    if (permission === "denied") return this.setDirectStatus("denied");
    if ((permission === "prompt" || permission === null)
        && this.storage.getItem(this.directPreferenceKey()) !== "enabled") {
      return this.setDirectStatus("permission_required");
    }
    return this.probeDirectAccess();
  }

  /** Call from a user gesture to request browser permission for direct local access. */
  async requestDirectAccess(): Promise<DirectAccessStatus> {
    const token = this.currentToken();
    if (!this.directCapable(token)) return this.setDirectStatus("disabled");
    this.storage.setItem(this.directPreferenceKey(), "enabled");
    this.directRetryAt = 0;
    return this.probeDirectAccess();
  }

  disableDirectAccess(): void {
    this.storage.setItem(this.directPreferenceKey(), "disabled");
    this.setDirectStatus("disabled");
    this.setRoute("relay");
  }

  /**
   * Return one offline-replication transport regardless of whether the
   * authority is remote, directly connected, or relay connected.
   * Authority credentials and routing stay private inside the SDK.
   */

  pendingMutation(): PendingMutationSummary | null {
    const pending = parseStored<PendingMutation>(this.storage.getItem(this.pendingMutationKey()));
    const token = this.currentToken();
    if (!pending || !token
        || pending.collectionId !== token.collectionId
        || pending.grantId !== token.grantId
        || pending.keyId !== token.encryption?.key_id) return null;
    return { operation: pending.operation, createdAt: pending.createdAt, resumable: true };
  }

  async resumePendingMutation<Result>(
    input: unknown,
    options?: OperationRequestOptions
  ): Promise<Result> {
    const pending = this.pendingMutation();
    if (!pending) {
      throw new MdbaseConnectError(
        "no_pending_mutation",
        "There is no interrupted mutation to resume.",
        { recovery: "none" }
      );
    }
    return this.performOperation<Result>(pending.operation, input, options);
  }

  async performOperation<Result>(
    operation: CollectionOperation,
    input: unknown,
    options: OperationRequestOptions = {}
  ): Promise<Result> {
    throwIfCancelled(options.signal);
    let token = this.currentToken();
    if (!token) throw new MdbaseConnectError("not_authorized", "Connect this application before accessing a collection.");
    if (!token.operations.includes(operation)) {
      throw new MdbaseConnectError("insufficient_access", `This connection does not allow ${operation}.`, {
        requiresAuthorization: true,
        recovery: "reauthorize",
        details: {
          requiredOperations: [operation],
          grantedOperations: [...token.operations],
          missingOperations: [operation]
        }
      });
    }
    let tryDirect = await this.shouldAttemptDirect(token);
    if (!tryDirect) {
      token = await this.authorizedToken();
      if (!token) throw new MdbaseConnectError("not_authorized", "Reconnect this application to continue.");
    }
    let attempt: OperationAttempt;
    try {
      attempt = await this.sendOperation(token, operation, input, tryDirect, options);
    } catch (error) {
      throw operationTransportError(error, options.signal, isMutation(operation, input) && this.pendingMutation() !== null);
    }
    let response = attempt.response;
    const staleBinding = response.status === 409
      && (await response.clone().json().catch(() => null))?.error?.code === "encryption_binding_stale";
    if ((response.status === 401 || staleBinding) && token.refreshToken) {
      if (attempt.pendingMutation
          && (attempt.directDeliveryUncertain
            || (attempt.encryptedRequest && attempt.resumingMutation))) {
        throw new MdbaseConnectError(
          "direct_outcome_unknown",
          "The direct operation may have completed, but its encrypted grant changed before the response could be recovered. Refresh before making another change."
        );
      }
      if (attempt.pendingMutation) this.clearPendingMutation();
      token = await this.refreshAuthorization();
      tryDirect = await this.shouldAttemptDirect(token);
      try {
        attempt = await this.sendOperation(token, operation, input, tryDirect, options);
      } catch (error) {
        throw operationTransportError(error, options.signal, isMutation(operation, input) && this.pendingMutation() !== null);
      }
      response = attempt.response;
    }
    const body = await response.json();
    if (!response.ok) {
      const error = apiError(body, "operation_failed", "Collection operation failed.", response.status);
      if (attempt.pendingMutation
          && (attempt.directDeliveryUncertain
            || (attempt.encryptedRequest && attempt.resumingMutation))) {
        throw uncertainDirectMutation(error);
      }
      if (attempt.pendingMutation && !attempt.directDeliveryUncertain) {
        this.clearPendingMutation();
      }
      if (error.code === "direct_operation_rejected" && error.status === 403) {
        this.invalidateRejectedAuthorization(token);
      }
      throw error;
    }
    if (attempt.encryptedRequest) {
      const encryptedResponse = body?.envelope as EncryptedRelayOperationResponse | undefined;
      if (!encryptedResponse || !token.encryption || !token.grantId || !token.keyHandle) {
        throw new MdbaseConnectError(
          "invalid_encrypted_response",
          "The relay did not return an encrypted connector response."
        );
      }
      try {
        const decrypted = await decryptRelayResponse<Result>(
          this.keyStore,
          token.keyHandle,
          { grantId: token.grantId, applicationId: token.clientId, encryption: token.encryption },
          attempt.encryptedRequest,
          encryptedResponse
        );
        if (attempt.pendingMutation) this.clearPendingMutation();
        if (!decrypted.ok) throw new MdbaseConnectError(decrypted.error.code, decrypted.error.message);
        return decrypted.result;
      } catch (error) {
        if (error instanceof MdbaseConnectError) throw error;
        if (error instanceof RelayCryptoError) throw new MdbaseConnectError(error.code, error.message);
        throw error;
      }
    }
    if (body?.protocol_version !== 1 || body?.request_id !== attempt.requestId) {
      throw new MdbaseConnectError(
        "invalid_operation_response",
        "The collection authority returned a response for a different protocol request."
      );
    }
    if (attempt.pendingMutation) this.clearPendingMutation();
    return body.result as Result;
  }

  async performAuthoritySyncRequest<Result>(
    collectionId: string,
    replicaId: string,
    method: "GET" | "POST",
    path: string,
    input?: unknown
  ): Promise<Result> {
    let token = await this.authorizedToken();
    if (!token?.authority
        || token.collectionId !== collectionId
        || token.authority.replicaId !== replicaId) {
      throw new MdbaseConnectError(
        "authority_authorization_changed",
        "Reconnect this collection authority before synchronizing."
      );
    }
    let response = await this.sendAuthoritySyncRequest(token, method, path, input);
    if (response.status === 401 && token.refreshToken) {
      token = await this.refreshAuthorization();
      if (!token.authority
          || token.collectionId !== collectionId
          || token.authority.replicaId !== replicaId) {
        throw new MdbaseConnectError(
          "authority_authorization_changed",
          "Reconnect this collection authority before synchronizing."
        );
      }
      response = await this.sendAuthoritySyncRequest(token, method, path, input);
    }
    const body = await response.json();
    if (!response.ok) throw apiError(body, "sync_failed", "Collection synchronization failed.", response.status);
    return body as Result;
  }

  private async sendAuthoritySyncRequest(
    token: StoredToken,
    method: "GET" | "POST",
    path: string,
    input?: unknown
  ): Promise<Response> {
    if (!token.authority) {
      throw new MdbaseConnectError("not_remote_authority", "This authorization has no remote authority endpoint.");
    }
    const url = `${token.authority.syncUrl}/${path}`;
    const body = input === undefined ? undefined : JSON.stringify(input);
    const proof = await this.authorityProofHeaders(token, method, url, body, token.authority.accessToken);
    return fetch(
      url,
      {
        method,
        headers: {
          authorization: `Bearer ${token.authority.accessToken}`,
          ...(input === undefined ? {} : { "content-type": "application/json" }),
          ...proof
        },
        ...(body === undefined ? {} : { body })
      }
    );
  }

  private async sendOperation(
    token: StoredToken,
    operation: CollectionOperation,
    input: unknown,
    tryDirect: boolean,
    options: OperationRequestOptions = {}
  ): Promise<OperationAttempt> {
    let body: unknown = input ?? {};
    let encryptedRequest: Awaited<ReturnType<typeof encryptRelayRequest>> | undefined;
    let pendingMutation = false;
    let resumingMutation = false;
    let requestId: string = crypto.randomUUID();
    let pending: PendingMutation | null = null;
    let inputFingerprint: string | undefined;
    if (isMutation(operation, input)) {
      inputFingerprint = await operationFingerprint(operation, input);
      pending = parseStored<PendingMutation>(
        this.storage.getItem(this.pendingMutationKey())
      );
      if (pending) {
        if (pending.collectionId !== token.collectionId
            || pending.grantId !== token.grantId
            || pending.keyId !== token.encryption?.key_id
            || pending.operation !== operation
            || pending.inputFingerprint !== inputFingerprint) {
          throw new MdbaseConnectError(
            "pending_mutation_unresolved",
            "A previous write still has an unknown outcome. Retry that exact write before making another change."
          );
        }
        requestId = pending.requestId;
        resumingMutation = true;
      }
      pendingMutation = true;
    }
    if (token.encryption && !token.authority) {
      if (!token.grantId || !token.keyHandle) {
        throw new MdbaseConnectError("missing_grant_key", "Reconnect this application to restore encrypted access.");
      }
      try {
        if (pendingMutation) {
          if (pending) {
            if (!pending.envelope) {
              throw new MdbaseConnectError(
                "pending_mutation_unresolved",
                "The pending write belongs to a different transport. Reconnect before retrying it."
              );
            }
            encryptedRequest = pending.envelope;
          } else {
            encryptedRequest = await encryptRelayRequest(
              this.keyStore,
              token.keyHandle,
              { grantId: token.grantId, applicationId: token.clientId, encryption: token.encryption },
              operation,
              input,
              requestId
            );
            this.storage.setItem(this.pendingMutationKey(), JSON.stringify({
              collectionId: token.collectionId,
              ...(token.grantId ? { grantId: token.grantId } : {}),
              keyId: token.encryption.key_id,
              operation,
              inputFingerprint: inputFingerprint!,
              requestId,
              envelope: encryptedRequest,
              createdAt: Date.now()
            } satisfies PendingMutation));
          }
        } else {
          encryptedRequest = await encryptRelayRequest(
            this.keyStore,
            token.keyHandle,
            { grantId: token.grantId, applicationId: token.clientId, encryption: token.encryption },
            operation,
            input
          );
        }
      } catch (error) {
        if (error instanceof RelayCryptoError) throw new MdbaseConnectError(error.code, error.message);
        throw error;
      }
      body = encryptedRequest;
    } else {
      const request: MdbaseOperationRequest = {
        protocol_version: 1,
        request_id: requestId,
        input: body
      };
      body = request;
      if (pendingMutation && !pending) {
        this.storage.setItem(this.pendingMutationKey(), JSON.stringify({
          collectionId: token.collectionId,
          ...(token.grantId ? { grantId: token.grantId } : {}),
          operation,
          inputFingerprint: inputFingerprint!,
          requestId,
          createdAt: Date.now()
        } satisfies PendingMutation));
      }
    }
    if (tryDirect && encryptedRequest && !token.authority) {
      let directDeliveryUncertain = false;
      try {
        const response = await fetch(`${this.loopbackUrl}/v1/operations`, loopbackRequest({
          method: "POST",
          headers: { "content-type": "application/mdbase-connect+json" },
          body: JSON.stringify(encryptedRequest),
          signal: options.signal
        }));
        if (!directFallbackStatus(response.status)) {
          if (response.ok) {
            this.markDirectAvailable();
            this.setRoute("direct");
          }
          return {
            response,
            requestId,
            encryptedRequest,
            pendingMutation,
            resumingMutation
          };
        }
        directDeliveryUncertain = response.status >= 500;
        this.markDirectUnavailable();
      } catch (error) {
        if (options.signal?.aborted) throw error;
        directDeliveryUncertain = true;
        if ((await localNetworkPermission()) === "denied") this.setDirectStatus("denied");
        else this.markDirectUnavailable();
      }
      let relayToken: StoredToken;
      try {
        relayToken = token.expiresAt > Date.now() + 30_000
          ? token
          : await this.refreshAuthorization();
      } catch (error) {
        if (pendingMutation && (directDeliveryUncertain || resumingMutation)) throw uncertainDirectMutation(error);
        throw error;
      }
      let response: Response;
      try {
        response = await fetch(
          `${this.serverUrl}/v1/authorities/${encodeURIComponent(relayToken.collectionId)}/operations/${operation}`,
          {
          method: "POST",
          headers: {
            authorization: `Bearer ${relayToken.accessToken}`,
            "content-type": "application/json"
          },
          body: JSON.stringify(encryptedRequest),
          signal: options.signal
          }
        );
      } catch (error) {
        if (pendingMutation && (directDeliveryUncertain || resumingMutation)) throw uncertainDirectMutation(error);
        throw error;
      }
      if (response.ok) this.setRoute("relay");
      return {
        response,
        requestId,
        encryptedRequest,
        directDeliveryUncertain,
        pendingMutation,
        resumingMutation
      };
    }
    const operationUrl = token.authority
      ? `${token.authority.operationsUrl}/${operation}`
      : `${this.serverUrl}/v1/authorities/${encodeURIComponent(token.collectionId)}/operations/${operation}`;
    const operationBody = JSON.stringify(body);
    const proof = token.authority
      ? await this.authorityProofHeaders(
          token,
          "POST",
          operationUrl,
          operationBody,
          token.authority.accessToken
        )
      : {};
    const response = await fetch(operationUrl, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token.authority?.accessToken ?? token.accessToken}`,
          "content-type": "application/json",
          ...proof
        },
        body: operationBody,
        signal: options.signal
      });
    if (response.ok) this.setRoute(token.authority ? "remote" : "relay");
    return { response, requestId, encryptedRequest, pendingMutation, resumingMutation };
  }

  private directCapable(token: StoredToken | null): boolean {
    if (!token || token.authority || !token.encryption || !token.grantId || !token.keyHandle) return false;
    if (this.directAccessMode === "disabled") return false;
    if (typeof location !== "undefined"
        && token.applicationOrigin
        && token.applicationOrigin !== location.origin) return false;
    return true;
  }

  hasResumableMutationTransport(): boolean {
    const token = this.currentToken();
    return Boolean(token);
  }

  private directEligible(token: StoredToken | null): token is StoredToken {
    return token !== null
      && this.directCapable(token)
      && this.storage.getItem(this.directPreferenceKey()) !== "disabled";
  }

  private async shouldAttemptDirect(token: StoredToken): Promise<boolean> {
    if (!this.directEligible(token)) return false;
    if (this.directStatus === "available") return true;
    if (this.directStatus === "unavailable" && Date.now() < this.directRetryAt) return false;
    const permission = await localNetworkPermission();
    if (permission === "denied") {
      this.setDirectStatus("denied");
      return false;
    }
    if ((permission === "prompt" || permission === null)
        && this.storage.getItem(this.directPreferenceKey()) !== "enabled") {
      this.setDirectStatus("permission_required");
      return false;
    }
    this.setDirectStatus("checking");
    return true;
  }

  private async probeDirectAccess(): Promise<DirectAccessStatus> {
    this.setDirectStatus("checking");
    try {
      const response = await fetch(`${this.loopbackUrl}/v1/ready`, loopbackRequest({
        method: "GET",
        cache: "no-store"
      }));
      const body = await response.json().catch(() => null);
      if (response.ok
          && body?.service === "mdbase-connect"
          && body?.loopback_protocol_version === 1
          && body?.encrypted_protocol_version === 1) {
        this.markDirectAvailable();
        return "available";
      }
    } catch {
      // Permission denial, unsupported mixed content, and an absent connector all reject fetch.
    }
    if ((await localNetworkPermission()) === "denied") return this.setDirectStatus("denied");
    this.markDirectUnavailable();
    return "unavailable";
  }

  private markDirectAvailable(): void {
    this.directFailures = 0;
    this.directRetryAt = 0;
    this.setDirectStatus("available");
  }

  private markDirectUnavailable(): void {
    this.directFailures += 1;
    this.directRetryAt = Date.now() + Math.min(60_000, 1_000 * 2 ** (this.directFailures - 1));
    this.setDirectStatus("unavailable");
  }

  private setDirectStatus(status: DirectAccessStatus): DirectAccessStatus {
    if (this.directStatus !== status) {
      this.directStatus = status;
      this.emitConnection();
    }
    return status;
  }

  private setRoute(route: MdbaseConnectionRoute): void {
    if (this.currentRoute !== route) {
      this.currentRoute = route;
      this.emitConnection();
    }
  }

  private emitConnection(): void {
    this.onChange();
  }

  private invalidateRejectedAuthorization(rejected: StoredToken): void {
    const current = parseStored<StoredToken>(this.storage.getItem(this.tokenKey()));
    if (!current || !sameAuthorization(current, rejected)) return;
    this.internals.removeToken(this.collectionId, current.keyHandle);
    this.currentRoute = "relay";
    this.directStatus = this.directAccessMode === "disabled" ? "disabled" : "unavailable";
    this.emitConnection();
  }

  currentToken(): StoredToken | null {
    const stored = this.storage.getItem(this.tokenKey());
    const token = parseStored<StoredToken>(stored);
    const invalidate = (keyHandle?: unknown): null => {
      this.internals.removeToken(
        this.collectionId,
        typeof keyHandle === "string" ? keyHandle : undefined,
        "invalid_stored_grant"
      );
      return null;
    };
    if (!token) {
      if (stored) invalidate();
      return null;
    }
    if (
      token.version !== 1
      || typeof token.accessToken !== "string"
      || token.accessToken.length === 0
      || typeof token.clientId !== "string"
      || token.clientId.length === 0
      || token.collectionId !== this.collectionId
      || typeof token.collectionName !== "string"
      || token.collectionName.length === 0
      || !Array.isArray(token.operations)
      || token.operations.some((operation) => typeof operation !== "string")
      || typeof token.expiresAt !== "number"
      || !Number.isFinite(token.expiresAt)
      || (
        token.refreshToken !== undefined
        && (
          typeof token.refreshToken !== "string"
          || token.refreshToken.length === 0
        )
      )
      || (
        token.refreshExpiresAt !== undefined
        && (
          typeof token.refreshExpiresAt !== "number"
          || !Number.isFinite(token.refreshExpiresAt)
        )
      )
    ) return invalidate(token.keyHandle);
    if (!parseGrantScope(token.scope)) {
      return invalidate(token.keyHandle);
    }
    if (
      token.authority
      && !validStoredAuthority(token.authority, token.collectionId)
    ) {
      return invalidate(token.keyHandle);
    }
    if (this.internals.relayEncryption === "required") {
      if (token.authority) {
        if (!token.keyHandle || !token.authority.proofPublicKey) {
          return invalidate(token.keyHandle);
        }
      } else {
        if (
          !token.grantId
          || !token.keyHandle
          || !validStoredEncryption(token.encryption, token.collectionId)
        ) {
          return invalidate(token.keyHandle);
        }
      }
    }
    if (token.expiresAt <= Date.now()
        && (!token.refreshToken || (token.refreshExpiresAt ?? 0) <= Date.now())) {
      // The cloud bearer and the local grant proof have separate lifetimes. Keep an
      // encrypted local grant usable while the connector still recognizes it; relay
      // use will require reauthorization, and revocation remains enforced locally.
      if (this.directCapable(token)) return token;
      this.internals.removeToken(this.collectionId, token.keyHandle);
      return null;
    }
    return token;
  }

  async authorizedToken(): Promise<StoredToken | null> {
    const token = this.currentToken();
    if (!token) return null;
    if (token.expiresAt > Date.now() + 30_000) return token;
    if (!token.refreshToken || (token.refreshExpiresAt ?? 0) <= Date.now()) {
      if (this.directCapable(token)) {
        throw new MdbaseConnectError(
          "relay_authorization_expired",
          "Direct access is still available on this computer, but using the relay requires reconnecting this application."
        );
      }
      this.internals.removeToken(this.collectionId, token.keyHandle);
      return null;
    }
    return this.refreshAuthorization();
  }

  private refreshAuthorization(): Promise<StoredToken> {
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = this.performRefresh().finally(() => {
      this.refreshPromise = null;
    });
    return this.refreshPromise;
  }

  private async performRefresh(): Promise<StoredToken> {
    const current = this.currentToken();
    if (!current?.refreshToken) {
      throw new MdbaseConnectError("not_authorized", "Reconnect this application to continue.");
    }
    if ((current.refreshExpiresAt ?? 0) <= Date.now()) {
      throw new MdbaseConnectError(
        "relay_authorization_expired",
        "Direct access is still available on this computer, but using the relay requires reconnecting this application."
      );
    }
    const attemptedRefreshToken = current.refreshToken;
    const refreshUrl = `${this.serverUrl}/oauth/token`;
    const refreshBody = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: current.refreshToken,
      client_id: current.clientId
    }).toString();
    const proof = current.authority
      ? await this.authorityProofHeaders(
          current,
          "POST",
          refreshUrl,
          refreshBody,
          current.refreshToken
        )
      : {};
    const response = await fetch(refreshUrl, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        ...proof
      },
      body: refreshBody
    });
    const body = await response.json();
    if (!response.ok) {
      const latest = this.currentToken();
      if (latest?.refreshToken && latest.refreshToken !== attemptedRefreshToken) {
        return latest;
      }
      if (!this.directCapable(current)) {
        this.internals.removeToken(this.collectionId, current.keyHandle);
      }
      throw apiError(body, "authorization_expired", "Reconnect this application to continue.", response.status);
    }
    return this.storeTokenResponse(body, current.clientId, current.keyHandle);
  }

  private async authorityProofHeaders(
    token: StoredToken,
    method: string,
    url: string,
    body: string | undefined,
    credential: string
  ): Promise<Record<string, string>> {
    if (!token.authority?.proofPublicKey) return {};
    if (!token.keyHandle) {
      throw new MdbaseConnectError(
        "missing_grant_key",
        "Reconnect this application to restore remote authority request signing."
      );
    }
    try {
      const target = new URL(url);
      return await signAuthorityRequest(
        this.keyStore,
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
        throw new MdbaseConnectError(error.code, error.message);
      }
      throw error;
    }
  }

  private storeTokenResponse(body: any, clientId: string, keyHandle?: string): StoredToken {
    if (body.collection_id !== this.collectionId) {
      throw new MdbaseConnectError(
        "collection_mismatch",
        "The refreshed authorization belongs to a different collection."
      );
    }
    const token = this.internals.storeTokenResponse(body, clientId, keyHandle);
    this.currentRoute = token.authority ? "remote" : "relay";
    this.directStatus = token.authority || this.directAccessMode === "disabled"
      ? "disabled"
      : "unavailable";
    this.emitConnection();
    return token;
  }

  private tokenKey() {
    return this.internals.tokenKey(this.collectionId);
  }
  private notificationKey(transport: "web_push" | "fcm" = "web_push") {
    return this.internals.notificationKey(this.collectionId, transport);
  }
  private pendingMutationKey() {
    return this.internals.pendingMutationKey(this.collectionId);
  }
  private clearPendingMutation(): void {
    this.storage.removeItem(this.pendingMutationKey());
  }
  private directPreferenceKey() {
    return this.internals.directPreferenceKey();
  }
}
