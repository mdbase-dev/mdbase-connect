import { createPublicKey, verify } from "node:crypto";
import type {
  MdbaseNotification,
  NotificationWebhook
} from "@mdbase-dev/connect-protocol";

export type { MdbaseNotification, NotificationWebhook };

export interface NotificationSigningKey extends JsonWebKey {
  kid: string;
}

export interface VerifyNotificationWebhookOptions {
  /** Exact UTF-8 request body before JSON parsing. */
  body: string;
  headers: Headers | Record<string, string | string[] | undefined>;
  /** Cached keys from `/v1/notifications/webhook-signing-keys`. */
  keys: NotificationSigningKey[];
  /** Override only for deterministic tests. */
  now?: number;
  /** Defaults to five minutes. */
  toleranceSeconds?: number;
}

export class NotificationWebhookVerificationError extends Error {
  constructor(
    readonly code:
      | "missing_header"
      | "invalid_timestamp"
      | "stale_timestamp"
      | "unknown_key"
      | "invalid_signature"
      | "invalid_payload",
    message: string
  ) {
    super(message);
  }
}

export function verifyNotificationWebhook(
  options: VerifyNotificationWebhookOptions
): NotificationWebhook {
  const deliveryId = requiredHeader(options.headers, "mdbase-webhook-id");
  const timestamp = requiredHeader(options.headers, "mdbase-webhook-timestamp");
  const keyId = requiredHeader(options.headers, "mdbase-webhook-key-id");
  const signatureHeader = requiredHeader(
    options.headers,
    "mdbase-webhook-signature"
  );
  if (!/^[0-9]{1,12}$/.test(timestamp)) {
    throw new NotificationWebhookVerificationError(
      "invalid_timestamp",
      "Webhook timestamp is invalid."
    );
  }
  const timestampMs = Number(timestamp) * 1_000;
  const tolerance = (options.toleranceSeconds ?? 300) * 1_000;
  if (Math.abs((options.now ?? Date.now()) - timestampMs) > tolerance) {
    throw new NotificationWebhookVerificationError(
      "stale_timestamp",
      "Webhook timestamp falls outside the replay window."
    );
  }
  const key = options.keys.find((candidate) => candidate.kid === keyId);
  if (
    !key
    || key.kty !== "OKP"
    || key.crv !== "Ed25519"
    || typeof key.x !== "string"
  ) {
    throw new NotificationWebhookVerificationError(
      "unknown_key",
      "Webhook signing key is unknown."
    );
  }
  const match = /^v1=([A-Za-z0-9_-]+)$/.exec(signatureHeader);
  if (!match) {
    throw new NotificationWebhookVerificationError(
      "invalid_signature",
      "Webhook signature header is invalid."
    );
  }
  const signed = `${deliveryId}.${timestamp}.${options.body}`;
  const valid = verify(
    null,
    Buffer.from(signed),
    createPublicKey({
      key: key as unknown as import("node:crypto").JsonWebKey,
      format: "jwk"
    }),
    Buffer.from(match[1], "base64url")
  );
  if (!valid) {
    throw new NotificationWebhookVerificationError(
      "invalid_signature",
      "Webhook signature does not match the request body."
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(options.body);
  } catch {
    throw new NotificationWebhookVerificationError(
      "invalid_payload",
      "Webhook body is not valid JSON."
    );
  }
  const payload = parseWebhook(parsed);
  if (payload.delivery_id !== deliveryId) {
    throw new NotificationWebhookVerificationError(
      "invalid_payload",
      "Webhook delivery ID does not match its signed header."
    );
  }
  return payload;
}

function parseWebhook(value: unknown): NotificationWebhook {
  if (
    !record(value)
    || !hasOnlyKeys(value, [
      "type",
      "version",
      "delivery_id",
      "connection_id",
      "notification"
    ])
  ) invalidPayload();
  const notification = value.notification;
  if (
    value.type !== "mdbase.notification.webhook"
    || value.version !== 1
    || typeof value.delivery_id !== "string"
    || typeof value.connection_id !== "string"
    || !record(notification)
    || !hasOnlyKeys(notification, [
      "type",
      "version",
      "signal_id",
      "criterion_id",
      "cursor",
      "presentation"
    ])
    || notification.type !== "mdbase.notification"
    || notification.version !== 1
    || typeof notification.signal_id !== "string"
    || typeof notification.criterion_id !== "string"
    || typeof notification.cursor !== "string"
    || !record(notification.presentation)
    || !hasOnlyKeys(notification.presentation, ["title", "body", "tag"])
    || typeof notification.presentation.title !== "string"
    || (
      notification.presentation.body !== undefined
      && typeof notification.presentation.body !== "string"
    )
    || (
      notification.presentation.tag !== undefined
      && typeof notification.presentation.tag !== "string"
    )
  ) {
    invalidPayload();
  }
  return value as unknown as NotificationWebhook;
}

function requiredHeader(
  headers: VerifyNotificationWebhookOptions["headers"],
  name: string
): string {
  const value = headers instanceof Headers
    ? headers.get(name)
    : Object.entries(headers).find(
        ([candidate]) => candidate.toLowerCase() === name
      )?.[1];
  const normalized = Array.isArray(value) ? value[0] : value;
  if (!normalized) {
    throw new NotificationWebhookVerificationError(
      "missing_header",
      `Missing ${name} header.`
    );
  }
  return normalized;
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  keys: string[]
): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function invalidPayload(): never {
  throw new NotificationWebhookVerificationError(
    "invalid_payload",
    "Webhook body is not an mdbase notification."
  );
}
