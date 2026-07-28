import type {
  EmailDelivery,
  EmailTransport,
  TransactionalEmail
} from "./email.js";

export interface PasswordResetEmailInput {
  challengeId: string;
  to: string;
  resetUrl: string;
  expiresAt: Date;
}

export function renderPasswordResetEmail(
  input: Omit<PasswordResetEmailInput, "challengeId">
): TransactionalEmail {
  const resetUrl = safePasswordResetUrl(input.resetUrl);
  const expiry = new Intl.DateTimeFormat("en-AU", {
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
    timeZoneName: "short"
  }).format(input.expiresAt);
  const escapedUrl = escapeHtml(resetUrl);
  const escapedExpiry = escapeHtml(expiry);
  return {
    to: input.to,
    subject: "Reset your mdbase connect password",
    text: [
      "mdbase connect",
      "",
      "A password reset was requested for your account.",
      "",
      "Choose a new password:",
      resetUrl,
      "",
      `This one-time link expires ${expiry}.`,
      "",
      "If you did not request this, you can ignore the email. Your password has not changed."
    ].join("\n"),
    html: `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Reset your mdbase connect password</title>
</head>
<body style="margin:0;background:#f8f9fa;color:#222831;font-family:Arial,sans-serif">
  <div style="display:none;max-height:0;overflow:hidden">Choose a new password for mdbase connect.</div>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f8f9fa">
    <tr>
      <td align="center" style="padding:40px 20px">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;background:#ffffff;border:1px solid #dfe3e8">
          <tr>
            <td style="padding:30px 34px 12px;color:#59636f;font-family:monospace;font-size:13px">mdbase&nbsp;&nbsp;connect</td>
          </tr>
          <tr>
            <td style="padding:12px 34px 34px">
              <h1 style="margin:0 0 16px;font-size:27px;line-height:1.2;color:#222831">Choose a new password.</h1>
              <p style="margin:0 0 20px;font-size:16px;line-height:1.55;color:#46515d">Use this one-time link to replace your mdbase connect password. Completing the reset signs out your other browser sessions.</p>
              <p style="margin:0 0 24px">
                <a href="${escapedUrl}" style="display:inline-block;padding:11px 16px;border:1px solid #8f99a5;border-radius:4px;color:#1d5f87;font-family:monospace;font-size:13px;font-weight:bold;text-decoration:none">Reset password</a>
              </p>
              <p style="margin:0 0 9px;font-size:13px;line-height:1.5;color:#66717c">This link expires ${escapedExpiry}.</p>
              <p style="margin:0;font-size:13px;line-height:1.5;color:#66717c">If you did not request it, you can ignore this email. Your password has not changed.</p>
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

export async function sendPasswordResetEmail(
  transport: EmailTransport,
  input: PasswordResetEmailInput
): Promise<EmailDelivery> {
  return transport.send(
    renderPasswordResetEmail(input),
    `password-reset/${input.challengeId}`
  );
}

function safePasswordResetUrl(value: string): string {
  const url = new URL(value);
  const fragment = new URLSearchParams(url.hash.slice(1));
  const token = fragment.get("reset") ?? "";
  if (
    url.username
    || url.password
    || url.pathname !== "/reset-password"
    || url.search
    || [...fragment.keys()].some((key) => key !== "reset")
    || !/^rst_[A-Za-z0-9_-]{32,196}$/u.test(token)
    || (url.protocol !== "https:" && !isLoopback(url.hostname))
  ) {
    throw new TypeError("Password reset email URL is invalid.");
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
