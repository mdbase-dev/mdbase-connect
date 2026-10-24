//! Full R6 Replica dispatch over owned synthetic SQLite state.
use super::*;
use mdbn_store_file::testing::replica;
use replica::log::EndpointId;
use replica::replica::{DeviceSecrets, Host, Replica, ReplicaConfig, UtcOnly};
use replica::seal::PlainSealer;

struct FixedClock;
impl replica::Clock for FixedClock {
    fn now_ms(&self) -> u64 {
        1_700_000_000_000
    }
}
fn replica(store: SqlStore<Trace>) -> Replica<SqlStore<Trace>> {
    let cfg = ReplicaConfig {
        collection: B16([7; 16]),
        replica_id: B16([1; 16]),
        device_id: B16([101; 16]),
        mode: mdbn_store_file::testing::wire::client::SyncMode::Synced,
        log_endpoint: EndpointId(1),
        verify: true,
        runtime_version: "test".into(),
        trusted_roots: vec![replica::testkit::TEST_ROOT, replica::testkit::signed_root()],
        e2e: false,
        trusted_signers: (101..=109).map(|n| B16([n; 16])).collect(),
        user_enabled_cloud_copy: false,
        chosen_state: None,
        expected_genesis: None,
        key_grants_only: false,
        policy_pins: None,
    };
    Replica::open(
        cfg,
        store,
        Box::new(replica::CorePlanner),
        Box::new(PlainSealer::for_device(B16([101; 16]))),
        Host {
            clock: Box::new(FixedClock),
            entropy: Box::new(replica::crypto::TestEntropy::new(1)),
            zones: Box::new(UtcOnly),
        },
        DeviceSecrets {
            sign_sk: [1; 32],
            kem_sk: [1; 32],
        },
    )
    .unwrap()
}
fn seeded(name: &str) -> (Replica<SqlStore<Trace>>, Rc<RefCell<Trace>>) {
    let rows = (1..=33)
        .map(|n| row(n, &format!("priority: {n}\ntags: [task]")))
        .collect();
    let (mut store, index, _, _, _) = open(name, rows, &["priority"]);
    store
        .commit(Tx {
            resources_put: vec![("mdbase.yaml".into(), "spec_version: \"0.3.0\"\n".into())],
            ..Tx::default()
        })
        .unwrap();
    let r = replica(store);
    assert!(r.store().query_index_state().unwrap().unwrap().ready);
    assert!(r.store().query_projection_state().unwrap().unwrap().ready);
    (r, index)
}
fn check(r: &Replica<SqlStore<Trace>>) {
    let page = r
        .indexed_projection(
            QueryPredicate::All,
            vec!["missing".into(), "priority".into()],
            true,
            None,
            128,
            1 << 20,
        )
        .unwrap()
        .unwrap();
    assert_eq!(page.rows.len(), 33);
    assert!(!page.has_more);
    for (n, row) in (1..=33).zip(&page.rows) {
        assert_eq!(row.id, id(n));
        assert!(matches!(row.fields[0], RawField::Missing));
        assert!(
            matches!(row.fields[1], RawField::Present(CoreValue::Int(value)) if value == i64::from(n))
        );
        assert_eq!(row.tags, Some(vec!["#task".into()]));
    }
}

#[test]
fn replica_reopen_backfills_missing_raw_data_despite_ready_field_index() {
    let (r, index) = seeded("raw_driver_cold_migration");
    check(&r);
    let store = r.into_store();
    sql(&index, "DELETE FROM st_qraw", vec![]);
    sql(&index, "DELETE FROM st_qraw_state", vec![]);
    assert!(store.query_index_state().unwrap().unwrap().ready);
    assert!(!store.query_projection_state().unwrap().unwrap().ready);
    let reopened = replica(store);
    check(&reopened);
}

#[test]
fn replica_reopen_rebuilds_poisoned_raw_state_and_does_not_recertify_stale_payloads() {
    let (r, index) = seeded("raw_driver_poison_rebuild");
    let store = r.into_store();
    let stale = cbor::encode(
        &DataMap::<WireValue>(vec![("priority".into(), WireValue::Int(999))]).to_cbor(),
    )
    .unwrap();
    sql(
        &index,
        "UPDATE st_qraw SET fields=?",
        vec![SqlValue::Blob(stale)],
    );
    sql(&index, "UPDATE st_qraw_state SET ready=0,version=0", vec![]);
    assert!(store.query_index_state().unwrap().unwrap().ready);
    let reopened = replica(store);
    check(&reopened);
}

#[test]
fn replica_raw_state_declines_are_not_store_corruption_or_empty_success() {
    let (r, index) = seeded("raw_driver_decline");
    sql(&index, "UPDATE st_qraw_state SET ready=0", vec![]);
    let result = r
        .indexed_projection(QueryPredicate::All, vec![], false, None, 128, 1 << 20)
        .unwrap();
    assert!(matches!(
        result,
        Err(replica::replica::QueryDecline::NotReady)
    ));
}
