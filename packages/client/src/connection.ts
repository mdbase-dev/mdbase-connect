import { MdbasePeopleClient, requestPeople } from "./people-client.js";
import type {
  CollectionOperation,
  CollectionDescription as WireCollectionDescription,
  CollectionTypeDocument,
  FileCapability,
  GrantScope,
  JsonObject,
  MdbaseOperationEnvelope
} from "@mdbase-dev/connect-protocol";
import {
  capabilityOperationsForContractVersion
} from "@mdbase-dev/connect-protocol";
import {
  retainedCapabilities,
  semanticContractVersion,
  validateAuthorizationSelection,
  type MdbaseApplicationCapabilityId as ApplicationCapabilityId
} from "./application-contract.js";
import { MdbaseCollectionClient } from "./collection-client.js";
import { AuthorityFeatures, authorityCapabilities } from "./authority-features.js";
import { filePage } from "./file-metadata.js";
import { wireCollectionDescription } from "./query-wire.js";
import { CollectionWatchSubscription } from "./watch-policy.js";
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
import {
  MdbaseConnectError,
  connectError,
  connectProblem,
  operationProblem
} from "./errors.js";
import { MdbaseFileClient } from "./files.js";
import { MdbaseRecords } from "./records.js";
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
  CollectionChange,
  CollectionChangesPage,
  DescribeOptions,
  CollectionDescription,
  CollectionSetupApplyResult,
  CollectionSetupAssessment,
  ApplyCollectionSetupInput,
  ApplyTypePackInput,
  AssessCollectionSetupInput,
  AssessTypePackInput,
  CreateInput,
  CreateTypeInput,
  CreateViewSourceInput,
  DeleteInput,
  DeletePreflightResult,
  DeleteProgressOptions,
  DeleteResult,
  DeleteViewSourceInput,
  DeleteViewSourceResult,
  ExecuteViewInput,
  MdbaseDesiredTimer,
  MdbaseTimer,
  MdbaseTimerList,
  MdbaseTimerReconciliation,
  MutationEstimate,
  MutationProgressState,
  ConnectRequestOptions,
  PendingMutation,
  QueryAllOptions,
  QueryInput,
  QueryMetadataInput,
  QueryMetadataRecord,
  QueryMetadataResult,
  QueryMetadataPage,
  QueryPage,
  QueryPagesOptions,
  QueryResult,
  ReadInput,
  ReadTypeInput,
  ReadViewSourceInput,
  RenameInput,
  RenamePreflightResult,
  RenameProgressOptions,
  RenameResult,
  RecordDocument,
  SavedViewExecution,
  SavedViewPage,
  SavedViewPagesOptions,
  SavedViewList,
  SavedViewSourceDocument,
  TypePackApplyResult,
  TypePackAssessment,
  UpdateInput,
  UpdateTypeInput,
  UpdateViewSourceInput,
  MdbaseWatchSubscription,
  WatchInput
} from "./operation-types.js";
import {
  AUTHORIZATION_PROBLEM_CODES,
  COLLECTION_CHANGES_PROBLEM_CODES,
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
import type { MdbaseDeviceAuthorization } from "./connection-types.js";
import {
  type ResolvedConnectTimeouts,
  withCooperativeRequestBudget,
  withRequestBudget
} from "./request-budget.js";
import { CollectionRequestCoordinator } from "./request-coordinator.js";

export type MdbaseAuthorizationTarget =
  | { kind: "choose" }
  | { kind: "collection"; collectionId: string };

export interface MdbaseAuthorizeOptions extends ConnectRequestOptions {
  /** Exact independent operations, for legacy v1 declarations only. Cannot be mixed with capabilities. */
  operations?: CollectionOperation[];
  /** Capability groups to request. Required groups are always included; optional groups default to all. */
  capabilities?: ApplicationCapabilityId[];
  /** Keep a web application loaded while Connect owns the approval ceremony. */
  presentation?: "redirect" | "popup";
  /** Choose any compatible collection, or require one exact collection. */
  target?: MdbaseAuthorizationTarget;
  /** App-local location to restore after the authorization callback. */
  returnTo?: string;
  /** Receives the short code even when the SDK also opens the approval page. */
  onDeviceCode?: (authorization: MdbaseDeviceAuthorization) => void;
  /** Replace the default popup for a downloaded application's approval page. */
  openVerification?: (authorization: MdbaseDeviceAuthorization) => void | Promise<void>;
}

export interface MdbaseConnectionAuthorizeOptions extends ConnectRequestOptions {
  /** Exact independent operations, for legacy v1 declarations only. */
  operations?: CollectionOperation[];
  /** Capability groups to request. Required groups are always included; optional groups default to all. */
  capabilities?: ApplicationCapabilityId[];
  presentation?: "redirect" | "popup";
  returnTo?: string;
  onDeviceCode?: (authorization: MdbaseDeviceAuthorization) => void;
  openVerification?: (authorization: MdbaseDeviceAuthorization) => void | Promise<void>;
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
  readonly timeouts: ResolvedConnectTimeouts;
  register(options?: ConnectRequestOptions): Promise<Application>;
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
  private readonly authorityFeatures: AuthorityFeatures;
  readonly files: MdbaseFileClient;
  /** Editable record sessions shared by every view of this connection. */
  readonly records: MdbaseRecords<Frontmatter>;
  readonly people: MdbasePeopleClient;
  readonly readMany: MdbaseCollectionClient<Frontmatter>["readMany"];
  readonly observe: MdbaseCollectionClient<Frontmatter>["observe"];
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
      timeouts: internals.timeouts,
      onChange: () => {
        this.authorityFeatures.refreshLifetime();
        this.emitConnection();
      }
    });
    this.authorityFeatures = new AuthorityFeatures({
      lifetime: () => {
        const token = this.transport.currentToken();
        return JSON.stringify([token?.savedAt, token?.grantId, token?.keyHandle,
          token?.authority?.operationsUrl, token?.authority?.filesUrl, token?.authority?.replicaId,
          token?.authority?.proofPublicKey, token?.clientId, token?.applicationOrigin,
          token?.encryption, token?.scope, token?.operations, token?.fileCapability, this.transport.route]);
      },
      operations: () => this.operations,
      fileCapability: () => this.fileCapability,
      // Catalog TTL/in-flight loads are not evidence for a new authority route.
      // B1 owns this authenticated baseline's sharing, deadline and lifetime.
      describe: async options => {
        const value = wireCollectionDescription(await this.transport.performOperation<WireCollectionDescription>("describe", {}, options));
        if (value.collectionId.toLowerCase() !== this.collectionId.toLowerCase()) throw connectError("invalid_operation_response", "The authority described a different collection.");
        return connectSuccess(value);
      },
      filesPage: async (folder, signal) => {
        const page = await filePage((method, path, input, signal) => this.transport.files.control(method, path, input, signal),
          new URLSearchParams({ protocol_version: "1", limit: "1", ...(folder ? { folder } : {}) }), signal);
        return authorityCapabilities(page.authority_capabilities);
      }
    }, internals.timeouts.requestMs);
    this.people = new MdbasePeopleClient({
      request: (resource, options) => requestPeople(resource, options ?? {}, {
        serverUrl: internals.serverUrl, collectionId, requestMs: internals.timeouts.requestMs,
        authorizedToken: (signal) => this.transport.authorizedToken({ signal, timeoutMs: null })
      }),
      describe: (options) => this.describe(options),
      queryPages: (input, options) => this.queryPages(input, options as QueryPagesOptions<Frontmatter>) as AsyncIterable<ConnectOutcome<QueryPage, CollectionQueryProblemCode>>
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
      },
      internals.timeouts,
      (id, options) => this.supportsAuthorityFeature(id, options)
    );
    this.records = new MdbaseRecords(this, (path) => this.transport.pendingUpdate(path));
    this.collectionClient = new MdbaseCollectionClient(new CollectionRequestCoordinator({
      operation: (operation, input, requestOptions) =>
        this.transport.performOperation(operation, input, requestOptions)
    }, internals.timeouts.requestMs), internals.timeouts.requestMs,
      (id, options) => this.supportsAuthorityFeature(id, options));
    this.readMany = this.collectionClient.readMany.bind(this.collectionClient);
    this.observe = this.collectionClient.observe.bind(this.collectionClient);
    this.notifications = new ConnectionNotifications({
      serverUrl: internals.serverUrl,
      storage: internals.storage,
      authorizedToken: (signal) => this.transport.authorizedToken({ signal, timeoutMs: null }),
      register: (signal) => this.internals.register({ signal, timeoutMs: null }),
      notificationKey: (transport) =>
        internals.notificationKey(collectionId, transport),
      requestTimeoutMs: internals.timeouts.requestMs
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

  /** Implementation support for this connection lifetime; not an authorization check. */
  supportsAuthorityFeature(id: string, options?: ConnectRequestOptions): Promise<ConnectOutcome<boolean>> {
    return this.authorityFeatures.supports(id, options);
  }

  get authorityCapabilities(): readonly string[] { return this.authorityFeatures.capabilities; }

  register(options?: ConnectRequestOptions): Promise<ConnectOutcome<Application, RegistrationProblemCode>> {
    return captureConnectOutcome(
      () => this.internals.register(options),
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
      authority: token.authority
        ? { kind: "hosted", durability: "provider" }
        : { kind: "connector", durability: "computer" },
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

  async requestCapabilities(
    capabilities: ApplicationCapabilityId[],
    options: MdbaseConnectionAuthorizeOptions = {}
  ): Promise<
    ConnectOutcome<
      MdbaseAuthorizationOutcome<Frontmatter>
      | { kind: "unchanged"; connection: MdbaseConnection<Frontmatter> },
      AuthorizationProblemCode
    >
  > {
    return captureConnectOutcome(async () => {
      const application = await this.internals.register(options);
      validateAuthorizationSelection(application.requirements, { ...options, capabilities });
      const sufficient = this.info() !== null && capabilities.every((capability) =>
        (capabilityOperationsForContractVersion(semanticContractVersion(application.requirements), capability) ?? [])
          .every((operation) => this.operations.includes(operation))
      );
      if (sufficient) return { kind: "unchanged" as const, connection: this };
      if (semanticContractVersion(application.requirements) === 1) {
        const { capabilities: _selection, ...legacyOptions } = options;
        return this.internals.authorize({
          ...legacyOptions,
          target: { kind: "collection", collectionId: this.collectionId },
          operations: [...new Set([...this.operations, ...capabilities.flatMap(
            (id) => capabilityOperationsForContractVersion(1, id) ?? []
          )])]
        });
      }
      const retained = retainedCapabilities(application.requirements, this.operations);
      return this.internals.authorize({
        ...options,
        target: { kind: "collection", collectionId: this.collectionId },
        capabilities: [...new Set([...retained, ...capabilities])]
      });
    }, AUTHORIZATION_PROBLEM_CODES);
  }

  async requestOperations(
    requiredOperations: CollectionOperation[],
    options: Omit<MdbaseConnectionAuthorizeOptions, "operations"> = {}
  ): Promise<ConnectOutcome<MdbaseAuthorizationOutcome<Frontmatter> | { kind: "unchanged"; connection: MdbaseConnection<Frontmatter> }, AuthorizationProblemCode>> {
    return captureConnectOutcome(async () => {
      const application = await this.internals.register(options);
      validateAuthorizationSelection(application.requirements, { ...options, operations: requiredOperations });
      const authorization = this.authorizationCapabilities(requiredOperations);
      if (authorization.sufficient) return { kind: "unchanged" as const, connection: this };
      return this.internals.authorize({
        ...options,
        target: { kind: "collection", collectionId: this.collectionId },
        operations: [...new Set([...authorization.grantedOperations, ...requiredOperations])]
      });
    }, AUTHORIZATION_PROBLEM_CODES);
  }

  onConnectionChange(listener: (connection: MdbaseConnectionInfo | null) => void): () => void {
    this.connectionListeners.add(listener);
    listener(this.info());
    return () => this.connectionListeners.delete(listener);
  }

  notifyStorageChanged(): void {
    this.authorityFeatures.invalidate();
    this.transport.notifyStorageChanged();
  }

  checkDirectAccess(options?: ConnectRequestOptions): Promise<ConnectOutcome<DirectAccessStatus, DirectAccessProblemCode>> {
    return captureConnectOutcome(
      () => this.transport.checkDirectAccess(options),
      DIRECT_ACCESS_PROBLEM_CODES
    );
  }

  /** Call from a user gesture to request browser permission for direct local access. */
  requestDirectAccess(options?: ConnectRequestOptions): Promise<ConnectOutcome<DirectAccessStatus, DirectAccessProblemCode>> {
    return captureConnectOutcome(
      () => this.transport.requestDirectAccess(options),
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
          openSession: (options) => this.transport.performOperation("sync", { action: "open_session" }, syncRequestOptions(options, this.internals.timeouts.syncMs)),
          snapshot: (snapshotId, page, options) => this.transport.performOperation("sync", {
            action: "snapshot",
            snapshot_id: snapshotId,
            ...(page ? { page } : {})
          }, syncRequestOptions(options, this.internals.timeouts.syncMs)),
          changes: (after, limit = 200, options) => this.transport.performOperation("sync", {
            action: "changes",
            after,
            limit
          }, syncRequestOptions(options, this.internals.timeouts.syncMs)),
          mutate: (mutation, options) => this.transport.performOperation("sync", {
            action: "mutate",
            mutation
          }, syncRequestOptions(options, this.internals.timeouts.syncMs))
        }
      };
    }
    const replicaId = token.authority.replicaId;
    return {
      collectionId,
      replicaId,
      transport: {
        openSession: (options) => this.transport.performAuthoritySyncRequest(collectionId, replicaId, "POST", "sessions", undefined, options),
        snapshot: (snapshotId, page, options) => {
          const query = new URLSearchParams({ snapshot_id: snapshotId });
          if (page) query.set("page", page);
          return this.transport.performAuthoritySyncRequest(collectionId, replicaId, "GET", `snapshot?${query}`, undefined, options);
        },
        changes: (after, limit = 200, options) => this.transport.performAuthoritySyncRequest(
          collectionId,
          replicaId,
          "GET",
          `changes?${new URLSearchParams({ after: String(after), limit: String(limit) })}`,
          undefined,
          options
        ),
        mutate: (mutation, options) => this.transport.performAuthoritySyncRequest(
          collectionId,
          replicaId,
          "POST",
          "mutations",
          mutation,
          options
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

  unregisterNativeNotifications(options?: ConnectRequestOptions): Promise<ConnectOutcome<void, NotificationProblemCode>> {
    return captureConnectOutcome(
      () => this.notifications.unregisterNativeNotifications(options),
      NOTIFICATION_PROBLEM_CODES
    );
  }

  unregisterNotifications(
    serviceWorker?: ServiceWorkerRegistration,
    options?: ConnectRequestOptions
  ): Promise<ConnectOutcome<void, NotificationProblemCode>> {
    return captureConnectOutcome(
      () => this.notifications.unregisterNotifications(serviceWorker, options),
      NOTIFICATION_PROBLEM_CODES
    );
  }

  forget(): void {
    const token = this.transport.currentToken();
    this.internals.removeToken(this.collectionId, token?.keyHandle, "not_authorized", true);
    this.transport.notifyStorageChanged();
  }

  get schemaGeneration(): number { return this.collectionClient.schemaGeneration; }
  async describe(options?: DescribeOptions): Promise<ConnectOutcome<CollectionDescription, CollectionDescriptionProblemCode>> {
    const outcome = await this.collectionClient.describe(options);
    if (outcome.ok && outcome.value.collectionId.toLowerCase() !== this.collectionId.toLowerCase()) {
      return connectFailure(connectProblem("invalid_operation_response", "The authority described a different collection."));
    }
    return outcome;
  }

  changes(input: ChangesInput = {}, options?: ConnectRequestOptions): Promise<ConnectOutcome<CollectionChangesPage, CollectionChangesProblemCode>> {
    return this.collectionClient.changes(input, options);
  }

  read(input: ReadInput, options?: ConnectRequestOptions): Promise<ConnectOutcome<RecordDocument<Frontmatter>, CollectionReadProblemCode>> {
    return this.collectionClient.read(input, options);
  }

  query(input: QueryMetadataInput, options?: ConnectRequestOptions): Promise<ConnectOutcome<QueryMetadataResult, CollectionQueryProblemCode>>;
  query(input?: QueryInput, options?: ConnectRequestOptions): Promise<ConnectOutcome<QueryResult<Frontmatter>, CollectionQueryProblemCode>>;
  query(input: QueryInput | QueryMetadataInput = {}, options?: ConnectRequestOptions): Promise<ConnectOutcome<QueryResult<Frontmatter> | QueryMetadataResult, CollectionQueryProblemCode>> {
    return this.collectionClient.query(input, options);
  }

  queryPages(input: QueryMetadataInput, options?: QueryPagesOptions<JsonObject, QueryMetadataRecord>): AsyncGenerator<ConnectOutcome<QueryMetadataPage, CollectionQueryProblemCode>>;
  queryPages(input?: QueryInput, options?: QueryPagesOptions<Frontmatter>): AsyncGenerator<ConnectOutcome<QueryPage<Frontmatter>, CollectionQueryProblemCode>>;
  queryPages(input: QueryInput | QueryMetadataInput = {}, options: QueryPagesOptions<Frontmatter> | QueryPagesOptions<JsonObject, QueryMetadataRecord> = {}) {
    return input.output === "metadata"
      ? this.collectionClient.queryPages(input, options as QueryPagesOptions<JsonObject, QueryMetadataRecord>)
      : this.collectionClient.queryPages(input, options as QueryPagesOptions<Frontmatter>);
  }

  queryAll(input: QueryMetadataInput, options?: QueryAllOptions<JsonObject, QueryMetadataRecord>): Promise<ConnectOutcome<QueryMetadataResult, CollectionQueryProblemCode>>;
  queryAll(input?: QueryInput, options?: QueryAllOptions<Frontmatter>): Promise<ConnectOutcome<QueryResult<Frontmatter>, CollectionQueryProblemCode>>;
  queryAll(input: QueryInput | QueryMetadataInput = {}, options: QueryAllOptions<Frontmatter> | QueryAllOptions<JsonObject, QueryMetadataRecord> = {}): Promise<ConnectOutcome<QueryResult<Frontmatter> | QueryMetadataResult, CollectionQueryProblemCode>> {
    return input.output === "metadata"
      ? this.collectionClient.queryAll(input, options as QueryAllOptions<JsonObject, QueryMetadataRecord>)
      : this.collectionClient.queryAll(input, options as QueryAllOptions<Frontmatter>);
  }

  listViews(options?: ConnectRequestOptions): Promise<ConnectOutcome<SavedViewList, CollectionReadProblemCode>> {
    return this.collectionClient.listViews(options);
  }

  executeView(input: ExecuteViewInput, options?: ConnectRequestOptions): Promise<ConnectOutcome<SavedViewExecution<Frontmatter>, CollectionReadProblemCode>> {
    return this.collectionClient.executeView(input, options);
  }

  executeViewPages(input: ExecuteViewInput, options: SavedViewPagesOptions<Frontmatter> = {}): AsyncGenerator<ConnectOutcome<SavedViewPage<Frontmatter>, CollectionReadProblemCode>> {
    return this.collectionClient.executeViewPages(input, options);
  }

  readViewSource(input: ReadViewSourceInput, options?: ConnectRequestOptions): Promise<ConnectOutcome<SavedViewSourceDocument, CollectionReadProblemCode>> {
    return this.collectionClient.readViewSource(input, options);
  }

  createViewSource(input: CreateViewSourceInput, options?: ConnectRequestOptions): Promise<ConnectOutcome<SavedViewSourceDocument, CollectionMutationProblemCode>> {
    return this.collectionClient.createViewSource(input, options);
  }

  updateViewSource(input: UpdateViewSourceInput, options?: ConnectRequestOptions): Promise<ConnectOutcome<SavedViewSourceDocument, CollectionMutationProblemCode>> {
    return this.collectionClient.updateViewSource(input, options);
  }

  deleteViewSource(input: DeleteViewSourceInput, options?: ConnectRequestOptions): Promise<ConnectOutcome<DeleteViewSourceResult, CollectionMutationProblemCode>> {
    return this.collectionClient.deleteViewSource(input, options);
  }

  create(input: CreateInput<Frontmatter>, options?: ConnectRequestOptions): Promise<ConnectOutcome<RecordDocument<Frontmatter>, CollectionMutationProblemCode>> {
    return this.collectionClient.create(input, options);
  }

  update(input: UpdateInput<Frontmatter>, options?: ConnectRequestOptions): Promise<ConnectOutcome<RecordDocument<Frontmatter>, CollectionMutationProblemCode>> {
    return this.collectionClient.update(input, options);
  }

  delete(input: DeleteInput, options?: ConnectRequestOptions): Promise<ConnectOutcome<DeleteResult, CollectionMutationProblemCode>> {
    return this.collectionClient.delete(input, options);
  }

  preflightDelete(input: DeleteInput, options?: ConnectRequestOptions): Promise<ConnectOutcome<DeletePreflightResult, CollectionMutationProblemCode>> {
    return this.collectionClient.preflightDelete(input, options);
  }

  rename(input: RenameInput, options?: ConnectRequestOptions): Promise<ConnectOutcome<RenameResult, CollectionMutationProblemCode>> {
    return this.collectionClient.rename(input, options);
  }

  preflightRename(input: RenameInput, options?: ConnectRequestOptions): Promise<ConnectOutcome<RenamePreflightResult, CollectionMutationProblemCode>> {
    return this.collectionClient.preflightRename(input, options);
  }

  async renameWithProgress(
    input: RenameInput,
    options: RenameProgressOptions = {}
  ): Promise<ConnectOutcome<RenameResult, CollectionMutationProblemCode>> {
    return withCooperativeRequestBudget(options, this.internals.timeouts.requestMs, async (budget) => {
      const started = Date.now();
      const resumed = false;
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
        throwIfCancelled(budget.signal);
        emit("preflighting", true);
        const previewOutcome = options.preflight
          ? connectSuccess(options.preflight)
          : await this.preflightRename(input, { signal: budget.signal, timeoutMs: null });
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
        throwIfCancelled(budget.signal);
        const cancellable = this.transport.hasResumableMutationTransport();
        emit("applying", cancellable);
        const result = await this.rename(
          input,
          cancellable
            ? { signal: budget.signal, timeoutMs: null }
            : { timeoutMs: remainingTimeout(budget.remainingMs()) }
        );
        if (result.ok) emit("completed", false, estimate.totalUnits);
        return result;
      } catch (error) {
        if (isCancellation(error, budget.signal)) emit("cancelled", false);
        if (error instanceof MdbaseConnectError) {
          return connectFailure(error.problem) as ConnectOutcome<RenameResult, CollectionMutationProblemCode>;
        }
        throw error;
      }
    });
  }

  async deleteWithProgress(
    input: DeleteInput,
    options: DeleteProgressOptions = {}
  ): Promise<ConnectOutcome<DeleteResult, CollectionMutationProblemCode>> {
    return withCooperativeRequestBudget(options, this.internals.timeouts.requestMs, async (budget) => {
      const started = Date.now();
      const resumed = false;
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
        throwIfCancelled(budget.signal);
        emit("preflighting", true);
        const previewOutcome = options.preflight
          ? connectSuccess(options.preflight)
          : await this.preflightDelete(input, { signal: budget.signal, timeoutMs: null });
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
        throwIfCancelled(budget.signal);
        const cancellable = this.transport.hasResumableMutationTransport();
        emit("applying", cancellable);
        const result = await this.delete(
          input,
          cancellable
            ? { signal: budget.signal, timeoutMs: null }
            : { timeoutMs: remainingTimeout(budget.remainingMs()) }
        );
        if (result.ok) emit("completed", false, estimate.totalUnits);
        return result;
      } catch (error) {
        if (isCancellation(error, budget.signal)) emit("cancelled", false);
        if (error instanceof MdbaseConnectError) {
          return connectFailure(error.problem) as ConnectOutcome<DeleteResult, CollectionMutationProblemCode>;
        }
        throw error;
      }
    });
  }

  pendingMutations<Result = unknown>(): readonly PendingMutation<Result>[] {
    return this.transport.pendingMutations().map((summary) => ({
      ...summary,
      recover: (options) => captureConnectOutcome(
        () => this.recoverPendingMutation<Result>(summary.requestId, options),
        COLLECTION_MUTATION_PROBLEM_CODES
      )
    }));
  }

  pendingMutation<Result = unknown>(requestId: string): PendingMutation<Result> | null {
    const summary = this.transport.pendingMutation(requestId);
    if (!summary) return null;
    return {
      ...summary,
      recover: (options) => captureConnectOutcome(
        () => this.recoverPendingMutation<Result>(requestId, options),
        COLLECTION_MUTATION_PROBLEM_CODES
      )
    };
  }

  private async recoverPendingMutation<Result>(
    requestId: string,
    options?: ConnectRequestOptions
  ): Promise<Result> {
    const result = await this.transport.recoverPendingMutation<unknown>(requestId, options);
    if (result && typeof result === "object" && "valid" in result) {
      const envelope = result as MdbaseOperationEnvelope<Result>;
      if (!envelope.valid) throw new MdbaseConnectError(operationProblem(envelope));
      return envelope.result;
    }
    return result as Result;
  }

  validate(input: JsonObject = {}, options?: ConnectRequestOptions): Promise<ConnectOutcome<JsonObject, CollectionReadProblemCode>> {
    return this.collectionClient.validate(input, options);
  }

  readType(input: ReadTypeInput, options?: ConnectRequestOptions): Promise<ConnectOutcome<CollectionTypeDocument, CollectionTypeProblemCode>> {
    return this.collectionClient.readType(input, options);
  }

  createType(input: CreateTypeInput, options?: ConnectRequestOptions): Promise<ConnectOutcome<CollectionTypeDocument, CollectionTypeProblemCode>> {
    return this.collectionClient.createType(input, options);
  }

  updateType(input: UpdateTypeInput, options?: ConnectRequestOptions): Promise<ConnectOutcome<CollectionTypeDocument, CollectionTypeProblemCode>> {
    return this.collectionClient.updateType(input, options);
  }

  assessTypePack(input: AssessTypePackInput, options?: ConnectRequestOptions): Promise<ConnectOutcome<TypePackAssessment, CollectionTypeProblemCode>> {
    return this.collectionClient.assessTypePack(input, options);
  }

  applyTypePack(input: ApplyTypePackInput, options?: ConnectRequestOptions): Promise<ConnectOutcome<TypePackApplyResult, CollectionTypeProblemCode>> {
    return this.collectionClient.applyTypePack(input, options);
  }

  assessCollectionSetup(input: AssessCollectionSetupInput, options?: ConnectRequestOptions): Promise<ConnectOutcome<CollectionSetupAssessment, CollectionTypeProblemCode>> {
    return this.collectionClient.assessCollectionSetup(input, options);
  }

  applyCollectionSetup(input: ApplyCollectionSetupInput, options?: ConnectRequestOptions): Promise<ConnectOutcome<CollectionSetupApplyResult, CollectionTypeProblemCode>> {
    return this.collectionClient.applyCollectionSetup(input, options);
  }

  listTimers(namespace: string, options?: ConnectRequestOptions): Promise<ConnectOutcome<MdbaseTimerList, CollectionReadProblemCode>> {
    return this.collectionClient.listTimers(namespace, options);
  }

  putTimer(input: {
    namespace: string;
    criterionId: string;
    timer: MdbaseDesiredTimer;
  }, options?: ConnectRequestOptions): Promise<ConnectOutcome<MdbaseTimer, CollectionMutationProblemCode>> {
    return this.collectionClient.putTimer(input, options);
  }

  cancelTimer(input: {
    namespace: string;
    id: string;
    generation?: number;
  }, options?: ConnectRequestOptions): Promise<ConnectOutcome<{ namespace: string; id: string; cancelled: boolean }, CollectionMutationProblemCode>> {
    return this.collectionClient.cancelTimer(input, options);
  }

  reconcileTimers(input: {
    namespace: string;
    criterionId: string;
    timers: MdbaseDesiredTimer[];
  }, options?: ConnectRequestOptions): Promise<ConnectOutcome<MdbaseTimerReconciliation, CollectionMutationProblemCode>> {
    return this.collectionClient.reconcileTimers(input, options);
  }

  watch(
    input: WatchInput = {},
    options: ConnectRequestOptions = {}
  ): Promise<ConnectOutcome<MdbaseWatchSubscription, CollectionChangesProblemCode>> {
    return captureConnectOutcome(
      () => withRequestBudget(options, this.internals.timeouts.watchStartMs, async (budget) => {
        const initial = await this.collectionClient.changes(
          input.cursor === undefined ? {} : { after: input.cursor, limit: 200 },
          { signal: budget.signal, timeoutMs: null }
        );
        if (!initial.ok) throw new MdbaseConnectError(initial.problem);
        if (initial.value.reset) {
          throw new MdbaseConnectError(connectProblem(
            "change_cursor_reset",
            "The collection change cursor expired. Refresh collection state before subscribing again."
          ));
        }
        return new CollectionWatchSubscription(
          options => this.collectionClient.watch(options),
          initial.value.cursor,
          input,
          input.cursor === undefined ? [] : initial.value.events,
          this.internals.timeouts.watchStartMs
        );
      }),
      COLLECTION_CHANGES_PROBLEM_CODES
    );
  }

  private emitConnection(): void {
    const connection = this.info();
    for (const listener of this.connectionListeners) listener(connection);
  }
}

function syncRequestOptions(
  options: ConnectRequestOptions | undefined,
  defaultTimeoutMs: number | null
): ConnectRequestOptions {
  return {
    ...options,
    timeoutMs: options?.timeoutMs === undefined ? defaultTimeoutMs : options.timeoutMs
  };
}

function remainingTimeout(remainingMs: number | null): number | null {
  return remainingMs === null ? null : Math.max(1, Math.ceil(remainingMs));
}
