//! Real SQLite pre-hydration budget tests: no BLOB read before admission.
use super::*;
use mdbn_store_file::SqlStore;
use mdbn_store_file::index::{IndexError, IndexInfo, StmtResult};
use mdbn_store_file::sql_query::{HydrationBudget, SqlQuery};
use mdbn_store_file::testing::replica::conformance::{id, record};
use mdbn_store_file::testing::replica::store::{Head, Page, StoreError};

struct TraceIndex {
    inner: SqliteIndex,
    blob_reads: Rc<Cell<usize>>,
    grow_before_blob: Rc<Cell<bool>>,
}
impl IndexStorage for TraceIndex {
    fn info(&self) -> IndexInfo {
        self.inner.info()
    }
    fn reset(&mut self) -> Result<(), IndexError> {
        self.inner.reset()
    }
    fn run(&mut self, batch: &Batch) -> Result<Vec<StmtResult>, IndexError> {
        let reads = batch
            .stmts
            .iter()
            .filter(|s| s.sql.starts_with("SELECT row FROM st_rec"))
            .count();
        if reads != 0 {
            self.blob_reads.set(self.blob_reads.get() + reads);
            if self.grow_before_blob.replace(false) {
                self.inner.run(&Batch {
                    mode: BatchMode::Transaction,
                    stmts: vec![Stmt::new(
                        "UPDATE st_rec SET row = zeroblob(length(row) + 1)",
                        vec![],
                    )],
                })?;
            }
        }
        self.inner.run(batch)
    }
}
type Fixture = (
    SqlStore<TraceIndex>,
    SqlQuery<TraceIndex>,
    Rc<Cell<usize>>,
    Rc<Cell<bool>>,
);
fn open(name: &str) -> Fixture {
    let blob_reads = Rc::new(Cell::new(0));
    let grow = Rc::new(Cell::new(false));
    let index = Rc::new(RefCell::new(TraceIndex {
        inner: SqliteIndex::open(scratch(name).join("state.db"), IndexDurability::Durable).unwrap(),
        blob_reads: blob_reads.clone(),
        grow_before_blob: grow.clone(),
    }));
    let store = SqlStore::open(index.clone()).unwrap();
    (store, SqlQuery::new(index), blob_reads, grow)
}

#[test]
fn neutral_source_scan_is_head_fenced_without_ready_field_index_or_blob_copies() {
    let (mut store, _, reads, _) = open("query-neutral-source-scan");
    store
        .commit(Tx {
            records_put: vec![
                record(1, "small.md", "small"),
                record(2, "large.md", &"x".repeat(1_100_000)),
            ],
            ..Tx::default()
        })
        .unwrap();
    let head = store.head().unwrap();
    assert!(store.query_index_state().unwrap().is_none_or(|s| !s.ready));
    let first = store
        .query_record_sizes_at(
            Page {
                after: None,
                limit: 1,
            },
            head,
        )
        .unwrap();
    assert_eq!(first.len(), 1);
    assert_eq!(first[0].id, id(1));
    let second = store
        .query_record_sizes_at(
            Page {
                after: Some(first[0].id),
                limit: 1,
            },
            head,
        )
        .unwrap();
    assert_eq!(second.len(), 1);
    assert_eq!(second[0].id, id(2));
    assert!(second[0].encoded_bytes > 1 << 20);
    assert!(
        store
            .query_record_sizes_at(
                Page {
                    after: Some(second[0].id),
                    limit: 1
                },
                head
            )
            .unwrap()
            .is_empty()
    );
    assert_eq!(reads.get(), 0, "source metadata never selects record BLOBs");
    let mut budget = HydrationBudget::HOSTED;
    assert_eq!(
        store.hydrate_query_at(&[second[0].id], head, &mut budget),
        Err(StoreError::Full)
    );
    assert_eq!(budget, HydrationBudget::HOSTED);
    assert_eq!(
        reads.get(),
        0,
        "oversized fallback source is rejected before copying"
    );
    assert_eq!(
        store.query_record_sizes_at(
            Page {
                after: None,
                limit: 1001
            },
            head
        ),
        Err(StoreError::Full)
    );
    assert!(
        store
            .query_record_sizes_at(
                Page {
                    after: None,
                    limit: 0
                },
                head
            )
            .unwrap()
            .is_empty()
    );
    store
        .commit(Tx {
            head: Some(Head {
                seq: 1,
                chain: revision(b"changed-source-scan-head"),
            }),
            ..Tx::default()
        })
        .unwrap();
    for limit in [0, 1] {
        assert!(
            store
                .query_record_sizes_at(Page { after: None, limit }, head)
                .is_err()
        );
    }
    assert_eq!(reads.get(), 0);
}
#[test]
fn hydration_budget_refuses_before_any_blob_select() {
    let (mut store, query, reads, _) = open("query-preflight-budget");
    store
        .commit(Tx {
            records_put: vec![
                record(1, "a.md", "small"),
                record(2, "b.md", "other"),
                record(3, "large.md", &"x".repeat(1_100_000)),
            ],
            ..Tx::default()
        })
        .unwrap();
    let sizes = query
        .record_ids_with_sizes(Page {
            after: None,
            limit: 10,
        })
        .unwrap();
    assert_eq!(sizes.len(), 3);
    assert_eq!(reads.get(), 0, "IDs/lengths do not hydrate");
    let mut count = HydrationBudget::new(1, u64::MAX);
    assert_eq!(
        query.hydrate_records_at(&[id(1), id(2)], store.head().unwrap(), &mut count),
        Err(StoreError::Full)
    );
    assert_eq!(count, HydrationBudget::new(1, u64::MAX));
    let first_bytes = sizes.iter().find(|s| s.id == id(1)).unwrap().encoded_bytes;
    let mut bytes = HydrationBudget::new(1, first_bytes - 1);
    assert_eq!(
        query.hydrate_records_at(&[id(1)], store.head().unwrap(), &mut bytes),
        Err(StoreError::Full)
    );
    assert_eq!(bytes, HydrationBudget::new(1, first_bytes - 1));
    let mut hosted = HydrationBudget::HOSTED;
    assert_eq!(
        query.hydrate_records_at(&[id(3)], store.head().unwrap(), &mut hosted),
        Err(StoreError::Full)
    );
    assert_eq!(hosted, HydrationBudget::HOSTED);
    assert_eq!(
        reads.get(),
        0,
        "reject oversized row without copying/decoding it"
    );
}
#[test]
fn hydration_budget_is_cumulative_and_preserves_selection_order() {
    let (mut store, query, reads, _) = open("query-preflight-cumulative");
    let rows = vec![
        record(1, "a.md", "one"),
        record(2, "b.md", "two"),
        record(3, "c.md", "three"),
    ];
    store
        .commit(Tx {
            records_put: rows.clone(),
            ..Tx::default()
        })
        .unwrap();
    let sizes = query
        .record_ids_with_sizes(Page {
            after: None,
            limit: 10,
        })
        .unwrap();
    let two_bytes = sizes
        .iter()
        .filter(|s| s.id == id(1) || s.id == id(2))
        .map(|s| s.encoded_bytes)
        .sum();
    let mut budget = HydrationBudget::new(2, two_bytes);
    let head = store.head().unwrap();
    let got = query
        .hydrate_records_at(&[id(2), id(1)], head, &mut budget)
        .unwrap();
    assert_eq!(got, vec![rows[1].clone(), rows[0].clone()]);
    assert_eq!(budget, HydrationBudget::new(0, 0));
    assert_eq!(reads.get(), 2);
    assert_eq!(
        query.hydrate_records_at(&[id(3)], head, &mut budget),
        Err(StoreError::Full)
    );
    assert_eq!(reads.get(), 2, "second page cannot renew the budget");
    assert!(
        query
            .hydrate_records_at(&[], head, &mut budget)
            .unwrap()
            .is_empty()
    );
}
#[test]
fn missing_duplicate_stale_and_growing_rows_never_return_partial_hydration() {
    let (mut store, query, reads, grow) = open("query-preflight-race");
    store
        .commit(Tx {
            records_put: vec![record(1, "a.md", "one")],
            ..Tx::default()
        })
        .unwrap();
    let head = store.head().unwrap();
    let mut budget = HydrationBudget::HOSTED;
    assert!(
        query
            .hydrate_records_at(&[id(1), id(1)], head, &mut budget)
            .is_err()
    );
    assert!(
        query
            .hydrate_records_at(&[id(99)], head, &mut budget)
            .is_err()
    );
    assert_eq!(budget, HydrationBudget::HOSTED);
    assert_eq!(reads.get(), 0);
    let changed = Head {
        seq: 1,
        chain: revision(b"new head"),
    };
    store
        .commit(Tx {
            head: Some(changed),
            ..Tx::default()
        })
        .unwrap();
    assert!(
        query
            .hydrate_records_at(&[id(1)], head, &mut budget)
            .is_err()
    );
    assert_eq!(reads.get(), 0, "stale head fails before BLOB read");
    grow.set(true);
    assert!(
        query
            .hydrate_records_at(&[id(1)], changed, &mut budget)
            .is_err()
    );
    assert_eq!(reads.get(), 1);
    assert_eq!(
        budget.records_left(),
        999,
        "attempted work is charged before fetch"
    );
    assert!(budget.bytes_left() < HydrationBudget::HOSTED.bytes_left());
}
#[test]
fn selection_pages_are_metadata_only_and_capped_at_1000() {
    let (mut store, query, reads, _) = open("query-preflight-id-pages");
    store
        .commit(Tx {
            records_put: (1..=1001)
                .map(|n| record(n, &format!("{n}.md"), "small"))
                .collect(),
            ..Tx::default()
        })
        .unwrap();
    assert!(
        query
            .record_ids_with_sizes(Page {
                after: None,
                limit: 0
            })
            .unwrap()
            .is_empty()
    );
    let first = query
        .record_ids_with_sizes(Page {
            after: None,
            limit: 1024,
        })
        .unwrap();
    assert_eq!(first.len(), 1000);
    assert!(first.windows(2).all(|w| w[0].id < w[1].id));
    let next = query
        .record_ids_with_sizes(Page {
            after: Some(first.last().unwrap().id),
            limit: 1000,
        })
        .unwrap();
    assert_eq!(next.len(), 1);
    assert_eq!(reads.get(), 0);
    let ids: Vec<_> = first
        .iter()
        .map(|s| s.id)
        .chain(next.iter().map(|s| s.id))
        .collect();
    let mut budget = HydrationBudget::new(2000, u64::MAX);
    assert_eq!(
        query.hydrate_records_at(&ids, store.head().unwrap(), &mut budget),
        Err(StoreError::Full)
    );
    assert_eq!(reads.get(), 0);
}
