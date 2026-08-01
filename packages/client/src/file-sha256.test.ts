import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { IncrementalSha256 } from "./file-sha256.js";

describe("IncrementalSha256", () => {
  it.each([
    ["", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
    ["abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
    ["The quick brown fox jumps over the lazy dog", "d7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592"]
  ])("matches the SHA-256 vector for %j", (input, expected) => {
    expect(new IncrementalSha256().update(new TextEncoder().encode(input)).digestHex())
      .toBe(expected);
  });

  it("is independent of arbitrary streaming chunk boundaries", () => {
    const input = Uint8Array.from({ length: 131_137 }, (_, index) => (index * 29 + 17) % 256);
    const hash = new IncrementalSha256();
    let offset = 0;
    for (const size of [1, 63, 64, 65, 4_097, 9, 65_537, 3, 60_000]) {
      hash.update(input.subarray(offset, Math.min(input.length, offset + size)));
      offset += size;
      if (offset >= input.length) break;
    }
    hash.update(input.subarray(Math.min(offset, input.length)));
    expect(hash.digestHex()).toBe(createHash("sha256").update(input).digest("hex"));
  });
});
