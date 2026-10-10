//! Real private SQLite reopen qualification. No LAB/Connect or user profiles.
use super::{Closed, Error};
use crate::testutil::TestDir;
use mdbn_platform_native::SqliteIndex;
use mdbn_replica::mirror_admission::{Fence, MAX_CANDIDATES, META};
use mdbn_replica::store::{Store, Tx};
use mdbn_store_file::index::{
    Batch, BatchMode, BorrowedBlob, IndexDurability, IndexStorage, SqlValue, Stmt,
};
use mdbn_store_file::{SqlStore, SqlStoreLimits};
use mdbn_wire::client::{Hold, HoldReason};
use mdbn_wire::common::B32;
use mdbn_wire::intent::BlobRef;
use mdbn_wire::snapshot::TextOrBlob;
use mdbn_wire::{Wire, cbor::Cbor};
use std::{cell::RefCell, path::PathBuf, rc::Rc};

struct Fixture {
    _dir: TestDir,
    private: PathBuf,
    folder: PathBuf,
}
impl Fixture {
    fn new(tag: &str) -> Self {
        let dir = TestDir::new(tag);
        let private = dir.path().join("private");
        let folder = dir.path().join("folder");
        crate::fsutil::ensure_private_dir(&private).unwrap();
        std::fs::create_dir(&folder).unwrap();
        std::fs::write(folder.join("local.md"), b"initial user bytes").unwrap();
        Self {
            _dir: dir,
            private,
            folder,
        }
    }
    fn sql(&self) -> SqlStore<SqliteIndex> {
        let index = Rc::new(RefCell::new(
            SqliteIndex::open(self.private.join("index.sqlite"), IndexDurability::Durable).unwrap(),
        ));
        SqlStore::open_with_limits(index, SqlStoreLimits::DESKTOP).unwrap()
    }
    /// Only fixtures write raw corrupt/future on-disk metadata. Product commits
    /// must reject it; this tests loading a pre-existing damaged/newer database.
    fn raw_fence(&self, bytes: &[u8]) {
        let index = Rc::new(RefCell::new(
            SqliteIndex::open(self.private.join("index.sqlite"), IndexDurability::Durable).unwrap(),
        ));
        let store = SqlStore::open_with_limits(index.clone(), SqlStoreLimits::DESKTOP).unwrap();
        index
            .borrow_mut()
            .run(&Batch {
                mode: BatchMode::Transaction,
                stmts: vec![Stmt::new(
                    "INSERT OR REPLACE INTO st_meta(k,v) VALUES (?,?)",
                    vec![SqlValue::Text(META.into()), SqlValue::Blob(bytes.to_vec())],
                )],
            })
            .unwrap();
        drop(store);
    }
    fn assert_user_bytes(&self, expected: &[u8]) {
        assert_eq!(
            std::fs::read(self.folder.join("local.md")).unwrap(),
            expected
        );
        assert!(!self.folder.join(".mdbase").exists());
    }
}

#[test]
fn sqlite_invalid_and_future_fences_stay_closed_without_repair_or_evidence_cleanup() {
    let valid = Fence::new([1; 16], 3).unwrap().encode().unwrap();
    let Cbor::Array(mut future) = mdbn_wire::cbor::decode(&valid).unwrap() else {
        panic!("array")
    };
    future[0] = Cbor::Uint(2);
    let future = mdbn_wire::cbor::encode(&Cbor::Array(future)).unwrap();
    let cases = [vec![0xff], valid[..valid.len() - 1].to_vec(), future];
    for bytes in cases {
        let f = Fixture::new("mirror-invalid");
        let retained = b"private immutable evidence from original attempt";
        std::fs::write(f.private.join("capture.json"), retained).unwrap();
        f.raw_fence(&bytes);
        for _ in 0..2 {
            assert!(crate::runtime::preopen_mirror_status(&f.private).is_err());
            assert!(matches!(
                Closed::resume(f.sql()),
                Err(Error::RequiresReopen(_))
            ));
            assert_eq!(f.sql().meta(META).unwrap().unwrap(), bytes);
            assert_eq!(
                std::fs::read(f.private.join("capture.json")).unwrap(),
                retained
            );
            f.assert_user_bytes(b"initial user bytes");
        }
    }
}

#[test]
fn sqlite_valid_large_fence_reopens_as_closed_diagnostic_not_corruption() {
    for detached in [false, true] {
        let f = Fixture::new("mirror-large");
        let mut fence = Fence::new([1; 16], 3).unwrap();
        fence.total = MAX_CANDIDATES + 1;
        fence.pending = fence.total;
        if detached {
            fence = fence.detached();
        }
        let bytes = fence.encode().unwrap();
        f.raw_fence(&bytes);
        for _ in 0..2 {
            let diagnostic = crate::runtime::preopen_mirror_status(&f.private)
                .unwrap()
                .unwrap();
            assert_eq!(
                diagnostic.phase,
                if detached { "detached" } else { "joining" }
            );
            assert_eq!(
                diagnostic.reason,
                if detached {
                    "explicitly_detached"
                } else {
                    "mirror_too_large"
                }
            );
            assert_eq!(diagnostic.pending, MAX_CANDIDATES + 1);
            assert!(!diagnostic.requires_reopen);
            assert_eq!(f.sql().meta(META).unwrap().unwrap(), bytes);
            f.assert_user_bytes(b"initial user bytes");
        }
    }
}

fn blob(bytes: &[u8], marker: u8) -> TextOrBlob {
    TextOrBlob::Blob(BlobRef {
        plain_hash: mdbn_wire::hash::sha256(bytes),
        size: bytes.len() as u64,
        blob_id: B32([marker; 32]),
        id_epoch: 7,
        part_size: 65536,
    })
}

struct CandidateFaultIndex {
    inner: SqliteIndex,
    fail: Rc<std::cell::Cell<Option<bool>>>,
}
impl IndexStorage for CandidateFaultIndex {
    fn info(&self) -> mdbn_store_file::index::IndexInfo {
        self.inner.info()
    }
    fn reset(&mut self) -> Result<(), mdbn_store_file::index::IndexError> {
        self.inner.reset()
    }
    fn defer_sync(&mut self, on: bool) -> Result<bool, mdbn_store_file::index::IndexError> {
        self.inner.defer_sync(on)
    }
    fn run(
        &mut self,
        batch: &Batch,
    ) -> Result<Vec<mdbn_store_file::index::StmtResult>, mdbn_store_file::index::IndexError> {
        let fault = self.before(batch)?;
        let result = self.inner.run(batch)?;
        self.after(fault, result)
    }
    fn run_with_borrowed_blob(
        &mut self,
        batch: &Batch,
        body: BorrowedBlob<'_>,
    ) -> Result<Vec<mdbn_store_file::index::StmtResult>, mdbn_store_file::index::IndexError> {
        let fault = self.before(batch)?;
        let result = self.inner.run_with_borrowed_blob(batch, body)?;
        self.after(fault, result)
    }
}
impl CandidateFaultIndex {
    fn before(
        &mut self,
        batch: &Batch,
    ) -> Result<Option<bool>, mdbn_store_file::index::IndexError> {
        use mdbn_store_file::index::{IndexError, IndexErrorKind};
        let candidate_write = batch.mode == BatchMode::Transaction
            && batch.stmts.iter().any(|s| {
                s.sql.contains("INSERT OR IGNORE INTO mi_") || s.sql.starts_with("WITH input(body)")
            });
        let resident_read = batch.mode == BatchMode::Autocommit
            && batch
                .stmts
                .first()
                .is_some_and(|s| s.sql.starts_with("SELECT CASE WHEN typeof(body)"));
        let fault = if candidate_write || resident_read {
            self.fail.take()
        } else {
            None
        };
        if fault == Some(false) {
            return Err(IndexError::new(
                IndexErrorKind::Sql,
                "injected known pre-transaction abort",
            ));
        }
        Ok(fault)
    }
    fn after(
        &mut self,
        fault: Option<bool>,
        result: Vec<mdbn_store_file::index::StmtResult>,
    ) -> Result<Vec<mdbn_store_file::index::StmtResult>, mdbn_store_file::index::IndexError> {
        use mdbn_store_file::index::{IndexError, IndexErrorKind};
        if fault == Some(true) {
            return Err(IndexError::new(
                IndexErrorKind::Other,
                "injected unknown acknowledgment",
            ));
        }
        Ok(result)
    }
}
#[test]
fn candidate_persistence_errors_drop_the_exclusive_handle_and_reopen_stays_closed() {
    use mdbn_replica::mirror_admission::{candidate, install_budget::WorkingSet};
    use mdbn_replica::store::{Head, meta_keys};
    for effect in 0..3 {
        for after in [false, true] {
            let f = Fixture::new("mirror-candidate-terminal");
            let pending = mdbn_replica::conformance::pending_row(7, 41);
            let hold = Hold {
                id: pending.mutation.id,
                path: "photo.bin".into(),
                reason: HoldReason::Conflict,
                since: 123,
                base: Some(blob(b"base bytes", 1)),
                mine: blob(b"mine", 2),
                theirs: Some(blob(b"theirs", 3)),
                saves: 4,
            };
            let mut identity = vec![1; 16];
            identity.extend_from_slice(&[2; 16]);
            {
                let mut store = f.sql();
                store
                    .commit(Tx {
                        pending_put: vec![pending.clone()],
                        holds_put: vec![hold.clone()],
                        meta: vec![(meta_keys::IDENTITY.into(), Some(identity))],
                        ..Tx::default()
                    })
                    .unwrap();
            }
            let fail = Rc::new(std::cell::Cell::new(None));
            let index = Rc::new(RefCell::new(CandidateFaultIndex {
                inner: SqliteIndex::open(f.private.join("index.sqlite"), IndexDurability::Durable)
                    .unwrap(),
                fail: fail.clone(),
            }));
            let store = SqlStore::open_with_limits(index, SqlStoreLimits::DESKTOP).unwrap();
            let mut closed = Closed::begin(store, [1; 16], 3).unwrap();
            let request = candidate::Request {
                candidate: [3; 16],
                fence: Fence::new([1; 16], 3).unwrap(),
                identity: candidate::Identity {
                    collection: [1; 16],
                    replica: [2; 16],
                    incarnation: 1,
                    generation: 0,
                },
                old_head: Head::GENESIS,
                target: candidate::Target {
                    cutover_seq: 1,
                    barrier_f: 2,
                    s_final: 90,
                    manifest: [5; 32],
                    state_digest: [6; 32],
                    chain: [7; 32],
                    epoch: 1,
                },
            };
            let working = WorkingSet::default();
            if effect > 0 {
                closed.candidate_begin(&request, &working).unwrap();
            }
            if effect > 1 {
                closed.candidate_reserve(&request, 0, 4, &working).unwrap();
            }
            fail.set(Some(after));
            let result = match effect {
                0 => closed.candidate_begin(&request, &working),
                1 => closed.candidate_reserve(&request, 0, 4, &working),
                _ => {
                    let mut body = working.buffer(4).unwrap();
                    body.as_mut_slice().copy_from_slice(b"body");
                    closed.candidate_write(&request, 0, body, &working)
                }
            };
            assert!(matches!(
                result,
                Err(Error::CandidateRequiresReopen(candidate::Error::Storage(_)))
            ));
            assert_eq!(working.used().unwrap(), 0);
            assert!(closed.diagnostic().requires_reopen);
            assert!(matches!(
                closed.candidate_begin(&request, &working),
                Err(Error::Terminal)
            ));
            assert!(matches!(closed.abandon(), Err(Error::Terminal)));
            // Fresh exclusive open succeeds while terminal driver is still alive:
            // no inner index/store leaked through its error or retained handle.
            let store = f.sql();
            assert_eq!(
                store.pending_get(&pending.mutation.id).unwrap(),
                Some(pending)
            );
            assert_eq!(store.hold(&hold.id).unwrap(), Some(hold));
            assert_eq!(Fence::load(&store).unwrap(), Some(request.fence));
            let reopened = Closed::resume(store).unwrap();
            assert_eq!(reopened.diagnostic().phase, "joining");
            assert!(!reopened.diagnostic().requires_reopen);
            f.assert_user_bytes(b"initial user bytes");
        }
    }
}

#[test]
fn resident_read_errors_drop_the_driver_handle_and_preserve_complete_evidence() {
    use mdbn_replica::mirror_admission::{
        candidate,
        install_budget::{Work, WorkingSet},
    };
    use mdbn_replica::store::{Head, meta_keys};
    for scenario in 0..5 {
        let f = Fixture::new("mirror-resident-read-terminal");
        let pending = mdbn_replica::conformance::pending_row(7, 41);
        let hold = Hold {
            id: pending.mutation.id,
            path: "photo.bin".into(),
            reason: HoldReason::Conflict,
            since: 123,
            base: Some(blob(b"base bytes", 1)),
            mine: blob(b"mine", 2),
            theirs: Some(blob(b"theirs", 3)),
            saves: 4,
        };
        let mut identity = vec![1; 16];
        identity.extend_from_slice(&[2; 16]);
        {
            let mut store = f.sql();
            store
                .commit(Tx {
                    pending_put: vec![pending.clone()],
                    holds_put: vec![hold.clone()],
                    meta: vec![(meta_keys::IDENTITY.into(), Some(identity))],
                    ..Tx::default()
                })
                .unwrap();
        }
        let fail = Rc::new(std::cell::Cell::new(None));
        let index = Rc::new(RefCell::new(CandidateFaultIndex {
            inner: SqliteIndex::open(f.private.join("index.sqlite"), IndexDurability::Durable)
                .unwrap(),
            fail: fail.clone(),
        }));
        let store = SqlStore::open_with_limits(index, SqlStoreLimits::DESKTOP).unwrap();
        let mut closed = Closed::begin(store, [1; 16], 3).unwrap();
        let request = candidate::Request {
            candidate: [3; 16],
            fence: Fence::new([1; 16], 3).unwrap(),
            identity: candidate::Identity {
                collection: [1; 16],
                replica: [2; 16],
                incarnation: 1,
                generation: 0,
            },
            old_head: Head::GENESIS,
            target: candidate::Target {
                cutover_seq: 1,
                barrier_f: 2,
                s_final: 90,
                manifest: [5; 32],
                state_digest: [6; 32],
                chain: [7; 32],
                epoch: 1,
            },
        };
        // Target fields are raw arrays; no proof or authenticated session is
        // manufactured by fixture labels or a matching byte address.
        let working = WorkingSet::default();
        closed.candidate_begin(&request, &working).unwrap();
        closed.candidate_reserve(&request, 0, 4, &working).unwrap();
        working
            .precharge(Work {
                pass_bytes: 2 * 4 + 4096,
                ..Work::default()
            })
            .unwrap();
        let mut body = working.buffer(4).unwrap();
        body.as_mut_slice().copy_from_slice(b"body");
        closed.candidate_write(&request, 0, body, &working).unwrap();
        let address = mdbn_wire::hash::sha256(b"body");
        let mut retained = None;
        let mut held = None;
        let expected = match scenario {
            0 | 1 => {
                fail.set(Some(scenario == 1));
                candidate::Error::Storage(candidate::StorageRefusal::Io)
            }
            2 => {
                held = Some(
                    working
                        .reserve(
                            mdbn_replica::mirror_admission::install_budget::MAX_WORKING_BYTES
                                - 64 * 1024
                                + 1,
                        )
                        .unwrap(),
                );
                candidate::Error::Budget(
                    mdbn_replica::mirror_admission::install_budget::Error::WorkingSet,
                )
            }
            3 => {
                working
                    .precharge(Work {
                        pass_bytes: mdbn_replica::mirror_admission::install_budget::MAX_PASS_BYTES
                            - working.work_used().unwrap().pass_bytes,
                        ..Work::default()
                    })
                    .unwrap();
                candidate::Error::Budget(
                    mdbn_replica::mirror_admission::install_budget::Error::PassBytes,
                )
            }
            _ => {
                let output = closed
                    .candidate_read(&request, 0, &address, &working)
                    .unwrap();
                assert_eq!(output.as_slice(), b"body");
                assert!(working.owns_buffer(&output));
                assert_eq!(working.used().unwrap(), 4);
                assert!(!closed.diagnostic().requires_reopen);
                retained = Some(output);
                candidate::Error::Conflict
            }
        };
        let expected_address = if scenario == 4 {
            mdbn_wire::hash::sha256(b"wrong")
        } else {
            address
        };
        match closed.candidate_read(&request, 0, &expected_address, &working) {
            Err(Error::CandidateRequiresReopen(actual)) => assert_eq!(actual, expected),
            other => panic!("missing terminal refusal: {other:?}"),
        }
        drop(held);
        assert_eq!(
            working.used().unwrap(),
            if retained.is_some() { 4 } else { 0 }
        );
        assert!(closed.diagnostic().requires_reopen);
        assert!(matches!(
            closed.candidate_read(&request, 0, &address, &working),
            Err(Error::Terminal)
        ));
        assert!(matches!(closed.abandon(), Err(Error::Terminal)));
        // A fresh exclusive open succeeds while the terminal driver still lives.
        // This is evidence inspection, not settlement or a native-effect retry.
        let store = f.sql();
        assert_eq!(
            store.pending_get(&pending.mutation.id).unwrap(),
            Some(pending)
        );
        assert_eq!(store.hold(&hold.id).unwrap(), Some(hold));
        assert_eq!(Fence::load(&store).unwrap(), Some(request.fence));
        let rows = store
            .index()
            .borrow_mut()
            .run(&Batch {
                mode: BatchMode::Autocommit,
                stmts: vec![Stmt::new("SELECT body FROM mi_part", vec![])],
            })
            .unwrap();
        assert_eq!(rows[0].values, vec![SqlValue::Blob(b"body".to_vec())]);
        f.assert_user_bytes(b"initial user bytes");
        drop(retained);
        assert_eq!(working.used().unwrap(), 0);
    }
}

#[test]
fn sqlite_closed_driver_keeps_original_pending_binary_hold_and_user_edits() {
    let f = Fixture::new("mirror-retained");
    let pending = mdbn_replica::conformance::pending_row(7, 41);
    let pending_id = pending.mutation.id;
    let pending_bytes = pending.to_bytes();
    let hold = Hold {
        id: pending_id,
        path: "photo.bin".into(),
        reason: HoldReason::Conflict,
        since: 123,
        base: Some(blob(b"base bytes", 1)),
        mine: blob(b"kept user bytes", 2),
        theirs: Some(blob(b"lost server bytes", 3)),
        saves: 4,
    };
    let hold_bytes = hold.to_bytes().unwrap();
    let original = pending_bytes.clone();
    std::fs::write(f.private.join("legacy-journal"), &original).unwrap();
    {
        let mut store = f.sql();
        store
            .commit(Tx {
                pending_put: vec![pending],
                holds_put: vec![hold],
                meta: vec![("mirror_original_unknown".into(), Some(original.clone()))],
                ..Tx::default()
            })
            .unwrap();
    }
    let mut d = Closed::begin(f.sql(), [1; 16], 3).unwrap();
    // OS editing is deliberately outside the fence. No observations are acked.
    std::fs::write(f.folder.join("local.md"), b"edited while joining").unwrap();
    std::fs::write(f.folder.join("photo.bin"), b"new local attachment bytes").unwrap();
    d.abandon().unwrap();
    drop(d);
    for _ in 0..2 {
        let diagnostic = Closed::resume(f.sql()).unwrap().diagnostic();
        assert_eq!(diagnostic.phase, "detached");
        let store = f.sql();
        assert_eq!(
            store.pending_get(&pending_id).unwrap().unwrap().to_bytes(),
            pending_bytes
        );
        assert_eq!(
            store
                .hold(&pending_id)
                .unwrap()
                .unwrap()
                .to_bytes()
                .unwrap(),
            hold_bytes
        );
        assert_eq!(
            store.meta("mirror_original_unknown").unwrap().unwrap(),
            original
        );
        drop(store);
        assert_eq!(
            std::fs::read(f.private.join("legacy-journal")).unwrap(),
            original
        );
        f.assert_user_bytes(b"edited while joining");
        assert_eq!(
            std::fs::read(f.folder.join("photo.bin")).unwrap(),
            b"new local attachment bytes"
        );
    }
    assert!(matches!(
        Closed::begin(f.sql(), [2; 16], 3),
        Err(Error::DifferentAttempt)
    ));
    assert_eq!(
        Closed::resume(f.sql()).unwrap().diagnostic().phase,
        "detached"
    );
}
