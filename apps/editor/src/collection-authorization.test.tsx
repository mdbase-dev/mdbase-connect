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

describe("useCollectionAuthorization", () => {
  it("clears the old workspace before starting a newly authorized collection", async () => {
    let snapshot: CollectionSessionSnapshot = { status: "ready", connection: connection("collection-a"), connections: [connection("collection-a")] };
    const events: string[] = [];
    const gateway = {
      sessionSnapshot: () => snapshot,
      authorize: vi.fn(async () => {
        snapshot = { status: "ready", connection: connection("collection-b"), connections: [connection("collection-b")] };
      })
    } as unknown as CollectionGateway;
    const setSessionSnapshot = vi.fn();
    const { result } = renderHook(() => useCollectionAuthorization({
      gateway,
      phase: "ready",
      beforeCollectionChange: () => events.push("clear"),
      start: async () => { events.push("start"); },
      setSessionSnapshot
    }));

    await act(async () => result.current.authorizeCollection("choose"));

    expect(events).toEqual(["clear", "start"]);
    expect(setSessionSnapshot).toHaveBeenCalledWith(snapshot);
  });
});
