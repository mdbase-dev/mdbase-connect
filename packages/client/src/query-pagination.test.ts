import { describe, expect, it } from "vitest";
import { coordinatedQueryPages } from "./query-pagination.js";
import { connectSuccess, connectFailure } from "./outcomes.js";
import { connectProblem } from "./errors.js";
import type { QueryInput } from "./operation-types.js";

 describe("adaptive cursor transport", () => {
  it("uses a small first page then larger pages of the same cursor", async () => {
    const calls: QueryInput[] = [];
    const releases: string[] = [];
    const sizes: number[] = [];
    const query = async (input: QueryInput) => {
      calls.push(input);
      const offset = input.cursor ? Number(input.cursor) : 0;
      const size = Math.min(input.limit ?? 100, 10_000 - offset);
      return connectSuccess({ results: Array.from({ length: size }, (_, i) => ({ path: `${offset + i}.md` })),
        meta: { hasMore: offset + size < 10_000, ...(offset + size < 10_000 ? { cursor: String(offset + size) } : {}) } });
    };
    for await (const outcome of coordinatedQueryPages(query, async cursor => { releases.push(cursor); }, {},
      { firstPageSize: 100, pageSize: 1_000 })) {
      expect(outcome.ok).toBe(true);
      if (outcome.ok) sizes.push(outcome.value.results.length);
    }
    expect(sizes).toEqual([100, ...Array<number>(9).fill(1_000), 900]);
    expect(calls).toHaveLength(11);
    expect(calls[1]).toEqual({ cursor: "100", limit: 1_000 });
    expect(releases).toEqual(["9100"]);
  });

  it("retries only an unsupported limit, retaining cursor identity", async () => {
    const calls: QueryInput[] = [];
    const query = async (input: QueryInput) => {
      calls.push(input);
      if (input.cursor && input.limit) return connectFailure(connectProblem("operation_invalid", "Old schema"));
      return connectSuccess({ results: [{ path: "a.md" }], meta: { hasMore: !input.cursor, ...(!input.cursor ? { cursor: "pinned" } : {}) } });
    };
    const results = [];
    for await (const outcome of coordinatedQueryPages(query, async () => {}, {}, { firstPageSize: 1, pageSize: 1000 })) results.push(outcome);
    expect(results).toHaveLength(2);
    expect(calls).toEqual([{ limit: 1, offset: 0, pagination: "cursor" }, { cursor: "pinned", limit: 1000 }, { cursor: "pinned" }]);
  });

  it("never retries an authorization failure as a paging capability probe", async () => {
    let calls = 0;
    const query = async () => {
      calls++;
      return connectFailure(connectProblem("access_denied", "Denied"));
    };
    const iterator = coordinatedQueryPages(query, async () => {}, { cursor: "pinned" });
    expect((await iterator.next()).value).toMatchObject({ ok: false, problem: { code: "access_denied" } });
    await iterator.return(undefined);
    expect(calls).toBe(1);
  });
});
