import { describe, expect, it, vi } from "vitest";
import type { CollectionOperation } from "@mdbase-dev/connect-protocol";
import type { ConnectRequestOptions, MdbaseCollectionTransport } from "./operation-types.js";
import { CollectionRequestCoordinator } from "./request-coordinator.js";

interface Deferred<Value> {
  promise: Promise<Value>;
  resolve(value: Value): void;
  reject(error: unknown): void;
}

function deferred<Value>(): Deferred<Value> {
  let resolve!: (value: Value) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<Value>((accepted, failed) => {
    resolve = accepted;
    reject = failed;
  });
  return { promise, resolve, reject };
}

describe("selected connection request coordination", () => {
  it("coalesces identical signal-free reads using canonical input keys", async () => {
    const result = deferred<number>();
    let calls = 0;
    const coordinator = new CollectionRequestCoordinator({
      operation: async <Result>() => {
        calls += 1;
        return await result.promise as Result;
      }
    }, 1_000);

    const first = coordinator.operation<number>("query", { where: "open", context: { b: 2, a: 1 } });
    const second = coordinator.operation<number>("query", { context: { a: 1, b: 2 }, where: "open" });
    expect(calls).toBe(1);
    result.resolve(42);
    await expect(Promise.all([first, second])).resolves.toEqual([42, 42]);
    expect(calls).toBe(1);
  });

  it("reserves an independent ordered mutation lane while reads are saturated", async () => {
    const reads: Deferred<string>[] = [];
    const calls: CollectionOperation[] = [];
    const transport: MdbaseCollectionTransport = {
      async operation<Result>(operation) {
        calls.push(operation);
        if (operation === "query") {
          const pending = deferred<string>();
          reads.push(pending);
          return await pending.promise as Result;
        }
        return "mutation" as Result;
      }
    };
    const coordinator = new CollectionRequestCoordinator(transport, 1_000, {
      foregroundCapacity: 2
    });
    const controllers = [new AbortController(), new AbortController()];
    const first = coordinator.operation<string>("query", { page: 1 }, { signal: controllers[0].signal });
    const second = coordinator.operation<string>("query", { page: 2 }, { signal: controllers[1].signal });
    await expect(coordinator.operation<string>("create", { path: "one.md" })).resolves.toBe("mutation");
    expect(calls).toEqual(["query", "query", "create"]);
    reads[0]?.resolve("first");
    reads[1]?.resolve("second");
    await expect(Promise.all([first, second])).resolves.toEqual(["first", "second"]);
  });

  it("uses the canonical mutation classifier for dry runs and sync actions", async () => {
    const held = deferred<string>();
    const calls: Array<{ operation: CollectionOperation; input: unknown }> = [];
    const coordinator = new CollectionRequestCoordinator({
      async operation<Result>(operation, input) {
        calls.push({ operation, input });
        if (operation === "query") return await held.promise as Result;
        return operation as Result;
      }
    }, 1_000, { foregroundCapacity: 1 });

    const query = coordinator.operation<string>("query", {});
    const dryRun = coordinator.operation<string>("delete", { path: "one.md", dry_run: true });
    await expect(coordinator.operation<string>("sync", { action: "mutate" })).resolves.toBe("sync");
    expect(calls.map(({ operation }) => operation)).toEqual(["query", "sync"]);
    held.resolve("query");
    await expect(query).resolves.toBe("query");
    await expect(dryRun).resolves.toBe("delete");
    expect(calls.map(({ operation }) => operation)).toEqual(["query", "sync", "delete"]);
  });

  it("serializes mutations without coalescing or changing their identity", async () => {
    const pending: Deferred<string>[] = [];
    const calls: CollectionOperation[] = [];
    const coordinator = new CollectionRequestCoordinator({
      async operation<Result>(operation) {
        calls.push(operation);
        const result = deferred<string>();
        pending.push(result);
        return await result.promise as Result;
      }
    }, 1_000);

    const mutations = [
      coordinator.operation<string>("create", { path: "one.md" }),
      coordinator.operation<string>("update", { path: "one.md" }),
      coordinator.operation<string>("delete", { path: "one.md" })
    ];
    expect(calls).toEqual(["create"]);
    pending[0]?.resolve("created");
    await vi.waitFor(() => expect(calls).toEqual(["create", "update"]));
    pending[1]?.resolve("updated");
    await vi.waitFor(() => expect(calls).toEqual(["create", "update", "delete"]));
    pending[2]?.resolve("deleted");
    await expect(Promise.all(mutations)).resolves.toEqual(["created", "updated", "deleted"]);
  });

  it("supports explicit latest-wins reads and never applies it to mutations", async () => {
    const transport: MdbaseCollectionTransport = {
      operation<Result>(operation, input, options?: ConnectRequestOptions) {
        if (operation !== "query") return Promise.resolve("mutation" as Result);
        const value = (input as { value: string }).value;
        if (value === "new") return Promise.resolve(value as Result);
        return new Promise<Result>((_resolve, reject) => {
          const abort = () => reject(options?.signal?.reason);
          if (options?.signal?.aborted) abort();
          else options?.signal?.addEventListener("abort", abort, { once: true });
        });
      }
    };
    const coordinator = new CollectionRequestCoordinator(transport, 1_000);
    const coordination = { family: "library-search", latestWins: true };
    const old = coordinator.operation<string>("query", { value: "old" }, { coordination });
    const latest = coordinator.operation<string>("query", { value: "new" }, { coordination });
    await expect(old).rejects.toMatchObject({ code: "operation_cancelled" });
    await expect(latest).resolves.toBe("new");
    expect(() => coordinator.operation("create", {}, { coordination })).toThrow(
      "latestWins coordination is available only for read operations"
    );
  });

  it("charges queue time to the original deadline and never sends expired work", async () => {
    vi.useFakeTimers();
    try {
      const held = deferred<string>();
      const calls: string[] = [];
      const coordinator = new CollectionRequestCoordinator({
        async operation<Result>(_operation, input) {
          const name = (input as { name: string }).name;
          calls.push(name);
          if (name === "held") return await held.promise as Result;
          return name as Result;
        }
      }, null, { foregroundCapacity: 1 });
      const first = coordinator.operation<string>("query", { name: "held" });
      const expired = coordinator.operation<string>("query", { name: "expired" }, { timeoutMs: 10 });
      await vi.advanceTimersByTimeAsync(11);
      await expect(expired).rejects.toMatchObject({ code: "timeout" });
      held.resolve("held");
      await expect(first).resolves.toBe("held");
      expect(calls).toEqual(["held"]);
    } finally {
      vi.useRealTimers();
    }
  });
});
