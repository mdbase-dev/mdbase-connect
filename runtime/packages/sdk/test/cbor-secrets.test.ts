import { afterEach, describe, expect, it, vi } from "vitest";
import { decode, encodeSecret, Float64, type CborValue } from "../src/cbor.js";

afterEach(() => vi.restoreAllMocks());

describe("secret-bearing CBOR scratch lifetime", () => {
  it("wipes temporary UTF-8 bytes for data keys and text values", () => {
    const temporary: Uint8Array[] = [];
    const original = TextEncoder.prototype.encode;
    vi.spyOn(TextEncoder.prototype, "encode").mockImplementation(function (this: TextEncoder, value) {
      const bytes = original.call(this, value);
      temporary.push(bytes);
      return bytes;
    });
    const input = new Map([["key", "value"]]);
    const output = encodeSecret(input);
    expect(decode(output)).toEqual(input);
    expect(temporary).toHaveLength(2);
    expect(temporary.every((bytes) => bytes.every((byte) => byte === 0))).toBe(true);
    output.fill(0);
  });
  for (const fails of [false, true]) {
    it(`wipes scratch across multiple growth allocations on ${fails ? "failure" : "success"}`, () => {
      const keys = new Uint8Array(32).fill(42);
      const scratch: Uint8Array[] = [];
      const set = Uint8Array.prototype.set;
      vi.spyOn(Uint8Array.prototype, "set").mockImplementation(function (this: Uint8Array, source, offset) {
        scratch.push(this);
        return set.call(this, source, offset);
      });
      const value: CborValue = [keys, new Uint8Array(1024).fill(1), new Uint8Array(4096).fill(2)];
      if (fails) value.push(new Float64(NaN));
      if (fails) expect(() => encodeSecret(value)).toThrow();
      else {
        const output = encodeSecret(value);
        expect((decode(output) as Uint8Array[])[0]).toEqual(keys);
        output.fill(0);
      }
      expect(new Set(scratch.map((b) => b.buffer)).size).toBeGreaterThan(1);
      expect(scratch.every((b) => b.every((byte) => byte === 0))).toBe(true);
      expect(keys.every((b) => b === 42)).toBe(true);
    });
  }
});
