import { describe, expect, it } from "vitest";
import { isNativeRedirectUri } from "./manifest.js";

describe("native manifest callbacks", () => {
  it("accepts a reverse-domain private-use application scheme", () => {
    expect(isNativeRedirectUri(
      new URL("dev.tasknotes.app://auth/mdbase/callback"),
      "tasknotes.dev"
    )).toBe(true);
  });

  it("binds the private-use scheme to the manifest publisher", () => {
    expect(isNativeRedirectUri(
      new URL("com.example.app://auth/mdbase/callback"),
      "tasknotes.dev"
    )).toBe(false);
  });

  it.each([
    "tasknotes://auth/callback",
    "javascript://auth/callback",
    "dev.tasknotes.app://user:secret@auth/callback",
    "dev.tasknotes.app://auth/callback#fragment"
  ])("rejects an unsafe native callback %s", (value) => {
    expect(isNativeRedirectUri(new URL(value))).toBe(false);
  });
});
