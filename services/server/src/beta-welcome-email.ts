import type { DatabaseQueryable } from "./database-types.js";
import type { TransactionalEmail } from "./email.js";
import {
  scheduleEmail,
  type EmailRenderContext
} from "./scheduled-email.js";

export const BETA_WELCOME_MESSAGE_KIND = "beta_welcome";
export const BETA_WELCOME_TEMPLATE_VERSION = 1;
const BETA_WELCOME_DELAY_MS = 24 * 60 * 60 * 1_000;

const SUBJECT = "A note about mdbase Connect";

export async function scheduleBetaWelcomeEmail(
  db: DatabaseQueryable,
  input: {
    userId: string;
    emailIdentityId: string;
    signedUpAt?: Date;
  }
): Promise<{ id: string; duplicate: boolean }> {
  return scheduleEmail(db, {
    userId: input.userId,
    emailIdentityId: input.emailIdentityId,
    messageKind: BETA_WELCOME_MESSAGE_KIND,
    templateVersion: BETA_WELCOME_TEMPLATE_VERSION,
    category: "onboarding",
    deduplicationKey:
      `${BETA_WELCOME_MESSAGE_KIND}:${input.userId}:v${BETA_WELCOME_TEMPLATE_VERSION}`,
    scheduledFor: new Date(
      (input.signedUpAt ?? new Date()).getTime() + BETA_WELCOME_DELAY_MS
    )
  });
}

export function renderScheduledEmail(
  context: EmailRenderContext
): TransactionalEmail {
  if (
    context.messageKind !== BETA_WELCOME_MESSAGE_KIND
    || context.templateVersion !== BETA_WELCOME_TEMPLATE_VERSION
  ) {
    throw new TypeError("Scheduled email template is unavailable.");
  }
  return renderBetaWelcomeEmail(context);
}

export function renderBetaWelcomeEmail(
  input: Pick<EmailRenderContext, "name" | "email">
): TransactionalEmail {
  const paragraphs = [
    `Hi ${input.name},`,
    "Thanks for signing up for mdbase Connect.",
    "My name is Callum. I've been working on mdbase as a tool for doing more with markdown files, and as you are getting started with mdbase, I want to say a few words about its philosophy, how it works, and some precautions that you might need to take.",
    "I think markdown files are great because they are human readable, work with ordinary text-editing tools, and they remain useful even as the software around them changes or disappears. mdbase Connect is designed to keep these qualities while making it easier to build applications on top of collections of markdown files and providing a secure way to connect to these files over the internet.",
    "A lot of the software that we use, especially SaaS software, puts your data in its own database. This can make it difficult to use elsewhere or leave with the data when the software becomes unsuitable to your needs. The goal of mdbase is to enable users to enjoy good software while maintaining control of their data, with or without mdbase.",
    "There is one important thing to keep in mind, though. By design, an application you connect may be able to read data from a collection. If you give it write access, it may also be able to create, change, move, or delete files in that collection, and, again by design, those changes can be synchronized back to your computer. mdbase checks that each application stays within the permissions you've granted, but you should still only connect applications you trust, especially when they ask for write access.",
    "You can also build applications using the mdbase SDK. This is a way to make your own tools that work with your data online or offline, without giving a third-party application access to it.",
    "Because you joined during the beta, your account has a 1 GB hosted-storage allowance that does not expire when the beta ends. It is shared across your Markdown files and other files. You can create up to 10 hosted collections, connect up to 10 replicas to each collection, store Markdown documents up to 2 MB, and store individual files up to 250 MB. I hope to offer paid plans with more storage later, and you'll be able to add one without losing your beta allowance.",
    "There will probably be some rough edges, so please let me know when something breaks, behaves unexpectedly, or is confusing. You can send an email to support@mdbase.dev or open an issue on GitHub. mdbase is early in its development and so feedback is super-helpful!",
    "Best,\nCallum."
  ];
  return {
    to: input.email,
    subject: SUBJECT,
    text: paragraphs.join("\n\n"),
    html: renderHtml(paragraphs)
  };
}

function renderHtml(paragraphs: string[]): string {
  const body = paragraphs.map((paragraph) => {
    const lines = escapeHtml(paragraph).replaceAll("\n", "<br>");
    return `    <p style="margin:0 0 20px">${lines}</p>`;
  }).join("\n");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${SUBJECT}</title>
</head>
<body style="margin:0;background:#ffffff;color:#222831;font-family:Arial,sans-serif">
  <div style="max-width:640px;margin:0 auto;padding:36px 24px;font-size:16px;line-height:1.6">
${body}
  </div>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
