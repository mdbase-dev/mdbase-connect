import { describe, expect, it } from "vitest";
import { RequestValidationError } from "../../platform/http-errors.js";
import {
  applicationOriginForDeviceRequest,
  applicationOriginForRedirect,
  normalizedApplicationOrigin
} from "./redirects.js";

describe("application authorization origins", () => {
  it("binds native callbacks to the manifest homepage origin", () => {
    expect(applicationOriginForRedirect(
      "dev.tasknotes.app://auth/mdbase/callback",
      "https://app.tasknotes.dev/"
    )).toBe("https://app.tasknotes.dev");
  });

  it("binds web callbacks to their exact redirect origin", () => {
    expect(applicationOriginForRedirect(
      "https://tasks.example:8443/auth/mdbase/callback",
      "https://homepage.example/"
    )).toBe("https://tasks.example:8443");
  });

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

  it.each(["ftp://example.com", "file:///extension", "data:text/plain,extension", "custom://app"])(
    "does not turn an unsupported device origin into portable authority: %s", (value) => {
      expect(() => applicationOriginForDeviceRequest(value)).toThrow(RequestValidationError);
    }
  );

  it("continues to normalize web origins", () => {
    expect(applicationOriginForDeviceRequest("https://app.example:8443")).toBe(
      "https://app.example:8443"
    );
  });

  it.each([
    "chrome-extension://extension/page.html", "chrome-extension://extension:443",
    "chrome-extension://extension?query", "chrome-extension://extension#fragment",
    "chrome-extension://user@extension", "chrome-extension://EXTENSION",
    "chrome-extension://*.example", "moz-extension://example:443"
  ])("rejects an extension URL that is not an origin: %s", (value) => {
    expect(() => normalizedApplicationOrigin(value)).toThrow("browser extension origin is invalid");
    expect(() => applicationOriginForDeviceRequest(value)).toThrow(RequestValidationError);
  });
});
