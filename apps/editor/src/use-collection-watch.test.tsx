import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeCollectionChange, type CollectionChange, type WatchStatus } from "@mdbase-dev/connect";
import { useCollectionWatch } from "./use-collection-watch";

afterEach(() => { cleanup(); vi.useRealTimers(); });
function setup() {
  vi.useFakeTimers();
  let change!: (event: CollectionChange) => void, notify!: () => void;
  let status: WatchStatus | undefined;
  const input: Parameters<typeof useCollectionWatch>[0] = {
    phase: "ready",
    index: {
      subscribe: vi.fn(listener => { notify = listener; return vi.fn(); }),
      subscribeChanges: vi.fn(listener => { change = listener; return vi.fn(); }),
      getWatchStatus: () => status
    } as any,
    files: { reload: vi.fn(async () => []), remove: vi.fn() } as any,
    assets: { invalidate: vi.fn() } as any,
    refreshCachedNote: vi.fn(async () => {}), refreshDescription: vi.fn(async () => {}),
    setConnectionState: vi.fn(), setConnectionIssue: vi.fn(), setNotice: vi.fn()
  };
  const hook = renderHook(() => useCollectionWatch(input));
  return { input, ...hook,
    emit(type: string, payload = { path: "a.md" }) { change(normalizeCollectionChange({ type, payload, cursor: 1, occurred_at: "now" })); },
    status(value: WatchStatus) { status = value; notify(); }
  };
}
const flush = () => act(async () => { await vi.advanceTimersByTimeAsync(50); });

describe("observation app effects", () => {
  it("coalesces only open-session refreshes, not collection point reads", async () => {
    const f = setup();
    for (let i = 0; i < 200; i++) f.emit("mdbase.record.modified");
    await flush();
    expect(f.input.refreshCachedNote).toHaveBeenCalledExactlyOnceWith("a.md", undefined);
  });
  it("reconciles schema and files when the SDK watch resets", async () => {
    const f = setup();
    f.status({ state: "reset_required", cursor: 1, problem: {} as any });
    await flush();
    expect(f.input.files.reload).toHaveBeenCalledOnce();
    expect(f.input.refreshDescription).toHaveBeenCalledOnce();
  });
  it("forwards reconnect state and ignores queued work after unmount", async () => {
    const f = setup();
    f.status({ state: "connected", cursor: 1, recovered: true });
    expect(f.input.setConnectionState).toHaveBeenCalledWith("connected");
    f.emit("mdbase.config.changed"); f.unmount(); await flush();
    expect(f.input.refreshDescription).not.toHaveBeenCalled();
  });
});
