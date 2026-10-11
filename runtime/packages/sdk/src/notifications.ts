/**
 * `@mdbase-dev/sdk/notifications`: the mdbase push delivery envelope
 * (`docs/contracts/push-envelope.md`) and service-worker helpers.
 *
 * The envelope is opaque. It carries a dedupe key, an opaque wake cursor, the
 * app's own manifest criterion id and the criterion's static presentation. It
 * never carries record, timer or collection identifiers or app data. Treat the
 * presentation as untrusted text and a push as a wake-up hint: on wake, the app
 * reads current state through its connection.
 *
 * This module imports no Worker, wasm or client code, so a service worker can
 * import it on its own.
 */
import { MdbaseError, mdbaseError } from "./errors.js";

export const MDBASE_NOTIFICATION_TYPE = "mdbase.notification";
/** The message `handleMdbaseNotificationClick` posts to the app window it focuses. */
export const MDBASE_NOTIFICATION_CLICK = "mdbase.notification.click";

export interface MdbaseNotificationPresentation {
  title: string;
  body?: string;
  tag?: string;
}

/** A validated envelope. */
export interface MdbaseNotification {
  version: 1;
  /** Idempotency key: the same signal may be delivered more than once. */
  signalId: string;
  /** The app's manifest criterion id. Its meaning is the app's own. */
  criterionId: string;
  /** Opaque wake cursor. Never parse it. */
  cursor: string;
  /** Static manifest text. `null` for native data, where the OS shows the text. */
  presentation: MdbaseNotificationPresentation | null;
}

export interface MdbaseNotificationClickMessage {
  type: typeof MDBASE_NOTIFICATION_CLICK;
  notification: MdbaseNotification;
}

export interface MdbaseNotificationDisplayOptions {
  icon?: string;
  badge?: string;
}

/** The parts of a `ServiceWorkerRegistration` the helpers use. */
export interface MdbaseNotificationRegistration {
  readonly scope?: string;
  showNotification(title: string, options?: NotificationOptions): Promise<void>;
}

/** The parts of a service-worker `PushEvent` the helpers use. */
export interface MdbasePushEvent {
  readonly data: { text(): string } | null;
  waitUntil(promise: Promise<unknown>): void;
}

/** The parts of a service-worker `NotificationEvent` the helpers use. */
export interface MdbaseNotificationClickEvent {
  readonly notification: { readonly data: unknown; close(): void };
  waitUntil(promise: Promise<unknown>): void;
}

interface WindowClientLike {
  readonly url: string;
  focus(): Promise<unknown>;
  postMessage(message: unknown): void;
}
/** The parts of a service worker's `Clients` the helpers use. */
export interface MdbaseNotificationClients {
  matchAll(options: { type: "window"; includeUncontrolled: boolean }): Promise<readonly WindowClientLike[]>;
  openWindow(url: string): Promise<unknown>;
}

export interface HandleMdbasePushOptions extends MdbaseNotificationDisplayOptions {
  /** Defaults to the service worker's own `registration`. */
  registration?: MdbaseNotificationRegistration;
}

export interface HandleMdbaseNotificationClickOptions {
  /** The page to open when no app window is open. Defaults to the registration scope. */
  url?: string;
  /** Defaults to the service worker's own `clients`. */
  clients?: MdbaseNotificationClients;
  /** Defaults to the service worker's own `registration.scope`. */
  scope?: string;
}

// Visible ASCII: today `tmr_` + base64url for timers; connector signals may differ.
const OPAQUE = /^[\x21-\x7e]{1,256}$/;
const CRITERION = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;

const invalid = (message: string) => mdbaseError("invalid_request", message, "invalid_push_payload");
const unsupported = () =>
  mdbaseError("upgrade_required", "The push uses an envelope version this SDK does not support.", "unsupported_push_version");

function object(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { throw invalid("The push payload is not JSON."); }
  } else if (value && typeof value === "object" && typeof (value as { json?: unknown }).json === "function") {
    try { value = (value as { json(): unknown }).json(); } catch { throw invalid("The push payload is not JSON."); }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid("The push payload is not an object.");
  return value as Record<string, unknown>;
}

function text(value: unknown, min: number, max: number): value is string {
  return typeof value === "string" && value.length >= min && value.length <= max;
}

function presentation(value: unknown): MdbaseNotificationPresentation | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const p = value as Record<string, unknown>;
  if (!text(p.title, 1, 80) || (p.body !== undefined && !text(p.body, 0, 160))
    || (p.tag !== undefined && !text(p.tag, 1, 80))) return null;
  return Object.freeze({
    title: p.title,
    ...(typeof p.body === "string" && p.body.length ? { body: p.body } : {}),
    ...(typeof p.tag === "string" ? { tag: p.tag } : {}),
  });
}

function envelope(raw: Record<string, unknown>, version: unknown, shown: MdbaseNotificationPresentation | null): MdbaseNotification {
  if (raw.type !== MDBASE_NOTIFICATION_TYPE) throw invalid("The payload is not an mdbase notification.");
  if (version !== 1) {
    if (typeof version === "number" && Number.isSafeInteger(version) && version > 1) throw unsupported();
    throw invalid("The payload has no valid envelope version.");
  }
  if (!text(raw.signal_id, 1, 256) || !OPAQUE.test(raw.signal_id) || !text(raw.cursor, 1, 256) || !OPAQUE.test(raw.cursor)
    || !text(raw.criterion_id, 1, 100) || !CRITERION.test(raw.criterion_id)) {
    throw invalid("The payload is not an mdbase notification.");
  }
  // Unknown fields are ignored: v1 may gain optional fields.
  return Object.freeze({ version: 1, signalId: raw.signal_id, criterionId: raw.criterion_id, cursor: raw.cursor, presentation: shown });
}

/** Parse a Web Push payload: an object, a JSON string or `PushMessageData`. */
export function parseMdbasePush(value: unknown): MdbaseNotification {
  const raw = object(value);
  const result = envelope(raw, raw.version, presentation(raw.presentation));
  if (!result.presentation) throw invalid("The push has no valid presentation.");
  return result;
}

/** Parse the string-valued data of an FCM/APNs notification (`version` "1" or 1). */
export function parseMdbaseNativeNotification(data: unknown): MdbaseNotification {
  if (!data || typeof data !== "object" || Array.isArray(data)) throw invalid("The native notification data is not an object.");
  const raw = data as Record<string, unknown>;
  const version = typeof raw.version === "string" && /^[1-9][0-9]{0,8}$/.test(raw.version) ? Number(raw.version) : raw.version;
  return envelope(raw, version, null);
}

/** Read the envelope kept on a shown notification, or on a native tap. `null` if it is not one. */
export function readMdbaseNotificationData(data: unknown): MdbaseNotification | null {
  try { return parseMdbaseNativeNotification(data); } catch { return null; }
}

/** The `data` kept on a shown notification. Same shape as prod Connect builds. */
function shownData(n: MdbaseNotification) {
  return { type: MDBASE_NOTIFICATION_TYPE, version: n.version, signal_id: n.signalId, criterion_id: n.criterionId, cursor: n.cursor };
}

/** Validate a Web Push payload and show it. Resolves with the envelope. */
export async function showMdbaseNotification(
  registration: MdbaseNotificationRegistration,
  value: unknown,
  options: MdbaseNotificationDisplayOptions = {},
): Promise<MdbaseNotification> {
  const n = parseMdbasePush(value);
  const p = n.presentation!;
  await registration.showNotification(p.title, {
    ...(p.body ? { body: p.body } : {}),
    ...(p.tag ? { tag: p.tag } : {}),
    ...(options.icon ? { icon: options.icon } : {}),
    ...(options.badge ? { badge: options.badge } : {}),
    data: shownData(n),
  });
  return n;
}

function own<T>(name: "registration" | "clients"): T | undefined {
  return (globalThis as Record<string, unknown>)[name] as T | undefined;
}

/** The service worker's own origin (its location, else its registration scope). */
function workerOrigin(registrationScope: string | undefined): string | null {
  const location = (globalThis as { location?: { origin?: unknown } }).location;
  if (typeof location?.origin === "string" && location.origin !== "null") return location.origin;
  try { return registrationScope ? new URL(registrationScope).origin : null; } catch { return null; }
}

/** Click `url`/`scope` must stay on the app's own origin. Without a known
 * origin only a root-relative path is accepted. */
function sameOrigin(value: string, origin: string | null, name: "url" | "scope"): string {
  const reject = () => mdbaseError("invalid_request", `The notification click ${name} must be on the app's own origin.`, "click_target_cross_origin");
  if (typeof value !== "string") throw reject();
  if (origin === null) {
    if (!value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) throw reject();
    return value;
  }
  let url: URL;
  try { url = new URL(value, `${origin}/`); } catch { throw reject(); }
  if (url.origin !== origin) throw reject();
  return url.href;
}

/**
 * A service-worker `push` handler. Returns `false` for a push that is not an
 * mdbase notification, so the app can handle its own pushes. Otherwise it
 * shows the notification inside `event.waitUntil` and returns `true`.
 */
export function handleMdbasePush(event: MdbasePushEvent, options: HandleMdbasePushOptions = {}): boolean {
  let raw: Record<string, unknown>;
  try { raw = object(event.data?.text() ?? null); } catch { return false; }
  if (raw.type !== MDBASE_NOTIFICATION_TYPE) return false;
  const registration = options.registration ?? own<MdbaseNotificationRegistration>("registration");
  if (!registration) throw mdbaseError("invalid_request", "No service worker registration to show the notification.", "push_registration_missing");
  const display = { ...(options.icon ? { icon: options.icon } : {}), ...(options.badge ? { badge: options.badge } : {}) };
  event.waitUntil((async () => {
    try {
      parseMdbasePush(raw);
    } catch (error) {
      // Only a NEWER envelope major falls back: it still carries a displayable
      // presentation, shown without data rather than a browser's generic
      // "updated in the background". Malformed v1 stays rejected.
      const shown = error instanceof MdbaseError && error.reason === "unsupported_push_version" ? presentation(raw.presentation) : null;
      if (!shown) throw error;
      await registration.showNotification(shown.title, {
        ...(shown.body ? { body: shown.body } : {}),
        ...(shown.tag ? { tag: shown.tag } : {}),
        ...display,
      });
      return null;
    }
    // Display failures propagate; they are not a compatibility case.
    return showMdbaseNotification(registration, raw, display);
  })());
  return true;
}

/**
 * A service-worker `notificationclick` handler. Returns `false` for a
 * notification that is not an mdbase one. Otherwise it closes it, focuses an
 * open app window (posting `MdbaseNotificationClickMessage` to it) or opens
 * `url`, and returns `true`.
 */
export function handleMdbaseNotificationClick(
  event: MdbaseNotificationClickEvent,
  options: HandleMdbaseNotificationClickOptions = {},
): boolean {
  const n = readMdbaseNotificationData(event.notification.data);
  if (!n) return false;
  event.notification.close();
  const clients = options.clients ?? own<MdbaseNotificationClients>("clients");
  const registrationScope = own<MdbaseNotificationRegistration>("registration")?.scope;
  const origin = workerOrigin(registrationScope);
  const scope = options.scope === undefined ? registrationScope : sameOrigin(options.scope, origin, "scope");
  const target = options.url === undefined ? scope ?? "/" : sameOrigin(options.url, origin, "url");
  if (!clients) return true;
  event.waitUntil((async () => {
    const windows = await clients.matchAll({ type: "window", includeUncontrolled: true });
    const open = windows.find(client => !scope || client.url.startsWith(scope));
    if (!open) return clients.openWindow(target);
    await open.focus();
    const message: MdbaseNotificationClickMessage = { type: MDBASE_NOTIFICATION_CLICK, notification: n };
    open.postMessage(message);
    return open;
  })());
  return true;
}
