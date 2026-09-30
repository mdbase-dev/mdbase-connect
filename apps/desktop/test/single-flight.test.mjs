import assert from "node:assert/strict";
import test from "node:test";
import { singleFlight } from "../src/renderer/single-flight.mts";

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
