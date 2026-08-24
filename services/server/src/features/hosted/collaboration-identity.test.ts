import { describe, expect, test } from "vitest";

import {
  collaborationPresentationIdentity,
  deriveAwarenessColor,
  GENERIC_AWARENESS_IDENTITY,
  sanitizeAwarenessDisplayName
} from "./collaboration-identity.js";

const COLLECTION = "018f0000-0000-7000-8000-000000000001";
const USER_A = "018f0000-0000-7000-8000-00000000000a";
const USER_B = "018f0000-0000-7000-8000-00000000000b";

describe("awareness color derivation", () => {
  test("is deterministic and domain separated", () => {
    expect(deriveAwarenessColor(COLLECTION, USER_A)).toBe(
      deriveAwarenessColor(COLLECTION, USER_A)
    );
    // Different users or collections may map to different colors; the exact
    // pairings are pinned below to catch accidental algorithm changes.
    expect(deriveAwarenessColor(COLLECTION, USER_A)).toBe("teal");
    expect(deriveAwarenessColor(COLLECTION, USER_B)).toBe("orange");
    expect(deriveAwarenessColor("018f0000-0000-7000-8000-000000000002", USER_A))
      .toBe("violet");
  });

  test("always lands on the fixed palette", () => {
    const palette = new Set([
      "blue", "teal", "green", "amber",
      "orange", "rose", "violet", "slate"
    ]);
    for (let index = 0; index < 64; index += 1) {
      const collection = crypto.randomUUID();
      const user = crypto.randomUUID();
      expect(palette.has(deriveAwarenessColor(collection, user))).toBe(true);
    }
  });
});

describe("display name sanitization", () => {
  test("accepts bounded NFC names and trims them", () => {
    expect(sanitizeAwarenessDisplayName("Ada Lovelace")).toBe("Ada Lovelace");
    expect(sanitizeAwarenessDisplayName("  Grace  ")).toBe("Grace");
    expect(sanitizeAwarenessDisplayName("\u4e3b\u7d16".repeat(40))).toBe(
      "\u4e3b\u7d16".repeat(40)
    );
  });

  test("normalizes to NFC and rejects control characters and bidi overrides", () => {
    expect(sanitizeAwarenessDisplayName("a\u0007b")).toBeNull();
    expect(sanitizeAwarenessDisplayName("a\u202Eb")).toBeNull();
    expect(sanitizeAwarenessDisplayName("a\u2066b")).toBeNull();
    // Decomposed input is normalized to NFC rather than rejected.
    expect(sanitizeAwarenessDisplayName("e\u0301clair")).toBe("\u00e9clair");
    expect(sanitizeAwarenessDisplayName("   ")).toBeNull();
    expect(sanitizeAwarenessDisplayName(null)).toBeNull();
    expect(sanitizeAwarenessDisplayName(undefined)).toBeNull();
  });

  test("rejects names beyond the shared budgets", () => {
    expect(sanitizeAwarenessDisplayName("x".repeat(101))).toBeNull();
    expect(sanitizeAwarenessDisplayName("\u4e3b".repeat(134))).toBeNull();
    expect(sanitizeAwarenessDisplayName("x".repeat(100))).toBe("x".repeat(100));
  });
});

describe("collaboration presentation identity", () => {
  test("uses users.name and never the email or any identifier", () => {
    const identity = collaborationPresentationIdentity(
      { id: USER_A, name: "Ada" },
      COLLECTION
    );
    expect(identity).toEqual({ name: "Ada", color: "teal" });
  });

  test("falls back to a generic identity for unsafe stored names", () => {
    for (const name of [null, undefined, "", "a\u202Eb", "x".repeat(200)]) {
      expect(collaborationPresentationIdentity({ id: USER_A, name }, COLLECTION)).toEqual({
        ...GENERIC_AWARENESS_IDENTITY
      });
    }
  });
});
