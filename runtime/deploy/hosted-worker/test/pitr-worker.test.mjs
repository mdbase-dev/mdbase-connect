import assert from "node:assert/strict";
import { mock, test } from "node:test";
let calls = 0;
mock.module("../src/worker.ts", { namedExports: { HostedCollection: class {} }, defaultExport: {
  async fetch() { calls++; return new Response("synthetic delegated handler"); }
} });
const { default: worker } = await import("../src/pitr-worker.ts");
test("required isolated entrypoint never falls back when the deployment binding is missing", async () => {
  for (const env of [{}, { PITR_BINDING: "" }, { PITR_BINDING: undefined }, { PITR_BINDING: 1 }]) {
    assert.equal((await worker.fetch(new Request("https://synthetic.test/v1/hosted/status"), env)).status, 503);
  }
  assert.equal(calls, 0);
});
test("configured entrypoint delegates to the canonical handler for strict binding/phase admission", async () => {
  assert.equal((await worker.fetch(new Request("https://synthetic.test/internal/v1/service-devices"), { PITR_BINDING: "synthetic" })).status, 200);
  assert.equal(calls, 1); // Delegation only: the real handler still rejects malformed bindings.
});
