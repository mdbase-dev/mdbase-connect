import { test } from "node:test";
import assert from "node:assert/strict";
import { isPermanentCustodyRefusal, withCustodyRetry } from "../src/custody-retry.ts";

const clock = () => {
  let t = 0;
  return { now: () => t, sleep: async (ms) => { t += ms; }, advance: (ms) => { t += ms; } };
};

test("transient custody refusals are retried with backoff until the fetch succeeds", async () => {
  const c = clock(), seen = [], signals = [];
  let calls = 0;
  const result = await withCustodyRetry(async (signal) => {
    signals.push(signal); calls++;
    if (calls === 1) throw new Error("custody_unavailable");
    if (calls === 2) throw new Error("custody_aborted");
    return "token";
  }, { now: c.now, sleep: c.sleep, onRetry: (f) => seen.push(f) });
  assert.equal(result, "token");
  assert.equal(calls, 3);
  assert.deepEqual(seen, [{ attempt: 1, code: "custody_unavailable", call: null, name: null, message: null }, { attempt: 2, code: "custody_aborted", call: null, name: null, message: null }]);
  assert.equal(c.now(), 250 + 500);
  assert(signals.every((s) => s instanceof AbortSignal && !s.aborted));
});

test("a refusal with a verdict is thrown at once, never retried", async () => {
  for (const code of ["custody_record_changed", "custody_identity_mismatch", "custody_token_invalid", "custody_invalid_record"]) {
    let calls = 0;
    await assert.rejects(withCustodyRetry(async () => { calls++; throw new Error(code); }, clock()), (e) => e.message === code);
    assert.equal(calls, 1);
  }
});

test("the whole budget bounds retries; the last transient refusal is thrown", async () => {
  const c = clock();
  let calls = 0;
  await assert.rejects(withCustodyRetry(async () => { calls++; c.advance(1_000); throw new Error("custody_aborted"); },
    { now: c.now, sleep: c.sleep, budgetMs: 10_000 }), /custody_aborted/);
  assert(calls > 1 && c.now() <= 10_000 + 1_000, `calls=${calls} t=${c.now()}`);
});

test("a collection the deployment's KMS does not serve is never retried", async () => {
  let calls = 0;
  await assert.rejects(withCustodyRetry(async () => { calls++; throw new Error("custody_collection_not_allowed"); }, clock()), /custody_collection_not_allowed/);
  assert.equal(calls, 1);
});

test("a collection the CP no longer serves is a permanent verdict, never retried", async () => {
  let calls = 0;
  await assert.rejects(withCustodyRetry(async () => { calls++; throw new Error("custody_collection_gone"); }, clock()), /custody_collection_gone/);
  assert.equal(calls, 1);
  for (const code of ["custody_collection_gone", "custody_collection_not_allowed"]) assert.equal(isPermanentCustodyRefusal(new Error(code)), true);
  for (const code of ["custody_unavailable", "custody_aborted", "custody_record_changed", "offline"]) assert.equal(isPermanentCustodyRefusal(new Error(code)), false);
  assert.equal(isPermanentCustodyRefusal("custody_collection_gone"), false);
});
