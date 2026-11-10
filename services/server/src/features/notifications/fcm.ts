import { GoogleAuth, type GoogleAuthOptions } from "google-auth-library";
import {
  PushDeliveryError,
  type FcmPushTarget,
  type FcmPushTransport
} from "./notifications.js";

const FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";

interface AccessTokenProvider {
  getAccessToken(): Promise<string | null | undefined>;
}

interface FcmPayload {
  type: "mdbase.notification";
  version: 1;
  signal_id: string;
  criterion_id: string;
  cursor: string;
  presentation: {
    title: string;
    body?: string;
    tag?: string;
  };
}

export interface FcmTransportOptions {
  credentials?: GoogleAuthOptions["credentials"];
  auth?: AccessTokenProvider;
  fetch?: typeof globalThis.fetch;
}

export class FcmTransport implements FcmPushTransport {
  private readonly auth: AccessTokenProvider;
  private readonly fetcher: typeof globalThis.fetch;

  constructor(options: FcmTransportOptions = {}) {
    this.auth = options.auth ?? new GoogleAuth({
      scopes: [FCM_SCOPE],
      ...(options.credentials ? { credentials: options.credentials } : {})
    });
    this.fetcher = options.fetch ?? globalThis.fetch;
  }

  async send(target: FcmPushTarget, serializedPayload: string): Promise<void> {
    const payload = JSON.parse(serializedPayload) as FcmPayload;
    const accessToken = await this.auth.getAccessToken();
    if (!accessToken) {
      throw new PushDeliveryError("FCM did not issue an access token.");
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    let response: Response;
    try {
      response = await this.fetcher(
        `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(target.projectId)}/messages:send`,
        {
          method: "POST",
          redirect: "error",
          signal: controller.signal,
          headers: {
            authorization: `Bearer ${accessToken}`,
            "content-type": "application/json"
          },
          body: JSON.stringify({
            message: {
              token: target.token,
              notification: {
                title: payload.presentation.title,
                ...(payload.presentation.body ? { body: payload.presentation.body } : {})
              },
              data: {
                type: payload.type,
                version: String(payload.version),
                signal_id: payload.signal_id,
                criterion_id: payload.criterion_id,
                cursor: payload.cursor
              },
              android: {
                priority: "high",
                notification: {
                  channel_id: "mdbase-updates",
                  ...(payload.presentation.tag ? { tag: payload.presentation.tag } : {})
                }
              },
              apns: {
                headers: {
                  "apns-push-type": "alert",
                  "apns-priority": "10"
                },
                payload: {
                  aps: {
                    ...(payload.presentation.tag
                      ? { "thread-id": payload.presentation.tag }
                      : {})
                  }
                }
              }
            }
          })
        }
      );
    } catch (error) {
      throw new PushDeliveryError(
        error instanceof Error ? `FCM request failed: ${error.message}` : "FCM request failed."
      );
    } finally {
      clearTimeout(timeout);
    }
    if (response.ok) return;
    const body = await response.text();
    const code = fcmErrorCode(body);
    const permanent = code === "UNREGISTERED" || code === "SENDER_ID_MISMATCH";
    const retryAfterMs = retryAfter(response.headers.get("retry-after"));
    throw new PushDeliveryError(
      `FCM returned HTTP ${response.status}${code ? ` (${code})` : ""}.`,
      permanent,
      retryAfterMs
    );
  }
}

function fcmErrorCode(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as {
      error?: {
        status?: string;
        details?: Array<{ errorCode?: string }>;
      };
    };
    return parsed.error?.details?.find((detail) => detail.errorCode)?.errorCode
      ?? parsed.error?.status;
  } catch {
    return undefined;
  }
}

function retryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  if (/^[0-9]+$/.test(value)) return Number(value) * 1_000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}
