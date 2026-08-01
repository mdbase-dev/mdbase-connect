import { describe, expect, it } from "vitest";
import { KeyedOperationQueue } from "./operation-queue";

describe("KeyedOperationQueue", () => {
  it("serializes operations for one key", async () => {
    const queue = new KeyedOperationQueue<object>();
    const key = {};
    const order: string[] = [];
    let release!: () => void;
    const first = queue.run(key, async () => {
      order.push("first:start");
      await new Promise<void>((resolve) => { release = resolve; });
      order.push("first:end");
    });
    const second = queue.run(key, async () => { order.push("second"); });

    await Promise.resolve();
    expect(order).toEqual(["first:start"]);
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(["first:start", "first:end", "second"]);
  });

  it("allows unrelated keys to progress independently", async () => {
    const queue = new KeyedOperationQueue<object>();
    const blocked = {};
    const free = {};
    let release!: () => void;
    const first = queue.run(blocked, () => new Promise<void>((resolve) => { release = resolve; }));

    await expect(queue.run(free, async () => "finished")).resolves.toBe("finished");
    expect(queue.isPending(blocked)).toBe(true);
    release();
    await first;
  });

  it("continues after a failed operation and reports idle accurately", async () => {
    const queue = new KeyedOperationQueue<string>();
    await expect(queue.run("note", async () => { throw new Error("failed"); })).rejects.toThrow("failed");
    await expect(queue.run("note", async () => "recovered")).resolves.toBe("recovered");
    await queue.waitForIdle();
    expect(queue.pendingCount).toBe(0);
  });
});
