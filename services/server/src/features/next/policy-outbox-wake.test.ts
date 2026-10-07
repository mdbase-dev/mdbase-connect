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
});
