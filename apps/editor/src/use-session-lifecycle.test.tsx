import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { CollectionGateway, CollectionSessionSnapshot, ConnectionSummary } from "./model";
import { useSessionLifecycle } from "./use-session-lifecycle";

function ready(collectionId: string): CollectionSessionSnapshot {
  const connection: ConnectionSummary = { collectionId, operations: ["all"], missingCapabilities: [] };
  return { status: "ready", connection, connections: [connection] };
}

describe("useSessionLifecycle", () => {
  it("routes initial, retry, and authoritative events through the transition callback", async () => {
    let snapshot = ready("collection-a");
    let publish: ((next: CollectionSessionSnapshot) => void) | undefined;
    const gateway = {
      startSession: vi.fn(async () => snapshot), sessionSnapshot: () => snapshot,
      onSessionChange: vi.fn((listener: (next: CollectionSessionSnapshot) => void) => { publish = listener; return () => undefined; })
    } as unknown as CollectionGateway;
    const acceptSnapshot = vi.fn(async () => undefined);
    const { result } = renderHook(() => useSessionLifecycle({ gateway, acceptSnapshot, setNotice: vi.fn() }));
    await waitFor(() => expect(acceptSnapshot).toHaveBeenCalledWith(snapshot));

    snapshot = ready("collection-b");
    act(() => publish?.(snapshot));
    await waitFor(() => expect(acceptSnapshot).toHaveBeenLastCalledWith(snapshot));
    await act(() => result.current.retrySessionStart());
    expect(acceptSnapshot).toHaveBeenLastCalledWith(snapshot);
  });

  it("rejects stale ready and non-ready events but accepts a genuine current disconnect", async () => {
    let snapshot = ready("collection-b");
    let publish: ((next: CollectionSessionSnapshot) => void) | undefined;
    const gateway = {
      startSession: vi.fn(async () => snapshot), sessionSnapshot: () => snapshot,
      onSessionChange: vi.fn((listener: (next: CollectionSessionSnapshot) => void) => { publish = listener; return () => undefined; })
    } as unknown as CollectionGateway;
    const acceptSnapshot = vi.fn(async () => undefined);
    renderHook(() => useSessionLifecycle({ gateway, acceptSnapshot, setNotice: vi.fn() }));
    await waitFor(() => expect(publish).toBeDefined());
    acceptSnapshot.mockClear();

    act(() => publish?.(ready("collection-a")));
    act(() => publish?.({ status: "unavailable", collectionId: "collection-a", reason: "not_authorized", connections: [] }));
    act(() => publish?.({ status: "destroyed", connections: [] }));
    expect(acceptSnapshot).not.toHaveBeenCalled();

    snapshot = { status: "unavailable", collectionId: "collection-b", reason: "not_authorized", connections: [] };
    act(() => publish?.(snapshot));
    await waitFor(() => expect(acceptSnapshot).toHaveBeenCalledWith(snapshot));
  });
});
