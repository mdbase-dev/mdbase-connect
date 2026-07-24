import webPush from "web-push";
import { describe, expect, it } from "vitest";
import { isPublicPushAddress, WebPushTransport } from "./web-push.js";

describe("Web Push transport", () => {
  it("rejects loopback, private, metadata, documentation, and local IPv6 destinations", () => {
    for (const address of [
      "0.0.0.1",
      "10.0.0.1",
      "100.64.0.1",
      "127.0.0.1",
      "169.254.169.254",
      "172.16.0.1",
      "192.168.0.1",
      "198.51.100.1",
      "224.0.0.1"
    ]) {
      expect(isPublicPushAddress(address, 4), address).toBe(false);
    }
    for (const address of ["::", "::1", "fc00::1", "fe80::1", "2001:db8::1"]) {
      expect(isPublicPushAddress(address, 6), address).toBe(false);
    }
    expect(isPublicPushAddress("8.8.8.8", 4)).toBe(true);
    expect(isPublicPushAddress("2606:4700:4700::1111", 6)).toBe(true);
  });

  it("validates VAPID key material when the transport starts", () => {
    const keys = webPush.generateVAPIDKeys();
    expect(() => new WebPushTransport({
      subject: "mailto:ops@example.com",
      publicKey: keys.publicKey,
      privateKey: keys.privateKey
    })).not.toThrow();
    expect(() => new WebPushTransport({
      subject: "mailto:ops@example.com",
      publicKey: "invalid",
      privateKey: "invalid"
    })).toThrow();
  });
});
