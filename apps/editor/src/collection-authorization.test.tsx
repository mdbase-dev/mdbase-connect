import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useCollectionAuthorization } from "./collection-authorization";
import type { CollectionGateway, CollectionSessionSnapshot, ConnectionSummary } from "./model";

function connection(collectionId: string): ConnectionSummary {
  return {
    collectionId,
    operations: ["all"],
    missingCapabilities: [],
    authorityKind: "hosted",
    fileActions: ["list", "read", "add", "replace", "move", "delete"]
  };
}

function ready(collectionId: string): CollectionSessionSnapshot {
  const current = connection(collectionId);
  return { status: "ready", connection: current, connections: [current] };
}

describe("useCollectionAuthorization", () => {
  it("clears the old workspace synchronously before starting a newly authorized collection", async () => {
    let snapshot = ready("collection-a");
    const events: string[] = [];
    const gateway = {
      sessionSnapshot: () => snapshot,
      authorize: vi.fn(async () => { snapshot = ready("collection-b"); })
    } as unknown as CollectionGateway;
    const { result } = renderHook(() => useCollectionAuthorization({
      gateway,
      phase: "ready",
      beforeCollectionChange: () => events.push("clear"),
      start: async () => { events.push("start"); },
      setSessionSnapshot: vi.fn()
    }));

    await act(async () => result.current.authorizeCollection("choose"));
    expect(events).toEqual(["clear", "start"]);
  });

  it("does not clear or restart for a same-collection capability refresh", async () => {
    let snapshot = ready("collection-a");
    const beforeCollectionChange = vi.fn();
    const start = vi.fn();
    const gateway = {
      sessionSnapshot: () => snapshot,
      authorize: vi.fn(async () => { snapshot = ready("collection-a"); })
    } as unknown as CollectionGateway;
    const { result } = renderHook(() => useCollectionAuthorization({
      gateway, phase: "ready", beforeCollectionChange, start, setSessionSnapshot: vi.fn()
    }));

    await act(async () => result.current.authorizeCollection("selected"));
    expect(beforeCollectionChange).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });

  it("does not clear or start when authorization fails", async () => {
    const beforeCollectionChange = vi.fn();
    const start = vi.fn();
    const gateway = {
      sessionSnapshot: () => ready("collection-a"),
      authorize: vi.fn(async () => { throw new Error("cancelled"); })
    } as unknown as CollectionGateway;
    const { result } = renderHook(() => useCollectionAuthorization({
      gateway, phase: "ready", beforeCollectionChange, start, setSessionSnapshot: vi.fn()
    }));

    await expect(act(async () => result.current.authorizeCollection("choose"))).rejects.toThrow("cancelled");
    expect(beforeCollectionChange).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });
});
