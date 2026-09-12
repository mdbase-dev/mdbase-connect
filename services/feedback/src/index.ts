const MAX_BODY_BYTES = 4_400_000;
const MAX_MESSAGE_LENGTH = 5_000;
const MAX_SCREENSHOT_BYTES = 3 * 1024 * 1024;
const MAX_DIAGNOSTIC_EVENTS = 30;
const EMAIL_TIMEOUT_MS = 10_000;

export interface FeedbackWorkerEnv {
  ALLOWED_ORIGINS: string;
  FEEDBACK_FROM: string;
  FEEDBACK_TO: string;
  RESEND_API_KEY: string;
  TURNSTILE_REQUIRED?: string;
  TURNSTILE_SECRET?: string;
  MDBASE_REVISION?: string;
}

interface FeedbackScreenshot {
  media_type: "image/png" | "image/jpeg";
  filename: "screenshot.png" | "screenshot.jpg";
  content_base64: string;
  bytes: Uint8Array;
}

interface FeedbackSubmission {
  schema_version: 1;
  request_id: string;
  topic: "problem" | "idea";
  message: string;
  reply_email?: string;
  context?: { collection_name?: string; application_origin?: string };
  diagnostics?: Record<string, unknown>;
  screenshot?: FeedbackScreenshot;
  turnstile_token?: string;
}

class RequestError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
  }
}

export function createFeedbackWorker(fetchImpl: typeof fetch = fetch) {
  return {
    async fetch(request: Request, env: FeedbackWorkerEnv): Promise<Response> {
      const healthRequest = request.method === "GET" && new URL(request.url).pathname === "/health";
      let allowedOrigins: Set<string>;
      try {
        allowedOrigins = configuredOrigins(env.ALLOWED_ORIGINS);
        validateEmailConfiguration(env);
      } catch {
        return healthRequest
          ? json({ ok: false, service: "mdbase-feedback", revision: safeRevision(env.MDBASE_REVISION) }, 503)
          : jsonError(503, "service_unavailable", "Feedback is temporarily unavailable.");
      }
      if (healthRequest) return json({ ok: true, service: "mdbase-feedback", revision: safeRevision(env.MDBASE_REVISION) });

      const origin = request.headers.get("origin") ?? "";
      if (!allowedOrigins.has(origin)) return jsonError(403, "origin_denied", "This feedback origin is not allowed.");
      const cors = corsHeaders(origin);
      if (request.method === "OPTIONS") {
        const requestedMethod = request.headers.get("access-control-request-method");
        return requestedMethod === "POST"
          ? new Response(null, { status: 204, headers: cors })
          : jsonError(405, "method_not_allowed", "Only POST submissions are accepted.", cors);
      }
      if (request.method !== "POST") return jsonError(405, "method_not_allowed", "Only POST submissions are accepted.", cors);
      if (new URL(request.url).pathname !== "/v1/feedback") return jsonError(404, "not_found", "Feedback endpoint not found.", cors);
      if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
        return jsonError(415, "unsupported_media_type", "Feedback must be sent as JSON.", cors);
      }
      const contentLengthHeader = request.headers.get("content-length");
      const contentLength = contentLengthHeader === null ? null : Number(contentLengthHeader);
      if (contentLength !== null && (!Number.isFinite(contentLength) || contentLength < 0 || contentLength > MAX_BODY_BYTES)) {
        return jsonError(413, "payload_too_large", "The feedback attachment is too large.", cors);
      }

      try {
        const body = await readBoundedBody(request, MAX_BODY_BYTES);
        let raw: unknown;
        try { raw = JSON.parse(body); } catch { throw new RequestError(400, "invalid_json", "Feedback must contain valid JSON."); }
        const submission = validateSubmission(raw);
        if (env.TURNSTILE_SECRET) await verifyTurnstile(fetchImpl, env.TURNSTILE_SECRET, submission.turnstile_token, origin);
        await sendEmail(fetchImpl, env, submission);
        return json({ ok: true, request_id: submission.request_id }, 202, cors);
      } catch (reason) {
        if (reason instanceof RequestError) return jsonError(reason.status, reason.code, reason.message, cors);
        return jsonError(503, "delivery_failed", "Feedback could not be delivered. Please try again.", cors);
      }
    }
  };
}

const worker = createFeedbackWorker();
export default worker;

function validateSubmission(value: unknown): FeedbackSubmission {
  const input = object(value, "Feedback must be an object.");
  exactKeys(input, ["schema_version", "request_id", "topic", "message", "reply_email", "context", "diagnostics", "screenshot", "turnstile_token"]);
  if (input.schema_version !== 1) throw new RequestError(400, "unsupported_schema", "This feedback format is not supported.");
  const requestId = text(input.request_id, "request_id", 64);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(requestId)) {
    throw new RequestError(400, "invalid_request_id", "The feedback request identifier is invalid.");
  }
  if (input.topic !== "problem" && input.topic !== "idea") throw new RequestError(400, "invalid_topic", "Choose problem or idea.");
  const message = text(input.message, "message", MAX_MESSAGE_LENGTH).trim();
  if (!message) throw new RequestError(400, "missing_message", "Describe the feedback before sending it.");
  if (message.includes("\0")) throw new RequestError(400, "invalid_message", "The feedback message contains unsupported characters.");
  const replyEmail = input.reply_email === undefined ? undefined : email(text(input.reply_email, "reply_email", 320));
  const context = input.context === undefined ? undefined : validateContext(input.context);
  const diagnostics = input.diagnostics === undefined ? undefined : validateDiagnostics(input.diagnostics);
  const screenshot = input.screenshot === undefined ? undefined : validateScreenshot(input.screenshot);
  const turnstileToken = input.turnstile_token === undefined ? undefined : text(input.turnstile_token, "turnstile_token", 2_048);
  return {
    schema_version: 1,
    request_id: requestId,
    topic: input.topic,
    message,
    ...(replyEmail ? { reply_email: replyEmail } : {}),
    ...(context ? { context } : {}),
    ...(diagnostics ? { diagnostics } : {}),
    ...(screenshot ? { screenshot } : {}),
    ...(turnstileToken ? { turnstile_token: turnstileToken } : {})
  };
}

function validateContext(value: unknown): FeedbackSubmission["context"] {
  const input = object(value, "Feedback context must be an object.");
  exactKeys(input, ["collection_name", "application_origin"]);
  const collectionName = input.collection_name === undefined ? undefined : text(input.collection_name, "collection_name", 200).trim();
  let applicationOrigin: string | undefined;
  if (input.application_origin !== undefined) {
    const candidate = text(input.application_origin, "application_origin", 2_048);
    try {
      const parsed = new URL(candidate);
      if ((parsed.protocol !== "https:" && parsed.protocol !== "http:") || parsed.origin !== candidate) throw new Error("not an origin");
      applicationOrigin = parsed.origin;
    } catch {
      throw new RequestError(400, "invalid_application_origin", "The application origin is invalid.");
    }
  }
  if (!collectionName && !applicationOrigin) return undefined;
  return { ...(collectionName ? { collection_name: collectionName } : {}), ...(applicationOrigin ? { application_origin: applicationOrigin } : {}) };
}

function validateDiagnostics(value: unknown): Record<string, unknown> {
  const input = object(value, "Diagnostics must be an object.");
  exactKeys(input, ["schema_version", "product", "surface", "source_view", "build_revision", "environment", "browser", "operating_system", "viewport", "events"]);
  if (input.schema_version !== 1 || input.product !== "mdbase editor" || input.surface !== "connect") {
    throw new RequestError(400, "invalid_diagnostics", "The diagnostic format is invalid.");
  }
  if (!["overview", "storage", "access", "collections", "applications", "computers", "account", "feedback"].includes(String(input.source_view))) {
    throw new RequestError(400, "invalid_diagnostics", "The diagnostic source is invalid.");
  }
  if (input.build_revision !== null && input.build_revision !== undefined && !/^[a-zA-Z0-9._-]{1,64}$/u.test(String(input.build_revision))) {
    throw new RequestError(400, "invalid_diagnostics", "The diagnostic revision is invalid.");
  }
  if (!["production", "staging", "development"].includes(String(input.environment))) throw new RequestError(400, "invalid_diagnostics", "The diagnostic environment is invalid.");
  const browser = text(input.browser, "browser", 40);
  const operatingSystem = text(input.operating_system, "operating_system", 20);
  if (!/^(?:Edge|Firefox|Chrome|Safari) (?:\d+|unknown)$|^Other$/u.test(browser)) throw new RequestError(400, "invalid_diagnostics", "The diagnostic browser is invalid.");
  if (!["Windows", "macOS", "Android", "iOS", "Linux", "Other"].includes(operatingSystem)) throw new RequestError(400, "invalid_diagnostics", "The diagnostic operating system is invalid.");
  if (!["compact", "medium", "wide"].includes(String(input.viewport))) throw new RequestError(400, "invalid_diagnostics", "The diagnostic viewport is invalid.");
  if (!Array.isArray(input.events) || input.events.length > MAX_DIAGNOSTIC_EVENTS) throw new RequestError(400, "invalid_diagnostics", "The diagnostic events are invalid.");
  const events = input.events.map(validateDiagnosticEvent);
  return { ...input, browser, operating_system: operatingSystem, events };
}

function validateDiagnosticEvent(value: unknown): Record<string, unknown> {
  const event = object(value, "A diagnostic event must be an object.");
  exactKeys(event, ["at", "event", "code", "status"]);
  const at = text(event.at, "diagnostic event time", 40);
  if (!Number.isFinite(Date.parse(at))) throw new RequestError(400, "invalid_diagnostics", "A diagnostic event time is invalid.");
  if (event.event !== "management_request_failed" && event.event !== "management_refresh_failed") throw new RequestError(400, "invalid_diagnostics", "A diagnostic event name is invalid.");
  if (!["cancelled", "http_error", "invalid_response", "outcome_unknown", "partial_failure", "timeout", "network_error", "unknown_error"].includes(String(event.code))) {
    throw new RequestError(400, "invalid_diagnostics", "A diagnostic event code is invalid.");
  }
  if (event.status !== undefined && (!Number.isInteger(event.status) || Number(event.status) < 0 || Number(event.status) > 599)) {
    throw new RequestError(400, "invalid_diagnostics", "A diagnostic status is invalid.");
  }
  return { at, event: event.event, code: event.code, ...(event.status === undefined ? {} : { status: event.status }) };
}

function validateScreenshot(value: unknown): FeedbackScreenshot {
  const input = object(value, "Screenshot must be an object.");
  exactKeys(input, ["media_type", "filename", "content_base64"]);
  if (input.media_type !== "image/png" && input.media_type !== "image/jpeg") throw new RequestError(400, "invalid_screenshot", "Choose a PNG or JPEG screenshot.");
  const expectedFilename = input.media_type === "image/png" ? "screenshot.png" : "screenshot.jpg";
  if (input.filename !== expectedFilename) throw new RequestError(400, "invalid_screenshot", "The screenshot filename is invalid.");
  const content = text(input.content_base64, "screenshot content", 4_200_000);
  if (!/^[a-zA-Z0-9+/]*={0,2}$/u.test(content)) throw new RequestError(400, "invalid_screenshot", "The screenshot encoding is invalid.");
  let bytes: Uint8Array;
  try { bytes = Uint8Array.from(atob(content), (character) => character.charCodeAt(0)); } catch { throw new RequestError(400, "invalid_screenshot", "The screenshot encoding is invalid."); }
  if (bytes.byteLength > MAX_SCREENSHOT_BYTES || !isValidRaster(bytes, input.media_type)) {
    throw new RequestError(400, "invalid_screenshot", "The screenshot is invalid or too large.");
  }
  return { media_type: input.media_type, filename: expectedFilename, content_base64: content, bytes };
}

async function verifyTurnstile(fetchImpl: typeof fetch, secret: string, token: string | undefined, origin: string): Promise<void> {
  if (!token) throw new RequestError(400, "verification_required", "Complete the verification before sending feedback.");
  let response: Response;
  try {
    response = await fetchImpl("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ secret, response: token }),
      signal: AbortSignal.timeout(EMAIL_TIMEOUT_MS)
    });
  } catch {
    throw new RequestError(503, "verification_unavailable", "Verification is temporarily unavailable. Please try again.");
  }
  if (!response.ok) throw new RequestError(503, "verification_unavailable", "Verification is temporarily unavailable. Please try again.");
  const result = await response.json().catch(() => null) as { success?: unknown; hostname?: unknown; action?: unknown } | null;
  const expectedHostname = new URL(origin).hostname;
  if (result?.success !== true || result.hostname !== expectedHostname || result.action !== "feedback") {
    throw new RequestError(400, "verification_failed", "Verification failed. Please try again.");
  }
}

async function sendEmail(fetchImpl: typeof fetch, env: FeedbackWorkerEnv, submission: FeedbackSubmission): Promise<void> {
  const attachments: Array<{ filename: string; content: string }> = [];
  if (submission.screenshot) attachments.push({ filename: submission.screenshot.filename, content: submission.screenshot.content_base64 });
  if (submission.diagnostics) attachments.push({ filename: "diagnostics.json", content: stringToBase64(`${JSON.stringify(submission.diagnostics, null, 2)}\n`) });
  const response = await fetchImpl("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.RESEND_API_KEY}`,
      "content-type": "application/json",
      "idempotency-key": `mdbase-feedback/${submission.request_id}`
    },
    body: JSON.stringify({
      from: env.FEEDBACK_FROM,
      to: [env.FEEDBACK_TO],
      subject: submission.topic === "problem" ? "[Problem] mdbase connect feedback" : "[Idea] mdbase connect feedback",
      text: emailBody(submission),
      ...(submission.reply_email ? { reply_to: submission.reply_email } : {}),
      ...(attachments.length > 0 ? { attachments } : {})
    }),
    signal: AbortSignal.timeout(EMAIL_TIMEOUT_MS)
  });
  if (!response.ok) throw new Error("Email provider rejected feedback");
}

function emailBody(submission: FeedbackSubmission): string {
  const lines = [
    `Feedback ID: ${submission.request_id}`,
    `Topic: ${submission.topic}`,
    "",
    submission.message,
    "",
    "Context"
  ];
  lines.push(`Collection: ${submission.context?.collection_name ?? "Not included"}`);
  lines.push(`Application origin: ${submission.context?.application_origin ?? "Not included"}`);
  lines.push(`Reply email: ${submission.reply_email ?? "Not provided"}`);
  lines.push(`Diagnostics: ${submission.diagnostics ? "Attached" : "Not included"}`);
  lines.push(`Screenshot: ${submission.screenshot ? "Attached" : "Not included"}`);
  return `${lines.join("\n")}\n`;
}

async function readBoundedBody(request: Request, maximumBytes: number): Promise<string> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel("feedback payload limit exceeded");
        throw new RequestError(413, "payload_too_large", "The feedback attachment is too large.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    throw new RequestError(400, "invalid_encoding", "Feedback must use UTF-8 encoding.");
  }
}

function configuredOrigins(value: string): Set<string> {
  const origins = value.split(",").map((entry) => entry.trim()).filter(Boolean);
  if (origins.length === 0) throw new Error("No origins configured");
  return new Set(origins.map((entry) => {
    const url = new URL(entry);
    if (url.origin !== entry || (url.protocol !== "https:" && url.hostname !== "127.0.0.1" && url.hostname !== "localhost")) throw new Error("Invalid origin");
    return url.origin;
  }));
}

function validateEmailConfiguration(env: FeedbackWorkerEnv): void {
  if (!env.RESEND_API_KEY || env.RESEND_API_KEY.includes("\n") || env.RESEND_API_KEY.includes("\r")) throw new Error("Invalid API key");
  if (!validMailbox(env.FEEDBACK_TO) || /[\r\n]/u.test(env.FEEDBACK_FROM) || !/^.{1,200}<[^<>]+@[^<>]+>$|^[^<>\s]+@[^<>\s]+$/u.test(env.FEEDBACK_FROM.trim())) throw new Error("Invalid email configuration");
  if (env.TURNSTILE_REQUIRED !== undefined && env.TURNSTILE_REQUIRED !== "0" && env.TURNSTILE_REQUIRED !== "1") throw new Error("Invalid Turnstile policy");
  if (env.TURNSTILE_REQUIRED === "1" && !env.TURNSTILE_SECRET) throw new Error("Turnstile secret is required");
}

function validMailbox(value: string): boolean {
  return value.length <= 320 && !/[\r\n]/u.test(value) && /^[^<>\s@]+@[^<>\s@]+\.[^<>\s@]+$/u.test(value);
}

function email(value: string): string {
  if (!validMailbox(value)) throw new RequestError(400, "invalid_reply_email", "Enter a valid reply email address.");
  return value;
}

function object(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RequestError(400, "invalid_request", message);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: string[]): void {
  const allowedKeys = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) throw new RequestError(400, "unknown_field", "The feedback contains an unsupported field.");
}

function text(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string" || value.length > maxLength) throw new RequestError(400, "invalid_field", `The ${field} field is invalid.`);
  return value;
}

function isValidRaster(bytes: Uint8Array, type: "image/png" | "image/jpeg"): boolean {
  return type === "image/png" ? isValidPng(bytes) : isValidJpeg(bytes);
}

function isValidPng(bytes: Uint8Array): boolean {
  if (bytes.length < 45 || ![137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value)) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8;
  let sawHeader = false;
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    const end = offset + 12 + length;
    if (end > bytes.length) return false;
    if (!sawHeader) {
      if (type !== "IHDR" || length !== 13) return false;
      const width = view.getUint32(offset + 8);
      const height = view.getUint32(offset + 12);
      if (!validImageDimensions(width, height)) return false;
      sawHeader = true;
    }
    if (["eXIf", "iTXt", "tEXt", "zTXt"].includes(type)) return false;
    if (type === "IEND") return sawHeader && length === 0 && end === bytes.length;
    offset = end;
  }
  return false;
}

function isValidJpeg(bytes: Uint8Array): boolean {
  if (bytes.length < 20 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) return false;
  let offset = 2;
  let sawDimensions = false;
  while (offset < bytes.length - 2) {
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset++];
    if (marker === undefined || marker === 0x00) return false;
    if (marker === 0xda) return sawDimensions;
    if (marker === 0xd9) return sawDimensions && offset === bytes.length;
    if (marker >= 0xd0 && marker <= 0xd7) continue;
    if (offset + 2 > bytes.length) return false;
    const length = (bytes[offset] << 8) | bytes[offset + 1];
    if (length < 2 || offset + length > bytes.length) return false;
    if ([0xe1, 0xe2, 0xed, 0xfe].includes(marker)) return false;
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      if (length < 7) return false;
      const height = (bytes[offset + 3] << 8) | bytes[offset + 4];
      const width = (bytes[offset + 5] << 8) | bytes[offset + 6];
      if (!validImageDimensions(width, height)) return false;
      sawDimensions = true;
    }
    offset += length;
  }
  return false;
}

function validImageDimensions(width: number, height: number): boolean {
  return width > 0 && height > 0 && width <= 8_192 && height <= 8_192 && width * height <= 16_000_000;
}

function stringToBase64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 32_768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
  return btoa(binary);
}

function corsHeaders(origin: string): Headers {
  return new Headers({
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "600",
    "cache-control": "no-store",
    vary: "Origin"
  });
}

function json(value: unknown, status = 200, headers = new Headers()): Response {
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(value), { status, headers });
}

function jsonError(status: number, code: string, message: string, headers = new Headers()): Response {
  return json({ error: { code, message } }, status, headers);
}

function safeRevision(value: string | undefined): string {
  return value && /^[0-9a-f]{40}$/u.test(value) ? value : "development";
}
