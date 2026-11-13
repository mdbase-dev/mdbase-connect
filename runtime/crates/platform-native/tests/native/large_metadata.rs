//! Issue #1497: a declared text field whose value is longer than an index key
//! (8 KiB). The browser replica is `MemoryConstrained` over SQLite, so any query
//! the field index cannot answer is a per-record scan with a 1 MiB source
//! budget. One such value used to leave the whole index unready, and then even
//! the SDK's verified-read gate, `query({limit: 1})`, was refused `too_large`
//! once the collection's sources passed that budget.
use super::*;
use mdbn_store_file::{
    SqlStore,
    testing::{replica as r, wire as w},
};
use r::api::{ClientApi, SessionAuth};
use r::store::RecordRow;
use r::{DeviceSecrets, Host, Replica, ReplicaConfig, UtcOnly, log::EndpointId};
use w::client::{HelloParams, Include, QueryResult};
use w::common::{B16, Value, Version};
use w::policy::CState;

const COL: B16 = B16([9; 16]);
const DEV: B16 = B16([109; 16]);
const TYPE_PATH: &str = "_types/reader-source.md";
const TYPE: &str = "---\nkind: mdbase.type\nname: reader-source\nmatch: {path_glob: 'sources/*.md'}\nschema:\n  dialect: json-schema-2020-12\n  value: {type: object, properties: {title: {type: string}, description: {type: string}}}\n---\n";
const SHAPE: usize = 150;
const WIDE: usize = 10 * 1024;

type App = Replica<SqlStore<SqliteIndex>>;

fn description(n: usize, bytes: usize) -> String {
    (0..bytes)
        .map(|i| char::from(b'a' + ((i + n) % 26) as u8))
        .collect()
}
fn source(n: usize, description_bytes: usize) -> String {
    let description = description(n, description_bytes);
    format!("---\ntitle: Source {n}\ndescription: {description}\n---\nBody {n}\n")
}

/// `reader-source` records (description bytes per record) confirmed in a real
/// SQLite store.
fn seed(dir: &std::path::Path, descriptions: &[usize]) {
    let mut store = sql(dir);
    let catalog = mdbn_core::types::Catalog::load([(TYPE_PATH, TYPE)]);
    store
        .commit(Tx {
            resources_put: vec![(TYPE_PATH.into(), TYPE.into())],
            records_put: descriptions
                .iter()
                .enumerate()
                .map(|(n, bytes)| {
                    let path = format!("sources/{n:03}.md");
                    let doc = source(n, *bytes);
                    RecordRow {
                        id: B16((n as u128 + 1).to_be_bytes()),
                        path_key: mdbn_core::paths::path_key(&path),
                        meta: r::plan::record_meta(&catalog, &path, &doc),
                        revision: w::hash::sha256(doc.as_bytes()),
                        path,
                        doc,
                        modified_seq: 0,
                        mtime: None,
                        bucket: 0,
                    }
                })
                .collect(),
            ..Tx::default()
        })
        .unwrap();
}
fn sql(dir: &std::path::Path) -> SqlStore<SqliteIndex> {
    SqlStore::open(Rc::new(RefCell::new(
        SqliteIndex::open(dir.join("app.db"), IndexDurability::Durable).unwrap(),
    )))
    .unwrap()
}
/// Open the store as the browser opens one, and say hello.
fn open(dir: &std::path::Path, svc: &r::fake::FakeLogService) -> (App, r::api::SessionId) {
    let mut replica = Replica::open(
        ReplicaConfig {
            collection: COL,
            device_id: DEV,
            replica_id: B16([1; 16]),
            mode: w::client::SyncMode::Synced,
            log_endpoint: EndpointId(1),
            verify: true,
            runtime_version: "large-metadata-test".into(),
            trusted_roots: vec![r::testkit::signed_root()],
            trusted_signers: vec![],
            e2e: false,
            user_enabled_cloud_copy: false,
            chosen_state: None,
            expected_genesis: None,
            key_grants_only: false,
            policy_pins: None,
        },
        sql(dir),
        Box::new(r::plan::CorePlanner),
        Box::new(r::seal::KeyringSealer::new(
            COL,
            DEV,
            &[0x31; 32],
            &[0x32; 32],
        )),
        Host {
            clock: Box::new(mdbn_core::host::FixedClock(1700000000000)),
            entropy: Box::new(r::crypto::TestEntropy::new(1)),
            zones: Box::new(UtcOnly),
        },
        DeviceSecrets {
            sign_sk: [0x31; 32],
            kem_sk: [0x32; 32],
        },
    )
    .unwrap();
    // The browser's query profile (the default).
    assert_eq!(
        replica.query_execution_profile(),
        r::QueryExecutionProfile::MemoryConstrained
    );
    let mut log = svc.client(DEV);
    for _ in 0..40 {
        r::log::pump(&mut replica, &mut log, 200);
        replica.tick();
    }
    let (session, _) = replica
        .hello(
            SessionAuth::Host,
            HelloParams {
                versions: vec![Version { major: 1, minor: 0 }],
                client_name: "test".into(),
                client_version: "0".into(),
                features: None,
                timezone: None,
            },
        )
        .unwrap();
    (replica, session)
}
fn world(name: &str, descriptions: &[usize]) -> (PathBuf, r::fake::FakeLogService) {
    let dir = scratch(name);
    seed(&dir, descriptions);
    let svc = r::fake::FakeLogService::new();
    r::testkit::TestControlPlane::signed(COL).genesis_with_keys(
        &svc,
        CState::E2e,
        DEV,
        &[0x31; 32],
        &[0x32; 32],
    );
    (dir, svc)
}
fn query(
    replica: &mut App,
    session: r::api::SessionId,
    fields: Vec<(&str, Value)>,
) -> Result<QueryResult, r::api::ApiError> {
    replica.query(
        session,
        Value::Map(fields.into_iter().map(|(k, v)| (k.into(), v)).collect()),
        Include {
            effective: None,
            body: None,
            document: Some(true),
            diagnostics: None,
        },
    )
}
fn first_record(replica: &mut App, session: r::api::SessionId) -> QueryResult {
    let before = replica.query_stats().indexed;
    let page = query(replica, session, vec![("limit", Value::Int(1))]);
    let stats = replica.query_stats();
    let page = page.unwrap_or_else(|e| panic!("verified read refused: {e:?}; {stats:?}"));
    assert_eq!(page.records.len(), 1);
    assert_eq!(
        stats.indexed,
        before + 1,
        "answered by the index: {stats:?}"
    );
    page
}

#[test]
fn small_metadata_answers_the_verified_read_from_the_index() {
    let (dir, svc) = world("large-metadata-control", &[200; SHAPE]);
    let (mut replica, session) = open(&dir, &svc);
    first_record(&mut replica, session);
}

#[test]
fn ten_kb_descriptions_leave_only_that_field_out_of_the_index() {
    let (dir, svc) = world("large-metadata-10kb", &[WIDE; SHAPE]);
    let (mut replica, session) = open(&dir, &svc);
    first_record(&mut replica, session);
    // A page as large as the collection is cut at the byte budget, never refused.
    let mut seen = 0;
    while seen < SHAPE {
        let page = query(
            &mut replica,
            session,
            vec![
                ("limit", Value::Int(SHAPE as i64)),
                ("offset", Value::Int(seen as i64)),
            ],
        )
        .expect("a budget-bounded page");
        assert!(!page.records.is_empty());
        let bytes: usize = page
            .records
            .iter()
            .map(|r| r.document.as_ref().map_or(0, |d| d.len()))
            .sum();
        assert!(bytes <= 1 << 20, "{bytes}");
        seen += page.records.len();
        assert!(seen == SHAPE || page.has_more == Some(true));
    }
    assert_eq!(seen, SHAPE);
    // Indexed fields stay indexed.
    let titled = query(
        &mut replica,
        session,
        vec![
            ("where", Value::Text("title == \"Source 42\"".into())),
            ("limit", Value::Int(5)),
        ],
    )
    .unwrap();
    assert_eq!(titled.records.len(), 1);
    assert_eq!(titled.records[0].path, "sources/042.md");
    // The left-out field reads every source, which this collection is too
    // large for: the refusal names `too_large`.
    let refused = query(
        &mut replica,
        session,
        vec![
            ("where", Value::Text("description != null".into())),
            ("limit", Value::Int(1)),
        ],
    )
    .unwrap_err();
    assert_eq!(refused.problem().code, "too_large");
}

#[test]
fn a_query_on_the_left_out_field_still_finds_its_records() {
    let (dir, svc) = world("large-metadata-left-out", &[200, WIDE, 200]);
    let (mut replica, session) = open(&dir, &svc);
    first_record(&mut replica, session);
    let page = query(
        &mut replica,
        session,
        vec![
            ("where", Value::Text("description != null".into())),
            ("limit", Value::Int(5)),
        ],
    )
    .unwrap();
    assert_eq!(page.records.len(), 3);
    let wide = page
        .records
        .iter()
        .find(|r| r.path == "sources/001.md")
        .expect("the record with the long value");
    assert!(
        wide.document
            .as_ref()
            .unwrap()
            .contains(&description(1, WIDE))
    );
    let declined = replica.query_stats();
    assert_eq!(
        declined.last_decline,
        Some("field_not_indexed"),
        "{declined:?}"
    );
}

#[test]
fn a_reopen_reuses_the_index_built_without_the_long_field() {
    let (dir, svc) = world("large-metadata-reopen", &[WIDE; SHAPE]);
    let (mut replica, session) = open(&dir, &svc);
    first_record(&mut replica, session);
    let built = replica.store().query_index_state().unwrap().unwrap();
    drop(replica);
    let (mut replica, session) = open(&dir, &svc);
    first_record(&mut replica, session);
    let reused = replica.store().query_index_state().unwrap().unwrap();
    assert_eq!(reused.generation, built.generation);
    assert_eq!(reused.fields, built.fields);
    assert!(reused.ready);
}
