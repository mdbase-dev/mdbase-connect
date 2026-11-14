//! `FileStore`: the file-backed [`Store`].
//!
//! Replicated state (records, pending, receipts, holds, ...) lives in an inner
//! [`Store`] (`M`): `MemStore` in tests and the simulator, a SQL store over
//! [`crate::IndexStorage`] in production. The file store adds the disk:
//! - [`Store::commit`] journals publish intents ([`DiskDb`]), commits the
//!   inner transaction, then publishes with the platform's strategy
//!   ([`crate::publish`]) and reports drifts;
//! - [`Store::observe`] reports what changed on disk: watcher-queued paths after
//!   a quiescence window (a queued folder that is gone, or new to the store, is
//!   expanded to the files beneath it), full scans, settled retained files with
//!   late writes, and preserved user versions; with re-checks before a delete
//!   and move pairing by content or file ID across a multi-second window;
//! - open runs crash recovery ([`crate::recover`]) for leftover intents.
//!
//! All I/O goes through [`FilePlatform`]. The store drives platform futures to
//! completion inside each call ([`crate::exec::run_ready`]), which suits every
//! platform whose operations complete in-call (native, in-memory, simulator
//! models). [`FileStore::start_open`] and [`FileStore::start_observe`] retain
//! their original futures across suspended host operations. Native convenience
//! calls use those same implementations. Resource-source hooks and
//! [`FileStore::start_commit`] retain their original operations as well.
//! Explicit queued publication uses the same orchestration; the host retains
//! [`FileStore::start_progress`] before the existing Replica progress hook.

use std::cell::Cell;
use std::collections::{BTreeMap, BTreeSet};
use std::rc::Rc;

use mdbn_core::host::Clock;
use mdbn_replica::store::{
    AliasRow, AttachmentClass, Candidate, CommitReport, ConflictRow, Content, DiskResult, Drift,
    Expect as RExpect, FileRow, Head, LocalReceipt, Observation, ObservationId, Observed, Page,
    PendingRow, Provenance, Publish, PublishResult, ReceiptRow, RecordRow, StageKey, Store,
    StoreError, StoreResult, TombstoneRow, TransferRow, Tx,
};
use mdbn_wire::client::Hold;
use mdbn_wire::common::{Hash, Uuid};
use mdbn_wire::intent::{FileInclusion, MediaClass};

use crate::codec::{DiskState, EvidenceRec, IntentRec, RetainedRec, counter_bytes, counter_of};
use crate::diskdb::{Change, DbError, DiskDb, Kind};
use crate::exec::{Timers, run_ready};
use crate::platform::{
    CaseSensitivity, FileId, FileKind, FileMeta, FilePlatform, FlushScope, FsError, FsErrorKind,
    LockShare, MAX_READ_AT, RangeHandle, RelPath, ReplaceStrategy,
};
use crate::publish::{Expect, Names, Options, Outcome, PublishOp, publish, revision};
use crate::recover::{Intent, State, recover};
use crate::retention::{self, Parked, ReleasePolicy};
use crate::stash::{MIN_RETENTION_MS, Settled, settle};

mod admitted;

/// Creates in one commit from which they are published as one batch.
const BATCH_MIN: usize = 16;
mod attachments;
mod batch;
mod check;
mod commit;
mod deferred;
mod observe;
mod open;
mod publishing;
mod scan;
mod settling;
mod state;
mod store_impl;

/// Markdown strictly larger than this is not a record (`intent.md` §3.10): it is
/// observed as an attachment of the unindexed oversized Markdown kind.
pub const RECORD_CAP_BYTES: u64 = mdbn_core::intent::RECORD_SOURCE_CAP_BYTES;

/// Tuning for quiescence, move pairing and retained-file safety.
#[derive(Clone, Debug)]
pub struct Config {
    /// Wait this long after the last event on a path before reading it (typically
    /// about 100 ms native; 1–2 s on mobile and Windows bursts).
    pub quiescence_ms: u64,
    /// Re-check a path that looked missing after this long before believing it
    /// (vim-style saves are missing for milliseconds).
    pub missing_recheck_ms: u64,
    /// Pair a disappeared path with an appeared one within this window (SC9;
    /// the vault reports moves as create then delete about 100 ms apart).
    pub move_window_ms: u64,
    /// Keep displaced files at least this long.
    pub retention_ms: u64,
    /// Retained-inode release scheduling; None uses the platform recommendation.
    /// Native macOS recommends NextLaunch; other hosts retain timed behavior.
    pub release: Option<ReleasePolicy>,
    /// Extensions observed as text (records and resources).
    pub text_extensions: Vec<String>,
    /// Text extensions that are Markdown: over [`RECORD_CAP_BYTES`] such a file
    /// is streamed as unindexed oversized Markdown, never read whole.
    pub markdown_extensions: Vec<String>,
    /// Windows D sharing while locked.
    pub lock_share: LockShare,
    /// Explicit queued publication. The host MUST retain `start_progress` and
    /// complete original IO before calling Replica::on_store_progress. Native
    /// default remains immediate. Accepted queued ownership is bounded; this is
    /// not a peak-heap, cancellation or power-loss guarantee.
    pub queued_publication: bool,
}

impl Default for Config {
    fn default() -> Self {
        Config {
            quiescence_ms: 100,
            missing_recheck_ms: 250,
            move_window_ms: 3_000,
            retention_ms: MIN_RETENTION_MS,
            release: None,
            text_extensions: ["md", "markdown", "yaml", "yml"].map(String::from).to_vec(),
            markdown_extensions: ["md", "markdown"].map(String::from).to_vec(),
            lock_share: LockShare::Read,
            queued_publication: false,
        }
    }
}

/// Counters for tests and diagnostics.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Stats {
    /// Publishes performed.
    pub published: u64,
    /// Publishes reported as drifts.
    pub drifted: u64,
    /// Intents resolved at open.
    pub recovered: u64,
    /// Late writes found in retained files.
    pub late_writes: u64,
    /// Checked same-launch age/cap exceptions (no hard disk-space guarantee).
    pub reclaimed: u64,
    /// Files read and hashed by observe.
    pub files_read: u64,
    /// Of those, files hashed through a range handle in bounded pieces.
    pub files_streamed: u64,
    /// Attachment-class files not hashed again: unchanged size, times and
    /// file ID since their last hash.
    pub hashes_reused: u64,
    /// Links, special files and unsupported names in the last full walk.
    /// Hidden, dependency and explicitly excluded entries are not counted.
    pub unsupported_entries: u64,
    /// Paths that cannot be indexed, from directory scans and file observations.
    pub unsupported_paths: BTreeMap<String, String>,
    /// Creates whose path already held exactly the new bytes, recorded
    /// without writing.
    pub already_held: u64,
}

/// Content-free local diagnostic for a same-launch retention exception.
/// Changed bytes remain evidence; this is not a claim of space reclaimed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Reclaimed {
    /// Original retained-file size, if it was available.
    pub size: Option<u64>,
    /// Time it was retained, in host milliseconds.
    pub since: u64,
}

/// A path that disappeared: waiting for the re-check and the move window.
#[derive(Clone, Debug)]
struct Missing {
    known: DiskState,
    first_seen: u64,
    confirmed: bool,
}

/// What a path was seen to hold: text bytes (read whole, small), or a file
/// that was only hashed in bounded pieces (an attachment).
#[derive(Clone, Debug)]
enum Body {
    Bytes(Vec<u8>),
    Streamed(AttachmentClass),
}

/// Content seen at a path, with its revision and metadata.
#[derive(Clone, Debug)]
struct Seen {
    body: Body,
    rev: Hash,
    meta: FileMeta,
}

/// An appeared path that might be the far end of a move.
#[derive(Clone, Debug)]
struct Appeared {
    seen: Seen,
    since: u64,
}

/// An observation handed out and not yet acknowledged.
#[derive(Clone, Debug)]
struct Outstanding {
    path: String,
    /// Original observed base; redelivery must not infer it from a later row.
    base: Option<Hash>,
    /// Armed only by the replica's declared dependency read, never by file type.
    resource_requested: bool,
    deferred: bool,
    attachment: Option<(Hash, u64, AttachmentClass)>,
    /// What to record as known when acknowledged (`None` = path gone).
    known_after: Option<DiskState>,
    moved_from: Option<String>,
    evidence: Option<RelPath>,
}

/// The file-backed store.
pub struct FileStore<P: FilePlatform, M: Store, D: DiskDb> {
    p: Rc<P>,
    inner: M,
    db: D,
    clock: Box<dyn Clock>,
    cfg: Config,
    release: ReleasePolicy,
    timers: Timers,
    disk: BTreeMap<String, DiskState>,
    /// How many `disk` entries hold each revision and each file ID: a new
    /// path asks whether it could be a move's far end without a full scan.
    disk_revs: BTreeMap<Hash, u32>,
    disk_ids: BTreeMap<FileId, u32>,
    /// Attachment-class files as last hashed, acknowledged or not (Kind::Seen).
    seen: BTreeMap<String, DiskState>,
    retained: BTreeMap<RelPath, RetainedRec>,
    session: u64,
    reclaimed: Vec<Reclaimed>,
    evidence: BTreeMap<u64, EvidenceRec>,
    outstanding: BTreeMap<u64, Outstanding>,
    refused_resource_sets: Vec<(Vec<u64>, Uuid)>,
    /// Outstanding observation tokens by path (`already_reported`).
    outstanding_at: BTreeMap<String, BTreeSet<u64>>,
    next_name: u64,
    next_obs: u64,
    dirty: BTreeMap<String, u64>,
    missing: BTreeMap<String, Missing>,
    appeared: BTreeMap<String, Appeared>,
    rescan: bool,
    /// A deferred-durability window is open on the inner store
    /// ([`Store::defer_durability`]). Any outside effect closes it first.
    deferred: bool,
    /// A dropped pending commit is unresolved, not a cancelled operation.
    commit_active: Rc<Cell<bool>>,
    queued: deferred::Deferred,
    /// The running commit is driven to completion at once ([`Store::commit`]
    /// over a synchronous platform), not polled by a host IO queue.
    immediate: bool,
    /// Statistics.
    pub stats: Stats,
}

/// Creates found already in place during one commit ([`FileStore::already_held`]).
#[derive(Default)]
struct AlreadyHeld {
    /// Their disk rows, applied in one batch.
    changes: Vec<Change>,
    /// Parent listings on a case-insensitive volume.
    names: BTreeMap<RelPath, BTreeSet<String>>,
}

// Inner transaction rollback cannot certify all preceding outer file state.
// In particular deferred/pending publication must never inherit this guarantee.
fn inner_commit_error(e: StoreError) -> StoreError {
    match e {
        StoreError::CommitAborted(m) => {
            StoreError::Io(format!("inner abort; outer durability unconfirmed: {m}"))
        }
        e => e,
    }
}

fn db_err(e: DbError) -> StoreError {
    StoreError::Io(format!("disk db: {}", e.0))
}

fn fs_err(e: FsError) -> StoreError {
    match e.kind {
        crate::platform::FsErrorKind::NoSpace => StoreError::Full,
        _ => StoreError::Io(e.to_string()),
    }
}

fn suspended() -> StoreError {
    StoreError::Io("platform suspended: async drive not available yet".into())
}
