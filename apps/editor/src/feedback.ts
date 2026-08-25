import { ManagementApiError } from "@mdbase/connect-management";

export const FEEDBACK_MAX_MESSAGE_LENGTH = 5_000;
export const FEEDBACK_MAX_SCREENSHOT_BYTES = 3 * 1024 * 1024;
const MAX_DIAGNOSTIC_EVENTS = 30;
const DIAGNOSTIC_WINDOW_MS = 5 * 60_000;

export type FeedbackTopic = "problem" | "idea";
export type FeedbackSourceView = "overview" | "storage" | "access" | "collections" | "applications" | "computers" | "account" | "feedback";

export interface FeedbackDiagnosticEvent {
  at: string;
  event: "management_request_failed" | "management_refresh_failed";
  code: "cancelled" | "http_error" | "invalid_response" | "outcome_unknown" | "partial_failure" | "timeout" | "network_error" | "unknown_error";
  status?: number;
}

export interface FeedbackDiagnostics {
  schema_version: 1;
  product: "mdbase editor";
  surface: "connect";
  source_view: FeedbackSourceView;
  build_revision: string | null;
  environment: string;
  browser: string;
  operating_system: string;
  viewport: "compact" | "medium" | "wide";
  events: FeedbackDiagnosticEvent[];
}

export interface FeedbackScreenshot {
  media_type: "image/png" | "image/jpeg";
  filename: "screenshot.png" | "screenshot.jpg";
  content_base64: string;
}

export interface FeedbackSubmission {
  schema_version: 1;
  request_id: string;
  topic: FeedbackTopic;
  message: string;
  reply_email?: string;
  context?: {
    collection_name?: string;
    application_origin?: string;
  };
  diagnostics?: FeedbackDiagnostics;
  screenshot?: FeedbackScreenshot;
  turnstile_token?: string;
}

const diagnosticEvents: FeedbackDiagnosticEvent[] = [];

export function recordFeedbackFailure(event: FeedbackDiagnosticEvent["event"], reason: unknown): void {
  const failure = reason instanceof ManagementApiError
    ? { code: reason.code, status: reason.status }
    : { code: isNetworkFailure(reason) ? "network_error" as const : "unknown_error" as const };
  diagnosticEvents.push({ at: new Date().toISOString(), event, ...failure });
  pruneDiagnosticEvents();
}

export function buildFeedbackDiagnostics(sourceView: FeedbackSourceView): FeedbackDiagnostics {
  pruneDiagnosticEvents();
  return {
    schema_version: 1,
    product: "mdbase editor",
    surface: "connect",
    source_view: sourceView,
    build_revision: normalizedBuildRevision(import.meta.env.VITE_MDBASE_BUILD_REVISION),
    environment: normalizedEnvironment(import.meta.env.VITE_MDBASE_ENV),
    browser: browserFamily(),
    operating_system: operatingSystem(),
    viewport: window.innerWidth < 760 ? "compact" : window.innerWidth < 1200 ? "medium" : "wide",
    events: diagnosticEvents.map((event) => ({ ...event }))
  };
}

export async function readFeedbackScreenshot(file: File): Promise<FeedbackScreenshot> {
  if (file.size > FEEDBACK_MAX_SCREENSHOT_BYTES) {
    throw new Error("Choose a screenshot smaller than 3 MB.");
  }
  if (file.type !== "image/png" && file.type !== "image/jpeg") {
    throw new Error("Choose a PNG or JPEG screenshot.");
  }
  const sourceBytes = new Uint8Array(await file.arrayBuffer());
  if (!matchesImageSignature(sourceBytes, file.type)) {
    throw new Error("The screenshot does not contain a valid PNG or JPEG image.");
  }
  const canonical = await canonicalizeScreenshot(file);
  const bytes = new Uint8Array(await canonical.arrayBuffer());
  if (bytes.byteLength > FEEDBACK_MAX_SCREENSHOT_BYTES) {
    throw new Error("The cleaned screenshot is larger than 3 MB. Crop it and try again.");
  }
  return {
    media_type: file.type,
    filename: file.type === "image/png" ? "screenshot.png" : "screenshot.jpg",
    content_base64: bytesToBase64(bytes)
  };
}

export async function sendFeedback(endpoint: string, submission: FeedbackSubmission, signal?: AbortSignal): Promise<void> {
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(submission),
      credentials: "omit",
      referrerPolicy: "no-referrer",
      signal
    });
  } catch {
    throw new Error("Feedback could not be sent. Check your connection and try again.");
  }
  if (response.ok) return;
  let message = "Feedback could not be sent. Please try again.";
  try {
    const result = await response.json() as { error?: { message?: string } };
    if (typeof result.error?.message === "string" && result.error.message.length <= 200) message = result.error.message;
  } catch {
    // Provider and infrastructure response bodies are intentionally ignored.
  }
  throw new Error(message);
}

export function feedbackEndpoint(): string | null {
  const configured = import.meta.env.VITE_MDBASE_FEEDBACK_URL?.trim();
  const value = configured || (import.meta.env.DEV ? "http://127.0.0.1:8790/v1/feedback" : "");
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.hostname !== "127.0.0.1" && url.hostname !== "localhost") return null;
    return url.href;
  } catch {
    return null;
  }
}

export function turnstileSiteKey(): string | null {
  return import.meta.env.VITE_MDBASE_TURNSTILE_SITE_KEY?.trim() || null;
}

function pruneDiagnosticEvents(now = Date.now()): void {
  const cutoff = now - DIAGNOSTIC_WINDOW_MS;
  while (diagnosticEvents.length > 0 && new Date(diagnosticEvents[0].at).getTime() < cutoff) diagnosticEvents.shift();
  if (diagnosticEvents.length > MAX_DIAGNOSTIC_EVENTS) diagnosticEvents.splice(0, diagnosticEvents.length - MAX_DIAGNOSTIC_EVENTS);
}

function matchesImageSignature(bytes: Uint8Array, type: File["type"]): boolean {
  if (type === "image/png") {
    return bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value);
  }
  return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

async function canonicalizeScreenshot(file: File): Promise<Blob> {
  const source = await decodeImage(file);
  try {
    if (source.width < 1 || source.height < 1 || source.width > 8_192 || source.height > 8_192 || source.width * source.height > 16_000_000) {
      throw new Error("Choose a screenshot smaller than 16 megapixels.");
    }
    const canvas = document.createElement("canvas");
    canvas.width = source.width;
    canvas.height = source.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("The screenshot could not be cleaned in this browser.");
    context.drawImage(source.image, 0, 0);
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(
      (result) => result ? resolve(result) : reject(new Error("The screenshot could not be cleaned in this browser.")),
      file.type,
      file.type === "image/jpeg" ? 0.9 : undefined
    ));
    return blob;
  } finally {
    source.close();
  }
}

async function decodeImage(file: File): Promise<{ width: number; height: number; image: CanvasImageSource; close(): void }> {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(file);
      return { width: bitmap.width, height: bitmap.height, image: bitmap, close: () => bitmap.close() };
    } catch {
      throw new Error("The screenshot could not be decoded as a PNG or JPEG image.");
    }
  }
  const objectUrl = URL.createObjectURL(file);
  const image = new Image();
  try {
    image.src = objectUrl;
    await image.decode();
    return { width: image.naturalWidth, height: image.naturalHeight, image, close: () => URL.revokeObjectURL(objectUrl) };
  } catch {
    URL.revokeObjectURL(objectUrl);
    throw new Error("The screenshot could not be decoded as a PNG or JPEG image.");
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 32_768) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
  }
  return btoa(binary);
}

function normalizedBuildRevision(value: string | undefined): string | null {
  const revision = value?.trim();
  return revision && /^[a-zA-Z0-9._-]{1,64}$/u.test(revision) ? revision : null;
}

function normalizedEnvironment(value: string | undefined): string {
  const environment = value?.trim().toLowerCase();
  return environment === "production" || environment === "staging" || environment === "development" ? environment : import.meta.env.DEV ? "development" : "production";
}

function browserFamily(): string {
  const userAgent = navigator.userAgent;
  const match = userAgent.match(/(?:Edg|Chrome|Firefox|Version)\/(\d+)/u);
  const version = match?.[1] ?? "unknown";
  if (/Edg\//u.test(userAgent)) return `Edge ${version}`;
  if (/Firefox\//u.test(userAgent)) return `Firefox ${version}`;
  if (/Chrome\//u.test(userAgent)) return `Chrome ${version}`;
  if (/Safari\//u.test(userAgent)) return `Safari ${version}`;
  return "Other";
}

function operatingSystem(): string {
  const userAgent = navigator.userAgent;
  if (/Windows/u.test(userAgent)) return "Windows";
  if (/Macintosh|Mac OS/u.test(userAgent)) return "macOS";
  if (/Android/u.test(userAgent)) return "Android";
  if (/iPhone|iPad|iPod/u.test(userAgent)) return "iOS";
  if (/Linux/u.test(userAgent)) return "Linux";
  return "Other";
}

function isNetworkFailure(value: unknown): boolean {
  return value instanceof TypeError && /fetch|network|load/i.test(value.message);
}
