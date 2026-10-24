//! Isolated ledger qualification on real SQLite. No verifier/swap/runtime claim.
//! Faults model transaction-boundary drift, known abort and unknown acknowledgment;
//! they do not certify power loss, physical page/WAL quotas, or native authority.
use super::*;
use mdbn_store_file::SqlStore;
use mdbn_store_file::index::{BorrowedBlob, IndexError, IndexInfo, StmtResult};
use mdbn_store_file::testing::replica::conformance::{id, pending_row, record};
use mdbn_store_file::testing::replica::mirror_admission::{
    Fence, META,
    candidate::{Error, HEADER_BYTES, Identity, MAX_PART_BYTES, Request, Target},
    install_budget::{self, Buffer, WorkingSet},
};
use mdbn_store_file::testing::replica::store::{Head, Stage, meta_keys};
use mdbn_store_file::testing::wire::client::{Hold, HoldReason};
use mdbn_store_file::testing::wire::snapshot::TextOrBlob;
use std::path::Path;

#[path = "mirror_candidate_resident.rs"]
mod resident;
#[path = "mirror_candidate_work.rs"]
mod work;

type Ledger = SqlStore<InjectedIndex>;
#[derive(Default)]
struct Injection {
    before: Option<Stmt>,
    abort: bool,
    unknown: bool,
    calls: u64,
    body_pointer: Option<usize>,
    expected_working: Option<WorkingSet>,
    query_failure: Option<QueryFailure>,
    barrier_calls: u64,
    barrier_failure: Option<(IndexError, WorkingSet, bool)>,
    close_unclean: bool,
    resident_before: Option<Stmt>,
    resident_after: Option<IndexError>,
    resident_live: Option<(WorkingSet, u64)>,
    resident_calls: u64,
}
struct QueryFailure {
    prefix: &'static str,
    skip: u64,
    error: IndexError,
    working: WorkingSet,
    input_bytes: u64,
}
struct InjectedIndex {
    inner: Option<SqliteIndex>,
    hook: Rc<RefCell<Injection>>,
}
impl Drop for InjectedIndex {
    fn drop(&mut self) {
        if self.hook.borrow().close_unclean
            && let Some(inner) = self.inner.take()
        {
            inner.close_unclean();
        }
    }
}
impl IndexStorage for InjectedIndex {
    fn info(&self) -> IndexInfo {
        self.inner.as_ref().unwrap().info()
    }
    fn reset(&mut self) -> Result<(), IndexError> {
        self.inner.as_mut().unwrap().reset()
    }
    fn defer_sync(&mut self, on: bool) -> Result<bool, IndexError> {
        if !on {
            self.hook.borrow_mut().barrier_calls += 1;
            let failure = self.hook.borrow_mut().barrier_failure.take();
            if let Some((error, working, after)) = failure {
                assert!(working.used().unwrap() >= 64 * 1024);
                if let Some((resident, bytes)) = &self.hook.borrow().resident_live {
                    assert!(resident.used().unwrap() >= 64 * 1024 + 3 * bytes + 4096);
                }
                if after {
                    self.inner.as_mut().unwrap().defer_sync(false)?;
                }
                return Err(error);
            }
        }
        self.inner.as_mut().unwrap().defer_sync(on)
    }
    fn run(&mut self, batch: &Batch) -> Result<Vec<StmtResult>, IndexError> {
        let candidate_write = self.before(batch, None)?;
        let result = self.inner.as_mut().unwrap().run(batch)?;
        if batch
            .stmts
            .first()
            .is_some_and(|s| s.sql.starts_with("SELECT CASE WHEN typeof(body)"))
            && let Some(error) = self.hook.borrow_mut().resident_after.take()
        {
            return Err(error);
        }
        self.after(candidate_write, result)
    }
    fn run_with_borrowed_blob(
        &mut self,
        batch: &Batch,
        body: BorrowedBlob<'_>,
    ) -> Result<Vec<StmtResult>, IndexError> {
        let candidate_write = self.before(batch, Some(body))?;
        let result = self
            .inner
            .as_mut()
            .unwrap()
            .run_with_borrowed_blob(batch, body)?;
        self.after(candidate_write, result)
    }
}
impl InjectedIndex {
    fn before(
        &mut self,
        batch: &Batch,
        borrowed: Option<BorrowedBlob<'_>>,
    ) -> Result<bool, IndexError> {
        self.hook.borrow_mut().calls += 1;
        {
            let mut hook = self.hook.borrow_mut();
            if batch.mode == BatchMode::Autocommit
                && let Some(failure) = hook.query_failure.as_mut()
                && batch
                    .stmts
                    .first()
                    .is_some_and(|s| s.sql.starts_with(failure.prefix))
            {
                if failure.skip == 0 {
                    assert!(failure.working.used().unwrap() >= 64 * 1024 + failure.input_bytes);
                    return Err(hook.query_failure.take().unwrap().error);
                }
                failure.skip -= 1;
            }
        }
        if batch
            .stmts
            .first()
            .is_some_and(|s| s.sql.starts_with("SELECT CASE WHEN typeof(body)"))
        {
            let mut hook = self.hook.borrow_mut();
            hook.resident_calls += 1;
            if let Some((working, bytes)) = &hook.resident_live {
                assert!(working.used().unwrap() >= 64 * 1024 + 3 * bytes + 4096);
            }
            if let Some(statement) = hook.resident_before.take() {
                self.inner.as_mut().unwrap().run(&Batch {
                    mode: BatchMode::Transaction,
                    stmts: vec![statement],
                })?;
            }
        }
        let candidate_write = batch.mode == BatchMode::Transaction
            && batch.stmts.iter().any(|s| {
                s.sql.contains("INSERT OR IGNORE INTO mi_") || s.sql.starts_with("WITH input(body)")
            });
        if candidate_write {
            let mut hook = self.hook.borrow_mut();
            if let Some(statement) = hook.before.take() {
                self.inner.as_mut().unwrap().run(&Batch {
                    mode: BatchMode::Transaction,
                    stmts: vec![statement],
                })?;
            }
            if let Some(pointer) = hook.body_pointer.take() {
                let body = borrowed.expect("borrowed body binding");
                assert_eq!(body.parameter, 0);
                assert_eq!(batch.stmts[0].params[0], SqlValue::Null);
                assert_eq!(
                    body.bytes.as_ptr() as usize,
                    pointer,
                    "only original Rust body borrowed"
                );
                // Buffer is fixed-size: its full charged capacity equals this
                // slice length. Preserve the full source+control live oracle.
                assert!(
                    hook.expected_working.as_ref().unwrap().used().unwrap()
                        >= body.bytes.len() as u64 + 64 * 1024
                );
            }
            if std::mem::take(&mut hook.abort) {
                return Err(IndexError::new(
                    IndexErrorKind::Sql,
                    "injected pre-transaction abort",
                ));
            }
        }
        Ok(candidate_write)
    }
    fn after(
        &mut self,
        candidate_write: bool,
        result: Vec<StmtResult>,
    ) -> Result<Vec<StmtResult>, IndexError> {
        if candidate_write && std::mem::take(&mut self.hook.borrow_mut().unknown) {
            return Err(IndexError::new(
                IndexErrorKind::Other,
                "injected lost commit acknowledgment",
            ));
        }
        Ok(result)
    }
}
fn open(path: &Path, hook: &Rc<RefCell<Injection>>) -> Ledger {
    SqlStore::open(Rc::new(RefCell::new(InjectedIndex {
        inner: Some(SqliteIndex::open(path, IndexDurability::Durable).unwrap()),
        hook: hook.clone(),
    })))
    .unwrap()
}
fn sql(s: &Ledger, statement: Stmt) -> StmtResult {
    s.index()
        .borrow_mut()
        .run(&Batch {
            mode: BatchMode::Transaction,
            stmts: vec![statement],
        })
        .unwrap()
        .remove(0)
}
fn read(s: &Ledger, query: &str) -> Vec<SqlValue> {
    s.index()
        .borrow_mut()
        .run(&Batch {
            mode: BatchMode::Autocommit,
            stmts: vec![Stmt::new(query, vec![])],
        })
        .unwrap()
        .remove(0)
        .values
}
fn request() -> Request {
    Request {
        candidate: [5; 16],
        fence: Fence::new([7; 16], 3).unwrap(),
        identity: Identity {
            collection: [1; 16],
            replica: [2; 16],
            incarnation: 3,
            generation: 4,
        },
        old_head: Head::GENESIS,
        target: Target {
            cutover_seq: 9,
            barrier_f: 12,
            s_final: 500,
            manifest: [10; 32],
            state_digest: [11; 32],
            chain: [12; 32],
            epoch: 1,
        },
    }
}
fn fixture(name: &str) -> (PathBuf, Ledger, Rc<RefCell<Injection>>, Request, WorkingSet) {
    let path = scratch(name).join("state.db");
    let hook = Rc::new(RefCell::new(Injection::default()));
    let mut s = open(&path, &hook);
    let r = request();
    let mut identity = r.identity.collection.to_vec();
    identity.extend_from_slice(&r.identity.replica);
    s.commit(Tx {
        records_put: vec![record(1, "original.md", "original")],
        pending_put: vec![pending_row(1, 6)],
        holds_put: vec![Hold {
            id: id(8),
            path: "held.md".into(),
            reason: HoldReason::Conflict,
            since: 21,
            base: Some(TextOrBlob::Text("old base".into())),
            mine: TextOrBlob::Text("mine".into()),
            theirs: Some(TextOrBlob::Text("theirs".into())),
            saves: 4,
        }],
        meta: vec![
            (meta_keys::IDENTITY.into(), Some(identity)),
            ("original_capture".into(), Some(vec![9, 0, 255])),
            ("journal_unknown".into(), Some(vec![4, 0, 3])),
        ],
        ..Tx::default()
    })
    .unwrap();
    s.commit(Tx {
        stage: Stage::Put,
        records_put: vec![record(9, "interrupted.md", "old stage")],
        ..Tx::default()
    })
    .unwrap();
    // Existing opaque disk evidence is not decoded by this isolated ledger.
    // Complete native Hold/journal semantics are covered by the separate driver suite.
    use mdbn_store_file::diskdb::{DiskDb, Kind};
    SqlDiskDb::open(s.index())
        .unwrap()
        .apply(vec![
            (Kind::Disk, b"original.md".to_vec(), Some(vec![1, 0, 1])),
            (
                Kind::Observation,
                b"unacked".to_vec(),
                Some(vec![4, 0, 255]),
            ),
            (Kind::Retained, b"retained".to_vec(), Some(vec![3, 0, 255])),
            (Kind::Intent, b"journal".to_vec(), Some(vec![2, 0, 255])),
        ])
        .unwrap();
    r.fence.persist(&mut s).unwrap();
    (path, s, hook, r, WorkingSet::default())
}
fn originals(s: &Ledger) -> Vec<Vec<SqlValue>> {
    read(
        s,
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'mi_%' ORDER BY name",
    )
    .into_iter()
    .map(|v| {
        let SqlValue::Text(name) = v else {
            panic!("table")
        };
        read(s, &format!("SELECT * FROM \"{name}\" ORDER BY 1,2"))
    })
    .collect()
}
fn ledger(s: &Ledger) -> (Vec<SqlValue>, Vec<SqlValue>) {
    (
        read(s, "SELECT * FROM mi_candidate ORDER BY id"),
        read(s, "SELECT * FROM mi_part ORDER BY candidate,ordinal"),
    )
}
fn body(w: &WorkingSet, bytes: &[u8]) -> Buffer {
    // Admit initialization/fill on the same attempt before allocating the input.
    w.precharge(install_budget::Work {
        pass_bytes: 2 * bytes.len() as u64 + 4096,
        ..install_budget::Work::default()
    })
    .unwrap();
    let mut buffer = w.buffer(bytes.len()).unwrap();
    buffer.as_mut_slice().copy_from_slice(bytes);
    buffer
}
#[test]
fn immutable_isolated_ledger_reopens_without_touching_original_state() {
    let (path, mut s, hook, r, w) = fixture("candidate-isolation");
    let before = originals(&s);
    s.mirror_candidate_begin(&r, &w).unwrap();
    s.mirror_candidate_begin(&r, &w).unwrap();
    s.mirror_candidate_reserve(&r, 0, 17, &w).unwrap();
    s.mirror_candidate_reserve(&r, 0, 17, &w).unwrap();
    let b = body(&w, b"original body");
    hook.borrow_mut().body_pointer = Some(b.as_slice().as_ptr() as usize);
    hook.borrow_mut().expected_working = Some(w.clone());
    s.mirror_candidate_write(&r, 0, b, &w).unwrap();
    assert_eq!(w.used().unwrap(), 0);
    let saved = ledger(&s);
    assert_eq!(originals(&s), before);
    assert_eq!(
        s.record(&id(1)).unwrap(),
        Some(record(1, "original.md", "original"))
    );
    assert_eq!(s.pending(None, 10).unwrap(), vec![pending_row(1, 6)]);
    assert_eq!(s.holds().unwrap()[0].saves, 4);
    assert_eq!(
        s.mirror_candidate_write(&r, 0, body(&w, b"changed body"), &w),
        Err(Error::Conflict)
    );
    assert_eq!(
        s.mirror_candidate_reserve(&r, 0, 16, &w),
        Err(Error::Conflict)
    );
    let mut collision = r.clone();
    collision.identity.generation += 1;
    assert_eq!(
        s.mirror_candidate_begin(&collision, &w),
        Err(Error::Conflict)
    );
    let mut collision = r.clone();
    collision.target.barrier_f += 1;
    assert_eq!(
        s.mirror_candidate_begin(&collision, &w),
        Err(Error::Conflict)
    );
    assert_eq!(ledger(&s), saved);
    assert_eq!(originals(&s), before);
    drop(s);
    let mut s = open(&path, &hook);
    assert_eq!(ledger(&s), saved);
    assert_eq!(originals(&s), before);
    s.mirror_candidate_write(&r, 0, body(&w, b"original body"), &w)
        .unwrap();
    assert_eq!(ledger(&s), saved);
    assert_eq!(originals(&s), before);
    assert_eq!(Fence::load(&s).unwrap(), Some(r.fence));
}
#[test]
fn every_mutation_rechecks_current_fence_head_identity_inside_sql() {
    for effect in 0..3 {
        for drift in 0..3 {
            let (path, mut s, hook, mut r, w) = fixture(&format!("candidate-cas-{effect}-{drift}"));
            s.mirror_candidate_begin(&r, &w).unwrap();
            s.mirror_candidate_reserve(&r, 0, 16, &w).unwrap();
            if effect == 0 {
                r.candidate = [6; 16];
            }
            let before = ledger(&s);
            hook.borrow_mut().before = Some(match drift {
                0 => Stmt::new(
                    "UPDATE st_meta SET v=? WHERE k=?",
                    vec![
                        SqlValue::Blob(r.fence.detached().encode().unwrap()),
                        SqlValue::Text(META.into()),
                    ],
                ),
                1 => Stmt::new(
                    "INSERT OR REPLACE INTO st_kv(k,v) VALUES('head',x'00')",
                    vec![],
                ),
                _ => Stmt::new(
                    "UPDATE st_meta SET v=zeroblob(32) WHERE k=?",
                    vec![SqlValue::Text(meta_keys::IDENTITY.into())],
                ),
            });
            let result = match effect {
                0 => s.mirror_candidate_begin(&r, &w),
                1 => s.mirror_candidate_reserve(&r, 1, 16, &w),
                _ => s.mirror_candidate_write(&r, 0, body(&w, b"body"), &w),
            };
            assert_eq!(result, Err(Error::Drift), "effect={effect} drift={drift}");
            assert_eq!(ledger(&s), before);
            assert_eq!(w.used().unwrap(), 0);
            drop(s);
            assert_eq!(ledger(&open(&path, &hook)), before);
        }
    }
}
#[test]
fn missing_future_malformed_detached_and_oversized_markers_refuse_boundedly() {
    for marker in [
        None,
        Some(vec![0]),
        Some(vec![0x81, 2]),
        Some(vec![0; 1024 * 1024]),
        Some(request().fence.detached().encode().unwrap()),
    ] {
        let (path, mut s, hook, r, w) = fixture("candidate-marker-shapes");
        s.mirror_candidate_begin(&r, &w).unwrap();
        let saved = ledger(&s);
        match marker {
            None => {
                sql(
                    &s,
                    Stmt::new(
                        "DELETE FROM st_meta WHERE k=?",
                        vec![SqlValue::Text(META.into())],
                    ),
                );
            }
            Some(bytes) => {
                sql(
                    &s,
                    Stmt::new(
                        "UPDATE st_meta SET v=? WHERE k=?",
                        vec![SqlValue::Blob(bytes), SqlValue::Text(META.into())],
                    ),
                );
            }
        }
        let old = originals(&s);
        assert_eq!(s.mirror_candidate_begin(&r, &w), Err(Error::Drift));
        assert_eq!(s.mirror_candidate_reserve(&r, 0, 4, &w), Err(Error::Drift));
        assert_eq!(
            s.mirror_candidate_write(&r, 0, body(&w, b"body"), &w),
            Err(Error::Drift)
        );
        assert_eq!(ledger(&s), saved);
        assert_eq!(originals(&s), old);
        drop(s);
        assert_eq!(ledger(&open(&path, &hook)), saved);
    }
}
#[test]
fn shared_working_refusal_precedes_all_index_calls_and_body_is_not_copied() {
    let (_, mut s, hook, r, w) = fixture("candidate-working-budget");
    let charge = w.reserve(install_budget::MAX_WORKING_BYTES).unwrap();
    let calls = hook.borrow().calls;
    let limit = Err(Error::Budget(install_budget::Error::WorkingSet));
    assert_eq!(s.mirror_candidate_begin(&r, &w), limit);
    assert_eq!(s.mirror_candidate_reserve(&r, 0, 4, &w), limit);
    assert_eq!(
        s.mirror_candidate_write(&r, 0, body(&WorkingSet::default(), b"body"), &w),
        limit
    );
    assert_eq!(hook.borrow().calls, calls);
    drop(charge);
    s.mirror_candidate_begin(&r, &w).unwrap();
    s.mirror_candidate_reserve(&r, 0, 4, &w).unwrap();
    let saved = ledger(&s);
    assert_eq!(
        s.mirror_candidate_write(&r, 0, body(&WorkingSet::default(), b"body"), &w),
        Err(Error::Invalid)
    );
    assert_eq!(
        s.mirror_candidate_write(&r, 0, body(&w, b"longer"), &w),
        Err(Error::Invalid)
    );
    assert_eq!(
        s.mirror_candidate_write(&r, 1, body(&w, b"body"), &w),
        Err(Error::Conflict)
    );
    assert_eq!(
        s.mirror_candidate_reserve(&r, 0, MAX_PART_BYTES + 1, &w),
        Err(Error::Invalid)
    );
    assert_eq!(ledger(&s), saved);
    assert_eq!(w.used().unwrap(), 0);
}
#[test]
fn all_retained_candidates_count_and_are_never_cleaned_to_fit() {
    let (_, mut s, _, mut r, w) = fixture("candidate-count-quota");
    s.mirror_candidate_begin(&r, &w).unwrap();
    sql(
        &s,
        Stmt::new(
            "WITH RECURSIVE n(i) AS(VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<99999) INSERT INTO mi_candidate(id,binding,charge) SELECT CAST(printf('old-%06d',i) AS BLOB),x'00',1024 FROM n",
            vec![],
        ),
    );
    assert_eq!(
        read(&s, "SELECT count(*) FROM mi_candidate"),
        vec![SqlValue::Integer(100000)]
    );
    let old = originals(&s);
    r.candidate = [6; 16];
    assert_eq!(
        s.mirror_candidate_begin(&r, &w),
        Err(Error::Budget(install_budget::Error::CandidateCount))
    );
    assert_eq!(
        read(&s, "SELECT count(*) FROM mi_candidate"),
        vec![SqlValue::Integer(100000)]
    );
    assert_eq!(originals(&s), old);
    assert_eq!(w.used().unwrap(), 0);
}
#[test]
fn retained_capacity_not_body_length_charges_exact_aggregate_bound() {
    let (path, mut s, hook, r, w) = fixture("candidate-byte-quota");
    s.mirror_candidate_begin(&r, &w).unwrap();
    sql(
        &s,
        Stmt::new(
            "WITH RECURSIVE n(i) AS(VALUES(0) UNION ALL SELECT i+1 FROM n WHERE i<1022) INSERT INTO mi_part(candidate,ordinal,bound,charge) SELECT ?,i,4194304,4194432 FROM n",
            vec![SqlValue::Blob(r.candidate.to_vec())],
        ),
    );
    let rest =
        install_budget::MAX_STAGED_BYTES - HEADER_BYTES - 1023 * (MAX_PART_BYTES + 128) - 128;
    s.mirror_candidate_reserve(&r, 1023, rest, &w).unwrap();
    assert_eq!(
        read(
            &s,
            "SELECT (SELECT sum(charge) FROM mi_candidate)+(SELECT sum(charge) FROM mi_part)"
        ),
        vec![SqlValue::Integer(install_budget::MAX_STAGED_BYTES as i64)]
    );
    let saved = ledger(&s);
    let original = originals(&s);
    assert_eq!(
        s.mirror_candidate_reserve(&r, 1024, 1, &w),
        Err(Error::Budget(install_budget::Error::StagedBytes))
    );
    // Even a tiny body remains bounded by its earlier durable capacity claim.
    s.mirror_candidate_write(&r, 0, body(&w, b"x"), &w).unwrap();
    assert_eq!(originals(&s), original);
    assert_eq!(
        read(&s, "SELECT sum(charge) FROM mi_part"),
        vec![SqlValue::Integer(
            (install_budget::MAX_STAGED_BYTES - HEADER_BYTES) as i64
        )]
    );
    drop(s);
    let mut s = open(&path, &hook);
    assert_eq!(
        s.mirror_candidate_reserve(&r, 1024, 1, &w),
        Err(Error::Budget(install_budget::Error::StagedBytes))
    );
    assert_eq!(ledger(&s).0, saved.0);
    assert_eq!(originals(&s), original);
}
#[test]
fn known_abort_and_unknown_ack_preserve_originals_and_require_explicit_reopen() {
    for effect in 0..3 {
        for unknown in [false, true] {
            let (path, mut s, hook, mut r, w) =
                fixture(&format!("candidate-fault-{effect}-{unknown}"));
            s.mirror_candidate_begin(&r, &w).unwrap();
            s.mirror_candidate_reserve(&r, 0, 4, &w).unwrap();
            let old = originals(&s);
            let saved = ledger(&s);
            if effect == 0 {
                r.candidate = [6; 16];
            }
            hook.borrow_mut().unknown = unknown;
            hook.borrow_mut().abort = !unknown;
            let result = match effect {
                0 => s.mirror_candidate_begin(&r, &w),
                1 => s.mirror_candidate_reserve(&r, 1, 4, &w),
                _ => s.mirror_candidate_write(&r, 0, body(&w, b"body"), &w),
            };
            assert!(matches!(result, Err(Error::Storage(_))), "{result:?}");
            assert_eq!(w.used().unwrap(), 0);
            // Never infer outcome from cached reads or retry the failed handle.
            drop(s);
            let s = open(&path, &hook);
            assert_eq!(originals(&s), old);
            if unknown {
                assert_ne!(ledger(&s), saved);
            } else {
                assert_eq!(ledger(&s), saved);
            }
            assert_eq!(Fence::load(&s).unwrap(), Some(r.fence));
        }
    }
}
#[test]
fn aggregate_quota_drift_is_rechecked_inside_each_sql_mutation() {
    for effect in 0..3 {
        let (_, mut s, hook, mut r, w) = fixture(&format!("candidate-quota-cas-{effect}"));
        s.mirror_candidate_begin(&r, &w).unwrap();
        s.mirror_candidate_reserve(&r, 0, 16, &w).unwrap();
        let old = originals(&s);
        let candidate_rows = ledger(&s);
        hook.borrow_mut().before = Some(Stmt::new(
            "WITH RECURSIVE n(i) AS(VALUES(0) UNION ALL SELECT i+1 FROM n WHERE i<1023) INSERT INTO mi_part(candidate,ordinal,bound,charge) SELECT x'00',i,4194304,4194432 FROM n",
            vec![],
        ));
        if effect == 0 {
            r.candidate = [6; 16];
        }
        let result = match effect {
            0 => s.mirror_candidate_begin(&r, &w),
            1 => s.mirror_candidate_reserve(&r, 1, 16, &w),
            _ => s.mirror_candidate_write(&r, 0, body(&w, b"body"), &w),
        };
        assert_eq!(
            result,
            Err(Error::Budget(install_budget::Error::StagedBytes))
        );
        assert_eq!(ledger(&s).0, candidate_rows.0);
        assert_eq!(
            read(
                &s,
                "SELECT * FROM mi_part WHERE candidate<>x'00' ORDER BY candidate,ordinal"
            ),
            candidate_rows.1
        );
        assert_eq!(originals(&s), old);
        assert_eq!(w.used().unwrap(), 0);
    }
}
#[test]
fn changed_reserved_bound_is_not_reused_even_when_body_would_fit() {
    let (_, mut s, hook, r, w) = fixture("candidate-bound-cas");
    s.mirror_candidate_begin(&r, &w).unwrap();
    s.mirror_candidate_reserve(&r, 0, 16, &w).unwrap();
    hook.borrow_mut().before = Some(Stmt::new(
        "UPDATE mi_part SET bound=4,charge=132 WHERE candidate=? AND ordinal=0",
        vec![SqlValue::Blob(r.candidate.to_vec())],
    ));
    assert_eq!(
        s.mirror_candidate_write(&r, 0, body(&w, b"body"), &w),
        Err(Error::Conflict)
    );
    assert_eq!(
        read(&s, "SELECT bound,body FROM mi_part"),
        vec![SqlValue::Integer(4), SqlValue::Null]
    );
    assert_eq!(w.used().unwrap(), 0);
}
#[test]
fn candidate_ack_closes_any_existing_deferred_durability_window() {
    let (path, mut s, hook, r, w) = fixture("candidate-deferred");
    s.defer_durability(true).unwrap();
    s.mirror_candidate_begin(&r, &w).unwrap();
    let saved = ledger(&s);
    drop(s);
    let s = open(&path, &hook);
    assert_eq!(ledger(&s), saved);
    assert_eq!(Fence::load(&s).unwrap(), Some(r.fence));
}
