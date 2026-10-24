import { describe, expect, it } from "vitest";
import { collectionDisplayName } from "../src/app-host/collection-display-name.js";

describe("cleartext collection display name", () => {
  it.each(["\ud800Name", "Name\udc00"])("rejects raw controls or malformed Unicode before trim %j", value => {
    expect(() => collectionDisplayName(value)).toThrow("invalid collection display name");
  });
  it.each(["x".repeat(201)])("rejects invalid/beyond UTF-16 limit %j", value => {
    expect(() => collectionDisplayName(value)).toThrow("invalid collection display name");
  });
});
