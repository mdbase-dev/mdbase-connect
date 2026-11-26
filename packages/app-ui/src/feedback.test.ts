import { afterEach, describe, expect, it, vi } from "vitest";
import { readdirSync } from "node:fs";
import { FeedbackSendError, feedbackApplication, feedbackDiagnostics, feedbackEvents, isScreenshotSendError, readFeedbackScreenshot, resolveFeedbackEndpoint, screenshotFromCanvas, sendFeedback, stripScreenshotMetadata } from "./feedback-data.js";

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
    await expect(readFeedbackScreenshot(new File([new Uint8Array(20 * 1024 * 1024 + 1)], "private.png", { type: "image/png" }))).rejects.toThrow("smaller than 20 MB");
    await expect(readFeedbackScreenshot(new File(["svg"], "private.svg", { type: "image/svg+xml" }))).rejects.toThrow("PNG or JPEG");
    await expect(readFeedbackScreenshot(new File(["fake"], "private.png", { type: "image/png" }))).rejects.toThrow("valid PNG");
    const png = new Uint8Array(24); png.set([137, 80, 78, 71, 13, 10, 26, 10]); png.set([73, 72, 68, 82], 12);
    const view = new DataView(png.buffer); view.setUint32(16, 100_000); view.setUint32(20, 100_000);
    await expect(readFeedbackScreenshot(new File([png], "private.png", { type: "image/png" }))).rejects.toThrow("16 megapixels");
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0, 8, 8, 0xff, 0xff, 0xff, 0xff, 3]);
    await expect(readFeedbackScreenshot(new File([jpeg], "private.jpg", { type: "image/jpeg" }))).rejects.toThrow("16 megapixels");
  });
  it("strips browser-emitted PNG and JPEG metadata chunks client-side", () => {
    const cleanPng = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="), (c) => c.charCodeAt(0));
    const exif = new Uint8Array(12 + 4);
    new DataView(exif.buffer).setUint32(0, 4);
    exif.set([101, 88, 73, 102], 4); // eXIf
    const headerEnd = 8 + 12 + 13;
    const pngWithExif = new Uint8Array(cleanPng.length + exif.length);
    pngWithExif.set(cleanPng.subarray(0, headerEnd), 0);
    pngWithExif.set(exif, headerEnd);
    pngWithExif.set(cleanPng.subarray(headerEnd), headerEnd + exif.length);
    expect(stripScreenshotMetadata(pngWithExif, "image/png")).toEqual(cleanPng);

    const cleanJpeg = Uint8Array.from(atob("/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q=="), (c) => c.charCodeAt(0));
    const app2 = new Uint8Array([0xff, 0xe2, 0x00, 0x06, 0x49, 0x43, 0x43, 0x00]);
    const jpegWithApp2 = new Uint8Array(cleanJpeg.length + app2.length);
    jpegWithApp2.set(cleanJpeg.subarray(0, 2), 0);
    jpegWithApp2.set(app2, 2);
    jpegWithApp2.set(cleanJpeg.subarray(2), 2 + app2.length);
    expect(stripScreenshotMetadata(jpegWithApp2, "image/jpeg")).toEqual(cleanJpeg);
  });
  it("falls back to downscaled JPEG when a high-resolution PNG canvas exceeds 3 MB", async () => {
    const smallJpeg = Uint8Array.from(atob("/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q=="), (c) => c.charCodeAt(0));
    const makeCanvas = (w: number, h: number) => ({
      width: w,
      height: h,
      getContext: () => ({ fillStyle: "", fillRect() {}, drawImage() {} }),
      toBlob(cb: BlobCallback, mime?: string) {
        if (mime === "image/png") cb(new Blob([new Uint8Array(3 * 1024 * 1024 + 100)], { type: "image/png" }));
        else cb(new Blob([smallJpeg], { type: "image/jpeg" }));
      }
    }) as unknown as HTMLCanvasElement;
    vi.stubGlobal("document", { createElement: () => makeCanvas(0, 0) });
    const result = await screenshotFromCanvas(makeCanvas(3456, 2234), "image/png");
    expect(result.media_type).toBe("image/jpeg");
    expect(result.filename).toBe("screenshot.jpg");
    expect(result.content_base64.length).toBeGreaterThan(0);
  });
  it("never exposes unstructured infrastructure responses and classifies screenshot errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("provider secrets", { status: 500 })));
    await expect(sendFeedback("https://feedback.example", { schema_version: 2, request_id: "id", application: feedbackApplication("mdbase reader", "library"), topic: "problem", message: "Help" }, new AbortController().signal)).rejects.toThrow("Please try again");

    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: { code: "invalid_screenshot", message: "The screenshot is invalid or too large." } }, { status: 400 })));
    try {
      await sendFeedback("https://feedback.example", { schema_version: 2, request_id: "id", application: feedbackApplication("mdbase reader", "library"), topic: "problem", message: "Help" }, new AbortController().signal);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(FeedbackSendError);
      expect(isScreenshotSendError(error)).toBe(true);
    }
  });
});
