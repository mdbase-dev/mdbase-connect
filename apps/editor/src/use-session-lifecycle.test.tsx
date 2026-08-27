import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { CollectionGateway, CollectionSessionSnapshot, ConnectionSummary } from "./model";
import { useSessionLifecycle } from "./use-session-lifecycle";

function ready(collectionId: string): CollectionSessionSnapshot {
  const connection: ConnectionSummary = { collectionId, operations: ["all"], missingCapabilities: [] };
  return { status: "ready", connection, connections: [connection] };
}

describe("useSessionLifecycle", () => {
  it("continues publishing session changes after the collection epoch changes", async () => {
    let snapshot = ready("collection-a");
    let publish: ((next: CollectionSessionSnapshot) => void) | undefined;
    const gateway = {
      startSession: vi.fn(async () => snapshot), sessionSnapshot: () => snapshot,
      onSessionChange: vi.fn((listener: (next: CollectionSessionSnapshot) => void) => { publish = listener; return () => undefined; })
    } as unknown as CollectionGateway;
    const collectionEpoch = { current: 0 };
    const setSessionSnapshot = vi.fn();
    renderHook(() => useSessionLifecycle({ gateway, collectionEpoch, start: vi.fn(async () => undefined),
      setSessionSnapshot, setNotice: vi.fn(), setPhase: vi.fn() }));
    await waitFor(() => expect(publish).toBeDefined());

    collectionEpoch.current = 1; snapshot = ready("collection-b");
    act(() => publish?.(snapshot));
    expect(setSessionSnapshot).toHaveBeenLastCalledWith(snapshot);
    const calls = setSessionSnapshot.mock.calls.length;
    act(() => publish?.(ready("collection-a")));
    expect(setSessionSnapshot).toHaveBeenCalledTimes(calls);
  });
});
