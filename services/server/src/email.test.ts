import { describe, expect, it, vi } from "vitest";
import {
  EmailDeliveryError,
  ResendEmailTransport
} from "./email.js";

const message = {
  to: "person@example.com",
  subject: "Your invitation",
  text: "Use the invitation link.",
  html: "<p>Use the invitation link.</p>"
};

describe("Resend transactional email transport", () => {
  it("sends text and HTML with authentication, user agent, and idempotency", async () => {
    const request = vi.fn(async () => new Response(
      JSON.stringify({ id: "email_123" }),
      {
        status: 200,
        headers: { "content-type": "application/json" }
      }
    ));
    const transport = new ResendEmailTransport({
      apiKey: "re_test_secret",
      from: "mdbase connect <hello@mdbase.dev>",
      fetch: request
    });
    await expect(transport.send(message, "invitation/example"))
      .resolves.toEqual({
        provider: "resend",
        messageId: "email_123"
      });
    expect(request).toHaveBeenCalledOnce();
    const [url, init] = request.mock.calls[0]!;
    expect(url).toBe("https://api.resend.com/emails");
    expect(init?.headers).toMatchObject({
      authorization: "Bearer re_test_secret",
      "content-type": "application/json",
      "idempotency-key": "invitation/example",
      "user-agent": "mdbase-connect/transactional-email"
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      from: "mdbase connect <hello@mdbase.dev>",
      to: ["person@example.com"],
      subject: message.subject,
      text: message.text,
      html: message.html
    });
  });

  it("classifies retryable provider and network failures without exposing response text", async () => {
    const provider = new ResendEmailTransport({
      apiKey: "re_test_secret",
      from: "hello@mdbase.dev",
      fetch: async () => new Response(
        JSON.stringify({
          name: "rate_limit_exceeded",
          message: "sensitive provider detail"
        }),
        {
          status: 429,
          headers: { "content-type": "application/json" }
        }
      )
    });
    const providerError = await provider.send(
      message,
      "invitation/provider-error"
    ).catch((error: unknown) => error);
    expect(providerError).toBeInstanceOf(EmailDeliveryError);
    expect(providerError).toMatchObject({
      code: "rate_limit_exceeded",
      retryable: true,
      status: 429
    });
    expect(String(providerError)).not.toContain("sensitive provider detail");

    const network = new ResendEmailTransport({
      apiKey: "re_test_secret",
      from: "hello@mdbase.dev",
      fetch: async () => { throw new Error("socket details"); }
    });
    await expect(network.send(message, "invitation/network-error"))
      .rejects.toMatchObject({
        code: "network_error",
        retryable: true,
        status: null
      });
  });

  it("validates configuration and request metadata before network access", async () => {
    expect(() => new ResendEmailTransport({
      apiKey: "",
      from: "hello@mdbase.dev"
    })).toThrow(/API key/);
    expect(() => new ResendEmailTransport({
      apiKey: "re_test",
      from: "hello@mdbase.dev\r\nBcc: other@example.com"
    })).toThrow(/sender/);
    const transport = new ResendEmailTransport({
      apiKey: "re_test",
      from: "hello@mdbase.dev",
      fetch: async () => { throw new Error("must not be called"); }
    });
    await expect(transport.send(message, "")).rejects.toThrow(/idempotency/);
  });
});
