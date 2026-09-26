import { afterEach, expect, it, vi } from "vitest";
import { tokenSupportsDirectAccess } from "./direct-access.js";
import type { StoredToken } from "./internal-types.js";

afterEach(() => vi.unstubAllGlobals());

it.each([
  "chrome-extension://nllgjelcggnmffkfncfgpfhdkellkhdo",
  "moz-extension://2c0d3f4e-5a6b-47c8-9012-3456789abcde"
])("uses the exact extension origin for direct eligibility: %s", (origin) => {
  vi.stubGlobal("location", new URL(`${origin}/capture.html`));
  const token = {
    encryption: {}, grantId: "grant", keyHandle: "key", applicationOrigin: origin
  } as StoredToken;
  expect(tokenSupportsDirectAccess(token, "auto")).toBe(true);
  expect(tokenSupportsDirectAccess({ ...token, applicationOrigin: "null" }, "auto")).toBe(false);
  expect(tokenSupportsDirectAccess({ ...token, applicationOrigin: "chrome-extension://other" }, "auto")).toBe(false);
  expect(tokenSupportsDirectAccess(token, "disabled")).toBe(false);
});
