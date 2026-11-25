//! `select` and the CEL link helpers on the Worker's own store composition.
//!
//! They run on the replica's bounded projected-query path, which reads source
//! through `Store::query_record_sizes_at` and `Store::hydrate_query_at`. The Worker
//! serves from `LogCache` over DO SQLite; here the same `LogCache` runs over
//! in-memory SQLite, with `MemStore` as the control.
use std::cell::RefCell;
use std::rc::Rc;

use mdbn_store_file::{LogCache, SqlStoreLimits};
use mdbn_wire::client::{HelloResult, QueryResult};

use super::sqlite::Sqlite;
use super::*;

const DOCS: [(u64, &str, &str); 3] = [
    (1, "projects/Alpha.md", "---\ntitle: Alpha\n---\n"),
    (
        2,
        "tasks/website.md",
        "---\ntitle: Website\nproject: \"[[projects/Alpha]]\"\n---\n",
    ),
    (3, "notes/plain.md", "---\ntitle: Plain\n---\n"),
];

/// A query's members and the paths it must return.
type Case = (Vec<(Cbor, Cbor)>, Vec<&'static str>);

fn cases() -> Vec<Case> {
    let t = |s: &str| Cbor::Text(s.into());
    vec![
        (
            vec![(t("select"), Cbor::Array(vec![t("title")]))],
            vec!["projects/Alpha.md", "tasks/website.md", "notes/plain.md"],
        ),
        (
            vec![(t("where"), t("file.hasLink(link(\"[[projects/Alpha]]\"))"))],
            vec!["tasks/website.md"],
        ),
        (
            vec![(
                t("where"),
                t("project != null && project.asFile() != null \
                   && project.asFile().title == \"Alpha\""),
            )],
            vec!["tasks/website.md"],
        ),
    ]
}

fn run_cases<S: Store>(mut h: Hosted<S>) {
    h.pump(false);
    let (s, _) = h.e.hello(Some((GRANT, CLIENT_PK)), &hello());
    for (i, path, doc) in DOCS {
        h.e.frame(s, &submit_doc(i, path, doc));
        h.pump(false);
        assert!(responses(&h.e.poll(), s, i)[0].is_ok(), "{path}");
    }
    let mut problems = Vec::new();
    for (n, (query, want)) in cases().into_iter().enumerate() {
        let id = 100 + n as u64;
        let params = Cbor::Map(vec![(Cbor::Uint(0), Cbor::Map(query))]);
        h.e.frame(s, &request(id, "query", params));
        let out = h.e.poll();
        let answer = out
            .iter()
            .find_map(|o| match o {
                Out::Frame(f, b) if *f == s => {
                    match ClientFrame::from_cbor(&cbor::decode(b).unwrap()).unwrap() {
                        ClientFrame::Response(r) if r.id == id => Some(r),
                        _ => None,
                    }
                }
                _ => None,
            })
            .unwrap_or_else(|| panic!("case {n}: no response in {out:?}"));
        if let Some(p) = answer.problem {
            problems.push(format!(
                "case {n}: {} ({:?}): {}",
                p.code, p.reason, p.message
            ));
            continue;
        }
        let result = QueryResult::from_cbor(&answer.result.unwrap()).unwrap();
        let mut paths: Vec<_> = result.records.iter().map(|r| r.path.as_str()).collect();
        let mut want = want;
        paths.sort_unstable();
        want.sort_unstable();
        assert_eq!(paths, want, "case {n}");
        if n == 0 {
            assert_eq!(result.columns.as_deref(), Some(&["title".to_string()][..]));
            assert!(result.records.iter().all(|r| r.values.is_some()));
        }
    }
    assert!(problems.is_empty(), "{problems:#?}");
}

#[test]
fn select_and_link_helpers_answer_over_the_in_memory_store() {
    run_cases(open(&world()));
}

#[test]
fn select_and_link_helpers_answer_over_the_workers_log_cache() {
    let svc = world();
    let index = Rc::new(RefCell::new(Sqlite::new()));
    let store = LogCache::open(index, SqlStoreLimits::default()).unwrap();
    run_cases(open_store(&svc, store, 2));
}

#[test]
fn hosted_log_cache_omits_contract_query_order_mtime_and_refuses_oversized_ordered_page() {
    let svc = world();
    let index = Rc::new(RefCell::new(Sqlite::new()));
    let store = LogCache::open(index, SqlStoreLimits::default()).unwrap();
    assert!(!store.query_index_supported());
    let mut h = open_store(&svc, store, 3);
    h.pump(false);

    let hello_frame = request(
        0,
        "hello",
        HelloParams {
            versions: vec![Version { major: 1, minor: 0 }],
            client_name: "app".into(),
            client_version: "0".into(),
            features: Some(vec![
                "contract-query-order-v1".into(),
                "contract-query-order-mtime-v1".into(),
            ]),
            timezone: None,
        }
        .to_cbor(),
    );
    // Neither a grant session nor a host session on hosted LogCache advertises
    // `contract-query-order-mtime-v1`, because LogCache does not maintain the query index.
    let mut sessions = Vec::new();
    for auth in [Some((GRANT, CLIENT_PK)), None] {
        let (sess, reply) = h.e.hello(auth, &hello_frame);
        assert_ne!(sess, 0);
        let ClientFrame::Response(resp) =
            ClientFrame::from_cbor(&cbor::decode(&reply).unwrap()).unwrap()
        else {
            panic!("expected hello response");
        };
        let hello_res = HelloResult::from_cbor(&resp.result.unwrap()).unwrap();
        assert!(
            hello_res
                .features
                .contains(&"contract-query-order-v1".to_owned())
        );
        assert!(
            !hello_res
                .features
                .contains(&"contract-query-order-mtime-v1".to_owned()),
            "hosted LogCache must not advertise contract-query-order-mtime-v1: {:?}",
            hello_res.features
        );
        sessions.push(sess);
    }
    let host_session = sessions[1];

    // Seed a record contract + implementing type + 51 matching records to prove
    // why hosted LogCache cannot advertise indexed mtime paging: >50 matches
    // with limit 50 refuses with `contract_query_cursor_required`.
    let contract_doc = "---\nkind: mdbase.contract\nid: dev.mdbase.writer.manuscript\nversion: '1.0.0'\ncontract_type: record\nrecord_schema:\n  dialect: json-schema-2020-12\n  value:\n    type: object\n    properties:\n      title: { type: string }\n---\n";
    let type_doc = "---\nkind: mdbase.type\nname: manuscript\nmatch:\n  path_glob: 'manuscripts/*.md'\nschema:\n  dialect: json-schema-2020-12\n  value:\n    type: object\n    properties:\n      title: { type: string }\nimplements:\n  - contract: dev.mdbase.writer.manuscript\n    version: '1.0.0'\n    fields: { '/title': '/title' }\n---\n";
    let setup = request(
        1,
        "submit",
        SubmitParams {
            ops: vec![
                mdbn_wire::intent::Op::ResourcePut(mdbn_wire::intent::ResourcePut {
                    path: "mdbase.yaml".into(),
                    doc: mdbn_wire::common::Text::Inline("spec_version: '0.3.0'\n".into()),
                    base_revision: None,
                    must_not_exist: None,
                }),
                mdbn_wire::intent::Op::ResourcePut(mdbn_wire::intent::ResourcePut {
                    path: "_contracts/manuscript.md".into(),
                    doc: mdbn_wire::common::Text::Inline(contract_doc.into()),
                    base_revision: None,
                    must_not_exist: None,
                }),
                mdbn_wire::intent::Op::ResourcePut(mdbn_wire::intent::ResourcePut {
                    path: "_types/manuscript.md".into(),
                    doc: mdbn_wire::common::Text::Inline(type_doc.into()),
                    base_revision: None,
                    must_not_exist: None,
                }),
            ],
            mutation_id: Some(B16([0xb1; 16])),
            conflict_mode: None,
            timezone: None,
            allow_partial: None,
            mutation_ids: None,
            dry_run: None,
            include: None,
            wait: None,
            validation: None,
        }
        .to_cbor(),
    );
    h.e.frame(host_session, &setup);
    h.pump(false);
    // Catalog changes trigger hosted alarm repair before the replica serves again.
    while !h.e.serving() {
        h.e.tick(h.clock.get() as i64, false);
        h.pump(false);
    }
    let _ = h.e.poll();
    // Re-open the grant session after repair completes.
    let (grant_session, _) = h.e.hello(Some((GRANT, CLIENT_PK)), &hello_frame);
    assert_ne!(grant_session, 0);
    let (host_session, _) = h.e.hello(None, &hello_frame);
    assert_ne!(host_session, 0);

    let ops: Vec<_> = (1u64..=51)
        .map(|i| {
            let mut id = [0u8; 16];
            id[8..].copy_from_slice(&i.to_be_bytes());
            mdbn_wire::intent::Op::Create(mdbn_wire::intent::Create {
                id: B16(id),
                path: Some(format!("manuscripts/m-{i:03}.md")),
                type_name: None,
                frontmatter: None,
                body: None,
                document: Some(mdbn_wire::common::Text::Inline(format!(
                    "---\ntitle: M {i}\n---\nbody\n"
                ))),
            })
        })
        .collect();
    let seed = request(
        2,
        "submit",
        SubmitParams {
            ops,
            mutation_id: Some(B16([0xb2; 16])),
            conflict_mode: None,
            timezone: None,
            allow_partial: None,
            mutation_ids: None,
            dry_run: None,
            include: None,
            wait: None,
            validation: None,
        }
        .to_cbor(),
    );
    h.e.frame(host_session, &seed);
    h.pump(false);
    let out2 = h.e.poll();
    let r2 = responses(&out2, host_session, 2);
    assert!(
        r2.first().is_some_and(Result::is_ok),
        "seed failed: {r2:?} out={out2:?}"
    );

    let query_params = Cbor::Map(vec![
        (Cbor::Uint(0), Cbor::Uint(1)),
        (
            Cbor::Uint(1),
            Cbor::Text("dev.mdbase.writer.manuscript".into()),
        ),
        (Cbor::Uint(2), Cbor::Text("1.0.0".into())),
        (Cbor::Uint(3), Cbor::Uint(50)),
        (
            Cbor::Uint(6),
            Cbor::Array(vec![Cbor::Map(vec![
                (Cbor::Text("field".into()), Cbor::Text("file.mtime".into())),
                (Cbor::Text("direction".into()), Cbor::Text("desc".into())),
            ])]),
        ),
    ]);
    h.e.frame(
        grant_session,
        &request(3, "query_contract_v1", query_params),
    );
    let out = h.e.poll();
    let answer = out
        .iter()
        .find_map(|o| match o {
            Out::Frame(f, b) if *f == grant_session => {
                match ClientFrame::from_cbor(&cbor::decode(b).unwrap()).unwrap() {
                    ClientFrame::Response(r) if r.id == 3 => Some(r),
                    _ => None,
                }
            }
            _ => None,
        })
        .expect("query_contract_v1 response");
    let problem = answer
        .problem
        .expect("oversized hosted ordered contract query must refuse");
    assert_eq!(problem.code, "upgrade_required");
    assert_eq!(
        problem.reason.as_deref(),
        Some("contract_query_cursor_required")
    );
}
