//! Record history over the retained log (`replica-client-api.md` §4.4).
//!
//! An in-memory index of every record version in a verified range of log
//! positions `(floor, top]`, read from the log service on first use and extended
//! towards older positions as callers page back. Every page must link by `prev`
//! to a chain hash this replica already verified, so the index only holds the
//! items it applied. Nothing is persisted; a store generation change drops it.
//!
//! Writers store each document whole in its own entry (`log-entry.md` §2.2), so
//! a version's text is read from that one entry, inline or from its blob text.

use std::collections::BTreeMap;

use mdbn_wire::attachment::FileContent;
use mdbn_wire::attachment_runtime_v1 as rt;
use mdbn_wire::client::{
    AuthorRef, HistoryVersion, RecordHistory, RecordHistoryParams, RecordVersion,
    RecordVersionParams, VersionKind,
};
use mdbn_wire::common::{Hash, Text, Uuid};
use mdbn_wire::entry::{Effect, TextDef, TextDefForm};
use mdbn_wire::envelope::{Item, ItemKind};
use mdbn_wire::intent::{BlobRef, Op, Source};
use mdbn_wire::log_service::{ReadParams, ReadResult};
use mdbn_wire::policy::DeviceKind;
use mdbn_wire::schema::Wire;

use super::Replica;
use crate::api::{ApiError, ApiResult, ErrorCode, HISTORY_LOADING, SessionId, history_unsupported};
use crate::file_source::{FileSourceReader, SourceNeed};
use crate::log::{CallId, LogError, LogReply, LogRequest, LogResponse};
use crate::seal::OpenError;
use crate::store::Store;

/// Log positions one read asks for.
const PAGE: u64 = 1000;
/// Log positions one `record_history` call reads below `before`, at most.
const SPAN: u64 = 10_000;
/// Versions per page when the caller gives no limit.
const DEFAULT_LIMIT: u64 = 50;
/// Concurrent `record_version` reads.
const MAX_VERSION_JOBS: usize = 4;
/// Largest blob text: the bound of the only writer of one (unindexed promotion).
const MAX_BLOB_TEXT: u64 = 1 << 20;

/// History state of one replica.
#[derive(Default)]
pub(crate) struct History {
    index: Option<Index>,
    scan: Option<Scan>,
    /// A failed scan, answered once to the next caller and then forgotten.
    failure: Option<ApiError>,
    versions: Vec<VersionJob>,
}

struct Index {
    generation: u64,
    /// Positions `(floor, top]` are indexed.
    floor: u64,
    /// `chain(floor)`: the `prev` of the item at `floor + 1`.
    floor_chain: Hash,
    top: u64,
    top_chain: Hash,
    /// Nothing below `floor` can be read: compacted, or sealed under an epoch this
    /// device cannot open.
    sealed: bool,
    /// The log's compaction point, as of the latest read.
    retained_from: u64,
    /// The oldest readable entry indexed: (position, capture time).
    oldest: Option<(u64, i64)>,
    entries: BTreeMap<u64, Entry>,
    /// Each record's versions, in ascending position.
    records: BTreeMap<Uuid, Vec<Row>>,
}

impl Index {
    fn exhausted(&self) -> bool {
        self.sealed || self.floor < self.retained_from
    }
}

/// Who wrote an entry and when.
#[derive(Clone)]
struct Entry {
    time: i64,
    device: Uuid,
    device_kind: DeviceKind,
    account: Uuid,
    grant: Option<Uuid>,
    source: Source,
    /// `chain_hash` of the item, so a version read gets the bytes indexed.
    chain: Hash,
}

#[derive(Clone)]
struct Row {
    seq: u64,
    hint: Hint,
    change: Change,
}

#[derive(Clone, Copy, PartialEq)]
enum Hint {
    None,
    Created,
    Renamed,
}

#[derive(Clone)]
enum Change {
    Put { path: String, revision: Hash },
    Remove { path: String },
}

/// One verified range being read: `(lo, hi]`, whose last item must hash to
/// `hi_chain`, and whose first item must name `lo_chain` as `prev` when known.
struct Scan {
    generation: u64,
    lo: u64,
    hi: u64,
    lo_chain: Option<Hash>,
    hi_chain: Hash,
    /// Highest position read so far, and the chain hash of its item.
    cursor: u64,
    running: Option<Hash>,
    /// `prev` of the item at `lo + 1`: `chain(lo)`.
    first_prev: Option<Hash>,
    call: Option<CallId>,
    found: Found,
}

/// What a scan found, merged into the index once its range verifies.
#[derive(Default)]
struct Found {
    entries: Vec<(u64, Entry)>,
    rows: Vec<(Uuid, Row)>,
    /// The highest item this device cannot open, and its chain hash.
    sealed: Option<(u64, Hash)>,
}

struct VersionJob {
    generation: u64,
    record: Uuid,
    seq: u64,
    call: Option<CallId>,
    /// Set while reading a blob text: (path, revision, reader).
    blob: Option<(String, Hash, FileSourceReader)>,
    done: Option<ApiResult<RecordVersion>>,
}

fn loading() -> ApiError {
    ErrorCode::Unavailable.err_with_reason(HISTORY_LOADING, "history log reads are outstanding")
}

fn integrity(what: &str) -> ApiError {
    ErrorCode::Unavailable.err_with_reason(
        "history_integrity",
        format!("the log does not match this replica's verified chain: {what}"),
    )
}

fn offline(e: &LogError) -> ApiError {
    ErrorCode::Unavailable.err_with_reason("history_offline", format!("log read failed: {e}"))
}

fn not_found(reason: &str, message: &str) -> ApiError {
    ErrorCode::NotFound.err_with_reason(reason, message.to_owned())
}

/// The revision of a record text in an entry, or `None` for an entry whose
/// text table does not resolve it (the replica voided such an entry at apply).
fn text_revision(doc: &Text, texts: &[TextDef]) -> Result<Option<Hash>, ApiError> {
    let literal = |s: &str| Some(crate::convert::whash(&mdbn_core::ids::revision(s)));
    Ok(match doc {
        Text::Inline(s) => literal(s),
        Text::Index(i) => match usize::try_from(*i).ok().and_then(|i| texts.get(i)) {
            Some(TextDef::Literal(s)) => literal(s),
            Some(TextDef::Form(TextDefForm::Blob(b))) => Some(b.blob.plain_hash),
            Some(TextDef::Form(TextDefForm::Delta(_))) => {
                return Err(ErrorCode::UpgradeRequired.err_with_reason(
                    "history_delta_unsupported",
                    "a record text in the log is delta-encoded",
                ));
            }
            None => None,
        },
    })
}

/// Each record an entry changed, with the op that explains the change.
type Changes = BTreeMap<Uuid, (Hint, Change)>;

/// Every record change an entry made; the last change of a record in the
/// entry wins. `None` for an entry whose text table does not resolve.
fn record_changes(p: &rt::EntryPayload) -> Result<Option<Changes>, ApiError> {
    let texts = p.texts.as_deref().unwrap_or_default();
    let mut hints = BTreeMap::new();
    let mut out = BTreeMap::new();
    for op in &p.mutation.ops {
        match op {
            rt::Op::Legacy(Op::Create(c)) => {
                hints.insert(c.id, Hint::Created);
            }
            rt::Op::Legacy(Op::Rename(r)) => {
                hints.insert(r.id, Hint::Renamed);
            }
            rt::Op::UnindexedMarkdownToRecord(o) => {
                hints.insert(o.id, Hint::Created);
            }
            rt::Op::OrdinaryFileToRecord(o) => {
                hints.insert(o.id, Hint::Created);
            }
            // The record becomes an unindexed file: as a record, it is gone.
            rt::Op::RecordToUnindexedMarkdown(o) => {
                out.insert(
                    o.id,
                    (
                        Hint::None,
                        Change::Remove {
                            path: o.path.clone(),
                        },
                    ),
                );
            }
            _ => {}
        }
    }
    for effect in &p.effects {
        let (id, path, doc) = match effect {
            rt::Effect::Legacy(Effect::PutRecord(e)) => (e.id, &e.path, &e.doc),
            rt::Effect::Legacy(Effect::RemoveRecord(e)) => {
                out.insert(
                    e.id,
                    (
                        Hint::None,
                        Change::Remove {
                            path: e.path.clone(),
                        },
                    ),
                );
                continue;
            }
            rt::Effect::ReindexUnindexedMarkdown(e) => (e.id, &e.path, &e.doc),
            rt::Effect::ReindexOrdinaryFile(e) => (e.id, &e.path, &e.doc),
            _ => continue,
        };
        let Some(revision) = text_revision(doc, texts)? else {
            return Ok(None);
        };
        out.insert(
            id,
            (
                Hint::None,
                Change::Put {
                    path: path.clone(),
                    revision,
                },
            ),
        );
    }
    for (id, (hint, change)) in &mut out {
        if matches!(change, Change::Put { .. }) {
            *hint = hints.get(id).copied().unwrap_or(Hint::None);
        }
    }
    Ok(Some(out))
}

/// A version's document from its own entry: inline text, or the blob to read.
enum Doc {
    Inline(String),
    Blob(BlobRef),
}

fn version_doc(p: &rt::EntryPayload, record: &Uuid) -> Option<(String, Doc)> {
    let texts = p.texts.as_deref().unwrap_or_default();
    let mut found = None;
    for effect in &p.effects {
        match effect {
            rt::Effect::Legacy(Effect::PutRecord(e)) if e.id == *record => {
                found = Some((&e.path, &e.doc));
            }
            rt::Effect::ReindexUnindexedMarkdown(e) if e.id == *record => {
                found = Some((&e.path, &e.doc));
            }
            rt::Effect::ReindexOrdinaryFile(e) if e.id == *record => {
                found = Some((&e.path, &e.doc));
            }
            _ => {}
        }
    }
    let (path, doc) = found?;
    let doc = match doc {
        Text::Inline(s) => Doc::Inline(s.clone()),
        Text::Index(i) => match texts.get(usize::try_from(*i).ok()?)? {
            TextDef::Literal(s) => Doc::Inline(s.clone()),
            TextDef::Form(TextDefForm::Blob(b)) => Doc::Blob(b.blob.clone()),
            TextDef::Form(TextDefForm::Delta(_)) => return None,
        },
    };
    Some((path.clone(), doc))
}

impl<S: Store> Replica<S> {
    fn history_supported(&self) -> ApiResult<()> {
        if self.is_hosted() || self.local_only() {
            return Err(history_unsupported());
        }
        self.check_apply_health()
    }

    /// Drop state from an older store generation, and hand a failed scan to
    /// this caller.
    fn history_prepare(&mut self) -> ApiResult<()> {
        let generation = self.store_generation;
        let h = &mut self.history;
        if h.index.as_ref().is_some_and(|i| i.generation != generation) {
            h.index = None;
        }
        if h.scan.as_ref().is_some_and(|s| s.generation != generation) {
            h.scan = None;
        }
        h.versions.retain(|j| j.generation == generation);
        if let Some(e) = h.failure.take() {
            return Err(e);
        }
        // A read the replica dropped (a transport reset clears calls) is resent.
        if let Some(s) = &mut self.history.scan
            && s.call.is_some_and(|c| !self.inflight.contains_key(&c))
        {
            s.call = None;
        }
        if self.history.scan.as_ref().is_some_and(|s| s.call.is_none()) {
            self.history_read_page();
        }
        Ok(())
    }

    /// Ensure the index reaches the applied head; `false` while reading.
    fn history_at_head(&mut self) -> bool {
        if self.install.is_some() || self.log_move != super::LogMove::None {
            return false;
        }
        let head = self.head;
        let generation = self.store_generation;
        let index = self.history.index.get_or_insert_with(|| Index {
            generation,
            floor: head.seq,
            floor_chain: head.chain,
            top: head.seq,
            top_chain: head.chain,
            sealed: false,
            retained_from: 1,
            oldest: None,
            entries: BTreeMap::new(),
            records: BTreeMap::new(),
        });
        if index.top >= head.seq {
            return true;
        }
        if self.history.scan.is_none() {
            let (lo, lo_chain) = (index.top, index.top_chain);
            self.history_start(lo, Some(lo_chain), head.seq, head.chain);
        }
        false
    }

    /// Extend the index below its floor by one range; `false` while reading.
    fn history_extend_down(&mut self) {
        if self.history.scan.is_some() {
            return;
        }
        let Some(index) = &self.history.index else {
            return;
        };
        let hi = index.floor;
        let lo = hi
            .saturating_sub(PAGE)
            .max(index.retained_from.saturating_sub(1));
        let hi_chain = index.floor_chain;
        self.history_start(lo, None, hi, hi_chain);
    }

    fn history_start(&mut self, lo: u64, lo_chain: Option<Hash>, hi: u64, hi_chain: Hash) {
        self.history.scan = Some(Scan {
            generation: self.store_generation,
            lo,
            hi,
            lo_chain,
            hi_chain,
            cursor: lo,
            running: lo_chain,
            first_prev: None,
            call: None,
            found: Found::default(),
        });
        self.history_read_page();
    }

    fn history_read_page(&mut self) {
        let Some(s) = &self.history.scan else { return };
        let (after, limit) = (s.cursor, (s.hi - s.cursor).min(PAGE));
        let call = self.queue(LogRequest::Read(ReadParams {
            collection: self.cfg.collection,
            after,
            limit,
            kinds: None,
            max_bytes: self.read_bytes(),
        }));
        self.inflight.insert(call, super::append::Inflight::History);
        if let Some(s) = &mut self.history.scan {
            s.call = Some(call);
        }
    }

    /// A page of the current scan.
    pub(crate) fn on_history_reply(&mut self, id: CallId, reply: LogReply) {
        let Some(mut scan) = self.history.scan.take() else {
            return;
        };
        if scan.call != Some(id) || scan.generation != self.store_generation {
            self.history.scan = Some(scan);
            return;
        }
        scan.call = None;
        let r = match reply {
            Ok(LogResponse::Read(r)) => r,
            Ok(_) => {
                self.history.failure = Some(integrity("unexpected read response"));
                return;
            }
            Err(e) => {
                self.history.failure = Some(offline(&e));
                return;
            }
        };
        if let Some(index) = &mut self.history.index {
            index.retained_from = r.retained_from;
        }
        if r.behind {
            // The range was compacted meanwhile. Below the floor, start the next
            // range at the new compaction point; at the head, rebuild.
            if scan.lo_chain.is_some() {
                self.history.index = None;
            }
            return;
        }
        if let Err(e) = self.history_scan_page(&mut scan, &r) {
            self.history.failure = Some(e);
            return;
        }
        if scan.cursor < scan.hi {
            if r.items.is_empty() {
                self.history.failure = Some(integrity("the log ends below a verified position"));
                return;
            }
            self.history.scan = Some(scan);
            self.history_read_page();
            return;
        }
        if scan.running != Some(scan.hi_chain) {
            self.history.failure = Some(integrity("range does not reach the verified chain"));
            return;
        }
        self.history_commit(scan);
    }

    fn history_scan_page(&self, scan: &mut Scan, r: &ReadResult) -> ApiResult<()> {
        for it in &r.items {
            if it.seq > scan.hi {
                break;
            }
            if it.seq != scan.cursor + 1 {
                return Err(integrity("positions are not consecutive"));
            }
            let raw = &it.item.0;
            let item = Item::from_bytes(raw).map_err(|_| integrity("an item does not decode"))?;
            if item.seq != Some(it.seq) {
                return Err(integrity("an item names another position"));
            }
            match scan.running {
                Some(c) if item.prev != Some(c) => {
                    return Err(integrity("an item does not link to its predecessor"));
                }
                Some(_) => {}
                None => {
                    scan.first_prev =
                        Some(item.prev.ok_or_else(|| integrity("an item has no prev"))?);
                }
            }
            let chain = mdbn_wire::hash::chain_hash(raw);
            scan.cursor = it.seq;
            scan.running = Some(chain);
            self.history_index_item(it.seq, chain, &item, raw, &mut scan.found)?;
        }
        Ok(())
    }

    /// The versions in one item. Items that do not open, decode or attribute
    /// add nothing; only a delta-encoded record text refuses the scan.
    fn history_index_item(
        &self,
        seq: u64,
        chain: Hash,
        item: &Item,
        raw: &[u8],
        found: &mut Found,
    ) -> ApiResult<()> {
        if item.kind != ItemKind::Entry || item.collection != self.cfg.collection {
            return Ok(());
        }
        let env = crate::policy::Env {
            verifier: self.sealer.verifier(),
            trusted_roots: &self.cfg.trusted_roots,
            policy_pins: self.cfg.policy_pins.as_ref(),
        };
        // A device ever enrolled, active or not: policy is never compacted.
        let Some(device) = item
            .signer
            .and_then(|s| self.policy.devices.get(&s).map(|d| (s, d)))
        else {
            return Ok(());
        };
        if !self.policy.observed_signature_valid(item, &env)
            || matches!(device.1.kind, DeviceKind::Escrow | DeviceKind::Recovery)
        {
            return Ok(());
        }
        let plain = match self.sealer.open(item, raw) {
            Ok(p) => p,
            Err(OpenError::NoKey) => {
                found.sealed = Some((seq, chain));
                return Ok(());
            }
            Err(OpenError::Aead) => return Ok(()),
        };
        let Ok(payload) = rt::EntryPayload::from_bytes(&plain) else {
            return Ok(());
        };
        let grant = payload.mutation.on_behalf;
        if let Some(g) = grant
            && !self.policy.grants.get(&g).is_some_and(|g| {
                g.account == device.1.account || device.1.kind == DeviceKind::Hosted
            })
        {
            return Ok(());
        }
        let Some(changes) = record_changes(&payload)? else {
            return Ok(());
        };
        found.entries.push((
            seq,
            Entry {
                time: payload.mutation.clock.instant,
                device: device.0,
                device_kind: device.1.kind,
                account: device.1.account,
                grant,
                source: payload.mutation.source,
                chain,
            },
        ));
        for (id, (hint, change)) in changes {
            found.rows.push((id, Row { seq, hint, change }));
        }
        Ok(())
    }

    /// Merge a verified range into the index.
    fn history_commit(&mut self, scan: Scan) {
        let Some(index) = &mut self.history.index else {
            return;
        };
        let Found {
            entries,
            rows,
            sealed,
        } = scan.found;
        // Scans read upwards, so a range's first entry is its oldest.
        if let Some((seq, entry)) = entries.first()
            && index.oldest.is_none_or(|(o, _)| *seq < o)
        {
            index.oldest = Some((*seq, entry.time));
        }
        index.entries.extend(entries);
        for (id, row) in rows {
            let list = index.records.entry(id).or_default();
            list.push(row);
            list.sort_by_key(|r| r.seq);
        }
        if scan.lo_chain.is_some() {
            index.top = scan.hi;
            index.top_chain = scan.hi_chain;
        } else {
            index.floor = scan.lo;
            index.floor_chain = scan.first_prev.unwrap_or(scan.hi_chain);
        }
        if let Some((seq, chain)) = sealed {
            // History is complete only above the newest item this device cannot open.
            index.floor = index.floor.max(seq);
            index.floor_chain = chain;
            index.sealed = true;
            index.entries = index.entries.split_off(&(seq + 1));
            for list in index.records.values_mut() {
                list.retain(|r| r.seq > seq);
            }
            index.records.retain(|_, list| !list.is_empty());
            if index.oldest.is_some_and(|(o, _)| o <= seq) {
                index.oldest = index.entries.iter().next().map(|(s, e)| (*s, e.time));
            }
        }
    }

    /// `record_history` (§4.4).
    pub(crate) fn history_page(
        &mut self,
        session: SessionId,
        params: RecordHistoryParams,
    ) -> ApiResult<RecordHistory> {
        self.history_supported()?;
        self.require(session, crate::policy::capability::HISTORY)?;
        self.history_prepare()?;
        if !self.history_at_head() {
            return Err(loading());
        }
        let limit = usize::try_from(params.limit.unwrap_or(DEFAULT_LIMIT)).unwrap_or(usize::MAX);
        let Some(index) = &self.history.index else {
            return Err(loading());
        };
        let before = params.before.unwrap_or(u64::MAX).min(index.top + 1);
        let rows: Vec<&Row> = index
            .records
            .get(&params.record)
            .map(|list| list.iter().filter(|r| r.seq < before).collect())
            .unwrap_or_default();
        let next = if rows.len() >= limit {
            let oldest = rows[rows.len() - limit].seq;
            (rows.len() > limit || !index.exhausted()).then_some(oldest)
        } else if index.exhausted() {
            None
        } else if before.saturating_sub(index.floor + 1) >= SPAN {
            Some(index.floor + 1)
        } else {
            if self.history.scan.is_none() {
                self.history_extend_down();
            }
            return Err(loading());
        };
        let start = rows.len().saturating_sub(limit);
        let all: Vec<&Row> = index
            .records
            .get(&params.record)
            .map(|l| l.iter().collect())
            .unwrap_or_default();
        let versions = rows[start..]
            .iter()
            .rev()
            .map(|row| {
                let previous = all.iter().take_while(|r| r.seq < row.seq).last().copied();
                self.history_version_view(index, row, previous)
            })
            .collect();
        Ok(RecordHistory {
            versions,
            from: index.floor + 1,
            from_time: index.oldest.map(|(_, t)| t),
            next,
        })
    }

    fn history_version_view(
        &self,
        index: &Index,
        row: &Row,
        previous: Option<&Row>,
    ) -> HistoryVersion {
        let entry = &index.entries[&row.seq];
        let path_of = |c: &Change| match c {
            Change::Put { path, .. } | Change::Remove { path } => path.clone(),
        };
        let (kind, path, revision) = match &row.change {
            Change::Remove { path } => (VersionKind::Deleted, path.clone(), None),
            Change::Put { path, revision } => {
                let kind = match previous.map(|p| &p.change) {
                    _ if row.hint == Hint::Created => VersionKind::Created,
                    Some(Change::Remove { .. }) => VersionKind::Created,
                    Some(p) if path_of(p) != *path => VersionKind::Moved,
                    None if row.hint == Hint::Renamed => VersionKind::Moved,
                    _ => VersionKind::Edited,
                };
                (kind, path.clone(), Some(*revision))
            }
        };
        let grant = entry
            .grant
            .and_then(|g| self.policy.grants.get(&g).map(|s| (g, s)));
        HistoryVersion {
            seq: row.seq,
            time: entry.time,
            author: AuthorRef {
                account: entry.account,
                device: entry.device,
                grant: entry.grant,
                grant_account: grant
                    .filter(|_| entry.device_kind == DeviceKind::Hosted)
                    .map(|(_, g)| g.account),
            },
            kind,
            path,
            revision,
            source: entry.source,
            device_kind: entry.device_kind,
            app: grant.map(|(_, g)| g.app_id.clone()),
        }
    }

    /// `record_version` (§4.4).
    pub(crate) fn history_version(
        &mut self,
        session: SessionId,
        params: RecordVersionParams,
    ) -> ApiResult<RecordVersion> {
        self.history_supported()?;
        self.require(session, crate::policy::capability::HISTORY)?;
        let RecordVersionParams { record, seq } = params;
        if let Some(i) = self
            .history
            .versions
            .iter()
            .position(|j| j.record == record && j.seq == seq && j.done.is_some())
        {
            let job = self.history.versions.remove(i);
            return job.done.expect("checked done");
        }
        self.history_prepare()?;
        if seq > self.head.seq {
            return Err(not_found("version_not_found", "no such version"));
        }
        if !self.history_at_head() {
            return Err(loading());
        }
        let Some(index) = &self.history.index else {
            return Err(loading());
        };
        if seq <= index.floor {
            if index.exhausted() {
                return Err(not_found(
                    "version_compacted",
                    "the log no longer retains this version",
                ));
            }
            self.history_extend_down();
            return Err(loading());
        }
        let listed = index
            .records
            .get(&record)
            .and_then(|l| l.iter().find(|r| r.seq == seq))
            .is_some_and(|r| matches!(r.change, Change::Put { .. }));
        if !listed {
            return Err(not_found(
                "version_not_found",
                "no such version of this record",
            ));
        }
        if let Some(j) = self
            .history
            .versions
            .iter_mut()
            .find(|j| j.record == record && j.seq == seq)
        {
            if j.call.is_some_and(|c| !self.inflight.contains_key(&c)) {
                j.call = None;
                j.blob = None;
            }
            if j.call.is_none() {
                self.history_version_step(record, seq);
            }
            return Err(loading());
        }
        if self.history.versions.len() >= MAX_VERSION_JOBS {
            // A finished read whose caller went away gives its slot up.
            let Some(k) = self.history.versions.iter().position(|j| j.done.is_some()) else {
                return Err(loading());
            };
            self.history.versions.remove(k);
        }
        self.history.versions.push(VersionJob {
            generation: self.store_generation,
            record,
            seq,
            call: None,
            blob: None,
            done: None,
        });
        self.history_version_step(record, seq);
        Err(loading())
    }

    /// Send a version job's next read: its entry, or its blob's next part.
    fn history_version_step(&mut self, record: Uuid, seq: u64) {
        let Some(i) = self
            .history
            .versions
            .iter()
            .position(|j| j.record == record && j.seq == seq)
        else {
            return;
        };
        let request = match &self.history.versions[i].blob {
            None => LogRequest::Read(ReadParams {
                collection: self.cfg.collection,
                after: seq - 1,
                limit: 1,
                kinds: None,
                max_bytes: None,
            }),
            Some((_, _, reader)) => match reader.need() {
                Ok(Some(SourceNeed::BlobPart { address, .. })) => LogRequest::GetObject {
                    collection: self.cfg.collection,
                    address,
                    range: None,
                },
                _ => {
                    self.history.versions[i].done = Some(Err(text_unavailable()));
                    return;
                }
            },
        };
        let call = self.queue(request);
        self.inflight
            .insert(call, super::append::Inflight::HistoryVersion);
        self.history.versions[i].call = Some(call);
    }

    /// A version job's entry read or blob part.
    pub(crate) fn on_history_version_reply(&mut self, id: CallId, reply: LogReply) {
        let Some(i) = self
            .history
            .versions
            .iter()
            .position(|j| j.call == Some(id))
        else {
            return;
        };
        self.history.versions[i].call = None;
        let (record, seq) = (
            self.history.versions[i].record,
            self.history.versions[i].seq,
        );
        let outcome = if self.history.versions[i].blob.is_some() {
            self.history_version_blob(i, reply)
        } else {
            self.history_version_entry(i, reply)
        };
        match outcome {
            Some(done) => self.history.versions[i].done = Some(done),
            None => self.history_version_step(record, seq),
        }
    }

    /// The version's entry: its inline document, or `None` once a blob read starts.
    fn history_version_entry(
        &mut self,
        i: usize,
        reply: LogReply,
    ) -> Option<ApiResult<RecordVersion>> {
        let (record, seq) = (
            self.history.versions[i].record,
            self.history.versions[i].seq,
        );
        let r = match reply {
            Ok(LogResponse::Read(r)) => r,
            Ok(_) => return Some(Err(integrity("unexpected read response"))),
            Err(e) => return Some(Err(offline(&e))),
        };
        if r.behind {
            return Some(Err(not_found(
                "version_compacted",
                "the log no longer retains this version",
            )));
        }
        let expected = self
            .history
            .index
            .as_ref()
            .and_then(|x| x.entries.get(&seq))
            .map(|e| e.chain);
        let Some(it) = r.items.first().filter(|it| it.seq == seq) else {
            return Some(Err(integrity("the version's entry is missing")));
        };
        let raw = &it.item.0;
        if expected != Some(mdbn_wire::hash::chain_hash(raw)) {
            return Some(Err(integrity("the version's entry changed")));
        }
        let opened = Item::from_bytes(raw)
            .ok()
            .and_then(|item| self.sealer.open(&item, raw).ok())
            .and_then(|plain| rt::EntryPayload::from_bytes(&plain).ok())
            .and_then(|p| version_doc(&p, &record));
        let Some((path, doc)) = opened else {
            return Some(Err(
                ErrorCode::Internal.err("an indexed version no longer opens")
            ));
        };
        let revision = self.history_row_revision(&record, seq);
        match doc {
            Doc::Inline(document) => Some(checked(path, document, revision)),
            Doc::Blob(blob) => {
                if blob.size > MAX_BLOB_TEXT || Some(blob.plain_hash) != revision {
                    return Some(Err(text_unavailable()));
                }
                let reader = match FileSourceReader::new(
                    &*self.sealer,
                    FileContent::Blob(blob.clone()),
                    MAX_BLOB_TEXT,
                ) {
                    Ok(reader) => reader,
                    Err(_) => return Some(Err(text_unavailable())),
                };
                self.history.versions[i].blob = Some((path, blob.plain_hash, reader));
                None
            }
        }
    }

    /// One blob part of a version's text; `None` while parts remain.
    fn history_version_blob(
        &mut self,
        i: usize,
        reply: LogReply,
    ) -> Option<ApiResult<RecordVersion>> {
        let (bytes, size) = match reply {
            Ok(LogResponse::GetObject { bytes, size, .. }) => (bytes, size),
            Ok(_) => return Some(Err(text_unavailable())),
            Err(LogError::Service {
                code: crate::log::LogErrorCode::NotFound,
                ..
            }) => {
                return Some(Err(text_unavailable()));
            }
            Err(e) => return Some(Err(offline(&e))),
        };
        let sealer = &*self.sealer;
        let job = &mut self.history.versions[i];
        let (_, _, reader) = job.blob.as_mut()?;
        if size != bytes.len() as u64 {
            return Some(Err(text_unavailable()));
        }
        let supplied = match reader.need() {
            Ok(Some(need)) => reader.supply(sealer, need, &bytes),
            _ => return Some(Err(text_unavailable())),
        };
        if supplied.is_err() {
            return Some(Err(text_unavailable()));
        }
        if !matches!(reader.need(), Ok(None)) {
            return None;
        }
        let (path, revision, reader) = job.blob.take()?;
        let Ok(proof) = reader.finish() else {
            return Some(Err(text_unavailable()));
        };
        let Ok(document) = String::from_utf8(proof.bytes().to_vec()) else {
            return Some(Err(text_unavailable()));
        };
        Some(checked(path, document, Some(revision)))
    }

    fn history_row_revision(&self, record: &Uuid, seq: u64) -> Option<Hash> {
        self.history
            .index
            .as_ref()?
            .records
            .get(record)?
            .iter()
            .find(|r| r.seq == seq)
            .and_then(|r| match &r.change {
                Change::Put { revision, .. } => Some(*revision),
                Change::Remove { .. } => None,
            })
    }
}

fn text_unavailable() -> ApiError {
    not_found(
        "version_text_unavailable",
        "the version's blob text is missing or does not authenticate",
    )
}

/// The document, if it hashes to the revision the index listed.
fn checked(path: String, document: String, revision: Option<Hash>) -> ApiResult<RecordVersion> {
    if Some(crate::convert::whash(&mdbn_core::ids::revision(&document))) != revision {
        return Err(ErrorCode::Internal.err("a version's text does not match its revision"));
    }
    Ok(RecordVersion { path, document })
}
