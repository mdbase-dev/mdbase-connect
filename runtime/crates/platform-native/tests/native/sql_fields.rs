use super::*;

#[path = "sql_fields/bases.rs"]
mod bases;
use mdbn_core::query::{
    FieldRef,
    indexed::{SortAtom, TemporalHint},
    topk::{KeyedRecord, compare},
};
use mdbn_core::types::Catalog;
use mdbn_core::value::Value as CoreValue;
use mdbn_store_file::SqlStore;
use mdbn_store_file::index::{IndexError, StmtResult};
use mdbn_store_file::testing::B16;
use mdbn_store_file::testing::replica::plan::{project_record_query_index_row, query_index_fields};
use mdbn_store_file::testing::replica::store::{Head, RecordMeta, RecordRow, StoreError};
use mdbn_store_file::testing::replica::store_query::*;

struct Trace {
    inner: SqliteIndex,
    blob_reads: Rc<Cell<usize>>,
    key_reads: Rc<Cell<usize>>,
    full_coverage_checks: Rc<Cell<usize>>,
}
impl IndexStorage for Trace {
    fn info(&self) -> mdbn_store_file::index::IndexInfo {
        self.inner.info()
    }
    fn reset(&mut self) -> Result<(), IndexError> {
        self.inner.reset()
    }
    fn run(&mut self, batch: &Batch) -> Result<Vec<StmtResult>, IndexError> {
        for s in &batch.stmts {
            if s.sql
                .contains("(SELECT count(*) FROM st_qrecord)=(SELECT count(*) FROM st_rec)")
            {
                self.full_coverage_checks
                    .set(self.full_coverage_checks.get() + 1);
            }
            if s.sql.contains("SELECT row FROM st_rec") {
                self.blob_reads.set(self.blob_reads.get() + 1);
            }
            if s.sql.contains("SELECT q.id,length(r.row)")
                && !s.sql.contains("length(f")
                && !s.sql.contains("length(q.path)")
            {
                self.key_reads.set(self.key_reads.get() + 1);
            }
        }
        self.inner.run(batch)
    }
}
fn catalog() -> Catalog {
    let c = Catalog::load([
        ("mdbase.yaml", "spec_version: \"0.3.0\"\n"),
        (
            "_types/task.md",
            "---\nkind: mdbase.type\nname: task\nmatch: {path_glob: 'tasks/*.md'}\nschema:\n  dialect: json-schema-2020-12\n  value: {type: object}\n---\n",
        ),
    ]);
    assert!(c.is_valid(), "{:?}", c.issues());
    c
}
fn id(n: u16) -> B16 {
    let mut b = [0; 16];
    b[..2].copy_from_slice(&n.to_be_bytes());
    B16(b)
}
fn row(n: u16, fields: &str) -> RecordRow {
    let doc = format!("---\n{fields}\n---\nbody\n");
    let path = format!("tasks/{n:04}.md");
    RecordRow {
        id: id(n),
        path_key: mdbn_core::paths::path_key(&path),
        path,
        revision: revision(doc.as_bytes()),
        doc,
        modified_seq: 0,
        bucket: 0,
        meta: RecordMeta::default(),
    }
}
fn field(name: &str) -> FieldRef {
    FieldRef::Effective(vec![name.into()])
}
type Fixture = (
    SqlStore<Trace>,
    Rc<RefCell<Trace>>,
    Rc<Cell<usize>>,
    Rc<Cell<usize>>,
    Vec<FieldRef>,
);
fn open(name: &str, rows: Vec<RecordRow>, names: &[&str]) -> Fixture {
    let path = scratch(name);
    let blobs = Rc::new(Cell::new(0));
    let keys = Rc::new(Cell::new(0));
    let index = Rc::new(RefCell::new(Trace {
        inner: SqliteIndex::open(path.join("index.sqlite"), IndexDurability::Durable).unwrap(),
        blob_reads: blobs.clone(),
        key_reads: keys.clone(),
        full_coverage_checks: Rc::new(Cell::new(0)),
    }));
    let mut store = SqlStore::open(index.clone()).unwrap();
    let refs: Vec<_> = names.iter().map(|n| field(n)).collect();
    let specs = query_index_fields(&refs, 8192).unwrap();
    let c = catalog();
    let projected = rows
        .iter()
        .map(|r| project_record_query_index_row(&c, r, &refs, 8192).unwrap())
        .collect();
    store
        .commit(Tx {
            records_put: rows,
            query_index: Some(QueryIndexTx {
                generation: [7; 32],
                replace_specs: Some(specs),
                rows: projected,
                publish_at: Some(Head::GENESIS),
            }),
            ..Tx::default()
        })
        .unwrap();
    assert!(store.query_index_state().unwrap().unwrap().ready);
    (store, index, blobs, keys, refs)
}
fn atom(v: CoreValue) -> QueryAtom {
    let a = SortAtom::from_value(Some(&v), TemporalHint::None, 8192).unwrap();
    QueryAtom {
        kind: a.kind() as u8,
        key: a.key().to_vec(),
    }
}
fn request(store: &SqlStore<Trace>, refs: &[FieldRef]) -> QueryIndexRequest {
    let state = store.query_index_state().unwrap().unwrap();
    QueryIndexRequest {
        generation: state.generation,
        head: state.head,
        predicate: QueryPredicate::All,
        order: query_index_fields(refs, 8192)
            .unwrap()
            .into_iter()
            .map(|f| QueryOrder {
                column: QueryColumn::Field(f),
                descending: false,
            })
            .collect(),
        after: None,
        offset: 0,
        limit: 1000,
        max_key_bytes: 1 << 20,
        count_matches: true,
    }
}
#[test]
fn indexed_selection_matches_core_mixed_oracle_and_descending_id_ties() {
    let rows = vec![
        row(8, "priority: null\npoints: 1"),
        row(2, "priority: 4\npoints: 1"),
        row(1, "priority: 4.0\npoints: 1"),
        row(3, "priority: 'four'\npoints: 1"),
        row(4, "priority: true\npoints: 1"),
        row(5, "points: 1"),
    ];
    let (store, _, blobs, _, refs) =
        open("query_index_oracle", rows.clone(), &["priority", "points"]);
    for descending in [false, true] {
        let mut req = request(&store, &refs);
        for o in &mut req.order {
            o.descending = descending;
        }
        let result = store.query_index_page(&req).unwrap().unwrap();
        let c = catalog();
        let mut oracle: Vec<_> = rows
            .iter()
            .map(|r| {
                let p = project_record_query_index_row(&c, r, &refs, 8192).unwrap();
                KeyedRecord {
                    id: mdbn_store_file::testing::replica::convert::uuid(&r.id),
                    keys: p
                        .fields
                        .iter()
                        .map(|f| SortAtom::from_parts(f.atom.kind, &f.atom.key, 8192).unwrap())
                        .collect(),
                }
            })
            .collect();
        let dirs = vec![
            if descending {
                mdbn_core::query::Direction::Desc
            } else {
                mdbn_core::query::Direction::Asc
            };
            refs.len()
        ];
        oracle.sort_by(|a, b| compare(a, b, &dirs));
        assert_eq!(
            result.rows.iter().map(|r| r.id).collect::<Vec<_>>(),
            oracle
                .iter()
                .map(|r| mdbn_store_file::testing::replica::convert::wuuid(&r.id))
                .collect::<Vec<_>>()
        );
        assert_eq!(result.total_matches, Some(6));
        assert!(!result.has_more);
        // An offset page is exactly that slice of the full order (keys only).
        for (offset, limit) in [(0u64, 2u32), (2, 2), (4, 2), (5, 3), (6, 1)] {
            let mut paged = req.clone();
            paged.offset = offset;
            paged.limit = limit;
            let page = store.query_index_page(&paged).unwrap().unwrap();
            let want: Vec<_> = result
                .rows
                .iter()
                .skip(offset as usize)
                .take(limit as usize)
                .map(|r| r.id)
                .collect();
            assert_eq!(page.rows.iter().map(|r| r.id).collect::<Vec<_>>(), want);
            assert_eq!(page.total_matches, Some(6));
            assert_eq!(
                page.has_more,
                offset + u64::from(limit) < 6,
                "{offset}+{limit}"
            );
        }
        let ids: Vec<_> = result
            .rows
            .iter()
            .filter(|r| r.id == id(1) || r.id == id(2))
            .map(|r| r.id)
            .collect();
        assert_eq!(ids, [id(1), id(2)]);
    }
    assert_eq!(blobs.get(), 0, "ID/key selection must not hydrate source");
}
#[test]
fn typed_numeric_range_excludes_wrong_kinds_and_keyset_pages_are_exact() {
    let (store, _, blobs, _, refs) = open(
        "query_index_numeric",
        vec![
            row(1, "priority: 4"),
            row(2, "priority: 5"),
            row(3, "priority: 'z'"),
            row(4, "priority: null"),
            row(5, "priority: [10]"),
        ],
        &["priority"],
    );
    let mut req = request(&store, &refs);
    req.limit = 1;
    req.predicate = QueryPredicate::And(vec![
        QueryPredicate::Types(vec!["task".into()]),
        QueryPredicate::Compare {
            column: req.order[0].column.clone(),
            op: QueryCompare::Ge,
            value: atom(CoreValue::Int(4)),
        },
    ]);
    req.order[0].descending = true;
    let first = store.query_index_page(&req).unwrap().unwrap();
    assert_eq!(first.total_matches, Some(2));
    assert_eq!(first.rows[0].id, id(2));
    assert!(first.has_more);
    req.after = first.rows.last().cloned();
    let second = store.query_index_page(&req).unwrap().unwrap();
    assert_eq!(second.rows[0].id, id(1));
    assert_eq!(second.total_matches, Some(2));
    assert!(!second.has_more);
    req.limit = 0;
    req.after = None;
    let zero = store.query_index_page(&req).unwrap().unwrap();
    assert!(zero.rows.is_empty());
    assert_eq!(zero.total_matches, Some(2));
    assert!(zero.has_more);
    assert_eq!(blobs.get(), 0);
}
#[test]
fn core_profile_maps_mixed_case_membership_and_unknown_types_without_hydration() {
    use mdbn_store_file::testing::replica::plan::QueryProjectionContext;
    let resources=vec![("mdbase.yaml".into(),"spec_version: \"0.3.0\"\n".into()),("_types/task.md".into(),"---\nkind: mdbase.type\nname: TASK\nmatch: {path_glob: 'tasks/*.md'}\nschema:\n  dialect: json-schema-2020-12\n  value: {type: object}\n---\n".into())];
    let preferred = vec![field("priority")];
    let sem = mdbn_core::semantics::SEM;
    let ctx = QueryProjectionContext::capture(
        &resources,
        mdbn_store_file::testing::Sem {
            major: sem.major,
            minor: sem.minor,
        },
        &preferred,
        8192,
    )
    .unwrap();
    let (mut store, _, blobs, _, _) = open("query_index_core_profile", vec![], &["priority"]);
    let rows = vec![row(1, "priority: 4"), row(2, "priority: 1")];
    let projected = rows.iter().map(|r| ctx.project_row(r).unwrap()).collect();
    store
        .commit(Tx {
            records_put: rows,
            query_index: Some(QueryIndexTx {
                generation: ctx.generation(),
                replace_specs: Some(ctx.fields().to_vec()),
                rows: projected,
                publish_at: Some(Head::GENESIS),
            }),
            ..Tx::default()
        })
        .unwrap();
    for spelling in ["TASK", "task", "TaSk", "unknown"] {
        let q = mdbn_core::query::Query {
            types: vec![spelling.into()],
            where_: Some("priority >= 4".into()),
            ..Default::default()
        };
        let plan = mdbn_core::query::compile(&q, ctx.catalog()).unwrap();
        let profile = mdbn_core::query::profile::lower(&plan, ctx.catalog()).unwrap();
        let req = QueryIndexRequest {
            count_matches: true,
            ..QueryIndexRequest::from_profile(&profile, &ctx, Head::GENESIS, 50, 1 << 20).unwrap()
        };
        let selected = store.query_index_page(&req).unwrap().unwrap();
        assert_eq!(
            selected.total_matches,
            Some(if spelling == "unknown" { 0 } else { 1 })
        );
    }
    assert_eq!(blobs.get(), 0);
    let q = mdbn_core::query::Query {
        where_: Some("unmaterialized == 4".into()),
        ..Default::default()
    };
    let plan = mdbn_core::query::compile(&q, ctx.catalog()).unwrap();
    let profile = mdbn_core::query::profile::lower(&plan, ctx.catalog()).unwrap();
    assert!(QueryIndexRequest::from_profile(&profile, &ctx, Head::GENESIS, 50, 1 << 20).is_err());
    assert_eq!(blobs.get(), 0);
}
#[test]
fn key_budget_preflight_and_invalid_ast_never_copy_keys_or_source() {
    let (store, _, blobs, keys, refs) = open(
        "query_index_key_preflight",
        vec![
            row(1, "priority: 'abcdefghijklmnop'"),
            row(2, "priority: 'qrstuvwxyz'"),
        ],
        &["priority"],
    );
    let mut req = request(&store, &refs);
    req.max_key_bytes = 1;
    assert_eq!(store.query_index_page(&req), Err(StoreError::Full));
    assert_eq!(keys.get(), 0);
    assert_eq!(blobs.get(), 0);
    req.limit = 1001;
    assert_eq!(store.query_index_page(&req), Err(StoreError::Full));
    req.limit = 1000;
    req.max_key_bytes = 1 << 20;
    for _ in 0..18 {
        req.predicate = QueryPredicate::And(vec![req.predicate]);
    }
    assert_eq!(store.query_index_page(&req), Err(StoreError::Full));
    assert_eq!(keys.get(), 0);
}
#[test]
fn optional_projection_failures_commit_valid_records_but_fence_queries() {
    for cause in ["missing", "generation", "wide"] {
        let (mut store, _, _, _, refs) = open(
            &format!("query_index_failsoft_{cause}"),
            vec![row(1, "priority: 4")],
            &["priority"],
        );
        let r = row(1, "priority: 9");
        let c = catalog();
        let mut projection = project_record_query_index_row(&c, &r, &refs, 8192).unwrap();
        if cause == "wide" {
            projection.fields[0].atom.key = vec![1; 9000];
        }
        let update = if cause == "missing" {
            None
        } else {
            Some(QueryIndexTx {
                generation: if cause == "generation" {
                    [8; 32]
                } else {
                    [7; 32]
                },
                replace_specs: None,
                rows: vec![projection],
                publish_at: None,
            })
        };
        store
            .commit(Tx {
                records_put: vec![r.clone()],
                query_index: update,
                ..Tx::default()
            })
            .unwrap();
        assert_eq!(store.record(&r.id).unwrap().unwrap().doc, r.doc);
        assert!(!store.query_index_state().unwrap().unwrap().ready);
        assert!(store.query_index_page(&request(&store, &refs)).is_err());
        // A later valid update of ANOTHER record cannot count stale retained
        // fields as coverage and accidentally re-activate this changed row.
        let other = row(2, "priority: 3");
        let other_projection = project_record_query_index_row(&c, &other, &refs, 8192).unwrap();
        store
            .commit(Tx {
                records_put: vec![other],
                query_index: Some(QueryIndexTx {
                    generation: [7; 32],
                    replace_specs: None,
                    rows: vec![other_projection],
                    publish_at: Some(Head::GENESIS),
                }),
                ..Tx::default()
            })
            .unwrap();
        assert!(!store.query_index_state().unwrap().unwrap().ready);
    }
}
#[test]
#[ignore = "manual release-only backend timing, not LAB/server qualification"]
fn indexed_sql_warm_10k_backend_timing() {
    use std::time::Instant;
    let (mut store, _, blobs, _, refs) =
        open("query_index_10k_bench", vec![], &["priority", "points"]);
    let c = catalog();
    for first in (0u16..10_000).step_by(64) {
        let rows: Vec<_> = (first..first.saturating_add(64).min(10_000))
            .map(|i| row(i, &format!("priority: {}\npoints: {}", i % 10, i % 31)))
            .collect();
        let projected = rows
            .iter()
            .map(|r| project_record_query_index_row(&c, r, &refs, 8192).unwrap())
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
    let mut req = request(&store, &refs);
    req.limit = 50;
    req.order[0].descending = true;
    req.order[1].descending = true;
    req.order.push(QueryOrder {
        column: QueryColumn::Path,
        descending: false,
    });
    req.predicate = QueryPredicate::And(vec![
        QueryPredicate::Types(vec!["task".into()]),
        QueryPredicate::Compare {
            column: req.order[0].column.clone(),
            op: QueryCompare::Ge,
            value: atom(CoreValue::Int(4)),
        },
    ]);
    let mut timings = Vec::new();
    for _ in 0..21 {
        let start = Instant::now();
        let page = store.query_index_page(&req).unwrap().unwrap();
        assert_eq!(page.total_matches, Some(6000));
        assert_eq!(page.rows.len(), 50);
        assert!(page.has_more);
        timings.push(start.elapsed().as_micros());
    }
    timings.sort();
    eprintln!(
        "backend_only_10k_top50 median_us={} p95_us={} total_matches=6000 source_blob_reads={}",
        timings[10],
        timings[19],
        blobs.get()
    );
    assert_eq!(blobs.get(), 0);
}
#[test]
fn neutral_store_budget_is_shared_across_pages_and_stale_restart() {
    let (store, _, blobs, _, refs) = open(
        "query_index_shared_budget",
        vec![row(1, "priority: 4"), row(2, "priority: 5")],
        &["priority"],
    );
    let req = request(&store, &refs);
    let selected = store.query_index_page(&req).unwrap().unwrap();
    let total_bytes = selected.rows.iter().map(|r| r.encoded_bytes).sum();
    let mut budget = QueryBudget::new(2, total_bytes);
    store
        .hydrate_query_at(&[id(1)], req.head, &mut budget)
        .unwrap();
    store
        .hydrate_query_at(&[id(2)], req.head, &mut budget)
        .unwrap();
    assert_eq!(budget.records_left(), 0);
    assert_eq!(budget.bytes_left(), 0);
    let reads = blobs.get();
    assert_eq!(
        store.hydrate_query_at(&[id(1)], req.head, &mut budget),
        Err(StoreError::Full)
    );
    assert_eq!(
        blobs.get(),
        reads,
        "same request never gets a renewed hydration budget"
    );
    let mut stale_req = req.clone();
    stale_req.generation = [8; 32];
    assert!(store.query_index_page(&stale_req).is_err());
    assert_eq!(
        budget.records_left(),
        0,
        "selection restart cannot refresh work"
    );
}
#[test]
fn deletion_keeps_null_coverage_and_nonlive_projection_cannot_keep_ready() {
    let (mut store, _, _, _, refs) = open(
        "query_index_delete_coverage",
        vec![row(1, "priority: null"), row(2, "body_only: true")],
        &["priority"],
    );
    let mut req = request(&store, &refs);
    req.predicate = QueryPredicate::Compare {
        column: req.order[0].column.clone(),
        op: QueryCompare::Eq,
        value: QueryAtom {
            kind: 255,
            key: vec![],
        },
    };
    assert_eq!(
        store.query_index_page(&req).unwrap().unwrap().total_matches,
        Some(2)
    );
    store
        .commit(Tx {
            records_del: vec![id(1)],
            ..Tx::default()
        })
        .unwrap();
    assert!(store.query_index_state().unwrap().unwrap().ready);
    assert_eq!(
        store.query_index_page(&req).unwrap().unwrap().total_matches,
        Some(1)
    );
    let fake =
        project_record_query_index_row(&catalog(), &row(99, "priority: 8"), &refs, 8192).unwrap();
    store
        .commit(Tx {
            query_index: Some(QueryIndexTx {
                generation: [7; 32],
                replace_specs: None,
                rows: vec![fake],
                publish_at: None,
            }),
            ..Tx::default()
        })
        .unwrap();
    assert!(!store.query_index_state().unwrap().unwrap().ready);
}
#[test]
fn statement_overflow_fallback_erases_stale_coverage_before_later_publication() {
    let (mut store, _, _, _, refs) = open(
        "query_index_statement_overflow",
        vec![row(1, "priority: 4"), row(2, "priority: 5")],
        &["priority"],
    );
    let changed_resource = "spec_version: \"0.3.0\"\n";
    let mut projected =
        project_record_query_index_row(&catalog(), &row(1, "priority: 4"), &refs, 8192).unwrap();
    // 64 distinct canonical type memberships maximize valid per-row derived
    // statements. This test isolates the aggregate statement fallback path.
    projected.types = (0..64).map(|i| format!("type{i}")).collect();
    let meta = (0..16_350)
        .map(|i| (format!("overflow_probe_{i}"), Some(vec![0])))
        .collect();
    store
        .commit(Tx {
            meta,
            resources_put: vec![("mdbase.yaml".into(), changed_resource.into())],
            query_index: Some(QueryIndexTx {
                generation: [8; 32],
                replace_specs: Some(query_index_fields(&refs, 8192).unwrap()),
                rows: vec![projected],
                publish_at: Some(Head::GENESIS),
            }),
            ..Tx::default()
        })
        .unwrap();
    assert_eq!(
        store.resource("mdbase.yaml").unwrap().as_deref(),
        Some(changed_resource)
    );
    assert!(
        !store.query_index_state().unwrap().unwrap().ready,
        "aggregate overflow must invalidate optional index only"
    );
    let other = row(2, "priority: 6");
    let p = project_record_query_index_row(&catalog(), &other, &refs, 8192).unwrap();
    store
        .commit(Tx {
            records_put: vec![other],
            query_index: Some(QueryIndexTx {
                generation: [7; 32],
                replace_specs: None,
                rows: vec![p],
                publish_at: Some(Head::GENESIS),
            }),
            ..Tx::default()
        })
        .unwrap();
    assert!(
        !store.query_index_state().unwrap().unwrap().ready,
        "unchanged stale projection cannot be republished after fallback"
    );
}
#[test]
fn coverage_publication_and_real_sql_failure_are_not_fake_ready_or_ack() {
    let (mut store, index, _, _, refs) = open(
        "query_index_coverage",
        vec![row(1, "priority: 4"), row(2, "priority: 5")],
        &["priority"],
    );
    let p =
        project_record_query_index_row(&catalog(), &row(1, "priority: 4"), &refs, 8192).unwrap();
    store
        .commit(Tx {
            query_index: Some(QueryIndexTx {
                generation: [8; 32],
                replace_specs: Some(query_index_fields(&refs, 8192).unwrap()),
                rows: vec![p],
                publish_at: Some(Head::GENESIS),
            }),
            ..Tx::default()
        })
        .unwrap();
    assert!(
        !store.query_index_state().unwrap().unwrap().ready,
        "a caller publication is not coverage proof"
    );
    index.borrow_mut().run(&Batch { mode:BatchMode::Transaction,stmts:vec![Stmt::new("CREATE TRIGGER stop_field BEFORE INSERT ON st_field BEGIN SELECT RAISE(ABORT,'injected field failure'); END",vec![])] }).unwrap();
    let r = row(1, "priority: 10");
    let p = project_record_query_index_row(&catalog(), &r, &refs, 8192).unwrap();
    assert!(
        store
            .commit(Tx {
                records_put: vec![r],
                query_index: Some(QueryIndexTx {
                    generation: [8; 32],
                    replace_specs: None,
                    rows: vec![p],
                    publish_at: None
                }),
                ..Tx::default()
            })
            .is_err()
    );
    assert!(
        store
            .record(&id(1))
            .unwrap()
            .unwrap()
            .doc
            .contains("priority: 4"),
        "real SQL error must roll back accompanying authoritative write"
    );
}

/// A local edit under a ready index verifies only the records it touches:
/// before, every commit re-proved coverage with whole-table counts and joins
/// (75 ms of an 85 ms edit at 3k notes, perf baseline 2026-10-08). Coverage
/// faults on touched records must still unpublish the index.
#[test]
fn incremental_publication_checks_touched_records_only() {
    let (mut store, index, _, _, refs) = open(
        "query_index_incremental",
        vec![
            row(1, "priority: 4"),
            row(2, "priority: 5"),
            row(3, "priority: 6"),
        ],
        &["priority"],
    );
    let full = || index.borrow().full_coverage_checks.get();
    let before = full();
    let publish =
        |store: &mut SqlStore<Trace>, put: Vec<RecordRow>, rows: Vec<RecordRow>, del: Vec<B16>| {
            let projected = rows
                .iter()
                .map(|r| project_record_query_index_row(&catalog(), r, &refs, 8192).unwrap())
                .collect();
            store
                .commit(Tx {
                    records_put: put,
                    records_del: del,
                    query_index: Some(QueryIndexTx {
                        generation: [7; 32],
                        replace_specs: None,
                        rows: projected,
                        publish_at: Some(Head::GENESIS),
                    }),
                    ..Tx::default()
                })
                .unwrap();
        };
    // An edit and a delete keep the index ready without a whole-table check.
    let edited = row(2, "priority: 9");
    publish(&mut store, vec![edited.clone()], vec![edited], vec![]);
    assert!(store.query_index_state().unwrap().unwrap().ready);
    publish(&mut store, vec![], vec![], vec![id(3)]);
    assert!(store.query_index_state().unwrap().unwrap().ready);
    assert_eq!(full(), before, "incremental commits scan only touched IDs");
    let mut req = request(&store, &refs);
    req.predicate = QueryPredicate::Compare {
        column: req.order[0].column.clone(),
        op: QueryCompare::Eq,
        value: atom(CoreValue::Int(9)),
    };
    assert_eq!(
        store.query_index_page(&req).unwrap().unwrap().total_matches,
        Some(1)
    );
    // A published projection for a record that is not live breaks coverage.
    publish(&mut store, vec![], vec![row(99, "priority: 8")], vec![]);
    assert!(
        !store.query_index_state().unwrap().unwrap().ready,
        "a non-live touched projection unpublishes"
    );
    // Once unpublished, the next publication proves coverage over everything.
    let again = row(1, "priority: 4");
    publish(&mut store, vec![again.clone()], vec![again], vec![]);
    assert_eq!(full(), before + 1);
    assert!(!store.query_index_state().unwrap().unwrap().ready);
}
