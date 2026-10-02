import { afterEach, describe, expect, it, vi } from "vitest";
import type { CollectionDescription, MdbaseOperationEnvelope } from "@mdbase-dev/connect-protocol";
import { MdbaseCollectionClient } from "./collection-client.js";
import { connectError } from "./errors.js";
import type { ConnectRequestOptions } from "./operation-types.js";

function description(name = "Notes"): CollectionDescription {
  return { protocol_version: 3, collection_id: "collection", display_name: name, spec_version: "0.3", operations: ["describe", "changes"], change_cursor: 1, types: [], contracts: [] };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}
function setup() {
  let load = () => Promise.resolve(description());
  let events: { cursor: number; type: string; occurred_at: string; payload: Record<string, unknown> }[] = [];
  let reset = false;
  const operation = vi.fn(async <Result>(name: string, _input: unknown, _options?: ConnectRequestOptions): Promise<Result> => {
    if (name === "describe") return await load() as Result;
    if (name === "changes") return { events, cursor: events.at(-1)?.cursor ?? 10, has_more: false, reset } as Result;
    return { valid: true, result: {}, diagnostics: [] } satisfies MdbaseOperationEnvelope<unknown> as Result;
  });
  const client = new MdbaseCollectionClient({ operation }, 1000);
  return {
    client, operation,
    get loads() { return operation.mock.calls.filter(([name]) => name === "describe").length; },
    load(next: typeof load) { load = next; },
    async emit(type: string, cursor = 2) {
      events = [{ type, cursor, occurred_at: "now", payload: { path: "schema.md" } }];
      return client.changes({ after: cursor - 1 });
    },
    async reset() { reset = true; return client.changes({ after: 1 }); }
  };
}
afterEach(() => vi.useRealTimers());

describe("description cache", () => {
  it("caches successes and shares concurrent loads (including fresh calls)", async () => {
    const state = setup();
    await Promise.all(Array.from({ length: 100 }, () => state.client.describe()));
    expect(state.loads).toBe(1);
    for (let i = 0; i < 100; i++) await state.client.describe();
    expect(state.loads).toBe(1);
    await Promise.all([state.client.describe({ fresh: true }), state.client.describe({ fresh: true })]);
    expect(state.loads).toBe(2);
    expect(state.client.schemaGeneration).toBe(0);
  });
  it("never caches failures or falls back to a stale value after a failed fresh load", async () => {
    const state = setup();
    await state.client.describe();
    state.load(() => Promise.reject(connectError("connector_offline", "Offline")));
    expect(await state.client.describe({ fresh: true })).toMatchObject({ ok: false, problem: { code: "connector_offline" } });
    expect(await state.client.describe()).toMatchObject({ ok: false });
    expect(state.loads).toBe(3);
    state.load(() => Promise.resolve(description("Recovered")));
    expect(await state.client.describe()).toMatchObject({ ok: true, value: { displayName: "Recovered" } });
    expect(state.loads).toBe(4);
  });
  for (const type of ["mdbase.type.changed", "mdbase.config.changed", "mdbase.contract.changed", "mdbase.view.changed", "mdbase.view_source.changed", "mdbase.collection.invalidated", "future.schema.event"]) {
    it(`invalidates description and increments generation on ${type}`, async () => {
      const state = setup();
      await state.client.describe();
      await state.emit(type);
      expect(state.client.schemaGeneration).toBe(1);
      await state.client.describe();
      expect(state.loads).toBe(2);
      await state.emit(type); // History replay of the same cursor is not a new generation.
      expect(state.client.schemaGeneration).toBe(1);
      await state.client.describe();
      expect(state.loads).toBe(2);
    });
  }
  it("does not invalidate for ordinary record or file changes", async () => {
    const state = setup();
    await state.client.describe();
    await state.emit("mdbase.record.modified");
    await state.emit("mdbase.resource.changed", 3);
    await state.client.describe();
    expect(state.client.schemaGeneration).toBe(0);
    expect(state.loads).toBe(1);
  });
  it("invalidates on reset while preserving the terminal watch failure", async () => {
    const state = setup();
    await state.client.describe();
    expect(await state.reset()).toMatchObject({ ok: true, value: { events: [{ kind: "reset" }], reset: true } });
    expect(state.client.schemaGeneration).toBe(1);
    await state.client.describe();
    expect(state.loads).toBe(2);
    const watch = state.client.watch({ cursor: 1 });
    expect((await watch.next()).value).toMatchObject({ ok: false, problem: { code: "change_cursor_reset" } });
  });
  it("fences a description fetched across a schema event, even when it resolves last", async () => {
    const state = setup();
    const old = deferred<CollectionDescription>();
    state.load(() => old.promise);
    const pending = state.client.describe();
    await state.emit("mdbase.type.changed");
    state.load(() => Promise.resolve(description("New schema")));
    await state.client.describe();
    old.resolve(description("Old schema"));
    await pending;
    expect(await state.client.describe()).toMatchObject({ ok: true, value: { displayName: "New schema" } });
    expect(state.loads).toBe(2);
  });
  it("bounds stale metadata to 60 seconds even without a live watch", async () => {
    vi.useFakeTimers();
    const state = setup();
    await state.client.describe();
    await vi.advanceTimersByTimeAsync(59_999);
    await state.client.describe();
    expect(state.loads).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await state.client.describe();
    expect(state.loads).toBe(2);
  });
  it("lets one concurrent caller cancel without cancelling the shared load", async () => {
    const state = setup();
    const gate = deferred<CollectionDescription>();
    state.load(() => gate.promise);
    const controller = new AbortController();
    const cancelled = state.client.describe({ signal: controller.signal });
    const other = state.client.describe();
    controller.abort();
    expect(await cancelled).toMatchObject({ ok: false, problem: { code: "operation_cancelled" } });
    expect(state.operation.mock.calls[0][2]?.signal?.aborted).toBe(false);
    gate.resolve(description());
    expect(await other).toMatchObject({ ok: true });
    expect(state.loads).toBe(1);
  });
  it("honors a caller timeout without poisoning other waiters, including cached calls", async () => {
    vi.useFakeTimers();
    const state = setup();
    const gate = deferred<CollectionDescription>();
    state.load(() => gate.promise);
    const timed = state.client.describe({ timeoutMs: 10 });
    const other = state.client.describe();
    await vi.advanceTimersByTimeAsync(10);
    expect(await timed).toMatchObject({ ok: false, problem: { code: "timeout" } });
    gate.resolve(description());
    expect(await other).toMatchObject({ ok: true });
    const cancelled = AbortSignal.abort();
    expect(await state.client.describe({ signal: cancelled })).toMatchObject({ ok: false, problem: { code: "operation_cancelled" } });
    expect(state.loads).toBe(1);
  });
  it("bounds and evicts a hung shared transport even if it ignores cancellation", async () => {
    vi.useFakeTimers();
    const state = setup();
    state.load(() => new Promise(() => undefined));
    const pending = state.client.describe({ timeoutMs: 2000 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(await pending).toMatchObject({ ok: false, problem: { code: "timeout" } });
    state.load(() => Promise.resolve(description()));
    expect(await state.client.describe()).toMatchObject({ ok: true });
    expect(state.loads).toBe(2);
  });
  it("invalidates after accepted schema mutations even without watching", async () => {
    const state = setup();
    await state.client.describe();
    await state.client.createType({ name: "task", source: "---\nname: task\n---\n" });
    expect(state.client.schemaGeneration).toBe(1);
    await state.client.describe();
    expect(state.loads).toBe(2);
  });
});
