import type { JsonObject } from "@mdbase-dev/connect-protocol";
import { connectProblem } from "./errors.js";
import {
  connectFailure,
  connectSuccess,
  type CollectionQueryProblemCode,
  type ConnectOutcome
} from "./outcomes.js";
import type {
  ConnectRequestOptions,
  QueryInput,
  QueryPage,
  QueryPagesOptions,
  QueryResult
} from "./operation-types.js";

type QueryOperation<Frontmatter extends JsonObject> = (
  input: QueryInput,
  options?: ConnectRequestOptions
) => Promise<ConnectOutcome<QueryResult<Frontmatter>, CollectionQueryProblemCode>>;

export async function* coordinatedQueryPages<Frontmatter extends JsonObject>(
  query: QueryOperation<Frontmatter>,
  releaseQueryCursor: (cursor: string) => Promise<void>,
  input: QueryInput = {},
  options: QueryPagesOptions<Frontmatter> = {}
): AsyncGenerator<ConnectOutcome<QueryPage<Frontmatter>, CollectionQueryProblemCode>> {
    const {
      offset: requestedOffset,
      limit: requestedLimit,
      cursor: requestedCursor,
      pagination: requestedPagination,
      snapshot: requestedSnapshot,
      ...criteria
    } = input;
    let offset = nonNegativeInteger(requestedOffset, 0);
    const firstPageSize = positiveInteger(options.firstPageSize ?? requestedLimit, 200);
    const pageSize = positiveInteger(options.pageSize ?? requestedLimit, 1_000);
    let cursor = requestedCursor;
    let cursorMode = requestedCursor !== undefined;
    let cursorToRelease = requestedCursor;
    let snapshot = requestedSnapshot;
    let loaded = 0;
    let pageNumber = 0;

    try {
      while (!options.signal?.aborted) {
        const pageCursor = cursor;
        const pageRequestOptions = {
          signal: options.signal,
          timeoutMs: options.pageTimeoutMs,
          coordination: { ...options.coordination, coalesce: false }
        };
        const automaticCursorProbe = pageNumber === 0
          && requestedCursor === undefined
          && requestedPagination === undefined
          && requestedSnapshot === undefined;
        let queried = await query({
          ...criteria,
          limit: pageNumber === 0 ? firstPageSize : pageSize,
          ...(cursorMode
            ? (pageCursor ? { cursor: pageCursor } : { pagination: "cursor" as const })
            : {
                offset,
                ...(snapshot ? { snapshot } : {}),
                ...(!snapshot && requestedPagination === "cursor"
                  ? { pagination: "cursor" as const }
                  : {})
              }),
          ...(!cursorMode && !snapshot && automaticCursorProbe
            ? { pagination: "cursor" as const }
            : {})
        }, pageRequestOptions);
        // Cursor pagination is a read-only capability probe for authorities
        // predating generation cursors. Retry the first page without that
        // optional field only when the authority rejected the operation
        // schema; explicit cursor requests remain strict.
        if (
          automaticCursorProbe
          && !queried.ok
          && queried.problem.code === "operation_invalid"
        ) {
          queried = await query({
            ...criteria,
            limit: firstPageSize,
            offset
          }, pageRequestOptions);
        }
        if (!queried.ok) {
          yield queried;
          return;
        }
        const result = queried.value;
        const returnedCursor = result.meta?.cursor;
        if (returnedCursor) {
          cursorMode = true;
          cursor = returnedCursor;
          cursorToRelease = returnedCursor;
        } else if (cursorMode) {
          cursor = undefined;
          cursorToRelease = pageCursor;
        }
        if (cursorMode && result.meta?.hasMore && !returnedCursor) {
          yield connectFailure(connectProblem(
            "invalid_operation_response",
            "The collection authority omitted the cursor required for the next query page."
          ));
          return;
        }
        const returnedSnapshot = result.meta?.snapshot;
        if (!cursorMode && snapshot && returnedSnapshot && snapshot !== returnedSnapshot) {
          yield connectFailure(connectProblem(
            "query_snapshot_changed",
            "The collection query snapshot changed while paging. Refresh the query before continuing."
          ));
          return;
        }
        if (!cursorMode && !snapshot && returnedSnapshot) snapshot = returnedSnapshot;
        loaded += result.results.length;
        const complete = !result.meta?.hasMore || result.results.length === 0;
        const page: QueryPage<Frontmatter> = {
          results: result.results,
          ...(result.meta ? { meta: result.meta } : {}),
          page: pageNumber,
          offset,
          loaded,
          complete,
          ...(returnedCursor ? { cursor: returnedCursor } : {}),
          ...(!cursorMode && snapshot ? { snapshot } : {})
        };
        options.onProgress?.(page);
        yield connectSuccess(page, queried.diagnostics);
        if (complete) return;
        offset += result.results.length;
        pageNumber += 1;
      }
    } finally {
      if (cursorMode && cursorToRelease) {
        await releaseQueryCursor(cursorToRelease);
      }
    }

}

function nonNegativeInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : fallback;
}

function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}
