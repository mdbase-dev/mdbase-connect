import { describe, expect, it } from "vitest";
import { gzipSync } from "node:zlib";
import { Base64Error, decodeAsset, decodeBase64, encodeBase64 } from "../src/embed/base64.js";

function rand(n: number, seed: number): Uint8Array {
  const out = new Uint8Array(n);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < n; i++) {
    x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0;
    out[i] = x & 0xff;
  }
  return out;
}

describe("base64", () => {
  it("round-trips every length 0..300 against Buffer", () => {
    for (let n = 0; n <= 300; n++) {
      const b = rand(n, n + 7);
      const ref = Buffer.from(b).toString("base64");
      expect(encodeBase64(b)).toBe(ref);
      expect(Buffer.from(decodeBase64(ref))).toEqual(Buffer.from(b));
      expect(Buffer.from(decodeBase64(ref.replace(/=+$/, "")))).toEqual(Buffer.from(b));
    }
  });
  it("decodes large input", () => {
    const b = rand(1 << 20, 99);
    expect(Buffer.from(decodeBase64(Buffer.from(b).toString("base64"))).equals(Buffer.from(b))).toBe(true);
  });
  it("accepts URL-safe alphabet", () => {
    const b = rand(64, 3);
    expect(Buffer.from(decodeBase64(Buffer.from(b).toString("base64url")))).toEqual(Buffer.from(b));
  });
  it("rejects garbage", () => {
    expect(() => decodeBase64("ab$d")).toThrow(Base64Error);
    expect(() => decodeBase64("abcde")).toThrow(Base64Error);
    expect(() => decodeBase64("abŁd")).toThrow(Base64Error);
    expect(() => decodeBase64("ab===")).toThrow(Base64Error);
  });
  it("decodes a gzipped embedded asset and checks its length", async () => {
    const raw = rand(5000, 1);
    const b64 = gzipSync(raw).toString("base64");
    expect(Buffer.from(await decodeAsset({ b64, gzip: true, rawLength: raw.length }))).toEqual(Buffer.from(raw));
    await expect(decodeAsset({ b64, gzip: true, rawLength: 1 })).rejects.toThrow(/length/);
  });
});
