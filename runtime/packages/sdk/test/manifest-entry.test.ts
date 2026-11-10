// `@mdbase-dev/sdk/manifest` is the build-time validator apps use instead of
// importing @mdbase-dev/connect-protocol directly.
import { expect, it } from "vitest";
import {
  AppManifestValidationError,
  formatManifestValidationIssues,
  MDBASE_TIMER_FIRED_CONTRACT,
  parseAppManifest,
  validateAppManifest,
} from "../src/manifest.js";

const manifest = {
  manifest_version: 1,
  id: "dev.tasknotes.web",
  name: "TaskNotes",
  homepage: "http://127.0.0.1:48218",
  redirect_uris: ["http://127.0.0.1:48218/callback"],
  requirements: {
    access: "full_collection",
    contracts: [],
    capabilities: { contract_version: 2, required: [], optional: [] },
  },
};

it("accepts a valid declaration and applies the loopback opt-in", () => {
  expect(validateAppManifest(manifest, { allowLocal: true })).toEqual({ valid: true, issues: [] });
  expect(parseAppManifest(manifest, { allowLocal: true }).id).toBe("dev.tasknotes.web");
  expect(validateAppManifest(manifest).valid).toBe(false);
});

it("reports and formats issues for an invalid declaration", () => {
  const result = validateAppManifest({ ...manifest, id: "" }, { allowLocal: true });
  expect(result.valid).toBe(false);
  if (result.valid) return;
  expect(formatManifestValidationIssues(result.issues)).toMatch(/id/);
  expect(() => parseAppManifest({ ...manifest, id: "" }, { allowLocal: true })).toThrow(AppManifestValidationError);
});

it("exports the timer-fired event contract", () => {
  expect(MDBASE_TIMER_FIRED_CONTRACT.id).toBe("mdbase.runtime.timer.fired");
});
