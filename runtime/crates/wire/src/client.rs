//! Replica client API messages (`docs/contracts/replica-client-api.md`).

use crate::cbor::Cbor;
use crate::common::{B16, Bytes, DataMap, Hash, Sem, Uuid, Value, Version};
use crate::entry::{Conflict, Status};
use crate::intent::{ConflictMode, MediaClass, Op};
use crate::policy::Role;
use crate::schema::{Ann, SchemaError, Wire, type_err};
use crate::snapshot::TextOrBlob;
use crate::{wire_enum, wire_struct, wire_union};

wire_struct! {
    /// A request.
    pub struct ClientRequest {
        /// Request ID, unique per session.
        1 req id: u64,
        /// Method.
        2 req method: String,
        /// Params.
        3 req params: Cbor,
    }
}

wire_struct! {
    /// A response: exactly one of `result` and `problem`.
    pub struct ClientResponse {
        /// Request ID.
        1 req id: u64,
        /// Result.
        2 opt result: Cbor,
        /// Problem.
        3 opt problem: Problem,
    }
}

wire_struct! {
    /// A push.
    pub struct ClientPush {
        /// Push type.
        1 req kind: String,
        /// Payload.
        2 req payload: Cbor,
    }
}

wire_union! {
    /// A client API frame (replica-client-api.md §1).
    pub enum ClientFrame {
        /// Request.
        0 => Request(ClientRequest),
        /// Response.
        1 => Response(ClientResponse),
        /// Push.
        2 => Push(ClientPush),
    }
}

wire_enum! {
    /// Recovery action of a problem (replica-client-api.md §9).
    pub enum Recovery {
        /// Fix the request.
        FixRequest = 0,
        /// Re-read state.
        Refresh = 1,
        /// Resolve the conflict.
        ResolveConflict = 2,
        /// Authorize again.
        Reauthorize = 3,
        /// Repair the collection's config or types.
        RepairCollection = 4,
        /// Retry later.
        Retry = 5,
        /// Free storage.
        FreeSpace = 6,
        /// Upgrade the app or runtime.
        Upgrade = 7,
        /// Re-read and decide whether to redo the write.
        ResolveOutcome = 8,
        /// Nothing to do.
        None = 9,
        /// Contact support.
        ContactSupport = 10,
    }
}

/// The 15 client error codes and their recovery actions (replica-client-api.md §9).
pub const ERROR_CODES: [(&str, Recovery); 15] = [
    ("invalid_request", Recovery::FixRequest),
    ("invalid_record", Recovery::FixRequest),
    ("not_found", Recovery::Refresh),
    ("conflict", Recovery::ResolveConflict),
    ("unauthenticated", Recovery::Reauthorize),
    ("forbidden", Recovery::Reauthorize),
    ("collection_invalid", Recovery::RepairCollection),
    ("unavailable", Recovery::Retry),
    ("rate_limited", Recovery::Retry),
    ("quota_exceeded", Recovery::FreeSpace),
    ("too_large", Recovery::FixRequest),
    ("upgrade_required", Recovery::Upgrade),
    ("outcome_unknown", Recovery::ResolveOutcome),
    ("cancelled", Recovery::None),
    ("internal", Recovery::ContactSupport),
];

/// The recovery action for an error code, if it is one of the 15.
pub fn recovery_for(code: &str) -> Option<Recovery> {
    ERROR_CODES
        .iter()
        .find(|(c, _)| *c == code)
        .map(|(_, r)| *r)
}

wire_enum! {
    /// Issue severity.
    pub enum Severity {
        /// Warning.
        Warning = 0,
        /// Error.
        Error = 1,
    }
}

wire_struct! {
    /// A validation issue.
    pub struct Issue {
        /// Code.
        0 req code: String,
        /// Severity.
        1 req severity: Severity,
        /// Message.
        2 req message: String,
        /// Details.
        3 opt details: Value,
    }
}

wire_struct! {
    /// A problem (replica-client-api.md §9).
    pub struct Problem {
        /// One of the 15 codes.
        0 req code: String,
        /// Recovery action.
        1 req recovery: Recovery,
        /// For developers.
        2 req message: String,
        /// Finer cause.
        3 opt reason: String,
        /// Details.
        4 opt details: Value,
        /// Retry hint.
        5 opt retry_after_ms: u64,
        /// Issues (invalid_record).
        6 opt issues: Vec<Issue>,
        /// Trace ID.
        7 opt trace_id: String,
    }
}

wire_struct! {
    /// What a session may do.
    pub struct GrantInfo {
        /// Grant ID (absent for the hosting app).
        0 opt grant: Uuid,
        /// Capabilities.
        1 req1 capabilities: Vec<String>,
        /// The granting member's role.
        2 req role: Role,
    }
}

wire_struct! {
    /// `hello` params (replica-client-api.md §2).
    pub struct HelloParams {
        /// API versions the client supports.
        0 req1 versions: Vec<Version>,
        /// Client name (app ID).
        1 req client_name: String,
        /// Client version.
        2 req client_version: String,
        /// Features wanted.
        3 opt features: Vec<String>,
        /// IANA time zone for this session.
        4 opt timezone: String,
    }
}

wire_enum! {
    /// Local-only or synced.
    pub enum SyncMode {
        /// No log.
        LocalOnly = 0,
        /// Synced.
        Synced = 1,
    }
}

wire_enum! {
    /// Connection state.
    pub enum Connection {
        /// Online.
        Online = 0,
        /// Connecting.
        Connecting = 1,
        /// Offline.
        Offline = 2,
    }
}

wire_enum! {
    /// Conditions that need attention.
    pub enum IncidentKind {
        /// A newer format or semantics is in the log.
        UpgradeRequired = 0,
        /// No key for an epoch yet.
        WaitingForKey = 1,
        /// The service returned a broken log.
        Integrity = 2,
        /// This device was revoked.
        AccessRevoked = 3,
        /// Over the storage quota.
        QuotaExceeded = 4,
        /// Read-only member.
        ReadOnly = 5,
        /// Re-execution disagreed with recorded results.
        VerificationMismatch = 6,
        /// Void items in the log.
        VoidedItems = 7,
        /// A rekey sent this device an inconsistent key.
        KeyInconsistent = 8,
        /// Another sync tool works on the same folder.
        ForeignSyncTool = 9,
        /// The collection was deleted or moved.
        Gone = 10,
        /// Acknowledged lost entries could not be recovered.
        LostEntries = 11,
        /// The service lost an applied tail (non-blocking ops signal).
        LogRegressed = 12,
    }
}

wire_struct! {
    /// An incident.
    pub struct Incident {
        /// Kind.
        0 req kind: IncidentKind,
        /// Details.
        1 opt details: Value,
    }
}

wire_struct! {
    /// Progress counters.
    pub struct Progress {
        /// Done.
        0 req done: u64,
        /// Total.
        1 req total: u64,
    }
}

wire_enum! {
    /// The phase of device-local lost-tail repair (replica-client-api.md §7).
    pub enum ResyncPhase {
        /// Locating the matching retained prefix.
        Probing = 0,
        /// Re-appending exact retained bytes.
        Repairing = 1,
        /// Verified rollback and acknowledged-intent resurrection.
        RollingBack = 2,
        /// Waiting for verified control restoration; hints never clear a latch.
        AwaitingControl = 3,
    }
}

wire_struct! {
    /// Device-local lost-tail repair progress, not a user-action incident.
    pub struct Resyncing {
        /// Current phase.
        0 req phase: ResyncPhase,
        /// Positions still to restore.
        1 req positions: u64,
    }
}

wire_struct! {
    /// An authoritative confirmed-prefix capture, never a query/local overlay position.
    pub struct ConfirmedHead {
        /// Applied log position.
        0 req seq: u64,
        /// Chain hash at exactly `seq`.
        1 req chain: Hash,
        /// Control-chain identity `ctl(seq)`.
        2 req policy_generation: Hash,
        /// Neutral confirmed resource+SEM identity, without profile-specific fields.
        3 req catalog_generation: Hash,
    }
}

wire_struct! {
    /// `applied_prefix` parameters.
    pub struct AppliedPrefixParams {
        /// Captured hosted fence position.
        0 req seq: u64,
    }
}

wire_struct! {
    /// READ-gated historical prefix evidence for `applied_prefix`.
    pub struct AppliedPrefix {
        /// Highest locally applied log position (zero for local-only).
        0 req applied_through: u64,
        /// Requested fence position, not the current head.
        1 req seq: u64,
        /// Absent when behind, unavailable, or not eligible for handover.
        2 opt chain: Hash,
    }
}

wire_struct! {
    /// "Confirmed through N, plus pending" (replica-client-api.md §7).
    pub struct SyncStatus {
        /// Local-only or synced.
        0 req mode: SyncMode,
        /// Highest log position applied.
        1 req confirmed_through: u64,
        /// Highest head heard of.
        2 req head_known: u64,
        /// Unconfirmed mutations.
        3 req pending: u64,
        /// Capture time of the oldest pending mutation.
        4 opt oldest_pending: i64,
        /// Holds on this replica.
        5 req holds: u64,
        /// Unresolved conflicts.
        6 req unresolved: u64,
        /// Connection.
        7 req connection: Connection,
        /// Snapshot install progress.
        8 opt installing: Progress,
        /// Incidents.
        9 req incidents: Vec<Incident>,
        /// Present only while lost-tail repair is active.
        10 opt resyncing: Resyncing,
        /// Optional authoritative handover fence; absence always means stay hosted.
        11 opt confirmed_head: ConfirmedHead,
    }
}

wire_struct! {
    /// `hello` result.
    pub struct HelloResult {
        /// Negotiated API version.
        0 req version: Version,
        /// Runtime version.
        1 req runtime_version: String,
        /// The replica's semantics version.
        2 req sem: Sem,
        /// Collection.
        3 req collection: Uuid,
        /// What this session may do.
        4 req grant: GrantInfo,
        /// Current status.
        5 req status: SyncStatus,
        /// Features granted.
        6 req features: Vec<String>,
        /// The replica's latest signed `head-witness` bytes (log-entry.md §11), remote sessions.
        7 opt head_witness: Bytes,
    }
}

wire_enum! {
    /// Why a file is held.
    pub enum HoldReason {
        /// A concurrent change won.
        Conflict = 0,
        /// The base is unknown.
        UnknownProvenance = 1,
        /// Deleted elsewhere.
        DeletedElsewhere = 2,
        /// Read-only member.
        ReadOnly = 3,
        /// An editor holds unsaved changes.
        EditorBusy = 4,
        /// Provenance could not be verified.
        SuspectWrite = 5,
    }
}

wire_struct! {
    /// Reference to a hold.
    pub struct HoldRef {
        /// Record or file ID.
        0 req id: Uuid,
        /// Reason.
        1 req reason: HoldReason,
    }
}

wire_struct! {
    /// A hold (replica-client-api.md §8.1).
    pub struct Hold {
        /// Record or file ID.
        0 req id: Uuid,
        /// Path.
        1 req path: String,
        /// Reason.
        2 req reason: HoldReason,
        /// Since.
        3 req since: i64,
        /// Last common version.
        4 opt base: TextOrBlob,
        /// Bytes in the file now.
        5 req mine: TextOrBlob,
        /// Confirmed version.
        6 opt theirs: TextOrBlob,
        /// User saves collected while held.
        7 req saves: u64,
    }
}

wire_enum! {
    /// Whether a view includes unconfirmed changes.
    pub enum Confirmation {
        /// Confirmed.
        Confirmed = 0,
        /// Includes pending changes.
        Pending = 1,
    }
}

wire_struct! {
    /// State of a record in the local view.
    pub struct RecordState {
        /// Confirmed or pending.
        0 req state: Confirmation,
        /// Last log position that changed the record.
        1 req confirmed_seq: u64,
        /// Hold on this replica.
        2 opt hold: HoldRef,
        /// Unresolved conflicts on the record.
        3 opt unresolved: u64,
    }
}

wire_struct! {
    /// A record as read from the local view (replica-client-api.md §3).
    pub struct RecordView {
        /// ID.
        0 req id: Uuid,
        /// Path.
        1 req path: String,
        /// Revision of the exact bytes.
        2 req revision: Hash,
        /// Persisted frontmatter.
        3 req frontmatter: DataMap<Value>,
        /// Effective frontmatter.
        4 opt effective: DataMap<Value>,
        /// Body.
        5 opt body: String,
        /// Exact source.
        6 opt document: String,
        /// Types.
        7 req types: Vec<String>,
        /// State.
        8 req state: RecordState,
        /// Diagnostics.
        9 opt diagnostics: Vec<Issue>,
        /// Canonical select output; absent when no selection was requested.
        10 opt values: DataMap<Value>,
    }
}

wire_struct! {
    /// What to include in record views.
    pub struct Include {
        /// Effective frontmatter.
        0 opt effective: bool,
        /// Body.
        1 opt body: bool,
        /// Exact source.
        2 opt document: bool,
        /// Diagnostics.
        3 opt diagnostics: bool,
    }
}

wire_struct! {
    /// The resolved named view which produced a query.
    pub struct ViewRef {
        /// Source resource path.
        0 req path: String,
        /// Named view in that resource.
        1 req view: String,
    }
}

wire_struct! {
    /// One complete pre-pagination group (replica-client-api.md §4).
    pub struct QueryGroup {
        /// Canonical named grouping tuple; empty without grouping.
        0 req values: DataMap<Value>,
        /// All matches in this group, not just the returned page.
        1 req count: u64,
        /// Canonical named summary results.
        2 opt summaries: DataMap<Value>,
    }
}

wire_struct! {
    /// Full live metadata replacement, bound to its enclosing update's as_of.
    pub struct QueryMetadata {
        /// Selection output names in canonical order.
        0 opt columns: Vec<String>,
        /// Exact complete filtered match count before the window.
        1 opt total_count: u64,
        /// Query evaluation diagnostics.
        2 opt diagnostics: Vec<Issue>,
        /// Resolved execute_view reference.
        3 opt view: ViewRef,
        /// Complete pre-pagination groups and summaries.
        4 opt groups: Vec<QueryGroup>,
        /// Flat matching records remain after the requested window.
        5 opt has_more: bool,
    }
}

wire_struct! {
    /// A query result (replica-client-api.md §4).
    pub struct QueryResult {
        /// Records.
        0 req records: Vec<RecordView>,
        /// Next-page cursor.
        1 opt cursor: String,
        /// False during a snapshot install.
        2 req complete: bool,
        /// Local view version.
        3 req as_of: u64,
        /// Selection output names in canonical order.
        4 opt columns: Vec<String>,
        /// Exact complete filtered match count before the window.
        5 opt total_count: u64,
        /// Query evaluation diagnostics.
        6 opt diagnostics: Vec<Issue>,
        /// Resolved execute_view reference.
        7 opt view: ViewRef,
        /// Complete pre-pagination groups and summaries.
        8 opt groups: Vec<QueryGroup>,
        /// Flat matching records remain after the requested window.
        9 opt has_more: bool,
    }
}

wire_enum! {
    /// Live query update kind.
    pub enum UpdateKind {
        /// The full result.
        Snapshot = 0,
        /// Changes since the last push.
        Diff = 1,
        /// Start over; a snapshot follows.
        Reset = 2,
    }
}

wire_struct! {
    /// A live query push.
    pub struct QueryUpdate {
        /// Subscription ID.
        0 req sub: u64,
        /// Kind.
        1 req kind: UpdateKind,
        /// Added (snapshot: the full result).
        2 opt added: Vec<RecordView>,
        /// Changed.
        3 opt changed: Vec<RecordView>,
        /// Removed.
        4 opt removed: Vec<Uuid>,
        /// Full ordered ID list when the order changed.
        5 opt order: Vec<Uuid>,
        /// Complete.
        6 req complete: bool,
        /// Local view version.
        7 req as_of: u64,
        /// Full metadata replacement at this as_of, never a metadata delta.
        8 opt metadata: QueryMetadata,
    }
}

wire_enum! {
    /// Change kind.
    pub enum ChangeKind {
        /// Put.
        Put = 0,
        /// Remove.
        Remove = 1,
    }
}

wire_struct! {
    /// A change feed entry.
    pub struct Change {
        /// ID.
        0 req id: Uuid,
        /// Path.
        1 req path: String,
        /// Kind.
        2 req kind: ChangeKind,
        /// Local view version.
        3 req version: u64,
    }
}

wire_enum! {
    /// When `submit` returns.
    pub enum WaitFor {
        /// Immediately, with optimistic results.
        Pending = 0,
        /// After confirmation.
        Confirmed = 1,
        /// After the mutation's bytes are in the files (file-backed replicas), or
        /// once it is known they won't be ([`PublishState`]).
        Published = 2,
    }
}

wire_enum! {
    /// Whether a mutation's effects are in the files of a file-backed replica.
    pub enum PublishState {
        /// Not yet: the files still show what they showed before.
        Publishing = 0,
        /// The files hold the mutation's effects, or a later local view that
        /// includes them.
        Published = 1,
        /// Not written: the record is held, or the file held other bytes (a user's
        /// edit, which ingest takes from there).
        NotPublished = 2,
    }
}

wire_struct! {
    /// `submit` params (replica-client-api.md §5).
    pub struct SubmitParams {
        /// Operations (texts inline).
        0 req1 ops: Vec<Op>,
        /// Mutation ID.
        1 opt mutation_id: Uuid,
        /// Conflict handling.
        2 opt conflict_mode: ConflictMode,
        /// Time zone for this write.
        3 opt timezone: String,
        /// One mutation per op.
        4 opt allow_partial: bool,
        /// Mutation IDs per op when partial.
        5 opt1 mutation_ids: Vec<Uuid>,
        /// Plan only.
        6 opt dry_run: bool,
        /// What to return.
        7 opt include: Include,
        /// When to return.
        8 opt wait: WaitFor,
    }
}

wire_enum! {
    /// Receipt state.
    pub enum ReceiptState {
        /// Not yet confirmed.
        Pending = 0,
        /// Durably appended.
        Confirmed = 1,
        /// Rejected.
        Rejected = 2,
        /// Outcome cannot be determined.
        Unknown = 3,
    }
}

wire_struct! {
    /// A receipt (replica-client-api.md §6).
    pub struct Receipt {
        /// Mutation ID.
        0 req mutation: Uuid,
        /// State.
        1 req state: ReceiptState,
        /// Position, when confirmed.
        2 opt seq: u64,
        /// Status, when confirmed.
        3 opt status: Status,
        /// Conflicts, when conflicted.
        4 opt1 conflicts: Vec<Conflict>,
        /// Optimistic or confirmed results.
        5 opt records: Vec<RecordView>,
        /// When rejected or unknown.
        6 opt problem: Problem,
        /// File-backed replicas, while pending or confirmed: whether the mutation's
        /// effects are in the files.
        7 opt published: PublishState,
        /// Earlier confirmed position after acknowledged-intent resurrection.
        /// Key8 remains reserved for preflight; this is exactly contract key9.
        9 opt relocated_from: u64,
    }
}

wire_enum! {
    /// File state on this device.
    pub enum FileState {
        /// On this device.
        Materialized = 0,
        /// Fetched on demand.
        Remote = 1,
        /// Being fetched.
        Fetching = 2,
        /// Local change not yet confirmed.
        PendingUpload = 3,
    }
}

wire_struct! {
    /// A file handle (replica-client-api.md §10.1).
    pub struct FileView {
        /// File ID.
        0 req id: Uuid,
        /// Path.
        1 req path: String,
        /// Size.
        2 req size: u64,
        /// Content digest.
        3 req digest: Hash,
        /// Media class.
        4 req media: MediaClass,
        /// State.
        5 req state: FileState,
        /// Last log position that changed it.
        6 req confirmed_seq: u64,
        /// Hold.
        7 opt hold: HoldRef,
    }
}

wire_struct! {
    /// `open_upload` params (replica-client-api.md §10.2).
    pub struct OpenUploadParams {
        /// Transfer ID chosen by the client.
        0 req transfer: Uuid,
        /// Path.
        1 req path: String,
        /// Exact size.
        2 req size: u64,
        /// SHA-256 commitment.
        3 opt digest: Hash,
        /// File to replace.
        4 opt file_id: Uuid,
        /// CAS on replace.
        5 opt if_revision: Hash,
        /// Mutation ID for the file_put.
        6 opt mutation_id: Uuid,
    }
}

wire_struct! {
    /// `open_upload` result.
    pub struct OpenUploadResult {
        /// Transfer ID.
        0 req transfer: Uuid,
        /// Chunk size.
        1 req chunk_size: u64,
        /// Chunk indexes already held.
        2 req received: Vec<u64>,
        /// Expiry.
        3 req expires_at: i64,
    }
}

wire_struct! {
    /// `upload_chunk` params.
    pub struct UploadChunkParams {
        /// Transfer ID.
        0 req transfer: Uuid,
        /// Chunk index.
        1 req index: u64,
        /// Bytes.
        2 req bytes: Bytes,
    }
}

wire_struct! {
    /// A download chunk push.
    pub struct FileChunk {
        /// Stream ID.
        0 req stream: u64,
        /// Offset.
        1 req offset: u64,
        /// Bytes.
        2 req bytes: Bytes,
        /// Last chunk; the whole-file digest has been verified.
        3 req last: bool,
    }
}

/// A transfer ID (upload) or stream ID (download).
#[derive(Debug, Clone, PartialEq)]
pub enum TransferId {
    /// Upload transfer.
    Upload(Uuid),
    /// Download stream.
    Download(u64),
}

impl Wire for TransferId {
    fn to_cbor(&self) -> Cbor {
        match self {
            TransferId::Upload(u) => u.to_cbor(),
            TransferId::Download(n) => Cbor::Uint(*n),
        }
    }
    fn from_cbor(c: &Cbor) -> Result<Self, SchemaError> {
        match c {
            Cbor::Bytes(_) => Ok(TransferId::Upload(Uuid::from_cbor(c)?)),
            Cbor::Uint(n) => Ok(TransferId::Download(*n)),
            _ => Err(type_err("transfer-id", "uuid or uint", c)),
        }
    }
    fn annotate(&self) -> Ann {
        Ann::Leaf(self.to_cbor())
    }
}

wire_enum! {
    /// Transfer phase.
    pub enum Phase {
        /// Receiving chunks from the client.
        Receiving = 0,
        /// Sealing parts.
        Sealing = 1,
        /// Uploading parts to the log service.
        Uploading = 2,
        /// Appending the mutation.
        Appending = 3,
        /// Confirmed.
        Confirmed = 4,
        /// Fetching parts.
        Fetching = 5,
        /// Streaming to the client.
        Streaming = 6,
        /// Done.
        Done = 7,
    }
}

wire_struct! {
    /// A transfer progress push.
    pub struct TransferProgress {
        /// Transfer or stream ID.
        0 req id: TransferId,
        /// Phase.
        1 req phase: Phase,
        /// Bytes done.
        2 req done: u64,
        /// Bytes total.
        3 req total: u64,
    }
}

wire_enum! {
    /// Materialization mode.
    pub enum MaterializeMode {
        /// Download everything included.
        All = 0,
        /// Fetch on demand.
        OnDemand = 1,
    }
}

wire_struct! {
    /// Device materialization policy (replica-client-api.md §10.3).
    pub struct Materialization {
        /// Mode.
        0 req mode: MaterializeMode,
        /// Folders always materialized under on_demand.
        1 opt pinned: Vec<String>,
        /// Classes always materialized under on_demand.
        2 opt media: Vec<MediaClass>,
        /// Under all, larger files stay remote.
        3 opt max_size: u64,
    }
}

wire_struct! {
    /// A presence peer (replica-client-api.md §11).
    pub struct Peer {
        /// Per-session pseudonym.
        0 req session: B16,
        /// Account.
        1 opt account: Uuid,
        /// App ID.
        2 opt app: String,
        /// State.
        3 req state: Value,
        /// Last seen.
        4 req last_seen: i64,
    }
}
