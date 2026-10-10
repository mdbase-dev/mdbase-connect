//! `MemStore`: the in-memory reference [`Store`].
//!
//! It is the executable statement of the `Store` rules: the conformance suite
//! ([`crate::conformance`]) passes against it, and other stores are expected to
//! agree with it. Every index is a `BTreeMap`, so every operation the replica uses
//! on a hot path (submit, confirm, point lookups) is O(log n).
//!
//! The data lives behind `Rc<RefCell<..>>` so tests and the simulator can drop a
//! replica ("crash") and reopen the same durable state with [`MemStore::shared`].
//! A commit is atomic: it is validated first and applied without failure points.
//! [`MemStore::fail_commits`] injects store failures.

use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet};
use std::ops::Range;
use std::rc::Rc;

use mdbn_wire::client::Hold;
use mdbn_wire::common::{Hash, Uuid};
use mdbn_wire::intent::FileInclusion;

use crate::store::{
    AliasRow, BoundedResource, Candidate, CommitReport, ConflictRow, FileRow, Head, LocalReceipt,
    Page, PendingRow, RESOURCE_PATH_BYTES, RESOURCE_SOURCE_BYTES, ReceiptRow, RecordRow,
    ResourcePathPage, Seq, Store, StoreError, StoreResult, TailRow, TailStats, TombstoneRow,
    TransferRow, Tx,
};

mod query_source;

const ID_MIN: Uuid = mdbn_wire::common::B16([0; 16]);
const ID_MAX: Uuid = mdbn_wire::common::B16([0xff; 16]);

/// The durable contents of a [`MemStore`].
#[derive(Debug, Clone)]
pub struct MemData {
    head: Head,
    records: BTreeMap<Uuid, RecordRow>,
    record_paths: BTreeMap<String, Uuid>,
    record_buckets: BTreeSet<(u32, Uuid)>,
    links: BTreeMap<String, BTreeSet<Uuid>>,
    unique: BTreeMap<(String, String), BTreeSet<Uuid>>,
    files: BTreeMap<Uuid, FileRow>,
    file_paths: BTreeMap<String, Uuid>,
    file_buckets: BTreeSet<(u32, Uuid)>,
    resources: BTreeMap<String, String>,
    settings: Option<FileInclusion>,
    tombstones: BTreeMap<Uuid, TombstoneRow>,
    tombstone_paths: BTreeSet<(String, Uuid)>,
    tombstone_seqs: BTreeSet<(u64, Uuid)>,
    aliases: BTreeMap<String, AliasRow>,
    conflicts: BTreeMap<(Uuid, Uuid), ConflictRow>,
    receipts: BTreeMap<Uuid, ReceiptRow>,
    receipt_seqs: BTreeSet<(u64, Uuid)>,
    pending: BTreeMap<u64, PendingRow>,
    pending_ids: BTreeMap<Uuid, u64>,
    local_receipts: BTreeMap<Uuid, LocalReceipt>,
    holds: BTreeMap<Uuid, Hold>,
    meta: BTreeMap<String, Vec<u8>>,
    transfers: BTreeMap<Uuid, TransferRow>,
    chunks: BTreeMap<(Uuid, u64), Vec<u8>>,
    blobs: BTreeMap<Hash, Vec<u8>>,
    /// The staging area ([`crate::store::Stage`]).
    staging: Option<Box<MemData>>,
    /// Report no staging area.
    no_staging: bool,
    /// Declares [`crate::store::KeyringPersistence::RebuildOnOpen`] (tests).
    rebuild_keyring: bool,
    /// Commits that carried the keyring meta row (tests).
    pub keyring_writes: u64,
    /// A deferred-durability window is open ([`Store::defer_durability`];
    /// memory has nothing to defer, tests check who opens and closes them).
    pub deferred: bool,
    /// Deferred-durability windows opened and closed (tests).
    pub windows: (u64, u64),
    tail: BTreeMap<u64, TailRow>,
    tail_bytes: u64,
    own_retained: BTreeMap<u64, PendingRow>,
    /// Number of successful commits.
    pub commits: u64,
    /// Fail this many upcoming commits with strongly guaranteed `CommitAborted`.
    pub fail_next: u32,
    /// Fail before applying, but give callers NO typed durability guarantee.
    pub fail_unknown_commits: u32,
    /// Report an I/O error after fully applying this many transactions.
    pub fail_after_commit: u32,
    /// Report an I/O error after the transaction installing this head commits.
    pub fail_after_head_commit: Option<Seq>,
    /// Fail the transaction installing this head before applying it, with NO
    /// durability guarantee (an unknown outcome at exactly that commit).
    pub fail_unknown_head_commit: Option<Seq>,
    /// Fail this many head reads, to test unknown durable commit outcomes.
    pub fail_head_reads: u32,
    /// Test-only resource read faults, never missing rows or commit outcomes.
    #[cfg(any(test, feature = "testing"))]
    pub fail_resource_reads: u32,
    /// Inventory tests refuse legacy whole-source/whole-inventory reads.
    #[cfg(test)]
    pub refuse_unbounded_resources: bool,
    /// Inventory tests inject a path-page failure.
    #[cfg(test)]
    pub fail_resource_path_reads: u32,
    /// Inventory tests observe source projection limits before copying.
    #[cfg(test)]
    pub resource_copy_limits: Vec<usize>,
    /// Tests: an in-memory disk that materializes attachment-v1 files.
    #[cfg(test)]
    pub att_disk: Option<AttDisk>,
    /// Test-only retention accounting read faults (never a commit outcome).
    #[cfg(any(test, feature = "testing"))]
    pub fail_tail_stats: u32,
    /// Deliberately mislabel a read fault to exercise the engine's downgrade.
    #[cfg(any(test, feature = "testing"))]
    pub tail_stats_abort_label: bool,
    /// PRIVATE PROBE: a query-index READ must never certify a strong abort.
    #[cfg(any(test, feature = "testing"))]
    pub query_read_abort_probe: bool,
}

impl Default for MemData {
    fn default() -> MemData {
        MemData {
            head: Head::GENESIS,
            records: BTreeMap::new(),
            record_paths: BTreeMap::new(),
            record_buckets: BTreeSet::new(),
            links: BTreeMap::new(),
            unique: BTreeMap::new(),
            files: BTreeMap::new(),
            file_paths: BTreeMap::new(),
            file_buckets: BTreeSet::new(),
            resources: BTreeMap::new(),
            staging: None,
            no_staging: false,
            rebuild_keyring: false,
            keyring_writes: 0,
            deferred: false,
            windows: (0, 0),
            settings: None,
            tombstones: BTreeMap::new(),
            tombstone_paths: BTreeSet::new(),
            tombstone_seqs: BTreeSet::new(),
            aliases: BTreeMap::new(),
            conflicts: BTreeMap::new(),
            receipts: BTreeMap::new(),
            receipt_seqs: BTreeSet::new(),
            pending: BTreeMap::new(),
            pending_ids: BTreeMap::new(),
            local_receipts: BTreeMap::new(),
            holds: BTreeMap::new(),
            meta: BTreeMap::new(),
            transfers: BTreeMap::new(),
            chunks: BTreeMap::new(),
            blobs: BTreeMap::new(),
            tail: BTreeMap::new(),
            tail_bytes: 0,
            own_retained: BTreeMap::new(),
            commits: 0,
            fail_next: 0,
            fail_unknown_commits: 0,
            fail_after_commit: 0,
            fail_after_head_commit: None,
            fail_unknown_head_commit: None,
            fail_head_reads: 0,
            #[cfg(any(test, feature = "testing"))]
            fail_resource_reads: 0,
            #[cfg(test)]
            refuse_unbounded_resources: false,
            #[cfg(test)]
            fail_resource_path_reads: 0,
            #[cfg(test)]
            resource_copy_limits: Vec::new(),
            #[cfg(any(test, feature = "testing"))]
            fail_tail_stats: 0,
            #[cfg(any(test, feature = "testing"))]
            tail_stats_abort_label: false,
            #[cfg(any(test, feature = "testing"))]
            query_read_abort_probe: false,
            #[cfg(test)]
            att_disk: None,
        }
    }
}

impl MemData {
    fn del_record(&mut self, id: &Uuid) {
        if let Some(r) = self.records.remove(id) {
            if self.record_paths.get(&r.path_key) == Some(id) {
                self.record_paths.remove(&r.path_key);
            }
            self.record_buckets.remove(&(u32::from(r.bucket), *id));
            for k in &r.meta.links {
                if let Some(s) = self.links.get_mut(k) {
                    s.remove(id);
                    if s.is_empty() {
                        self.links.remove(k);
                    }
                }
            }
            for (f, v) in &r.meta.unique {
                let key = (f.clone(), v.clone());
                if let Some(s) = self.unique.get_mut(&key) {
                    s.remove(id);
                    if s.is_empty() {
                        self.unique.remove(&key);
                    }
                }
            }
        }
    }

    fn put_record(&mut self, r: RecordRow) {
        let id = r.id;
        self.del_record(&id);
        self.record_paths.insert(r.path_key.clone(), id);
        self.record_buckets.insert((u32::from(r.bucket), id));
        for k in &r.meta.links {
            self.links.entry(k.clone()).or_default().insert(id);
        }
        for (f, v) in &r.meta.unique {
            self.unique
                .entry((f.clone(), v.clone()))
                .or_default()
                .insert(id);
        }
        self.records.insert(id, r);
    }

    fn del_file(&mut self, id: &Uuid) {
        if let Some(f) = self.files.remove(id) {
            if self.file_paths.get(&f.path_key) == Some(id) {
                self.file_paths.remove(&f.path_key);
            }
            self.file_buckets.remove(&(u32::from(f.bucket), *id));
        }
    }

    fn put_file(&mut self, f: FileRow) {
        let id = f.id;
        self.del_file(&id);
        self.file_paths.insert(f.path_key.clone(), id);
        self.file_buckets.insert((u32::from(f.bucket), id));
        self.files.insert(id, f);
    }

    fn del_tombstone(&mut self, id: &Uuid) {
        if let Some(t) = self.tombstones.remove(id) {
            self.tombstone_paths.remove(&(t.path_key.clone(), *id));
            self.tombstone_seqs.remove(&(t.seq, *id));
        }
    }

    fn put_tombstone(&mut self, t: TombstoneRow) {
        self.del_tombstone(&t.id);
        self.tombstone_paths.insert((t.path_key.clone(), t.id));
        self.tombstone_seqs.insert((t.seq, t.id));
        self.tombstones.insert(t.id, t);
    }

    fn put_receipt(&mut self, r: ReceiptRow) {
        if let Some(old) = self.receipts.insert(r.mutation, r) {
            self.receipt_seqs.remove(&(old.seq, old.mutation));
        }
        self.receipt_seqs.insert((r.seq, r.mutation));
    }

    fn del_pending(&mut self, id: &Uuid) {
        if let Some(order) = self.pending_ids.remove(id) {
            self.pending.remove(&order);
        }
    }

    /// Replace the tail by `keep` (the rows at or above a pruning floor).
    fn drop_tail_rows(&mut self, keep: BTreeMap<u64, TailRow>) {
        let dropped: u64 = self.tail.values().map(|r| r.item.len() as u64).sum();
        self.tail_bytes -= dropped;
        self.tail = keep;
    }

    fn clear_confirmed(&mut self) {
        self.records.clear();
        self.record_paths.clear();
        self.record_buckets.clear();
        self.links.clear();
        self.unique.clear();
        self.files.clear();
        self.file_paths.clear();
        self.file_buckets.clear();
        self.resources.clear();
        self.settings = None;
        self.tombstones.clear();
        self.tombstone_paths.clear();
        self.tombstone_seqs.clear();
        self.aliases.clear();
        self.conflicts.clear();
        self.receipts.clear();
        self.receipt_seqs.clear();
    }

    /// Apply with staging ([`crate::store::Stage`]).
    fn apply_staged(&mut self, mut tx: Tx) {
        use crate::store::Stage;
        match std::mem::take(&mut tx.stage) {
            Stage::None => self.apply(tx),
            Stage::Put => {
                let rows = tx.take_confirmed_rows();
                self.staging.get_or_insert_default().apply(rows);
                self.apply(tx);
            }
            Stage::Swap => {
                let s = *self.staging.take().unwrap_or_default();
                self.take_confirmed_from(s);
                self.apply(tx);
            }
            Stage::Discard => {
                self.staging = None;
                self.apply(tx);
            }
        }
    }

    /// Replace confirmed state with `s`'s.
    fn take_confirmed_from(&mut self, s: MemData) {
        self.records = s.records;
        self.record_paths = s.record_paths;
        self.record_buckets = s.record_buckets;
        self.links = s.links;
        self.unique = s.unique;
        self.files = s.files;
        self.file_paths = s.file_paths;
        self.file_buckets = s.file_buckets;
        self.resources = s.resources;
        self.settings = s.settings;
        self.tombstones = s.tombstones;
        self.tombstone_paths = s.tombstone_paths;
        self.tombstone_seqs = s.tombstone_seqs;
        self.aliases = s.aliases;
        self.conflicts = s.conflicts;
        self.receipts = s.receipts;
        self.receipt_seqs = s.receipt_seqs;
    }

    fn apply(&mut self, tx: Tx) {
        if tx.clear_confirmed {
            self.clear_confirmed();
        }
        if let Some(h) = tx.head {
            self.head = h;
        }
        // Removals first, so a record moved into a path freed in the same tx wins.
        for id in &tx.records_del {
            self.del_record(id);
        }
        for r in tx.records_put {
            self.put_record(r);
        }
        for id in &tx.files_del {
            self.del_file(id);
        }
        for f in tx.files_put {
            self.put_file(f);
        }
        for p in &tx.resources_del {
            self.resources.remove(p);
        }
        for (p, d) in tx.resources_put {
            self.resources.insert(p, d);
        }
        if let Some(s) = tx.settings {
            self.settings = Some(s);
        }
        for id in &tx.tombstones_del {
            self.del_tombstone(id);
        }
        for t in tx.tombstones_put {
            self.put_tombstone(t);
        }
        for a in tx.aliases_put {
            self.aliases.insert(a.path_key.clone(), a);
        }
        for (m, id) in &tx.conflicts_del {
            self.conflicts.remove(&(*m, *id));
        }
        for c in tx.conflicts_put {
            self.conflicts.insert((c.mutation, c.conflict.id), c);
        }
        for r in tx.receipts_put {
            self.put_receipt(r);
        }
        if let Some(p) = tx.prune {
            let old: Vec<(u64, Uuid)> = self
                .receipt_seqs
                .range(..(p.seq_floor, ID_MIN))
                .copied()
                .collect();
            for (seq, id) in old {
                if self
                    .receipts
                    .get(&id)
                    .is_some_and(|r| r.time < p.time_floor)
                {
                    self.receipts.remove(&id);
                    self.receipt_seqs.remove(&(seq, id));
                }
            }
            let old: Vec<(u64, Uuid)> = self
                .tombstone_seqs
                .range(..(p.seq_floor, ID_MIN))
                .copied()
                .collect();
            for (_, id) in old {
                if self
                    .tombstones
                    .get(&id)
                    .is_some_and(|t| t.time < p.time_floor)
                {
                    self.del_tombstone(&id);
                }
            }
        }
        for id in &tx.pending_del {
            self.del_pending(id);
        }
        for p in tx.pending_put {
            let id = p.mutation.id;
            self.del_pending(&id);
            if let Some(old) = self.pending.remove(&p.order) {
                self.pending_ids.remove(&old.mutation.id);
            }
            self.pending_ids.insert(id, p.order);
            self.pending.insert(p.order, p);
        }
        for r in tx.local_receipts_put {
            self.local_receipts.insert(r.mutation, r);
        }
        if let Some(t) = tx.local_receipts_prune {
            self.local_receipts.retain(|_, r| r.resolved_at >= t);
        }
        for id in &tx.holds_del {
            self.holds.remove(id);
        }
        for h in tx.holds_put {
            self.holds.insert(h.id, h);
        }
        for (k, v) in tx.meta {
            match v {
                Some(v) => {
                    self.meta.insert(k, v);
                }
                None => {
                    self.meta.remove(&k);
                }
            }
        }
        for t in tx.transfers_put {
            self.transfers.insert(t.id, t);
        }
        for (id, i, b) in tx.transfer_chunks {
            self.chunks.insert((id, i), b);
        }
        for id in &tx.transfers_del {
            self.transfers.remove(id);
            let keys: Vec<(Uuid, u64)> = self
                .chunks
                .range((*id, 0)..=(*id, u64::MAX))
                .map(|(k, _)| *k)
                .collect();
            for k in keys {
                self.chunks.remove(&k);
            }
        }
        for (d, off, bytes) in tx.blob_parts {
            let b = self.blobs.entry(d).or_default();
            let off = usize::try_from(off).unwrap_or(usize::MAX);
            let end = off.saturating_add(bytes.len());
            if b.len() < end {
                b.resize(end, 0);
            }
            b[off..end].copy_from_slice(&bytes);
        }
        for d in &tx.blobs_del {
            self.blobs.remove(d);
        }
        if let Some(n) = tx.tail_drop_below {
            let keep = self.tail.split_off(&n);
            self.drop_tail_rows(keep);
        }
        if let Some(n) = tx.tail_drop_above {
            if n == 0 {
                self.tail.clear();
                self.tail_bytes = 0;
            } else if let Some(first_dropped) = n.checked_add(1) {
                let dropped = self.tail.split_off(&first_dropped);
                self.tail_bytes -= dropped.values().map(|r| r.item.len() as u64).sum::<u64>();
            }
        }
        for r in tx.tail_put {
            self.tail_bytes += r.item.len() as u64;
            if let Some(old) = self.tail.insert(r.seq, r) {
                self.tail_bytes -= old.item.len() as u64;
            }
        }
        if let Some(n) = tx.own_retained_drop_below {
            self.own_retained = self.own_retained.split_off(&n);
        }
        if let Some(n) = tx.own_retained_drop_above {
            if n == 0 {
                self.own_retained.clear();
            } else if let Some(first_dropped) = n.checked_add(1) {
                self.own_retained.split_off(&first_dropped);
            }
        }
        for (seq, row) in tx.own_retained_put {
            self.own_retained.insert(seq, row);
        }
        self.commits += 1;
    }
}

/// The in-memory store.
#[derive(Debug, Clone, Default)]
pub struct MemStore {
    data: Rc<RefCell<MemData>>,
}

impl MemStore {
    /// An empty store.
    pub fn new() -> MemStore {
        MemStore::default()
    }

    /// A store over shared data: reopen after a simulated crash.
    pub fn shared(data: Rc<RefCell<MemData>>) -> MemStore {
        MemStore { data }
    }

    /// The shared data, to reopen later.
    pub fn data(&self) -> Rc<RefCell<MemData>> {
        self.data.clone()
    }

    /// Fail the next `n` commits with a guaranteed durable, unchanged prior state.
    pub fn fail_commits(&self, n: u32) {
        self.data.borrow_mut().fail_next = n;
    }

    /// Behave as a store without a staging area ([`Store::stages`] false).
    pub fn without_staging(self) -> MemStore {
        self.data.borrow_mut().no_staging = true;
        self
    }

    /// Declare [`crate::store::KeyringPersistence::RebuildOnOpen`]: the replica
    /// must never hand this store its keyring.
    pub fn with_keyring_rebuild(self) -> MemStore {
        self.data.borrow_mut().rebuild_keyring = true;
        self
    }

    /// Records and files in the staging area (tests).
    pub fn staged_rows(&self) -> usize {
        self.data
            .borrow()
            .staging
            .as_ref()
            .map_or(0, |s| s.records.len() + s.files.len())
    }

    /// Exact staged entity/alias inventory for row-admission unit tests.
    #[cfg(test)]
    pub(crate) fn staged_inventory(&self) -> Option<(usize, usize, usize, usize)> {
        self.data.borrow().staging.as_ref().map(|s| {
            (
                s.records.len(),
                s.files.len(),
                s.tombstones.len(),
                s.aliases.len(),
            )
        })
    }

    /// Fail before the next `n` transactions, reporting an UNKNOWN outcome even
    /// though this fake's logical head/meta still look unchanged.
    pub fn fail_unknown_commits(&self, n: u32) {
        self.data.borrow_mut().fail_unknown_commits = n;
    }

    /// Report an I/O error after the next `n` transactions have fully committed.
    pub fn fail_after_commit(&self, n: u32) {
        self.data.borrow_mut().fail_after_commit = n;
    }

    /// Fail after fully committing the transaction installing exactly this head.
    pub fn fail_after_head_commit(&self, seq: Seq) {
        self.data.borrow_mut().fail_after_head_commit = Some(seq);
    }

    /// Fail exactly the transaction that would install this head, before applying
    /// it, reporting an unknown outcome.
    pub fn fail_unknown_head_commit(&self, seq: Seq) {
        self.data.borrow_mut().fail_unknown_head_commit = Some(seq);
    }

    /// Fail the next `n` head reads with an I/O error.
    pub fn fail_head_reads(&self, n: u32) {
        self.data.borrow_mut().fail_head_reads = n;
    }

    /// Test-only: fail accounting reads; `abort_label` deliberately violates the
    /// read contract to prove it cannot certify a safe commit retry.
    #[cfg(any(test, feature = "testing"))]
    pub fn fail_tail_stats(&self, n: u32, abort_label: bool) {
        let mut d = self.data.borrow_mut();
        d.fail_tail_stats = n;
        d.tail_stats_abort_label = abort_label;
    }
}

fn after_range<T>(
    m: &BTreeMap<Uuid, T>,
    p: Page,
) -> std::collections::btree_map::Range<'_, Uuid, T> {
    use std::ops::Bound;
    match p.after {
        Some(a) => m.range((Bound::Excluded(a), Bound::Unbounded)),
        None => m.range(..),
    }
}

/// Does a record possibly satisfy a candidate? Exact for types and folders, and for
/// `Compare` with `Pruning::Exact` and `==`/`!=` on scalar fields; conservative
/// (true) for everything else.
pub fn candidate_matches(c: &Candidate, r: &RecordRow) -> bool {
    use mdbn_core::query::{CompareOp, FieldRef, Pruning};
    match c {
        Candidate::All => true,
        Candidate::None => false,
        Candidate::And(cs) => cs.iter().all(|c| candidate_matches(c, r)),
        Candidate::Or(cs) => cs.iter().any(|c| candidate_matches(c, r)),
        Candidate::Not(inner) => match exact(inner, r) {
            Some(b) => !b,
            None => true,
        },
        Candidate::HasType(t) => r.meta.types.iter().any(|x| x.eq_ignore_ascii_case(t)),
        Candidate::InFolder(f) => in_folder(&r.path, f),
        // Outgoing link keys are stored as `l:` + key (`plan::LINK_PREFIX`).
        Candidate::LinksTo(keys) => keys.iter().any(|k| {
            r.meta
                .links
                .contains(&format!("{}{}", crate::plan::LINK_PREFIX, k.0))
        }),
        // Necessary only; the residual decides.
        Candidate::BodyContains { .. } => true,
        Candidate::Compare {
            field,
            op,
            value,
            pruning,
        } => {
            let (FieldRef::Persisted(path), Pruning::Exact, CompareOp::Eq | CompareOp::Ne) =
                (field, pruning, op)
            else {
                return true;
            };
            let [key] = path.as_slice() else {
                return true;
            };
            let have = r.meta.effective.get(key).map(crate::convert::value);
            let eq = matches!(have, Some(Ok(v)) if v == *value);
            if *op == CompareOp::Eq { eq } else { !eq }
        }
    }
}

fn exact(c: &Candidate, r: &RecordRow) -> Option<bool> {
    match c {
        Candidate::All => Some(true),
        Candidate::None => Some(false),
        Candidate::HasType(_) | Candidate::InFolder(_) => Some(candidate_matches(c, r)),
        _ => None,
    }
}

fn in_folder(path: &str, folder: &str) -> bool {
    let f = folder.trim_end_matches('/');
    f.is_empty()
        || path
            .strip_prefix(f)
            .is_some_and(|rest| rest.starts_with('/'))
}

/// Tests: a toy disk for attachment-v1 files, with staging and the
/// never-clobber checks of [`Store::attachment_publish`].
#[cfg(test)]
#[derive(Debug, Clone, Default)]
pub struct AttDisk {
    /// User-visible files.
    pub files: BTreeMap<String, Vec<u8>>,
    /// What the store knows each path holds (ours or observed).
    pub known: BTreeMap<String, Hash>,
    /// Staging by key.
    pub staging: BTreeMap<crate::store::StageKey, Vec<u8>>,
    /// Largest single staging write.
    pub max_stage_write: usize,
    /// Operations performed: `publish`, `remove`, `move`.
    pub ops: Vec<String>,
    /// Fail the next staging write (a crash mid-fetch).
    pub fail_stage: bool,
    /// Observations queued for the next `observe` (T6 ingest).
    pub queued: Vec<crate::store::Observation>,
    /// Observations handed out and not acknowledged: token -> (path, what to
    /// record as known on acknowledgement, the moved-from path).
    pub outstanding: BTreeMap<u64, (String, Option<Hash>, Option<String>)>,
    /// Observations acknowledged.
    pub acked: Vec<u64>,
    next_token: u64,
    /// Sources opened.
    pub sources_opened: u64,
    /// The largest single source read.
    pub max_source_read: usize,
}

#[cfg(test)]
impl AttDisk {
    fn observe(&mut self, path: &str, moved_from: Option<&str>) {
        self.next_token += 1;
        let base = self.known.get(moved_from.unwrap_or(path)).copied();
        let now = self
            .files
            .get(path)
            .map(|b| crate::store::Observed::Attachment {
                digest: mdbn_wire::hash::sha256(b),
                size: b.len() as u64,
                class: crate::store::AttachmentClass::Ordinary,
            });
        let after = self.files.get(path).map(|b| mdbn_wire::hash::sha256(b));
        self.outstanding.insert(
            self.next_token,
            (path.to_owned(), after, moved_from.map(str::to_owned)),
        );
        self.queued.push(crate::store::Observation {
            token: crate::store::ObservationId(self.next_token),
            path: path.into(),
            base,
            now,
            moved_from: moved_from.map(str::to_owned),
            provenance: crate::store::Provenance::Normal,
        });
    }

    /// A user writes `bytes` at `path` (create or edit): queue the observation.
    pub fn user_write(&mut self, path: &str, bytes: &[u8]) {
        self.files.insert(path.into(), bytes.to_vec());
        self.observe(path, None);
    }

    /// A user removes `path`.
    pub fn user_remove(&mut self, path: &str) {
        self.files.remove(path);
        self.observe(path, None);
    }

    /// A user renames `from` to `to`; the store pairs it as a move.
    pub fn user_move(&mut self, from: &str, to: &str) {
        if let Some(b) = self.files.remove(from) {
            self.files.insert(to.into(), b);
        }
        self.observe(to, Some(from));
    }

    /// Forget unacknowledged observations (a restart); return their paths.
    pub fn restart(&mut self) -> Vec<String> {
        self.queued.clear();
        std::mem::take(&mut self.outstanding)
            .into_values()
            .map(|(p, _, _)| p)
            .collect()
    }

    /// Re-observe `path` as a full scan after a restart would.
    pub fn rescan(&mut self, path: &str) {
        self.observe(path, None);
    }

    fn ack(&mut self, token: u64) {
        let Some((path, after, from)) = self.outstanding.remove(&token) else {
            return;
        };
        self.acked.push(token);
        if let Some(f) = from {
            self.known.remove(&f);
        }
        match after {
            Some(h) => self.known.insert(path, h),
            None => self.known.remove(&path),
        };
    }

    fn holds(&self, path: &str, rev: Hash) -> Option<&'static str> {
        match self.files.get(path) {
            None => Some("missing"),
            Some(b) if mdbn_wire::hash::sha256(b) == rev => None,
            Some(_) => Some("changed"),
        }
    }
}

/// Tests: a source over the toy disk that refuses a changed file.
#[cfg(test)]
struct MemSource {
    data: Rc<RefCell<MemData>>,
    path: String,
    bytes: Vec<u8>,
}

#[cfg(test)]
impl crate::replica::AttachmentSource for MemSource {
    fn len(&self) -> u64 {
        self.bytes.len() as u64
    }
    fn read_at(&mut self, offset: u64, buf: &mut [u8]) -> Result<(), String> {
        let mut d = self.data.borrow_mut();
        let a = d.att_disk.as_mut().ok_or("no disk")?;
        if a.files.get(&self.path) != Some(&self.bytes) {
            return Err("the file changed".into());
        }
        a.max_source_read = a.max_source_read.max(buf.len());
        let start = usize::try_from(offset).map_err(|_| "offset")?;
        let src = self
            .bytes
            .get(start..start + buf.len())
            .ok_or("past the end")?;
        buf.copy_from_slice(src);
        Ok(())
    }
}

#[cfg(test)]
impl MemStore {
    /// Materialize attachment-v1 files on a toy disk.
    pub fn with_attachment_disk(self) -> MemStore {
        self.data.borrow_mut().att_disk = Some(AttDisk::default());
        self
    }

    /// The toy disk (panics without one).
    pub fn att_disk(&self) -> std::cell::RefMut<'_, AttDisk> {
        std::cell::RefMut::map(self.data.borrow_mut(), |d| {
            d.att_disk.as_mut().expect("attachment disk")
        })
    }
}

impl Store for MemStore {
    fn query_record_sizes_at(
        &self,
        page: Page,
        head: Head,
    ) -> StoreResult<Vec<crate::store_query::QueryRecordSize>> {
        query_source::sizes(self, page, head)
    }
    fn hydrate_query_at(
        &self,
        ids: &[Uuid],
        head: Head,
        budget: &mut crate::store_query::QueryBudget,
    ) -> StoreResult<Vec<RecordRow>> {
        query_source::hydrate(self, ids, head, budget)
    }
    #[cfg(test)]
    fn observe(
        &mut self,
        _paths: Option<&[String]>,
    ) -> StoreResult<Vec<crate::store::Observation>> {
        let mut d = self.data.borrow_mut();
        Ok(d.att_disk
            .as_mut()
            .map(|a| std::mem::take(&mut a.queued))
            .unwrap_or_default())
    }
    #[cfg(test)]
    fn attachment_source(
        &mut self,
        path: &str,
        size: u64,
    ) -> StoreResult<Option<Box<dyn crate::replica::AttachmentSource>>> {
        let mut d = self.att_disk();
        let Some(b) = d.files.get(path).cloned() else {
            return Ok(None);
        };
        if b.len() as u64 != size {
            return Ok(None);
        }
        d.sources_opened += 1;
        Ok(Some(Box::new(MemSource {
            data: self.data.clone(),
            path: path.into(),
            bytes: b,
        })))
    }
    #[cfg(test)]
    fn materializes_attachments(&self) -> bool {
        self.data.borrow().att_disk.is_some()
    }
    #[cfg(test)]
    fn disk_revision(&self, path: &str) -> StoreResult<Option<Hash>> {
        Ok(self
            .data
            .borrow()
            .att_disk
            .as_ref()
            .and_then(|d| d.known.get(path).copied()))
    }
    #[cfg(test)]
    fn attachment_staged(&mut self, key: &crate::store::StageKey) -> StoreResult<u64> {
        Ok(self
            .att_disk()
            .staging
            .get(key)
            .map_or(0, |b| b.len() as u64))
    }
    #[cfg(test)]
    fn attachment_stage(
        &mut self,
        key: &crate::store::StageKey,
        offset: u64,
        plain: &[u8],
    ) -> StoreResult<()> {
        let mut d = self.att_disk();
        if d.fail_stage {
            d.fail_stage = false;
            return Err(StoreError::Io("disk full".into()));
        }
        d.max_stage_write = d.max_stage_write.max(plain.len());
        let b = d.staging.entry(*key).or_default();
        if offset == 0 {
            b.clear();
        }
        if b.len() as u64 != offset {
            return Err(StoreError::Io("not contiguous".into()));
        }
        b.extend_from_slice(plain);
        Ok(())
    }
    #[cfg(test)]
    fn attachment_stage_read(
        &mut self,
        key: &crate::store::StageKey,
        offset: u64,
        len: u32,
    ) -> StoreResult<Vec<u8>> {
        let d = self.att_disk();
        let b = d.staging.get(key).cloned().unwrap_or_default();
        let start = (offset as usize).min(b.len());
        let end = (start + len as usize).min(b.len());
        Ok(b[start..end].to_vec())
    }
    #[cfg(test)]
    fn attachment_unstage(&mut self, key: &crate::store::StageKey) -> StoreResult<()> {
        self.att_disk().staging.remove(key);
        Ok(())
    }
    #[cfg(test)]
    fn attachment_publish(
        &mut self,
        key: &crate::store::StageKey,
        rev: Hash,
        path: &str,
        expect: crate::store::Expect,
    ) -> crate::store::DiskResult {
        let mut d = self.att_disk();
        let drift = match expect {
            crate::store::Expect::Absent => d.files.contains_key(path).then_some("changed"),
            crate::store::Expect::Revision(r) => d.holds(path, r),
        };
        if let Some(r) = drift {
            return Ok(Some(r.into()));
        }
        let b = d
            .staging
            .remove(key)
            .ok_or_else(|| StoreError::Io("nothing staged".into()))?;
        d.files.insert(path.into(), b);
        d.known.insert(path.into(), rev);
        d.ops.push(format!("publish {path}"));
        Ok(None)
    }
    #[cfg(test)]
    fn attachment_remove(
        &mut self,
        _id: Uuid,
        path: &str,
        expect: Hash,
    ) -> crate::store::DiskResult {
        let mut d = self.att_disk();
        if let Some(r) = d.holds(path, expect) {
            return Ok(Some(r.into()));
        }
        d.files.remove(path);
        d.known.remove(path);
        d.ops.push(format!("remove {path}"));
        Ok(None)
    }
    #[cfg(test)]
    fn attachment_move(
        &mut self,
        _id: Uuid,
        from: &str,
        to: &str,
        expect: Hash,
    ) -> crate::store::DiskResult {
        let mut d = self.att_disk();
        if let Some(r) = d.holds(from, expect) {
            return Ok(Some(r.into()));
        }
        if d.files.contains_key(to) {
            return Ok(Some("changed".into()));
        }
        let b = d.files.remove(from).unwrap_or_default();
        d.known.remove(from);
        d.files.insert(to.into(), b);
        d.known.insert(to.into(), expect);
        d.ops.push(format!("move {from} {to}"));
        Ok(None)
    }

    fn head(&self) -> StoreResult<Head> {
        let mut d = self.data.borrow_mut();
        if d.fail_head_reads > 0 {
            d.fail_head_reads -= 1;
            return Err(StoreError::Io("injected head-read failure".into()));
        }
        Ok(d.head)
    }
    fn record(&self, id: &Uuid) -> StoreResult<Option<RecordRow>> {
        Ok(self.data.borrow().records.get(id).cloned())
    }
    fn record_at(&self, path_key: &str) -> StoreResult<Option<Uuid>> {
        Ok(self.data.borrow().record_paths.get(path_key).copied())
    }
    fn records(&self, p: Page) -> StoreResult<Vec<RecordRow>> {
        let d = self.data.borrow();
        Ok(after_range(&d.records, p)
            .take(p.limit as usize)
            .map(|(_, r)| r.clone())
            .collect())
    }
    fn records_in_buckets(&self, range: Range<u32>, p: Page) -> StoreResult<Vec<RecordRow>> {
        let d = self.data.borrow();
        let mut ids: Vec<Uuid> = d
            .record_buckets
            .range((range.start, ID_MIN)..(range.end, ID_MIN))
            .map(|(_, id)| *id)
            .collect();
        ids.sort();
        Ok(ids
            .iter()
            .filter(|id| p.after.is_none_or(|a| **id > a))
            .take(p.limit as usize)
            .filter_map(|id| d.records.get(id).cloned())
            .collect())
    }
    fn record_count(&self) -> StoreResult<u64> {
        Ok(self.data.borrow().records.len() as u64)
    }
    fn file(&self, id: &Uuid) -> StoreResult<Option<FileRow>> {
        Ok(self.data.borrow().files.get(id).cloned())
    }
    fn file_at(&self, path_key: &str) -> StoreResult<Option<Uuid>> {
        Ok(self.data.borrow().file_paths.get(path_key).copied())
    }
    fn files(&self, p: Page) -> StoreResult<Vec<FileRow>> {
        let d = self.data.borrow();
        Ok(after_range(&d.files, p)
            .take(p.limit as usize)
            .map(|(_, r)| r.clone())
            .collect())
    }
    fn files_in_buckets(&self, range: Range<u32>, p: Page) -> StoreResult<Vec<FileRow>> {
        let d = self.data.borrow();
        let mut ids: Vec<Uuid> = d
            .file_buckets
            .range((range.start, ID_MIN)..(range.end, ID_MIN))
            .map(|(_, id)| *id)
            .collect();
        ids.sort();
        Ok(ids
            .iter()
            .filter(|id| p.after.is_none_or(|a| **id > a))
            .take(p.limit as usize)
            .filter_map(|id| d.files.get(id).cloned())
            .collect())
    }
    fn resource(&self, path: &str) -> StoreResult<Option<String>> {
        #[cfg(test)]
        if self.data.borrow().refuse_unbounded_resources {
            return Err(StoreError::Io("unbounded resource read refused".into()));
        }
        #[cfg(any(test, feature = "testing"))]
        {
            let mut data = self.data.borrow_mut();
            if data.fail_resource_reads > 0 {
                data.fail_resource_reads -= 1;
                return Err(StoreError::Io("injected resource read fault".into()));
            }
        }
        Ok(self.data.borrow().resources.get(path).cloned())
    }
    fn resource_paths_page(&self, page: ResourcePathPage<'_>) -> StoreResult<Vec<String>> {
        use std::ops::Bound::{Excluded, Included, Unbounded};
        page.validate()?;
        #[cfg(test)]
        {
            let mut data = self.data.borrow_mut();
            if data.fail_resource_path_reads > 0 {
                data.fail_resource_path_reads -= 1;
                return Err(StoreError::Io("injected resource path fault".into()));
            }
        }
        let start = match (page.after, page.prefix) {
            (Some(after), Some(prefix)) if after < prefix => Included(prefix),
            (Some(after), _) => Excluded(after),
            (None, Some(prefix)) => Included(prefix),
            (None, None) => Unbounded,
        };
        let data = self.data.borrow();
        data.resources
            .range::<str, _>((start, Unbounded))
            .take_while(|(path, _)| page.prefix.is_none_or(|prefix| path.starts_with(prefix)))
            .take(page.limit as usize)
            .map(|(path, _)| {
                if path.len() > RESOURCE_PATH_BYTES {
                    return Err(StoreError::Full);
                }
                Ok(path.clone())
            })
            .collect()
    }
    fn resource_bounded(
        &self,
        path: &str,
        copy_limit: usize,
    ) -> StoreResult<Option<BoundedResource>> {
        if path.len() > RESOURCE_PATH_BYTES || copy_limit > RESOURCE_SOURCE_BYTES {
            return Err(StoreError::Full);
        }
        #[cfg(any(test, feature = "testing"))]
        {
            let mut data = self.data.borrow_mut();
            if data.fail_resource_reads > 0 {
                data.fail_resource_reads -= 1;
                return Err(StoreError::Io("injected resource read fault".into()));
            }
        }
        #[cfg(test)]
        self.data.borrow_mut().resource_copy_limits.push(copy_limit);
        Ok(self
            .data
            .borrow()
            .resources
            .get(path)
            .map(|doc| BoundedResource {
                size: doc.len() as u64,
                text: (doc.len() <= copy_limit).then(|| doc.clone()),
            }))
    }
    fn resources(&self) -> StoreResult<Vec<(String, String)>> {
        #[cfg(test)]
        if self.data.borrow().refuse_unbounded_resources {
            return Err(StoreError::Io(
                "unbounded resource inventory refused".into(),
            ));
        }
        Ok(self
            .data
            .borrow()
            .resources
            .iter()
            .map(|(a, b)| (a.clone(), b.clone()))
            .collect())
    }
    #[cfg(any(test, feature = "testing"))]
    fn query_index_state(&self) -> StoreResult<Option<crate::store_query::QueryIndexState>> {
        let mut data = self.data.borrow_mut();
        if data.query_read_abort_probe {
            data.query_read_abort_probe = false;
            return Err(StoreError::CommitAborted("private query READ probe".into()));
        }
        Ok(None)
    }
    fn settings(&self) -> StoreResult<Option<FileInclusion>> {
        Ok(self.data.borrow().settings.clone())
    }
    fn tombstone(&self, id: &Uuid) -> StoreResult<Option<TombstoneRow>> {
        Ok(self.data.borrow().tombstones.get(id).cloned())
    }
    fn tombstones_at(&self, path_key: &str) -> StoreResult<Vec<TombstoneRow>> {
        let d = self.data.borrow();
        Ok(d.tombstone_paths
            .range((path_key.to_string(), ID_MIN)..=(path_key.to_string(), ID_MAX))
            .filter_map(|(_, id)| d.tombstones.get(id).cloned())
            .collect())
    }
    fn tombstones(&self, p: Page) -> StoreResult<Vec<TombstoneRow>> {
        let d = self.data.borrow();
        Ok(after_range(&d.tombstones, p)
            .take(p.limit as usize)
            .map(|(_, t)| t.clone())
            .collect())
    }
    fn alias(&self, path_key: &str) -> StoreResult<Option<Uuid>> {
        Ok(self.data.borrow().aliases.get(path_key).map(|a| a.record))
    }
    fn aliases(&self) -> StoreResult<Vec<AliasRow>> {
        let mut v: Vec<AliasRow> = self.data.borrow().aliases.values().cloned().collect();
        v.sort_by(|a, b| a.path.as_bytes().cmp(b.path.as_bytes()));
        Ok(v)
    }
    fn conflicts(&self, of: Option<&Uuid>) -> StoreResult<Vec<ConflictRow>> {
        Ok(self
            .data
            .borrow()
            .conflicts
            .values()
            .filter(|c| of.is_none_or(|id| c.conflict.id == *id))
            .cloned()
            .collect())
    }
    fn conflict_count(&self) -> StoreResult<u64> {
        Ok(self.data.borrow().conflicts.len() as u64)
    }
    fn receipt(&self, mutation: &Uuid) -> StoreResult<Option<ReceiptRow>> {
        Ok(self.data.borrow().receipts.get(mutation).copied())
    }
    fn receipts(&self, after: Option<Uuid>, limit: u32) -> StoreResult<Vec<ReceiptRow>> {
        let d = self.data.borrow();
        Ok(after_range(&d.receipts, Page { after, limit })
            .take(limit as usize)
            .map(|(_, r)| *r)
            .collect())
    }
    fn referrers(&self, target_keys: &[String]) -> StoreResult<Vec<Uuid>> {
        let d = self.data.borrow();
        let mut out = BTreeSet::new();
        for k in target_keys {
            if let Some(s) = d.links.get(k) {
                out.extend(s.iter().copied());
            }
        }
        Ok(out.into_iter().collect())
    }
    fn unique_holders(&self, field: &str, value_key: &str) -> StoreResult<Vec<Uuid>> {
        Ok(self
            .data
            .borrow()
            .unique
            .get(&(field.to_string(), value_key.to_string()))
            .map(|s| s.iter().copied().collect())
            .unwrap_or_default())
    }
    fn candidates(&self, q: &Candidate, p: Page) -> StoreResult<Vec<RecordRow>> {
        let d = self.data.borrow();
        Ok(after_range(&d.records, p)
            .map(|(_, r)| r)
            .filter(|r| candidate_matches(q, r))
            .take(p.limit as usize)
            .cloned()
            .collect())
    }
    fn pending(&self, after_order: Option<u64>, limit: u32) -> StoreResult<Vec<PendingRow>> {
        use std::ops::Bound;
        let d = self.data.borrow();
        let lo = match after_order {
            Some(o) => Bound::Excluded(o),
            None => Bound::Unbounded,
        };
        Ok(d.pending
            .range((lo, Bound::Unbounded))
            .take(limit as usize)
            .map(|(_, r)| r.clone())
            .collect())
    }
    fn pending_get(&self, mutation: &Uuid) -> StoreResult<Option<PendingRow>> {
        let d = self.data.borrow();
        Ok(d.pending_ids
            .get(mutation)
            .and_then(|o| d.pending.get(o))
            .cloned())
    }
    fn pending_count(&self) -> StoreResult<u64> {
        Ok(self.data.borrow().pending.len() as u64)
    }
    fn local_receipt(&self, mutation: &Uuid) -> StoreResult<Option<LocalReceipt>> {
        Ok(self.data.borrow().local_receipts.get(mutation).cloned())
    }
    fn holds(&self) -> StoreResult<Vec<Hold>> {
        Ok(self.data.borrow().holds.values().cloned().collect())
    }
    fn hold(&self, id: &Uuid) -> StoreResult<Option<Hold>> {
        Ok(self.data.borrow().holds.get(id).cloned())
    }
    fn meta(&self, key: &str) -> StoreResult<Option<Vec<u8>>> {
        Ok(self.data.borrow().meta.get(key).cloned())
    }
    fn transfer(&self, id: &Uuid) -> StoreResult<Option<TransferRow>> {
        Ok(self.data.borrow().transfers.get(id).cloned())
    }
    fn transfer_chunk(&self, id: &Uuid, index: u64) -> StoreResult<Option<Vec<u8>>> {
        Ok(self.data.borrow().chunks.get(&(*id, index)).cloned())
    }
    fn blob_size(&self, digest: &Hash) -> StoreResult<Option<u64>> {
        Ok(self.data.borrow().blobs.get(digest).map(|b| b.len() as u64))
    }
    fn blob_read(&self, digest: &Hash, offset: u64, len: u64) -> StoreResult<Vec<u8>> {
        let d = self.data.borrow();
        let b = d
            .blobs
            .get(digest)
            .ok_or_else(|| StoreError::Io(format!("no blob {}", digest.to_hex())))?;
        let start = usize::try_from(offset).unwrap_or(usize::MAX).min(b.len());
        let end = start
            .saturating_add(usize::try_from(len).unwrap_or(usize::MAX))
            .min(b.len());
        Ok(b[start..end].to_vec())
    }
    fn tail(&self, after: Seq, limit: u32) -> StoreResult<Vec<TailRow>> {
        Ok(self
            .data
            .borrow()
            .tail
            .range((std::ops::Bound::Excluded(after), std::ops::Bound::Unbounded))
            .take(limit as usize)
            .map(|(_, r)| r.clone())
            .collect())
    }
    fn tail_stats(&self) -> StoreResult<TailStats> {
        #[cfg(any(test, feature = "testing"))]
        {
            let mut d = self.data.borrow_mut();
            if d.fail_tail_stats > 0 {
                d.fail_tail_stats -= 1;
                let why = "injected tail stats read failure".into();
                return Err(if d.tail_stats_abort_label {
                    StoreError::CommitAborted(why)
                } else {
                    StoreError::Io(why)
                });
            }
        }
        let d = self.data.borrow();
        Ok(TailStats {
            first: d.tail.keys().next().copied().unwrap_or(0),
            last: d.tail.keys().next_back().copied().unwrap_or(0),
            count: d.tail.len() as u64,
            bytes: d.tail_bytes,
        })
    }
    fn own_retained(&self, after: Seq, limit: u32) -> StoreResult<Vec<(Seq, PendingRow)>> {
        Ok(self
            .data
            .borrow()
            .own_retained
            .range((std::ops::Bound::Excluded(after), std::ops::Bound::Unbounded))
            .take(limit as usize)
            .map(|(s, r)| (*s, r.clone()))
            .collect())
    }
    fn durability_deferred(&self) -> bool {
        self.data.borrow().deferred
    }

    fn defer_durability(&mut self, on: bool) -> StoreResult<()> {
        let mut d = self.data.borrow_mut();
        if on != d.deferred {
            d.deferred = on;
            if on {
                d.windows.0 += 1;
            } else {
                d.windows.1 += 1;
            }
        }
        Ok(())
    }

    fn commit(&mut self, tx: Tx) -> StoreResult<CommitReport> {
        crate::mirror_admission::check_tx(
            self.meta(crate::mirror_admission::META)?.as_deref(),
            &tx,
        )?;
        let mut d = self.data.borrow_mut();
        if tx
            .meta
            .iter()
            .any(|(k, _)| k == crate::store::meta_keys::KEYRING)
        {
            d.keyring_writes += 1;
        }
        if d.fail_next > 0 {
            d.fail_next -= 1;
            return Err(StoreError::CommitAborted("injected failure".into()));
        }
        if d.fail_unknown_commits > 0 {
            d.fail_unknown_commits -= 1;
            return Err(StoreError::Io("injected unknown outcome".into()));
        }
        if tx
            .head
            .is_some_and(|head| Some(head.seq) == d.fail_unknown_head_commit)
        {
            d.fail_unknown_head_commit = None;
            return Err(StoreError::Io(
                "injected unknown outcome at head commit".into(),
            ));
        }
        let fail_after_head = tx
            .head
            .is_some_and(|head| Some(head.seq) == d.fail_after_head_commit);
        #[cfg(test)]
        if let Some(a) = d.att_disk.as_mut() {
            for t in &tx.ack_observations {
                a.ack(t.0);
            }
        }
        d.apply_staged(tx);
        if fail_after_head {
            d.fail_after_head_commit = None;
            return Err(StoreError::Io("injected error after head commit".into()));
        }
        if d.fail_after_commit > 0 {
            d.fail_after_commit -= 1;
            return Err(StoreError::Io("injected error after commit".into()));
        }
        Ok(CommitReport::default())
    }

    fn stages(&self) -> bool {
        !self.data.borrow().no_staging
    }

    fn keyring_persistence(&self) -> crate::store::KeyringPersistence {
        if self.data.borrow().rebuild_keyring {
            crate::store::KeyringPersistence::RebuildOnOpen
        } else {
            crate::store::KeyringPersistence::Plaintext
        }
    }
}

#[cfg(test)]
mod retained_boundary_tests {
    use super::*;
    use mdbn_wire::common::{B16, B32};
    use mdbn_wire::intent::{Mutation, OpClock, Source};

    fn own() -> PendingRow {
        PendingRow {
            order: 1,
            mutation: Mutation {
                id: B16([1; 16]),
                origin: B16([2; 16]),
                base_seq: 0,
                clock: OpClock {
                    instant: 0,
                    tz: "UTC".into(),
                    local_date: "1970-01-01".into(),
                },
                seed: B32([0; 32]),
                source: Source::Api,
                ops: vec![mdbn_wire::intent::Op::Delete(mdbn_wire::intent::Delete {
                    id: B16([3; 16]),
                    base_revision: None,
                    if_revision: None,
                })],
                on_behalf: None,
                conflict_mode: None,
                validated_at: None,
                room: None,
            }
            .into(),
            effects: Vec::new(),
            touches: Vec::new(),
            grant: None,
            uploads: Vec::new(),
            refs: Vec::new(),
        }
    }

    #[test]
    fn zero_erases_all_accepted_rows_and_max_drops_nothing() {
        let mut s = MemStore::new();
        for seq in [0, u64::MAX] {
            s.commit(Tx {
                tail_put: vec![TailRow {
                    seq,
                    item: vec![1],
                    applied_at: 0,
                }],
                own_retained_put: vec![(seq, own())],
                ..Tx::default()
            })
            .unwrap();
            s.commit(Tx {
                tail_drop_above: Some(seq),
                own_retained_drop_above: Some(seq),
                ..Tx::default()
            })
            .unwrap();
            let expected = u64::from(seq != 0);
            assert_eq!(s.tail_stats().unwrap().count, expected);
            assert_eq!(s.tail_stats().unwrap().bytes, expected);
            assert_eq!(
                s.data.borrow().own_retained.len() as u64,
                expected,
                "including otherwise unqueryable position zero"
            );
        }
        assert!(s.tail(u64::MAX, 10).unwrap().is_empty());
        assert!(s.own_retained(u64::MAX, 10).unwrap().is_empty());
        s.commit(Tx {
            tail_drop_above: Some(0),
            own_retained_drop_above: Some(0),
            ..Tx::default()
        })
        .unwrap();
        assert_eq!(s.tail_stats().unwrap(), TailStats::default());
        assert!(s.data.borrow().own_retained.is_empty());
    }
}
