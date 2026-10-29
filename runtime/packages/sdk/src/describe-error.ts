/**
 * Shared user-facing copy for SDK errors, sign-in/open problems and readiness.
 *
 * Plain language plus one suggested action. Never returns raw codes, server
 * messages or exception text. English by default; pass `messages` to
 * translate by `key`. No Worker, wasm or network imports, so it is safe in any
 * bundle. Every server-provided field is untrusted: only known codes select
 * copy, retry delays are clamped and update links are allowlisted.
 *
 * The problem vocabulary is closed: `ProblemCode` lists every code an app can
 * meet, and `COPY` must give each one plain copy (checked by the compiler).
 * Other SDK codes either alias a ProblemCode or are internal (described by
 * their `MdbaseError` code); a source-scan test fails on any unclassified code.
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
   * end users. Built only from typed codes and manifest paths; null when none.
   * The same text is available from {@link describeDiagnostic}. */
  readonly developerMessage: string | null;
}

/** Translated copy for one problem key. Missing fields keep the English. */
export interface MdbaseProblemMessages {
  readonly title?: string;
  readonly message?: string;
  readonly actionLabel?: string;
}
export interface DescribeErrorOptions {
  /** The app's declared CP origin: allows update links there. */
  readonly cpOrigin?: string;
  /** Original protected account display metadata. Never authority. */
  readonly recoveryAccountLabel?: string;
  /** Locale hook: replacement copy by `key` (a ProblemCode, or "unknown"). */
  readonly messages?: Readonly<Partial<Record<ProblemCode | "unknown", MdbaseProblemMessages>>>;
}

type Entry = readonly [title: string, message: string, action: MdbaseErrorAction, severity: MdbaseErrorDescription["severity"], transient?: boolean,
  /** A more specific label for the same action, e.g. which app to update. */ actionLabel?: string];

const LABELS: Record<MdbaseErrorAction, string | null> = {
  retry: "Try again", wait: null, reload: "Reload", sign_in: "Sign in", approve: "Approve",
  choose_collection: "Choose a collection", set_up: "Set up", update_app: "Update the app",
  free_space: "Manage storage", check_connection: "Try again", resolve_outcome: "Check and try again",
  contact_support: "Contact support", none: null,
};

/** Every problem code an app can meet. Each has plain copy in COPY. */
export const PROBLEM_CODES = [
  // Collection availability.
  "device_offline", "desktop_update_required", "old_connector_running", "sync_required", "no_device_registered",
  "access_removed", "read_only", "capability_missing", "collection_deleted", "collection_unavailable", "moved_to_next_runtime", "device_approval_required",
  // Server outcomes.
  "collection_migrating", "account_suspended", "update_required", "account_collection_quota_exceeded",
  // MdbaseError codes (the 15).
  "invalid_request", "invalid_record", "not_found", "conflict", "unauthenticated", "forbidden", "collection_invalid",
  "unavailable", "rate_limited", "quota_exceeded", "too_large", "outcome_unknown", "internal",
  // Sign-in, open and sign-out.
  "refused", "expired", "approval_window_closed", "account_confirmation_required", "recovery_required", "open_failed",
  "busy", "open_in_another_tab", "not_authorized", "sign_out_pending_writes", "sign_out_failed",
  // Application entry.
  "application_popup_blocked", "sign_in_window", "application_not_yet_available", "application_failed",
  "application_worker_unavailable", "browser_unsupported", "application_storage_unavailable", "storage_may_be_evicted",
  "application_registration_unsupported", "application_registration_refused",
  "application_selection_not_approved", "application_selection_invalid", "installation_scope_removed", "recovery_account_mismatch", "assets",
  // Readiness.
  "setup_required", "incompatible", "approval_required", "contract_mismatch", "contract_missing", "implementation_missing",
  "catalog_invalid", "catalog_response", "type_invalid", "readiness_budget", "readiness_unsupported",
  "notifications_consent_required", "timer_channel_reapproval_required", "notifications_unsupported",
  "people_unsupported", "people_permission_declined", "people_access",
  "configuration_conflict", "configuration_unavailable", "configuration_unsupported", "configuration_busy_timeout", "readiness_busy_timeout",
  // Setup review.
  "setup_forbidden", "setup_conflict", "collection_setup_conflict", "setup_records_forbidden", "setup_changed", "installed_newer",
  "type_pack_conflict", "invalid_type_pack",
  // Optional file actions.
  "access_required", "access_declined", "access_undeclared", "files_access_missing", "files_scope_missing", "file_read_failed", "file_read_idle",
  // Collection delete.
  "collection_delete_name_mismatch", "collection_delete_not_owner", "collection_delete_not_found", "collection_delete_frozen",
  "collection_delete_busy", "collection_delete_not_approved", "collection_delete_sign_in", "collection_delete_invalid",
  "collection_delete_outcome_unknown", "collection_delete_failed",
  // Account keys (Private collections).
  "wrong_secret", "locked", "weak_password", "already_set_up", "no_account_key",
] as const;
export type ProblemCode = typeof PROBLEM_CODES[number];

const GENERIC: Entry = ["Something went wrong", "An unexpected problem occurred. Reload the app, and contact support if it keeps happening.", "reload", "error"];
const BUSY: Entry = ["Another step hasn't finished", "The app couldn't finish this step yet. Try again, or reload if it keeps happening.", "retry", "warning", true];
const OFFLINE: Entry = ["Can't connect right now", "mdbase couldn't be reached. Check your connection and try again.", "check_connection", "warning"];
const UPDATE: Entry = ["Update required", "Update mdbase on this computer, then reload the app to try again.", "update_app", "warning", false, "Update mdbase"];
const CHOOSE: Entry = ["Choose a collection", "Pick the collection you want this app to use.", "choose_collection", "info"];
const APPROVE: Entry = ["Approval needed", "This app needs your approval for extra access to your collection.", "approve", "info"];
const SET_UP: Entry = ["Set up this collection", "This collection needs a one-time setup before the app can use it.", "set_up", "info"];

const COPY = {
  // Private collections served by one of the account's computers (collection availability).
  device_offline: ["Your computer isn't online", "This collection is kept on your computer. Open the mdbase desktop app on a computer that has it, and this app connects as soon as it's online.", "wait", "info", true],
  desktop_update_required: ["Update mdbase on your computer", "The mdbase desktop app on the computer that has this collection is out of date. Update it there, then try again.", "update_app", "warning", false, "Get the update"],
  old_connector_running: ["Quit the old mdbase Connect app", "The old mdbase Connect app is still running on the computer that has this collection. Quit it there (including its menu-bar or tray icon), then open the mdbase desktop app.", "retry", "warning"],
  sync_required: ["Give this app access again", "Access to this collection changed since you approved this app. Approve it again to keep using the collection.", "approve", "warning", false, "Approve again"],
  no_device_registered: ["Turn on sync for this collection", "No computer is offering this collection to apps. Open the mdbase desktop app on the computer that has it and turn on sync. Web apps can reach a collection once sync is on.", "retry", "info"],
  installation_scope_removed: ["Access was removed", "This app's previous installation cannot regain access to this collection. Request access again to approve a new installation for this collection. Your other collections keep their access.", "approve", "warning", false, "Request access again"],
  access_removed: ["You no longer have access", "You were removed from this collection, so this app can't open it. Ask its owner to add you again, or choose another collection.", "choose_collection", "warning"],
  collection_deleted: ["Collection deleted", "This collection was deleted, so it can't be opened any more. Choose another collection.", "choose_collection", "info"],
  collection_unavailable: ["Collection not available", "This collection can't be opened from this app right now. It may no longer be shared with this app, or the computer that offered it stopped. Choose another collection, or try again later.", "choose_collection", "warning"],
  moved_to_next_runtime: ["mdbase was upgraded", "This collection now uses the new version of mdbase. Update the app to keep using it; for a web app, reloading the page is enough. If the collection still doesn't appear, open the mdbase desktop app and turn on sync for it so web apps can reach it.", "update_app", "warning"],
  // `approval_required` (readiness) means approval in the portal; this one means on a computer.
  device_approval_required: ["Waiting for your computer", "Keep a computer with this collection running mdbase and signed in. This app connects when it is ready.", "wait", "info", true],
  collection_migrating: ["Your collection is being upgraded", "Your data is safe. This usually takes a few minutes, and the app reconnects by itself when it's done.", "wait", "info", true],
  account_suspended: ["Your account is suspended", "Your mdbase account has been suspended, so this app can't open your collections. Contact mdbase support for help.", "contact_support", "error"],
  update_required: UPDATE,
  invalid_request: ["Couldn't do that", "Some of the information isn't valid. Check it and try again.", "none", "warning"],
  invalid_record: ["Couldn't save that", "Some fields aren't valid. Check them and try again.", "none", "warning"],
  not_found: ["Not found", "This item no longer exists. It may have been deleted on another device.", "none", "info"],
  conflict: ["Changed somewhere else", "This item was changed on another device. Review the latest version and try again.", "retry", "warning"],
  unauthenticated: ["Sign in again", "Your session has ended. Sign in again to continue.", "sign_in", "warning"],
  read_only: ["View access only", "You have view access, so changes can't be saved. Ask the collection's owner for edit access.", "none", "warning"],
  forbidden: ["Access needed", "This app doesn't have permission to do that. Approve access to continue.", "approve", "warning"],
  collection_invalid: ["Your collection needs repair", "Something in this collection isn't valid. Contact support if this keeps happening.", "contact_support", "error"],
  unavailable: OFFLINE,
  rate_limited: ["Too many requests", "Wait a moment, then try again.", "retry", "warning", true],
  quota_exceeded: ["Out of storage", "Your collection has reached its storage limit. Free up space to keep saving.", "free_space", "error"],
  account_collection_quota_exceeded: ["Synced collection limit reached", "Your account has reached its synced collection limit. Delete a synced collection before creating another.", "free_space", "error", false, "Manage collections"],
  too_large: ["That's too large", "This item is larger than mdbase allows.", "none", "warning"],
  outcome_unknown: ["Not sure that worked", "The connection dropped before mdbase confirmed it. Check whether it went through before trying again.", "resolve_outcome", "warning"],
  internal: GENERIC,
  refused: ["Sign-in didn't go through", "mdbase didn't accept this sign-in. Try signing in again.", "sign_in", "warning"],
  expired: ["Sign-in timed out", "The sign-in request expired. Start again to get a new one.", "sign_in", "warning"],
  approval_window_closed: ["Sign-in wasn't finished", "The mdbase window was closed before access was approved. Sign in again to continue.", "sign_in", "info"],
  account_confirmation_required: ["Confirm your account", "Confirm which mdbase account to use, then continue.", "sign_in", "info"],
  recovery_account_mismatch: ["Use a different account", "Sign in with the account you originally used for this collection to continue.", "approve", "info", false, "Use a different account"],
  recovery_required: ["Reload required", "The app stopped to keep your data safe. Reload to continue.", "reload", "error"],
  open_failed: ["Couldn't open your collection", "Something went wrong while opening it. Reload the app to try again.", "reload", "error"],
  busy: BUSY,
  file_read_failed: ["Couldn't load the file", "mdbase couldn't finish downloading this file. Check your connection and try opening the collection again.", "retry", "warning"],
  file_read_idle: ["File download timed out", "The file download stopped making progress. Try opening the collection again.", "retry", "warning"],
  configuration_busy_timeout: ["Collection setup is taking too long", "The app is waiting for another setup or metadata request to finish. Try again; if it keeps happening, close other tabs of this app and reload.", "retry", "warning"],
  readiness_busy_timeout: ["Collection checks are taking too long", "The app couldn't get a stable view of the collection yet. Try again when the other step has finished.", "retry", "warning"],
  open_in_another_tab: ["Open in another tab", "This app is already open in another tab. Close that tab, or keep using it there; this tab continues by itself when it's free.", "none", "info", true],
  not_authorized: ["This app can't open this collection", "This app isn't allowed to open this collection. Approve it again, or choose another collection.", "approve", "warning", false, "Approve again"],
  sign_out_pending_writes: ["Changes are still saving", "Some changes haven't reached mdbase yet. Wait for them to finish, or sign out anyway and lose them on this device.", "wait", "warning", false, "Wait"],
  sign_out_failed: ["Couldn't finish signing out", "This device couldn't remove all of its sign-in data. Reload the app and sign out again.", "reload", "error"],
  application_popup_blocked: ["Allow pop-ups to sign in", "Your browser blocked the sign-in window. Allow pop-ups for this site, then try again.", "retry", "warning"],
  sign_in_window: ["Sign-in window problem", "The sign-in window couldn't be opened. Try again.", "retry", "warning"],
  application_not_yet_available: ["Not available yet", "This app isn't available on this version of mdbase yet.", "none", "info"],
  application_failed: ["The app stopped", "Something inside the app stopped working. Your data is safe. Reload to continue.", "reload", "error"],
  application_worker_unavailable: ["This browser can't run the app", "Open the app in a current version of Chrome, Edge, Firefox or Safari.", "none", "error"],
  browser_unsupported: ["This browser can't run mdbase", "Update Safari to 17.4 or newer, Firefox to 130 or newer, or Chrome or Edge to 133 or newer, then open the app again.", "none", "error"],
  application_storage_unavailable: ["This browser can't keep mdbase data on this device", "Private browsing may be on. Open the app in a regular window so your changes can be kept safely on this device.", "none", "error"],
  storage_may_be_evicted: ["Not synced yet", "Some changes are only on this device. Stay online so they can sync.", "check_connection", "warning"],
  application_registration_unsupported: ["This app can't connect", "This version of the app isn't supported by mdbase. Update the app.", "update_app", "error"],
  application_registration_refused: ["This app can't connect", "This app can't connect right now. Contact the app's developer.", "contact_support", "error"],
  application_selection_not_approved: ["Collection not approved", "This app hasn't been given access to that collection. Approve it to continue.", "approve", "info"],
  application_selection_invalid: CHOOSE,
  assets: ["The app couldn't load", "Some of the app's files couldn't be loaded. Check your connection and reload.", "reload", "error"],
  setup_required: SET_UP,
  incompatible: ["This collection isn't compatible", "This collection uses a format this version of the app doesn't support. Update the app.", "update_app", "error"],
  approval_required: APPROVE,
  capability_missing: APPROVE,
  contract_mismatch: ["Your collection's format differs", "This collection's record types don't match what this app expects. Set it up again or update the app.", "set_up", "warning"],
  contract_missing: ["Set up this collection", "This collection is missing record types this app needs. Set it up to continue.", "set_up", "info"],
  implementation_missing: ["Set up this collection", "A record type in this collection doesn't provide the fields this app needs. Set it up to continue.", "set_up", "info"],
  catalog_invalid: ["A definition has a problem", "A definition in this collection has an error, so the app can't open the collection safely. Fix the definition in your collection, and the app picks up the change.", "none", "warning"],
  catalog_response: ["Couldn't read this collection's definitions", "The app couldn't read how this collection is defined, so it didn't open it. Nothing was changed. Try again.", "retry", "warning"],
  type_invalid: ["A record type isn't available", "This record type has an error in its definition, so the app can't use it right now. Everything else still works. Fix the type in your collection to use it again.", "none", "warning"],
  readiness_budget: ["This collection is too large to check", "This collection has more definitions than the app can check at once. Contact the app's developer.", "contact_support", "warning"],
  readiness_unsupported: ["Update the app", "This collection uses features this version of the app can't check. Update the app to open it.", "update_app", "warning"],
  notifications_consent_required: ["Allow reminders", "Approve notifications so reminders can reach this device.", "approve", "info"],
  timer_channel_reapproval_required: ["Allow reminders again", "Approve notifications again so reminders keep reaching this device.", "approve", "info"],
  notifications_unsupported: ["Reminders aren't available here", "This browser or device can't receive notifications.", "none", "info"],
  people_unsupported: ["Sharing isn't available here", "People and sharing aren't supported for this collection yet.", "none", "info"],
  people_permission_declined: ["People aren't shown", "This app wasn't allowed to see who else is in this collection. Approve it again and allow people to show them here.", "approve", "info", false, "Approve again"],
  people_access: ["People can't be shown", "This app can't see the people in this collection right now. Everything else still works.", "none", "info"],
  configuration_conflict: ["Settings changed elsewhere", "These settings were changed on another device. Review them and try again.", "retry", "warning"],
  // The collection's setup couldn't be assessed: not a network problem.
  configuration_unavailable: ["Couldn't check this collection's setup", "The app couldn't read how this collection is set up, so it didn't open it. Nothing in the collection was changed. Try again, and contact support if it keeps happening.", "retry", "warning"],
  configuration_unsupported: ["This app can't set up this collection", "This app's setup isn't supported by this version of mdbase. Contact the app's developer.", "contact_support", "warning"],
  setup_forbidden: ["You can't set up this collection", "Your access to this collection doesn't allow setting it up. Ask its owner to open it in this app first.", "choose_collection", "warning"],
  setup_conflict: ["Setup needs your decision", "Some things in this collection differ from what this app needs. Review them to continue.", "set_up", "warning", false, "Review setup"],
  collection_setup_conflict: ["Collection setup conflicts", "This collection's definitions conflict with what this app requires. Ask its owner to review them, or choose a different collection. Setup cannot continue while these conflicts remain.", "choose_collection", "warning"],
  setup_records_forbidden: ["You can't add notes to this collection", "Your access to this collection doesn't allow creating notes, which this app's setup needs. Ask its owner for more access.", "choose_collection", "warning"],
  setup_changed: ["This collection changed", "The collection changed while you were reviewing its setup. Review the setup again; nothing was changed yet.", "set_up", "info", false, "Review again"],
  installed_newer: ["Update the app", "A newer version of this app set up this collection with changes this version can't use. Update the app to keep using the collection.", "update_app", "warning"],
  type_pack_conflict: ["Setup needs your decision", "Some record types already exist with different content. Review them to continue.", "set_up", "warning", false, "Review setup"],
  invalid_type_pack: ["This app's setup has a problem", "Setting up this collection would leave it invalid, so nothing was changed. Contact the app's developer.", "contact_support", "warning"],
  // Optional file actions asked for at the moment of use (requestAccess).
  access_required: ["Allow this app to change files?", "This app needs your permission before it can add or change files in this collection.", "approve", "info", false, "Allow"],
  access_declined: ["Not allowed", "You chose not to allow this. Everything else in the app works as before, and you can allow it the next time you try.", "none", "info"],
  access_undeclared: ["This app can't do that", "This app isn't set up to change files this way. Contact the app's developer if you need it.", "none", "warning"],
  files_access_missing: ["This app can't use this collection", "Your access to this collection doesn't include the file changes this app needs. Ask the collection's owner for more access.", "none", "warning"],
  files_scope_missing: ["This app can't use this collection", "This app needs access to all files in this collection, but your access covers only some folders. Ask the collection's owner for more access.", "none", "warning"],
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
  wrong_secret: ["That isn't right", "The password or recovery key doesn't match. Check it and try again.", "none", "warning"],
  locked: ["Too many attempts", "Wait a few minutes before trying again.", "wait", "warning", true],
  weak_password: ["Choose a stronger password", "That password is too easy to guess. Use a longer one, or a few unrelated words.", "none", "warning"],
  already_set_up: ["Already set up", "Your account key is already set up on this account.", "none", "info"],
  no_account_key: ["Set up your account key", "This account doesn't have an account key yet. Set one up to use Private collections.", "none", "info"],
} as const satisfies Record<ProblemCode, Entry>;

/** Codes that mean the same outcome as a ProblemCode (server reasons, facet
 * and entry variants). Explicit: there is no suffix guessing. */
const ALIASES: Readonly<Record<string, ProblemCode>> = Object.assign(Object.create(null) as Record<string, ProblemCode>, {
  no_device_online: "device_offline", collection_moved: "moved_to_next_runtime", client_update_required: "update_required",
  upgrade_required: "update_required",
  // Compatibility details can be published without their upgrade_required wrapper.
  declared_setup_unsupported: "update_required", resource_setup_unsupported: "update_required",
  type_packs_unsupported: "update_required", describe_definitions_unsupported: "update_required",
  contract_records_unsupported: "update_required", record_links_unsupported: "update_required",
  change_entity_unsupported: "update_required", timer_operation_recovery_unavailable: "update_required",
  contract_query_version: "update_required", unsupported_push_version: "update_required",
  // The SDK re-checks a concurrent change or an occupied step by itself.
  fenced: "busy", reconnecting: "busy", application_busy: "busy", application_fenced: "busy", application_entry_fenced: "busy",
  application_asset_fenced: "busy", application_connection_busy: "busy", application_connection_fenced: "busy",
  application_readiness_busy: "busy", application_readiness_fenced: "busy", application_registration_fenced: "busy",
  application_selection_busy: "busy", application_selection_fenced: "busy", application_worker_busy: "busy",
  application_worker_fenced: "busy", application_popup_fenced: "busy", readiness_fenced: "busy", readiness_busy: "busy",
  readiness_changed: "busy", configuration_busy: "busy", configuration_fenced: "busy", files_fenced: "busy",
  people_fenced: "busy", people_readiness_busy: "busy", people_readiness_fenced: "busy",
  notification_readiness_busy: "busy", notification_readiness_fenced: "busy", record_links_fenced: "busy",
  // An internal invariant failed: the Worker, page and SDK stop safely.
  binding: "application_failed", response: "application_failed", application_declaration: "application_failed",
  application_connection_binding: "application_failed", application_popup_binding: "application_failed",
  application_registration_response: "application_failed",
  application_selection_binding: "application_failed", application_worker_binding: "application_failed",
  application_worker_module_binding: "application_failed", application_entry_unavailable: "application_failed",
  application_readiness_unavailable: "application_failed", configuration_binding: "application_failed",
  configuration_response: "application_failed", files_unavailable: "application_failed",
  application_stop_failed: "recovery_required", application_worker_stop_failed: "recovery_required",
  application_popup_stop_failed: "recovery_required", configuration_recovery_required: "recovery_required",
  application_popup_unavailable: "sign_in_window",
  // Registration could not reach the CP: a connection problem.
  application_registration_unavailable: "unavailable", application_registration_unknown: "unavailable",
  application_connection_unavailable: "unavailable", readiness_unavailable: "unavailable",
  grant_activation_timeout: "unavailable",
  application_connection_people_unavailable: "people_access", people_unavailable: "people_access",
  people_response: "people_access", people_binding: "people_access", people_budget: "people_access", people_incomplete: "people_access",
  application_selection_empty: "application_selection_invalid", application_selection_duplicate: "application_selection_invalid",
  application_selection_metadata: "application_selection_invalid",
  application_lab_trust_unavailable: "assets", application_production_trust_unavailable: "assets",
  application_packaged_assets_unavailable: "assets", application_asset_fetch: "assets",
  grant_required: "approval_required",
  readiness_capability_version: "readiness_unsupported", readiness_type_invalid: "type_invalid",
  configuration_not_authorized: "setup_forbidden", configuration_unsupported_source_provision: "configuration_unsupported",
  setup_downgrade: "installed_newer", type_pack_downgrade: "installed_newer", installed_newer_major: "installed_newer",
  timer_push_platform: "notifications_unsupported", push_registration_missing: "notifications_consent_required",
});
/** Readiness facets publish `readiness_<reason>`; some reasons need their own key. */
const READINESS: Readonly<Record<string, ProblemCode>> = Object.assign(Object.create(null) as Record<string, ProblemCode>, {
  budget: "readiness_budget", unsupported: "readiness_unsupported",
});

/** Not problems: the SDK handled them, or the person chose them. describeError returns null. */
export const NON_PROBLEM_CODES = ["application_registration_id_superseded", "application_closing", "cancelled", "aborted"] as const;
const NON_PROBLEMS: ReadonlySet<string> = new Set<string>(NON_PROBLEM_CODES);

/** Published inventory of codec/protocol internals, test fakes and developer
 * misuse. Previously exported compatibility details remain here for source
 * compatibility; problemCodeOf and ALIASES now give those details update copy
 * even when their MdbaseError wrapper is no longer available. */
export const INTERNAL_PROBLEM_CODES = [
  // CBOR / codec internals.
  "duplicate_key", "float", "hash", "indefinite", "int", "mixed_map_keys", "non_canonical_head", "simple", "tag", "too_deep",
  "too_long", "trailing_bytes", "tstr", "uint", "unencodable", "unexpected_end", "unsorted_keys", "utf8", "uuid", "value",
  "unknown_method", "unknown_variant", "unsupported", "storage", "noise", "declared_setup_codec",
  // In-memory test replica and contracts.
  "body", "data_contract_ambiguous", "data_contract_field_conflict", "data_contract_field_unmapped", "data_contract_not_found",
  "data_contract_not_implemented", "data_contract_promote_typed", "digest_mismatch", "invalid_type_definition", "path_taken",
  "revision", "size_mismatch", "transfer_expired", "type_conflict",
  // Developer misuse (invalid_request / invalid_record carry the copy).
  "account_secret_length", "access_invalid", "access_no_collection", "application_sign_in_opener", "change_entity_unsupported",
  "click_target_cross_origin", "context_required", "context_type_mismatch", "cursor_expired", "file_upload_identity_mismatch",
  "invalid_autosave", "invalid_binding", "invalid_call", "invalid_push_payload", "invalid_sas", "invalid_scope",
  "invalid_timeout", "invalid_timer_response", "invalid_typing_response", "invalid_validation_result", "invalid_view",
  "key_id_changed", "read_many_bounds", "read_many_identity_mismatch", "read_many_selection", "record_identity_mismatch",
  "record_lease_policy", "record_links_bounds", "record_links_missing", "record_links_response", "record_links_unsupported",
  "record_recovery_mismatch", "record_session_budget", "record_validation_stale", "record_witness_required", "strength",
  "strict_mode", "typing_bounds", "unsupported_push_version", "validation_bounds", "validation_selection",
  // The build does not match the app's registration: apps describe this in
  // their own words (describeError gives the "unknown" key so their copy wins).
  "application_registration_binding",
  "view_not_found", "view_source_changed", "view_source_witness_required", "bases_read_backpressure",
  "contract_query_response", "contract_query_version", "contract_records_unsupported", "describe_definitions_unsupported",
  "prefix_response", "type_pack_contract_setups_unsupported", "type_packs_unsupported", "resource_setup_unavailable",
  "resource_setup_unsupported", "timer_operation_recovery_unavailable", "declared_setup_unsupported", "setup_outcome_unknown",
  // Storage probe (describes as `unavailable`).
  "cleanup_failed", "opfs_unavailable", "probe_failed", "sync_handle_unavailable", "worker_required",
  // Owner lifecycle (wrapped as open_failed / recovery_required by the session).
  "shutdown_failed",
  // Thin-client, relay and app-grant transport (legacy Private path; wrapped as the 15).
  "authorization_binding", "authorization_callback", "authorization_cancelled", "authorization_denied", "authorization_signature", "authorization_start",
  "authorization_timed_out", "client_key_required", "collection_mismatch", "control_error",
  "control_unreachable", "daemon_not_running", "grant_invalid", "grant_storage", "key_storage", "redirect_uri",
  "relay_insecure", "relay_unauthenticated", "relay_unavailable", "relay_url", "route_mismatch", "token_error",
  "token_response", "untrusted_identity",
] as const;

const DEVELOPER: Readonly<Record<string, string>> = Object.assign(Object.create(null) as Record<string, string>, {
  device_offline: "Collection availability device_offline: no device serving this Private collection is connected to the relay.",
  desktop_update_required: "Collection availability desktop_update_required: the serving device's last relay connection was refused as incompatible.",
  old_connector_running: "Collection availability old_connector_running: the serving device reports a legacy connector still holding its collections.",
  device_approval_required: "Collection availability approval_required: no device has signed an approval for this app's grant yet.",
  sync_required: "Collection availability sync_required: the grant no longer matches the collection's membership; run authorize() again.",
  no_device_registered: "Collection availability no_device_registered: Connect has no device that can serve this collection (none registered with sync on, or its device was revoked).",
  installation_scope_removed: "The original installation lost this collection scope. Only explicit approval of a fresh scoped installation can regain access.",
  access_removed: "Collection availability access_removed: the grant's account is no longer a member of the collection.",
  collection_deleted: "Collection availability collection_deleted: the owner deleted the collection.",
  collection_unavailable: "Connect problem collection_unavailable without a known reason: the collection is not offered to this app or client.",
  moved_to_next_runtime: "Connect problem collection_unavailable, reason moved_to_next_runtime: a legacy route was used for a collection that completed its move to mdbase-next.",
  people_permission_declined: "People members request refused (people_permission_declined): the person did not grant the people permission for this app.",
  people_access: "People request refused (people_access).",
  access_required: "access_required: an optional file action the person has not allowed. Call requestAccess from the user's action, then retry.",
  access_undeclared: "access_undeclared: the file action is not in the manifest's requirements.files.",
  installed_newer: "installed_newer: an installed type pack has a different major version than the one this app ships; same-major newer packs open read/write.",
  application_registration_id_superseded: "The declared application ID is an earlier registration ID: mdbase registers each exact manifest under its own ID, so it changes with the manifest. The SDK uses the registered ID and keeps the declared storage names. Declare the manifest's logical `id` (stable across manifest changes and origins) with pinned storage names to remove this note.",
  application_worker_unavailable: "application_worker_unavailable: this page cannot construct the SDK's module Worker (no Worker/MessageChannel, or a non-web origin).",
  browser_unsupported: "browser_unsupported: the SDK's upfront capability probe found a required browser feature missing (Web Crypto/X25519, AbortSignal.any, Web Locks, BroadcastChannel, IndexedDB, Worker/MessageChannel or crypto.randomUUID); see the MdbaseError details for the missing tokens.",
  application_storage_unavailable: "application_storage_unavailable: navigator.storage.getDirectory() (OPFS) is absent or rejected, as in private browsing; the local replica cannot be kept on this device.",
  storage_may_be_evicted: "storage_may_be_evicted: replica edits are pending for at least 30 seconds or while disconnected on nonpersistent storage (snapshot.saveWarning); only a log-confirmed receipt counts as saved.",
  sign_out_pending_writes: "sign_out_pending_writes: unconfirmed writes are still queued on this device; signOut({discard: true}) discards them.",
});

const NAME = /^[a-z][a-z0-9_-]{0,127}$/;
const str = (v: unknown): string | null => typeof v === "string" && NAME.test(v) ? v : null;
const obj = (v: unknown): Record<string, unknown> | null => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null;
const retry = (v: unknown): number | null => typeof v === "number" && Number.isFinite(v) && v >= 0
  ? Math.min(MAX_SERVER_RETRY_MS, Math.max(MIN_SERVER_RETRY_MS, Math.round(v))) : null;
const isProblemCode = (code: string): code is ProblemCode => Object.hasOwn(COPY, code);

/** The ProblemCode a code means, or null when it has none. */
export function problemCodeOf(code: string): ProblemCode | null {
  if (typeof code !== "string") return null;
  if (isProblemCode(code)) return code;
  if (Object.hasOwn(ALIASES, code)) return ALIASES[code]!;
  for (const prefix of ["readiness_", "application_"]) {
    if (!code.startsWith(prefix)) continue;
    const rest = code.slice(prefix.length);
    if (prefix === "readiness_" && Object.hasOwn(READINESS, rest)) return READINESS[rest]!;
    if (isProblemCode(rest)) return rest;
    if (Object.hasOwn(ALIASES, rest)) return ALIASES[rest]!;
  }
  return null;
}

interface Found { codes: string[]; retryAfterMs: number | null; updateUrl: string | null; refusal?: ReturnType<typeof registrationRefusal> }

function availabilityReason(o: Record<string, unknown>): CollectionUnavailableReason | null {
  const details = o.details;
  if (details instanceof Map && isCollectionUnavailableReason(details.get("availability"))) return details.get("availability") as CollectionUnavailableReason;
  const value = obj(o.availability) ?? (o.state === "unavailable" ? o : null);
  return value && value.state === "unavailable" && isCollectionUnavailableReason(value.reason) ? value.reason : null;
}

/** Find the problem in any SDK shape: a code, an error, a public snapshot or a facet. */
function problemOf(input: unknown, cpOrigin: string | null): Found | null {
  const code = str(input);
  if (code) return {codes: [code], retryAfterMs: null, updateUrl: null};
  const o = obj(input);
  if (!o) return null;
  try {
    // A phase: its problem (if any) is already described.
    if (typeof o.kind === "string" && "problem" in o && obj(o.problem) && typeof obj(o.problem)!.code === "string") return problemOf(obj(o.problem)!.code, cpOrigin);
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

function resolve(found: Found): {key: ProblemCode | "unknown" | null; original: string} {
  const original = found.codes[found.codes.length - 1]!;
  try {
    for (const code of found.codes) {
      if (NON_PROBLEMS.has(code)) return {key: null, original};
      const key = problemCodeOf(code);
      if (key) return {key, original};
    }
  } catch { /* fall through to generic */ }
  return {key: "unknown", original};
}

/**
 * Describe a problem for people. Accepts a code string, an `MdbaseError` or SDK
 * error, `{code, reason?}`, a public application snapshot, a phase, a readiness
 * facet, a collection availability or a collection list entry carrying one.
 * Returns `null` when the input has no problem (a ready snapshot) or is not a
 * problem (a cancellation, a note the SDK handled).
 * The most specific known code wins (server reason, then reason, then code).
 */
export function describeError(input: unknown, options: DescribeErrorOptions = {}): MdbaseErrorDescription | null {
  const cpOrigin = typeof options.cpOrigin === "string" ? options.cpOrigin : null;
  const found = problemOf(input, cpOrigin);
  if (!found) return null;
  const {key, original} = resolve(found);
  if (key === null) return null;
  const [title, message, action, severity, transient = false, label] = key === "unknown" ? GENERIC : COPY[key] as Entry;
  let translated: MdbaseProblemMessages | undefined;
  try { const messages = options.messages; translated = messages && Object.hasOwn(messages, key) ? obj(messages[key]) as MdbaseProblemMessages : undefined; } catch { translated = undefined; }
  const text = (v: unknown, fallback: string) => typeof v === "string" && v.trim() ? v : fallback;
  const accountLabel = typeof options.recoveryAccountLabel === "string" && options.recoveryAccountLabel.trim().length > 0 && options.recoveryAccountLabel.length <= 320 && !Array.from(options.recoveryAccountLabel).some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) ? options.recoveryAccountLabel : null;
  const accountMessage = key === "recovery_account_mismatch" && accountLabel ? `This collection belongs to ${accountLabel}. Sign in as ${accountLabel} to continue.` : message;
  const actionLabel = key === "recovery_account_mismatch" && accountLabel ? `Sign in as ${accountLabel}` : label ?? LABELS[action];
  return Object.freeze({
    key, title: text(translated?.title, title), message: text(translated?.message, accountMessage), action,
    actionLabel: actionLabel === null ? null : text(translated?.actionLabel, actionLabel), severity, transient, code: original,
    developerMessage: diagnostic(key, original, found.refusal ?? null),
    retryAfterMs: found.retryAfterMs,
    updateUrl: action === "update_app" ? found.updateUrl ?? DEFAULT_UPDATE_URL : null,
  });
}

function diagnostic(key: string, original: string, refusal: ReturnType<typeof registrationRefusal> | null): string | null {
  if (key === "application_registration_refused") return registrationRefusalMessage(refusal);
  if (Object.hasOwn(DEVELOPER, key)) return DEVELOPER[key]!;
  // The code has no user-facing copy: name it for the developer (validated code only).
  return key === "unknown" ? `Problem code ${original} has no user-facing copy; it is shown as a generic error.` : null;
}

/** Developer detail for logs and consoles, including notes on non-problems
 * (for example a superseded registration ID). Never show it to end users. */
export function describeDiagnostic(input: unknown, options: Pick<DescribeErrorOptions, "cpOrigin"> = {}): string | null {
  const found = problemOf(input, typeof options.cpOrigin === "string" ? options.cpOrigin : null);
  if (!found) return null;
  for (const code of found.codes) if (Object.hasOwn(DEVELOPER, code) && NON_PROBLEMS.has(code)) return DEVELOPER[code]!;
  const {key, original} = resolve(found);
  return key === null ? null : diagnostic(key, original, found.refusal ?? null);
}
