import { describe, expect, it, vi } from "vitest";
import { createFeedbackWorker, type FeedbackWorkerEnv } from "./index";

const ONE_PIXEL_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const ONE_PIXEL_JPEG_BASE64 = "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==";

const env: FeedbackWorkerEnv = {
  ALLOWED_ORIGINS: "https://editor.mdbase.dev,https://editor-staging.mdbase.dev",
  FEEDBACK_FROM: "mdbase feedback <feedback@notifications.mdbase.dev>",
  FEEDBACK_TO: "support@mdbase.dev",
  RESEND_API_KEY: "re_test_secret",
  MDBASE_REVISION: "a".repeat(40)
};

function submission(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 1,
    request_id: "123e4567-e89b-42d3-a456-426614174000",
    topic: "problem",
    message: "Application access did not finish.",
    diagnostics: {
      schema_version: 1,
      product: "mdbase editor",
      surface: "connect",
      source_view: "applications",
      build_revision: "abc123",
      environment: "production",
      browser: "Chrome 140",
      operating_system: "Linux",
      viewport: "wide",
      events: [{ at: "2026-08-24T10:00:00.000Z", event: "management_request_failed", code: "http_error", status: 503 }]
    },
    ...overrides
  };
}

function request(body: unknown = submission(), origin = "https://editor.mdbase.dev") {
  return new Request("https://feedback-api.mdbase.dev/v1/feedback", {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

describe("feedback Worker", () => {
  it("delivers a bounded plain-text email with idempotency", async () => {
    const provider = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ id: "email" }, { status: 200 }));
    const response = await createFeedbackWorker(provider).fetch(request(submission({
      reply_email: "person@example.com",
      context: { collection_name: "Garden notes", application_origin: "https://example.app" },
      screenshot: {
        media_type: "image/png",
        filename: "screenshot.png",
        content_base64: ONE_PIXEL_PNG_BASE64
      }
    })), env);

    expect(response.status).toBe(202);
    expect(response.headers.get("access-control-allow-origin")).toBe("https://editor.mdbase.dev");
    expect(provider).toHaveBeenCalledOnce();
    const [url, init] = provider.mock.calls[0];
    expect(url).toBe("https://api.resend.com/emails");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer re_test_secret");
    expect(new Headers(init?.headers).get("idempotency-key")).toBe("mdbase-feedback/123e4567-e89b-42d3-a456-426614174000");
    const email = JSON.parse(String(init?.body));
    expect(email).toMatchObject({
      from: env.FEEDBACK_FROM,
      to: [env.FEEDBACK_TO],
      reply_to: "person@example.com",
      subject: "[Problem] mdbase connect feedback"
    });
    expect(email.html).toBeUndefined();
    expect(email.text).toContain("Collection: Garden notes");
    expect(email.attachments.map((attachment: { filename: string }) => attachment.filename)).toEqual(["screenshot.png", "diagnostics.json"]);
  });

  it("accepts a structurally valid stripped JPEG", async () => {
    const provider = vi.fn(async () => Response.json({ id: "email" }));
    const response = await createFeedbackWorker(provider).fetch(request(submission({
      screenshot: { media_type: "image/jpeg", filename: "screenshot.jpg", content_base64: ONE_PIXEL_JPEG_BASE64 }
    })), env);
    expect(response.status).toBe(202);
    expect(provider).toHaveBeenCalledOnce();
  });

  it("strips browser-emitted PNG metadata chunks (eXIf, iTXt, tEXt, zTXt, iDOT) instead of rejecting", async () => {
    const png = Uint8Array.from(atob(ONE_PIXEL_PNG_BASE64), (c) => c.charCodeAt(0));
    function chunk(type: string, data: Uint8Array): Uint8Array {
      const out = new Uint8Array(12 + data.length);
      new DataView(out.buffer).setUint32(0, data.length);
      for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
      out.set(data, 8);
      return out;
    }
    const headerEnd = 8 + 12 + 13; // signature + IHDR
    const exif = chunk("eXIf", new Uint8Array([0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08]));
    const itxt = chunk("iTXt", new TextEncoder().encode("XML:com.adobe.xmp\0\0\0\0\0<x/>"));
    const idot = chunk("iDOT", new Uint8Array(28));
    const withMeta = new Uint8Array(png.length + exif.length + itxt.length + idot.length);
    let offset = 0;
    for (const part of [png.subarray(0, headerEnd), exif, itxt, idot, png.subarray(headerEnd)]) {
      withMeta.set(part, offset);
      offset += part.length;
    }
    const provider = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ id: "email" }));
    const response = await createFeedbackWorker(provider).fetch(request(submission({
      screenshot: { media_type: "image/png", filename: "screenshot.png", content_base64: btoa(String.fromCharCode(...withMeta)) }
    })), env);
    expect(response.status).toBe(202);
    const email = JSON.parse(String(provider.mock.calls[0][1]?.body));
    expect(email.attachments[0]).toEqual({ filename: "screenshot.png", content: ONE_PIXEL_PNG_BASE64 });
  });

  it("accepts JPEG ICC color profiles (APP2) and strips EXIF/IPTC/comment metadata segments", async () => {
    const jpeg = Uint8Array.from(atob(ONE_PIXEL_JPEG_BASE64), (c) => c.charCodeAt(0));
    function segment(marker: number, payload: Uint8Array): Uint8Array {
      const out = new Uint8Array(4 + payload.length);
      out[0] = 0xff; out[1] = marker;
      out[2] = ((payload.length + 2) >> 8) & 0xff; out[3] = (payload.length + 2) & 0xff;
      out.set(payload, 4);
      return out;
    }
    const app1 = segment(0xe1, new TextEncoder().encode("Exif\0\0MM"));
    const app2 = segment(0xe2, new TextEncoder().encode("ICC_PROFILE\0\x01\x01"));
    const com = segment(0xfe, new TextEncoder().encode("private comment"));
    const withSegments = new Uint8Array(jpeg.length + app1.length + app2.length + com.length);
    let offset = 0;
    for (const part of [jpeg.subarray(0, 2), app1, app2, com, jpeg.subarray(2)]) {
      withSegments.set(part, offset);
      offset += part.length;
    }
    const provider = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ id: "email" }));
    const response = await createFeedbackWorker(provider).fetch(request(submission({
      screenshot: { media_type: "image/jpeg", filename: "screenshot.jpg", content_base64: btoa(String.fromCharCode(...withSegments)) }
    })), env);
    expect(response.status).toBe(202);
    const email = JSON.parse(String(provider.mock.calls[0][1]?.body));
    const delivered = Uint8Array.from(atob(email.attachments[0].content), (c) => c.charCodeAt(0));
    const expected = new Uint8Array(jpeg.length + app2.length);
    expected.set(jpeg.subarray(0, 2), 0);
    expected.set(app2, 2);
    expected.set(jpeg.subarray(2), 2 + app2.length);
    expect(delivered).toEqual(expected);
  });

  it("rejects origins before reading or forwarding the body", async () => {
    const provider = vi.fn();
    const response = await createFeedbackWorker(provider).fetch(request(undefined, "https://attacker.example"), env);
    expect(response.status).toBe(403);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(provider).not.toHaveBeenCalled();
  });

  it("answers preflight only for an allowed origin and POST", async () => {
    const response = await createFeedbackWorker(vi.fn()).fetch(new Request("https://feedback-api.mdbase.dev/v1/feedback", {
      method: "OPTIONS",
      headers: { origin: "https://editor.mdbase.dev", "access-control-request-method": "POST" }
    }), env);
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-methods")).toBe("POST, OPTIONS");
  });

  it("stops reading an oversized stream without relying on Content-Length", async () => {
    const chunk = new Uint8Array(2_300_000);
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(chunk);
        if (pulls === 3) controller.close();
      }
    });
    const streamed = new Request("https://feedback-api.mdbase.dev/v1/feedback", {
      method: "POST",
      headers: { origin: "https://editor.mdbase.dev", "content-type": "application/json" },
      body,
      duplex: "half"
    } as RequestInit & { duplex: "half" });
    const provider = vi.fn();
    const response = await createFeedbackWorker(provider).fetch(streamed, env);
    expect(response.status).toBe(413);
    expect(provider).not.toHaveBeenCalled();
  });

  it("strictly rejects unknown fields and invalid image bytes", async () => {
    const worker = createFeedbackWorker(vi.fn());
    const unknown = await worker.fetch(request(submission({ account_id: "private" })), env);
    expect(unknown.status).toBe(400);
    expect(await unknown.json()).toMatchObject({ error: { code: "unknown_field" } });

    const image = await worker.fetch(request(submission({
      screenshot: { media_type: "image/png", filename: "screenshot.png", content_base64: btoa("not a png") }
    })), env);
    expect(image.status).toBe(400);
    expect(await image.json()).toMatchObject({ error: { code: "invalid_screenshot" } });

    const appended = btoa(`${atob(ONE_PIXEL_PNG_BASE64)}hidden`);
    const polyglot = await worker.fetch(request(submission({
      screenshot: { media_type: "image/png", filename: "screenshot.png", content_base64: appended }
    })), env);
    expect(polyglot.status).toBe(400);

    const oversized = await worker.fetch(request(submission({
      screenshot: { media_type: "image/png", filename: "screenshot.png", content_base64: "A".repeat(4_200_001) }
    })), env);
    expect(oversized.status).toBe(400);
    expect(await oversized.json()).toMatchObject({ error: { code: "invalid_screenshot" } });
  });

  it("does not expose provider response details", async () => {
    const provider = vi.fn(async () => new Response("mailbox and provider details", { status: 500 }));
    const response = await createFeedbackWorker(provider).fetch(request(), env);
    expect(response.status).toBe(503);
    const body = await response.text();
    expect(body).not.toContain("mailbox and provider details");
    expect(body).not.toContain(env.FEEDBACK_TO);
  });

  it("requires and verifies Turnstile when configured", async () => {
    const provider = vi.fn(async (input: RequestInfo | URL) => String(input).includes("siteverify")
      ? Response.json({ success: true, hostname: "editor.mdbase.dev", action: "feedback" })
      : Response.json({ id: "email" }));
    const protectedEnv = { ...env, TURNSTILE_REQUIRED: "1", TURNSTILE_SECRET: "turnstile-secret" };
    const missing = await createFeedbackWorker(provider).fetch(request(), protectedEnv);
    expect(missing.status).toBe(400);
    expect(await missing.json()).toMatchObject({ error: { code: "verification_required" } });

    provider.mockClear();
    const accepted = await createFeedbackWorker(provider).fetch(request(submission({ turnstile_token: "browser-token" })), protectedEnv);
    expect(accepted.status).toBe(202);
    expect(provider).toHaveBeenCalledTimes(2);
    expect(String(provider.mock.calls[0][0])).toContain("siteverify");
    expect(String(provider.mock.calls[1][0])).toBe("https://api.resend.com/emails");

    const wrongHost = vi.fn(async () => Response.json({ success: true, hostname: "attacker.example", action: "feedback" }));
    const rejected = await createFeedbackWorker(wrongHost).fetch(request(submission({ turnstile_token: "other-token" })), protectedEnv);
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toMatchObject({ error: { code: "verification_failed" } });
  });

  it("fails readiness when managed Turnstile protection is missing", async () => {
    const response = await createFeedbackWorker(vi.fn()).fetch(new Request("https://feedback-api.mdbase.dev/health"), { ...env, TURNSTILE_REQUIRED: "1" });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ok: false, service: "mdbase-feedback", revision: "a".repeat(40) });
  });

  it("exposes only service identity and revision on health", async () => {
    const response = await createFeedbackWorker(vi.fn()).fetch(new Request("https://feedback-api.mdbase.dev/health"), env);
    expect(await response.json()).toEqual({ ok: true, service: "mdbase-feedback", revision: "a".repeat(40) });
  });
});
