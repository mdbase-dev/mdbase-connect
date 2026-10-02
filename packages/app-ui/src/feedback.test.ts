import { afterEach, describe, expect, it, vi } from "vitest";
import { readdirSync } from "node:fs";
import { feedbackApplication, feedbackDiagnostics, feedbackEvents, readFeedbackScreenshot, resolveFeedbackEndpoint, sendFeedback } from "./feedback-data.js";

afterEach(() => vi.unstubAllGlobals());
describe("shared feedback data boundary", () => {
  it("emits unique module paths on case-insensitive filesystems", () => {
    const modules = readdirSync(new URL(".", import.meta.url)).filter((file) => /\.tsx?$/.test(file) && !file.includes(".test.")).map((file) => file.replace(/\.tsx?$/, "").toLowerCase());
    expect(new Set(modules).size).toBe(modules.length);
  });
  it("accepts only configured HTTPS or local HTTP destinations", () => {
    expect(resolveFeedbackEndpoint(undefined)).toBeNull();
    expect(resolveFeedbackEndpoint(undefined, true)).toBe("http://127.0.0.1:8790/v1/feedback");
    expect(resolveFeedbackEndpoint(" https://feedback.example/v1/feedback ")).toBe("https://feedback.example/v1/feedback");
    for (const value of ["garbage", "http://feedback.example", "ftp://localhost", "https://secret@feedback.example", "javascript:alert(1)"]) expect(resolveFeedbackEndpoint(value)).toBeNull();
  });
  it("keeps only 30 fixed events from the last five minutes, stripping extra properties", () => {
    const now = Date.parse("2026-10-02T10:00:00.000Z");
    const events = Array.from({ length: 40 }, (_, index) => ({ at: new Date(now - index).toISOString(), code: "save_failed" as const, message: "private data" }));
    const bounded = feedbackEvents([...events, { at: new Date(now - 300_001).toISOString(), code: "timeout" }, { at: new Date(now + 1).toISOString(), code: "timeout" }, { at: "bad", code: "timeout" }], now);
    expect(bounded).toHaveLength(30); expect(bounded.every((event) => Object.keys(event).join(",") === "at,code")).toBe(true);
  });
  it("records coarse browser/OS/viewport information rather than the user agent", () => {
    vi.stubGlobal("navigator", { userAgent: "Windows Chrome/140.1.2.3 Edg/141.0.0.0 PrivateStuff", maxTouchPoints: 0 });
    vi.stubGlobal("window", { innerWidth: 500 });
    expect(feedbackDiagnostics([])).toEqual({ schema_version: 2, browser: "Edge 141", operating_system: "Windows", viewport: "compact", events: [] });
  });
  it("keeps app identity independent of diagnostic consent and rejects URL-shaped views", () => {
    expect(feedbackApplication("mdbase writer", "workspace", "private/path", "unknown")).toEqual({ product: "mdbase writer", source_view: "workspace", build_revision: null, environment: "production" });
    expect(() => feedbackApplication("mdbase reader", "/private/source.pdf")).toThrow("fixed identifiers");
  });
  it("rejects invalid/oversized attachments without decoding", async () => {
    await expect(readFeedbackScreenshot(new File([new Uint8Array(3 * 1024 * 1024 + 1)], "private.png", { type: "image/png" }))).rejects.toThrow("smaller than 3 MB");
    await expect(readFeedbackScreenshot(new File(["svg"], "private.svg", { type: "image/svg+xml" }))).rejects.toThrow("PNG or JPEG");
    await expect(readFeedbackScreenshot(new File(["fake"], "private.png", { type: "image/png" }))).rejects.toThrow("valid PNG");
    const png = new Uint8Array(24); png.set([137, 80, 78, 71, 13, 10, 26, 10]); png.set([73, 72, 68, 82], 12);
    const view = new DataView(png.buffer); view.setUint32(16, 100_000); view.setUint32(20, 100_000);
    await expect(readFeedbackScreenshot(new File([png], "private.png", { type: "image/png" }))).rejects.toThrow("16 megapixels");
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0, 8, 8, 0xff, 0xff, 0xff, 0xff, 3]);
    await expect(readFeedbackScreenshot(new File([jpeg], "private.jpg", { type: "image/jpeg" }))).rejects.toThrow("16 megapixels");
  });
  it("never exposes unstructured infrastructure responses", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("provider secrets", { status: 500 })));
    await expect(sendFeedback("https://feedback.example", { schema_version: 2, request_id: "id", application: feedbackApplication("mdbase reader", "library"), topic: "problem", message: "Help" }, new AbortController().signal)).rejects.toThrow("Please try again");
  });
});
