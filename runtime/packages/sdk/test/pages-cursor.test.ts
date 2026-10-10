import { afterEach, describe, expect, it, vi } from "vitest";
import { connect, MdbaseClient, MdbaseError, Float64, type QueryResult, type PagesReset } from "../src/index.js";
import { MemoryReplica } from "../src/testing/index.js";

const clients: MdbaseClient[] = [];
afterEach(() => { clients.splice(0).forEach(client => client.close()); });
async function fixture() {
  const replica = new MemoryReplica();
  const client = await connect({ connector: replica.connector(), app: { name: "pages-test", version: "0" } });
  clients.push(client);
  return { client, query: vi.spyOn(client, "query") };
}
const page = (asOf: number, cursor?: string): QueryResult => ({
  records: [], complete: true, asOf, ...(cursor ? { cursor, hasMore: true } : { hasMore: false }),
});
const problem = (reason: string, code: "invalid_request" | "forbidden" | "unavailable" = "invalid_request") =>
  new MdbaseError({ code, recovery: code === "invalid_request" ? "fix_request" : code === "forbidden" ? "reauthorize" : "retry", reason, message: "cursor refusal" });

describe("pages cursor lifecycle (query responses mocked, not native cursor qualification)", () => {
  it.each(["cursor_expired", "cursor_stale"])("throws %s unchanged by default after yielding", async reason => {
    const { client, query } = await fixture(), error = problem(reason);
    query.mockResolvedValueOnce(page(1, "opaque-token")).mockRejectedValueOnce(error);
    const pages = client.pages({ offset: 100, limit: 50 });
    expect((await pages.next()).value).toEqual(page(1, "opaque-token"));
    await expect(pages.next()).rejects.toBe(error);
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[1]![0]).toEqual({ offset: 100, limit: 50, cursor: "opaque-token" });
  });

  it.each([1, 2])("awaits caller clearing before the first-page restart (replacement asOf %s)", async asOf => {
    const { client, query } = await fixture(), error = problem("cursor_expired");
    query.mockResolvedValueOnce(page(1, "old-token")).mockRejectedValueOnce(error)
      .mockResolvedValueOnce(page(asOf, "new-token")).mockResolvedValueOnce(page(asOf));
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const callbackEntered = new Promise<void>(resolve => { entered = resolve; });
    const accumulated: QueryResult[] = [];
    const original = { offset: 100, limit: 50, types: ["task"] };
    const include = { effective: true };
    const onReset = vi.fn(async (reset: PagesReset) => {
      expect(reset).toMatchObject({ reason: "cursor_expired", error, pagesYielded: 1 });
      entered(); await gate; accumulated.length = 0;
      // Caller changes cannot alter the captured invocation on restart.
      original.offset = 0; original.limit = 999; original.types[0] = "other"; include.effective = false;
    });
    const pages = client.pages(original, include, undefined, { onReset });
    accumulated.push((await pages.next()).value!);
    const next = pages.next(); await callbackEntered;
    expect(query).toHaveBeenCalledTimes(2); expect(accumulated).toHaveLength(1);
    release(); accumulated.push((await next).value!);
    expect(accumulated).toEqual([page(asOf, "new-token")]);
    expect(query.mock.calls[2]).toEqual([{ offset: 100, limit: 50, types: ["task"] }, { effective: true }, undefined]);
    expect((await pages.next()).value).toEqual(page(asOf));
    expect(await pages.next()).toEqual({ done: true, value: undefined });
    expect(query).toHaveBeenCalledTimes(4); expect(onReset).toHaveBeenCalledOnce();
  });

  it("preserves numeric kind/signed zero, exact bigint and ordered context Maps", async () => {
    const { client, query } = await fixture();
    const context = new Map<string, import("../src/index.js").PlainValue>([
      ["1", new Float64(-0)], ["0", new Float64(1)], ["large", 9007199254740993n],
    ]);
    query.mockRejectedValueOnce(problem("cursor_stale")).mockResolvedValueOnce(page(1));
    const pages = client.pages({ context, cursor: "old" }, undefined, undefined, {
      onReset: () => { context.clear(); },
    });
    await pages.next();
    const retained = query.mock.calls[1]![0].context as Map<string, unknown>;
    expect([...retained.keys()]).toEqual(["1", "0", "large"]);
    expect(retained.get("1")).toBeInstanceOf(Float64);
    expect(Object.is((retained.get("1") as Float64).value, -0)).toBe(true);
    expect(retained.get("0")).toBeInstanceOf(Float64);
    expect(retained.get("large")).toBe(9007199254740993n);
  });

  it("strips a caller-supplied initial cursor on reset", async () => {
    const { client, query } = await fixture();
    query.mockRejectedValueOnce(problem("cursor_stale")).mockResolvedValueOnce(page(2));
    const onReset = vi.fn();
    const pages = client.pages({ offset: 10, limit: 5, cursor: "supplied" }, undefined, undefined, { onReset });
    expect((await pages.next()).value).toEqual(page(2));
    expect(query.mock.calls.map(call => call[0])).toEqual([
      { offset: 10, limit: 5, cursor: "supplied" }, { offset: 10, limit: 5 },
    ]);
    expect(onReset).toHaveBeenCalledWith(expect.objectContaining({ pagesYielded: 0 }));
  });

  it("bounds the entire iterator to one restart", async () => {
    const { client, query } = await fixture(), final = problem("cursor_stale");
    query.mockResolvedValueOnce(page(1, "old")).mockRejectedValueOnce(problem("cursor_expired"))
      .mockResolvedValueOnce(page(2, "new")).mockRejectedValueOnce(final);
    const onReset = vi.fn(), pages = client.pages({}, undefined, undefined, { onReset });
    await pages.next(); await pages.next(); await expect(pages.next()).rejects.toBe(final);
    expect(onReset).toHaveBeenCalledOnce(); expect(query).toHaveBeenCalledTimes(4);
  });

  it.each([
    problem("invalid_query_cursor"), problem("query_cursor_stale"),
    new MdbaseError({ code: "invalid_request", recovery: "none", reason: "cursor_stale", message: "wrong recovery" }),
    problem("cursor_stale", "forbidden"), problem("cursor_expired", "unavailable"), new Error("backend fault"),
  ])("does not reset for malformed/conflicting cursors, authority denial or other errors", async error => {
    const { client, query } = await fixture(); query.mockRejectedValueOnce(error);
    const onReset = vi.fn();
    await expect(client.pages({}, undefined, undefined, { onReset }).next()).rejects.toBe(error);
    expect(onReset).not.toHaveBeenCalled(); expect(query).toHaveBeenCalledOnce();
  });

  it("propagates a reset callback failure without requerying", async () => {
    const { client, query } = await fixture(), failure = new Error("clear failed");
    query.mockRejectedValueOnce(problem("cursor_expired"));
    const onReset = vi.fn(async () => { throw failure; });
    await expect(client.pages({}, undefined, undefined, { onReset }).next()).rejects.toBe(failure);
    expect(query).toHaveBeenCalledOnce();
  });

  it("does not requery when aborted while the callback clears", async () => {
    const { client, query } = await fixture(), controller = new AbortController();
    query.mockRejectedValueOnce(problem("cursor_expired"));
    const onReset = vi.fn(async (reset: PagesReset) => { expect(reset.signal).toBe(controller.signal); controller.abort(); });
    await expect(client.pages({}, undefined, controller.signal, { onReset }).next()).rejects.toMatchObject({ name: "AbortError" });
    expect(query).toHaveBeenCalledOnce(); expect(onReset).toHaveBeenCalledOnce();
  });

  it("does no query when pre-aborted and preserves EOF without offset fallback", async () => {
    const { client, query } = await fixture();
    await expect(client.pages({}, undefined, AbortSignal.abort()).next()).rejects.toMatchObject({ name: "AbortError" });
    expect(query).not.toHaveBeenCalled();
    query.mockResolvedValueOnce(page(1));
    const pages = client.pages({ limit: 10 });
    expect((await pages.next()).value).toEqual(page(1));
    expect((await pages.next()).done).toBe(true); expect(query).toHaveBeenCalledOnce();
  });
});
