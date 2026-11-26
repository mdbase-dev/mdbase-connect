import { t } from "@lingui/core/macro";
import "./i18n.js";
export const FEEDBACK_MAX_MESSAGE_LENGTH = 5_000;
export const FEEDBACK_MAX_SCREENSHOT_BYTES = 3 * 1024 * 1024;
const FEEDBACK_MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const FEEDBACK_MAX_UPLOAD_EDGE = 2_560;
const STRIPPED_PNG_CHUNKS = new Set(["eXIf", "iTXt", "tEXt", "zTXt", "iDOT"]);
export const FEEDBACK_ERROR_CODES = ["cancelled", "http_error", "invalid_response", "outcome_unknown", "partial_failure", "timeout", "network_error", "unknown_error", "save_failed", "source_open_failed", "preview_failed"] as const;
export type FeedbackErrorCode = typeof FEEDBACK_ERROR_CODES[number];
export type FeedbackTopic = "problem" | "idea" | "appreciation";
export interface FeedbackApplication {
  product: "mdbase editor" | "mdbase reader" | "mdbase writer" | "mdbase connect" | "tasknotes";
  source_view: string;
  build_revision: string | null;
  environment: "production" | "staging" | "development" | "lab";
}
export interface FeedbackFailure { code: FeedbackErrorCode; status?: number }
export interface FeedbackDiagnosticEvent extends FeedbackFailure { at: string }
export interface FeedbackDiagnostics {
  schema_version: 2;
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
  schema_version: 2;
  request_id: string;
  application: FeedbackApplication;
  topic: FeedbackTopic;
  message: string;
  reply_email?: string;
  context?: { collection_name: string };
  diagnostics?: FeedbackDiagnostics;
  screenshot?: FeedbackScreenshot;
  turnstile_token?: string;
}
export const feedbackTopics = {
  problem: { get label() { return t({ message: "Report a problem" }); }, get prompt() { return t({ message: "What happened?" }); }, get placeholder() { return t({ message: "What were you trying to do?" }); }, get thanks() { return t({ message: "Thanks for the report." }); } },
  idea: { get label() { return t({ message: "Suggest an improvement" }); }, get prompt() { return t({ message: "What would you like to improve?" }); }, get placeholder() { return t({ message: "How would it help you?" }); }, get thanks() { return t({ message: "Thanks for the idea." }); } },
  appreciation: { get label() { return t({ message: "Share something you like" }); }, get prompt() { return t({ message: "What’s working well for you?" }); }, get placeholder() { return t({ message: "What made a difference?" }); }, get thanks() { return t({ message: "Thanks for the kind words." }); } }
} satisfies Record<FeedbackTopic, { label: string; prompt: string; placeholder: string; thanks: string }>;

/** Each provider owns its bounded, short-lived error buffer; never accepts messages or request data. */
export function feedbackEvents(events: readonly FeedbackDiagnosticEvent[], now = Date.now()): FeedbackDiagnosticEvent[] {
  return events.filter((event) => { const age = now - Date.parse(event.at); return age >= 0 && age <= 5 * 60_000; }).slice(-30).map(({ at, code, status }) => ({ at, code, ...(status === undefined ? {} : { status }) }));
}
export function feedbackDiagnostics(events: readonly FeedbackDiagnosticEvent[]): FeedbackDiagnostics {
  const ua = navigator.userAgent;
  const family = /Edg\//u.test(ua) ? "Edge" : /Firefox\//u.test(ua) ? "Firefox" : /Chrome\//u.test(ua) ? "Chrome" : /Safari\//u.test(ua) ? "Safari" : "Other";
  const browserMatch = { Edge: /Edg\/(\d+)/u, Firefox: /Firefox\/(\d+)/u, Chrome: /Chrome\/(\d+)/u, Safari: /Version\/(\d+)/u, Other: /$^/u }[family].exec(ua);
  return {
    schema_version: 2,
    browser: family === "Other" ? "Other" : `${family} ${browserMatch?.[1] ?? "unknown"}`,
    operating_system: /iPhone|iPad|iPod/u.test(ua) || (/Macintosh/u.test(ua) && navigator.maxTouchPoints > 1) ? "iOS" : /Android/u.test(ua) ? "Android" : /Windows/u.test(ua) ? "Windows" : /Macintosh|Mac OS/u.test(ua) ? "macOS" : /Linux/u.test(ua) ? "Linux" : "Other",
    viewport: window.innerWidth < 760 ? "compact" : window.innerWidth < 1200 ? "medium" : "wide",
    events: feedbackEvents(events)
  };
}
export function resolveFeedbackEndpoint(configured: string | undefined, development = false): string | null {
  const value = configured?.trim() || (development ? "http://127.0.0.1:8790/v1/feedback" : "");
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.username || url.password || (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname)))) return null;
    return url.href;
  } catch { return null; }
}
export function feedbackApplication(product: FeedbackApplication["product"], sourceView: string, revision?: string, environment?: string): FeedbackApplication {
  if (!/^[a-z][a-z0-9_-]{0,63}$/u.test(sourceView)) throw new TypeError("Feedback views must be fixed identifiers, not URLs or record paths.");
  return { product, source_view: sourceView, build_revision: revision && /^[a-zA-Z0-9._-]{1,64}$/u.test(revision) ? revision : null, environment: environment === "staging" || environment === "development" || environment === "lab" ? environment : "production" };
}
export class FeedbackSendError extends Error {
  constructor(message: string, public readonly code?: string, public readonly status?: number) {
    super(message);
  }
}
export function isScreenshotSendError(reason: unknown): boolean {
  return reason instanceof FeedbackSendError && (reason.code === "invalid_screenshot" || reason.code === "payload_too_large" || reason.status === 413);
}
export async function sendFeedback(endpoint: string, submission: FeedbackSubmission, signal: AbortSignal): Promise<void> {
  let response: Response;
  try {
    response = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(submission), credentials: "omit", referrerPolicy: "no-referrer", signal });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new Error(t({ message: "Feedback could not be sent. Check your connection and try again." }));
  }
  if (response.ok) return;
  let message = t({ message: "Feedback could not be sent. Please try again." });
  let code: string | undefined;
  try {
    const result = await response.json() as { error?: { code?: unknown; message?: unknown } };
    if (typeof result.error?.message === "string" && result.error.message.length <= 200) message = result.error.message;
    if (typeof result.error?.code === "string" && result.error.code.length <= 64) code = result.error.code;
  } catch { /* Never reflect infrastructure/provider response bodies. */ }
  throw new FeedbackSendError(message, code, response.status);
}
export function screenshotUrl(screenshot: FeedbackScreenshot): string { return `data:${screenshot.media_type};base64,${screenshot.content_base64}`; }
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 32_768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
  return btoa(binary);
}
function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.byteLength;
  const output = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) { output.set(part, offset); offset += part.byteLength; }
  return output;
}
/** Strips encoder-emitted PNG text/EXIF chunks and JPEG metadata segments so canvas exports are clean across browsers. */
export function stripScreenshotMetadata(bytes: Uint8Array, type: "image/png" | "image/jpeg"): Uint8Array {
  if (type === "image/png") {
    if (bytes.length < 45 || ![137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => bytes[i] === v)) return bytes;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let offset = 8, stripped = false;
    const kept: Uint8Array[] = [bytes.subarray(0, 8)];
    while (offset + 12 <= bytes.length) {
      const length = view.getUint32(offset);
      const end = offset + 12 + length;
      if (end > bytes.length) return bytes;
      const chunkType = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
      if (STRIPPED_PNG_CHUNKS.has(chunkType)) stripped = true;
      else kept.push(bytes.subarray(offset, end));
      if (chunkType === "IEND") return stripped && end === bytes.length ? concatBytes(kept) : bytes;
      offset = end;
    }
    return bytes;
  }
  if (bytes.length < 20 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) return bytes;
  let offset = 2, stripped = false;
  const kept: Uint8Array[] = [bytes.subarray(0, 2)];
  while (offset < bytes.length - 2) {
    if (bytes[offset] !== 0xff) return bytes;
    const markerStart = offset;
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset++];
    if (marker === undefined || marker === 0x00) return bytes;
    if (marker === 0xda) { kept.push(bytes.subarray(markerStart)); return stripped ? concatBytes(kept) : bytes; }
    if (marker === 0xd9) return bytes;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { kept.push(bytes.subarray(markerStart, offset)); continue; }
    if (offset + 2 > bytes.length) return bytes;
    const length = (bytes[offset] << 8) | bytes[offset + 1];
    if (length < 2 || offset + length > bytes.length) return bytes;
    const segmentEnd = offset + length;
    if ([0xe1, 0xe2, 0xed, 0xfe].includes(marker)) stripped = true;
    else kept.push(bytes.subarray(markerStart, segmentEnd));
    offset = segmentEnd;
  }
  return bytes;
}
function renderScaledCanvas(source: HTMLCanvasElement, maxEdge: number | null, opaqueBackground: boolean): HTMLCanvasElement {
  const scale = maxEdge ? Math.min(1, maxEdge / source.width, maxEdge / source.height) : 1;
  if (scale === 1 && !opaqueBackground) return source;
  const target = document.createElement("canvas");
  target.width = Math.max(1, Math.round(source.width * scale));
  target.height = Math.max(1, Math.round(source.height * scale));
  const context = target.getContext("2d");
  if (!context) return source;
  if (opaqueBackground) { context.fillStyle = "#ffffff"; context.fillRect(0, 0, target.width, target.height); }
  context.drawImage(source, 0, 0, target.width, target.height);
  return target;
}
async function encodeCanvas(canvas: HTMLCanvasElement, type: "image/png" | "image/jpeg", quality?: number): Promise<{ media_type: "image/png" | "image/jpeg"; bytes: Uint8Array }> {
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((result) => result ? resolve(result) : reject(new Error(t({ message: "The screenshot could not be created." }))), type, quality));
  const actualType: "image/png" | "image/jpeg" = blob.type === "image/png" || blob.type === "image/jpeg" ? blob.type : type;
  return { media_type: actualType, bytes: stripScreenshotMetadata(new Uint8Array(await blob.arrayBuffer()), actualType) };
}
export async function screenshotFromCanvas(canvas: HTMLCanvasElement, type: "image/png" | "image/jpeg" = "image/png"): Promise<FeedbackScreenshot> {
  const first = await encodeCanvas(type === "image/jpeg" ? renderScaledCanvas(canvas, null, true) : canvas, type, type === "image/jpeg" ? 0.9 : undefined);
  if (first.bytes.byteLength <= FEEDBACK_MAX_SCREENSHOT_BYTES) {
    return { media_type: first.media_type, filename: first.media_type === "image/png" ? "screenshot.png" : "screenshot.jpg", content_base64: bytesToBase64(first.bytes) };
  }
  for (const { maxEdge, quality } of [
    { maxEdge: 2560, quality: 0.85 },
    { maxEdge: 1920, quality: 0.82 },
    { maxEdge: 1600, quality: 0.78 },
    { maxEdge: 1280, quality: 0.72 },
    { maxEdge: 960, quality: 0.65 }
  ]) {
    const encoded = await encodeCanvas(renderScaledCanvas(canvas, maxEdge, true), "image/jpeg", quality);
    if (encoded.bytes.byteLength <= FEEDBACK_MAX_SCREENSHOT_BYTES) {
      return { media_type: encoded.media_type, filename: encoded.media_type === "image/png" ? "screenshot.png" : "screenshot.jpg", content_base64: bytesToBase64(encoded.bytes) };
    }
  }
  throw new Error(t({ message: "The screenshot is larger than 3 MB. Choose a smaller image." }));
}
export async function readFeedbackScreenshot(file: File): Promise<FeedbackScreenshot> {
  if (file.size > FEEDBACK_MAX_UPLOAD_BYTES) throw new Error(t({ message: "Choose a screenshot smaller than 20 MB.", context: "Feedback" }));
  if (file.type !== "image/png" && file.type !== "image/jpeg") throw new Error(t({ message: "Choose a PNG or JPEG screenshot." }));
  const bytes = new Uint8Array(await file.arrayBuffer());
  const valid = file.type === "image/png" ? [137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => bytes[i] === v) : bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (!valid) throw new Error(t({ message: "The screenshot does not contain a valid PNG or JPEG image." }));
  const dimensions = rasterDimensions(bytes, file.type);
  assertImageSize(dimensions.width, dimensions.height); // Reject decompression bombs before browser decoding.
  const url = URL.createObjectURL(file);
  try {
    const image = new Image(); image.src = url;
    await image.decode();
    assertImageSize(image.naturalWidth, image.naturalHeight);
    const scale = Math.min(1, FEEDBACK_MAX_UPLOAD_EDGE / image.naturalWidth, FEEDBACK_MAX_UPLOAD_EDGE / image.naturalHeight);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error(t({ message: "The screenshot could not be cleaned in this browser." }));
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return await screenshotFromCanvas(canvas, file.type);
  } finally { URL.revokeObjectURL(url); }
}
function assertImageSize(width: number, height: number) {
  if (!width || !height || width > 8192 || height > 8192 || width * height > 16_000_000) throw new Error(t({ message: "Choose a screenshot smaller than 16 megapixels." }));
}
function rasterDimensions(bytes: Uint8Array, type: "image/png" | "image/jpeg"): { width: number; height: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (type === "image/png" && bytes.length >= 24 && String.fromCharCode(...bytes.subarray(12, 16)) === "IHDR") return { width: view.getUint32(16), height: view.getUint32(20) };
  if (type === "image/jpeg") {
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset++] !== 0xff) break;
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++];
      if (marker === 0xd9 || marker === 0xda || marker === undefined || offset + 2 > bytes.length) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      const length = view.getUint16(offset);
      if (length < 2 || offset + length > bytes.length) break;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && length >= 8) return { width: view.getUint16(offset + 5), height: view.getUint16(offset + 3) };
      offset += length;
    }
  }
  throw new Error(t({ message: "The screenshot does not contain a valid PNG or JPEG image." }));
}
async function bounded<T>(promise: Promise<T>, milliseconds: number, signal: AbortSignal): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      abort = () => reject(new DOMException("Capture cancelled", "AbortError"));
      if (signal.aborted) { abort(); return; }
      signal.addEventListener("abort", abort, { once: true });
      timer = setTimeout(() => reject(new Error(t({ message: "The screenshot could not be captured. Try again." }))), milliseconds);
    })]);
  } finally { clearTimeout(timer); if (abort) signal.removeEventListener("abort", abort); }
}
/** Caller closes the native dialog first. Media is always stopped, including cancellation/unmount. */
export async function captureFeedbackScreenshot(signal: AbortSignal): Promise<FeedbackScreenshot> {
  if (!navigator.mediaDevices?.getDisplayMedia) throw new Error(t({ message: "Screen capture isn’t available in this browser. You can attach an image instead." }));
  await bounded(new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))), 1000, signal);
  if (signal.aborted) throw new DOMException("Capture cancelled", "AbortError");
  // The picker is intentionally not timed out: the user decides whether to grant capture.
  const stream = await navigator.mediaDevices.getDisplayMedia({ video: { displaySurface: "browser" }, audio: false, preferCurrentTab: true, selfBrowserSurface: "include", surfaceSwitching: "exclude" } as DisplayMediaStreamOptions);
  const stop = () => stream.getTracks().forEach((track) => track.stop());
  const video = document.createElement("video");
  let frameCallback: number | undefined;
  signal.addEventListener("abort", stop, { once: true });
  try {
    if (signal.aborted) throw new DOMException("Capture cancelled", "AbortError");
    video.muted = true; video.playsInline = true; video.srcObject = stream;
    const frame = typeof video.requestVideoFrameCallback === "function" ? new Promise<void>((resolve) => { frameCallback = video.requestVideoFrameCallback(() => resolve()); }) : Promise.resolve();
    await bounded(Promise.all([video.play(), frame]), 5000, signal);
    if (!video.videoWidth || !video.videoHeight || stream.getVideoTracks()[0]?.readyState === "ended") throw new Error(t({ message: "Screen sharing ended before a screenshot was taken." }));
    const scale = Math.min(1, 1600 / video.videoWidth, 1200 / video.videoHeight);
    const canvas = document.createElement("canvas"); canvas.width = Math.max(1, Math.round(video.videoWidth * scale)); canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error(t({ message: "The screenshot could not be created in this browser." }));
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    stop(); // Do not leave sharing running during asynchronous PNG encoding.
    return await screenshotFromCanvas(canvas);
  } finally {
    stop(); signal.removeEventListener("abort", stop);
    if (frameCallback !== undefined) video.cancelVideoFrameCallback(frameCallback);
    video.pause(); video.srcObject = null;
  }
}
