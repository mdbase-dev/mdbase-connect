//! `LogCache`: the shared SQL schema as a **log-derived, disposable cache**.
//!
//! The hosted replica (one Cloudflare Durable Object per collection) keeps its
//! confirmed state in DO SQLite, whose synchronous commits are atomic but not
//! confirmed durable when they return. That is acceptable only for state that can
//! be rebuilt from the log: the hosted replica's `HostedCache` keeps everything
//! accepted-but-unlogged (pending rows, keys, pre-log receipts) in RAM, and a lost
//! or dropped cache is rebuilt from a snapshot plus the log tail.
//!
//! `LogCache` is a separate type so that this relaxation never reaches a device:
//! [`crate::SqlStore::open`] still refuses a Disposable index. `LogCache` accepts
//! an index of either durability and claims neither: callers must treat every
//! commit as possibly lost on a crash, and only the hosted replica composes it.

use std::cell::RefCell;
use std::ops::Range;
use std::rc::Rc;

use mdbn_replica::store::{
    AliasRow, Candidate, CommitReport, ConflictRow, FileRow, Head, LocalReceipt, Page, PendingRow,
    ReceiptRow, RecordRow, Store, StoreResult, TombstoneRow, TransferRow, Tx,
};
use mdbn_wire::client::Hold;
use mdbn_wire::common::{Hash, Uuid};
use mdbn_wire::intent::FileInclusion;

use crate::index::IndexStorage;
use crate::sql::{SqlStore, SqlStoreLimits};

/// The shared SQL store as a disposable cache of the log (hosted replica only).
pub struct LogCache<I: IndexStorage>(SqlStore<I>);

impl<I: IndexStorage> std::fmt::Debug for LogCache<I> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("LogCache(..)")
    }
}

impl<I: IndexStorage> LogCache<I> {
    /// Open over `index` (Durable or Disposable); creates the schema.
    pub fn open(index: Rc<RefCell<I>>, limits: SqlStoreLimits) -> StoreResult<LogCache<I>> {
        SqlStore::open_schema(index, limits).map(LogCache)
    }

    /// The index (for maintenance and `reset` on rebuild).
    pub fn index(&self) -> Rc<RefCell<I>> {
        self.0.index()
    }
}

impl<I: IndexStorage> Store for LogCache<I> {
    fn head(&self) -> StoreResult<Head> {
        self.0.head()
    }
    fn record(&self, id: &Uuid) -> StoreResult<Option<RecordRow>> {
        self.0.record(id)
    }
    fn record_at(&self, path_key: &str) -> StoreResult<Option<Uuid>> {
        self.0.record_at(path_key)
    }
    fn records(&self, p: Page) -> StoreResult<Vec<RecordRow>> {
        self.0.records(p)
    }
    fn records_in_buckets(&self, range: Range<u32>, p: Page) -> StoreResult<Vec<RecordRow>> {
        self.0.records_in_buckets(range, p)
    }
    fn record_count(&self) -> StoreResult<u64> {
        self.0.record_count()
    }
    fn file(&self, id: &Uuid) -> StoreResult<Option<FileRow>> {
        self.0.file(id)
    }
    fn file_at(&self, path_key: &str) -> StoreResult<Option<Uuid>> {
        self.0.file_at(path_key)
    }
    fn files(&self, p: Page) -> StoreResult<Vec<FileRow>> {
        self.0.files(p)
    }
    fn files_in_buckets(&self, range: Range<u32>, p: Page) -> StoreResult<Vec<FileRow>> {
        self.0.files_in_buckets(range, p)
    }
    fn resource(&self, path: &str) -> StoreResult<Option<String>> {
        self.0.resource(path)
    }
    fn resources(&self) -> StoreResult<Vec<(String, String)>> {
        self.0.resources()
    }
    fn resource_paths_page(
        &self,
        page: mdbn_replica::store::ResourcePathPage<'_>,
    ) -> StoreResult<Vec<String>> {
        self.0.resource_paths_page(page)
    }
    fn resource_bounded(
        &self,
        path: &str,
        copy_limit: usize,
    ) -> StoreResult<Option<mdbn_replica::store::BoundedResource>> {
        self.0.resource_bounded(path, copy_limit)
    }
    fn settings(&self) -> StoreResult<Option<FileInclusion>> {
        self.0.settings()
    }
    fn tombstone(&self, id: &Uuid) -> StoreResult<Option<TombstoneRow>> {
        self.0.tombstone(id)
    }
    fn tombstones_at(&self, path_key: &str) -> StoreResult<Vec<TombstoneRow>> {
        self.0.tombstones_at(path_key)
    }
    fn tombstones(&self, p: Page) -> StoreResult<Vec<TombstoneRow>> {
        self.0.tombstones(p)
    }
    fn alias(&self, path_key: &str) -> StoreResult<Option<Uuid>> {
        self.0.alias(path_key)
    }
    fn aliases(&self) -> StoreResult<Vec<AliasRow>> {
        self.0.aliases()
    }
    fn conflicts(&self, of: Option<&Uuid>) -> StoreResult<Vec<ConflictRow>> {
        self.0.conflicts(of)
    }
    fn conflict_count(&self) -> StoreResult<u64> {
        self.0.conflict_count()
    }
    fn receipt(&self, mutation: &Uuid) -> StoreResult<Option<ReceiptRow>> {
        self.0.receipt(mutation)
    }
    fn receipts(&self, after: Option<Uuid>, limit: u32) -> StoreResult<Vec<ReceiptRow>> {
        self.0.receipts(after, limit)
    }
    fn referrers(&self, target_keys: &[String]) -> StoreResult<Vec<Uuid>> {
        self.0.referrers(target_keys)
    }
    fn unique_holders(&self, field: &str, value_key: &str) -> StoreResult<Vec<Uuid>> {
        self.0.unique_holders(field, value_key)
    }
    fn candidates(&self, q: &Candidate, p: Page) -> StoreResult<Vec<RecordRow>> {
        self.0.candidates(q, p)
    }
    fn pending(&self, after_order: Option<u64>, limit: u32) -> StoreResult<Vec<PendingRow>> {
        self.0.pending(after_order, limit)
    }
    fn pending_get(&self, mutation: &Uuid) -> StoreResult<Option<PendingRow>> {
        self.0.pending_get(mutation)
    }
    fn pending_count(&self) -> StoreResult<u64> {
        self.0.pending_count()
    }
    fn local_receipt(&self, mutation: &Uuid) -> StoreResult<Option<LocalReceipt>> {
        self.0.local_receipt(mutation)
    }
    fn holds(&self) -> StoreResult<Vec<Hold>> {
        self.0.holds()
    }
    fn hold(&self, id: &Uuid) -> StoreResult<Option<Hold>> {
        self.0.hold(id)
    }
    fn meta(&self, key: &str) -> StoreResult<Option<Vec<u8>>> {
        self.0.meta(key)
    }
    fn transfer(&self, id: &Uuid) -> StoreResult<Option<TransferRow>> {
        self.0.transfer(id)
    }
    fn transfer_chunk(&self, id: &Uuid, index: u64) -> StoreResult<Option<Vec<u8>>> {
        self.0.transfer_chunk(id, index)
    }
    fn blob_size(&self, digest: &Hash) -> StoreResult<Option<u64>> {
        self.0.blob_size(digest)
    }
    fn blob_read(&self, digest: &Hash, offset: u64, len: u64) -> StoreResult<Vec<u8>> {
        self.0.blob_read(digest, offset, len)
    }
    fn commit(&mut self, tx: Tx) -> StoreResult<CommitReport> {
        self.0.commit(tx)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::index::{Batch, IndexDurability, IndexError, IndexInfo, OpenState, StmtResult};
    use std::cell::Cell;

    struct Counting(Rc<Cell<u32>>, IndexDurability);
    impl IndexStorage for Counting {
        fn info(&self) -> IndexInfo {
            IndexInfo {
                durability: self.1,
                opened: OpenState::Fresh,
                sqlite_version: 0,
            }
        }
        fn run(&mut self, batch: &Batch) -> Result<Vec<StmtResult>, IndexError> {
            self.0.set(self.0.get() + 1);
            Ok(vec![StmtResult::default(); batch.stmts.len()])
        }
        fn reset(&mut self) -> Result<(), IndexError> {
            Ok(())
        }
    }

    #[test]
    fn only_the_typed_log_cache_opens_a_disposable_index() {
        let calls = Rc::new(Cell::new(0));
        let disposable = || {
            Rc::new(RefCell::new(Counting(
                calls.clone(),
                IndexDurability::Disposable,
            )))
        };
        assert!(SqlStore::open(disposable()).is_err(), "raw guard unchanged");
        assert_eq!(calls.get(), 0, "refused before any SQL");
        let cache = LogCache::open(disposable(), SqlStoreLimits::default());
        assert!(cache.is_ok());
        assert_eq!(calls.get(), 1, "schema created once");
        let bad = SqlStoreLimits {
            max_blob_bytes: 0,
            ..SqlStoreLimits::default()
        };
        assert!(
            LogCache::open(disposable(), bad).is_err(),
            "limits still checked"
        );
    }
}
