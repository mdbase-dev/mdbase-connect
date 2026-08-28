import { describe, expect, it } from "vitest";
import { grantWithCompatibleApplicationOrigin } from "./application-origin.js";

describe("grant account snapshot origin compatibility", () => {
  it("keeps mixed grants while preserving only usable opaque origins", () => {
    const grants = [
      { id: "valid", application_origin: "https://valid.example:8443" },
      { id: "portable", application_origin: "null" },
      { id: "null-origin", application_origin: null },
      { id: "extension", application_origin: "chrome-extension://abcdefghijklmnop" },
      { id: "malformed-string", application_origin: "not an origin" },
      {
        id: "malformed-extension",
        application_origin: "chrome-extension://abcdefghijklmnop/page.html"
      },
      { id: "opaque-url", application_origin: "data:text/plain,not-an-origin" },
      { id: "malformed-value", application_origin: { unexpected: true } }
    ].map(grantWithCompatibleApplicationOrigin);

    expect(grants).toHaveLength(8);
    expect(grants[0]).toEqual({
      id: "valid",
      application_origin: "https://valid.example:8443"
    });
    expect(grants[1]).toEqual({ id: "portable", application_origin: "null" });
    expect(grants.slice(2)).toEqual([
      { id: "null-origin" },
      {
        id: "extension",
        application_origin: "chrome-extension://abcdefghijklmnop"
      },
      { id: "malformed-string" },
      { id: "malformed-extension" },
      { id: "opaque-url" },
      { id: "malformed-value" }
    ]);
  });

  it("normalizes a legacy homepage fallback without turning it into authority", () => {
    expect(grantWithCompatibleApplicationOrigin({
      id: "legacy-homepage",
      application_origin: "https://apps.example/downloads/app"
    })).toEqual({
      id: "legacy-homepage",
      application_origin: "https://apps.example"
    });
  });
});
