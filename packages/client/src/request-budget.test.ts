import { afterEach, describe, expect, it, vi } from "vitest";
import { MdbaseConnectError } from "./errors.js";
import {
  createRequestBudget,
  requestAbortReason,
  withRequestBudget
} from "./request-budget.js";

afterEach(() => vi.useRealTimers());

describe("request budgets", () => {
  it("bounds a black-holed operation with a typed timeout", async () => {
    vi.useFakeTimers();
    const pending = withRequestBudget(
      { timeoutMs: 25 },
      1_000,
      async () => new Promise<never>(() => undefined)
    );
    const rejection = expect(pending).rejects.toMatchObject<MdbaseConnectError>({
      code: "timeout",
      problem: { operation_outcome: "not_sent" }
    });
    await vi.advanceTimersByTimeAsync(25);
    await rejection;
  });

  it("allows an explicit null timeout for intentional streams", () => {
    vi.useFakeTimers();
    const budget = createRequestBudget({ timeoutMs: null }, 10);
    vi.advanceTimersByTime(60_000);
    expect(budget.deadline).toBeNull();
    expect(budget.remainingMs()).toBeNull();
    expect(budget.signal.aborted).toBe(false);
    budget.dispose();
  });

  it("composes caller cancellation and removes its listener", () => {
    const caller = new AbortController();
    const remove = vi.spyOn(caller.signal, "removeEventListener");
    const budget = createRequestBudget({ signal: caller.signal, timeoutMs: null });
    caller.abort("navigation");
    expect(budget.signal.aborted).toBe(true);
    expect((requestAbortReason(budget.signal) as MdbaseConnectError).code)
      .toBe("operation_cancelled");
    budget.dispose();
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid timeout %s before dispatch",
    (timeoutMs) => {
      expect(() => createRequestBudget({ timeoutMs })).toThrow(TypeError);
    }
  );
});
