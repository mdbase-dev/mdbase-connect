import { describe, expect, it } from "vitest";
import { collectionDisplayName } from "./collection-display-name.js";

describe("collection display names", () => {
  it("trims edges without changing case, Unicode normalization or path-like text", () => {
    for (const name of ["Work", "e\u0301", "é", "日本語", "📚", "a/b"]) {
      expect(collectionDisplayName(`  ${name}  `)).toBe(name);
    }
  });
  it("uses the existing 200 UTF-16-unit limit", () => {
    expect(collectionDisplayName("x".repeat(200))).toHaveLength(200);
    expect(collectionDisplayName("📚".repeat(100))).toHaveLength(200);
    for (const name of ["x".repeat(201), "📚".repeat(101)]) expect(() => collectionDisplayName(name)).toThrow("invalid_display_name");
  });
  it.each(["", "  ", "\ud800", "\udc00", "a\ud800b", "\nWork", "Work\t", "a\u0000b", "a\u007fb", "a\u0085b", "a\u2028b", "a\u2029b"])("refuses blank, malformed or control-bearing input #%#", name => {
    expect(() => collectionDisplayName(name)).toThrow("invalid_display_name");
  });
});
