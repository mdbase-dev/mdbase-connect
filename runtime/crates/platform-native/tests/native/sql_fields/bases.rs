use super::*;

#[path = "bases/candidate.rs"]
mod candidate;
#[path = "bases/driver.rs"]
mod driver;
#[path = "bases/page.rs"]
mod page;
use mdbn_store_file::testing::wire::{
    cbor,
    common::{DataMap, Value as WireValue},
    schema::Wire,
};

fn sql(index: &Rc<RefCell<Trace>>, statement: &str, params: Vec<SqlValue>) -> Vec<SqlValue> {
    index
        .borrow_mut()
        .run(&Batch {
            mode: BatchMode::Autocommit,
            stmts: vec![Stmt::new(statement, params)],
        })
        .unwrap()
        .remove(0)
        .values
}
fn raw(index: &Rc<RefCell<Trace>>, n: u16) -> Vec<SqlValue> {
    sql(
        index,
        "SELECT path,source_sha,source_bytes,fields,tags FROM st_qraw WHERE id=?",
        vec![SqlValue::Blob(id(n).0.to_vec())],
    )
}
fn ready(index: &Rc<RefCell<Trace>>) -> bool {
    sql(
        index,
        "SELECT ready FROM st_qraw_state WHERE slot=0",
        vec![],
    ) == vec![SqlValue::Integer(1)]
}
fn decode(value: &SqlValue) -> cbor::Cbor {
    let SqlValue::Blob(bytes) = value else {
        panic!("raw blob expected")
    };
    cbor::decode(bytes).unwrap()
}

#[test]
fn raw_source_projection_roundtrips_without_coercion_after_reopen() {
    let r = row(
        1,
        "due: 2026-06-10\nprojects: ['[[Projects/Work|Alias]]']\ntags: [task]\n'null': null\nflag: false\nzero: 0\nempty: ''",
    );
    let (store, index, _, _, _) = open("raw_roundtrip", vec![r.clone()], &["due"]);
    assert!(ready(&index));
    let values = raw(&index, 1);
    assert_eq!(values[0], SqlValue::Blob(r.path.as_bytes().to_vec()));
    assert_eq!(values[1], SqlValue::Blob(r.revision.0.to_vec()));
    assert_eq!(values[2], SqlValue::Integer(r.doc.len() as i64));
    let map = mdbn_store_file::testing::replica::convert::map(
        &DataMap::<WireValue>::from_cbor(&decode(&values[3])).unwrap(),
    )
    .unwrap();
    assert_eq!(
        map,
        mdbn_core::doc::Document::parse_at(&r.path, &r.doc)
            .frontmatter()
            .clone()
    );
    assert_eq!(map.get("due"), Some(&CoreValue::Text("2026-06-10".into())));
    assert_eq!(map.get("missing"), None);
    assert_eq!(map.get("null"), Some(&CoreValue::Null));
    assert_eq!(
        Vec::<String>::from_cbor(&decode(&values[4])).unwrap(),
        vec!["#task"]
    );
    drop(store);
    let _reopened = SqlStore::open(index.clone()).unwrap();
    assert_eq!(raw(&index, 1), values);
    assert!(ready(&index));
}

#[test]
fn raw_backfill_reuses_index_transactions_and_unavailable_is_not_empty() {
    let (mut store, index, _, _, refs) = open("raw_backfill", vec![], &["priority"]);
    let r = row(2, "priority: 2\ntags: [task]");
    store
        .commit(Tx {
            records_put: vec![r.clone()],
            ..Tx::default()
        })
        .unwrap();
    assert!(!ready(&index));
    assert!(raw(&index, 2).is_empty());
    store
        .commit(Tx {
            query_index: Some(QueryIndexTx {
                generation: [7; 32],
                replace_specs: Some(query_index_fields(&refs, 8192).unwrap()),
                rows: vec![project_record_query_index_row(&catalog(), &r, &refs, 8192).unwrap()],
                publish_at: Some(Head::GENESIS),
            }),
            ..Tx::default()
        })
        .unwrap();
    assert!(ready(&index));
    assert!(!raw(&index, 2).is_empty());
    let mut invalid = row(3, "a: [");
    invalid.revision = revision(invalid.doc.as_bytes());
    // Configured zero-field projection is valid, but invalid raw frontmatter
    // remains unavailable and cannot be represented as absent keys.
    store
        .commit(Tx {
            records_put: vec![invalid.clone()],
            query_index: Some(QueryIndexTx {
                generation: [8; 32],
                replace_specs: Some(vec![]),
                rows: vec![QueryIndexedRow {
                    id: invalid.id,
                    path: invalid.path,
                    types: vec![],
                    fields: vec![],
                }],
                publish_at: Some(Head::GENESIS),
            }),
            ..Tx::default()
        })
        .unwrap();
    assert!(!ready(&index));
    assert!(raw(&index, 3).is_empty());
    assert!(store.record(&id(3)).unwrap().is_some());
}

#[test]
fn invalidated_payload_cannot_reactivate_from_id_coverage_alone() {
    let (mut store, index, _, _, refs) = open(
        "raw_sticky_invalidation",
        vec![row(1, "priority: 1")],
        &["priority"],
    );
    let changed = row(1, "priority: 1");
    let projected = project_record_query_index_row(&catalog(), &changed, &refs, 8192).unwrap();
    store
        .commit(Tx {
            query_index: Some(QueryIndexTx {
                generation: [7; 32],
                replace_specs: None,
                rows: vec![projected; 501],
                publish_at: Some(Head::GENESIS),
            }),
            ..Tx::default()
        })
        .unwrap();
    assert!(!ready(&index));
    let unrelated = row(2, "priority: 2");
    store
        .commit(Tx {
            records_put: vec![unrelated.clone()],
            query_index: Some(QueryIndexTx {
                generation: [7; 32],
                replace_specs: None,
                rows: vec![
                    project_record_query_index_row(&catalog(), &unrelated, &refs, 8192).unwrap(),
                ],
                publish_at: Some(Head::GENESIS),
            }),
            ..Tx::default()
        })
        .unwrap();
    // Both IDs exist, but coverage alone cannot certify an invalidated generation.
    assert_eq!(
        sql(&index, "SELECT count(*) FROM st_qraw", vec![]),
        vec![SqlValue::Integer(2)]
    );
    assert!(!ready(&index));
    store
        .commit(Tx {
            query_index: Some(QueryIndexTx {
                generation: [7; 32],
                replace_specs: Some(query_index_fields(&refs, 8192).unwrap()),
                rows: vec![
                    project_record_query_index_row(&catalog(), &changed, &refs, 8192).unwrap(),
                    project_record_query_index_row(&catalog(), &unrelated, &refs, 8192).unwrap(),
                ],
                publish_at: Some(Head::GENESIS),
            }),
            ..Tx::default()
        })
        .unwrap();
    assert!(ready(&index));
    assert_eq!(
        raw(&index, 1)[1],
        SqlValue::Blob(changed.revision.0.to_vec())
    );
}

#[test]
fn raw_storage_failure_is_atomic_with_authoritative_record_write() {
    let original = row(1, "priority: 1");
    let (mut store, index, _, _, refs) = open("raw_atomic", vec![original.clone()], &["priority"]);
    let before = raw(&index, 1);
    sql(
        &index,
        "CREATE TRIGGER deny_raw BEFORE INSERT ON st_qraw BEGIN SELECT RAISE(ABORT,'owned raw test fault'); END",
        vec![],
    );
    let changed = row(1, "priority: 2");
    assert!(
        store
            .commit(Tx {
                records_put: vec![changed.clone()],
                query_index: Some(QueryIndexTx {
                    generation: [7; 32],
                    replace_specs: None,
                    rows: vec![
                        project_record_query_index_row(&catalog(), &changed, &refs, 8192).unwrap()
                    ],
                    publish_at: Some(Head::GENESIS)
                }),
                ..Tx::default()
            })
            .is_err()
    );
    assert_eq!(
        store.record(&id(1)).unwrap().unwrap().revision,
        original.revision
    );
    assert_eq!(raw(&index, 1), before);
}

#[test]
fn raw_publication_head_mismatch_never_certifies_or_recovers_from_retained_ids() {
    use mdbn_store_file::testing::replica::store_query::{QueryPredicate, QueryProjectionRequest};
    let next = Head {
        seq: 1,
        chain: revision(b"owned raw publication head"),
    };
    for advance in [false, true] {
        let (mut store, index, _, _, refs) = open(
            if advance {
                "raw_bad_new_head"
            } else {
                "raw_bad_current_head"
            },
            vec![row(1, "priority: 1")],
            &["priority"],
        );
        let changed = row(1, "priority: 2");
        let projected = project_record_query_index_row(&catalog(), &changed, &refs, 8192).unwrap();
        let actual = if advance { next } else { Head::GENESIS };
        store
            .commit(Tx {
                head: advance.then_some(next),
                records_put: vec![changed.clone()],
                query_index: Some(QueryIndexTx {
                    generation: [7; 32],
                    replace_specs: None,
                    rows: vec![projected.clone()],
                    publish_at: Some(if advance { Head::GENESIS } else { next }),
                }),
                ..Tx::default()
            })
            .unwrap();
        assert_eq!(store.head().unwrap(), actual);
        assert_eq!(
            store.record(&changed.id).unwrap().unwrap().revision,
            changed.revision
        );
        assert!(!ready(&index));
        let state = store.query_projection_state().unwrap().unwrap();
        assert_eq!(state.head, actual);
        assert!(!state.ready);
        assert!(
            store
                .query_projection_page(&QueryProjectionRequest {
                    generation: [7; 32],
                    head: actual,
                    predicate: QueryPredicate::All,
                    bases_candidate: None,
                    bases_records: None,
                    after: None,
                    limit: 128,
                    max_bytes: 1 << 20,
                    fields: vec!["priority".into()],
                    tags: false
                })
                .is_err()
        );
        // A later valid head cannot bless retained IDs after version poisoning.
        store
            .commit(Tx {
                query_index: Some(QueryIndexTx {
                    generation: [7; 32],
                    replace_specs: None,
                    rows: vec![projected.clone()],
                    publish_at: Some(actual),
                }),
                ..Tx::default()
            })
            .unwrap();
        assert!(!ready(&index));
        store
            .commit(Tx {
                query_index: Some(QueryIndexTx {
                    generation: [7; 32],
                    replace_specs: Some(query_index_fields(&refs, 8192).unwrap()),
                    rows: vec![projected],
                    publish_at: Some(actual),
                }),
                ..Tx::default()
            })
            .unwrap();
        assert!(ready(&index));
        assert_eq!(
            raw(&index, 1)[1],
            SqlValue::Blob(changed.revision.0.to_vec())
        );
    }
}

#[test]
fn raw_delete_and_snapshot_swap_do_not_retain_stale_payload() {
    let (mut store, index, _, _, _) = open(
        "raw_delete_swap",
        vec![row(1, "priority: 1"), row(2, "priority: 2")],
        &["priority"],
    );
    store
        .commit(Tx {
            records_del: vec![id(1)],
            ..Tx::default()
        })
        .unwrap();
    assert!(raw(&index, 1).is_empty());
    assert!(!ready(&index));
    store
        .commit(Tx {
            stage: mdbn_store_file::testing::replica::store::Stage::Put,
            records_put: vec![row(3, "priority: 3")],
            ..Tx::default()
        })
        .unwrap();
    assert!(raw(&index, 3).is_empty());
    assert!(!raw(&index, 2).is_empty());
    store
        .commit(Tx {
            stage: mdbn_store_file::testing::replica::store::Stage::Swap,
            ..Tx::default()
        })
        .unwrap();
    assert!(raw(&index, 2).is_empty());
    assert!(raw(&index, 3).is_empty());
    assert!(!ready(&index));
}
