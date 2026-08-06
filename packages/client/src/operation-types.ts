import type {
  CollectionOperation,
  ConnectProblem,
  ContractRequirement,
  JsonObject,
  MutationOperationIdentifier,
  TypePackProvision
} from "@mdbase-dev/connect-protocol";

export interface MdbaseDesiredTimer {
  /** Stable within the timer namespace. */
  id: string;
  /** RFC 3339 instant at which the authority should fire the timer. */
  fireAt: string;
  /** Private application data retained by the collection authority. */
  data?: unknown;
}

export interface MdbaseTimer extends MdbaseDesiredTimer {
  criterionId: string;
  generation: number;
  status: "scheduled" | "firing" | "fired" | "cancelled";
  createdAt: string;
  updatedAt: string;
  firedAt: string | null;
}

export interface MdbaseTimerList {
  namespace: string;
  timers: MdbaseTimer[];
}

export interface MdbaseTimerReconciliation extends MdbaseTimerList {
  cancelledIds: string[];
}

export interface ReadInput {
  path: string;
  /** Select an exact approved contract view when more than one is possible. */
  contract?: DataContractSelector;
  /** Include the exact UTF-8 Markdown source; requires full-collection access. */
  includeDocument?: boolean;
}

export interface DataContractSelector {
  id: string;
  version: string;
  /** Required when several approved types implement the selected contract. */
  type?: string;
}

export interface CollectionFileMetadata extends JsonObject {
  name: string;
  folder: string;
  size: number;
  mtime: string;
  tags?: string[];
  links?: unknown[];
  embeds?: unknown[];
}

export interface DataContractViewIdentity {
  id: string;
  version: string;
  digest: string;
  type: string;
  implementationDigest: string;
}

export interface QueryRecord<Frontmatter extends JsonObject = JsonObject> {
  path: string;
  frontmatter?: Frontmatter;
  effectiveFrontmatter?: Frontmatter;
  body?: string;
  types: string[];
  file: Partial<CollectionFileMetadata> & { path?: string };
  contract?: DataContractViewIdentity;
}

export interface RecordDocument<Frontmatter extends JsonObject = JsonObject> {
  path: string;
  revision: string;
  types: string[];
  frontmatter: Frontmatter;
  effectiveFrontmatter: Frontmatter;
  body?: string;
  document?: string;
  file: Partial<CollectionFileMetadata> & { path?: string };
  contract?: DataContractViewIdentity;
}

export interface CollectionTypeDescriptor {
  name: string;
  version?: number;
  description?: string;
  revision?: string;
  path?: string;
  definition?: JsonObject;
  schema: JsonObject;
  collection?: JsonObject;
  lifecycle?: JsonObject;
  extensions: Record<string, unknown>;
}

export interface CollectionContractImplementationDescriptor {
  typeName: string;
  typeVersion: number;
  typePath?: string;
  digest: string;
  fields: Record<string, string>;
  binding?: JsonObject;
}

export interface CollectionContractDescriptor {
  contractType: "record";
  id: string;
  version: string;
  digest: string;
  schema: JsonObject;
  bindingSchema?: JsonObject;
  implementations: CollectionContractImplementationDescriptor[];
}

export interface CollectionDescription {
  protocolVersion: 1;
  collectionId: string;
  displayName: string;
  specVersion: string;
  operations: CollectionOperation[];
  changeCursor: number;
  types: CollectionTypeDescriptor[];
  contracts: CollectionContractDescriptor[];
  configuration?: JsonObject;
}

export interface QueryProjection {
  expression: string;
  description?: string;
}

export interface QuerySelectionExpression {
  name: string;
  expression: string;
  label?: string;
  description?: string;
}

export interface QueryOrder {
  field: string;
  direction?: "asc" | "desc";
}

export interface QuerySummary {
  field: string;
  function: string;
  name?: string;
  label?: string;
}

/** Application-facing form of the canonical mdbase v0.3 query schema. */
export interface QueryInput {
  /**
   * Contract-scoped queries accept only `types`, `timezone`, pagination,
   * `frontmatterMode`, and `contract`; filter normalized fields in the app.
   */
  types?: string[];
  /** IANA timezone used for calendar semantics in this invocation. */
  timezone?: string;
  context?: { this: { path: string } };
  projections?: Record<string, QueryProjection>;
  where?: string;
  select?: Array<string | QuerySelectionExpression>;
  orderBy?: QueryOrder[];
  groupBy?: QueryOrder[];
  summaryFunctions?: Record<string, QueryProjection>;
  summaries?: QuerySummary[];
  limit?: number;
  offset?: number;
  /** Opaque token returned by the first metadata page for consistent, fast pagination. */
  snapshot?: string;
  includeBody?: boolean;
  frontmatterMode?: "effective" | "persisted" | "both";
  /** Narrow a contract-scoped query to one exact contract/provider view. */
  contract?: DataContractSelector;
}

export interface QueryResult<Record extends JsonObject = JsonObject> {
  results: Array<QueryRecord<Record>>;
  meta?: {
    totalCount: number;
    hasMore: boolean;
    snapshot?: string;
  };
}

export interface QueryPagesOptions<Record extends JsonObject = JsonObject> {
  firstPageSize?: number;
  pageSize?: number;
  signal?: AbortSignal;
  /** Independent budget for each page requested by this caller-driven iterator. */
  pageTimeoutMs?: number | null;
  onProgress?: (page: QueryPage<Record>) => void;
}

export interface QueryAllOptions<Record extends JsonObject = JsonObject>
  extends ConnectRequestOptions {
  firstPageSize?: number;
  pageSize?: number;
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

export interface ConnectRequestOptions {
  signal?: AbortSignal;
  /** Relative request budget. `null` deliberately disables the SDK default. */
  timeoutMs?: number | null;
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

export interface MutationProgressOptions extends ConnectRequestOptions {
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
  requestId: string;
  operation: MutationOperationIdentifier;
  fingerprint: string;
  status: "pending" | "recovering" | "outcome_unknown";
  createdAt: string;
}

export interface PendingMutation<Result = unknown> extends PendingMutationSummary {
  recover(options?: ConnectRequestOptions): Promise<import("./outcomes.js").ConnectOutcome<Result>>;
}

export interface CreateInput<Frontmatter extends JsonObject = JsonObject> {
  path?: string;
  type?: string;
  contract?: DataContractSelector;
  frontmatter?: Partial<Frontmatter> & JsonObject;
  /** Requires full-collection access; contract creates are frontmatter-only. */
  body?: string;
  ifRevision?: string;
  /** Include the resulting exact Markdown source in `result.document`. */
  includeDocument?: boolean;
}

interface UpdateInputBase {
  path: string;
  contract?: DataContractSelector;
  ifRevision?: string;
  /** Include the resulting exact Markdown source; requires full-collection access. */
  includeDocument?: boolean;
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
     * `patch` and `body`, and implies `includeDocument`.
     */
    document: string;
    patch?: never;
    body?: never;
  }
);

export interface DeleteInput {
  path: string;
  contract?: DataContractSelector;
  checkBacklinks?: boolean;
  ifRevision?: string;
}

export interface DeleteResult {
  path: string;
  deleted: boolean;
  brokenLinks?: Array<{ path: string }>;
}

export interface DeletePreflightResult {
  path: string;
  deleted: false;
  dryRun: true;
  wouldDelete: true;
  brokenLinks?: Array<{ path: string }>;
}

export interface RenameInput {
  from: string;
  to: string;
  contract?: DataContractSelector;
  updateRefs?: boolean;
  ifRevision?: string;
  /** Include the resulting exact Markdown source in `result.document`. */
  includeDocument?: boolean;
}

export interface RenameResult extends RecordDocument {
  from: string;
  to: string;
  referencesUpdated?: JsonObject[];
}

export interface RenamePreflightResult {
  from: string;
  to: string;
  dryRun: true;
  wouldRename: true;
  referencesAffected?: Array<{ path: string; field?: string; location?: string }>;
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
  ifRevision: string;
}

export interface ReadViewSourceInput { path: string; }

export interface CreateViewSourceInput {
  document: string;
  path?: string;
  format?: string;
  name?: string;
}

export interface UpdateViewSourceInput {
  path: string;
  document: string;
  ifRevision?: string;
}

export interface DeleteViewSourceInput { path: string; ifRevision?: string; }

export interface DeleteViewSourceResult { path: string; deleted: boolean; }

export interface ExecuteViewInput {
  path: string;
  view: string;
  /** IANA timezone used for calendar semantics in this invocation. */
  timezone?: string;
  context?: { path: string } | null;
  limit?: number;
  offset?: number;
  render?: boolean;
}

export interface SavedViewPresentation extends JsonObject {
  type: string;
  fallback?: string;
  mappings?: Record<string, string>;
  options?: JsonObject;
}

export interface SavedViewSource {
  path: string;
  format: string;
  revision: string;
  writable: boolean;
}

export interface SavedViewProperty {
  key: string;
  label?: string;
  description?: string;
  format?: string;
  hidden?: boolean;
}

export interface SavedNamedView {
  id: string;
  name: string;
  properties: SavedViewProperty[];
  presentation?: SavedViewPresentation;
}

export interface SavedViewDocument {
  id: string;
  name: string;
  source: SavedViewSource;
  views: SavedNamedView[];
}

export interface SavedViewList {
  views: SavedViewDocument[];
  meta: { totalCount: number };
}

export interface SavedViewSourceDocument {
  path: string;
  format: string;
  revision: string;
  document: string;
}

export interface SavedViewRecord<Frontmatter extends JsonObject = JsonObject>
  extends Omit<QueryRecord<Frontmatter>, "effectiveFrontmatter"> {
  effectiveFrontmatter: Frontmatter;
  values?: JsonObject;
}

export interface SavedViewExecution<Frontmatter extends JsonObject = JsonObject> {
  results: Array<SavedViewRecord<Frontmatter>>;
  meta: {
    totalCount: number;
    hasMore: boolean;
    view: { path: string; id: string };
    context?: { path: string };
    groups?: Array<{ values: JsonObject; count: number; summaries: JsonObject }>;
  };
}

export type ContractSetupChoice =
  | { contract: ContractRequirement; mode: "starter" }
  | {
      contract: ContractRequirement;
      mode: "existing";
      typeName: string;
      typeRevision: string;
      fields: Record<string, string>;
      binding?: Record<string, unknown>;
    };

export interface TypePackResourceDiff {
  source: string;
  target: string;
  kind: "contract" | "type" | "schema";
  mode: "managed" | "seed";
  action: "create" | "update" | "delete" | "adopt" | "unchanged" | "preserve" | "conflict";
  digest: string;
  currentDigest?: string;
  installedDigest?: string;
  adoptedFromDigest?: string;
  reason?: string;
}

export interface TypePackReceipt {
  id: string;
  version: string;
  digest: string;
  installedBy: string;
  resources: Array<Omit<TypePackResourceDiff, "action" | "currentDigest" | "installedDigest" | "reason">>;
}

export interface TypePackAssessment {
  status: "current" | "install" | "upgrade" | "downgrade" | "reconfigure" | "conflict";
  applicable: boolean;
  assessmentDigest: string;
  current?: TypePackReceipt;
  desired: TypePackReceipt;
  resources: TypePackResourceDiff[];
  lock: { target: "mdbase.lock.yaml"; action: "create" | "update" | "unchanged"; digest: string };
  contractSetups: { choices: ContractSetupChoice[]; resources: TypePackResourceDiff[] };
}

export interface TypePackApplyResult extends TypePackAssessment {
  receipt: TypePackReceipt;
  cleanupDeferred: boolean;
}

export type ConfigurationContributionValue = string | number | boolean | null;

export interface ConfigurationRequirement {
  id: string;
  path: string;
  predicate: "contains";
  value: ConfigurationContributionValue;
}

export interface ConfigurationProvision {
  requirement: string;
  operation: "set_add";
  path: string;
  value: ConfigurationContributionValue;
}

export interface ApplicationCollectionSetupRequirements {
  configuration: ConfigurationRequirement[];
}

export interface ApplicationCollectionSetupProvisions {
  configuration: ConfigurationProvision[];
  typePacks: TypePackProvision[];
}

export interface ConfigurationSetupConflict {
  code: "configuration_path_conflict" | "configuration_type_conflict";
  path: string;
  expected: "mapping" | "sequence";
  observed: "null" | "boolean" | "number" | "string" | "sequence" | "mapping" | "tagged";
  message: string;
}

export interface ConfigurationSetupAssessment {
  requirement: string;
  path: string;
  value: ConfigurationContributionValue;
  action: "current" | "add" | "conflict";
  conflict?: ConfigurationSetupConflict;
}

export interface CollectionSetupAssessment {
  status: "current" | "provision" | "conflict";
  applicable: boolean;
  applicationId: string;
  declarationDigest: string;
  provisionDigest: string;
  collectionRevision: string;
  finalCollectionRevision: string;
  configuration: ConfigurationSetupAssessment[];
  typePacks: TypePackAssessment[];
  finalResourceRevisions: Record<string, string>;
  assessmentDigest: string;
}

export interface CollectionSetupReceipt {
  applicationId: string;
  declarationDigest: string;
  provisionDigest: string;
  assessmentDigest: string;
  collectionRevision: string;
  configuration: Array<{ requirement: string; path: string; value: ConfigurationContributionValue }>;
  typePacks: TypePackReceipt[];
  cleanupDeferred: boolean;
}

export interface CollectionSetupApplyResult {
  assessment: CollectionSetupAssessment;
  receipt: CollectionSetupReceipt;
}

export interface AssessTypePackInput {
  provision: TypePackProvision;
  installedBy: string;
  adoptResources?: Record<string, string>;
  preserveSeedTargets?: string[];
  targetOverrides?: Record<string, string>;
  contractSetups?: ContractSetupChoice[];
}

export interface ApplyTypePackInput extends AssessTypePackInput {
  expectedAssessmentDigest: string;
  allowDowngrade?: boolean;
}

export interface AssessCollectionSetupInput {
  applicationId: string;
  declarationDigest: string;
  requirements: ApplicationCollectionSetupRequirements;
  provisions: ApplicationCollectionSetupProvisions;
  contractSetups?: ContractSetupChoice[];
}

export interface ApplyCollectionSetupInput extends AssessCollectionSetupInput {
  expectedAssessmentDigest: string;
  expectedCollectionRevision: string;
  expectedProvisionDigest: string;
  allowTypePackDowngrades?: string[];
}

export interface ChangesInput {
  after?: number;
  limit?: number;
}

export interface WatchOptions {
  cursor?: number;
  pollIntervalMs?: number;
  signal?: AbortSignal;
  /** Per-poll/reconnect budget. null deliberately disables the SDK default. */
  timeoutMs?: number | null;
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
  | { state: "reconnecting"; cursor?: number; attempt: number; retryInMs: number; problem: ConnectProblem }
  | { state: "reset_required"; cursor: number; problem: ConnectProblem<"change_cursor_reset"> }
  | { state: "closed"; cursor?: number };

export interface WatchInput {
  cursor?: number;
  pollIntervalMs?: number;
  retry?: false | WatchRetryOptions;
  /** Cancels the subscription lifetime after bounded startup succeeds. */
  lifetimeSignal?: AbortSignal;
}

export interface MdbaseWatchSubscription {
  readonly status: WatchStatus;
  readonly problem: ConnectProblem | null;
  subscribe(
    listener: (change: CollectionChange) => void,
    onStatus?: (status: WatchStatus) => void,
    onProblem?: (problem: ConnectProblem) => void
  ): () => void;
  close(): void;
}

export interface CollectionChange {
  cursor: number;
  type: string;
  occurredAt: string;
  payload: JsonObject;
}

export interface CollectionChangesPage {
  events: CollectionChange[];
  cursor: number;
  hasMore: boolean;
  reset: boolean;
}

/** Provider-neutral operation transport used by the typed collection client. */
export interface MdbaseCollectionTransport {
  operation<Result>(operation: CollectionOperation, input: unknown, options?: ConnectRequestOptions): Promise<Result>;
}
