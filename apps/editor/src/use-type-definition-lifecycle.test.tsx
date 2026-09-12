import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { CollectionDescription } from "@mdbase-dev/connect";
import type { CollectionGateway, TypeDocument } from "./model";
import { useTypeDefinitionLifecycle } from "./use-type-definition-lifecycle";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function type(name: string, revision = "same"): TypeDocument {
  return { name, path: `_types/${name}.md`, revision, document: `name: ${name}` };
}
function setup(gateway: Partial<CollectionGateway>) {
  const publishDescription = vi.fn();
  const selectName = vi.fn();
  const notify = vi.fn();
  const hook = renderHook(() => useTypeDefinitionLifecycle({
    gateway: gateway as CollectionGateway, publishDescription, selectName, notify
  }));
  return { ...hook, publishDescription, selectName, notify };
}

describe("useTypeDefinitionLifecycle", () => {
  it.each(["resolve", "reject"] as const)("ends save A when load B supersedes it, then ignores A %s", async (outcome) => {
    const saveA = deferred<TypeDocument>();
    const readB = deferred<TypeDocument>();
    const readType = vi.fn(async (name: string) => name === "A" ? type("A", "same") : readB.promise);
    const { result, notify } = setup({
      updateType: vi.fn(() => saveA.promise), readType, describe: vi.fn()
    });
    await act(async () => { await result.current.load("A"); });
    act(() => { void result.current.save(); });
    expect(result.current.saving).toBe(true);
    act(() => { void result.current.load("B"); });
    expect(result.current.saving).toBe(false);
    await act(async () => readB.resolve(type("B", "same")));
    await act(async () => outcome === "resolve" ? saveA.resolve(type("A")) : saveA.reject(new Error("stale A")));
    expect(result.current.document?.name).toBe("B");
    expect(result.current.error).toBeUndefined();
    expect(notify).not.toHaveBeenCalled();
  });

  it("keeps B saving when overlapping stale save A resolves first", async () => {
    const saveA = deferred<TypeDocument>();
    const saveB = deferred<TypeDocument>();
    const pending = [saveA, saveB];
    const gateway = { updateType: vi.fn(() => pending.shift()!.promise), describe: vi.fn(async () => ({ types: [] } as unknown as CollectionDescription)) };
    const { result, notify } = setup(gateway);
    act(() => result.current.beginCreate("name: A"));
    // Creation and update share the same lifecycle invariant; seed documents through loads.
    const reads = [type("A"), type("B", "same")];
    (gateway as Partial<CollectionGateway>).readType = vi.fn(async () => reads.shift()!);
    await act(async () => { await result.current.load("A"); });
    act(() => { void result.current.save(); });
    await act(async () => { await result.current.load("B"); });
    act(() => { void result.current.save(); });
    await act(async () => saveA.resolve(type("A")));
    expect(result.current.saving).toBe(true);
    expect(notify).not.toHaveBeenCalled();
    await act(async () => saveB.resolve(type("B", "same")));
    expect(result.current.saving).toBe(false);
  });

  it("silences stale describe completion and all completions after unmount", async () => {
    const describe = deferred<CollectionDescription>();
    const { result, unmount, publishDescription, notify } = setup({
      updateType: vi.fn(async () => type("A")), describe: vi.fn(() => describe.promise), readType: vi.fn(async () => type("A"))
    });
    await act(async () => { await result.current.load("A"); });
    act(() => { void result.current.save(); });
    act(() => result.current.beginCreate("name: B"));
    await act(async () => describe.resolve({ types: [] } as unknown as CollectionDescription));
    expect(publishDescription).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    unmount();
  });
});
