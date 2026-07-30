import type {
  CollectionOperation,
  GrantScope,
  JsonObject,
  MdbaseAppManifest
} from "@mdbase/connect-protocol";
import {
  DEFAULT_LOOPBACK_PORT,
  ENCRYPTED_RELAY_PROTOCOL_VERSION,
  RELAY_ENCRYPTION_SUITE
} from "@mdbase/connect-protocol";
import { abortableDelay } from "./async.js";
import type { MdbaseDeviceAuthorization } from "./authorization-types.js";
import { randomBase64Url } from "./base64.js";
import {
  MdbaseConnection,
  type MdbaseAuthorizationOutcome,
  type MdbaseAuthorizationResult,
  type MdbaseAuthorizeOptions,
  type MdbaseConnectEnvironment
} from "./connection.js";
import type { MdbaseConnectionInfo } from "./connection-types.js";
import {
  IndexedDbGrantKeyStore,
  MemoryGrantKeyStore,
  validateGrantEncryption,
  type GrantKeyStore
} from "./crypto.js";
import { MdbaseConnectError } from "./errors.js";
import {
  DEFAULT_OPERATIONS,
  type Application,
  type StoredAuthorization,
  type StoredConnectionIndex,
  type StoredToken
} from "./internal-types.js";
import { uniqueOperations } from "./operation-helpers.js";
import {
  MdbaseSession,
  type MdbaseSessionOptions,
  type MdbaseUnavailableReason
} from "./session.js";
import {
  MemoryStorage,
  apiError,
  canonicalLoopbackUrl,
  createPkce,
  defaultCallbackUrl,
  defaultManifestSource,
  defaultRedirectUri,
  defaultStorage,
  isOpaquePortableManifest,
  manifestStorageFingerprint,
  oauthErrorCode,
  parseDeviceAuthorization,
  parseGrantScope,
  parseStored,
  stripTrailingSlash,
  validAuthorityTokenResponse
} from "./runtime-utils.js";

export interface MdbaseConnectOptions {
  serverUrl: string;
  /**
   * A bundled v1 application manifest or its app-local URL. String values
   * are loaded by this SDK and posted inline; Connect never fetches them.
   */
  manifest?: MdbaseAppManifest | string;
  redirectUri?: string;
  storage?: Storage;
  /** Encrypted relay is required by default for newly authorized grants. */
  relayEncryption?: "required" | "disabled";
  keyStore?: GrantKeyStore;
  /** Prefer same-computer connector access when the browser permits it. */
  directAccess?: "auto" | "disabled";
  /** Loopback origin override for development and automated testing. */
  loopbackUrl?: string;
  /** Override browser navigation, for example to use a native system browser. */
  navigate?: (url: string) => void | Promise<void>;
}

export class MdbaseConnect<Frontmatter extends JsonObject = JsonObject> {
  private readonly internals: MdbaseConnectInternals<Frontmatter>;

  constructor(options: MdbaseConnectOptions) {
    this.internals = new MdbaseConnectInternals(options);
  }

  register(): Promise<Application> {
    return this.internals.register();
  }

  authorize(options: MdbaseAuthorizeOptions = {}): Promise<MdbaseAuthorizationOutcome<Frontmatter>> {
    return this.internals.authorize(options);
  }

  createSession(options: MdbaseSessionOptions): MdbaseSession<Frontmatter> {
    return new MdbaseSession(this, options);
  }

  environment(): MdbaseConnectEnvironment {
    return this.internals.environment();
  }

  completeAuthorization(
    callbackUrl = defaultCallbackUrl()
  ): Promise<MdbaseAuthorizationResult<Frontmatter>> {
    return this.internals.completeAuthorization(callbackUrl);
  }

  connections(): MdbaseConnectionInfo[] {
    return this.internals.connections();
  }

  connection(collectionId: string): MdbaseConnection<Frontmatter> | null {
    return this.internals.connection(collectionId);
  }

  unavailableReason(collectionId: string): MdbaseUnavailableReason | null {
    return this.internals.unavailableReason(collectionId);
  }

  onConnectionsChange(
    listener: (connections: MdbaseConnectionInfo[]) => void
  ): () => void {
    return this.internals.onConnectionsChange(listener);
  }

  forgetAll(): void {
    for (const connection of this.connections()) {
      this.connection(connection.collectionId)?.forget();
    }
  }
}

class MdbaseConnectInternals<Frontmatter extends JsonObject> {
  readonly serverUrl: string;
  readonly manifest: MdbaseAppManifest | string;
  readonly manifestSource: string;
  readonly redirectUri: string;
  readonly storage: Storage;
  readonly relayEncryption: "required" | "disabled";
  readonly keyStore: GrantKeyStore;
  readonly directAccessMode: "auto" | "disabled";
  readonly loopbackUrl: string;
  readonly navigate?: (url: string) => void | Promise<void>;
  readonly credentialStorage: MdbaseConnectEnvironment["credentialStorage"];
  private application: Application | null = null;
  private readonly completionPromises = new Map<string, Promise<MdbaseAuthorizationResult<Frontmatter>>>();
  private readonly connectionCache = new Map<string, MdbaseConnection<Frontmatter>>();
  private readonly listeners = new Set<(connections: MdbaseConnectionInfo[]) => void>();
  private readonly invalidatedConnections = new Map<string, MdbaseUnavailableReason>();

  constructor(options: MdbaseConnectOptions) {
    this.serverUrl = stripTrailingSlash(options.serverUrl);
    this.manifest = options.manifest ?? defaultManifestSource();
    this.manifestSource = typeof this.manifest === "string"
      ? this.manifest
      : this.manifest.distribution === "portable"
        ? `bundle:${this.manifest.id}:${manifestStorageFingerprint(this.manifest)}`
        : `bundle:${this.manifest.id}`;
    const opaquePortable = isOpaquePortableManifest(this.manifest);
    this.redirectUri = options.redirectUri ?? (
      typeof this.manifest !== "string" && this.manifest.distribution === "portable"
        ? ""
        : defaultRedirectUri()
    );
    this.storage = options.storage ?? defaultStorage(opaquePortable);
    this.relayEncryption = options.relayEncryption ?? "required";
    this.keyStore = options.keyStore ?? (
      opaquePortable ? new MemoryGrantKeyStore() : new IndexedDbGrantKeyStore()
    );
    this.credentialStorage = options.storage || options.keyStore
      ? "custom"
      : this.storage instanceof MemoryStorage ? "memory" : "persistent";
    this.directAccessMode = options.directAccess ?? "auto";
    this.loopbackUrl = canonicalLoopbackUrl(
      options.loopbackUrl ?? `http://127.0.0.1:${DEFAULT_LOOPBACK_PORT}`
    );
    this.navigate = options.navigate;
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

  async register(): Promise<Application> {
    if (this.application) return this.application;
    const response = await fetch(`${this.serverUrl}/v1/apps/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ manifest: await this.loadManifest() })
    });
    const body = await response.json();
    if (!response.ok) throw apiError(body, "discovery_failed", "Application discovery failed.", response.status);
    this.application = body.application;
    return this.application!;
  }

  private async loadManifest(): Promise<MdbaseAppManifest> {
    if (typeof this.manifest !== "string") return this.manifest;
    const source = this.manifest;
    let response: Response;
    try {
      response = await fetch(source, {
        headers: { accept: "application/json" }
      });
    } catch (cause) {
      throw new MdbaseConnectError(
        "manifest_load_failed",
        "The bundled application declaration could not be loaded.",
        { cause }
      );
    }
    if (!response.ok) {
      throw new MdbaseConnectError(
        "manifest_load_failed",
        `The bundled application declaration returned HTTP ${response.status}.`,
        { status: response.status }
      );
    }
    try {
      return await response.json() as MdbaseAppManifest;
    } catch (cause) {
      throw new MdbaseConnectError(
        "invalid_application_manifest",
        "The bundled application declaration is not valid JSON.",
        { cause }
      );
    }
  }

  async authorize(
    options: MdbaseAuthorizeOptions = {}
  ): Promise<MdbaseAuthorizationOutcome<Frontmatter>> {
    if (typeof location === "undefined" && !this.navigate && !options.openVerification) {
      throw new MdbaseConnectError(
        "browser_required",
        "Authorization navigation requires a browser environment."
      );
    }
    const portableDeclared = typeof this.manifest !== "string"
      && this.manifest.distribution === "portable";
    const popup = portableDeclared
      && !options.openVerification
      && typeof window !== "undefined"
      ? window.open(
          `${this.serverUrl}/device`,
          "mdbase-connect-authorization",
          "popup,width=620,height=760"
        )
      : null;
    let application: Application;
    try {
      application = await this.register();
    } catch (error) {
      popup?.close();
      throw error;
    }
    if (application.distribution === "portable") {
      return this.authorizePortable(application, options, popup);
    }
    popup?.close();
    const { verifier, challenge } = await createPkce();
    const state = randomBase64Url(24);
    const targetCollectionId = options.target?.kind === "collection"
      ? options.target.collectionId
      : undefined;
    const keyHandle = this.relayEncryption === "required"
      ? `grant:${application.id}:${state}`
      : undefined;
    const grantKey = keyHandle ? await this.keyStore.create(keyHandle) : undefined;
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
      applicationAgreementPublicKey: grantKey?.agreementPublicKey,
      applicationSigningPublicKey: grantKey?.signingPublicKey
    };
    this.storage.setItem(this.pendingKey(state), JSON.stringify(pending));
    const authorize = new URL(`${this.serverUrl}/oauth/authorize`);
    authorize.searchParams.set("client_id", application.id);
    authorize.searchParams.set("redirect_uri", this.redirectUri);
    authorize.searchParams.set("code_challenge", challenge);
    authorize.searchParams.set("code_challenge_method", "S256");
    authorize.searchParams.set("state", state);
    authorize.searchParams.set(
      "operations",
      uniqueOperations(options.operations ?? DEFAULT_OPERATIONS).join(",")
    );
    if (targetCollectionId) {
      authorize.searchParams.set("collection_id", targetCollectionId);
    }
    if (grantKey) {
      authorize.searchParams.set("relay_protocol", "1");
      authorize.searchParams.set(
        "application_agreement_public_key",
        grantKey.agreementPublicKey
      );
      authorize.searchParams.set(
        "application_signing_public_key",
        grantKey.signingPublicKey
      );
    }
    if (this.navigate) await this.navigate(authorize.href);
    else location.assign(authorize.href);
    return { kind: "redirecting" };
  }

  private async authorizePortable(
    application: Application,
    options: MdbaseAuthorizeOptions,
    popup: Window | null
  ): Promise<MdbaseAuthorizationOutcome<Frontmatter>> {
    if (this.relayEncryption !== "required") {
      popup?.close();
      throw new MdbaseConnectError(
        "encryption_required",
        "Downloaded applications require encrypted relay authorization."
      );
    }
    const { verifier, challenge } = await createPkce();
    const keyHandle = `grant:${application.id}:${randomBase64Url(24)}`;
    const grantKey = await this.keyStore.create(keyHandle);
    let response: Response;
    let body: any;
    try {
      response = await fetch(`${this.serverUrl}/oauth/device_authorization`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: application.id,
          operations: uniqueOperations(options.operations ?? DEFAULT_OPERATIONS).join(","),
          ...(options.target?.kind === "collection"
            ? { collection_id: options.target.collectionId }
            : {}),
          code_challenge: challenge,
          code_challenge_method: "S256",
          relay_protocol: "1",
          application_agreement_public_key: grantKey.agreementPublicKey,
          application_signing_public_key: grantKey.signingPublicKey
        })
      });
      body = await response.json();
    } catch (cause) {
      popup?.close();
      await this.keyStore.delete(keyHandle);
      throw new MdbaseConnectError(
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
      throw new MdbaseConnectError(
        "approval_window_blocked",
        "The approval window was blocked. Show the provided verification link and code, then try again.",
        { details: authorization }
      );
    }

    let intervalSeconds = authorization.intervalSeconds;
    try {
      while (Date.now() < authorization.expiresAt) {
        await abortableDelay(intervalSeconds * 1_000, options.signal);
        if (options.signal?.aborted) {
          throw new MdbaseConnectError(
            "authorization_cancelled",
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
            throw new MdbaseConnectError(
              "authorization_cancelled",
              "Downloaded application authorization was cancelled.",
              { cause }
            );
          }
          continue;
        }
        const tokenBody = await tokenResponse.json();
        if (!tokenResponse.ok) {
          const code = oauthErrorCode(tokenBody);
          if (code === "authorization_pending") continue;
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
          && tokenBody.encryption.protocol_version === ENCRYPTED_RELAY_PROTOCOL_VERSION
          && tokenBody.encryption.suite === RELAY_ENCRYPTION_SUITE
          && tokenBody.encryption.application_agreement_public_key
            === grantKey.agreementPublicKey;
        if (tokenBody.application_origin !== "null") {
          throw new MdbaseConnectError(
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
          throw new MdbaseConnectError(
            "invalid_token_response",
            "Authorization returned a remote authority capability that is not bound to this portable grant key."
          );
        }
        if (!tokenBody.authority && !localEncryption) {
          throw new MdbaseConnectError(
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
          throw new MdbaseConnectError(
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
      throw new MdbaseConnectError(
        "expired_token",
        "The downloaded application authorization code expired."
      );
    } catch (error) {
      popup?.close();
      await this.keyStore.delete(keyHandle);
      throw error;
    }
  }

  completeAuthorization(callbackUrl: string): Promise<MdbaseAuthorizationResult<Frontmatter>> {
    const state = new URL(callbackUrl).searchParams.get("state");
    if (!state) {
      return Promise.reject(new MdbaseConnectError(
        "invalid_callback",
        "Authorization callback is missing its state."
      ));
    }
    const existing = this.completionPromises.get(state);
    if (existing) return existing;
    const completion = this.performAuthorizationCompletion(callbackUrl, state);
    const shared = completion.finally(() => {
      if (this.completionPromises.get(state) === shared) this.completionPromises.delete(state);
    });
    this.completionPromises.set(state, shared);
    return shared;
  }

  private async performAuthorizationCompletion(
    callbackUrl: string,
    state: string
  ): Promise<MdbaseAuthorizationResult<Frontmatter>> {
    const callback = new URL(callbackUrl);
    const code = callback.searchParams.get("code");
    const pendingKey = this.pendingKey(state);
    const pending = parseStored<StoredAuthorization>(this.storage.getItem(pendingKey));
    if (!pending || pending.version !== 1 || state !== pending.state) {
      throw new MdbaseConnectError("invalid_callback", "Authorization callback is missing or does not match this browser session.");
    }
    if (callback.searchParams.has("error")) {
      if (pending.keyHandle) await this.keyStore.delete(pending.keyHandle);
      this.storage.removeItem(pendingKey);
      throw new MdbaseConnectError(
        callback.searchParams.get("error") ?? "access_denied",
        callback.searchParams.get("error_description") ?? "Collection access was not approved.",
        { details: pending.returnTo ? { returnTo: pending.returnTo } : undefined }
      );
    }
    if (!code) {
      throw new MdbaseConnectError("invalid_callback", "Authorization callback is missing its code.");
    }
    const response = await fetch(`${this.serverUrl}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: pending.clientId,
        redirect_uri: pending.redirectUri,
        code_verifier: pending.verifier
      })
    });
    const body = await response.json();
    if (!response.ok) throw apiError(body, "token_exchange_failed", "Authorization could not be completed.", response.status);
    if (pending.relayEncryption === "required" && !body.authority && (
      !body.encryption
      || !pending.keyHandle
      || body.encryption.application_agreement_public_key
        !== pending.applicationAgreementPublicKey
    )) {
      if (pending.keyHandle) await this.keyStore.delete(pending.keyHandle);
      this.storage.removeItem(pendingKey);
      throw new MdbaseConnectError(
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
        throw new MdbaseConnectError(
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
      throw new MdbaseConnectError(
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
      throw new MdbaseConnectError("invalid_token_response", "Authorization returned no collection ID.");
    }
    const scope = parseGrantScope(body.scope);
    if (!scope) {
      throw new MdbaseConnectError(
        "invalid_token_response",
        "Authorization returned no valid collection scope."
      );
    }
    if (body.authority && !validAuthorityTokenResponse(body.authority, collectionId)) {
      throw new MdbaseConnectError(
        "invalid_token_response",
        "Authorization returned an invalid remote authority capability."
      );
    }
    if (body.authority && body.encryption) {
      throw new MdbaseConnectError(
        "invalid_token_response",
        "Authorization returned conflicting collection transports."
      );
    }
    if (body.encryption) {
      try {
        validateGrantEncryption(body.encryption);
      } catch {
        throw new MdbaseConnectError(
          "invalid_token_response",
          "Authorization returned an invalid encrypted relay binding."
        );
      }
      if (
        body.encryption.collection_id !== collectionId
        || typeof body.grant_id !== "string"
        || body.grant_id.length === 0
      ) {
        throw new MdbaseConnectError(
          "invalid_token_response",
          "Authorization returned an encrypted relay binding for another grant."
        );
      }
    }
    const previous = parseStored<StoredToken>(this.storage.getItem(this.tokenKey(collectionId)));
    if (
      previous?.encryption
      && body.encryption
      && previous.keyHandle
      && previous.keyHandle === keyHandle
      && (
        previous.grantId !== body.grant_id
        || previous.encryption.connector_id !== body.encryption.connector_id
        || previous.encryption.connector_agreement_public_key
          !== body.encryption.connector_agreement_public_key
        || previous.encryption.application_agreement_public_key
          !== body.encryption.application_agreement_public_key
      )
    ) {
      throw new MdbaseConnectError(
        "connector_identity_changed",
        "The connector identity changed during authorization renewal. Reauthorize before sending collection data.",
        { requiresAuthorization: true, recovery: "reauthorize" }
      );
    }
    if (previous?.keyHandle && previous.keyHandle !== keyHandle) {
      void this.keyStore.delete(previous.keyHandle).catch(() => undefined);
    }
    const token: StoredToken = {
      version: 1,
      accessToken: body.access_token,
      refreshToken: body.refresh_token,
      clientId,
      collectionId,
      collectionName: body.collection_name ?? `Collection ${collectionId.slice(0, 8)}`,
      operations: body.operations,
      scope,
      expiresAt: Date.now() + body.expires_in * 1_000,
      refreshExpiresAt: body.refresh_expires_in
        ? Date.now() + body.refresh_expires_in * 1_000
        : undefined,
      grantId: body.grant_id,
      encryption: body.encryption ?? undefined,
      applicationOrigin: body.application_origin ?? this.defaultApplicationOrigin(),
      keyHandle,
      savedAt: Date.now(),
      authority: body.authority ? {
        operationsUrl: body.authority.operations_url,
        syncUrl: body.authority.sync_url,
        replicaId: body.authority.replica_id,
        accessToken: body.authority.access_token,
        proofPublicKey: body.authority.proof_public_key
      } : undefined
    };
    this.storage.setItem(this.tokenKey(collectionId), JSON.stringify(token));
    this.addConnectionId(collectionId);
    this.invalidatedConnections.delete(collectionId);
    this.connectionCache.delete(collectionId);
    this.emitConnections();
    return token;
  }

  removeToken(
    collectionId: string,
    keyHandle?: string,
    reason: MdbaseUnavailableReason = "authorization_lost"
  ): void {
    this.invalidatedConnections.set(collectionId, reason);
    if (keyHandle) void this.keyStore.delete(keyHandle).catch(() => undefined);
    this.storage.removeItem(this.tokenKey(collectionId));
    this.storage.removeItem(this.pendingMutationKey(collectionId));
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

  notificationKey(collectionId: string, transport: "web_push" | "fcm" = "web_push"): string {
    return `${this.storagePrefix()}:notifications:${collectionId}:${transport}`;
  }

  directPreferenceKey(): string {
    return `mdbase-connect:direct:${this.defaultApplicationOrigin()}`;
  }

  defaultApplicationOrigin(): string {
    if (
      (typeof this.manifest !== "string" && this.manifest.distribution === "portable")
      || this.application?.distribution === "portable"
    ) {
      return "null";
    }
    const redirect = new URL(this.redirectUri);
    if (["http:", "https:"].includes(redirect.protocol)) return redirect.origin;
    if (typeof location !== "undefined") return location.origin;
    if (
      this.manifest
      && typeof this.manifest !== "string"
    ) {
      return new URL(this.manifest.homepage).origin;
    }
    try {
      return new URL(this.manifestSource).origin;
    } catch {
      return "";
    }
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

function collectionIdFromTokenKey(key: string): string {
  const marker = ":token:";
  const index = key.lastIndexOf(marker);
  return index < 0 ? "" : key.slice(index + marker.length);
}
