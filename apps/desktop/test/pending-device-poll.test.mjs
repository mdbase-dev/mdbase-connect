import assert from "node:assert/strict";
import test from "node:test";
import { PendingDevicePoll } from "../src/main/pending-device-poll.ts";

test("slow reads deduplicate past the TTL and empty results age from completion", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 10_000 });
  const first = Promise.withResolvers();
  let calls = 0;
  const poll = new PendingDevicePoll(() => ++calls === 1 ? first.promise : Promise.resolve(["device"]), 20_000);
  const reading = poll.read();
  t.mock.timers.tick(21_000);
  assert.equal(poll.read(), reading);
  first.resolve([]);
  assert.deepEqual(await reading, []);
  t.mock.timers.tick(19_999);
  assert.deepEqual(await poll.read(), []);
  assert.equal(calls, 1);
  t.mock.timers.tick(1);
  assert.deepEqual(await poll.read(), ["device"]);
  assert.deepEqual(await poll.read(), ["device"]);
  assert.equal(calls, 3);
});

test("a read after an approval waits for the old CLI without caching its stale result", async () => {
  const first = Promise.withResolvers();
  let calls = 0;
  const poll = new PendingDevicePoll(() => ++calls === 1 ? first.promise : Promise.resolve(["other device"]), 20_000);
  const reading = poll.read();
  poll.invalidate();
  const fresh = poll.read();
  assert.equal(calls, 1);
  first.resolve([]);
  assert.deepEqual(await reading, []);
  assert.deepEqual(await fresh, ["other device"]);
  assert.equal(calls, 2);
});
