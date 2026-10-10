import { describe, expect, it } from "vitest";
import { collectionDisplayName } from "../src/app-host/collection-display-name.js";

describe("cleartext collection display name", () => {
  it.each(["\tName", "Name\n", "Name\u007f", "Name\u0085", "Name\u2028", "Name\u2029", "\ud800Name", "Name\udc00", "\ud800", "\ud800\ud800"])("rejects raw controls or malformed Unicode before trim %j", value => {
    expect(() => collectionDisplayName(value)).toThrow("invalid collection display name");
  });
  it.each([undefined, null, 1, {}, "", "   ", "x".repeat(201), "😀".repeat(101)])("rejects invalid/beyond UTF-16 limit %j", value => {
    expect(() => collectionDisplayName(value)).toThrow("invalid collection display name");
  });
  it("trims ordinary whitespace without Unicode/case/path normalization", () => {
    expect(collectionDisplayName("  Research  ")).toBe("Research");
    expect(collectionDisplayName("\u00a0Research\u00a0")).toBe("Research");
    expect(collectionDisplayName("e\u0301")).toBe("e\u0301");
    expect(collectionDisplayName("../Research")).toBe("../Research");
    expect(collectionDisplayName("😀".repeat(100))).toHaveLength(200);
  });
});
