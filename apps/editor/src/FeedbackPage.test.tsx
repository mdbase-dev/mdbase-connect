import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FeedbackPage } from "./FeedbackPage";
import { FEEDBACK_MAX_SCREENSHOT_BYTES, readFeedbackScreenshot } from "./feedback";

const ONE_PIXEL_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: true }, { status: 202 })));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("FeedbackPage", () => {
  it("shows optional context and sends only consented fields", async () => {
    const user = userEvent.setup();
    render(<FeedbackPage
      endpoint="https://feedback-api.mdbase.dev/v1/feedback"
      turnstileSiteKey={null}
      sourceView="applications"
      collectionName="Garden notes"
      applicationOrigins={["https://example.app"]}
      onDone={() => undefined}
    />);

    await user.click(screen.getByRole("radio", { name: /Share an idea/ }));
    await user.type(screen.getByLabelText("What would you like to be able to do?"), "Make application access easier to compare.");
    await user.type(screen.getByLabelText(/Reply email/), "person@example.com");
    await user.click(screen.getByRole("checkbox", { name: /Include collection name/ }));
    await user.click(screen.getByRole("button", { name: "Send feedback" }));

    expect(await screen.findByRole("heading", { name: "Feedback sent" })).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe("https://feedback-api.mdbase.dev/v1/feedback");
    expect(init).toMatchObject({ method: "POST", credentials: "omit", referrerPolicy: "no-referrer" });
    const submission = JSON.parse(String(init?.body));
    expect(submission).toMatchObject({
      schema_version: 1,
      topic: "idea",
      message: "Make application access easier to compare.",
      reply_email: "person@example.com",
      context: { collection_name: "Garden notes" },
      diagnostics: { schema_version: 1, surface: "connect", source_view: "applications" }
    });
    expect(submission.context.application_origin).toBeUndefined();
    expect(JSON.stringify(submission.diagnostics)).not.toContain("Garden notes");
    expect(JSON.stringify(submission.diagnostics)).not.toContain("example.app");
  });

  it("preserves the draft when delivery fails", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ error: { message: "Feedback could not be delivered. Please try again." } }, { status: 503 }));
    const user = userEvent.setup();
    render(<FeedbackPage
      endpoint="https://feedback-api.mdbase.dev/v1/feedback"
      turnstileSiteKey={null}
      sourceView="overview"
      applicationOrigins={[]}
      onDone={() => undefined}
    />);

    const message = screen.getByLabelText("What were you trying to do, and what happened?");
    await user.type(message, "The collection stayed offline.");
    await user.click(screen.getByRole("button", { name: "Send feedback" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Feedback could not be delivered");
    expect(message).toHaveValue("The collection stayed offline.");
    expect(screen.getByRole("button", { name: "Send feedback" })).toBeEnabled();
  });

  it("validates screenshot size, type, and magic bytes before submission", async () => {
    const oversized = fakeFile("image/png", new Uint8Array(FEEDBACK_MAX_SCREENSHOT_BYTES + 1));
    await expect(readFeedbackScreenshot(oversized)).rejects.toThrow("smaller than 3 MB");

    const disguised = fakeFile("image/png", new TextEncoder().encode("not a png"));
    await expect(readFeedbackScreenshot(disguised)).rejects.toThrow("does not contain a valid PNG");

    const canonicalPng = bytesFromBase64(ONE_PIXEL_PNG_BASE64);
    vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ width: 1, height: 1, close: vi.fn() })));
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage: vi.fn() } as unknown as CanvasRenderingContext2D);
    const canonicalBuffer = new ArrayBuffer(canonicalPng.byteLength);
    new Uint8Array(canonicalBuffer).set(canonicalPng);
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((callback) => callback(new Blob([canonicalBuffer], { type: "image/png" })));
    const png = fakeFile("image/png", canonicalPng);
    await expect(readFeedbackScreenshot(png)).resolves.toMatchObject({ media_type: "image/png", filename: "screenshot.png", content_base64: ONE_PIXEL_PNG_BASE64 });
  });

  it("requires a configured Turnstile token before enabling submission", async () => {
    render(<FeedbackPage
      endpoint="https://feedback-api.mdbase.dev/v1/feedback"
      turnstileSiteKey="site-key"
      sourceView="overview"
      applicationOrigins={[]}
      onDone={() => undefined}
    />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("What were you trying to do, and what happened?"), "A clear problem description.");
    expect(screen.getByRole("button", { name: "Send feedback" })).toBeDisabled();
  });
});

function bytesFromBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

function fakeFile(type: string, bytes: Uint8Array): File {
  const data = Uint8Array.from(bytes).buffer;
  const file = new File([data], "capture", { type });
  Object.defineProperty(file, "size", { value: data.byteLength });
  Object.defineProperty(file, "arrayBuffer", { value: async () => data });
  return file;
}
