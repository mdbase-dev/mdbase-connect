import { describe, expect, it } from "vitest";
import { isNativeRedirectUri, isPrivateAddress } from "./manifest.js";

describe("manifest network boundary", () => {
  it.each([
    "10.0.0.1",
    "100.64.0.1",
    "100.127.255.254",
    "127.0.0.1",
    "169.254.1.1",
    "172.31.0.1",
    "192.168.1.1",
    "198.18.0.1",
    "::1",
    "::ffff:127.0.0.1",
    "fd00::1",
    "fe80::1"
  ])("rejects non-public address %s", (address) => {
    expect(isPrivateAddress(address)).toBe(true);
  });

  it.each(["1.1.1.1", "8.8.8.8", "2606:4700:4700::1111"])(
    "allows public address %s",
    (address) => expect(isPrivateAddress(address)).toBe(false)
  );
});

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
