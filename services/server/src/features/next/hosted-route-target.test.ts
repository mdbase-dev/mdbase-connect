import { describe, expect, it } from "vitest";
import { hostedClientOrigin } from "./hosted-route-target.js";
import { parseNextControlPlaneEnv } from "./policy-keys.js";

describe("trusted hosted client destination", () => {
  it("is optional and fails startup on an invalid configured origin", () => {
    const base = { MDBASE_NEXT_CONTROL_PLANE: "1", MDBASE_NEXT_ROOT_PUBLIC_KEY: "00".repeat(32), MDBASE_NEXT_POLICY_SIGNING_KEY: "pem", MDBASE_NEXT_POLICY_KEY_CERT: "{}", MDBASE_NEXT_LOG_SERVICE_URL: "https://log.example", MDBASE_NEXT_LOG_TOKEN_SIGNING_KEY: "pem", MDBASE_NEXT_LOG_TRANSPORT_KEY: "pem" };
    expect(parseNextControlPlaneEnv(base)?.hostedClientUrl).toBeUndefined();
    expect(parseNextControlPlaneEnv({ ...base, MDBASE_NEXT_HOSTED_CLIENT_URL: " https://hosted.example " })?.hostedClientUrl).toBe("wss://hosted.example");
    expect(() => parseNextControlPlaneEnv({ ...base, MDBASE_NEXT_HOSTED_CLIENT_URL: "https://hosted.example/old" })).toThrow(/MDBASE_NEXT_HOSTED_CLIENT_URL/);
  });
  it.each(["https://hosted.example", "wss://hosted.example/"])("normalizes %s to a WSS origin", value => {
    expect(hostedClientOrigin(value)).toBe("wss://hosted.example");
  });
  it.each(["not a URL", "http://hosted.example", "ws://hosted.example", "http://127.0.0.1:8787", "https://user:password@hosted.example", "https://hosted.example/old-prefix", "https://hosted.example/?collection=other", "https://hosted.example/#fragment"])("refuses unsafe/prefixed destination %s", value => {
    expect(() => hostedClientOrigin(value)).toThrow(/MDBASE_NEXT_HOSTED_CLIENT_URL/);
  });
});
