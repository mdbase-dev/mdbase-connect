import type {
  CollectionOperation,
  EncryptedRelayOperationRequest,
  EncryptedRelayOperationResponse,
  JsonObject,
  MdbaseOperationRequest
} from "@mdbase-dev/connect-protocol";
import {
  OPERATION_TRANSPORT_PROTOCOL_VERSION,
  isConnectProblem,
  mutationOperationIdentifier
} from "@mdbase-dev/connect-protocol";
import {
  decryptRelayResponse,
  encryptRelayRequest,
  RelayCryptoError,
  type GrantKeyStore
} from "./crypto.js";
import {
  MdbaseConnectError,
  connectError,
  serverConnectError
} from "./errors.js";
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
  ConnectRequestOptions,
  PendingMutationSummary
} from "./operation-types.js";
import { ConnectionFileTransport } from "./connection-file-transport.js";
import { authorityProofHeaders } from "./authority-proof.js";
import { PendingMutationStore } from "./pending-mutation-store.js";
import {
  directFallbackStatus,
  encryptedOperationError,
  fetchOperationRequest,
  isMutation,
  localNetworkPermission,
  loopbackRequest,
  operationFingerprint,
  operationTransportError,
  sameAuthorization,
  throwIfCancelled,
  unknownMutationOutcome,
  withOperationDeadline
} from "./operation-helpers.js";
import {
  apiError,
  decodeJsonResponse,
  oauthErrorCode,
  parseStored,
} from "./runtime-utils.js";
import { readStoredToken } from "./stored-token.js";
import {
  type OperationRequestOptions, type ResolvedConnectTimeouts, requestOptionsWithinBudget,
  withCooperativeRequestBudget,
  withRequestBudget
} from "./request-budget.js";
import { sendAuthoritySyncRequest } from "./authority-sync-request.js";
import { freshEncryptedRequest } from "./fresh-encrypted-request.js";
import type {
  ConnectionTransportInternals,
  ConnectionTransportOptions
} from "./connection-transport-internals.js";
import {
  isExplicitConnectorBusyResponse,
  retryExplicitConnectorBusy
} from "./transient-retry.js";
import { probeLoopbackAccess, tokenSupportsDirectAccess } from "./direct-access.js";

export type {
  ConnectionTransportInternals,
  ConnectionTransportOptions
} from "./connection-transport-internals.js";

export class ConnectionTransport {
  private readonly serverUrl: string;
  private readonly storage: Storage;
  private readonly keyStore: GrantKeyStore;
  private readonly directAccessMode: "auto" | "disabled";
  private readonly loopbackUrl: string;
  private readonly collectionId: string;
  private readonly internals: ConnectionTransportInternals;
  private readonly onChange: () => void;
  private readonly timeouts: ResolvedConnectTimeouts;
  private readonly pendingMutationStore: PendingMutationStore;
  readonly files: ConnectionFileTransport;
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
    this.timeouts = options.timeouts;
    this.pendingMutationStore = new PendingMutationStore(
      this.storage,
      this.internals.pendingMutationKey(this.collectionId)
    );
    this.files = new ConnectionFileTransport({
      keyStore: this.keyStore,
      serverUrl: this.serverUrl,
      loopbackUrl: this.loopbackUrl,
      authorizedToken: (signal) => this.authorizedToken({ signal, timeoutMs: null }),
      refreshAuthorization: (signal) => this.refreshAuthorization(signal),
      shouldAttemptDirect: (token) => this.shouldAttemptDirect(token),
      onDirectAvailable: () => {
        this.markDirectAvailable();
        this.setRoute("direct");
      },
      onDirectUnavailable: () => this.markDirectUnavailable(),
      onRelayAvailable: () => this.setRoute("relay"),
      authorityProofHeaders: (token, method, url, body, credential) =>
        authorityProofHeaders(this.keyStore, token, method, url, body, credential)
    });
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

  notifyStorageChanged(): void { this.emitConnection(); }

  async checkDirectAccess(options: ConnectRequestOptions = {}): Promise<DirectAccessStatus> {
    return withRequestBudget(options, this.timeouts.watchStartMs, (budget) =>
      this.checkDirectAccessWithinBudget(budget.signal)
    );
  }

  private async checkDirectAccessWithinBudget(signal: AbortSignal): Promise<DirectAccessStatus> {
    const token = this.currentToken();
    if (!this.directEligible(token)) return this.setDirectStatus("disabled");
    const permission = await localNetworkPermission();
    if (permission === "denied") return this.setDirectStatus("denied");
    if ((permission === "prompt" || permission === null)
        && this.storage.getItem(this.internals.directPreferenceKey()) !== "enabled") {
      return this.setDirectStatus("permission_required");
    }
    return this.probeDirectAccess(signal);
  }

  /** Call from a user gesture to request browser permission for direct local access. */
  async requestDirectAccess(options: ConnectRequestOptions = {}): Promise<DirectAccessStatus> {
    return withRequestBudget(options, this.timeouts.watchStartMs, (budget) =>
      this.requestDirectAccessWithinBudget(budget.signal)
    );
  }

  private async requestDirectAccessWithinBudget(signal: AbortSignal): Promise<DirectAccessStatus> {
    const token = this.currentToken();
    if (!this.directCapable(token)) return this.setDirectStatus("disabled");
    this.storage.setItem(this.internals.directPreferenceKey(), "enabled");
    this.directRetryAt = 0;
    return this.probeDirectAccess(signal);
  }

  disableDirectAccess(): void {
    this.storage.setItem(this.internals.directPreferenceKey(), "disabled");
    this.setDirectStatus("disabled");
    this.setRoute("relay");
  }

  /** Return pending writes without exposing authority transport credentials. */
  pendingMutations(): readonly PendingMutationSummary[] {
    return this.storedPendingMutations().map((pending) => ({
      requestId: pending.requestId,
      operation: this.pendingMutationStore.identifier(pending),
      fingerprint: pending.inputFingerprint,
      status: "outcome_unknown",
      createdAt: new Date(pending.createdAt).toISOString()
    }));
  }

  pendingMutation(requestId: string): PendingMutationSummary | null {
    const pending = this.storedPendingMutation(requestId);
    return pending ? {
      requestId: pending.requestId,
      operation: this.pendingMutationStore.identifier(pending),
      fingerprint: pending.inputFingerprint,
      status: "outcome_unknown",
      createdAt: new Date(pending.createdAt).toISOString()
    } : null;
  }

  async recoverPendingMutation<Result>(
    requestId: string,
    options?: ConnectRequestOptions
  ): Promise<Result> {
    const pending = this.storedPendingMutation(requestId);
    if (!pending) {
      throw connectError(
        "no_pending_mutation",
        "There is no interrupted mutation to resume."
      );
    }
    return withCooperativeRequestBudget(options, this.timeouts.requestMs, (budget) =>
      this.performOperationWithinBudget<Result>(
        pending.operation,
        pending.request?.input ?? {},
        requestOptionsWithinBudget(options ?? {}, budget),
        pending
      )
    );
  }

  async performOperation<Result>(
    operation: CollectionOperation,
    input: unknown,
    options: ConnectRequestOptions = {}
  ): Promise<Result> {
    return withCooperativeRequestBudget(options, this.timeouts.requestMs, (budget) =>
      this.performOperationWithinBudget<Result>(operation, input, requestOptionsWithinBudget(options, budget))
    );
  }

  private async performOperationWithinBudget<Result>(
    operation: CollectionOperation,
    input: unknown,
    options: OperationRequestOptions,
    storedPending?: PendingMutation,
    freshReadRetried = false,
    connectorBusyRetries = 0,
    knownRejectedMutationRetry = false
  ): Promise<Result> {
    throwIfCancelled(options.signal);
    let token = this.currentToken();
    if (!token) throw connectError("not_authorized", "Connect this application before accessing a collection.");
    if (!token.operations.includes(operation)) {
      throw connectError("insufficient_access", `This connection does not allow ${operation}.`, {
        details: {
          required_operations: [operation],
          granted_operations: [...token.operations],
          missing_operations: [operation]
        }
      });
    }
    let tryDirect = await this.shouldAttemptDirect(token);
    if (!tryDirect) {
      token = await this.authorizedToken({ signal: options.signal, timeoutMs: null });
      if (!token) throw connectError("not_authorized", "Reconnect this application to continue.");
    }
    const pendingRequestId = storedPending?.requestId
      ?? (isMutation(operation, input) ? crypto.randomUUID() : undefined);
    let attempt: OperationAttempt;
    try {
      attempt = await this.sendOperation(token, operation, input, tryDirect, options,
        pendingRequestId, knownRejectedMutationRetry);
    } catch (error) {
      throw operationTransportError(
        error,
        options.signal,
        pendingRequestId !== undefined && this.storedPendingMutation(pendingRequestId) !== null
          ? pendingRequestId
          : undefined,
        token.authority ? "hosted_provider_unavailable" : "relay_unavailable"
      );
    }
    let response = attempt.response;
    const staleBinding = response.status === 409
      && (await decodeJsonResponse(
        response.clone(),
        "invalid_operation_response",
        "The collection authority returned an invalid operation response."
      ).catch(() => null))?.error?.code === "encryption_binding_stale";
    if ((response.status === 401 || staleBinding) && token.refreshToken) {
      if (attempt.pendingMutation
          && (attempt.directDeliveryUncertain
            || (attempt.encryptedRequest && attempt.resumingMutation))) {
        throw connectError(
          "operation_outcome_unknown",
          "The direct operation may have completed, but its encrypted grant changed before the response could be recovered. Refresh before making another change.",
          { operationOutcome: "unknown", details: { request_id: attempt.requestId } }
        );
      }
      if (attempt.pendingMutation) this.clearPendingMutation(attempt.requestId);
      token = await this.refreshAuthorization(options.signal);
      tryDirect = await this.shouldAttemptDirect(token);
      try {
        attempt = await this.sendOperation(token, operation, input, tryDirect, options,
          pendingRequestId, knownRejectedMutationRetry);
      } catch (error) {
        throw operationTransportError(
          error,
          options.signal,
          pendingRequestId !== undefined && this.storedPendingMutation(pendingRequestId) !== null
            ? pendingRequestId
            : undefined,
          token.authority ? "hosted_provider_unavailable" : "relay_unavailable"
        );
      }
      response = attempt.response;
    }
    const retryBusy = (error: unknown) => retryExplicitConnectorBusy<Result>({
      error,
      attempt,
      completedRetries: connectorBusyRetries,
      signal: options.signal,
      knownRejectedMutationRetry,
      clearPending: (requestId) => this.clearPendingMutation(requestId),
      retry: (pending, knownRejected) => this.performOperationWithinBudget<Result>(
        operation, input, options, pending, freshReadRetried, connectorBusyRetries + 1,
        knownRejected
      )
    });
    let body: any;
    try {
      body = await decodeJsonResponse(
        response,
        "invalid_operation_response",
        "The collection authority returned a response that is not valid JSON."
      );
    } catch (cause) {
      if (attempt.pendingMutation) throw unknownMutationOutcome(attempt.requestId, cause);
      throw connectError(
        "invalid_operation_response",
        "The collection authority returned a response that is not valid JSON.",
        { cause }
      );
    }
    if (!response.ok) {
      const error = apiError(body, "operation_failed", "Collection operation failed.", response.status);
      const recovery = await retryBusy(error);
      if (recovery.retried) return recovery.result;
      if (error.code === "fresh_request_required"
          && !attempt.pendingMutation
          && !freshReadRetried) {
        return this.performOperationWithinBudget<Result>(
          operation,
          input,
          options,
          undefined,
          true
        );
      }
      if (attempt.pendingMutation && error.outcomeUnknown) throw error;
      if (attempt.pendingMutation
          && (attempt.directDeliveryUncertain
            || (attempt.encryptedRequest && attempt.resumingMutation))) {
        throw unknownMutationOutcome(attempt.requestId, error);
      }
      if (attempt.pendingMutation && !attempt.directDeliveryUncertain) {
        this.clearPendingMutation(attempt.requestId);
      }
      if (error.code === "direct_operation_rejected" && error.status === 403) {
        this.invalidateRejectedAuthorization(token);
      }
      throw error;
    }
    if (attempt.encryptedRequest) {
      const encryptedResponse = body?.envelope as EncryptedRelayOperationResponse | undefined;
      const pendingCrypto = attempt.pendingMutationRecord;
      const responseEncryption = pendingCrypto?.encryption ?? token.encryption;
      const responseGrantId = pendingCrypto?.grantId ?? token.grantId;
      const responseApplicationId = pendingCrypto?.applicationId ?? token.clientId;
      const responseKeyHandle = pendingCrypto?.keyHandle ?? token.keyHandle;
      if (!encryptedResponse || !responseEncryption || !responseGrantId || !responseKeyHandle) {
        if (attempt.pendingMutation) throw unknownMutationOutcome(attempt.requestId,
          new Error("Encrypted operation response was missing its envelope.")
        );
        throw connectError(
          "invalid_encrypted_response",
          "The relay did not return an encrypted connector response."
        );
      }
      try {
        const decrypted = await decryptRelayResponse<Result>(
          this.keyStore,
          responseKeyHandle,
          {
            grantId: responseGrantId,
            applicationId: responseApplicationId,
            encryption: responseEncryption
          },
          attempt.encryptedRequest,
          encryptedResponse
        );
        if (!decrypted.ok
            && decrypted.problem.code === "fresh_request_required"
            && !attempt.pendingMutation
            && !freshReadRetried) {
          return this.performOperationWithinBudget<Result>(
            operation,
            input,
            options,
            undefined,
            true
          );
        }
        if (!decrypted.ok) {
          const error = encryptedOperationError(decrypted.problem);
          if (attempt.pendingMutation && !error.outcomeUnknown) this.clearPendingMutation(attempt.requestId);
          throw error;
        }
        if (attempt.pendingMutation) this.clearPendingMutation(attempt.requestId);
        return decrypted.result;
      } catch (error) {
        if (error instanceof MdbaseConnectError) throw error;
        if (error instanceof RelayCryptoError) {
          if (attempt.pendingMutation) throw unknownMutationOutcome(attempt.requestId, error);
          throw serverConnectError(error.code, error.message);
        }
        throw error;
      }
    }
    const expectedProtocol = attempt.pendingMutationRecord?.request?.protocol_version
      ?? OPERATION_TRANSPORT_PROTOCOL_VERSION;
    if (body?.protocol_version !== expectedProtocol
        || body?.request_id !== attempt.requestId) {
      if (attempt.pendingMutation) throw unknownMutationOutcome(attempt.requestId,
        new Error("Operation response protocol or request ID did not match.")
      );
      throw connectError(
        "invalid_operation_response",
        "The collection authority returned a response for a different protocol request."
      );
    }
    if (body.ok === false) {
      if (!isConnectProblem(body.problem)) {
        if (attempt.pendingMutation) throw unknownMutationOutcome(attempt.requestId,
          new Error("Operation rejection did not contain a canonical problem.")
        );
        throw connectError(
          "invalid_operation_response",
          "The collection authority returned an invalid operation problem."
        );
      }
      const error = new MdbaseConnectError(body.problem);
      const recovery = await retryBusy(error);
      if (recovery.retried) return recovery.result;
      if (attempt.pendingMutation && !error.outcomeUnknown) this.clearPendingMutation(attempt.requestId);
      throw error;
    }
    if (body.ok !== true || !("result" in body)) {
      if (attempt.pendingMutation) throw unknownMutationOutcome(attempt.requestId,
        new Error("Successful operation response did not contain a result.")
      );
      throw connectError(
        "invalid_operation_response",
        "The collection authority returned an incomplete operation response."
      );
    }
    if (attempt.pendingMutation) this.clearPendingMutation(attempt.requestId);
    return body.result as Result;
  }

  async performAuthoritySyncRequest<Result>(
    collectionId: string,
    replicaId: string,
    method: "GET" | "POST",
    path: string,
    input?: unknown,
    options: ConnectRequestOptions = {}
  ): Promise<Result> {
    return withCooperativeRequestBudget(options, this.timeouts.syncMs, async (budget) => {
      let token = await this.authorizedToken({ signal: budget.signal, timeoutMs: null });
      if (!token?.authority
          || token.collectionId !== collectionId
          || token.authority.replicaId !== replicaId) {
        throw connectError(
          "authority_authorization_changed",
          "Reconnect this collection authority before synchronizing."
        );
      }
      try {
        let response = await sendAuthoritySyncRequest(
          this.keyStore,
          token,
          method,
          path,
          input,
          budget.signal
        );
        if (response.status === 401 && token.refreshToken) {
          token = await this.refreshAuthorization(budget.signal);
          if (!token.authority
              || token.collectionId !== collectionId
              || token.authority.replicaId !== replicaId) {
            throw connectError(
              "authority_authorization_changed",
              "Reconnect this collection authority before synchronizing."
            );
          }
          response = await sendAuthoritySyncRequest(
            this.keyStore,
            token,
            method,
            path,
            input,
            budget.signal
          );
        }
        const body = await decodeJsonResponse(
          response,
          "invalid_operation_response",
          "The collection authority returned an invalid synchronization response."
        );
        if (!response.ok) {
          throw apiError(body, "sync_failed", "Collection synchronization failed.", response.status);
        }
        return body as Result;
      } catch (error) {
        const mutationRequestId = method === "POST" && path === "mutations"
          && input && typeof input === "object"
          && typeof (input as { mutation_id?: unknown }).mutation_id === "string"
          ? (input as { mutation_id: string }).mutation_id
          : undefined;
        throw operationTransportError(
          error,
          budget.signal,
          mutationRequestId,
          "hosted_provider_unavailable"
        );
      }
    });
  }

  private async sendOperation(
    token: StoredToken,
    operation: CollectionOperation,
    input: unknown,
    tryDirect: boolean,
    options: OperationRequestOptions = {},
    pendingRequestId?: string,
    knownRejectedMutationRetry = false
  ): Promise<OperationAttempt> {
    let body: unknown = input ?? {};
    let encryptedRequest: Awaited<ReturnType<typeof encryptRelayRequest>> | undefined;
    let pendingMutation = false;
    let resumingMutation = false;
    let requestId: string = pendingRequestId ?? crypto.randomUUID();
    let pending: PendingMutation | null = null;
    let inputFingerprint: string | undefined;
    if (pendingRequestId !== undefined) {
      pending = this.storedPendingMutation(pendingRequestId);
      inputFingerprint = pending?.inputFingerprint
        ?? await operationFingerprint(operation, input);
      if (pending) {
        if (pending.collectionId !== token.collectionId
            || pending.operation !== operation
            || pending.inputFingerprint !== inputFingerprint) {
          throw connectError(
            "pending_mutation_unresolved",
            "A previous write still has an unknown outcome. Retry that exact write before making another change."
          );
        }
        requestId = pending.requestId;
        resumingMutation = !knownRejectedMutationRetry;
      }
      pendingMutation = true;
    }
    const mutation = pending?.mutation ?? mutationOperationIdentifier(operation, input);
    if (pending?.envelope && (token.authority || !token.encryption)) {
      throw connectError(
        "pending_mutation_unresolved",
        "The pending write requires its encrypted relay authority. Reconnect that authority before recovery."
      );
    }
    if (pending?.request && token.encryption && !token.authority) {
      throw connectError(
        "pending_mutation_unresolved",
        "The pending write belongs to a different authority transport. Reconnect that authority before recovery."
      );
    }
    if (token.encryption && !token.authority) {
      if (!token.grantId || !token.keyHandle) {
        throw connectError("missing_grant_key", "Reconnect this application to restore encrypted access.");
      }
      try {
        if (pendingMutation) {
          if (pending) {
            if (!pending.envelope) {
              throw connectError(
                "pending_mutation_unresolved",
                "The pending write belongs to a different transport. Reconnect before retrying it."
              );
            }
            // Preserve the durable identity and ciphertext, but refresh the
            // unauthenticated scheduling deadline for this recovery attempt.
            encryptedRequest = withOperationDeadline(pending.envelope, options.deadlineUnixMs);
          } else {
            encryptedRequest = await encryptRelayRequest(
              this.keyStore,
              token.keyHandle,
              { grantId: token.grantId, applicationId: token.clientId, encryption: token.encryption },
              operation,
              input,
              requestId, options.deadlineUnixMs
            );
            this.pendingMutationStore.store({
              collectionId: token.collectionId,
              ...(token.grantId ? { grantId: token.grantId } : {}),
              keyId: token.encryption.key_id,
              keyHandle: token.keyHandle,
              applicationId: token.clientId,
              encryption: token.encryption,
              operation,
              mutation: mutation!,
              inputFingerprint: inputFingerprint!,
              requestId,
              envelope: encryptedRequest,
              createdAt: Date.now()
            });
          }
        } else {
          encryptedRequest = await encryptRelayRequest(
            this.keyStore,
            token.keyHandle,
            { grantId: token.grantId, applicationId: token.clientId, encryption: token.encryption },
            operation,
            input,
            undefined, options.deadlineUnixMs
          );
        }
      } catch (error) {
        if (error instanceof RelayCryptoError) throw serverConnectError(error.code, error.message);
        throw error;
      }
      requestId = encryptedRequest.request_id;
      body = encryptedRequest;
    } else {
      const request: MdbaseOperationRequest = pending?.request ?? {
          protocol_version: OPERATION_TRANSPORT_PROTOCOL_VERSION,
          request_id: requestId,
          input: body
        };
      body = request;
      if (pendingMutation && !pending) {
        this.pendingMutationStore.store({
          collectionId: token.collectionId,
          ...(token.grantId ? { grantId: token.grantId } : {}),
          operation,
          mutation: mutation!,
          inputFingerprint: inputFingerprint!,
          requestId,
          request,
          createdAt: Date.now()
        });
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
        if (
          !directFallbackStatus(response.status)
          || await isExplicitConnectorBusyResponse(response)
        ) {
          if (response.ok) {
            this.markDirectAvailable();
            this.setRoute("direct");
          }
          return {
            response,
            requestId,
            encryptedRequest,
            pendingMutation,
            ...(pendingMutation ? { pendingMutationRecord: pending ?? this.storedPendingMutation(requestId) ?? undefined } : {}),
            resumingMutation
          };
        }
        directDeliveryUncertain = response.status >= 500;
        this.markDirectUnavailable();
      } catch (error) {
        if (options.signal?.aborted) {
          if (pendingMutation) throw unknownMutationOutcome(requestId, error);
          throw error;
        }
        directDeliveryUncertain = true;
        if ((await localNetworkPermission()) === "denied") this.setDirectStatus("denied");
        else this.markDirectUnavailable();
      }
      let relayToken: StoredToken;
      try {
        relayToken = token.expiresAt > Date.now() + 30_000
          ? token
          : await this.refreshAuthorization(options.signal);
      } catch (error) {
        if (pendingMutation && (directDeliveryUncertain || resumingMutation)) throw unknownMutationOutcome(requestId, error);
        throw error;
      }
      let response: Response;
      if (!pendingMutation) {
        encryptedRequest = await freshEncryptedRequest(
          this.keyStore,
          relayToken,
          operation,
          input, options.deadlineUnixMs
        );
        requestId = encryptedRequest.request_id;
      }
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
        if (pendingMutation) throw unknownMutationOutcome(requestId, error);
        throw error;
      }
      if (response.ok) this.setRoute("relay");
      return {
        response,
        requestId,
        encryptedRequest,
        directDeliveryUncertain,
        pendingMutation,
        ...(pendingMutation ? { pendingMutationRecord: pending ?? this.storedPendingMutation(requestId) ?? undefined } : {}),
        resumingMutation
      };
    }
    const operationUrl = token.authority
      ? `${token.authority.operationsUrl}/${operation}`
      : `${this.serverUrl}/v1/authorities/${encodeURIComponent(token.collectionId)}/operations/${operation}`;
    const operationBody = JSON.stringify(body);
    const proof = token.authority
      ? await authorityProofHeaders(
          this.keyStore,
          token,
          "POST",
          operationUrl,
          operationBody,
          token.authority.accessToken
        )
      : {};
    let response: Response;
    try {
      response = await fetchOperationRequest(operationUrl,
        token.authority?.accessToken ?? token.accessToken, proof, operationBody, options.signal);
    } catch (error) {
      if (pendingMutation) throw unknownMutationOutcome(requestId, error);
      throw error;
    }
    if (response.ok) this.setRoute(token.authority ? "remote" : "relay");
    return {
      response,
      requestId,
      encryptedRequest,
      pendingMutation,
      ...(pendingMutation ? { pendingMutationRecord: pending ?? this.storedPendingMutation(requestId) ?? undefined } : {}),
      resumingMutation
    };
  }

  private directCapable(token: StoredToken | null): boolean {
    return tokenSupportsDirectAccess(token, this.directAccessMode);
  }

  hasResumableMutationTransport(): boolean { return this.currentToken() !== null; }

  private directEligible(token: StoredToken | null): token is StoredToken {
    return token !== null
      && this.directCapable(token)
      && this.storage.getItem(this.internals.directPreferenceKey()) !== "disabled";
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
        && this.storage.getItem(this.internals.directPreferenceKey()) !== "enabled") {
      this.setDirectStatus("permission_required");
      return false;
    }
    this.setDirectStatus("checking");
    return true;
  }

  private async probeDirectAccess(signal?: AbortSignal): Promise<DirectAccessStatus> {
    this.setDirectStatus("checking");
    if (await probeLoopbackAccess(
      this.loopbackUrl,
      OPERATION_TRANSPORT_PROTOCOL_VERSION,
      signal
    )) {
      this.markDirectAvailable();
      return "available";
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

  private emitConnection(): void { this.onChange(); }

  private invalidateRejectedAuthorization(rejected: StoredToken): void {
    const current = parseStored<StoredToken>(this.storage.getItem(
      this.internals.tokenKey(this.collectionId)
    ));
    if (!current || !sameAuthorization(current, rejected)) return;
    this.internals.removeToken(this.collectionId, current.keyHandle);
    this.currentRoute = "relay";
    this.directStatus = this.directAccessMode === "disabled" ? "disabled" : "unavailable";
    this.emitConnection();
  }

  currentToken(): StoredToken | null {
    return readStoredToken({
      stored: this.storage.getItem(this.internals.tokenKey(this.collectionId)),
      collectionId: this.collectionId,
      relayEncryption: this.internals.relayEncryption,
      invalidate: (keyHandle) => this.internals.removeToken(
        this.collectionId,
        keyHandle,
        "invalid_stored_grant"
      ),
      directCapable: (token) => this.directCapable(token)
    });
  }

  async authorizedToken(options: ConnectRequestOptions = {}): Promise<StoredToken | null> {
    const token = this.currentToken();
    if (!token) return null;
    if (token.expiresAt > Date.now() + 30_000) return token;
    if (!token.refreshToken || (token.refreshExpiresAt ?? 0) <= Date.now()) {
      if (this.directCapable(token)) {
        throw connectError(
          "relay_authorization_expired",
          "Direct access is still available on this computer, but using the relay requires reconnecting this application."
        );
      }
      this.internals.removeToken(this.collectionId, token.keyHandle);
      return null;
    }
    return this.refreshAuthorization(options.signal);
  }

  private refreshAuthorization(signal?: AbortSignal): Promise<StoredToken> {
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = this.performRefresh(signal).finally(() => {
      this.refreshPromise = null;
    });
    return this.refreshPromise;
  }

  private async performRefresh(signal?: AbortSignal): Promise<StoredToken> {
    const current = this.currentToken();
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
    const refreshUrl = `${this.serverUrl}/oauth/token`;
    const refreshBody = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: current.refreshToken,
      client_id: current.clientId
    }).toString();
    const proof = current.authority
      ? await authorityProofHeaders(
          this.keyStore,
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
      body: refreshBody,
      signal
    });
    const body = await decodeJsonResponse(
      response,
      "invalid_token_response",
      "The authorization service returned an invalid token response."
    );
    if (!response.ok) {
      const latest = this.currentToken();
      if (latest?.refreshToken && latest.refreshToken !== attemptedRefreshToken) {
        return latest;
      }
      if (!this.directCapable(current)) {
        this.internals.removeToken(this.collectionId, current.keyHandle);
      }
      if ((oauthErrorCode(body) ?? body?.error?.code) === "invalid_grant") {
        throw connectError(
          "authorization_expired",
          body?.error_description ?? body?.error?.message ?? "Reconnect this application to continue.",
          { status: response.status }
        );
      }
      throw apiError(body, "authorization_expired", "Reconnect this application to continue.", response.status);
    }
    return this.storeTokenResponse(body, current.clientId, current.keyHandle);
  }

  private storeTokenResponse(body: any, clientId: string, keyHandle?: string): StoredToken {
    if (body.collection_id !== this.collectionId) {
      throw connectError(
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

  private storedPendingMutations(): PendingMutation[] {
    return this.pendingMutationStore.list(this.currentToken()?.collectionId ?? null);
  }

  private storedPendingMutation(requestId: string): PendingMutation | null {
    return this.pendingMutationStore.find(
      this.currentToken()?.collectionId ?? null,
      requestId
    );
  }

  private clearPendingMutation(requestId: string): void {
    const pending = this.pendingMutationStore.take(requestId);
    const currentKeyHandle = this.currentToken()?.keyHandle;
    if (pending?.keyHandle && pending.keyHandle !== currentKeyHandle) {
      void this.keyStore.delete(pending.keyHandle).catch(() => undefined);
    }
  }
}
