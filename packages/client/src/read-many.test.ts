import { describe, expect, it, vi } from "vitest";
import { connectError } from "./errors.js";
import { connectFailure, connectSuccess, type ConnectOutcome } from "./outcomes.js";
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
const document = (path: string) => ({ path, revision: `opaque:${path}`, types: ["note"], frontmatter: { title: "persisted" }, effective_frontmatter: { title: "effective" }, body: "Body\r\n雪", file: { path } });
const documents = (paths: string[]) => ({ valid: true, diagnostics: [], result: { items: paths.map(path => ({ path, status: "found", record: document(path) })) } });
function nativeFixture(handler: (operation: string, input: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>, supports: (id: string, options?: ConnectRequestOptions) => Promise<ConnectOutcome<boolean>> = vi.fn(async () => connectSuccess(true))) {
  const request = vi.fn(async (operation: string, input: unknown, options?: ConnectRequestOptions) => await handler(operation, input as Record<string, unknown>, options?.signal));
  const client = new MdbaseCollectionClient<{ title: string }>({ operation: request as any }, 1000, supports);
  return { client, request, supports };
}

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

describe("revision-bearing readMany", () => {
  it("uses only advertised read paths, preserving duplicate identity and missing entries", async () => {
    const { client, request, supports } = nativeFixture(async (operation, input) => {
      expect(operation).toBe("read");
      return { valid: true, diagnostics: [], result: { items: (input.paths as string[]).map(path => path === "missing.md"
        ? { path, status: "missing" } : { path, status: "found", record: document(path) }) } };
    });
    const outcome = await client.readMany(["a.md", "missing.md", "a.md", "b.md"], { includeBody: true, concurrency: 1 });
    expect(supports).toHaveBeenCalledWith("read-many-documents-v1", expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0].slice(0, 2)).toEqual(["read", { paths: ["a.md", "missing.md", "b.md"], include_body: true, include_document: false }]);
    expect(outcome).toMatchObject({ ok: true, value: { results: [
      { status: "found", record: { revision: "opaque:a.md", body: "Body\r\n雪" } },
      { status: "missing", path: "missing.md" }, { status: "found", path: "a.md" }, { status: "found", path: "b.md" }
    ], errors: [] } });
    if (outcome.ok) expect(outcome.value.results[0]).toBe(outcome.value.results[2]);
  });

  it.each([undefined, "effective", "persisted", "both"] as const)("preserves frontmatter mode %s and query-default body omission", async frontmatterMode => {
    const { client, request } = nativeFixture(async (_operation, input) => documents(input.paths as string[]));
    const outcome = await client.readMany(["a.md"], { frontmatterMode });
    expect(request.mock.calls[0][1]).toEqual({ paths: ["a.md"], include_body: false, include_document: false });
    expect(outcome.ok).toBe(true);
    if (outcome.ok && outcome.value.results[0].status === "found") {
      const record = outcome.value.results[0].record;
      expect(record).not.toHaveProperty("body");
      expect(record).not.toHaveProperty("document");
      expect(record.revision).toBe("opaque:a.md");
      if (frontmatterMode === "persisted" || frontmatterMode === "both") expect(record.frontmatter).toEqual({ title: "persisted" });
      else expect(record).not.toHaveProperty("frontmatter");
      if (frontmatterMode !== "persisted") expect(record.effectiveFrontmatter).toEqual({ title: "effective" });
      else expect(record).not.toHaveProperty("effectiveFrontmatter");
    }
  });

  it("keeps type selection authority-owned, then installs new content and revision together", async () => {
    const { client, request } = nativeFixture(async (operation, input) => operation === "query"
      ? { ...envelope(["a.md"]), result: { results: [{ ...wireRow("a.md"), revision: "old-query-token" }], meta: { has_more: false } } }
      : { valid: true, diagnostics: [], result: { items: [{ path: "a.md", status: "found", record: { ...document("a.md"), revision: "new-read-token", body: "new content", types: ["changed"] } }] } });
    const outcome = await client.readMany(["a.md", "unselected.md"], { types: ["note"], includeBody: true, concurrency: 1 });
    expect(request.mock.calls.map(call => call[0])).toEqual(["query", "read"]);
    expect(request.mock.calls[0][1]).toMatchObject({ types: ["note"], where: 'file.path in ["a.md","unselected.md"]', select: ["file.path"], include_body: false });
    expect(request.mock.calls[1][1]).toEqual({ paths: ["a.md"], include_body: true, include_document: false });
    expect(outcome).toMatchObject({ ok: true, value: { results: [
      { status: "found", record: { revision: "new-read-token", body: "new content", types: ["changed"] } },
      { status: "missing", path: "unselected.md" }
    ] } });
  });

  it("sends no extended read if the route loses support during type selection", async () => {
    let supported = true;
    const { client, request } = nativeFixture(async (operation, input) => {
      expect(operation).toBe("query");
      supported = false;
      return envelope(selected(input));
    }, vi.fn(async () => connectSuccess(supported)));
    expect(await client.readMany(["a.md"], { types: ["note"], concurrency: 1 })).toMatchObject({ ok: true, value: { results: [{ status: "found" }] } });
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[0][1]).toHaveProperty("select");
    expect(request.mock.calls[1][1]).not.toHaveProperty("select");
    expect(request.mock.calls.every(call => call[0] === "query")).toBe(true);
  });
  it("does not send a document read when type selection matches nothing", async () => {
    const { client, request } = nativeFixture(async operation => { expect(operation).toBe("query"); return envelope([]); });
    expect(await client.readMany(["a.md"], { types: ["note"] })).toMatchObject({ ok: true, value: { results: [{ status: "missing" }] } });
    expect(request).toHaveBeenCalledOnce();
  });

  it("keeps successful and missing items beside semantic item failures", async () => {
    const { client } = nativeFixture(async () => ({ valid: true, diagnostics: [], result: { items: [
      { path: "a.md", status: "found", record: document("a.md") },
      { path: "missing.md", status: "missing" },
      { path: "bad.md", status: "error", error: { code: "invalid_frontmatter", message: "Cannot parse frontmatter" } },
      { path: "invalid.md", status: "error", error: { code: "validation_failed", message: "Invalid record" } }
    ] } }));
    const outcome = await client.readMany(["a.md", "missing.md", "bad.md", "invalid.md", "bad.md"], { concurrency: 1 });
    expect(outcome).toMatchObject({ ok: true, value: { results: [
      { status: "found" }, { status: "missing" }, { status: "error", batch: 0 }, { status: "error", batch: 0 }, { status: "error", batch: 0 }
    ], errors: [{ batch: 0, paths: ["bad.md", "invalid.md"], failure: { problem: { code: "operation_invalid", details: { diagnostics: [
      { code: "invalid_frontmatter", path: "bad.md" }, { code: "validation_failed", path: "invalid.md" }
    ] } } } }] } });
  });

  it("caps native batches at 100 and preserves input order under bounded parallelism", async () => {
    let active = 0, maximum = 0;
    const { client, request } = nativeFixture(async (_operation, input) => {
      active++; maximum = Math.max(maximum, active);
      await new Promise(resolve => setTimeout(resolve, 2)); active--;
      expect((input.paths as string[]).length).toBeLessThanOrEqual(100);
      return documents(input.paths as string[]);
    });
    const paths = Array.from({ length: 250 }, (_, i) => `${i}.md`);
    const result = await client.readMany(paths, { batchSize: 1000, concurrency: 2 });
    expect(maximum).toBe(2); expect(request).toHaveBeenCalledTimes(3);
    if (!result.ok) throw new Error(result.problem.message);
    expect(result.value.results.map(item => item.path)).toEqual(paths);
  });

  it.each([
    { items: [] },
    { items: [{ path: "other.md", status: "missing" }] },
    { items: [{ path: "a.md", status: "unknown" }] },
    { items: [{ path: "a.md", status: "error", error: null }] },
    { items: [{ path: "a.md", status: "found", record: { ...document("a.md"), revision: undefined } }] },
    { items: [{ path: "a.md", status: "found", record: { ...document("a.md"), path: "other.md" } }] },
    { items: [{ path: "a.md", status: "found", record: { ...document("a.md"), frontmatter: null } }] },
    { items: [{ path: "a.md", status: "found", record: { ...document("a.md"), body: undefined } }] }
  ])("rejects malformed/incoherent batches without fallback: %j", async result => {
    const { client, request } = nativeFixture(async () => ({ valid: true, diagnostics: [], result }));
    expect(await client.readMany(["a.md"], { includeBody: true })).toMatchObject({ ok: true, value: {
      results: [{ status: "error", batch: 0 }], errors: [{ failure: { problem: { code: "invalid_operation_response" } } }]
    } });
    expect(request).toHaveBeenCalledOnce(); expect(request.mock.calls[0][0]).toBe("read");
  });

  it("preserves capacity/authorization failures as batch failures, never missing or legacy probes", async () => {
    const { client, request } = nativeFixture(async (_operation, input) => {
      if ((input.paths as string[])[0] === "a.md") throw connectError("access_denied", "Read approval is required");
      return { valid: false, diagnostics: [{ severity: "error", code: "response_too_large", message: "Split the batch" }], result: null };
    });
    const result = await client.readMany(["a.md", "b.md"], { batchSize: 1 });
    expect(result).toMatchObject({ ok: true, value: { results: [{ status: "error" }, { status: "error" }], errors: [
      { batch: 0, failure: { problem: { code: "access_denied" } } },
      { batch: 1, failure: { problem: { code: "operation_invalid", details: { diagnostics: [{ code: "response_too_large" }] } } } }
    ] } });
    expect(request.mock.calls.map(call => call[0])).toEqual(["read", "read"]);
  });

  it("makes zero data/discovery requests for empty input", async () => {
    const { client, request, supports } = nativeFixture(async () => { throw new Error("Unexpected request"); });
    expect(await client.readMany([])).toEqual({ ok: true, value: { results: [], errors: [] }, diagnostics: [] });
    expect(request).not.toHaveBeenCalled(); expect(supports).not.toHaveBeenCalled();
  });

  it("preserves already-aborted empty input and rejects invalid representation options", async () => {
    const { client, request, supports } = nativeFixture(async () => { throw new Error("Unexpected request"); });
    expect(await client.readMany([], { signal: AbortSignal.abort() })).toMatchObject({ ok: false, problem: { code: "operation_cancelled" } });
    for (const options of [{ includeBody: "true" }, { frontmatterMode: "unknown" }]) {
      await expect(client.readMany(["a.md"], options as ReadManyOptions)).rejects.toThrow(TypeError);
    }
    expect(request).not.toHaveBeenCalled(); expect(supports).not.toHaveBeenCalled();
  });
  it("bounds discovery itself and sends no data request when it times out", async () => {
    const { client, request } = nativeFixture(async () => { throw new Error("Unexpected request"); }, vi.fn(async () => await new Promise(() => {})));
    expect(await client.readMany(["a.md"], { timeoutMs: 5 })).toMatchObject({ ok: false, problem: { code: "timeout" } });
    expect(request).not.toHaveBeenCalled();
  });
  it("keeps discovery failure visible instead of assuming legacy", async () => {
    const { client, request } = nativeFixture(async () => { throw new Error("Unexpected request"); }, vi.fn(async () => connectFailure(connectError("access_denied", "Discovery denied").problem)));
    expect(await client.readMany(["a.md"])).toMatchObject({ ok: false, problem: { code: "access_denied" } });
    expect(request).not.toHaveBeenCalled();
  });

  it("falls back only on explicit unsupported evidence, including after route replacement", async () => {
    let supported = true;
    const { client, request } = nativeFixture(async (operation, input) => {
      if (operation === "read") { supported = false; return documents(input.paths as string[]); }
      return envelope(selected(input));
    }, vi.fn(async () => connectSuccess(supported)));
    const result = await client.readMany(["a.md", "b.md"], { batchSize: 1, concurrency: 1 });
    expect(result).toMatchObject({ ok: true, value: { results: [{ status: "found", record: { revision: "opaque:a.md" } }, { status: "found", path: "b.md" }] } });
    expect(request.mock.calls.map(call => call[0])).toEqual(["read", "query"]);
    expect(request.mock.calls[1][1]).not.toHaveProperty("paths");
  });

  it("unsupported producers get only today's typed path queries, even if rows carry revisions", async () => {
    const { client, request } = nativeFixture(async (operation, input) => {
      expect(operation).toBe("query"); expect(input).not.toHaveProperty("paths");
      return { ...envelope(selected(input)), result: { results: selected(input).map(path => ({ ...wireRow(path), revision: "query-token" })), meta: { has_more: false } } };
    }, vi.fn(async () => connectSuccess(false)));
    expect(await client.readMany(["a.md", "a.md"])).toMatchObject({ ok: true, value: { results: [
      { status: "found", record: { revision: "query-token" } }, { status: "found" }
    ] } });
    expect(request).toHaveBeenCalledOnce();
  });

  it.each(["abort", "timeout"])("bounds discovery and native work under one total budget: %s", async reason => {
    const controller = new AbortController();
    const { client, request } = nativeFixture(async () => {
      if (reason === "abort") controller.abort();
      return await new Promise(() => {}); // Deliberately ignores the signal.
    });
    expect(await client.readMany(["a.md", "b.md"], { signal: controller.signal, timeoutMs: reason === "timeout" ? 5 : null, batchSize: 1, concurrency: 1 }))
      .toMatchObject({ ok: false, problem: { code: reason === "timeout" ? "timeout" : "operation_cancelled" } });
    expect(request).toHaveBeenCalledOnce();
  });
});
