import { afterEach, describe, expect, it, vi } from "vitest";
import { MdbaseCollectionClient } from "./collection-client.js";
import { connectError } from "./errors.js";
import { connectSuccess } from "./outcomes.js";
import type { QueryMetadataInput, QueryMetadataPage } from "./operation-types.js";

const row = { path: "annotations/a.md", types: ["annotation"], revision: "opaque:1", values: { source: "[[book]]", resolved: "sources/book.md" } };
function fixture(result: unknown, supported = true) {
  const request = vi.fn(async () => ({ valid: true, result, diagnostics: [{ severity: "warning", code: "example", message: "Retained" }] }));
  const support = vi.fn(async () => connectSuccess(supported));
  const client = new MdbaseCollectionClient({ operation: request as any }, 1000, support);
  return { client, request, support };
}
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("negotiated metadata output", () => {
  it("serializes canonical select/projections and exposes only revision-required narrow fields", async () => {
    const { client, request, support } = fixture({ output: "metadata", results: [row], meta: { total_count: 1, has_more: false } });
    const outcome = await client.query({ output: "metadata", types: ["annotation"],
      select: ["source", { name: "resolved", expression: "projection.resolved" }],
      projections: { resolved: { expression: "source.asFile().file.path" } }, includeBody: false });
    expect(outcome).toEqual({ ok: true, value: { output: "metadata", results: [row], meta: { totalCount: 1, hasMore: false } },
      diagnostics: [{ severity: "warning", code: "example", message: "Retained" }] });
    expect(support).toHaveBeenCalledWith("query-metadata-v1", expect.any(Object));
    expect(request.mock.calls[0].slice(0, 2)).toEqual(["query", {
      output: "metadata", types: ["annotation"], select: ["source", { name: "resolved", expr: "projection.resolved" }],
      projections: { resolved: { expr: "source.asFile().file.path" } }, include_body: false
    }]);
  });
  it("absence of support fails explicit metadata before any extended request", async () => {
    const { client, request } = fixture({}, false);
    expect(await client.query({ output: "metadata" })).toMatchObject({ ok: false, problem: { code: "unsupported_operation" } });
    expect(request).not.toHaveBeenCalled();
    const independent = new MdbaseCollectionClient({ operation: request as any });
    expect(await independent.query({ output: "metadata" })).toMatchObject({ ok: false, problem: { code: "unsupported_operation" } });
    expect(request).not.toHaveBeenCalled();
  });
  it("unsupported metadata cursors cause zero extended requests, including cleanup", async () => {
    const { client, request, support } = fixture({}, false);
    const pages = [];
    for await (const page of client.queryPages({ output: "metadata", cursor: "retired-cursor" })) pages.push(page);
    await vi.waitFor(() => expect(support).toHaveBeenCalledTimes(2));
    expect(pages).toMatchObject([{ ok: false, problem: { code: "unsupported_operation" } }]);
    expect(request).not.toHaveBeenCalled();
  });
  it("does not release a metadata cursor after support is lost on continuation", async () => {
    let supported = true;
    const request = vi.fn(async () => ({ valid: true, diagnostics: [], result: {
      output: "metadata", results: [row], meta: { has_more: true, cursor: "next" }
    } }));
    const support = vi.fn(async () => connectSuccess(supported));
    const client = new MdbaseCollectionClient({ operation: request as any }, 1000, support);
    const pages = client.queryPages({ output: "metadata", pagination: "cursor" });
    expect((await pages.next()).value).toMatchObject({ ok: true });
    supported = false;
    expect((await pages.next()).value).toMatchObject({ ok: false, problem: { code: "unsupported_operation" } });
    await pages.return(undefined);
    await vi.waitFor(() => expect(support).toHaveBeenCalledTimes(3));
    expect(request).toHaveBeenCalledOnce();
  });
  it("ordinary queries retain old inputs and optional query revisions without discovery", async () => {
    const { client, request, support } = fixture({ results: [{ path: "a.md", types: [], file: {}, revision: "opaque:1", effective_frontmatter: { title: "A" } }] });
    expect(await client.query({ select: ["file.path"] })).toMatchObject({ ok: true, value: { results: [{ revision: "opaque:1", effectiveFrontmatter: { title: "A" } }] } });
    expect(request.mock.calls[0][1]).toEqual({ select: ["file.path"] });
    expect(support).not.toHaveBeenCalled();
  });
  it.each([null, "documents", "unknown"])("rejects invalid output %j before any request", async output => {
    const { client, request, support } = fixture({});
    expect(await client.query({ output } as unknown as QueryMetadataInput)).toMatchObject({ ok: false, problem: { code: "invalid_request" } });
    expect(request).not.toHaveBeenCalled(); expect(support).not.toHaveBeenCalled();
  });
  it("rejects includeBody:true at runtime before discovery or dispatch", async () => {
    const { client, request, support } = fixture({});
    expect(await client.query({ output: "metadata", includeBody: true } as unknown as QueryMetadataInput)).toMatchObject({ ok: false, problem: { code: "invalid_request" } });
    expect(request).not.toHaveBeenCalled(); expect(support).not.toHaveBeenCalled();
  });
  it.each(["revision", "values"])("rejects missing %s rather than manufacturing a partial record", async key => {
    const { [key]: omitted, ...invalid } = row;
    const { client } = fixture({ output: "metadata", results: [invalid] });
    expect(await client.query({ output: "metadata" })).toMatchObject({ ok: false, problem: { code: "invalid_operation_response" } });
  });
  it.each(["file", "body", "document", "frontmatter", "effective_frontmatter"])("rejects forbidden %s on metadata rows", async key => {
    const { client } = fixture({ output: "metadata", results: [{ ...row, [key]: key === "body" || key === "document" ? "" : {} }] });
    expect(await client.query({ output: "metadata" })).toMatchObject({ ok: false, problem: { code: "invalid_operation_response" } });
  });
  it.each([null, "contract", {}])("rejects malformed contract identity %j", async contract => {
    const { client } = fixture({ output: "metadata", results: [{ ...row, contract }] });
    expect(await client.query({ output: "metadata" })).toMatchObject({ ok: false, problem: { code: "invalid_operation_response" } });
  });
  it.each([{}, { results: [row] }, { output: "metadata", results: null }])("rejects malformed/mismatched mode %j", async result => {
    const { client } = fixture(result);
    expect(await client.query({ output: "metadata" })).toMatchObject({ ok: false, problem: { code: "invalid_operation_response" } });
  });
  it("retains metadata output across cursor pages, progress callbacks and queryAll", async () => {
    const calls: any[] = [];
    const pages: QueryMetadataPage[] = [];
    const request = vi.fn(async (_operation, input) => {
      calls.push(input);
      return { valid: true, result: { output: "metadata", results: input.release_cursor ? [] : [row],
        meta: { has_more: !input.cursor && !input.release_cursor, ...(!input.cursor && !input.release_cursor ? { cursor: "next" } : {}) } }, diagnostics: [] };
    });
    const client = new MdbaseCollectionClient({ operation: request as any }, 1000, async () => connectSuccess(true));
    for await (const page of client.queryPages({ output: "metadata", pagination: "cursor" }, {
      onProgress: page => { expect(page.results[0].revision).toBe("opaque:1"); }
    })) {
      expect(page.ok).toBe(true); if (page.ok) pages.push(page.value);
    }
    expect(calls).toHaveLength(2);
    expect(pages).toHaveLength(2);
    expect(pages.every(page => page.output === "metadata")).toBe(true);
    expect(calls).toEqual([
      { output: "metadata", limit: 200, offset: 0, pagination: "cursor" },
      { output: "metadata", cursor: "next" }
    ]);
    const all = await client.queryAll({ output: "metadata", pagination: "cursor" });
    expect(all).toMatchObject({ ok: true, value: { output: "metadata", results: [row, row] } });
  });
  it("never retries metadata operation_invalid as a capability or cursor probe", async () => {
    const request = vi.fn(async () => { throw connectError("operation_invalid", "Invalid metadata query"); });
    const client = new MdbaseCollectionClient({ operation: request as any }, 1000, async () => connectSuccess(true));
    const pages = [];
    for await (const page of client.queryPages({ output: "metadata" })) pages.push(page);
    expect(pages).toMatchObject([{ ok: false, problem: { code: "operation_invalid" } }]);
    expect(request).toHaveBeenCalledOnce();
  });
  it("uses one caller budget for feature discovery and metadata execution", async () => {
    vi.useFakeTimers();
    const request = vi.fn(async () => new Promise(() => {}));
    const client = new MdbaseCollectionClient({ operation: request as any }, 1000, async () => {
      await new Promise(resolve => setTimeout(resolve, 3)); return connectSuccess(true);
    });
    const pending = client.query({ output: "metadata" }, { timeoutMs: 5 });
    await vi.advanceTimersByTimeAsync(5);
    expect(await pending).toMatchObject({ ok: false, problem: { code: "timeout" } });
    expect(request).toHaveBeenCalledOnce();
  });
});
