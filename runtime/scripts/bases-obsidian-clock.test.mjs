import test from "node:test";
import assert from "node:assert/strict";
import { installOwnedClock } from "./bases-obsidian-clock.mjs";

test("freeze construction, not scheduler elapsed time or explicit dates", () => {
  const previous = globalThis.window;
  let schedulingTime = 100;
  class RealClock extends Date {
    static now() {
      return schedulingTime;
    }
  }
  globalThis.window = { Date: RealClock };
  try {
    const epoch = 1781075828070;
    installOwnedClock(epoch);
    assert.equal(new window.Date().getTime(), epoch);
    assert.equal(window.Date.now(), 100);
    schedulingTime = 200;
    assert.equal(window.Date.now(), 200);
    assert.equal(new window.Date().getTime(), epoch);
    assert.equal(new window.Date(1234).getTime(), 1234);
    assert.equal(window.Date.UTC(2026, 5, 10), Date.UTC(2026, 5, 10));
    assert.throws(() => installOwnedClock(NaN));
  } finally {
    if (previous === undefined) delete globalThis.window;
    else globalThis.window = previous;
  }
});
