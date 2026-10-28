import { test } from "node:test";
import assert from "node:assert/strict";
import { modeServiceRequest, modeReady, modeAck } from "../src/collection-mode.ts";

// Parser/output ports only: not native readiness, custody or erasure proof.
const token = "synthetic-mode-service-token".repeat(2);
const input = { collection: "0e0e0e0e-0e0e-4e0e-8e0e-0e0e0e0e0e0e", device: "0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f", epoch: "18446744073709551615", challenge: "11".repeat(32) };
const request = value => new Request("https://hosted.test/internal/v1/collection-mode/ready", { method: "POST", headers: { authorization: `Bearer ${token}` }, body: typeof value === "string" ? value : JSON.stringify(value) });

test("mode authentication precedes body consumption", async () => {
  let reads = 0;
  const body = new ReadableStream({ pull() { reads++; } }, { highWaterMark: 0 });
  const r = new Request("https://hosted.test/internal/v1/collection-mode/ready", { method: "POST", body, duplex: "half" });
  assert.equal((await modeServiceRequest(r, token)).status, 401);
  assert.equal(reads, 0);
  assert.equal((await modeServiceRequest(new Request("https://hosted.test/"), token)).status, 405);
});

test("mode body is bounded, exact, canonical and positive-u64", async () => {
  assert.deepEqual(await modeServiceRequest(request(input), token), input);
  for (const value of [" ".repeat(1025), "{", [], null, { ...input, extra: true }, { ...input, device: "00000000-0000-0000-0000-000000000000" }, ...["0", "01", "-1", "18446744073709551616", 1].map(epoch => ({ ...input, epoch })), { ...input, challenge: "zz".repeat(32) }]) {
    assert.equal((await modeServiceRequest(request(value), token)).status, 503);
  }
});

test("native observation must match the exact device and epoch; unsafe numbers are refused", () => {
  const id = Uint8Array.from(Buffer.from(input.device.replaceAll("-", ""), "hex"));
  assert.equal(modeReady([id, BigInt(input.epoch)], input), true);
  for (const value of [null, [], [id, Number(input.epoch)], [id, 1n], [new Uint8Array(16), BigInt(input.epoch)], [id, input.epoch], [id, BigInt(input.epoch), true]]) assert.equal(modeReady(value, input), false);
  assert.equal(modeReady([id, 1], { ...input, epoch: "1" }), true);
});

test("mode ACK only echoes bounded public fields, with no-store", async () => {
  const response = modeAck(input);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { ...input, ready: true });
});
