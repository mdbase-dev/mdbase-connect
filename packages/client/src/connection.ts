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
  GrantScope,
  JsonObject,
  MdbaseOperationEnvelope,
  ReadViewSourceInput,
  RecordDocument,
  SavedViewExecution,
  SavedViewList,
  SavedViewSourceDocument,
  TypePackInstallResult,
  TypePackProvision,
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
import { MdbaseConnectError, unwrapOperation } from "./errors.js";
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
    this.collectionClient = new MdbaseCollectionClient({
      operation: (operation, input, requestOptions) =>
        this.transport.performOperation(operation, input, requestOptions)
    });
    this.notifications = new ConnectionNotifications({
      serverUrl: internals.serverUrl,
      storage: internals.storage,
      authorizedToken: () => this.transport.authorizedToken(),
      register: () => this.register(),
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

  get scope(): GrantScope {
    const scope = this.transport.currentToken()?.scope;
    if (!scope) {
      throw new MdbaseConnectError(
        "not_authorized",
        "This collection is no longer authorized for this application."
      );
    }
    return scope;
  }

  get directAccess(): DirectAccessStatus {
    return this.transport.directAccess;
  }

  get route(): MdbaseConnectionRoute {
    return this.transport.route;
  }

  register(): Promise<Application> {
    return this.internals.register();
  }

  info(): MdbaseConnectionInfo | null {
    const token = this.transport.currentToken();
    return token ? {
      collectionId: token.collectionId,
      displayName: token.collectionName,
      operations: [...token.operations],
      scope: token.scope,
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
  ): Promise<MdbaseAuthorizationOutcome<Frontmatter>> {
    return this.internals.authorize({
      ...options,
      target: { kind: "collection", collectionId: this.collectionId }
    });
  }

  async requestOperations(
    requiredOperations: CollectionOperation[],
    options: Pick<MdbaseConnectionAuthorizeOptions, "returnTo"> = {}
  ): Promise<
    MdbaseAuthorizationOutcome<Frontmatter>
    | { kind: "unchanged"; connection: MdbaseConnection<Frontmatter> }
  > {
    const capabilities = this.authorizationCapabilities(requiredOperations);
    if (capabilities.sufficient) return { kind: "unchanged", connection: this };
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

  checkDirectAccess(): Promise<DirectAccessStatus> {
    return this.transport.checkDirectAccess();
  }

  /** Call from a user gesture to request browser permission for direct local access. */
  requestDirectAccess(): Promise<DirectAccessStatus> {
    return this.transport.requestDirectAccess();
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
  ): Promise<MdbaseNotificationRegistration> {
    return this.notifications.registerNotifications(options);
  }

  registerNativeNotifications(
    options: MdbaseNativeNotificationRegistrationOptions
  ): Promise<MdbaseNativeNotificationRegistration> {
    return this.notifications.registerNativeNotifications(options);
  }

  unregisterNativeNotifications(): Promise<void> {
    return this.notifications.unregisterNativeNotifications();
  }

  unregisterNotifications(
    serviceWorker?: ServiceWorkerRegistration
  ): Promise<void> {
    return this.notifications.unregisterNotifications(serviceWorker);
  }

  forget(): void {
    const token = this.transport.currentToken();
    this.internals.removeToken(this.collectionId, token?.keyHandle, "not_authorized");
    this.transport.notifyStorageChanged();
  }

  describe(): Promise<CollectionDescription> {
    return this.collectionClient.describe();
  }

  changes(input: ChangesInput = {}, options?: OperationRequestOptions): Promise<CollectionChangesPage> {
    return this.collectionClient.changes(input, options);
  }

  read(input: ReadInput): Promise<MdbaseOperationEnvelope<RecordDocument<Frontmatter>>> {
    return this.collectionClient.read(input);
  }

  query(input: QueryInput = {}, options?: OperationRequestOptions): Promise<MdbaseOperationEnvelope<QueryResult<Frontmatter>>> {
    return this.collectionClient.query(input, options);
  }

  queryPages(input: QueryInput = {}, options: QueryPagesOptions<Frontmatter> = {}): AsyncGenerator<QueryPage<Frontmatter>> {
    return this.collectionClient.queryPages(input, options);
  }

  queryAll(input: QueryInput = {}, options: QueryPagesOptions<Frontmatter> = {}): Promise<QueryResult<Frontmatter>> {
    return this.collectionClient.queryAll(input, options);
  }

  listViews(): Promise<MdbaseOperationEnvelope<SavedViewList>> {
    return this.collectionClient.listViews();
  }

  executeView(input: ExecuteViewInput): Promise<MdbaseOperationEnvelope<SavedViewExecution<Frontmatter>>> {
    return this.collectionClient.executeView(input);
  }

  readViewSource(input: ReadViewSourceInput): Promise<MdbaseOperationEnvelope<SavedViewSourceDocument>> {
    return this.collectionClient.readViewSource(input);
  }

  createViewSource(input: CreateViewSourceInput): Promise<MdbaseOperationEnvelope<SavedViewSourceDocument>> {
    return this.collectionClient.createViewSource(input);
  }

  updateViewSource(input: UpdateViewSourceInput): Promise<MdbaseOperationEnvelope<SavedViewSourceDocument>> {
    return this.collectionClient.updateViewSource(input);
  }

  deleteViewSource(input: DeleteViewSourceInput): Promise<MdbaseOperationEnvelope<DeleteViewSourceResult>> {
    return this.collectionClient.deleteViewSource(input);
  }

  create(input: CreateInput<Frontmatter>): Promise<MdbaseOperationEnvelope<RecordDocument<Frontmatter>>> {
    return this.collectionClient.create(input);
  }

  update(input: UpdateInput<Frontmatter>): Promise<MdbaseOperationEnvelope<RecordDocument<Frontmatter>>> {
    return this.collectionClient.update(input);
  }

  delete(input: DeleteInput, options?: OperationRequestOptions): Promise<MdbaseOperationEnvelope<DeleteResult>> {
    return this.collectionClient.delete(input, options);
  }

  preflightDelete(input: DeleteInput, options?: OperationRequestOptions): Promise<MdbaseOperationEnvelope<DeletePreflightResult>> {
    return this.collectionClient.preflightDelete(input, options);
  }

  rename(input: RenameInput, options?: OperationRequestOptions): Promise<MdbaseOperationEnvelope<RenameResult>> {
    return this.collectionClient.rename(input, options);
  }

  preflightRename(input: RenameInput, options?: OperationRequestOptions): Promise<MdbaseOperationEnvelope<RenamePreflightResult>> {
    return this.collectionClient.preflightRename(input, options);
  }

  async renameWithProgress(
    input: RenameInput,
    options: RenameProgressOptions = {}
  ): Promise<MdbaseOperationEnvelope<RenameResult>> {
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
      const preview = options.preflight ?? unwrapOperation(await this.preflightRename(input, {
        signal: options.signal
      }));
      assertRenamePreview(input, preview);
      estimate = renameEstimate(input, preview);
      emit("ready", true);
      throwIfCancelled(options.signal);
      const cancellable = this.transport.hasResumableMutationTransport();
      emit("applying", cancellable);
      const result = await this.rename(input, cancellable ? { signal: options.signal } : undefined);
      emit("completed", false, estimate.totalUnits);
      return result;
    } catch (error) {
      if (isCancellation(error, options.signal)) emit("cancelled", false);
      throw error;
    }
  }

  async deleteWithProgress(
    input: DeleteInput,
    options: DeleteProgressOptions = {}
  ): Promise<MdbaseOperationEnvelope<DeleteResult>> {
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
      const preview = options.preflight ?? unwrapOperation(await this.preflightDelete(input, {
        signal: options.signal
      }));
      assertDeletePreview(input, preview);
      estimate = deleteEstimate(preview);
      emit("ready", true);
      throwIfCancelled(options.signal);
      const cancellable = this.transport.hasResumableMutationTransport();
      emit("applying", cancellable);
      const result = await this.delete(input, cancellable ? { signal: options.signal } : undefined);
      emit("completed", false, estimate.totalUnits);
      return result;
    } catch (error) {
      if (isCancellation(error, options.signal)) emit("cancelled", false);
      throw error;
    }
  }

  pendingMutation(): PendingMutationSummary | null {
    return this.transport.pendingMutation();
  }

  async resumePendingMutation<Result>(
    input: unknown,
    options?: OperationRequestOptions
  ): Promise<Result> {
    return this.transport.resumePendingMutation<Result>(input, options);
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

  installTypePack(input: TypePackProvision): Promise<MdbaseOperationEnvelope<TypePackInstallResult>> {
    return this.collectionClient.installTypePack(input);
  }

  listTimers(namespace: string): Promise<MdbaseTimerList> {
    return this.collectionClient.listTimers(namespace);
  }

  putTimer(input: {
    namespace: string;
    criterion_id: string;
    timer: MdbaseDesiredTimer;
  }): Promise<MdbaseTimer> {
    return this.collectionClient.putTimer(input);
  }

  cancelTimer(input: {
    namespace: string;
    id: string;
    generation?: number;
  }): Promise<{ namespace: string; id: string; cancelled: boolean }> {
    return this.collectionClient.cancelTimer(input);
  }

  reconcileTimers(input: {
    namespace: string;
    criterion_id: string;
    timers: MdbaseDesiredTimer[];
  }): Promise<MdbaseTimerReconciliation> {
    return this.collectionClient.reconcileTimers(input);
  }

  async *watch(options: WatchOptions = {}): AsyncGenerator<CollectionChange> {
    yield* this.collectionClient.watch(options);
  }

  async operation<Result>(
    operation: CollectionOperation,
    input: unknown,
    options?: OperationRequestOptions
  ): Promise<Result> {
    return this.collectionClient.operation(operation, input, options);
  }

  private emitConnection(): void {
    const connection = this.info();
    for (const listener of this.connectionListeners) listener(connection);
  }
}
