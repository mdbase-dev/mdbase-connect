//! Real snapshot builder/endorser + bundled SQLite/codec. Fake log and explicitly
//! plaintext TEST sealer isolate SQL transport, not cryptographic qualification.
use super::*;
use r::api::{ClientApi, SessionAuth};
use r::log::{EndpointId, LogClient, LogRequest, LogResponse};
use r::{DeviceSecrets, Host, Replica, ReplicaConfig, UtcOnly};
use w::client::{HelloParams, SubmitParams, SyncMode};
use w::common::{Text, Version};
use w::intent::{Create, Op};
const COLLECTION: B16 = B16([7; 16]);
fn device(n: u8) -> B16 {
    B16([100 + n; 16])
}
fn service() -> r::fake::FakeLogService {
    let svc = r::fake::FakeLogService::new();
    r::testkit::TestControlPlane::new(COLLECTION).bootstrap(
        &svc,
        w::policy::CState::E2e,
        &[device(1), device(2)],
    );
    svc
}
fn open<S: Store>(store: S, n: u8) -> Replica<S> {
    Replica::open(
        ReplicaConfig {
            collection: COLLECTION,
            device_id: device(n),
            replica_id: B16([n; 16]),
            mode: SyncMode::Synced,
            log_endpoint: EndpointId(1),
            verify: true,
            runtime_version: "record-budget-test".into(),
            trusted_roots: vec![r::testkit::TEST_ROOT],
            trusted_signers: vec![device(1), device(2)],
            e2e: false,
            user_enabled_cloud_copy: false,
            chosen_state: None,
            expected_genesis: None,
            key_grants_only: false,
            policy_pins: None,
        },
        store,
        Box::new(r::plan::CorePlanner),
        Box::new(r::seal::PlainSealer::for_device(device(n))),
        Host {
            clock: Box::new(mdbn_core::host::FixedClock(1_700_000_000_000)),
            entropy: Box::new(r::crypto::TestEntropy::new(n)),
            zones: Box::new(UtcOnly),
        },
        DeviceSecrets {
            sign_sk: [n; 32],
            kem_sk: [n; 32],
        },
    )
    .unwrap()
}
fn settle<S: Store>(app: &mut Replica<S>, svc: &r::fake::FakeLogService, n: u8) {
    let mut log = svc.client(device(n));
    for _ in 0..12 {
        r::log::pump(app, &mut log, 200);
        app.tick();
    }
}
fn create_records<S: Store>(app: &mut Replica<S>, svc: &r::fake::FakeLogService) {
    settle(app, svc, 1);
    let (session, _) = app
        .hello(
            SessionAuth::Host,
            HelloParams {
                versions: vec![Version { major: 1, minor: 0 }],
                client_name: "record-budget".into(),
                client_version: "1".into(),
                features: None,
                timezone: None,
            },
        )
        .unwrap();
    for row in rows(121, 68_000) {
        app.submit(
            session,
            SubmitParams {
                ops: vec![Op::Create(Create {
                    id: row.id,
                    path: Some(row.path),
                    type_name: None,
                    frontmatter: None,
                    body: None,
                    document: Some(Text::Inline(row.doc)),
                })],
                mutation_id: None,
                conflict_mode: None,
                timezone: None,
                allow_partial: None,
                mutation_ids: None,
                dry_run: None,
                include: None,
                wait: None,
            },
        )
        .unwrap();
        settle(app, svc, 1);
    }
    assert_eq!(
        app.store().record_count().unwrap(),
        121,
        "genuine applied creates"
    );
    assert!(app.sync_status().incidents.is_empty());
}
#[test]
fn ten_thousand_small_record_snapshot_uses_grouped_sql_not_per_record_reads() {
    // Raw SQL fixture measures scan cost ONLY, not log/state authenticity.
    // The large-record controls below use genuinely applied client creates.
    let svc = service();
    let (store, reads) = fixture("record-budget-small-10k");
    let mut app = open(store, 1);
    settle(&mut app, &svc, 1);
    let rows = rows(10_000, 128);
    for chunk in rows.chunks(64) {
        app.store_mut()
            .commit(Tx {
                records_put: chunk.to_vec(),
                ..Default::default()
            })
            .unwrap();
    }
    reads.borrow_mut().clear();
    app.build_snapshot_now().unwrap();
    settle(&mut app, &svc, 1);
    assert_eq!(app.stats.snapshots_built, 1);
    let count = reads.borrow().len();
    eprintln!("10k-small-record actual snapshot record SQL reads: {count}");
    assert!(
        count <= 100,
        "must not hydrate one record per SQL request: {count}"
    );
}

#[test]
fn actual_snapshot_builder_reads_large_records_through_bounded_codec() {
    let svc = service();
    let (store, reads) = fixture("record-budget-builder");
    let mut app = open(store, 1);
    create_records(&mut app, &svc);
    reads.borrow_mut().clear();
    app.build_snapshot_now()
        .expect("large-record snapshot must build through4MiB replies");
    settle(&mut app, &svc, 1);
    assert_eq!(app.stats.snapshots_built, 1);
    assert!(reads.borrow().iter().any(|q| q.contains("LIMIT")));
    assert!(app.sync_status().incidents.is_empty());
}
#[test]
fn actual_snapshot_endorser_preserves_large_record_state_digest() {
    let svc = service();
    let author = SqlStore::open(Rc::new(RefCell::new(
        SqliteIndex::open(
            scratch("record-budget-author-oracle").join("state.db"),
            IndexDurability::Durable,
        )
        .unwrap(),
    )))
    .unwrap();
    let mut a = open(author, 1);
    let (target, reads) = fixture("record-budget-endorser");
    let mut b = open(target, 2);
    create_records(&mut a, &svc);
    settle(&mut b, &svc, 2);
    assert_eq!(b.store().record_count().unwrap(), 121);
    assert_eq!(a.head(), b.head());
    let expected = r::replica::state_digest(a.store()).unwrap();
    a.build_snapshot_now().unwrap();
    settle(&mut a, &svc, 1);
    assert_eq!(a.stats.snapshots_built, 1);
    reads.borrow_mut().clear();
    b.check_snapshots();
    settle(&mut b, &svc, 2);
    let pointers = svc
        .client(device(2))
        .call(LogRequest::GetSnapshot {
            collection: COLLECTION,
        })
        .unwrap();
    let LogResponse::GetSnapshot(pointers) = pointers else {
        panic!("snapshot pointers")
    };
    assert!(
        pointers.iter().any(|p| p.endorsed),
        "large-record same-state peer must endorse: {:?}",
        b.sync_status().incidents
    );
    assert_eq!(r::replica::state_digest(b.store()).unwrap(), expected);
    assert!(reads.borrow().iter().any(|q| q.contains("LIMIT")));
    assert!(b.sync_status().incidents.is_empty());
}
