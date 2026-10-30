//! Projected (select/link) queries charge only their candidates and each
//! hydrated record once per invocation, under the unchanged hosted account.
use super::engine::{node, settle};
use crate::api::{ClientApi, ErrorCode};
use crate::fake::FakeLogService;
use crate::mem::MemStore;
use crate::store::RecordRow;
use crate::{Store, Tx};
use mdbn_wire::client::{Include, QueryResult};
use mdbn_wire::common::{B16, Value};

const ANNOTATION: &str = "---\nkind: mdbase.type\nname: reader-annotation\nmatch: {path_glob: 'annotations/*.md'}\nschema:\n  dialect: json-schema-2020-12\n  value: {type: object}\n---\n";
const TYPE_PATH: &str = "_types/reader-annotation.md";

fn include() -> Include {
    Include {
        effective: None,
        body: None,
        document: None,
        diagnostics: None,
    }
}

fn annotation(source: &str) -> String {
    format!("---\nsource: '[[{source}]]'\n---\nNote\n")
}

/// Reader's shapes: `select: ["source"]` with the SDK's `linksTo` expansion,
/// plus an `asFile()` projection of the same field.
fn query(target: &str) -> Value {
    Value::Map(vec![
        (
            "types".into(),
            Value::List(vec![Value::Text("reader-annotation".into())]),
        ),
        (
            "where".into(),
            Value::Text(format!(
                "source != null && source.asFile() != null && source.asFile().file.path == \"{target}\""
            )),
        ),
        (
            "select".into(),
            Value::List(vec![
                Value::Text("source".into()),
                Value::Map(vec![
                    ("name".into(), Value::Text("target".into())),
                    (
                        "expr".into(),
                        Value::Text(
                            "source.asFile() == null ? null : source.asFile().file.path".into(),
                        ),
                    ),
                ]),
            ]),
        ),
    ])
}

/// Confirmed rows with the index entries the replica itself derives.
fn seeded(records: Vec<(u128, String, String)>) -> MemStore {
    let catalog = mdbn_core::types::Catalog::load([(TYPE_PATH, ANNOTATION)]);
    let mut store = MemStore::new();
    store
        .commit(Tx {
            resources_put: vec![(TYPE_PATH.into(), ANNOTATION.into())],
            records_put: records
                .into_iter()
                .map(|(n, path, doc)| RecordRow {
                    id: B16(n.to_be_bytes()),
                    path_key: mdbn_core::paths::path_key(&path),
                    meta: crate::plan::record_meta(&catalog, &path, &doc),
                    revision: mdbn_wire::hash::sha256(doc.as_bytes()),
                    path,
                    doc,
                    modified_seq: 0,
                    bucket: 0,
                })
                .collect(),
            ..Tx::default()
        })
        .unwrap();
    store
}

fn run(store: MemStore, target: &str) -> Result<QueryResult, crate::api::ApiError> {
    let svc = FakeLogService::new();
    let mut a = node(&svc, 1, store);
    settle(&mut [&mut a]);
    a.r.query(a.s, query(target), include())
}

fn paths(result: &QueryResult) -> Vec<&str> {
    result.records.iter().map(|r| r.path.as_str()).collect()
}

fn assert_exhausted(result: Result<QueryResult, crate::api::ApiError>) {
    let error = result.unwrap_err();
    assert_eq!(error.code(), Some(ErrorCode::TooLarge));
    assert_eq!(
        error.problem().reason.as_deref(),
        Some("query_budget_exceeded")
    );
}

#[test]
fn typed_link_selection_ignores_non_candidates_past_the_collection_budget() {
    // ~1.5 MiB of large notes and 1100 small ones: both exceed the whole
    // account, but none is a reader-annotation candidate.
    let mut records: Vec<_> = (0..24_u128)
        .map(|n| {
            (
                1_000 + n,
                format!("notes/large-{n}.md"),
                format!("---\ntitle: Large\n---\n{}", "x".repeat(64 * 1024)),
            )
        })
        .chain((0..1_100_u128).map(|n| {
            (
                10_000 + n,
                format!("notes/small-{n}.md"),
                "---\ntitle: Small\n---\n".into(),
            )
        }))
        .collect();
    records.push((1, "sources/a.md".into(), "---\ntitle: A\n---\n".into()));
    records.push((2, "sources/b.md".into(), "---\ntitle: B\n---\n".into()));
    records.push((3, "annotations/1.md".into(), annotation("sources/a")));
    records.push((4, "annotations/2.md".into(), annotation("sources/b")));
    records.push((5, "annotations/3.md".into(), annotation("sources/a")));
    let result = run(seeded(records), "sources/a.md").unwrap();
    assert_eq!(paths(&result), ["annotations/1.md", "annotations/3.md"]);
    assert_eq!(result.columns, Some(vec!["source".into(), "target".into()]));
    let values = result.records[0].values.as_ref().unwrap();
    assert_eq!(
        values.get("target"),
        Some(&Value::Text("sources/a.md".into()))
    );
    assert!(result.complete);
}

#[test]
fn many_links_to_one_large_source_charge_its_bytes_once() {
    // 600 KiB fits the 1 MiB account once; every annotation reaches it
    // through several asFile() reads, which previously recharged it each time.
    let mut records = vec![(
        1,
        "sources/big.md".to_string(),
        format!("---\ntitle: Big\n---\n{}", "x".repeat(600 * 1024)),
    )];
    for n in 0..20_u128 {
        records.push((
            100 + n,
            format!("annotations/{n}.md"),
            annotation("sources/big"),
        ));
    }
    let result = run(seeded(records), "sources/big.md").unwrap();
    assert_eq!(result.records.len(), 20);
    assert!(result.records.iter().all(|r| {
        r.values.as_ref().unwrap().get("target") == Some(&Value::Text("sources/big.md".into()))
    }));
}

#[test]
fn candidates_past_the_budget_still_fail_closed() {
    // More candidate identities than the ID ceiling.
    let mut records = vec![(
        1,
        "sources/a.md".to_string(),
        "---\ntitle: A\n---\n".to_string(),
    )];
    for n in 0..1_001_u128 {
        records.push((
            100 + n,
            format!("annotations/{n}.md"),
            annotation("sources/a"),
        ));
    }
    assert_exhausted(run(seeded(records), "sources/a.md"));

    // Candidate sources whose bytes exceed the account.
    let mut records = vec![(
        1,
        "sources/a.md".to_string(),
        "---\ntitle: A\n---\n".to_string(),
    )];
    for n in 0..3_u128 {
        records.push((
            100 + n,
            format!("annotations/{n}.md"),
            format!("{}{}", annotation("sources/a"), "x".repeat(400 * 1024)),
        ));
    }
    assert_exhausted(run(seeded(records), "sources/a.md"));

    // Distinct link targets still share the same account.
    let mut records = Vec::new();
    for n in 0..3_u128 {
        records.push((
            1 + n,
            format!("sources/{n}.md"),
            format!("---\ntitle: S\n---\n{}", "x".repeat(400 * 1024)),
        ));
        records.push((
            100 + n,
            format!("annotations/{n}.md"),
            annotation(&format!("sources/{n}")),
        ));
    }
    assert_exhausted(run(seeded(records), "sources/0.md"));
}

#[test]
fn clock_dependent_membership_keeps_the_complete_scan() {
    // Stored membership is clock-free, so it never lists `overdue`; the
    // query's own clock does. Narrowing on it would silently drop the match.
    const OVERDUE: &str = "---\nkind: mdbase.type\nname: overdue\nmatch:\n  expr: 'has(raw.due) && raw.due < today()'\nschema:\n  dialect: json-schema-2020-12\n  value: {type: object}\n---\n";
    let mut store = MemStore::new();
    store
        .commit(Tx {
            resources_put: vec![("_types/overdue.md".into(), OVERDUE.into())],
            ..Tx::default()
        })
        .unwrap();
    let svc = FakeLogService::new();
    let mut a = node(&svc, 1, store);
    settle(&mut [&mut a]);
    a.create(20, "tasks/late.md", "---\ndue: '2000-01-01'\n---\n");
    settle(&mut [&mut a]);
    assert!(
        a.r.store()
            .record(&B16([20; 16]))
            .unwrap()
            .unwrap()
            .meta
            .types
            .is_empty()
    );
    let query = Value::Map(vec![
        (
            "types".into(),
            Value::List(vec![Value::Text("overdue".into())]),
        ),
        (
            "select".into(),
            Value::List(vec![Value::Text("file.path".into())]),
        ),
    ]);
    let result = a.r.query(a.s, query, include()).unwrap();
    assert_eq!(paths(&result), ["tasks/late.md"]);
}
