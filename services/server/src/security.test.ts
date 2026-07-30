import { createECDH } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  canonicalUserCode,
  isP256PublicKey,
  safeEqual,
  tokenHash
} from "./security.js";

describe("security primitives", () => {
  it("accepts only uncompressed P-256 public keys", () => {
    const key = createECDH("prime256v1");
    key.generateKeys();

    expect(isP256PublicKey(key.getPublicKey().toString("base64url"))).toBe(true);
    expect(isP256PublicKey(key.getPublicKey("base64url", "compressed"))).toBe(false);
    expect(isP256PublicKey("not+p256")).toBe(false);
  });

  it("compares equal values without accepting different lengths", () => {
    expect(safeEqual("state-value", "state-value")).toBe(true);
    expect(safeEqual("state-value", "state-other")).toBe(false);
    expect(safeEqual("short", "longer")).toBe(false);
  });

  it("normalizes human-entered user codes", () => {
    expect(canonicalUserCode("abcd-2345")).toBe("ABCD2345");
  });

  it("hashes tokens deterministically without returning the token", () => {
    const digest = tokenHash("secret-token");
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
    expect(digest).toBe(tokenHash("secret-token"));
    expect(digest).not.toContain("secret-token");
  });
});
