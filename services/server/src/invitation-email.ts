import type {
  EmailDelivery,
  EmailTransport,
  TransactionalEmail
} from "./email.js";

export interface InvitationEmailInput {
  invitationId: string;
  to: string;
  invitationUrl: string;
  expiresAt: Date;
}

export function renderInvitationEmail(
  input: Omit<InvitationEmailInput, "invitationId">
): TransactionalEmail {
  const invitationUrl = safeInvitationUrl(input.invitationUrl);
  const expiry = new Intl.DateTimeFormat("en-AU", {
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
    timeZoneName: "short"
  }).format(input.expiresAt);
  const escapedUrl = escapeHtml(invitationUrl);
  const escapedEmail = escapeHtml(input.to);
  const escapedExpiry = escapeHtml(expiry);
  return {
    to: input.to,
    subject: "Your mdbase connect invitation",
    text: [
      "mdbase connect",
      "",
      "You’re invited to the private preview.",
      "",
      `Create the account for ${input.to}:`,
      invitationUrl,
      "",
      `This one-time invitation expires ${expiry}.`,
      "",
      "If you weren’t expecting this invitation, you can ignore this email.",
      "",
      "mdbase connect gives applications access to the Markdown collections you choose."
    ].join("\n"),
    html: `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Your mdbase connect invitation</title>
</head>
<body style="margin:0;background:#f8f9fa;color:#222831;font-family:Arial,sans-serif">
  <div style="display:none;max-height:0;overflow:hidden">Create your invited mdbase connect account.</div>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f8f9fa">
    <tr>
      <td align="center" style="padding:40px 20px">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;background:#ffffff;border:1px solid #dfe3e8">
          <tr>
            <td style="padding:30px 34px 12px;color:#59636f;font-family:monospace;font-size:13px">mdbase&nbsp;&nbsp;connect</td>
          </tr>
          <tr>
            <td style="padding:12px 34px 34px">
              <h1 style="margin:0 0 16px;font-size:27px;line-height:1.2;color:#222831">You’re invited.</h1>
              <p style="margin:0 0 20px;font-size:16px;line-height:1.55;color:#46515d">Create the private-preview account for <strong>${escapedEmail}</strong>. Your email is verified by this one-time link.</p>
              <p style="margin:0 0 24px">
                <a href="${escapedUrl}" style="display:inline-block;padding:11px 16px;border:1px solid #8f99a5;border-radius:4px;color:#1d5f87;font-family:monospace;font-size:13px;font-weight:bold;text-decoration:none">Create your account</a>
              </p>
              <p style="margin:0 0 9px;font-size:13px;line-height:1.5;color:#66717c">This invitation expires ${escapedExpiry}.</p>
              <p style="margin:0;font-size:13px;line-height:1.5;color:#66717c">If you weren’t expecting it, you can ignore this email.</p>
            </td>
          </tr>
          <tr>
            <td style="padding:22px 34px;border-top:1px solid #e5e8ec;font-size:12px;line-height:1.5;color:#7a838d">mdbase connect gives applications access to the Markdown collections you choose.</td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`
  };
}

export async function sendInvitationEmail(
  transport: EmailTransport,
  input: InvitationEmailInput
): Promise<EmailDelivery> {
  return transport.send(
    renderInvitationEmail(input),
    `invitation/${input.invitationId}`
  );
}

function safeInvitationUrl(value: string): string {
  const url = new URL(value);
  const fragment = new URLSearchParams(url.hash.slice(1));
  const token = fragment.get("invitation") ?? "";
  if (
    url.username
    || url.password
    || url.pathname !== "/signup"
    || url.search
    || [...fragment.keys()].some((key) => key !== "invitation")
    || !/^inv_[A-Za-z0-9_-]{32,196}$/u.test(token)
    || (url.protocol !== "https:" && !isLoopback(url.hostname))
  ) {
    throw new TypeError("Invitation email URL is invalid.");
  }
  return url.href;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function isLoopback(hostname: string): boolean {
  return ["localhost", "127.0.0.1", "[::1]", "::1"].includes(hostname);
}
