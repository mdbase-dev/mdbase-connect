import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
const { ensureAgentReady, presentReadiness } = createRequire(import.meta.url)("../dist/main/agent-startup.js");

const health = { schema_version: 1, ready: true, binary_version: "expected" };
for (const [name, value, state] of [
  ["ready", health, "ready"],
  ["missing", undefined, "attention"],
  ["future schema", { ...health, schema_version: 2 }, "attention"],
  ["wrong version", { ...health, binary_version: "old" }, "attention"],
  ["missing ready", { ...health, ready: undefined }, "attention"],
  ["starting", { ...health, ready: false, safe_reason: "starting" }, "starting"],
  ...["initialization_failed", "critical_worker_failed", "credential_store_unavailable"].map((reason) =>
    [reason, { ...health, ready: false, safe_reason: reason }, "attention"])
]) {
  test(`canonical readiness: ${name}`, async () => {
    assert.equal(presentReadiness(value, "expected").state, state);
    if (state !== "attention") return;
    let probes = 0;
    await assert.rejects(ensureAgentReady({
      expectedVersion: "expected",
      async ping() { probes++; return { pong: true, ready: true, readiness: value }; },
      async launch() { assert.fail("must not launch over incompatible or failed daemon"); },
      endpointIsUnavailable: () => false,
      incompatibleDaemon: () => false
    }));
    assert.equal(probes, 1);
  });
}
