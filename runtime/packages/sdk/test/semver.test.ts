import { expect, it } from "vitest";
import { compareVersions, versionRelation } from "../src/semver.js";

it("orders prereleases by SemVer precedence (rc.18 is newer than rc.12)", () => {
  const order = ["1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta", "1.0.0-beta.2", "1.0.0-beta.11", "1.0.0-rc.1", "1.0.0"];
  for (let i = 0; i < order.length - 1; i++) {
    expect(compareVersions(order[i]!, order[i + 1]!)).toBe(-1);
    expect(compareVersions(order[i + 1]!, order[i]!)).toBe(1);
  }
  expect(compareVersions("0.3.0-rc.18", "0.3.0-rc.12")).toBe(1);
  expect(compareVersions("1.0.0+a", "1.0.0+b")).toBe(0);
  expect(compareVersions("not-a-version", "1.0.0")).toBeNull();
});

it("classifies an installed pack against the app's version by major", () => {
  expect(versionRelation("0.3.0-rc.18", "0.3.0-rc.12")).toBe("installed_newer");
  expect(versionRelation("2.0.0", "1.9.0")).toBe("installed_newer_major");
  expect(versionRelation("1.0.0", "1.1.0")).toBe("installed_older");
  expect(versionRelation("1.1.0", "1.1.0")).toBe("same");
});
