import type {
  ApplicationNotifications,
  CollectionChange,
  CollectionChangesPage,
  CollectionDescription,
  CollectionFileMetadata,
  CollectionOperation,
  CollectionTypeDocument,
  CreateViewSourceInput,
  DeleteViewSourceInput,
  DeleteViewSourceResult,
  EncryptedRelayOperationRequest,
  EncryptedRelayOperationResponse,
  ExecuteViewInput,
  GrantEncryption,
  GrantScope,
  JsonObject,
  MdbaseAppManifest,
  MdbaseDiagnostic,
  MdbaseOperationEnvelope,
  MdbaseOperationRequest,
  QueryRecord,
  RecordDocument,
  ReadViewSourceInput,
  SavedViewExecution,
  SavedViewList,
  SavedViewSourceDocument,
  SyncChangesPage,
  SyncMutation,
  SyncMutationReceipt,
  SyncSession,
  SyncSnapshotPage,
  TypePackInstallResult,
  TypePackProvision,
  UpdateViewSourceInput
} from "@mdbase/connect-protocol";
import {
  DEFAULT_LOOPBACK_PORT,
  ENCRYPTED_RELAY_PROTOCOL_VERSION,
  RELAY_ENCRYPTION_SUITE
} from "@mdbase/connect-protocol";
import {
  decryptRelayResponse,
  encryptRelayRequest,
  IndexedDbGrantKeyStore,
  MemoryGrantKeyStore,
  RelayCryptoError,
  signAuthorityRequest,
  validateGrantEncryption,
  type GrantKeyStore
} from "./crypto.js";

export {
  decryptRelayResponse,
  encryptRelayRequest,
  IndexedDbGrantKeyStore,
  MemoryGrantKeyStore,
  RelayCryptoError,
  type RelayBinding,
  type GrantKeyRecord,
  type GrantKeyStore
} from "./crypto.js";

export type {
  ApplicationProvisions,
  ApplicationRequirements,
  ApplicationNotifications,
  CollectionChange,
  CollectionChangesPage,
  CollectionContractDescriptor,
  CollectionDescription,
  CollectionFileMetadata,
  CollectionOperation as MdbaseOperation,
  CollectionTypeDescriptor,
  CollectionTypeDocument,
  ContractRequirement,
  DataContractViewIdentity,
  GrantScope,
  JsonObject,
  MdbaseAppManifest,
  NotificationCriterion,
  MdbaseDiagnostic,
  MdbaseOperationEnvelope,
  RecordDocument,
  QueryRecord,
  SavedNamedView,
  SavedViewDocument,
  SavedViewExecution,
  SavedViewList,
  SavedViewPresentation,
  SavedViewProperty,
  SavedViewSource,
  SavedViewSourceDocument,
  ReadViewSourceInput,
  CreateViewSourceInput,
  UpdateViewSourceInput,
  DeleteViewSourceInput,
  DeleteViewSourceResult,
  ExecuteViewInput,
  TypePackManifest,
  TypePackManifestResource,
  TypePackInstallResult,
  TypePackProvision,
  TypePackResourceDiff,
  TypePackSourceResource
} from "@mdbase/connect-protocol";

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

export type MdbaseConnectionRoute = "remote" | "direct" | "relay";
export type DirectAccessStatus =
  | "disabled"
  | "permission_required"
  | "checking"
  | "available"
  | "unavailable"
  | "denied";

export interface MdbaseConnectionInfo {
  collectionId: string;
  displayName: string;
  operations: CollectionOperation[];
  scope: GrantScope;
  route: MdbaseConnectionRoute;
  directAccess: DirectAccessStatus;
}

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

export interface MdbaseDeviceAuthorization {
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresAt: number;
  intervalSeconds: number;
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

export interface MdbaseDesiredTimer {
  /** Stable within the timer namespace. */
  id: string;
  /** RFC 3339 instant at which the authority should fire the timer. */
  fire_at: string;
  /** Private application data retained by the collection authority. */
  data?: unknown;
}

export interface MdbaseTimer extends MdbaseDesiredTimer {
  criterion_id: string;
  generation: number;
  status: "scheduled" | "firing" | "fired" | "cancelled";
  created_at: string;
  updated_at: string;
  fired_at: string | null;
}

export interface MdbaseTimerList {
  namespace: string;
  timers: MdbaseTimer[];
}

export interface MdbaseTimerReconciliation extends MdbaseTimerList {
  cancelled_ids: string[];
}

export interface MdbaseAuthorizationCapabilities {
  authorized: boolean;
  sufficient: boolean;
  collectionId?: string;
  grantedOperations: CollectionOperation[];
  missingOperations: CollectionOperation[];
}

export interface MdbaseSyncTransport<Frontmatter extends JsonObject = JsonObject> {
  openSession(): Promise<SyncSession>;
  snapshot(snapshotId: string, page?: string): Promise<SyncSnapshotPage<Frontmatter>>;
  changes(after: number, limit?: number): Promise<SyncChangesPage<Frontmatter>>;
  mutate(mutation: SyncMutation): Promise<SyncMutationReceipt<Frontmatter>>;
}

export interface MdbaseSyncConnection<Frontmatter extends JsonObject = JsonObject> {
  collectionId: string;
  replicaId: string;
  transport: MdbaseSyncTransport<Frontmatter>;
}

export interface MdbaseNotificationRegistrationOptions {
  serviceWorker: ServiceWorkerRegistration;
  /** Manifest criterion IDs to enable. Omit to enable every declared criterion. */
  criteria?: string[];
  /** Stable per-installation ID. The SDK persists one when omitted. */
  installationId?: string;
}

export interface MdbaseNotificationRegistration {
  channelId: string;
  installationId: string;
  criteria: string[];
}

export interface MdbaseNativeNotificationRegistrationOptions {
  /** Current FCM registration token. Refresh by calling this method again. */
  token: string;
  /** Manifest criterion IDs to enable. Omit to enable every declared criterion. */
  criteria?: string[];
  /** Stable per-installation ID. The SDK persists one when omitted. */
  installationId?: string;
}

export interface MdbaseNativeNotificationRegistration
  extends MdbaseNotificationRegistration {
  transport: "fcm";
}

export interface MdbaseNativeNotificationData {
  type: "mdbase.notification";
  version: 1;
  signal_id: string;
  criterion_id: string;
  cursor: string;
}

export interface MdbasePushPayload {
  type: "mdbase.notification";
  version: 1;
  signal_id: string;
  criterion_id: string;
  cursor: string;
  presentation: {
    title: string;
    body?: string;
    tag?: string;
  };
}

export function parseMdbasePushPayload(value: unknown): MdbasePushPayload {
  if (!value || typeof value !== "object") {
    throw new MdbaseConnectError("invalid_push_payload", "The push payload is not an object.");
  }
  const payload = value as Partial<MdbasePushPayload>;
  if (
    payload.type !== "mdbase.notification"
    || payload.version !== 1
    || typeof payload.signal_id !== "string"
    || typeof payload.criterion_id !== "string"
    || typeof payload.cursor !== "string"
    || !payload.presentation
    || typeof payload.presentation.title !== "string"
  ) {
    throw new MdbaseConnectError("invalid_push_payload", "The push payload is not an mdbase notification.");
  }
  return payload as MdbasePushPayload;
}

/** Parse the string-valued data attached to an APNs/FCM notification. */
export function parseMdbaseNativeNotificationData(
  value: unknown
): MdbaseNativeNotificationData {
  if (!value || typeof value !== "object") {
    throw new MdbaseConnectError(
      "invalid_push_payload",
      "The native notification data is not an object."
    );
  }
  const data = value as Record<string, unknown>;
  if (
    data.type !== "mdbase.notification"
    || (data.version !== 1 && data.version !== "1")
    || typeof data.signal_id !== "string"
    || typeof data.criterion_id !== "string"
    || typeof data.cursor !== "string"
  ) {
    throw new MdbaseConnectError(
      "invalid_push_payload",
      "The native notification data is not an mdbase notification."
    );
  }
  return {
    type: "mdbase.notification",
    version: 1,
    signal_id: data.signal_id,
    criterion_id: data.criterion_id,
    cursor: data.cursor
  };
}

/** Display a validated mdbase push from a service worker `push` handler. */
export function showMdbasePushNotification(
  registration: Pick<ServiceWorkerRegistration, "showNotification">,
  value: unknown
): Promise<void> {
  const payload = parseMdbasePushPayload(value);
  return registration.showNotification(payload.presentation.title, {
    ...(payload.presentation.body ? { body: payload.presentation.body } : {}),
    ...(payload.presentation.tag ? { tag: payload.presentation.tag } : {}),
    data: {
      type: payload.type,
      signal_id: payload.signal_id,
      criterion_id: payload.criterion_id,
      cursor: payload.cursor
    }
  });
}

export interface ReadInput {
  path: string;
  /** Select an exact approved contract view when more than one is possible. */
  contract?: DataContractSelector;
  /** Include the exact UTF-8 Markdown source; requires full-collection access. */
  include_document?: boolean;
}

export interface DataContractSelector {
  id: string;
  version: string;
  /** Required when several approved types implement the selected contract. */
  type?: string;
}

export interface QueryInput {
  /**
   * Contract-scoped queries accept only `types`, pagination,
   * `frontmatter_mode`, and `contract`; filter normalized fields in the app.
   */
  types?: string[];
  where?: unknown;
  order_by?: unknown;
  limit?: number;
  offset?: number;
  /** Opaque token returned by the first metadata page for consistent, fast pagination. */
  snapshot?: string;
  include_body?: boolean;
  frontmatter_mode?: "effective" | "persisted" | "both";
  /** Narrow a contract-scoped query to one exact contract/provider view. */
  contract?: DataContractSelector;
  [key: string]: unknown;
}

export interface QueryResult<Record extends JsonObject = JsonObject> {
  results: Array<QueryRecord<Record> & JsonObject>;
  meta?: {
    total_count: number;
    has_more: boolean;
    snapshot?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface QueryPagesOptions<Record extends JsonObject = JsonObject> {
  firstPageSize?: number;
  pageSize?: number;
  signal?: AbortSignal;
  onProgress?: (page: QueryPage<Record>) => void;
}

export interface QueryPage<Record extends JsonObject = JsonObject> {
  results: QueryResult<Record>["results"];
  meta?: QueryResult<Record>["meta"];
  page: number;
  offset: number;
  loaded: number;
  complete: boolean;
  snapshot?: string;
}

export interface OperationRequestOptions {
  signal?: AbortSignal;
}

export interface MutationEstimate {
  /** Records whose links may be affected, excluding the record being mutated. */
  affectedRecords: number;
  /** Estimated atomic changes: the mutation itself plus known reference updates. */
  totalUnits: number;
  warnings: number;
}

export type MutationProgressState = "preflighting" | "ready" | "applying" | "completed" | "cancelled";

export interface MutationProgress {
  operation: "rename" | "delete";
  state: MutationProgressState;
  elapsedMs: number;
  cancellable: boolean;
  resumed: boolean;
  completedUnits: number;
  estimate?: MutationEstimate;
}

export interface MutationProgressOptions {
  signal?: AbortSignal;
  onProgress?: (progress: MutationProgress) => void;
}

export interface RenameProgressOptions extends MutationProgressOptions {
  /** Reuse an authoritative preview already shown to the user. */
  preflight?: RenamePreflightResult;
}

export interface DeleteProgressOptions extends MutationProgressOptions {
  /** Reuse an authoritative preview already shown to the user. */
  preflight?: DeletePreflightResult;
}

export interface PendingMutationSummary {
  operation: CollectionOperation;
  createdAt: number;
  resumable: true;
}

export interface CreateInput<Frontmatter extends JsonObject = JsonObject> {
  path?: string;
  type?: string;
  contract?: DataContractSelector;
  frontmatter?: Partial<Frontmatter> & JsonObject;
  /** Requires full-collection access; contract creates are frontmatter-only. */
  body?: string;
  if_revision?: string;
  /** Include the resulting exact Markdown source in `result.document`. */
  include_document?: boolean;
}

interface UpdateInputBase {
  path: string;
  contract?: DataContractSelector;
  if_revision?: string;
  /** Include the resulting exact Markdown source; requires full-collection access. */
  include_document?: boolean;
}

export type UpdateInput<Frontmatter extends JsonObject = JsonObject> = UpdateInputBase & (
  | {
    patch: Partial<Frontmatter> & JsonObject;
    body?: string;
    document?: never;
  }
  | {
    /**
     * Replace the complete Markdown source. This is mutually exclusive with
     * `patch` and `body`, and implies `include_document`.
     */
    document: string;
    patch?: never;
    body?: never;
  }
);

export interface DeleteInput {
  path: string;
  contract?: DataContractSelector;
  check_backlinks?: boolean;
  if_revision?: string;
}

export interface DeleteResult {
  path: string;
  deleted: boolean;
  broken_links?: Array<{ path: string }>;
}

export interface DeletePreflightResult {
  path: string;
  deleted: false;
  dry_run: true;
  would_delete: true;
  broken_links?: Array<{ path: string }>;
}

export interface RenameInput {
  from: string;
  to: string;
  contract?: DataContractSelector;
  update_refs?: boolean;
  if_revision?: string;
  /** Include the resulting exact Markdown source in `result.document`. */
  include_document?: boolean;
}

export interface RenameResult extends RecordDocument {
  from: string;
  to: string;
  references_updated?: JsonObject[];
}

export interface RenamePreflightResult {
  from: string;
  to: string;
  dry_run: true;
  would_rename: true;
  references_affected?: Array<{ path: string; field?: string; location?: string }>;
  warnings?: Array<{ path: string; message: string }>;
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
  /** Set to false to surface transient transport failures immediately. */
  retry?: false | WatchRetryOptions;
  onStatus?: (status: WatchStatus) => void;
}

export interface WatchRetryOptions {
  initialDelayMs?: number;
  maxDelayMs?: number;
  multiplier?: number;
  /** Number of consecutive transient failures. Omit to keep reconnecting. */
  maxAttempts?: number;
}

export type WatchStatus =
  | { state: "connecting"; cursor?: number }
  | { state: "connected"; cursor: number; recovered: boolean }
  | { state: "reconnecting"; cursor?: number; attempt: number; retryInMs: number; error: unknown }
  | { state: "reset_required"; cursor: number; error: MdbaseConnectError };

/** Provider-neutral operation transport used by the typed collection client. */
export interface MdbaseCollectionTransport {
  operation<Result>(operation: CollectionOperation, input: unknown, options?: OperationRequestOptions): Promise<Result>;
}

/**
 * Typed collection operations independent of OAuth, HTTP, or storage.
 *
 * Application code can use this surface against Connect, the developer
 * sandbox, or another provider without changing its record logic.
 */
export class MdbaseCollectionClient<Frontmatter extends JsonObject = JsonObject> {
  constructor(private readonly transport: MdbaseCollectionTransport) {}

  operation<Result>(operation: CollectionOperation, input: unknown, options?: OperationRequestOptions): Promise<Result> {
    return this.transport.operation(operation, input, options);
  }

  describe(): Promise<CollectionDescription> {
    return this.operation("describe", {});
  }

  changes(input: ChangesInput = {}, options?: OperationRequestOptions): Promise<CollectionChangesPage> {
    return this.operation("changes", input, options);
  }

  read(input: ReadInput): Promise<MdbaseOperationEnvelope<RecordDocument<Frontmatter>>> {
    return this.operation("read", input);
  }

  query(input: QueryInput = {}, options?: OperationRequestOptions): Promise<MdbaseOperationEnvelope<QueryResult<Frontmatter>>> {
    return this.operation("query", input, options);
  }

  async *queryPages(input: QueryInput = {}, options: QueryPagesOptions<Frontmatter> = {}): AsyncGenerator<QueryPage<Frontmatter>> {
    const {
      offset: requestedOffset,
      limit: requestedLimit,
      snapshot: requestedSnapshot,
      ...criteria
    } = input;
    let offset = nonNegativeInteger(requestedOffset, 0);
    const firstPageSize = positiveInteger(options.firstPageSize ?? requestedLimit, 200);
    const pageSize = positiveInteger(options.pageSize ?? requestedLimit, 1_000);
    let snapshot = requestedSnapshot;
    let loaded = 0;
    let pageNumber = 0;

    while (!options.signal?.aborted) {
      const result = unwrapOperation(await this.query({
        ...criteria,
        offset,
        limit: pageNumber === 0 ? firstPageSize : pageSize,
        ...(snapshot ? { snapshot } : {})
      }, { signal: options.signal }));
      const returnedSnapshot = result.meta?.snapshot;
      if (snapshot && returnedSnapshot && snapshot !== returnedSnapshot) {
        throw new MdbaseConnectError(
          "query_snapshot_changed",
          "The collection query snapshot changed while paging. Refresh the query before continuing.",
          { recovery: "refresh" }
        );
      }
      if (!snapshot && returnedSnapshot) snapshot = returnedSnapshot;
      loaded += result.results.length;
      const complete = !result.meta?.has_more || result.results.length === 0;
      const page: QueryPage<Frontmatter> = {
        results: result.results,
        ...(result.meta ? { meta: result.meta } : {}),
        page: pageNumber,
        offset,
        loaded,
        complete,
        ...(snapshot ? { snapshot } : {})
      };
      options.onProgress?.(page);
      yield page;
      if (complete) return;
      offset += result.results.length;
      pageNumber += 1;
    }
  }

  async queryAll(input: QueryInput = {}, options: QueryPagesOptions<Frontmatter> = {}): Promise<QueryResult<Frontmatter>> {
    const results: QueryResult<Frontmatter>["results"] = [];
    let finalPage: QueryPage<Frontmatter> | undefined;
    for await (const page of this.queryPages(input, options)) {
      results.push(...page.results);
      finalPage = page;
    }
    return {
      results,
      meta: {
        ...(finalPage?.meta ?? {}),
        total_count: finalPage?.meta?.total_count ?? results.length,
        has_more: finalPage ? !finalPage.complete : false,
        ...(finalPage?.snapshot ? { snapshot: finalPage.snapshot } : {})
      }
    };
  }

  listViews(): Promise<MdbaseOperationEnvelope<SavedViewList>> {
    return this.operation("list_views", {});
  }

  executeView(input: ExecuteViewInput): Promise<MdbaseOperationEnvelope<SavedViewExecution<Frontmatter>>> {
    return this.operation("execute_view", input);
  }

  readViewSource(input: ReadViewSourceInput): Promise<MdbaseOperationEnvelope<SavedViewSourceDocument>> {
    return this.operation("read_view_source", input);
  }

  createViewSource(input: CreateViewSourceInput): Promise<MdbaseOperationEnvelope<SavedViewSourceDocument>> {
    return this.operation("create_view_source", input);
  }

  updateViewSource(input: UpdateViewSourceInput): Promise<MdbaseOperationEnvelope<SavedViewSourceDocument>> {
    return this.operation("update_view_source", input);
  }

  deleteViewSource(input: DeleteViewSourceInput): Promise<MdbaseOperationEnvelope<DeleteViewSourceResult>> {
    return this.operation("delete_view_source", input);
  }

  create(input: CreateInput<Frontmatter>): Promise<MdbaseOperationEnvelope<RecordDocument<Frontmatter>>> {
    return this.operation("create", input);
  }

  update(input: UpdateInput<Frontmatter>): Promise<MdbaseOperationEnvelope<RecordDocument<Frontmatter>>> {
    return this.operation("update", input);
  }

  delete(input: DeleteInput, options?: OperationRequestOptions): Promise<MdbaseOperationEnvelope<DeleteResult>> {
    return this.operation("delete", input, options);
  }

  preflightDelete(input: DeleteInput, options?: OperationRequestOptions): Promise<MdbaseOperationEnvelope<DeletePreflightResult>> {
    return this.operation("delete", { ...input, check_backlinks: true, dry_run: true }, options);
  }

  rename(input: RenameInput, options?: OperationRequestOptions): Promise<MdbaseOperationEnvelope<RenameResult>> {
    return this.operation("rename", input, options);
  }

  preflightRename(input: RenameInput, options?: OperationRequestOptions): Promise<MdbaseOperationEnvelope<RenamePreflightResult>> {
    return this.operation("rename", { ...input, dry_run: true }, options);
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

  installTypePack(input: TypePackProvision): Promise<MdbaseOperationEnvelope<TypePackInstallResult>> {
    return this.operation("install_type_pack", input);
  }

  listTimers(namespace: string): Promise<MdbaseTimerList> {
    return this.operation("list_timers", { namespace });
  }

  putTimer(input: {
    namespace: string;
    criterion_id: string;
    timer: MdbaseDesiredTimer;
  }): Promise<MdbaseTimer> {
    return this.operation("put_timer", input);
  }

  cancelTimer(input: {
    namespace: string;
    id: string;
    generation?: number;
  }): Promise<{ namespace: string; id: string; cancelled: boolean }> {
    return this.operation("cancel_timer", input);
  }

  reconcileTimers(input: {
    namespace: string;
    criterion_id: string;
    timers: MdbaseDesiredTimer[];
  }): Promise<MdbaseTimerReconciliation> {
    return this.operation("reconcile_timers", input);
  }

  async *watch(options: WatchOptions = {}): AsyncGenerator<CollectionChange> {
    let cursor = options.cursor;
    const pollInterval = Math.max(100, options.pollIntervalMs ?? 1_000);
    const retry = watchRetryPolicy(options.retry);
    let failures = 0;
    let connected = false;
    options.onStatus?.({ state: "connecting", ...(cursor === undefined ? {} : { cursor }) });
    while (!options.signal?.aborted) {
      try {
        if (cursor === undefined) cursor = (await this.changes({}, { signal: options.signal })).cursor;
        const page = await this.changes({ after: cursor, limit: 200 }, { signal: options.signal });
        if (page.reset) {
          const error = new MdbaseConnectError(
            "change_cursor_reset",
            "The collection change cursor expired. Refresh collection state before subscribing again."
          );
          options.onStatus?.({ state: "reset_required", cursor, error });
          throw error;
        }
        const recovered = failures > 0;
        failures = 0;
        if (!connected || recovered) options.onStatus?.({ state: "connected", cursor, recovered });
        connected = true;
        for (const event of page.events) yield event;
        cursor = page.cursor;
        if (!page.has_more) await abortableDelay(pollInterval, options.signal);
      } catch (error) {
        if (options.signal?.aborted) return;
        if (!retry || !isRetryableConnectError(error)) throw error;
        connected = false;
        failures += 1;
        if (retry.maxAttempts !== undefined && failures > retry.maxAttempts) throw error;
        const retryInMs = Math.min(
          retry.maxDelayMs,
          Math.round(retry.initialDelayMs * retry.multiplier ** (failures - 1))
        );
        options.onStatus?.({
          state: "reconnecting",
          ...(cursor === undefined ? {} : { cursor }),
          attempt: failures,
          retryInMs,
          error
        });
        await abortableDelay(retryInMs, options.signal);
      }
    }
  }
}

interface ResolvedWatchRetryOptions {
  initialDelayMs: number;
  maxDelayMs: number;
  multiplier: number;
  maxAttempts?: number;
}

function watchRetryPolicy(options: WatchOptions["retry"]): ResolvedWatchRetryOptions | undefined {
  if (options === false) return undefined;
  return {
    initialDelayMs: Math.max(0, options?.initialDelayMs ?? 500),
    maxDelayMs: Math.max(0, options?.maxDelayMs ?? 15_000),
    multiplier: Math.max(1, options?.multiplier ?? 2),
    ...(options?.maxAttempts === undefined ? {} : { maxAttempts: Math.max(0, options.maxAttempts) })
  };
}

function nonNegativeInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : fallback;
}

function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

interface Application {
  id: string;
  name: string;
  distribution?: "web" | "portable";
  homepage?: string;
  project_url?: string;
  notifications?: ApplicationNotifications;
}

interface StoredAuthorization {
  version: 1;
  verifier: string;
  state: string;
  clientId: string;
  redirectUri: string;
  relayEncryption: "required" | "disabled";
  collectionId?: string;
  returnTo?: string;
  keyHandle?: string;
  applicationAgreementPublicKey?: string;
  applicationSigningPublicKey?: string;
}

interface StoredToken {
  version: 1;
  accessToken: string;
  refreshToken?: string;
  clientId: string;
  collectionId: string;
  collectionName: string;
  operations: CollectionOperation[];
  scope: GrantScope;
  expiresAt: number;
  refreshExpiresAt?: number;
  grantId?: string;
  encryption?: GrantEncryption;
  applicationOrigin?: string;
  keyHandle?: string;
  savedAt: number;
  authority?: {
    operationsUrl: string;
    syncUrl: string;
    replicaId: string;
    accessToken: string;
    proofPublicKey?: string;
  };
}

interface StoredConnectionIndex {
  version: 1;
  collectionIds: string[];
}

interface PendingMutation {
  collectionId: string;
  grantId?: string;
  keyId?: string;
  operation: CollectionOperation;
  inputFingerprint: string;
  requestId: string;
  envelope?: EncryptedRelayOperationRequest;
  createdAt: number;
}

interface OperationAttempt {
  response: Response;
  requestId: string;
  encryptedRequest?: Awaited<ReturnType<typeof encryptRelayRequest>>;
  directDeliveryUncertain?: boolean;
  pendingMutation?: boolean;
  resumingMutation?: boolean;
}

const DEFAULT_OPERATIONS: CollectionOperation[] = ["describe", "changes", "read", "query"];

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

export type MdbaseSelectionHistory = "push" | "replace";

export interface MdbaseSessionSelection {
  selectedCollectionId(): string | null;
  select(collectionId: string | null, options?: { history?: MdbaseSelectionHistory }): void;
  authorizationReturnTo(): string | undefined;
  authorizationCallback(): string | null;
  finishAuthorization(returnTo: string | undefined, collectionId: string): void;
  clearAuthorizationCallback(returnTo?: string): void;
  subscribe(listener: () => void): () => void;
}

export interface MdbaseBrowserSelectionOptions {
  collectionParameter?: string;
  fallbackPath?: string;
}

/** URL-backed collection selection for browser and browser-shell applications. */
export class MdbaseBrowserSelection implements MdbaseSessionSelection {
  private readonly collectionParameter: string;
  private readonly fallbackPath: string;
  private readonly listeners = new Set<() => void>();
  private readonly handlePopState = () => this.emit();

  constructor(options: MdbaseBrowserSelectionOptions = {}) {
    this.collectionParameter = options.collectionParameter ?? "collection";
    this.fallbackPath = options.fallbackPath ?? "/";
  }

  selectedCollectionId(): string | null {
    return this.currentUrl().searchParams.get(this.collectionParameter);
  }

  select(
    collectionId: string | null,
    options: { history?: MdbaseSelectionHistory } = {}
  ): void {
    const url = cleanAuthorizationParameters(this.currentUrl());
    if (collectionId) url.searchParams.set(this.collectionParameter, collectionId);
    else url.searchParams.delete(this.collectionParameter);
    const browserHistory = this.browserHistory();
    browserHistory[options.history === "push" ? "pushState" : "replaceState"](
      browserHistory.state,
      "",
      url
    );
    this.emit();
  }

  authorizationReturnTo(): string {
    const url = cleanAuthorizationParameters(this.currentUrl());
    return `${url.pathname}${url.search}${url.hash}`;
  }

  authorizationCallback(): string | null {
    const value = this.currentUrl().href;
    return isAuthorizationCallbackUrl(value) ? value : null;
  }

  finishAuthorization(returnTo: string | undefined, collectionId: string): void {
    const url = this.safeAppUrl(returnTo ?? this.fallbackPath);
    cleanAuthorizationParameters(url);
    url.searchParams.set(this.collectionParameter, collectionId);
    const browserHistory = this.browserHistory();
    browserHistory.replaceState(null, "", url);
    this.emit();
  }

  clearAuthorizationCallback(returnTo?: string): void {
    const url = returnTo ? this.safeAppUrl(returnTo) : this.currentUrl();
    const browserHistory = this.browserHistory();
    browserHistory.replaceState(browserHistory.state, "", cleanAuthorizationParameters(url));
    this.emit();
  }

  subscribe(listener: () => void): () => void {
    const first = this.listeners.size === 0;
    this.listeners.add(listener);
    if (first && typeof window !== "undefined") {
      window.addEventListener("popstate", this.handlePopState);
    }
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0 && typeof window !== "undefined") {
        window.removeEventListener("popstate", this.handlePopState);
      }
    };
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  private safeAppUrl(value: string): URL {
    const current = this.currentUrl();
    const candidate = new URL(value, current.origin);
    return candidate.origin === current.origin
      ? candidate
      : new URL(this.fallbackPath, current.origin);
  }

  private currentUrl(): URL {
    if (typeof location === "undefined") {
      throw new MdbaseConnectError("browser_required", "Browser selection requires a browser environment.");
    }
    return new URL(location.href);
  }

  private browserHistory(): History {
    if (typeof history === "undefined") {
      throw new MdbaseConnectError("browser_required", "Browser selection requires a browser environment.");
    }
    return history;
  }
}

export class MdbaseMemorySelection implements MdbaseSessionSelection {
  private collectionId: string | null = null;
  private readonly listeners = new Set<() => void>();

  selectedCollectionId(): string | null {
    return this.collectionId;
  }

  select(collectionId: string | null): void {
    if (collectionId === this.collectionId) return;
    this.collectionId = collectionId;
    for (const listener of this.listeners) listener();
  }

  authorizationReturnTo(): undefined {
    return undefined;
  }

  authorizationCallback(): null {
    return null;
  }

  finishAuthorization(_returnTo: string | undefined, collectionId: string): void {
    this.select(collectionId);
  }

  clearAuthorizationCallback(): void {}

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export interface MdbaseSessionOptions {
  selection: MdbaseSessionSelection;
  operations?: CollectionOperation[];
  autoSelect?: "only" | "never";
}

export type MdbaseUnavailableReason =
  | "not_authorized"
  | "authorization_lost"
  | "invalid_stored_grant";

export type MdbaseSessionSnapshot<Frontmatter extends JsonObject = JsonObject> =
  | {
      status: "unselected";
      connections: MdbaseConnectionInfo[];
    }
  | {
      status: "ready";
      collectionId: string;
      connection: MdbaseConnection<Frontmatter>;
      info: MdbaseConnectionInfo;
      access: MdbaseAuthorizationCapabilities;
      connections: MdbaseConnectionInfo[];
    }
  | {
      status: "unavailable";
      collectionId: string;
      reason: MdbaseUnavailableReason;
      connections: MdbaseConnectionInfo[];
    };

export class MdbaseSession<Frontmatter extends JsonObject = JsonObject> {
  private readonly operations: CollectionOperation[];
  private readonly selection: MdbaseSessionSelection;
  private readonly autoSelect: "only" | "never";
  private readonly listeners = new Set<() => void>();
  private snapshot: MdbaseSessionSnapshot<Frontmatter>;
  private snapshotKey = "";
  private stopConnections?: () => void;
  private stopSelection?: () => void;
  private stopActiveConnection?: () => void;
  private activeCollectionId: string | null = null;
  private unavailableReason: MdbaseUnavailableReason = "not_authorized";
  private started = false;
  private refreshing = false;
  private refreshQueued = false;
  private transactionDepth = 0;
  private callbackPromise: Promise<MdbaseConnection<Frontmatter>> | null = null;

  constructor(
    private readonly connect: MdbaseConnect<Frontmatter>,
    options: MdbaseSessionOptions
  ) {
    this.operations = uniqueOperations(options.operations ?? DEFAULT_OPERATIONS);
    this.selection = options.selection;
    this.autoSelect = options.autoSelect ?? "only";
    this.snapshot = { status: "unselected", connections: [] };
    this.refresh();
  }

  async start(): Promise<MdbaseSessionSnapshot<Frontmatter>> {
    if (!this.started) {
      this.started = true;
      this.stopConnections = this.connect.onConnectionsChange(() => this.refresh());
      this.stopSelection = this.selection.subscribe(() => {
        this.unavailableReason = "not_authorized";
        this.refresh();
      });
    }
    const callback = this.selection.authorizationCallback();
    if (callback) await this.handleAuthorizationCallback(callback);
    else this.autoSelectOnlyConnection();
    this.refresh();
    return this.snapshot;
  }

  destroy(): void {
    this.stopConnections?.();
    this.stopSelection?.();
    this.stopActiveConnection?.();
    this.stopConnections = undefined;
    this.stopSelection = undefined;
    this.stopActiveConnection = undefined;
    this.activeCollectionId = null;
    this.started = false;
  }

  getSnapshot(): MdbaseSessionSnapshot<Frontmatter> {
    return this.snapshot;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  select(
    collectionId: string,
    options: { history?: MdbaseSelectionHistory } = {}
  ): MdbaseConnection<Frontmatter> {
    const connection = this.connect.connection(collectionId);
    if (!connection) {
      throw new MdbaseConnectError(
        "unknown_collection",
        "This collection is not authorized for this application."
      );
    }
    this.unavailableReason = "not_authorized";
    this.selection.select(collectionId, options);
    this.refresh();
    return connection;
  }

  clearSelection(options: { history?: MdbaseSelectionHistory } = {}): void {
    this.unavailableReason = "not_authorized";
    this.selection.select(null, options);
    this.refresh();
  }

  forget(collectionId: string): void {
    this.transactionDepth += 1;
    try {
      const selected = this.selection.selectedCollectionId() === collectionId;
      this.connect.connection(collectionId)?.forget();
      if (selected) this.selection.select(null, { history: "replace" });
    } finally {
      this.transactionDepth -= 1;
      this.refresh();
    }
  }

  async authorize(
    target: "choose" | "selected" | { collectionId: string },
    options: Omit<MdbaseAuthorizeOptions, "operations" | "returnTo" | "target"> = {}
  ): Promise<MdbaseAuthorizationOutcome<Frontmatter>> {
    const selectedCollectionId = this.selection.selectedCollectionId();
    if (target === "selected" && !selectedCollectionId) {
      throw new MdbaseConnectError("collection_not_selected", "Choose a collection before updating its access.");
    }
    const targetCollectionId = typeof target === "object"
      ? target.collectionId
      : target === "selected"
        ? selectedCollectionId!
        : null;
    this.transactionDepth += 1;
    try {
      const outcome = await this.connect.authorize({
        ...options,
        operations: this.operations,
        target: targetCollectionId === null
          ? { kind: "choose" }
          : { kind: "collection", collectionId: targetCollectionId },
        returnTo: this.selection.authorizationReturnTo()
      });
      if (outcome.kind === "connected") {
        this.selection.finishAuthorization(outcome.returnTo, outcome.connection.collectionId);
      }
      return outcome;
    } finally {
      this.transactionDepth -= 1;
      this.refresh();
    }
  }

  async ensureOperations(
    requiredOperations: CollectionOperation[]
  ): Promise<MdbaseAuthorizationOutcome<Frontmatter> | { kind: "unchanged"; connection: MdbaseConnection<Frontmatter> }> {
    const current = this.snapshot;
    if (current.status !== "ready") {
      throw new MdbaseConnectError("collection_not_ready", "Choose an authorized collection first.");
    }
    const required = uniqueOperations(requiredOperations);
    const capabilities = current.connection.authorizationCapabilities(required);
    if (capabilities.sufficient) return { kind: "unchanged", connection: current.connection };
    this.transactionDepth += 1;
    try {
      const outcome = await this.connect.authorize({
        operations: uniqueOperations([...capabilities.grantedOperations, ...capabilities.missingOperations]),
        target: { kind: "collection", collectionId: current.collectionId },
        returnTo: this.selection.authorizationReturnTo()
      });
      if (outcome.kind === "connected") {
        this.selection.finishAuthorization(outcome.returnTo, outcome.connection.collectionId);
      }
      return outcome;
    } finally {
      this.transactionDepth -= 1;
      this.refresh();
    }
  }

  handleAuthorizationCallback(
    callbackUrl: string
  ): Promise<MdbaseConnection<Frontmatter>> {
    if (!isAuthorizationCallbackUrl(callbackUrl)) {
      return Promise.reject(new MdbaseConnectError("invalid_callback", "This URL is not an authorization callback."));
    }
    if (this.callbackPromise) return this.callbackPromise;
    this.transactionDepth += 1;
    const completion = this.connect.completeAuthorization(callbackUrl)
      .then((result) => {
        this.unavailableReason = "not_authorized";
        this.selection.finishAuthorization(result.returnTo, result.connection.collectionId);
        this.refresh();
        return result.connection;
      })
      .catch((error) => {
        const returnTo = authorizationReturnToFromError(error);
        this.selection.clearAuthorizationCallback(returnTo);
        this.refresh();
        throw error;
      })
      .finally(() => {
        this.transactionDepth -= 1;
        this.refresh();
        if (this.callbackPromise === completion) this.callbackPromise = null;
      });
    this.callbackPromise = completion;
    return completion;
  }

  private autoSelectOnlyConnection(): void {
    if (this.autoSelect !== "only" || this.selection.selectedCollectionId()) return;
    const connections = this.connect.connections();
    if (connections.length === 1) {
      this.selection.select(connections[0].collectionId, { history: "replace" });
    }
  }

  private refresh(): void {
    if (this.transactionDepth > 0) {
      this.refreshQueued = true;
      return;
    }
    if (this.refreshing) {
      this.refreshQueued = true;
      return;
    }
    this.refreshing = true;
    try {
      do {
        this.refreshQueued = false;
        this.refreshOnce();
      } while (this.refreshQueued);
    } finally {
      this.refreshing = false;
    }
  }

  private refreshOnce(): void {
    const collectionId = this.selection.selectedCollectionId();
    const connections = this.connect.connections();
    const connection = collectionId ? this.connect.connection(collectionId) : null;
    if (connection?.collectionId !== this.activeCollectionId) {
      this.stopActiveConnection?.();
      this.activeCollectionId = connection?.collectionId ?? null;
      this.stopActiveConnection = connection?.onConnectionChange((info) => {
        if (!info && this.selection.selectedCollectionId() === connection.collectionId) {
          this.unavailableReason = "authorization_lost";
        }
        this.refresh();
      });
    }

    let next: MdbaseSessionSnapshot<Frontmatter>;
    if (!collectionId) {
      next = { status: "unselected", connections };
    } else if (!connection || !connection.info()) {
      next = {
        status: "unavailable",
        collectionId,
        reason: this.connect.unavailableReason(collectionId) ?? this.unavailableReason,
        connections
      };
    } else {
      const info = connection.info()!;
      next = {
        status: "ready",
        collectionId,
        connection,
        info,
        access: connection.authorizationCapabilities(this.operations),
        connections
      };
    }
    const key = sessionSnapshotKey(next);
    if (key === this.snapshotKey) return;
    this.snapshot = next;
    this.snapshotKey = key;
    for (const listener of this.listeners) listener();
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

export class MdbaseConnection<Frontmatter extends JsonObject = JsonObject> {
  private readonly serverUrl: string;
  private readonly storage: Storage;
  private readonly keyStore: GrantKeyStore;
  private readonly directAccessMode: "auto" | "disabled";
  private readonly loopbackUrl: string;
  private refreshPromise: Promise<StoredToken> | null = null;
  private readonly collectionClient: MdbaseCollectionClient<Frontmatter>;
  private directStatus: DirectAccessStatus;
  private currentRoute: MdbaseConnectionRoute = "relay";
  private directFailures = 0;
  private directRetryAt = 0;
  private readonly connectionListeners = new Set<(connection: MdbaseConnectionInfo | null) => void>();

  constructor(
    private readonly internals: MdbaseConnectInternals<Frontmatter>,
    readonly collectionId: string
  ) {
    this.serverUrl = internals.serverUrl;
    this.storage = internals.storage;
    this.keyStore = internals.keyStore;
    this.directAccessMode = internals.directAccessMode;
    this.loopbackUrl = internals.loopbackUrl;
    this.directStatus = this.directAccessMode === "disabled" ? "disabled" : "unavailable";
    this.collectionClient = new MdbaseCollectionClient({
      operation: (operation, input, requestOptions) => this.performOperation(operation, input, requestOptions)
    });
  }

  get displayName(): string {
    return this.currentToken()?.collectionName ?? `Collection ${this.collectionId.slice(0, 8)}`;
  }

  get operations(): CollectionOperation[] {
    return [...(this.currentToken()?.operations ?? [])];
  }

  get scope(): GrantScope {
    const scope = this.currentToken()?.scope;
    if (!scope) {
      throw new MdbaseConnectError(
        "not_authorized",
        "This collection is no longer authorized for this application."
      );
    }
    return scope;
  }

  get directAccess(): DirectAccessStatus {
    return this.currentToken()?.authority ? "disabled" : this.directStatus;
  }

  get route(): MdbaseConnectionRoute {
    return this.currentToken()?.authority ? "remote" : this.currentRoute;
  }

  register(): Promise<Application> {
    return this.internals.register();
  }

  info(): MdbaseConnectionInfo | null {
    const token = this.currentToken();
    return token ? {
      collectionId: token.collectionId,
      displayName: token.collectionName,
      operations: [...token.operations],
      scope: token.scope,
      route: token.authority ? "remote" : this.currentRoute,
      directAccess: token.authority ? "disabled" : this.directStatus
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
  sync(): MdbaseSyncConnection<Frontmatter> | null {
    const token = this.currentToken();
    if (!token) return null;
    const collectionId = token.collectionId;
    if (!token.authority) {
      if (!token.grantId || !token.operations.includes("sync")) return null;
      const replicaId = token.grantId;
      return {
        collectionId,
        replicaId,
        transport: {
          openSession: () => this.performOperation("sync", { action: "open_session" }),
          snapshot: (snapshotId, page) => this.performOperation("sync", {
            action: "snapshot",
            snapshot_id: snapshotId,
            ...(page ? { page } : {})
          }),
          changes: (after, limit = 200) => this.performOperation("sync", {
            action: "changes",
            after,
            limit
          }),
          mutate: (mutation) => this.performOperation("sync", {
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
        openSession: () => this.performAuthoritySyncRequest(collectionId, replicaId, "POST", "sessions"),
        snapshot: (snapshotId, page) => {
          const query = new URLSearchParams({ snapshot_id: snapshotId });
          if (page) query.set("page", page);
          return this.performAuthoritySyncRequest(collectionId, replicaId, "GET", `snapshot?${query}`);
        },
        changes: (after, limit = 200) => this.performAuthoritySyncRequest(
          collectionId,
          replicaId,
          "GET",
          `changes?${new URLSearchParams({ after: String(after), limit: String(limit) })}`
        ),
        mutate: (mutation) => this.performAuthoritySyncRequest(
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
  async registerNotifications(
    options: MdbaseNotificationRegistrationOptions
  ): Promise<MdbaseNotificationRegistration> {
    const token = await this.authorizedToken();
    if (!token) {
      throw new MdbaseConnectError(
        "not_authorized",
        "Connect this application before enabling notifications."
      );
    }
    const application = await this.register();
    const declared = application.notifications?.criteria.map((criterion) => criterion.id) ?? [];
    const criteria = [...new Set(options.criteria ?? declared)];
    const undeclared = criteria.find((criterion) => !declared.includes(criterion));
    if (undeclared) {
      throw new MdbaseConnectError(
        "notification_criterion_not_declared",
        `The application manifest does not declare notification criterion ${undeclared}.`
      );
    }
    if (criteria.length === 0) {
      throw new MdbaseConnectError(
        "notifications_not_declared",
        "This application manifest does not declare any notification criteria."
      );
    }
    const keyResponse = await fetch(`${this.serverUrl}/v1/notifications/vapid-public-key`);
    const keyBody = await keyResponse.json();
    if (!keyResponse.ok) {
      throw apiError(keyBody, "notifications_unavailable", "Push notifications are unavailable.", keyResponse.status);
    }
    let pushSubscription = await options.serviceWorker.pushManager.getSubscription();
    if (!pushSubscription) {
      pushSubscription = await options.serviceWorker.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: base64UrlBytes(keyBody.public_key)
      });
    }
    const serialized = pushSubscription.toJSON();
    if (!serialized.endpoint || !serialized.keys?.p256dh || !serialized.keys.auth) {
      throw new MdbaseConnectError(
        "invalid_push_subscription",
        "The browser returned an incomplete push subscription."
      );
    }
    const previous = parseStored<MdbaseNotificationRegistration>(
      this.storage.getItem(this.notificationKey())
    );
    const installationId = options.installationId
      ?? previous?.installationId
      ?? randomBase64Url(24);
    const channelResponse = await fetch(`${this.serverUrl}/v1/notifications/channels`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token.accessToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        installation_id: installationId,
        criteria,
        subscription: {
          endpoint: serialized.endpoint,
          expirationTime: serialized.expirationTime ?? null,
          keys: serialized.keys
        }
      })
    });
    const channelBody = await channelResponse.json();
    if (!channelResponse.ok) {
      throw apiError(channelBody, "notification_registration_failed", "Could not register push notifications.", channelResponse.status);
    }
    if (previous?.channelId && previous.channelId !== channelBody.channel_id) {
      void fetch(`${this.serverUrl}/v1/notifications/channels/${previous.channelId}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${token.accessToken}` }
      }).catch(() => undefined);
    }
    const registration = {
      channelId: channelBody.channel_id,
      installationId,
      criteria
    };
    this.storage.setItem(this.notificationKey(), JSON.stringify(registration));
    return registration;
  }

  /**
   * Register an iOS or Android installation for Connect-managed FCM.
   *
   * The application manifest selects the Firebase project. Re-register the
   * same installation whenever Firebase refreshes its token.
   */
  async registerNativeNotifications(
    options: MdbaseNativeNotificationRegistrationOptions
  ): Promise<MdbaseNativeNotificationRegistration> {
    const token = await this.authorizedToken();
    if (!token) {
      throw new MdbaseConnectError(
        "not_authorized",
        "Connect this application before enabling notifications."
      );
    }
    const application = await this.register();
    if (application.notifications?.native_delivery?.mode !== "managed_fcm") {
      throw new MdbaseConnectError(
        "managed_fcm_not_declared",
        "This application does not declare Connect-managed native notifications."
      );
    }
    const declared = application.notifications.criteria.map(
      (criterion) => criterion.id
    );
    const criteria = [...new Set(options.criteria ?? declared)];
    const undeclared = criteria.find((criterion) => !declared.includes(criterion));
    if (undeclared) {
      throw new MdbaseConnectError(
        "notification_criterion_not_declared",
        `The application manifest does not declare notification criterion ${undeclared}.`
      );
    }
    if (criteria.length === 0) {
      throw new MdbaseConnectError(
        "notifications_not_declared",
        "This application manifest does not declare any notification criteria."
      );
    }
    const storageKey = this.notificationKey("fcm");
    const previous = parseStored<MdbaseNativeNotificationRegistration>(
      this.storage.getItem(storageKey)
    );
    const installationId = options.installationId
      ?? previous?.installationId
      ?? randomBase64Url(24);
    const response = await fetch(`${this.serverUrl}/v1/notifications/channels`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token.accessToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        installation_id: installationId,
        criteria,
        transport: "fcm",
        token: options.token
      })
    });
    const body = await response.json();
    if (!response.ok) {
      throw apiError(
        body,
        "notification_registration_failed",
        "Could not register native notifications.",
        response.status
      );
    }
    if (previous?.channelId && previous.channelId !== body.channel_id) {
      void this.deleteNotificationChannel(previous.channelId, token.accessToken)
        .catch(() => undefined);
    }
    const registration: MdbaseNativeNotificationRegistration = {
      channelId: body.channel_id,
      installationId,
      transport: "fcm",
      criteria
    };
    this.storage.setItem(storageKey, JSON.stringify(registration));
    return registration;
  }

  async unregisterNativeNotifications(): Promise<void> {
    const storageKey = this.notificationKey("fcm");
    const registration = parseStored<MdbaseNativeNotificationRegistration>(
      this.storage.getItem(storageKey)
    );
    const token = await this.authorizedToken();
    if (registration?.channelId && !token) {
      throw new MdbaseConnectError(
        "not_authorized",
        "Reconnect this application before disabling native notifications."
      );
    }
    if (registration?.channelId && token) {
      await this.deleteNotificationChannel(
        registration.channelId,
        token.accessToken
      );
    }
    this.storage.removeItem(storageKey);
  }

  async unregisterNotifications(
    serviceWorker?: ServiceWorkerRegistration
  ): Promise<void> {
    const registration = parseStored<MdbaseNotificationRegistration>(
      this.storage.getItem(this.notificationKey())
    );
    const token = await this.authorizedToken();
    if (registration?.channelId && !token) {
      throw new MdbaseConnectError(
        "not_authorized",
        "Reconnect this application before disabling push notifications."
      );
    }
    if (registration?.channelId && token) {
      const response = await fetch(`${this.serverUrl}/v1/notifications/channels/${registration.channelId}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${token.accessToken}` }
      });
      if (!response.ok && response.status !== 404) {
        const body = await response.json();
        throw apiError(
          body,
          "notification_unregistration_failed",
          "Could not unregister push notifications.",
          response.status
        );
      }
    }
    this.storage.removeItem(this.notificationKey());
    const subscription = await serviceWorker?.pushManager.getSubscription();
    await subscription?.unsubscribe();
  }

  forget(): void {
    const token = this.currentToken();
    this.internals.removeToken(this.collectionId, token?.keyHandle, "not_authorized");
    this.setRoute("relay");
    this.emitConnection();
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
      const cancellable = this.hasResumableMutationTransport();
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
      const cancellable = this.hasResumableMutationTransport();
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

  private async performOperation<Result>(
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

  private async performAuthoritySyncRequest<Result>(
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

  private hasResumableMutationTransport(): boolean {
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
    const connection = this.info();
    for (const listener of this.connectionListeners) listener(connection);
  }

  private invalidateRejectedAuthorization(rejected: StoredToken): void {
    const current = parseStored<StoredToken>(this.storage.getItem(this.tokenKey()));
    if (!current || !sameAuthorization(current, rejected)) return;
    this.internals.removeToken(this.collectionId, current.keyHandle);
    this.currentRoute = "relay";
    this.directStatus = this.directAccessMode === "disabled" ? "disabled" : "unavailable";
    this.emitConnection();
  }

  private currentToken(): StoredToken | null {
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
  private async deleteNotificationChannel(
    channelId: string,
    accessToken: string
  ): Promise<void> {
    const response = await fetch(
      `${this.serverUrl}/v1/notifications/channels/${channelId}`,
      {
        method: "DELETE",
        headers: { authorization: `Bearer ${accessToken}` }
      }
    );
    if (!response.ok && response.status !== 404) {
      const body = await response.json();
      throw apiError(
        body,
        "notification_unregistration_failed",
        "Could not unregister push notifications.",
        response.status
      );
    }
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

export type MdbaseRecoveryAction = "retry" | "reauthorize" | "refresh" | "resolve_outcome" | "fix_request" | "none";

export interface MdbaseConnectErrorOptions {
  status?: number;
  retryable?: boolean;
  requiresAuthorization?: boolean;
  outcomeUnknown?: boolean;
  recovery?: MdbaseRecoveryAction;
  details?: unknown;
  cause?: unknown;
}

export class MdbaseConnectError extends Error {
  readonly status?: number;
  readonly retryable: boolean;
  readonly requiresAuthorization: boolean;
  readonly outcomeUnknown: boolean;
  readonly recovery: MdbaseRecoveryAction;
  readonly details?: unknown;

  constructor(public readonly code: string, message: string, options: MdbaseConnectErrorOptions = {}) {
    super(message);
    this.name = "MdbaseConnectError";
    const classification = classifyConnectError(code, options.status);
    this.status = options.status;
    this.retryable = options.retryable ?? classification.retryable;
    this.requiresAuthorization = options.requiresAuthorization ?? classification.requiresAuthorization;
    this.outcomeUnknown = options.outcomeUnknown ?? classification.outcomeUnknown;
    this.recovery = options.recovery ?? classification.recovery;
    this.details = options.details;
    if (options.cause !== undefined) Object.defineProperty(this, "cause", { value: options.cause, configurable: true });
  }
}

export class MdbaseOperationValidationError<Result = unknown> extends Error {
  readonly code = "operation_invalid";

  constructor(
    public readonly diagnostics: MdbaseDiagnostic[],
    public readonly result: Result
  ) {
    super(diagnostics.filter((item) => item.severity === "error").map((item) => item.message).join(" ")
      || diagnostics.map((item) => item.message).join(" ")
      || "The collection rejected this operation.");
    this.name = "MdbaseOperationValidationError";
  }
}

/** Return a valid operation result or throw while preserving every diagnostic. */
export function unwrapOperation<Result>(envelope: MdbaseOperationEnvelope<Result>): Result {
  if (!envelope.valid) throw new MdbaseOperationValidationError(envelope.diagnostics, envelope.result);
  return envelope.result;
}

/** True only when repeating a read/poll is safe without asking the user. */
export function isRetryableConnectError(error: unknown): boolean {
  if (error instanceof MdbaseConnectError) return error.retryable && !error.outcomeUnknown;
  return error instanceof TypeError;
}

function classifyConnectError(code: string, status?: number): Required<Pick<
  MdbaseConnectErrorOptions,
  "retryable" | "requiresAuthorization" | "outcomeUnknown" | "recovery"
>> {
  const authorizationCodes = new Set([
    "authorization_expired",
    "direct_operation_rejected",
    "encryption_required",
    "insufficient_access",
    "missing_grant_key",
    "not_authorized",
    "relay_authorization_expired"
  ]);
  const outcomeUnknown = code === "direct_outcome_unknown" || code === "pending_mutation_unresolved";
  const requiresAuthorization = authorizationCodes.has(code) || status === 401;
  const retryableCodes = new Set([
    "connector_offline",
    "discovery_failed",
    "relay_unavailable",
    "sync_failed",
    "temporarily_unavailable",
    "timeout"
  ]);
  const retryableStatus = status === 408 || status === 425 || status === 429 || (status !== undefined && status >= 500);
  const retryable = !outcomeUnknown && !requiresAuthorization && (retryableCodes.has(code) || retryableStatus);
  const recovery: MdbaseRecoveryAction = outcomeUnknown
    ? "resolve_outcome"
    : requiresAuthorization
      ? "reauthorize"
      : code === "change_cursor_reset"
        ? "refresh"
        : retryable
          ? "retry"
          : status !== undefined && status >= 400 && status < 500
            ? "fix_request"
            : "none";
  return { retryable, requiresAuthorization, outcomeUnknown, recovery };
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

function isMutation(operation: CollectionOperation, input?: unknown): boolean {
  if (input && typeof input === "object" && !Array.isArray(input)
      && (input as Record<string, unknown>).dry_run === true) return false;
  return (operation === "sync"
      && input !== null
      && typeof input === "object"
      && !Array.isArray(input)
      && (input as Record<string, unknown>).action === "mutate")
    || operation === "create"
    || operation === "update"
    || operation === "delete"
    || operation === "rename"
    || operation === "create_type"
    || operation === "update_type"
    || operation === "install_type_pack"
    || operation === "put_timer"
    || operation === "cancel_timer"
    || operation === "reconcile_timers";
}

function uniqueOperations(operations: CollectionOperation[]): CollectionOperation[] {
  return [...new Set(operations)];
}

function sameAuthorization(left: StoredToken, right: StoredToken): boolean {
  if (left.grantId || right.grantId) {
    return left.grantId === right.grantId
      && left.keyHandle === right.keyHandle
      && left.encryption?.key_id === right.encryption?.key_id;
  }
  return left.accessToken === right.accessToken;
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw new MdbaseConnectError(
    "operation_cancelled",
    "The operation was cancelled before it changed the collection.",
    { recovery: "none", cause: signal.reason }
  );
}

function operationTransportError(
  error: unknown,
  signal: AbortSignal | undefined,
  outcomeUnknown: boolean
): Error {
  if (signal?.aborted) {
    return new MdbaseConnectError(
      "operation_cancelled",
      outcomeUnknown
        ? "Waiting was cancelled after the mutation was sent. Resume the pending mutation to recover its authoritative result."
        : "The operation was cancelled before it changed the collection.",
      {
        outcomeUnknown,
        recovery: outcomeUnknown ? "resolve_outcome" : "none",
        cause: error
      }
    );
  }
  if (outcomeUnknown) {
    if (error instanceof MdbaseConnectError && error.outcomeUnknown) return error;
    return uncertainDirectMutation(error);
  }
  return error instanceof Error ? error : new Error(String(error));
}

function isCancellation(error: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true
    || (error instanceof MdbaseConnectError && error.code === "operation_cancelled");
}

function assertRenamePreview(input: RenameInput, preview: RenamePreflightResult): void {
  if (preview.dry_run !== true || preview.would_rename !== true
      || preview.from !== input.from || preview.to !== input.to) {
    throw new MdbaseConnectError(
      "invalid_preflight",
      "The rename preview does not match this mutation. Run the preview again.",
      { recovery: "fix_request" }
    );
  }
}

function assertDeletePreview(input: DeleteInput, preview: DeletePreflightResult): void {
  if (preview.dry_run !== true || preview.would_delete !== true || preview.path !== input.path) {
    throw new MdbaseConnectError(
      "invalid_preflight",
      "The delete preview does not match this mutation. Run the preview again.",
      { recovery: "fix_request" }
    );
  }
}

function renameEstimate(input: RenameInput, preview: RenamePreflightResult): MutationEstimate {
  if (input.update_refs === false) {
    return { affectedRecords: 0, totalUnits: 1, warnings: 0 };
  }
  const references = preview.references_affected ?? [];
  return {
    affectedRecords: new Set(references.map((reference) => reference.path)).size,
    totalUnits: 1 + references.length,
    warnings: preview.warnings?.length ?? 0
  };
}

function deleteEstimate(preview: DeletePreflightResult): MutationEstimate {
  return {
    affectedRecords: new Set((preview.broken_links ?? []).map((reference) => reference.path)).size,
    totalUnits: 1,
    warnings: 0
  };
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
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([key, item]) => [key, sortJson(item)])
    );
  }
  return value;
}

function uncertainDirectMutation(cause: unknown): MdbaseConnectError {
  return new MdbaseConnectError(
    "direct_outcome_unknown",
    "The direct write may have completed, and mdbase could not recover its receipt through the relay. Retry the exact same write to recover safely.",
    { cause }
  );
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

function apiError(body: any, fallbackCode: string, fallbackMessage: string, status?: number): MdbaseConnectError {
  return new MdbaseConnectError(
    oauthErrorCode(body) ?? body?.error?.code ?? fallbackCode,
    body?.error_description ?? body?.error?.message ?? fallbackMessage,
    { status, details: body?.error?.details }
  );
}

function oauthErrorCode(body: any): string | undefined {
  return typeof body?.error === "string" ? body.error : undefined;
}

function validAuthorityTokenResponse(value: unknown, collectionId: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (typeof collectionId !== "string") return false;
  const authority = value as {
    operations_url?: unknown;
    sync_url?: unknown;
    replica_id?: unknown;
    access_token?: unknown;
    proof_public_key?: unknown;
  };
  if (
    typeof authority.operations_url !== "string"
    || typeof authority.sync_url !== "string"
    || typeof authority.replica_id !== "string"
    || authority.replica_id.length === 0
    || typeof authority.access_token !== "string"
    || authority.access_token.length === 0
    || (
      authority.proof_public_key !== undefined
      && (
        typeof authority.proof_public_key !== "string"
        || authority.proof_public_key.length === 0
      )
    )
  ) return false;
  try {
    const operations = new URL(authority.operations_url);
    const sync = new URL(authority.sync_url);
    return [operations, sync].every((url) =>
      (
        url.protocol === "https:"
        || (
          url.protocol === "http:"
          && ["localhost", "127.0.0.1", "[::1]", "::1"].includes(url.hostname)
        )
      )
      && !url.username
      && !url.password
      && !url.search
      && !url.hash
    )
      && /^\/v1\/authorities\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/operations$/i.test(operations.pathname)
      && /^\/v1\/authorities\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/sync$/i.test(sync.pathname)
      && operations.origin === sync.origin
      && operations.pathname.split("/")[3] === collectionId
      && sync.pathname.split("/")[3] === collectionId;
  } catch {
    return false;
  }
}

function validStoredAuthority(
  authority: StoredToken["authority"],
  collectionId: string
): boolean {
  return validAuthorityTokenResponse({
    operations_url: authority?.operationsUrl,
    sync_url: authority?.syncUrl,
    replica_id: authority?.replicaId,
    access_token: authority?.accessToken,
    proof_public_key: authority?.proofPublicKey
  }, collectionId);
}

function validStoredEncryption(
  encryption: StoredToken["encryption"],
  collectionId: string
): encryption is GrantEncryption {
  if (!encryption || typeof encryption !== "object" || Array.isArray(encryption)) {
    return false;
  }
  if (encryption.collection_id !== collectionId) return false;
  try {
    validateGrantEncryption(encryption);
    return true;
  } catch {
    return false;
  }
}

function parseDeviceAuthorization(body: any): MdbaseDeviceAuthorization {
  if (
    typeof body?.device_code !== "string"
    || typeof body?.user_code !== "string"
    || typeof body?.verification_uri !== "string"
    || typeof body?.verification_uri_complete !== "string"
    || !Number.isFinite(body?.expires_in)
    || !Number.isFinite(body?.interval)
  ) {
    throw new MdbaseConnectError(
      "invalid_device_authorization_response",
      "Connect returned an invalid downloaded application authorization response."
    );
  }
  return {
    userCode: body.user_code,
    verificationUri: body.verification_uri,
    verificationUriComplete: body.verification_uri_complete,
    expiresAt: Date.now() + Math.max(1, body.expires_in) * 1_000,
    intervalSeconds: Math.max(1, body.interval)
  };
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

function base64UrlBytes(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function parseStored<T>(value: string | null): T | null {
  if (!value) return null;
  try { return JSON.parse(value) as T; } catch { return null; }
}

function cleanAuthorizationParameters(url: URL): URL {
  for (const parameter of ["code", "state", "error", "error_description"]) {
    url.searchParams.delete(parameter);
  }
  return url;
}

function isAuthorizationCallbackUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.searchParams.has("state")
    && (url.searchParams.has("code") || url.searchParams.has("error"));
}

function authorizationReturnToFromError(error: unknown): string | undefined {
  if (!(error instanceof MdbaseConnectError)
      || !error.details
      || typeof error.details !== "object"
      || Array.isArray(error.details)) return undefined;
  const returnTo = (error.details as { returnTo?: unknown }).returnTo;
  return typeof returnTo === "string" ? returnTo : undefined;
}

function sessionSnapshotKey<Frontmatter extends JsonObject>(
  snapshot: MdbaseSessionSnapshot<Frontmatter>
): string {
  if (snapshot.status === "unselected") {
    return JSON.stringify({ status: snapshot.status, connections: snapshot.connections });
  }
  if (snapshot.status === "unavailable") {
    return JSON.stringify({
      status: snapshot.status,
      collectionId: snapshot.collectionId,
      reason: snapshot.reason,
      connections: snapshot.connections
    });
  }
  return JSON.stringify({
    status: snapshot.status,
    collectionId: snapshot.collectionId,
    info: snapshot.info,
    access: snapshot.access,
    connections: snapshot.connections
  });
}

function parseGrantScope(value: unknown): GrantScope | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const scope = value as Partial<GrantScope>;
  if (scope.access !== "contract" && scope.access !== "full_collection") return null;
  if (!Array.isArray(scope.contracts)) return null;
  if (scope.contracts.some((contract) =>
    !contract
    || typeof contract !== "object"
    || contract.contract_type !== "record"
    || typeof contract.id !== "string"
    || typeof contract.version !== "string"
    || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(contract.version)
    || !/^sha256:[0-9a-f]{64}$/.test(contract.digest)
    || !contract.schema
    || typeof contract.schema !== "object"
    || Array.isArray(contract.schema)
    || !Array.isArray(contract.implementations)
    || contract.implementations.some((implementation) =>
      !implementation
      || typeof implementation !== "object"
      || typeof implementation.type_name !== "string"
      || !Number.isInteger(implementation.type_version)
      || !/^sha256:[0-9a-f]{64}$/.test(implementation.digest)
      || !implementation.fields
      || typeof implementation.fields !== "object"
      || Array.isArray(implementation.fields)
      || Object.values(implementation.fields).some((field) => typeof field !== "string")
    )
  )) return null;
  return scope as GrantScope;
}

function stripTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function defaultManifestSource(): string {
  if (typeof location === "undefined") {
    throw new MdbaseConnectError(
      "manifest_required",
      "manifest is required outside a browser environment."
    );
  }
  if (location.origin === "null") {
    throw new MdbaseConnectError(
      "manifest_required",
      "Downloaded applications must provide their v1 portable manifest inline."
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

function defaultStorage(memoryOnly: boolean): Storage {
  if (memoryOnly) return new MemoryStorage();
  if (typeof localStorage === "undefined") {
    throw new MdbaseConnectError(
      "storage_required",
      "storage is required outside a browser environment."
    );
  }
  try {
    const probe = `mdbase-connect:probe:${randomBase64Url(8)}`;
    localStorage.setItem(probe, "1");
    localStorage.removeItem(probe);
    return localStorage;
  } catch {
    return new MemoryStorage();
  }
}

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(String(key), String(value));
  }
}

function isOpaquePortableManifest(manifest: MdbaseAppManifest | string): boolean {
  if (typeof manifest === "string" || manifest.distribution !== "portable") return false;
  return typeof location === "undefined"
    || location.origin === "null"
    || !["http:", "https:"].includes(location.protocol);
}

function manifestStorageFingerprint(manifest: MdbaseAppManifest): string {
  const canonical = canonicalJson(manifest);
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < canonical.length; index += 1) {
    const code = canonical.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x85ebca6b);
  }
  return `${(first >>> 0).toString(16).padStart(8, "0")}${(second >>> 0).toString(16).padStart(8, "0")}`;
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
