//! Attachment-v1 fetch and materialization (`intent.md` §3.9, T5): a device
//! that applied a `put_attachment_file` streams the content from the log's
//! object store, authenticates it chunk by chunk, and places the file at its
//! path on disk.
//!
//! ```text
//!  apply / open ──► reconcile(file) ──► nothing | unlink | move (no refetch) | queue
//!                                                                           │
//!   queue ──► start: resume the staged prefix, or start over                │
//!              │                                                            ▼
//!              ▼
//!            GetObject(manifest) ─► AttachmentReader authenticates it
//!            GetObject(chunk i)  ─► authenticated plaintext ─► store staging (durable)
//!              │   one object in flight; transient errors retry the same object
//!              ▼
//!            finish: whole-file SHA-256 (in stream, or re-hashed after a resume)
//!              │
//!              ▼
//!            publish: conditional atomic rename at the path, record what is shown
//! ```
//!
//! - **Bounded memory.** One sealed object (≤ 9 MiB) and its plaintext at a
//!   time, one file at a time. The file is never held in memory: plaintext goes
//!   to the store's private staging as it is authenticated.
//! - **Verified before publish.** Nothing reaches the user's path unless every
//!   chunk authenticated against the signed descriptor's manifest and the
//!   whole file matched the signed whole-plaintext hash.
//! - **Resumable.** The staged length is the progress record. A restart resumes
//!   at the next whole chunk and re-hashes the staged file before publishing; a
//!   torn or tampered staging starts over.
//! - **Rows hold descriptors, not bytes.** `FileRow.content` is the signed
//!   `AttachmentV1` descriptor; `FileRow.local` says whether this device shows
//!   it. What the replica placed on disk (path and revision) is recorded per file
//!   in device-local meta, so a delete unlinks, a rename moves the file without
//!   fetching anything, and a crash in between is reconciled at open.
//! - **Terminal failures** (objects collected by the log, content that does not
//!   authenticate) are typed per content version, reported as an incident and in
//!   [`Replica::attachment_fetch_status`], and never retried for ever.

use std::collections::{BTreeMap, VecDeque};

use mdbn_wire::attachment::{AttachmentContentV1, FileContent};
use mdbn_wire::attachment_runtime_v1 as rt;
use mdbn_wire::cbor::{self, Cbor};
use mdbn_wire::client::{IncidentKind, Problem};
use mdbn_wire::common::{B32, Hash, Uuid, Value};
use mdbn_wire::entry::Effect;

use super::Replica;
use crate::api::ErrorCode;
use crate::attachments::{AttachmentReader, MAX_SEALED_MANIFEST, Need, PlainSink, StreamError};
use crate::crypto::chunked_blob::{
    AttachmentContextV1, AttachmentLimits, AttachmentRefV1, CHUNK_BYTES, ExpectedFileV1,
};
use crate::log::{CallId, LogError, LogErrorCode, LogReply, LogRequest, LogResponse};
use crate::store::{
    Expect, FileLocal, FileRow, Page, StageKey, Store, StoreError, TombstoneLast, Tx, meta_keys,
};

/// Bytes read per step when re-hashing a resumed staging.
const REHASH_BYTES: u32 = 1 << 20;
/// How many times one content version starts over (torn staging, a corrupt
/// object) before it fails.
const MAX_RESTARTS: u32 = 2;
/// Rows per page when reconciling every attachment file at open.
const PAGE: u32 = 256;

/// Where materializing one file stands.
#[derive(Debug, Clone, PartialEq)]
pub enum AttachmentFetchStatus {
    /// Waiting for its turn.
    Queued,
    /// Fetching: `chunks_done` of `chunks` chunk objects are staged.
    Fetching {
        /// Chunks staged.
        chunks_done: u64,
        /// Chunks in the file.
        chunks: u64,
    },
    /// Stopped for this content version (typed `problem`). A newer version of
    /// the file, or reopening the replica, tries again.
    Failed(Problem),
}

struct Fetch {
    file: Uuid,
    content: AttachmentContentV1,
    key: StageKey,
    reader: Option<AttachmentReader>,
    /// Bytes staged so far.
    staged: u64,
    /// The outstanding object read and what it was for.
    call: Option<(CallId, Need)>,
    retry_at: Option<i64>,
    restarts: u32,
}

/// The replica's materializations, one at a time in queue order.
#[derive(Default)]
pub(crate) struct Fetches {
    queue: VecDeque<Uuid>,
    current: Option<Fetch>,
    failed: BTreeMap<StageKey, Problem>,
    /// Chunk objects fetched (statistics and tests).
    pub(crate) chunks_fetched: u64,
}

impl Fetches {
    /// When the current fetch next wants a tick.
    pub(crate) fn next_wakeup(&self) -> Option<i64> {
        self.current.as_ref().and_then(|f| f.retry_at)
    }
}

/// The crypto descriptor and signed expectations of wire content.
pub(crate) fn descriptor(c: &AttachmentContentV1) -> (AttachmentRefV1, ExpectedFileV1) {
    (
        AttachmentRefV1 {
            context: AttachmentContextV1 {
                collection: c.reference.collection,
                key_epoch: c.reference.key_epoch,
                attachment_id: c.reference.attachment_id,
                chunk_bytes: CHUNK_BYTES,
            },
            manifest_cipher_hash: c.reference.manifest_cipher_hash,
        },
        ExpectedFileV1 {
            whole_plain_hash: c.whole_plain_hash,
            total_plain_bytes: c.total_plain_bytes,
        },
    )
}

fn stage_key(file: Uuid, c: &AttachmentContentV1) -> StageKey {
    StageKey {
        file,
        manifest: c.reference.manifest_cipher_hash,
    }
}

/// Files whose materialization an entry's effects may change.
pub(crate) fn touched_files(effects: &[rt::Effect]) -> Vec<Uuid> {
    let mut out: Vec<Uuid> = effects
        .iter()
        .filter_map(|e| match e {
            rt::Effect::PutAttachmentFile(f) => Some(f.id),
            rt::Effect::Legacy(Effect::PutFile(f)) => Some(f.id),
            rt::Effect::Legacy(Effect::RemoveFile(f)) => Some(f.id),
            rt::Effect::PutUnindexedMarkdown(f) => Some(f.id),
            rt::Effect::ReindexUnindexedMarkdown(f) => Some(f.id),
            rt::Effect::ReindexOrdinaryFile(f) => Some(f.id),
            rt::Effect::Legacy(_) => None,
        })
        .collect();
    out.sort();
    out.dedup();
    out
}

fn shown_key(id: &Uuid) -> String {
    format!("{}{}", meta_keys::ATTACHMENT_SHOWN, id.to_hex())
}

pub(crate) fn shown_meta(id: &Uuid, shown: Option<(&str, Hash)>) -> (String, Option<Vec<u8>>) {
    (
        shown_key(id),
        shown.map(|(path, rev)| {
            cbor::encode(&Cbor::Array(vec![
                Cbor::Text(path.to_owned()),
                Cbor::Bytes(rev.0.to_vec()),
            ]))
            .unwrap_or_default()
        }),
    )
}

fn stream_problem(e: &StreamError) -> Problem {
    match e {
        StreamError::Corrupt(m) => ErrorCode::Internal.problem_with_reason(
            "attachment_unavailable",
            format!("the attachment does not authenticate: {m}"),
        ),
        StreamError::TooLarge => ErrorCode::TooLarge.problem_with_reason(
            "attachment_too_large",
            "the attachment exceeds the file cap",
        ),
        StreamError::NoKey => ErrorCode::Unavailable
            .problem_with_reason("waiting_for_key", "no key for the attachment's epoch"),
        StreamError::Protocol(m) => ErrorCode::Internal.problem(format!("attachment reader: {m}")),
        StreamError::Sink(m) => ErrorCode::Unavailable.problem(format!("staging: {m}")),
    }
}

/// Authenticated plaintext into the store's staging, in order.
struct StageSink<'a, S: Store> {
    store: &'a mut S,
    key: StageKey,
    staged: &'a mut u64,
}

impl<S: Store> PlainSink for StageSink<'_, S> {
    fn write(&mut self, offset: u64, plain: &[u8]) -> Result<(), String> {
        if offset != *self.staged {
            return Err("staging is not contiguous".into());
        }
        self.store
            .attachment_stage(&self.key, offset, plain)
            .map_err(|e| e.to_string())?;
        *self.staged += plain.len() as u64;
        Ok(())
    }
}

impl<S: Store> Replica<S> {
    fn materializes_attachments(&self) -> bool {
        self.store.materializes_attachments() && !self.is_hosted() && !self.local_only()
    }

    /// Where materializing `file` stands; `None` when nothing is pending or
    /// failed for its current content.
    pub fn attachment_fetch_status(&self, file: &Uuid) -> Option<AttachmentFetchStatus> {
        let fetches = &self.attachment_fetches;
        if let Some(f) = fetches.current.as_ref().filter(|f| f.file == *file) {
            let chunks = f
                .content
                .total_plain_bytes
                .div_ceil(u64::from(CHUNK_BYTES))
                .max(1);
            return Some(AttachmentFetchStatus::Fetching {
                chunks_done: f.staged / u64::from(CHUNK_BYTES),
                chunks,
            });
        }
        if fetches.queue.contains(file) {
            return Some(AttachmentFetchStatus::Queued);
        }
        let row = self.store.file(file).ok().flatten()?;
        let FileContent::AttachmentV1(c) = &row.content else {
            return None;
        };
        fetches
            .failed
            .get(&stage_key(*file, c))
            .cloned()
            .map(AttachmentFetchStatus::Failed)
    }

    /// Chunk objects fetched since the replica opened.
    pub fn attachment_chunks_fetched(&self) -> u64 {
        self.attachment_fetches.chunks_fetched
    }

    pub(crate) fn attachment_shown(&self, id: &Uuid) -> Result<Option<(String, Hash)>, StoreError> {
        let Some(bytes) = self.store.meta(&shown_key(id))? else {
            return Ok(None);
        };
        let bad = || StoreError::Corrupt("attachment shown record".into());
        let c = cbor::decode(&bytes).map_err(|_| bad())?;
        match c {
            Cbor::Array(a) => match a.as_slice() {
                [Cbor::Text(p), Cbor::Bytes(h)] => {
                    let h: [u8; 32] = h.as_slice().try_into().map_err(|_| bad())?;
                    Ok(Some((p.clone(), B32(h))))
                }
                _ => Err(bad()),
            },
            _ => Err(bad()),
        }
    }

    /// Record what the disk shows for `row` (and its local state) in one commit.
    pub(crate) fn commit_shown(
        &mut self,
        row: Option<FileRow>,
        id: &Uuid,
        shown: Option<(&str, Hash)>,
    ) -> Result<(), StoreError> {
        let mut tx = Tx {
            meta: vec![shown_meta(id, shown)],
            ..Tx::default()
        };
        if let Some(r) = row {
            tx.files_put.push(r);
        }
        self.store.commit(tx)?;
        Ok(())
    }

    pub(crate) fn with_local(row: &FileRow, local: FileLocal) -> Option<FileRow> {
        (row.local != local).then(|| FileRow {
            local,
            ..row.clone()
        })
    }

    /// After an applied entry: bring these files' disk state in line.
    pub(crate) fn attachment_files_changed(&mut self, files: Vec<Uuid>) {
        if files.is_empty() || !self.materializes_attachments() {
            return;
        }
        for id in files {
            if let Err(e) = self.reconcile_attachment(id) {
                self.incident(
                    IncidentKind::Integrity,
                    Some(Value::Text(format!("attachment materialize: {e}"))),
                );
                return;
            }
        }
        self.attachment_fetch_step();
    }

    /// At open: every attachment file, and every deleted one this device still
    /// shows (a crash between apply and the unlink).
    pub(crate) fn reconcile_attachments(&mut self) -> Result<(), StoreError> {
        if !self.materializes_attachments() {
            return Ok(());
        }
        let mut ids = Vec::new();
        let mut after = None;
        loop {
            let page = self.store.files(Page { after, limit: PAGE })?;
            let n = page.len();
            for f in &page {
                if matches!(f.content, FileContent::AttachmentV1(_))
                    || f.kind
                        == mdbn_wire::unindexed_markdown::FileKindV1::UnindexedOversizedMarkdown
                {
                    ids.push(f.id);
                }
            }
            after = page.last().map(|f| f.id);
            if n < PAGE as usize {
                break;
            }
        }
        let mut after = None;
        loop {
            let page = self.store.tombstones(Page { after, limit: PAGE })?;
            let n = page.len();
            for t in &page {
                if matches!(
                    t.last,
                    TombstoneLast::Attachment(_) | TombstoneLast::UnindexedMarkdown(_)
                ) && self.store.meta(&shown_key(&t.id))?.is_some()
                {
                    ids.push(t.id);
                }
            }
            after = page.last().map(|t| t.id);
            if n < PAGE as usize {
                break;
            }
        }
        for id in ids {
            self.reconcile_attachment(id)?;
        }
        self.attachment_fetch_step();
        Ok(())
    }

    /// Compare what this device shows for `id` with the confirmed row: unlink,
    /// move, adopt, or queue a fetch.
    fn reconcile_attachment(&mut self, id: Uuid) -> Result<(), StoreError> {
        let row = self.store.file(&id)?;
        if self.file_materialization_fenced(id, row.as_ref().map(|r| r.path.as_str()))? {
            self.cancel_fetch(&id);
            self.cancel_native_blob(id)?;
            return Ok(());
        }
        let shown = self.attachment_shown(&id)?;
        if let Some(r) = row.as_ref().filter(|r| {
            r.kind == mdbn_wire::unindexed_markdown::FileKindV1::UnindexedOversizedMarkdown
                && matches!(r.content, FileContent::Blob(_))
        }) {
            self.cancel_fetch(&id);
            return self.reconcile_native_blob(r.clone());
        }
        self.cancel_native_blob(id)?;
        let want = row.as_ref().and_then(|r| match &r.content {
            FileContent::AttachmentV1(c) => Some((r.path.clone(), c.clone())),
            FileContent::Blob(_) => None,
            _ => None,
        });
        match (shown, want) {
            (None, None) => self.cancel_fetch(&id),
            (Some((path, rev)), None) => {
                // Deleted, or no longer attachment content: unlink what this
                // device placed, only if it still holds exactly those bytes.
                self.cancel_fetch(&id);
                if row.is_none() && self.store.record(&id)?.is_none() {
                    // A Record transition publishes its replacement atomically;
                    // never unlink the prior file before that conditional write.
                    // A drift means the user changed or removed it: ingest owns it.
                    let _ = self.store.attachment_remove(id, &path, rev)?;
                }
                self.commit_shown(None, &id, None)?;
            }
            (Some((path, rev)), Some((wpath, c))) if rev == c.whole_plain_hash => {
                // Same content: a rename is metadata only, nothing is fetched.
                self.cancel_fetch(&id);
                let row = row.expect("want implies a row");
                let placed = path == wpath
                    || self
                        .store
                        .attachment_move(id, &path, &wpath, rev)?
                        .is_none()
                    || self.store.disk_revision(&wpath)? == Some(rev);
                if placed {
                    let r = Self::with_local(&row, FileLocal::Materialized);
                    self.commit_shown(r, &id, Some((&wpath, rev)))?;
                } else {
                    let r = Self::with_local(&row, FileLocal::Remote);
                    self.commit_shown(r, &id, None)?;
                    self.queue_fetch(id);
                }
            }
            (shown, Some((wpath, c))) => {
                let row = row.expect("want implies a row");
                // The disk already shows exactly this content (this device wrote
                // it, or an earlier run placed it): adopt it, fetch nothing.
                if self.store.disk_revision(&wpath)? == Some(c.whole_plain_hash) {
                    self.cancel_fetch(&id);
                    if let Some((p, r)) = &shown
                        && *p != wpath
                    {
                        let _ = self.store.attachment_remove(id, p, *r)?;
                    }
                    let r = Self::with_local(&row, FileLocal::Materialized);
                    self.commit_shown(r, &id, Some((&wpath, c.whole_plain_hash)))?;
                    return Ok(());
                }
                if let Some(r) = Self::with_local(&row, FileLocal::Remote) {
                    self.store.commit(Tx {
                        files_put: vec![r],
                        ..Tx::default()
                    })?;
                }
                if !self
                    .attachment_fetches
                    .failed
                    .contains_key(&stage_key(id, &c))
                {
                    self.queue_fetch(id);
                }
            }
        }
        Ok(())
    }

    fn queue_fetch(&mut self, id: Uuid) {
        let f = &mut self.attachment_fetches;
        if f.current.as_ref().is_some_and(|c| c.file == id) || f.queue.contains(&id) {
            return;
        }
        f.queue.push_back(id);
    }

    /// Stop fetching `id` (its content changed or is gone). Staging is dropped.
    fn cancel_fetch(&mut self, id: &Uuid) {
        self.attachment_fetches.queue.retain(|q| q != id);
        if self
            .attachment_fetches
            .current
            .as_ref()
            .is_some_and(|c| c.file == *id)
            && let Some(f) = self.attachment_fetches.current.take()
        {
            if let Some((call, _)) = f.call {
                self.inflight.remove(&call);
            }
            let _ = self.store.attachment_unstage(&f.key);
        }
    }

    /// Start the fetch of `id`'s current content, resuming its staging.
    fn start_fetch(&mut self, id: Uuid) -> Result<Option<Fetch>, StoreError> {
        let Some(row) = self.store.file(&id)? else {
            return Ok(None);
        };
        let FileContent::AttachmentV1(c) = &row.content else {
            return Ok(None);
        };
        if self.file_materialization_fenced(id, Some(&row.path))? {
            return Ok(None);
        }
        if row.local == FileLocal::Materialized {
            return Ok(None);
        }
        let key = stage_key(id, c);
        if self.attachment_fetches.failed.contains_key(&key) {
            return Ok(None);
        }
        let (d, e) = descriptor(c);
        let limits = AttachmentLimits::default();
        let chunk = u64::from(CHUNK_BYTES);
        let staged = self.store.attachment_staged(&key)?;
        // Resume only a staging that is exactly a whole-chunk prefix.
        let resumable = staged > 0
            && staged <= e.total_plain_bytes
            && (staged % chunk == 0 || staged == e.total_plain_bytes);
        let reader = if resumable {
            AttachmentReader::resume(d, e, limits, staged.div_ceil(chunk))
        } else {
            if staged > 0 {
                self.store.attachment_unstage(&key)?;
            }
            AttachmentReader::whole(d, e, limits)
        };
        match reader {
            Ok(r) => Ok(Some(Fetch {
                file: id,
                content: c.clone(),
                key,
                reader: Some(r),
                staged: if resumable { staged } else { 0 },
                call: None,
                retry_at: None,
                restarts: 0,
            })),
            Err(e) => {
                self.fail_fetch(id, key, &row.path, stream_problem(&e));
                Ok(None)
            }
        }
    }

    /// Advance materialization until it waits for a reply or a retry time.
    pub(crate) fn attachment_fetch_step(&mut self) {
        if !self.materializes_attachments()
            || self.log_move != super::LogMove::None
            || self.apply_fault
        {
            return;
        }
        loop {
            let f = match self.attachment_fetches.current.take() {
                Some(f) => f,
                None => {
                    let Some(id) = self.attachment_fetches.queue.pop_front() else {
                        return;
                    };
                    match self.start_fetch(id) {
                        Ok(Some(f)) => f,
                        Ok(None) => continue,
                        Err(e) => {
                            self.store_trouble(&e);
                            return;
                        }
                    }
                }
            };
            match self.drive_fetch(f) {
                Ok(Some(f)) => {
                    self.attachment_fetches.current = Some(f);
                    return;
                }
                Ok(None) => {}
                Err(e) => {
                    self.store_trouble(&e);
                    return;
                }
            }
        }
    }

    fn store_trouble(&mut self, e: &StoreError) {
        self.incident(
            IncidentKind::Integrity,
            Some(Value::Text(format!("attachment materialize: store: {e}"))),
        );
    }

    /// Issue the next read, or finish. `Some` while the fetch is still running.
    fn drive_fetch(&mut self, mut f: Fetch) -> Result<Option<Fetch>, StoreError> {
        if let Some((call, _)) = f.call {
            if self.inflight.contains_key(&call) {
                return Ok(Some(f));
            }
            // Dropped by a repoint: no reply is coming. Ask again.
            f.call = None;
        }
        if let Some(t) = f.retry_at {
            if self.now() < t {
                return Ok(Some(f));
            }
            f.retry_at = None;
        }
        let Some(reader) = f.reader.as_ref() else {
            return Ok(None);
        };
        match reader.need() {
            Some(need) => {
                let address = match need {
                    Need::Manifest { address } | Need::Chunk { address, .. } => address,
                };
                let id = self.queue(LogRequest::GetObject {
                    collection: self.cfg.collection,
                    address,
                    range: None,
                });
                self.inflight
                    .insert(id, super::append::Inflight::AttachmentFetch(f.file));
                f.call = Some((id, need));
                Ok(Some(f))
            }
            None => {
                self.finish_fetch(f)?;
                Ok(None)
            }
        }
    }

    /// A reply to the current fetch's object read.
    pub(crate) fn on_attachment_fetch_reply(&mut self, file: Uuid, id: CallId, reply: LogReply) {
        let Some(mut f) = self.attachment_fetches.current.take() else {
            return;
        };
        let need = match f.call {
            Some((c, need)) if c == id && f.file == file => need,
            _ => {
                self.attachment_fetches.current = Some(f);
                return; // stale
            }
        };
        f.call = None;
        let retry = |r: &Self, after: Option<u64>| {
            r.now()
                .saturating_add(i64::try_from(after.unwrap_or(r.tuning.retry_ms)).unwrap_or(0))
        };
        let path = self
            .store
            .file(&f.file)
            .ok()
            .flatten()
            .map(|r| r.path)
            .unwrap_or_default();
        match reply {
            Ok(LogResponse::GetObject { bytes, .. }) => {
                let (address, max) = match need {
                    Need::Manifest { address } => (address, MAX_SEALED_MANIFEST),
                    Need::Chunk {
                        address,
                        sealed_bytes,
                        ..
                    } => (address, sealed_bytes),
                };
                // Complete objects are addressed by their SHA-256: anything else
                // is not the object the signed manifest names.
                if bytes.len() as u64 > max || mdbn_wire::hash::sha256(&bytes) != address {
                    self.restart_fetch(f, &path, "an object does not match its address");
                    return self.attachment_fetch_step();
                }
                let Some(mut reader) = f.reader.take() else {
                    return;
                };
                let supplied = match need {
                    Need::Manifest { .. } => reader.supply_manifest(&*self.sealer, &bytes),
                    Need::Chunk { index, .. } => {
                        let mut sink = StageSink {
                            store: &mut self.store,
                            key: f.key,
                            staged: &mut f.staged,
                        };
                        let r = reader.supply_chunk(&*self.sealer, index, &bytes, &mut sink);
                        if r.is_ok() {
                            self.attachment_fetches.chunks_fetched += 1;
                        }
                        r
                    }
                };
                drop(bytes);
                if matches!(need, Need::Manifest { .. })
                    && supplied.is_ok()
                    && let Some(v) = reader.manifest()
                {
                    // The authenticated object inventory, for snapshot refs.
                    let meta = super::attachment_inventory::inventory_meta(
                        f.key.manifest,
                        &v.manifest().chunks,
                    );
                    if let Err(e) = self.store.commit(Tx {
                        meta: vec![meta],
                        ..Tx::default()
                    }) {
                        self.store_trouble(&e);
                    }
                }
                f.reader = Some(reader);
                match supplied {
                    Ok(()) => self.attachment_fetches.current = Some(f),
                    Err(StreamError::NoKey) => {
                        // A key for the attachment's epoch may still arrive.
                        f.retry_at = Some(retry(self, None));
                        self.attachment_fetches.current = Some(f);
                    }
                    Err(StreamError::Sink(m)) => {
                        // Local storage trouble: keep what is staged, try later.
                        self.incident(
                            IncidentKind::Integrity,
                            Some(Value::Text(format!("attachment staging: {m}"))),
                        );
                        f.retry_at = Some(retry(self, None));
                        self.attachment_fetches.current = Some(f);
                    }
                    Err(StreamError::Corrupt(m)) => self.restart_fetch(f, &path, m),
                    Err(e) => {
                        let key = f.key;
                        let _ = self.store.attachment_unstage(&key);
                        self.fail_fetch(f.file, key, &path, stream_problem(&e));
                    }
                }
            }
            Ok(_) => {
                let key = f.key;
                self.fail_fetch(
                    f.file,
                    key,
                    &path,
                    ErrorCode::Internal.problem("unexpected object store response"),
                );
            }
            Err(LogError::NoResponse | LogError::Offline) => {
                f.retry_at = Some(retry(self, None));
                self.attachment_fetches.current = Some(f);
            }
            Err(LogError::Service {
                code,
                retry_after_ms,
                ..
            }) => match code {
                LogErrorCode::Unavailable
                | LogErrorCode::RateLimited
                | LogErrorCode::Unauthenticated
                | LogErrorCode::Frozen => {
                    f.retry_at = Some(retry(self, retry_after_ms));
                    self.attachment_fetches.current = Some(f);
                }
                LogErrorCode::NotFound | LogErrorCode::Gone => {
                    // Collected by the log (no transfer lease in v1): this version
                    // cannot be fetched. A newer entry for the file can be.
                    let key = f.key;
                    let _ = self.store.attachment_unstage(&key);
                    self.fail_fetch(
                        f.file,
                        key,
                        &path,
                        ErrorCode::NotFound.problem_with_reason(
                            "attachment_objects_missing",
                            "the log no longer has this attachment's objects",
                        ),
                    );
                }
                other => {
                    let key = f.key;
                    self.fail_fetch(
                        f.file,
                        key,
                        &path,
                        ErrorCode::Internal.problem(format!(
                            "the log refused the object read: {}",
                            other.as_str()
                        )),
                    );
                }
            },
        }
        self.attachment_fetch_step();
    }

    /// Drop the staging and start this version over, a bounded number of times.
    fn restart_fetch(&mut self, mut f: Fetch, path: &str, why: &str) {
        let _ = self.store.attachment_unstage(&f.key);
        f.restarts += 1;
        if f.restarts > MAX_RESTARTS {
            let key = f.key;
            return self.fail_fetch(
                f.file,
                key,
                path,
                stream_problem(&StreamError::Corrupt(
                    // A static reason keeps the problem typed; `why` goes to the incident.
                    "repeated authentication failure",
                )),
            );
        }
        self.incident(
            IncidentKind::Integrity,
            Some(Value::Text(format!(
                "attachment_unavailable: {path}: {why}; fetching again"
            ))),
        );
        let (d, e) = descriptor(&f.content);
        match AttachmentReader::whole(d, e, AttachmentLimits::default()) {
            Ok(r) => {
                f.reader = Some(r);
                f.staged = 0;
                f.call = None;
                self.attachment_fetches.current = Some(f);
            }
            Err(e) => {
                let key = f.key;
                self.fail_fetch(f.file, key, path, stream_problem(&e));
            }
        }
    }

    /// A typed terminal failure for this content version: reported, never retried.
    fn fail_fetch(&mut self, file: Uuid, key: StageKey, path: &str, problem: Problem) {
        self.incident(
            IncidentKind::Integrity,
            Some(Value::Text(format!(
                "attachment_unavailable: {path}: {}",
                problem.message
            ))),
        );
        let _ = file;
        self.attachment_fetches.failed.insert(key, problem);
        self.status_dirty = true;
    }

    /// Every object is in: check the whole file, then place it.
    fn finish_fetch(&mut self, mut f: Fetch) -> Result<(), StoreError> {
        let path = self
            .store
            .file(&f.file)?
            .map(|r| r.path)
            .unwrap_or_default();
        let Some(reader) = f.reader.take() else {
            return Ok(());
        };
        let total = f.content.total_plain_bytes;
        match reader.finish() {
            Ok(false) => {}
            Ok(true) => {
                // Resumed: the earlier prefix was staged by another run. Re-hash
                // the whole staging (bounded reads) before it can be published.
                let mut h = crate::attachments::WholeFileHasher::default();
                let mut at = 0u64;
                let staged = self.store.attachment_staged(&f.key)?;
                if staged != total {
                    self.restart_fetch(f, &path, "staging length");
                    return Ok(());
                }
                while at < total {
                    let len = u32::try_from((total - at).min(u64::from(REHASH_BYTES)))
                        .unwrap_or(REHASH_BYTES);
                    let b = self.store.attachment_stage_read(&f.key, at, len)?;
                    if b.is_empty() || b.len() as u64 > u64::from(len) {
                        break;
                    }
                    h.update(&b);
                    at += b.len() as u64;
                }
                let (_, e) = descriptor(&f.content);
                if at != total || !h.matches(&e) {
                    self.restart_fetch(f, &path, "staged bytes do not match the signed hash");
                    return Ok(());
                }
            }
            Err(StreamError::Corrupt(m)) => {
                self.restart_fetch(f, &path, m);
                return Ok(());
            }
            Err(e) => {
                let _ = self.store.attachment_unstage(&f.key);
                self.fail_fetch(f.file, f.key, &path, stream_problem(&e));
                return Ok(());
            }
        }
        self.publish_attachment(&f)
    }

    /// Place a verified staging at the file's current path.
    fn publish_attachment(&mut self, f: &Fetch) -> Result<(), StoreError> {
        let rev = f.content.whole_plain_hash;
        let row = match self.store.file(&f.file)? {
            Some(r) if r.content == FileContent::AttachmentV1(f.content.clone()) => r,
            _ => {
                // The file changed or went while fetching: this version is moot.
                self.store.attachment_unstage(&f.key)?;
                return self.reconcile_attachment(f.file);
            }
        };
        if self.file_materialization_fenced(f.file, Some(&row.path))? {
            // Recheck at the publication boundary: a hold/pending edit can
            // arrive after staging or while an object reply is in flight.
            self.store.attachment_unstage(&f.key)?;
            return Ok(());
        }
        let mut shown = self.attachment_shown(&f.file)?;
        if let Some((p, r)) = shown.clone()
            && p != row.path
        {
            // The previous version sits at an old path: remove it first.
            let _ = self.store.attachment_remove(f.file, &p, r)?;
            shown = None;
        }
        let expect = match &shown {
            Some((_, r)) => Expect::Revision(*r),
            None => Expect::Absent,
        };
        if f.content.total_plain_bytes == 0 {
            // An empty file has no plaintext to stage: create its empty staging.
            self.store.attachment_stage(&f.key, 0, &[])?;
        }
        let drift = self
            .store
            .attachment_publish(&f.key, rev, &row.path, expect)?;
        if let Some(reason) = drift {
            self.store.attachment_unstage(&f.key)?;
            if self.store.disk_revision(&row.path)? != Some(rev) {
                // Someone else's bytes are there: never overwritten. Ingest
                // reconciles them; this version stays remote.
                let r = Self::with_local(&row, FileLocal::Remote);
                self.commit_shown(r, &f.file, None)?;
                self.fail_fetch(
                    f.file,
                    f.key,
                    &row.path,
                    ErrorCode::Conflict.problem_with_reason(
                        "path_occupied",
                        format!("not materialized: the path holds other bytes ({reason})"),
                    ),
                );
                return Ok(());
            }
        }
        let r = Self::with_local(&row, FileLocal::Materialized);
        self.commit_shown(r, &f.file, Some((&row.path, rev)))?;
        self.status_dirty = true;
        Ok(())
    }
}
