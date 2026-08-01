import type {
  CollectionOperation,
  JsonObject,
  QueryRecord,
  RecordDocument
} from "@mdbase-dev/connect-protocol";
import type { MdbaseConnectError } from "./errors.js";

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
