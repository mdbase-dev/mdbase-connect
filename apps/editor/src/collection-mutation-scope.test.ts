import { describe, expect, it, vi } from "vitest";
import { CollectionMutationScope, FrozenCollectionError, StaleCollectionOperationError } from "./collection-mutation-scope";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}

describe("CollectionMutationScope", () => {
  it("freezes synchronously and drains every registered owner operation", async () => {
    const scope = new CollectionMutationScope();
    scope.changeOwner("a");
    const first = deferred<number>();
    const second = deferred<number>();
    const pending = [scope.register(scope.token(), first.promise), scope.register(scope.token(), second.promise)];
    scope.freeze();
    await expect(scope.run(async () => 3)).rejects.toBeInstanceOf(FrozenCollectionError);
    const drained = vi.fn();
    const drain = scope.drain().then(drained);
    first.resolve(1);
    await Promise.resolve();
    expect(drained).not.toHaveBeenCalled();
    second.resolve(2);
    await drain;
    await expect(Promise.all(pending)).resolves.toEqual([1, 2]);
  });

  it("rejects completion from an exact stale collection epoch", async () => {
    const scope = new CollectionMutationScope();
    scope.changeOwner("a");
    const result = deferred<number>();
    const operation = scope.register(scope.token(), result.promise);
    scope.changeOwner("b");
    result.resolve(1);
    await expect(operation).rejects.toBeInstanceOf(StaleCollectionOperationError);
  });
});
