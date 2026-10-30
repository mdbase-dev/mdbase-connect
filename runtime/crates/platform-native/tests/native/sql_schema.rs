//! Real SQLite migration/reopen tests; no reset of durable local state.
use super::*;
use mdbn_store_file::{SqlStore, testing::replica as r};
use r::store::{DERIVED_DATA_VERSION, RecordMeta, meta_keys};

fn index(path: &std::path::Path) -> Rc<RefCell<SqliteIndex>> {
    Rc::new(RefCell::new(
        SqliteIndex::open(path, IndexDurability::Durable).unwrap(),
    ))
}
fn sql<I: IndexStorage>(
    index: &Rc<RefCell<I>>,
    statements: &[&str],
) -> Vec<mdbn_store_file::index::StmtResult> {
    index
        .borrow_mut()
        .run(&Batch {
            mode: BatchMode::Transaction,
            stmts: statements.iter().map(|s| Stmt::new(*s, vec![])).collect(),
        })
        .unwrap()
}
fn version<I: IndexStorage>(index: &Rc<RefCell<I>>) -> i64 {
    match sql(index, &["PRAGMA user_version"])[0].values.as_slice() {
        [SqlValue::Integer(v)] => *v,
        other => panic!("version: {other:?}"),
    }
}
fn replica<I: IndexStorage>(
    store: SqlStore<I>,
) -> Result<r::Replica<SqlStore<I>>, r::replica::OpenError> {
    r::Replica::open(
        r::ReplicaConfig {
            collection: r::conformance::id(50),
            device_id: r::conformance::id(51),
            replica_id: r::conformance::id(52),
            mode: mdbn_store_file::testing::wire::client::SyncMode::Synced,
            log_endpoint: r::log::EndpointId(1),
            verify: false,
            runtime_version: "schema-test".into(),
            trusted_roots: vec![r::testkit::signed_root()],
            trusted_signers: vec![],
            e2e: false,
            user_enabled_cloud_copy: false,
            chosen_state: None,
            expected_genesis: None,
            key_grants_only: false,
            policy_pins: None,
        },
        store,
        Box::new(r::plan::CorePlanner),
        Box::new(r::seal::PlainSealer::for_device(r::conformance::id(51))),
        r::Host {
            clock: Box::new(mdbn_core::host::FixedClock(1700000000000)),
            entropy: Box::new(r::crypto::TestEntropy::new(1)),
            zones: Box::new(r::UtcOnly),
        },
        r::DeviceSecrets {
            sign_sk: [1; 32],
            kem_sk: [2; 32],
        },
    )
}

#[test]
fn fresh_database_gets_schema_and_derived_versions_and_warm_open_does_not_reindex() {
    let path = scratch("schema-fresh").join("state.db");
    let idx = index(&path);
    assert_eq!(version(&idx), 0);
    let store = SqlStore::open(idx.clone()).unwrap();
    assert_eq!(version(&idx), 1);
    let app = replica(store).unwrap();
    assert_eq!(app.stats.reindexed, 0);
    let store = app.into_store();
    assert_eq!(
        store.meta(meta_keys::DERIVED_VERSION).unwrap(),
        Some(DERIVED_DATA_VERSION.to_be_bytes().to_vec())
    );
    drop(store);
    drop(idx);
    assert_eq!(
        replica(SqlStore::open(index(&path)).unwrap())
            .unwrap()
            .stats
            .reindexed,
        0
    );
}

#[test]
fn unversioned_database_is_adopted_without_losing_any_durable_row_family() {
    let path = scratch("schema-legacy").join("state.db");
    let idx = index(&path);
    let mut store = SqlStore::open(idx.clone()).unwrap();
    let mut row = r::conformance::record(1, "old.md", "---\ntitle: old\n---\nbody");
    row.meta.tags = vec!["legacy-encoding-stays".into()];
    store
        .commit(Tx {
            records_put: vec![row.clone()],
            ..Tx::default()
        })
        .unwrap();
    // The v0 layout is unchanged by v1. These opaque local-state bytes MUST be
    // preserved even when migration itself cannot interpret their payloads.
    sql(
        &idx,
        &[
            "INSERT INTO st_pending VALUES(9, x'01', x'010203')",
            "INSERT INTO st_hold VALUES(x'02', x'040506')",
            "INSERT INTO st_lreceipt VALUES(x'03', 7, x'070809')",
            "INSERT INTO st_transfer VALUES(x'04', x'0a0b0c')",
            "INSERT INTO st_meta VALUES('local-secret-sentinel', x'0d0e0f')",
            "INSERT INTO st_chunk VALUES(x'04', 0, x'101112')",
            "PRAGMA user_version=0",
        ],
    );
    let queries = [
        "SELECT * FROM st_pending",
        "SELECT * FROM st_hold",
        "SELECT * FROM st_lreceipt",
        "SELECT * FROM st_transfer",
        "SELECT * FROM st_meta",
        "SELECT * FROM st_chunk",
        "SELECT * FROM st_rec",
    ];
    let before: Vec<_> = sql(&idx, &queries).into_iter().map(|r| r.values).collect();
    drop(store);
    drop(idx);
    let idx = index(&path);
    let store = SqlStore::open(idx.clone()).unwrap();
    assert_eq!(version(&idx), 1);
    let after: Vec<_> = sql(&idx, &queries).into_iter().map(|r| r.values).collect();
    assert_eq!(before, after);
    assert_eq!(store.record(&row.id).unwrap(), Some(row));
}

#[test]
fn newer_schema_refuses_before_ddl_and_does_not_reset() {
    let path = scratch("schema-newer").join("state.db");
    let idx = index(&path);
    sql(
        &idx,
        &[
            "CREATE TABLE future(bytes BLOB)",
            "INSERT INTO future VALUES(x'0102')",
            "PRAGMA user_version=2",
        ],
    );
    let err = SqlStore::open(idx.clone())
        .err()
        .expect("must refuse newer schema");
    assert!(
        matches!(err, r::StoreError::Io(ref m) if m.contains("newer") && m.contains("upgrade")),
        "{err}"
    );
    assert_eq!(version(&idx), 2);
    assert_eq!(
        sql(&idx, &["SELECT bytes FROM future"])[0].values,
        vec![SqlValue::Blob(vec![1, 2])]
    );
    assert_eq!(
        sql(
            &idx,
            &["SELECT count(*) FROM sqlite_master WHERE name='st_rec'"]
        )[0]
        .values,
        vec![SqlValue::Integer(0)]
    );
}

fn seed<I: IndexStorage>(store: &mut SqlStore<I>) {
    store
        .commit(Tx {
            records_put: (1..=130)
                .map(|n| {
                    let mut row = r::conformance::record(
                        n,
                        &format!("tasks/{n}.md"),
                        "---\ntitle: original\n---\nbody",
                    );
                    row.meta = RecordMeta {
                        types: vec!["stale".into()],
                        ..RecordMeta::default()
                    };
                    row
                })
                .collect(),
            resources_put: vec![("mdbase.yaml".into(), "spec_version: '0.3.0'\n".into())],
            ..Tx::default()
        })
        .unwrap();
}

#[test]
fn derived_version_change_reuses_reindex_across_all_pages_then_stamps_and_skips_warm_rebuild() {
    let path = scratch("schema-derived").join("state.db");
    let idx = index(&path);
    let mut store = SqlStore::open(idx.clone()).unwrap();
    seed(&mut store);
    // Missing (legacy) and explicitly older completed versions both migrate.
    for old in [None, Some(0u64.to_be_bytes().to_vec())] {
        store
            .commit(Tx {
                meta: vec![(meta_keys::DERIVED_VERSION.into(), old)],
                ..Tx::default()
            })
            .unwrap();
        let app = replica(store).unwrap();
        assert_eq!(app.stats.reindexed, 130);
        store = app.into_store();
        let catalog = r::plan::load_catalog(&store).unwrap();
        for row in store
            .records(r::store::Page {
                after: None,
                limit: 200,
            })
            .unwrap()
        {
            assert_eq!(
                row.meta,
                r::plan::record_meta(&catalog, &row.path, &row.doc)
            );
            assert_eq!(row.doc, "---\ntitle: original\n---\nbody");
        }
        assert_eq!(
            store.meta(meta_keys::DERIVED_VERSION).unwrap(),
            Some(DERIVED_DATA_VERSION.to_be_bytes().to_vec())
        );
        let app = replica(store).unwrap();
        assert_eq!(app.stats.reindexed, 0);
        store = app.into_store();
    }
}

#[test]
fn newer_or_malformed_derived_version_refuses_without_stamp_or_identity_write() {
    for (suffix, marker) in [("newer", 2u64.to_be_bytes().to_vec()), ("bad", vec![1, 2])] {
        let path = scratch(&format!("schema-derived-{suffix}")).join("state.db");
        let idx = index(&path);
        let mut store = SqlStore::open(idx.clone()).unwrap();
        store
            .commit(Tx {
                meta: vec![(meta_keys::DERIVED_VERSION.into(), Some(marker.clone()))],
                ..Tx::default()
            })
            .unwrap();
        let err = replica(store).expect_err("must refuse incompatible metadata");
        assert!(if suffix == "newer" {
            matches!(err, r::replica::OpenError::Mismatch(ref m) if m.contains("newer"))
        } else {
            matches!(err, r::replica::OpenError::Corrupt(_))
        });
        let store = SqlStore::open(idx).unwrap();
        assert_eq!(
            store.meta(meta_keys::DERIVED_VERSION).unwrap(),
            Some(marker)
        );
        assert!(store.meta(meta_keys::IDENTITY).unwrap().is_none());
    }
}

struct FailIndex {
    inner: SqliteIndex,
    writes: usize,
    fail_schema: bool,
}
impl IndexStorage for FailIndex {
    fn info(&self) -> mdbn_store_file::index::IndexInfo {
        self.inner.info()
    }
    fn reset(&mut self) -> Result<(), mdbn_store_file::index::IndexError> {
        panic!("migration must never reset durable data")
    }
    fn run(
        &mut self,
        batch: &Batch,
    ) -> Result<Vec<mdbn_store_file::index::StmtResult>, mdbn_store_file::index::IndexError> {
        if batch
            .stmts
            .iter()
            .any(|s| s.sql.starts_with("INSERT INTO st_rec("))
        {
            self.writes += 1;
        }
        let fail = if self.fail_schema {
            batch
                .stmts
                .iter()
                .any(|s| s.sql.starts_with("PRAGMA user_version="))
        } else {
            self.writes == 2
                && batch
                    .stmts
                    .iter()
                    .any(|s| s.sql.starts_with("INSERT INTO st_rec("))
        };
        if fail {
            let mut broken = batch.clone();
            broken.stmts.push(Stmt::new(
                "INSERT INTO missing_migration_table VALUES(1)",
                vec![],
            ));
            return self.inner.run(&broken);
        }
        self.inner.run(batch)
    }
}
#[test]
fn failed_schema_migration_rolls_back_ddl_and_version_then_cold_retry_succeeds() {
    let path = scratch("schema-rollback").join("state.db");
    let idx = Rc::new(RefCell::new(FailIndex {
        inner: SqliteIndex::open(&path, IndexDurability::Durable).unwrap(),
        writes: 0,
        fail_schema: true,
    }));
    assert!(SqlStore::open(idx.clone()).is_err());
    drop(idx);
    let idx = index(&path);
    assert_eq!(version(&idx), 0);
    assert_eq!(
        sql(
            &idx,
            &["SELECT count(*) FROM sqlite_master WHERE name LIKE 'st_%'"]
        )[0]
        .values,
        vec![SqlValue::Integer(0)]
    );
    SqlStore::open(idx.clone()).unwrap();
    assert_eq!(version(&idx), 1);
}
#[test]
fn interrupted_reindex_does_not_advance_version_and_cold_retry_completes() {
    let path = scratch("schema-reindex-retry").join("state.db");
    let idx = index(&path);
    let mut store = SqlStore::open(idx.clone()).unwrap();
    seed(&mut store);
    drop(store);
    drop(idx);
    let idx = Rc::new(RefCell::new(FailIndex {
        inner: SqliteIndex::open(&path, IndexDurability::Durable).unwrap(),
        writes: 0,
        fail_schema: false,
    }));
    assert!(replica(SqlStore::open(idx.clone()).unwrap()).is_err());
    assert_eq!(idx.borrow().writes, 2);
    drop(idx);
    let store = SqlStore::open(index(&path)).unwrap();
    assert!(store.meta(meta_keys::DERIVED_VERSION).unwrap().is_none());
    assert_eq!(store.record_count().unwrap(), 130);
    let app = replica(store).unwrap();
    assert_eq!(app.stats.reindexed, 130);
    assert_eq!(
        app.store().meta(meta_keys::DERIVED_VERSION).unwrap(),
        Some(DERIVED_DATA_VERSION.to_be_bytes().to_vec())
    );
}

/// Manual first-upgrade timing, not a latency gate or browser-durability proof.
#[test]
#[ignore = "manual large-store first-open measurement"]
fn upgrade_first_open_timing() {
    const ROWS: u64 = 10_000;
    let path = scratch("schema-upgrade-timing").join("state.db");
    let idx = index(&path);
    let mut store = SqlStore::open(idx.clone()).unwrap();
    let doc = format!(
        "---\ntitle: A task\nstatus: todo\ntags: [one, two]\n---\n{}",
        "A paragraph with [[another]] and #work.\n".repeat(48)
    );
    for start in (1..=ROWS).step_by(128) {
        store
            .commit(Tx {
                records_put: (start..=(start + 127).min(ROWS))
                    .map(|n| r::conformance::record(n, &format!("tasks/{n}.md"), &doc))
                    .collect(),
                ..Tx::default()
            })
            .unwrap();
    }
    sql(&idx, &["PRAGMA user_version=0"]);
    drop(store);
    drop(idx);
    let start = std::time::Instant::now();
    let app = replica(SqlStore::open(index(&path)).unwrap()).unwrap();
    let first = start.elapsed();
    assert_eq!(app.stats.reindexed, ROWS);
    assert_eq!(app.store().record_count().unwrap(), ROWS);
    drop(app);
    let start = std::time::Instant::now();
    let warm = replica(SqlStore::open(index(&path)).unwrap()).unwrap();
    let second = start.elapsed();
    assert_eq!(warm.stats.reindexed, 0);
    eprintln!(
        "upgrade timing: rows={ROWS} document_bytes={} first_open_ms={} warm_open_ms={} debug_assertions={}",
        doc.len() as u64 * ROWS,
        first.as_millis(),
        second.as_millis(),
        cfg!(debug_assertions)
    );
}
