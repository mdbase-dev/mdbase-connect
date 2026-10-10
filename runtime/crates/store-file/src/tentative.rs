//! `TentativeStore`: the shared SQL schema for an **app-local replica** whose
//! storage cannot promise physical durability (the browser/PWA and Capacitor
//! WebView host: sqlite-wasm over OPFS `opfs-sahpool`, which reports
//! Disposable).
//!
//! It is a separate, typed composition, never a relabelled [`SqlStore`]:
//! [`SqlStore::open`] still refuses a Disposable index. Its contract
//! (local replica offline design):
//!
//! - **Pending is "not yet synced", kept as durably as the platform allows.**
//!   Unlike the hosted `HostedCache` (pending in RAM only), local pending
//!   mutations, their original IDs, intents, receipts and the snapshot-install
//!   staging are written to the same SQL database, and survive a reopen. The
//!   origin can still be evicted before they sync; the host says so. Only a
//!   log-confirmed receipt means saved: the store certifies nothing more.
//! - **No durability certificate.** A failed commit is never reported as
//!   [`StoreError::CommitAborted`] (which certifies the whole prior state
//!   durable): it is `Io`, an unknown outcome.
//! - **Uncertain operations fence.** After any error from the database (a
//!   COMMIT may apply before it throws), every later read and commit fails
//!   until the host reopens the store and the replica reconciles its receipts.
//! - **No key material.** The store declares
//!   [`KeyringPersistence::RebuildOnOpen`]: the replica never commits its epoch
//!   keyring here and rebuilds it from the log on each open. A commit carrying
//!   it is refused, and a database already holding one does not open.
//!
//! The raw [`SqlStore`] Disposable guard is unchanged.

use std::cell::RefCell;
use std::ops::Range;
use std::rc::Rc;

use mdbn_replica::store::{
    AliasRow, Candidate, CommitReport, ConflictRow, FileRow, Head, KeyringPersistence,
    LocalReceipt, Page, PendingRow, ReceiptRow, RecordRow, Store, StoreError, StoreResult,
    TombstoneRow, TransferRow, Tx, meta_keys,
};
use mdbn_wire::client::Hold;
use mdbn_wire::common::{Hash, Uuid};
use mdbn_wire::intent::FileInclusion;

use crate::index::{IndexDurability, IndexStorage};
use crate::sql::{SqlStore, SqlStoreLimits};

/// The app-local replica's SQL store (see the module docs).
pub struct TentativeStore<I: IndexStorage> {
    inner: SqlStore<I>,
    durability: IndexDurability,
    /// Why the store is fenced, once an operation's outcome is unknown.
    fenced: RefCell<Option<String>>,
}

impl<I: IndexStorage> std::fmt::Debug for TentativeStore<I> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TentativeStore")
            .field("durability", &self.durability)
            .field("fenced", &self.fenced.borrow().is_some())
            .finish()
    }
}

impl<I: IndexStorage> TentativeStore<I> {
    /// Open over `index` (Disposable or Durable) and create the schema. Refuses
    /// a database that holds the epoch keyring.
    pub fn open(index: Rc<RefCell<I>>, limits: SqlStoreLimits) -> StoreResult<TentativeStore<I>> {
        let durability = index.borrow().info().durability;
        let inner = SqlStore::open_schema(index, limits)?;
        if inner.meta(meta_keys::KEYRING)?.is_some() {
            return Err(StoreError::Corrupt(
                "the app store holds key material at rest; drop and rebuild it".into(),
            ));
        }
        Ok(TentativeStore {
            inner,
            durability,
            fenced: RefCell::new(None),
        })
    }

    /// What the index reported at open. Disposable is expected for OPFS.
    pub fn durability(&self) -> IndexDurability {
        self.durability
    }

    /// Why the store is fenced (`None`: usable). A fenced store must be dropped
    /// and reopened; the replica then reconciles receipts by original ID.
    pub fn fenced(&self) -> Option<String> {
        self.fenced.borrow().clone()
    }

    /// The index (for the host's integrity checks).
    pub fn index(&self) -> Rc<RefCell<I>> {
        self.inner.index()
    }

    fn check(&self) -> StoreResult<()> {
        match &*self.fenced.borrow() {
            Some(why) => Err(StoreError::Io(format!(
                "app store fenced ({why}): reopen and reconcile"
            ))),
            None => Ok(()),
        }
    }

    /// Fence on any error: its outcome is unknown, and never certified.
    fn guard<T>(&self, r: StoreResult<T>) -> StoreResult<T> {
        r.map_err(|e| {
            let msg = e.to_string();
            self.fenced.borrow_mut().get_or_insert(msg.clone());
            match e {
                StoreError::CommitAborted(m) => StoreError::Io(format!("app store: {m}")),
                e => e,
            }
        })
    }
}

macro_rules! read {
    ($self:ident . $f:ident ( $($a:expr),* )) => {{
        $self.check()?;
        $self.guard($self.inner.$f($($a),*))
    }};
}

impl<I: IndexStorage> Store for TentativeStore<I> {
    fn head(&self) -> StoreResult<Head> {
        read!(self.head())
    }
    fn record(&self, id: &Uuid) -> StoreResult<Option<RecordRow>> {
        read!(self.record(id))
    }
    fn record_at(&self, path_key: &str) -> StoreResult<Option<Uuid>> {
        read!(self.record_at(path_key))
    }
    fn records(&self, p: Page) -> StoreResult<Vec<RecordRow>> {
        read!(self.records(p))
    }
    fn records_in_buckets(&self, range: Range<u32>, p: Page) -> StoreResult<Vec<RecordRow>> {
        read!(self.records_in_buckets(range, p))
    }
    fn record_count(&self) -> StoreResult<u64> {
        read!(self.record_count())
    }
    fn file(&self, id: &Uuid) -> StoreResult<Option<FileRow>> {
        read!(self.file(id))
    }
    fn file_at(&self, path_key: &str) -> StoreResult<Option<Uuid>> {
        read!(self.file_at(path_key))
    }
    fn files(&self, p: Page) -> StoreResult<Vec<FileRow>> {
        read!(self.files(p))
    }
    fn files_in_buckets(&self, range: Range<u32>, p: Page) -> StoreResult<Vec<FileRow>> {
        read!(self.files_in_buckets(range, p))
    }
    fn resource(&self, path: &str) -> StoreResult<Option<String>> {
        read!(self.resource(path))
    }
    fn resources(&self) -> StoreResult<Vec<(String, String)>> {
        read!(self.resources())
    }
    fn resource_paths_page(
        &self,
        page: mdbn_replica::store::ResourcePathPage<'_>,
    ) -> StoreResult<Vec<String>> {
        read!(self.resource_paths_page(page))
    }
    fn resource_bounded(
        &self,
        path: &str,
        copy_limit: usize,
    ) -> StoreResult<Option<mdbn_replica::store::BoundedResource>> {
        read!(self.resource_bounded(path, copy_limit))
    }
    fn settings(&self) -> StoreResult<Option<FileInclusion>> {
        read!(self.settings())
    }
    fn tombstone(&self, id: &Uuid) -> StoreResult<Option<TombstoneRow>> {
        read!(self.tombstone(id))
    }
    fn tombstones_at(&self, path_key: &str) -> StoreResult<Vec<TombstoneRow>> {
        read!(self.tombstones_at(path_key))
    }
    fn tombstones(&self, p: Page) -> StoreResult<Vec<TombstoneRow>> {
        read!(self.tombstones(p))
    }
    fn alias(&self, path_key: &str) -> StoreResult<Option<Uuid>> {
        read!(self.alias(path_key))
    }
    fn aliases(&self) -> StoreResult<Vec<AliasRow>> {
        read!(self.aliases())
    }
    fn conflicts(&self, of: Option<&Uuid>) -> StoreResult<Vec<ConflictRow>> {
        read!(self.conflicts(of))
    }
    fn conflict_count(&self) -> StoreResult<u64> {
        read!(self.conflict_count())
    }
    fn receipt(&self, mutation: &Uuid) -> StoreResult<Option<ReceiptRow>> {
        read!(self.receipt(mutation))
    }
    fn receipts(&self, after: Option<Uuid>, limit: u32) -> StoreResult<Vec<ReceiptRow>> {
        read!(self.receipts(after, limit))
    }
    fn referrers(&self, target_keys: &[String]) -> StoreResult<Vec<Uuid>> {
        read!(self.referrers(target_keys))
    }
    fn unique_holders(&self, field: &str, value_key: &str) -> StoreResult<Vec<Uuid>> {
        read!(self.unique_holders(field, value_key))
    }
    fn candidates(&self, q: &Candidate, p: Page) -> StoreResult<Vec<RecordRow>> {
        read!(self.candidates(q, p))
    }
    fn query_index_state(&self) -> StoreResult<Option<mdbn_replica::store_query::QueryIndexState>> {
        read!(self.query_index_state())
    }
    fn query_index_page(
        &self,
        request: &mdbn_replica::store_query::QueryIndexRequest,
    ) -> StoreResult<Option<mdbn_replica::store_query::QueryIndexPage>> {
        read!(self.query_index_page(request))
    }
    fn hydrate_query_at(
        &self,
        ids: &[Uuid],
        head: Head,
        budget: &mut mdbn_replica::store_query::QueryBudget,
    ) -> StoreResult<Vec<RecordRow>> {
        read!(self.hydrate_query_at(ids, head, budget))
    }
    fn query_record_sizes_at(
        &self,
        page: Page,
        head: Head,
    ) -> StoreResult<Vec<mdbn_replica::store_query::QueryRecordSize>> {
        read!(self.query_record_sizes_at(page, head))
    }
    fn pending(&self, after_order: Option<u64>, limit: u32) -> StoreResult<Vec<PendingRow>> {
        read!(self.pending(after_order, limit))
    }
    fn pending_get(&self, mutation: &Uuid) -> StoreResult<Option<PendingRow>> {
        read!(self.pending_get(mutation))
    }
    fn pending_count(&self) -> StoreResult<u64> {
        read!(self.pending_count())
    }
    fn local_receipt(&self, mutation: &Uuid) -> StoreResult<Option<LocalReceipt>> {
        read!(self.local_receipt(mutation))
    }
    fn holds(&self) -> StoreResult<Vec<Hold>> {
        read!(self.holds())
    }
    fn hold(&self, id: &Uuid) -> StoreResult<Option<Hold>> {
        read!(self.hold(id))
    }
    fn meta(&self, key: &str) -> StoreResult<Option<Vec<u8>>> {
        if key == meta_keys::KEYRING {
            self.check()?;
            return Ok(None);
        }
        read!(self.meta(key))
    }
    fn transfer(&self, id: &Uuid) -> StoreResult<Option<TransferRow>> {
        read!(self.transfer(id))
    }
    fn transfer_chunk(&self, id: &Uuid, index: u64) -> StoreResult<Option<Vec<u8>>> {
        read!(self.transfer_chunk(id, index))
    }
    fn blob_size(&self, digest: &Hash) -> StoreResult<Option<u64>> {
        read!(self.blob_size(digest))
    }
    fn blob_read(&self, digest: &Hash, offset: u64, len: u64) -> StoreResult<Vec<u8>> {
        read!(self.blob_read(digest, offset, len))
    }
    fn tail(&self, after: u64, limit: u32) -> StoreResult<Vec<mdbn_replica::store::TailRow>> {
        read!(self.tail(after, limit))
    }
    fn tail_stats(&self) -> StoreResult<mdbn_replica::store::TailStats> {
        read!(self.tail_stats())
    }
    fn own_retained(&self, after: u64, limit: u32) -> StoreResult<Vec<(u64, PendingRow)>> {
        read!(self.own_retained(after, limit))
    }

    fn commit(&mut self, tx: Tx) -> StoreResult<CommitReport> {
        self.check()?;
        if tx.meta.iter().any(|(k, _)| k == meta_keys::KEYRING) {
            // Refused before anything runs: the store is unchanged, so this is
            // the one error that does not fence.
            return Err(StoreError::Io(
                "the app store never holds the keyring (KeyringPersistence::RebuildOnOpen)".into(),
            ));
        }
        let r = self.inner.commit(tx);
        self.guard(r)
    }

    fn stages(&self) -> bool {
        self.inner.stages()
    }

    fn keyring_persistence(&self) -> KeyringPersistence {
        KeyringPersistence::RebuildOnOpen
    }
}
