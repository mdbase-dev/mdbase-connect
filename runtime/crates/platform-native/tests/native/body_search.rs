//! A lower-cased body search (`file.body.lower().contains("...")`) is
//! answered by the store's body index, not by reading every record, and
//! returns exactly what evaluating the expression on each record returns:
//! across local edits, deletes, reopens, and a collection holding a body too
//! long for the index.
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

const COL: B16 = B16([11; 16]);
const DEV: B16 = B16([111; 16]);
const TYPE_PATH: &str = "_types/note.md";
const TYPE: &str = "---\nkind: mdbase.type\nname: note\nmatch: {path_glob: 'notes/*.md'}\nschema:\n  dialect: json-schema-2020-12\n  value: {type: object, properties: {title: {type: string}, rank: {type: integer}}}\n---\n";
const NOTES: usize = 120;

type App = Replica<SqlStore<SqliteIndex>>;

/// Words with case, accents, both sigmas, a dotted capital I, quotes and a NUL.
const WORDS: &[&str] = &[
    "Meeting",
    "notes",
    "CAFÉ",
    "café",
    "ΟΔΟΣ",
    "οδος",
    "İstanbul",
    "quote\"d",
    "line\nbreak",
    "tab\there",
    "nul\0byte",
    "Plan",
    "plan",
    "x",
    "Σ",
    "draft",
    "Draft",
];

fn body(n: usize) -> String {
    let mut seed = (n as u64).wrapping_mul(0x9e37_79b9_7f4a_7c15) + 1;
    let mut words = Vec::new();
    for _ in 0..(3 + n % 9) {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        words.push(WORDS[(seed % WORDS.len() as u64) as usize]);
    }
    format!("{} {n}\n", words.join(" "))
}
fn doc(n: usize, body: &str) -> String {
    format!("---\ntitle: Note {n}\nrank: {}\n---\n{body}", n % 7)
}
fn id(n: usize) -> B16 {
    B16((n as u128 + 1).to_be_bytes())
}
fn path(n: usize) -> String {
    format!("notes/{n:03}.md")
}

fn sql(dir: &std::path::Path) -> SqlStore<SqliteIndex> {
    SqlStore::open(Rc::new(RefCell::new(
        SqliteIndex::open(dir.join("app.db"), IndexDurability::Durable).unwrap(),
    )))
    .unwrap()
}
fn seed(dir: &std::path::Path, bodies: &[String]) {
    let resources = [(TYPE_PATH, TYPE)];
    let catalog = mdbn_core::types::Catalog::load(resources);
    sql(dir)
        .commit(Tx {
            resources_put: vec![(TYPE_PATH.into(), TYPE.into())],
            records_put: bodies
                .iter()
                .enumerate()
                .map(|(n, body)| {
                    let doc = doc(n, body);
                    RecordRow {
                        id: id(n),
                        path_key: mdbn_core::paths::path_key(&path(n)),
                        meta: r::plan::record_meta(&catalog, &path(n), &doc),
                        revision: w::hash::sha256(doc.as_bytes()),
                        path: path(n),
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
fn world(name: &str, bodies: &[String]) -> (PathBuf, r::fake::FakeLogService) {
    let dir = scratch(name);
    seed(&dir, bodies);
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
            runtime_version: "body-search-test".into(),
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
fn query(
    replica: &mut App,
    session: r::api::SessionId,
    where_: &str,
) -> Result<QueryResult, r::api::ApiError> {
    replica.query(
        session,
        Value::Map(
            [
                ("where".into(), Value::Text(where_.into())),
                ("limit".into(), Value::Int(1000)),
            ]
            .into_iter()
            .collect(),
        ),
        Include {
            effective: None,
            body: None,
            document: None,
            diagnostics: None,
        },
    )
}
/// A CEL string literal for `s`.
fn literal(s: &str) -> String {
    let mut out = String::from("\"");
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            '\t' => out.push_str("\\t"),
            '\0' => out.push_str("\\u0000"),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}
/// Paths of the records whose body, lower-cased, contains `needle`: the
/// expression evaluated on each record (CEL `lower()` is `to_lowercase`).
fn expected(bodies: &[Option<String>], needle: &str) -> Vec<String> {
    bodies
        .iter()
        .enumerate()
        .filter(|(_, b)| {
            b.as_ref()
                .is_some_and(|b| b.to_lowercase().contains(needle))
        })
        .map(|(n, _)| path(n))
        .collect()
}
/// Search for every needle; each must be answered by the index, without
/// parsing a record, and match `expected`.
fn check_indexed(
    replica: &mut App,
    session: r::api::SessionId,
    bodies: &[Option<String>],
    needles: &[&str],
) {
    for needle in needles {
        let where_ = format!("file.body.lower().contains({})", literal(needle));
        let before = replica.query_stats();
        let page = query(replica, session, &where_)
            .unwrap_or_else(|e| panic!("{where_}: {e:?}; {:?}", replica.query_stats()));
        let after = replica.query_stats();
        assert_eq!(after.indexed, before.indexed + 1, "{where_}: {after:?}");
        assert_eq!(after.parsed, before.parsed, "{where_} parsed records");
        let mut got: Vec<String> = page.records.iter().map(|r| r.path.clone()).collect();
        got.sort();
        assert_eq!(got, expected(bodies, needle), "{where_}");

        // The complement, too: the index proves which bodies lack it.
        let where_ = format!("!file.body.lower().contains({})", literal(needle));
        let page = query(replica, session, &where_).unwrap();
        assert_eq!(
            page.records.len(),
            bodies.iter().flatten().count() - expected(bodies, needle).len(),
            "{where_}"
        );
    }
}
const NEEDLES: &[&str] = &[
    "meeting",
    "café",
    "caf",
    "οδο",
    "i\u{307}st",
    "quote\"d",
    "e\nbr",
    "tab\th",
    "plan 1",
    "draft 7",
    " 42\n",
    "zzz",
    "notes notes",
];

#[test]
fn lower_cased_body_searches_are_answered_by_the_index_exactly() {
    let bodies: Vec<String> = (0..NOTES).map(body).collect();
    let (dir, svc) = world("body-search-exact", &bodies);
    let (mut replica, session) = open(&dir, &svc);
    let bodies: Vec<Option<String>> = bodies.into_iter().map(Some).collect();
    // The needles split the collection: none matches every record or none.
    for needle in [
        "meeting",
        "café",
        "οδο",
        "i\u{307}st",
        "quote\"d",
        "e\nbr",
        "tab\th",
    ] {
        let n = expected(&bodies, needle).len();
        assert!(n > 0 && n < NOTES, "{needle:?} matches {n}");
    }
    check_indexed(&mut replica, session, &bodies, NEEDLES);

    // Needles the index cannot answer exactly are evaluated per record.
    for needle in ["ab", "οδος", "οδοσ", "Meeting", "nul\0b"] {
        let where_ = format!("file.body.lower().contains({})", literal(needle));
        let before = replica.query_stats();
        let page = query(&mut replica, session, &where_).unwrap();
        assert_eq!(replica.query_stats().indexed, before.indexed, "{where_}");
        let mut got: Vec<String> = page.records.iter().map(|r| r.path.clone()).collect();
        got.sort();
        assert_eq!(got, expected(&bodies, needle), "{where_}");
    }

    // With a field term, in one indexed selection.
    let page = query(
        &mut replica,
        session,
        "rank == 3 && file.body.lower().contains(\"plan\")",
    )
    .unwrap();
    let mut got: Vec<String> = page.records.iter().map(|r| r.path.clone()).collect();
    got.sort();
    let want: Vec<String> = expected(&bodies, "plan")
        .into_iter()
        .filter(|p| p[6..9].parse::<usize>().unwrap() % 7 == 3)
        .collect();
    assert_eq!(got, want);
}

#[test]
fn local_edits_and_deletes_keep_body_searches_exact() {
    let bodies: Vec<String> = (0..NOTES).map(body).collect();
    let (dir, svc) = world("body-search-edits", &bodies);
    let (mut replica, session) = open(&dir, &svc);
    let mut bodies: Vec<Option<String>> = bodies.into_iter().map(Some).collect();
    let mut mutation = 0u8;
    let mut submit = |replica: &mut App, op: w::intent::Op| {
        mutation += 1;
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
    };
    for n in [3, 17, 64] {
        let text = format!("Rewritten Zebra notes {n}\n");
        submit(
            &mut replica,
            w::intent::Op::Update(w::intent::Update {
                id: id(n),
                patch: None,
                unset: None,
                add: None,
                remove: None,
                body: Some(w::common::Text::Inline(text.clone())),
                body_edits: None,
                body_base: None,
                body_base_text: None,
                base: None,
                if_revision: None,
                update_refs: None,
            }),
        );
        bodies[n] = Some(text);
    }
    for n in [5, 40] {
        submit(
            &mut replica,
            w::intent::Op::Delete(w::intent::Delete {
                id: id(n),
                base_revision: None,
                if_revision: None,
            }),
        );
        bodies[n] = None;
    }
    // Edits wait in the local layer until the log acknowledges them; the
    // indexed answer merges them.
    let needles = ["zebra", "meeting", "rewritten zebra notes 6", "notes"];
    for needle in needles {
        let where_ = format!("file.body.lower().contains({})", literal(needle));
        let page = query(&mut replica, session, &where_).unwrap();
        let mut got: Vec<String> = page.records.iter().map(|r| r.path.clone()).collect();
        got.sort();
        assert_eq!(got, expected(&bodies, needle), "{where_} pending");
    }
    // Once acknowledged, the store's index holds them.
    let mut log = svc.client(DEV);
    for _ in 0..40 {
        r::log::pump(&mut replica, &mut log, 200);
        replica.tick();
    }
    check_indexed(&mut replica, session, &bodies, &needles);
    drop(replica);
    let (mut replica, session) = open(&dir, &svc);
    check_indexed(&mut replica, session, &bodies, &needles);
}

#[test]
fn a_body_too_long_for_the_index_leaves_bodies_out_and_is_reused_on_reopen() {
    let mut bodies: Vec<String> = (0..20).map(body).collect();
    bodies[7] = format!(
        "{} needle\n",
        "long ".repeat(r::store_query::MAX_ROW_BODY_BYTES / 5)
    );
    let (dir, svc) = world("body-search-long", &bodies);
    let (mut replica, session) = open(&dir, &svc);
    // A desktop host: the per-record path may read the long record.
    replica.set_query_execution_profile(r::QueryExecutionProfile::Desktop);
    let before = replica.query_stats();
    query(&mut replica, session, "rank == 3").unwrap();
    assert_eq!(replica.query_stats().indexed, before.indexed + 1);
    let built = replica.store().query_index_state().unwrap().unwrap();
    assert!(built.ready);

    // Body searches are evaluated per record, and still exact.
    let bodies: Vec<Option<String>> = bodies.into_iter().map(Some).collect();
    let before = replica.query_stats();
    let page = query(
        &mut replica,
        session,
        "file.body.lower().contains(\"needle\")",
    )
    .unwrap();
    let stats = replica.query_stats();
    assert_eq!(stats.indexed, before.indexed, "{stats:?}");
    assert_eq!(stats.last_decline, Some("field_not_indexed"), "{stats:?}");
    let got: Vec<String> = page.records.iter().map(|r| r.path.clone()).collect();
    assert_eq!(got, expected(&bodies, "needle"));

    // Field queries still use the index.
    let before = replica.query_stats();
    query(&mut replica, session, "rank == 3").unwrap();
    assert_eq!(replica.query_stats().indexed, before.indexed + 1);

    // A reopen reuses that index rather than rebuilding it.
    drop(replica);
    let (replica, _) = open(&dir, &svc);
    let reused = replica.store().query_index_state().unwrap().unwrap();
    assert_eq!(reused.generation, built.generation);
    assert!(reused.ready);
}
