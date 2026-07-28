import { describe, expect, it } from "vitest";
import {
  EMAIL_NORMALIZATION_VERSION,
  InvalidEmailAddressError,
  normalizeEmailAddress
} from "./email-identity.js";

describe("email identity normalization", () => {
  it("uses a versioned, stable lower-case key", () => {
    expect(EMAIL_NORMALIZATION_VERSION).toBe(1);
    expect(normalizeEmailAddress("  Callum@MDBASE.dev ")).toBe("callum@mdbase.dev");
  });

  it("canonicalizes international domain names without provider-specific aliases", () => {
    expect(normalizeEmailAddress("Person@BÜCHER.example")).toBe(
      "person@xn--bcher-kva.example"
    );
    expect(normalizeEmailAddress("person+beta@example.com")).toBe(
      "person+beta@example.com"
    );
    expect(normalizeEmailAddress("first.last@gmail.com")).not.toBe(
      normalizeEmailAddress("firstlast@gmail.com")
    );
  });

  it("rejects malformed or unbounded identity keys", () => {
    for (const value of [
      "missing-at.example",
      "@example.com",
      "person@",
      "two@signs@example.com",
      "person @example.com",
      `${"a".repeat(310)}@example.com`
    ]) {
      expect(() => normalizeEmailAddress(value)).toThrow(InvalidEmailAddressError);
    }
  });
});
