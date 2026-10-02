import type { JsonObject } from "@mdbase-dev/connect-protocol";
import { connectProblem } from "./errors.js";
import {
  connectFailure,
  connectSuccess,
  type CollectionReadProblemCode,
  type ConnectOutcome
} from "./outcomes.js";
import type {
  ConnectRequestOptions,
  ExecuteViewInput,
  SavedViewExecution,
  SavedViewPage,
  SavedViewPagesOptions
} from "./operation-types.js";

import { nonNegativeInteger, positiveInteger, queryCursorLease, resultCap } from "./query-pagination-internals.js";

type SavedViewOperation<Frontmatter extends JsonObject> = (
  input: ExecuteViewInput,
  options?: ConnectRequestOptions
) => Promise<ConnectOutcome<SavedViewExecution<Frontmatter>, CollectionReadProblemCode>>;

export async function* coordinatedSavedViewPages<Frontmatter extends JsonObject>(
  executeView: SavedViewOperation<Frontmatter>,
  releaseQueryCursor: (cursor: string) => Promise<void>,
  input: ExecuteViewInput,
  options: SavedViewPagesOptions<Frontmatter> = {}
): AsyncGenerator<ConnectOutcome<SavedViewPage<Frontmatter>, CollectionReadProblemCode>> {
  const { offset: requestedOffset, limit: requestedLimit, cursor: requestedCursor, ...criteria } = input;
  let offset = nonNegativeInteger(requestedOffset, 0);
  const firstPageSize = positiveInteger(options.firstPageSize ?? options.pageSize ?? requestedLimit, 200);
  const pageSize = positiveInteger(options.pageSize ?? requestedLimit, 1_000);
  let cursor = requestedCursor;
  let cursorMode = requestedCursor !== undefined;
  const maxResults = resultCap(options.maxResults);
  const lease = queryCursorLease(releaseQueryCursor, options.signal, requestedCursor);
  let loaded = 0;
  let pageNumber = 0;
  try {
    while (!options.signal?.aborted && loaded < maxResults) {
      lease.startRequest();
      const pageCursor = cursor;
      const outcome = await executeView(
        {
          ...criteria,
          ...(!cursorMode ? { limit: Math.min(pageNumber === 0 ? firstPageSize : pageSize, maxResults - loaded) } : {}),
          ...(cursorMode && pageCursor ? { cursor: pageCursor } : { offset })
        },
        {
          signal: options.signal,
          timeoutMs: options.pageTimeoutMs,
          coordination: { ...options.coordination, coalesce: false }
        }
      );
      lease.finishRequest(outcome.ok ? outcome.value.meta.cursor : undefined);
      if (options.signal?.aborted) return;
      if (!outcome.ok) {
        lease.dispose();
        yield outcome;
        return;
      }
      const result = outcome.value;
      const returnedCursor = result.meta.cursor;
      if (returnedCursor) {
        cursorMode = true;
        cursor = returnedCursor;
      } else if (cursorMode) {
        cursor = undefined;
      }
      if (cursorMode && result.meta.hasMore && !returnedCursor) {
        lease.dispose();
        yield connectFailure(connectProblem(
          "invalid_operation_response",
          "The collection authority omitted the cursor required for the next saved-view page."
        ));
        return;
      }
      const remaining = maxResults - loaded;
      const results = result.results.length > remaining ? result.results.slice(0, remaining) : result.results;
      loaded += results.length;
      const complete = loaded >= maxResults || !result.meta.hasMore || result.results.length === 0;
      const page: SavedViewPage<Frontmatter> = {
        ...result,
        results,
        page: pageNumber,
        offset,
        loaded,
        complete,
        ...(returnedCursor ? { cursor: returnedCursor } : {})
      };
      if (complete) lease.dispose();
      options.onProgress?.(page);
      yield connectSuccess(page, outcome.diagnostics);
      if (complete) return;
      offset += result.results.length;
      pageNumber += 1;
    }
  } finally {
    lease.dispose();
  }
}
