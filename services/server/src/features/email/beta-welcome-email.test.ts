import { describe, expect, it } from "vitest";
import {
  OPEN_BETA_WELCOME_MESSAGE_KIND,
  PLUS_AND_APPS_BETA_MESSAGE_KIND,
  PLUS_AND_APPS_MESSAGE_KIND,
  renderBetaWelcomeEmail,
  renderOpenBetaWelcomeEmail,
  renderScheduledEmail
} from "./beta-welcome-email.js";

const APPROVED_TEXT = `Hi Person Example,

Thanks for signing up for mdbase Connect.

My name is Callum. I've been working on mdbase as a tool for doing more with markdown files, and as you are getting started with mdbase, I want to say a few words about its philosophy and how it works.

I think markdown files are great because they are human readable, work with ordinary text-editing tools, and they remain useful even as the software around them changes or disappears. mdbase Connect is designed to keep these qualities while making it easier to build applications on top of collections of markdown files and providing a secure way to connect to these files over the internet.

A lot of the software that we use, especially SaaS software, puts your data in its own database. This can make it difficult to use elsewhere or to leave with your data when the software no longer suits your needs. The goal of mdbase is to enable users to enjoy good software while maintaining control of their data, with or without mdbase.

You can also build applications using the mdbase SDK. This is a way to make your own tools that work with your data online or offline, without giving a third-party application access to it.

Because you joined during the beta, your account has a 1 GB hosted-storage allowance that does not expire when the beta ends. It is shared across your Markdown files and other files. You can create up to 10 hosted collections, connect up to 10 replicas to each collection, store Markdown documents up to 1 MB, and store individual files up to 250 MB. I hope to offer paid plans with more storage later, and you'll be able to add one without losing your beta allowance.

There will probably be some rough edges, so please let me know when something breaks, behaves unexpectedly, or is confusing. You can send an email to support@mdbase.dev or open an issue on GitHub. mdbase is early in its development and so feedback is super-helpful!

Best,
Callum.`;

describe("Beta welcome email", () => {
  it("renders the approved plain-text copy exactly", () => {
    const message = renderBetaWelcomeEmail({
      name: "Person Example",
      email: "person@example.com",
      unsubscribeUrl: null
    });
    expect(message).toMatchObject({
      to: "person@example.com",
      subject: "Welcome to mdbase Connect",
      text: APPROVED_TEXT
    });
    expect(message.text).toMatch(/^[\x00-\x7f]*$/u);
  });

  it("renders the open Beta collection and replica limits", () => {
    const message = renderOpenBetaWelcomeEmail({
      name: "Person Example",
      email: "person@example.com",
      unsubscribeUrl: null
    });
    expect(message.text).toContain("2 GB retained-file allowance");
    expect(message.text).toContain("up to 10,000 files");
    expect(message.text).toContain("up to 3 hosted collections in total");
    expect(message.text).toContain("including the starter collection");
    expect(message.text).toContain("10 synced folders and 50 application installations");
    expect(renderScheduledEmail({
      userId: "user-1",
      name: "Person Example",
      email: "person@example.com",
      messageKind: OPEN_BETA_WELCOME_MESSAGE_KIND,
      templateVersion: 1,
      unsubscribeUrl: null
    })).toEqual(message);
  });

  it("describes the free plan and storage trial to new signups", () => {
    const message = renderScheduledEmail({
      userId: "user-1",
      name: "Person Example",
      email: "person@example.com",
      messageKind: "signup_welcome",
      templateVersion: 1,
      unsubscribeUrl: null
    });
    expect(message.text).toContain(
      "Your account is on the Free plan. It includes 1 synced collection, which you can share with one other person, and 250 MB of storage for the files you upload. For your first month, your account has a 5 GB storage trial, and I'll email you a week before it ends."
    );
    expect(message.text).not.toContain("paid plans");
    expect(message.text).not.toContain("does not expire");
    expect(message.text).not.toContain("starter collection");
  });

  it.each([
    ["storage_trial_ending", "Your mdbase Connect storage trial ends in 7 days"],
    ["storage_trial_ended", "Your mdbase Connect storage trial has ended"]
  ])("renders the %s notice with the free allowance and kept files", (messageKind, subject) => {
    // Essential account email: the scheduler issues no unsubscribe link.
    const message = renderScheduledEmail({
      userId: "user-1",
      name: "Person Example",
      email: "person@example.com",
      messageKind,
      templateVersion: 1,
      unsubscribeUrl: null
    });
    expect(message.subject).toBe(subject);
    expect(message.html).toContain(`<title>${subject}</title>`);
    expect(message.text).toContain("250 MB");
    expect(message.text).toContain("Your existing files are kept, and nothing is deleted.");
    expect(message.text).toContain("new uploads will pause");
    expect(message.text.endsWith("Best,\nCallum.")).toBe(true);
    expect(message.html).not.toContain("Unsubscribe");
  });

  it("escapes recipient names in the matching HTML version", () => {
    const message = renderBetaWelcomeEmail({
      name: "<Person & Friend>",
      email: "person@example.com",
      unsubscribeUrl: null
    });
    expect(message.html).toContain("Hi &lt;Person &amp; Friend&gt;,");
    expect(message.html).not.toContain("Hi <Person & Friend>,");
    expect(message.html).toContain("1 GB hosted-storage allowance");
  });

  it("ends with the unsubscribe link when one is issued", () => {
    const unsubscribeUrl = "https://connect.example/unsubscribe#unsubscribe=uns_a&b";
    const message = renderOpenBetaWelcomeEmail({
      name: "Person Example",
      email: "person@example.com",
      unsubscribeUrl
    });
    expect(message.text.endsWith(
      `To stop announcements like this one, unsubscribe: ${unsubscribeUrl}`
    )).toBe(true);
    expect(message.html).toContain(
      'href="https://connect.example/unsubscribe#unsubscribe=uns_a&amp;b"'
    );
  });

  it("fails closed for an unknown kind or template version", () => {
    expect(() => renderScheduledEmail({
      userId: "user-1",
      name: "Person",
      email: "person@example.com",
      messageKind: "unknown",
      templateVersion: 1,
      unsubscribeUrl: null
    })).toThrow("Scheduled email template is unavailable.");
  });
});

const PLUS_AND_APPS_TEXT = (beta: boolean) => `Hi Person Example,

I wanted to send a quick update on mdbase, because a few things have changed since you signed up.

First, there's now a paid plan. mdbase Plus is US$10 a month, or US$96 a year, and it gives you 100 GB of storage for the files you upload, up to 10 synced collections, and room to share your collections with up to 5 people. The Free plan isn't changing. On both plans, notes don't count towards storage; only uploaded files like PDFs and images do. ${beta ? "If you joined during the beta, your beta allowance stays with your account whether or not you upgrade. " : ""}You can upgrade from your account page: https://connect.mdbase.dev/account

Second, I've been building a few apps on top of mdbase that I don't think many people know about. They all work with the same markdown files in your collections, so you can use them together, or open what they write in any other editor.

mdbase Reader is for reading and annotating PDFs, EPUBs and saved web pages. Each highlight and comment is saved as its own markdown file, and there's a Chrome extension for saving and highlighting pages as you read. https://reader.mdbase.dev

mdbase Writer is for writing longer things in markdown, like papers, theses and books. It has a typeset preview, citations from your Reader library, and export to PDF or Word. https://writer.mdbase.dev

mdbase Journal is much simpler. It opens to a blank page every time, and each entry becomes a markdown note in your collection. https://journal.mdbase.dev/

Reader and Writer are still early, and Journal is more of an experiment, so there will probably be some rough edges. As always, please let me know when something breaks, behaves unexpectedly, or is confusing. You can send an email to support@mdbase.dev or open an issue on GitHub. Feedback is super-helpful at this stage!

Best,
Callum.

You're receiving this because you created an mdbase Connect account. To stop announcements like this one, unsubscribe: https://connect.example/unsubscribe#unsubscribe=uns_a`;

describe("Plus and apps announcement", () => {
  it.each([
    [PLUS_AND_APPS_MESSAGE_KIND, false],
    [PLUS_AND_APPS_BETA_MESSAGE_KIND, true]
  ])("renders the approved copy for %s", (messageKind, beta) => {
    const message = renderScheduledEmail({
      userId: "user-1",
      name: "Person Example",
      email: "person@example.com",
      messageKind,
      templateVersion: 1,
      unsubscribeUrl: "https://connect.example/unsubscribe#unsubscribe=uns_a"
    });
    expect(message).toMatchObject({
      to: "person@example.com",
      subject: "mdbase Plus, and three apps you might not have seen",
      text: PLUS_AND_APPS_TEXT(beta)
    });
    expect(message.text).toMatch(/^[\x00-\x7f]*$/u);
    expect(message.html.includes("beta allowance")).toBe(beta);
  });
});
