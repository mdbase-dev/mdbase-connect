import assert from "node:assert/strict";
import { test } from "node:test";
import { retryProviderDatabaseRequest } from "./provider-database-retry.mjs";

const conflict = retryClass => ({
  ok: false,
  status: 503,
  body: { error: { code: "provider_database_retryable", details: { retry_class: retryClass } } }
});

test("retries aborted provider transactions with bounded exponential delays", async () => {
  const success = { ok: true, status: 200, body: { provisioned: true } };
  const replies = [conflict("deadlock"), conflict("serialization"), success];
  const waits = [];
  let calls = 0;
  const result = await retryProviderDatabaseRequest(
    async () => replies[calls++],
    async milliseconds => waits.push(milliseconds)
  );
  assert.equal(result, success);
  assert.equal(calls, 3);
  assert.deepEqual(waits, [25, 50]);
});

test("exhaustion returns the original final conflict for the caller's diagnostics", async () => {
  const last = conflict("deadlock");
  const waits = [];
  let calls = 0;
  const result = await retryProviderDatabaseRequest(
    async () => { calls++; return last; },
    async milliseconds => waits.push(milliseconds)
  );
  assert.equal(result, last);
  assert.equal(calls, 5);
  assert.deepEqual(waits, [25, 50, 100, 200]);
});

test("does not retry other failures or a successful response bearing an error code", async () => {
  for (const response of [
    { status: 503, body: { error: { code: "provider_database_timeout" } } },
    { status: 502, body: { error: { code: "provider_database_retryable" } } },
    { status: 403, body: { error: { code: "scope_denied" } } },
    { status: 400, body: { error: { code: "invalid_type_pack" } } },
    { status: 503, body: "upstream unavailable" },
    { status: 503 },
    { status: 200, body: { error: { code: "provider_database_retryable" } } }
  ]) {
    let calls = 0;
    const result = await retryProviderDatabaseRequest(
      async () => { calls++; return response; },
      async () => assert.fail("non-retryable response must not sleep")
    );
    assert.equal(result, response);
    assert.equal(calls, 1);
  }
});

test("does not replay a transport failure whose transaction outcome is unknown", async () => {
  const failure = new Error("connection reset");
  let calls = 0;
  await assert.rejects(retryProviderDatabaseRequest(
    async () => { calls++; throw failure; },
    async () => assert.fail("transport failure must not sleep")
  ), error => error === failure);
  assert.equal(calls, 1);
});
