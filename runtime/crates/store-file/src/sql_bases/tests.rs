use super::*;
use crate::index::{IndexDurability, IndexInfo, OpenState, StmtResult};
use mdbn_core::value::Value;
use mdbn_replica::store::{Head, RecordMeta};
use mdbn_replica::store_query::{QueryIndexTx, QueryIndexedRow};
use mdbn_wire::common::{B16, B32, DataMap, Value as WireValue};

fn record(doc: &str) -> RecordRow {
    RecordRow {
        id: B16([1; 16]),
        path: "Tasks/a.md".into(),
        path_key: "tasks/a.md".into(),
        doc: doc.into(),
        revision: B32(Hash::of(doc.as_bytes()).0),
        modified_seq: 0,
        bucket: 0,
        meta: RecordMeta::default(),
    }
}
fn capture(row: &RecordRow) -> Option<Payload> {
    let mut remaining = MAX_TX_TAG_STEPS;
    super::capture(row, &mut remaining)
}
fn fields(payload: &Payload) -> mdbn_core::value::Map {
    convert::map(&DataMap::<WireValue>::from_cbor(&cbor::decode(&payload.fields).unwrap()).unwrap())
        .unwrap()
}
fn tags(payload: &Payload) -> Option<Vec<String>> {
    match cbor::decode(&payload.tags).unwrap() {
        Cbor::Null => None,
        c => Some(Vec::<String>::from_cbor(&c).unwrap()),
    }
}

#[test]
fn raw_values_are_not_temporal_atoms_or_effective_defaults() {
    let r = record(
        "---\ndue: 2026-06-10\nprojects: ['[[Projects/Work|Alias]]']\ntags: [task]\n'null': null\nflag: false\nzero: 0\nempty: ''\nmap: {b: 2, a: 1}\n---\n#inline\n",
    );
    let payload = capture(&r).unwrap();
    let raw = fields(&payload);
    assert_eq!(raw.get("due"), Some(&Value::Text("2026-06-10".into())));
    assert_eq!(
        raw.get("projects"),
        Some(&Value::List(vec![Value::Text(
            "[[Projects/Work|Alias]]".into()
        )]))
    );
    assert_eq!(
        raw.get("tags"),
        Some(&Value::List(vec![Value::Text("task".into())]))
    );
    assert_eq!(raw.get("null"), Some(&Value::Null));
    assert_eq!(raw.get("missing"), None);
    assert_eq!(raw.get("flag"), Some(&Value::Bool(false)));
    assert_eq!(raw.get("zero"), Some(&Value::Int(0)));
    assert_eq!(raw.get("empty"), Some(&Value::Text(String::new())));
    assert_eq!(
        raw,
        Document::parse_at(&r.path, &r.doc).frontmatter().clone()
    );
    assert_eq!(tags(&payload), Some(vec!["#inline".into(), "#task".into()]));
}

#[test]
fn cumulative_tag_work_never_resets_at_a_row_boundary() {
    let row = record("#task\n");
    let mut remaining = 100;
    assert!(super::capture(&row, &mut remaining).is_some());
    assert!(remaining < 100);
    let mut none = 0;
    assert!(super::capture(&row, &mut none).is_none());
    assert_eq!(none, 0);
}

#[test]
fn unavailable_and_known_empty_are_distinct() {
    assert_eq!(
        tags(&capture(&record("plain body\n")).unwrap()),
        Some(vec![])
    );
    assert_eq!(tags(&capture(&record("```\n#task\n```\n")).unwrap()), None);
    assert!(capture(&record("---\na: [\n---\n")).is_none());
    let mut bad = record("plain body");
    bad.revision = B32([0; 32]);
    assert!(capture(&bad).is_none());
    assert!(capture(&record(&"x".repeat(MAX_SOURCE + 1))).is_none());
}

struct Probe {
    generation: Option<([u8; 32], bool, i64)>,
    calls: Vec<Batch>,
}
impl IndexStorage for Probe {
    fn info(&self) -> IndexInfo {
        IndexInfo {
            durability: IndexDurability::Durable,
            opened: OpenState::Fresh,
            sqlite_version: 3_045_000,
        }
    }
    fn reset(&mut self) -> Result<(), IndexError> {
        unreachable!()
    }
    fn run(&mut self, batch: &Batch) -> Result<Vec<StmtResult>, IndexError> {
        self.calls.push(batch.clone());
        assert_eq!(batch.stmts.len(), 1);
        let statement = &batch.stmts[0];
        if statement.sql.contains("FROM st_qraw_state") {
            Ok(vec![StmtResult {
                columns: 3,
                values: self
                    .generation
                    .map_or_else(Vec::new, |(g, ready, version)| {
                        vec![
                            blob(&g),
                            SqlValue::Integer(i64::from(ready)),
                            SqlValue::Integer(version),
                        ]
                    }),
                ..StmtResult::default()
            }])
        } else if statement.sql.contains("FROM st_kv WHERE k='head'") {
            Ok(vec![StmtResult {
                columns: 1,
                ..StmtResult::default()
            }])
        } else {
            assert!(statement.sql.contains("CASE WHEN length(row)<=?"));
            Ok(vec![StmtResult {
                columns: 1,
                ..StmtResult::default()
            }])
        }
    }
}
fn tx(row: RecordRow) -> Tx {
    Tx {
        query_index: Some(QueryIndexTx {
            generation: [7; 32],
            replace_specs: None,
            rows: vec![QueryIndexedRow {
                id: row.id,
                path: row.path.clone(),
                types: vec![],
                fields: vec![],
            }],
            publish_at: Some(Head::GENESIS),
        }),
        records_put: vec![row],
        ..Tx::default()
    }
}
fn probe(ready: bool) -> Rc<RefCell<Probe>> {
    Rc::new(RefCell::new(Probe {
        generation: Some(([7; 32], ready, VERSION)),
        calls: vec![],
    }))
}

#[test]
fn ready_commits_only_capture_and_certify_touched_rows() {
    let p = probe(true);
    let r = record("---\ntags: [task]\n---\n#inline\n");
    let statements = maintenance(&p, &tx(r.clone())).unwrap();
    assert_eq!(p.borrow().calls.len(), 2);
    assert!(
        p.borrow()
            .calls
            .iter()
            .all(|b| b.stmts[0].sql.contains("FROM st_qraw_state")
                || b.stmts[0].sql.contains("FROM st_kv WHERE k='head'"))
    );
    assert!(
        statements
            .iter()
            .all(|s| s.sql != COVERAGE && s.sql != "DELETE FROM st_qraw")
    );
    assert_eq!(statements.last().unwrap().sql, TOUCHED);
    let insert = statements
        .iter()
        .find(|s| s.sql.starts_with("INSERT OR REPLACE INTO st_qraw("))
        .unwrap();
    assert_eq!(
        &insert.params[..4],
        &[
            blob(&r.id.0),
            blob(r.path.as_bytes()),
            blob(&r.revision.0),
            SqlValue::Integer(r.doc.len() as i64)
        ]
    );
}

#[test]
fn rebuild_and_bad_optional_rows_never_publish_empty_success() {
    let p = probe(false);
    let statements = maintenance(&p, &tx(record("body"))).unwrap();
    assert_eq!(statements.last().unwrap().sql, COVERAGE);
    let bad = maintenance(&p, &tx(record("---\na: [\n---\n"))).unwrap();
    assert!(
        bad.iter()
            .any(|s| s.sql == "DELETE FROM st_qraw WHERE id=?")
    );
    assert!(bad.iter().all(|s| s.sql != COVERAGE));
    assert_eq!(bad.last().unwrap().sql, invalidate()[0].sql);
    let mut cold = tx(record("body"));
    cold.records_put.clear();
    let cold = maintenance(&p, &cold).unwrap();
    assert_eq!(cold.last().unwrap().sql, invalidate()[0].sql);
    assert!(
        p.borrow().calls.last().unwrap().stmts[0]
            .sql
            .contains("CASE WHEN length(row)<=?")
    );
}

#[test]
fn mismatched_publication_head_poisoning_precedes_raw_capture_or_coverage() {
    for actual in [
        None,
        Some(Head {
            seq: 2,
            chain: B32([2; 32]),
        }),
    ] {
        let p = probe(true);
        let mut update = tx(record("body"));
        update.head = actual;
        update.query_index.as_mut().unwrap().publish_at = Some(Head {
            seq: 1,
            chain: B32([1; 32]),
        });
        assert_eq!(maintenance(&p, &update).unwrap(), invalidate());
        assert_eq!(p.borrow().calls.len(), usize::from(actual.is_none()));
        assert!(
            p.borrow()
                .calls
                .iter()
                .all(|b| b.stmts[0].sql.contains("FROM st_kv WHERE k='head'"))
        );
    }
}

#[test]
fn deletes_and_snapshot_swaps_preserve_atomic_coverage_rules() {
    let p = probe(true);
    let mut deletion = tx(record("body"));
    deletion.records_del.push(B16([2; 16]));
    let out = maintenance(&p, &deletion).unwrap();
    assert_eq!(out.iter().filter(|s| s.sql == TOUCHED).count(), 2);
    let swapped = maintenance(
        &p,
        &Tx {
            stage: Stage::Swap,
            ..Tx::default()
        },
    )
    .unwrap();
    assert!(swapped.iter().any(|s| s.sql == "DELETE FROM st_qraw"));
    assert_eq!(swapped[0].sql, invalidate()[0].sql);
    assert!(
        maintenance(
            &p,
            &Tx {
                stage: Stage::Put,
                ..Tx::default()
            }
        )
        .unwrap()
        .is_empty()
    );
    assert_eq!(
        maintenance(
            &p,
            &Tx {
                records_del: vec![B16([2; 16])],
                ..Tx::default()
            }
        )
        .unwrap(),
        invalidate()
    );
}
