// The LAB custody stub: envelopes open only for the record they were made for, and
// the escrow deployment reports kind "escrow".
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { LAB_STUB_ARN, labStubUnwrap, labStubWrapper } from "../src/custody-stub.ts";
import { generateServiceDevice } from "../src/service-devices.ts";
import { generateDeviceKeys } from "../src/keygen.ts";

const K = "ab".repeat(32);
const col = "51515151-5151-4151-8151-515151515151";
const dev = "0c0c0c0c-0c0c-4c0c-8c0c-0c0c0c0c0c0c";

test("stub wrap/unwrap is bound to role, collection and device", async () => {
  const secret = Uint8Array.from({ length: 96 }, (_, i) => i);
  const w = labStubWrapper("escrow", K);
  const { envelope, kmsKeyArn } = await w.wrapDeviceKeys({ collection: col, device: dev, secret }, AbortSignal.timeout(1000));
  assert.equal(kmsKeyArn, LAB_STUB_ARN);
  assert.match(kmsKeyArn, /^arn:[!-~]{1,2044}$/);
  assert.ok(!Buffer.from(envelope).includes(Buffer.from(secret.subarray(0, 16))), "no plaintext in the envelope");
  assert.deepEqual(await labStubUnwrap(K, "escrow", col, dev, envelope), secret);
  for (const [k, role, c, d] of [
    ["cd".repeat(32), "escrow", col, dev],
    [K, "hosted", col, dev],
    [K, "escrow", "52525252-5252-4252-8252-525252525252", dev],
    [K, "escrow", col, "0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b"],
  ]) {
    await assert.rejects(labStubUnwrap(k, role, c, d, envelope));
  }
  const tampered = Uint8Array.from(envelope);
  tampered[tampered.length - 1] ^= 1;
  await assert.rejects(labStubUnwrap(K, "escrow", col, dev, tampered));
  assert.equal(labStubWrapper("escrow", undefined), null, "absent key: no stub");
  await assert.rejects(labStubWrapper("escrow", "ab").wrapDeviceKeys({ collection: col, device: dev, secret }, AbortSignal.timeout(1000)));
});

const wasm = new URL("../hosted.wasm", import.meta.url);
const skip = existsSync(wasm) ? false : "hosted.wasm not built";
test("the escrow deployment generates an escrow service device under the stub", { skip }, async () => {
  const module = new WebAssembly.Module(readFileSync(wasm));
  const token = "s".repeat(40);
  const r = await generateServiceDevice(new Request("https://escrow.test/internal/v1/service-devices", {
    method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ collection: col }),
  }), { serviceToken: token, generate: () => generateDeviceKeys(module), wrapper: labStubWrapper("escrow", K), kind: "escrow" });
  assert.equal(r.status, 200);
  const b = await r.json();
  assert.equal(b.kind, "escrow");
  assert.equal(b.kms_key_arn, LAB_STUB_ARN);
  const secret = await labStubUnwrap(K, "escrow", col, b.device_id, Buffer.from(b.wrapped_keys, "base64"));
  assert.equal(secret.length, 96);
});
