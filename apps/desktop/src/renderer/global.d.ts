/** The daemon's `status` (control protocol v1), as the renderer uses it. */
interface DaemonStatus {
  readiness?: { schema_version: number; ready: boolean; binary_version: string; safe_reason?: string | null };
  target: "installed_service" | "isolated_profile";
  state_dir: string;
  account: {
    signed_in: boolean;
    online: boolean;
    pairing?: string;
    last_error?: string;
    server?: string;
    environment?: string;
    computer_name?: string;
  };
  collections: DaemonCollection[];
}

interface SyncCounters {
  confirmed_through: number;
  head_known: number;
  pending: number;
  holds: number;
  unresolved: number;
  connection: "online" | "connecting" | "offline" | string;
  last_error?: string;
  resyncing?: boolean;
  unsupported_entries?: number;
}

/** `collection.list` entry (`CollectionStatus`). */
interface DaemonCollection {
  id: string;
  name: string;
  description?: string;
  root: string;
  mode: "local" | "synced" | "synced_e2e";
  origin: string;
  log: "none" | "hosted";
  state: "paused" | "opening" | "ready" | "moving" | "unavailable" | "failed";
  reason?: string;
  sync?: SyncCounters;
  other_devices_online?: number;
  notices: Array<{ code: string; message: string; path?: string }>;
}

/** `collection.holds` entry. */
interface HoldSummary {
  id: string;
  path: string;
  reason: string;
  since: number;
  saves: number;
  has_theirs: boolean;
  binary: boolean;
}

/** `access.list` entry: an app's grant for a local collection, as this device sees it. */
interface AccessEntry {
  grant: string;
  collection: string;
  app_id: string;
  app_name: string;
  client_pk: string;
  capabilities: string[];
  folders?: string[];
  legacy_only?: boolean;
  state: "active" | "pending_approval" | "denied" | "revoked_locally";
  first_seen_ms: number;
  acknowledged: boolean;
  delisted?: boolean;
  /** `log`: an app grant on a synced Private collection, approved into the collection's log. */
  source?: "local" | "log";
  /** The app key's fingerprint, to compare with the one the app shows. */
  fingerprint?: string;
  /** The app's requested access could not be fetched from mdbase; it cannot be approved yet. */
  terms_unavailable?: boolean;
}

/** `device.pending` entry, with the collection it asks to open. */
interface PendingDevice {
  collection: string;
  device: string;
  account: string;
  /** `desktop`, `mobile`, ... */
  kind: string;
  /** The six-digit code the new device shows. */
  code: string;
}

/** `activity.list` entry: something that changed on this computer. */
interface ActivityEntry {
  at_ms: number;
  kind: string;
  collection?: string;
  collection_name?: string;
  app_name?: string;
  detail?: string;
}

interface StartupSetting {
  enabled: boolean;
  available: boolean;
}

interface DesktopUpdateStatus {
  phase:
    | "unavailable"
    | "idle"
    | "checking"
    | "deferred"
    | "downloading"
    | "ready"
    | "external"
    | "installing"
    | "failed";
  current_version: string;
  channel: "stable" | "beta";
  target_version?: string;
  checked_at?: string;
  progress?: number;
  message: string;
  release_url?: string;
  can_check: boolean;
  can_install: boolean;
  /** The bundled daemon was rolled back to the previous version; why. */
  daemon_notice?: string;
}

interface CloudSetting {
  /** Signed in to an mdbase account. */
  configured: boolean;
  serverUrl: string | null;
  online?: boolean;
  /** A sign-in waiting for browser approval: the page to open. */
  pairing?: string | null;
  lastError?: string | null;
  /** This computer's name in the account. */
  computerName?: string | null;
}

interface Window {
  mdbaseConnect: {
    getLocale(): Promise<string>;
    setLocale(locale: string): Promise<void>;
    status(): Promise<DaemonStatus>;
    updateStatus(): Promise<DesktopUpdateStatus>;
    checkForUpdates(): Promise<DesktopUpdateStatus>;
    installUpdate(): Promise<DesktopUpdateStatus>;
    migrationStatus(): Promise<import("./takeover-state.mjs").TakeoverStatus & { running: boolean }>;
    startMigration(stopMirrors: boolean): Promise<unknown>;
    listCollections(): Promise<DaemonCollection[]>;
    addCollection(): Promise<DaemonCollection | null>;
    chooseCreateFolder(): Promise<string | null>;
    createCollection(input: { parent: string; name: string }): Promise<DaemonCollection>;
    removeCollection(collectionId: string): Promise<unknown>;
    setCollectionEnabled(collectionId: string, enabled: boolean): Promise<unknown>;
    enableSync(collectionId: string, mode: "private" | "cloud-copy", acceptTakeoverHolds: boolean): Promise<unknown>;
    disableSync(collectionId: string): Promise<unknown>;
    listHolds(collectionId: string): Promise<HoldSummary[]>;
    resolveHold(collectionId: string, id: string, how: "keep_mine" | "take_theirs" | "keep_both" | "delete"): Promise<unknown>;
    openCollectionFolder(collectionId: string): Promise<void>;
    openEditor(collectionId: string): Promise<void>;
    getLaunchAtLogin(): Promise<StartupSetting>;
    setLaunchAtLogin(enabled: boolean): Promise<StartupSetting>;
    getCloudConfig(): Promise<CloudSetting>;
    openAccount(): Promise<void>;
    signIn(): Promise<{ verificationUri: string; expiresIn: number | null }>;
    reopenSignIn(): Promise<void>;
    signOut(): Promise<void>;
    renameComputer(name: string): Promise<{ name: string }>;
    listActivity(): Promise<ActivityEntry[]>;
    updateCollection(collectionId: string, changes: { name?: string; description?: string }): Promise<DaemonCollection>;
    listAccess(): Promise<AccessEntry[]>;
    approveAccess(grant: string): Promise<AccessEntry>;
    acknowledgeAccess(grant: string): Promise<AccessEntry>;
    denyAccess(grant: string): Promise<AccessEntry>;
    revokeAccess(grant: string): Promise<AccessEntry>;
    listPendingDevices(): Promise<PendingDevice[]>;
    approveDevice(collectionId: string, device: string, code: string): Promise<unknown>;
    rejectDevice(collectionId: string, device: string): Promise<unknown>;
    getSettings(): Promise<{ require_grant_approval: boolean }>;
    setRequireApproval(on: boolean): Promise<{ require_grant_approval: boolean }>;
    onNavigate(listener: (route: string) => void): () => void;
    onUpdateStatus(listener: (status: DesktopUpdateStatus) => void): () => void;
  };
}
