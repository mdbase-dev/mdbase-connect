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
  MdbaseOperationEnvelope,
  ReadViewSourceInput,
  RecordDocument,
  SavedViewExecution,
  SavedViewList,
  SavedViewSourceDocument,
  TypePackInstallResult,
  TypePackProvision,
  UpdateViewSourceInput
} from "@mdbase/connect-protocol";
import { abortableDelay } from "./async.js";
import {
  MdbaseConnectError,
  isRetryableConnectError,
  unwrapOperation
} from "./errors.js";
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
