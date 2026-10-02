import { describe, expect, it, vi } from "vitest";
import { createFeedbackWorker, type FeedbackWorkerEnv } from "./index";

const env: FeedbackWorkerEnv = { ALLOWED_ORIGINS: "https://reader.example,https://writer.example,https://editor.example", FEEDBACK_FROM: "feedback@example.com", FEEDBACK_TO: "support@example.com", RESEND_API_KEY: "test-secret" };
const application = { product: "mdbase reader", source_view: "library", build_revision: "abc123", environment: "lab" };
const diagnostics = { schema_version: 2, browser: "Chrome 140", operating_system: "Linux", viewport: "wide", events: [{ at: "2026-10-02T10:00:00.000Z", code: "save_failed", status: 503 }] };
function submission(overrides: Record<string, unknown> = {}) { return { schema_version: 2, request_id: "123e4567-e89b-42d3-a456-426614174000", application, topic: "problem", message: "Something failed.", ...overrides }; }
function request(value: unknown) { return new Request("https://feedback.example/v1/feedback", { method: "POST", headers: { origin: "https://reader.example", "content-type": "application/json" }, body: JSON.stringify(value) }); }

describe("shared feedback schema v2", () => {
  it.each(["mdbase reader", "mdbase writer", "mdbase editor", "mdbase connect"])("routes %s privately with explicit application metadata", async (product) => {
    const provider = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ id: "mail" }));
    const response = await createFeedbackWorker(provider).fetch(request(submission({ application: { ...application, product }, diagnostics, context: { collection_name: "Chosen collection" } })), env);
    expect(response.status).toBe(202);
    const email = JSON.parse(String(provider.mock.calls[0][1]?.body));
    expect(email.subject).toBe(`[Problem] ${product} feedback`);
    expect(email.text).toContain(`Application: ${product}`);
    expect(email.text).toContain("View: library");
    expect(email.text).toContain("Build: abc123");
    expect(email.text).toContain("Environment: lab");
    expect(email.to).toEqual(["support@example.com"]);
    expect(email.html).toBeUndefined();
    expect(email.attachments[0].filename).toBe("diagnostics.json");
    expect(JSON.parse(atob(email.attachments[0].content))).toEqual(diagnostics);
  });

  it.each([["problem", "Problem"], ["idea", "Idea"], ["appreciation", "Appreciation"]])("accepts %s with a matching email subject", async (topic, label) => {
    const provider = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ id: "mail" }));
    const response = await createFeedbackWorker(provider).fetch(request(submission({ topic })), env);
    expect(response.status).toBe(202);
    expect(JSON.parse(String(provider.mock.calls[0][1]?.body)).subject).toBe(`[${label}] mdbase reader feedback`);
  });

  it.each([
    { application: undefined },
    { application: { ...application, product: "other product" } },
    { application: { ...application, product: ["mdbase reader"] } },
    { application: { ...application, source_view: "/private/note.md" } },
    { application: { ...application, source_view: "https://reader.example/private" } },
    { application: { ...application, build_revision: "private/path" } },
    { application: { ...application, environment: "unknown" } },
    { application: { ...application, environment: ["lab"] } },
    { application: { ...application, url: "https://reader.example/private" } },
    { account_id: "private" },
    { diagnostics: { ...diagnostics, cookies: "secret" } },
    { diagnostics: { ...diagnostics, browser: "complete user-agent and private information" } },
    { diagnostics: { ...diagnostics, operating_system: ["Linux"] } },
    { diagnostics: { ...diagnostics, viewport: ["wide"] } },
    { diagnostics: { ...diagnostics, events: [{ at: "invalid", code: "save_failed" }] } },
    { diagnostics: { ...diagnostics, events: [{ at: diagnostics.events[0].at, code: "raw exception text" }] } },
    { diagnostics: { ...diagnostics, events: [{ ...diagnostics.events[0], code: ["save_failed"] }] } },
    { diagnostics: { ...diagnostics, events: [{ ...diagnostics.events[0], message: "private path" }] } },
    { diagnostics: { ...diagnostics, events: [{ ...diagnostics.events[0], status: 0 }] } },
    { diagnostics: { ...diagnostics, events: [{ ...diagnostics.events[0], status: 600 }] } },
    { diagnostics: { ...diagnostics, events: Array.from({ length: 31 }, () => diagnostics.events[0]) } },
    { context: { application_origin: "https://private.example" } }
  ])("rejects unbounded/private metadata: %j", async (overrides) => {
    const provider = vi.fn();
    const response = await createFeedbackWorker(provider).fetch(request(submission(overrides)), env);
    expect(response.status).toBe(400);
    expect(provider).not.toHaveBeenCalled();
  });

  it("continues enforcing exact origin permissions for other products", async () => {
    const provider = vi.fn();
    const response = await createFeedbackWorker(provider).fetch(request(submission()), { ...env, ALLOWED_ORIGINS: "https://editor.example" });
    expect(response.status).toBe(403); expect(provider).not.toHaveBeenCalled();
  });
});
