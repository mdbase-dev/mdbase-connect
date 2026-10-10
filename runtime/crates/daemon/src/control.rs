//! The daemon control protocol, version 1.
//!
//! The CLI and the desktop app administer the daemon over its **control
//! endpoint** ([`crate::paths::Profile::control`]). This is separate from the
//! replica client API that apps use (`replica-client-api.md`): it registers
//! collections, reports daemon and collection state, moves logs, approves devices,
//! and stops the daemon. Access control is the OS's: the endpoint is reachable only
//! by the owning user (see [`crate::ipc`]).
//!
//! **Framing.** `u32be(length) ‖ JSON`, at most 1 MiB per frame. JSON keeps the
//! desktop (Node) side dependency-free and the protocol debuggable.
//!
//! ```text
//! request   {"v":1, "id":7, "method":"status", "params":{...}}
//! response  {"v":1, "id":7, "result":{...}}
//!           {"v":1, "id":7, "error":{"code":"not_found","message":"...","reason":"..."}}
//! push      {"v":1, "push":"status", "payload":{...}}       (after status.subscribe)
//! ```
//!
//! **Versioning.** `v` is the protocol major. A daemon answers a request with a
//! different `v` with `upgrade_required` and closes. New methods, push types and
//! optional fields are additive; clients ignore unknown fields.
//!
//! **Error codes** reuse the client API's 15 (`replica-client-api.md` §9), so
//! every failure has one recovery action. Reasons are stable snake_case strings.
//!
//! **Methods** (see [`Method`]): `ping`, `status`, `status.subscribe`,
//! `shutdown`, `collection.list|add|remove|pause|resume|holds|conflicts`,
//! `sync.enable|disable`, `device.pending|approve|reject`,
//! `recovery.status|create|import`, `access.list|revoke|approve|deny|ack`,
//! `settings.get|set`, `doctor`.
//!
//! **Pushes** after `status.subscribe`: `status` ([`DaemonStatus`]) and `access`
//! ([`crate::access::AccessEvent`]: `new_access`, `approval_requested`,
//! `revoked`), which the desktop turns into notifications.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::paths::Target;
use crate::registry::{Origin, SyncMode};

/// Control protocol major version.
pub const PROTOCOL: u32 = 1;

/// Readiness schema version.
pub const READINESS_SCHEMA: u32 = 1;

/// A request frame.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Request {
    /// Protocol major.
    pub v: u32,
    /// Request ID, chosen by the client, unique per connection.
    pub id: u64,
    /// Method name.
    pub method: String,
    /// Parameters (an object; `{}` when none).
    #[serde(default)]
    pub params: Value,
}

/// A response or push frame.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Response {
    /// Protocol major.
    pub v: u32,
    /// The request this answers (absent on pushes).
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub id: Option<u64>,
    /// Result on success.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub result: Option<Value>,
    /// Error on failure.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub error: Option<ControlError>,
    /// Push type.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub push: Option<String>,
    /// Push payload.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub payload: Option<Value>,
}

impl Response {
    /// A success.
    pub fn ok(id: u64, result: Value) -> Response {
        Response {
            v: PROTOCOL,
            id: Some(id),
            result: Some(result),
            error: None,
            push: None,
            payload: None,
        }
    }

    /// A failure.
    pub fn err(id: u64, error: ControlError) -> Response {
        Response {
            v: PROTOCOL,
            id: Some(id),
            result: None,
            error: Some(error),
            push: None,
            payload: None,
        }
    }

    /// A push.
    pub fn push(kind: &str, payload: Value) -> Response {
        Response {
            v: PROTOCOL,
            id: None,
            result: None,
            error: None,
            push: Some(kind.to_string()),
            payload: Some(payload),
        }
    }
}

/// An error: one of the client API's 15 codes, a message, a stable reason.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ControlError {
    /// One of the 15 codes (`replica-client-api.md` §9).
    pub code: String,
    /// For people. Never contains secrets.
    pub message: String,
    /// Finer cause, snake_case.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub reason: Option<String>,
}

impl ControlError {
    /// Build one.
    pub fn new(code: &str, reason: &str, message: impl Into<String>) -> ControlError {
        ControlError {
            code: code.to_string(),
            message: message.into(),
            reason: Some(reason.to_string()),
        }
    }

    /// `invalid_request`.
    pub fn invalid(reason: &str, message: impl Into<String>) -> ControlError {
        ControlError::new("invalid_request", reason, message)
    }

    /// `not_found`.
    pub fn not_found(message: impl Into<String>) -> ControlError {
        ControlError::new("not_found", "not_found", message)
    }

    /// `unavailable`.
    pub fn unavailable(reason: &str, message: impl Into<String>) -> ControlError {
        ControlError::new("unavailable", reason, message)
    }

    /// `unavailable` with reason `not_implemented`: the method exists in the
    /// protocol, but the runtime piece behind it has not landed yet.
    pub fn not_implemented(what: &str) -> ControlError {
        ControlError::unavailable(
            "not_implemented",
            format!("{what} is not available in this build yet"),
        )
    }

    /// `internal`.
    pub fn internal(message: impl Into<String>) -> ControlError {
        ControlError::new("internal", "internal", message)
    }
}

impl std::fmt::Display for ControlError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} ({}", self.message, self.code)?;
        if let Some(r) = &self.reason {
            write!(f, ": {r}")?;
        }
        f.write_str(")")
    }
}

impl std::error::Error for ControlError {}

/// Method names.
pub struct Method;

impl Method {
    /// Readiness only. Cheap; safe to poll.
    pub const PING: &'static str = "ping";
    /// Daemon and collection status ([`DaemonStatus`]).
    pub const STATUS: &'static str = "status";
    /// Push `status` whenever it changes (and once immediately).
    pub const STATUS_SUBSCRIBE: &'static str = "status.subscribe";
    /// Graceful shutdown. Responds, then stops.
    pub const SHUTDOWN: &'static str = "shutdown";
    /// `[CollectionStatus]`.
    pub const COLLECTION_LIST: &'static str = "collection.list";
    /// [`AddCollection`] → [`CollectionStatus`].
    pub const COLLECTION_ADD: &'static str = "collection.add";
    /// `{collection}` → `{}`. Unregisters; never deletes files.
    pub const COLLECTION_REMOVE: &'static str = "collection.remove";
    /// `{collection}` → [`CollectionStatus`].
    pub const COLLECTION_PAUSE: &'static str = "collection.pause";
    /// `{collection}` → [`CollectionStatus`].
    pub const COLLECTION_RESUME: &'static str = "collection.resume";
    /// `{collection}` → `Vec<`[`HoldSummary`]`>`: files the replica protected
    /// instead of overwriting (content-free; the SDK shows the versions).
    pub const COLLECTION_HOLDS: &'static str = "collection.holds";
    /// [`ResolveHold`] → [`HoldResolved`]: resolve one hold as the hosting app.
    pub const COLLECTION_RESOLVE_HOLD: &'static str = "collection.resolve_hold";
    /// `{collection}` → the client API's `list_conflicts` result.
    pub const COLLECTION_CONFLICTS: &'static str = "collection.conflicts";
    /// [`JoinCollection`] → [`CollectionStatus`]: join an account's cloud copy into
    /// an empty folder (enrolled through Connect; hosted then keys this device).
    pub const COLLECTION_JOIN: &'static str = "collection.join";
    /// [`EnableSync`] → [`CollectionStatus`]: adopt the folder and start syncing.
    pub const SYNC_ENABLE: &'static str = "sync.enable";
    /// `{collection}` → [`CollectionStatus`]: stop syncing; the folder stays here
    /// as a local collection.
    pub const SYNC_DISABLE: &'static str = "sync.disable";
    /// `{collection}` → `[PendingDevice]` (end-to-end synced collections).
    pub const DEVICE_PENDING: &'static str = "device.pending";
    /// [`ApproveDevice`] → `{}`.
    pub const DEVICE_APPROVE: &'static str = "device.approve";
    /// `{collection, device}` → `{}`.
    pub const DEVICE_REJECT: &'static str = "device.reject";
    /// `{collection}` → `{configured, device?}`.
    pub const RECOVERY_STATUS: &'static str = "recovery.status";
    /// `{collection}` → `{recovery_key, device}`: shown once, never stored.
    pub const RECOVERY_CREATE: &'static str = "recovery.create";
    /// `{collection, recovery_key}` → [`CollectionStatus`].
    pub const RECOVERY_IMPORT: &'static str = "recovery.import";
    /// `{}` → `{mode, version, unlocked}`: the account key (AK1).
    pub const PRIVATE_STATUS: &'static str = "private.status";
    /// `{password}` → `{recovery_key, collections}`: set up the account key; the
    /// recovery key is shown once and never stored in clear.
    pub const PRIVATE_SETUP: &'static str = "private.setup";
    /// `{password?, recovery_key?}` → `{collections}`: unlock this device.
    pub const PRIVATE_UNLOCK: &'static str = "private.unlock";
    /// `{password, recovery_key?}` → `{version}`: change the password (re-wrap).
    pub const PRIVATE_PASSWORD: &'static str = "private.password";
    /// `{}` → `{version, revoked}`: strict mode (SAS approval only).
    pub const PRIVATE_STRICT: &'static str = "private.strict";
    /// `[Check]`.
    pub const DOCTOR: &'static str = "doctor";
    /// `{}` → `{record, revived, holds}`: the local takeover of an old connector
    /// (`<state>/takeover.json`; `record` is null when there is none).
    pub const MIGRATE_STATUS: &'static str = "migrate.status";
    /// [`MigrateStart`] → as `migrate.status`: run (or resume) the takeover now.
    pub const MIGRATE_START: &'static str = "migrate.start";
    /// `{collection?}` → `[AccessEntry]`: apps that can use local collections.
    pub const ACCESS_LIST: &'static str = "access.list";
    /// `{grant}` → `AccessEntry`: revoke on this device. Always allowed.
    pub const ACCESS_REVOKE: &'static str = "access.revoke";
    /// `{grant}` → `AccessEntry`: approve a pending grant.
    pub const ACCESS_APPROVE: &'static str = "access.approve";
    /// `{grant}` → `AccessEntry`: decline a pending grant.
    pub const ACCESS_DENY: &'static str = "access.deny";
    /// `{grant}` → `AccessEntry`: acknowledge the new-access notification.
    pub const ACCESS_ACK: &'static str = "access.ack";
    /// `{server_url?, name?}` → `{verification_uri, expires_in}`: start signing in
    /// (pairing as a connector). The daemon completes it in the background;
    /// `status.account` shows progress.
    pub const ACCOUNT_SIGN_IN: &'static str = "account.sign_in";
    /// → `{}`: sign out: stop the relay, forget the credential. Local grants
    /// stop being served (their leases are cleared).
    pub const ACCOUNT_SIGN_OUT: &'static str = "account.sign_out";
    /// → `{nonce}`: start caller authentication on this connection.
    pub const AUTH_CHALLENGE: &'static str = "auth.challenge";
    /// `{proof}` → `{}`: `proof = hex(HMAC-SHA256(control key, "mdbase/v1/control-auth" ‖ nonce))`.
    /// The connection is then **privileged**.
    pub const AUTH_PROVE: &'static str = "auth.prove";
    /// → [`Settings`].
    pub const SETTINGS_GET: &'static str = "settings.get";
    /// [`Settings`] (partial) → [`Settings`]. Turning approval *off* requires on-screen
    /// confirmation.
    pub const SETTINGS_SET: &'static str = "settings.set";
}

/// Why the daemon is not ready.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NotReady {
    /// Still starting.
    Starting,
    /// Startup failed (for example a malformed registry); see `doctor`.
    InitializationFailed,
    /// The OS credential store is unavailable or the device identity is invalid.
    CredentialStoreUnavailable,
    /// A critical worker stopped.
    CriticalWorkerFailed,
    /// Shutting down.
    Stopping,
}

/// The readiness contract (kept from today's connector,
/// `exact-recovery-and-health.md`). Consumers treat an unknown
/// `schema_version`, a different `binary_version` than expected, or a
/// different `control_protocol` as attention, never as success.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Readiness {
    /// Schema of this object.
    pub schema_version: u32,
    /// Whether the daemon serves requests normally.
    pub ready: bool,
    /// The daemon binary's version.
    pub binary_version: String,
    /// The control protocol major it speaks.
    pub control_protocol: u32,
    /// Set when not ready.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub safe_reason: Option<NotReady>,
}

/// The daemon's own state.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DaemonStatus {
    /// Readiness.
    pub readiness: Readiness,
    /// Process ID.
    pub pid: u32,
    /// Installed service or isolated profile.
    pub target: Target,
    /// State directory.
    pub state_dir: PathBuf,
    /// When the process started (ms since the epoch).
    pub started_at_ms: u64,
    /// Secret backend in use (`keychain`, or `insecure-test-file` in tests).
    pub secret_backend: String,
    /// This device (absent until the identity loads).
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub device: Option<DeviceInfo>,
    /// Account and control-plane reachability, kept separate from readiness.
    pub account: AccountInfo,
    /// Every registered collection.
    pub collections: Vec<CollectionStatus>,
}

/// Public device identity.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeviceInfo {
    /// Device ID.
    pub device_id: String,
    /// Noise static public key (hex): apps on this machine pin it for local IPC.
    pub noise_pk: String,
    /// Ed25519 public key (hex).
    pub sign_pk: String,
}

/// Account state. Never contains credentials.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AccountInfo {
    /// Whether this device is signed in to an mdbase account.
    pub signed_in: bool,
    /// Whether the relay socket is up.
    pub online: bool,
    /// A sign-in waiting for approval: the page to open.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pairing: Option<String>,
    /// The last account-link problem, if any.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    /// The paired account's ID (a UUID; not a secret), once signed in.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
    /// The control plane this device is signed in to, once signed in.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub server: Option<String>,
    /// This build's environment (`production` or `lab`).
    #[serde(default)]
    pub environment: String,
}

/// What a collection is doing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CollectionState {
    /// Registered and paused by the user.
    Paused,
    /// Opening its replica (recovery, index warm-up, log catch-up).
    Opening,
    /// Serving.
    Ready,
    /// Serving, with a log move (sync enable/disable) in progress.
    Moving,
    /// Not served; see `reason` (for example `runtime_pending`, `folder_missing`).
    Unavailable,
    /// Failed; see `reason`. Files are untouched.
    Failed,
}

/// Where the log lives.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LogLocation {
    /// No log: a local collection, confirmed by durable publish to the file.
    None,
    /// The hosted blind log service.
    Hosted,
}

/// A collection-level notice for the UI. `code` is stable.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Notice {
    /// Stable code, e.g. `no_other_device_online`, `holds_pending`,
    /// `devices_waiting_for_approval`, `recovery_key_not_set_up`.
    pub code: String,
    /// For people.
    pub message: String,
}

/// Replica sync counters ("confirmed through N, plus pending";
/// `replica-client-api.md` §7).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SyncCounters {
    /// Highest log position applied.
    pub confirmed_through: u64,
    /// Highest head heard of.
    pub head_known: u64,
    /// Unconfirmed mutations.
    pub pending: u64,
    /// Held files.
    pub holds: u64,
    /// Unresolved conflicts.
    pub unresolved: u64,
    /// `online`, `connecting` or `offline` (to the log).
    pub connection: String,
    /// Chain digest at confirmed_through (not the advertised/unapplied head).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub head_digest: Option<String>,
    /// Content-free confirmed-record tuple digest, not normalized markdown.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confirmed_record_digest: Option<ConfirmedRecordDigest>,
    /// Stable incident code only; never remote details or user content.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    /// Snapshot installation, bootstrap, or not yet caught up to the known head.
    #[serde(default)]
    pub resyncing: bool,
    /// Folder entries not synced because they are symlinks (never followed)
    /// or other special files, as of the last full scan.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub unsupported_entries: u64,
}

fn is_zero(n: &u64) -> bool {
    *n == 0
}

/// Hash of ID-ordered confirmed (id, path, revision, modified_seq) tuples.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ConfirmedRecordDigest {
    /// Exact existing Runtime::confirmed_digest algorithm identifier.
    pub algorithm: String,
    /// Confirmed records covered by the hash.
    pub records: u64,
    /// Hex SHA-256; no record bytes are returned.
    pub digest: String,
    /// Actor's applied position at the same observation.
    pub confirmed_through: u64,
}

/// One collection, as the CLI and desktop show it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CollectionStatus {
    /// Collection ID.
    pub id: String,
    /// Display name.
    pub name: String,
    /// Folder.
    pub root: PathBuf,
    /// Local, synced, or synced end-to-end.
    pub mode: SyncMode,
    /// How it was registered.
    pub origin: Origin,
    /// Where the log lives.
    pub log: LogLocation,
    /// What it is doing.
    pub state: CollectionState,
    /// Stable reason when not `ready`.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub reason: Option<String>,
    /// Counters, once the replica is open.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub sync: Option<SyncCounters>,
    /// End-to-end synced: how many of the user's *other* device replicas are online, if
    /// known. Thin clients (web apps) can load data only while at least one device
    /// replica is online.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub other_devices_online: Option<u32>,
    /// Notices.
    #[serde(default)]
    pub notices: Vec<Notice>,
}

/// One protected file, for the tray and the CLI (`replica-client-api.md` §8.1).
/// Content-free: the SDK's hold surface carries the versions themselves.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HoldSummary {
    /// Record or file ID.
    pub id: String,
    /// Path in the collection.
    pub path: String,
    /// Wire `HoldReason`, snake_case: `conflict`, `unknown_provenance`,
    /// `deleted_elsewhere`, `read_only`, `editor_busy`, `suspect_write`.
    pub reason: String,
    /// When the hold began (ms).
    pub since: i64,
    /// User saves collected while held.
    pub saves: u64,
    /// Whether a confirmed version exists to take.
    pub has_theirs: bool,
    /// Whether the file is binary (resolved by upload through the SDK, never here).
    pub binary: bool,
}

/// `collection.resolve_hold` params.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResolveHold {
    /// Collection ID.
    pub collection: String,
    /// Record or file ID.
    pub id: String,
    /// What to do.
    pub how: HoldAction,
}

/// The hold resolutions the hosting app offers (wire `HoldResolution` names). `use`
/// and uploads need content and stay with the SDK.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HoldAction {
    /// Mine: three-way merge preferring mine (records), or replace (files).
    KeepMine,
    /// The confirmed version.
    TakeTheirs,
    /// Mine at a `name (conflict <device> <date>).ext` path, theirs at the original.
    KeepBoth,
    /// Delete it.
    Delete,
}

/// `collection.resolve_hold` result.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HoldResolved {
    /// The resolving mutation.
    pub mutation: String,
    /// Receipt state: `pending`, `confirmed`, `rejected` or `unknown`.
    pub state: String,
}

/// `collection.add` params.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AddCollection {
    /// Folder path (absolute, or relative to the client's working directory; the
    /// client resolves it before sending).
    pub path: PathBuf,
    /// Display name (default: the folder name).
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub name: Option<String>,
}

/// `collection.join` params.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct JoinCollection {
    /// The collection to join (UUID).
    pub collection: String,
    /// An empty folder (absolute; the client resolves it).
    pub path: PathBuf,
    /// Display name (default: the folder name).
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub name: Option<String>,
    /// A private (end-to-end) collection: enrol this device, then unlock it with
    /// the account key (`private.unlock`) or approve it from another device.
    #[serde(skip_serializing_if = "std::ops::Not::not", default)]
    pub private: bool,
}

/// `private.*` secrets: the password and/or recovery key. Zeroized on drop; never
/// logged or echoed.
#[derive(Clone, Default, Serialize, Deserialize)]
pub struct PrivateSecret {
    /// The encryption password.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub password: Option<String>,
    /// The recovery key (`MDB1-…`).
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub recovery_key: Option<String>,
}

impl std::fmt::Debug for PrivateSecret {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("PrivateSecret(..)")
    }
}

impl Drop for PrivateSecret {
    fn drop(&mut self) {
        use zeroize::Zeroize;
        if let Some(p) = self.password.as_mut() {
            p.zeroize();
        }
        if let Some(k) = self.recovery_key.as_mut() {
            k.zeroize();
        }
    }
}

/// `sync.enable` params.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EnableSync {
    /// Collection ID.
    pub collection: String,
    /// `synced` (with the hosted replica) or `synced_e2e` (end-to-end encrypted,
    /// no hosted replica).
    pub mode: SyncMode,
}

/// A device waiting for approval (end-to-end synced collections; `replica-client-api.md` §8.3).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PendingDevice {
    /// Device ID.
    pub device: String,
    /// Account ID.
    pub account: String,
    /// `desktop`, `mobile`, ...
    pub kind: String,
    /// The six-digit code to compare with the new device's screen.
    pub code: String,
}

/// `device.approve` params.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ApproveDevice {
    /// Collection ID.
    pub collection: String,
    /// Device ID.
    pub device: String,
    /// The six digits the user confirmed.
    pub code: String,
}

/// Methods that need a privileged connection: they widen access, reveal secrets
/// or hide notices. Narrowing access (revoke, deny, pause, remove) never does.
pub const PRIVILEGED: &[&str] = &[
    Method::ACCESS_APPROVE,
    Method::ACCESS_ACK,
    Method::SETTINGS_SET,
    Method::DEVICE_PENDING,
    Method::DEVICE_APPROVE,
    Method::RECOVERY_CREATE,
    Method::RECOVERY_IMPORT,
    Method::PRIVATE_SETUP,
    Method::PRIVATE_UNLOCK,
    Method::PRIVATE_PASSWORD,
    Method::PRIVATE_STRICT,
    Method::SYNC_ENABLE,
    Method::COLLECTION_JOIN,
    Method::ACCOUNT_SIGN_IN,
    Method::MIGRATE_START,
];

/// [`Method::MIGRATE_START`] params.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct MigrateStart {
    /// Proceed past old hosted mirrors once their upload queues are empty (they stop
    /// syncing until they join the migrated collection).
    #[serde(default)]
    pub stop_mirrors: bool,
}

/// Device settings.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Settings {
    /// Opt-in: new app grants for local collections wait for approval here.
    pub require_grant_approval: bool,
}

/// `{grant}` params.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GrantRef {
    /// Grant ID.
    pub grant: String,
}

/// `{collection}` params.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CollectionRef {
    /// Collection ID.
    pub collection: String,
}

/// One `doctor` check.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Check {
    /// Stable check ID.
    pub id: String,
    /// `ok`, `warn` or `fail`.
    pub status: String,
    /// What was found.
    pub detail: String,
    /// What to do, when not ok.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub action: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frames_serialize_compactly() {
        let ok = serde_json::to_string(&Response::ok(3, serde_json::json!({"a":1}))).unwrap();
        assert_eq!(ok, r#"{"v":1,"id":3,"result":{"a":1}}"#);
        let push = serde_json::to_string(&Response::push("status", Value::Null)).unwrap();
        assert_eq!(push, r#"{"v":1,"push":"status","payload":null}"#);
        let r = Readiness {
            schema_version: READINESS_SCHEMA,
            ready: false,
            binary_version: "0.0.0".into(),
            control_protocol: PROTOCOL,
            safe_reason: Some(NotReady::CredentialStoreUnavailable),
        };
        assert_eq!(
            serde_json::to_string(&r).unwrap(),
            r#"{"schema_version":1,"ready":false,"binary_version":"0.0.0","control_protocol":1,"safe_reason":"credential_store_unavailable"}"#
        );
    }
}
