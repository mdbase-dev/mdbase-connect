import { describe, expect, it } from "vitest";
import type { MirrorApplyResult } from "./mirror-plan.js";
import { MAX_WATCH_BACKOFF_MS, WatchBackoff } from "./watch-backoff.js";

function result(status: MirrorApplyResult["status"], applied = 0, plan = "plan-1"): MirrorApplyResult {
  return {
    status,
    plan_fingerprint: plan,
    applied,
    pending: 1,
    checkpoint_cursor: null,
    conflicts: 0,
    issues: []
  };
}

describe("mdbase-mirror watch backoff", () => {
  it("doubles the wait while a kept batch makes no progress, up to five minutes", () => {
    const backoff = new WatchBackoff(2_000);
    const waits = Array.from({ length: 10 }, () => backoff.next(result("failed", 1)));
    expect(waits).toEqual([
      2_000, 4_000, 8_000, 16_000, 32_000, 64_000, 128_000, 256_000, MAX_WATCH_BACKOFF_MS, MAX_WATCH_BACKOFF_MS
    ]);
    // Errors before any result back off the same way.
    const offline = new WatchBackoff(2_000);
    expect([offline.next(undefined), offline.next(undefined), offline.next(undefined)]).toEqual([2_000, 4_000, 8_000]);
  });

  it("resets on progress, on a successful pass, and on a local change", () => {
    const backoff = new WatchBackoff(2_000);
    backoff.next(result("failed", 1));
    expect(backoff.next(result("failed", 1))).toBe(4_000);
    // The batch moved on to its next action before blocking again.
    expect(backoff.next(result("failed", 2))).toBe(2_000);
    expect(backoff.next(result("failed", 2))).toBe(4_000);
    expect(backoff.next(result("applied", 3))).toBe(2_000);
    expect(backoff.next(result("failed", 3))).toBe(2_000);

    expect(backoff.next(result("failed", 3))).toBe(4_000);
    expect(backoff.reset()).toBe(true);
    expect(backoff.next(result("failed", 3))).toBe(2_000);
    expect(backoff.reset()).toBe(false);
  });
});
