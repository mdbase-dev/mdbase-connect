import { describe, expect, it, vi } from "vitest";
import type { EmailTransport } from "./email.js";
import {
  renderPasswordResetEmail,
  sendPasswordResetEmail
} from "./password-reset-email.js";

const reset = {
  challengeId: "3e74e919-fc87-4e90-ad93-05d40464ecac",
  to: "person@example.com",
  resetUrl:
    "https://connect.mdbase.dev/reset-password#reset=rst_abcdefghijklmnopqrstuvwxyz0123456789ABCDE",
  expiresAt: new Date("2026-08-04T02:30:00.000Z")
};

describe("password reset email", () => {
  it("renders matching text and HTML actions without exposing the token elsewhere", () => {
    const rendered = renderPasswordResetEmail(reset);
    expect(rendered.subject).toBe("Reset your mdbase connect password");
    expect(rendered.text).toContain(reset.resetUrl);
    expect(rendered.text).toContain("one-time link");
    expect(rendered.html).toContain("Reset password");
    expect(rendered.html).toContain(reset.resetUrl);
    expect(rendered.html).toContain("other browser sessions");
    expect(rendered.html).not.toContain("<script");
  });

  it("rejects reset links that could disclose a token to another origin or request target", () => {
    expect(() => renderPasswordResetEmail({
      ...reset,
      resetUrl:
        "http://connect.example/reset-password#reset=rst_abcdefghijklmnopqrstuvwxyz"
    })).toThrow(/URL is invalid/);
    expect(() => renderPasswordResetEmail({
      ...reset,
      resetUrl:
        "https://connect.example/reset-password?reset=rst_abcdefghijklmnopqrstuvwxyz"
    })).toThrow(/URL is invalid/);
    expect(() => renderPasswordResetEmail({
      ...reset,
      resetUrl:
        "https://other.example/reset-password#token=rst_abcdefghijklmnopqrstuvwxyz"
    })).toThrow(/URL is invalid/);
  });

  it("uses the challenge identity as the provider idempotency key", async () => {
    const send = vi.fn(async () => ({
      provider: "test",
      messageId: "message-1"
    }));
    const transport: EmailTransport = { send };
    await expect(sendPasswordResetEmail(transport, reset)).resolves.toEqual({
      provider: "test",
      messageId: "message-1"
    });
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: reset.to,
        subject: "Reset your mdbase connect password"
      }),
      `password-reset/${reset.challengeId}`
    );
  });
});
