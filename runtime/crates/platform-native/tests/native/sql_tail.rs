//! Actual durable SQLite reopen and abort tests, not physical power-loss claims.
use super::*;
use mdbn_store_file::SqlStore;
use mdbn_store_file::testing::replica::store::{StoreError, TailRow, TailStats};
use std::path::Path;

fn open(path: &Path) -> SqlStore<SqliteIndex> {
    SqlStore::open(Rc::new(RefCell::new(
        SqliteIndex::open(path, IndexDurability::Durable).unwrap(),
    )))
    .unwrap()
}
#[test]
fn retained_tail_reopens_and_failed_batch_does_not_erase_committed_prefix() {
    let dir = scratch("tail-reopen-abort");
    let path = dir.join("state.db");
    let old = TailRow {
        seq: 1,
        item: vec![1, 2, 3],
        applied_at: 123,
    };
    let mut store = open(&path);
    store
        .commit(Tx {
            tail_put: vec![old.clone()],
            ..Tx::default()
        })
        .unwrap();
    drop(store);
    let mut store = open(&path);
    assert_eq!(store.tail(0, 10).unwrap(), vec![old.clone()]);
    assert_eq!(
        store.tail_stats().unwrap(),
        TailStats {
            first: 1,
            last: 1,
            count: 1,
            bytes: 3
        }
    );
    store.index().borrow_mut().run(&Batch{mode:BatchMode::Transaction,stmts:vec![Stmt::new("CREATE TRIGGER refuse_tail BEFORE INSERT ON st_tail BEGIN SELECT RAISE(ABORT,'synthetic tail failure'); END",vec![])]}).unwrap();
    assert!(
        store
            .commit(Tx {
                tail_drop_above: Some(0),
                tail_put: vec![TailRow {
                    seq: 2,
                    item: vec![9; 8],
                    applied_at: 999
                }],
                ..Tx::default()
            })
            .is_err()
    );
    drop(store);
    let mut store = open(&path);
    assert_eq!(store.tail(0, 10).unwrap(), vec![old]);
    assert_eq!(
        store.tail_stats().unwrap().bytes,
        3,
        "accounting rolls back with the rows"
    );
    store
        .index()
        .borrow_mut()
        .run(&Batch {
            mode: BatchMode::Transaction,
            stmts: vec![Stmt::new("DROP TRIGGER refuse_tail", vec![])],
        })
        .unwrap();
    store
        .commit(Tx {
            tail_drop_above: Some(0),
            ..Tx::default()
        })
        .unwrap();
    drop(store);
    assert_eq!(open(&path).tail_stats().unwrap(), TailStats::default());
}
// Adopted from RR's independently executed native wrapper regression.
#[test]
fn file_wrapper_forwards_retention_and_preserves_raw_and_own_on_reopen() {
    let dir = scratch("file-wrapper-sql-retention");
    let n = Cell::new(0u32);
    let make = |i: u32| {
        let root = dir.join(format!("root{i}"));
        std::fs::create_dir_all(&root).unwrap();
        let index = Rc::new(RefCell::new(
            SqliteIndex::open(dir.join(format!("file{i}.db")), IndexDurability::Durable).unwrap(),
        ));
        FileStore::open(
            Rc::new(platform(&root)),
            SqlStore::open(index.clone()).unwrap(),
            SqlDiskDb::open(index).unwrap(),
            Box::new(WallClock::default()),
            Config::default(),
        )
        .unwrap()
    };
    mdbn_store_file::testing::replica::conformance::run_tail(|| {
        n.set(n.get() + 1);
        make(n.get())
    });
    // Canonical fixture4 clears confirmed state but retains the raw/own pair.
    // Read through a fresh actual FileStore, not directly through SqlStore.
    let store = make(4);
    assert_eq!(store.tail(0, 10).unwrap().len(), 1);
    assert_eq!(store.tail_stats().unwrap().count, 1);
    assert_eq!(store.own_retained(0, 10).unwrap().len(), 1);
}

#[test]
fn retained_tail_oversized_envelope_fails_instead_of_returning_a_prefix() {
    let dir = scratch("tail-bounded-page");
    let path = dir.join("state.db");
    let mut store = open(&path);
    store
        .commit(Tx {
            tail_put: (1..=1000)
                .map(|seq| TailRow {
                    seq,
                    item: vec![7],
                    applied_at: 0,
                })
                .collect(),
            ..Tx::default()
        })
        .unwrap();
    store
        .commit(Tx {
            tail_put: vec![TailRow {
                seq: 1001,
                item: vec![8],
                applied_at: 0,
            }],
            ..Tx::default()
        })
        .unwrap();
    assert_eq!(store.tail(0, u32::MAX), Err(StoreError::Full));
    assert_eq!(store.tail(0, 1000).unwrap().len(), 1000);
    assert_eq!(store.tail(1000, 1000).unwrap()[0].seq, 1001);
    assert_eq!(store.tail_stats().unwrap().count, 1001);
}
