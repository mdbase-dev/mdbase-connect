import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Dispatch, SetStateAction } from "react";
import { CollectionMutationScope } from "./collection-mutation-scope";
import type { CollectionGateway, CollectionSessionSnapshot, ConnectionSummary } from "./model";
import { useCollectionTransition } from "./use-collection-transition";

function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function ready(id: string): CollectionSessionSnapshot { const connection: ConnectionSummary = { collectionId: id, operations: ["all"] }; return { status: "ready", connection, connections: [connection] }; }
const staleSameOwner = ready("a");
const exactCases: [string, CollectionSessionSnapshot, boolean][] = [
  ["revoked capability", { status: "ready", connection: { collectionId: "a", operations: ["read"], missingCapabilities: ["collection.read"] }, connections: [] }, false],
  ["granted capability", { status: "ready", connection: { collectionId: "a", operations: ["read", "write"], missingCapabilities: [], fileActions: ["list", "replace"] }, connections: [{ collectionId: "other", operations: ["read"] }] }, true],
  ["changed operations, file actions, and inventory", { status: "ready", connection: { collectionId: "a", operations: ["new-operation"], fileActions: ["move"] }, connections: [{ collectionId: "new-saved", operations: [] }] }, true],
  ["changed start failure problem", { status: "start_failed", problem: { message: "current failure", recovery: "retry now" }, connections: [{ collectionId: "saved", operations: [] }] }, false],
  ["changed destroyed ownerless inventory", { status: "destroyed", connections: [{ collectionId: "survivor", operations: ["read"] }] }, false]
];

function setup() {
  let current = ready("a"), owner: string | undefined;
  const gateway = { sessionSnapshot: () => current, authorize: vi.fn(async () => undefined) } as unknown as CollectionGateway;
  const starts: string[] = [];
  const gates = new Map<string, ReturnType<typeof deferred<void>>>();
  const input = {
    gateway, scope: new CollectionMutationScope(), currentOwner: () => owner,
    drain: vi.fn(async () => undefined), clear: vi.fn(),
    start: vi.fn(async () => { const id = (current as Extract<CollectionSessionSnapshot, { status: "ready" }>).connection.collectionId; starts.push(id); await gates.get(id)?.promise; }),
    setFrozen: vi.fn(), setPhase: vi.fn(),
    setSnapshot: vi.fn(((value: SetStateAction<CollectionSessionSnapshot>) => {
      const snapshot = typeof value === "function" ? value(current) : value;
      owner = snapshot.status === "ready" ? snapshot.connection.collectionId : undefined;
    }) as Dispatch<SetStateAction<CollectionSessionSnapshot>>)
  };
  const hook = renderHook(() => useCollectionTransition(input));
  return { ...hook, input, starts, gates, setCurrent: (snapshot: CollectionSessionSnapshot) => { current = snapshot; } };
}

describe("useCollectionTransition serial ownership", () => {
  it("executes A, queued B, and C arriving during B without losing C", async () => {
    const state = setup();
    const a = deferred<void>(), b = deferred<void>(); state.gates.set("a", a); state.gates.set("b", b);
    let aCall!: Promise<void>, bCall!: Promise<void>, cCall!: Promise<void>;
    act(() => { aCall = state.result.current.acceptSnapshot(ready("a")); });
    await waitFor(() => expect(state.starts).toEqual(["a"]));
    state.setCurrent(ready("b")); act(() => { bCall = state.result.current.acceptSnapshot(ready("b")); });
    a.resolve(); await waitFor(() => expect(state.starts).toEqual(["a", "b"]));
    state.setCurrent(ready("c")); act(() => { cCall = state.result.current.acceptSnapshot(ready("c")); });
    b.resolve(); await act(async () => { await Promise.all([aCall, bCall, cCall]); });
    expect(state.starts).toEqual(["a", "b", "c"]);
  });

  it("gives each queued snapshot its own failure and continues with the next authority", async () => {
    const state = setup();
    const a = deferred<void>(), b = deferred<void>(); state.gates.set("a", a); state.gates.set("b", b);
    let aCall!: Promise<void>, bCall!: Promise<void>, cCall!: Promise<void>;
    act(() => { aCall = state.result.current.acceptSnapshot(ready("a")); });
    await waitFor(() => expect(state.starts).toEqual(["a"]));
    state.setCurrent(ready("b")); act(() => { bCall = state.result.current.acceptSnapshot(ready("b")); });
    a.resolve(); await expect(aCall).resolves.toBeUndefined();
    await waitFor(() => expect(state.starts).toEqual(["a", "b"]));
    state.setCurrent(ready("c")); act(() => { cCall = state.result.current.acceptSnapshot(ready("c")); });
    b.reject(new Error("B failed"));
    await expect(bCall).rejects.toThrow("B failed");
    await expect(cCall).resolves.toBeUndefined();
  });

  it.each(exactCases)("publishes the exact current explicit snapshot after deferred same-owner %s", async (_name, current, shouldStart) => {
    const state = setup(); const change = deferred<CollectionSessionSnapshot>();
    let call!: Promise<void>;
    act(() => { call = state.result.current.transition(() => change.promise); });
    state.setCurrent(current); change.resolve(staleSameOwner);
    await act(async () => { await call; });
    expect(state.input.setSnapshot).toHaveBeenLastCalledWith(current);
    expect(state.input.start).toHaveBeenCalledTimes(shouldStart ? 1 : 0);
  });

  it.each(exactCases)("publishes the exact current queued snapshot after deferred same-owner %s", async (_name, current, shouldStart) => {
    const state = setup(); const active = deferred<void>(); state.gates.set("a", active);
    let first!: Promise<void>, queued!: Promise<void>;
    act(() => { first = state.result.current.acceptSnapshot(ready("a")); });
    await waitFor(() => expect(state.starts).toEqual(["a"]));
    act(() => { queued = state.result.current.acceptSnapshot(staleSameOwner); });
    state.setCurrent(current); active.resolve();
    await act(async () => { await Promise.all([first, queued]); });
    expect(state.input.setSnapshot).toHaveBeenLastCalledWith(current);
    expect(state.input.start).toHaveBeenCalledTimes(shouldStart ? 2 : 1);
  });

  it("revalidates stale queued snapshots", async () => {
    const state = setup(); const a = deferred<void>(); state.gates.set("a", a);
    let active!: Promise<void>, stale!: Promise<void>;
    act(() => { active = state.result.current.acceptSnapshot(ready("a")); });
    await waitFor(() => expect(state.starts).toEqual(["a"]));
    act(() => { stale = state.result.current.acceptSnapshot(ready("a")); });
    state.setCurrent(ready("b")); a.resolve();
    await act(async () => { await Promise.all([active, stale]); });
    expect(state.starts).toEqual(["a", "b"]);
  });

  it("executes every distinct explicit A to B to C change in order", async () => {
    const state = setup(); const firstGate = deferred<void>(); const order: string[] = [];
    let first!: Promise<void>, second!: Promise<void>, third!: Promise<void>;
    act(() => {
      first = state.result.current.transition(async () => { order.push("a"); await firstGate.promise; });
      second = state.result.current.transition(() => { order.push("b"); state.setCurrent(ready("b")); });
      third = state.result.current.transition(() => { order.push("c"); state.setCurrent(ready("c")); });
    });
    await waitFor(() => expect(order).toEqual(["a"])); firstGate.resolve();
    await act(async () => { await Promise.all([first, second, third]); });
    expect(order).toEqual(["a", "b", "c"]); expect(state.starts).toEqual(["a", "b", "c"]);
  });

  it("isolates an explicit B failure and continues with queued C", async () => {
    const state = setup(); const firstGate = deferred<void>(); const failure = new Error("B failed"); const order: string[] = [];
    let first!: Promise<void>, second!: Promise<void>, third!: Promise<void>;
    act(() => {
      first = state.result.current.transition(async () => { order.push("a"); await firstGate.promise; });
      second = state.result.current.transition(() => { order.push("b"); throw failure; });
      third = state.result.current.transition(() => { order.push("c"); state.setCurrent(ready("c")); });
    });
    firstGate.resolve(); await expect(first).resolves.toBeUndefined();
    await expect(second).rejects.toBe(failure); await expect(third).resolves.toBeUndefined();
    expect(order).toEqual(["a", "b", "c"]);
  });

  it("single-flights overlapping authorization popups", async () => {
    const state = setup(); const popup = deferred<void>(); state.input.gateway.authorize = vi.fn(() => popup.promise);
    let first!: Promise<void>, second!: Promise<void>;
    act(() => { first = state.result.current.authorize("choose"); second = state.result.current.authorize("choose"); });
    expect(first).toBe(second); await waitFor(() => expect(state.input.gateway.authorize).toHaveBeenCalledOnce());
    popup.resolve(); await act(async () => { await first; });
  });
});
