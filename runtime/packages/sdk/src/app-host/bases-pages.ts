/** Saved-view result pages over native app Bases windows (prod
 * `executeViewPages`). Each page is one independent windowed READ: native has no
 * cross-request cursor or snapshot, so pages report when the collection changed
 * since the first page (rows may then be skipped or repeated). */
import { mdbaseError } from "../errors.js";
import type { AppBasesRequest, AppBasesResult } from "./bases-wire.js";

type Success = Extract<AppBasesResult, { kind: "success" }>;

export interface AppBasesPagesOptions {
  /** Rows in the first page (default 200). */
  firstPageSize?: number;
  /** Rows in later pages (default 1000; at most 65536). */
  pageSize?: number;
  signal?: AbortSignal;
}

export type AppBasesPage = Success & {
  /** Zero-based page number. */
  page: number;
  /** Global row offset of this page. */
  offset: number;
  /** Rows yielded so far, this page included. */
  loaded: number;
  /** No rows remain after this page. */
  complete: boolean;
  /** The collection revision or matched-row count differs from the first page. */
  changedSinceFirst: boolean;
};

const size = (n: number | undefined, fallback: number): number => {
  if (n === undefined) return fallback;
  if (!Number.isInteger(n) || n < 1 || n > 65536) throw mdbaseError("invalid_request", "page size must be 1..65536");
  return n;
};

/** Yields success pages until the matched rows are exhausted; a native refusal
 * is yielded once and ends the iteration. */
export async function* appBasesPages(
  execute: (request: AppBasesRequest, signal?: AbortSignal) => Promise<AppBasesResult>,
  request: AppBasesRequest,
  options: AppBasesPagesOptions = {},
): AsyncGenerator<AppBasesPage | Extract<AppBasesResult, { kind: "refusal" }>> {
  const first = size(options.firstPageSize, 200), later = size(options.pageSize, 1000);
  let offset = request.window?.offset ?? 0, loaded = 0, page = 0;
  let baseline: { revision: string; total: number } | undefined;
  for (;;) {
    options.signal?.throwIfAborted();
    const result = await execute({ ...request, window: { offset, limit: page === 0 ? first : later } }, options.signal);
    if (result.kind === "refusal") {
      yield result;
      return;
    }
    const total = result.window?.totalMatchedRows;
    if (total === undefined) throw mdbaseError("internal", "native Bases page omitted its window");
    baseline ??= { revision: result.collectionRevision, total };
    loaded += result.rows.length;
    const complete = result.rows.length === 0 || offset + result.rows.length >= total;
    yield {
      ...result, page, offset, loaded, complete,
      changedSinceFirst: baseline.revision !== result.collectionRevision || baseline.total !== total,
    };
    if (complete) return;
    offset += result.rows.length;
    page += 1;
  }
}
