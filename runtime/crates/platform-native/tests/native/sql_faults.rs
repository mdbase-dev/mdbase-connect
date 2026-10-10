//! Real SQLite plus injected pre-transaction blob SELECT failures.

use super::*;
use mdbn_store_file::index::{IndexError, IndexInfo};
use mdbn_store_file::testing::replica::conformance::{id, record};
use mdbn_store_file::testing::replica::store::{Candidate, Page, ReceiptRow, StoreError};
use mdbn_store_file::{SqlStore, SqlStoreLimits};

struct FaultIndex {
    inner: SqliteIndex,
    fail: Rc<Cell<Option<IndexErrorKind>>>,
    writes: Rc<Cell<u32>>,
}

impl IndexStorage for FaultIndex {
    fn info(&self) -> IndexInfo {
        self.inner.info()
    }
    fn reset(&mut self) -> Result<(), IndexError> {
        self.inner.reset()
    }
    fn run(
        &mut self,
        batch: &Batch,
    ) -> Result<Vec<mdbn_store_file::index::StmtResult>, IndexError> {
        if batch
            .stmts
            .iter()
            .any(|s| s.sql.starts_with("SELECT substr(b,"))
            && let Some(kind) = self.fail.take()
        {
            return Err(IndexError::new(kind, "injected blob SELECT fault"));
        }
        if batch.mode == BatchMode::Transaction {
            self.writes.set(self.writes.get() + 1);
        }
        self.inner.run(batch)
    }
}

#[test]
fn blob_select_failure_preserves_all_state_through_reopen_and_retry() {
    for (kind, label) in [
        (IndexErrorKind::Other, "io"),
        (IndexErrorKind::Corrupt, "corrupt"),
        (IndexErrorKind::Full, "full"),
    ] {
        let path = scratch(&format!("sql-blob-fault-{label}")).join("s.db");
        let fail = Rc::new(Cell::new(None));
        let writes = Rc::new(Cell::new(0));
        let open = || {
            SqlStore::open(Rc::new(RefCell::new(FaultIndex {
                inner: SqliteIndex::open(&path, IndexDurability::Durable).unwrap(),
                fail: fail.clone(),
                writes: writes.clone(),
            })))
            .unwrap()
        };
        let digest = revision(b"original blob");
        let old = record(1, "old.md", "old");
        let mut s = open();
        s.commit(Tx {
            blob_parts: vec![(digest, 0, b"abcdef".to_vec())],
            records_put: vec![old.clone()],
            meta: vec![("state".into(), Some(b"old".to_vec()))],
            ..Tx::default()
        })
        .unwrap();
        let tx = || Tx {
            blob_parts: vec![(digest, 2, b"ZZ".to_vec())],
            records_del: vec![old.id],
            meta: vec![("state".into(), Some(b"new".to_vec()))],
            ..Tx::default()
        };
        let before = writes.get();
        fail.set(Some(kind));
        let error = s.commit(tx()).unwrap_err();
        assert!(match kind {
            IndexErrorKind::Other => matches!(error, StoreError::Io(_)),
            IndexErrorKind::Corrupt => matches!(error, StoreError::Corrupt(_)),
            IndexErrorKind::Full => error == StoreError::Full,
            _ => unreachable!(),
        });
        assert_eq!(
            writes.get(),
            before,
            "no mutation batch after failed SELECT"
        );
        assert_eq!(s.blob_read(&digest, 0, u64::MAX).unwrap(), b"abcdef");
        assert_eq!(s.record(&old.id).unwrap(), Some(old.clone()));
        assert_eq!(s.meta("state").unwrap(), Some(b"old".to_vec()));
        drop(s);
        let mut s = open();
        assert_eq!(s.blob_read(&digest, 0, u64::MAX).unwrap(), b"abcdef");
        assert_eq!(s.record(&old.id).unwrap(), Some(old.clone()));
        assert_eq!(s.meta("state").unwrap(), Some(b"old".to_vec()));
        s.commit(tx()).unwrap();
        assert_eq!(s.blob_read(&digest, 0, u64::MAX).unwrap(), b"abZZef");
        assert_eq!(s.record(&old.id).unwrap(), None);
        assert_eq!(s.meta("state").unwrap(), Some(b"new".to_vec()));
        drop(s);
        let s = open();
        assert_eq!(s.blob_read(&digest, 0, u64::MAX).unwrap(), b"abZZef");
        assert_eq!(s.record(&old.id).unwrap(), None);
        assert_eq!(s.meta("state").unwrap(), Some(b"new".to_vec()));
    }
}

#[test]
fn blob_memory_caps_cover_sparse_growth_input_and_total_working_rows() {
    let path = scratch("sql-blob-budget").join("s.db");
    let limits = SqlStoreLimits {
        max_blob_bytes: 8,
        max_blob_patch_bytes: 8,
    };
    let open = |limits| {
        SqlStore::open_with_limits(
            Rc::new(RefCell::new(
                SqliteIndex::open(&path, IndexDurability::Durable).unwrap(),
            )),
            limits,
        )
        .unwrap()
    };
    let a = revision(b"a");
    let b = revision(b"b");
    let mut s = open(limits);
    s.commit(Tx {
        blob_parts: vec![(a, 0, b"aaaa".to_vec()), (b, 0, b"bbbb".to_vec())],
        ..Tx::default()
    })
    .unwrap();
    for parts in [
        vec![(a, 7, vec![1, 2])],    // sparse growth crosses row budget
        vec![(a, 0, vec![1; 5]); 3], // input sum crosses working budget
        vec![(a, 4, vec![1; 3]), (b, 0, vec![2])], // two assembled rows exceed total
    ] {
        assert!(
            s.commit(Tx {
                blob_parts: parts,
                meta: vec![("must-not-commit".into(), Some(vec![1]))],
                ..Tx::default()
            })
            .is_err()
        );
        assert_eq!(s.blob_read(&a, 0, u64::MAX).unwrap(), b"aaaa");
        assert_eq!(s.blob_read(&b, 0, u64::MAX).unwrap(), b"bbbb");
        assert_eq!(s.meta("must-not-commit").unwrap(), None);
    }
    drop(s);
    let mut s = open(limits);
    assert_eq!(s.blob_read(&a, 0, u64::MAX).unwrap(), b"aaaa");
    assert_eq!(s.blob_read(&b, 0, u64::MAX).unwrap(), b"bbbb");
    s.commit(Tx {
        blob_parts: vec![(a, 4, vec![1; 3])],
        ..Tx::default()
    })
    .unwrap();
    assert_eq!(s.blob_read(&a, 0, u64::MAX).unwrap(), b"aaaa\x01\x01\x01");
    drop(s);
    let s = open(SqlStoreLimits {
        max_blob_bytes: 4,
        max_blob_patch_bytes: 4,
    });
    assert_eq!(
        s.blob_read(&a, 0, u64::MAX),
        Err(StoreError::Full),
        "a lower host read budget must fail, never silently truncate"
    );
    assert_eq!(s.blob_read(&a, 4, 2).unwrap(), vec![1, 1]);
    assert_eq!(s.meta("must-not-commit").unwrap(), None);
}

#[test]
fn overlapping_blob_parts_preserve_memstore_vec_order_through_reopen() {
    use mdbn_store_file::testing::replica::mem::MemStore;
    let a = revision(b"digest-a");
    let b = revision(b"digest-b");
    let cases = [
        vec![(a, 2, b"ZZ".to_vec()), (a, 0, b"abcdef".to_vec())],
        vec![
            (a, 4, b"tail".to_vec()),
            (b, 2, b"xy".to_vec()),
            (a, 0, b"ABCDEFGHIJ".to_vec()),
            (b, 0, b"abcdefghijkl".to_vec()),
            (a, 1, b"!".to_vec()),
            (b, 2, b"??".to_vec()),
            (a, 1, b"#".to_vec()),
            (a, 8, b"Z".to_vec()),
        ],
    ];
    for (n, parts) in cases.into_iter().enumerate() {
        let path = scratch(&format!("sql-overlap-{n}")).join("s.db");
        let open = || {
            SqlStore::open(Rc::new(RefCell::new(
                SqliteIndex::open(&path, IndexDurability::Durable).unwrap(),
            )))
            .unwrap()
        };
        let mut s = open();
        let mut m = MemStore::new();
        let seed = Tx {
            blob_parts: vec![(a, 0, b"123456".to_vec()), (b, 0, b"olddata".to_vec())],
            ..Tx::default()
        };
        s.commit(seed.clone()).unwrap();
        m.commit(seed).unwrap();
        let tx = Tx {
            blob_parts: parts,
            meta: vec![("parity".into(), Some(b"done".to_vec()))],
            ..Tx::default()
        };
        m.commit(tx.clone()).unwrap();
        s.commit(tx).unwrap();
        for d in [a, b] {
            assert_eq!(
                s.blob_read(&d, 0, u64::MAX).unwrap(),
                m.blob_read(&d, 0, u64::MAX).unwrap()
            );
            assert_eq!(s.blob_size(&d).unwrap(), m.blob_size(&d).unwrap());
        }
        assert_eq!(s.meta("parity").unwrap(), Some(b"done".to_vec()));
        drop(s);
        let s = open();
        for d in [a, b] {
            assert_eq!(
                s.blob_read(&d, 0, u64::MAX).unwrap(),
                m.blob_read(&d, 0, u64::MAX).unwrap()
            );
        }
        assert_eq!(s.meta("parity").unwrap(), Some(b"done".to_vec()));
    }
}

#[test]
fn invalid_blob_offsets_and_sql_integer_overflow_do_not_mutate() {
    let path = scratch("sql-overflow").join("s.db");
    let open = || {
        SqlStore::open(Rc::new(RefCell::new(
            SqliteIndex::open(&path, IndexDurability::Durable).unwrap(),
        )))
        .unwrap()
    };
    let digest = revision(b"blob");
    let mut s = open();
    s.commit(Tx {
        blob_parts: vec![(digest, 0, b"abc".to_vec())],
        ..Tx::default()
    })
    .unwrap();
    for off in [u64::MAX, 1_000_000_000] {
        assert!(
            s.commit(Tx {
                blob_parts: vec![(digest, off, vec![1])],
                meta: vec![("must-not-commit".into(), Some(vec![1]))],
                ..Tx::default()
            })
            .is_err()
        );
    }
    assert!(
        s.commit(Tx {
            receipts_put: vec![ReceiptRow {
                mutation: id(7),
                seq: u64::MAX,
                time: 0
            }],
            meta: vec![("must-not-commit".into(), Some(vec![1]))],
            ..Tx::default()
        })
        .is_err()
    );
    assert_eq!(s.blob_read(&digest, 0, u64::MAX).unwrap(), b"abc");
    assert!(s.blob_read(&digest, u64::MAX, u64::MAX).unwrap().is_empty());
    assert_eq!(s.receipt(&id(7)).unwrap(), None);
    assert_eq!(s.meta("must-not-commit").unwrap(), None);
    s.commit(Tx {
        records_put: vec![record(1, "a.md", "a")],
        ..Tx::default()
    })
    .unwrap();
    assert!(
        s.candidates(
            &Candidate::All,
            Page {
                after: None,
                limit: 0
            }
        )
        .unwrap()
        .is_empty()
    );
    drop(s);
    let s = open();
    assert_eq!(s.blob_read(&digest, 0, u64::MAX).unwrap(), b"abc");
    assert_eq!(s.receipt(&id(7)).unwrap(), None);
    assert_eq!(s.meta("must-not-commit").unwrap(), None);
}
