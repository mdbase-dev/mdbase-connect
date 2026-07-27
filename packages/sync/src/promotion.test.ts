import { describe, expect, it } from "vitest";
import { trustedVerificationUri } from "./promotion.js";

describe("authority promotion confirmation", () => {
  it("accepts confirmation pages from the configured Connect origin", () => {
    expect(
      trustedVerificationUri(
        "https://connect.example",
        "https://connect.example/transfer/123?source=desktop"
      )
    ).toBe("https://connect.example/transfer/123?source=desktop");
  });

  it("rejects a confirmation page from another origin", () => {
    expect(() =>
      trustedVerificationUri(
        "https://connect.example",
        "https://accounts.example/transfer/123"
      )
    ).toThrow("untrusted confirmation address");
  });
});
