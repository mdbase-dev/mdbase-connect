// Presentation of the mdbase daemon's status, collections and app access. Pure, so
// the wording and grouping are testable without a renderer.

export type ConnectionDotState = "connected" | "connecting" | "paused" | "danger" | "idle";

interface StatusLike {
  account: { signed_in: boolean; online: boolean; pairing?: string; last_error?: string };
}

export interface ConnectionPresentation {
  label: string;
  settingsLabel: string;
  dot: ConnectionDotState;
}

export function presentConnection(status: StatusLike | null, checked: boolean): ConnectionPresentation {
  if (!status) {
    return checked
      ? { label: "mdbase is not running", settingsLabel: "Not running", dot: "danger" }
      : { label: "Checking connection…", settingsLabel: "Checking", dot: "connecting" };
  }
  const account = status.account;
  if (account.pairing) return { label: "Waiting for sign-in approval", settingsLabel: "Signing in", dot: "connecting" };
  if (!account.signed_in) return { label: "Not signed in", settingsLabel: "Not signed in", dot: "idle" };
  if (account.online) return { label: "Connected securely", settingsLabel: "Connected", dot: "connected" };
  return {
    label: account.last_error ? "Account connection needs attention" : "Connecting securely…",
    settingsLabel: account.last_error ? "Needs attention" : "Connecting",
    dot: account.last_error ? "danger" : "connecting"
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
  canDisableSync: boolean;
  paused: boolean;
  holds: number;
}

const MODES: Record<string, string> = {
  local: "On this computer only",
  synced: "Synced",
  synced_e2e: "Private sync (end-to-end encrypted)"
};

const REASONS: Record<string, string> = {
  folder_missing: "The folder is missing. Reconnect the drive or restore the folder.",
  runtime_pending: "Waiting to open.",
  account_identity_missing: "Sign in to serve this collection.",
  collection_account_mismatch: "This collection belongs to a different mdbase account.",
  collection_policy_required: "Waiting for the collection's access policy from mdbase.",
  collection_membership_missing: "This computer is not a member of this collection yet.",
  old_connector_running: "The old mdbase Connect is running on this computer. Quit it or update it; mdbase resumes on its own.",
  hosted_elsewhere: "Another app, such as Obsidian, is using this folder right now. mdbase opens it when that app lets go.",
  sync_not_configured: "Sign in to sync this collection.",
  sync_not_eligible: "Your mdbase account cannot sync this collection. Check your plan or the collection's owner.",
  sync_unreachable: "mdbase cannot reach the sync service. It opens the collection when you are back online.",
  trust_missing: "This build of mdbase cannot sync yet. Update mdbase.",
  sync_config_invalid: "This collection's sync settings could not be verified. Turn sync off and on again, or contact support.",
  not_joined: "This computer has not joined this collection yet.",
  joining_sync: "Joining this collection…",
  detached_sync: "This copy stopped following the collection. Join it again to keep it in sync.",
  adopt_failed: "Turning on sync did not finish. Choose Turn on sync again to continue.",
  adopting: "Turning on sync: uploading the files in the folder…"
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
    canDisableSync: collection.mode !== "local" && collection.state === "ready",
    paused: collection.state === "paused",
    holds
  };
  switch (collection.state) {
    case "paused":
      return { ...base, status: "Paused", detail: "Apps cannot use it until you resume it.", dot: "paused" };
    case "opening":
      return { ...base, status: "Opening…", detail: reasonText(collection.reason), dot: "connecting" };
    case "moving":
      return { ...base, status: "Changing sync…", detail: "Apps keep working while the change finishes.", dot: "connecting" };
    case "unavailable":
      return { ...base, status: "Unavailable", detail: reasonText(collection.reason), dot: "idle" };
    case "failed":
      return { ...base, status: "Stopped", detail: `${reasonText(collection.reason) ?? "It failed to open."} Your files are untouched.`, dot: "danger" };
    default:
      break;
  }
  const sync = collection.sync;
  if (collection.mode === "local" || !sync) {
    return { ...base, status: "Ready", detail: holds > 0 ? `${holds} ${holds === 1 ? "file is" : "files are"} waiting for you` : undefined, dot: holds > 0 ? "paused" : "connected" };
  }
  const waiting: string[] = [];
  if (sync.pending > 0) waiting.push(`${sync.pending} ${sync.pending === 1 ? "change" : "changes"} to upload`);
  if (holds > 0) waiting.push(`${holds} ${holds === 1 ? "file" : "files"} waiting for you`);
  if (sync.unresolved > 0) waiting.push(`${sync.unresolved} unresolved ${sync.unresolved === 1 ? "conflict" : "conflicts"}`);
  if (sync.last_error) waiting.push(`sync problem: ${sync.last_error.replaceAll("_", " ")}`);
  const status = sync.resyncing ? "Catching up…"
    : sync.connection === "online" ? (sync.pending > 0 ? "Syncing…" : "Up to date")
      : sync.connection === "connecting" ? "Connecting…" : "Offline";
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
    read: "Read",
    write: "Create and edit",
    delete: "Delete",
    schema: "Change types",
    views: "Views",
    files: "Files",
    timers: "Reminders"
  };
  return labels[capability] ?? capability.replaceAll("_", " ");
}

interface ActivityLike {
  kind: string;
  collection_name?: string;
  app_name?: string;
  detail?: string;
}

/** One activity entry as a sentence. Unknown kinds are shown as they are. */
export function describeActivity(entry: ActivityLike): string {
  const collection = entry.collection_name ?? "a collection";
  const app = entry.app_name ?? "An app";
  switch (entry.kind) {
    case "collection_added": return `${collection} was added`;
    case "collection_removed": return `${collection} was removed (its files were not touched)`;
    case "collection_updated": return `${collection} was renamed or described`;
    case "collection_paused": return `${collection} was paused`;
    case "collection_resumed": return `${collection} was resumed`;
    case "collection_joined": return `${collection} was joined from your account`;
    case "sync_enabled": return `${collection} now syncs${entry.detail === "synced_e2e" ? " privately" : ""}`;
    case "sync_disabled": return `${collection} stopped syncing`;
    case "app_connected": return `${app} can now use ${collection}`;
    case "app_requested": return `${app} asked to use ${collection}`;
    case "app_approved": return `You approved ${app} for ${collection}`;
    case "app_declined": return `You declined ${app} for ${collection}`;
    case "app_revoked": return `You revoked ${app} on ${collection}`;
    case "app_revoked_in_account": return `${app} lost access to ${collection} in your account`;
    case "signed_in": return "This computer signed in";
    case "signed_out": return "This computer signed out";
    case "computer_renamed": return `This computer is now called ${entry.detail ?? "something new"}`;
    default: return entry.kind.replaceAll("_", " ");
  }
}
