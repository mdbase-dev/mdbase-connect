import { describe, expect, it } from "vitest";
import {
  renderBetaWelcomeEmail,
  renderScheduledEmail
} from "./beta-welcome-email.js";

const APPROVED_TEXT = `Hi Person Example,

Thanks for signing up for mdbase Connect.

My name is Callum. I've been working on mdbase as a tool for doing more with markdown files, and as you are getting started with mdbase, I want to say a few words about its philosophy, how it works, and some precautions that you might need to take.

I think markdown files are great because they are human readable, work with ordinary text-editing tools, and they remain useful even as the software around them changes or disappears. mdbase Connect is designed to keep these qualities while making it easier to build applications on top of collections of markdown files and providing a secure way to connect to these files over the internet.

A lot of the software that we use, especially SaaS software, puts your data in its own database. This can make it difficult to use elsewhere or leave with the data when the software becomes unsuitable to your needs. The goal of mdbase is to enable users to enjoy good software while maintaining control of their data, with or without mdbase.

There is one important thing to keep in mind, though. By design, an application you connect may be able to read data from a collection. If you give it write access, it may also be able to create, change, move, or delete files in that collection, and, again by design, those changes can be synchronized back to your computer. mdbase checks that each application stays within the permissions you've granted, but you should still only connect applications you trust, especially when they ask for write access.

You can also build applications using the mdbase SDK. This is a way to make your own tools that work with your data online or offline, without giving a third-party application access to it.

Because you joined during the beta, your account has a 1 GB hosted-storage allowance that does not expire when the beta ends. It is shared across your Markdown files and other files. You can create up to 10 hosted collections, connect up to 10 replicas to each collection, store Markdown documents up to 2 MB, and store individual files up to 250 MB. I hope to offer paid plans with more storage later, and you'll be able to add one without losing your beta allowance.

There will probably be some rough edges, so please let me know when something breaks, behaves unexpectedly, or is confusing. You can send an email to support@mdbase.dev or open an issue on GitHub. mdbase is early in its development and so feedback is super-helpful!

Best,
Callum.`;

describe("Beta welcome email", () => {
  it("renders the approved plain-text copy exactly", () => {
    const message = renderBetaWelcomeEmail({
      name: "Person Example",
      email: "person@example.com"
    });
    expect(message).toMatchObject({
      to: "person@example.com",
      subject: "A note about mdbase Connect",
      text: APPROVED_TEXT
    });
    expect(message.text).toMatch(/^[\x00-\x7f]*$/u);
  });

  it("escapes recipient names in the matching HTML version", () => {
    const message = renderBetaWelcomeEmail({
      name: "<Person & Friend>",
      email: "person@example.com"
    });
    expect(message.html).toContain("Hi &lt;Person &amp; Friend&gt;,");
    expect(message.html).not.toContain("Hi <Person & Friend>,");
    expect(message.html).toContain("1 GB hosted-storage allowance");
  });

  it("fails closed for an unknown kind or template version", () => {
    expect(() => renderScheduledEmail({
      userId: "user-1",
      name: "Person",
      email: "person@example.com",
      messageKind: "unknown",
      templateVersion: 1
    })).toThrow("Scheduled email template is unavailable.");
  });
});
