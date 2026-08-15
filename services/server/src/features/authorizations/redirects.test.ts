import { describe, expect, it } from "vitest";
import {
  applicationOriginForDeviceRequest,
  normalizedApplicationOrigin
} from "./redirects.js";

describe("application authorization origins", () => {
  it("keeps native device authorization on the opaque origin", () => {
    expect(applicationOriginForDeviceRequest(undefined)).toBe("null");
    expect(applicationOriginForDeviceRequest("null")).toBe("null");
  });

  it("preserves browser extension origins instead of collapsing them to null", () => {
    expect(applicationOriginForDeviceRequest(
      "chrome-extension://nllgjelcggnmffkfncfgpfhdkellkhdo"
    )).toBe("chrome-extension://nllgjelcggnmffkfncfgpfhdkellkhdo");
    expect(applicationOriginForDeviceRequest(
      "moz-extension://2c0d3f4e-5a6b-47c8-9012-3456789abcde"
    )).toBe("moz-extension://2c0d3f4e-5a6b-47c8-9012-3456789abcde");
  });

  it("continues to normalize web origins", () => {
    expect(applicationOriginForDeviceRequest("https://app.example:8443")).toBe(
      "https://app.example:8443"
    );
  });

  it("rejects an extension URL that is not an origin", () => {
    expect(() => normalizedApplicationOrigin(
      "chrome-extension://nllgjelcggnmffkfncfgpfhdkellkhdo/page.html"
    )).toThrow("browser extension origin is invalid");
  });
});
