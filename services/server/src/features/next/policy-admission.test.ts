import { describe, expect, it, vi } from "vitest";
import type { DatabasePool } from "../../database-types.js";
import { withPolicyLock } from "./policy-recovery.js";

const LIMIT = 6; // 30% of the unchanged 20-connection control-plane pool.
const collection = (n: number) => `00000000-0000-4000-8000-${String(n + 1).padStart(12, "0")}`;
function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
function pool(stats: { active: number; peak: number }, unlock: (id: string) => Promise<void> = async () => {}) {
  const connect = vi.fn(async () => {
    stats.active += 1;
    stats.peak = Math.max(stats.peak, stats.active);
    return {
      async query(sql: string, values: unknown[]) {
        if (sql.includes("pg_advisory_unlock")) {
          await unlock(String(values[0]));
          return { rows: [{ unlocked: true }] };
        }
        if (sql.includes("pg_advisory_lock")) return { rows: [] };
        throw new Error(`Unexpected admission-test query: ${sql}`);
      },
      release() { stats.active -= 1; }
    };
  });
  const db = { connect, query: vi.fn().mockRejectedValue(new Error("must not borrow a pool connection")), end: async () => {} } as unknown as DatabasePool;
  return { db, connect };
}

describe("per-process policy admission", () => {
  it("queues before checkout, shares six slots across pools/collections, and hands them off FIFO", async () => {
    const stats = { active: 0, peak: 0 }, first = pool(stats), second = pool(stats);
    const finish = Array.from({ length: 10 }, gate), started = Array.from({ length: 10 }, gate);
    const entered: number[] = [];
    const work = finish.map((g, i) => withPolicyLock(i % 2 ? first.db : second.db, collection(i), async () => {
      entered.push(i); started[i]!.release(); await g.promise; return i;
    }));
    try {
      await started[LIMIT - 1]!.promise;
      expect(first.connect.mock.calls.length + second.connect.mock.calls.length).toBe(LIMIT);
      expect(entered).toEqual([0, 1, 2, 3, 4, 5]);
      expect(stats).toEqual({ active: LIMIT, peak: LIMIT });
      for (let i = 0; i < 4; i++) {
        finish[i]!.release();
        expect(await work[i]).toBe(i);
        await started[LIMIT + i]!.promise;
        expect(entered).toEqual(Array.from({ length: LIMIT + i + 1 }, (_, n) => n));
        expect(stats.peak).toBe(LIMIT);
      }
    } finally { finish.forEach(g => g.release()); await Promise.allSettled(work); }
    expect(await Promise.all(work)).toEqual(Array.from({ length: 10 }, (_, i) => i));
    expect(stats).toEqual({ active: 0, peak: LIMIT });
  });

  it("retains admission until unlock and physical connection release finish", async () => {
    const stats = { active: 0, peak: 0 }, unlockEntered = gate(), unlockFinish = gate();
    const p = pool(stats, async id => {
      if (id === collection(0)) { unlockEntered.release(); await unlockFinish.promise; }
    });
    const finish = Array.from({ length: LIMIT + 1 }, gate), started = Array.from({ length: LIMIT + 1 }, gate);
    const work = finish.map((g, i) => withPolicyLock(p.db, collection(i), async () => {
      started[i]!.release(); await g.promise; return i;
    }));
    try {
      await started[LIMIT - 1]!.promise;
      finish[0]!.release();
      await unlockEntered.promise;
      expect(p.connect).toHaveBeenCalledTimes(LIMIT);
      expect(stats).toEqual({ active: LIMIT, peak: LIMIT });
      unlockFinish.release();
      await work[0];
      await started[LIMIT]!.promise;
      expect(stats.peak).toBe(LIMIT);
    } finally { finish.forEach(g => g.release()); unlockFinish.release(); await Promise.allSettled(work); }
    expect(await Promise.all(work)).toEqual(Array.from({ length: LIMIT + 1 }, (_, i) => i));
    expect(stats.active).toBe(0);
  });

  it.each(["checkout", "lock acquisition"])("returns admission after failed %s without rejecting the queued successor", async stage => {
    const stats = { active: 0, peak: 0 }, p = pool(stats), failure = new Error(`${stage} failed`);
    const broken = pool(stats);
    if (stage === "checkout") broken.connect.mockRejectedValueOnce(failure);
    else {
      const connect = broken.connect.getMockImplementation()!;
      broken.connect.mockImplementationOnce(async () => {
        const client = await connect();
        return { ...client, async query() { throw failure; } };
      });
    }
    const finish = Array.from({ length: LIMIT }, gate), started = Array.from({ length: LIMIT }, gate);
    const active = finish.map((g, i) => withPolicyLock(p.db, collection(i), async () => {
      started[i]!.release(); await g.promise; return i;
    }));
    const callback = vi.fn(async () => 0);
    const failed = withPolicyLock(broken.db, collection(10), callback).catch(error => error);
    const successorStarted = gate(), successorFinish = gate();
    const successor = withPolicyLock(p.db, collection(11), async () => {
      successorStarted.release(); await successorFinish.promise; return 42;
    });
    try {
      await started[LIMIT - 1]!.promise;
      expect(broken.connect).not.toHaveBeenCalled();
      finish[0]!.release();
      expect(await failed).toBe(failure);
      await successorStarted.promise;
      expect(callback).not.toHaveBeenCalled();
      expect(stats.peak).toBe(LIMIT);
    } finally {
      finish.forEach(g => g.release()); successorFinish.release();
      await Promise.allSettled([...active, failed, successor]);
    }
    expect(await successor).toBe(42);
    expect(stats.active).toBe(0);
  });

  it("returns admission after callback AND unlock failure, preserving the original error", async () => {
    const stats = { active: 0, peak: 0 }, original = new Error("callback failed"), cleanup = new Error("unlock failed");
    const p = pool(stats, async id => { if (id === collection(0)) throw cleanup; });
    const finish = Array.from({ length: LIMIT + 1 }, gate), started = Array.from({ length: LIMIT + 1 }, gate);
    const work = finish.map((g, i) => withPolicyLock(p.db, collection(i), async () => {
      started[i]!.release(); await g.promise;
      if (i === 0) throw original;
      return i;
    }).catch(error => error));
    try {
      await started[LIMIT - 1]!.promise;
      expect(p.connect).toHaveBeenCalledTimes(LIMIT);
      finish[0]!.release();
      expect(await work[0]).toBe(original);
      await started[LIMIT]!.promise;
      expect(stats.peak).toBe(LIMIT);
    } finally { finish.forEach(g => g.release()); await Promise.allSettled(work); }
    expect(await work[LIMIT]).toBe(LIMIT);
    expect(stats.active).toBe(0);
  });
});
