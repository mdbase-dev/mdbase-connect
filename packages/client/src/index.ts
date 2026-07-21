import type {
  CollectionChange,
  CollectionChangesPage,
  CollectionDescription,
  CollectionFileMetadata,
  CollectionOperation,
  CollectionTypeDocument,
  EncryptedRelayOperationRequest,
  EncryptedRelayOperationResponse,
  GrantEncryption,
  GrantScope,
  JsonObject,
  MdbaseOperationEnvelope,
  RecordSummary,
  RecordResult,
  SyncChangesPage,
  SyncMutation,
  SyncMutationReceipt,
  SyncSession,
  SyncSnapshotPage
} from "@mdbase/connect-protocol";
import { DEFAULT_LOOPBACK_PORT } from "@mdbase/connect-protocol";
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
  ApplicationProvisions,
  ApplicationRequirements,
  CollectionChange,
  CollectionChangesPage,
  CollectionContractDescriptor,
  CollectionDescription,
  CollectionFileMetadata,
  CollectionOperation as MdbaseOperation,
  CollectionTypeDescriptor,
  CollectionTypeDocument,
  ContractRequirement,
  GrantScope,
  JsonObject,
  MdbaseAppManifest,
  MdbaseDiagnostic,
  MdbaseOperationEnvelope,
  RecordResult,
  RecordSummary,
  TypeProvision
} from "@mdbase/connect-protocol";

export interface MdbaseConnectOptions {
  serverUrl: string;
  manifestUrl?: string;
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

export type MdbaseConnectionRoute = "hosted" | "direct" | "relay";
export type DirectAccessStatus =
  | "disabled"
  | "permission_required"
  | "checking"
  | "available"
  | "unavailable"
  | "denied";

export interface MdbaseConnection {
  collectionId: string;
  operations: CollectionOperation[];
  scope: GrantScope;
  route: MdbaseConnectionRoute;
  directAccess: DirectAccessStatus;
}

export interface MdbaseHostedSyncTransport<Frontmatter extends JsonObject = JsonObject> {
  openSession(): Promise<SyncSession>;
  snapshot(snapshotId: string, page?: string): Promise<SyncSnapshotPage<Frontmatter>>;
  changes(after: number, limit?: number): Promise<SyncChangesPage<Frontmatter>>;
  mutate(mutation: SyncMutation): Promise<SyncMutationReceipt<Frontmatter>>;
}

export interface MdbaseHostedSyncConnection<Frontmatter extends JsonObject = JsonObject> {
  collectionId: string;
  replicaId: string;
  transport: MdbaseHostedSyncTransport<Frontmatter>;
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

export interface ReadTypeInput {
  name?: string;
  path?: string;
}

export interface CreateTypeInput {
  document: string;
  path?: string;
}

export interface UpdateTypeInput extends ReadTypeInput {
  document: string;
  if_revision: string;
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

  readType(input: ReadTypeInput): Promise<MdbaseOperationEnvelope<CollectionTypeDocument>> {
    return this.operation("read_type", input);
  }

  createType(input: CreateTypeInput): Promise<MdbaseOperationEnvelope<CollectionTypeDocument>> {
    return this.operation("create_type", input);
  }

  updateType(input: UpdateTypeInput): Promise<MdbaseOperationEnvelope<CollectionTypeDocument>> {
    return this.operation("update_type", input);
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
  applicationOrigin?: string;
  keyHandle?: string;
  hosted?: {
    providerUrl: string;
    replicaId: string;
    accessToken: string;
  };
}

interface PendingDirectMutation {
  grantId: string;
  keyId: string;
  operation: CollectionOperation;
  inputFingerprint: string;
  envelope: EncryptedRelayOperationRequest;
  createdAt: number;
}

const DEFAULT_OPERATIONS: CollectionOperation[] = ["describe", "changes", "read", "query"];

export class MdbaseConnect<Frontmatter extends JsonObject = JsonObject> {
  private readonly serverUrl: string;
  private readonly manifestUrl: string;
  private readonly redirectUri: string;
  private readonly storage: Storage;
  private readonly relayEncryption: "required" | "disabled";
  private readonly keyStore: GrantKeyStore;
  private readonly directAccessMode: "auto" | "disabled";
  private readonly loopbackUrl: string;
  private readonly navigate?: (url: string) => void | Promise<void>;
  private application: Application | null = null;
  private refreshPromise: Promise<StoredToken> | null = null;
  private readonly collectionClient: MdbaseCollectionClient<Frontmatter>;
  private directStatus: DirectAccessStatus;
  private route: MdbaseConnectionRoute = "relay";
  private directFailures = 0;
  private directRetryAt = 0;
  private readonly connectionListeners = new Set<(connection: MdbaseConnection | null) => void>();

  constructor(options: MdbaseConnectOptions) {
    this.serverUrl = stripTrailingSlash(options.serverUrl);
    this.manifestUrl = options.manifestUrl ?? defaultManifestUrl();
    this.redirectUri = options.redirectUri ?? defaultRedirectUri();
    this.storage = options.storage ?? defaultStorage();
    this.relayEncryption = options.relayEncryption ?? "required";
    this.keyStore = options.keyStore ?? new IndexedDbGrantKeyStore();
    this.directAccessMode = options.directAccess ?? "auto";
    this.loopbackUrl = canonicalLoopbackUrl(
      options.loopbackUrl ?? `http://127.0.0.1:${DEFAULT_LOOPBACK_PORT}`
    );
    this.directStatus = this.directAccessMode === "disabled" ? "disabled" : "unavailable";
    this.navigate = options.navigate;
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
    if (typeof location === "undefined" && !this.navigate) {
      throw new MdbaseConnectError(
        "browser_required",
        "Authorization navigation requires a browser environment."
      );
    }
    const replaced = parseStored<StoredAuthorization>(this.storage.getItem(this.pendingKey()));
    if (replaced?.keyHandle) await this.keyStore.delete(replaced.keyHandle);
    this.storage.removeItem(this.pendingKey());
    this.clearPendingMutation();
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
    if (this.navigate) await this.navigate(authorize.href);
    else location.assign(authorize.href);
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

  connection(): MdbaseConnection | null {
    const token = this.currentToken();
    return token
      ? {
          collectionId: token.collectionId,
          operations: token.operations,
          scope: token.scope,
          route: token.hosted ? "hosted" : this.route,
          directAccess: token.hosted ? "disabled" : this.directStatus
        }
      : null;
  }

  onConnectionChange(listener: (connection: MdbaseConnection | null) => void): () => void {
    this.connectionListeners.add(listener);
    listener(this.connection());
    return () => this.connectionListeners.delete(listener);
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
   * Return an offline-replication transport for an authorized hosted
   * collection. Provider credentials stay inside the SDK and are refreshed
   * before requests when necessary.
   */
  hostedSync(): MdbaseHostedSyncConnection<Frontmatter> | null {
    const token = this.currentToken();
    if (!token?.hosted) return null;
    const collectionId = token.collectionId;
    const replicaId = token.hosted.replicaId;
    return {
      collectionId,
      replicaId,
      transport: {
        openSession: () => this.performHostedSyncRequest(collectionId, replicaId, "POST", "sessions"),
        snapshot: (snapshotId, page) => {
          const query = new URLSearchParams({ snapshot_id: snapshotId });
          if (page) query.set("page", page);
          return this.performHostedSyncRequest(collectionId, replicaId, "GET", `snapshot?${query}`);
        },
        changes: (after, limit = 200) => this.performHostedSyncRequest(
          collectionId,
          replicaId,
          "GET",
          `changes?${new URLSearchParams({ after: String(after), limit: String(limit) })}`
        ),
        mutate: (mutation) => this.performHostedSyncRequest(
          collectionId,
          replicaId,
          "POST",
          "mutations",
          mutation
        )
      }
    };
  }

  disconnect(): void {
    const handles = new Set([
      this.currentToken()?.keyHandle,
      parseStored<StoredAuthorization>(this.storage.getItem(this.pendingKey()))?.keyHandle
    ].filter((handle): handle is string => Boolean(handle)));
    for (const handle of handles) void this.keyStore.delete(handle);
    this.storage.removeItem(this.tokenKey());
    this.storage.removeItem(this.pendingKey());
    this.clearPendingMutation();
    this.setRoute("relay");
    this.emitConnection();
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

  readType(input: ReadTypeInput): Promise<MdbaseOperationEnvelope<CollectionTypeDocument>> {
    return this.collectionClient.readType(input);
  }

  createType(input: CreateTypeInput): Promise<MdbaseOperationEnvelope<CollectionTypeDocument>> {
    return this.collectionClient.createType(input);
  }

  updateType(input: UpdateTypeInput): Promise<MdbaseOperationEnvelope<CollectionTypeDocument>> {
    return this.collectionClient.updateType(input);
  }

  async *watch(options: WatchOptions = {}): AsyncGenerator<CollectionChange> {
    yield* this.collectionClient.watch(options);
  }

  async operation<Result>(operation: CollectionOperation, input: unknown): Promise<Result> {
    return this.collectionClient.operation(operation, input);
  }

  private async performOperation<Result>(operation: CollectionOperation, input: unknown): Promise<Result> {
    let token = this.currentToken();
    if (!token) throw new MdbaseConnectError("not_authorized", "Connect this application before accessing a collection.");
    if (!token.operations.includes(operation)) {
      throw new MdbaseConnectError("insufficient_access", `This connection does not allow ${operation}.`);
    }
    let tryDirect = isMutation(operation) && this.storage.getItem(this.pendingMutationKey()) !== null
      ? true
      : await this.shouldAttemptDirect(token);
    if (!tryDirect) {
      token = await this.authorizedToken();
      if (!token) throw new MdbaseConnectError("not_authorized", "Reconnect this application to continue.");
    }
    let attempt = await this.sendOperation<Result>(token, operation, input, tryDirect);
    let response = attempt.response;
    const staleBinding = response.status === 409
      && (await response.clone().json().catch(() => null))?.error?.code === "encryption_binding_stale";
    if ((response.status === 401 || staleBinding) && token.refreshToken) {
      if (attempt.pendingMutation && attempt.directDeliveryUncertain) {
        throw new MdbaseConnectError(
          "direct_outcome_unknown",
          "The direct operation may have completed, but its encrypted grant changed before the response could be recovered. Refresh before making another change."
        );
      }
      if (attempt.pendingMutation) this.clearPendingMutation();
      token = await this.refreshAuthorization();
      tryDirect = await this.shouldAttemptDirect(token);
      attempt = await this.sendOperation<Result>(token, operation, input, tryDirect);
      response = attempt.response;
    }
    const body = await response.json();
    if (!response.ok) {
      const error = apiError(body, "operation_failed", "Collection operation failed.");
      if (attempt.pendingMutation && attempt.directDeliveryUncertain) {
        throw uncertainDirectMutation(error);
      }
      if (attempt.pendingMutation && !attempt.directDeliveryUncertain) {
        this.clearPendingMutation();
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
    return body.result as Result;
  }

  private async performHostedSyncRequest<Result>(
    collectionId: string,
    replicaId: string,
    method: "GET" | "POST",
    path: string,
    input?: unknown
  ): Promise<Result> {
    let token = await this.authorizedToken();
    if (!token?.hosted
        || token.collectionId !== collectionId
        || token.hosted.replicaId !== replicaId) {
      throw new MdbaseConnectError(
        "hosted_authorization_changed",
        "Reconnect this hosted collection before synchronizing."
      );
    }
    let response = await this.sendHostedSyncRequest(token, collectionId, method, path, input);
    if (response.status === 401 && token.refreshToken) {
      token = await this.refreshAuthorization();
      if (!token.hosted
          || token.collectionId !== collectionId
          || token.hosted.replicaId !== replicaId) {
        throw new MdbaseConnectError(
          "hosted_authorization_changed",
          "Reconnect this hosted collection before synchronizing."
        );
      }
      response = await this.sendHostedSyncRequest(token, collectionId, method, path, input);
    }
    const body = await response.json();
    if (!response.ok) throw apiError(body, "sync_failed", "Hosted collection synchronization failed.");
    return body as Result;
  }

  private sendHostedSyncRequest(
    token: StoredToken,
    collectionId: string,
    method: "GET" | "POST",
    path: string,
    input?: unknown
  ): Promise<Response> {
    if (!token.hosted) {
      throw new MdbaseConnectError("not_hosted", "This authorization is not for a hosted collection.");
    }
    return fetch(
      `${stripTrailingSlash(token.hosted.providerUrl)}/v1/hosted/collections/${encodeURIComponent(collectionId)}/sync/${path}`,
      {
        method,
        headers: {
          authorization: `Bearer ${token.hosted.accessToken}`,
          ...(input === undefined ? {} : { "content-type": "application/json" })
        },
        ...(input === undefined ? {} : { body: JSON.stringify(input) })
      }
    );
  }

  private async sendOperation<Result>(
    token: StoredToken,
    operation: CollectionOperation,
    input: unknown,
    tryDirect: boolean
  ): Promise<{
    response: Response;
    encryptedRequest?: Awaited<ReturnType<typeof encryptRelayRequest>>;
    directDeliveryUncertain?: boolean;
    pendingMutation?: boolean;
  }> {
    let body: unknown = input ?? {};
    let encryptedRequest: Awaited<ReturnType<typeof encryptRelayRequest>> | undefined;
    let pendingMutation = false;
    if (token.encryption && !token.hosted) {
      if (!token.grantId || !token.keyHandle) {
        throw new MdbaseConnectError("missing_grant_key", "Reconnect this application to restore encrypted access.");
      }
      try {
        if (tryDirect && isMutation(operation)) {
          const inputFingerprint = await operationFingerprint(operation, input);
          const pending = parseStored<PendingDirectMutation>(
            this.storage.getItem(this.pendingMutationKey())
          );
          if (pending) {
            if (pending.grantId !== token.grantId
                || pending.keyId !== token.encryption.key_id
                || pending.operation !== operation
                || pending.inputFingerprint !== inputFingerprint) {
              throw new MdbaseConnectError(
                "pending_mutation_unresolved",
                "A previous direct write still has an unknown outcome. Retry that same write before making another change."
              );
            }
            encryptedRequest = pending.envelope;
          } else {
            encryptedRequest = await encryptRelayRequest(
              this.keyStore,
              token.keyHandle,
              { grantId: token.grantId, applicationId: token.clientId, encryption: token.encryption },
              operation,
              input
            );
            this.storage.setItem(this.pendingMutationKey(), JSON.stringify({
              grantId: token.grantId,
              keyId: token.encryption.key_id,
              operation,
              inputFingerprint,
              envelope: encryptedRequest,
              createdAt: Date.now()
            } satisfies PendingDirectMutation));
          }
          pendingMutation = true;
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
    }
    if (tryDirect && encryptedRequest && !token.hosted) {
      let directDeliveryUncertain = false;
      try {
        const response = await fetch(`${this.loopbackUrl}/v1/operations`, loopbackRequest({
          method: "POST",
          headers: { "content-type": "application/mdbase-connect+json" },
          body: JSON.stringify(encryptedRequest)
        }));
        if (!directFallbackStatus(response.status)) {
          if (response.ok) {
            this.markDirectAvailable();
            this.setRoute("direct");
          }
          return { response, encryptedRequest, pendingMutation };
        }
        directDeliveryUncertain = response.status >= 500;
        this.markDirectUnavailable();
      } catch {
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
        if (pendingMutation && directDeliveryUncertain) throw uncertainDirectMutation(error);
        throw error;
      }
      let response: Response;
      try {
        response = await fetch(
          `${this.serverUrl}/v1/collections/${encodeURIComponent(relayToken.collectionId)}/operations/${operation}`,
          {
          method: "POST",
          headers: {
            authorization: `Bearer ${relayToken.accessToken}`,
            "content-type": "application/json"
          },
          body: JSON.stringify(encryptedRequest)
          }
        );
      } catch (error) {
        if (pendingMutation && directDeliveryUncertain) throw uncertainDirectMutation(error);
        throw error;
      }
      if (response.ok) this.setRoute("relay");
      return { response, encryptedRequest, directDeliveryUncertain, pendingMutation };
    }
    const operationUrl = token.hosted
      ? `${stripTrailingSlash(token.hosted.providerUrl)}/v1/hosted/collections/${encodeURIComponent(token.collectionId)}/operations/${operation}`
      : `${this.serverUrl}/v1/collections/${encodeURIComponent(token.collectionId)}/operations/${operation}`;
    const response = await fetch(operationUrl, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token.hosted?.accessToken ?? token.accessToken}`,
          "content-type": "application/json"
        },
        body: JSON.stringify(body)
      });
    if (response.ok) this.setRoute(token.hosted ? "hosted" : "relay");
    return { response, encryptedRequest };
  }

  private directCapable(token: StoredToken | null): boolean {
    if (!token || token.hosted || !token.encryption || !token.grantId || !token.keyHandle) return false;
    if (this.directAccessMode === "disabled") return false;
    if (typeof location !== "undefined"
        && token.applicationOrigin
        && token.applicationOrigin !== location.origin) return false;
    return true;
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
          && body?.encrypted_protocol_version === 3) {
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
    if (this.route !== route) {
      this.route = route;
      this.emitConnection();
    }
  }

  private emitConnection(): void {
    const connection = this.connection();
    for (const listener of this.connectionListeners) listener(connection);
  }

  private currentToken(): StoredToken | null {
    const token = parseStored<StoredToken>(this.storage.getItem(this.tokenKey()));
    if (!token) return null;
    token.scope ??= { contracts: [] };
    if (token.expiresAt <= Date.now()
        && (!token.refreshToken || (token.refreshExpiresAt ?? 0) <= Date.now())) {
      // The cloud bearer and the local grant proof have separate lifetimes. Keep an
      // encrypted local grant usable while the connector still recognizes it; relay
      // use will require reauthorization, and revocation remains enforced locally.
      if (this.directCapable(token)) return token;
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
    if (!token.refreshToken || (token.refreshExpiresAt ?? 0) <= Date.now()) {
      if (this.directCapable(token)) {
        throw new MdbaseConnectError(
          "relay_authorization_expired",
          "Direct access is still available on this computer, but using the relay requires reconnecting this application."
        );
      }
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
    if ((current.refreshExpiresAt ?? 0) <= Date.now()) {
      throw new MdbaseConnectError(
        "relay_authorization_expired",
        "Direct access is still available on this computer, but using the relay requires reconnecting this application."
      );
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
      if (!this.directCapable(current)) {
        if (current.keyHandle) void this.keyStore.delete(current.keyHandle);
        this.storage.removeItem(this.tokenKey());
      }
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
      applicationOrigin: body.application_origin ?? new URL(this.manifestUrl).origin,
      keyHandle,
      hosted: body.hosted ? {
        providerUrl: body.hosted.provider_url,
        replicaId: body.hosted.replica_id,
        accessToken: body.hosted.access_token
      } : undefined
    };
    this.storage.setItem(this.tokenKey(), JSON.stringify(token));
    this.route = token.hosted ? "hosted" : "relay";
    this.directStatus = token.hosted || this.directAccessMode === "disabled"
      ? "disabled"
      : "unavailable";
    this.emitConnection();
    return token;
  }

  private pendingKey() { return `mdbase-connect:pending:${this.serverUrl}:${this.manifestUrl}`; }
  private tokenKey() { return `mdbase-connect:token:${this.serverUrl}:${this.manifestUrl}`; }
  private pendingMutationKey() {
    return `mdbase-connect:pending-mutation:${this.serverUrl}:${this.manifestUrl}`;
  }
  private clearPendingMutation(): void {
    this.storage.removeItem(this.pendingMutationKey());
  }
  private directPreferenceKey() {
    return `mdbase-connect:direct:${new URL(this.manifestUrl).origin}`;
  }
}

export class MdbaseConnectError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
  }
}

type LoopbackRequestInit = RequestInit & {
  targetAddressSpace?: "loopback";
};

function loopbackRequest(init: RequestInit): LoopbackRequestInit {
  return { ...init, credentials: "omit", targetAddressSpace: "loopback" };
}

async function localNetworkPermission(): Promise<PermissionState | null> {
  if (typeof navigator === "undefined" || !navigator.permissions?.query) return null;
  try {
    const status = await navigator.permissions.query({
      name: "local-network-access" as PermissionName
    });
    return status.state;
  } catch {
    return null;
  }
}

function directFallbackStatus(status: number): boolean {
  return status === 404 || status === 405 || status === 426 || status >= 500;
}

function isMutation(operation: CollectionOperation): boolean {
  return operation === "create"
    || operation === "update"
    || operation === "delete"
    || operation === "rename"
    || operation === "create_type"
    || operation === "update_type";
}

async function operationFingerprint(
  operation: CollectionOperation,
  input: unknown
): Promise<string> {
  const encoded = new TextEncoder().encode(`${operation}\0${canonicalJson(input ?? {})}`);
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  return bytesToBase64Url(new Uint8Array(digest));
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => sortJson(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, sortJson(item)])
    );
  }
  return value;
}

function uncertainDirectMutation(cause: unknown): MdbaseConnectError {
  const error = new MdbaseConnectError(
    "direct_outcome_unknown",
    "The direct write may have completed, and mdbase could not recover its receipt through the relay. Retry the exact same write to recover safely."
  );
  Object.defineProperty(error, "cause", { value: cause, configurable: true });
  return error;
}

function canonicalLoopbackUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:"
      || !["127.0.0.1", "[::1]"].includes(url.hostname)
      || url.username
      || url.password
      || url.pathname !== "/"
      || url.search
      || url.hash) {
    throw new MdbaseConnectError(
      "invalid_loopback_url",
      "loopbackUrl must be an HTTP origin on 127.0.0.1 or ::1."
    );
  }
  return url.origin;
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
