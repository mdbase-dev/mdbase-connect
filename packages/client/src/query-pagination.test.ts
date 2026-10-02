import { describe, expect, it, vi } from "vitest";
import { coordinatedQueryPages } from "./query-pagination.js";
import { coordinatedSavedViewPages } from "./saved-view-pagination.js";
import { connectSuccess, connectFailure } from "./outcomes.js";
import { connectProblem } from "./errors.js";
import type { QueryInput, QueryResult, SavedViewExecution } from "./operation-types.js";

const row = (path: string) => ({ path, types: [], file: {} });

function paging(view: boolean, operation: (input: QueryInput) => Promise<ReturnType<typeof connectSuccess<QueryResult>>>, release: (cursor: string) => Promise<void>, options: { signal?: AbortSignal; maxResults?: number; firstPageSize?: number; pageSize?: number } = {}) {
  return view
    ? coordinatedSavedViewPages(async input => {
      const { context: _context, ...pageInput } = input;
      const outcome = await operation(pageInput);
      return connectSuccess({ ...outcome.value, meta: { ...outcome.value.meta, hasMore: outcome.value.meta?.hasMore ?? false, view: { path: "view.md", id: "all" } } } as SavedViewExecution);
    }, release, { path: "view.md", view: "all" }, options)
    : coordinatedQueryPages(operation, release, {}, options);
}

for (const view of [false, true]) describe(view ? "saved-view paging" : "query paging", () => {
  it("sets pageSize on the initial request and omits continuation limits", async () => {
    const calls: QueryInput[] = [];
    const release = vi.fn(async () => {});
    const sizes: number[] = [];
    const iterator = paging(view, async input => {
      calls.push(input);
      const offset = input.cursor ? 2 : 0;
      return connectSuccess({ results: [row(`${offset}.md`), row(`${offset + 1}.md`)], meta: { hasMore: !input.cursor, ...(!input.cursor ? { cursor: "next" } : {}) } });
    }, release, { pageSize: 2 });
    for await (const outcome of iterator) if (outcome.ok) sizes.push(outcome.value.results.length);
    expect(sizes).toEqual([2, 2]);
    expect(calls[0]).toMatchObject({ limit: 2, offset: 0 });
    expect(calls[1]).toHaveProperty("cursor", "next");
    expect(calls[1]).not.toHaveProperty("limit");
    expect(release).toHaveBeenCalledExactlyOnceWith("next");
  });

  it("releases a paused cursor promptly on abort, without next/return, exactly once", async () => {
    const controller = new AbortController();
    const release = vi.fn(async () => {});
    const operation = vi.fn(async () => connectSuccess({ results: [row("a.md")], meta: { hasMore: true, cursor: "paused" } }));
    const iterator = paging(view, operation, release, { signal: controller.signal });
    await iterator.next();
    controller.abort();
    expect(release).toHaveBeenCalledExactlyOnceWith("paused");
    await iterator.next();
    await iterator.return(undefined);
    expect(release).toHaveBeenCalledTimes(1);
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("releases the rotated cursor if abort races an in-flight continuation", async () => {
    const controller = new AbortController();
    const release = vi.fn(async () => {});
    let settle!: (result: ReturnType<typeof connectSuccess<QueryResult>>) => void;
    const operation = vi.fn(async (input: QueryInput) => input.cursor
      ? new Promise<ReturnType<typeof connectSuccess<QueryResult>>>(resolve => { settle = resolve; })
      : connectSuccess({ results: [row("a.md")], meta: { hasMore: true, cursor: "first" } }));
    const iterator = paging(view, operation, release, { signal: controller.signal });
    await iterator.next();
    const next = iterator.next();
    controller.abort();
    expect(release).not.toHaveBeenCalled();
    settle(connectSuccess({ results: [row("b.md")], meta: { hasMore: true, cursor: "rotated" } }));
    expect(await next).toMatchObject({ done: true });
    expect(release).toHaveBeenCalledExactlyOnceWith("rotated");
  });

  it("caps total delivered rows, trims a pinned page, and releases before yielding completion", async () => {
    let calls = 0;
    const release = vi.fn(async () => {});
    const iterator = paging(view, async () => {
      calls++;
      return connectSuccess({ results: [row(`${calls}a.md`), row(`${calls}b.md`)], meta: { hasMore: true, cursor: `${calls}` } });
    }, release, { firstPageSize: 2, pageSize: 10, maxResults: 3 });
    expect((await iterator.next()).value).toMatchObject({ ok: true, value: { loaded: 2, complete: false } });
    expect((await iterator.next()).value).toMatchObject({ ok: true, value: { results: [row("2a.md")], loaded: 3, complete: true, meta: { hasMore: true } } });
    expect(release).toHaveBeenCalledExactlyOnceWith("2");
    expect((await iterator.next()).done).toBe(true);
    expect(calls).toBe(2);
  });

  it("zero cap and pre-aborted callers make no data requests", async () => {
    const operation = vi.fn(async () => connectSuccess({ results: [] }));
    const release = vi.fn(async () => {});
    expect((await paging(view, operation, release, { maxResults: 0 }).next()).done).toBe(true);
    expect((await paging(view, operation, release, { signal: AbortSignal.abort() }).next()).done).toBe(true);
    expect(operation).not.toHaveBeenCalled();
  });

  it("rejects invalid total caps", async () => {
    for (const maxResults of [-1, 1.5, NaN, Infinity]) {
      await expect(paging(view, async () => connectSuccess({ results: [] }), async () => {}, { maxResults }).next()).rejects.toThrow("maxResults");
    }
  });

  it("aborting one paused iterator does not release another's cursor", async () => {
    let token = 0;
    const operation = async () => connectSuccess({ results: [row("a.md")], meta: { hasMore: true, cursor: String(++token) } });
    const release = vi.fn(async () => {});
    const controller = new AbortController();
    const abandoned = paging(view, operation, release, { signal: controller.signal });
    const live = paging(view, operation, release);
    await abandoned.next();
    await live.next();
    controller.abort();
    expect(release).toHaveBeenCalledExactlyOnceWith("1");
    await live.return(undefined);
    expect(release.mock.calls).toEqual([["1"], ["2"]]);
    await abandoned.return(undefined);
    expect(release).toHaveBeenCalledTimes(2);
  });

  it("does not wait for cleanup or propagate cleanup failures", async () => {
    const release = vi.fn(() => Promise.reject(new Error("cleanup unavailable")));
    const iterator = paging(view, async () => connectSuccess({ results: [row("a.md")], meta: { hasMore: true, cursor: "next" } }), release);
    await iterator.next();
    await iterator.return(undefined);
    await Promise.resolve();
    expect(release).toHaveBeenCalledExactlyOnceWith("next");
  });
});

describe("cursor/offset size contract", () => {
  it("keeps limit as a page-size fallback, not a total cap", async () => {
    let calls = 0, delivered = 0;
    for await (const outcome of coordinatedQueryPages(async input => {
      if (!input.cursor) expect(input.limit).toBe(1);
      calls++;
      return connectSuccess({ results: [row(`${calls}.md`)], meta: { hasMore: calls === 1, ...(calls === 1 ? { cursor: "next" } : {}) } });
    }, async () => {}, { limit: 1 })) {
      if (outcome.ok) delivered += outcome.value.results.length;
    }
    expect(delivered).toBe(2);
  });
  it("firstPageSize overrides pageSize; only legacy offset mode grows pages", async () => {
    const calls: QueryInput[] = [];
    const query = async (input: QueryInput) => {
      calls.push(input);
      return connectSuccess({ results: [row("a.md")], meta: { hasMore: calls.length < 2 } });
    };
    for await (const _ of coordinatedQueryPages(query, async () => {}, { snapshot: "legacy" }, { firstPageSize: 1, pageSize: 10 })) { /* drain */ }
    expect(calls).toEqual([{ limit: 1, offset: 0, snapshot: "legacy" }, { limit: 10, offset: 1, snapshot: "legacy" }]);
  });

  it("does not retry a continuation operation_invalid as a capability probe", async () => {
    const query = vi.fn(async () => connectFailure<"operation_invalid">(connectProblem("operation_invalid", "Bad cursor", { details: { diagnostics: [] } })));
    const release = vi.fn(async () => {});
    const iterator = coordinatedQueryPages(query, release, { cursor: "pinned" });
    expect((await iterator.next()).value).toMatchObject({ ok: false, problem: { code: "operation_invalid" } });
    await iterator.return(undefined);
    expect(query).toHaveBeenCalledExactlyOnceWith({ cursor: "pinned" }, expect.anything());
    expect(release).toHaveBeenCalledExactlyOnceWith("pinned");
  });
});
