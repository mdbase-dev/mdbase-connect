import type {
  CollectionChange,
  CollectionChangesPage,
  CollectionDescription,
  CollectionOperation,
  CollectionTypeDocument,
  CreateViewSourceInput,
  DeleteViewSourceInput,
  DeleteViewSourceResult,
  ExecuteViewInput,
  FileCapability,
  GrantScope,
  JsonObject,
  ReadViewSourceInput,
  RecordDocument,
  SavedViewExecution,
  SavedViewList,
  SavedViewSourceDocument,
  ApplyTypePackInput,
  AssessTypePackInput,
  TypePackApplyResult,
  TypePackAssessment,
  UpdateViewSourceInput
} from "@mdbase-dev/connect-protocol";
import { MdbaseCollectionClient } from "./collection-client.js";
import {
  ConnectionNotifications
} from "./connection-notifications.js";
import {
  ConnectionTransport,
  type ConnectionTransportInternals
} from "./connection-transport.js";
import type {
  DirectAccessStatus,
  MdbaseAuthorizationCapabilities,
  MdbaseConnectionInfo,
  MdbaseConnectionRoute,
  MdbaseSyncConnection
} from "./connection-types.js";
import type { GrantKeyStore } from "./crypto.js";
import { MdbaseConnectError, connectError } from "./errors.js";
import { MdbaseFileClient } from "./files.js";
import {
  DEFAULT_OPERATIONS,
  type Application
} from "./internal-types.js";
import type {
  MdbaseNativeNotificationRegistration,
  MdbaseNativeNotificationRegistrationOptions,
  MdbaseNotificationRegistration,
  MdbaseNotificationRegistrationOptions
} from "./notifications.js";
import {
  assertDeletePreview,
  assertRenamePreview,
  deleteEstimate,
  isCancellation,
  renameEstimate,
  throwIfCancelled,
  uniqueOperations
} from "./operation-helpers.js";
import type {
  ChangesInput,
  CreateInput,
  CreateTypeInput,
  DeleteInput,
  DeletePreflightResult,
  DeleteProgressOptions,
  DeleteResult,
  MdbaseDesiredTimer,
  MdbaseTimer,
  MdbaseTimerList,
  MdbaseTimerReconciliation,
  MutationEstimate,
  MutationProgressState,
  OperationRequestOptions,
  PendingMutationSummary,
  QueryInput,
  QueryPage,
  QueryPagesOptions,
  QueryResult,
  ReadInput,
  ReadTypeInput,
  RenameInput,
  RenamePreflightResult,
  RenameProgressOptions,
  RenameResult,
  UpdateInput,
  UpdateTypeInput,
  WatchOptions
} from "./operation-types.js";
import {
  AUTHORIZATION_PROBLEM_CODES,
  COLLECTION_MUTATION_PROBLEM_CODES,
  DIRECT_ACCESS_PROBLEM_CODES,
  NOTIFICATION_PROBLEM_CODES,
  REGISTRATION_PROBLEM_CODES,
  captureConnectOutcome,
  connectFailure,
  connectSuccess,
  type AuthorizationProblemCode,
  type CollectionChangesProblemCode,
  type CollectionDescriptionProblemCode,
  type CollectionMutationProblemCode,
  type CollectionQueryProblemCode,
  type CollectionReadProblemCode,
  type CollectionTypeProblemCode,
  type ConnectOutcome,
  type DirectAccessProblemCode,
  type NotificationProblemCode,
  type RegistrationProblemCode
} from "./outcomes.js";
import type { MdbaseDeviceAuthorization } from "./authorization-types.js";

export type MdbaseAuthorizationTarget =
  | { kind: "choose" }
  | { kind: "collection"; collectionId: string };

export interface MdbaseAuthorizeOptions {
  operations?: CollectionOperation[];
  /** Choose any compatible collection, or require one exact collection. */
  target?: MdbaseAuthorizationTarget;
  /** App-local location to restore after the authorization callback. */
  returnTo?: string;
  /** Receives the short code even when the SDK also opens the approval page. */
  onDeviceCode?: (authorization: MdbaseDeviceAuthorization) => void;
  /** Replace the default popup for a downloaded application's approval page. */
  openVerification?: (authorization: MdbaseDeviceAuthorization) => void | Promise<void>;
  /** Stop polling and discard the unapproved, in-memory key. */
  signal?: AbortSignal;
}

export interface MdbaseConnectionAuthorizeOptions {
  operations?: CollectionOperation[];
  returnTo?: string;
  onDeviceCode?: (authorization: MdbaseDeviceAuthorization) => void;
  openVerification?: (authorization: MdbaseDeviceAuthorization) => void | Promise<void>;
  signal?: AbortSignal;
}

export interface MdbaseConnectEnvironment {
  distribution: "web" | "portable";
  applicationOrigin: string;
  credentialStorage: "persistent" | "memory" | "custom";
}

export interface MdbaseAuthorizationResult<Frontmatter extends JsonObject = JsonObject> {
  connection: MdbaseConnection<Frontmatter>;
  returnTo?: string;
}

export type MdbaseAuthorizationOutcome<Frontmatter extends JsonObject = JsonObject> =
  | { kind: "redirecting" }
  | ({ kind: "connected" } & MdbaseAuthorizationResult<Frontmatter>);

export interface MdbaseConnectionInternals<Frontmatter extends JsonObject>
  extends ConnectionTransportInternals {
  readonly serverUrl: string;
  readonly storage: Storage;
  readonly keyStore: GrantKeyStore;
  readonly directAccessMode: "auto" | "disabled";
  readonly loopbackUrl: string;
  register(): Promise<Application>;
  authorize(
    options?: MdbaseAuthorizeOptions
  ): Promise<MdbaseAuthorizationOutcome<Frontmatter>>;
  notificationKey(
    collectionId: string,
    transport?: "web_push" | "fcm"
  ): string;
}

export class MdbaseConnection<Frontmatter extends JsonObject = JsonObject> {
  private readonly collectionClient: MdbaseCollectionClient<Frontmatter>;
  private readonly notifications: ConnectionNotifications;
  private readonly transport: ConnectionTransport;
  readonly files: MdbaseFileClient;
  private readonly connectionListeners = new Set<(connection: MdbaseConnectionInfo | null) => void>();

  constructor(
    private readonly internals: MdbaseConnectionInternals<Frontmatter>,
    readonly collectionId: string
  ) {
    this.transport = new ConnectionTransport({
      serverUrl: internals.serverUrl,
      storage: internals.storage,
      keyStore: internals.keyStore,
      directAccessMode: internals.directAccessMode,
      loopbackUrl: internals.loopbackUrl,
      collectionId,
      internals,
      onChange: () => this.emitConnection()
    });
    this.files = new MdbaseFileClient(
      () => this.fileCapability,
      (method, path, input, signal) =>
        this.transport.files.control(method, path, input, signal),
      {
        uploadChunk: (session, chunkIndex, bytes, signal) =>
          this.transport.files.uploadChunk(session, chunkIndex, bytes, signal),
        downloadChunk: (session, chunkIndex, signal) =>
          this.transport.files.downloadChunk(session, chunkIndex, signal)
      },
      {
        downloadPart: (session, partIndex, expectedLength, signal) =>
          this.transport.files.downloadHostedPart(
            session,
            partIndex,
            expectedLength,
            signal
          )
      }
    );
    this.collectionClient = new MdbaseCollectionClient({
      operation: (operation, input, requestOptions) =>
        this.transport.performOperation(operation, input, requestOptions)
    });
    this.notifications = new ConnectionNotifications({
      serverUrl: internals.serverUrl,
      storage: internals.storage,
      authorizedToken: () => this.transport.authorizedToken(),
      register: () => this.internals.register(),
      notificationKey: (transport) =>
        internals.notificationKey(collectionId, transport)
    });
  }

  get displayName(): string {
    return this.transport.currentToken()?.collectionName
      ?? `Collection ${this.collectionId.slice(0, 8)}`;
  }

  get operations(): CollectionOperation[] {
    return [...(this.transport.currentToken()?.operations ?? [])];
  }

  get scope(): GrantScope | null {
    return this.transport.currentToken()?.scope ?? null;
  }

  get fileCapability(): FileCapability | null {
    return this.transport.currentToken()?.fileCapability ?? null;
  }

  get directAccess(): DirectAccessStatus {
    return this.transport.directAccess;
  }

  get route(): MdbaseConnectionRoute {
    return this.transport.route;
  }

  register(): Promise<ConnectOutcome<Application, RegistrationProblemCode>> {
    return captureConnectOutcome(
      () => this.internals.register(),
      REGISTRATION_PROBLEM_CODES
    );
  }

  info(): MdbaseConnectionInfo | null {
    const token = this.transport.currentToken();
    return token ? {
      collectionId: token.collectionId,
      displayName: token.collectionName,
      operations: [...token.operations],
      scope: token.scope,
      ...(token.fileCapability ? { fileCapability: token.fileCapability } : {}),
      route: this.transport.route,
      directAccess: this.transport.directAccess
    } : null;
  }

  authorizationCapabilities(
    requiredOperations: CollectionOperation[] = DEFAULT_OPERATIONS
  ): MdbaseAuthorizationCapabilities {
    const grantedOperations = this.operations;
    const missingOperations = uniqueOperations(requiredOperations)
      .filter((operation) => !grantedOperations.includes(operation));
    return {
      authorized: this.info() !== null,
      sufficient: this.info() !== null && missingOperations.length === 0,
      collectionId: this.collectionId,
      grantedOperations,
      missingOperations
    };
  }

  hasOperations(requiredOperations: CollectionOperation[]): boolean {
    return this.authorizationCapabilities(requiredOperations).sufficient;
  }

  authorize(
    options: MdbaseConnectionAuthorizeOptions = {}
  ): Promise<ConnectOutcome<MdbaseAuthorizationOutcome<Frontmatter>, AuthorizationProblemCode>> {
    return captureConnectOutcome(
      () => this.internals.authorize({
        ...options,
        target: { kind: "collection", collectionId: this.collectionId }
      }),
      AUTHORIZATION_PROBLEM_CODES
    );
  }

  async requestOperations(
    requiredOperations: CollectionOperation[],
    options: Omit<MdbaseConnectionAuthorizeOptions, "operations"> = {}
  ): Promise<
    ConnectOutcome<
      MdbaseAuthorizationOutcome<Frontmatter>
      | { kind: "unchanged"; connection: MdbaseConnection<Frontmatter> },
      AuthorizationProblemCode
    >
  > {
    const capabilities = this.authorizationCapabilities(requiredOperations);
    if (capabilities.sufficient) {
      return connectSuccess({ kind: "unchanged", connection: this });
    }
    return this.authorize({
      ...options,
      operations: uniqueOperations([
        ...capabilities.grantedOperations,
        ...capabilities.missingOperations
      ])
    });
  }

  onConnectionChange(listener: (connection: MdbaseConnectionInfo | null) => void): () => void {
    this.connectionListeners.add(listener);
    listener(this.info());
    return () => this.connectionListeners.delete(listener);
  }

  notifyStorageChanged(): void {
    this.transport.notifyStorageChanged();
  }

  checkDirectAccess(): Promise<ConnectOutcome<DirectAccessStatus, DirectAccessProblemCode>> {
    return captureConnectOutcome(
      () => this.transport.checkDirectAccess(),
      DIRECT_ACCESS_PROBLEM_CODES
    );
  }

  /** Call from a user gesture to request browser permission for direct local access. */
  requestDirectAccess(): Promise<ConnectOutcome<DirectAccessStatus, DirectAccessProblemCode>> {
    return captureConnectOutcome(
      () => this.transport.requestDirectAccess(),
      DIRECT_ACCESS_PROBLEM_CODES
    );
  }

  disableDirectAccess(): void {
    this.transport.disableDirectAccess();
  }

  /**
   * Return one offline-replication transport regardless of whether the
   * authority is remote, directly connected, or relay connected.
   * Authority credentials and routing stay private inside the SDK.
   */
  sync(): MdbaseSyncConnection<Frontmatter> | null {
    const token = this.transport.currentToken();
    if (!token) return null;
    const collectionId = token.collectionId;
    if (!token.authority) {
      if (!token.grantId || !token.operations.includes("sync")) return null;
      const replicaId = token.grantId;
      return {
        collectionId,
        replicaId,
        transport: {
          openSession: () => this.transport.performOperation("sync", { action: "open_session" }),
          snapshot: (snapshotId, page) => this.transport.performOperation("sync", {
            action: "snapshot",
            snapshot_id: snapshotId,
            ...(page ? { page } : {})
          }),
          changes: (after, limit = 200) => this.transport.performOperation("sync", {
            action: "changes",
            after,
            limit
          }),
          mutate: (mutation) => this.transport.performOperation("sync", {
            action: "mutate",
            mutation
          })
        }
      };
    }
    const replicaId = token.authority.replicaId;
    return {
      collectionId,
      replicaId,
      transport: {
        openSession: () => this.transport.performAuthoritySyncRequest(collectionId, replicaId, "POST", "sessions"),
        snapshot: (snapshotId, page) => {
          const query = new URLSearchParams({ snapshot_id: snapshotId });
          if (page) query.set("page", page);
          return this.transport.performAuthoritySyncRequest(collectionId, replicaId, "GET", `snapshot?${query}`);
        },
        changes: (after, limit = 200) => this.transport.performAuthoritySyncRequest(
          collectionId,
          replicaId,
          "GET",
          `changes?${new URLSearchParams({ after: String(after), limit: String(limit) })}`
        ),
        mutate: (mutation) => this.transport.performAuthoritySyncRequest(
          collectionId,
          replicaId,
          "POST",
          "mutations",
          mutation
        )
      }
    };
  }

  /**
   * Register this browser installation for manifest-declared Web Push.
   *
   * Criteria are evaluated by the collection authority. Push payloads contain
   * only an opaque cursor and static presentation copy.
   */
  registerNotifications(
    options: MdbaseNotificationRegistrationOptions
  ): Promise<ConnectOutcome<MdbaseNotificationRegistration, NotificationProblemCode>> {
    return captureConnectOutcome(
      () => this.notifications.registerNotifications(options),
      NOTIFICATION_PROBLEM_CODES
    );
  }

  registerNativeNotifications(
    options: MdbaseNativeNotificationRegistrationOptions
  ): Promise<ConnectOutcome<MdbaseNativeNotificationRegistration, NotificationProblemCode>> {
    return captureConnectOutcome(
      () => this.notifications.registerNativeNotifications(options),
      NOTIFICATION_PROBLEM_CODES
    );
  }

  unregisterNativeNotifications(): Promise<ConnectOutcome<void, NotificationProblemCode>> {
    return captureConnectOutcome(
      () => this.notifications.unregisterNativeNotifications(),
      NOTIFICATION_PROBLEM_CODES
    );
  }

  unregisterNotifications(
    serviceWorker?: ServiceWorkerRegistration
  ): Promise<ConnectOutcome<void, NotificationProblemCode>> {
    return captureConnectOutcome(
      () => this.notifications.unregisterNotifications(serviceWorker),
      NOTIFICATION_PROBLEM_CODES
    );
  }

  forget(): void {
    const token = this.transport.currentToken();
    this.internals.removeToken(this.collectionId, token?.keyHandle, "not_authorized");
    this.transport.notifyStorageChanged();
  }

  describe(): Promise<ConnectOutcome<CollectionDescription, CollectionDescriptionProblemCode>> {
    return this.collectionClient.describe();
  }

  changes(input: ChangesInput = {}, options?: OperationRequestOptions): Promise<ConnectOutcome<CollectionChangesPage, CollectionChangesProblemCode>> {
    return this.collectionClient.changes(input, options);
  }

  read(input: ReadInput): Promise<ConnectOutcome<RecordDocument<Frontmatter>, CollectionReadProblemCode>> {
    return this.collectionClient.read(input);
  }

  query(input: QueryInput = {}, options?: OperationRequestOptions): Promise<ConnectOutcome<QueryResult<Frontmatter>, CollectionQueryProblemCode>> {
    return this.collectionClient.query(input, options);
  }

  queryPages(input: QueryInput = {}, options: QueryPagesOptions<Frontmatter> = {}): AsyncGenerator<ConnectOutcome<QueryPage<Frontmatter>, CollectionQueryProblemCode>> {
    return this.collectionClient.queryPages(input, options);
  }

  queryAll(input: QueryInput = {}, options: QueryPagesOptions<Frontmatter> = {}): Promise<ConnectOutcome<QueryResult<Frontmatter>, CollectionQueryProblemCode>> {
    return this.collectionClient.queryAll(input, options);
  }

  listViews(): Promise<ConnectOutcome<SavedViewList, CollectionReadProblemCode>> {
    return this.collectionClient.listViews();
  }

  executeView(input: ExecuteViewInput): Promise<ConnectOutcome<SavedViewExecution<Frontmatter>, CollectionReadProblemCode>> {
    return this.collectionClient.executeView(input);
  }

  readViewSource(input: ReadViewSourceInput): Promise<ConnectOutcome<SavedViewSourceDocument, CollectionReadProblemCode>> {
    return this.collectionClient.readViewSource(input);
  }

  createViewSource(input: CreateViewSourceInput): Promise<ConnectOutcome<SavedViewSourceDocument, CollectionMutationProblemCode>> {
    return this.collectionClient.createViewSource(input);
  }

  updateViewSource(input: UpdateViewSourceInput): Promise<ConnectOutcome<SavedViewSourceDocument, CollectionMutationProblemCode>> {
    return this.collectionClient.updateViewSource(input);
  }

  deleteViewSource(input: DeleteViewSourceInput): Promise<ConnectOutcome<DeleteViewSourceResult, CollectionMutationProblemCode>> {
    return this.collectionClient.deleteViewSource(input);
  }

  create(input: CreateInput<Frontmatter>): Promise<ConnectOutcome<RecordDocument<Frontmatter>, CollectionMutationProblemCode>> {
    return this.collectionClient.create(input);
  }

  update(input: UpdateInput<Frontmatter>): Promise<ConnectOutcome<RecordDocument<Frontmatter>, CollectionMutationProblemCode>> {
    return this.collectionClient.update(input);
  }

  delete(input: DeleteInput, options?: OperationRequestOptions): Promise<ConnectOutcome<DeleteResult, CollectionMutationProblemCode>> {
    return this.collectionClient.delete(input, options);
  }

  preflightDelete(input: DeleteInput, options?: OperationRequestOptions): Promise<ConnectOutcome<DeletePreflightResult, CollectionMutationProblemCode>> {
    return this.collectionClient.preflightDelete(input, options);
  }

  rename(input: RenameInput, options?: OperationRequestOptions): Promise<ConnectOutcome<RenameResult, CollectionMutationProblemCode>> {
    return this.collectionClient.rename(input, options);
  }

  preflightRename(input: RenameInput, options?: OperationRequestOptions): Promise<ConnectOutcome<RenamePreflightResult, CollectionMutationProblemCode>> {
    return this.collectionClient.preflightRename(input, options);
  }

  async renameWithProgress(
    input: RenameInput,
    options: RenameProgressOptions = {}
  ): Promise<ConnectOutcome<RenameResult, CollectionMutationProblemCode>> {
    const started = Date.now();
    const resumed = this.pendingMutation()?.operation === "rename";
    let estimate: MutationEstimate | undefined;
    const emit = (state: MutationProgressState, cancellable: boolean, completedUnits = 0) => {
      options.onProgress?.({
        operation: "rename",
        state,
        elapsedMs: Date.now() - started,
        cancellable,
        resumed,
        completedUnits,
        ...(estimate ? { estimate } : {})
      });
    };
    try {
      throwIfCancelled(options.signal);
      emit("preflighting", true);
      const previewOutcome = options.preflight
        ? connectSuccess(options.preflight)
        : await this.preflightRename(input, { signal: options.signal });
      if (!previewOutcome.ok) return previewOutcome;
      const preview = previewOutcome.value;
      try {
        assertRenamePreview(input, preview);
      } catch (error) {
        if (error instanceof MdbaseConnectError) {
          return connectFailure(error.problem) as ConnectOutcome<RenameResult, CollectionMutationProblemCode>;
        }
        throw error;
      }
      estimate = renameEstimate(input, preview);
      emit("ready", true);
      throwIfCancelled(options.signal);
      const cancellable = this.transport.hasResumableMutationTransport();
      emit("applying", cancellable);
      const result = await this.rename(input, cancellable ? { signal: options.signal } : undefined);
      if (result.ok) emit("completed", false, estimate.totalUnits);
      return result;
    } catch (error) {
      if (isCancellation(error, options.signal)) emit("cancelled", false);
      if (error instanceof MdbaseConnectError) {
        return connectFailure(error.problem) as ConnectOutcome<RenameResult, CollectionMutationProblemCode>;
      }
      throw error;
    }
  }

  async deleteWithProgress(
    input: DeleteInput,
    options: DeleteProgressOptions = {}
  ): Promise<ConnectOutcome<DeleteResult, CollectionMutationProblemCode>> {
    const started = Date.now();
    const resumed = this.pendingMutation()?.operation === "delete";
    let estimate: MutationEstimate | undefined;
    const emit = (state: MutationProgressState, cancellable: boolean, completedUnits = 0) => {
      options.onProgress?.({
        operation: "delete",
        state,
        elapsedMs: Date.now() - started,
        cancellable,
        resumed,
        completedUnits,
        ...(estimate ? { estimate } : {})
      });
    };
    try {
      throwIfCancelled(options.signal);
      emit("preflighting", true);
      const previewOutcome = options.preflight
        ? connectSuccess(options.preflight)
        : await this.preflightDelete(input, { signal: options.signal });
      if (!previewOutcome.ok) return previewOutcome;
      const preview = previewOutcome.value;
      try {
        assertDeletePreview(input, preview);
      } catch (error) {
        if (error instanceof MdbaseConnectError) {
          return connectFailure(error.problem) as ConnectOutcome<DeleteResult, CollectionMutationProblemCode>;
        }
        throw error;
      }
      estimate = deleteEstimate(preview);
      emit("ready", true);
      throwIfCancelled(options.signal);
      const cancellable = this.transport.hasResumableMutationTransport();
      emit("applying", cancellable);
      const result = await this.delete(input, cancellable ? { signal: options.signal } : undefined);
      if (result.ok) emit("completed", false, estimate.totalUnits);
      return result;
    } catch (error) {
      if (isCancellation(error, options.signal)) emit("cancelled", false);
      if (error instanceof MdbaseConnectError) {
        return connectFailure(error.problem) as ConnectOutcome<DeleteResult, CollectionMutationProblemCode>;
      }
      throw error;
    }
  }

  pendingMutation(): PendingMutationSummary | null {
    return this.transport.pendingMutation();
  }

  resumePendingMutation<Result>(
    input: unknown,
    options?: OperationRequestOptions
  ): Promise<ConnectOutcome<Result, CollectionMutationProblemCode>> {
    return captureConnectOutcome(
      () => this.transport.resumePendingMutation<Result>(input, options),
      COLLECTION_MUTATION_PROBLEM_CODES
    );
  }

  validate(input: JsonObject = {}): Promise<ConnectOutcome<JsonObject, CollectionReadProblemCode>> {
    return this.collectionClient.validate(input);
  }

  readType(input: ReadTypeInput): Promise<ConnectOutcome<CollectionTypeDocument, CollectionTypeProblemCode>> {
    return this.collectionClient.readType(input);
  }

  createType(input: CreateTypeInput): Promise<ConnectOutcome<CollectionTypeDocument, CollectionTypeProblemCode>> {
    return this.collectionClient.createType(input);
  }

  updateType(input: UpdateTypeInput): Promise<ConnectOutcome<CollectionTypeDocument, CollectionTypeProblemCode>> {
    return this.collectionClient.updateType(input);
  }

  assessTypePack(input: AssessTypePackInput): Promise<ConnectOutcome<TypePackAssessment, CollectionTypeProblemCode>> {
    return this.collectionClient.assessTypePack(input);
  }

  applyTypePack(input: ApplyTypePackInput): Promise<ConnectOutcome<TypePackApplyResult, CollectionTypeProblemCode>> {
    return this.collectionClient.applyTypePack(input);
  }

  listTimers(namespace: string): Promise<ConnectOutcome<MdbaseTimerList, CollectionReadProblemCode>> {
    return this.collectionClient.listTimers(namespace);
  }

  putTimer(input: {
    namespace: string;
    criterion_id: string;
    timer: MdbaseDesiredTimer;
  }): Promise<ConnectOutcome<MdbaseTimer, CollectionMutationProblemCode>> {
    return this.collectionClient.putTimer(input);
  }

  cancelTimer(input: {
    namespace: string;
    id: string;
    generation?: number;
  }): Promise<ConnectOutcome<{ namespace: string; id: string; cancelled: boolean }, CollectionMutationProblemCode>> {
    return this.collectionClient.cancelTimer(input);
  }

  reconcileTimers(input: {
    namespace: string;
    criterion_id: string;
    timers: MdbaseDesiredTimer[];
  }): Promise<ConnectOutcome<MdbaseTimerReconciliation, CollectionMutationProblemCode>> {
    return this.collectionClient.reconcileTimers(input);
  }

  watch(options: WatchOptions = {}): AsyncGenerator<ConnectOutcome<CollectionChange, CollectionChangesProblemCode>> {
    return this.collectionClient.watch(options);
  }

  operation<Result>(
    operation: CollectionOperation,
    input: unknown,
    options?: OperationRequestOptions
  ): Promise<ConnectOutcome<Result>> {
    return this.collectionClient.operation(operation, input, options);
  }

  private emitConnection(): void {
    const connection = this.info();
    for (const listener of this.connectionListeners) listener(connection);
  }
}
