import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { build } from "esbuild";
import { controlModule, qualifyServiceRecordConsumer } from "../service-record-compatibility.mjs";

const record = JSON.parse(fs.readFileSync(new URL("fixtures/service-device-record.json", import.meta.url)));
const prior = fs.readFileSync(new URL("fixtures/service-record-consumer-v1.js", import.meta.url));
const recordBytes = role => Buffer.from(JSON.stringify({ ...record, kind: role }) + "\n");
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
// Build the actual current consumer, not a hand-maintained acceptance adapter.
// The entry marker is also how real frozen Wrangler bundles delimit modules.
const compiled = await build({
  stdin: { contents: 'import { ControlClient } from "./src/control.ts"; export function create(...args) { return new ControlClient(...args); }', resolveDir: new URL("../", import.meta.url).pathname, sourcefile: "qualification-entry.js" },
  bundle: true, write: false, format: "esm", platform: "node", keepNames: true,
});
const current = Buffer.from(compiled.outputFiles[0].text);

test("actual prior compiled consumer refuses the mandatory current record for both service roles", async () => {
  assert.equal(sha(controlModule(prior.toString())), "8e0178e022d3af22e36d87e7dac004f80d89cbde95fc0b71e10525bdc687d6bb");
  for (const role of ["hosted", "escrow"]) {
    const report = await qualifyServiceRecordConsumer({ bundleBytes: prior, recordBytes: recordBytes(role), role });
    assert.equal(report.compatible, false);
    assert.equal(report.failure, "record_contract_refused");
    assert.equal(report.bundleSha256, sha(prior));
    assert.equal(report.recordSha256, sha(recordBytes(role)));
  }
});

test("exact current compiled consumers accept the record and preserve mandatory refusals", async () => {
  for (const role of ["hosted", "escrow"]) {
    const bytes = recordBytes(role);
    const report = await qualifyServiceRecordConsumer({ bundleBytes: current, recordBytes: bytes, role });
    assert.equal(report.compatible, true);
    assert.equal(report.checkedRefusals, 6);
    assert.equal(report.fixtureFetchCalls, 7);
    assert.equal(report.networkRequests, 0);
    assert.equal(report.unwrapCalls, 0);
    assert.equal(report.bundleSha256, sha(current));
    assert.equal(report.consumerSha256, sha(controlModule(current.toString())));
    assert.equal(report.recordSha256, sha(bytes));
    assert.equal(report.scope, "structural-service-record-compatibility");
    assert.equal(Object.hasOwn(report, "deploymentAuthorized"), false);
  }
});

test("missing, minified or ambiguous module boundaries cannot substitute source qualification", () => {
  for (const bundle of ["", "var ControlClient=class{}", current.toString() + current.toString(), "// src/control.ts\nvar ControlClient = class {};\n"]) {
    assert.throws(() => controlModule(bundle), { message: "unsupported_consumer_bundle" });
  }
});

test("caller shape, bounds, malformed UTF8 and noncanonical records refuse before artifact execution", async () => {
  const good = { bundleBytes: current, recordBytes: recordBytes("hosted"), role: "hosted" };
  for (const delta of [
    { role: "desktop" }, { bundleBytes: Buffer.alloc(0) }, { bundleBytes: Buffer.alloc((8 << 20) + 1) },
    { recordBytes: Buffer.alloc((128 << 10) + 1) }, { recordBytes: Buffer.from([255]) },
    { recordBytes: Buffer.from("not-json-private-data") }, { recordBytes: Buffer.from(JSON.stringify(record)) },
    { recordBytes: recordBytes("escrow") },
    { recordBytes: Buffer.from('{"kind":"hosted","kind":"hosted"}\n') },
  ]) await assert.rejects(qualifyServiceRecordConsumer({ ...good, ...delta }), { message: "invalid_qualification_input" });
});

test("unexpected consumer runtime failures are fixed diagnostics, not compatibility success", async () => {
  const broken = Buffer.from('// src/control.ts\nvar ControlClient = class { constructor() { throw new Error("private-detail"); } };\n// end\n');
  const report = await qualifyServiceRecordConsumer({ bundleBytes: broken, recordBytes: recordBytes("hosted"), role: "hosted" });
  assert.equal(report.compatible, false);
  assert.equal(report.failure, "artifact_runtime_failure");
  assert.equal(JSON.stringify(report).includes("private-detail"), false);
});

test("a stalled artifact is bounded and its worker is terminated", async () => {
  const stalled = Buffer.from('// src/control.ts\nvar ControlClient = class { serviceDevice() { while (true) {} } };\n// end\n');
  const report = await qualifyServiceRecordConsumer({ bundleBytes: stalled, recordBytes: recordBytes("hosted"), role: "hosted" });
  assert.equal(report.compatible, false);
  assert.equal(report.failure, "qualifier_timeout");
});
