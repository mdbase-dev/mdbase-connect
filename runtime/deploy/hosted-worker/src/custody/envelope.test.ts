import assert from "node:assert/strict";
import test from "node:test";
import { configuredEnvelope, encodeEnvelope, parseEnvelope } from "./envelope.ts";

// Non-secret, deliberately non-deployable wire fixtures.
test("MDBK matches native big-endian v1 format", () => {
  const encoded = encodeEnvelope("key", Uint8Array.of(7, 8));
  assert.equal(Buffer.from(encoded).toString("hex"), "4d44424b01010003000000026b65790708");
  assert.deepEqual(parseEnvelope(encoded), { keyRef: "key", ciphertext: Uint8Array.of(7, 8) });
});

test("count and byte limits permit only exact bounded envelope", () => {
  const encoded = encodeEnvelope("k".repeat(2048), new Uint8Array(8192));
  assert.equal(parseEnvelope(encoded).ciphertext.length, 8192);
  for (const key of ["", "k".repeat(2049), "a b", "a\"b", "a\\b", "é", "a\n"]) {
    assert.throws(() => encodeEnvelope(key, Uint8Array.of(1)), /custody_envelope_invalid/);
  }
  assert.throws(() => encodeEnvelope("key", new Uint8Array(0)));
  assert.throws(() => encodeEnvelope("key", new Uint8Array(8193)));
});

test("reject wrong magic, version and wrapping kind", () => {
  for (const position of [0, 1, 2, 3, 4, 5]) {
    const input = encodeEnvelope("key", Uint8Array.of(1));
    input[position] ^= 0xff;
    assert.throws(() => parseEnvelope(input), /custody_envelope_invalid/);
  }
});

test("reject truncated, trailing, oversized and false-length inputs", () => {
  const valid = encodeEnvelope("key", Uint8Array.of(1));
  for (let length = 0; length < valid.length; length++) {
    assert.throws(() => parseEnvelope(valid.slice(0, length)));
  }
  assert.throws(() => parseEnvelope(Uint8Array.from([...valid, 0])));
  assert.throws(() => parseEnvelope(new Uint8Array(10253)));
  for (const [offset, width, value] of [[6, 2, 0], [6, 2, 2049], [8, 4, 0], [8, 4, 8193], [8, 4, 0xffffffff]]) {
    const input = valid.slice();
    const view = new DataView(input.buffer);
    if (width === 2) view.setUint16(offset, value, false);
    else view.setUint32(offset, value, false);
    assert.throws(() => parseEnvelope(input));
  }
});

test("reject invalid UTF8 and disallowed reference characters after parsing", () => {
  for (const byte of [0xff, 0x00, 0x20, 0x22, 0x5c, 0x7f]) {
    const input = encodeEnvelope("key", Uint8Array.of(1));
    input[12] = byte;
    assert.throws(() => parseEnvelope(input));
  }
});

test("non-zero offsets parse; returned ciphertext cannot be changed by caller", () => {
  const encoded = encodeEnvelope("key", Uint8Array.of(7, 8));
  const backing = new Uint8Array(encoded.length + 9);
  backing.set(encoded, 5);
  const input = backing.subarray(5, 5 + encoded.length);
  const parsed = parseEnvelope(input);
  input.fill(0);
  assert.equal(parsed.keyRef, "key");
  assert.deepEqual(parsed.ciphertext, Uint8Array.of(7, 8));
});

test("configured key selection rejects foreign ARN without fallback", () => {
  const encoded = encodeEnvelope("configured", Uint8Array.of(1));
  assert.throws(() => configuredEnvelope(encoded, []), /custody_key_not_configured/);
  assert.throws(() => configuredEnvelope(encoded, ["other"]), /custody_key_not_configured/);
  assert.deepEqual(configuredEnvelope(encoded, ["old", "configured"]), {
    keyArn: "configured", ciphertext: Uint8Array.of(1),
  });
});
