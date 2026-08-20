import { describe, expect, it, vi } from "vitest";
import type { EmailTransport } from "./email.js";
import {
  renderPublicSignupVerificationEmail,
  sendPublicSignupVerificationEmail
} from "./public-signup-email.js";

const verification = {
  challengeId: "3e74e919-fc87-4e90-ad93-05d40464ecac",
  to: "person@example.com",
  verificationUrl:
    "https://connect.mdbase.dev/signup#verification=vfy_abcdefghijklmnopqrstuvwxyz0123456789ABCDE",
  expiresAt: new Date("2026-08-21T02:30:00.000Z")
};

describe("public signup verification email", () => {
  it("keeps the one-time token in a fragment-only account setup link", () => {
    const rendered = renderPublicSignupVerificationEmail(verification);
    expect(rendered.subject).toBe("Verify your email for mdbase connect");
    expect(rendered.text).toContain(verification.verificationUrl);
    expect(rendered.html).toContain(verification.verificationUrl);
    expect(rendered.html).not.toContain("<script");
  });

  it("rejects links that could disclose the token to another request target", () => {
    expect(() => renderPublicSignupVerificationEmail({
      ...verification,
      verificationUrl:
        "http://connect.example/signup#verification=vfy_abcdefghijklmnopqrstuvwxyz0123456789ABCDE"
    })).toThrow(/URL is invalid/u);
    expect(() => renderPublicSignupVerificationEmail({
      ...verification,
      verificationUrl:
        "https://connect.example/signup?verification=vfy_abcdefghijklmnopqrstuvwxyz0123456789ABCDE"
    })).toThrow(/URL is invalid/u);
    expect(() => renderPublicSignupVerificationEmail({
      ...verification,
      verificationUrl:
        "https://connect.example/login#verification=vfy_abcdefghijklmnopqrstuvwxyz0123456789ABCDE"
    })).toThrow(/URL is invalid/u);
  });

  it("uses the challenge identity as the provider idempotency key", async () => {
    const send = vi.fn(async () => ({ provider: "test", messageId: "message-1" }));
    const transport: EmailTransport = { send };
    await sendPublicSignupVerificationEmail(transport, verification);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ to: verification.to }),
      `public-signup/${verification.challengeId}`
    );
  });
});
