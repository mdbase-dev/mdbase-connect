//! Hosted mode: the replica as a disposable cache of the log.
//!
//! Devices are offline-first: a submit persists a pending row and answers `pending`,
//! and the append loop takes it to the log later. The hosted replica (one per
//! cloud-copy collection) instead treats its store as a **disposable projection of
//! the log**. Its rules:
//!
//! 1. **Log-ACK barrier.** An app write is acknowledged only after its log append
//!    succeeded and was applied, or with a definitive pre-log rejection. Hosts submit
//!    through [`Replica::submit_logged`] and receive outcomes from
//!    [`Replica::take_acks`]; the generic [`crate::ClientApi::submit`] refuses, so a
//!    `pending` answer is never mistaken for an accepted write.
//! 2. **Nothing accepted-but-unlogged is persisted.** [`HostedCache`] keeps pending
//!    rows and pre-log (rejected) local receipts in RAM. The wrapped store only ever
//!    receives state derived from the log (confirmed rows, log-derived receipts).
//! 3. **Unknown append outcomes.** While the replica lives, the sealed batch stays in
//!    RAM and is resent byte-identical (the append loop's `RetryAt`/reconnect path).
//!    After a cold restart the mutation is found in the log by catching up (and the
//!    log's idempotency token turns a re-planned copy into `duplicate`), never
//!    re-applied. A write that may have landed never gets a definitive failure.
//! 4. **Log-derived receipt ownership.** Every applied entry records a confirmed local
//!    receipt owned by its authenticated `on_behalf` grant (policy V6 binds it to the
//!    signer), so a cold rebuild from the tail restores grant-isolated receipts.
//!    Receipts that arrived only in a snapshot carry no owner: the replica reads the
//!    entry at that position back, verifies it (signature, AEAD, mutation ID) and
//!    records its owner; meanwhile it answers `unavailable`, and `outcome_unknown` if
//!    the log no longer retains the entry — never `mutation_id_in_use` for a
//!    mutation that may be the caller's.
//! 5. **Rebuild before serve.** After open (a cache drop is an open over an empty
//!    store) no session is served until the replica has caught up with the log head,
//!    including any snapshot install. This is a catch-up gate only; it is not the
//!    verified-admission observer, which hosts must still pin separately.
//!
//! The profile is fixed at open: only [`Replica::open_hosted`] builds a hosted
//! replica, and only it can construct a [`HostedCache`]. Devices never enter it.

use std::collections::{BTreeMap, BTreeSet};
use std::ops::Range;

use mdbn_wire::client::{Hold, Receipt, ReceiptState};
use mdbn_wire::common::{Hash, Uuid};
use mdbn_wire::entry::EntryPayload;
use mdbn_wire::envelope::{Item, ItemKind};
use mdbn_wire::intent::FileInclusion;
use mdbn_wire::log_service::ReadParams;
use mdbn_wire::schema::Wire;

use super::append::Inflight;
use super::{DeviceSecrets, Host, OpenError, Replica, ReplicaConfig};
use crate::api::{ApiError, ApiResult, ErrorCode, SessionId};
use crate::log::{LogReply, LogRequest, LogResponse};
use crate::plan::Planner;
use crate::seal::Sealer;
use crate::store::{
    AliasRow, Candidate, CommitReport, ConflictRow, FileRow, Head, LocalReceipt, Page, PendingRow,
    ReceiptRow, RecordRow, Seq, Store, StoreError, StoreResult, TailRow, TailStats, TombstoneRow,
    TransferRow, Tx, meta_keys,
};

/// Hosted-mode limits on RAM-only state. At a limit, `submit_logged` answers
/// `rate_limited` before capturing anything (backpressure, never a dropped write).
///
/// **Hard bound** on pending-row bytes: `max_pending × max_row_bytes` — every row,
/// new or re-planned, is refused above `max_row_bytes`. `max_pending_bytes` is a
/// **soft admission budget**: new mutations are refused while the total would exceed
/// it, but a re-plan of a held row is kept (refusing it would strand a write that may
/// already be in flight) even if the total then exceeds it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HostedProfile {
    /// Unlogged mutations held in RAM at once.
    pub max_pending: u64,
    /// Soft admission budget: encoded bytes of those mutations (mutation, planned
    /// effects, touch keys).
    pub max_pending_bytes: u64,
    /// Hard cap on one encoded pending row, new or re-planned.
    pub max_row_bytes: u64,
    /// Open tickets plus completed acks not yet taken.
    pub max_tickets: u64,
    /// Pre-log (rejected) receipts kept in RAM; the oldest go first. Losing one only
    /// means a retry of that never-captured write is planned again.
    pub max_unlogged_receipts: u64,
}

impl Default for HostedProfile {
    fn default() -> HostedProfile {
        HostedProfile {
            // Hard bound 64 × 2 MiB = 128 MiB; hosts pin their own envelope.
            max_pending: 64,
            max_pending_bytes: 16 << 20,
            max_row_bytes: 2 << 20,
            max_tickets: 1_000,
            max_unlogged_receipts: 10_000,
        }
    }
}

/// A submission awaiting its log outcome ([`Replica::submit_logged`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct SubmitTicket(pub u64);

/// The outcome of a ticket: one receipt per submitted mutation, each `confirmed`
/// (appended and applied), `rejected` (definitively never appended) or `unknown`
/// (the mutation is in the log but its owner can no longer be proven). A `dry_run`
/// ticket completes at once with the planner's `pending` receipts and records: a
/// preview, never a write acceptance (nothing was captured).
#[derive(Debug, Clone, PartialEq)]
pub struct HostedAck {
    /// The ticket.
    pub ticket: SubmitTicket,
    /// The session that submitted.
    pub session: SessionId,
    /// Receipts, in submission order. Never `pending`, except for a `dry_run` preview.
    pub receipts: Vec<Receipt>,
}

#[derive(Debug)]
struct Ticket {
    session: SessionId,
    receipts: Vec<Receipt>,
    open: BTreeSet<Uuid>,
}

/// Owner lookup of a snapshot-installed receipt.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Lookup {
    InFlight,
    /// The log no longer retains a verifiable entry at that position.
    Unresolvable,
}

/// Hosted-mode state of a replica. RAM only.
#[derive(Debug, Default)]
pub(crate) struct HostedState {
    profile: HostedProfile,
    rebuilt: bool,
    next_ticket: u64,
    tickets: BTreeMap<SubmitTicket, Ticket>,
    waiting: BTreeMap<Uuid, BTreeSet<SubmitTicket>>,
    acks: Vec<HostedAck>,
    lookups: BTreeMap<Uuid, Lookup>,
    /// While `submit_logged` captures: outcomes reached before its ticket exists.
    capturing: Option<BTreeMap<Uuid, Receipt>>,
    /// Warm wake: the control prefix being re-verified into a fresh policy state.
    keys: Option<KeyRebuild>,
    /// The cache disagreed with the log's control prefix: drop it and reopen.
    needs_reset: bool,
    /// The head (position, chain) fetched over the authenticated channel in this
    /// instance since the last fault.
    head_seen: Option<(u64, mdbn_wire::common::Hash)>,
    /// Bumped on every fault/transport event: a fresh fetch belongs to one generation.
    generation: u64,
    /// When this generation became Ready: (fetched head, applied head).
    ready_at: Option<(
        (u64, mdbn_wire::common::Hash),
        (u64, mdbn_wire::common::Hash),
    )>,
    /// Where the current policy state came from (crate-private origin fact).
    origin: PolicyOrigin,
    /// Head fetches in flight, by call ID, with the generation that queued them.
    /// Cleared on every fault; an entry leaves when its fetch is answered or fails.
    /// A fetch not listed never counts.
    fetches: BTreeMap<u64, u64>,
}

/// Crate-private currentness fact for the verified-admission observer (trust
/// assumption: the log service is trusted for ordering and head). In wake
/// `instance` (a fresh nonce per open) and fault generation `generation`, a head
/// was fetched over the authenticated channel (`fetched`) and this replica had
/// applied through `applied` (>= fetched, same chain at equality) when it became
/// Ready. Generation numbers mean nothing across instances.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[allow(dead_code)]
pub(crate) struct FreshHead {
    pub(crate) instance: u64,
    pub(crate) generation: u64,
    pub(crate) fetched: (u64, mdbn_wire::common::Hash),
    pub(crate) applied: (u64, mdbn_wire::common::Hash),
}

/// Crate-private origin fact for the current policy state. Never the cached
/// `POLICY` bits on their own.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
#[allow(dead_code)]
pub(crate) enum PolicyOrigin {
    /// Not established (e.g. installed from a snapshot, or a rebuild in progress).
    #[default]
    Unproven,
    /// Built in this instance by applying every item from genesis (cold, head 0).
    Genesis,
    /// Warm wake: every control item through `target` re-evaluated into a fresh
    /// state in this instance, equal to the cache's policy at `target`; later items
    /// applied normally.
    Replayed {
        /// The cache's head at open.
        target: u64,
    },
}

/// Warm-wake key rebuild (hosted mode). Keys live only in RAM, so a reopen over a
/// persisted cache (head > 0) has none. Every control item up to the cache's head
/// is read again (`kinds = control`) and evaluated into a FRESH policy state with
/// full signature/certificate checks; rekeys and key grants re-deliver the keys.
/// The result must equal the cache's persisted policy at its head, else the cache
/// is not trusted (the host drops it and rebuilds from the log).
#[derive(Debug)]
pub(crate) struct KeyRebuild {
    /// Next read starts after this position.
    after: u64,
    /// The cache's head at open.
    target: u64,
    /// The cache's persisted policy at `target`.
    persisted: Option<Vec<u8>>,
    /// A read is outstanding.
    reading: bool,
}

/// Control items per rebuild read. Item count only: the log caps a read at 8 MiB
/// and has no byte-limit parameter yet, so the byte budget is the host's response
/// bound until the log offers one.
const KEY_REBUILD_PAGE: u64 = 64;

/// Item-byte budget a hosted replica asks for on each paged log read (logsvc
/// `read.max_bytes`, interface note 2026-10-05-logsvc-read-byte-budget.md): the DO
/// apply budget. Soft: the service still returns an oversized first item alone, and
/// servers without the field ignore it, so it bounds memory per read but replaces no
/// apply-side check. Apply stays one item per store commit either way.
pub(crate) const HOSTED_READ_BYTES: u64 = 512 << 10;

impl HostedState {
    /// Record a final receipt for every ticket waiting on its mutation.
    fn resolve(&mut self, r: &Receipt) {
        if r.state == ReceiptState::Pending {
            return;
        }
        if let Some(c) = self.capturing.as_mut() {
            c.insert(r.mutation, r.clone());
        }
        let Some(tickets) = self.waiting.remove(&r.mutation) else {
            return;
        };
        for t in tickets {
            let Some(ticket) = self.tickets.get_mut(&t) else {
                continue;
            };
            for slot in ticket
                .receipts
                .iter_mut()
                .filter(|s| s.mutation == r.mutation)
            {
                *slot = r.clone();
            }
            ticket.open.remove(&r.mutation);
            if ticket.open.is_empty()
                && let Some(done) = self.tickets.remove(&t)
            {
                self.acks.push(HostedAck {
                    ticket: t,
                    session: done.session,
                    receipts: done.receipts,
                });
            }
        }
    }
}

/// Entries an owner lookup may read to chain a position to the applied head.
const OWNER_LOOKUP_WINDOW: u64 = 256;
/// Owner lookups remembered at once (in flight or settled unresolvable).
const MAX_OWNER_LOOKUPS: usize = 1024;

/// The bytes at `seq`, if `items` run contiguously from `seq` to `head.seq` and each
/// item's `prev` is the chain hash of the one before, ending at `head.chain`.
fn chained_to(items: &[mdbn_wire::log_service::SeqItem], seq: u64, head: Head) -> Option<&[u8]> {
    let n = usize::try_from(head.seq.checked_sub(seq)? + 1).ok()?;
    let run = items.get(..n)?;
    let mut chain = None;
    for (i, it) in run.iter().enumerate() {
        if it.seq != seq + i as u64 {
            return None;
        }
        if let Some(c) = chain {
            let item = Item::from_bytes(&it.item.0).ok()?;
            if item.prev != Some(c) {
                return None;
            }
        }
        chain = Some(mdbn_wire::hash::chain_hash(&it.item.0));
    }
    (chain? == head.chain).then(|| run[0].item.0.as_slice())
}

/// The receipt for a mutation whose ID the log already holds for another client.
pub(crate) fn in_use_receipt(id: Uuid) -> Receipt {
    let mut p = ErrorCode::InvalidRequest.problem("this mutation ID belongs to another client");
    p.reason = Some("mutation_id_in_use".into());
    Receipt {
        relocated_from: None,
        mutation: id,
        state: ReceiptState::Rejected,
        seq: None,
        status: None,
        conflicts: None,
        records: None,
        problem: Some(p),
        published: None,
    }
}

fn unknown_receipt(id: Uuid) -> Receipt {
    let mut p = ErrorCode::OutcomeUnknown
        .problem("the mutation is in the log but its owner can no longer be verified");
    p.reason = Some("receipt_owner_unknown".into());
    Receipt {
        relocated_from: None,
        mutation: id,
        state: ReceiptState::Unknown,
        seq: None,
        status: None,
        conflicts: None,
        records: None,
        problem: Some(p),
        published: None,
    }
}

// ------------------------------------------------------------------ the cache

/// The hosted replica's store: a log-derived cache over `S`, with every piece of
/// accepted-but-unlogged state (pending rows, pre-log rejections) and the epoch
/// keyring held in RAM.
///
/// Built only by [`Replica::open_hosted`]. Dropping it loses exactly the state that
/// was never acknowledged, plus the keys (which the host re-supplies from KMS in the
/// sealer it opens with); everything `S` holds can be rebuilt from the log. Parts of
/// a transaction the hosted cache cannot hold (upload transfers, blob bytes, disk
/// holds) are refused, never silently dropped or persisted.
pub struct HostedCache<S: Store> {
    inner: S,
    pending: BTreeMap<u64, PendingRow>,
    pending_ids: BTreeMap<Uuid, u64>,
    pending_sizes: BTreeMap<u64, u64>,
    pending_bytes: u64,
    unlogged_receipts: BTreeMap<Uuid, LocalReceipt>,
    max_unlogged_receipts: u64,
    max_pending_bytes: u64,
    max_row_bytes: u64,
    keyring: Option<zeroize::Zeroizing<Vec<u8>>>,
}

impl<S: Store> std::fmt::Debug for HostedCache<S> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HostedCache")
            .field("pending", &self.pending.len())
            .field("unlogged_receipts", &self.unlogged_receipts.len())
            .finish_non_exhaustive()
    }
}

impl<S: Store> HostedCache<S> {
    pub(crate) fn new(inner: S, profile: &HostedProfile) -> HostedCache<S> {
        HostedCache {
            inner,
            pending: BTreeMap::new(),
            pending_ids: BTreeMap::new(),
            pending_sizes: BTreeMap::new(),
            pending_bytes: 0,
            unlogged_receipts: BTreeMap::new(),
            max_unlogged_receipts: profile.max_unlogged_receipts,
            max_pending_bytes: profile.max_pending_bytes,
            max_row_bytes: profile.max_row_bytes,
            keyring: None,
        }
    }

    /// Encoded bytes of the RAM pending rows.
    pub fn pending_bytes(&self) -> u64 {
        self.pending_bytes
    }

    fn drop_order(&mut self, order: u64) -> Option<PendingRow> {
        let row = self.pending.remove(&order)?;
        self.pending_ids.remove(&row.mutation.id);
        let size = self.pending_sizes.remove(&order).unwrap_or(0);
        self.pending_bytes = self.pending_bytes.saturating_sub(size);
        Some(row)
    }

    /// The wrapped (log-derived) store.
    pub fn inner(&self) -> &S {
        &self.inner
    }

    /// The wrapped store, mutably, for store-specific maintenance. Never commit
    /// through it.
    pub fn inner_mut(&mut self) -> &mut S {
        &mut self.inner
    }

    /// Unwrap, discarding the RAM-only state.
    pub fn into_inner(self) -> S {
        self.inner
    }

    fn del_pending(&mut self, id: &Uuid) {
        if let Some(order) = self.pending_ids.get(id).copied() {
            self.drop_order(order);
        }
    }
}

impl<S: Store> Store for HostedCache<S> {
    fn head(&self) -> StoreResult<Head> {
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
    fn records_in_buckets(&self, range: Range<u32>, page: Page) -> StoreResult<Vec<RecordRow>> {
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
    fn files_in_buckets(&self, range: Range<u32>, page: Page) -> StoreResult<Vec<FileRow>> {
        self.inner.files_in_buckets(range, page)
    }
    fn resource(&self, path: &str) -> StoreResult<Option<String>> {
        self.inner.resource(path)
    }
    fn resources(&self) -> StoreResult<Vec<(String, String)>> {
        self.inner.resources()
    }
    fn resource_paths_page(
        &self,
        page: crate::store::ResourcePathPage<'_>,
    ) -> StoreResult<Vec<String>> {
        self.inner.resource_paths_page(page)
    }
    fn resource_bounded(
        &self,
        path: &str,
        copy_limit: usize,
    ) -> StoreResult<Option<crate::store::BoundedResource>> {
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
    ) -> StoreResult<Option<crate::store_query::QueryProjectionState>> {
        self.inner.query_projection_state()
    }
    fn query_projection_page(
        &self,
        request: &crate::store_query::QueryProjectionRequest,
    ) -> StoreResult<crate::store_query::QueryProjectionPage> {
        self.inner.query_projection_page(request)
    }
    fn query_index_supported(&self) -> bool {
        self.inner.query_index_supported()
    }
    fn query_index_state(&self) -> StoreResult<Option<crate::store_query::QueryIndexState>> {
        self.inner.query_index_state()
    }
    fn query_index_page(
        &self,
        request: &crate::store_query::QueryIndexRequest,
    ) -> StoreResult<Option<crate::store_query::QueryIndexPage>> {
        self.inner.query_index_page(request)
    }
    fn hydrate_query_at(
        &self,
        ids: &[Uuid],
        head: Head,
        budget: &mut crate::store_query::QueryBudget,
    ) -> StoreResult<Vec<RecordRow>> {
        self.inner.hydrate_query_at(ids, head, budget)
    }

    fn query_record_sizes_at(
        &self,
        page: Page,
        head: Head,
    ) -> StoreResult<Vec<crate::store_query::QueryRecordSize>> {
        self.inner.query_record_sizes_at(page, head)
    }
    fn pending(&self, after_order: Option<u64>, limit: u32) -> StoreResult<Vec<PendingRow>> {
        let lo = match after_order {
            Some(o) => std::ops::Bound::Excluded(o),
            None => std::ops::Bound::Unbounded,
        };
        Ok(self
            .pending
            .range((lo, std::ops::Bound::Unbounded))
            .take(usize::try_from(limit).unwrap_or(usize::MAX))
            .map(|(_, r)| r.clone())
            .collect())
    }
    fn pending_get(&self, mutation: &Uuid) -> StoreResult<Option<PendingRow>> {
        Ok(self
            .pending_ids
            .get(mutation)
            .and_then(|o| self.pending.get(o))
            .cloned())
    }
    fn pending_count(&self) -> StoreResult<u64> {
        Ok(self.pending.len() as u64)
    }
    fn local_receipt(&self, mutation: &Uuid) -> StoreResult<Option<LocalReceipt>> {
        // A log-derived receipt supersedes any pre-log decision.
        if let Some(r) = self.inner.local_receipt(mutation)? {
            return Ok(Some(r));
        }
        Ok(self.unlogged_receipts.get(mutation).cloned())
    }
    fn holds(&self) -> StoreResult<Vec<Hold>> {
        self.inner.holds()
    }
    fn hold(&self, id: &Uuid) -> StoreResult<Option<Hold>> {
        self.inner.hold(id)
    }
    fn meta(&self, key: &str) -> StoreResult<Option<Vec<u8>>> {
        if key == meta_keys::KEYRING {
            return Ok(self.keyring.as_ref().map(|k| k.to_vec()));
        }
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
    fn tail(&self, after: Seq, limit: u32) -> StoreResult<Vec<TailRow>> {
        self.inner.tail(after, limit)
    }
    fn tail_stats(&self) -> StoreResult<TailStats> {
        self.inner.tail_stats()
    }
    fn own_retained(&self, after: Seq, limit: u32) -> StoreResult<Vec<(Seq, PendingRow)>> {
        self.inner.own_retained(after, limit)
    }

    /// Commit the log-derived part to the wrapped store first; only once that is
    /// durable apply the RAM part, so a failed commit changes nothing here.
    fn commit(&mut self, mut tx: Tx) -> StoreResult<CommitReport> {
        if !tx.transfers_put.is_empty()
            || !tx.transfer_chunks.is_empty()
            || !tx.transfers_del.is_empty()
            || !tx.blob_parts.is_empty()
            || !tx.blobs_del.is_empty()
            || !tx.holds_put.is_empty()
        {
            // Not `CommitAborted`: that certifies the whole preceding state durable,
            // and this store's RAM part never is.
            return Err(StoreError::Io(
                "the hosted cache holds no transfers, blob bytes or disk holds".into(),
            ));
        }
        let mut keyring = None;
        tx.meta.retain_mut(|(k, v)| {
            if k == meta_keys::KEYRING {
                keyring = Some(v.take());
                false
            } else {
                true
            }
        });
        let pending_put = std::mem::take(&mut tx.pending_put);
        let pending_del = std::mem::take(&mut tx.pending_del);
        // Prospective byte budget over the FINAL RAM state of this commit (deletes,
        // same-ID and same-order replacements, new rows). A commit adding a new
        // mutation is refused before anything changes if it would end over budget.
        // Re-plans of held rows (no new mutation) are never refused: they can grow the
        // total, bounded by `max_pending` rows each below the 1 MiB entry limit, and
        // admission stays closed until the backlog drains under the budget.
        let mut after = self.pending_bytes;
        let mut gone: BTreeSet<u64> = BTreeSet::new();
        let drop_size = |order: u64, after: &mut u64, gone: &mut BTreeSet<u64>| {
            if gone.insert(order) {
                *after = after.saturating_sub(self.pending_sizes.get(&order).copied().unwrap_or(0));
            }
        };
        for id in &pending_del {
            if let Some(o) = self.pending_ids.get(id) {
                drop_size(*o, &mut after, &mut gone);
            }
        }
        let mut adds_new = false;
        for p in &pending_put {
            match self.pending_ids.get(&p.mutation.id) {
                Some(o) => drop_size(*o, &mut after, &mut gone),
                None => adds_new = true,
            }
            if self.pending.contains_key(&p.order) {
                drop_size(p.order, &mut after, &mut gone);
            }
            let size = p.to_bytes().len() as u64;
            if size > self.max_row_bytes {
                // Hard per-row cap, re-plans included. The row keeps its last plan;
                // the append loop plans afresh at the head anyway.
                return Err(StoreError::Full);
            }
            after = after.saturating_add(size);
        }
        if adds_new && after > self.max_pending_bytes {
            return Err(StoreError::Full);
        }
        let (logged, unlogged): (Vec<LocalReceipt>, Vec<LocalReceipt>) =
            std::mem::take(&mut tx.local_receipts_put)
                .into_iter()
                .partition(|r| r.state == ReceiptState::Confirmed);
        tx.local_receipts_put = logged;
        let logged_ids: Vec<Uuid> = tx.local_receipts_put.iter().map(|r| r.mutation).collect();
        let prune = tx.local_receipts_prune;
        let report = if tx.is_empty() {
            CommitReport::default()
        } else {
            // An inner `CommitAborted` certifies only the inner store; RAM state
            // (pending rows, keys) is never durable, so downgrade it (store.rs).
            self.inner.commit(tx).map_err(|e| match e {
                StoreError::CommitAborted(m) => StoreError::Io(format!("hosted cache: {m}")),
                e => e,
            })?
        };
        for id in &pending_del {
            self.del_pending(id);
        }
        for p in pending_put {
            let id = p.mutation.id;
            self.del_pending(&id);
            self.drop_order(p.order);
            let size = p.to_bytes().len() as u64;
            self.pending_ids.insert(id, p.order);
            self.pending_sizes.insert(p.order, size);
            self.pending_bytes = self.pending_bytes.saturating_add(size);
            self.pending.insert(p.order, p);
        }
        for r in unlogged {
            self.unlogged_receipts.insert(r.mutation, r);
        }
        while self.unlogged_receipts.len() as u64 > self.max_unlogged_receipts {
            let oldest = self
                .unlogged_receipts
                .values()
                .min_by_key(|r| (r.resolved_at, r.mutation))
                .map(|r| r.mutation);
            match oldest {
                Some(id) => self.unlogged_receipts.remove(&id),
                None => break,
            };
        }
        for id in logged_ids {
            self.unlogged_receipts.remove(&id);
        }
        if let Some(t) = prune {
            self.unlogged_receipts.retain(|_, r| r.resolved_at >= t);
        }
        if let Some(k) = keyring {
            self.keyring = k.map(zeroize::Zeroizing::new);
        }
        Ok(report)
    }

    fn has_files(&self) -> bool {
        self.inner.has_files()
    }
    fn stages(&self) -> bool {
        self.inner.stages()
    }
    fn disk_revision(&self, path: &str) -> StoreResult<Option<Hash>> {
        self.inner.disk_revision(path)
    }
    fn disk_paths(&self) -> StoreResult<Vec<(String, Hash)>> {
        self.inner.disk_paths()
    }
    fn observe(&mut self, paths: Option<&[String]>) -> StoreResult<Vec<crate::store::Observation>> {
        self.inner.observe(paths)
    }
}

// ------------------------------------------------------------------ the replica

impl<S: Store> Replica<HostedCache<S>> {
    /// Open the hosted replica of a collection over its log-derived cache `store`
    /// (empty after a cache drop). Pending and retry state live in RAM only, app
    /// writes are acknowledged only after the log append ([`Replica::submit_logged`]),
    /// and no session is served until the replica has caught up with the log.
    ///
    /// A store holding durable pending rows (a device store, or a legacy hosted
    /// database) is refused: those writes must be drained into the log first.
    pub fn open_hosted(
        cfg: ReplicaConfig,
        store: S,
        planner: Box<dyn Planner>,
        sealer: Box<dyn Sealer>,
        host: Host,
        secrets: DeviceSecrets,
        profile: HostedProfile,
    ) -> Result<Replica<HostedCache<S>>, OpenError> {
        if store.has_files() {
            return Err(OpenError::Mismatch(
                "a hosted cache is never a file-backed store".into(),
            ));
        }
        if store.meta(meta_keys::KEYRING)?.is_some() {
            return Err(OpenError::Mismatch(
                "the hosted cache holds key material at rest; drop and rebuild it".into(),
            ));
        }
        if store.pending_count()? > 0 {
            return Err(OpenError::Mismatch(
                "the hosted cache holds durable pending rows; drain them into the log first".into(),
            ));
        }
        if cfg.mode != mdbn_wire::client::SyncMode::Synced {
            return Err(OpenError::Mismatch(
                "a hosted replica is always synced".into(),
            ));
        }
        let mut r = Self::open_inner(
            cfg,
            HostedCache::new(store, &profile),
            planner,
            sealer,
            host,
            secrets,
            None,
        )?;
        let head = r.head.seq;
        let mut state = HostedState {
            profile,
            ..HostedState::default()
        };
        if head == 0 {
            // Cold: whatever policy bytes the cache holds are not provenance. Start
            // from a fresh state; every item is applied from genesis in this instance.
            r.policy = crate::policy::PolicyState::new();
            r.sealer.set_epoch(0);
            state.origin = PolicyOrigin::Genesis;
        } else {
            // Warm wake: nothing may run on the cached policy until the control
            // prefix has been re-verified and the keys re-derived from the log.
            state.keys = Some(KeyRebuild {
                after: 0,
                target: head,
                persisted: r.store.meta(meta_keys::POLICY)?,
                reading: false,
            });
            r.policy = crate::policy::PolicyState::new();
            r.sealer.set_epoch(0);
            r.calls.clear();
            r.inflight.clear();
        }
        // A cold open's head fetch was queued before hosted state existed: it is
        // this instance's generation-0 fetch.
        for (id, kind) in &r.inflight {
            if *kind == Inflight::Subscribe {
                state.fetches.insert(id.0, state.generation);
            }
        }
        r.hosted = Some(Box::new(state));
        r.hosted_key_rebuild_step();
        Ok(r)
    }

    /// Submit with the log-ACK barrier: capture and plan as `submit` does, but the
    /// outcome is delivered by [`Replica::take_acks`] only once every mutation is
    /// confirmed in the log or definitively rejected. Errors returned here mean
    /// nothing was captured.
    pub fn submit_logged(
        &mut self,
        session: SessionId,
        params: mdbn_wire::client::SubmitParams,
    ) -> ApiResult<SubmitTicket> {
        self.session(session)?;
        let (profile, outstanding) = {
            let h = self.hosted_state()?;
            (h.profile, (h.tickets.len() + h.acks.len()) as u64)
        };
        let pending = self
            .store
            .pending_count()
            .map_err(super::submit::store_err)?;
        let groups = split_groups(params, profile.max_pending.saturating_sub(pending))?;
        if outstanding >= profile.max_tickets
            || pending.saturating_add(groups.len() as u64) > profile.max_pending
            || self.store.pending_bytes() >= profile.max_pending_bytes
        {
            return Err(ErrorCode::RateLimited
                .err_with_reason("hosted_backlog", "too many writes awaiting the log"));
        }
        let dry_run = groups.first().is_some_and(|g| g.dry_run == Some(true));
        if let Some(h) = self.hosted.as_deref_mut() {
            h.capturing = Some(BTreeMap::new());
        }
        // One group at a time: a group that fails is not captured (its RAM row is
        // added only after a successful commit), so earlier groups keep their place
        // in the ticket and the failure is reported for that group alone.
        let mut receipts = Vec::with_capacity(groups.len());
        for (i, g) in groups.into_iter().enumerate() {
            let id = g.mutation_id;
            match self.submit_ops(session, g).map_err(hosted_budget) {
                Ok(mut r) => receipts.append(&mut r),
                Err(e) if i == 0 => {
                    if let Some(h) = self.hosted.as_deref_mut() {
                        h.capturing = None;
                    }
                    return Err(e);
                }
                Err(e) => {
                    let mutation = id.unwrap_or_else(|| self.mint_v7());
                    // A possibly-logged mutation (owner lookup pending or lost) is
                    // never reported as a definitive pre-log rejection.
                    let state = match e.code() {
                        Some(ErrorCode::OutcomeUnknown | ErrorCode::Unavailable) => {
                            ReceiptState::Unknown
                        }
                        _ => ReceiptState::Rejected,
                    };
                    receipts.push(Receipt {
                        relocated_from: None,
                        mutation,
                        state,
                        seq: None,
                        status: None,
                        conflicts: None,
                        records: None,
                        problem: Some(e.into_problem()),
                        published: None,
                    });
                }
            }
        }
        let h = self.hosted.as_deref_mut().ok_or_else(not_hosted)?;
        // Outcomes reached during capture (e.g. refused at head in the same pump).
        let early = h.capturing.take().unwrap_or_default();
        if !dry_run {
            for r in receipts.iter_mut() {
                if r.state == ReceiptState::Pending
                    && let Some(f) = early.get(&r.mutation)
                {
                    *r = f.clone();
                }
            }
        }
        h.next_ticket += 1;
        let ticket = SubmitTicket(h.next_ticket);
        let open: BTreeSet<Uuid> = if dry_run {
            BTreeSet::new()
        } else {
            receipts
                .iter()
                .filter(|r| r.state == ReceiptState::Pending)
                .map(|r| r.mutation)
                .collect()
        };
        if open.is_empty() {
            h.acks.push(HostedAck {
                ticket,
                session,
                receipts,
            });
            return Ok(ticket);
        }
        for id in &open {
            h.waiting.entry(*id).or_default().insert(ticket);
        }
        h.tickets.insert(
            ticket,
            Ticket {
                session,
                receipts,
                open,
            },
        );
        Ok(ticket)
    }

    /// Completed tickets, in completion order, delivered only while Ready. Acks of
    /// sessions that are gone, or whose grant is no longer served (revoked), are
    /// dropped: the outcome stays available to a fresh session through `receipt`.
    pub fn take_acks(&mut self) -> Vec<HostedAck> {
        // Not Ready (e.g. re-fetching the head after an unknown outcome): keep the
        // acks until it is, rather than dropping them as undeliverable.
        if !self.hosted_serving() {
            return Vec::new();
        }
        let acks = self
            .hosted
            .as_deref_mut()
            .map(|h| std::mem::take(&mut h.acks))
            .unwrap_or_default();
        acks.into_iter()
            .filter(|a| self.session_live(a.session))
            .collect()
    }

    /// The session exists and, for a grant, the grant is still active and served
    /// here (capability checks were made at submit).
    fn session_live(&self, s: SessionId) -> bool {
        let Ok(sess) = self.session(s) else {
            return false;
        };
        match &sess.auth {
            crate::api::SessionAuth::Host => true,
            crate::api::SessionAuth::Grant { grant, client_pk } => {
                self.grant_for_client(grant, client_pk)
                    .is_some_and(|g| self.serving_account_matches(&g.account))
                    && self.serves_apps().is_ok()
            }
        }
    }

    /// Tickets still awaiting the log.
    pub fn open_tickets(&self) -> usize {
        self.hosted.as_deref().map_or(0, |h| h.tickets.len())
    }

    fn hosted_state(&self) -> ApiResult<&HostedState> {
        self.hosted.as_deref().ok_or_else(not_hosted)
    }
}

/// One request per group: each op alone with `allow_partial`, else the whole request.
/// Ops and IDs are moved, never cloned per group; more groups than `max_groups` is
/// refused before any expansion.
fn split_groups(
    mut p: mdbn_wire::client::SubmitParams,
    max_groups: u64,
) -> ApiResult<Vec<mdbn_wire::client::SubmitParams>> {
    if p.allow_partial != Some(true) {
        return Ok(vec![p]);
    }
    if p.ops.len() as u64 > max_groups {
        return Err(ErrorCode::RateLimited
            .err_with_reason("hosted_backlog", "too many writes awaiting the log"));
    }
    let ops = std::mem::take(&mut p.ops);
    let ids = p.mutation_ids.take().unwrap_or_default();
    if !ids.is_empty() && ids.len() != ops.len() {
        return Err(ErrorCode::InvalidRequest.err("mutation_ids must have one ID per op"));
    }
    p.allow_partial = None;
    p.mutation_id = None;
    let mut ids = ids.into_iter();
    Ok(ops
        .into_iter()
        .map(|op| mdbn_wire::client::SubmitParams {
            ops: vec![op],
            mutation_id: ids.next(),
            ..p.clone()
        })
        .collect())
}

/// The cache refusing a new pending row over its byte budget (`StoreError::Full`
/// before anything changed) is backpressure, not a full device.
fn hosted_budget(e: ApiError) -> ApiError {
    if e.code() == Some(ErrorCode::QuotaExceeded) {
        return ErrorCode::RateLimited
            .err_with_reason("hosted_backlog", "too many writes awaiting the log");
    }
    e
}

fn not_hosted() -> ApiError {
    ErrorCode::Internal.err("not a hosted replica")
}

impl<S: Store> Replica<S> {
    /// Hosted mode: whether this replica serves sessions (it has rebuilt from the log
    /// since open and no snapshot install is running). Always true on devices.
    pub fn hosted_serving(&self) -> bool {
        match self.hosted.as_deref() {
            None => true,
            Some(h) => {
                h.rebuilt
                    && h.keys.is_none()
                    && !h.needs_reset
                    && self.install.is_none()
                    && self.stalled.is_none()
                    && !self.apply_fault
                    && !self.is_apply_recovering()
                    // Not while a newer reported head is still unapplied.
                    && self.head.seq >= self.head_known
                    && self.policy.cstate == Some(mdbn_wire::policy::CState::CloudCopy)
                    && self
                        .policy
                        .devices
                        .get(&self.cfg.device_id)
                        .is_some_and(|d| d.active)
            }
        }
    }

    /// Hosted mode: the cache disagrees with the log's control prefix (warm-wake
    /// check). The host must drop the cache (`IndexStorage::reset`) and reopen.
    pub fn hosted_needs_reset(&self) -> bool {
        self.hosted.as_deref().is_some_and(|h| h.needs_reset)
    }

    /// While the warm-wake key rebuild runs (hosted), or a device keyring
    /// rebuild (`key_rebuild.rs`), the replica neither reads nor appends.
    pub(crate) fn hosted_blocked(&self) -> bool {
        self.device_keys_blocked()
            || self
                .hosted
                .as_deref()
                .is_some_and(|h| h.keys.is_some() || h.needs_reset)
    }

    /// Queue the next control read of the warm-wake rebuild, if one is due.
    pub(crate) fn hosted_key_rebuild_step(&mut self) {
        self.device_key_rebuild_step();
        let Some(h) = self.hosted.as_deref_mut() else {
            return;
        };
        let Some(k) = h.keys.as_mut() else {
            return;
        };
        if k.reading {
            return;
        }
        k.reading = true;
        let after = k.after;
        let call = self.queue(LogRequest::Read(ReadParams {
            collection: self.cfg.collection,
            after,
            limit: KEY_REBUILD_PAGE,
            kinds: Some(mdbn_wire::log_service::ReadKinds::Control),
            max_bytes: Some(HOSTED_READ_BYTES),
        }));
        self.inflight.insert(call, Inflight::KeyRebuild);
    }

    /// A page of control items for the warm-wake rebuild.
    pub(crate) fn on_key_rebuild(&mut self, reply: LogReply) {
        if self.device_keys.is_some() {
            return self.on_device_key_rebuild(reply);
        }
        let Some((target, after)) = self.hosted.as_deref_mut().and_then(|h| {
            let k = h.keys.as_mut()?;
            k.reading = false;
            Some((k.target, k.after))
        }) else {
            return;
        };
        let r = match reply {
            Ok(LogResponse::Read(r)) => r,
            // Transport trouble: the next tick asks again.
            _ => return,
        };
        if r.head < target {
            // The log is behind this cache (lost tail or another log): never serve it.
            return self.hosted_reset_required("the log's head is below the cache's");
        }
        let mut last = None;
        let mut beyond = false;
        for it in &r.items {
            if it.seq > target {
                beyond = true;
                break;
            }
            if it.seq <= last.unwrap_or(after) {
                return self.hosted_reset_required("control items out of order");
            }
            // Cached GENESIS/POLICY metadata is not the raw identity of the log
            // being replayed. Check the host's pin before decoding or importing keys.
            if self.check_genesis(it.seq, &it.item.0).is_err() {
                self.genesis_fault();
                return;
            }
            let Ok(item) = Item::from_bytes(&it.item.0) else {
                return self.hosted_reset_required("control item does not decode");
            };
            if item.seq != Some(it.seq)
                || item.collection != self.cfg.collection
                || !item.kind.is_control()
            {
                return self.hosted_reset_required("not a control item of this collection");
            }
            let chain = mdbn_wire::hash::chain_hash(&it.item.0);
            if let Err(e) = self.evaluate_control(it.seq, &chain, &item, &it.item.0) {
                // A stall (e.g. a key not yet deliverable) or a refused item: the
                // cache cannot be confirmed against this prefix.
                let _ = e;
                return self.hosted_reset_required("control prefix does not verify");
            }
            last = Some(it.seq);
        }
        let done = beyond || !r.more || last.is_some_and(|l| l >= target);
        if !done && last.is_none() {
            // `more` with nothing usable: no progress is possible on this log.
            return self.hosted_reset_required("control read made no progress");
        }
        if let Some(l) = last
            && let Some(k) = self.hosted.as_deref_mut().and_then(|h| h.keys.as_mut())
        {
            k.after = l;
        }
        if !done {
            return self.hosted_key_rebuild_step();
        }
        // The fresh policy at the cache's head must be the one the cache holds.
        let persisted = self
            .hosted
            .as_deref_mut()
            .and_then(|h| h.keys.take())
            .and_then(|k| k.persisted);
        // Entries (not control items) also move a few counters in the policy state;
        // take those from the cache, then require everything else to match exactly.
        let Some(cached) = persisted
            .as_deref()
            .and_then(|b| crate::policy::PolicyState::from_bytes(b).ok())
        else {
            return self.hosted_reset_required("cache holds no readable policy");
        };
        if cached.seq != target {
            return self.hosted_reset_required("cached policy is not at the cache's head");
        }
        self.policy.seq = cached.seq;
        self.policy.sem_ratchet = cached.sem_ratchet;
        self.policy.log_time = cached.log_time;
        self.policy.content_seen = cached.content_seen;
        self.policy.voids = cached.voids;
        if self.policy.to_bytes().ok() != persisted {
            return self.hosted_reset_required("cached policy differs from the log's");
        }
        if let Some(h) = self.hosted.as_deref_mut() {
            h.origin = PolicyOrigin::Replayed { target };
        }
        self.queue_head_fetch();
    }

    fn hosted_reset_required(&mut self, why: &str) {
        if let Some(h) = self.hosted.as_deref_mut() {
            h.keys = None;
            h.needs_reset = true;
        }
        self.incident(
            mdbn_wire::client::IncidentKind::Integrity,
            Some(mdbn_wire::common::Value::Text(format!(
                "hosted cache: {why}"
            ))),
        );
    }

    /// The `read.max_bytes` for a paged read: the hosted budget, or none.
    pub(crate) fn read_bytes(&self) -> Option<u64> {
        self.is_hosted().then_some(HOSTED_READ_BYTES)
    }

    pub(crate) fn is_hosted(&self) -> bool {
        self.hosted.is_some()
    }

    /// Latch the rebuild gate once caught up with the log head.
    ///
    /// **Ready requires authenticated progress: the log service is trusted for
    /// ordering and head.** The replica has applied
    /// the log through a head fetched over the authenticated channel in this
    /// instance (a `subscribe` answered since open or since the last fault), the
    /// verified policy says this device is an active member of a cloud-copy
    /// collection, and the cache is not fenced. Any failed log call (unknown
    /// outcome, I/O), transport event, stall, fault or recovery drops Ready until a
    /// fresh head fetch has been answered and applied ([`Replica::hosted_stale`]).
    pub(crate) fn hosted_note_progress(&mut self) {
        let ready = self.caught_up
            && self.install.is_none()
            && self.stalled.is_none()
            && !self.apply_fault
            && !self.is_apply_recovering();
        let applied = self.head;
        if let Some(h) = self.hosted.as_deref_mut()
            && ready
            && let Some((seq, chain)) = h.head_seen
            // Applied through the fetched head, on the same chain.
            && (applied.seq > seq || (applied.seq == seq && applied.chain == chain))
        {
            if !h.rebuilt {
                h.ready_at = Some(((seq, chain), (applied.seq, applied.chain)));
            }
            h.rebuilt = true;
        }
    }

    /// The observer's fact: the fresh head this generation became Ready at.
    #[allow(dead_code)]
    pub(crate) fn hosted_fresh_head(&self) -> Option<FreshHead> {
        let h = self.hosted.as_deref()?;
        if !self.hosted_serving() {
            return None;
        }
        h.ready_at.map(|(fetched, applied)| FreshHead {
            instance: self.live.instance,
            generation: h.generation,
            fetched,
            applied,
        })
    }

    /// A snapshot install began: the policy origin is no longer a local replay.
    pub(crate) fn hosted_origin_unproven(&mut self) {
        if let Some(h) = self.hosted.as_deref_mut() {
            h.origin = PolicyOrigin::Unproven;
        }
    }

    /// The observer's origin fact for the current policy state.
    #[allow(dead_code)]
    pub(crate) fn hosted_policy_origin(&self) -> PolicyOrigin {
        match self.hosted.as_deref() {
            Some(h) if self.install.is_none() => h.origin,
            _ => PolicyOrigin::Unproven,
        }
    }

    /// A `subscribe` reply arrived: the head was fetched in this instance.
    pub(crate) fn hosted_head_seen(
        &mut self,
        call: crate::log::CallId,
        seq: u64,
        chain: mdbn_wire::common::Hash,
    ) {
        // Only a fetch queued in the current fault generation counts: a reply to a
        // request sent before the fault is not a fresh fence.
        if let Some(h) = self.hosted.as_deref_mut() {
            match h.fetches.remove(&call.0) {
                Some(g) if g == h.generation => {}
                _ => return,
            }
        }
        // A head below what this replica already applied (lost tail, another log)
        // is never a basis for Ready; the subscribe handler reports the regression.
        let applied = self.head;
        if seq < applied.seq || (seq == applied.seq && chain != applied.chain) {
            return;
        }
        if let Some(h) = self.hosted.as_deref_mut() {
            h.head_seen = Some((seq, chain));
        }
    }

    /// Hosted: a failed log call or transport event. Not Ready until a fresh head
    /// fetch has been answered and applied; one is queued unless already out.
    pub(crate) fn hosted_stale(&mut self) {
        let Some(h) = self.hosted.as_deref_mut() else {
            return;
        };
        h.rebuilt = false;
        h.head_seen = None;
        h.ready_at = None;
        h.generation += 1;
        // Every fetch still out belongs to an earlier generation and can never count.
        h.fetches.clear();
        if h.keys.is_some() || h.needs_reset {
            return;
        }
        // Always a NEW fetch for this generation (never reuse one already out).
        self.queue_head_fetch();
    }

    /// Queue a head fetch (`subscribe`). In hosted mode it is registered under the
    /// current fault generation, whichever path queues it (open, warm-key rebuild,
    /// reconnect, fault, install), so its answer can restore Ready.
    pub(crate) fn queue_head_fetch(&mut self) {
        let id = self.queue(LogRequest::Subscribe {
            collection: self.cfg.collection,
            after: self.head.seq,
            inline_bytes: None,
        });
        self.inflight.insert(id, Inflight::Subscribe);
        if let Some(h) = self.hosted.as_deref_mut() {
            h.fetches.insert(id.0, h.generation);
        }
    }

    /// A head fetch failed or was answered with the wrong shape: forget it.
    pub(crate) fn hosted_forget_fetch(&mut self, call: crate::log::CallId) {
        if let Some(h) = self.hosted.as_deref_mut() {
            h.fetches.remove(&call.0);
        }
    }

    /// A mutation left `pending` with this receipt: complete waiting tickets.
    pub(crate) fn hosted_resolve(&mut self, r: &Receipt) {
        if let Some(h) = self.hosted.as_deref_mut() {
            h.resolve(r);
        }
    }

    /// A session closed: forget its tickets (their mutations still go to the log;
    /// the outcome stays available through `receipt`).
    pub(crate) fn hosted_drop_session(&mut self, session: SessionId) {
        if let Some(h) = self.hosted.as_deref_mut() {
            let gone: Vec<SubmitTicket> = h
                .tickets
                .iter()
                .filter(|(_, t)| t.session == session)
                .map(|(id, _)| *id)
                .collect();
            for t in gone {
                h.tickets.remove(&t);
            }
            for set in h.waiting.values_mut() {
                set.retain(|t| h.tickets.contains_key(t));
            }
            h.waiting.retain(|_, set| !set.is_empty());
            h.acks.retain(|a| a.session != session);
        }
    }

    /// Hosted mode, granted viewer: a confirmed receipt whose owner the cache does not
    /// know (it came in a snapshot) is neither shown nor refused as another
    /// client's. Start an owner lookup and answer `unavailable`, or `outcome_unknown`
    /// once the log can no longer prove the owner.
    pub(crate) fn hosted_owner_check(&mut self, id: &Uuid, viewer: Option<Uuid>) -> ApiResult<()> {
        if self.hosted.is_none() || viewer.is_none() {
            return Ok(());
        }
        let store_err = super::submit::store_err;
        if self.store.pending_get(id).map_err(store_err)?.is_some()
            || self.store.local_receipt(id).map_err(store_err)?.is_some()
        {
            return Ok(());
        }
        let Some(r) = self.store.receipt(id).map_err(store_err)? else {
            return Ok(());
        };
        if self.hosted_lookup(*id, r.seq) == Some(Lookup::Unresolvable) {
            return Err(ErrorCode::OutcomeUnknown.err_with_reason(
                "receipt_owner_unknown",
                "the mutation is in the log but its owner can no longer be verified",
            ));
        }
        Err(ErrorCode::Unavailable.err_with_reason(
            "receipt_owner_pending",
            "verifying the mutation's owner from the log; retry",
        ))
    }

    /// Start (or report) the owner lookup of a mutation confirmed at `seq`.
    fn hosted_lookup(&mut self, id: Uuid, seq: u64) -> Option<Lookup> {
        let known = self.hosted.as_deref()?.lookups.get(&id).copied();
        if known.is_some() {
            return known;
        }
        if seq == 0 || seq > self.head.seq {
            return None;
        }
        // Bounded memo: forget a settled (unresolvable) entry to make room; with every
        // slot in flight, answer "pending" without starting another read.
        if let Some(h) = self.hosted.as_deref_mut()
            && h.lookups.len() >= MAX_OWNER_LOOKUPS
        {
            let settled = h
                .lookups
                .iter()
                .find(|(_, l)| **l == Lookup::Unresolvable)
                .map(|(k, _)| *k);
            match settled {
                Some(k) => {
                    h.lookups.remove(&k);
                }
                None => return Some(Lookup::InFlight),
            }
        }
        // The entry is proven to be the applied one only by chaining it to this
        // replica's own head; beyond a bounded window the owner stays unknown.
        let window = self.head.seq - seq + 1;
        if window > OWNER_LOOKUP_WINDOW {
            if let Some(h) = self.hosted.as_deref_mut() {
                h.lookups.insert(id, Lookup::Unresolvable);
            }
            return Some(Lookup::Unresolvable);
        }
        let call = self.queue(LogRequest::Read(ReadParams {
            collection: self.cfg.collection,
            after: seq - 1,
            limit: window,
            kinds: None,
            // Byte-bounded like every hosted read. The window must chain to the head
            // in one answer; one that does not fit the budget leaves the owner
            // unknown (`outcome_unknown`), never an unbounded proof read.
            max_bytes: Some(HOSTED_READ_BYTES),
        }));
        self.inflight
            .insert(call, Inflight::OwnerLookup(id, seq, self.head));
        if let Some(h) = self.hosted.as_deref_mut() {
            h.lookups.insert(id, Lookup::InFlight);
        }
        Some(Lookup::InFlight)
    }

    /// The entry at `seq`, read back for an owner lookup. Only an entry that verifies
    /// (active signer's signature, AEAD under a held key, the same mutation ID)
    /// becomes a log-derived receipt.
    pub(crate) fn on_owner_lookup(&mut self, id: Uuid, seq: u64, head: Head, reply: LogReply) {
        let verdict = match reply {
            Ok(LogResponse::Read(r)) if r.behind || r.retained_from > seq => {
                Err(Lookup::Unresolvable)
            }
            // Truncated before the head this replica applied: the window does not
            // fit the read budget, so the owner cannot be proven.
            Ok(LogResponse::Read(r))
                if r.more && r.items.last().is_none_or(|it| it.seq < head.seq) =>
            {
                Err(Lookup::Unresolvable)
            }
            Ok(LogResponse::Read(r)) => match chained_to(&r.items, seq, head) {
                Some(raw) => match self.verify_owner(raw, id, seq) {
                    Some(payload) => Ok(payload),
                    None => Err(Lookup::Unresolvable),
                },
                // Incomplete or not linking to the head this replica applied: never
                // elevate a rival candidate; the next ask looks again.
                None => return self.forget_lookup(&id),
            },
            // Transport trouble: forget, so the next ask retries.
            _ => return self.forget_lookup(&id),
        };
        match verdict {
            Ok(payload) => {
                self.forget_lookup(&id);
                let lr = LocalReceipt {
                    mutation: id,
                    state: ReceiptState::Confirmed,
                    seq: Some(seq),
                    status: Some(payload.status),
                    conflicts: payload.conflicts.clone().unwrap_or_default(),
                    problem: None,
                    resolved_at: self.now(),
                    grant: payload.mutation.on_behalf,
                };
                if self
                    .store
                    .commit(Tx {
                        local_receipts_put: vec![lr],
                        ..Tx::default()
                    })
                    .is_err()
                {
                    // Nothing recorded; a later ask looks it up again.
                }
            }
            Err(l) => {
                if let Some(h) = self.hosted.as_deref_mut() {
                    h.lookups.insert(id, l);
                }
            }
        }
    }

    /// Test only: fill the owner-lookup memo with `n` synthetic entries.
    #[cfg(test)]
    pub(crate) fn testing_fill_lookups(&mut self, n: usize, settled: bool) {
        if let Some(h) = self.hosted.as_deref_mut() {
            for i in 0..n {
                let mut id = [0xee; 16];
                id[..8].copy_from_slice(&(i as u64).to_be_bytes());
                let l = if settled {
                    Lookup::Unresolvable
                } else {
                    Lookup::InFlight
                };
                h.lookups.insert(mdbn_wire::common::B16(id), l);
            }
        }
    }

    /// Test only: head fetches tracked for the Ready gate.
    #[cfg(test)]
    pub(crate) fn testing_fetches(&self) -> usize {
        self.hosted.as_deref().map_or(0, |h| h.fetches.len())
    }

    /// Test only: entries in the owner-lookup memo.
    #[cfg(test)]
    pub(crate) fn testing_lookups(&self) -> usize {
        self.hosted.as_deref().map_or(0, |h| h.lookups.len())
    }

    fn forget_lookup(&mut self, id: &Uuid) {
        if let Some(h) = self.hosted.as_deref_mut() {
            h.lookups.remove(id);
        }
    }

    fn verify_owner(&self, raw: &[u8], id: Uuid, seq: u64) -> Option<EntryPayload> {
        let item = Item::from_bytes(raw).ok()?;
        if item.kind != ItemKind::Entry
            || item.collection != self.cfg.collection
            || item.seq != Some(seq)
        {
            return None;
        }
        let env = crate::policy::Env {
            verifier: self.sealer.verifier(),
            trusted_roots: &self.cfg.trusted_roots,
            policy_pins: self.cfg.policy_pins.as_ref(),
        };
        let signer = self.policy.check_device_signature(&item, &env).ok()?;
        let plain = self.sealer.open(&item, raw).ok()?;
        // Attachment entries decode but are not yet verifiable here: fail closed.
        let payload = super::attachment_runtime::entry(&plain)?;
        if payload.mutation.id != id {
            return None;
        }
        // The owner is the `on_behalf` grant, bound to its signer by V6. Recheck it
        // under the current policy; a grant or writer no longer valid fails closed.
        let store = &self.store;
        let path_key = |p: &str| mdbn_core::paths::path_key(p);
        let file_path = |f: &Uuid| store.file(f).ok().flatten().map(|f| f.path);
        let ctx = crate::policy::OpContext {
            path_key: &path_key,
            file_path: &file_path,
        };
        self.policy
            .check_entry_payload(&payload, &signer, &ctx)
            .ok()?;
        Some(payload)
    }

    /// Hosted mode, append loop: a pending row whose mutation the log already holds
    /// (a snapshot or catch-up carried it). Confirm it only for the grant the log
    /// names; refuse it as in use for another; with no known owner yet, look it up
    /// and keep the row (appending it again would only meet `duplicate`).
    pub(crate) fn hosted_resolve_logged(
        &mut self,
        id: Uuid,
        grant: Option<Uuid>,
        seq: u64,
    ) -> Result<(), StoreError> {
        match self.store.local_receipt(&id)? {
            Some(l) if l.state == ReceiptState::Confirmed && l.grant == grant => {
                self.resolve_confirmed_without_entry(id, seq)
            }
            Some(l) if l.state == ReceiptState::Confirmed => {
                self.hosted_drop_pending(id, in_use_receipt(id))
            }
            _ => match self.hosted_lookup(id, seq) {
                Some(Lookup::Unresolvable) => self.hosted_drop_pending(id, unknown_receipt(id)),
                _ => Ok(()),
            },
        }
    }

    /// Drop a pending row that will never be appended, answering waiting tickets and
    /// the submitter with `r` (not persisted: it is not a log-derived outcome).
    fn hosted_drop_pending(&mut self, id: Uuid, r: Receipt) -> Result<(), StoreError> {
        self.store.commit(Tx {
            pending_del: vec![id],
            ..Tx::default()
        })?;
        if let Some(s) = self.submitted_by.remove(&id) {
            self.pushes.push((s, crate::api::Push::Receipt(r.clone())));
        }
        self.hosted_resolve(&r);
        self.after_local_change()
    }
}
