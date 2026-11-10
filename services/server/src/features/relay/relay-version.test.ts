import { describe, expect, it } from "vitest";
import { connectorVersionAtLeast } from "./relay.js";

describe("connectorVersionAtLeast", () => {
  it.each([
    ["0.1.0-beta.31", true],
    ["0.1.0-beta.31.1", true],
    ["0.1.0-beta.32", true],
    ["0.1.0-beta.33", true],
    ["0.1.0", true],
    ["0.1.0-beta.30", false],
    ["0.1.0-beta", false],
    ["0.0.9", false],
    ["not-semver", false]
  ])("compares %s with the beta.31 floor", (actual, expected) => {
    expect(connectorVersionAtLeast(actual, "0.1.0-beta.31")).toBe(expected);
  });

  it("orders numeric prerelease identifiers below non-numeric identifiers", () => {
    expect(connectorVersionAtLeast("1.0.0-1", "1.0.0-alpha")).toBe(false);
    expect(connectorVersionAtLeast("1.0.0-alpha", "1.0.0-1")).toBe(true);
  });
});
