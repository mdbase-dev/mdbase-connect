import { describe, expect, it, vi } from "vitest";
import type { EmailTransport } from "./email.js";
import {
  renderInvitationEmail,
  sendInvitationEmail
} from "./invitation-email.js";

const invitation = {
  invitationId: "3e74e919-fc87-4e90-ad93-05d40464ecac",
  to: "person@example.com",
  invitationUrl:
    "https://connect.mdbase.dev/signup#invitation=inv_abcdefghijklmnopqrstuvwxyz0123456789ABCDE",
  expiresAt: new Date("2026-08-04T02:30:00.000Z")
};

describe("invitation email", () => {
  it("renders restrained text and HTML versions with the same account action", () => {
    const rendered = renderInvitationEmail(invitation);
    expect(rendered.subject).toBe("Your mdbase connect invitation");
    expect(rendered.text).toContain(invitation.to);
    expect(rendered.text).toContain(invitation.invitationUrl);
    expect(rendered.text).toContain("one-time invitation");
    expect(rendered.html).toContain("Create your account");
    expect(rendered.html).toContain(invitation.invitationUrl);
    expect(rendered.html).not.toContain("<script");
  });

  it("escapes recipient presentation and rejects unsafe invitation links", () => {
    const rendered = renderInvitationEmail({
      ...invitation,
      to: `person@example.com"><img src=x onerror=alert(1)>`
    });
    expect(rendered.html).not.toContain("<img");
    expect(rendered.html).toContain("&quot;&gt;&lt;img");
    expect(() => renderInvitationEmail({
      ...invitation,
      invitationUrl:
        "http://connect.example/signup#invitation=inv_abcdefghijklmnopqrstuvwxyz"
    })).toThrow(/URL is invalid/);
  });

  it("uses the invitation identity as the provider idempotency key", async () => {
    const send = vi.fn(async () => ({
      provider: "test",
      messageId: "message-1"
    }));
    const transport: EmailTransport = { send };
    await expect(sendInvitationEmail(transport, invitation)).resolves.toEqual({
      provider: "test",
      messageId: "message-1"
    });
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: invitation.to,
        subject: "Your mdbase connect invitation"
      }),
      `invitation/${invitation.invitationId}`
    );
  });
});
