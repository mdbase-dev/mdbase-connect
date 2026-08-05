import type {
  CollectionOperation,
  GrantScope,
  JsonObject,
  MdbaseAppManifest
} from "@mdbase-dev/connect-protocol";
import {
  APPLICATION_AUTHORIZATION_PROTOCOL_VERSION,
  authorizationContractRequirements,
  DEFAULT_LOOPBACK_PORT,
  GRANT_ENCRYPTION_PROTOCOL_VERSION,
  RELAY_ENCRYPTION_SUITE
} from "@mdbase-dev/connect-protocol";
import { abortableDelay } from "./async.js";
import type { MdbaseDeviceAuthorization } from "./authorization-types.js";
import { randomBase64Url } from "./base64.js";
import {
  ApplicationIdentityStoreError,
  IndexedDbApplicationIdentityStore,
  MemoryApplicationIdentityStore,
  applicationIdentity,
  applicationInstallationId,
  signApplicationAuthorization,
  type ApplicationIdentity,
  type ApplicationIdentityStore
} from "./application-identity.js";
import {
  MdbaseConnection,
  type MdbaseAuthorizationOutcome,
  type MdbaseAuthorizationResult,
  type MdbaseAuthorizeOptions,
  type MdbaseConnectEnvironment
} from "./connection.js";
import type { MdbaseConnectOptions } from "./connect-options.js";
import type { MdbaseConnectionInfo } from "./connection-types.js";
import {
  IndexedDbGrantKeyStore,
  MemoryGrantKeyStore,
  type GrantKeyStore
} from "./crypto.js";
import { MdbaseConnectError, connectError, serverConnectError } from "./errors.js";
import {
  DEFAULT_OPERATIONS,
  type Application,
  type StoredAuthorization,
  type StoredConnectionIndex,
  type StoredToken
} from "./internal-types.js";
import { uniqueOperations } from "./operation-helpers.js";
import type { ConnectRequestOptions } from "./operation-types.js";
import {
  resolveConnectTimeouts,
  type ResolvedConnectTimeouts,
  withRequestBudget
} from "./request-budget.js";
import type { MdbaseUnavailableReason } from "./session.js";
import {
  MemoryStorage,
  apiError,
  applicationStorageOrigin,
  canonicalLoopbackUrl,
  collectionIdFromTokenKey,
  connectFetch,
  createPkce,
  defaultManifestSource,
  defaultRedirectUri,
  defaultStorage,
  decodeJsonResponse,
  isOpaquePortableManifest,
  manifestStorageFingerprint,
  oauthErrorCode,
  parseDeviceAuthorization,
  parseStored,
  stripTrailingSlash,
  validAuthorityTokenResponse
} from "./runtime-utils.js";
import { storedTokenFromResponse } from "./token-response.js";

export class MdbaseConnectInternals<Frontmatter extends JsonObject> {
  readonly serverUrl: string;
  readonly manifest: MdbaseAppManifest | string;
  readonly manifestSource: string;
  readonly redirectUri: string;
  readonly storage: Storage;
  readonly relayEncryption: "required" | "disabled";
  readonly keyStore: GrantKeyStore;
  readonly identityStore: ApplicationIdentityStore;
  readonly directAccessMode: "auto" | "disabled";
  readonly loopbackUrl: string;
  readonly navigate?: (url: string) => void | Promise<void>;
  readonly timeouts: ResolvedConnectTimeouts;
  readonly credentialStorage: MdbaseConnectEnvironment["credentialStorage"];
  private application: Application | null = null;
  private manifestPromise: Promise<MdbaseAppManifest> | null = null;
  private readonly completionPromises = new Map<string, Promise<MdbaseAuthorizationResult<Frontmatter>>>();
  private readonly connectionCache = new Map<string, MdbaseConnection<Frontmatter>>();
  private readonly listeners = new Set<(connections: MdbaseConnectionInfo[]) => void>();
  private readonly invalidatedConnections = new Map<string, MdbaseUnavailableReason>();

  constructor(options: MdbaseConnectOptions) {
    this.serverUrl = stripTrailingSlash(String(options.serverUrl));
    this.manifest = options.manifest instanceof URL
      ? options.manifest.href
      : options.manifest ?? defaultManifestSource();
    this.manifestSource = typeof this.manifest === "string"
      ? this.manifest
      : this.manifest.distribution === "portable"
        ? `bundle:${this.manifest.id}:${manifestStorageFingerprint(this.manifest)}`
        : `bundle:${this.manifest.id}`;
    const opaquePortable = isOpaquePortableManifest(this.manifest);
    this.redirectUri = options.redirectUri === undefined ? (
      typeof this.manifest !== "string" && this.manifest.distribution === "portable"
        ? ""
        : defaultRedirectUri()
    ) : String(options.redirectUri);
    this.storage = options.storage ?? defaultStorage(opaquePortable);
    this.relayEncryption = options.relayEncryption ?? "required";
    this.keyStore = options.keyStore ?? (
      opaquePortable ? new MemoryGrantKeyStore() : new IndexedDbGrantKeyStore()
    );
    this.identityStore = options.identityStore ?? (
      opaquePortable
        ? new MemoryApplicationIdentityStore()
        : new IndexedDbApplicationIdentityStore()
    );
    this.credentialStorage = options.storage || options.keyStore || options.identityStore
      ? "custom"
      : this.storage instanceof MemoryStorage ? "memory" : "persistent";
    this.directAccessMode = options.directAccess ?? "auto";
    this.loopbackUrl = canonicalLoopbackUrl(
      String(options.loopbackUrl ?? `http://127.0.0.1:${DEFAULT_LOOPBACK_PORT}`)
    );
    this.navigate = options.navigate;
    this.timeouts = resolveConnectTimeouts(options.timeouts);
    if (typeof window !== "undefined" && this.storage === window.localStorage) {
      window.addEventListener("storage", (event) => {
        if (event.storageArea !== this.storage || !event.key?.startsWith(this.storagePrefix())) return;
        this.connectionCache.get(collectionIdFromTokenKey(event.key))?.notifyStorageChanged();
        this.emitConnections();
      });
    }
  }

  environment(): MdbaseConnectEnvironment {
    const distribution = typeof this.manifest !== "string"
      && this.manifest.distribution === "portable"
      ? "portable"
      : this.application?.distribution ?? "web";
    return {
      distribution,
      applicationOrigin: distribution === "portable"
        ? "null"
        : this.defaultApplicationOrigin(),
      credentialStorage: this.credentialStorage
    };
  }

  register(options: ConnectRequestOptions = {}): Promise<Application> {
    return withRequestBudget(options, this.timeouts.requestMs, (budget) =>
      this.registerWithinBudget(budget.signal)
    );
  }

  private async registerWithinBudget(signal: AbortSignal): Promise<Application> {
    if (this.application) return this.application;
    const response = await connectFetch(`${this.serverUrl}/v1/apps/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ manifest: await this.manifestDeclaration({ signal, timeoutMs: null }) }),
      signal
    }, "temporarily_unavailable", "Application registration is temporarily unavailable.");
    const body = await decodeJsonResponse(
      response,
      "invalid_operation_response",
      "Connect returned an invalid application registration response."
    );
    if (!response.ok) throw apiError(body, "discovery_failed", "Application discovery failed.", response.status);
    this.application = body.application;
    return this.application!;
  }

  manifestDeclaration(options: ConnectRequestOptions = {}): Promise<MdbaseAppManifest> {
    if (this.manifestPromise) return this.manifestPromise;
    const loading = withRequestBudget(options, this.timeouts.requestMs, (budget) =>
      this.loadManifest(budget.signal)
    );
    const shared = loading.catch((error: unknown) => {
      if (this.manifestPromise === shared) this.manifestPromise = null;
      throw error;
    });
    this.manifestPromise = shared;
    return this.manifestPromise;
  }

  private async loadManifest(signal: AbortSignal): Promise<MdbaseAppManifest> {
    if (typeof this.manifest !== "string") return this.manifest;
    const source = this.manifest;
    let response: Response;
    try {
      response = await fetch(source, {
        headers: { accept: "application/json" },
        signal
      });
    } catch (cause) {
      throw connectError(
        "manifest_load_failed",
        "The bundled application declaration could not be loaded.",
        { cause }
      );
    }
    if (!response.ok) {
      throw connectError(
        "manifest_load_failed",
        `The bundled application declaration returned HTTP ${response.status}.`,
        { status: response.status }
      );
    }
    try {
      return await decodeJsonResponse(
        response,
        "invalid_application_manifest",
        "The bundled application declaration is not valid JSON."
      ) as MdbaseAppManifest;
    } catch (cause) {
      throw connectError(
        "invalid_application_manifest",
        "The bundled application declaration is not valid JSON.",
        {
          cause,
          details: {
            issues: [{
              path: "/",
              keyword: "json",
              message: "must be valid JSON",
              params: {}
            }]
          }
        }
      );
    }
  }

  async authorize(
    options: MdbaseAuthorizeOptions = {}
  ): Promise<MdbaseAuthorizationOutcome<Frontmatter>> {
    return withRequestBudget(options, this.timeouts.requestMs, (budget) =>
      this.authorizeWithinBudget({ ...options, signal: budget.signal, timeoutMs: null })
    );
  }

  private async authorizeWithinBudget(
    options: MdbaseAuthorizeOptions
  ): Promise<MdbaseAuthorizationOutcome<Frontmatter>> {
    if (typeof location === "undefined" && !this.navigate && !options.openVerification) {
      throw connectError(
        "browser_required",
        "Authorization navigation requires a browser environment."
      );
    }
    const portableDeclared = typeof this.manifest !== "string"
      && this.manifest.distribution === "portable";
    const popup = portableDeclared
      && !options.openVerification
      && !this.navigate
      && typeof window !== "undefined"
      ? window.open(
          "",
          "mdbase-connect-authorization",
          "popup,width=620,height=760"
        )
      : null;
    let application: Application;
    try {
      application = await this.registerWithinBudget(options.signal!);
    } catch (error) {
      popup?.close();
      throw error;
    }
    if (application.distribution === "portable") {
      if (options.openVerification) popup?.close();
      return this.authorizePortable(
        application,
        options,
        options.openVerification ? null : popup
      );
    }
    popup?.close();
    return this.authorizeWeb(application, options);
  }

  private async authorizeWeb(
    application: Application,
    options: MdbaseAuthorizeOptions
  ): Promise<MdbaseAuthorizationOutcome<Frontmatter>> {
    const { verifier, challenge } = await createPkce();
    const state = randomBase64Url(24);
    const authorizationId = crypto.randomUUID();
    const targetCollectionId = options.target?.kind === "collection"
      ? options.target.collectionId
      : undefined;
    const keyHandle = `grant:${application.id}:${state}`;
    const grantKey = await this.keyStore.create(keyHandle);
    let installation: ApplicationIdentity;
    try {
      installation = await this.loadApplicationIdentity(application);
    } catch (error) {
      await this.keyStore.delete(keyHandle);
      throw error;
    }
    const operations = uniqueOperations(options.operations ?? DEFAULT_OPERATIONS);
    const issuedAt = new Date();
    const proof = await signApplicationAuthorization({
      protocol_version: APPLICATION_AUTHORIZATION_PROTOCOL_VERSION,
      authorization_id: authorizationId,
      application_id: application.id,
      application_manifest_digest: application.manifest_digest,
      application_installation_id: await applicationInstallationId(installation),
      installation_signing_public_key: installation.signingPublicKey,
      grant_agreement_public_key: grantKey.agreementPublicKey,
      grant_signing_public_key: grantKey.signingPublicKey,
      flow: "authorization_code",
      authorization_nonce: randomBase64Url(32),
      issued_at: issuedAt.toISOString(),
      expires_at: new Date(issuedAt.getTime() + 10 * 60 * 1_000).toISOString(),
      redirect_uri: this.redirectUri,
      state,
      code_challenge: challenge,
      contracts: authorizationContractRequirements(operations, application.requirements?.files),
      requested_operations: operations,
      ...(application.requirements?.files
        ? { requested_files: application.requirements.files }
        : {}),
      ...(targetCollectionId ? { collection_id: targetCollectionId } : {})
    }, installation);
    const pending: StoredAuthorization = {
      version: 1,
      verifier,
      state,
      clientId: application.id,
      redirectUri: this.redirectUri,
      relayEncryption: this.relayEncryption,
      collectionId: targetCollectionId,
      returnTo: options.returnTo,
      keyHandle,
      authorizationId,
      applicationAgreementPublicKey: grantKey.agreementPublicKey,
      applicationSigningPublicKey: grantKey.signingPublicKey
    };
    this.storage.setItem(this.pendingKey(state), JSON.stringify(pending));
    try {
      const response = await fetch(`${this.serverUrl}/oauth/authorization_request`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: application.id,
          redirect_uri: this.redirectUri,
          code_challenge: challenge,
          code_challenge_method: "S256",
          state,
          operations: operations.join(","),
          ...(targetCollectionId ? { collection_id: targetCollectionId } : {}),
          application_authorization: JSON.stringify(proof)
        }),
        signal: options.signal
      });
      const body = await decodeJsonResponse(
        response,
        "invalid_device_authorization_response",
        "The authorization service returned an invalid authorization response."
      );
      if (!response.ok) {
        throw apiError(
          body,
          "device_authorization_failed",
          "Application authorization could not be started.",
          response.status
        );
      }
      if (
        typeof body.authorization_uri !== "string"
        || body.authorization_id !== authorizationId
        || !Number.isInteger(body.expires_in)
        || body.expires_in <= 0
      ) {
        throw connectError(
          "invalid_device_authorization_response",
          "The authorization service returned an invalid authorization response."
        );
      }
      if (this.navigate) await this.navigate(body.authorization_uri);
      else if (typeof location !== "undefined") location.assign(body.authorization_uri);
      else {
        throw connectError(
          "browser_required",
          "Authorization navigation requires a browser environment."
        );
      }
      return { kind: "redirecting" };
    } catch (error) {
      this.storage.removeItem(this.pendingKey(state));
      await this.keyStore.delete(keyHandle);
      if (options.signal?.aborted) {
        throw authorizationAbort(options.signal, "Application authorization was cancelled.", error);
      }
      throw error;
    }
  }

  private async authorizePortable(
    application: Application,
    options: MdbaseAuthorizeOptions,
    popup: Window | null
  ): Promise<MdbaseAuthorizationOutcome<Frontmatter>> {
    if (this.relayEncryption !== "required") {
      popup?.close();
      throw connectError(
        "encryption_required",
        "Downloaded applications require encrypted relay authorization."
      );
    }
    const { verifier, challenge } = await createPkce();
    const keyHandle = `grant:${application.id}:${randomBase64Url(24)}`;
    const grantKey = await this.keyStore.create(keyHandle);
    let installation: ApplicationIdentity;
    try {
      installation = await this.loadApplicationIdentity(application);
    } catch (error) {
      popup?.close();
      await this.keyStore.delete(keyHandle);
      throw error;
    }
    const operations = uniqueOperations(options.operations ?? DEFAULT_OPERATIONS);
    const authorizationId = crypto.randomUUID();
    const issuedAt = new Date();
    const proof = await signApplicationAuthorization({
      protocol_version: APPLICATION_AUTHORIZATION_PROTOCOL_VERSION,
      authorization_id: authorizationId,
      application_id: application.id,
      application_manifest_digest: application.manifest_digest,
      application_installation_id: await applicationInstallationId(installation),
      installation_signing_public_key: installation.signingPublicKey,
      grant_agreement_public_key: grantKey.agreementPublicKey,
      grant_signing_public_key: grantKey.signingPublicKey,
      flow: "device_code",
      authorization_nonce: randomBase64Url(32),
      issued_at: issuedAt.toISOString(),
      expires_at: new Date(issuedAt.getTime() + 10 * 60 * 1_000).toISOString(),
      code_challenge: challenge,
      contracts: authorizationContractRequirements(operations, application.requirements?.files),
      requested_operations: operations,
      ...(application.requirements?.files
        ? { requested_files: application.requirements.files }
        : {}),
      ...(options.target?.kind === "collection"
        ? { collection_id: options.target.collectionId }
        : {})
    }, installation);
    let response: Response;
    let body: any;
    try {
      response = await fetch(`${this.serverUrl}/oauth/device_authorization`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: application.id,
          operations: operations.join(","),
          ...(options.target?.kind === "collection"
            ? { collection_id: options.target.collectionId }
            : {}),
          code_challenge: challenge,
          code_challenge_method: "S256",
          application_authorization: JSON.stringify(proof)
        }),
        signal: options.signal
      });
      body = await decodeJsonResponse(
        response,
        "invalid_device_authorization_response",
        "The authorization service returned an invalid device authorization response."
      );
    } catch (cause) {
      popup?.close();
      await this.keyStore.delete(keyHandle);
      throw connectError(
        "device_authorization_failed",
        "Downloaded application authorization could not be started.",
        { cause }
      );
    }
    if (!response.ok) {
      popup?.close();
      await this.keyStore.delete(keyHandle);
      throw apiError(
        body,
        "device_authorization_failed",
        "Downloaded application authorization could not be started.",
        response.status
      );
    }
    let authorization: MdbaseDeviceAuthorization;
    try {
      authorization = parseDeviceAuthorization(body);
    } catch (error) {
      popup?.close();
      await this.keyStore.delete(keyHandle);
      if (options.signal?.aborted) {
        throw authorizationAbort(
          options.signal,
          "Downloaded application authorization was cancelled.",
          error
        );
      }
      throw error;
    }
    options.onDeviceCode?.(authorization);
    if (options.openVerification) {
      await options.openVerification(authorization);
    } else if (popup) {
      try {
        popup.location.href = authorization.verificationUriComplete;
      } catch {
        // The already-open verification page still accepts the displayed code.
      }
    } else {
      await this.keyStore.delete(keyHandle);
      throw connectError(
        "approval_window_blocked",
        "The approval window was blocked. Show the provided verification link and code, then try again.",
        {
          details: {
            user_code: authorization.userCode,
            verification_uri: authorization.verificationUri,
            verification_uri_complete: authorization.verificationUriComplete,
            expires_at: authorization.expiresAt,
            interval_seconds: authorization.intervalSeconds
          }
        }
      );
    }

    let intervalSeconds = authorization.intervalSeconds;
    try {
      while (Date.now() < authorization.expiresAt) {
        await abortableDelay(intervalSeconds * 1_000, options.signal);
        if (options.signal?.aborted) {
          throw authorizationAbort(
            options.signal,
            "Downloaded application authorization was cancelled."
          );
        }
        let tokenResponse: Response;
        try {
          tokenResponse = await fetch(`${this.serverUrl}/oauth/token`, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              grant_type: "urn:ietf:params:oauth:grant-type:device_code",
              device_code: body.device_code,
              client_id: application.id,
              code_verifier: verifier
            }),
            signal: options.signal
          });
        } catch (cause) {
          if (options.signal?.aborted) {
            throw authorizationAbort(
              options.signal,
              "Downloaded application authorization was cancelled.",
              cause
            );
          }
          continue;
        }
        const tokenBody = await decodeJsonResponse(
          tokenResponse,
          "invalid_token_response",
          "The authorization service returned an invalid token response."
        );
        if (!tokenResponse.ok) {
          const code = oauthErrorCode(tokenBody);
          if (code === "authorization_pending") {
            continue;
          }
          if (code === "slow_down") {
            intervalSeconds += 5;
            continue;
          }
          throw apiError(
            tokenBody,
            "token_exchange_failed",
            "Downloaded application authorization could not be completed.",
            tokenResponse.status
          );
        }
        const authority = validAuthorityTokenResponse(tokenBody.authority, tokenBody.collection_id);
        const localEncryption = tokenBody.encryption
          && tokenBody.encryption.protocol_version === GRANT_ENCRYPTION_PROTOCOL_VERSION
          && tokenBody.encryption.suite === RELAY_ENCRYPTION_SUITE
          && tokenBody.encryption.application_agreement_public_key
            === grantKey.agreementPublicKey;
        if (tokenBody.application_origin !== "null") {
          throw connectError(
            "invalid_token_response",
            "Authorization did not bind the portable grant to its opaque application origin."
          );
        }
        if (
          tokenBody.authority
          && (
            !authority
            || tokenBody.encryption != null
            || tokenBody.authority.proof_public_key !== grantKey.signingPublicKey
          )
        ) {
          throw connectError(
            "invalid_token_response",
            "Authorization returned a remote authority capability that is not bound to this portable grant key."
          );
        }
        if (!tokenBody.authority && !localEncryption) {
          throw connectError(
            "encryption_required",
            "Authorization did not establish the expected key-bound local portable grant."
          );
        }
        const token = this.storeTokenResponse(
          tokenBody,
          application.id,
          keyHandle
        );
        if (options.target?.kind === "collection"
            && options.target.collectionId !== token.collectionId) {
          this.removeToken(token.collectionId, token.keyHandle);
          throw connectError(
            "collection_mismatch",
            "The approved collection does not match the collection requested by this link."
          );
        }
        popup?.close();
        return {
          kind: "connected",
          connection: this.connection(token.collectionId)!,
          ...(options.returnTo ? { returnTo: options.returnTo } : {})
        };
      }
      throw connectError(
        "expired_token",
        "The downloaded application authorization code expired."
      );
    } catch (error) {
      popup?.close();
      await this.keyStore.delete(keyHandle);
      if (options.signal?.aborted) {
        throw authorizationAbort(
          options.signal,
          "Downloaded application authorization was cancelled.",
          error
        );
      }
      throw error;
    }
  }

  completeAuthorization(
    callbackUrl: string,
    options: ConnectRequestOptions = {}
  ): Promise<MdbaseAuthorizationResult<Frontmatter>> {
    return withRequestBudget(options, this.timeouts.requestMs, (budget) =>
      this.completeAuthorizationWithinBudget(callbackUrl, budget.signal)
    );
  }

  private completeAuthorizationWithinBudget(
    callbackUrl: string,
    signal: AbortSignal
  ): Promise<MdbaseAuthorizationResult<Frontmatter>> {
    const state = new URL(callbackUrl).searchParams.get("state");
    if (!state) {
      return Promise.reject(connectError(
        "invalid_callback",
        "Authorization callback is missing its state."
      ));
    }
    const existing = this.completionPromises.get(state);
    if (existing) return existing;
    const completion = this.performAuthorizationCompletion(callbackUrl, state, signal);
    const shared = completion.finally(() => {
      if (this.completionPromises.get(state) === shared) this.completionPromises.delete(state);
    });
    this.completionPromises.set(state, shared);
    return shared;
  }

  private async performAuthorizationCompletion(
    callbackUrl: string,
    state: string,
    signal: AbortSignal
  ): Promise<MdbaseAuthorizationResult<Frontmatter>> {
    const callback = new URL(callbackUrl);
    const code = callback.searchParams.get("code");
    const pendingKey = this.pendingKey(state);
    const pending = parseStored<StoredAuthorization>(this.storage.getItem(pendingKey));
    if (!pending || pending.version !== 1 || state !== pending.state) {
      throw connectError("invalid_callback", "Authorization callback is missing or does not match this browser session.");
    }
    if (callback.searchParams.has("error")) {
      if (pending.keyHandle) await this.keyStore.delete(pending.keyHandle);
      this.storage.removeItem(pendingKey);
      throw serverConnectError(
        callback.searchParams.get("error") ?? "access_denied",
        callback.searchParams.get("error_description") ?? "Collection access was not approved.",
        { details: pending.returnTo ? { return_to: pending.returnTo } : undefined }
      );
    }
    if (!code) {
      throw connectError("invalid_callback", "Authorization callback is missing its code.");
    }
    const response = await connectFetch(`${this.serverUrl}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: pending.clientId,
        redirect_uri: pending.redirectUri,
        code_verifier: pending.verifier
      }),
      signal
    }, "temporarily_unavailable", "Authorization completion is temporarily unavailable.");
    const body = await decodeJsonResponse(
      response,
      "invalid_token_response",
      "The authorization service returned an invalid token response."
    );
    if (!response.ok) throw apiError(body, "token_exchange_failed", "Authorization could not be completed.", response.status);
    if (pending.relayEncryption === "required" && !body.authority && (
      !body.encryption
      || !pending.keyHandle
      || body.encryption.application_agreement_public_key
        !== pending.applicationAgreementPublicKey
    )) {
      if (pending.keyHandle) await this.keyStore.delete(pending.keyHandle);
      this.storage.removeItem(pendingKey);
      throw connectError(
        "encryption_required",
        "Authorization did not establish the required encrypted relay grant."
      );
    }
    if (body.authority?.proof_public_key) {
      if (
        !pending.keyHandle
        || !pending.applicationSigningPublicKey
        || body.authority.proof_public_key !== pending.applicationSigningPublicKey
      ) {
        if (pending.keyHandle) await this.keyStore.delete(pending.keyHandle);
        this.storage.removeItem(pendingKey);
        throw connectError(
          "invalid_token_response",
          "Authorization returned a remote authority capability bound to another application key."
        );
      }
    } else if (body.authority && pending.keyHandle) {
      await this.keyStore.delete(pending.keyHandle);
    }
    const token = this.storeTokenResponse(
      body,
      pending.clientId,
      body.authority?.proof_public_key ? pending.keyHandle : body.authority ? undefined : pending.keyHandle
    );
    if (pending.collectionId && pending.collectionId !== token.collectionId) {
      this.removeToken(token.collectionId, token.keyHandle);
      this.storage.removeItem(pendingKey);
      throw connectError(
        "collection_mismatch",
        "The approved collection does not match the collection requested by this link."
      );
    }
    this.storage.removeItem(pendingKey);
    return {
      connection: this.connection(token.collectionId)!,
      ...(pending.returnTo ? { returnTo: pending.returnTo } : {})
    };
  }

  connections(): MdbaseConnectionInfo[] {
    const connections: MdbaseConnectionInfo[] = [];
    for (const collectionId of this.connectionIds()) {
      const info = this.connection(collectionId)?.info();
      if (info) connections.push(info);
    }
    return connections.sort((left, right) =>
      left.displayName.localeCompare(right.displayName) || left.collectionId.localeCompare(right.collectionId)
    );
  }

  connection(collectionId: string): MdbaseConnection<Frontmatter> | null {
    if (!this.storage.getItem(this.tokenKey(collectionId))) return null;
    let connection = this.connectionCache.get(collectionId);
    if (!connection) {
      connection = new MdbaseConnection(this, collectionId);
      this.connectionCache.set(collectionId, connection);
    }
    return connection.info() ? connection : null;
  }

  unavailableReason(collectionId: string): MdbaseUnavailableReason | null {
    return this.invalidatedConnections.get(collectionId) ?? null;
  }

  onConnectionsChange(listener: (connections: MdbaseConnectionInfo[]) => void): () => void {
    this.listeners.add(listener);
    listener(this.connections());
    return () => this.listeners.delete(listener);
  }

  storeTokenResponse(body: any, clientId: string, keyHandle?: string): StoredToken {
    const collectionId = body.collection_id;
    if (typeof collectionId !== "string") {
      throw connectError("invalid_token_response", "Authorization returned no collection ID.");
    }
    const previous = parseStored<StoredToken>(this.storage.getItem(this.tokenKey(collectionId)));
    const token = storedTokenFromResponse({
      body,
      clientId,
      keyHandle,
      previous,
      defaultApplicationOrigin: this.defaultApplicationOrigin(),
      pinConnectorIdentity: (connectorId, publicKey) =>
        this.pinConnectorIdentity(connectorId, publicKey)
    });
    if (previous?.keyHandle && previous.keyHandle !== keyHandle) {
      void this.keyStore.delete(previous.keyHandle).catch(() => undefined);
    }
    this.storage.setItem(this.tokenKey(collectionId), JSON.stringify(token));
    this.addConnectionId(collectionId);
    this.invalidatedConnections.delete(collectionId);
    this.connectionCache.delete(collectionId);
    this.emitConnections();
    return token;
  }

  forgetConnectorIdentity(connectorId: string): void {
    this.storage.removeItem(this.connectorPinKey(connectorId));
  }

  private pinConnectorIdentity(connectorId: string, publicKey: string): void {
    const key = this.connectorPinKey(connectorId);
    const previous = parseStored<{ version: 1; publicKey: string }>(this.storage.getItem(key));
    if (previous && (previous.version !== 1 || previous.publicKey !== publicKey)) {
      throw connectError(
        "connector_identity_changed",
        "The connector identity changed since this application first connected. Forget the saved connector identity only after verifying the computer, then authorize again."
      );
    }
    if (!previous) this.storage.setItem(key, JSON.stringify({ version: 1, publicKey }));
  }

  private connectorPinKey(connectorId: string): string {
    return `mdbase-connect:${this.serverUrl}:connector-pin:${connectorId}`;
  }

  private async loadApplicationIdentity(application: Application) {
    try {
      return await applicationIdentity(this.identityStore, this.serverUrl, application);
    } catch (cause) {
      throw connectError(
        "application_identity_unavailable",
        cause instanceof ApplicationIdentityStoreError
          ? cause.message
          : "The application installation identity is unavailable.",
        { cause }
      );
    }
  }

  removeToken(
    collectionId: string,
    keyHandle?: string,
    reason: MdbaseUnavailableReason = "authorization_lost",
    discardPending = false
  ): void {
    this.invalidatedConnections.set(collectionId, reason);
    if (keyHandle && (discardPending || !this.pendingMutationsUseKey(collectionId, keyHandle))) {
      void this.keyStore.delete(keyHandle).catch(() => undefined);
    }
    this.storage.removeItem(this.tokenKey(collectionId));
    if (discardPending) this.removePendingMutations(collectionId);
    for (const transport of ["web_push", "fcm"] as const) {
      this.storage.removeItem(this.notificationKey(collectionId, transport));
    }
    this.storage.setItem(
      this.connectionsKey(),
      JSON.stringify({
        version: 1,
        collectionIds: this.connectionIds().filter((id) => id !== collectionId)
      } satisfies StoredConnectionIndex)
    );
    this.connectionCache.delete(collectionId);
    this.emitConnections();
  }

  tokenKey(collectionId: string): string {
    return `${this.storagePrefix()}:token:${collectionId}`;
  }

  pendingMutationKey(collectionId: string): string {
    return `${this.storagePrefix()}:pending-mutation:${collectionId}`;
  }

  private removePendingMutations(collectionId: string): void {
    const baseKey = this.pendingMutationKey(collectionId);
    const keys = [baseKey];
    for (let index = 0; index < this.storage.length; index += 1) {
      const key = this.storage.key(index);
      if (key?.startsWith(`${baseKey}:`)) keys.push(key);
    }
    for (const key of keys) {
      const pending = parseStored<{ keyHandle?: string }>(this.storage.getItem(key));
      if (pending?.keyHandle) void this.keyStore.delete(pending.keyHandle).catch(() => undefined);
      this.storage.removeItem(key);
    }
  }

  private pendingMutationsUseKey(collectionId: string, keyHandle: string): boolean {
    const baseKey = this.pendingMutationKey(collectionId);
    for (let index = 0; index < this.storage.length; index += 1) {
      const key = this.storage.key(index);
      if (key !== baseKey && !key?.startsWith(`${baseKey}:`)) continue;
      const pending = parseStored<{ keyHandle?: string }>(this.storage.getItem(key));
      if (pending?.keyHandle === keyHandle) return true;
    }
    return false;
  }

  notificationKey(collectionId: string, transport: "web_push" | "fcm" = "web_push"): string {
    return `${this.storagePrefix()}:notifications:${collectionId}:${transport}`;
  }

  directPreferenceKey(): string {
    return `mdbase-connect:direct:${this.defaultApplicationOrigin()}`;
  }

  defaultApplicationOrigin(): string {
    return applicationStorageOrigin(
      this.manifest,
      this.manifestSource,
      this.redirectUri,
      this.application?.distribution === "portable"
    );
  }

  private pendingKey(state: string): string {
    return `${this.storagePrefix()}:pending:${state}`;
  }

  private storagePrefix(): string {
    return `mdbase-connect:${this.serverUrl}:${this.manifestSource}`;
  }

  private connectionsKey(): string {
    return `${this.storagePrefix()}:connections`;
  }

  private connectionIds(): string[] {
    const index = parseStored<StoredConnectionIndex>(this.storage.getItem(this.connectionsKey()));
    return index?.version === 1 && Array.isArray(index.collectionIds)
      && index.collectionIds.every((collectionId) => typeof collectionId === "string")
      ? index.collectionIds
      : [];
  }

  private addConnectionId(collectionId: string): void {
    this.storage.setItem(
      this.connectionsKey(),
      JSON.stringify({
        version: 1,
        collectionIds: [...new Set([...this.connectionIds(), collectionId])]
      } satisfies StoredConnectionIndex)
    );
  }

  private emitConnections(): void {
    const connections = this.connections();
    for (const listener of this.listeners) listener(connections);
  }
}

function authorizationAbort(
  signal: AbortSignal,
  message: string,
  cause?: unknown
): MdbaseConnectError {
  if (signal.reason instanceof MdbaseConnectError) return signal.reason;
  return connectError("authorization_cancelled", message, { cause });
}
