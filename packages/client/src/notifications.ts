import { connectError } from "./errors.js";

export interface MdbaseNotificationRegistrationOptions {
  serviceWorker: ServiceWorkerRegistration;
  /** Manifest criterion IDs to enable. Omit to enable every declared criterion. */
  criteria?: string[];
  /** Stable per-installation ID. The SDK persists one when omitted. */
  installationId?: string;
}

export interface MdbaseNotificationRegistration {
  channelId: string;
  installationId: string;
  criteria: string[];
}

export interface MdbaseNativeNotificationRegistrationOptions {
  /** Current FCM registration token. Refresh by calling this method again. */
  token: string;
  /** Manifest criterion IDs to enable. Omit to enable every declared criterion. */
  criteria?: string[];
  /** Stable per-installation ID. The SDK persists one when omitted. */
  installationId?: string;
}

export interface MdbaseNativeNotificationRegistration
  extends MdbaseNotificationRegistration {
  transport: "fcm";
}

export interface MdbaseNativeNotificationData {
  type: "mdbase.notification";
  version: 1;
  signal_id: string;
  criterion_id: string;
  cursor: string;
}

export interface MdbasePushPayload {
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

export function parseMdbasePushPayload(value: unknown): MdbasePushPayload {
  if (!value || typeof value !== "object") {
    throw connectError("invalid_push_payload", "The push payload is not an object.");
  }
  const payload = value as Partial<MdbasePushPayload>;
  if (
    payload.type !== "mdbase.notification"
    || payload.version !== 1
    || typeof payload.signal_id !== "string"
    || typeof payload.criterion_id !== "string"
    || typeof payload.cursor !== "string"
    || !payload.presentation
    || typeof payload.presentation.title !== "string"
  ) {
    throw connectError("invalid_push_payload", "The push payload is not an mdbase notification.");
  }
  return payload as MdbasePushPayload;
}

/** Parse the string-valued data attached to an APNs/FCM notification. */
export function parseMdbaseNativeNotificationData(
  value: unknown
): MdbaseNativeNotificationData {
  if (!value || typeof value !== "object") {
    throw connectError(
      "invalid_push_payload",
      "The native notification data is not an object."
    );
  }
  const data = value as Record<string, unknown>;
  if (
    data.type !== "mdbase.notification"
    || (data.version !== 1 && data.version !== "1")
    || typeof data.signal_id !== "string"
    || typeof data.criterion_id !== "string"
    || typeof data.cursor !== "string"
  ) {
    throw connectError(
      "invalid_push_payload",
      "The native notification data is not an mdbase notification."
    );
  }
  return {
    type: "mdbase.notification",
    version: 1,
    signal_id: data.signal_id,
    criterion_id: data.criterion_id,
    cursor: data.cursor
  };
}

/** Display a validated mdbase push from a service worker `push` handler. */
export function showMdbasePushNotification(
  registration: Pick<ServiceWorkerRegistration, "showNotification">,
  value: unknown
): Promise<void> {
  const payload = parseMdbasePushPayload(value);
  return registration.showNotification(payload.presentation.title, {
    ...(payload.presentation.body ? { body: payload.presentation.body } : {}),
    ...(payload.presentation.tag ? { tag: payload.presentation.tag } : {}),
    data: {
      type: payload.type,
      signal_id: payload.signal_id,
      criterion_id: payload.criterion_id,
      cursor: payload.cursor
    }
  });
}
