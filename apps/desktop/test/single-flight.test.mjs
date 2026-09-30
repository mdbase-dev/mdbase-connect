import assert from "node:assert/strict";
import test from "node:test";
import { singleFlight, singleFlightEach } from "../src/renderer/single-flight.mts";

test("overlapping refreshes share one operation and capacity is released", async () => {
  const calls = [];
  let release;
  const refresh = singleFlight(async (quiet) => {
    calls.push(quiet);
    if (calls.length === 1) await new Promise((resolve) => { release = resolve; });
    return calls.length;
  });

  const first = refresh(false);
  const overlapping = refresh(true);
  assert.equal(first, overlapping);
  await Promise.resolve();
  assert.deepEqual(calls, [false]);
  release();
  assert.equal(await first, 1);

  assert.equal(await refresh(true), 2);
  assert.deepEqual(calls, [false, true]);
});

test("a rejected refresh does not wedge later refreshes", async () => {
  let attempts = 0;
  const refresh = singleFlight(async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("offline");
    return "online";
  });

  await assert.rejects(refresh(), /offline/);
  assert.equal(await refresh(), "online");
  assert.equal(attempts, 2);
});

test("each request coalesces on its own, so a slow one does not hold back another", async () => {
  let release;
  let slowCalls = 0;
  let fastCalls = 0;
  const requests = singleFlightEach({
    slow: async () => {
      slowCalls += 1;
      await new Promise((resolve) => { release = resolve; });
    },
    fast: async () => (fastCalls += 1)
  });

  const firstSlow = requests.slow();
  assert.equal(await requests.fast(), 1);
  assert.equal(requests.slow(), firstSlow);
  assert.equal(await requests.fast(), 2);
  assert.equal(slowCalls, 1);
  release();
  await firstSlow;
});
