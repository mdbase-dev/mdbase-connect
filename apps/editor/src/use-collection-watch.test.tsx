import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CollectionChange } from "@mdbase-dev/connect";
import type { CollectionGateway } from "./model";
import { useCollectionWatch } from "./use-collection-watch";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function setup(notes: string[] = []) {
  let handler!: Parameters<CollectionGateway["watch"]>[0];
  let status!: NonNullable<Parameters<CollectionGateway["watch"]>[2]>;
  let signal!: AbortSignal;
  const watching = deferred();
  const reads: { path: string; gate: ReturnType<typeof deferred> }[] = [];
  let active = 0;
  let maxActive = 0;
  const watch = vi.fn<CollectionGateway["watch"]>((change, abort, onStatus) => {
    handler = change; signal = abort; status = onStatus!;
    return watching.promise;
  });
  const reload = vi.fn(async () => undefined);
  const input = {
    phase: "ready", connectionRetry: 0,
    gateway: { watch } as unknown as CollectionGateway,
    index: { getSnapshot: () => ({ notes: notes.map((path) => ({ path })) }) } as Parameters<typeof useCollectionWatch>[0]["index"],
    files: { reload, remove: vi.fn() } as unknown as Parameters<typeof useCollectionWatch>[0]["files"],
    assets: { invalidate: vi.fn() } as unknown as Parameters<typeof useCollectionWatch>[0]["assets"],
    loadIndex: vi.fn<() => Promise<void>>(async () => undefined),
    refreshChangedNote: vi.fn(async (path: string) => {
      const gate = deferred();
      reads.push({ path, gate });
      maxActive = Math.max(maxActive, ++active);
      try { await gate.promise; } finally { active--; }
    }),
    refreshDescription: vi.fn(async () => undefined),
    refreshAfterConnectionGap: vi.fn(async () => undefined),
    setConnectionState: vi.fn(), setConnectionIssue: vi.fn(), setNotice: vi.fn()
  };
  const hook = renderHook(() => useCollectionWatch(input));
  return {
    ...hook, input, reads, watching, reload,
    get signal() { return signal; }, get maxActive() { return maxActive; },
    emit: (path: string, type = "mdbase.record.modified") => handler({ type, payload: { path }, cursor: 1, occurredAt: "2026-01-01T00:00:00Z" } as CollectionChange),
    unknown: () => handler(), status: (value: Parameters<typeof status>[0]) => status(value)
  };
}
const tick = () => act(async () => { await vi.advanceTimersByTimeAsync(180); });
const finish = (state: ReturnType<typeof setup>, index: number, error?: string) => act(async () => {
  if (error) state.reads[index].gate.reject(new Error(error));
  else state.reads[index].gate.resolve();
});

beforeEach(() => vi.useFakeTimers());
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("useCollectionWatch bounded drain", () => {
  it("eventually refreshes 200 paths and a second burst through the same serial worker", async () => {
    const state = setup();
    for (let i = 0; i < 200; i++) state.emit(`${i}.md`);
    await tick();
    expect(state.reads.map((read) => read.path)).toEqual(["0.md"]);
    for (let i = 200; i < 240; i++) state.emit(`${i}.md`);
    await tick();
    expect(state.reads).toHaveLength(1);
    for (let i = 0; i < 240; i++) await finish(state, i);
    expect(state.reads.map((read) => read.path)).toEqual(Array.from({ length: 240 }, (_, i) => `${i}.md`));
    expect(state.maxActive).toBe(1);
  });

  it("coalesces pending duplicates but rereads a path changed during its read", async () => {
    const state = setup();
    state.emit("a.md"); state.emit("b.md");
    await tick();
    for (let i = 0; i < 10; i++) { state.emit("a.md"); state.emit("b.md"); }
    await tick();
    await finish(state, 0);
    await finish(state, 1);
    await finish(state, 2);
    expect(state.reads.map((read) => read.path)).toEqual(["a.md", "b.md", "a.md"]);
    expect(state.maxActive).toBe(1);
  });

  it("reports ordinary errors without fallback or stopping the remaining reads", async () => {
    const state = setup();
    state.emit("a.md"); state.emit("b.md");
    await tick();
    await finish(state, 0, "read failed");
    expect(state.input.setNotice).toHaveBeenCalledWith("read failed");
    expect(state.input.loadIndex).not.toHaveBeenCalled();
    expect(state.reads[1].path).toBe("b.md");
    await finish(state, 1);
  });

  it("shares the bound with deletion confirmations and awaits their index fallback", async () => {
    const state = setup(["a.md", "b.md"]);
    const fallback = deferred();
    state.input.loadIndex.mockImplementation(() => fallback.promise);
    state.emit("a.md", "mdbase.record.deleted"); state.emit("a.md");
    state.emit("b.md", "mdbase.record.deleted"); state.emit("c.md");
    await tick();
    await finish(state, 0, "missing");
    expect(state.input.loadIndex).toHaveBeenCalledTimes(1);
    state.emit("d.md"); await tick();
    expect(state.reads).toHaveLength(1);
    await act(async () => { fallback.reject(new Error("index failed")); });
    expect(state.input.setConnectionIssue).toHaveBeenCalledWith("index failed");
    for (let i = 1; i < 4; i++) await finish(state, i);
    expect(state.reads.map((read) => read.path)).toEqual(["a.md", "b.md", "c.md", "d.md"]);
    expect(state.input.loadIndex).toHaveBeenCalledTimes(1);
    expect(state.input.setNotice).not.toHaveBeenCalled();
    expect(state.maxActive).toBe(1);
  });

  it.each(["unmount", "switch", "reset"])("%s cancels queued and debounced work and ignores late read failures", async (stop) => {
    const state = setup(["a.md"]);
    state.emit("a.md", "mdbase.record.deleted"); state.emit("b.md");
    await tick();
    state.emit("c.md");
    const oldSignal = state.signal;
    if (stop === "unmount") state.unmount();
    else if (stop === "switch") { state.input.phase = "loading"; state.rerender(); }
    else state.status({ state: "reset_required" } as Parameters<typeof state.status>[0]);
    expect(oldSignal.aborted).toBe(true);
    state.emit("late.md");
    await finish(state, 0, "late failure");
    await tick();
    expect(state.reads).toHaveLength(1);
    expect(state.input.loadIndex).not.toHaveBeenCalled();
    expect(state.input.setNotice).not.toHaveBeenCalled();
    expect(state.input.setConnectionIssue).not.toHaveBeenCalled();
    if (stop === "reset") {
      state.status({ state: "reset_required" } as Parameters<typeof state.status>[0]);
      await act(async () => { state.watching.reject(new Error("watch ended")); });
      expect(state.input.refreshAfterConnectionGap).toHaveBeenCalledTimes(1);
      expect(state.input.setConnectionState).not.toHaveBeenCalled();
    }
  });

  it("suppresses late ordinary notices and deletion fallback errors on cleanup", async () => {
    const ordinary = setup(); ordinary.emit("a.md"); await tick(); ordinary.unmount();
    await finish(ordinary, 0, "late ordinary failure");
    expect(ordinary.input.setNotice).not.toHaveBeenCalled();
    const state = setup(["a.md"]);
    const fallback = deferred(); state.input.loadIndex.mockImplementation(() => fallback.promise);
    state.emit("a.md", "mdbase.record.deleted"); state.emit("b.md"); await tick();
    await finish(state, 0, "missing"); state.unmount();
    await act(async () => { fallback.reject(new Error("late index failure")); });
    expect(state.input.setConnectionIssue).not.toHaveBeenCalled();
    expect(state.reads).toHaveLength(1);
  });

  it("retains debounce, structural/index refresh, and types/files refresh semantics", async () => {
    const state = setup(["exists.md"]);
    state.emit("exists.md", "mdbase.record.deleted");
    state.emit("new.md", "mdbase.record.created");
    state.emit("type.md", "mdbase.type.changed");
    state.emit("file.png", "mdbase.file.put");
    await act(async () => { await vi.advanceTimersByTimeAsync(179); });
    expect(state.input.loadIndex).not.toHaveBeenCalled();
    state.emit("modified.md");
    await act(async () => { await vi.advanceTimersByTimeAsync(179); });
    expect(state.reads).toHaveLength(0);
    await tick();
    expect(state.input.loadIndex).toHaveBeenCalledTimes(1);
    expect(state.input.refreshDescription).toHaveBeenCalledTimes(1);
    expect(state.reload).toHaveBeenCalledTimes(1);
    expect(state.reads.map((read) => read.path)).toEqual(["modified.md"]);
    await finish(state, 0);
    state.unknown(); await tick();
    expect(state.input.loadIndex).toHaveBeenCalledTimes(2);
  });
});
