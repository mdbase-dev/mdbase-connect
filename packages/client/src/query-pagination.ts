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
  QueryMetadataInput,
  QueryRecord,
  QueryPage,
  QueryPagesOptions,
  QueryResult
} from "./operation-types.js";

import { nonNegativeInteger, positiveInteger, queryCursorLease, resultCap } from "./query-pagination-internals.js";

type QueryOperation<Frontmatter extends JsonObject, Row> = (
  input: QueryInput | QueryMetadataInput,
  options?: ConnectRequestOptions
) => Promise<ConnectOutcome<QueryResult<Frontmatter, Row> & { output?: "metadata" }, CollectionQueryProblemCode>>;

export async function* coordinatedQueryPages<Frontmatter extends JsonObject, Row = QueryRecord<Frontmatter>>(
  query: QueryOperation<Frontmatter, Row>,
  releaseQueryCursor: (cursor: string) => Promise<void>,
  input: QueryInput | QueryMetadataInput = {},
  options: QueryPagesOptions<Frontmatter, Row> = {}
): AsyncGenerator<ConnectOutcome<QueryPage<Frontmatter, Row> & { output?: "metadata" }, CollectionQueryProblemCode>> {
    const {
      offset: requestedOffset,
      limit: requestedLimit,
      cursor: requestedCursor,
      pagination: requestedPagination,
      snapshot: requestedSnapshot,
      ...criteria
    } = input;
    let offset = nonNegativeInteger(requestedOffset, 0);
    const firstPageSize = positiveInteger(options.firstPageSize ?? options.pageSize ?? requestedLimit, 200);
    const pageSize = positiveInteger(options.pageSize ?? requestedLimit, 1_000);
    let cursor = requestedCursor;
    let cursorMode = requestedCursor !== undefined;
    const maxResults = resultCap(options.maxResults);
    const lease = queryCursorLease(releaseQueryCursor, options.signal, requestedCursor);
    let snapshot = requestedSnapshot;
    let loaded = 0;
    let pageNumber = 0;

    try {
      while (!options.signal?.aborted && loaded < maxResults) {
        lease.startRequest();
        const pageCursor = cursor;
        const pageRequestOptions = {
          signal: options.signal,
          timeoutMs: options.pageTimeoutMs,
          coordination: { ...options.coordination, coalesce: false }
        };
        const automaticCursorProbe = pageNumber === 0
          && requestedCursor === undefined
          && requestedPagination === undefined
          && requestedSnapshot === undefined
          && input.output !== "metadata";
        let queried = await query({
          ...criteria,
          // Initial size is portable across authorities; continuations use the
          // pinned size. Do not infer variable-size support from operation errors.
          ...(!cursorMode
            ? { limit: Math.min(pageNumber === 0 ? firstPageSize : pageSize, maxResults - loaded) }
            : {}),
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
        // schema; explicit cursor requests remain strict. This existing fallback
        // serves pre-cursor desktop authorities; remove when those are unsupported.
        if (
          automaticCursorProbe
          && !options.signal?.aborted
          && !queried.ok
          && queried.problem.code === "operation_invalid"
        ) {
          queried = await query({
            ...criteria,
            limit: Math.min(firstPageSize, maxResults - loaded),
            offset
          }, pageRequestOptions);
        }
        lease.finishRequest(queried.ok ? queried.value.meta?.cursor : undefined);
        if (options.signal?.aborted) return;
        if (!queried.ok) {
          lease.dispose();
          yield queried;
          return;
        }
        const result = queried.value;
        const returnedCursor = result.meta?.cursor;
        if (returnedCursor) {
          cursorMode = true;
          cursor = returnedCursor;
        } else if (cursorMode) {
          cursor = undefined;
        }
        if (cursorMode && result.meta?.hasMore && !returnedCursor) {
          lease.dispose();
          yield connectFailure(connectProblem(
            "invalid_operation_response",
            "The collection authority omitted the cursor required for the next query page."
          ));
          return;
        }
        const returnedSnapshot = result.meta?.snapshot;
        if (!cursorMode && snapshot && returnedSnapshot && snapshot !== returnedSnapshot) {
          lease.dispose();
          yield connectFailure(connectProblem(
            "query_snapshot_changed",
            "The collection query snapshot changed while paging. Refresh the query before continuing."
          ));
          return;
        }
        if (!cursorMode && !snapshot && returnedSnapshot) snapshot = returnedSnapshot;
        const remaining = maxResults - loaded;
        const results = result.results.length > remaining ? result.results.slice(0, remaining) : result.results;
        loaded += results.length;
        const complete = loaded >= maxResults || !result.meta?.hasMore || result.results.length === 0;
        const page: QueryPage<Frontmatter, Row> & { output?: "metadata" } = {
          ...(result.output ? { output: result.output } : {}),
          results,
          ...(result.meta ? { meta: result.meta } : {}),
          page: pageNumber,
          offset,
          loaded,
          complete,
          ...(returnedCursor ? { cursor: returnedCursor } : {}),
          ...(!cursorMode && snapshot ? { snapshot } : {})
        };
        if (complete) lease.dispose();
        options.onProgress?.(page);
        yield connectSuccess(page, queried.diagnostics);
        if (complete) return;
        offset += result.results.length;
        pageNumber += 1;
      }
    } finally {
      lease.dispose();
    }
}
