//! Real SQLite foundation adapter, NOT the shared runtime query executor.
//! The Core oracle owns query semantics and raw seeded/shrunk cases.
use super::*;
use mdbn_conformance::query_differential::{self as differential, AdapterOutcome, Case, Shape};
use mdbn_core::query::{self, FieldRef};
use mdbn_core::state::MemState;
use mdbn_store_file::testing::replica::{
    plan::QueryProjectionContext,
    store::{Head, RecordMeta, RecordRow, StoreError},
    store_query::{QueryBudget, QueryIndexRequest, QueryIndexTx},
};
use mdbn_store_file::{
    SqlStore,
    index::{IndexError, StmtResult},
    testing::{B16, Sem},
};

struct Trace {
    inner: SqliteIndex,
    payload_reads: Rc<Cell<usize>>,
    selections: Rc<Cell<usize>>,
}
impl IndexStorage for Trace {
    fn info(&self) -> mdbn_store_file::index::IndexInfo {
        self.inner.info()
    }
    fn reset(&mut self) -> Result<(), IndexError> {
        self.inner.reset()
    }
    fn run(&mut self, batch: &Batch) -> Result<Vec<StmtResult>, IndexError> {
        for stmt in &batch.stmts {
            if stmt.sql.contains("SELECT row FROM st_rec") {
                self.payload_reads.set(self.payload_reads.get() + 1);
            }
            if stmt.sql.contains("SELECT q.id,length(r.row)") {
                self.selections.set(self.selections.get() + 1);
            }
        }
        self.inner.run(batch)
    }
}
pub(super) struct Run {
    pub(super) outcome: AdapterOutcome,
    pub(super) selections: usize,
    pub(super) payload_reads: usize,
}
fn refuse(error: StoreError) -> AdapterOutcome {
    match error {
        StoreError::Full => AdapterOutcome::ResourceExhausted("indexed source/key budget".into()),
        other => panic!("unexpected backend error, never an unsupported/empty success: {other:?}"),
    }
}
pub(super) fn run_case(case: &Case) -> Run {
    let state = case.state().expect("valid exact fixture");
    let query = match case.query() {
        Ok(q) => q,
        Err(e) => {
            return Run {
                outcome: AdapterOutcome::QueryError(e),
                selections: 0,
                payload_reads: 0,
            };
        }
    };
    let plan = match query::compile(&query, &mdbn_core::state::StateView::catalog(&state)) {
        Ok(p) => p,
        Err(e) => {
            return Run {
                outcome: AdapterOutcome::QueryError(e),
                selections: 0,
                payload_reads: 0,
            };
        }
    };
    let profile = match query::profile::lower(&plan, &mdbn_core::state::StateView::catalog(&state))
    {
        Ok(p) => p,
        Err(e) => {
            return Run {
                outcome: AdapterOutcome::LowerDeclined(format!("{e:?}")),
                selections: 0,
                payload_reads: 0,
            };
        }
    };
    if !profile.diagnostics_exact || plan.requires_whole_metadata() {
        return Run {
            outcome: AdapterOutcome::LowerDeclined(
                "diagnostics/whole metadata need shared executor".into(),
            ),
            selections: 0,
            payload_reads: 0,
        };
    }
    let fields = vec![
        FieldRef::Effective(vec!["status".into()]),
        FieldRef::Effective(vec!["priority".into()]),
        FieldRef::Effective(vec!["project".into()]),
        FieldRef::Effective(vec!["context".into()]),
    ];
    let sem = mdbn_core::semantics::SEM;
    let context = QueryProjectionContext::capture(
        &case.resources,
        Sem {
            major: sem.major,
            minor: sem.minor,
        },
        &fields,
        8192,
    )
    .expect("trusted captured fixture projection");
    let request =
        match QueryIndexRequest::from_profile(&profile, &context, Head::GENESIS, 1000, 1 << 20) {
            Ok(r) => QueryIndexRequest {
                count_matches: true,
                ..r
            },
            Err(e) => {
                return Run {
                    outcome: refuse(e),
                    selections: 0,
                    payload_reads: 0,
                };
            }
        };
    static NEXT_SCRATCH: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let scratch_id = NEXT_SCRATCH.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let dir = scratch(&format!("query-differential-{scratch_id}"));
    let payload_reads = Rc::new(Cell::new(0));
    let selections = Rc::new(Cell::new(0));
    let db = Trace {
        inner: SqliteIndex::open(dir.join("state.db"), IndexDurability::Durable).unwrap(),
        payload_reads: payload_reads.clone(),
        selections: selections.clone(),
    };
    let mut store = SqlStore::open(Rc::new(RefCell::new(db))).unwrap();
    // Fixture construction is bounded test tooling, not runtime heap evidence.
    let rows = case
        .records
        .iter()
        .map(|r| RecordRow {
            id: B16(r.id.0),
            path: r.path.clone(),
            path_key: mdbn_core::paths::path_key(&r.path),
            doc: r.source.clone(),
            revision: revision(r.source.as_bytes()),
            modified_seq: 0,
            bucket: 0,
            meta: RecordMeta::default(),
        })
        .collect::<Vec<_>>();
    let projected = rows
        .iter()
        .map(|r| context.project_row(r).expect("Core projection"))
        .collect();
    store
        .commit(Tx {
            records_put: rows,
            query_index: Some(QueryIndexTx {
                generation: context.generation(),
                replace_specs: Some(context.fields().to_vec()),
                rows: projected,
                publish_at: Some(Head::GENESIS),
            }),
            ..Tx::default()
        })
        .unwrap();
    let selected = match store.query_index_page(&request) {
        Ok(Some(page)) => page,
        Ok(None) => panic!("eligible fixture index must be ready; decline is not SQL coverage"),
        Err(e) => {
            return Run {
                outcome: refuse(e),
                selections: selections.get(),
                payload_reads: payload_reads.get(),
            };
        }
    };
    assert_eq!(
        payload_reads.get(),
        0,
        "selection must not copy record payload"
    );
    assert!(
        !selected.has_more,
        "bounded fixture selects ALL matches, never a prefix"
    );
    // Independently compare SQL's complete order/count, before Core's final sort
    // could hide a backend order defect. No SQL-generated expected values.
    let mut unwindowed = query.clone();
    unwindowed.limit = None;
    unwindowed.offset = 0;
    let unwindowed_plan = query::compile(&unwindowed, context.catalog()).unwrap();
    let canonical = query::execute(&unwindowed_plan, &state, &case.env).unwrap();
    assert_eq!(
        selected.total_matches,
        Some(canonical.total_count),
        "seed {} whole count",
        case.seed
    );
    assert_eq!(
        selected
            .rows
            .iter()
            .map(|r| mdbn_core::ids::Uuid(r.id.0))
            .collect::<Vec<_>>(),
        canonical.ids,
        "seed {} SQL order",
        case.seed
    );
    let ids = selected.rows.iter().map(|r| r.id).collect::<Vec<_>>();
    let mut budget = QueryBudget::HOSTED;
    let hydrated = match store.hydrate_query_at(&ids, Head::GENESIS, &mut budget) {
        Ok(rows) => rows,
        Err(e) => {
            return Run {
                outcome: refuse(e),
                selections: selections.get(),
                payload_reads: payload_reads.get(),
            };
        }
    };
    let mut selected_state = MemState::new();
    for (path, source) in &case.resources {
        selected_state.insert_resource(path, source);
    }
    for row in &hydrated {
        selected_state.insert_record(mdbn_core::ids::Uuid(row.id.0), &row.path, &row.doc);
    }
    let outcome = match query::execute(&plan, &selected_state, &case.env) {
        Ok(page) => AdapterOutcome::Success(page),
        Err(error) => AdapterOutcome::QueryError(error),
    };
    Run {
        outcome,
        selections: selections.get(),
        payload_reads: payload_reads.get(),
    }
}
fn mismatch(case: &Case) -> bool {
    let expected = differential::oracle(case).unwrap();
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| run_case(case))) {
        Err(_) => true,
        Ok(run) => match run.outcome {
            AdapterOutcome::LowerDeclined(_) | AdapterOutcome::ResourceExhausted(_) => false,
            _ => !differential::equivalent(&expected, &run.outcome),
        },
    }
}
fn save_failure(case: &Case) -> PathBuf {
    let mut shrunk = case.clone();
    // Lazy Core candidates; only an actual mismatch may survive each step.
    for _ in 0..256 {
        let next = differential::shrink(&shrunk).find(mismatch);
        match next {
            Some(next) => shrunk = next,
            None => break,
        }
    }
    let dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join("query-differential-failures");
    fs::create_dir_all(&dir).unwrap();
    let digest = revision(case.query_yaml.as_bytes()).0[..8]
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>();
    let base = dir.join(format!("seed-{}-{digest}", case.seed));
    fs::write(base.with_extension("raw.json"), case.to_json().to_string()).unwrap();
    fs::write(
        base.with_extension("shrunk.json"),
        shrunk.to_json().to_string(),
    )
    .unwrap();
    base
}
fn assert_case(case: &Case) -> bool {
    let expected = differential::oracle(case).unwrap();
    let actual = match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| run_case(case))) {
        Ok(run) => run,
        Err(error) => {
            eprintln!(
                "Exact raw/shrunk failure saved at {}",
                save_failure(case).display()
            );
            std::panic::resume_unwind(error)
        }
    };
    match actual.outcome {
        AdapterOutcome::LowerDeclined(_) | AdapterOutcome::ResourceExhausted(_) => false,
        _ => {
            if !differential::equivalent(&expected, &actual.outcome) {
                panic!(
                    "seed {} raw case {}\nexpected {expected:?}\nactual {:?}",
                    case.seed,
                    save_failure(case).display(),
                    actual.outcome
                );
            }
            if matches!(actual.outcome, AdapterOutcome::Success(_)) {
                assert!(
                    actual.selections > 0,
                    "success must execute SQL, never vacuous oracle coverage"
                );
                true
            } else {
                false // Canonical errors are equivalent, but NOT SQL success coverage.
            }
        }
    }
}
#[test]
fn seeded_real_sqlite_matches_whole_core_oracle_and_keeps_declines_explicit() {
    let mut successes = [0; 6];
    let mut declines = [0; 6];
    for seed in 0..32 {
        for (i, shape) in [
            Shape::ScalarEquality,
            Shape::NumericRange,
            Shape::AndOr,
            Shape::OrderWindow,
            Shape::ExplicitPresence,
            Shape::LiteralSet,
        ]
        .into_iter()
        .enumerate()
        {
            let case = differential::generate(seed, shape, 24);
            let restored = Case::from_json(&case.to_json()).unwrap();
            assert_eq!(case.to_json(), restored.to_json());
            if assert_case(&restored) {
                successes[i] += 1;
            } else {
                declines[i] += 1;
            }
        }
    }
    assert!(
        successes[0] > 0 && successes[3] > 0,
        "existing equality/order subset must not decline every case"
    );
    assert!(
        successes[5] > 0,
        "IN over literals is lowered and must match the Core oracle on SQLite"
    );
    eprintln!("SQL successes per shape {successes:?}; explicit declines {declines:?}");
}
#[test]
fn canonical_compile_errors_match_without_sql_success_coverage() {
    let mut case = differential::generate(7, Shape::ScalarEquality, 12);
    case.query_yaml = "types: [Task]\nwhere: 'status =='\n".into();
    let expected = differential::oracle(&case).unwrap();
    let actual = run_case(&case);
    assert!(matches!(actual.outcome, AdapterOutcome::QueryError(_)));
    assert!(differential::equivalent(&expected, &actual.outcome));
    assert_eq!(actual.selections, 0);
    assert!(!assert_case(&case));
}
#[test]
fn exact_plaintext_limit_still_refuses_encoded_hydration_before_payload() {
    let case = differential::source_boundary(42, 1 << 20);
    let run = run_case(&case);
    assert!(matches!(run.outcome, AdapterOutcome::ResourceExhausted(_)));
    assert!(run.selections > 0);
    assert_eq!(
        run.payload_reads, 0,
        "exact plaintext cap is NOT encoded-row cap"
    );
}
