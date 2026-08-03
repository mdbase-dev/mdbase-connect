import assert from "node:assert/strict";
import test from "node:test";
import { availableTcpPort, poll } from "./test-runtime.mjs";

test("allocates a valid loopback port", async () => {
  const port = await availableTcpPort();
  assert.ok(Number.isInteger(port));
  assert.ok(port > 0 && port <= 65_535);
});

test("poll returns the first truthy result", async () => {
  let attempts = 0;
  const result = await poll(() => {
    attempts += 1;
    return attempts === 3 ? "ready" : undefined;
  }, "did not become ready", 4, 0);
  assert.equal(result, "ready");
  assert.equal(attempts, 3);
});

test("poll retains the last failure as its cause", async () => {
  const failure = new Error("connection refused");
  await assert.rejects(
    poll(() => { throw failure; }, "service unavailable", 2, 0),
    (error) => error.message === "service unavailable" && error.cause === failure
  );
});
