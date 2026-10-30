//! Actual bundled SQLite through the shared binary ABI's unchanged 4MiB budget.
//! No physical-client/OPFS or managed-provider claim.
use super::*;
use mdbn_store_file::SqlStore;
use mdbn_store_file::index::{IndexError, IndexInfo, StmtResult};
use mdbn_store_file::index_codec::{
    CodecLimits, IndexReply, IndexRequest, decode_reply, decode_request, encode_reply,
    encode_request,
};
use mdbn_store_file::testing::{replica as r, wire as w};
use r::store::{Page, RecordMeta, RecordRow};
use w::common::B16;

const LIMITS: CodecLimits = CodecLimits {
    max_rows: 4096,
    ..CodecLimits::HOSTED
};
struct BudgetIndex {
    inner: SqliteIndex,
    reads: Rc<RefCell<Vec<String>>>,
    // Deliberately violates the owner contract on this SAME connection.
    before_group: Option<&'static str>,
    payload_reads: usize,
    sql_calls: usize,
}
impl IndexStorage for BudgetIndex {
    fn info(&self) -> IndexInfo {
        self.inner.info()
    }
    fn reset(&mut self) -> Result<(), IndexError> {
        self.inner.reset()
    }
    fn run(&mut self, batch: &Batch) -> Result<Vec<StmtResult>, IndexError> {
        self.sql_calls += 1;
        let full = || IndexError::new(IndexErrorKind::Full, "binary index envelope exceeded");
        let request =
            encode_request(&IndexRequest::Run(batch.clone()), LIMITS).map_err(|_| full())?;
        let IndexRequest::Run(batch) = decode_request(&request, LIMITS).map_err(|_| full())? else {
            panic!("run only")
        };
        self.reads.borrow_mut().extend(
            batch
                .stmts
                .iter()
                .filter(|s| s.sql.starts_with("SELECT") && s.sql.contains("FROM st_rec"))
                .map(|s| s.sql.clone()),
        );
        let group = batch.stmts.iter().any(|s| {
            [
                "SELECT id, row FROM st_rec WHERE id >=",
                "SELECT id, row FROM st_tomb WHERE id >=",
                "SELECT m, cid, row FROM st_conflict",
                "SELECT path, path_key, row FROM st_alias",
            ]
            .iter()
            .any(|prefix| s.sql.starts_with(prefix))
        });
        if group {
            self.payload_reads += 1;
        }
        if group && let Some(sql) = self.before_group.take() {
            self.inner.run(&Batch {
                mode: BatchMode::Autocommit,
                stmts: vec![Stmt::new(sql, vec![])],
            })?;
        }
        let results = self.inner.run(&batch)?;
        let reply = encode_reply(&IndexReply::Results(results), LIMITS)
            .unwrap_or_else(|_| encode_reply(&IndexReply::Error(full()), LIMITS).unwrap());
        match decode_reply(&reply, LIMITS, Some(batch.stmts.len())).unwrap() {
            IndexReply::Results(results) => Ok(results),
            IndexReply::Error(error) => Err(error),
            IndexReply::ResetOk => panic!("run reply"),
        }
    }
}
fn fixture(name: &str) -> (SqlStore<BudgetIndex>, Rc<RefCell<Vec<String>>>) {
    let reads = Rc::new(RefCell::new(Vec::new()));
    let index = BudgetIndex {
        inner: SqliteIndex::open(scratch(name).join("state.db"), IndexDurability::Durable).unwrap(),
        reads: reads.clone(),
        before_group: None,
        payload_reads: 0,
        sql_calls: 0,
    };
    (SqlStore::open(Rc::new(RefCell::new(index))).unwrap(), reads)
}
fn rows(count: usize, size: usize) -> Vec<RecordRow> {
    (0..count)
        .map(|n| {
            let doc = "x".repeat(size);
            let path = format!("records/{n:05}.md");
            RecordRow {
                id: B16((n as u128 + 1).to_be_bytes()),
                path: path.clone(),
                path_key: path,
                revision: w::hash::sha256(doc.as_bytes()),
                doc,
                modified_seq: 0,
                bucket: (n % 7) as u16,
                meta: RecordMeta::default(),
            }
        })
        .collect()
}
fn seed(store: &mut impl Store, rows: &[RecordRow]) {
    for row in rows {
        store
            .commit(Tx {
                records_put: vec![row.clone()],
                ..Default::default()
            })
            .unwrap();
    }
}
#[test]
fn snapshot_state_digest_large_record_page_preserves_same_data_digest() {
    let (mut store, _) = fixture("record-page-snapshot-digest");
    let rows = rows(121, 68_000);
    let mut oracle = MemStore::new();
    seed(&mut oracle, &rows);
    seed(&mut store, &rows);
    let before = r::replica::state_digest(&oracle).unwrap();
    eprintln!("same-data unbounded oracle digest: {before:?}");
    assert_eq!(r::replica::state_digest(&store).unwrap(), before);
    assert_eq!(
        store
            .records(Page {
                after: None,
                limit: 1024
            })
            .unwrap(),
        rows
    );
}
#[path = "record_pages/bounds.rs"]
mod bounds;
#[path = "record_pages/inventory_bounds.rs"]
mod inventory_bounds;
#[path = "record_pages/retained.rs"]
mod retained;
#[path = "record_pages/snapshots.rs"]
mod snapshots;
#[path = "record_pages/visitor.rs"]
mod visitor;

#[test]
fn backfill_sized_record_page_returns_every_large_row() {
    let (mut store, _) = fixture("record-page-backfill");
    let rows = rows(16, 300_000);
    seed(&mut store, &rows);
    assert_eq!(
        store
            .records(Page {
                after: None,
                limit: 16
            })
            .unwrap(),
        rows
    );
}
