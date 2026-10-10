//! Owned projection test backend over real signed MemStore authority. Snapshot
//! raw materialization occurs before execution; guarded warm reads never parse
//! or hydrate other sources. SQLite transaction behavior is qualified separately.
use super::*;
use crate::store::*;
use crate::store_query::*;
use mdbn_wire::{
    client::Hold,
    common::{Hash, Uuid},
    intent::FileInclusion,
};
use std::ops::Range;
#[derive(Clone)]
pub(super) struct ProjectionStore {
    pub inner: MemStore,
    pub generation: [u8; 32],
    pub head: Head,
    pub raw: Rc<BTreeMap<Uuid, QueryProjectionRow>>,
    pub maps: Rc<BTreeMap<Uuid, mdbn_core::value::Map>>,
    pub selected: Uuid,
    pub reads: Rc<Cell<usize>>,
    pub pages: Rc<Cell<usize>>,
    pub fail_page: Rc<Cell<usize>>,
    pub ready: Rc<Cell<bool>>,
    pub armed: Rc<Cell<bool>>,
}
macro_rules! forward {
    ($($name:ident($($arg:ident:$ty:ty),*)->$out:ty;)+)=> {$(
        fn $name(&self,$($arg:$ty),*)->$out {self.inner.$name($($arg),*)}
    )+};
}
impl Store for ProjectionStore {
    forward! {
        head()->StoreResult<Head>;
        record(id:&Uuid)->StoreResult<Option<RecordRow>>;
        record_at(key:&str)->StoreResult<Option<Uuid>>;
        records_in_buckets(range:Range<u32>,page:Page)->StoreResult<Vec<RecordRow>>;
        record_count()->StoreResult<u64>;
        file(id:&Uuid)->StoreResult<Option<FileRow>>;
        file_at(key:&str)->StoreResult<Option<Uuid>>;
        files(page:Page)->StoreResult<Vec<FileRow>>;
        files_in_buckets(range:Range<u32>,page:Page)->StoreResult<Vec<FileRow>>;
        resource(path:&str)->StoreResult<Option<String>>;
        resources()->StoreResult<Vec<(String,String)>>;
        settings()->StoreResult<Option<FileInclusion>>;
        tombstone(id:&Uuid)->StoreResult<Option<TombstoneRow>>;
        tombstones_at(key:&str)->StoreResult<Vec<TombstoneRow>>;
        tombstones(page:Page)->StoreResult<Vec<TombstoneRow>>;
        alias(key:&str)->StoreResult<Option<Uuid>>;
        aliases()->StoreResult<Vec<AliasRow>>;
        conflicts(of:Option<&Uuid>)->StoreResult<Vec<ConflictRow>>;
        conflict_count()->StoreResult<u64>;
        receipt(id:&Uuid)->StoreResult<Option<ReceiptRow>>;
        receipts(after:Option<Uuid>,limit:u32)->StoreResult<Vec<ReceiptRow>>;
        referrers(keys:&[String])->StoreResult<Vec<Uuid>>;
        unique_holders(field:&str,key:&str)->StoreResult<Vec<Uuid>>;
        candidates(q:&Candidate,page:Page)->StoreResult<Vec<RecordRow>>;
        pending(after:Option<u64>,limit:u32)->StoreResult<Vec<PendingRow>>;
        pending_get(id:&Uuid)->StoreResult<Option<PendingRow>>;
        pending_count()->StoreResult<u64>;
        local_receipt(id:&Uuid)->StoreResult<Option<LocalReceipt>>;
        holds()->StoreResult<Vec<Hold>>;
        hold(id:&Uuid)->StoreResult<Option<Hold>>;
        meta(key:&str)->StoreResult<Option<Vec<u8>>>;
        transfer(id:&Uuid)->StoreResult<Option<TransferRow>>;
        transfer_chunk(id:&Uuid,index:u64)->StoreResult<Option<Vec<u8>>>;
        blob_size(digest:&Hash)->StoreResult<Option<u64>>;
        blob_read(digest:&Hash,offset:u64,len:u64)->StoreResult<Vec<u8>>;
        tail(after:Seq,limit:u32)->StoreResult<Vec<TailRow>>;
        tail_stats()->StoreResult<TailStats>;
        own_retained(after:Seq,limit:u32)->StoreResult<Vec<(Seq,PendingRow)>>;
    }
    fn records(&self, page: Page) -> StoreResult<Vec<RecordRow>> {
        assert!(
            !self.armed.get(),
            "warm executor must not request source inventory"
        );
        self.inner.records(page)
    }
    fn commit(&mut self, tx: Tx) -> StoreResult<CommitReport> {
        self.inner.commit(tx)
    }
    fn keyring_persistence(&self) -> KeyringPersistence {
        self.inner.keyring_persistence()
    }
    fn hydrate_query_at(
        &self,
        ids: &[Uuid],
        head: Head,
        budget: &mut QueryBudget,
    ) -> StoreResult<Vec<RecordRow>> {
        if self.armed.get() {
            assert_eq!(
                ids,
                &[self.selected],
                "warm executor hydrated unrelated source"
            );
            self.reads.set(self.reads.get() + 1);
        }
        self.inner.hydrate_query_at(ids, head, budget)
    }
    fn query_record_sizes_at(&self, page: Page, head: Head) -> StoreResult<Vec<QueryRecordSize>> {
        assert!(
            !self.armed.get(),
            "warm executor must not enumerate source sizes"
        );
        self.inner.query_record_sizes_at(page, head)
    }
    fn query_projection_state(&self) -> StoreResult<Option<QueryProjectionState>> {
        Ok(Some(QueryProjectionState {
            generation: self.generation,
            head: self.inner.head()?,
            ready: self.ready.get() && self.head == self.inner.head()?,
        }))
    }
    fn query_projection_page(
        &self,
        request: &QueryProjectionRequest,
    ) -> StoreResult<QueryProjectionPage> {
        request.check()?;
        let n = self.pages.get() + 1;
        self.pages.set(n);
        if n == self.fail_page.get() {
            return Err(StoreError::Io("owned projection page fault".into()));
        }
        assert_eq!(request.predicate, QueryPredicate::All);
        if request.generation != self.generation || request.head != self.head || !self.ready.get() {
            return Err(StoreError::Io("owned snapshot drift".into()));
        }
        let mut page = QueryProjectionPage::default();
        for (id, row) in self.raw.iter().filter(|(id, _)| {
            request.after.is_none_or(|after| **id > after)
                && request
                    .bases_records
                    .as_ref()
                    .is_none_or(|ids| ids.binary_search(id).is_ok())
        }) {
            if page.rows.len() == request.limit as usize {
                page.has_more = true;
                break;
            }
            let billed = 256 + row.path.len() as u64 + request.fields.len() as u64 * 256;
            if page.encoded_bytes + billed > request.max_bytes {
                if page.rows.is_empty() {
                    return Err(StoreError::Full);
                }
                page.has_more = true;
                break;
            }
            let mut row = row.clone();
            row.fields = request
                .fields
                .iter()
                .map(|name| {
                    self.maps[id]
                        .get(name)
                        .map_or(RawField::Missing, |value| RawField::Present(value.clone()))
                })
                .collect();
            if !request.tags {
                row.tags = None;
            }
            page.encoded_bytes += billed;
            page.rows.push(row);
        }
        page.check(request)
            .map_err(|reason| StoreError::Corrupt(reason.into()))?;
        Ok(page)
    }
}
