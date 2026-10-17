import { test } from "node:test";
import assert from "node:assert/strict";
import { generateServiceDevice } from "../src/service-devices.ts";
import { HostedAwsKms } from "../src/custody/aws-kms.ts";

const token = "s".repeat(40);
const collection = "11111111-1111-4111-8111-111111111111";
const device = "22222222-2222-4222-8222-222222222222";
const arn = "arn:aws:kms:ap-southeast-1:000000000000:key/33333333-3333-4333-8333-333333333333";
const request = (auth = token) => new Request("https://worker.test/internal/v1/service-devices", {
  method: "POST", headers: { authorization: `Bearer ${auth}` }, body: JSON.stringify({ collection }),
});
function fixture(extra = {}) {
  const secret = new Uint8Array(96).fill(7);
  let generated = 0;
  const deps = { serviceToken: token, newId: () => device,
    generate: () => { generated++; return { secret, signPk: new Uint8Array(32), kemPk: new Uint8Array(32), noisePk: new Uint8Array(32) }; },
    wrapper: { async wrapDeviceKeys() { return { envelope: Uint8Array.of(1), kmsKeyArn: arn }; } }, ...extra };
  return { deps, secret, generated: () => generated };
}
const cause = async (r) => { assert.equal(r.status, 503); return (await r.json()).sub_cause; };

test("LAB distinguishes both seed guards and envelope validation without changing effects", async (t) => {
  const log = t.mock.method(console, "warn", () => {});
  const before = fixture({ labRawErrors: true, allowed: async () => false });
  assert.deepEqual(await cause(await generateServiceDevice(request(), before.deps)), { call: "guard_before", code: "refused" });
  assert.equal(before.generated(), 0);
  let checks = 0;
  const after = fixture({ labRawErrors: true, allowed: async () => ++checks === 1 });
  assert.deepEqual(await cause(await generateServiceDevice(request(), after.deps)), { call: "guard_after", code: "refused" });
  assert.equal(after.generated(), 1);
  assert.ok(after.secret.every((b) => b === 0));
  const malformed = fixture({ labRawErrors: true, wrapper: { async wrapDeviceKeys() { return { envelope: new Uint8Array(0), kmsKeyArn: arn }; } } });
  assert.deepEqual(await cause(await generateServiceDevice(request(), malformed.deps)), { call: "envelope", code: "invalid" });
  assert.ok(malformed.secret.every((b) => b === 0));
  assert.equal(log.mock.callCount(), 3);
});

test("actual HostedAwsKms membership refusal is identified before fetch and the secret is wiped", async (t) => {
  t.mock.method(console, "warn", () => {});
  const kms = new HostedAwsKms({ keyArn: arn, region: "ap-southeast-1", environment: "lab", collections: [] }, () => null,
    async () => { assert.fail("membership refusal must not fetch"); });
  const f = fixture({ labRawErrors: true, wrapper: kms });
  assert.deepEqual(await cause(await generateServiceDevice(request(), f.deps)), { call: "wrap", code: "kms_collection_not_allowed" });
  assert.ok(f.secret.every((b) => b === 0));
});

test("real signed KMS HTTP refusal is finite, with no response data exposed", async (t) => {
  const log = t.mock.method(console, "warn", () => {});
  let calls = 0;
  const kms = new HostedAwsKms({ keyArn: arn, region: "ap-southeast-1", environment: "lab", collections: [collection] },
    () => ({ accessKeyId: "A".repeat(20), secretAccessKey: "x".repeat(40) }), async (r) => {
      calls++;
      assert.equal(r.headers.get("x-amz-target"), "TrentService.Encrypt");
      return new Response(JSON.stringify({ Message: "PRIVATE_RESPONSE_CANARY" }), { status: 403 });
    });
  const f = fixture({ labRawErrors: true, wrapper: kms });
  const r = await generateServiceDevice(request(), f.deps);
  assert.deepEqual(await cause(r), { call: "wrap", code: "kms_refused" });
  assert.equal(calls, 1);
  assert.ok(f.secret.every((b) => b === 0));
  assert.ok(!JSON.stringify(log.mock.calls).includes("PRIVATE_RESPONSE_CANARY"));
});

test("arbitrary exceptions become unknown; unauthenticated and non-LAB requests never get diagnostics", async (t) => {
  const log = t.mock.method(console, "warn", () => {});
  const wrapper = { async wrapDeviceKeys() { throw new Error("PRIVATE_ERROR_CANARY https://private.invalid TOKEN_VALUE"); } };
  const lab = fixture({ wrapper, labRawErrors: true });
  assert.deepEqual(await cause(await generateServiceDevice(request(), lab.deps)), { call: "wrap", code: "unknown" });
  assert.ok(!JSON.stringify(log.mock.calls).includes("PRIVATE_ERROR_CANARY"));
  log.mock.resetCalls();
  for (const labRawErrors of [undefined, false]) {
    const f = fixture({ wrapper, labRawErrors });
    const r = await generateServiceDevice(request(), f.deps);
    assert.equal(r.status, 503);
    assert.deepEqual(await r.json(), { error: "custody_unavailable" });
    assert.ok(f.secret.every((b) => b === 0));
  }
  const denied = fixture({ labRawErrors: true });
  assert.equal((await generateServiceDevice(request("wrong"), denied.deps)).status, 401);
  assert.equal(denied.generated(), 0);
  assert.equal(log.mock.callCount(), 0);
});

test("successful LAB generation retains the exact public schema and never logs", async (t) => {
  const log = t.mock.method(console, "warn", () => {});
  const f = fixture({ labRawErrors: true });
  const r = await generateServiceDevice(request(), f.deps);
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(await r.json()), ["kind", "device_id", "sign_pk", "kem_pk", "noise_pk", "wrapped_keys", "kms_key_arn"]);
  assert.ok(f.secret.every((b) => b === 0));
  assert.equal(log.mock.callCount(), 0);
});
