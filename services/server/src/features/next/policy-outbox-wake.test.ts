import { describe, expect, it, vi } from "vitest";
import type { DatabasePool } from "../../database-types.js";
import type { LogServiceClient } from "./log-service-client.js";
import { PolicyEmitter } from "./policy-outbox.js";
import type { PolicySigner } from "./policy-wire.js";

type Steps = { step(collection: string): Promise<"appended" | "idle" | "blocked" | "rebuild"> };
const collection = "00000000-0000-4000-8000-000000000001";
function emitter(callback: (collection?: string) => Promise<void>) {
  const query = vi.fn().mockRejectedValue(new Error("foreground must not start global verification"));
  return new PolicyEmitter({ query } as unknown as DatabasePool, {} as LogServiceClient,
    {} as PolicySigner, undefined, 2_000, () => 0, callback);
}

describe("foreground committed policy wake", () => {
  it("returns committed drain while slow activation remains occupied, and close drains it", async () => {
    let finish!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    const e = emitter(() => pending);
    vi.spyOn(e as unknown as Steps, "step").mockResolvedValueOnce("appended").mockResolvedValueOnce("idle");
    let drained = false;
    const drain = e.drainCollection(collection).then(value => { drained = true; return value; });
    try {
      for (let i = 0; i < 12; i++) await Promise.resolve();
      expect(drained).toBe(true);
      let closed = false;
      const closing = e.close().then(() => { closed = true; });
      for (let i = 0; i < 12; i++) await Promise.resolve();
      expect(closed).toBe(false);
      finish();
      await closing;
      expect(await drain).toBe(1);
    } finally { finish(); await drain; await e.close(); }
  });
  it("does not report close while the original wake is still physically occupied", async () => {
    let finish!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    const e = emitter(() => pending);
    vi.spyOn(e as unknown as Steps, "step").mockResolvedValueOnce("appended").mockResolvedValueOnce("idle");
    const drain = e.drainCollection(collection);
    for (let i = 0; i < 12; i++) await Promise.resolve();
    let closed = false;
    const closing = e.close().then(() => { closed = true; });
    try {
      for (let i = 0; i < 12; i++) await Promise.resolve();
      expect(closed).toBe(false);
    } finally { finish(); await drain; await closing; }
  });
  it("bounds and coalesces background wake hints without blocking committed appends", async () => {
    let finish!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    const wake = vi.fn(() => pending), e = emitter(wake);
    const calls = new Map<string, number>();
    vi.spyOn(e as unknown as Steps, "step").mockImplementation(async id => {
      const n = calls.get(id) ?? 0; calls.set(id, n + 1);
      return n % 2 === 0 ? "appended" : "idle";
    });
    try {
      expect(await e.drainCollection(collection)).toBe(1);
      expect(await e.drainCollection(collection)).toBe(1);
      for (let i = 2; i <= 7; i++) expect(await e.drainCollection(`00000000-0000-4000-8000-${String(i).padStart(12, "0")}`)).toBe(1);
      expect(wake).toHaveBeenCalledTimes(4);
      expect(wake.mock.calls.filter(([id]) => id === collection)).toHaveLength(1);
    } finally { finish(); await e.close(); }
    await expect(e.drainCollection(collection)).rejects.toThrow("policy emitter closed");
    await expect(e.drain()).rejects.toThrow("policy emitter closed");
    expect(() => e.start()).toThrow("policy emitter closed");
  });
  it("drains admitted wakes even when the original global drain fails", async () => {
    let finish!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    const e = emitter(() => pending);
    vi.spyOn(e as unknown as Steps, "step").mockResolvedValueOnce("appended").mockResolvedValueOnce("idle");
    await e.drainCollection(collection);
    const failure = new Error("original global drain failure");
    vi.spyOn(e as unknown as { drainAll(): Promise<number> }, "drainAll").mockRejectedValueOnce(failure);
    const global = e.drain();
    const observed = global.catch(error => error);
    let closed = false;
    const closing = e.close().catch(error => { closed = true; return error; });
    try {
      for (let i = 0; i < 12; i++) await Promise.resolve();
      expect(closed).toBe(false);
      finish();
      expect(await closing).toBe(failure);
      expect(await observed).toBe(failure);
    } finally { finish(); await observed; await closing; }
  });
  it("wakes this collection after its committed step without waiting for global scanning", async () => {
    let locked = false;
    const wake = vi.fn(async () => { expect(locked).toBe(false); });
    const e = emitter(wake);
    vi.spyOn(e as unknown as Steps, "step")
      .mockImplementationOnce(async () => { locked = true; await Promise.resolve(); locked = false; return "appended"; })
      .mockResolvedValueOnce("idle");
    expect(await e.drainCollection(collection)).toBe(1);
    expect(wake).toHaveBeenCalledExactlyOnceWith(collection);
  });
  it.each(["idle", "blocked", "rebuild"] as const)("does not wake on uncommitted %s", async (outcome) => {
    const wake = vi.fn(async () => {});
    const e = emitter(wake);
    vi.spyOn(e as unknown as Steps, "step").mockResolvedValueOnce(outcome).mockResolvedValueOnce("idle");
    expect(await e.drainCollection(collection)).toBe(0);
    expect(wake).not.toHaveBeenCalled();
  });
  it("does not fail a committed append when its wake transport/database fails", async () => {
    const wake = vi.fn(async () => { throw new Error("wake unavailable"); });
    const e = emitter(wake);
    vi.spyOn(e as unknown as Steps, "step").mockResolvedValueOnce("appended").mockResolvedValueOnce("idle");
    expect(await e.drainCollection(collection)).toBe(1);
    expect(wake).toHaveBeenCalledExactlyOnceWith(collection);
  });
  it("keeps the committed wake even when a later append transport fails", async () => {
    const wake = vi.fn(async () => {});
    const e = emitter(wake);
    vi.spyOn(e as unknown as Steps, "step").mockResolvedValueOnce("appended").mockRejectedValueOnce(new Error("offline"));
    await expect(e.drainCollection(collection)).rejects.toThrow("offline");
    expect(wake).toHaveBeenCalledExactlyOnceWith(collection);
  });
  it("re-arms one coalesced wake when commits land while an earlier wake is in flight", async () => {
    const wakes: Array<() => void> = [];
    const wake = vi.fn(() => new Promise<void>(resolve => { wakes.push(resolve); }));
    const e = emitter(wake);
    let steps = 0;
    vi.spyOn(e as unknown as Steps, "step").mockImplementation(async () => (++steps % 2 === 1 ? "appended" : "idle"));
    try {
      // First batch commits and starts an in-flight wake (e.g., an earlier enrolment/revoke).
      expect(await e.drainCollection(collection)).toBe(1);
      for (let i = 0; i < 6; i++) await Promise.resolve();
      expect(wake).toHaveBeenCalledTimes(1);
      // Multiple grants/enrolments commit while the first wake is still in flight.
      expect(await e.drainCollection(collection)).toBe(1);
      expect(await e.drainCollection(collection)).toBe(1);
      expect(await e.drainCollection(collection)).toBe(1);
      for (let i = 0; i < 6; i++) await Promise.resolve();
      // Still bounded to one in-flight wake per collection (no wake storm).
      expect(wake).toHaveBeenCalledTimes(1);
      // Once the first wake finishes, one coalesced follow-up wake runs for the newer commits.
      wakes.shift()!();
      await vi.waitFor(() => expect(wake).toHaveBeenCalledTimes(2));
      expect(wake).toHaveBeenNthCalledWith(2, collection);
      // Finishing the follow-up wake with no further commits does not loop.
      wakes.shift()!();
      for (let i = 0; i < 12; i++) await Promise.resolve();
      expect(wake).toHaveBeenCalledTimes(2);
    } finally {
      while (wakes.length) wakes.shift()!();
      await e.close();
    }
  });
  it("still runs the re-armed wake when the in-flight wake fails", async () => {
    let failFirst!: (error: Error) => void;
    let finishSecond!: () => void;
    const wake = vi.fn<() => Promise<void>>()
      .mockImplementationOnce(() => new Promise<void>((_, reject) => { failFirst = reject; }))
      .mockImplementationOnce(() => new Promise<void>(resolve => { finishSecond = resolve; }));
    const e = emitter(wake);
    let steps = 0;
    vi.spyOn(e as unknown as Steps, "step").mockImplementation(async () => (++steps % 2 === 1 ? "appended" : "idle"));
    try {
      expect(await e.drainCollection(collection)).toBe(1);
      for (let i = 0; i < 6; i++) await Promise.resolve();
      expect(await e.drainCollection(collection)).toBe(1);
      expect(wake).toHaveBeenCalledTimes(1);
      failFirst(new Error("wake transport failed"));
      await vi.waitFor(() => expect(wake).toHaveBeenCalledTimes(2));
      finishSecond();
      await e.close();
    } finally {
      finishSecond?.();
      await e.close();
    }
  });
  it("does not launch a re-armed wake after close starts, and drains an already started follow-up wake", async () => {
    const wakes: Array<() => void> = [];
    const wake = vi.fn(() => new Promise<void>(resolve => { wakes.push(resolve); }));
    const e = emitter(wake);
    let steps = 0;
    vi.spyOn(e as unknown as Steps, "step").mockImplementation(async () => (++steps % 2 === 1 ? "appended" : "idle"));
    try {
      expect(await e.drainCollection(collection)).toBe(1);
      for (let i = 0; i < 6; i++) await Promise.resolve();
      expect(await e.drainCollection(collection)).toBe(1);
      // Start closing while wake 1 is in flight with a pending re-arm.
      const closing = e.close();
      wakes.shift()!();
      await closing;
      expect(wake).toHaveBeenCalledTimes(1);
    } finally {
      while (wakes.length) wakes.shift()!();
      await e.close();
    }
  });
});
