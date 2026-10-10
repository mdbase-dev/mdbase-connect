use super::*;
use mdbn_store_file::index::{MAX_BORROWED_BLOB_BYTES, Stmt};
use std::sync::atomic::AtomicU64;

fn path(label: &str) -> PathBuf {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let dir = std::env::temp_dir().join(format!(
        "mdbn-borrowed-index-{}-{label}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir.join("index.sqlite")
}
fn batch(sql: &str, params: Vec<SqlValue>) -> Batch {
    Batch {
        mode: BatchMode::Transaction,
        stmts: vec![Stmt::new(sql, params)],
    }
}
fn insert(id: i64) -> Batch {
    batch(
        "INSERT INTO t(k,v) VALUES(?,?)",
        vec![SqlValue::Integer(id), SqlValue::Null],
    )
}
fn create(index: &mut SqliteIndex) {
    index
        .run(&batch(
            "CREATE TABLE t(k INTEGER PRIMARY KEY,v BLOB)",
            vec![],
        ))
        .unwrap();
}
fn borrowed(bytes: &[u8]) -> BorrowedBlob<'_> {
    BorrowedBlob {
        parameter: 1,
        bytes,
    }
}

#[test]
fn bounded_borrowed_write_persists_exact_bytes_and_rust_parameter_adapters_borrow() {
    let p = path("max-bound");
    let mut i = SqliteIndex::open(&p, IndexDurability::Durable).unwrap();
    create(&mut i);
    let bytes = vec![7; MAX_BORROWED_BLOB_BYTES];
    let typed = SqlValue::Blob(bytes.clone());
    let ValueRef::Blob(reference) = to_sql_ref(&typed) else {
        panic!("blob")
    };
    let SqlValue::Blob(owned) = &typed else {
        panic!("blob")
    };
    assert!(std::ptr::eq(reference.as_ptr(), owned.as_ptr()));
    let request = insert(1);
    let result = i
        .run_with_borrowed_blob(&request, borrowed(&bytes))
        .unwrap();
    assert_eq!(result.len(), 1);
    assert_eq!(result[0].changes, 1);
    assert_eq!(result[0].columns, 0);
    assert!(result[0].values.is_empty());
    assert_eq!(request.stmts[0].params.len(), 2);
    assert!(matches!(request.stmts[0].params[1], SqlValue::Null));
    assert_eq!(bytes, vec![7; MAX_BORROWED_BLOB_BYTES]);
    drop(i);
    let mut i = SqliteIndex::open(&p, IndexDurability::Durable).unwrap();
    // Readback is an explicit ordinary operation OUTSIDE the borrowed-write API.
    let rows = i.run(&batch("SELECT v FROM t WHERE k=1", vec![])).unwrap();
    assert_eq!(rows[0].values, vec![SqlValue::Blob(bytes)]);
}

#[test]
fn invalid_slots_size_batch_shape_and_readback_refuse_without_writes_or_poison() {
    let p = path("refusals");
    let mut i = SqliteIndex::open(&p, IndexDurability::Durable).unwrap();
    create(&mut i);
    let bytes = [7; 17];
    for slot in [0, 2, usize::MAX] {
        assert_eq!(
            i.run_with_borrowed_blob(
                &insert(1),
                BorrowedBlob {
                    parameter: slot,
                    bytes: &bytes
                }
            )
            .unwrap_err()
            .kind,
            IndexErrorKind::Sql
        );
    }
    let huge = vec![7; MAX_BORROWED_BLOB_BYTES + 1];
    assert_eq!(
        i.run_with_borrowed_blob(&insert(1), borrowed(&huge))
            .unwrap_err()
            .kind,
        IndexErrorKind::Sql
    );
    let mut auto = insert(1);
    auto.mode = BatchMode::Autocommit;
    assert!(i.run_with_borrowed_blob(&auto, borrowed(&bytes)).is_err());
    let mut two = insert(1);
    two.stmts
        .push(Stmt::new("INSERT INTO t VALUES(2,NULL)", vec![]));
    assert!(i.run_with_borrowed_blob(&two, borrowed(&bytes)).is_err());
    let read = batch("SELECT ?,?", vec![SqlValue::Integer(1), SqlValue::Null]);
    assert!(i.run_with_borrowed_blob(&read, borrowed(&bytes)).is_err());
    let returning = batch(
        "INSERT INTO t(k,v) VALUES(?,?) RETURNING v",
        vec![SqlValue::Integer(1), SqlValue::Null],
    );
    assert!(
        i.run_with_borrowed_blob(&returning, borrowed(&bytes))
            .is_err()
    );
    assert!(i.conn.is_some());
    let rows = i.run(&batch("SELECT count(*) FROM t", vec![])).unwrap();
    assert_eq!(rows[0].values, vec![SqlValue::Integer(0)]);
    assert_eq!(bytes, [7; 17]);
    i.run_with_borrowed_blob(&insert(1), borrowed(&bytes))
        .unwrap();
}

#[test]
fn borrowed_known_statement_abort_rolls_back_and_preserves_prior_rows() {
    let p = path("constraint");
    let mut i = SqliteIndex::open(&p, IndexDurability::Durable).unwrap();
    create(&mut i);
    let first = [7; 17];
    i.run_with_borrowed_blob(&insert(1), borrowed(&first))
        .unwrap();
    let other = [9; 17];
    assert_eq!(
        i.run_with_borrowed_blob(&insert(1), borrowed(&other))
            .unwrap_err()
            .kind,
        IndexErrorKind::Sql
    );
    assert!(i.conn.is_some());
    let rows = i.run(&batch("SELECT k,v FROM t", vec![])).unwrap();
    assert_eq!(
        rows[0].values,
        vec![SqlValue::Integer(1), SqlValue::Blob(first.to_vec())]
    );
    assert_eq!(other, [9; 17]);
}

#[test]
fn borrowed_commit_and_checkpoint_barrier_failure_fences_every_api_until_reopen() {
    for at in 1..=3 {
        let p = path(&format!("barrier-{at}"));
        let mut i = SqliteIndex::open(&p, IndexDurability::Durable).unwrap();
        create(&mut i);
        let first = [7; 17];
        i.run_with_borrowed_blob(&insert(1), borrowed(&first))
            .unwrap();
        i.wal_limit_bytes = 0;
        i.barrier.fail_on_call(at);
        let other = [9; 17];
        assert!(
            i.run_with_borrowed_blob(&insert(2), borrowed(&other))
                .is_err()
        );
        assert!(i.conn.is_none());
        assert!(
            i.run_with_borrowed_blob(&insert(3), borrowed(&other))
                .is_err()
        );
        assert!(i.run(&batch("SELECT * FROM t", vec![])).is_err());
        assert!(i.reset().is_err());
        assert_eq!(other, [9; 17]);
        drop(i);
        let mut i = SqliteIndex::open(&p, IndexDurability::Durable).unwrap();
        let rows = i
            .run(&batch("SELECT k,v FROM t ORDER BY k", vec![]))
            .unwrap();
        assert_eq!(
            &rows[0].values[..2],
            &[SqlValue::Integer(1), SqlValue::Blob(first.to_vec())]
        );
        // The uncertain write may already exist; never assert rollback from error.
        if rows[0].values.len() > 2 {
            assert_eq!(
                &rows[0].values[2..],
                &[SqlValue::Integer(2), SqlValue::Blob(other.to_vec())]
            );
        }
        i.run_with_borrowed_blob(&insert(3), borrowed(&other))
            .unwrap();
    }
}

#[test]
fn borrowed_deferred_window_retains_existing_savepoint_and_final_barrier_semantics() {
    let p = path("window");
    let mut i = SqliteIndex::open(&p, IndexDurability::Durable).unwrap();
    create(&mut i);
    i.defer_sync(true).unwrap();
    i.run_with_borrowed_blob(&insert(1), borrowed(&[7; 17]))
        .unwrap();
    i.run_with_borrowed_blob(&insert(2), borrowed(&[9; 17]))
        .unwrap();
    assert!(i.deferred);
    i.defer_sync(false).unwrap();
    assert!(!i.deferred);
    drop(i);
    let mut i = SqliteIndex::open(&p, IndexDurability::Durable).unwrap();
    let rows = i.run(&batch("SELECT count(*) FROM t", vec![])).unwrap();
    assert_eq!(rows[0].values, vec![SqlValue::Integer(2)]);
}
