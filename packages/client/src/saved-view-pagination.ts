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
  const firstPageSize = positiveInteger(options.firstPageSize ?? requestedLimit, 200);
  const pageSize = positiveInteger(options.pageSize ?? requestedLimit, 1_000);
  let cursor = requestedCursor;
  let cursorMode = requestedCursor !== undefined;
  let cursorToRelease = requestedCursor;
  let loaded = 0;
  let pageNumber = 0;
  try {
    while (!options.signal?.aborted) {
      const pageCursor = cursor;
      const outcome = await executeView(
        {
          ...criteria,
          limit: pageNumber === 0 ? firstPageSize : pageSize,
          ...(cursorMode && pageCursor ? { cursor: pageCursor } : { offset })
        },
        {
          signal: options.signal,
          timeoutMs: options.pageTimeoutMs,
          coordination: { ...options.coordination, coalesce: false }
        }
      );
      if (!outcome.ok) {
        yield outcome;
        return;
      }
      const result = outcome.value;
      const returnedCursor = result.meta.cursor;
      if (returnedCursor) {
        cursorMode = true;
        cursor = returnedCursor;
        cursorToRelease = returnedCursor;
      } else if (cursorMode) {
        cursor = undefined;
        cursorToRelease = pageCursor;
      }
      if (cursorMode && result.meta.hasMore && !returnedCursor) {
        yield connectFailure(connectProblem(
          "invalid_operation_response",
          "The collection authority omitted the cursor required for the next saved-view page."
        ));
        return;
      }
      loaded += result.results.length;
      const complete = !result.meta.hasMore || result.results.length === 0;
      const page: SavedViewPage<Frontmatter> = {
        ...result,
        page: pageNumber,
        offset,
        loaded,
        complete,
        ...(returnedCursor ? { cursor: returnedCursor } : {})
      };
      options.onProgress?.(page);
      yield connectSuccess(page, outcome.diagnostics);
      if (complete) return;
      offset += result.results.length;
      pageNumber += 1;
    }
  } finally {
    if (cursorMode && cursorToRelease) await releaseQueryCursor(cursorToRelease);
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
