import assert from "node:assert/strict";
import test from "node:test";
import { PAIRING_PREPARATION_TIMEOUT_MS, watchPairingPreparation } from "./src/pairing-progress.ts";

const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
function fixture(t, read, isDispatching = () => false) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const ready = [], errors = [];
  let timeouts = 0;
  const options = { read, isDispatching, onReady: value => ready.push(value), onError: reason => errors.push(reason), onTimeout: () => { timeouts++; } };
  return { ready, errors, options, get timeouts() { return timeouts; } };
}

test("preparation times out even if inspection hangs, fences late success, and retries only the same read", async t => {
  let resolve, signal, reads = 0;
  const ready = { attested: true, approved_at: null };
  const f = fixture(t, async current => { signal = current; reads++; return new Promise(r => { resolve = r; }); });
  const stop = watchPairingPreparation(f.options);
  t.mock.timers.tick(1000);
  assert.equal(reads, 1);
  t.mock.timers.tick(PAIRING_PREPARATION_TIMEOUT_MS - 1000);
  assert.equal(f.timeouts, 1);
  assert.equal(signal.aborted, true);
  resolve(ready); await flush();
  assert.deepEqual(f.ready, []);
  assert.deepEqual(f.errors, []);
  stop(); stop();
  const retry = watchPairingPreparation(f.options);
  t.mock.timers.tick(1000);
  assert.equal(reads, 2);
  resolve(ready); await flush();
  assert.deepEqual(f.ready, [ready]);
  t.mock.timers.tick(PAIRING_PREPARATION_TIMEOUT_MS);
  assert.equal(f.timeouts, 1);
  retry();
});

test("repeated unprepared responses cannot extend the deadline", async t => {
  let reads = 0;
  const f = fixture(t, async () => { reads++; return { attested: false, approved_at: null }; });
  watchPairingPreparation(f.options);
  for (let i = 0; i < 29; i++) { t.mock.timers.tick(1000); await flush(); }
  assert.equal(reads, 29);
  assert.equal(f.timeouts, 0);
  t.mock.timers.tick(1000); await flush();
  assert.equal(f.timeouts, 1);
  assert.deepEqual(f.ready, []);
});

test("cleanup prevents another read or timeout after leaving the pairing", async t => {
  const f = fixture(t, async () => { throw new Error("must not read"); });
  const stop = watchPairingPreparation(f.options);
  stop();
  t.mock.timers.tick(PAIRING_PREPARATION_TIMEOUT_MS); await flush();
  assert.equal(f.timeouts, 0);
  assert.deepEqual(f.errors, []);
});

test("an inspection failure stops polling and does not later become a timeout", async t => {
  const reason = new TypeError("Failed to fetch");
  const f = fixture(t, async () => { throw reason; });
  watchPairingPreparation(f.options);
  t.mock.timers.tick(1000); await flush();
  assert.deepEqual(f.errors, [reason]);
  t.mock.timers.tick(PAIRING_PREPARATION_TIMEOUT_MS);
  assert.equal(f.timeouts, 0);
});
