import type {
  CollectionChange,
  CollectionChangesPage,
  CollectionDescription,
  CollectionFileMetadata,
  CollectionOperation,
  EncryptedRelayOperationResponse,
  GrantEncryption,
  GrantScope,
  JsonObject,
  MdbaseOperationEnvelope,
  RecordSummary,
  RecordResult
} from "@mdbase/connect-protocol";
import {
  decryptRelayResponse,
  encryptRelayRequest,
  IndexedDbGrantKeyStore,
  RelayCryptoError,
  type GrantKeyStore
} from "./crypto.js";

export {
  IndexedDbGrantKeyStore,
  MemoryGrantKeyStore,
  RelayCryptoError,
  type GrantKeyRecord,
  type GrantKeyStore
} from "./crypto.js";

export type {
  CollectionChange,
  CollectionChangesPage,
  CollectionContractDescriptor,
  CollectionDescription,
  CollectionFileMetadata,
  CollectionOperation as MdbaseOperation,
  CollectionTypeDescriptor,
  ContractRequirement,
  GrantScope,
  JsonObject,
  MdbaseDiagnostic,
  MdbaseOperationEnvelope,
  RecordResult,
  RecordSummary
} from "@mdbase/connect-protocol";

export interface MdbaseConnectOptions {
  serverUrl: string;
  manifestUrl?: string;
  redirectUri?: string;
  storage?: Storage;
  /** Encrypted relay is required by default for newly authorized grants. */
  relayEncryption?: "required" | "disabled";
  keyStore?: GrantKeyStore;
}

export interface ReadInput {
  path: string;
}

export interface QueryInput {
  types?: string[];
  where?: unknown;
  order_by?: unknown;
  limit?: number;
  offset?: number;
  include_body?: boolean;
  [key: string]: unknown;
}

export interface QueryResult<Record extends JsonObject = JsonObject> {
  results: Array<RecordSummary<Record> & JsonObject>;
  meta?: {
    total_count: number;
    has_more: boolean;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface CreateInput<Frontmatter extends JsonObject = JsonObject> {
  path?: string;
  type?: string;
  frontmatter: Partial<Frontmatter> & JsonObject;
  body?: string;
  if_revision?: string;
}

interface UpdateInputBase {
  path: string;
  body?: string;
  if_revision?: string;
}

export type UpdateInput<Frontmatter extends JsonObject = JsonObject> = UpdateInputBase & (
  | {
      /** Canonical v0.3 partial frontmatter update. */
      patch: Partial<Frontmatter> & JsonObject;
      fields?: never;
    }
  | {
      /** @deprecated Use `patch`. Kept during the protocol-2 transition. */
      fields: Partial<Frontmatter> & JsonObject;
      patch?: never;
    }
);

export interface DeleteInput {
  path: string;
  check_backlinks?: boolean;
  if_revision?: string;
}

export interface DeleteResult {
  path: string;
  deleted: boolean;
  broken_links?: Array<{ path: string }>;
}

export interface RenameInput {
  from: string;
  to: string;
  update_refs?: boolean;
  if_revision?: string;
}

export interface RenameResult extends RecordResult {
  from: string;
  to: string;
  references_updated?: JsonObject[];
}

export interface ChangesInput {
  after?: number;
  limit?: number;
}

export interface WatchOptions {
  cursor?: number;
  pollIntervalMs?: number;
  signal?: AbortSignal;
}

/** Provider-neutral operation transport used by the typed collection client. */
export interface MdbaseCollectionTransport {
  operation<Result>(operation: CollectionOperation, input: unknown): Promise<Result>;
}

/**
 * Typed collection operations independent of OAuth, HTTP, or storage.
 *
 * Application code can use this surface against Connect, the developer
 * sandbox, or another provider without changing its record logic.
 */
export class MdbaseCollectionClient<Frontmatter extends JsonObject = JsonObject> {
  constructor(private readonly transport: MdbaseCollectionTransport) {}

  operation<Result>(operation: CollectionOperation, input: unknown): Promise<Result> {
    return this.transport.operation(operation, input);
  }

  describe(): Promise<CollectionDescription> {
    return this.operation("describe", {});
  }

  changes(input: ChangesInput = {}): Promise<CollectionChangesPage> {
    return this.operation("changes", input);
  }

  read(input: ReadInput): Promise<MdbaseOperationEnvelope<RecordResult<Frontmatter>>> {
    return this.operation("read", input);
  }

  query(input: QueryInput = {}): Promise<MdbaseOperationEnvelope<QueryResult<Frontmatter>>> {
    return this.operation("query", input);
  }

  create(input: CreateInput<Frontmatter>): Promise<MdbaseOperationEnvelope<RecordResult<Frontmatter>>> {
    return this.operation("create", input);
  }

  update(input: UpdateInput<Frontmatter>): Promise<MdbaseOperationEnvelope<RecordResult<Frontmatter>>> {
    return this.operation("update", input);
  }

  delete(input: DeleteInput): Promise<MdbaseOperationEnvelope<DeleteResult>> {
    return this.operation("delete", input);
  }

  rename(input: RenameInput): Promise<MdbaseOperationEnvelope<RenameResult>> {
    return this.operation("rename", input);
  }

  validate(input: JsonObject = {}): Promise<MdbaseOperationEnvelope> {
    return this.operation("validate", input);
  }

  async *watch(options: WatchOptions = {}): AsyncGenerator<CollectionChange> {
    let cursor = options.cursor;
    if (cursor === undefined) cursor = (await this.changes()).cursor;
    const pollInterval = Math.max(100, options.pollIntervalMs ?? 1_000);
    while (!options.signal?.aborted) {
      const page = await this.changes({ after: cursor, limit: 200 });
      if (page.reset) {
        throw new MdbaseConnectError(
          "change_cursor_reset",
          "The collection change cursor expired. Refresh collection state before subscribing again."
        );
      }
      for (const event of page.events) yield event;
      cursor = page.cursor;
      if (!page.has_more) await abortableDelay(pollInterval, options.signal);
    }
  }
}

interface Application {
  id: string;
  name: string;
  homepage: string;
}

interface StoredAuthorization {
  verifier: string;
  state: string;
  clientId: string;
  redirectUri: string;
  relayEncryption: "required" | "disabled";
  keyHandle?: string;
  applicationPublicKey?: string;
}

interface StoredToken {
  accessToken: string;
  refreshToken?: string;
  clientId: string;
  collectionId: string;
  operations: CollectionOperation[];
  scope: GrantScope;
  expiresAt: number;
  refreshExpiresAt?: number;
  grantId?: string;
  encryption?: GrantEncryption;
  keyHandle?: string;
  hosted?: {
    providerUrl: string;
    replicaId: string;
    accessToken: string;
  };
}

const DEFAULT_OPERATIONS: CollectionOperation[] = ["describe", "changes", "read", "query"];

export class MdbaseConnect<Frontmatter extends JsonObject = JsonObject> {
  private readonly serverUrl: string;
  private readonly manifestUrl: string;
  private readonly redirectUri: string;
  private readonly storage: Storage;
  private readonly relayEncryption: "required" | "disabled";
  private readonly keyStore: GrantKeyStore;
  private application: Application | null = null;
  private refreshPromise: Promise<StoredToken> | null = null;
  private readonly collectionClient: MdbaseCollectionClient<Frontmatter>;

  constructor(options: MdbaseConnectOptions) {
    this.serverUrl = stripTrailingSlash(options.serverUrl);
    this.manifestUrl = options.manifestUrl ?? defaultManifestUrl();
    this.redirectUri = options.redirectUri ?? defaultRedirectUri();
    this.storage = options.storage ?? defaultStorage();
    this.relayEncryption = options.relayEncryption ?? "required";
    this.keyStore = options.keyStore ?? new IndexedDbGrantKeyStore();
    this.collectionClient = new MdbaseCollectionClient({
      operation: (operation, input) => this.performOperation(operation, input)
    });
  }

  async discover(): Promise<Application> {
    if (this.application) return this.application;
    const response = await fetch(`${this.serverUrl}/v1/apps/discover`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ manifest_url: this.manifestUrl })
    });
    const body = await response.json();
    if (!response.ok) throw apiError(body, "discovery_failed", "Application discovery failed.");
    this.application = body.application;
    return this.application!;
  }

  async authorize(operations: CollectionOperation[] = DEFAULT_OPERATIONS): Promise<never> {
    if (typeof location === "undefined") {
      throw new MdbaseConnectError(
        "browser_required",
        "Authorization navigation requires a browser environment."
      );
    }
    const replaced = parseStored<StoredAuthorization>(this.storage.getItem(this.pendingKey()));
    if (replaced?.keyHandle) await this.keyStore.delete(replaced.keyHandle);
    this.storage.removeItem(this.pendingKey());
    const application = await this.discover();
    const { verifier, challenge } = await createPkce();
    const state = randomBase64Url(24);
    const keyHandle = this.relayEncryption === "required"
      ? `grant:${application.id}:${state}`
      : undefined;
    const grantKey = keyHandle ? await this.keyStore.create(keyHandle) : undefined;
    const pending: StoredAuthorization = {
      verifier,
      state,
      clientId: application.id,
      redirectUri: this.redirectUri,
      relayEncryption: this.relayEncryption,
      keyHandle,
      applicationPublicKey: grantKey?.publicKey
    };
    this.storage.setItem(this.pendingKey(), JSON.stringify(pending));
    const authorize = new URL(`${this.serverUrl}/oauth/authorize`);
    authorize.searchParams.set("client_id", application.id);
    authorize.searchParams.set("redirect_uri", this.redirectUri);
    authorize.searchParams.set("code_challenge", challenge);
    authorize.searchParams.set("code_challenge_method", "S256");
    authorize.searchParams.set("state", state);
    authorize.searchParams.set("operations", [...new Set(operations)].join(","));
    if (grantKey) {
      authorize.searchParams.set("relay_protocol", "3");
      authorize.searchParams.set("application_public_key", grantKey.publicKey);
    }
    location.assign(authorize.href);
    return new Promise<never>(() => undefined);
  }

  async completeAuthorization(callbackUrl = defaultCallbackUrl()): Promise<{
    collectionId: string;
    operations: CollectionOperation[];
    scope: GrantScope;
  }> {
    const callback = new URL(callbackUrl);
    const code = callback.searchParams.get("code");
    const state = callback.searchParams.get("state");
    const pending = parseStored<StoredAuthorization>(this.storage.getItem(this.pendingKey()));
    if (!code || !state || !pending || state !== pending.state) {
      throw new MdbaseConnectError("invalid_callback", "Authorization callback is missing or does not match this browser session.");
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
    if (!response.ok) throw apiError(body, "token_exchange_failed", "Authorization could not be completed.");
    if (pending.relayEncryption === "required" && !body.hosted && (
      !body.encryption
      || !pending.keyHandle
      || body.encryption.application_public_key !== pending.applicationPublicKey
    )) {
      if (pending.keyHandle) await this.keyStore.delete(pending.keyHandle);
      this.storage.removeItem(this.pendingKey());
      throw new MdbaseConnectError(
        "encryption_required",
        "Authorization did not establish the required encrypted relay grant."
      );
    }
    if (body.hosted && pending.keyHandle) await this.keyStore.delete(pending.keyHandle);
    const token = this.storeTokenResponse(
      body,
      pending.clientId,
      body.hosted ? undefined : pending.keyHandle
    );
    this.storage.removeItem(this.pendingKey());
    return { collectionId: token.collectionId, operations: token.operations, scope: token.scope };
  }

  connection(): { collectionId: string; operations: CollectionOperation[]; scope: GrantScope } | null {
    const token = this.currentToken();
    return token
      ? { collectionId: token.collectionId, operations: token.operations, scope: token.scope }
      : null;
  }

  disconnect(): void {
    const handles = new Set([
      this.currentToken()?.keyHandle,
      parseStored<StoredAuthorization>(this.storage.getItem(this.pendingKey()))?.keyHandle
    ].filter((handle): handle is string => Boolean(handle)));
    for (const handle of handles) void this.keyStore.delete(handle);
    this.storage.removeItem(this.tokenKey());
    this.storage.removeItem(this.pendingKey());
  }

  describe(): Promise<CollectionDescription> {
    return this.collectionClient.describe();
  }

  changes(input: ChangesInput = {}): Promise<CollectionChangesPage> {
    return this.collectionClient.changes(input);
  }

  read(input: ReadInput): Promise<MdbaseOperationEnvelope<RecordResult<Frontmatter>>> {
    return this.collectionClient.read(input);
  }

  query(input: QueryInput = {}): Promise<MdbaseOperationEnvelope<QueryResult<Frontmatter>>> {
    return this.collectionClient.query(input);
  }

  create(input: CreateInput<Frontmatter>): Promise<MdbaseOperationEnvelope<RecordResult<Frontmatter>>> {
    return this.collectionClient.create(input);
  }

  update(input: UpdateInput<Frontmatter>): Promise<MdbaseOperationEnvelope<RecordResult<Frontmatter>>> {
    return this.collectionClient.update(input);
  }

  delete(input: DeleteInput): Promise<MdbaseOperationEnvelope<DeleteResult>> {
    return this.collectionClient.delete(input);
  }

  rename(input: RenameInput): Promise<MdbaseOperationEnvelope<RenameResult>> {
    return this.collectionClient.rename(input);
  }

  validate(input: JsonObject = {}): Promise<MdbaseOperationEnvelope> {
    return this.collectionClient.validate(input);
  }

  async *watch(options: WatchOptions = {}): AsyncGenerator<CollectionChange> {
    yield* this.collectionClient.watch(options);
  }

  async operation<Result>(operation: CollectionOperation, input: unknown): Promise<Result> {
    return this.collectionClient.operation(operation, input);
  }

  private async performOperation<Result>(operation: CollectionOperation, input: unknown): Promise<Result> {
    let token = await this.authorizedToken();
    if (!token) throw new MdbaseConnectError("not_authorized", "Connect this application before accessing a collection.");
    if (!token.operations.includes(operation)) {
      throw new MdbaseConnectError("insufficient_access", `This connection does not allow ${operation}.`);
    }
    let attempt = await this.sendOperation<Result>(token, operation, input);
    let response = attempt.response;
    const staleBinding = response.status === 409
      && (await response.clone().json().catch(() => null))?.error?.code === "encryption_binding_stale";
    if ((response.status === 401 || staleBinding) && token.refreshToken) {
      token = await this.refreshAuthorization();
      attempt = await this.sendOperation<Result>(token, operation, input);
      response = attempt.response;
    }
    const body = await response.json();
    if (!response.ok) throw apiError(body, "operation_failed", "Collection operation failed.");
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
        if (!decrypted.ok) throw new MdbaseConnectError(decrypted.error.code, decrypted.error.message);
        return decrypted.result;
      } catch (error) {
        if (error instanceof MdbaseConnectError) throw error;
        if (error instanceof RelayCryptoError) throw new MdbaseConnectError(error.code, error.message);
        throw error;
      }
    }
    return body.result as Result;
  }

  private async sendOperation<Result>(
    token: StoredToken,
    operation: CollectionOperation,
    input: unknown
  ): Promise<{
    response: Response;
    encryptedRequest?: Awaited<ReturnType<typeof encryptRelayRequest>>;
  }> {
    let body: unknown = input ?? {};
    let encryptedRequest: Awaited<ReturnType<typeof encryptRelayRequest>> | undefined;
    if (token.encryption && !token.hosted) {
      if (!token.grantId || !token.keyHandle) {
        throw new MdbaseConnectError("missing_grant_key", "Reconnect this application to restore encrypted access.");
      }
      try {
        encryptedRequest = await encryptRelayRequest(
          this.keyStore,
          token.keyHandle,
          { grantId: token.grantId, applicationId: token.clientId, encryption: token.encryption },
          operation,
          input
        );
      } catch (error) {
        if (error instanceof RelayCryptoError) throw new MdbaseConnectError(error.code, error.message);
        throw error;
      }
      body = encryptedRequest;
    }
    const operationUrl = token.hosted
      ? `${stripTrailingSlash(token.hosted.providerUrl)}/v1/hosted/collections/${encodeURIComponent(token.collectionId)}/operations/${operation}`
      : `${this.serverUrl}/v1/collections/${encodeURIComponent(token.collectionId)}/operations/${operation}`;
    const response = await fetch(
      operationUrl,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token.hosted?.accessToken ?? token.accessToken}`,
          "content-type": "application/json"
        },
        body: JSON.stringify(body)
      }
    );
    return { response, encryptedRequest };
  }

  private currentToken(): StoredToken | null {
    const token = parseStored<StoredToken>(this.storage.getItem(this.tokenKey()));
    if (!token) return null;
    token.scope ??= { contracts: [] };
    if (token.expiresAt <= Date.now()
        && (!token.refreshToken || (token.refreshExpiresAt ?? 0) <= Date.now())) {
      if (token.keyHandle) void this.keyStore.delete(token.keyHandle);
      this.storage.removeItem(this.tokenKey());
      return null;
    }
    return token;
  }

  private async authorizedToken(): Promise<StoredToken | null> {
    const token = this.currentToken();
    if (!token) return null;
    if (token.expiresAt > Date.now() + 30_000) return token;
    if (!token.refreshToken) {
      if (token.keyHandle) void this.keyStore.delete(token.keyHandle);
      this.storage.removeItem(this.tokenKey());
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
    const attemptedRefreshToken = current.refreshToken;
    const response = await fetch(`${this.serverUrl}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: current.refreshToken,
        client_id: current.clientId
      })
    });
    const body = await response.json();
    if (!response.ok) {
      const latest = this.currentToken();
      if (latest?.refreshToken && latest.refreshToken !== attemptedRefreshToken) {
        return latest;
      }
      if (current.keyHandle) void this.keyStore.delete(current.keyHandle);
      this.storage.removeItem(this.tokenKey());
      throw apiError(body, "authorization_expired", "Reconnect this application to continue.");
    }
    return this.storeTokenResponse(body, current.clientId, current.keyHandle);
  }

  private storeTokenResponse(body: any, clientId: string, keyHandle?: string): StoredToken {
    const token: StoredToken = {
      accessToken: body.access_token,
      refreshToken: body.refresh_token,
      clientId,
      collectionId: body.collection_id,
      operations: body.operations,
      scope: body.scope ?? { contracts: [] },
      expiresAt: Date.now() + body.expires_in * 1_000,
      refreshExpiresAt: body.refresh_expires_in
        ? Date.now() + body.refresh_expires_in * 1_000
        : undefined,
      grantId: body.grant_id,
      encryption: body.encryption ?? undefined,
      keyHandle,
      hosted: body.hosted ? {
        providerUrl: body.hosted.provider_url,
        replicaId: body.hosted.replica_id,
        accessToken: body.hosted.access_token
      } : undefined
    };
    this.storage.setItem(this.tokenKey(), JSON.stringify(token));
    return token;
  }

  private pendingKey() { return `mdbase-connect:pending:${this.serverUrl}:${this.manifestUrl}`; }
  private tokenKey() { return `mdbase-connect:token:${this.serverUrl}:${this.manifestUrl}`; }
}

export class MdbaseConnectError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
  }
}

export async function createPkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = randomBase64Url(32);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: bytesToBase64Url(new Uint8Array(digest)) };
}

function apiError(body: any, fallbackCode: string, fallbackMessage: string): MdbaseConnectError {
  return new MdbaseConnectError(
    body?.error?.code ?? fallbackCode,
    body?.error?.message ?? fallbackMessage
  );
}

function randomBase64Url(size: number): string {
  const bytes = new Uint8Array(size);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function parseStored<T>(value: string | null): T | null {
  if (!value) return null;
  try { return JSON.parse(value) as T; } catch { return null; }
}

function stripTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function defaultManifestUrl(): string {
  if (typeof location === "undefined") {
    throw new MdbaseConnectError(
      "manifest_url_required",
      "manifestUrl is required outside a browser environment."
    );
  }
  return new URL("/.well-known/mdbase-app.json", location.origin).href;
}

function defaultRedirectUri(): string {
  if (typeof location === "undefined") {
    throw new MdbaseConnectError(
      "redirect_uri_required",
      "redirectUri is required outside a browser environment."
    );
  }
  return location.href.split(/[?#]/)[0];
}

function defaultCallbackUrl(): string {
  if (typeof location === "undefined") {
    throw new MdbaseConnectError(
      "callback_url_required",
      "callbackUrl is required outside a browser environment."
    );
  }
  return location.href;
}

function defaultStorage(): Storage {
  if (typeof localStorage === "undefined") {
    throw new MdbaseConnectError(
      "storage_required",
      "storage is required outside a browser environment."
    );
  }
  return localStorage;
}

function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = setTimeout(done, milliseconds);
    signal?.addEventListener("abort", done, { once: true });
    function done() {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", done);
      resolve();
    }
  });
}
