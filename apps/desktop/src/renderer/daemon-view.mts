import { t, plural } from "@lingui/core/macro";
import { i18n } from "@mdbase-dev/ui/i18n";
function missingOpenReason() { return t(i18n)`It failed to open.`; }
// Presentation of the mdbase daemon's status, collections and app access. Pure, so
// the wording and grouping are testable without a renderer.

export type ConnectionDotState = "connected" | "connecting" | "paused" | "danger" | "idle";

interface StatusLike {
  collections?: CollectionLike[];
  account: { signed_in: boolean; online: boolean; pairing?: string; last_error?: string };
}

export interface ConnectionPresentation {
  label: string;
  settingsLabel: string;
  dot: ConnectionDotState;
  /** What the account problem is, in plain words, when there is one. */
  detail?: string;
}

// The daemon reports account problems as reason codes.
export function accountProblemText(reason: string | null | undefined): string | undefined {
  if (!reason) return undefined;
  switch (reason) {
    case "system_clock_wrong": return t(i18n)`This computer's system clock looks wrong. Check its date and time to reconnect.`;
    case "sign_in_failed": return t(i18n)({ message: "Sign-in did not finish. Try again." });
    case "sign_in_expired": return t(i18n)({ message: "The sign-in request expired. Start again." });
    case "sign_in_cancelled": return t(i18n)({ message: "Sign-in was cancelled. Start again." });
    case "sign_in_required": return t(i18n)({ message: "Sign in to mdbase on this computer again." });
    case "authentication_required": return t(i18n)({ message: "mdbase no longer accepts this computer's sign-in. Sign out and sign in again." });
    case "device_registration_failed": return t(i18n)({ message: "mdbase could not register this computer yet. It keeps trying while mdbase is running." });
    case "incompatible_version": return t(i18n)({ message: "This version of mdbase is too old for the service. Update mdbase." });
    case "credential_store_unavailable": return t(i18n)({ message: "mdbase cannot reach this computer's secure storage. Unlock your keychain or restart mdbase." });
    case "account_state": return t(i18n)({ message: "mdbase could not save this computer's account settings. Check that there is free disk space, then restart mdbase." });
    case "account_cleanup_failed": return t(i18n)({ message: "Signing out did not finish. Try signing out again." });
    default: return t(i18n)({ message: "mdbase could not connect this computer to your account. It keeps trying while mdbase is running." });
  }
}

export function presentConnection(status: StatusLike | null, checked: boolean): ConnectionPresentation {
  if (!status) {
    return checked
      ? { label: t(i18n)({ message: "mdbase is not running", context: "Local connection status" }), settingsLabel: t(i18n)({ message: "Not running", context: "Local connection status" }), dot: "danger" }
      : { label: t(i18n)({ message: "Checking connection…", context: "Local connection status" }), settingsLabel: t(i18n)({ message: "Checking", context: "Local connection status" }), dot: "connecting" };
  }
  const account = status.account;
  if (account.pairing) return { label: t(i18n)({ message: "Waiting for sign-in approval" }), settingsLabel: t(i18n)({ message: "Signing in", context: "Local connection status" }), dot: "connecting" };
  if (!account.signed_in) return { label: t(i18n)({ message: "Not signed in", context: "Local connection status" }), settingsLabel: t(i18n)({ message: "Not signed in", context: "Local connection status" }), dot: "idle" };
  const detail = accountProblemText(account.last_error);
  const syncs = status.collections?.filter((c) => c.mode !== "local" && (["ready", "opening", "moving"].includes(c.state) || c.reason === "sync_unreachable")) ?? [];
  const offline = syncs.some((c) => c.sync?.connection === "offline" || c.reason === "sync_unreachable");
  const connecting = syncs.some((c) => c.sync?.connection === "connecting");
  if (offline) return { label: t(i18n)({ message: "Offline", context: "Local connection status" }), settingsLabel: t(i18n)({ message: "Offline", context: "Local connection status" }), dot: "danger", ...(detail ? { detail } : {}) };
  if (account.online && !connecting) return { label: t(i18n)({ message: "Connected securely", context: "Local connection status" }), settingsLabel: t(i18n)({ message: "Connected", context: "Local connection status" }), dot: "connected", ...(detail ? { detail } : {}) };
  return {
    label: detail ? t(i18n)({ message: "Account connection needs attention" }) : t(i18n)({ message: "Connecting securely…", context: "Local connection status" }),
    settingsLabel: detail ? t(i18n)({ message: "Needs attention", context: "Local connection status" }) : t(i18n)({ message: "Connecting", context: "Local connection status" }),
    dot: detail ? "danger" : "connecting",
    ...(detail ? { detail } : {})
  };
}

interface CollectionLike {
  mode: "local" | "synced" | "synced_e2e" | string;
  state: string;
  reason?: string;
  sync?: { pending: number; holds: number; unresolved: number; connection: string; resyncing?: boolean; last_error?: string };
  other_devices_online?: number;
}

export interface CollectionPresentation {
  mode: string;
  status: string;
  detail?: string;
  dot: ConnectionDotState;
  canEnableSync: boolean;
  paused: boolean;
  holds: number;
}

const MODES: Record<string, string> = {
  get local() { return t(i18n)({ message: "On this computer only", context: "Local connection status" }); },
  get synced() { return t(i18n)({ message: "Synced", context: "Local connection status" }); },
  get synced_e2e() { return t(i18n)({ message: "Private sync (end-to-end encrypted)" }); }
};

const REASONS: Record<string, string> = {
  get folder_missing() { return t(i18n)({ message: "The folder is missing. Reconnect the drive or restore the folder." }); },
  get runtime_pending() { return t(i18n)({ message: "Waiting to open.", context: "Local connection status" }); },
  get account_identity_missing() { return t(i18n)({ message: "Sign in to serve this collection." }); },
  get collection_account_mismatch() { return t(i18n)({ message: "This collection belongs to a different mdbase account." }); },
  get collection_policy_required() { return t(i18n)({ message: "Waiting for the collection's access policy from mdbase." }); },
  get collection_membership_missing() { return t(i18n)({ message: "This computer is not a member of this collection yet." }); },
  get old_connector_running() { return t(i18n)({ message: "The old mdbase Connect is running on this computer. Quit it or update it; mdbase resumes on its own." }); },
  get hosted_elsewhere() { return t(i18n)({ message: "Another app, such as Obsidian, is using this folder right now. mdbase opens it when that app lets go." }); },
  get sync_not_configured() { return t(i18n)({ message: "Sign in to sync this collection." }); },
  get sync_not_eligible() { return t(i18n)({ message: "Your mdbase account cannot sync this collection. Check your plan or the collection's owner." }); },
  get sync_unreachable() { return t(i18n)({ message: "mdbase cannot reach the sync service. It opens the collection when you are back online." }); },
  get trust_missing() { return t(i18n)({ message: "This build of mdbase cannot sync yet. Update mdbase." }); },
  get sync_config_invalid() { return t(i18n)({ message: "This collection's sync settings could not be verified. Turn sync off and on again, or contact support." }); },
  get not_joined() { return t(i18n)({ message: "This computer has not joined this collection yet." }); },
  get joining_sync() { return t(i18n)({ message: "Joining this collection…", context: "Local connection status" }); },
  get detached_sync() { return t(i18n)({ message: "This copy stopped following the collection. Join it again to keep it in sync." }); },
  get adopt_failed() { return t(i18n)({ message: "Turning on sync did not finish. Choose Turn on sync again to continue." }); },
  get adopting() { return t(i18n)({ message: "Turning on sync: uploading the files in the folder…" }); },
  get private_sync_pending() { return t(i18n)({ message: "Turning on Private sync so apps that used this collection keep working. mdbase finishes this on its own; your files are untouched." }); }
};

function reasonText(reason: string | undefined): string | undefined {
  if (!reason) return undefined;
  return REASONS[reason] ?? reason.replaceAll("_", " ");
}

export function presentCollection(collection: CollectionLike): CollectionPresentation {
  const holds = collection.sync?.holds ?? 0;
  const base = {
    mode: MODES[collection.mode] ?? collection.mode,
    canEnableSync: collection.mode === "local" && collection.state === "ready",
    paused: collection.state === "paused",
    holds
  };
  const pendingText = collection.sync && collection.sync.pending > 0 ? t(i18n)`${plural(collection.sync.pending, { one: "# change to sync", other: "# changes to sync" })}` : undefined;
  switch (collection.state) {
    case "paused":
      // Taken over from mdbase Connect: an interrupted turn-on of Private sync, retried automatically.
      if (collection.reason === "private_sync_pending") {
        return { ...base, status: t(i18n)`Turning on Private sync…`, detail: reasonText(collection.reason), dot: "connecting" };
      }
      return { ...base, status: t(i18n)`Paused`, detail: t(i18n)`Apps cannot use it until you resume it.`, dot: "paused" };
    case "opening":
      return { ...base, status: t(i18n)`Opening…`, detail: pendingText ?? reasonText(collection.reason), dot: "connecting" };
    case "moving":
      return { ...base, status: t(i18n)`Changing sync…`, detail: t(i18n)`Apps keep working while the change finishes.`, dot: "connecting" };
    case "unavailable":
      return { ...base, status: t(i18n)`Unavailable`, detail: reasonText(collection.reason), dot: "idle" };
    case "failed":
      return { ...base, status: t(i18n)`Stopped`, detail: t(i18n)`${reasonText(collection.reason) ?? missingOpenReason()} Your files are untouched.`, dot: "danger" };
    default:
      break;
  }
  const sync = collection.sync;
  if (collection.mode === "local" || !sync) {
    return { ...base, status: t(i18n)({ message: "Ready", context: "Local connection status" }), detail: holds > 0 ? t(i18n)`${plural(holds, { one: "# file is waiting for you", other: "# files are waiting for you" })}` : undefined, dot: holds > 0 ? "paused" : "connected" };
  }
  const waiting: string[] = [];
  if (pendingText) waiting.push(pendingText);
  if (holds > 0) waiting.push(t(i18n)`${plural(holds, { one: "# file waiting for you", other: "# files waiting for you" })}`);
  if (sync.unresolved > 0) waiting.push(t(i18n)`${plural(sync.unresolved, { one: "# unresolved conflict", other: "# unresolved conflicts" })}`);
  if (sync.last_error) waiting.push(t(i18n)`sync problem: ${sync.last_error.replaceAll("_", " ")}`);
  const status = sync.resyncing ? t(i18n)({ message: "Catching up…", context: "Local connection status" })
    : sync.connection === "online" ? (sync.pending > 0 ? t(i18n)({ message: "Syncing…", context: "Local connection status" }) : t(i18n)({ message: "Up to date", context: "Local connection status" }))
      : sync.connection === "connecting" ? t(i18n)({ message: "Connecting…", context: "Local connection status" }) : t(i18n)({ message: "Offline", context: "Local connection status" });
  const dot: ConnectionDotState = sync.last_error ? "danger"
    : holds > 0 || sync.unresolved > 0 ? "paused"
      : sync.connection === "online" && !sync.resyncing ? "connected" : "connecting";
  return { ...base, status, detail: waiting.join(" · ") || undefined, dot };
}

interface EntryLike {
  grant: string;
  collection: string;
  app_id: string;
  app_name: string;
  state: "active" | "pending_approval" | "denied" | "revoked_locally";
  acknowledged: boolean;
}

export interface AccessGroups<T extends EntryLike> {
  /** Waiting for this computer's approval (the "require approval" setting). */
  pending: T[];
  /** Served apps, grouped by app, newest notice first. */
  apps: Array<{ appId: string; appName: string; grants: T[]; unacknowledged: number }>;
  /** Declined or revoked on this computer; they stay refused. */
  refused: T[];
  /** Badge count: decisions plus new-access notices. */
  attention: number;
}

export function groupAccess<T extends EntryLike>(entries: T[]): AccessGroups<T> {
  const pending = entries.filter((entry) => entry.state === "pending_approval");
  const refused = entries.filter((entry) => entry.state === "denied" || entry.state === "revoked_locally");
  const byApp = new Map<string, { appId: string; appName: string; grants: T[]; unacknowledged: number }>();
  for (const entry of entries.filter((candidate) => candidate.state === "active")) {
    const group = byApp.get(entry.app_id) ?? { appId: entry.app_id, appName: entry.app_name, grants: [], unacknowledged: 0 };
    group.grants.push(entry);
    if (!entry.acknowledged) group.unacknowledged += 1;
    byApp.set(entry.app_id, group);
  }
  const apps = [...byApp.values()].sort((a, b) =>
    (b.unacknowledged > 0 ? 1 : 0) - (a.unacknowledged > 0 ? 1 : 0) || a.appName.localeCompare(b.appName));
  return {
    pending,
    apps,
    refused,
    attention: pending.length + apps.reduce((count, app) => count + app.unacknowledged, 0)
  };
}

/** Capability group names, for people. Unknown names are shown as they are. */
export function capabilityLabel(capability: string): string {
  const labels: Record<string, string> = {
    read: t(i18n)({ message: "Read", context: "Local connection status" }),
    write: t(i18n)({ message: "Create and edit", context: "Local connection status" }),
    delete: t(i18n)({ message: "Delete", context: "Local connection status" }),
    schema: t(i18n)({ message: "Change types", context: "Local connection status" }),
    views: t(i18n)({ message: "Views", context: "Local connection status" }),
    files: t(i18n)({ message: "Files", context: "Local connection status" }),
    timers: t(i18n)({ message: "Reminders", context: "Local connection status" })
  };
  return labels[capability] ?? capability.replaceAll("_", " ");
}

/** What an app with these capabilities will be able to do, as one phrase. */
export function capabilityPhrase(capabilities: readonly string[]): string {
  const phrases: Record<string, string> = {
    read: t(i18n)({ message: "read notes", context: "Local connection status" }),
    write: t(i18n)({ message: "create and edit notes", context: "Local connection status" }),
    delete: t(i18n)({ message: "delete notes", context: "Local connection status" }),
    schema: t(i18n)({ message: "change note types", context: "Local connection status" }),
    views: t(i18n)({ message: "save views", context: "Local connection status" }),
    files: t(i18n)({ message: "read and add files", context: "Local connection status" }),
    timers: t(i18n)({ message: "set reminders", context: "Local connection status" })
  };
  const parts = capabilities.map((capability) => phrases[capability] ?? capability.replaceAll("_", " "));
  if (parts.length === 0) return t(i18n)({ message: "do nothing yet", context: "Local connection status" });
  return parts.length === 1 ? parts[0] : t(i18n)`${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/** A device kind (`desktop`, `mobile`, ...) as people say it. */
export function deviceLabel(kind: string): string {
  return kind === "desktop" ? "computer" : kind === "mobile" ? "phone" : "device";
}

/** A key fingerprint in groups of four, for comparing by eye. */
export function groupedFingerprint(fingerprint: string): string {
  return fingerprint.replace(/(.{4})(?=.)/gu, "$1 ");
}

interface ActivityLike {
  kind: string;
  collection_name?: string;
  app_name?: string;
  detail?: string;
}

/** One activity entry as a sentence. Unknown kinds are shown as they are. */
export function describeActivity(entry: ActivityLike): string {
  const collection = entry.collection_name ?? t(i18n)({ message: "a collection", context: "Local connection status" });
  const app = entry.app_name ?? t(i18n)({ message: "An app", context: "Local connection status" });
  switch (entry.kind) {
    case "collection_added": return t(i18n)`${collection} was added`;
    case "collection_removed": return t(i18n)`${collection} was removed (its files were not touched)`;
    case "collection_updated": return t(i18n)`${collection} was renamed or described`;
    case "collection_paused": return t(i18n)`${collection} was paused`;
    case "collection_resumed": return t(i18n)`${collection} was resumed`;
    case "collection_joined": return t(i18n)`${collection} was joined from your account`;
    case "collection_taken_over": return t(i18n)`${collection} moved here from mdbase Connect (its files were not touched)`;
    case "sync_enabled": return t(i18n)`${collection} now syncs${entry.detail === "synced_e2e" ? " privately" : ""}`;
    case "sync_disabled": return t(i18n)`${collection} stopped syncing`;
    case "app_connected": return t(i18n)`${app} can now use ${collection}`;
    case "app_requested": return t(i18n)`${app} asked to use ${collection}`;
    case "app_approved": return t(i18n)`You approved ${app} for ${collection}`;
    case "app_declined": return t(i18n)`You declined ${app} for ${collection}`;
    case "app_revoked": return t(i18n)`You revoked ${app} on ${collection}`;
    case "app_revoked_in_account": return t(i18n)`${app} lost access to ${collection} in your account`;
    case "signed_in": return t(i18n)`This computer signed in`;
    case "signed_out": return t(i18n)`This computer signed out`;
    case "computer_renamed": return t(i18n)`This computer is now called ${entry.detail ?? "something new"}`;
    default: return entry.kind.replaceAll("_", " ");
  }
}
