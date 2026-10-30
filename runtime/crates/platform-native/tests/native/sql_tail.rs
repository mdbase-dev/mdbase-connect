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

/// Retention uses ordinary DELETEs, not VACUUM. Real SQLite must make their
/// pages reusable under sustained own-history churn and after closing/reopening.
#[test]
fn retained_own_churn_reuses_sqlite_pages_without_vacuum() {
    let dir = scratch("own-churn-reuse");
    let path = dir.join("state.db");
    let mut store = open(&path);
    let scalar = |store: &SqlStore<SqliteIndex>, pragma: &str| {
        let rows = store
            .index()
            .borrow_mut()
            .run(&Batch {
                mode: BatchMode::Autocommit,
                stmts: vec![Stmt::new(pragma, vec![])],
            })
            .unwrap();
        match rows[0].values.as_slice() {
            [SqlValue::Integer(n)] => *n,
            other => panic!("pragma: {other:?}"),
        }
    };
    assert_eq!(scalar(&store, "PRAGMA auto_vacuum"), 0);
    let mut row = mdbn_store_file::testing::replica::conformance::pending_row(1, 1);
    row.touches = vec!["large original".repeat(2400)];
    let own_bytes = row.to_bytes().len() as u64;
    let mut warm_pages = 0;
    for seq in 1u64..=300 {
        // Same paired floor emitted by Replica's budget pruning. Keep four
        // encoded originals, independent of the much smaller encrypted tail.
        let floor = seq.saturating_sub(3).max(1);
        store
            .commit(Tx {
                tail_drop_below: Some(floor),
                own_retained_drop_below: Some(floor),
                tail_put: vec![TailRow {
                    seq,
                    item: vec![7; 128],
                    applied_at: 0,
                }],
                own_retained_put: vec![(seq, row.clone())],
                ..Tx::default()
            })
            .unwrap();
        assert!(Store::own_retained_stats(&store).unwrap().bytes <= 4 * own_bytes);
        assert!(store.tail_stats().unwrap().bytes <= 4 * 128);
        let pages = scalar(&store, "PRAGMA page_count");
        if seq == 50 {
            warm_pages = pages;
        }
        if seq > 50 {
            assert!(
                pages <= warm_pages + 4,
                "freed own-history pages must be reused"
            );
        }
        if seq == 150 {
            drop(store);
            store = open(&path);
        }
    }
    store
        .commit(Tx {
            tail_drop_above: Some(0),
            own_retained_drop_above: Some(0),
            ..Tx::default()
        })
        .unwrap();
    assert!(scalar(&store, "PRAGMA freelist_count") > 0);
    drop(store);
    let store = open(&path);
    assert_eq!(
        Store::own_retained_stats(&store).unwrap(),
        TailStats::default()
    );
    assert_eq!(store.tail_stats().unwrap(), TailStats::default());
    // Physical high-water capacity is retained, not forensic erasure or shrink.
    assert!(scalar(&store, "PRAGMA page_count") <= warm_pages + 4);
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
