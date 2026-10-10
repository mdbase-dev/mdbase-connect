use super::*;
use mdbn_store_file::testing::replica::store_query::{QueryProjectionRequest, RawField};

fn request(store: &SqlStore<Trace>) -> QueryProjectionRequest {
    let state = store.query_projection_state().unwrap().unwrap();
    QueryProjectionRequest {
        generation: state.generation,
        head: state.head,
        predicate: QueryPredicate::All,
        bases_candidate: None,
        bases_records: None,
        after: None,
        limit: 128,
        max_bytes: 1 << 20,
        fields: vec!["missing".into(), "priority".into()],
        tags: true,
    }
}

#[test]
fn exact_window_id_hydration_is_sparse_byte_bounded_and_complete() {
    let (store, _, blobs, _, _) = open(
        "window_exact_ids",
        (1..=10)
            .map(|n| row(n, &format!("priority: {n}")))
            .collect(),
        &["priority"],
    );
    let mut req = request(&store);
    req.bases_records = Some(vec![id(1), id(3), id(7)]);
    let page = store.query_projection_page(&req).unwrap();
    page.check(&req).unwrap();
    assert_eq!(
        page.rows.iter().map(|r| r.id).collect::<Vec<_>>(),
        vec![id(1), id(3), id(7)]
    );
    assert!(!page.has_more);
    let mut single = req.clone();
    single.bases_records = Some(vec![id(1)]);
    single.limit = 1;
    req.max_bytes = store.query_projection_page(&single).unwrap().encoded_bytes;
    let first = store.query_projection_page(&req).unwrap();
    first.check(&req).unwrap();
    assert_eq!(first.rows.len(), 1);
    assert_eq!(first.rows[0].id, id(1));
    assert!(first.has_more);
    req.bases_records = Some(vec![id(3), id(7)]);
    let next = store.query_projection_page(&req).unwrap();
    next.check(&req).unwrap();
    assert_eq!(next.rows.len(), 1);
    assert_eq!(next.rows[0].id, id(3));
    assert!(next.has_more);
    req.bases_records = Some(vec![id(7)]);
    let last = store.query_projection_page(&req).unwrap();
    last.check(&req).unwrap();
    assert_eq!(last.rows[0].id, id(7));
    assert!(!last.has_more);
    req.max_bytes = 1 << 20;
    req.bases_records = Some(vec![id(1), id(99)]);
    assert!(store.query_projection_page(&req).is_err());
    assert_eq!(blobs.get(), 0);
}
#[test]
fn raw_uuid_pages_cross_legacy_window_without_source_hydration() {
    let rows: Vec<_> = (1..=500)
        .map(|n| row(n, &format!("priority: {n}\ntags: [task]")))
        .collect();
    let (mut store, index, blobs, _, refs) = open("raw_uuid_pages", rows, &["priority"]);
    for (first, last) in [(501, 1000), (1001, 1100)] {
        let rows: Vec<_> = (first..=last)
            .map(|n| row(n, &format!("priority: {n}\ntags: [task]")))
            .collect();
        let projected = rows
            .iter()
            .map(|r| project_record_query_index_row(&catalog(), r, &refs, 8192).unwrap())
            .collect();
        store
            .commit(Tx {
                records_put: rows,
                query_index: Some(QueryIndexTx {
                    generation: [7; 32],
                    replace_specs: None,
                    rows: projected,
                    publish_at: Some(Head::GENESIS),
                }),
                ..Tx::default()
            })
            .unwrap();
    }
    let mut req = request(&store);
    let mut ids = vec![];
    // All must remain usable even when configured sort-field coverage is unready.
    sql(&index, "UPDATE st_qstate SET ready=0", vec![]);
    let mut pages = 0;
    loop {
        let page = store.query_projection_page(&req).unwrap();
        page.check(&req).unwrap();
        pages += 1;
        assert!(!page.rows.is_empty());
        assert!(page.encoded_bytes <= req.max_bytes);
        for r in &page.rows {
            assert!(matches!(r.fields[0], RawField::Missing));
            assert_eq!(r.tags, Some(vec!["#task".into()]));
            ids.push(r.id);
        }
        req.after = page.rows.last().map(|r| r.id);
        if !page.has_more {
            break;
        }
    }
    assert_eq!(ids, (1..=1100).map(id).collect::<Vec<_>>());
    assert_eq!(pages, 9);
    assert_eq!(blobs.get(), 0);
}

#[test]
fn raw_names_need_not_be_sort_specs_and_null_is_present() {
    let (store, _, _, _, _) = open(
        "raw_requested_names",
        vec![row(
            1,
            "priority: 1\n'null': null\ndue: 2026-06-10\nprojects: ['[[P/Work|Alias]]']\ntags: [task]",
        )],
        &["priority"],
    );
    let mut req = request(&store);
    req.fields = vec![
        "due".into(),
        "missing".into(),
        "null".into(),
        "projects".into(),
        "tags".into(),
    ];
    let page = store.query_projection_page(&req).unwrap();
    let fields = &page.rows[0].fields;
    assert!(matches!(&fields[0],RawField::Present(CoreValue::Text(s)) if s=="2026-06-10"));
    assert!(matches!(fields[1], RawField::Missing));
    assert!(matches!(fields[2], RawField::Present(CoreValue::Null)));
    assert!(
        matches!(&fields[3],RawField::Present(CoreValue::List(v)) if v==&vec![CoreValue::Text("[[P/Work|Alias]]".into())])
    );
    assert!(
        matches!(&fields[4],RawField::Present(CoreValue::List(v)) if v==&vec![CoreValue::Text("task".into())])
    );
}

#[test]
fn byte_capped_short_page_is_not_eof_and_first_row_oversize_refuses() {
    let (store, _, _, _, _) = open(
        "raw_byte_pages",
        vec![
            row(1, "priority: 1"),
            row(2, "priority: 2"),
            row(3, "priority: 3"),
        ],
        &["priority"],
    );
    let mut req = request(&store);
    req.limit = 1;
    let first = store.query_projection_page(&req).unwrap();
    assert!(first.has_more);
    req.limit = 128;
    req.max_bytes = first.encoded_bytes;
    let first = store.query_projection_page(&req).unwrap();
    assert_eq!(first.rows.len(), 1);
    assert!(first.has_more);
    req.after = Some(first.rows[0].id);
    let next = store.query_projection_page(&req).unwrap();
    assert_eq!(next.rows[0].id, id(2));
    assert!(next.has_more);
    req.max_bytes = 1;
    assert_eq!(
        store.query_projection_page(&req).unwrap_err(),
        StoreError::Full
    );
    req.after = Some(id(3));
    let empty = store.query_projection_page(&req).unwrap();
    assert!(empty.rows.is_empty());
    assert!(!empty.has_more);
}

#[test]
fn necessary_predicates_use_shared_r6_selection_and_independent_index_fence() {
    let (store, index, blobs, _, refs) = open(
        "raw_r6_candidates",
        vec![
            row(1, "priority: 1"),
            row(2, "priority: 2"),
            row(3, "priority: 2"),
        ],
        &["priority"],
    );
    let mut req = request(&store);
    req.predicate = QueryPredicate::Compare {
        column: QueryColumn::Field(query_index_fields(&refs, 8192).unwrap()[0].clone()),
        op: QueryCompare::Eq,
        value: atom(CoreValue::Int(2)),
    };
    req.limit = 1;
    let first = store.query_projection_page(&req).unwrap();
    assert_eq!(first.rows[0].id, id(2));
    assert!(first.has_more);
    req.after = Some(id(2));
    let last = store.query_projection_page(&req).unwrap();
    assert_eq!(last.rows[0].id, id(3));
    assert!(!last.has_more);
    assert_eq!(blobs.get(), 0);
    sql(&index, "UPDATE st_qstate SET ready=0", vec![]);
    assert!(store.query_projection_page(&req).is_err());
}

#[test]
fn unready_versions_and_generation_or_head_drift_refuse() {
    let (store, index, _, _, _) = open(
        "raw_state_fences",
        vec![row(1, "priority: 1")],
        &["priority"],
    );
    let mut req = request(&store);
    req.generation = [9; 32];
    assert!(store.query_projection_page(&req).is_err());
    req.generation = [7; 32];
    req.head = Head {
        seq: 1,
        chain: revision(b"owned changed head"),
    };
    assert!(store.query_projection_page(&req).is_err());
    req.head = Head::GENESIS;
    sql(&index, "UPDATE st_qraw_state SET version=0", vec![]);
    assert!(!store.query_projection_state().unwrap().unwrap().ready);
    assert!(store.query_projection_page(&req).is_err());
    sql(&index, "DELETE FROM st_qraw_state", vec![]);
    assert!(!store.query_projection_state().unwrap().unwrap().ready);
}

#[test]
fn unavailable_tags_and_unrequested_values_do_not_become_empty_tags() {
    let mut r = row(1, "priority: 1");
    r.doc.push_str("```\n#task\n```\n");
    r.revision = revision(r.doc.as_bytes());
    let (store, _, _, _, _) = open("raw_tag_availability", vec![r], &["priority"]);
    let mut req = request(&store);
    assert_eq!(
        store.query_projection_page(&req).unwrap().rows[0].tags,
        None
    );
    req.fields.clear();
    req.tags = false;
    let r = store.query_projection_page(&req).unwrap().rows.remove(0);
    assert!(r.fields.is_empty());
    assert_eq!(r.tags, None);
}

struct Drift {
    inner: Trace,
    armed: bool,
}
impl IndexStorage for Drift {
    fn info(&self) -> mdbn_store_file::index::IndexInfo {
        self.inner.info()
    }
    fn reset(&mut self) -> Result<(), IndexError> {
        self.inner.reset()
    }
    fn run(&mut self, batch: &Batch) -> Result<Vec<StmtResult>, IndexError> {
        let metadata = self.armed
            && batch.stmts.iter().any(|s| {
                s.sql
                    .contains("source_bytes,length(path),length(fields),length(tags)")
            });
        let result = self.inner.run(batch)?;
        if metadata {
            self.armed = false;
            let changed = cbor::encode(&cbor::Cbor::Array(vec![
                1u64.to_cbor(),
                revision(b"owned mid-page head").to_cbor(),
            ]))
            .unwrap();
            self.inner.run(&Batch {
                mode: BatchMode::Transaction,
                stmts: vec![Stmt::new(
                    "INSERT OR REPLACE INTO st_kv(k,v) VALUES('head',?)",
                    vec![SqlValue::Blob(changed)],
                )],
            })?;
        }
        Ok(result)
    }
}

#[test]
fn mid_page_head_change_suppresses_the_entire_page() {
    let (store, index, _, _, _) = open(
        "raw_midpage_head",
        vec![row(1, "priority: 1")],
        &["priority"],
    );
    let req = request(&store);
    drop(store);
    let inner = Rc::try_unwrap(index).ok().unwrap().into_inner();
    let index = Rc::new(RefCell::new(Drift { inner, armed: true }));
    let store = SqlStore::open(index).unwrap();
    assert!(matches!(
        store.query_projection_page(&req),
        Err(StoreError::Io(_))
    ));
}

struct CountFree {
    inner: Trace,
    armed: bool,
}
impl IndexStorage for CountFree {
    fn info(&self) -> mdbn_store_file::index::IndexInfo {
        self.inner.info()
    }
    fn reset(&mut self) -> Result<(), IndexError> {
        self.inner.reset()
    }
    fn run(&mut self, batch: &Batch) -> Result<Vec<StmtResult>, IndexError> {
        if self.armed {
            for stmt in &batch.stmts {
                assert!(
                    !stmt.sql.contains("count(*)"),
                    "projection paging must not scan match counts: {}",
                    stmt.sql
                );
                assert!(
                    !stmt.sql.contains("SELECT row FROM st_rec"),
                    "no warm document hydration"
                );
            }
        }
        self.inner.run(batch)
    }
}

#[test]
fn predicate_pages_are_count_free_with_exact_limit_lookahead_and_byte_prefixes() {
    let rows = (1..=130).map(|n| row(n, "priority: 2")).collect();
    let (store, index, _, _, refs) = open("raw_count_free", rows, &["priority"]);
    let mut req = request(&store);
    req.predicate = QueryPredicate::Compare {
        column: QueryColumn::Field(query_index_fields(&refs, 8192).unwrap()[0].clone()),
        op: QueryCompare::Eq,
        value: atom(CoreValue::Int(2)),
    };
    drop(store);
    let inner = Rc::try_unwrap(index).ok().unwrap().into_inner();
    let index = Rc::new(RefCell::new(CountFree {
        inner,
        armed: false,
    }));
    let store = SqlStore::open(index.clone()).unwrap();
    // Schema initialization maintains unrelated tail/own retained statistics.
    // All projection selection/fence/preflight/hydration statements are guarded.
    index.borrow_mut().armed = true;
    let first = store.query_projection_page(&req).unwrap();
    assert_eq!(first.rows.len(), 128);
    assert!(first.has_more);
    req.after = Some(first.rows.last().unwrap().id);
    let last = store.query_projection_page(&req).unwrap();
    assert_eq!(last.rows.len(), 2);
    assert!(!last.has_more);
    assert_eq!(
        last.rows.iter().map(|r| r.id).collect::<Vec<_>>(),
        vec![id(129), id(130)]
    );
    req.after = None;
    req.limit = 1;
    let one = store.query_projection_page(&req).unwrap();
    req.limit = 128;
    req.max_bytes = one.encoded_bytes;
    let mut ids = Vec::new();
    loop {
        let page = store.query_projection_page(&req).unwrap();
        assert_eq!(page.rows.len(), 1);
        ids.push(page.rows[0].id);
        req.after = Some(page.rows[0].id);
        if !page.has_more {
            break;
        }
    }
    assert_eq!(ids, (1..=130).map(id).collect::<Vec<_>>());
}

#[test]
fn malformed_raw_payload_is_corruption_not_a_missing_or_null_field() {
    let (store, index, _, _, _) = open(
        "raw_bad_payload",
        vec![row(1, "priority: 1")],
        &["priority"],
    );
    let req = request(&store);
    sql(
        &index,
        "UPDATE st_qraw SET fields=?",
        vec![SqlValue::Blob(vec![0xff])],
    );
    assert!(matches!(
        store.query_projection_page(&req),
        Err(StoreError::Corrupt(_))
    ));
}

#[test]
fn raw_metadata_limit_preserves_rows_without_sqlite_reprepare() {
    use rusqlite::{Connection, OpenFlags, StatementStatus, params_from_iter};
    use std::collections::BTreeMap;

    struct Capture {
        inner: SqliteIndex,
        metadata: Rc<RefCell<Vec<(Stmt, StmtResult)>>>,
    }
    impl IndexStorage for Capture {
        fn info(&self) -> mdbn_store_file::index::IndexInfo {
            self.inner.info()
        }
        fn reset(&mut self) -> Result<(), IndexError> {
            self.inner.reset()
        }
        fn run(&mut self, batch: &Batch) -> Result<Vec<StmtResult>, IndexError> {
            let results = self.inner.run(batch)?;
            for (statement, result) in batch.stmts.iter().zip(&results) {
                if statement.sql.contains(" FROM st_qraw q WHERE ") {
                    self.metadata
                        .borrow_mut()
                        .push((statement.clone(), result.clone()));
                }
            }
            Ok(results)
        }
    }
    let path = scratch("raw_limit_reprepare").join("index.sqlite");
    let metadata = Rc::new(RefCell::new(Vec::new()));
    let index = Rc::new(RefCell::new(Capture {
        inner: SqliteIndex::open(&path, IndexDurability::Durable).unwrap(),
        metadata: metadata.clone(),
    }));
    let mut store = SqlStore::open(index.clone()).unwrap();
    let records: Vec<_> = (1..=130)
        .map(|n| row(n, &format!("priority: {n}\ntags: [task]")))
        .collect();
    let refs = vec![field("priority")];
    let projected = records
        .iter()
        .map(|r| project_record_query_index_row(&catalog(), r, &refs, 8192).unwrap())
        .collect();
    store
        .commit(Tx {
            records_put: records,
            query_index: Some(QueryIndexTx {
                generation: [7; 32],
                replace_specs: Some(query_index_fields(&refs, 8192).unwrap()),
                rows: projected,
                publish_at: Some(Head::GENESIS),
            }),
            ..Tx::default()
        })
        .unwrap();
    let state = store.query_projection_state().unwrap().unwrap();
    for limit in [1, 2, 128, 2, 1] {
        for after in [None, Some(id(20))] {
            let req = QueryProjectionRequest {
                generation: state.generation,
                head: state.head,
                predicate: QueryPredicate::All,
                bases_candidate: None,
                bases_records: None,
                after,
                limit,
                max_bytes: 1 << 20,
                fields: vec!["missing".into(), "priority".into()],
                tags: true,
            };
            let page = store.query_projection_page(&req).unwrap();
            page.check(&req).unwrap();
            let first = if after.is_some() { 21 } else { 1 };
            let expected: Vec<_> = (first..=130).take(limit as usize).map(id).collect();
            assert_eq!(page.rows.iter().map(|r| r.id).collect::<Vec<_>>(), expected);
            assert_eq!(page.has_more, usize::from(131 - first) > limit as usize);
        }
    }
    drop(store);
    drop(index);

    // Replay the ACTUAL generated metadata statements on the same synthetic DB,
    // read-only, with native SQLite's statement counter (not a timing threshold).
    let conn = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    let mut grouped = BTreeMap::<String, Vec<(Vec<SqlValue>, Vec<SqlValue>)>>::new();
    for (statement, result) in metadata.borrow().iter() {
        assert_eq!(result.columns, 6);
        grouped
            .entry(statement.sql.clone())
            .or_default()
            .push((statement.params.clone(), result.values.clone()));
    }
    assert_eq!(grouped.len(), 2, "initial and UUID continuation shapes");
    let mut current_count = 0;
    let mut legacy_count = 0;
    for (sql, cases) in grouped {
        let legacy = sql.replace("LIMIT CAST(? AS INTEGER)", "LIMIT ?");
        for (query, count) in [(&sql, &mut current_count), (&legacy, &mut legacy_count)] {
            let mut statement = conn.prepare(query).unwrap();
            for (params, expected) in &cases {
                let params: Vec<_> = params
                    .iter()
                    .map(|p| match p {
                        SqlValue::Integer(n) => rusqlite::types::Value::Integer(*n),
                        SqlValue::Blob(b) => rusqlite::types::Value::Blob(b.clone()),
                        _ => panic!("metadata parameters must stay Integer or Blob"),
                    })
                    .collect();
                let mut actual = Vec::new();
                {
                    let mut rows = statement.query(params_from_iter(params)).unwrap();
                    while let Some(row) = rows.next().unwrap() {
                        for column in 0..6 {
                            actual.push(
                                match row.get::<_, rusqlite::types::Value>(column).unwrap() {
                                    rusqlite::types::Value::Integer(n) => SqlValue::Integer(n),
                                    rusqlite::types::Value::Blob(b) => SqlValue::Blob(b),
                                    _ => panic!("metadata values must stay Integer or Blob"),
                                },
                            );
                        }
                    }
                }
                assert_eq!(&actual, expected, "{query}");
                *count += statement.reset_status(StatementStatus::RePrepare);
            }
        }
    }
    eprintln!("raw-metadata-reprepare legacy={legacy_count} current={current_count}");
    assert!(
        legacy_count >= 10,
        "control must reproduce bind-triggered reprepare"
    );
    assert_eq!(
        current_count, 0,
        "typed limit must retain the prepared program"
    );
}
