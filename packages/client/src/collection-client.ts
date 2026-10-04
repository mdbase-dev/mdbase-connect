import type {
  CollectionChangesPage as WireCollectionChangesPage,
  CollectionOperation,
  ConnectProblemCode,
  CollectionTypeDocument,
  ApplyTypePackInput as WireApplyTypePackInput,
  ApplyCollectionSetupInput as WireApplyCollectionSetupInput,
  AssessTypePackInput as WireAssessTypePackInput,
  AssessCollectionSetupInput as WireAssessCollectionSetupInput,
  CollectionSetupApplyResult as WireCollectionSetupApplyResult,
  CollectionSetupAssessment as WireCollectionSetupAssessment,
  DeleteViewSourceResult as WireDeleteViewSourceResult,
  ExecuteViewInput as WireExecuteViewInput,
  JsonObject,
  MdbaseDiagnostic,
  MdbaseOperationEnvelope,
  RecordDocument as WireRecordDocument,
  ReadManyDocumentsResult as WireReadManyDocumentsResult,
  SavedViewExecution as WireSavedViewExecution,
  SavedViewList as WireSavedViewList,
  SavedViewSourceDocument as WireSavedViewSourceDocument,
  TypePackApplyResult as WireTypePackApplyResult,
  TypePackAssessment as WireTypePackAssessment,
} from "@mdbase-dev/connect-protocol";
import { abortableDelay, pollDelay } from "./async.js";
import { invalidatesDescription, normalizeChangesPage } from "./change-events.js";
import { CollectionDescriptionCache } from "./description-cache.js";
import { coordinatedQueryPages } from "./query-pagination.js";
import { readMany as readManyRecords } from "./read-many.js";
import { MdbaseQueryObserver, type ObserveOptions } from "./observe.js";
import { wireDataContractIdentity, wireQueryInput, wireQueryRecord, wireQueryResult, type WireQueryResult } from "./query-wire.js";
import { coordinatedSavedViewPages } from "./saved-view-pagination.js";
import {
  MdbaseConnectError,
  connectError,
  connectProblem,
  operationProblem
} from "./errors.js";
import {
  COLLECTION_CHANGES_PROBLEM_CODES,
  COLLECTION_MUTATION_PROBLEM_CODES,
  COLLECTION_QUERY_PROBLEM_CODES,
  COLLECTION_READ_PROBLEM_CODES,
  COLLECTION_TYPE_PROBLEM_CODES,
  ALL_CONNECT_PROBLEM_CODES,
  captureConnectOutcome,
  connectFailure,
  connectSuccess,
  type CollectionChangesProblemCode,
  type CollectionDescriptionProblemCode,
  type CollectionMutationProblemCode,
  type CollectionQueryProblemCode,
  type CollectionReadProblemCode,
  type CollectionTypeProblemCode,
  type CommonOperationProblemCode,
  type ConnectOutcome
} from "./outcomes.js";
import type {
  ChangesInput,
  DescribeOptions,
  CollectionChange,
  CollectionChangesPage,
  CollectionDescription,
  CollectionSetupApplyResult,
  CollectionSetupAssessment,
  AssessCollectionSetupInput,
  AssessTypePackInput,
  ApplyCollectionSetupInput,
  ApplyTypePackInput,
  CreateInput,
  CreateTypeInput,
  CreateViewSourceInput,
  DeleteInput,
  DeletePreflightResult,
  DeleteResult,
  DeleteViewSourceInput,
  DeleteViewSourceResult,
  ExecuteViewInput,
  MdbaseCollectionTransport,
  MdbaseDesiredTimer,
  MdbaseTimer,
  MdbaseTimerList,
  MdbaseTimerReconciliation,
  ConnectRequestOptions,
  QueryAllOptions,
  QueryInput,
  QueryMetadataInput,
  QueryMetadataRecord,
  QueryMetadataResult,
  QueryMetadataPage,
  QueryRecord,
  QueryPage,
  QueryPagesOptions,
  QueryResult,
  ReadInput,
  ReadManyOptions,
  ReadManyResult,
  ReadTypeInput,
  ReadViewSourceInput,
  RenameInput,
  RenamePreflightResult,
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
  WatchOptions
} from "./operation-types.js";
import {
  createRequestBudget,
  DEFAULT_REQUEST_TIMEOUT_MS,
  requestAbortReason,
  requestOptionsWithinBudget,
  withRequestBudget
} from "./request-budget.js";
import { watchRetryPolicy } from "./watch-policy.js";

/**
 * Typed collection operations independent of OAuth, HTTP, or storage.
 *
 * Application code can use this surface against Connect, the developer
 * sandbox, or another provider without changing its record logic.
 */
export class MdbaseCollectionClient<Frontmatter extends JsonObject = JsonObject> {
  private readonly descriptions: CollectionDescriptionCache;
  private lastSchemaCursor = -1;

  /** Local cache generation, not an authority revision or cross-connection identity. */
  get schemaGeneration(): number { return this.descriptions.schemaGeneration; }

  constructor(
    private readonly transport: MdbaseCollectionTransport,
    private readonly requestTimeoutMs: number | null = DEFAULT_REQUEST_TIMEOUT_MS,
    private readonly supportsAuthorityFeature?: (id: string, options?: ConnectRequestOptions) => Promise<ConnectOutcome<boolean>>
  ) {
    this.descriptions = new CollectionDescriptionCache(transport, requestTimeoutMs);
  }

  operation<Result>(
    operation: CollectionOperation,
    input: unknown,
    options?: ConnectRequestOptions
  ): Promise<ConnectOutcome<Result>> {
    return captureConnectOutcome(
      () => this.transport.operation<Result>(operation, input, options),
      ALL_CONNECT_PROBLEM_CODES
    );
  }

  describe(options?: DescribeOptions): Promise<ConnectOutcome<CollectionDescription, CollectionDescriptionProblemCode>> {
    return this.descriptions.describe(options);
  }

  async changes(
    input: ChangesInput = {},
    options?: ConnectRequestOptions
  ): Promise<ConnectOutcome<CollectionChangesPage, CollectionChangesProblemCode>> {
    const outcome = await this.rawOperation<WireCollectionChangesPage, CollectionChangesProblemCode>("changes", input, COLLECTION_CHANGES_PROBLEM_CODES, options);
    const mapped = mapOutcome(outcome, normalizeChangesPage);
    if (mapped.ok) {
      const invalidations = mapped.value.events.filter(invalidatesDescription);
      if (mapped.value.reset || invalidations.some((event) => event.cursor > this.lastSchemaCursor)) {
        this.descriptions.invalidate();
        this.lastSchemaCursor = mapped.value.cursor;
      }
    }
    return mapped;
  }

  async read(input: ReadInput, options?: ConnectRequestOptions): Promise<ConnectOutcome<RecordDocument<Frontmatter>, CollectionReadProblemCode>> {
    const outcome = await this.envelopeOperation<WireRecordDocument<Frontmatter>, CollectionReadProblemCode>("read", wireReadInput(input), COLLECTION_READ_PROBLEM_CODES, options);
    return mapOutcome(outcome, wireRecordDocument);
  }

  readMany(paths: readonly string[], options: ReadManyOptions = {}): Promise<ConnectOutcome<ReadManyResult<Frontmatter>, CollectionQueryProblemCode>> {
    return readManyRecords(
      (input, requestOptions) => this.queryAll(input, requestOptions),
      (selected, includeBody, requestOptions) => this.envelopeOperation<WireReadManyDocumentsResult<Frontmatter>, CollectionReadProblemCode>(
        "read", { paths: selected, include_body: includeBody, include_document: false }, COLLECTION_READ_PROBLEM_CODES, requestOptions
      ),
      this.supportsAuthorityFeature, paths, options, this.requestTimeoutMs
    );
  }

  observe(query: QueryInput = {}, options: ObserveOptions = {}): MdbaseQueryObserver<Frontmatter> {
    return new MdbaseQueryObserver(this, query, options, this.supportsAuthorityFeature);
  }

  query(input: QueryMetadataInput, options?: ConnectRequestOptions): Promise<ConnectOutcome<QueryMetadataResult, CollectionQueryProblemCode>>;
  query(input?: QueryInput, options?: ConnectRequestOptions): Promise<ConnectOutcome<QueryResult<Frontmatter>, CollectionQueryProblemCode>>;
  query(input: QueryInput | QueryMetadataInput, options?: ConnectRequestOptions): Promise<ConnectOutcome<QueryResult<Frontmatter> | QueryMetadataResult, CollectionQueryProblemCode>>;
  async query(input: QueryInput | QueryMetadataInput = {}, options?: ConnectRequestOptions): Promise<ConnectOutcome<QueryResult<Frontmatter> | QueryMetadataResult, CollectionQueryProblemCode>> {
    if (input.output !== undefined && input.output !== "metadata") {
      return connectFailure(connectProblem("invalid_request", "Unknown query output mode."));
    }
    if (input.output !== "metadata") {
      const outcome = await this.envelopeOperation<WireQueryResult<Frontmatter>, CollectionQueryProblemCode>(
        "query", wireQueryInput(input), COLLECTION_QUERY_PROBLEM_CODES, options
      );
      return mapOutcome(outcome, value => wireQueryResult(value, undefined));
    }
    const captured = await captureConnectOutcome(() => withRequestBudget(options, this.requestTimeoutMs, async budget => {
      const requestOptions = requestOptionsWithinBudget({ ...options, timeoutMs: null }, budget);
      if (input.includeBody) throw connectError("invalid_request", "Metadata queries cannot include a body.");
      const support = await this.supportsAuthorityFeature?.("query-metadata-v1", requestOptions);
      if (support && !support.ok) throw new MdbaseConnectError(support.problem);
      if (!support?.value) throw connectError("unsupported_operation", "This authority does not support metadata queries. Use an ordinary query on legacy authorities.");
      const outcome = await this.envelopeOperation<WireQueryResult<Frontmatter>, CollectionQueryProblemCode>(
        "query", wireQueryInput(input), COLLECTION_QUERY_PROBLEM_CODES, requestOptions
      );
      return mapOutcome(outcome, value => wireQueryResult(value, input.output));
    }), COLLECTION_QUERY_PROBLEM_CODES);
    return captured.ok ? captured.value : captured;
  }

  queryPages(input: QueryMetadataInput, options?: QueryPagesOptions<JsonObject, QueryMetadataRecord>): AsyncGenerator<ConnectOutcome<QueryMetadataPage, CollectionQueryProblemCode>>;
  queryPages(input?: QueryInput, options?: QueryPagesOptions<Frontmatter>): AsyncGenerator<ConnectOutcome<QueryPage<Frontmatter>, CollectionQueryProblemCode>>;
  async *queryPages(input: QueryInput | QueryMetadataInput = {}, options: QueryPagesOptions<Frontmatter> | QueryPagesOptions<JsonObject, QueryMetadataRecord> = {}): AsyncGenerator<ConnectOutcome<QueryPage<Frontmatter, QueryRecord<Frontmatter> | QueryMetadataRecord> & { output?: "metadata" }, CollectionQueryProblemCode>> {
    yield* coordinatedQueryPages<Frontmatter, QueryRecord<Frontmatter> | QueryMetadataRecord>(
      (pageInput, pageOptions) => this.query(pageInput, pageOptions),
      (cursor) => this.releaseQueryCursor(cursor, input.output),
      input,
      // The overload ties callback row types to input.output; the wire parser
      // rejects mode mismatch before pagination can deliver a page.
      options as QueryPagesOptions<Frontmatter, QueryRecord<Frontmatter> | QueryMetadataRecord>
    );
  }

  queryAll(input: QueryMetadataInput, options?: QueryAllOptions<JsonObject, QueryMetadataRecord>): Promise<ConnectOutcome<QueryMetadataResult, CollectionQueryProblemCode>>;
  queryAll(input?: QueryInput, options?: QueryAllOptions<Frontmatter>): Promise<ConnectOutcome<QueryResult<Frontmatter>, CollectionQueryProblemCode>>;
  async queryAll(input: QueryInput | QueryMetadataInput = {}, options: QueryAllOptions<Frontmatter> | QueryAllOptions<JsonObject, QueryMetadataRecord> = {}): Promise<ConnectOutcome<QueryResult<Frontmatter> | QueryMetadataResult, CollectionQueryProblemCode>> {
    const budget = createRequestBudget(options, this.requestTimeoutMs);
    const results: Array<QueryRecord<Frontmatter> | QueryMetadataRecord> = [];
    let finalPage: QueryPage<Frontmatter, QueryRecord<Frontmatter> | QueryMetadataRecord> | undefined;
    const diagnostics: MdbaseDiagnostic[] = [];
    try {
      const pageOptions = {
        firstPageSize: options.firstPageSize,
        pageSize: options.pageSize,
        maxResults: options.maxResults,
        signal: budget.signal,
        pageTimeoutMs: null,
        coordination: options.coordination
      };
      const pages = input.output === "metadata"
        ? this.queryPages(input, { ...pageOptions, onProgress: (options as QueryAllOptions<JsonObject, QueryMetadataRecord>).onProgress })
        : this.queryPages(input, { ...pageOptions, onProgress: (options as QueryAllOptions<Frontmatter>).onProgress });
      for await (const outcome of pages) {
        if (!outcome.ok) return outcome;
        const page = outcome.value;
        results.push(...page.results);
        finalPage = page;
        diagnostics.push(...outcome.diagnostics);
      }
      if (budget.signal.aborted) throw requestAbortReason(budget.signal);
      const meta = finalPage ? {
        ...(finalPage.meta?.totalCount === undefined
          ? (!finalPage.meta?.hasMore ? { totalCount: results.length } : {})
          : { totalCount: finalPage.meta.totalCount }),
        ...(finalPage.meta?.hasMore && finalPage.meta.totalCountOutcome ? { totalCountOutcome: finalPage.meta.totalCountOutcome } : {}),
        hasMore: finalPage.meta?.hasMore ?? false,
        ...(finalPage.snapshot ? { snapshot: finalPage.snapshot } : {})
      } : undefined;
      // Every page is parsed in the requested mode, never converted from full
      // rows to revision-required metadata (or from partial rows to documents).
      return input.output === "metadata"
        ? connectSuccess({ output: "metadata", results: results as QueryMetadataRecord[], ...(meta ? { meta } : {}) }, diagnostics)
        : connectSuccess({ results: results as QueryRecord<Frontmatter>[], ...(meta ? { meta } : {}) }, diagnostics);
    } catch (error) {
      if (error instanceof MdbaseConnectError) {
        return connectFailure(error.problem) as ConnectOutcome<
          QueryResult<Frontmatter> | QueryMetadataResult,
          CollectionQueryProblemCode
        >;
      }
      throw error;
    } finally {
      budget.dispose();
    }
  }

  async listViews(options?: ConnectRequestOptions): Promise<ConnectOutcome<SavedViewList, CollectionReadProblemCode>> {
    const outcome = await this.envelopeOperation<WireSavedViewList, CollectionReadProblemCode>("list_views", {}, COLLECTION_READ_PROBLEM_CODES, options);
    return mapOutcome(outcome, (value) => ({ views: value.views, meta: { totalCount: value.meta.total_count } }));
  }

  async executeView(input: ExecuteViewInput, options?: ConnectRequestOptions): Promise<ConnectOutcome<SavedViewExecution<Frontmatter>, CollectionReadProblemCode>> {
    const outcome = await this.envelopeOperation<WireSavedViewExecution<Frontmatter>, CollectionReadProblemCode>("execute_view", input satisfies WireExecuteViewInput, COLLECTION_READ_PROBLEM_CODES, options);
    return mapOutcome(outcome, wireSavedViewExecution);
  }

  async *executeViewPages(
    input: ExecuteViewInput,
    options: SavedViewPagesOptions<Frontmatter> = {}
  ): AsyncGenerator<ConnectOutcome<SavedViewPage<Frontmatter>, CollectionReadProblemCode>> {
    yield* coordinatedSavedViewPages(
      (pageInput, pageOptions) => this.executeView(pageInput, pageOptions),
      (cursor) => this.releaseQueryCursor(cursor),
      input,
      options
    );
  }

  readViewSource(input: ReadViewSourceInput, options?: ConnectRequestOptions): Promise<ConnectOutcome<SavedViewSourceDocument, CollectionReadProblemCode>> {
    return this.envelopeOperation("read_view_source", input, COLLECTION_READ_PROBLEM_CODES, options);
  }

  createViewSource(input: CreateViewSourceInput, options?: ConnectRequestOptions): Promise<ConnectOutcome<SavedViewSourceDocument, CollectionMutationProblemCode>> {
    return this.envelopeOperation("create_view_source", input, COLLECTION_MUTATION_PROBLEM_CODES, options);
  }

  updateViewSource(input: UpdateViewSourceInput, options?: ConnectRequestOptions): Promise<ConnectOutcome<SavedViewSourceDocument, CollectionMutationProblemCode>> {
    return this.envelopeOperation("update_view_source", wireRevisionInput(input), COLLECTION_MUTATION_PROBLEM_CODES, options);
  }

  deleteViewSource(input: DeleteViewSourceInput, options?: ConnectRequestOptions): Promise<ConnectOutcome<DeleteViewSourceResult, CollectionMutationProblemCode>> {
    return this.envelopeOperation("delete_view_source", wireRevisionInput(input), COLLECTION_MUTATION_PROBLEM_CODES, options);
  }

  async create(input: CreateInput<Frontmatter>, options?: ConnectRequestOptions): Promise<ConnectOutcome<RecordDocument<Frontmatter>, CollectionMutationProblemCode>> {
    const outcome = await this.envelopeOperation<WireRecordDocument<Frontmatter>, CollectionMutationProblemCode>("create", wireCreateInput(input), COLLECTION_MUTATION_PROBLEM_CODES, options);
    return mapOutcome(outcome, wireRecordDocument);
  }

  async update(input: UpdateInput<Frontmatter>, options?: ConnectRequestOptions): Promise<ConnectOutcome<RecordDocument<Frontmatter>, CollectionMutationProblemCode>> {
    const outcome = await this.envelopeOperation<WireRecordDocument<Frontmatter>, CollectionMutationProblemCode>("update", wireUpdateInput(input), COLLECTION_MUTATION_PROBLEM_CODES, options);
    return mapOutcome(outcome, wireRecordDocument);
  }

  async delete(input: DeleteInput, options?: ConnectRequestOptions): Promise<ConnectOutcome<DeleteResult, CollectionMutationProblemCode>> {
    const outcome = await this.envelopeOperation<WireDeleteResult, CollectionMutationProblemCode>("delete", wireDeleteInput(input), COLLECTION_MUTATION_PROBLEM_CODES, options);
    return mapOutcome(outcome, wireDeleteResult);
  }

  async preflightDelete(input: DeleteInput, options?: ConnectRequestOptions): Promise<ConnectOutcome<DeletePreflightResult, CollectionMutationProblemCode>> {
    const outcome = await this.envelopeOperation<WireDeletePreflightResult, CollectionMutationProblemCode>("delete", {
      ...wireDeleteInput(input),
      check_backlinks: true,
      dry_run: true
    }, COLLECTION_MUTATION_PROBLEM_CODES, options);
    return mapOutcome(outcome, wireDeletePreflightResult);
  }

  async rename(input: RenameInput, options?: ConnectRequestOptions): Promise<ConnectOutcome<RenameResult, CollectionMutationProblemCode>> {
    const outcome = await this.envelopeOperation<WireRenameResult, CollectionMutationProblemCode>("rename", wireRenameInput(input), COLLECTION_MUTATION_PROBLEM_CODES, options);
    return mapOutcome(outcome, wireRenameResult);
  }

  async preflightRename(input: RenameInput, options?: ConnectRequestOptions): Promise<ConnectOutcome<RenamePreflightResult, CollectionMutationProblemCode>> {
    const outcome = await this.envelopeOperation<WireRenamePreflightResult, CollectionMutationProblemCode>("rename", {
      ...wireRenameInput(input),
      dry_run: true
    }, COLLECTION_MUTATION_PROBLEM_CODES, options);
    return mapOutcome(outcome, wireRenamePreflightResult);
  }

  validate(input: JsonObject = {}, options?: ConnectRequestOptions): Promise<ConnectOutcome<JsonObject, CollectionReadProblemCode>> {
    return this.envelopeOperation("validate", input, COLLECTION_READ_PROBLEM_CODES, options);
  }

  readType(input: ReadTypeInput, options?: ConnectRequestOptions): Promise<ConnectOutcome<CollectionTypeDocument, CollectionTypeProblemCode>> {
    return this.envelopeOperation("read_type", input, COLLECTION_TYPE_PROBLEM_CODES, options);
  }

  createType(input: CreateTypeInput, options?: ConnectRequestOptions): Promise<ConnectOutcome<CollectionTypeDocument, CollectionTypeProblemCode>> {
    return this.envelopeOperation("create_type", input, COLLECTION_TYPE_PROBLEM_CODES, options);
  }

  updateType(input: UpdateTypeInput, options?: ConnectRequestOptions): Promise<ConnectOutcome<CollectionTypeDocument, CollectionTypeProblemCode>> {
    return this.envelopeOperation("update_type", wireRevisionInput(input), COLLECTION_TYPE_PROBLEM_CODES, options);
  }

  async assessTypePack(input: AssessTypePackInput, options?: ConnectRequestOptions): Promise<ConnectOutcome<TypePackAssessment, CollectionTypeProblemCode>> {
    const outcome = await this.envelopeOperation<WireTypePackAssessment, CollectionTypeProblemCode>("assess_type_pack", wireAssessTypePackInput(input), COLLECTION_TYPE_PROBLEM_CODES, options);
    return mapOutcome(outcome, wireTypePackAssessment);
  }

  async applyTypePack(input: ApplyTypePackInput, options?: ConnectRequestOptions): Promise<ConnectOutcome<TypePackApplyResult, CollectionTypeProblemCode>> {
    const outcome = await this.envelopeOperation<WireTypePackApplyResult, CollectionTypeProblemCode>("apply_type_pack", wireApplyTypePackInput(input), COLLECTION_TYPE_PROBLEM_CODES, options);
    return mapOutcome(outcome, wireTypePackApplyResult);
  }

  async assessCollectionSetup(input: AssessCollectionSetupInput, options?: ConnectRequestOptions): Promise<ConnectOutcome<CollectionSetupAssessment, CollectionTypeProblemCode>> {
    const outcome = await this.envelopeOperation<WireCollectionSetupAssessment, CollectionTypeProblemCode>("assess_collection_setup", wireAssessCollectionSetupInput(input), COLLECTION_TYPE_PROBLEM_CODES, options);
    return mapOutcome(outcome, wireCollectionSetupAssessment);
  }

  async applyCollectionSetup(input: ApplyCollectionSetupInput, options?: ConnectRequestOptions): Promise<ConnectOutcome<CollectionSetupApplyResult, CollectionTypeProblemCode>> {
    const outcome = await this.envelopeOperation<WireCollectionSetupApplyResult, CollectionTypeProblemCode>("apply_collection_setup", wireApplyCollectionSetupInput(input), COLLECTION_TYPE_PROBLEM_CODES, options);
    return mapOutcome(outcome, (value) => ({
      assessment: wireCollectionSetupAssessment(value.assessment),
      receipt: wireCollectionSetupReceipt(value.receipt)
    }));
  }

  async listTimers(namespace: string, options?: ConnectRequestOptions): Promise<ConnectOutcome<MdbaseTimerList, CollectionReadProblemCode>> {
    const outcome = await this.rawOperation<WireTimerList, CollectionReadProblemCode>("list_timers", { namespace }, COLLECTION_READ_PROBLEM_CODES, options);
    return mapOutcome(outcome, (value) => ({
      namespace: value.namespace,
      timers: value.timers.map(wireTimer)
    }));
  }

  async putTimer(input: {
    namespace: string;
    criterionId: string;
    timer: MdbaseDesiredTimer;
  }, options?: ConnectRequestOptions): Promise<ConnectOutcome<MdbaseTimer, CollectionMutationProblemCode>> {
    const outcome = await this.rawOperation<WireTimer, CollectionMutationProblemCode>("put_timer", {
      namespace: input.namespace,
      criterion_id: input.criterionId,
      timer: wireDesiredTimer(input.timer)
    }, COLLECTION_MUTATION_PROBLEM_CODES, options);
    return mapOutcome(outcome, wireTimer);
  }

  cancelTimer(input: {
    namespace: string;
    id: string;
    generation?: number;
  }, options?: ConnectRequestOptions): Promise<ConnectOutcome<{ namespace: string; id: string; cancelled: boolean }, CollectionMutationProblemCode>> {
    return this.rawOperation("cancel_timer", input, COLLECTION_MUTATION_PROBLEM_CODES, options);
  }

  async reconcileTimers(input: {
    namespace: string;
    criterionId: string;
    timers: MdbaseDesiredTimer[];
  }, options?: ConnectRequestOptions): Promise<ConnectOutcome<MdbaseTimerReconciliation, CollectionMutationProblemCode>> {
    const outcome = await this.rawOperation<WireTimerReconciliation, CollectionMutationProblemCode>("reconcile_timers", {
      namespace: input.namespace,
      criterion_id: input.criterionId,
      timers: input.timers.map(wireDesiredTimer)
    }, COLLECTION_MUTATION_PROBLEM_CODES, options);
    return mapOutcome(outcome, (value) => ({
      namespace: value.namespace,
      timers: value.timers.map(wireTimer),
      cancelledIds: value.cancelled_ids
    }));
  }

  async *watch(options: WatchOptions = {}): AsyncGenerator<ConnectOutcome<CollectionChange, CollectionChangesProblemCode>> {
    let cursor = options.cursor;
    const pollInterval = Math.max(100, options.pollIntervalMs ?? 1_000);
    const retry = watchRetryPolicy(options.retry);
    let failures = 0;
    let connected = false;
    options.onStatus?.({ state: "connecting", ...(cursor === undefined ? {} : { cursor }) });
    while (!options.signal?.aborted) {
      const changed = await this.changes(
        cursor === undefined ? {} : { after: cursor, limit: 200 },
        { signal: options.signal, timeoutMs: options.timeoutMs }
      );
      if (!changed.ok) {
        const problem = changed.problem;
        if (options.signal?.aborted) return;
        if (!retry || problem.recovery !== "retry") {
          yield changed;
          return;
        }
        connected = false;
        failures += 1;
        if (retry.maxAttempts !== undefined && failures > retry.maxAttempts) {
          yield changed;
          return;
        }
        const retryInMs = Math.min(
          retry.maxDelayMs,
          Math.round(retry.initialDelayMs * retry.multiplier ** (failures - 1))
        );
        options.onStatus?.({
          state: "reconnecting",
          ...(cursor === undefined ? {} : { cursor }),
          attempt: failures,
          retryInMs,
          problem
        });
        try {
          await abortableDelay(retryInMs, options.signal);
        } catch {
          if (!options.signal?.aborted) throw connectError("operation_failed", "Watch retry delay failed unexpectedly.");
        }
        continue;
      }
      const page = changed.value;
      if (cursor === undefined) {
        cursor = page.cursor;
        continue;
      }
      if (page.reset) {
          const problem = connectProblem(
            "change_cursor_reset",
            "The collection change cursor expired. Refresh collection state before subscribing again."
          );
          options.onStatus?.({ state: "reset_required", cursor, problem });
          yield connectFailure(problem);
          return;
        }
        const recovered = failures > 0;
        failures = 0;
        if (!connected || recovered) options.onStatus?.({ state: "connected", cursor, recovered });
        connected = true;
        for (const event of page.events) yield connectSuccess(event);
        cursor = page.cursor;
        if (!page.hasMore) {
          try {
            await pollDelay(pollInterval, options.signal);
          } catch {
            if (!options.signal?.aborted) throw connectError("operation_failed", "Watch polling delay failed unexpectedly.");
          }
        }
      }
    }

  private rawOperation<Result, Code extends CommonOperationProblemCode | CollectionReadProblemCode | CollectionMutationProblemCode | CollectionChangesProblemCode>(
    operation: CollectionOperation,
    input: unknown,
    allowedCodes: readonly Code[],
    options?: ConnectRequestOptions
  ): Promise<ConnectOutcome<Result, Code>> {
    return captureConnectOutcome(
      () => this.transport.operation<Result>(operation, input, options),
      allowedCodes
    );
  }

  private async releaseQueryCursor(cursor: string, output?: "metadata"): Promise<void> {
    try {
      await withRequestBudget({ timeoutMs: 2_000 }, null, async budget => {
        const options = requestOptionsWithinBudget({ signal: budget.signal, timeoutMs: null, coordination: { coalesce: false } }, budget);
        if (output) {
          // A supplied/stale cursor can reach cleanup even when the page was
          // rejected before dispatch. Never send metadata release to an old route.
          const support = await this.supportsAuthorityFeature?.("query-metadata-v1", options);
          if (!support?.ok || !support.value) return;
        }
        await this.envelopeOperation<WireQueryResult<Frontmatter>, CollectionQueryProblemCode>(
          "query", { release_cursor: cursor, ...(output ? { output } : {}) }, COLLECTION_QUERY_PROBLEM_CODES, options
        );
      });
    } catch {
      // Lease expiry is bounded by the authority; cleanup never masks query results.
    }
  }

  private async envelopeOperation<Result, Code extends CollectionReadProblemCode | CollectionQueryProblemCode | CollectionMutationProblemCode | CollectionTypeProblemCode>(
    operation: CollectionOperation,
    input: unknown,
    allowedCodes: readonly Code[],
    options?: ConnectRequestOptions
  ): Promise<ConnectOutcome<Result, Code>> {
    const transported = await captureConnectOutcome(
      () => this.transport.operation<MdbaseOperationEnvelope<Result>>(operation, input, options),
      allowedCodes
    );
    if (!transported.ok) return transported;
    const envelope = transported.value;
    if (!envelope.valid) {
      return connectFailure(operationProblem(envelope)) as unknown as ConnectOutcome<Result, Code>;
    }
    if (["create_type", "update_type", "apply_type_pack", "apply_collection_setup", "create_view_source", "update_view_source", "delete_view_source"].includes(operation)) {
      this.descriptions.invalidate();
    }
    return connectSuccess(envelope.result, envelope.diagnostics);
  }
}

interface WireDeleteResult {
  path: string;
  deleted: boolean;
  broken_links?: Array<{ path: string }>;
}

interface WireDeletePreflightResult extends WireDeleteResult {
  deleted: false;
  dry_run: true;
  would_delete: true;
}

interface WireRenameResult extends WireRecordDocument {
  from: string;
  to: string;
  references_updated?: JsonObject[];
}

interface WireRenamePreflightResult {
  from: string;
  to: string;
  dry_run: true;
  would_rename: true;
  references_affected?: Array<{ path: string; field?: string; location?: string }>;
  warnings?: Array<{ path: string; message: string }>;
}

interface WireTimer {
  id: string;
  fire_at: string;
  data?: unknown;
  criterion_id: string;
  generation: number;
  status: "scheduled" | "firing" | "fired" | "cancelled";
  created_at: string;
  updated_at: string;
  fired_at: string | null;
}

interface WireTimerList { namespace: string; timers: WireTimer[]; }
interface WireTimerReconciliation extends WireTimerList { cancelled_ids: string[]; }

function mapOutcome<Input, Output, Code extends ConnectProblemCode>(
  outcome: ConnectOutcome<Input, Code>,
  map: (value: Input) => Output
): ConnectOutcome<Output, Code> {
  if (!outcome.ok) return outcome;
  try { return connectSuccess(map(outcome.value), outcome.diagnostics); }
  catch (error) {
    if (error instanceof MdbaseConnectError) return connectFailure(error.problem) as ConnectOutcome<Output, Code>;
    throw error;
  }
}

function wireReadInput(input: ReadInput) {
  return {
    path: input.path,
    ...(input.contract ? { contract: input.contract } : {}),
    ...(input.includeDocument === undefined ? {} : { include_document: input.includeDocument })
  };
}

function wireCreateInput<Frontmatter extends JsonObject>(input: CreateInput<Frontmatter>) {
  return {
    ...(input.path ? { path: input.path } : {}),
    ...(input.type ? { type: input.type } : {}),
    ...(input.contract ? { contract: input.contract } : {}),
    ...(input.frontmatter ? { frontmatter: input.frontmatter } : {}),
    ...(input.body === undefined ? {} : { body: input.body }),
    ...(input.ifRevision ? { if_revision: input.ifRevision } : {}),
    ...(input.includeDocument === undefined ? {} : { include_document: input.includeDocument })
  };
}

function wireUpdateInput<Frontmatter extends JsonObject>(input: UpdateInput<Frontmatter>) {
  return {
    path: input.path,
    ...(input.contract ? { contract: input.contract } : {}),
    ...(input.ifRevision ? { if_revision: input.ifRevision } : {}),
    ...(input.includeDocument === undefined ? {} : { include_document: input.includeDocument }),
    ...(input.document === undefined
      ? { patch: input.patch, ...(input.body === undefined ? {} : { body: input.body }) }
      : { document: input.document })
  };
}

function wireDeleteInput(input: DeleteInput) {
  return {
    path: input.path,
    ...(input.contract ? { contract: input.contract } : {}),
    ...(input.checkBacklinks === undefined ? {} : { check_backlinks: input.checkBacklinks }),
    ...(input.ifRevision ? { if_revision: input.ifRevision } : {})
  };
}

function wireRenameInput(input: RenameInput) {
  return {
    from: input.from,
    to: input.to,
    ...(input.contract ? { contract: input.contract } : {}),
    ...(input.updateRefs === undefined ? {} : { update_refs: input.updateRefs }),
    ...(input.ifRevision ? { if_revision: input.ifRevision } : {}),
    ...(input.includeDocument === undefined ? {} : { include_document: input.includeDocument })
  };
}

function wireRevisionInput<T extends { ifRevision?: string }>(input: T) {
  const { ifRevision, ...rest } = input;
  return { ...rest, ...(ifRevision ? { if_revision: ifRevision } : {}) };
}

function wireAssessTypePackInput(input: AssessTypePackInput): WireAssessTypePackInput {
  return {
    provision: input.provision,
    installed_by: input.installedBy,
    ...(input.adoptResources ? { adopt_resources: input.adoptResources } : {}),
    ...(input.preserveSeedTargets ? { preserve_seed_targets: input.preserveSeedTargets } : {}),
    ...(input.targetOverrides ? { target_overrides: input.targetOverrides } : {}),
    ...(input.contractSetups ? { contract_setups: input.contractSetups.map(wireContractSetupChoice) } : {})
  };
}

function wireApplyTypePackInput(input: ApplyTypePackInput): WireApplyTypePackInput {
  return {
    ...wireAssessTypePackInput(input),
    expected_assessment_digest: input.expectedAssessmentDigest,
    ...(input.allowDowngrade === undefined ? {} : { allow_downgrade: input.allowDowngrade })
  };
}

function wireAssessCollectionSetupInput(
  input: AssessCollectionSetupInput
): WireAssessCollectionSetupInput {
  return {
    application_id: input.applicationId,
    declaration_digest: input.declarationDigest,
    requirements: input.requirements,
    provisions: {
      configuration: input.provisions.configuration,
      type_packs: input.provisions.typePacks
    },
    ...(input.contractSetups ? { contract_setups: input.contractSetups.map(wireContractSetupChoice) } : {}),
    ...(input.typePackAdoptions ? { type_pack_adoptions: input.typePackAdoptions } : {})
  };
}

function wireApplyCollectionSetupInput(
  input: ApplyCollectionSetupInput
): WireApplyCollectionSetupInput {
  return {
    ...wireAssessCollectionSetupInput(input),
    expected_assessment_digest: input.expectedAssessmentDigest,
    expected_collection_revision: input.expectedCollectionRevision,
    expected_provision_digest: input.expectedProvisionDigest,
    ...(input.allowTypePackDowngrades
      ? { allow_type_pack_downgrades: input.allowTypePackDowngrades }
      : {})
  };
}

function wireDeleteResult(value: WireDeleteResult): DeleteResult {
  return {
    path: value.path,
    deleted: value.deleted,
    ...(value.broken_links ? { brokenLinks: value.broken_links } : {})
  };
}

function wireDeletePreflightResult(value: WireDeletePreflightResult): DeletePreflightResult {
  return {
    ...wireDeleteResult(value),
    deleted: false,
    dryRun: true,
    wouldDelete: true
  };
}

function wireRenameResult(value: WireRenameResult): RenameResult {
  const { references_updated, ...record } = value;
  return {
    ...wireRecordDocument(record),
    from: value.from,
    to: value.to,
    ...(references_updated ? { referencesUpdated: references_updated } : {})
  };
}

function wireRenamePreflightResult(value: WireRenamePreflightResult): RenamePreflightResult {
  return {
    from: value.from,
    to: value.to,
    dryRun: true,
    wouldRename: true,
    ...(value.references_affected ? { referencesAffected: value.references_affected } : {}),
    ...(value.warnings ? { warnings: value.warnings } : {})
  };
}

function wireDesiredTimer(timer: MdbaseDesiredTimer) {
  return { id: timer.id, fire_at: timer.fireAt, ...(timer.data === undefined ? {} : { data: timer.data }) };
}

function wireTimer(timer: WireTimer): MdbaseTimer {
  return {
    id: timer.id,
    fireAt: timer.fire_at,
    ...(timer.data === undefined ? {} : { data: timer.data }),
    criterionId: timer.criterion_id,
    generation: timer.generation,
    status: timer.status,
    createdAt: timer.created_at,
    updatedAt: timer.updated_at,
    firedAt: timer.fired_at
  };
}

function wireContractSetupChoice(choice: import("./operation-types.js").ContractSetupChoice): import("@mdbase-dev/connect-protocol").ContractSetupChoice {
  return choice.mode === "starter"
    ? choice
    : {
        contract: choice.contract,
        mode: "existing",
        type_name: choice.typeName,
        type_revision: choice.typeRevision,
        fields: choice.fields,
        ...(choice.binding ? { binding: choice.binding } : {})
      };
}

function wireRecordDocument<Frontmatter extends JsonObject>(value: WireRecordDocument<Frontmatter>): RecordDocument<Frontmatter> {
  const { effective_frontmatter, contract, ...record } = value;
  return {
    ...record,
    effectiveFrontmatter: effective_frontmatter,
    ...(contract ? { contract: wireDataContractIdentity(contract) } : {})
  };
}

function wireSavedViewExecution<Frontmatter extends JsonObject>(value: WireSavedViewExecution<Frontmatter>): SavedViewExecution<Frontmatter> {
  return {
    results: value.results.map((record) => {
      const mapped = wireQueryRecord(record);
      if (!mapped.effectiveFrontmatter) {
        throw new Error("Saved view result omitted canonical effective frontmatter.");
      }
      return { ...mapped, effectiveFrontmatter: mapped.effectiveFrontmatter };
    }),
    meta: {
      totalCount: value.meta.total_count,
      hasMore: value.meta.has_more,
      ...(value.meta.cursor ? { cursor: value.meta.cursor } : {}),
      view: value.meta.view,
      ...(value.meta.context ? { context: value.meta.context } : {}),
      ...(value.meta.groups ? { groups: value.meta.groups } : {})
    }
  };
}

function wireTypePackResource(value: import("@mdbase-dev/connect-protocol").TypePackResourceDiff): import("./operation-types.js").TypePackResourceDiff {
  return {
    source: value.source,
    target: value.target,
    kind: value.kind,
    mode: value.mode,
    action: value.action,
    digest: value.digest,
    ...(value.current_digest ? { currentDigest: value.current_digest } : {}),
    ...(value.installed_digest ? { installedDigest: value.installed_digest } : {}),
    ...(value.adopted_from_digest ? { adoptedFromDigest: value.adopted_from_digest } : {}),
    ...(value.upgrade_baseline ? { upgradeBaseline: value.upgrade_baseline } : {}),
    ...(value.reason ? { reason: value.reason } : {})
  };
}

function wireTypePackReceipt(value: import("@mdbase-dev/connect-protocol").TypePackReceipt): import("./operation-types.js").TypePackReceipt {
  return {
    id: value.id,
    version: value.version,
    digest: value.digest,
    installedBy: value.installed_by,
    resources: value.resources.map((resource) => ({
      source: resource.source,
      target: resource.target,
      kind: resource.kind,
      mode: resource.mode,
      digest: resource.digest,
      ...(resource.adopted_from_digest ? { adoptedFromDigest: resource.adopted_from_digest } : {}),
      ...(resource.origin_digest ? { originDigest: resource.origin_digest } : {})
    }))
  };
}

function clientContractSetupChoice(choice: import("@mdbase-dev/connect-protocol").ContractSetupChoice): import("./operation-types.js").ContractSetupChoice {
  return choice.mode === "starter"
    ? choice
    : {
        contract: choice.contract,
        mode: "existing",
        typeName: choice.type_name,
        typeRevision: choice.type_revision,
        fields: choice.fields,
        ...(choice.binding ? { binding: choice.binding } : {})
      };
}

function wireTypePackAssessment(value: WireTypePackAssessment): TypePackAssessment {
  return {
    status: value.status,
    applicable: value.applicable,
    assessmentDigest: value.assessment_digest,
    ...(value.current ? { current: wireTypePackReceipt(value.current) } : {}),
    desired: wireTypePackReceipt(value.desired),
    resources: value.resources.map(wireTypePackResource),
    lock: value.lock,
    contractSetups: {
      choices: value.contract_setups.choices.map(clientContractSetupChoice),
      resources: value.contract_setups.resources.map(wireTypePackResource)
    }
  };
}

function wireTypePackApplyResult(value: WireTypePackApplyResult): TypePackApplyResult {
  return {
    ...wireTypePackAssessment(value),
    receipt: wireTypePackReceipt(value.receipt),
    cleanupDeferred: value.cleanup_deferred
  };
}

function wireCollectionSetupAssessment(value: WireCollectionSetupAssessment): CollectionSetupAssessment {
  return {
    status: value.status,
    applicable: value.applicable,
    applicationId: value.application_id,
    declarationDigest: value.declaration_digest,
    provisionDigest: value.provision_digest,
    collectionRevision: value.collection_revision,
    finalCollectionRevision: value.final_collection_revision,
    configuration: value.configuration,
    typePacks: value.type_packs.map(wireTypePackAssessment),
    finalResourceRevisions: value.final_resource_revisions,
    assessmentDigest: value.assessment_digest
  };
}
function wireCollectionSetupReceipt(value: import("@mdbase-dev/connect-protocol").CollectionSetupReceipt): import("./operation-types.js").CollectionSetupReceipt {
  return {
    applicationId: value.application_id,
    declarationDigest: value.declaration_digest,
    provisionDigest: value.provision_digest,
    assessmentDigest: value.assessment_digest,
    collectionRevision: value.collection_revision,
    configuration: value.configuration,
    typePacks: value.type_packs.map(wireTypePackReceipt),
    cleanupDeferred: value.cleanup_deferred
  };
}
