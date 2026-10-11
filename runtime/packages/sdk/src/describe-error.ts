/**
 * Shared user-facing copy for SDK errors, sign-in/open problems and readiness.
 *
 * Plain language plus one suggested action. Never returns raw codes, server
 * messages or exception text. English for now: translate by `key`.
 * No Worker, wasm or network imports, so it is safe in any bundle.
 * Every server-provided field is untrusted: only known codes select copy,
 * retry delays are clamped and update links are allowlisted.
 */
import { registrationRefusal, registrationRefusalMessage } from "./application/registration-refusal.js";
import { isCollectionUnavailableReason, type CollectionUnavailableReason } from "./collection-availability.js";
import { DEFAULT_UPDATE_URL, MAX_SERVER_RETRY_MS, MIN_SERVER_RETRY_MS, sanitizeAppServerProblem, trustedUpdateUrl } from "./app-host/cp-problem.js";

export type MdbaseErrorAction =
  | "retry" | "wait" | "reload" | "sign_in" | "approve" | "choose_collection" | "set_up"
  | "update_app" | "free_space" | "check_connection" | "resolve_outcome" | "contact_support" | "none";

export interface MdbaseErrorDescription {
  /** Stable id for translation and analytics, e.g. "collection_migrating". */
  readonly key: string;
  readonly title: string;
  readonly message: string;
  readonly action: MdbaseErrorAction;
  readonly actionLabel: string | null;
  /** Server-directed wait, clamped to 5 s..10 min. */
  readonly retryAfterMs: number | null;
  /** Set with action `update_app`: the server's https link when it is on
   * mdbase.dev or the declared CP origin, otherwise the mdbase downloads page. */
  readonly updateUrl: string | null;
  readonly severity: "info" | "warning" | "error";
  /** True when the SDK clears it by itself (busy, migrating); apps may show it quietly. */
  readonly transient: boolean;
  /** The original code, for logs and support only. Do not show it as the message. */
  readonly code: string;
  /** Plain detail for the app's developer (logs, developer consoles), never for
   * end users. Built only from typed codes and manifest paths; null when none. */
  readonly developerMessage: string | null;
}

type Entry = readonly [title: string, message: string, action: MdbaseErrorAction, severity: MdbaseErrorDescription["severity"], transient?: boolean];

const LABELS: Record<MdbaseErrorAction, string | null> = {
  retry: "Try again", wait: null, reload: "Reload", sign_in: "Sign in", approve: "Approve",
  choose_collection: "Choose a collection", set_up: "Set up", update_app: "Update the app",
  free_space: "Manage storage", check_connection: "Try again", resolve_outcome: "Check and try again",
  contact_support: "Contact support", none: null,
};

const SUPERSEDED_ID_NOTE = "The declared application ID is not the ID mdbase registered for this manifest (a changed manifest gets a new ID). The SDK uses the registered ID and keeps the declared storage names. Update the declared ID to the registered one to remove this note.";
const GENERIC: Entry = ["Something went wrong", "An unexpected problem occurred. Reload the app, and contact support if it keeps happening.", "reload", "error"];
const BUSY: Entry = ["Just a moment", "The app is finishing another step.", "wait", "info", true];
const OFFLINE: Entry = ["Can't connect right now", "mdbase couldn't be reached. Check your connection and try again.", "check_connection", "warning"];
const UPDATE: Entry = ["Update required", "Your collection now uses a newer version of mdbase. Update the app to keep using it.", "update_app", "warning"];
const CHOOSE: Entry = ["Choose a collection", "Pick the collection you want this app to use.", "choose_collection", "info"];
const APPROVE: Entry = ["Approval needed", "This app needs your approval for extra access to your collection.", "approve", "info"];
const ASSETS: Entry = ["The app couldn't load", "Some of the app's files couldn't be loaded. Check your connection and reload.", "reload", "error"];

// Private collections served by one of the account's computers (collection availability).
const DEVICE_OFFLINE: Entry = ["Your computer isn't online", "Open the mdbase desktop app on a computer that has this collection. The app connects as soon as it's online.", "wait", "info", true];
const DESKTOP_UPDATE: Entry = ["Update mdbase on your computer", "Update the mdbase desktop app on the computer that has this collection, then try again.", "update_app", "warning"];
const OLD_CONNECTOR: Entry = ["Quit the old mdbase Connect app", "The old mdbase Connect app is still running on the computer that has this collection. Quit it, then open the mdbase desktop app.", "retry", "warning"];
const DEVICE_APPROVAL: Entry = ["Approve this app on your computer", "Open the mdbase desktop app on a computer that has this collection and approve this app. The app connects once you approve it.", "wait", "info", true];
const SYNC_REQUIRED: Entry = ["Give this app access again", "This collection has changed since this app was given access. Approve the app for it again to keep using it.", "approve", "warning"];
const ACCESS_REMOVED: Entry = ["You no longer have access", "You were removed from this collection, so this app can't open it. Ask the collection's owner to add you again.", "none", "warning"];
const NO_DEVICE: Entry = ["Open this collection on your computer", "Open this collection in the mdbase desktop app on one of your computers first, then try again.", "retry", "info"];

const COPY: Readonly<Record<string, Entry>> = Object.assign(Object.create(null) as Record<string, Entry>, {
  // Collection availability. `approval_required` has its own key because the readiness
  // facet of the same name means approval in the portal, not on a computer.
  device_offline: DEVICE_OFFLINE,
  no_device_online: DEVICE_OFFLINE,
  desktop_update_required: DESKTOP_UPDATE,
  old_connector_running: OLD_CONNECTOR,
  sync_required: SYNC_REQUIRED,
  no_device_registered: NO_DEVICE,
  access_removed: ACCESS_REMOVED,
  collection_deleted: ["Collection deleted", "Its owner deleted this collection, so it can't be opened any more.", "none", "info"],
  device_approval_required: DEVICE_APPROVAL,
  // Server outcomes.
  collection_migrating: ["Your collection is being upgraded", "This usually takes a few minutes. The app will reconnect by itself when it's done.", "wait", "info", true],
  account_suspended: ["Your account is suspended", "Your mdbase account has been suspended, so this app can't open your collections. Contact mdbase support for help.", "contact_support", "error"],
  update_required: UPDATE,
  upgrade_required: UPDATE,
  // MdbaseError codes.
  invalid_request: ["Couldn't do that", "Some of the information isn't valid. Check it and try again.", "none", "warning"],
  invalid_record: ["Couldn't save that", "Some fields aren't valid. Check them and try again.", "none", "warning"],
  not_found: ["Not found", "This item no longer exists. It may have been deleted on another device.", "none", "info"],
  conflict: ["Changed somewhere else", "This item was changed on another device. Review the latest version and try again.", "retry", "warning"],
  unauthenticated: ["Sign in again", "Your session has ended. Sign in again to continue.", "sign_in", "warning"],
  forbidden: ["Access needed", "This app doesn't have permission to do that. Approve access to continue.", "approve", "warning"],
  collection_invalid: ["Your collection needs repair", "Something in this collection isn't valid. Contact support if this keeps happening.", "contact_support", "error"],
  unavailable: OFFLINE,
  rate_limited: ["Too many requests", "Wait a moment, then try again.", "retry", "warning", true],
  quota_exceeded: ["Out of storage", "Your collection has reached its storage limit. Free up space to keep saving.", "free_space", "error"],
  too_large: ["That's too large", "This item is larger than mdbase allows.", "none", "warning"],
  outcome_unknown: ["Not sure that worked", "The connection dropped before mdbase confirmed it. Check whether it went through before trying again.", "resolve_outcome", "warning"],
  cancelled: ["Cancelled", "The action was cancelled.", "none", "info"],
  internal: GENERIC,
  // Sign-in and open.
  refused: ["Sign-in didn't go through", "mdbase didn't accept this sign-in. Try signing in again.", "sign_in", "warning"],
  expired: ["Sign-in timed out", "The sign-in request expired. Start again to get a new one.", "sign_in", "warning"],
  account_confirmation_required: ["Confirm your account", "Confirm which mdbase account to use, then continue.", "sign_in", "info"],
  recovery_required: ["Reload required", "The app stopped to keep your data safe. Reload to continue.", "reload", "error"],
  open_failed: ["Couldn't open your collection", "Something went wrong while opening it. Reload the app to try again.", "reload", "error"],
  response: GENERIC,
  binding: GENERIC,
  fenced: BUSY,
  busy: BUSY,
  // Application entry.
  application_popup_blocked: ["Allow pop-ups to sign in", "Your browser blocked the sign-in window. Allow pop-ups for this site, then try again.", "retry", "warning"],
  application_not_yet_available: ["Not available yet", "This app isn't available on this version of mdbase yet.", "none", "info"],
  application_declaration: GENERIC,
  application_registration_unsupported: ["This app can't connect", "This version of the app isn't supported by mdbase. Update the app.", "update_app", "error"],
  application_registration_refused: ["This app can't connect", "This app can't connect right now. Contact the app's developer.", "contact_support", "error"],
  // Developer note only: registration succeeded under the CP's id. Apps should not show it.
  application_registration_id_superseded: ["Connected", "This app is connected.", "none", "info", true],
  application_registration_unknown: OFFLINE,
  application_selection_not_approved: ["Collection not approved", "This app hasn't been given access to that collection. Approve it to continue.", "approve", "info"],
  application_selection_empty: CHOOSE,
  application_selection_invalid: CHOOSE,
  application_selection_duplicate: CHOOSE,
  application_selection_metadata: CHOOSE,
  application_lab_trust_unavailable: ASSETS,
  application_production_trust_unavailable: ASSETS,
  application_packaged_assets_unavailable: ASSETS,
  application_asset_fetch: ASSETS,
  application_closing: ["Closing", "The app is closing this connection.", "none", "info", true],
  // Readiness.
  setup_required: ["Set up this collection", "This collection needs a one-time setup before the app can use it.", "set_up", "info"],
  incompatible: ["This collection isn't compatible", "This collection uses a format this version of the app doesn't support. Update the app.", "update_app", "error"],
  capability_missing: APPROVE,
  approval_required: APPROVE,
  grant_required: APPROVE,
  contract_mismatch: ["Your collection's format differs", "This collection's record types don't match what this app expects. Set it up again or update the app.", "set_up", "warning"],
  contract_missing: ["Set up this collection", "This collection is missing record types this app needs. Set it up to continue.", "set_up", "info"],
  notifications_consent_required: ["Allow reminders", "Approve notifications so reminders can reach this device.", "approve", "info"],
  timer_channel_reapproval_required: ["Allow reminders again", "Approve notifications again so reminders keep reaching this device.", "approve", "info"],
  notifications_unsupported: ["Reminders aren't available here", "This browser or device can't receive notifications.", "none", "info"],
  people_unsupported: ["Sharing isn't available here", "People and sharing aren't supported for this collection yet.", "none", "info"],
  configuration_conflict: ["Settings changed elsewhere", "These settings were changed on another device. Review them and try again.", "retry", "warning"],
  configuration_changed: ["Settings changed elsewhere", "These settings were changed on another device. Review them and try again.", "retry", "warning"],
  // Collection delete.
  collection_delete_name_mismatch: ["The name doesn't match", "Type the collection's current name exactly to delete it.", "none", "warning"],
  collection_delete_not_owner: ["Only the owner can delete this", "Ask the collection's owner to delete it.", "none", "info"],
  collection_delete_not_found: ["Collection not found", "This collection no longer exists, or this app can't reach it. It may already have been deleted.", "none", "info"],
  collection_delete_frozen: ["Can't delete right now", "Your account is being upgraded, so collections can't be deleted until that finishes. Try again later.", "retry", "warning"],
  collection_delete_busy: ["mdbase is busy", "Wait a moment, then try deleting again.", "retry", "warning", true],
  collection_delete_not_approved: ["This app can't delete this collection", "This app doesn't have access to this collection anymore. Approve it again, then try again.", "approve", "warning"],
  collection_delete_sign_in: ["Sign in again", "This device's sign-in is no longer current. Sign in again, then try deleting again.", "sign_in", "warning"],
  collection_delete_invalid: ["Couldn't delete the collection", "Check the name you typed and try again.", "none", "warning"],
  collection_delete_outcome_unknown: ["Not sure the collection was deleted", "The connection dropped before mdbase confirmed. Reload your collections to check before trying again.", "resolve_outcome", "warning"],
  collection_delete_failed: ["Couldn't delete the collection", "Something went wrong. Try again, and contact support if it keeps happening.", "retry", "error"],
} satisfies Record<string, Entry>);

/** Server reasons that mean the same outcome. */
const ALIASES: Readonly<Record<string, string>> = Object.assign(Object.create(null) as Record<string, string>, {
  moved_to_next_runtime: "update_required", collection_moved: "update_required", client_update_required: "update_required",
});

const NAME = /^[a-z][a-z0-9_-]{0,127}$/;
const str = (v: unknown): string | null => typeof v === "string" && NAME.test(v) ? v : null;
const obj = (v: unknown): Record<string, unknown> | null => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null;
const retry = (v: unknown): number | null => typeof v === "number" && Number.isFinite(v) && v >= 0
  ? Math.min(MAX_SERVER_RETRY_MS, Math.max(MIN_SERVER_RETRY_MS, Math.round(v))) : null;

function lookup(code: string): [string, Entry] | null {
  const aliased = Object.hasOwn(ALIASES, code) ? ALIASES[code]! : code;
  if (Object.hasOwn(COPY, aliased)) return [aliased, COPY[aliased]!];
  for (const prefix of ["readiness_", "application_"]) {
    if (aliased.startsWith(prefix)) { const rest = aliased.slice(prefix.length); if (Object.hasOwn(COPY, rest)) return [rest, COPY[rest]!]; }
  }
  return null;
}

function fallback(code: string): [string, Entry] {
  if (/_(fenced|busy)$/.test(code)) return ["busy", BUSY];
  if (/_unavailable$/.test(code)) return ["unavailable", OFFLINE];
  if (/_stop_failed$/.test(code)) return ["recovery_required", COPY.recovery_required!];
  if (/_popup_/.test(code)) return ["sign_in_window", ["Sign-in window problem", "The sign-in window couldn't be opened. Try again.", "retry", "warning"]];
  if (/_asset_/.test(code)) return ["assets", ASSETS];
  return ["unknown", GENERIC];
}

interface Problem { codes: string[]; retryAfterMs: number | null; updateUrl: string | null; refusal?: ReturnType<typeof registrationRefusal> }

function availabilityReason(o: Record<string, unknown>): CollectionUnavailableReason | null {
  const details = o.details;
  if (details instanceof Map && isCollectionUnavailableReason(details.get("availability"))) return details.get("availability") as CollectionUnavailableReason;
  const value = obj(o.availability) ?? (o.state === "unavailable" ? o : null);
  return value && value.state === "unavailable" && isCollectionUnavailableReason(value.reason) ? value.reason : null;
}

/** Find the problem in any SDK shape: a code, an error, a public snapshot or a facet. */
function problemOf(input: unknown, cpOrigin: string | null): Problem | null {
  const code = str(input);
  if (code) return {codes: [code], retryAfterMs: null, updateUrl: null};
  const o = obj(input);
  if (!o) return null;
  try {
    // Server detail counts only if it re-validates as a sanitized SDK problem.
    const detail = obj(o.problemDetail), server = sanitizeAppServerProblem(o.server ?? detail?.server, cpOrigin);
    const serverCodes = [server?.reason ?? null, server?.code ?? null].filter((c): c is string => c !== null);
    const extra = {retryAfterMs: server?.retryAfterMs ?? retry(o.retryAfterMs), updateUrl: trustedUpdateUrl(server?.updateUrl, cpOrigin)};
    // Snapshot or facet: { problem: string | {code}, readiness?, assessment?, status? }.
    if ("problem" in o || "readiness" in o || "assessment" in o) {
      const own = str(o.problem) ?? str(obj(o.problem)?.code);
      if (own) return {codes: [...serverCodes, own], ...extra, refusal: registrationRefusal(detail?.registration)};
      const readiness = obj(o.readiness) ?? o;
      const assessment = obj(readiness.assessment);
      const facet = str(obj(readiness.problem)?.code) ?? str(obj(assessment?.problem)?.code);
      if (facet) return {codes: [facet], ...extra};
      const status = str(assessment?.status) ?? str(o.status);
      if (status === "incompatible" || status === "setup_required") return {codes: [status], ...extra};
      return null;
    }
    // Collection availability: {state, reason}, a list entry {availability} or an
    // open error carrying details.availability.
    const availability = availabilityReason(o);
    if (availability) return {codes: [availability === "approval_required" ? "device_approval_required" : availability], ...extra};
    if ("state" in o && (o.state === "available" || o.state === "opening")) return null;
    // Errors: MdbaseError {code, reason}, SDK errors {reason, server}.
    const codes = [...serverCodes, str(o.reason), str(o.code)].filter((c): c is string => c !== null);
    return codes.length ? {codes, ...extra, refusal: registrationRefusal(o.details ?? detail?.registration)} : null;
  } catch { return null; /* hostile getters never replace the description */ }
}

/**
 * Describe a problem for people. Accepts a code string, an `MdbaseError` or SDK
 * error, `{code, reason?}`, a public application snapshot, a readiness facet, a
 * collection availability or a collection list entry carrying one.
 * Returns `null` when the input has no problem (e.g. a ready snapshot).
 * Pass `cpOrigin` (the app's declared CP origin) to allow update links there.
 * The most specific known code wins (server reason, then reason, then code).
 */
export function describeError(input: unknown, options: { readonly cpOrigin?: string } = {}): MdbaseErrorDescription | null {
  const cpOrigin = typeof options.cpOrigin === "string" ? options.cpOrigin : null;
  const problem = problemOf(input, cpOrigin);
  if (!problem) return null;
  let found: [string, Entry] | null = null;
  try { for (const code of problem.codes) { found = lookup(code); if (found) break; } } catch { found = null; }
  const original = problem.codes[problem.codes.length - 1]!;
  const [key, [title, message, action, severity, transient = false]] = found ?? fallback(original);
  return Object.freeze({
    key, title, message, action, actionLabel: LABELS[action], severity, transient, code: original,
    developerMessage: key === "application_registration_refused" ? registrationRefusalMessage(problem.refusal ?? null)
      : key === "application_registration_id_superseded" ? SUPERSEDED_ID_NOTE : null,
    retryAfterMs: problem.retryAfterMs,
    updateUrl: action === "update_app" ? problem.updateUrl ?? DEFAULT_UPDATE_URL : null,
  });
}
