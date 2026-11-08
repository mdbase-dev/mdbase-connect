import { test } from "node:test";
import assert from "node:assert/strict";
import { deadline, withDeadline } from "../src/deadline.ts";

const timers = () => process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;

test("a settled deadline leaves no timer behind", async () => {
  const before = timers();
  assert.equal(await withDeadline(60_000, async (signal) => { assert(!signal.aborted); return 1; }), 1);
  await assert.rejects(withDeadline(60_000, async () => { throw new Error("boom"); }), /boom/);
  const d = deadline(60_000);
  assert.equal(timers(), before + 1);
  d.clear();
  assert.equal(timers(), before);
});

test("an expired deadline aborts with a TimeoutError; a parent abort still reaches the work", async () => {
  await assert.rejects(withDeadline(5, (signal) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)))),
    (e) => e.name === "TimeoutError");
  const parent = new AbortController();
  const run = withDeadline(60_000, (signal) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("parent")))), parent.signal);
  parent.abort();
  await assert.rejects(run, /parent/);
});
