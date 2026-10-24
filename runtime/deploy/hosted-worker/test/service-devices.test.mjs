// The deployment's service-device generation, over the real engine wasm (build it
// first with ./build-wasm.sh; the test skips without it) and a fake KMS wrapper.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createPrivateKey, createPublicKey } from "node:crypto";
import { devicePublicKeys, generateDeviceKeys } from "../src/keygen.ts";
import { generateServiceDevice } from "../src/service-devices.ts";

const wasm = new URL("../hosted.wasm", import.meta.url);
const skip = existsSync(wasm) ? false : "hosted.wasm not built";
const module = skip ? null : new WebAssembly.Module(readFileSync(wasm));
const token = "s".repeat(40);
const collection = "0e0e0e0e-0e0e-4e0e-8e0e-0e0e0e0e0e0e";
const hex = (b) => Buffer.from(b).toString("hex");

// Independent derivations with node:crypto.
const edPublic = (seed) => createPublicKey(createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]), format: "der", type: "pkcs8" })).export({ format: "der", type: "spki" }).subarray(12);
const xPublic = (sk) => createPublicKey(createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b656e04220420", "hex"), sk]), format: "der", type: "pkcs8" })).export({ format: "der", type: "spki" }).subarray(12);

function wrapper(seen) {
  return {
    async wrapDeviceKeys(input, signal) {
      assert.ok(signal instanceof AbortSignal);
      seen.push({ ...input, copy: Buffer.from(input.secret) });
      return { envelope: Buffer.from("MDBK-envelope"), kmsKeyArn: "arn:aws:kms:eu-west-1:000000000000:key/lab" };
    },
  };
}
const post = (body, auth = `Bearer ${token}`) => new Request("https://hosted.test/internal/v1/service-devices", {
  method: "POST", headers: { authorization: auth, "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body),
});

test("generated keys match independent derivation and differ each time", { skip }, () => {
  const a = generateDeviceKeys(module);
  const b = generateDeviceKeys(module);
  assert.equal(a.secret.length, 96);
  assert.deepEqual(Buffer.from(a.signPk), edPublic(Buffer.from(a.secret.subarray(0, 32))));
  assert.deepEqual(Buffer.from(a.kemPk), xPublic(Buffer.from(a.secret.subarray(32, 64))));
  assert.deepEqual(Buffer.from(a.noisePk), xPublic(Buffer.from(a.secret.subarray(64, 96))));
  assert.notDeepEqual(a.secret, b.secret);
  assert.deepEqual(devicePublicKeys(module, a.secret), { signPk: a.signPk, kemPk: a.kemPk, noisePk: a.noisePk });
  assert.equal(devicePublicKeys(module, a.secret.subarray(0, 95)), null);
});

test("returns public keys and the envelope, and wipes the secret", { skip }, async () => {
  const seen = [];
  const response = await generateServiceDevice(post({ collection }), { serviceToken: token, generate: () => generateDeviceKeys(module), wrapper: wrapper(seen), newId: () => "11111111-1111-4111-8111-111111111111" });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const record = await response.json();
  assert.deepEqual(Object.keys(record), ["kind", "device_id", "sign_pk", "kem_pk", "noise_pk", "wrapped_keys", "kms_key_arn"]);
  assert.equal(record.kind, "hosted");
  assert.equal(record.device_id, "11111111-1111-4111-8111-111111111111");
  assert.equal(seen.length, 1);
  assert.equal(seen[0].collection, collection);
  assert.equal(seen[0].device, record.device_id);
  assert.equal(seen[0].copy.length, 96);
  assert.ok(seen[0].secret.every((b) => b === 0), "secret wiped after wrap");
  assert.equal(record.sign_pk, hex(edPublic(seen[0].copy.subarray(0, 32))));
  assert.equal(record.noise_pk, hex(xPublic(seen[0].copy.subarray(64, 96))));
  assert.equal(Buffer.from(record.wrapped_keys, "base64").toString(), "MDBK-envelope");
  assert.ok(!JSON.stringify(record).includes(hex(seen[0].copy)));
});

test("refuses bad tokens and bodies; custody failure wipes and answers 503", { skip }, async () => {
  const seen = [];
  const deps = { serviceToken: token, generate: () => generateDeviceKeys(module), wrapper: wrapper(seen) };
  assert.equal((await generateServiceDevice(post({ collection }, "Bearer wrong"), deps)).status, 401);
  assert.equal((await generateServiceDevice(post({ collection }), { ...deps, serviceToken: "short" })).status, 401);
  for (const body of ["{", { collection: "nope" }, { collection, extra: 1 }, { collection: collection.toUpperCase() }, "x".repeat(2000)]) {
    assert.equal((await generateServiceDevice(post(body), deps)).status, 400, String(body).slice(0, 40));
  }
  assert.equal(seen.length, 0);
  let handed;
  const failing = { async wrapDeviceKeys(input) { handed = input.secret; throw new Error("kms down"); } };
  const response = await generateServiceDevice(post({ collection }), { ...deps, wrapper: failing });
  assert.equal(response.status, 503);
  assert.ok(handed.every((b) => b === 0));
  const bad = { async wrapDeviceKeys() { return { envelope: new Uint8Array(0), kmsKeyArn: "arn:x" }; } };
  assert.equal((await generateServiceDevice(post({ collection }), { ...deps, wrapper: bad })).status, 503);
});
