import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRecordTestAuthority } from "./index.js";
import { MdbaseConnectError, MdbaseRecords, type ConnectProblem, type MdbaseRecordLease } from "@mdbase-dev/connect";
import { MdbaseCollectionClient, connectProblem } from "@mdbase-dev/connect/advanced";
import { CollectionRequestCoordinator } from "../../client/dist/request-coordinator.js";

// Public records/watch API over the supported testing authority. Only the wire
// harness knows about the coordinator: the real 4-active + 32-queued boundary,
// not a fake unlimited read adapter, is essential to the reset regression.
async function fixture(count: number) {
  const authority = createRecordTestAuthority();
  const paths = Array.from({ length: count }, (_, i) => `Notes/${String(i)}.md`);
  for (const path of paths) authority.seed(path, { body: "Before" });
  let gate: Promise<void> | undefined;
  let failure: ConnectProblem | undefined;
  let active = 0;
  const reads: string[] = [];
  const failures: ConnectProblem[] = [];
  let maxActive = 0;
  const coordinator = new CollectionRequestCoordinator({
    async operation<Result>(operation: string, input: unknown): Promise<Result> {
      if (operation !== "read") throw new Error(`Unexpected operation: ${operation}`);
      const { path } = input as { path: string };
      reads.push(path);
      active += 1;
      maxActive = Math.max(maxActive, active);
      // Capture before waiting: a later invalidation must cause a follow-up.
      const record = authority.get(path);
      try {
        await gate;
        if (failure) throw new MdbaseConnectError(failure);
        if (!record) throw new MdbaseConnectError(connectProblem("file_not_found", "Missing"));
        const { effectiveFrontmatter, ...rest } = record;
        return { valid: true, result: { ...rest, effective_frontmatter: effectiveFrontmatter }, diagnostics: [] } as Result;
      } finally {
        active -= 1;
      }
    }
  }, null);
  const client = new MdbaseCollectionClient(coordinator, null);
  const records = new MdbaseRecords({
    read: async (...args) => {
      const result = await client.read(...args);
      if (!result.ok) failures.push(result.problem);
      return result;
    },
    update: (...args) => client.update(...args),
    pendingMutation: () => null
  });
  const leases: MdbaseRecordLease[] = [];
  for (const path of paths) {
    const opened = await records.open(path, { autosave: false });
    if (!opened.ok) throw new Error(opened.problem.message);
    leases.push(opened.value);
  }
  reads.length = 0;
  maxActive = 0;
  return {
    authority, records, client, paths, leases, reads, failures,
    get maxActive() { return maxActive; },
    holdReads() {
      let release!: () => void;
      gate = new Promise<void>((resolve) => { release = resolve; });
      return () => { gate = undefined; release(); };
    },
    failReads(problem?: ConnectProblem) { failure = problem; }
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

// Yield through the event loop, not session.run(): a per-session queue barrier
// cannot drain refreshes still waiting for admission in the records scheduler.
const settle = () => vi.runAllTimersAsync();

describe("follow refresh admission and coalescing", () => {
  it("reconciles all 1,000 sessions after reset without overflowing the coordinator", async () => {
    const f = await fixture(1000);
    const stop = f.records.follow(f.authority.watch);
    for (const path of f.paths) f.authority.seed(path, { body: "Missed" });
    const release = f.holdReads();
    f.authority.resetWatch();
    await settle();
    expect(f.reads).toHaveLength(4);
    release();
    await settle();
    expect(f.reads).toHaveLength(1000);
    expect(f.maxActive).toBe(4);
    expect(f.failures).toEqual([]);
    for (const { session } of f.leases) {
      expect(session.snapshot).toMatchObject({ state: "saved", body: "Missed", problem: null });
    }
    stop();
    f.leases.forEach(l => l.release());
  });

  it("collapses 1,000 events during one read into exactly one follow-up read of the latest record", async () => {
    const f = await fixture(1);
    const stop = f.records.follow(f.authority.watch);
    const release = f.holdReads();
    f.authority.editElsewhere(f.paths[0], { body: "First" });
    await settle();
    for (let i = 1; i < 1000; i++) f.authority.editElsewhere(f.paths[0], { body: `Event ${String(i)}` });
    expect(f.reads).toHaveLength(1);
    release();
    await settle();
    expect(f.reads).toHaveLength(2);
    expect(f.leases[0].session.snapshot).toMatchObject({ state: "saved", body: "Event 999" });
    stop();
  });

  it("keeps only one refresh for a session still waiting for admission", async () => {
    const f = await fixture(5);
    f.records.follow(f.authority.watch);
    const release = f.holdReads();
    f.authority.resetWatch();
    await settle();
    for (let i = 0; i < 1000; i++) f.authority.editElsewhere(f.paths[4], { body: `Event ${String(i)}` });
    release();
    await settle();
    expect(f.reads).toHaveLength(5);
    expect(f.leases[4].session.snapshot.body).toBe("Event 999");
  });

  it("follows a rename and deletion while their refreshes wait for admission", async () => {
    const f = await fixture(6);
    f.records.follow(f.authority.watch);
    const release = f.holdReads();
    f.authority.resetWatch();
    await settle();
    f.authority.renameElsewhere(f.paths[4], "Moved.md");
    f.leases[5].session.setBody("Keep local text");
    f.authority.deleteElsewhere(f.paths[5]);
    release();
    await settle();
    expect(f.reads).toHaveLength(6);
    expect(f.reads).toContain("Moved.md");
    expect(f.leases[4].session.snapshot.record.path).toBe("Moved.md");
    expect(f.leases[5].session.snapshot).toMatchObject({ state: "deleted", body: "Keep local text" });
    const reopened = await f.records.open("Moved.md");
    expect(reopened.ok && reopened.value.session).toBe(f.leases[4].session);
  });

  it("retries coordinator not-sent outcomes after foreground contention clears", async () => {
    const f = await fixture(4);
    f.records.follow(f.authority.watch);
    const release = f.holdReads();
    const foreground = Array.from({ length: 36 }, (_, i) => {
      const path = `Foreground/${String(i)}.md`;
      f.authority.seed(path);
      return f.client.read({ path });
    });
    for (const path of f.paths) f.authority.seed(path, { body: "Missed" });
    f.authority.resetWatch();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.failures).toHaveLength(4);
    expect(f.failures.every(p => p.code === "connector_busy" && p.operation_outcome === "not_sent")).toBe(true);
    release();
    expect((await Promise.all(foreground)).every(o => o.ok)).toBe(true);
    await settle();
    expect(f.reads).toHaveLength(40);
    expect(f.leases.every(l => l.session.snapshot.body === "Missed" && l.session.snapshot.state === "saved")).toBe(true);
  });

  it("backs off transient failures, exhausts four attempts visibly, and can refresh again", async () => {
    const f = await fixture(1);
    f.records.follow(f.authority.watch);
    f.failReads(connectProblem("connector_offline", "Offline"));
    f.authority.resetWatch();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.reads).toHaveLength(1);
    expect(f.leases[0].session.snapshot).toMatchObject({ state: "error", body: "Before", problem: { code: "connector_offline" } });
    await vi.advanceTimersByTimeAsync(99);
    expect(f.reads).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.reads).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(200);
    expect(f.reads).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(400);
    expect(f.reads).toHaveLength(4);
    await settle();
    expect(f.reads).toHaveLength(4);
    expect(f.leases[0].session.snapshot.state).toBe("error");
    f.failReads();
    f.authority.resetWatch(); // Same revision must clear the refresh failure.
    await settle();
    expect(f.leases[0].session.snapshot).toMatchObject({ state: "saved", problem: null });
  });

  it.each([
    connectProblem("access_denied", "Denied", { operationOutcome: "not_sent" }),
    connectProblem("operation_cancelled", "Cancelled", { operationOutcome: "not_sent" })
  ])("does not retry $code and leaves the failure visible", async problem => {
    const f = await fixture(1);
    f.records.follow(f.authority.watch);
    f.failReads(problem);
    f.authority.resetWatch();
    await settle();
    expect(f.reads).toHaveLength(1);
    expect(f.leases[0].session.snapshot).toMatchObject({ state: "error", problem });
  });

  it("coalesces changes arriving during backoff into the retry's latest read", async () => {
    const f = await fixture(1);
    f.records.follow(f.authority.watch);
    f.failReads(connectProblem("connector_offline", "Offline"));
    f.authority.resetWatch();
    await vi.advanceTimersByTimeAsync(0);
    f.failReads();
    for (let i = 0; i < 1000; i++) f.authority.editElsewhere(f.paths[0], { body: `Event ${String(i)}` });
    await settle();
    expect(f.reads).toHaveLength(2);
    expect(f.leases[0].session.snapshot).toMatchObject({ state: "saved", body: "Event 999", problem: null });
  });

  it("keeps following until all followers stop, with idempotent stops", async () => {
    const f = await fixture(1);
    const first = f.records.follow(f.authority.watch);
    const second = f.records.follow(f.authority.watch);
    first();
    first();
    f.authority.editElsewhere(f.paths[0], { body: "Still following" });
    await settle();
    expect(f.leases[0].session.snapshot.body).toBe("Still following");
    second();
    f.authority.editElsewhere(f.paths[0], { body: "Ignored" });
    await settle();
    expect(f.reads).toHaveLength(1);
  });

  it("stops queued and retry work when the last follower stops, but lets admitted reads settle", async () => {
    const f = await fixture(5);
    const stop = f.records.follow(f.authority.watch);
    const release = f.holdReads();
    f.authority.resetWatch();
    await settle();
    stop();
    stop();
    release();
    await settle();
    expect(f.reads).toHaveLength(4);
    const again = f.records.follow(f.authority.watch);
    f.failReads(connectProblem("connector_offline", "Offline"));
    f.authority.resetWatch();
    await vi.advanceTimersByTimeAsync(0);
    again();
    const attempts = f.reads.length;
    await settle();
    expect(f.reads).toHaveLength(attempts);
  });

  it("drops released clean sessions from the queue, including sessions with failed refreshes", async () => {
    const f = await fixture(5);
    f.records.follow(f.authority.watch);
    const release = f.holdReads();
    f.authority.resetWatch();
    await settle();
    f.leases[4].release();
    release();
    await settle();
    expect(f.reads).toHaveLength(4);
    f.failReads(connectProblem("access_denied", "Denied"));
    f.authority.resetWatch();
    await settle();
    f.leases[0].release();
    f.failReads();
    const reopened = await f.records.open(f.paths[0], { autosave: false });
    expect(reopened.ok && reopened.value.session).not.toBe(f.leases[0].session);
  });
});
