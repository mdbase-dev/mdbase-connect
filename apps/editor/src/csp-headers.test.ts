import { describe, expect, it } from "vitest";
import headers from "../public/_headers?raw";

const policy = headers.match(/^\s*Content-Security-Policy:\s*(.+)$/m)?.[1] ?? "";
const connectSrc = policy.split(";").map((directive: string) => directive.trim().split(/\s+/u))
  .find(([name]) => name === "connect-src")?.slice(1) ?? [];

describe("deployed Content-Security-Policy", () => {
  // The SDK Worker receives other apps' and devices' writes over the log's
  // wss: push socket. Chrome does not treat https: or http: as covering wss:,
  // so without it the socket is blocked and remote changes never arrive.
  it("allows the log's push socket", () => {
    expect(connectSrc).toContain("wss:");
  });
});
