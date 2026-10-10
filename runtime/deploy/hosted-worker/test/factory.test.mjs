// The production custody factory: fail closed on partial configuration, one
// collection per DO, hosted records only.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
// Test-only module replacement, never a shipped/runtime trust override.
let bundled = { schema: "mdbn-app-trust/release/1", environment: "lab", cpOrigin: "https://cp.test", logOrigin: "https://log.test",
  assetSha256: "aa".repeat(32), source: { repository: "mdbase-dev/mdbase-connect", commit: "bb".repeat(20), version: "unit" },
  trustedRoots: [new Uint8Array(32).fill(0xab)], policyPins: Uint8Array.of(0x80) };
const configured = bundled;
mock.module("#hosted-release-trust", { namedExports: { appReleaseTrust: () => bundled } });
const { ProductionCustody, hostedPort, productionParts, productionWrapper } = await import("../src/factory.ts");
import { ControlClient } from "../src/control.ts";

const full = {
  KMS_KEY_ARN: "arn:aws:kms:eu-west-1:123456789012:key/11111111-1111-4111-8111-111111111111",
  AWS_REGION: "eu-west-1", AWS_ACCESS_KEY_ID: "AKIDEXAMPLE", AWS_SECRET_ACCESS_KEY: "s".repeat(40),
  KMS_ENVIRONMENT: "lab", KMS_COLLECTIONS: "0e0e0e0e-0e0e-4e0e-8e0e-0e0e0e0e0e0e",
  LOG_URL: "https://log.test", CP_URL: "https://cp.test", CP_INBOUND_TOKEN: "t".repeat(40), CP_ROOTS: "ab".repeat(32),
  HOSTED_SIGNERS: "22222222-2222-4222-8222-222222222222",
};

test("fails closed unless fully configured", () => {
  assert.ok(productionParts(full));
  for (const k of Object.keys(full).filter((k) => k !== "KMS_COLLECTIONS" && k !== "CP_ROOTS")) {
    assert.equal(productionParts({ ...full, [k]: "" }), null, k);
  }
  assert.ok(productionParts({ ...full, CP_ROOTS: undefined }), "only bundle supplies authority");
  assert.equal(productionParts({ ...full, CP_ROOTS: "zz" }), null);
  assert.equal(productionParts({ ...full, LOG_URL: "https://wrong.test" }), null);
  bundled = null;
  assert.equal(productionParts(full), null, "unsigned runtime roots cannot replace missing build asset");
  bundled = configured;
  assert.equal(productionParts({ ...full, KMS_ENVIRONMENT: "dev" }), null);
  assert.equal(productionParts({ ...full, AWS_REGION: "us-east-1" }), null, "ARN region must match");
  assert.equal(productionParts({ ...full, CP_URL: "http://cp.test" }), null);
  assert.equal(productionWrapper(null), null);
  assert.ok(productionWrapper(productionParts(full)));
});

test("one collection per DO; replica ID asked once", async () => {
  let asked = 0;
  const failing = async () => { throw new TypeError("offline"); };
  const parts = productionParts(full, failing);
  const c = new ProductionCustody(parts, async () => { asked++; return "33333333-3333-4333-8333-333333333333"; }, () => null, () => false);
  const col = "0e0e0e0e-0e0e-4e0e-8e0e-0e0e0e0e0e0e";
  await assert.rejects(c.openSealer(col, AbortSignal.timeout(1000)));
  await assert.rejects(c.logToken(col, AbortSignal.timeout(1000)));
  assert.equal(asked, 1);
  await assert.rejects(c.openSealer("1b1b1b1b-1b1b-4b1b-8b1b-1b1b1b1b1b1b", AbortSignal.timeout(1000)), /custody_unavailable/);
  c.close();
});

test("the port passes hosted records only", async () => {
  const rec = (kind) => async () => Response.json({ kind, device_id: "11111111-1111-4111-8111-111111111111", sign_pk: "aa".repeat(32),
    kem_pk: "bb".repeat(32), noise_pk: "cc".repeat(32), wrapped_keys: Buffer.from("e").toString("base64"), kms_key_arn: "arn:aws:kms:x", genesis: { seq: 1, item: "oA==", hash: "dd".repeat(32) } });
  const col = "0e0e0e0e-0e0e-4e0e-8e0e-0e0e0e0e0e0e";
  const ok = await hostedPort(new ControlClient({ url: "https://cp.test", token: "t".repeat(40) }, rec("hosted"))).serviceDevice(col, AbortSignal.timeout(1000));
  assert.equal(ok.kind, "hosted");
  await assert.rejects(hostedPort(new ControlClient({ url: "https://cp.test", token: "t".repeat(40) }, rec("escrow"))).serviceDevice(col, AbortSignal.timeout(1000)));
});

test("terminal close: no custody is created or handed out after close; one instance under races", async () => {
  const parts = productionParts(full, async () => { throw new TypeError("offline"); });
  let release;
  const gate = new Promise((r) => { release = r; });
  let asked = 0;
  const c = new ProductionCustody(parts, async () => { asked++; await gate; return "33333333-3333-4333-8333-333333333333"; }, () => null, () => false);
  const col = "0e0e0e0e-0e0e-4e0e-8e0e-0e0e0e0e0e0e";
  const a = c.openSealer(col, AbortSignal.timeout(1000));
  const b = c.logToken(col, AbortSignal.timeout(1000));
  c.close();
  release();
  await assert.rejects(a, /custody_aborted/);
  await assert.rejects(b, /custody_aborted/);
  assert.equal(asked, 1, "single flight");
  await assert.rejects(c.openSealer(col, AbortSignal.timeout(1000)), /custody_unavailable/);
});

test("terminal close after creation: a token minted during close is not handed out", async () => {
  const parts = productionParts(full, async () => { throw new TypeError("offline"); });
  const c = new ProductionCustody(parts, async () => "33333333-3333-4333-8333-333333333333", () => null, () => false);
  const col = "0e0e0e0e-0e0e-4e0e-8e0e-0e0e0e0e0e0e";
  // Create the custody, then stand in for its token mint and close mid-flight.
  await assert.rejects(c.openSealer(col, AbortSignal.timeout(1000)));
  const inner = c["custody"];
  assert.ok(inner, "custody created");
  inner.logToken = async () => { c.close(); return "late-token"; };
  await assert.rejects(c.logToken(col, AbortSignal.timeout(1000)), /custody_aborted/);
});
