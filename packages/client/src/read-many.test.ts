import { describe, expect, it } from "vitest";
import { MdbaseCollectionClient } from "./collection-client.js";
import type { ConnectRequestOptions, ReadManyOptions } from "./operation-types.js";

function fixture(handler: (input: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>) {
  return new MdbaseCollectionClient<{ title: string }>({
    async operation<Result>(_operation: string, input: unknown, options?: ConnectRequestOptions) {
      return await handler(input as Record<string, unknown>, options?.signal) as Result;
    }
  });
}
const wireRow = (path: string) => ({ path, types: ["note"], frontmatter: { title: path }, effective_frontmatter: { title: path }, body: "Body", file: { path } });
const envelope = (paths: string[], meta = { has_more: false }) => ({ valid: true, diagnostics: [], result: { results: paths.map(wireRow), meta } });
const selected = (input: Record<string, unknown>) => JSON.parse((input.where as string).slice("file.path in ".length)) as string[];

describe("queryAll total caps", () => {
  it("keeps authority hasMore/counts independent of the client cap", async () => {
    const requests: Record<string, unknown>[] = [];
    const client = fixture(async input => {
      requests.push(input);
      if (input.release_cursor) return envelope([]);
      return envelope(["a.md", "b.md"], { has_more: true, cursor: input.cursor ? "second" : "first" } as { has_more: boolean });
    });
    const progress: number[] = [];
    const outcome = await client.queryAll({ limit: 2 }, { maxResults: 3, onProgress: page => progress.push(page.loaded) });
    expect(outcome).toMatchObject({ ok: true, value: { results: [{ path: "a.md" }, { path: "b.md" }, { path: "a.md" }], meta: { hasMore: true } } });
    if (outcome.ok) expect(outcome.value.meta).not.toHaveProperty("totalCount");
    expect(progress).toEqual([2, 3]);
    expect(requests).toHaveLength(3);
    expect(requests[2]).toEqual({ release_cursor: "second" });
    requests.length = 0;
    expect(await client.queryAll({}, { maxResults: 0 })).toEqual({ ok: true, value: { results: [] }, diagnostics: [] });
    expect(requests).toHaveLength(0);
  });
});

describe("readMany", () => {
  it("escapes literal paths, preserves input order/duplicates, and reports missing entries", async () => {
    const requests: Record<string, unknown>[] = [];
    const path = 'dir/quote"\\newline\n雪.md';
    const client = fixture(async input => {
      requests.push(input);
      return envelope(selected(input).filter(path => path !== "missing.md").reverse());
    });
    const outcome = await client.readMany([path, "b.md", path, "missing.md"], { includeBody: true, types: ["note"], frontmatterMode: "both" });
    expect(requests).toHaveLength(1);
    expect(selected(requests[0]!)).toEqual([path, "b.md", "missing.md"]);
    expect(requests[0]).toMatchObject({ types: ["note"], include_body: true, frontmatter_mode: "both", limit: 3 });
    expect(outcome).toMatchObject({ ok: true, value: { results: [
      { status: "found", path, record: { body: "Body", frontmatter: { title: path } } },
      { status: "found", path: "b.md" },
      { status: "found", path },
      { status: "missing", path: "missing.md" }
    ], errors: [] } });
    if (outcome.ok && outcome.value.results[0]?.status === "found") expect(outcome.value.results[0].record).not.toHaveProperty("revision");
  });

  it("bounds independent batches while keeping every cursor sequential", async () => {
    let active = 0, maximum = 0;
    const consumed = new Set<string>();
    const client = fixture(async input => {
      if (input.release_cursor) return envelope([]);
      active++;
      maximum = Math.max(maximum, active);
      await new Promise(resolve => setTimeout(resolve, 2));
      active--;
      if (input.cursor) {
        expect(input).not.toHaveProperty("limit");
        expect(consumed.has(input.cursor as string)).toBe(false);
        consumed.add(input.cursor as string);
        return envelope([input.cursor as string]);
      }
      const paths = selected(input);
      return envelope(paths.slice(0, 1), { has_more: true, cursor: paths[1] } as { has_more: boolean });
    });
    const paths = Array.from({ length: 20 }, (_, i) => `${i}.md`);
    const outcome = await client.readMany(paths, { batchSize: 2, concurrency: 3 });
    expect(maximum).toBe(3);
    expect(consumed.size).toBe(10);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.value.results.map(entry => entry.path)).toEqual(paths);
  });

  it("does not classify any record from a failed multi-page batch as missing or found", async () => {
    const client = fixture(async input => {
      if (input.release_cursor) return envelope([]);
      if (input.cursor) return { valid: false, diagnostics: [{ severity: "error", code: "invalid_query", message: "failed continuation" }], result: {} };
      const paths = selected(input);
      return paths.includes("a.md")
        ? envelope(["a.md"], { has_more: true, cursor: "failed" } as { has_more: boolean })
        : envelope(paths);
    });
    const outcome = await client.readMany(["a.md", "b.md", "c.md", "a.md"], { batchSize: 2 });
    expect(outcome).toMatchObject({ ok: true, value: { results: [
      { status: "error", path: "a.md", batch: 0 }, { status: "error", path: "b.md", batch: 0 },
      { status: "found", path: "c.md" }, { status: "error", path: "a.md", batch: 0 }
    ], errors: [{ batch: 0, paths: ["a.md", "b.md"], failure: { ok: false, problem: { code: "operation_invalid" } } }] } });
  });

  it("empty input makes no requests and invalid scheduling options fail explicitly", async () => {
    let calls = 0;
    const client = fixture(async () => { calls++; return envelope([]); });
    expect(await client.readMany([])).toMatchObject({ ok: true, value: { results: [], errors: [] } });
    for (const options of [{ batchSize: 0 }, { concurrency: 5 }, { concurrency: 1.5 }, { batchSize: 1001 }, { coordination: { latestWins: true, family: "reads" } }]) {
      await expect(client.readMany(["a.md"], options)).rejects.toThrow(TypeError);
    }
    expect(calls).toBe(0);
  });

  it.each(["abort", "timeout"])("uses a total budget, stops queued batches on %s", async reason => {
    const controller = new AbortController();
    let calls = 0;
    const client = fixture(async (_input, signal) => {
      calls++;
      if (reason === "abort") controller.abort();
      if (!signal?.aborted) await new Promise(resolve => signal?.addEventListener("abort", resolve, { once: true }));
      return envelope([]);
    });
    const options: ReadManyOptions = { batchSize: 1, concurrency: 1, signal: controller.signal, timeoutMs: reason === "timeout" ? 5 : null };
    expect(await client.readMany(["a.md", "b.md", "c.md"], options)).toMatchObject({ ok: false, problem: { code: reason === "timeout" ? "timeout" : "operation_cancelled" } });
    expect(calls).toBe(1);
  });
});
