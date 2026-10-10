//! The in-process client API (`docs/contracts/replica-client-api.md`).
//!
//! [`ClientApi`] is what apps and plugins call on a replica, as typed Rust. Every
//! transport is an adapter over it:
//!
//! | Transport | Adapter | Owner |
//! |---|---|---|
//! | in-process (shared runtime, §12.1) | `mdbn-wasm` bindings → TS SDK | sdk |
//! | local IPC (§12.2) | frames over a socket/pipe, Noise | daemon |
//! | remote (§12.3) | frames over Noise through the relay or a WebSocket | hosted, control |
//!
//! Frame-level dispatch (`method` strings and CBOR params, `cancel`, `await`,
//! `wait: confirmed`) is a thin layer that maps frames to these calls and turns
//! [`Push`]es into `c-push` frames. `await` and `wait: confirmed` are implemented
//! there by watching [`Push::Receipt`] for the session; the replica itself never
//! blocks.
//!
//! **Sessions.** [`ClientApi::hello`] opens one. The host authenticates the client
//! first (Noise static key → grant, or "hosting app") and passes the result as
//! [`SessionAuth`]; the replica binds the session to that grant and checks every
//! call against the grant's capabilities in its current confirmed policy
//! (`policy.md` §7).
//!
//! **Pushes.** Calls that start a stream (subscriptions, `read_file`, receipts of
//! submitted mutations) produce [`Push`]es, which the host drains with
//! [`ClientApi::take_pushes`] after every call into the replica.

use std::fmt;

use mdbn_wire::client::{
    Change, FileChunk, FileView, HelloParams, HelloResult, Hold, Include, Issue, Materialization,
    OpenUploadParams, OpenUploadResult, Peer, Problem, QueryResult, QueryUpdate, Receipt, Recovery,
    SubmitParams, SyncStatus, TransferProgress, UploadChunkParams,
};
use mdbn_wire::common::{Hash, Uuid, Value};
use mdbn_wire::intent::MediaClass;
use mdbn_wire::policy::DeviceKind;

// ------------------------------------------------------------------ errors

/// The 15 error codes (§9). Each has exactly one recovery action.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum ErrorCode {
    /// Malformed params or ops.
    InvalidRequest,
    /// Rejected by single-record validation, or an invalid resource write.
    InvalidRecord,
    /// No such record, file, hold, subscription, view or transfer.
    NotFound,
    /// The current state doesn't allow this write.
    Conflict,
    /// No or expired session, or the grant was revoked.
    Unauthenticated,
    /// The grant lacks the capability, or the role doesn't allow it.
    Forbidden,
    /// The catalog can't be loaded.
    CollectionInvalid,
    /// Starting, moving its lease, or not reachable.
    Unavailable,
    /// Over a request or presence limit.
    RateLimited,
    /// Over the storage quota.
    QuotaExceeded,
    /// Over a size limit.
    TooLarge,
    /// Unsupported API version, or the replica can't write this collection.
    UpgradeRequired,
    /// The outcome can't be determined.
    OutcomeUnknown,
    /// Cancelled by the client.
    Cancelled,
    /// A bug.
    Internal,
}

impl ErrorCode {
    /// All codes, in the contract's order.
    pub const ALL: [ErrorCode; 15] = [
        ErrorCode::InvalidRequest,
        ErrorCode::InvalidRecord,
        ErrorCode::NotFound,
        ErrorCode::Conflict,
        ErrorCode::Unauthenticated,
        ErrorCode::Forbidden,
        ErrorCode::CollectionInvalid,
        ErrorCode::Unavailable,
        ErrorCode::RateLimited,
        ErrorCode::QuotaExceeded,
        ErrorCode::TooLarge,
        ErrorCode::UpgradeRequired,
        ErrorCode::OutcomeUnknown,
        ErrorCode::Cancelled,
        ErrorCode::Internal,
    ];

    /// The code as on the wire.
    pub fn as_str(self) -> &'static str {
        match self {
            ErrorCode::InvalidRequest => "invalid_request",
            ErrorCode::InvalidRecord => "invalid_record",
            ErrorCode::NotFound => "not_found",
            ErrorCode::Conflict => "conflict",
            ErrorCode::Unauthenticated => "unauthenticated",
            ErrorCode::Forbidden => "forbidden",
            ErrorCode::CollectionInvalid => "collection_invalid",
            ErrorCode::Unavailable => "unavailable",
            ErrorCode::RateLimited => "rate_limited",
            ErrorCode::QuotaExceeded => "quota_exceeded",
            ErrorCode::TooLarge => "too_large",
            ErrorCode::UpgradeRequired => "upgrade_required",
            ErrorCode::OutcomeUnknown => "outcome_unknown",
            ErrorCode::Cancelled => "cancelled",
            ErrorCode::Internal => "internal",
        }
    }

    /// Parse a wire code.
    pub fn parse(s: &str) -> Option<ErrorCode> {
        ErrorCode::ALL.into_iter().find(|c| c.as_str() == s)
    }

    /// The one recovery action for this code.
    pub fn recovery(self) -> Recovery {
        match self {
            ErrorCode::InvalidRequest | ErrorCode::InvalidRecord | ErrorCode::TooLarge => {
                Recovery::FixRequest
            }
            ErrorCode::NotFound => Recovery::Refresh,
            ErrorCode::Conflict => Recovery::ResolveConflict,
            ErrorCode::Unauthenticated | ErrorCode::Forbidden => Recovery::Reauthorize,
            ErrorCode::CollectionInvalid => Recovery::RepairCollection,
            ErrorCode::Unavailable | ErrorCode::RateLimited => Recovery::Retry,
            ErrorCode::QuotaExceeded => Recovery::FreeSpace,
            ErrorCode::UpgradeRequired => Recovery::Upgrade,
            ErrorCode::OutcomeUnknown => Recovery::ResolveOutcome,
            ErrorCode::Cancelled => Recovery::None,
            ErrorCode::Internal => Recovery::ContactSupport,
        }
    }

    /// A problem with this code and a developer message.
    pub fn problem(self, message: impl Into<String>) -> Problem {
        Problem {
            code: self.as_str().to_string(),
            recovery: self.recovery(),
            message: message.into(),
            reason: None,
            details: None,
            retry_after_ms: None,
            issues: None,
            trace_id: None,
        }
    }

    /// A problem with a reason (a stable, documented finer cause).
    pub fn problem_with_reason(self, reason: &str, message: impl Into<String>) -> Problem {
        let mut p = self.problem(message);
        p.reason = Some(reason.to_string());
        p
    }

    /// An [`ApiError`] with this code.
    pub fn err(self, message: impl Into<String>) -> ApiError {
        self.problem(message).into()
    }

    /// An [`ApiError`] with this code and a reason.
    pub fn err_with_reason(self, reason: &str, message: impl Into<String>) -> ApiError {
        self.problem_with_reason(reason, message).into()
    }
}

impl fmt::Display for ErrorCode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Stable `reason`s of `conflict` (§9).
pub mod conflict_reason {
    /// `if_revision` (CAS) mismatch.
    pub const REVISION: &str = "revision";
    /// The explicit path is taken.
    pub const PATH_TAKEN: &str = "path_taken";
    /// An enforced unique value is taken.
    pub const DUPLICATE_VALUE: &str = "duplicate_value";
    /// A body merge conflicted.
    pub const BODY: &str = "body";
    /// The body base could not be obtained.
    pub const BODY_BASE_UNAVAILABLE: &str = "body_base_unavailable";
    /// The record was renamed (stale `from`).
    pub const RENAMED: &str = "renamed";
}

/// A failed call: a [`Problem`] (boxed; problems are large and rare).
#[derive(Debug, Clone, PartialEq)]
pub struct ApiError(pub Box<Problem>);

impl ApiError {
    /// The problem.
    pub fn problem(&self) -> &Problem {
        &self.0
    }

    /// The problem, by value.
    pub fn into_problem(self) -> Problem {
        *self.0
    }

    /// The error code, if it is one of the 15.
    pub fn code(&self) -> Option<ErrorCode> {
        ErrorCode::parse(&self.0.code)
    }
}

impl From<Problem> for ApiError {
    fn from(p: Problem) -> ApiError {
        ApiError(Box::new(p))
    }
}

impl fmt::Display for ApiError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match &self.0.reason {
            Some(r) => write!(f, "{} ({r}): {}", self.0.code, self.0.message),
            None => write!(f, "{}: {}", self.0.code, self.0.message),
        }
    }
}

impl std::error::Error for ApiError {}

/// API result.
pub type ApiResult<T> = Result<T, ApiError>;

// ------------------------------------------------------------------ sessions

/// A client session on this replica.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct SessionId(pub u64);

/// Who the host authenticated, before `hello`.
#[derive(Debug, Clone, PartialEq)]
pub enum SessionAuth {
    /// The app hosting the replica (the desktop app over its own daemon, the plugin
    /// that owns the shared runtime). Needs no grant; may approve devices and set
    /// materialization.
    Host,
    /// A client whose Noise static key matched this grant's `client_pk`.
    Grant {
        /// Grant ID.
        grant: Uuid,
        /// The client's static public key, as authenticated.
        client_pk: [u8; 32],
    },
}

/// What to read: a record or file by ID or by path.
#[derive(Debug, Clone, PartialEq)]
pub enum Target {
    /// By ID.
    Id(Uuid),
    /// By path (exact; resolved through the path key and aliases).
    Path(String),
}

/// A valid contract implementation reported by `describe`.
#[derive(Debug, Clone, PartialEq)]
pub struct ContractImplementation {
    /// Registered contract ID.
    pub contract: String,
    /// Exact resolved version, not the declared requirement.
    pub version: String,
    /// Contract field reference to record field reference.
    pub fields: mdbn_wire::common::DataMap<String>,
    /// Binding value; omitted when empty.
    pub binding: Option<Value>,
}

/// One valid catalog type reported by `describe`.
#[derive(Debug, Clone, PartialEq)]
pub struct TypeSummary {
    /// Type name as written.
    pub name: String,
    /// Type resource path.
    pub path: String,
    /// Valid resolved implementations in canonical catalog order.
    pub implements: Vec<ContractImplementation>,
}

/// One registered contract version reported by `describe`.
#[derive(Debug, Clone, PartialEq)]
pub struct ContractSummary {
    /// Registered contract ID.
    pub id: String,
    /// Exact version.
    pub version: String,
    /// Contract resource path.
    pub path: String,
    /// Canonical contract digest.
    pub digest: Hash,
    /// Contract type (`record`, `event` or `action`).
    pub contract_type: String,
    /// Types implementing this exact version, in canonical order.
    pub implemented_by: Vec<String>,
}

/// One definition document in the authoritative local resource view.
#[derive(Debug, Clone, PartialEq)]
pub struct ResourceView {
    /// Exact portable resource path.
    pub path: String,
    /// Revision of the returned source, usable for resource CAS.
    pub revision: Hash,
    /// UTF-8 source bytes.
    pub size: u64,
    /// Whether the source is confirmed rather than locally pending.
    pub confirmed: bool,
    /// Complete resource source, never a synthesized catalog projection.
    pub text: String,
}

/// Selection for a bounded, confirmed resource inventory page.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ListResources {
    /// Optional portable directory prefix, not an authorization scope.
    pub folder: Option<String>,
    /// Include exact source (default false).
    pub text: Option<bool>,
    /// Opaque session-bound continuation.
    pub cursor: Option<String>,
    /// Maximum rows (default 64, range 1–128).
    pub limit: Option<u32>,
}

/// One exact tracked resource; invalid catalog definitions remain visible.
#[derive(Debug, Clone, PartialEq)]
pub struct ResourceListEntry {
    /// Exact portable tracked path.
    pub path: String,
    /// Revision of the complete source.
    pub revision: Hash,
    /// Complete UTF-8 source size.
    pub size: u64,
    /// Confirmed rather than pending source.
    pub confirmed: bool,
    /// Complete source when requested, never truncated.
    pub text: Option<String>,
}

/// One page; only a terminal page is complete.
#[derive(Debug, Clone, PartialEq)]
pub struct ResourceList {
    /// Tracked resources in UTF-8 byte order.
    pub resources: Vec<ResourceListEntry>,
    /// True only at the end of a consistent inventory.
    pub complete: bool,
    /// Nonempty continuation on every nonterminal page.
    pub cursor: Option<String>,
}

impl ResourceList {
    pub(crate) fn to_cbor(&self) -> mdbn_wire::Cbor {
        use mdbn_wire::{Cbor, Wire};
        let resources = self
            .resources
            .iter()
            .map(|r| {
                let mut fields = vec![
                    (Cbor::Uint(0), Cbor::Text(r.path.clone())),
                    (Cbor::Uint(1), r.revision.to_cbor()),
                    (Cbor::Uint(2), Cbor::Uint(r.size)),
                    (Cbor::Uint(3), Cbor::Uint(u64::from(!r.confirmed))),
                ];
                if let Some(text) = &r.text {
                    fields.push((Cbor::Uint(4), Cbor::Text(text.clone())));
                }
                Cbor::Map(fields)
            })
            .collect();
        let mut fields = vec![
            (Cbor::Uint(0), Cbor::Array(resources)),
            (Cbor::Uint(1), Cbor::Bool(self.complete)),
        ];
        if let Some(cursor) = &self.cursor {
            fields.push((Cbor::Uint(2), Cbor::Text(cursor.clone())));
        }
        Cbor::Map(fields)
    }
}

/// `describe` result: the typed catalog summary served to the SDK.
#[derive(Debug, Clone, PartialEq)]
pub struct Describe {
    /// Spec version the collection declares.
    pub spec_version: String,
    /// Valid types and their resolved implementations.
    pub types: Vec<TypeSummary>,
    /// Settings (`mdbase.yaml` `settings`), as a value.
    pub settings: Value,
    /// File inclusion policy (replica-client-api.md §10.3).
    pub inclusion: mdbn_wire::intent::FileInclusion,
    /// Problems loading the catalog, if any (then writes fail `collection_invalid`).
    pub issues: Vec<Issue>,
    /// Registered contracts, ordered by ID and exact version.
    pub contracts: Vec<ContractSummary>,
}

/// `changes` result (§4).
#[derive(Debug, Clone, PartialEq)]
pub struct ChangesResult {
    /// Changes since the cursor.
    pub changes: Vec<Change>,
    /// Cursor to continue from.
    pub cursor: String,
    /// The cursor could not be served: re-read what you cache.
    pub reset: bool,
}

/// One unresolved conflict, for `list_conflicts` (§8.2).
#[derive(Debug, Clone, PartialEq)]
pub struct ConflictEntry {
    /// The mutation whose entry recorded it.
    pub mutation: Uuid,
    /// Position.
    pub seq: u64,
    /// The conflict. Attachment sides are ConflictValue5 (runtime family).
    pub conflict: mdbn_wire::attachment_runtime_v1::Conflict,
}

/// How to resolve a hold (§8.1).
#[derive(Debug, Clone, PartialEq)]
pub enum HoldResolution {
    /// Mine: three-way merge preferring mine (records), or replace (files).
    KeepMine,
    /// The confirmed version.
    TakeTheirs,
    /// This document (records).
    Use(String),
    /// A completed upload's transfer ID (files).
    UseUpload(Uuid),
    /// Delete it.
    Delete,
    /// Mine at a new `name (conflict <device> <date>).ext` path, theirs at the original.
    KeepBoth,
}

/// A device waiting for approval (§8.3).
#[derive(Debug, Clone, PartialEq)]
pub struct PendingDevice {
    /// Device ID.
    pub device: Uuid,
    /// Account.
    pub account: Uuid,
    /// Kind.
    pub kind: DeviceKind,
    /// The current challenge/reveal exchange is ready for USER input.
    /// This is not approval or key delivery. An approver's expected SAS is never
    /// exposed by this DTO (legacy wire slot 3 is decode-only/deprecated).
    pub exchange_ready: bool,
}

/// `list_files` params (§10.1).
#[derive(Debug, Clone, PartialEq, Default)]
pub struct ListFiles {
    /// Folder.
    pub folder: Option<String>,
    /// Media classes.
    pub media: Option<Vec<MediaClass>>,
    /// Cursor.
    pub cursor: Option<String>,
    /// Limit.
    pub limit: Option<u32>,
}

/// `list_files` result.
#[derive(Debug, Clone, PartialEq)]
pub struct FileList {
    /// Files.
    pub files: Vec<FileView>,
    /// Next-page cursor.
    pub cursor: Option<String>,
    /// False during a snapshot install.
    pub complete: bool,
}

/// A download stream (§10.2).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct StreamId(pub u64);

/// What a fence client reports about one open editor (§14).
#[derive(Debug, Clone, PartialEq)]
pub struct FenceEditor {
    /// Path.
    pub path: String,
    /// Has unsaved changes.
    pub dirty: bool,
    /// Hash of the buffer.
    pub buffer: Hash,
}

/// The replica asks a fence client to edit a buffer (§14).
#[derive(Debug, Clone, PartialEq)]
pub struct FenceApply {
    /// Path.
    pub path: String,
    /// Hash the buffer must have.
    pub base: Hash,
    /// Edits: `(start, end, insert)` in Unicode scalar offsets over the document.
    pub edits: Vec<(u64, u64, String)>,
    /// Hash after the edits.
    pub expected: Hash,
}

/// A fence client's answer.
#[derive(Debug, Clone, PartialEq)]
pub enum FenceResult {
    /// Applied.
    Applied,
    /// No editor has the file open any more.
    NotOpen,
    /// The buffer changed; here it is.
    BufferChanged(String),
}

/// A replica-to-client request ID (fence callbacks).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct CallbackId(pub u64);

/// Something the replica sends to a session without being asked.
#[derive(Debug, Clone, PartialEq)]
pub enum Push {
    /// A receipt of this session's mutation changed state (`receipt`).
    Receipt(Receipt),
    /// A live query update (`query-update`).
    QueryUpdate(QueryUpdate),
    /// Change feed entries (`changes`), for `watch: true`.
    Changes(ChangesResult),
    /// Status changed (`status`), at most 4 per second.
    Status(SyncStatus),
    /// The holds list changed (`holds`).
    Holds(Vec<Hold>),
    /// The conflicts list changed (`conflicts`).
    Conflicts(Vec<ConflictEntry>),
    /// Presence on a record changed (`presence`).
    Presence {
        /// Record.
        record: Uuid,
        /// Peers.
        peers: Vec<Peer>,
    },
    /// Download bytes (`file-chunk`).
    FileChunk(FileChunk),
    /// Transfer progress (`transfer-progress`).
    TransferProgress(TransferProgress),
    /// A host-only device approval exchange changed readiness (`approval`).
    /// Contains no computed SAS; readiness is not approval or key delivery.
    ApprovalReady {
        /// The requesting device.
        device: Uuid,
        /// Whether the current challenge/reveal context accepts USER input.
        exchange_ready: bool,
    },
    /// A fence request the client must answer with [`ClientApi::fence_result`].
    FenceApply {
        /// Callback ID.
        id: CallbackId,
        /// The edit.
        apply: FenceApply,
    },
    /// The session was closed by the replica (grant revoked, collection gone).
    Closed(Problem),
}

impl Push {
    /// The push type on the wire (`c-push` key 1).
    pub fn kind(&self) -> &'static str {
        match self {
            Push::Receipt(_) => "receipt",
            Push::QueryUpdate(_) => "query_update",
            Push::Changes(_) => "changes",
            Push::Status(_) => "status",
            Push::Holds(_) => "holds",
            Push::Conflicts(_) => "conflicts",
            Push::Presence { .. } => "presence",
            Push::FileChunk(_) => "file_chunk",
            Push::TransferProgress(_) => "transfer_progress",
            Push::ApprovalReady { .. } => "approval",
            Push::FenceApply { .. } => "fence_apply",
            Push::Closed(_) => "closed",
        }
    }
}

// ------------------------------------------------------------------ the API

/// The replica client API, in process.
///
/// Every method that takes a [`SessionId`] fails with `unauthenticated` for an
/// unknown or closed session, and with `forbidden` when the session's grant lacks
/// the capability (`policy.md` §5).
pub trait ClientApi {
    // ---- session (§2) ----

    /// Open a session. The host has authenticated the client as `auth`.
    fn hello(
        &mut self,
        auth: SessionAuth,
        params: HelloParams,
    ) -> ApiResult<(SessionId, HelloResult)>;
    /// Close a session: drops its subscriptions, presence and streams.
    fn close(&mut self, session: SessionId);

    // ---- reads (§3, §4) ----

    /// Catalog summary.
    fn describe(&mut self, session: SessionId) -> ApiResult<Describe>;
    /// One resource source from the local view, under the current READ gate.
    fn get_resource(&mut self, session: SessionId, path: String) -> ApiResult<ResourceView>;
    /// A bounded confirmed inventory, independent of catalog validity.
    fn list_resources(
        &mut self,
        session: SessionId,
        params: ListResources,
    ) -> ApiResult<ResourceList>;
    /// One record from the local view.
    fn get(
        &mut self,
        session: SessionId,
        target: Target,
        include: Include,
    ) -> ApiResult<mdbn_wire::client::RecordView>;
    /// A query (spec 11 query object) over the local view.
    fn query(
        &mut self,
        session: SessionId,
        query: Value,
        include: Include,
    ) -> ApiResult<QueryResult>;
    /// A live query; pushes a `snapshot`, then `diff`s and `reset`s.
    fn subscribe(&mut self, session: SessionId, query: Value, include: Include) -> ApiResult<u64>;
    /// Stop a live query.
    fn unsubscribe(&mut self, session: SessionId, sub: u64) -> ApiResult<()>;
    /// The change feed after `cursor` (`None`: from now). `watch` pushes later changes.
    fn changes(
        &mut self,
        session: SessionId,
        cursor: Option<String>,
        limit: Option<u32>,
        watch: bool,
    ) -> ApiResult<ChangesResult>;
    /// Validate records (all when `None`).
    fn validate(
        &mut self,
        session: SessionId,
        targets: Option<Vec<Target>>,
    ) -> ApiResult<Vec<(Uuid, Vec<Issue>)>>;

    // ---- writes (§5, §6) ----

    /// Submit operations: one receipt per mutation (several with `allow_partial`).
    /// Returns as soon as the mutation is captured (`pending`) or rejected; the
    /// frame layer implements `wait: confirmed` from [`Push::Receipt`].
    fn submit(&mut self, session: SessionId, params: SubmitParams) -> ApiResult<Vec<Receipt>>;
    /// The current receipt of a mutation.
    fn receipt(&mut self, session: SessionId, mutation: Uuid) -> ApiResult<Receipt>;

    // ---- status (§7) ----

    /// "Confirmed through N, plus pending".
    fn status(&mut self, session: SessionId) -> ApiResult<SyncStatus>;
    /// READ-gated chain at an exact handover fence, including when locally ahead.
    /// Adapters without confirmed-prefix evidence fail closed.
    fn applied_prefix(
        &mut self,
        _session: SessionId,
        _seq: u64,
    ) -> ApiResult<mdbn_wire::client::AppliedPrefix> {
        Err(ErrorCode::Unavailable
            .err_with_reason("prefix_unavailable", "confirmed prefix is not available"))
    }
    /// Push [`Push::Status`] on change.
    fn subscribe_status(&mut self, session: SessionId) -> ApiResult<()>;

    // ---- holds and conflicts (§8) ----

    /// Holds on this replica.
    fn list_holds(&mut self, session: SessionId) -> ApiResult<Vec<Hold>>;
    /// Push [`Push::Holds`] on change.
    fn subscribe_holds(&mut self, session: SessionId) -> ApiResult<()>;
    /// Resolve a hold by submitting an ordinary mutation.
    fn resolve_hold(
        &mut self,
        session: SessionId,
        id: Uuid,
        how: HoldResolution,
    ) -> ApiResult<Receipt>;
    /// Unresolved conflicts, optionally of one record.
    fn list_conflicts(
        &mut self,
        session: SessionId,
        record: Option<Uuid>,
    ) -> ApiResult<Vec<ConflictEntry>>;
    /// Push [`Push::Conflicts`] on change.
    fn subscribe_conflicts(&mut self, session: SessionId) -> ApiResult<()>;

    // ---- device approval (§8.3; hosting app only) ----

    /// Devices waiting for a key in an end-to-end collection.
    fn pending_devices(&mut self, session: SessionId) -> ApiResult<Vec<PendingDevice>>;
    /// Approve after the user compared the SAS; appends the `key_grant`.
    fn approve_device(&mut self, session: SessionId, device: Uuid, sas: String) -> ApiResult<()>;
    /// Stop offering a device here.
    fn reject_device(&mut self, session: SessionId, device: Uuid) -> ApiResult<()>;

    // ---- files (§10) ----

    /// List files.
    fn list_files(&mut self, session: SessionId, params: ListFiles) -> ApiResult<FileList>;
    /// One file.
    fn get_file(&mut self, session: SessionId, target: Target) -> ApiResult<FileView>;
    /// Open or resume an upload.
    fn open_upload(
        &mut self,
        session: SessionId,
        params: OpenUploadParams,
    ) -> ApiResult<OpenUploadResult>;
    /// Send one chunk; returns the number of chunks received.
    fn upload_chunk(&mut self, session: SessionId, params: UploadChunkParams) -> ApiResult<u64>;
    /// Commit an upload: captures a `file_put`.
    fn commit_upload(&mut self, session: SessionId, transfer: Uuid) -> ApiResult<Receipt>;
    /// Abandon an upload.
    fn abort_upload(&mut self, session: SessionId, transfer: Uuid) -> ApiResult<()>;
    /// Start a download stream of a pinned revision; bytes arrive as [`Push::FileChunk`].
    fn read_file(
        &mut self,
        session: SessionId,
        target: Target,
        range: Option<(u64, u64)>,
        revision: Option<Hash>,
    ) -> ApiResult<(StreamId, FileView)>;
    /// Flow control for a download stream.
    fn ack_chunks(&mut self, session: SessionId, stream: StreamId, offset: u64) -> ApiResult<()>;
    /// Materialize a remote file on this device.
    fn fetch_file(&mut self, session: SessionId, file: Uuid) -> ApiResult<()>;
    /// Drop the local copy of a confirmed, unheld file (hosting app only).
    fn evict_file(&mut self, session: SessionId, file: Uuid) -> ApiResult<()>;
    /// The device materialization policy.
    fn get_materialization(&mut self, session: SessionId) -> ApiResult<Materialization>;
    /// Set the device materialization policy (hosting app only).
    fn set_materialization(&mut self, session: SessionId, policy: Materialization)
    -> ApiResult<()>;

    // ---- presence (§11) ----

    /// Join a record's presence with a state (≤ 4 KiB).
    fn presence_join(&mut self, session: SessionId, record: Uuid, state: Value) -> ApiResult<()>;
    /// Update presence state (≤ 10/s; extra updates coalesce).
    fn presence_update(&mut self, session: SessionId, record: Uuid, state: Value) -> ApiResult<()>;
    /// Leave a record's presence.
    fn presence_leave(&mut self, session: SessionId, record: Uuid) -> ApiResult<()>;
    /// Push [`Push::Presence`] for a record.
    fn subscribe_presence(&mut self, session: SessionId, record: Uuid) -> ApiResult<()>;

    // ---- editor fence (§14; sessions that asked for "fence") ----

    /// The files open in this client's editors.
    fn fence_report(&mut self, session: SessionId, editors: Vec<FenceEditor>) -> ApiResult<()>;
    /// The answer to a [`Push::FenceApply`].
    fn fence_result(
        &mut self,
        session: SessionId,
        id: CallbackId,
        result: FenceResult,
    ) -> ApiResult<()>;

    // ---- pushes ----

    /// Pushes queued since the last take, per session, in order.
    fn take_pushes(&mut self) -> Vec<(SessionId, Push)>;
}
