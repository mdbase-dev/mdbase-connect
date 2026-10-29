//! Actual SQLite app-local store, signed sync and native Bases READ regressions.
//! The log/host are test fixtures; this is not browser, OPFS or LAB qualification.
use super::*;
use mdbn_store_file::index::{IndexError, IndexInfo, StmtResult};
use mdbn_store_file::{
    SqlStoreLimits, TentativeStore,
    testing::{replica as r, wire as w},
};
use r::api::{ClientApi, ErrorCode, SessionAuth, SessionId};
use r::fake::FakeLogService;
use r::replica::{BasesViewSelection, DeviceSecrets, Host, Replica, ReplicaConfig, UtcOnly};
use r::store::meta_keys;
use r::store_query::{QueryPredicate, QueryProjectionRequest};
use w::client::{HelloParams, SubmitParams, SyncMode};
use w::common::{B16, B32, Version};
use w::intent::{Create, Op, ResourcePut};

#[path = "tentative_discovery/asfile_query.rs"]
mod asfile_query;
#[path = "tentative_discovery/host_views.rs"]
mod host_views;
#[path = "tentative_discovery/local_reads.rs"]
mod local_reads;
#[path = "tentative_discovery/missing_contract.rs"]
mod missing_contract;
#[path = "tentative_discovery/pending_inventory.rs"]
mod pending_inventory;
#[path = "tentative_discovery/raw_inventory.rs"]
mod raw_inventory;
#[path = "tentative_discovery/task_policy.rs"]
mod task_policy;

const SOURCE: &str = "# Original café source\nviews:\n  - type: table\n    name: First\n  - type: tasknotesTaskList\n    name: Second\n";
const SOURCE_PATH: &str = "TaskNotes/Views/original.base";
const COLLECTION: B16 = B16([7; 16]);
const DEVICE: B16 = B16([101; 16]);
const SOURCE_ID: B16 = B16([11; 16]);
const SIGN: [u8; 32] = [0x31; 32];
const KEM: [u8; 32] = [0x32; 32];

#[derive(Default)]
struct Probe {
    calls: Cell<usize>,
    record_blob_reads: Cell<usize>,
    transactions: Cell<usize>,
    fail_read: Cell<bool>,
    uncertain_commit: Cell<bool>,
    enforce_codec: Cell<bool>,
}
struct AppSql {
    inner: SqliteIndex,
    probe: Rc<Probe>,
}
impl IndexStorage for AppSql {
    fn info(&self) -> IndexInfo {
        self.inner.info()
    }
    fn reset(&mut self) -> Result<(), IndexError> {
        self.inner.reset()
    }
    fn run(&mut self, batch: &Batch) -> Result<Vec<StmtResult>, IndexError> {
        if self.probe.enforce_codec.get() {
            mdbn_store_file::index_codec::encode_request(
                &mdbn_store_file::index_codec::IndexRequest::Run(batch.clone()),
                mdbn_store_file::index_codec::CodecLimits::HOSTED,
            )
            .map_err(|error| IndexError::new(IndexErrorKind::Other, error.to_string()))?;
        }
        self.probe.calls.set(self.probe.calls.get() + 1);
        self.probe.record_blob_reads.set(
            self.probe.record_blob_reads.get()
                + batch
                    .stmts
                    .iter()
                    .filter(|statement| statement.sql.starts_with("SELECT row FROM st_rec"))
                    .count(),
        );
        if batch.mode == BatchMode::Transaction {
            self.probe
                .transactions
                .set(self.probe.transactions.get() + 1);
        }
        if batch.mode == BatchMode::Autocommit && self.probe.fail_read.replace(false) {
            return Err(IndexError::new(
                IndexErrorKind::Other,
                "injected app SQL read failure",
            ));
        }
        let result = self.inner.run(batch)?;
        if batch.mode == BatchMode::Transaction && self.probe.uncertain_commit.replace(false) {
            return Err(IndexError::new(
                IndexErrorKind::Other,
                "commit outcome unknown",
            ));
        }
        Ok(result)
    }
}
type App = Replica<TentativeStore<AppSql>>;
type Index = Rc<RefCell<AppSql>>;
type Identity = (B16, String, B32, u32, Option<String>);

fn open(path: &std::path::Path, probe: Rc<Probe>) -> (App, SessionId, Index) {
    let index = Rc::new(RefCell::new(AppSql {
        inner: SqliteIndex::open(path, IndexDurability::Disposable).unwrap(),
        probe,
    }));
    let store = TentativeStore::open(index.clone(), SqlStoreLimits::MOBILE).unwrap();
    let mut app = Replica::open(
        ReplicaConfig {
            collection: COLLECTION,
            device_id: DEVICE,
            replica_id: B16([1; 16]),
            mode: SyncMode::Synced,
            log_endpoint: r::log::EndpointId(1),
            verify: true,
            runtime_version: "tentative-discovery-test".into(),
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
        Box::new(r::seal::KeyringSealer::new(COLLECTION, DEVICE, &SIGN, &KEM)),
        Host {
            clock: Box::new(mdbn_core::host::FixedClock(1_700_000_000_000)),
            entropy: Box::new(r::crypto::TestEntropy::new(1)),
            zones: Box::new(UtcOnly),
        },
        DeviceSecrets {
            sign_sk: SIGN,
            kem_sk: KEM,
        },
    )
    .unwrap();
    let session = app
        .hello(
            SessionAuth::Host,
            HelloParams {
                versions: vec![Version { major: 1, minor: 0 }],
                client_name: "app".into(),
                client_version: "test".into(),
                features: None,
                timezone: Some("UTC".into()),
            },
        )
        .unwrap()
        .0;
    (app, session, index)
}
fn log() -> FakeLogService {
    let service = FakeLogService::new();
    r::testkit::TestControlPlane::signed(COLLECTION).genesis_with_keys(
        &service,
        w::policy::CState::E2e,
        DEVICE,
        &SIGN,
        &KEM,
    );
    service
}
fn settle(app: &mut App, service: &FakeLogService) {
    let mut client = service.client(DEVICE);
    for _ in 0..20 {
        r::log::pump(app, &mut client, 100);
        app.tick();
    }
    assert_eq!(app.store().pending_count().unwrap(), 0);
    assert!(!app.keyring_rebuilding() && !app.keyring_rebuild_failed());
}
fn submit(app: &mut App, session: SessionId, ops: Vec<Op>, mutation: u8) {
    app.submit(
        session,
        SubmitParams {
            ops,
            mutation_id: Some(B16([mutation; 16])),
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
}
fn create(id: B16, path: &str, source: &str) -> Op {
    Op::Create(Create {
        id,
        path: Some(path.into()),
        type_name: None,
        frontmatter: None,
        body: None,
        document: Some(w::common::Text::Inline(source.into())),
    })
}
fn configure_resources(app: &mut App, session: SessionId, service: &FakeLogService) {
    // Reuse the checked-in resolved Base contract/type, not extension-only
    // classification or caller-authored native discovery descriptors.
    let fixture = mdbn_core::yaml::parse_value(
        include_str!("../../../../conformance/determinism/bases-discovery.log")
            .lines()
            .find(|line| !line.starts_with('#'))
            .unwrap(),
    )
    .unwrap()
    .unwrap();
    let mut ops = vec![Op::ResourcePut(ResourcePut {
        path: "mdbase.yaml".into(),
        doc: "spec_version: '0.3.0'\nsettings:\n  record_extensions: [md, base]\n".into(),
        base_revision: None,
        must_not_exist: None,
    })];
    for resource in fixture.get("resources").unwrap().as_list().unwrap() {
        ops.push(Op::ResourcePut(ResourcePut {
            path: resource.get("path").unwrap().as_str().unwrap().into(),
            doc: resource.get("source").unwrap().as_str().unwrap().into(),
            base_revision: None,
            must_not_exist: None,
        }));
    }
    submit(app, session, ops, 21);
    settle(app, service);
}
fn configure(app: &mut App, session: SessionId, service: &FakeLogService) {
    configure_resources(app, session, service);
    submit(
        app,
        session,
        vec![
            create(SOURCE_ID, SOURCE_PATH, SOURCE),
            create(
                B16([12; 16]),
                "ordinary.md",
                "---\nviews: [{type: table, name: NotBase}]\n---\n",
            ),
        ],
        22,
    );
    settle(app, service);
}
fn views(app: &mut App, session: SessionId) -> Vec<Identity> {
    let mut next = None;
    let mut output = Vec::new();
    for _ in 0..8 {
        let (page, continuation) = app
            .encode_bases_discovery_page(session, Some("UTC"), 1, next, |_, page, _| {
                Ok((
                    page.views
                        .iter()
                        .map(|view| {
                            (
                                view.record,
                                view.path.clone(),
                                view.revision,
                                view.index,
                                view.name.clone(),
                            )
                        })
                        .collect::<Vec<_>>(),
                    page.next,
                ))
            })
            .unwrap();
        output.extend(page);
        next = continuation;
        if next.is_none() {
            return output;
        }
    }
    panic!("bounded fixture discovery did not reach actual EOF")
}
fn check(app: &mut App, session: SessionId) {
    let revision = w::hash::sha256(SOURCE.as_bytes());
    assert_eq!(
        views(app, session),
        vec![
            (
                SOURCE_ID,
                SOURCE_PATH.into(),
                revision,
                0,
                Some("First".into())
            ),
            (
                SOURCE_ID,
                SOURCE_PATH.into(),
                revision,
                1,
                Some("Second".into())
            ),
        ]
    );
    let state = app.store().query_projection_state().unwrap().unwrap();
    assert!(state.ready);
    assert_eq!(state.head, app.store().head().unwrap());
    let source = app
        .encode_bases_view_source(
            session,
            BasesViewSelection {
                record: SOURCE_ID,
                revision,
                index: 1,
            },
            Some("UTC"),
            |_, source, _| Ok(source.source.clone()),
        )
        .unwrap();
    assert_eq!(
        source, SOURCE,
        "read original bytes, not a synthesized source"
    );
    assert_eq!(app.store().meta(meta_keys::KEYRING).unwrap(), None);
}
fn refused(app: &mut App, session: SessionId) {
    let encoded = Cell::new(false);
    let error = app
        .encode_bases_discovery_page(session, Some("UTC"), 1, None, |_, _, _| {
            encoded.set(true);
            Ok(())
        })
        .unwrap_err();
    assert_eq!(error.code(), Some(ErrorCode::Unavailable));
    assert!(
        !encoded.get(),
        "unavailable must never encode empty success"
    );
}
fn raw(index: &Index, statement: &str, params: Vec<SqlValue>) {
    index
        .borrow_mut()
        .inner
        .run(&Batch {
            mode: BatchMode::Autocommit,
            stmts: vec![Stmt::new(statement, params)],
        })
        .unwrap();
}
fn projection_request(app: &App) -> QueryProjectionRequest {
    let state = app.store().query_projection_state().unwrap().unwrap();
    QueryProjectionRequest {
        generation: state.generation,
        head: state.head,
        predicate: QueryPredicate::All,
        bases_candidate: None,
        bases_records: Some(vec![SOURCE_ID]),
        after: None,
        limit: 1,
        max_bytes: 1 << 20,
        fields: vec![],
        tags: false,
    }
}

#[test]
fn tentative_discovery_sync_and_reopen_backfill_preserve_original_sources() {
    let path = scratch("tentative-discovery-reopen").join("app.db");
    let probe = Rc::new(Probe::default());
    let service = log();
    let (mut app, session, index) = open(&path, probe.clone());
    settle(&mut app, &service);
    refused(&mut app, session); // No installed Base contract is not empty success.
    configure(&mut app, session, &service);
    check(&mut app, session);
    let head = app.store().head().unwrap();
    assert!(app.store().query_index_supported());
    assert!(app.store().query_index_state().unwrap().unwrap().ready);
    // A missing derived cache cannot certify indexed execution. Discovery
    // instead proves primary raw universe exhaustion under its own READ cut.
    let identities = views(&mut app, session);
    raw(&index, "DELETE FROM st_qraw", vec![]);
    raw(&index, "DELETE FROM st_qraw_state", vec![]);
    let missing = app.store().query_projection_state().unwrap();
    assert!(missing.as_ref().is_none_or(|state| !state.ready));
    assert_eq!(views(&mut app, session), identities);
    assert_eq!(app.store().query_projection_state().unwrap(), missing);
    drop(app);
    drop(index);
    let (mut app, session, _) = open(&path, probe);
    assert!(app.keyring_rebuilding());
    refused(&mut app, session);
    settle(&mut app, &service);
    assert_eq!(app.store().head().unwrap(), head, "backfill is index-only");
    check(&mut app, session);
}

#[test]
fn tentative_discovery_reads_primary_inventory_without_certifying_derived_readiness() {
    let path = scratch("tentative-discovery-gates").join("app.db");
    let (mut app, session, index) = open(&path, Rc::new(Probe::default()));
    let service = log();
    settle(&mut app, &service);
    configure(&mut app, session, &service);
    check(&mut app, session);
    let generation = app
        .store()
        .query_projection_state()
        .unwrap()
        .unwrap()
        .generation;
    let identities = views(&mut app, session);
    raw(&index, "UPDATE st_qraw_state SET ready=0", vec![]);
    assert_eq!(views(&mut app, session), identities);
    assert!(!app.store().query_projection_state().unwrap().unwrap().ready);
    raw(
        &index,
        "UPDATE st_qraw_state SET ready=1,generation=?",
        vec![SqlValue::Blob(vec![99; 32])],
    );
    assert_eq!(views(&mut app, session), identities);
    assert_eq!(
        app.store()
            .query_projection_state()
            .unwrap()
            .unwrap()
            .generation,
        [99; 32]
    );
    raw(
        &index,
        "UPDATE st_qraw_state SET generation=?",
        vec![SqlValue::Blob(generation.to_vec())],
    );
    check(&mut app, session);
    submit(
        &mut app,
        session,
        vec![create(B16([13; 16]), "pending.md", "pending")],
        23,
    );
    assert_eq!(app.store().pending_count().unwrap(), 1);
    assert!(app.collection_setup_capture_fence(None).is_err());
    check(&mut app, session);
    assert_eq!(app.store().pending_count().unwrap(), 1);
    settle(&mut app, &service);
    check(&mut app, session);
    let encoded = Cell::new(false);
    assert!(
        app.encode_bases_view_source(
            session,
            BasesViewSelection {
                record: SOURCE_ID,
                revision: B32([99; 32]),
                index: 0
            },
            Some("UTC"),
            |_, _, _| {
                encoded.set(true);
                Ok(())
            },
        )
        .is_err()
    );
    assert!(!encoded.get(), "wrong source revision cannot publish");
}

#[test]
fn tentative_discovery_uncertain_commit_fences_projection_reads_until_reopen() {
    let path = scratch("tentative-discovery-uncertain").join("app.db");
    let probe = Rc::new(Probe::default());
    let service = log();
    let (mut app, session, index) = open(&path, probe.clone());
    settle(&mut app, &service);
    configure(&mut app, session, &service);
    let request = projection_request(&app);
    probe.uncertain_commit.set(true);
    assert!(
        app.store_mut()
            .commit(Tx {
                meta: vec![("test.uncertain".into(), Some(vec![1]))],
                ..Tx::default()
            })
            .is_err()
    );
    assert!(app.store().fenced().is_some());
    let calls = probe.calls.get();
    assert!(app.store().query_projection_state().is_err());
    assert!(app.store().query_projection_page(&request).is_err());
    assert_eq!(probe.calls.get(), calls, "fenced reads never reach SQL");
    assert!(
        app.encode_bases_discovery_page(session, Some("UTC"), 1, None, |_, _, _| Ok(()))
            .is_err()
    );
    drop(app);
    drop(index);
    let (mut app, session, _) = open(&path, probe);
    assert!(app.store().fenced().is_none());
    assert_eq!(app.store().meta("test.uncertain").unwrap(), Some(vec![1]));
    settle(&mut app, &service);
    check(&mut app, session);
}

#[test]
fn tentative_discovery_projection_state_and_page_errors_fence_without_fallback() {
    for page in [false, true] {
        let path = scratch(if page {
            "tentative-discovery-page-fault"
        } else {
            "tentative-discovery-state-fault"
        })
        .join("app.db");
        let probe = Rc::new(Probe::default());
        let service = log();
        let (mut app, session, index) = open(&path, probe.clone());
        settle(&mut app, &service);
        configure(&mut app, session, &service);
        let request = projection_request(&app);
        probe.fail_read.set(true);
        if page {
            assert!(app.store().query_projection_page(&request).is_err());
        } else {
            assert!(app.store().query_projection_state().is_err());
        }
        assert!(app.store().fenced().is_some());
        let calls = probe.calls.get();
        assert!(app.store().query_projection_state().is_err());
        assert!(app.store().query_projection_page(&request).is_err());
        assert_eq!(probe.calls.get(), calls);
        drop(app);
        drop(index);
        let (mut app, session, _) = open(&path, probe);
        settle(&mut app, &service);
        check(&mut app, session);
    }
}
