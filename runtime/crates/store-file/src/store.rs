//! `FileStore`: the file-backed [`Store`].
//!
//! Replicated state (records, pending, receipts, holds, ...) lives in an inner
//! [`Store`] (`M`): `MemStore` in tests and the simulator, a SQL store over
//! [`crate::IndexStorage`] in production. The file store adds the disk:
//! - [`Store::commit`] journals publish intents ([`DiskDb`]), commits the
//!   inner transaction, then publishes with the platform's strategy
//!   ([`crate::publish`]) and reports drifts;
//! - [`Store::observe`] reports what changed on disk: watcher-queued paths after
//!   a quiescence window, full scans, settled retained files with late writes,
//!   and preserved user versions; with re-checks before a delete and move
//!   pairing by content or file ID across a multi-second window;
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
use mdbn_wire::intent::FileInclusion;

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
mod deferred;

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

impl<P: FilePlatform, M: Store, D: DiskDb> FileStore<P, M, D> {
    /// Open a store: load the file store's state, create the private
    /// directories, and recover leftover publish intents. The first
    /// [`Store::observe`] then scans the whole tree. This convenience requires
    /// an immediate platform; suspending hosts retain [`FileStore::start_open`].
    pub fn open(
        p: Rc<P>,
        inner: M,
        db: D,
        clock: Box<dyn Clock>,
        cfg: Config,
    ) -> StoreResult<Self> {
        Self::start_open(p, inner, db, clock, cfg).finish_immediate()
    }

    /// Start opening without dropping a future when its host IO suspends.
    /// The host retains this owner and polls it after completing original ops.
    pub fn start_open<'a>(
        p: Rc<P>,
        inner: M,
        db: D,
        clock: Box<dyn Clock>,
        cfg: Config,
    ) -> crate::opening::Opening<'a, P, M, D>
    where
        P: 'a,
        M: 'a,
        D: 'a,
    {
        let timers = Timers::default();
        timers.set_now(clock.now_ms());
        crate::opening::Opening::new(
            timers.clone(),
            Self::open_task(p, inner, db, clock, cfg, timers),
        )
    }

    async fn open_task(
        p: Rc<P>,
        inner: M,
        db: D,
        clock: Box<dyn Clock>,
        cfg: Config,
        timers: Timers,
    ) -> StoreResult<Self> {
        if mdbn_replica::mirror_admission::Fence::load(&inner)?.is_some() {
            return Err(StoreError::Io(
                "mirror admission closed: skip filesystem recovery".into(),
            ));
        }
        let release = cfg.release.unwrap_or_else(|| p.release_policy());
        let mut s = FileStore {
            p,
            inner,
            db,
            clock,
            cfg,
            release,
            timers,
            disk: BTreeMap::new(),
            disk_revs: BTreeMap::new(),
            disk_ids: BTreeMap::new(),
            seen: BTreeMap::new(),
            retained: BTreeMap::new(),
            session: 0,
            reclaimed: Vec::new(),
            evidence: BTreeMap::new(),
            outstanding: BTreeMap::new(),
            refused_resource_sets: Vec::new(),
            outstanding_at: BTreeMap::new(),
            next_name: 1,
            next_obs: 1,
            dirty: BTreeMap::new(),
            missing: BTreeMap::new(),
            appeared: BTreeMap::new(),
            rescan: true,
            deferred: false,
            commit_active: Rc::new(Cell::new(false)),
            queued: deferred::Deferred::default(),
            immediate: false,
            stats: Stats::default(),
        };
        s.timers.set_now(s.clock.now_ms());
        let mut intents = Vec::new();
        for (kind, key, v) in s.db.load().map_err(db_err)? {
            let bad = || StoreError::Corrupt(format!("file store row {kind:?}"));
            match kind {
                Kind::Disk => {
                    let path = String::from_utf8(key).map_err(|_| bad())?;
                    s.put_disk(path, DiskState::from_bytes(&v).ok_or_else(bad)?);
                }
                Kind::Seen => {
                    let path = String::from_utf8(key).map_err(|_| bad())?;
                    s.seen
                        .insert(path, DiskState::from_bytes(&v).ok_or_else(bad)?);
                }
                Kind::Intent => intents.push((key, IntentRec::from_bytes(&v).ok_or_else(bad)?)),
                Kind::Retained => {
                    let r = RetainedRec::from_bytes(&v).ok_or_else(bad)?;
                    s.retained.insert(r.r.path.clone(), r);
                }
                Kind::Observation => {
                    let id = counter_of(&key).ok_or_else(bad)?;
                    s.evidence
                        .insert(id, EvidenceRec::from_bytes(&v).ok_or_else(bad)?);
                }
                Kind::Counter => match key.as_slice() {
                    b"name" => s.next_name = counter_of(&v).ok_or_else(bad)?,
                    b"obs" => s.next_obs = counter_of(&v).ok_or_else(bad)?,
                    b"retention-session" => s.session = counter_of(&v).ok_or_else(bad)?,
                    _ => {}
                },
            }
        }
        if matches!(s.release, ReleasePolicy::NextLaunch { .. }) {
            if s.retained.values().any(|r| r.session > s.session) {
                return Err(StoreError::Corrupt(
                    "retention session exceeds persisted counter".into(),
                ));
            }
            s.session = s
                .session
                .checked_add(1)
                .ok_or_else(|| StoreError::Corrupt("retention session exhausted".into()))?;
            // Any closed-admission front-door guard must precede this write,
            // exactly as it must precede directory creation/recovery below.
            s.db.apply(vec![(
                Kind::Counter,
                b"retention-session".to_vec(),
                Some(counter_bytes(s.session)),
            )])
            .map_err(db_err)?;
        }
        let private = s.p.capabilities().private_dir.clone();
        // Also create legacy stash for recovery: an old journal keeps its
        // original name even when this platform now selects retained.nosync.
        let mut dirs = Names::dirs(&private).to_vec();
        if s.p.retained_nosync() {
            dirs.push(private.join("retained.nosync").map_err(fs_err)?);
        }
        for d in dirs {
            s.p.create_dir_all(&d).await.map_err(fs_err)?;
        }
        s.recover_intents(intents).await?;
        Ok(s)
    }

    /// Retain one original transaction, including evidence ACK and publication.
    /// This explicit owner is not yet Replica deferred/progress integration.
    pub fn start_commit(&mut self, tx: Tx) -> crate::Committing<'_> {
        let timers = self.timers.clone();
        if let Err(e) = self
            .ensure_commit_available()
            .and_then(|()| self.ensure_queue_drained())
        {
            return crate::Committing::new(timers, None, std::future::ready(Err(e)));
        }
        let lease = self.commit_active.clone();
        lease.set(true);
        crate::Committing::new(timers, Some(lease), self.commit_task(tx))
    }

    /// Drive all ORIGINAL queued ACK/publication work in FIFO order. This owner
    /// never repeats inner commits or reallocates a pending intent. Release the
    /// completed owner before Replica::on_store_progress consumes results.
    pub fn start_progress(&mut self) -> crate::Committing<'_> {
        let timers = self.timers.clone();
        if let Err(e) = self.ensure_commit_available() {
            return crate::Committing::new(timers, None, std::future::ready(Err(e)));
        }
        let lease = self.commit_active.clone();
        lease.set(true);
        crate::Committing::new(timers, Some(lease), self.progress_task())
    }

    fn ensure_queue_drained(&self) -> StoreResult<()> {
        if self.queued.queue.is_empty() {
            Ok(())
        } else {
            Err(StoreError::Io(
                "original queued file work pending: retain FileStore::start_progress".into(),
            ))
        }
    }

    fn ensure_commit_available(&self) -> StoreResult<()> {
        if self.commit_active.get() || self.queued.fault {
            Err(StoreError::Io(
                "original file commit unresolved: drain original host IO and reopen".into(),
            ))
        } else {
            Ok(())
        }
    }

    /// Start a retained observation scan with captured paths. Pending exclusively
    /// borrows this store; poll the same owner after original host IO completes.
    pub fn start_observe(&mut self, paths: Option<&[String]>) -> crate::observing::Observing<'_> {
        let paths = paths.map(<[String]>::to_vec);
        let timers = self.timers.clone();
        crate::observing::Observing::new(timers, self.observe_task(paths))
    }

    async fn observe_task(&mut self, paths: Option<Vec<String>>) -> StoreResult<Vec<Observation>> {
        self.ensure_commit_available()?;
        self.ensure_queue_drained()?;
        mdbn_replica::mirror_admission::ensure_open(&self.inner)?;
        // Retention and move settlement may have outside effects.
        self.end_deferral()?;
        let mut out = Vec::new();
        let mut changes = Vec::new();
        let scanned = self
            .observe_batch(paths.as_deref(), &mut changes, &mut out)
            .await
            .and_then(|()| mdbn_replica::mirror_admission::ensure_open(&self.inner));
        let persisted = self.db.apply(changes).map_err(db_err);
        if scanned.is_err() || persisted.is_err() {
            self.rescan = true;
            // These observations have never been delivered. Keep ORIGINAL
            // tokens/base and explicitly arm revalidation/redelivery, rather
            // than losing a partial capture or reminting after terminal error.
            for observation in &out {
                if let Some(original) = self.outstanding.get_mut(&observation.token.0) {
                    original.deferred = true;
                }
            }
        }
        persisted?;
        scanned?;
        Ok(out)
    }

    async fn observe_batch(
        &mut self,
        paths: Option<&[String]>,
        changes: &mut Vec<Change>,
        out: &mut Vec<Observation>,
    ) -> StoreResult<()> {
        let now_ms = self.now();
        self.settle_retained(changes).await?;
        self.deliver_evidence(out).await?;
        let settings = self.inner.settings()?;
        // Path -> whether the walk already checked inclusion.
        let mut todo: BTreeMap<String, bool> = BTreeMap::new();
        match paths {
            Some(ps) => todo.extend(ps.iter().map(|p| (p.clone(), false))),
            None => {
                if self.rescan {
                    let mut found = BTreeSet::new();
                    let mut unsupported = BTreeMap::new();
                    self.walk(&RelPath::ROOT, &settings, &mut found, &mut unsupported)
                        .await?;
                    self.rescan = false;
                    self.stats.unsupported_entries = unsupported.len() as u64;
                    unsupported.extend(
                        self.stats
                            .unsupported_paths
                            .iter()
                            .filter(|(path, _)| found.contains(*path))
                            .map(|(path, reason)| (path.clone(), reason.clone())),
                    );
                    self.stats.unsupported_paths = unsupported;
                    for p in self.disk.keys().chain(self.seen.keys()) {
                        if !found.contains(p) {
                            todo.insert(p.clone(), false);
                        }
                    }
                    todo.extend(found.into_iter().map(|p| (p, true)));
                }
                let due: Vec<String> = self
                    .dirty
                    .iter()
                    .filter(|(_, d)| **d <= now_ms)
                    .map(|(p, _)| p.clone())
                    .collect();
                for p in due {
                    todo.entry(p).or_insert(false);
                }
            }
        }
        for (p, walked) in todo {
            // Preserve the completed quiet window before retiring its marker.
            let quiet_recheck = self.dirty.get(&p).is_some_and(|due| *due <= now_ms);
            if quiet_recheck {
                self.dirty.remove(&p);
            }
            if !walked {
                let Ok(rp) = RelPath::new(p.clone()) else {
                    continue;
                };
                if !self.included(&rp, &settings) {
                    continue;
                }
            }
            self.check_path(&p, changes, out, quiet_recheck).await?;
        }
        self.settle_moves(changes, out).await?;
        self.reoffer_outstanding(out).await?;
        Ok(())
    }

    async fn resource_batch_complete_task(
        &self,
        observations: &[Observation],
    ) -> StoreResult<bool> {
        mdbn_replica::mirror_admission::ensure_open(&self.inner)?;
        if observations.len() > 64 || self.refused_resource_sets.len() >= 64 {
            return Ok(false);
        }
        let mut tokens = observations.iter().map(|o| o.token.0).collect::<Vec<_>>();
        tokens.sort_unstable();
        if self
            .refused_resource_sets
            .iter()
            .any(|(set, _)| set == &tokens)
        {
            return Ok(false);
        }
        let paths = observations
            .iter()
            .map(|o| o.path.as_str())
            .collect::<BTreeSet<_>>();
        let mut requested = 0usize;
        for (work, original) in self.outstanding.values().enumerate() {
            if work >= 65536 {
                return Ok(false);
            }
            if !original.resource_requested {
                continue;
            }
            requested += 1;
            if requested > 1024 {
                return Ok(false);
            }
            if paths.contains(original.path.as_str()) {
                continue;
            }
            let path = Self::rel(&original.path)?;
            match self.observe_io(|| self.p.stat(&path)).await? {
                Err(e) if e.is_not_found() => continue,
                _ => return Ok(false),
            }
        }
        mdbn_replica::mirror_admission::ensure_open(&self.inner)?;
        Ok(true)
    }

    async fn resource_current_task(&mut self, o: &Observation) -> StoreResult<bool> {
        mdbn_replica::mirror_admission::ensure_open(&self.inner)?;
        let Some(original) = self.outstanding.get(&o.token.0) else {
            return Ok(false);
        };
        if original.path != o.path
            || original.base != o.base
            || original.moved_from != o.moved_from
            || o.provenance != Provenance::Normal
            || original.evidence.is_some()
            || self.dirty.get(&o.path).is_some_and(|due| *due > self.now())
        {
            return Ok(false);
        }
        if let Some(from) = &o.moved_from {
            let from = Self::rel(from)?;
            match self.observe_io(|| self.p.stat(&from)).await? {
                Err(e) if e.is_not_found() => {}
                _ => return Ok(false),
            }
        }
        let current = match &o.now {
            Some(Observed::Text(text)) => {
                self.resource_text_task(o, 1024 * 1024).await?.as_ref() == Some(text)
            }
            None if original.known_after.is_none() => {
                let path = Self::rel(&o.path)?;
                matches!(self.observe_io(|| self.p.stat(&path)).await?, Err(e) if e.is_not_found())
            }
            _ => false,
        };
        mdbn_replica::mirror_admission::ensure_open(&self.inner)?;
        Ok(current)
    }

    async fn resource_text_task(
        &mut self,
        observation: &Observation,
        limit: usize,
    ) -> StoreResult<Option<String>> {
        mdbn_replica::mirror_admission::ensure_open(&self.inner)?;
        if limit == 0 || limit > mdbn_replica::store::RESOURCE_SOURCE_BYTES {
            return Err(StoreError::Full);
        }
        let Some(original) = self.outstanding.get(&observation.token.0) else {
            return Ok(None);
        };
        if original.path != observation.path
            || original.base != observation.base
            || original.moved_from != observation.moved_from
            || observation.provenance != Provenance::Normal
            || original.evidence.is_some()
            || self
                .dirty
                .get(&original.path)
                .is_some_and(|due| *due > self.now())
        {
            return Ok(None);
        }
        let Some(expected) = &original.known_after else {
            return Ok(None);
        };
        let path = Self::rel(&original.path)?;
        let meta = match self.observe_io(|| self.p.stat(&path)).await? {
            Ok(meta) if meta.kind == FileKind::File && meta.size <= limit as u64 => meta,
            _ => return Ok(None),
        };
        let read = match self.observe_io(|| self.p.read(&path)).await? {
            Ok(read) if read.meta == meta && read.bytes.len() <= limit => read,
            _ => return Ok(None),
        };
        if revision(&read.bytes) != expected.rev {
            return Ok(None);
        }
        mdbn_replica::mirror_admission::ensure_open(&self.inner)?;
        let text = String::from_utf8(read.bytes).ok();
        if text.is_some()
            && let Some(original) = self.outstanding.get_mut(&observation.token.0)
        {
            original.resource_requested = true;
        }
        Ok(text)
    }

    /// Drain content-free local retention diagnostics. Never contains note paths.
    pub fn take_reclaimed(&mut self) -> Vec<Reclaimed> {
        std::mem::take(&mut self.reclaimed)
    }

    /// The inner store.
    pub fn inner(&self) -> &M {
        &self.inner
    }

    /// The platform.
    pub fn platform(&self) -> &Rc<P> {
        &self.p
    }

    /// What the store believes is at `path`.
    pub fn disk_state(&self, path: &str) -> Option<&DiskState> {
        self.disk.get(path)
    }

    /// What the store last knew was on disk at `path`: its own publishes and
    /// acknowledged observations, without reading the file. The replica uses it
    /// (with [`FileStore::disk_paths`]) to reconcile the folder at open; these
    /// become the `Store::disk_revision`/`disk_paths` overrides once the corresponding
    /// trait methods are available.
    pub fn disk_revision(&self, path: &str) -> Option<Hash> {
        self.disk.get(path).map(|d| d.rev)
    }

    /// Every path the store last knew to hold bytes, with revisions, by path.
    pub fn disk_paths(&self) -> Vec<(String, Hash)> {
        self.disk.iter().map(|(p, d)| (p.clone(), d.rev)).collect()
    }

    /// Feed watcher events. They only queue paths; [`Store::observe`] reads.
    pub fn on_events(&mut self, events: &[crate::platform::FileEvent]) {
        let now = self.now();
        for e in events {
            if e.kind == crate::platform::FileEventKind::Rescan {
                self.rescan = true;
                continue;
            }
            if self.is_private(&e.path) {
                continue;
            }
            self.dirty
                .insert(e.path.as_str().to_string(), now + self.cfg.quiescence_ms);
        }
    }

    /// Request a full scan on the next observe (lost events, resume).
    pub fn request_rescan(&mut self) {
        self.rescan = true;
    }

    /// When the store next has work (quiescence, re-checks, settling), in host ms.
    pub fn next_wakeup(&self) -> Option<u64> {
        let a = self.dirty.values().copied();
        let pressure = match self.release {
            ReleasePolicy::AfterRetention => false,
            ReleasePolicy::NextLaunch { cap_bytes, .. } => {
                self.retained
                    .values()
                    .map(|r| u128::from(r.size.unwrap_or(u64::MAX)))
                    .sum::<u128>()
                    > u128::from(cap_bytes)
            }
        };
        let b = self.retained.values().filter_map(|r| {
            let parked = Parked {
                since: r.since,
                session: r.session,
                size: r.size,
            };
            if pressure && r.session == self.session {
                Some(r.since.saturating_add(self.cfg.retention_ms))
            } else {
                retention::deadline(self.release, self.cfg.retention_ms, self.session, &parked)
            }
        });
        let c = self.missing.values().map(|m| {
            if m.confirmed {
                m.first_seen + self.cfg.move_window_ms
            } else {
                m.first_seen + self.cfg.missing_recheck_ms
            }
        });
        let d = self
            .appeared
            .values()
            .map(|a| a.since + self.cfg.move_window_ms);
        a.chain(b).chain(c).chain(d).min()
    }

    // ------------------------------------------------------------ helpers

    /// Close a deferred-durability window before an outside effect (a file
    /// written, moved or removed): the effect must never be visible while the
    /// commits it follows could still be lost.
    fn end_deferral(&mut self) -> StoreResult<()> {
        if self.deferred {
            // Closed even on error: the inner store fences an uncertain barrier.
            self.deferred = false;
            // Commits first, then the acknowledgements of them.
            self.inner.defer_durability(false)?;
            self.db.defer_sync(false).map_err(db_err)?;
        }
        Ok(())
    }

    fn now(&self) -> u64 {
        let n = self.clock.now_ms();
        self.timers.set_now(n);
        self.timers.now()
    }

    fn run<F: std::future::Future>(&self, f: F) -> StoreResult<F::Output> {
        run_ready(&self.timers, f).ok_or_else(suspended)
    }

    async fn observe_io<F: std::future::Future>(
        &self,
        operation: impl FnOnce() -> F,
    ) -> StoreResult<F::Output> {
        // Check before constructing a queued future: construction itself may
        // issue the original request. Pending resumes cannot bypass closure.
        mdbn_replica::mirror_admission::ensure_open(&self.inner)?;
        Ok(operation().await)
    }

    fn is_private(&self, p: &RelPath) -> bool {
        let private = self.p.capabilities().private_dir.as_str();
        p.as_str() == private || p.as_str().starts_with(&format!("{private}/"))
    }

    fn strategy(&self) -> ReplaceStrategy {
        self.p.capabilities().replace
    }

    fn options(&self) -> Options {
        Options {
            share: self.cfg.lock_share,
            ..Options::default()
        }
    }

    fn take_name(&mut self, changes: &mut Vec<Change>) -> u64 {
        let n = self.next_name;
        self.next_name += 1;
        changes.push((
            Kind::Counter,
            b"name".to_vec(),
            Some(counter_bytes(self.next_name)),
        ));
        n
    }

    fn take_obs(&mut self, changes: &mut Vec<Change>) -> u64 {
        let n = self.next_obs;
        self.next_obs += 1;
        changes.push((
            Kind::Counter,
            b"obs".to_vec(),
            Some(counter_bytes(self.next_obs)),
        ));
        n
    }

    fn state_from(&self, id: Option<Uuid>, rev: Hash, m: &FileMeta, ours: bool) -> DiskState {
        DiskState {
            id,
            rev,
            size: m.size,
            mtime_ns: m.mtime_ns,
            ctime_ns: m.ctime_ns,
            file_id: m.id,
            ours,
        }
    }

    /// Drop the hash memo of `path` (gone, or now known through `disk`).
    fn forget_seen(&mut self, changes: &mut Vec<Change>, path: &str) {
        if self.seen.remove(path).is_some() {
            changes.push((Kind::Seen, path.as_bytes().to_vec(), None));
        }
    }

    fn set_disk(&mut self, changes: &mut Vec<Change>, path: &str, st: Option<DiskState>) {
        self.forget_seen(changes, path);
        match st {
            Some(st) => {
                changes.push((Kind::Disk, path.as_bytes().to_vec(), Some(st.to_bytes())));
                self.put_disk(path.to_string(), st);
            }
            None => {
                changes.push((Kind::Disk, path.as_bytes().to_vec(), None));
                self.remove_disk(path);
            }
        }
    }

    /// `disk` insert, keeping `disk_revs`/`disk_ids` in step.
    fn put_disk(&mut self, path: String, st: DiskState) {
        *self.disk_revs.entry(st.rev).or_default() += 1;
        if let Some(id) = st.file_id {
            *self.disk_ids.entry(id).or_default() += 1;
        }
        if let Some(old) = self.disk.insert(path, st) {
            self.unindex_disk(&old);
        }
    }

    /// `disk` remove, keeping `disk_revs`/`disk_ids` in step.
    fn remove_disk(&mut self, path: &str) {
        if let Some(old) = self.disk.remove(path) {
            self.unindex_disk(&old);
        }
    }

    fn unindex_disk(&mut self, old: &DiskState) {
        fn dec<K: Ord>(m: &mut BTreeMap<K, u32>, k: &K) {
            if let Some(n) = m.get_mut(k) {
                *n -= 1;
                if *n == 0 {
                    m.remove(k);
                }
            }
        }
        dec(&mut self.disk_revs, &old.rev);
        if let Some(id) = &old.file_id {
            dec(&mut self.disk_ids, id);
        }
    }

    /// `outstanding` insert, keeping `outstanding_at` in step.
    fn put_outstanding(&mut self, token: u64, o: Outstanding) {
        self.take_outstanding(token);
        self.outstanding_at
            .entry(o.path.clone())
            .or_default()
            .insert(token);
        self.outstanding.insert(token, o);
    }

    /// `outstanding` remove, keeping `outstanding_at` in step.
    fn take_outstanding(&mut self, token: u64) -> Option<Outstanding> {
        let o = self.outstanding.remove(&token)?;
        self.unindex_outstanding(token, &o.path);
        Some(o)
    }

    fn unindex_outstanding(&mut self, token: u64, path: &str) {
        if let Some(set) = self.outstanding_at.get_mut(path) {
            set.remove(&token);
            if set.is_empty() {
                self.outstanding_at.remove(path);
            }
        }
    }

    async fn retain_async(
        &mut self,
        changes: &mut Vec<Change>,
        r: crate::publish::Retained,
        user_path: &str,
        id: Option<Uuid>,
    ) {
        let size = self
            .observe_io(|| self.p.stat(&r.path))
            .await
            .ok()
            .and_then(Result::ok)
            .filter(|meta| meta.kind == FileKind::File)
            .map(|meta| meta.size);
        self.retain_with_size(changes, r, user_path, id, size);
    }

    fn retain_with_size(
        &mut self,
        changes: &mut Vec<Change>,
        r: crate::publish::Retained,
        user_path: &str,
        id: Option<Uuid>,
        size: Option<u64>,
    ) {
        let rec = RetainedRec {
            r,
            user_path: user_path.to_string(),
            since: self.now(),
            session: self.session,
            size,
            id,
        };
        changes.push((
            Kind::Retained,
            rec.r.path.as_str().as_bytes().to_vec(),
            Some(rec.to_bytes()),
        ));
        self.retained.insert(rec.r.path.clone(), rec);
    }

    fn add_evidence(
        &mut self,
        changes: &mut Vec<Change>,
        path: &str,
        evidence: RelPath,
        base: Option<Hash>,
        suspect: bool,
    ) {
        let id = self.take_obs(changes);
        let rec = EvidenceRec {
            path: path.to_string(),
            evidence,
            base,
            suspect,
        };
        changes.push((Kind::Observation, counter_bytes(id), Some(rec.to_bytes())));
        self.evidence.insert(id, rec);
    }

    /// Stat the path after our publish and record it as ours. If the stat
    /// fails or disagrees, the state is recorded with an impossible size so
    /// the next observation re-reads the file instead of trusting it.
    async fn record_published_async(
        &mut self,
        changes: &mut Vec<Change>,
        path: &RelPath,
        id: Option<Uuid>,
        new: &[u8],
    ) -> StoreResult<()> {
        let rev = revision(new);
        let result = self.observe_io(|| self.p.stat(path)).await?;
        mdbn_replica::mirror_admission::ensure_open(&self.inner)?;
        let st = match result {
            Ok(m) if m.kind == FileKind::File && m.size == new.len() as u64 => {
                self.state_from(id, rev, &m, true)
            }
            _ => {
                self.dirty.insert(path.as_str().to_string(), self.now());
                DiskState {
                    id,
                    rev,
                    size: u64::MAX,
                    mtime_ns: 0,
                    ctime_ns: None,
                    file_id: None,
                    ours: true,
                }
            }
        };
        self.set_disk(changes, path.as_str(), Some(st));
        Ok(())
    }

    // ------------------------------------------------------------ recovery

    async fn recover_intents(&mut self, intents: Vec<(Vec<u8>, IntentRec)>) -> StoreResult<()> {
        let private = self.p.capabilities().private_dir.clone();
        let mut changes = Vec::new();
        let mut flushed_any = false;
        for (key, rec) in intents {
            let it = Intent {
                strategy: rec.strategy,
                op: rec.op.clone(),
                names: rec.names(&private),
            };
            let r = recover(&*self.p, &it).await.map_err(fs_err)?;
            self.stats.recovered += 1;
            let path = rec.op.path.as_str().to_string();
            // A recovered publish may not be durable: the process crashed
            // before its flush. Make it durable before recording these bytes as
            // known, or a later power loss brings the old bytes back under a
            // disk state that says they are ours, and they get ingested as a
            // user edit rather than treated as a recovered publish.
            // - exchange/rename (Linux, macOS; creates and deletes everywhere):
            //   the directory entry;
            // - in-place (Windows D, vault): the file's data.
            // If the flush fails (e.g. a sharing violation on Windows), the
            // bytes are not recorded as known: the path is re-observed instead,
            // which is safe, and the store still opens.
            let mut state = r.state;
            if state == State::Published {
                let in_place = rec.op.new.is_some()
                    && rec.op.expect != Expect::Absent
                    && matches!(
                        rec.strategy,
                        ReplaceStrategy::LockedInPlace | ReplaceStrategy::GuardedInPlace
                    );
                let scope = if in_place {
                    FlushScope::File(rec.op.path.clone())
                } else {
                    FlushScope::Dir(rec.op.path.parent())
                };
                if self.p.flush(scope).await.is_err() {
                    state = State::Drifted;
                } else {
                    flushed_any = true;
                }
            }
            match (state, &rec.op.new) {
                (State::Published, Some(new)) => {
                    self.record_published_async(&mut changes, &rec.op.path, rec.id, new)
                        .await?
                }
                (State::Published, None) => self.set_disk(&mut changes, &path, None),
                // Not published: the disk state stays as it was.
                (State::NotPublished, _) => {}
                (State::Drifted, _) => {
                    self.dirty.insert(path.clone(), self.now());
                }
            }
            for ret in r.retained {
                self.retain_async(&mut changes, ret, &path, rec.id).await;
            }
            for pres in r.preserved {
                self.add_evidence(&mut changes, &path, pres, rec.op.expect.rev(), true);
            }
            changes.push((Kind::Intent, key, None));
        }
        // One device-level commit point for everything recovered: a plain
        // directory fsync doesn't flush the drive cache on macOS (use
        // F_FULLFSYNC at the commit point). Rare (recovery only), so cheap.
        if flushed_any {
            // Required commit point: do not persist trusted bytes or retire
            // intents if the drive cache was not flushed. Opening fails with
            // the original durable intents intact, so a later open can retry.
            self.p.flush(FlushScope::Full).await.map_err(fs_err)?;
        }
        self.db.apply(changes).map_err(db_err)
    }

    // ------------------------------------------------------------ publish

    fn content_bytes(&self, c: &Content) -> StoreResult<Vec<u8>> {
        match c {
            Content::Text(t) => Ok(t.as_bytes().to_vec()),
            Content::Blob(h) => {
                if let Some(original) = self.queued.active_blobs.get(h) {
                    return Ok(original.clone());
                }
                let size = self
                    .inner
                    .blob_size(h)?
                    .ok_or_else(|| StoreError::Io(format!("blob {h:?} not in the local cache")))?;
                self.inner.blob_read(h, 0, size)
            }
        }
    }

    fn rel(path: &str) -> StoreResult<RelPath> {
        RelPath::new(path).map_err(|e| StoreError::Io(format!("bad publish path: {e}")))
    }

    /// Turn the replica's expectation into the protocol's. In-place strategies
    /// need the expected bytes for the journal (torn-write recovery), so they
    /// read them now; a mismatch is an immediate drift.
    async fn expect_for(
        &self,
        path: &RelPath,
        e: RExpect,
    ) -> StoreResult<Result<Expect, &'static str>> {
        match e {
            RExpect::Absent => Ok(Ok(Expect::Absent)),
            RExpect::Revision(h) if self.strategy() == ReplaceStrategy::Exchange => {
                Ok(Ok(Expect::Rev(h)))
            }
            RExpect::Revision(h) => match self.observe_io(|| self.p.read(path)).await? {
                Ok(r) if revision(&r.bytes) == h => Ok(Ok(Expect::Bytes(r.bytes))),
                Ok(_) => Ok(Err("changed")),
                Err(e) if e.is_not_found() => Ok(Err("missing")),
                Err(e) => Err(fs_err(e)),
            },
        }
    }

    /// One publish step: journal, perform, record. Returns a drift reason.
    async fn publish_one(
        &mut self,
        op: PublishOp,
        id: Option<Uuid>,
    ) -> StoreResult<Option<&'static str>> {
        mdbn_replica::mirror_admission::ensure_open(&self.inner)?;
        let private = self.p.capabilities().private_dir.clone();
        let mut changes = Vec::new();
        let n = self.take_name(&mut changes);
        let rec = IntentRec {
            strategy: self.strategy(),
            op: op.clone(),
            n,
            id,
            retained_nosync: self.p.retained_nosync(),
        };
        let key = counter_bytes(n);
        changes.push((Kind::Intent, key.clone(), Some(rec.to_bytes())));
        self.db
            .apply(std::mem::take(&mut changes))
            .map_err(db_err)?;
        let names = rec.names(&private);
        let opts = self.options();
        let admitted = admitted::Admitted {
            p: &*self.p,
            inner: &self.inner,
        };
        let outcome = publish(&admitted, &op, &names, &opts).await;
        let reason = match self.settle_publish(&mut changes, &op, id, outcome).await? {
            Ok(reason) => reason,
            Err(e) => {
                // Original intent/names/bytes stay journaled for recovery.
                self.db.apply(changes).map_err(db_err)?;
                return Err(fs_err(e));
            }
        };
        mdbn_replica::mirror_admission::ensure_open(&self.inner)?;
        changes.push((Kind::Intent, key, None));
        self.db.apply(changes).map_err(db_err)?;
        Ok(reason)
    }

    /// Record one publish outcome in `changes`: the drift reason (`None` when
    /// published), or the platform failure, after which the intent must stay.
    async fn settle_publish(
        &mut self,
        changes: &mut Vec<Change>,
        op: &PublishOp,
        id: Option<Uuid>,
        outcome: Outcome,
    ) -> StoreResult<Result<Option<&'static str>, FsError>> {
        let path = op.path.as_str().to_string();
        Ok(Ok(match outcome {
            Outcome::Published { retained } => {
                self.stats.published += 1;
                match &op.new {
                    Some(new) => {
                        self.record_published_async(changes, &op.path, id, new)
                            .await?
                    }
                    None => self.set_disk(changes, &path, None),
                }
                if let Some(r) = retained {
                    self.retain_async(changes, r, &path, id).await;
                }
                None
            }
            Outcome::Drifted {
                retained,
                preserved,
            } => {
                self.stats.drifted += 1;
                if let Some(r) = retained {
                    self.retain_async(changes, r, &path, id).await;
                }
                if let Some(h) = preserved {
                    self.add_evidence(changes, &path, h, op.expect.rev(), false);
                }
                self.dirty.insert(path.clone(), self.now());
                let gone = matches!(self.observe_io(|| self.p.stat(&op.path)).await?, Err(e) if e.is_not_found());
                Some(if gone { "missing" } else { "changed" })
            }
            Outcome::Busy => {
                // Retry remains Replica-owned; never restart an in-flight task.
                self.stats.drifted += 1;
                self.dirty
                    .insert(path.clone(), self.now() + self.cfg.quiescence_ms);
                Some("locked")
            }
            Outcome::Failed(e) => return Ok(Err(e)),
        }))
    }

    /// Whether an existing ancestor folder of `path` is not a real directory
    /// (a symlink, or a file). Missing ancestors are created by the publish.
    async fn link_in_path(&self, path: &str) -> StoreResult<bool> {
        let rp = Self::rel(path)?;
        let mut dir = rp.parent();
        let mut ancestors = Vec::new();
        while !dir.is_root() {
            ancestors.push(dir.clone());
            dir = dir.parent();
        }
        for a in ancestors.iter().rev() {
            match self.observe_io(|| self.p.stat(a)).await? {
                Ok(m) if m.kind == FileKind::Dir => {}
                Ok(_) => return Ok(true),
                Err(e) if e.is_not_found() => return Ok(false),
                Err(e) => return Err(fs_err(e)),
            }
        }
        Ok(false)
    }

    fn drift(p: &Publish, reason: &str) -> Drift {
        Drift {
            publish: p.clone(),
            reason: reason.to_string(),
        }
    }

    fn same_name_on_volume(&self, a: &str, b: &str) -> bool {
        a == b
            || (self.p.capabilities().case == CaseSensitivity::Insensitive
                && a.to_lowercase() == b.to_lowercase())
    }

    async fn perform(&mut self, publ: &Publish) -> StoreResult<Option<Drift>> {
        if self.strategy() == ReplaceStrategy::ReadOnly {
            return Ok(Some(Self::drift(publ, "read_only")));
        }
        let paths: Vec<&str> = match publ {
            Publish::Write { path, .. } | Publish::Delete { path, .. } => vec![path],
            Publish::Move { from, to, .. } => vec![from, to],
        };
        if paths
            .iter()
            .any(|p| crate::platform::portable_violation(p).is_some())
        {
            return Ok(Some(Self::drift(publ, "invalid_path")));
        }
        for p in &paths {
            if self.link_in_path(p).await? {
                return Ok(Some(Self::drift(publ, "symlink_in_path")));
            }
        }
        match publ {
            Publish::Write {
                id,
                path,
                expect,
                content,
            } => {
                let rp = Self::rel(path)?;
                let expect = match self.expect_for(&rp, *expect).await? {
                    Ok(e) => e,
                    Err(why) => return Ok(Some(Self::drift(publ, why))),
                };
                let new = self.content_bytes(content)?;
                let r = self
                    .publish_one(
                        PublishOp {
                            path: rp,
                            expect,
                            new: Some(new),
                        },
                        *id,
                    )
                    .await?;
                Ok(r.map(|why| Self::drift(publ, why)))
            }
            Publish::Delete { id, path, expect } => {
                let rp = Self::rel(path)?;
                let expect = match self.expect_for(&rp, *expect).await? {
                    Ok(e) => e,
                    Err(why) => return Ok(Some(Self::drift(publ, why))),
                };
                let r = self
                    .publish_one(
                        PublishOp {
                            path: rp,
                            expect,
                            new: None,
                        },
                        *id,
                    )
                    .await?;
                Ok(r.map(|why| Self::drift(publ, why)))
            }
            Publish::Move {
                id,
                from,
                to,
                expect,
                content,
            } => {
                let rf = Self::rel(from)?;
                let rt = Self::rel(to)?;
                let RExpect::Revision(h) = *expect else {
                    return Ok(Some(Self::drift(publ, "missing")));
                };
                let cur = match self.observe_io(|| self.p.read(&rf)).await? {
                    Ok(r) if revision(&r.bytes) == h => r.bytes,
                    Ok(_) => return Ok(Some(Self::drift(publ, "changed"))),
                    Err(e) if e.is_not_found() => return Ok(Some(Self::drift(publ, "missing"))),
                    Err(e) => return Err(fs_err(e)),
                };
                let new = match content {
                    Some(c) => self.content_bytes(c)?,
                    None => cur.clone(),
                };
                if self.same_name_on_volume(from, to) {
                    return self
                        .case_only_move(publ, &rf, &rt, h, cur, new, Some(*id))
                        .await;
                }
                // Create the destination before conditionally removing source.
                if let Some(why) = self
                    .publish_one(
                        PublishOp {
                            path: rt,
                            expect: Expect::Absent,
                            new: Some(new),
                        },
                        Some(*id),
                    )
                    .await?
                {
                    return Ok(Some(Self::drift(publ, why)));
                }
                let expect = match self.expect_for(&rf, RExpect::Revision(h)).await? {
                    Ok(e) => e,
                    Err(why) => return Ok(Some(Self::drift(publ, why))),
                };
                let r = self
                    .publish_one(
                        PublishOp {
                            path: rf,
                            expect,
                            new: None,
                        },
                        Some(*id),
                    )
                    .await?;
                Ok(r.map(|why| Self::drift(publ, why)))
            }
        }
    }

    /// A rename that only changes case (or normalization) on a volume that
    /// treats both names as one file: a direct create would collide with the
    /// file itself, so go through a private name (Android deletes the file
    /// on a direct case-only rename).
    #[allow(clippy::too_many_arguments)]
    async fn case_only_move(
        &mut self,
        publ: &Publish,
        from: &RelPath,
        to: &RelPath,
        h: Hash,
        cur: Vec<u8>,
        new: Vec<u8>,
        id: Option<Uuid>,
    ) -> StoreResult<Option<Drift>> {
        // Both phases keep their own original journaled intent and retained bytes.
        let expect = if self.strategy() == ReplaceStrategy::Exchange {
            Expect::Rev(h)
        } else {
            Expect::Bytes(cur)
        };
        if let Some(why) = self
            .publish_one(
                PublishOp {
                    path: from.clone(),
                    expect,
                    new: None,
                },
                id,
            )
            .await?
        {
            return Ok(Some(Self::drift(publ, why)));
        }
        let r = self
            .publish_one(
                PublishOp {
                    path: to.clone(),
                    expect: Expect::Absent,
                    new: Some(new),
                },
                id,
            )
            .await?;
        Ok(r.map(|why| Self::drift(publ, why)))
    }

    // ------------------------------------------------------------ observe

    fn is_text(&self, path: &str) -> bool {
        let ext = path.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase());
        ext.is_some_and(|e| self.cfg.text_extensions.contains(&e))
    }

    fn included(&self, path: &RelPath, settings: &Option<FileInclusion>) -> bool {
        if self.is_private(path) {
            return false;
        }
        // Hidden files and folders (.git, .obsidian, .trash, .stfolder, ...)
        // and anything else the portable-path policy rejects are never
        // collection content: ingest ignores them, it never holds them.
        if path.as_str().split('/').any(|seg| seg.starts_with('.'))
            || crate::platform::portable_violation(path.as_str()).is_some()
        {
            return false;
        }
        if let Some(s) = settings
            && let Some(ex) = &s.exclude
            && ex.iter().any(|e| {
                let e = e.trim_end_matches('/');
                path.as_str() == e || path.as_str().starts_with(&format!("{e}/"))
            })
        {
            return false;
        }
        true
    }

    async fn walk(
        &self,
        dir: &RelPath,
        settings: &Option<FileInclusion>,
        out: &mut BTreeSet<String>,
        unsupported: &mut BTreeMap<String, String>,
    ) -> StoreResult<()> {
        let mut dirs = vec![dir.clone()];
        while let Some(dir) = dirs.pop() {
            let entries = match self.observe_io(|| self.p.list(&dir)).await? {
                Ok(e) => e,
                Err(e) if e.is_not_found() => continue,
                Err(e) => return Err(fs_err(e)),
            };
            for e in entries {
                let display_path = if dir.is_root() {
                    e.name.clone()
                } else {
                    format!("{dir}/{}", e.name)
                };
                if e.kind == FileKind::InvalidName {
                    unsupported.insert(
                        display_path,
                        "Filename is not valid UTF-8 (shown with replacement characters).".into(),
                    );
                    continue;
                }
                let Ok(p) = dir.join(&e.name) else {
                    unsupported.insert(
                        display_path,
                        "Filename contains unsupported separators or control characters.".into(),
                    );
                    continue;
                };
                if !self.included(&p, settings) {
                    if !self.is_private(&p) {
                        match crate::platform::portable_violation(p.as_str()) {
                            Some("hidden_path" | "dependency_path") | None => {}
                            Some("reserved_name") => {
                                unsupported.insert(p.as_str().into(), "Filename uses a Windows reserved name; rename this file to sync it.".into());
                            }
                            Some(reason) => {
                                unsupported.insert(
                                    p.as_str().into(),
                                    format!(
                                        "Filename is not supported for sync: {}.",
                                        reason.replace('_', " ")
                                    ),
                                );
                            }
                        }
                    }
                    continue;
                }
                if let Some(reason) = Self::unsupported_kind(e.kind) {
                    unsupported.insert(p.as_str().into(), reason.into());
                } else if e.kind == FileKind::Dir {
                    dirs.push(p);
                } else {
                    out.insert(p.as_str().to_string());
                }
            }
        }
        Ok(())
    }

    fn unsupported_kind(kind: FileKind) -> Option<&'static str> {
        match kind {
            FileKind::Symlink => Some("Symlink not followed."),
            FileKind::ReparsePoint => Some("Windows reparse point not followed."),
            FileKind::Other => Some("Special file is not synced."),
            FileKind::InvalidName => Some("Filename is not valid UTF-8."),
            FileKind::File | FileKind::Dir => None,
        }
    }

    fn has_ext(path: &str, exts: &[String]) -> bool {
        let ext = path.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase());
        ext.is_some_and(|e| exts.contains(&e))
    }

    /// How a file of `size` bytes at `path` is observed: `None` reads it whole
    /// as text (records and resources up to the record cap for Markdown);
    /// otherwise it is an attachment, hashed and uploaded in bounded pieces.
    fn attachment_class(&self, path: &str, size: u64) -> Option<AttachmentClass> {
        if !self.is_text(path) {
            return Some(AttachmentClass::Ordinary);
        }
        (Self::has_ext(path, &self.cfg.markdown_extensions) && size > RECORD_CAP_BYTES)
            .then_some(AttachmentClass::OversizedMarkdown)
    }

    /// SHA-256 of the file at `path` through a range handle, in pieces of at
    /// most [`MAX_READ_AT`], with the handle's metadata. `None`: it vanished,
    /// changed while being read, or the platform cannot stream (the store then
    /// does not ingest it).
    async fn hash_streamed(&mut self, path: &RelPath) -> StoreResult<Option<(Hash, FileMeta)>> {
        let (h, meta) = match self.observe_io(|| self.p.open_range_read(path)).await? {
            Ok(x) => x,
            Err(e)
                if e.is_not_found()
                    || matches!(
                        e.kind,
                        FsErrorKind::Unsupported | FsErrorKind::WrongKind | FsErrorKind::Busy
                    ) =>
            {
                return Ok(None);
            }
            Err(e) => return Err(fs_err(e)),
        };
        let r = self.hash_handle(h, &meta).await;
        self.p.close_range_read(h).await.map_err(fs_err)?;
        self.stats.files_streamed += 1;
        Ok(r?.map(|rev| (rev, meta)))
    }

    async fn hash_handle(&self, h: RangeHandle, meta: &FileMeta) -> StoreResult<Option<Hash>> {
        let mut hasher = mdbn_replica::attachments::WholeFileHasher::default();
        let mut at = 0u64;
        while at < meta.size {
            let want =
                u32::try_from((meta.size - at).min(u64::from(MAX_READ_AT))).unwrap_or(MAX_READ_AT);
            let b = match self.observe_io(|| self.p.read_at(h, at, want)).await? {
                Ok(b) => b,
                Err(e) if e.kind == FsErrorKind::Busy => return Ok(None),
                Err(e) => return Err(fs_err(e)),
            };
            if b.len() != want as usize {
                return Ok(None);
            }
            hasher.update(&b);
            at += b.len() as u64;
        }
        match self.observe_io(|| self.p.range_meta(h)).await? {
            Ok(m) if m.size == meta.size && m.mtime_ns == meta.mtime_ns => {
                Ok(Some(hasher.finish()))
            }
            Ok(_) => Ok(None),
            Err(e) => Err(fs_err(e)),
        }
    }

    fn observed(&self, path: &str, seen: &Seen) -> Observed {
        match &seen.body {
            Body::Bytes(bytes) => match std::str::from_utf8(bytes) {
                Ok(t) if self.is_text(path) => Observed::Text(t.to_string()),
                _ => Observed::Attachment {
                    digest: seen.rev,
                    size: bytes.len() as u64,
                    class: AttachmentClass::Ordinary,
                },
            },
            Body::Streamed(class) => Observed::Attachment {
                digest: seen.rev,
                size: seen.meta.size,
                class: *class,
            },
        }
    }

    fn meta_unchanged(k: &DiskState, m: &FileMeta) -> bool {
        k.size == m.size
            && k.mtime_ns == m.mtime_ns
            && k.ctime_ns == m.ctime_ns
            && k.file_id == m.id
    }

    #[allow(clippy::too_many_arguments)]
    fn emit(
        &mut self,
        changes: &mut Vec<Change>,
        out: &mut Vec<Observation>,
        path: &str,
        base: Option<Hash>,
        now: Option<Seen>,
        moved_from: Option<String>,
        id: Option<Uuid>,
    ) -> StoreResult<()> {
        let token = self.take_obs(changes);
        let (now_obs, known_after) = match now {
            Some(seen) => {
                let st = self.state_from(id, seen.rev, &seen.meta, false);
                (Some(self.observed(path, &seen)), Some(st))
            }
            None => (None, None),
        };
        // Transfer only the dependency-read hint to a genuine newer observation;
        // retain old tokens/evidence, without acknowledging or confirming them.
        let mut resource_requested = false;
        let mut deferred = false;
        if let Some(tokens) = self.outstanding_at.get(path) {
            for token in tokens {
                if let Some(old) = self.outstanding.get_mut(token) {
                    resource_requested |= old.resource_requested;
                    deferred |= old.deferred;
                    old.resource_requested = false;
                    old.deferred = false;
                }
            }
        }
        let attachment = match &now_obs {
            Some(Observed::Attachment {
                digest,
                size,
                class,
            }) => Some((*digest, *size, *class)),
            _ => None,
        };
        self.put_outstanding(
            token,
            Outstanding {
                path: path.to_string(),
                base,
                resource_requested,
                deferred,
                attachment,
                known_after,
                moved_from: moved_from.clone(),
                evidence: None,
            },
        );
        out.push(Observation {
            token: ObservationId(token),
            path: path.to_string(),
            base,
            now: now_obs,
            moved_from,
            provenance: Provenance::Normal,
        });
        Ok(())
    }

    /// Redeliver stable ordinary text evidence with its ORIGINAL token/base.
    /// Missing dependency deferral must not consume it or mint a fresh attempt.
    async fn reoffer_outstanding(&self, out: &mut Vec<Observation>) -> StoreResult<()> {
        const MAX: usize = 64;
        const BYTES: usize = 8 * 1024 * 1024;
        let mut bytes = 0usize;
        let mut count = 0usize;
        for (id, o) in self.outstanding.iter().take(4096) {
            if o.evidence.is_some()
                || (!o.resource_requested && !o.deferred)
                || out.iter().any(|v| v.token == ObservationId(*id))
                || self.dirty.get(&o.path).is_some_and(|due| *due > self.now())
            {
                continue;
            }
            if count == MAX {
                break;
            }
            if let Some(from) = &o.moved_from {
                let from = Self::rel(from)?;
                match self.observe_io(|| self.p.stat(&from)).await? {
                    Err(e) if e.is_not_found() => {}
                    _ => continue,
                }
            }
            let now = match &o.known_after {
                Some(expected) => {
                    let path = Self::rel(&o.path)?;
                    let meta = match self.observe_io(|| self.p.stat(&path)).await? {
                        Ok(meta) if meta.kind == FileKind::File => meta,
                        _ => continue,
                    };
                    if !o.resource_requested
                        && let Some((digest, size, class)) = o.attachment
                    {
                        if !Self::meta_unchanged(expected, &meta) {
                            continue;
                        }
                        out.push(Observation {
                            token: ObservationId(*id),
                            path: o.path.clone(),
                            base: o.base,
                            now: Some(Observed::Attachment {
                                digest,
                                size,
                                class,
                            }),
                            moved_from: o.moved_from.clone(),
                            provenance: Provenance::Normal,
                        });
                        count += 1;
                        continue;
                    }
                    if meta.size > 1024 * 1024 {
                        continue;
                    }
                    let read = match self.observe_io(|| self.p.read(&path)).await? {
                        Ok(read) if read.meta == meta && read.bytes.len() <= 1024 * 1024 => read,
                        _ => continue,
                    };
                    let hash = revision(&read.bytes);
                    if hash != expected.rev {
                        continue;
                    }
                    let seen = Seen {
                        rev: hash,
                        meta: read.meta,
                        body: Body::Bytes(read.bytes),
                    };
                    let observed = self.observed(&o.path, &seen);
                    let size = usize::try_from(meta.size).map_err(|_| StoreError::Full)?;
                    if bytes.saturating_add(size) > BYTES {
                        break;
                    }
                    bytes += size;
                    Some(observed)
                }
                None => {
                    let path = Self::rel(&o.path)?;
                    match self.observe_io(|| self.p.stat(&path)).await? {
                        Err(e) if e.is_not_found() => None,
                        _ => continue,
                    }
                }
            };
            out.push(Observation {
                token: ObservationId(*id),
                path: o.path.clone(),
                base: o.base,
                now,
                moved_from: o.moved_from.clone(),
                provenance: Provenance::Normal,
            });
            count += 1;
        }
        Ok(())
    }

    /// Is an outstanding observation already reporting exactly this?
    fn already_reported(&self, path: &str, rev: Option<Hash>) -> bool {
        self.outstanding_at
            .get(path)
            .into_iter()
            .flatten()
            .filter_map(|t| self.outstanding.get(t))
            .any(|o| o.known_after.as_ref().map(|k| k.rev) == rev && o.evidence.is_none())
    }

    async fn check_path(
        &mut self,
        path: &str,
        changes: &mut Vec<Change>,
        out: &mut Vec<Observation>,
        quiet_recheck: bool,
    ) -> StoreResult<()> {
        let rp = Self::rel(path)?;
        let meta = match self.observe_io(|| self.p.stat(&rp)).await? {
            Ok(m) if m.kind == FileKind::File => Some(m),
            Ok(m) => {
                self.stats.unsupported_paths.remove(path);
                if let Some(reason) = Self::unsupported_kind(m.kind) {
                    self.stats
                        .unsupported_paths
                        .insert(path.into(), reason.into());
                }
                None
            }
            Err(e) if e.is_not_found() => {
                self.stats.unsupported_paths.remove(path);
                None
            }
            Err(e) => return Err(fs_err(e)),
        };
        // Start the evidence window at original stat completion: suspended
        // host IO can itself take longer than the missing/move window.
        let now_ms = self.now();
        let known = self.disk.get(path).cloned();
        let Some(meta) = meta else {
            self.appeared.remove(path);
            self.forget_seen(changes, path);
            if let Some(k) = known
                && !self.missing.contains_key(path)
            {
                // A single "missing" is never a delete:
                // re-check after a delay, then wait out the move window.
                self.missing.insert(
                    path.to_string(),
                    Missing {
                        known: k,
                        first_seen: now_ms,
                        confirmed: false,
                    },
                );
            }
            return Ok(());
        };
        if !known
            .as_ref()
            .is_some_and(|k| Self::meta_unchanged(k, &meta))
        {
            self.stats.unsupported_paths.remove(path);
        }
        if Self::has_ext(path, &self.cfg.markdown_extensions) && meta.size > RECORD_CAP_BYTES {
            self.stats.unsupported_paths.insert(path.into(), format!(
                "Too large to index as a note: {} bytes; limit is {RECORD_CAP_BYTES} bytes (1 MiB).", meta.size));
        }
        // It exists: not missing (any more).
        if self.missing.remove(path).is_some() {
            // Came back (vim-style save, swap window): compare as usual.
        }
        if let Some(k) = &known
            && Self::meta_unchanged(k, &meta)
        {
            return Ok(());
        }
        let Some(seen) = self.read_seen(changes, path, &rp, &meta).await? else {
            return Ok(());
        };
        let rev = seen.rev;
        match known {
            Some(k) if k.rev == rev => {
                // Same bytes, new metadata (touch, our swap): just remember it.
                let st = self.state_from(k.id, rev, &seen.meta, k.ours);
                self.set_disk(changes, path, Some(st));
            }
            Some(k) => {
                if seen.meta.size == 0 && k.size != 0 && !quiet_recheck {
                    // An O_TRUNC writer between truncate and write:
                    // look once more after a quiet window before believing it.
                    self.dirty
                        .insert(path.to_string(), self.now() + self.cfg.quiescence_ms.max(1));
                    return Ok(());
                }
                if !self.already_reported(path, Some(rev)) {
                    self.emit(changes, out, path, Some(k.rev), Some(seen), None, k.id)?;
                }
            }
            None => {
                if self.already_reported(path, Some(rev)) {
                    return Ok(());
                }
                // Might be the far end of a move: if a known path has these
                // bytes or this file ID, wait for the move window.
                // (`path` itself is not in `disk` here.)
                let could_pair = self.disk_revs.contains_key(&rev)
                    || seen
                        .meta
                        .id
                        .is_some_and(|id| self.disk_ids.contains_key(&id));
                if could_pair {
                    self.appeared.entry(path.to_string()).or_insert(Appeared {
                        seen,
                        since: now_ms,
                    });
                } else {
                    self.emit(changes, out, path, None, Some(seen), None, None)?;
                }
            }
        }
        Ok(())
    }

    /// Read what `path` holds now: text read whole, anything else (or Markdown
    /// over the record cap) hashed through a range handle in bounded pieces.
    /// Explicit whole-file snapshot providers document their own allocation
    /// policy; the store does not add a silent whole-read fallback. `None`: it changed while being read (look again after
    /// a quiet window), vanished, or cannot be streamed here.
    async fn read_seen(
        &mut self,
        changes: &mut Vec<Change>,
        path: &str,
        rp: &RelPath,
        meta: &FileMeta,
    ) -> StoreResult<Option<Seen>> {
        if let Some(class) = self.attachment_class(path, meta.size) {
            // Hashed before with the same size, times and file ID: the same
            // policy that lets a known file skip its read (`meta_unchanged`).
            if let Some(k) = self.seen.get(path)
                && Self::meta_unchanged(k, meta)
            {
                self.stats.hashes_reused += 1;
                return Ok(Some(Seen {
                    body: Body::Streamed(class),
                    rev: k.rev,
                    meta: meta.clone(),
                }));
            }
            let Some((rev, m)) = self.hash_streamed(rp).await? else {
                self.dirty
                    .insert(path.to_string(), self.now() + self.cfg.quiescence_ms);
                return Ok(None);
            };
            self.stats.files_read += 1;
            if m.size != meta.size || m.mtime_ns != meta.mtime_ns {
                self.dirty
                    .insert(path.to_string(), self.now() + self.cfg.quiescence_ms);
                return Ok(None);
            }
            // Grew past the record cap while being looked at: classify by what
            // was actually hashed.
            let class = self.attachment_class(path, m.size).unwrap_or(class);
            let st = self.state_from(None, rev, &m, false);
            changes.push((Kind::Seen, path.as_bytes().to_vec(), Some(st.to_bytes())));
            self.seen.insert(path.to_string(), st);
            return Ok(Some(Seen {
                body: Body::Streamed(class),
                rev,
                meta: m,
            }));
        }
        let read = match self.observe_io(|| self.p.read(rp)).await? {
            Ok(r) => r,
            Err(e) if e.is_not_found() => {
                self.dirty
                    .insert(path.to_string(), self.now() + self.cfg.missing_recheck_ms);
                return Ok(None);
            }
            Err(e) => return Err(fs_err(e)),
        };
        self.stats.files_read += 1;
        // Changed while we read: wait for quiet again.
        if read.meta.size != read.bytes.len() as u64 || read.meta.mtime_ns != meta.mtime_ns {
            self.dirty
                .insert(path.to_string(), self.now() + self.cfg.quiescence_ms);
            return Ok(None);
        }
        if self.is_text(path) && std::str::from_utf8(&read.bytes).is_err() {
            self.stats.unsupported_paths.insert(
                path.into(),
                "Not valid UTF-8; cannot be read as text.".into(),
            );
        }
        let rev = revision(&read.bytes);
        Ok(Some(Seen {
            body: Body::Bytes(read.bytes),
            rev,
            meta: read.meta,
        }))
    }

    /// Advance missing paths and appeared paths: re-check, pair moves, and emit
    /// deletes and creates whose windows have passed.
    async fn settle_moves(
        &mut self,
        changes: &mut Vec<Change>,
        out: &mut Vec<Observation>,
    ) -> StoreResult<()> {
        let now_ms = self.now();
        let paths: Vec<String> = self.missing.keys().cloned().collect();
        for path in paths {
            let Some(m) = self.missing.get(&path).cloned() else {
                continue;
            };
            if !m.confirmed {
                if now_ms < m.first_seen + self.cfg.missing_recheck_ms {
                    continue;
                }
                let rp = Self::rel(&path)?;
                match self.observe_io(|| self.p.stat(&rp)).await? {
                    Ok(meta) if meta.kind == FileKind::File => {
                        self.missing.remove(&path);
                        self.dirty.insert(path.clone(), now_ms);
                        continue;
                    }
                    _ => {
                        if let Some(mm) = self.missing.get_mut(&path) {
                            mm.confirmed = true;
                        }
                    }
                }
            }
            // Pair with an appeared path: same bytes, or same file ID with
            // similar content (a move with an edit).
            let pair = self
                .appeared
                .iter()
                .find(|(_, a)| a.seen.rev == m.known.rev)
                .or_else(|| {
                    self.appeared.iter().find(|(_, a)| {
                        m.known.file_id.is_some() && a.seen.meta.id == m.known.file_id
                    })
                })
                .map(|(p, _)| p.clone());
            if let Some(to) = pair {
                let Some(a) = self.appeared.remove(&to) else {
                    continue;
                };
                self.missing.remove(&path);
                self.emit(
                    changes,
                    out,
                    &to,
                    Some(m.known.rev),
                    Some(a.seen),
                    Some(path.clone()),
                    m.known.id,
                )?;
                continue;
            }
            if now_ms >= m.first_seen + self.cfg.move_window_ms {
                self.missing.remove(&path);
                if !self.already_reported(&path, None) {
                    self.emit(
                        changes,
                        out,
                        &path,
                        Some(m.known.rev),
                        None,
                        None,
                        m.known.id,
                    )?;
                }
            }
        }
        // Appeared paths whose window passed unpaired are creates (or copies).
        let due: Vec<String> = self
            .appeared
            .iter()
            .filter(|(_, a)| now_ms >= a.since + self.cfg.move_window_ms)
            .map(|(p, _)| p.clone())
            .collect();
        for p in due {
            if let Some(a) = self.appeared.remove(&p) {
                self.emit(changes, out, &p, None, Some(a.seen), None, None)?;
            }
        }
        Ok(())
    }

    async fn settle_retained(&mut self, changes: &mut Vec<Change>) -> StoreResult<()> {
        let now_ms = self.now();
        let retained: Vec<_> = self.retained.values().cloned().collect();
        let parked: Vec<_> = retained
            .iter()
            .map(|r| Parked {
                since: r.since,
                session: r.session,
                size: r.size,
            })
            .collect();
        let due = retention::due(
            self.release,
            self.cfg.retention_ms,
            now_ms,
            self.session,
            &parked,
        );
        for selected in due {
            let r = &retained[selected.index];
            match self.observe_io(|| settle(&*self.p, &r.r)).await? {
                Settled::Released | Settled::Gone => {}
                Settled::LateWrite => {
                    self.stats.late_writes += 1;
                    self.add_evidence(
                        changes,
                        &r.user_path,
                        r.r.path.clone(),
                        Some(r.r.expect),
                        false,
                    );
                }
                Settled::Busy | Settled::Error => continue,
            }
            if selected.reclaimed {
                self.stats.reclaimed += 1;
                self.reclaimed.push(Reclaimed {
                    size: r.size,
                    since: r.since,
                });
            }
            changes.push((Kind::Retained, r.r.path.as_str().as_bytes().to_vec(), None));
            self.retained.remove(&r.r.path);
        }
        Ok(())
    }

    async fn deliver_evidence(&mut self, out: &mut Vec<Observation>) -> StoreResult<()> {
        let ids: Vec<u64> = self
            .evidence
            .keys()
            .copied()
            .filter(|id| !self.outstanding.contains_key(id))
            .collect();
        for id in ids {
            let Some(e) = self.evidence.get(&id).cloned() else {
                continue;
            };
            // Evidence of an attachment-class file (binary, or Markdown over the
            // record cap) stays preserved in the private directory: it is never
            // read whole, and an upload reads the user path, not the evidence.
            match self.observe_io(|| self.p.stat(&e.evidence)).await? {
                Ok(m) if self.attachment_class(&e.path, m.size).is_none() => {}
                Ok(_) => continue,
                Err(err) if err.is_not_found() => continue,
                Err(err) => return Err(fs_err(err)),
            }
            let read = match self.observe_io(|| self.p.read(&e.evidence)).await? {
                Ok(r) => r,
                // Gone: nothing to deliver (an earlier ack removed it).
                Err(err) if err.is_not_found() => continue,
                Err(err) => return Err(fs_err(err)),
            };
            let seen = Seen {
                rev: revision(&read.bytes),
                body: Body::Bytes(read.bytes),
                meta: read.meta,
            };
            let now = self.observed(&e.path, &seen);
            if !matches!(now, Observed::Text(_)) {
                // Not UTF-8 text: kept, as above.
                continue;
            }
            self.put_outstanding(
                id,
                Outstanding {
                    path: e.path.clone(),
                    base: e.base,
                    resource_requested: false,
                    deferred: false,
                    attachment: None,
                    known_after: None,
                    moved_from: None,
                    evidence: Some(e.evidence.clone()),
                },
            );
            out.push(Observation {
                token: ObservationId(id),
                path: e.path.clone(),
                base: e.base,
                now: Some(now),
                moved_from: None,
                provenance: if e.suspect {
                    Provenance::Suspect
                } else {
                    Provenance::Normal
                },
            });
        }
        Ok(())
    }

    fn queue_charge(&self, tx: &Tx) -> StoreResult<deferred::Charge> {
        use deferred::{MAX_BYTES, MAX_OPERATIONS, MAX_PATH_BYTES, MAX_TEXT_BYTES, bounds_error};
        let operations = (tx.publish.len() as u64)
            .checked_add(tx.ack_observations.len() as u64)
            .ok_or_else(bounds_error)?;
        if operations > MAX_OPERATIONS {
            return Err(bounds_error());
        }
        let mut bytes = operations.checked_mul(128).ok_or_else(bounds_error)?;
        for publish in &tx.publish {
            let (paths, content): (Vec<&str>, Option<&Content>) = match publish {
                Publish::Write { path, content, .. } => (vec![path], Some(content)),
                Publish::Delete { path, .. } => (vec![path], None),
                Publish::Move {
                    from, to, content, ..
                } => (vec![from, to], content.as_ref()),
            };
            for path in paths {
                if path.is_empty() || path.len() > MAX_PATH_BYTES {
                    return Err(bounds_error());
                }
                RelPath::new(path).map_err(|_| bounds_error())?;
                bytes = bytes
                    .checked_add(path.len() as u64)
                    .ok_or_else(bounds_error)?;
            }
            let payload = match content {
                Some(Content::Text(text)) => {
                    if text.len() > MAX_TEXT_BYTES {
                        return Err(bounds_error());
                    }
                    text.len() as u64
                }
                Some(Content::Blob(digest)) => {
                    self.inner.blob_size(digest)?.ok_or_else(bounds_error)?
                }
                None => 0,
            };
            bytes = bytes.checked_add(payload).ok_or_else(bounds_error)?;
            if bytes > MAX_BYTES {
                return Err(bounds_error());
            }
        }
        Ok(deferred::Charge { bytes, operations })
    }

    fn queue_blobs(&self, tx: &Tx) -> StoreResult<BTreeMap<Hash, Vec<u8>>> {
        let mut blobs = BTreeMap::new();
        for publish in &tx.publish {
            let content = match publish {
                Publish::Write { content, .. } => Some(content),
                Publish::Move { content, .. } => content.as_ref(),
                Publish::Delete { .. } => None,
            };
            if let Some(Content::Blob(digest)) = content {
                if blobs.contains_key(digest) {
                    continue;
                }
                let size = self
                    .inner
                    .blob_size(digest)?
                    .ok_or_else(deferred::bounds_error)?;
                if size > deferred::MAX_BYTES {
                    return Err(deferred::bounds_error());
                }
                let original = self.inner.blob_read(digest, 0, size)?;
                if original.len() as u64 != size || revision(&original) != *digest {
                    return Err(deferred::bounds_error());
                }
                blobs.insert(*digest, original);
            }
        }
        Ok(blobs)
    }

    fn queue_commit(&mut self, tx: Tx) -> StoreResult<CommitReport> {
        self.ensure_commit_available()?;
        if tx.clear_confirmed && !self.queued.is_idle() {
            return Err(StoreError::CommitAborted(
                "drain ORIGINAL queued file work/results before snapshot reset".into(),
            ));
        }
        // Check before ANY inner rows, ACK state or owned queue changes.
        mdbn_replica::mirror_admission::check_tx(
            self.inner
                .meta(mdbn_replica::mirror_admission::META)?
                .as_deref(),
            &tx,
        )?;
        let required = !tx.publish.is_empty()
            || tx.ack_observations.iter().any(|id| {
                self.outstanding
                    .get(&id.0)
                    .is_some_and(|o| o.evidence.is_some())
            });
        if !required {
            // Ordinary ACKs have no host IO. Preserve their immediate native
            // bookkeeping so original disk captures do not manufacture writes.
            let (publishes, acks) = self.prepare_commit(tx)?;
            return run_ready(&self.timers.clone(), self.finish_commit(&publishes, &acks))
                .ok_or_else(suspended)?;
        }
        let charge = self.queue_charge(&tx)?;
        let batch = self.queued.reserve(charge, !tx.publish.is_empty())?;
        let blobs = match self.queue_blobs(&tx) {
            Ok(blobs) => blobs,
            Err(error) => {
                self.queued.release(batch, charge);
                return Err(error);
            }
        };
        let (publishes, acks) = match self.prepare_commit(tx) {
            Ok(work) => work,
            Err(error) => {
                self.queued.release(batch, charge);
                self.queued.fault = true;
                return Err(error);
            }
        };
        self.queued.queue.push_back(deferred::Work {
            batch,
            publishes,
            acks,
            charge,
            blobs,
        });
        Ok(CommitReport {
            drifts: Vec::new(),
            deferred: batch,
        })
    }

    async fn progress_task(&mut self) -> StoreResult<CommitReport> {
        // Later metadata-only commits may have reopened index deferral. Close
        // it before any original queued outside effect.
        if let Err(error) = mdbn_replica::mirror_admission::ensure_open(&self.inner)
            .and_then(|()| self.end_deferral())
        {
            self.queued.fault = true;
            return Err(error);
        }
        while let Some(work) = self.queued.queue.pop_front() {
            self.queued.active_blobs = work.blobs;
            let report = match self.finish_commit(&work.publishes, &work.acks).await {
                Ok(report) => report,
                Err(error) => {
                    self.queued.fault = true;
                    return Err(error);
                }
            };
            self.queued.active_blobs.clear();
            if let Some(batch) = work.batch {
                self.queued.results.push(PublishResult {
                    batch,
                    drifts: report.drifts,
                });
            } else {
                // Zero-publish evidence ACKs are real FIFO cleanup obligations,
                // not publication results or invented Replica wait ownership.
                self.queued.release(None, work.charge);
            }
        }
        Ok(CommitReport::default())
    }

    fn prepare_commit(&mut self, mut tx: Tx) -> StoreResult<(Vec<Publish>, Vec<ObservationId>)> {
        mdbn_replica::mirror_admission::check_tx(
            self.inner
                .meta(mdbn_replica::mirror_admission::META)?
                .as_deref(),
            &tx,
        )?;
        let publishes = std::mem::take(&mut tx.publish);
        let acks = tx.ack_observations.clone();
        if !publishes.is_empty()
            || acks.iter().any(|a| {
                self.outstanding
                    .get(&a.0)
                    .is_some_and(|o| o.evidence.is_some())
            })
        {
            self.end_deferral()?;
        }
        self.inner.commit(tx).map_err(inner_commit_error)?;
        Ok((publishes, acks))
    }

    async fn commit_task(&mut self, tx: Tx) -> StoreResult<CommitReport> {
        let (publishes, acks) = self.prepare_commit(tx)?;
        self.finish_commit(&publishes, &acks).await
    }

    async fn finish_commit(
        &mut self,
        publishes: &[Publish],
        acks: &[ObservationId],
    ) -> StoreResult<CommitReport> {
        let mut changes = Vec::new();
        self.ack(acks, &mut changes).await?;
        self.db.apply(changes).map_err(db_err)?;
        let mut report = CommitReport::default();
        let mut held = AlreadyHeld::default();
        let mut i = 0;
        while i < publishes.len() {
            // A run of plain creates (an install, a join) shares one journal
            // write, one barrier and one flush instead of four syncs a file.
            let (taken, run) = self.create_run(&publishes[i..], &mut held).await?;
            if taken > 0 {
                i += taken;
                self.flush_held(&mut held)?;
                if run.len() >= BATCH_MIN {
                    report.drifts.extend(self.publish_batch(run).await?);
                } else {
                    for p in run {
                        if let Some(d) = self.perform(p).await? {
                            report.drifts.push(d);
                        }
                    }
                }
                continue;
            }
            let p = &publishes[i];
            i += 1;
            if self.already_held(p, &mut held).await? {
                continue;
            }
            self.flush_held(&mut held)?;
            if let Some(d) = self.perform(p).await? {
                report.drifts.push(d);
            }
        }
        self.flush_held(&mut held)?;
        Ok(report)
    }

    /// The leading run of `publishes` that [`Self::publish_batch`] may take:
    /// creates of distinct paths on an immediate commit of at least
    /// [`BATCH_MIN`] publishes. Those already on disk are recorded in `held`
    /// as they are met. Returns how many publishes the run spans (0: none)
    /// and the creates still to write, in order.
    async fn create_run<'p>(
        &mut self,
        publishes: &'p [Publish],
        held: &mut AlreadyHeld,
    ) -> StoreResult<(usize, Vec<&'p Publish>)> {
        if !self.immediate
            || !matches!(
                self.strategy(),
                ReplaceStrategy::Exchange | ReplaceStrategy::LockedInPlace
            )
            || publishes.len() < BATCH_MIN
        {
            return Ok((0, Vec::new()));
        }
        let mut paths = BTreeSet::new();
        let mut run = Vec::new();
        let mut taken = 0;
        for p in publishes {
            let Publish::Write {
                path,
                expect: RExpect::Absent,
                ..
            } = p
            else {
                break;
            };
            if crate::platform::portable_violation(path).is_some() || !paths.insert(path.as_str()) {
                break;
            }
            if !self.already_held(p, held).await? {
                run.push(p);
            }
            taken += 1;
        }
        Ok((taken, run))
    }

    /// Publish plain creates together: journal every intent in one write,
    /// write every temp unsynced, one barrier, then each no-replace rename
    /// without a directory sync, one full flush, and every outcome in one
    /// write. A crash anywhere leaves journaled intents that recovery settles
    /// exactly as for single publishes (a temp never renamed is not
    /// published; a renamed one is flushed before it is recorded).
    async fn publish_batch(&mut self, run: Vec<&Publish>) -> StoreResult<Vec<Drift>> {
        mdbn_replica::mirror_admission::ensure_open(&self.inner)?;
        let private = self.p.capabilities().private_dir.clone();
        let mut drifts = Vec::new();
        let mut changes = Vec::new();
        let mut items = Vec::new();
        for publ in run {
            let Publish::Write {
                id, path, content, ..
            } = publ
            else {
                unreachable!("create_run takes creates only");
            };
            if self.link_in_path(path).await? {
                drifts.push(Self::drift(publ, "symlink_in_path"));
                continue;
            }
            let op = PublishOp {
                path: Self::rel(path)?,
                expect: Expect::Absent,
                new: Some(self.content_bytes(content)?),
            };
            let n = self.take_name(&mut changes);
            let rec = IntentRec {
                strategy: self.strategy(),
                op,
                n,
                id: *id,
                retained_nosync: self.p.retained_nosync(),
            };
            changes.push((Kind::Intent, counter_bytes(n), Some(rec.to_bytes())));
            items.push((publ, rec));
        }
        self.db
            .apply(std::mem::take(&mut changes))
            .map_err(db_err)?;
        let opts = Options {
            sync_temp: false,
            sync_dir: false,
            ..self.options()
        };
        let mut ours = Vec::with_capacity(items.len());
        {
            let admitted = admitted::Admitted {
                p: &*self.p,
                inner: &self.inner,
            };
            for (_, rec) in &items {
                let names = rec.names(&private);
                let dir = rec.op.path.parent();
                if !dir.is_root() {
                    admitted.create_dir_all(&dir).await.map_err(fs_err)?;
                }
                let new = rec.op.new.as_deref().unwrap_or_default();
                let m = admitted
                    .write_new(&names.tmp, new, false)
                    .await
                    .map_err(fs_err)?;
                ours.push(m.id);
            }
            admitted.flush(FlushScope::Barrier).await.map_err(fs_err)?;
        }
        let mut published_any = false;
        let mut retire = Vec::with_capacity(items.len());
        for ((publ, rec), our) in items.into_iter().zip(ours) {
            let names = rec.names(&private);
            let outcome = {
                let admitted = admitted::Admitted {
                    p: &*self.p,
                    inner: &self.inner,
                };
                crate::publish::publish_prewritten(&admitted, &rec.op, &names, &opts, our).await
            };
            published_any |= matches!(outcome, Outcome::Published { .. });
            // A failure leaves every intent of the batch journaled (nothing of
            // it is recorded before the flush): the next open recovers them.
            match self
                .settle_publish(&mut changes, &rec.op, rec.id, outcome)
                .await?
            {
                Ok(None) => {}
                Ok(Some(why)) => drifts.push(Self::drift(publ, why)),
                Err(e) => return Err(fs_err(e)),
            }
            retire.push(counter_bytes(rec.n));
        }
        if published_any {
            // Required commit point before any of these bytes count as ours.
            self.p.flush(FlushScope::Full).await.map_err(fs_err)?;
        }
        mdbn_replica::mirror_admission::ensure_open(&self.inner)?;
        changes.extend(retire.into_iter().map(|k| (Kind::Intent, k, None)));
        self.db.apply(changes).map_err(db_err)?;
        Ok(drifts)
    }

    /// A create whose path already holds exactly the new bytes (a folder
    /// adopted with its files in place, an install resumed after a crash,
    /// including a publish recovered and recorded at reopen):
    /// record the file as on disk without writing a temp, renaming or
    /// flushing. Anything less than an exact match (other bytes, a symlink,
    /// a name that only matches by case or normalization) takes the normal
    /// publish, which leaves the user's file alone and reports a drift.
    /// Immediate commits only: a host that queues and polls IO keeps the
    /// original IO sequence it accounts for.
    async fn already_held(&mut self, publ: &Publish, held: &mut AlreadyHeld) -> StoreResult<bool> {
        let Publish::Write {
            id,
            path,
            expect: RExpect::Absent,
            content,
        } = publ
        else {
            return Ok(false);
        };
        if !self.immediate
            || self.strategy() == ReplaceStrategy::ReadOnly
            || crate::platform::portable_violation(path).is_some()
        {
            return Ok(false);
        }
        let rp = Self::rel(path)?;
        let new = self.content_bytes(content)?;
        // Already recorded here (a publish recovered after a crash): only as
        // these very bytes for this ID, and the file must still hold them.
        if self
            .disk
            .get(path.as_str())
            .is_some_and(|row| row.rev != revision(&new) || row.id != *id)
        {
            return Ok(false);
        }
        let meta = match self.observe_io(|| self.p.stat(&rp)).await? {
            Ok(m) if m.kind == FileKind::File && m.size == new.len() as u64 => m,
            _ => return Ok(false),
        };
        if self.link_in_path(path).await? || !self.exact_name(&rp, held).await? {
            return Ok(false);
        }
        let read = match self.observe_io(|| self.p.read(&rp)).await? {
            Ok(r) => r,
            Err(_) => return Ok(false),
        };
        if read.bytes != new || read.meta.size != meta.size || read.meta.mtime_ns != meta.mtime_ns {
            return Ok(false);
        }
        mdbn_replica::mirror_admission::ensure_open(&self.inner)?;
        let st = self.state_from(*id, revision(&new), &read.meta, false);
        self.set_disk(&mut held.changes, path, Some(st));
        self.stats.already_held += 1;
        Ok(true)
    }

    /// Whether `path`'s last segment is spelled exactly as on disk. Only a
    /// case- or normalization-insensitive volume can resolve a different
    /// spelling to the same file; there the parent is listed once per commit.
    async fn exact_name(&mut self, path: &RelPath, held: &mut AlreadyHeld) -> StoreResult<bool> {
        if self.p.capabilities().case != CaseSensitivity::Insensitive {
            return Ok(true);
        }
        let dir = path.parent();
        if !held.names.contains_key(&dir) {
            let names = match self.observe_io(|| self.p.list(&dir)).await? {
                Ok(entries) => entries.into_iter().map(|e| e.name).collect(),
                Err(_) => BTreeSet::new(),
            };
            held.names.insert(dir.clone(), names);
        }
        Ok(held.names[&dir].contains(path.file_name()))
    }

    fn flush_held(&mut self, held: &mut AlreadyHeld) -> StoreResult<()> {
        if held.changes.is_empty() {
            return Ok(());
        }
        self.db
            .apply(std::mem::take(&mut held.changes))
            .map_err(db_err)
    }

    async fn ack(&mut self, ids: &[ObservationId], changes: &mut Vec<Change>) -> StoreResult<()> {
        for ObservationId(id) in ids {
            let Some(o) = self.take_outstanding(*id) else {
                continue;
            };
            if let Some(ev) = &o.evidence {
                // The inner commit finished. Retain ORIGINAL cleanup IO until
                // completion; failure keeps the persisted evidence obligation.
                match self.observe_io(|| self.p.remove_file(ev)).await? {
                    Ok(()) => {}
                    Err(e) if e.is_not_found() => {}
                    Err(e) => return Err(fs_err(e)),
                }
                mdbn_replica::mirror_admission::ensure_open(&self.inner)?;
                changes.push((Kind::Observation, counter_bytes(*id), None));
                self.evidence.remove(id);
                continue;
            }
            if let Some(from) = &o.moved_from {
                self.set_disk(changes, from, None);
            }
            self.set_disk(changes, &o.path, o.known_after.clone());
        }
        Ok(())
    }
}

impl<P: FilePlatform + 'static, M: Store, D: DiskDb> Store for FileStore<P, M, D> {
    fn head(&self) -> StoreResult<Head> {
        self.ensure_commit_available()?;
        self.inner.head()
    }
    fn record(&self, id: &Uuid) -> StoreResult<Option<RecordRow>> {
        self.inner.record(id)
    }
    fn record_at(&self, path_key: &str) -> StoreResult<Option<Uuid>> {
        self.inner.record_at(path_key)
    }
    fn records(&self, page: Page) -> StoreResult<Vec<RecordRow>> {
        self.inner.records(page)
    }
    fn records_in_buckets(
        &self,
        range: std::ops::Range<u32>,
        page: Page,
    ) -> StoreResult<Vec<RecordRow>> {
        self.inner.records_in_buckets(range, page)
    }
    fn record_count(&self) -> StoreResult<u64> {
        self.inner.record_count()
    }
    fn file(&self, id: &Uuid) -> StoreResult<Option<FileRow>> {
        self.inner.file(id)
    }
    fn file_at(&self, path_key: &str) -> StoreResult<Option<Uuid>> {
        self.inner.file_at(path_key)
    }
    fn files(&self, page: Page) -> StoreResult<Vec<FileRow>> {
        self.inner.files(page)
    }
    fn files_in_buckets(
        &self,
        range: std::ops::Range<u32>,
        page: Page,
    ) -> StoreResult<Vec<FileRow>> {
        self.inner.files_in_buckets(range, page)
    }
    fn resource(&self, path: &str) -> StoreResult<Option<String>> {
        self.inner.resource(path)
    }
    fn resources(&self) -> StoreResult<Vec<(String, String)>> {
        self.inner.resources()
    }
    fn resource_observation_batch_complete(
        &self,
        observations: &[Observation],
    ) -> StoreResult<bool> {
        let timers = self.timers.clone();
        run_ready(&timers, self.resource_batch_complete_task(observations)).ok_or_else(suspended)?
    }
    fn resource_observation_batch_complete_async<'a>(
        &'a self,
        observations: &'a [Observation],
    ) -> mdbn_replica::store::StoreFuture<'a, bool> {
        Box::pin(self.resource_batch_complete_task(observations))
    }
    fn resource_observation_refused(
        &mut self,
        tokens: &[ObservationId],
        mutation: Uuid,
    ) -> StoreResult<()> {
        mdbn_replica::mirror_admission::ensure_open(&self.inner)?;
        if tokens.len() > 64 || self.refused_resource_sets.len() >= 64 {
            return Err(StoreError::Full);
        }
        for token in tokens {
            if let Some(original) = self.outstanding.get_mut(&token.0) {
                original.deferred = true;
            }
        }
        let mut set = tokens.iter().map(|o| o.0).collect::<Vec<_>>();
        set.sort_unstable();
        if !self
            .refused_resource_sets
            .iter()
            .any(|(old, _)| old == &set)
        {
            self.refused_resource_sets.push((set, mutation));
        }
        Ok(())
    }
    fn defer_disk_observations(&mut self, tokens: &[ObservationId]) -> StoreResult<()> {
        mdbn_replica::mirror_admission::ensure_open(&self.inner)?;
        if tokens.len() > 65536 {
            return Err(StoreError::Full);
        }
        for token in tokens {
            if let Some(original) = self.outstanding.get_mut(&token.0) {
                original.deferred = true;
            }
        }
        Ok(())
    }
    fn resource_observation_current(&mut self, o: &Observation) -> StoreResult<bool> {
        let timers = self.timers.clone();
        run_ready(&timers, self.resource_current_task(o)).ok_or_else(suspended)?
    }
    fn resource_observation_current_async<'a>(
        &'a mut self,
        o: &'a Observation,
    ) -> mdbn_replica::store::StoreFuture<'a, bool> {
        Box::pin(self.resource_current_task(o))
    }
    fn resource_observation_text(
        &mut self,
        observation: &Observation,
        limit: usize,
    ) -> StoreResult<Option<String>> {
        let timers = self.timers.clone();
        run_ready(&timers, self.resource_text_task(observation, limit)).ok_or_else(suspended)?
    }
    fn resource_observation_text_async<'a>(
        &'a mut self,
        observation: &'a Observation,
        limit: usize,
    ) -> mdbn_replica::store::StoreFuture<'a, Option<String>> {
        Box::pin(self.resource_text_task(observation, limit))
    }
    fn resource_paths_page(
        &self,
        page: mdbn_replica::store::ResourcePathPage<'_>,
    ) -> StoreResult<Vec<String>> {
        self.inner.resource_paths_page(page)
    }
    fn resource_bounded(
        &self,
        path: &str,
        copy_limit: usize,
    ) -> StoreResult<Option<mdbn_replica::store::BoundedResource>> {
        self.inner.resource_bounded(path, copy_limit)
    }
    fn settings(&self) -> StoreResult<Option<FileInclusion>> {
        self.inner.settings()
    }
    fn tombstone(&self, id: &Uuid) -> StoreResult<Option<TombstoneRow>> {
        self.inner.tombstone(id)
    }
    fn tombstones_at(&self, path_key: &str) -> StoreResult<Vec<TombstoneRow>> {
        self.inner.tombstones_at(path_key)
    }
    fn tombstones(&self, page: Page) -> StoreResult<Vec<TombstoneRow>> {
        self.inner.tombstones(page)
    }
    fn alias(&self, path_key: &str) -> StoreResult<Option<Uuid>> {
        self.inner.alias(path_key)
    }
    fn aliases(&self) -> StoreResult<Vec<AliasRow>> {
        self.inner.aliases()
    }
    fn conflicts(&self, of: Option<&Uuid>) -> StoreResult<Vec<ConflictRow>> {
        self.inner.conflicts(of)
    }
    fn conflict_count(&self) -> StoreResult<u64> {
        self.inner.conflict_count()
    }
    fn receipt(&self, mutation: &Uuid) -> StoreResult<Option<ReceiptRow>> {
        self.inner.receipt(mutation)
    }
    fn receipts(&self, after: Option<Uuid>, limit: u32) -> StoreResult<Vec<ReceiptRow>> {
        self.inner.receipts(after, limit)
    }
    fn referrers(&self, target_keys: &[String]) -> StoreResult<Vec<Uuid>> {
        self.inner.referrers(target_keys)
    }
    fn unique_holders(&self, field: &str, value_key: &str) -> StoreResult<Vec<Uuid>> {
        self.inner.unique_holders(field, value_key)
    }
    fn candidates(&self, q: &Candidate, page: Page) -> StoreResult<Vec<RecordRow>> {
        self.inner.candidates(q, page)
    }
    fn query_projection_state(
        &self,
    ) -> StoreResult<Option<mdbn_replica::store_query::QueryProjectionState>> {
        self.inner.query_projection_state()
    }
    fn query_projection_page(
        &self,
        request: &mdbn_replica::store_query::QueryProjectionRequest,
    ) -> StoreResult<mdbn_replica::store_query::QueryProjectionPage> {
        self.inner.query_projection_page(request)
    }
    fn query_index_supported(&self) -> bool {
        self.inner.query_index_supported()
    }
    fn query_index_state(&self) -> StoreResult<Option<mdbn_replica::store_query::QueryIndexState>> {
        self.inner.query_index_state()
    }
    fn query_index_page(
        &self,
        request: &mdbn_replica::store_query::QueryIndexRequest,
    ) -> StoreResult<Option<mdbn_replica::store_query::QueryIndexPage>> {
        self.inner.query_index_page(request)
    }
    fn hydrate_query_at(
        &self,
        ids: &[Uuid],
        head: Head,
        budget: &mut mdbn_replica::store_query::QueryBudget,
    ) -> StoreResult<Vec<RecordRow>> {
        self.inner.hydrate_query_at(ids, head, budget)
    }
    fn query_record_sizes_at(
        &self,
        page: Page,
        head: Head,
    ) -> StoreResult<Vec<mdbn_replica::store_query::QueryRecordSize>> {
        self.inner.query_record_sizes_at(page, head)
    }
    fn tail(&self, after: u64, limit: u32) -> StoreResult<Vec<mdbn_replica::store::TailRow>> {
        self.inner.tail(after, limit)
    }
    fn tail_stats(&self) -> StoreResult<mdbn_replica::store::TailStats> {
        self.inner.tail_stats()
    }
    fn own_retained(&self, after: u64, limit: u32) -> StoreResult<Vec<(u64, PendingRow)>> {
        self.inner.own_retained(after, limit)
    }
    fn pending(&self, after_order: Option<u64>, limit: u32) -> StoreResult<Vec<PendingRow>> {
        self.inner.pending(after_order, limit)
    }
    fn pending_get(&self, mutation: &Uuid) -> StoreResult<Option<PendingRow>> {
        self.inner.pending_get(mutation)
    }
    fn pending_count(&self) -> StoreResult<u64> {
        self.inner.pending_count()
    }
    fn local_receipt(&self, mutation: &Uuid) -> StoreResult<Option<LocalReceipt>> {
        self.inner.local_receipt(mutation)
    }
    fn holds(&self) -> StoreResult<Vec<Hold>> {
        self.inner.holds()
    }
    fn hold(&self, id: &Uuid) -> StoreResult<Option<Hold>> {
        self.inner.hold(id)
    }
    fn meta(&self, key: &str) -> StoreResult<Option<Vec<u8>>> {
        self.ensure_commit_available()?;
        self.inner.meta(key)
    }
    fn transfer(&self, id: &Uuid) -> StoreResult<Option<TransferRow>> {
        self.inner.transfer(id)
    }
    fn transfer_chunk(&self, id: &Uuid, index: u64) -> StoreResult<Option<Vec<u8>>> {
        self.inner.transfer_chunk(id, index)
    }
    fn blob_size(&self, digest: &Hash) -> StoreResult<Option<u64>> {
        self.inner.blob_size(digest)
    }
    fn blob_read(&self, digest: &Hash, offset: u64, len: u64) -> StoreResult<Vec<u8>> {
        self.inner.blob_read(digest, offset, len)
    }

    fn durability_deferred(&self) -> bool {
        self.deferred
    }

    fn defer_durability(&mut self, on: bool) -> StoreResult<()> {
        if !on {
            return self.end_deferral();
        }
        if !self.deferred {
            // Only with a disk database that defers alongside: otherwise an
            // acknowledgement could become durable before its commit.
            if !self.db.defer_sync(true).map_err(db_err)? {
                return Ok(());
            }
            self.deferred = true;
            self.inner.defer_durability(true)?;
        }
        Ok(())
    }

    fn commit(&mut self, tx: Tx) -> StoreResult<CommitReport> {
        if self.cfg.queued_publication {
            self.queue_commit(tx)
        } else {
            self.immediate = true;
            let report = self.start_commit(tx).finish_immediate();
            self.immediate = false;
            report
        }
    }

    fn take_publish_results(&mut self) -> Vec<PublishResult> {
        if self.ensure_commit_available().is_err() {
            return Vec::new();
        }
        self.queued.take_results()
    }

    fn has_files(&self) -> bool {
        true
    }

    /// Snapshot-install staging lives in the inner store: staged rows are
    /// never published to, or observed on, the disk.
    fn stages(&self) -> bool {
        self.inner.stages()
    }

    fn materializes_attachments(&self) -> bool {
        self.attachments_supported()
    }

    fn attachment_source(
        &mut self,
        path: &str,
        size: u64,
    ) -> StoreResult<Option<Box<dyn mdbn_replica::replica::AttachmentSource>>> {
        self.open_source(path, size)
    }

    fn attachment_staged(&mut self, key: &StageKey) -> StoreResult<u64> {
        self.att_staged(key)
    }

    fn attachment_stage(&mut self, key: &StageKey, offset: u64, plain: &[u8]) -> StoreResult<()> {
        mdbn_replica::mirror_admission::ensure_open(&self.inner)?;
        self.end_deferral()?;
        self.att_stage(key, offset, plain)
    }

    fn attachment_stage_read(
        &mut self,
        key: &StageKey,
        offset: u64,
        len: u32,
    ) -> StoreResult<Vec<u8>> {
        self.att_stage_read(key, offset, len)
    }

    fn attachment_unstage(&mut self, key: &StageKey) -> StoreResult<()> {
        mdbn_replica::mirror_admission::ensure_open(&self.inner)?;
        self.end_deferral()?;
        self.att_unstage(key)
    }

    fn attachment_publish(
        &mut self,
        key: &StageKey,
        rev: Hash,
        path: &str,
        expect: RExpect,
    ) -> DiskResult {
        mdbn_replica::mirror_admission::ensure_open(&self.inner)?;
        self.end_deferral()?;
        self.att_publish(key, rev, path, expect)
    }

    fn attachment_remove(&mut self, id: Uuid, path: &str, expect: Hash) -> DiskResult {
        mdbn_replica::mirror_admission::ensure_open(&self.inner)?;
        self.end_deferral()?;
        self.att_remove(id, path, expect)
    }

    fn attachment_move(&mut self, id: Uuid, from: &str, to: &str, expect: Hash) -> DiskResult {
        mdbn_replica::mirror_admission::ensure_open(&self.inner)?;
        self.end_deferral()?;
        self.att_move(id, from, to, expect)
    }

    fn disk_revision(&self, path: &str) -> StoreResult<Option<Hash>> {
        Ok(FileStore::disk_revision(self, path))
    }

    fn disk_paths(&self) -> StoreResult<Vec<(String, Hash)>> {
        Ok(FileStore::disk_paths(self))
    }

    fn observe(&mut self, paths: Option<&[String]>) -> StoreResult<Vec<Observation>> {
        self.start_observe(paths).finish_immediate()
    }
    fn observe_async<'a>(
        &'a mut self,
        paths: Option<&'a [String]>,
    ) -> mdbn_replica::store::StoreFuture<'a, Vec<Observation>> {
        let paths = paths.map(<[String]>::to_vec);
        Box::pin(self.observe_task(paths))
    }
}
