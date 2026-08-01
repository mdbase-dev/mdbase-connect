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
  JsonObject,
  MdbaseDiagnostic,
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
import { abortableDelay } from "./async.js";
import {
  connectError,
  connectProblem,
  operationProblem
} from "./errors.js";
import {
  COLLECTION_CHANGES_PROBLEM_CODES,
  COLLECTION_DESCRIPTION_PROBLEM_CODES,
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
  CreateInput,
  CreateTypeInput,
  DeleteInput,
  DeletePreflightResult,
  DeleteResult,
  MdbaseCollectionTransport,
  MdbaseDesiredTimer,
  MdbaseTimer,
  MdbaseTimerList,
  MdbaseTimerReconciliation,
  OperationRequestOptions,
  QueryInput,
  QueryPage,
  QueryPagesOptions,
  QueryResult,
  ReadInput,
  ReadTypeInput,
  RenameInput,
  RenamePreflightResult,
  RenameResult,
  UpdateInput,
  UpdateTypeInput,
  WatchOptions
} from "./operation-types.js";

/**
 * Typed collection operations independent of OAuth, HTTP, or storage.
 *
 * Application code can use this surface against Connect, the developer
 * sandbox, or another provider without changing its record logic.
 */
export class MdbaseCollectionClient<Frontmatter extends JsonObject = JsonObject> {
  constructor(private readonly transport: MdbaseCollectionTransport) {}

  operation<Result>(
    operation: CollectionOperation,
    input: unknown,
    options?: OperationRequestOptions
  ): Promise<ConnectOutcome<Result>> {
    return captureConnectOutcome(
      () => this.transport.operation<Result>(operation, input, options),
      ALL_CONNECT_PROBLEM_CODES
    );
  }

  describe(): Promise<ConnectOutcome<CollectionDescription, CollectionDescriptionProblemCode>> {
    return this.rawOperation("describe", {}, COLLECTION_DESCRIPTION_PROBLEM_CODES);
  }

  changes(
    input: ChangesInput = {},
    options?: OperationRequestOptions
  ): Promise<ConnectOutcome<CollectionChangesPage, CollectionChangesProblemCode>> {
    return this.rawOperation("changes", input, COLLECTION_CHANGES_PROBLEM_CODES, options);
  }

  read(input: ReadInput): Promise<ConnectOutcome<RecordDocument<Frontmatter>, CollectionReadProblemCode>> {
    return this.envelopeOperation("read", input, COLLECTION_READ_PROBLEM_CODES);
  }

  query(
    input: QueryInput = {},
    options?: OperationRequestOptions
  ): Promise<ConnectOutcome<QueryResult<Frontmatter>, CollectionQueryProblemCode>> {
    return this.envelopeOperation("query", input, COLLECTION_QUERY_PROBLEM_CODES, options);
  }

  async *queryPages(
    input: QueryInput = {},
    options: QueryPagesOptions<Frontmatter> = {}
  ): AsyncGenerator<ConnectOutcome<QueryPage<Frontmatter>, CollectionQueryProblemCode>> {
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
      const queried = await this.query({
        ...criteria,
        offset,
        limit: pageNumber === 0 ? firstPageSize : pageSize,
        ...(snapshot ? { snapshot } : {})
      }, { signal: options.signal });
      if (!queried.ok) {
        yield queried;
        return;
      }
      const result = queried.value;
      const returnedSnapshot = result.meta?.snapshot;
      if (snapshot && returnedSnapshot && snapshot !== returnedSnapshot) {
        yield connectFailure(connectProblem(
          "query_snapshot_changed",
          "The collection query snapshot changed while paging. Refresh the query before continuing."
        ));
        return;
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
      yield connectSuccess(page, queried.diagnostics);
      if (complete) return;
      offset += result.results.length;
      pageNumber += 1;
    }
  }

  async queryAll(
    input: QueryInput = {},
    options: QueryPagesOptions<Frontmatter> = {}
  ): Promise<ConnectOutcome<QueryResult<Frontmatter>, CollectionQueryProblemCode>> {
    const results: QueryResult<Frontmatter>["results"] = [];
    let finalPage: QueryPage<Frontmatter> | undefined;
    const diagnostics: MdbaseDiagnostic[] = [];
    for await (const outcome of this.queryPages(input, options)) {
      if (!outcome.ok) return outcome;
      const page = outcome.value;
      results.push(...page.results);
      finalPage = page;
      diagnostics.push(...outcome.diagnostics);
    }
    return connectSuccess({
      results,
      meta: {
        ...(finalPage?.meta ?? {}),
        total_count: finalPage?.meta?.total_count ?? results.length,
        has_more: finalPage ? !finalPage.complete : false,
        ...(finalPage?.snapshot ? { snapshot: finalPage.snapshot } : {})
      }
    }, diagnostics);
  }

  listViews(): Promise<ConnectOutcome<SavedViewList, CollectionReadProblemCode>> {
    return this.envelopeOperation("list_views", {}, COLLECTION_READ_PROBLEM_CODES);
  }

  executeView(input: ExecuteViewInput): Promise<ConnectOutcome<SavedViewExecution<Frontmatter>, CollectionReadProblemCode>> {
    return this.envelopeOperation("execute_view", input, COLLECTION_READ_PROBLEM_CODES);
  }

  readViewSource(input: ReadViewSourceInput): Promise<ConnectOutcome<SavedViewSourceDocument, CollectionReadProblemCode>> {
    return this.envelopeOperation("read_view_source", input, COLLECTION_READ_PROBLEM_CODES);
  }

  createViewSource(input: CreateViewSourceInput): Promise<ConnectOutcome<SavedViewSourceDocument, CollectionMutationProblemCode>> {
    return this.envelopeOperation("create_view_source", input, COLLECTION_MUTATION_PROBLEM_CODES);
  }

  updateViewSource(input: UpdateViewSourceInput): Promise<ConnectOutcome<SavedViewSourceDocument, CollectionMutationProblemCode>> {
    return this.envelopeOperation("update_view_source", input, COLLECTION_MUTATION_PROBLEM_CODES);
  }

  deleteViewSource(input: DeleteViewSourceInput): Promise<ConnectOutcome<DeleteViewSourceResult, CollectionMutationProblemCode>> {
    return this.envelopeOperation("delete_view_source", input, COLLECTION_MUTATION_PROBLEM_CODES);
  }

  create(input: CreateInput<Frontmatter>): Promise<ConnectOutcome<RecordDocument<Frontmatter>, CollectionMutationProblemCode>> {
    return this.envelopeOperation("create", input, COLLECTION_MUTATION_PROBLEM_CODES);
  }

  update(input: UpdateInput<Frontmatter>): Promise<ConnectOutcome<RecordDocument<Frontmatter>, CollectionMutationProblemCode>> {
    return this.envelopeOperation("update", input, COLLECTION_MUTATION_PROBLEM_CODES);
  }

  delete(input: DeleteInput, options?: OperationRequestOptions): Promise<ConnectOutcome<DeleteResult, CollectionMutationProblemCode>> {
    return this.envelopeOperation("delete", input, COLLECTION_MUTATION_PROBLEM_CODES, options);
  }

  preflightDelete(input: DeleteInput, options?: OperationRequestOptions): Promise<ConnectOutcome<DeletePreflightResult, CollectionMutationProblemCode>> {
    return this.envelopeOperation("delete", { ...input, check_backlinks: true, dry_run: true }, COLLECTION_MUTATION_PROBLEM_CODES, options);
  }

  rename(input: RenameInput, options?: OperationRequestOptions): Promise<ConnectOutcome<RenameResult, CollectionMutationProblemCode>> {
    return this.envelopeOperation("rename", input, COLLECTION_MUTATION_PROBLEM_CODES, options);
  }

  preflightRename(input: RenameInput, options?: OperationRequestOptions): Promise<ConnectOutcome<RenamePreflightResult, CollectionMutationProblemCode>> {
    return this.envelopeOperation("rename", { ...input, dry_run: true }, COLLECTION_MUTATION_PROBLEM_CODES, options);
  }

  validate(input: JsonObject = {}): Promise<ConnectOutcome<JsonObject, CollectionReadProblemCode>> {
    return this.envelopeOperation("validate", input, COLLECTION_READ_PROBLEM_CODES);
  }

  readType(input: ReadTypeInput): Promise<ConnectOutcome<CollectionTypeDocument, CollectionTypeProblemCode>> {
    return this.envelopeOperation("read_type", input, COLLECTION_TYPE_PROBLEM_CODES);
  }

  createType(input: CreateTypeInput): Promise<ConnectOutcome<CollectionTypeDocument, CollectionTypeProblemCode>> {
    return this.envelopeOperation("create_type", input, COLLECTION_TYPE_PROBLEM_CODES);
  }

  updateType(input: UpdateTypeInput): Promise<ConnectOutcome<CollectionTypeDocument, CollectionTypeProblemCode>> {
    return this.envelopeOperation("update_type", input, COLLECTION_TYPE_PROBLEM_CODES);
  }

  installTypePack(input: TypePackProvision): Promise<ConnectOutcome<TypePackInstallResult, CollectionTypeProblemCode>> {
    return this.envelopeOperation("install_type_pack", input, COLLECTION_TYPE_PROBLEM_CODES);
  }

  listTimers(namespace: string): Promise<ConnectOutcome<MdbaseTimerList, CollectionReadProblemCode>> {
    return this.rawOperation("list_timers", { namespace }, COLLECTION_READ_PROBLEM_CODES);
  }

  putTimer(input: {
    namespace: string;
    criterion_id: string;
    timer: MdbaseDesiredTimer;
  }): Promise<ConnectOutcome<MdbaseTimer, CollectionMutationProblemCode>> {
    return this.rawOperation("put_timer", input, COLLECTION_MUTATION_PROBLEM_CODES);
  }

  cancelTimer(input: {
    namespace: string;
    id: string;
    generation?: number;
  }): Promise<ConnectOutcome<{ namespace: string; id: string; cancelled: boolean }, CollectionMutationProblemCode>> {
    return this.rawOperation("cancel_timer", input, COLLECTION_MUTATION_PROBLEM_CODES);
  }

  reconcileTimers(input: {
    namespace: string;
    criterion_id: string;
    timers: MdbaseDesiredTimer[];
  }): Promise<ConnectOutcome<MdbaseTimerReconciliation, CollectionMutationProblemCode>> {
    return this.rawOperation("reconcile_timers", input, COLLECTION_MUTATION_PROBLEM_CODES);
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
        { signal: options.signal }
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
        if (!page.has_more) {
          try {
            await abortableDelay(pollInterval, options.signal);
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
    options?: OperationRequestOptions
  ): Promise<ConnectOutcome<Result, Code>> {
    return captureConnectOutcome(
      () => this.transport.operation<Result>(operation, input, options),
      allowedCodes
    );
  }

  private async envelopeOperation<Result, Code extends CollectionReadProblemCode | CollectionQueryProblemCode | CollectionMutationProblemCode | CollectionTypeProblemCode>(
    operation: CollectionOperation,
    input: unknown,
    allowedCodes: readonly Code[],
    options?: OperationRequestOptions
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
    return connectSuccess(envelope.result, envelope.diagnostics);
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
