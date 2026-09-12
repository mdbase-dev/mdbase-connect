import { describe, expect, it } from "vitest";
import {
  applyConnectServerOverride,
  connectServerUrl
} from "./connect-endpoint";

describe("Connect endpoint URLs", () => {
  it("uses the configured environment without a redundant server override", () => {
    const configured = "https://connect.mdbase.dev";
    expect(connectServerUrl("?server=https%3A%2F%2Fconnect.mdbase.dev", configured))
      .toBe(configured);

    const target = applyConnectServerOverride(
      new URL("https://editor.mdbase.dev/"),
      configured,
      configured
    );
    expect(target.href).toBe("https://editor.mdbase.dev/");
  });

  it("preserves a deliberate cross-environment override", () => {
    const target = applyConnectServerOverride(
      new URL("https://editor.mdbase.dev/"),
      "https://connect-staging.mdbase.dev",
      "https://connect.mdbase.dev"
    );
    expect(target.searchParams.get("server"))
      .toBe("https://connect-staging.mdbase.dev");
  });

  it("removes a stale redundant override from callback URLs", () => {
    const target = applyConnectServerOverride(
      new URL("https://editor.mdbase.dev/?server=https%3A%2F%2Fold.example"),
      "https://connect.mdbase.dev",
      "https://connect.mdbase.dev"
    );
    expect(target.href).toBe("https://editor.mdbase.dev/");
  });
});
