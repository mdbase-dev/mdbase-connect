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

/// `resources` and their `sources/` records (description bytes per record),
/// confirmed in a real SQLite store.
fn seed_with(dir: &std::path::Path, resources: &[(&str, &str)], descriptions: &[usize]) {
    let mut store = sql(dir);
    let catalog = mdbn_core::types::Catalog::load(resources.iter().copied());
    store
        .commit(Tx {
            resources_put: resources
                .iter()
                .map(|(p, s)| ((*p).into(), (*s).into()))
                .collect(),
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
    world_with(name, &[(TYPE_PATH, TYPE)], descriptions)
}
fn world_with(
    name: &str,
    resources: &[(&str, &str)],
    descriptions: &[usize],
) -> (PathBuf, r::fake::FakeLogService) {
    let dir = scratch(name);
    seed_with(&dir, resources, descriptions);
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

const CONTRACT_PATH: &str = "_contracts/reader-source.md";
const CONTRACT: &str = "---\nkind: mdbase.contract\ncontract_type: record\nid: reader.source\nversion: 1.0.0\nrecord_schema:\n  dialect: json-schema-2020-12\n  value: {type: object, properties: {title: {type: string}}}\n---\n";
const MAPPED_TYPE: &str = "---\nkind: mdbase.type\nname: reader-source\nmatch: {path_glob: 'sources/*.md'}\nschema:\n  dialect: json-schema-2020-12\n  value: {type: object, properties: {title: {type: string}, description: {type: string}}}\nimplements:\n  - contract: reader.source\n    version: '1.0.0'\n    fields: {'/title': '/title'}\n---\n";

fn contract_page(
    replica: &mut App,
    session: r::api::SessionId,
    cursor: Option<String>,
) -> Result<r::api::ContractQueryResult, r::api::ApiError> {
    replica.query_contract(
        session,
        r::api::ContractQuery {
            where_: None,
            contract: "reader.source".into(),
            version: "1.0.0".into(),
            limit: 128,
            cursor,
        },
    )
}
/// Every record of a contract inventory, page by page; ids in page order.
fn contract_inventory(replica: &mut App, session: r::api::SessionId) -> Vec<B16> {
    let mut ids = Vec::new();
    let mut cursor = None;
    loop {
        let page = contract_page(replica, session, cursor).unwrap_or_else(|e| {
            panic!("contract page refused: {e:?}; {:?}", replica.query_stats())
        });
        assert!(!page.records.is_empty());
        ids.extend(page.records.iter().map(|r| r.id));
        match page.page.cursor {
            Some(next) => cursor = Some(next),
            None => return ids,
        }
    }
}
fn titles(replica: &mut App, session: r::api::SessionId) -> Vec<String> {
    let mut titles = Vec::new();
    let mut cursor = None;
    loop {
        let page = contract_page(replica, session, cursor).unwrap();
        titles.extend(
            page.records
                .iter()
                .map(|r| match &r.implementations[0].fields.0[0].1 {
                    Value::Text(t) => t.clone(),
                    other => panic!("{other:?}"),
                }),
        );
        match page.page.cursor {
            Some(next) => cursor = Some(next),
            None => return titles,
        }
    }
}
fn submit(replica: &mut App, session: r::api::SessionId, mutation: u8, op: w::intent::Op) {
    replica
        .submit(
            session,
            w::client::SubmitParams {
                ops: vec![op],
                mutation_id: Some(B16([mutation; 16])),
                conflict_mode: None,
                timezone: None,
                allow_partial: None,
                mutation_ids: None,
                dry_run: None,
                include: None,
                wait: None,
                validation: None,
            },
        )
        .unwrap();
}
fn create(n: u8, path: &str) -> w::intent::Op {
    w::intent::Op::Create(w::intent::Create {
        id: B16([n; 16]),
        path: Some(path.into()),
        type_name: None,
        frontmatter: None,
        body: None,
        document: Some(w::common::Text::Inline(source(900 + usize::from(n), 1400))),
    })
}
fn retitle(n: usize) -> w::intent::Op {
    w::intent::Op::Update(w::intent::Update {
        id: id(n),
        patch: Some(w::common::DataMap(vec![(
            "title".into(),
            Value::Text("Edited".into()),
        )])),
        unset: None,
        add: None,
        remove: None,
        body: None,
        body_edits: None,
        body_base: None,
        body_base_text: None,
        base: None,
        if_revision: None,
        update_refs: None,
    })
}
fn id(n: usize) -> B16 {
    B16((n as u128 + 1).to_be_bytes())
}

/// Issue #1502: pending local writes must not make a contract inventory
/// larger than one page unanswerable. The browser keeps a write in its local
/// layer until the log acknowledges it; contract pages page through it.
#[test]
fn pending_local_writes_keep_a_multi_page_contract_inventory_answerable() {
    let (dir, svc) = world_with(
        "large-metadata-contract-after-write",
        &[
            ("mdbase.yaml", "spec_version: '0.3.0'\n"),
            (CONTRACT_PATH, CONTRACT),
            (TYPE_PATH, MAPPED_TYPE),
        ],
        &[1400; 140],
    );
    let (mut replica, session) = open(&dir, &svc);
    assert_eq!(contract_inventory(&mut replica, session).len(), 140);
    // An edit of a record on the first page, as Writer and Reader save.
    submit(&mut replica, session, 0xE1, retitle(5));
    let ids = contract_inventory(&mut replica, session);
    assert_eq!(ids.len(), 140);
    assert_eq!(
        ids.iter().collect::<std::collections::BTreeSet<_>>().len(),
        140
    );
    let edited = titles(&mut replica, session);
    assert_eq!(edited[5], "Edited");
    assert_eq!(edited.iter().filter(|t| *t == "Edited").count(), 1);
    // Creates inside each page and a delete, all still pending.
    submit(&mut replica, session, 0xE2, create(0xA1, "sources/0705.md"));
    submit(&mut replica, session, 0xE3, create(0xA2, "sources/zzz.md"));
    submit(
        &mut replica,
        session,
        0xE4,
        w::intent::Op::Delete(w::intent::Delete {
            id: id(130),
            base_revision: None,
            if_revision: None,
        }),
    );
    let ids = contract_inventory(&mut replica, session);
    let mut expected: Vec<B16> = (0..140).filter(|n| *n != 130).map(id).collect();
    expected.insert(71, B16([0xA1; 16]));
    expected.push(B16([0xA2; 16]));
    assert_eq!(ids, expected);
    // A continuation over one layer ends when the layer changes.
    let first = contract_page(&mut replica, session, None).unwrap();
    submit(&mut replica, session, 0xE5, create(0xA3, "sources/zzzz.md"));
    let stale = contract_page(&mut replica, session, first.page.cursor).unwrap_err();
    assert_eq!(stale.problem().reason.as_deref(), Some("cursor_stale"));
    // Once the log acknowledges the writes, the confirmed index answers.
    let mut log = svc.client(DEV);
    for _ in 0..40 {
        r::log::pump(&mut replica, &mut log, 200);
        replica.tick();
    }
    assert_eq!(contract_inventory(&mut replica, session).len(), 142);
}

/// Issue #1502: with a write pending, a page larger than the source budget
/// (Writer reads every record in pages of 500) ends early with a cursor, as it
/// does without one, instead of refusing `too_large`.
#[test]
fn a_merged_page_over_the_source_budget_ends_early() {
    let (dir, svc) = world("large-metadata-merged-budget", &[WIDE; SHAPE]);
    let (mut replica, session) = open(&dir, &svc);
    submit(&mut replica, session, 0xE1, retitle(5));
    submit(&mut replica, session, 0xE2, retitle(140));
    let mut paths = Vec::new();
    let mut cursor = None;
    loop {
        let mut fields = vec![("limit", Value::Int(500))];
        if let Some(c) = cursor.take() {
            fields.push(("cursor", Value::Text(c)));
        }
        let page = query(&mut replica, session, fields)
            .unwrap_or_else(|e| panic!("page refused: {e:?}; {:?}", replica.query_stats()));
        assert!(!page.records.is_empty());
        let bytes: usize = page
            .records
            .iter()
            .map(|r| r.document.as_ref().map_or(0, |d| d.len()))
            .sum();
        assert!(bytes <= 1 << 20, "{bytes}");
        paths.extend(page.records.iter().map(|r| r.path.clone()));
        match page.cursor {
            Some(next) => cursor = Some(next),
            None => break,
        }
    }
    let expected: Vec<String> = (0..SHAPE).map(|n| format!("sources/{n:03}.md")).collect();
    assert_eq!(paths, expected);
}
