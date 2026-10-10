//! The shared indexed query driver over the real SQL store and SQLite: answers
//! must equal the per-record path, pending edits included, and the index must
//! be used (not silently declined). Stores live under `CARGO_TARGET_TMPDIR`; the
//! manual timing test measures wall time, hence the std fs/time allowances.
#![allow(clippy::disallowed_methods, clippy::disallowed_types)]

use std::cell::{Cell, RefCell};
use std::rc::Rc;

use mdbn_platform_native::SqliteIndex;
use mdbn_replica::api::{ClientApi, SessionAuth, SessionId};
use mdbn_replica::fake::{FakeLog, FakeLogService};
use mdbn_replica::log::{EndpointId, pump};
use mdbn_replica::replica::{DeviceSecrets, Host, Replica, ReplicaConfig, UtcOnly};
use mdbn_replica::seal::PlainSealer;
use mdbn_replica::testkit::{TEST_ROOT, TestControlPlane, signed_root};
use mdbn_replica::{Clock, CorePlanner};
use mdbn_store_file::SqlStore;
use mdbn_store_file::index::{
    Batch, IndexDurability, IndexError, IndexInfo, IndexStorage, Stmt, StmtResult,
};
use mdbn_wire::client::{HelloParams, Include, SubmitParams};
use mdbn_wire::common::{B16, Text, Value, Version};
use mdbn_wire::intent::{Create, Op, ResourcePut};

const COL: B16 = B16([7; 16]);
const TASK: &str = "---\nkind: mdbase.type\nname: task\nmatch: {path_glob: 'tasks/*.md'}\nschema:\n  dialect: json-schema-2020-12\n  value:\n    type: object\n    properties:\n      priority: {}\n      status: {type: string}\n---\n";

// Test-only interception of the ACTUAL generated selector, no reconstructed SQL.
struct ProfiledIndex {
    inner: SqliteIndex,
    explain: bool,
}
impl IndexStorage for ProfiledIndex {
    fn info(&self) -> IndexInfo {
        self.inner.info()
    }
    fn reset(&mut self) -> Result<(), IndexError> {
        self.inner.reset()
    }
    fn defer_sync(&mut self, on: bool) -> Result<bool, IndexError> {
        self.inner.defer_sync(on)
    }
    fn run(&mut self, batch: &Batch) -> Result<Vec<StmtResult>, IndexError> {
        if self.explain {
            for statement in &batch.stmts {
                if statement.sql.contains("FROM st_qrecord q JOIN st_rec r")
                    || statement.sql.contains("/* generic ordered seek */")
                {
                    let plan = self.inner.run(&Batch {
                        mode: mdbn_store_file::index::BatchMode::Autocommit,
                        stmts: vec![Stmt::new(
                            format!("EXPLAIN QUERY PLAN {}", statement.sql),
                            statement.params.clone(),
                        )],
                    })?;
                    println!(
                        "GENERIC_QUERY_SQL {}\nEXPLAIN_QUERY_PLAN {:?}",
                        statement.sql, plan
                    );
                }
            }
        }
        self.inner.run(batch)
    }
}
type Store = SqlStore<ProfiledIndex>;

struct TestClock(Rc<Cell<u64>>);
impl Clock for TestClock {
    fn now_ms(&self) -> u64 {
        self.0.get()
    }
}

struct Node {
    r: Replica<Store>,
    log: FakeLog,
    s: SessionId,
    clock: Rc<Cell<u64>>,
}

fn store(name: &str) -> Store {
    let dir = std::path::Path::new(env!("CARGO_TARGET_TMPDIR")).join(name);
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let index = SqliteIndex::open(dir.join("index.sqlite"), IndexDurability::Durable).unwrap();
    SqlStore::open(Rc::new(RefCell::new(ProfiledIndex {
        inner: index,
        explain: false,
    })))
    .unwrap()
}

fn open(svc: &FakeLogService, store: Store) -> Node {
    let devices: Vec<B16> = (101..=109u8).map(|d| B16([d; 16])).collect();
    if svc.head(&COL).0 == 0 {
        TestControlPlane::new(COL).bootstrap(svc, mdbn_wire::policy::CState::E2e, &devices);
    }
    let cfg = ReplicaConfig {
        collection: COL,
        replica_id: B16([1; 16]),
        device_id: B16([101; 16]),
        mode: mdbn_wire::client::SyncMode::Synced,
        log_endpoint: EndpointId(1),
        verify: true,
        runtime_version: "test".into(),
        trusted_roots: vec![TEST_ROOT, signed_root()],
        e2e: false,
        trusted_signers: devices,
        user_enabled_cloud_copy: false,
        chosen_state: None,
        expected_genesis: None,
        key_grants_only: false,
        policy_pins: None,
    };
    let clock = Rc::new(Cell::new(1_700_000_000_000));
    let host = Host {
        clock: Box::new(TestClock(clock.clone())),
        entropy: Box::new(mdbn_replica::crypto::TestEntropy::new(1)),
        zones: Box::new(UtcOnly),
    };
    let mut r = Replica::open(
        cfg,
        store,
        Box::new(CorePlanner),
        Box::new(PlainSealer::for_device(B16([101; 16]))),
        host,
        DeviceSecrets {
            sign_sk: [1; 32],
            kem_sk: [1; 32],
        },
    )
    .expect("open");
    // The native desktop host: its non-indexed queries keep the unbudgeted scan.
    r.set_query_execution_profile(mdbn_replica::QueryExecutionProfile::Desktop);
    let (s, _) = r
        .hello(
            SessionAuth::Host,
            HelloParams {
                versions: vec![Version { major: 1, minor: 0 }],
                client_name: "bench".into(),
                client_version: "0".into(),
                features: None,
                timezone: None,
            },
        )
        .expect("hello");
    Node {
        r,
        log: svc.client(B16([101; 16])),
        s,
        clock,
    }
}

fn id(n: u32) -> B16 {
    let mut b = [0u8; 16];
    b[..4].copy_from_slice(&n.to_be_bytes());
    // Spread IDs so ID order differs from creation order.
    b[4..8].copy_from_slice(&n.wrapping_mul(2_654_435_761).to_be_bytes());
    B16(b)
}

fn create(n: u32, path: &str, doc: String) -> Op {
    Op::Create(Create {
        id: id(n),
        path: Some(path.into()),
        type_name: None,
        frontmatter: None,
        body: None,
        document: Some(Text::Inline(doc)),
    })
}

fn submit(node: &mut Node, ops: Vec<Op>) {
    let receipts = node
        .r
        .submit(
            node.s,
            SubmitParams {
                ops,
                mutation_id: None,
                conflict_mode: None,
                timezone: None,
                allow_partial: None,
                mutation_ids: None,
                dry_run: None,
                include: None,
                wait: None,
            },
        )
        .expect("submit");
    for r in &receipts {
        assert!(r.problem.is_none(), "submit refused: {:?}", r.problem);
    }
}

impl Node {
    fn pump(&mut self) {
        for _ in 0..20 {
            pump(&mut self.r, &mut self.log, 100);
            self.r.tick();
        }
    }
}

fn task(n: u32) -> String {
    // Mixed kinds on purpose: a few text and missing priorities.
    let priority = match n % 17 {
        0 => "priority: high\n".to_string(),
        1 => String::new(),
        _ => format!("priority: {}\n", n % 7),
    };
    let status = if n.is_multiple_of(3) { "done" } else { "open" };
    format!("---\n{priority}status: {status}\n---\nTask {n}\n")
}

/// Seed `count` tasks in batches, confirmed through the log.
fn seed(node: &mut Node, count: u32) {
    seed_with(node, count, task);
}

fn seed_with(node: &mut Node, count: u32, document: fn(u32) -> String) {
    submit(
        node,
        vec![Op::ResourcePut(ResourcePut {
            path: "_types/task.md".into(),
            doc: Text::Inline(TASK.into()),
            base_revision: None,
            must_not_exist: None,
        })],
    );
    node.pump();
    let mut n = 1;
    while n <= count {
        let ops = (n..(n + 100).min(count + 1))
            .map(|i| create(i, &format!("tasks/t{i:05}.md"), document(i)))
            .collect();
        submit(node, ops);
        node.pump();
        n += 100;
    }
}

fn q(y: &[(&str, Value)]) -> Value {
    Value::Map(y.iter().map(|(k, v)| (k.to_string(), v.clone())).collect())
}

fn order(field: &str, dir: &str) -> Value {
    Value::List(vec![Value::Map(vec![
        ("field".into(), Value::Text(field.into())),
        ("direction".into(), Value::Text(dir.into())),
    ])])
}

/// The indexed answer for `query`, and the per-record answer for the same query
/// (no limit declines the index), cut to the same window.
fn both(
    node: &mut Node,
    query: &[(&str, Value)],
    offset: usize,
    limit: usize,
) -> (Vec<B16>, Vec<B16>) {
    let before = node.r.query_stats();
    let mut windowed: Vec<(&str, Value)> = query.to_vec();
    windowed.push(("limit", Value::Int(limit as i64)));
    windowed.push(("offset", Value::Int(offset as i64)));
    let indexed = node
        .r
        .query(node.s, q(&windowed), none())
        .expect("indexed query");
    assert_eq!(
        node.r.query_stats().indexed,
        before.indexed + 1,
        "the index answered {query:?}: {:?}",
        node.r.query_stats().last_decline
    );
    let full = node.r.query(node.s, q(query), none()).expect("full query");
    assert_eq!(node.r.query_stats().declined, before.declined + 1);
    assert!(
        offset >= full.records.len() || !indexed.records.is_empty(),
        "a non-empty window: {query:?}"
    );
    let a = indexed.records.iter().map(|r| r.id).collect();
    let b = full
        .records
        .iter()
        .skip(offset)
        .take(limit)
        .map(|r| r.id)
        .collect();
    (a, b)
}

#[test]
fn indexed_answers_equal_the_per_record_path_with_pending_edits() {
    let svc = FakeLogService::new();
    let mut node = open(&svc, store("indexed_query_equal"));
    seed(&mut node, 600);

    let types = ("types", Value::List(vec![Value::Text("task".into())]));
    let cases: Vec<Vec<(&str, Value)>> = vec![
        vec![types.clone(), ("order_by", order("priority", "desc"))],
        vec![
            types.clone(),
            ("where", Value::Text("priority >= 3".into())),
            ("order_by", order("priority", "asc")),
        ],
        vec![
            (
                "where",
                Value::Text("status == \"open\" && priority < 4".into()),
            ),
            ("order_by", order("file.path", "desc")),
        ],
        vec![types.clone()],
        // Negation and `in` (TaskNotes' open tasks), answered from the index.
        vec![
            types.clone(),
            ("where", Value::Text("status != \"done\"".into())),
            ("order_by", order("priority", "asc")),
        ],
        vec![
            (
                "where",
                Value::Text("!(status == \"done\") && priority != 4".into()),
            ),
            ("order_by", order("priority", "desc")),
        ],
        vec![
            types.clone(),
            (
                "where",
                Value::Text("status in [\"open\", \"waiting\"]".into()),
            ),
            ("order_by", order("file.path", "asc")),
        ],
        // Path order with a filter on another field (SQLite once read the
        // constant path kind in ORDER BY as a column index).
        vec![
            types.clone(),
            (
                "where",
                Value::Text("status == \"open\" || priority == 2".into()),
            ),
            ("order_by", order("file.path", "asc")),
        ],
    ];
    for case in &cases {
        for (offset, limit) in [(0, 50), (37, 50), (590, 50)] {
            let (a, b) = both(&mut node, case, offset, limit);
            assert_eq!(a, b, "{case:?} offset {offset}");
        }
    }

    // Pending (unconfirmed) edits: a new high-priority task and a re-prioritised one.
    submit(
        &mut node,
        vec![create(
            9001,
            "tasks/pending.md",
            task(9001).replace("Task", "Pending").replacen(
                &format!("priority: {}", 9001 % 7),
                "priority: 6",
                1,
            ),
        )],
    );
    for case in &cases {
        let (a, b) = both(&mut node, case, 0, 50);
        assert_eq!(a, b, "pending: {case:?}");
    }
    let sixes = vec![
        types.clone(),
        ("where", Value::Text("priority == 6".into())),
        ("order_by", order("priority", "desc")),
    ];
    let (a, b) = both(&mut node, &sixes, 0, 200);
    assert_eq!(a, b);
    assert!(a.contains(&id(9001)), "the pending task is in the answer");
    node.pump();
    for case in &cases {
        let (a, b) = both(&mut node, case, 0, 50);
        assert_eq!(a, b, "confirmed: {case:?}");
    }
}

#[test]
fn reopen_backfills_and_deep_windows_are_paged_by_the_index() {
    let svc = FakeLogService::new();
    let mut node = open(&svc, store("indexed_query_reopen"));
    seed(&mut node, 300);
    let store = node.r.into_store();
    let mut node = open(&svc, store);
    node.pump();
    let types = ("types", Value::List(vec![Value::Text("task".into())]));
    let (a, b) = both(
        &mut node,
        &[types.clone(), ("order_by", order("priority", "desc"))],
        0,
        50,
    );
    assert_eq!(a, b);
    // A window beyond the 1000-record selection cap is paged by the store
    // (offset skipped by key), not declined: equal to the per-record answer.
    let (a, b) = both(&mut node, &[types], 250, 50);
    assert_eq!(a, b);
}

#[test]
fn budgeted_fallback_refuses_explicitly_and_unbudgeted_answers() {
    let svc = FakeLogService::new();
    let mut node = open(&svc, store("indexed_query_fallback"));
    seed(&mut node, 1200);
    // No limit: the index declines; the fallback scans every task.
    let all = q(&[("types", Value::List(vec![Value::Text("task".into())]))]);
    assert_eq!(
        node.r.query_execution_profile(),
        mdbn_replica::QueryExecutionProfile::Desktop
    );
    let full = node.r.query(node.s, all.clone(), none()).unwrap();
    assert_eq!(full.records.len(), 1200);
    node.r
        .set_query_execution_profile(mdbn_replica::QueryExecutionProfile::MemoryConstrained);
    let e = node.r.query(node.s, all, none()).unwrap_err();
    assert_eq!(e.code(), Some(mdbn_replica::ErrorCode::TooLarge));
    assert_eq!(e.problem().reason.as_deref(), Some("query_budget_exceeded"));
    // An indexed window still answers under the budgeted profile.
    let (a, b) = {
        let windowed = q(&[
            ("types", Value::List(vec![Value::Text("task".into())])),
            ("order_by", order("priority", "desc")),
            ("limit", Value::Int(50)),
        ]);
        let r = node.r.query(node.s, windowed, none()).unwrap();
        (r.records.len(), node.r.query_stats().indexed)
    };
    assert_eq!(a, 50);
    assert!(b >= 1);
}

/// Release-only timing: `rcargo test --release -p mdbn-bench --test indexed_query -- --ignored --nocapture`.
#[test]
#[ignore = "manual release timing"]
fn indexed_top50_over_10k_timing() {
    let svc = FakeLogService::new();
    let mut node = open(&svc, store("indexed_query_10k"));
    seed(&mut node, 10_000);
    let types = ("types", Value::List(vec![Value::Text("task".into())]));
    let query = q(&[
        types,
        ("where", Value::Text("priority >= 2".into())),
        ("order_by", order("priority", "desc")),
        ("limit", Value::Int(50)),
    ]);
    let mut samples = Vec::new();
    for _ in 0..30 {
        let t = std::time::Instant::now();
        let r = node.r.query(node.s, query.clone(), none()).unwrap();
        samples.push(t.elapsed());
        assert_eq!(r.records.len(), 50);
    }
    samples.sort();
    let stats = node.r.query_stats();
    assert_eq!(stats.indexed, 30);

    // Stage split: the store's selection alone, and the per-record path.
    use mdbn_core::query::FieldRef;
    use mdbn_core::query::indexed::{SortAtom, TemporalHint};
    use mdbn_replica::Store as _;
    use mdbn_replica::store_query::*;
    let store = node.r.store();
    let state = store.query_index_state().unwrap().unwrap();
    assert!(state.ready);
    let field = mdbn_replica::plan::query_index_fields(
        &[FieldRef::Effective(vec!["priority".into()])],
        8192,
    )
    .unwrap()
    .remove(0);
    let two = SortAtom::from_value(
        Some(&mdbn_core::value::Value::Int(2)),
        TemporalHint::None,
        8192,
    )
    .unwrap();
    let request = QueryIndexRequest {
        generation: state.generation,
        head: state.head,
        predicate: QueryPredicate::And(vec![
            QueryPredicate::Types(vec!["task".into()]),
            QueryPredicate::Compare {
                column: QueryColumn::Field(field.clone()),
                op: QueryCompare::Ge,
                value: QueryAtom {
                    kind: two.kind() as u8,
                    key: two.key().to_vec(),
                },
            },
        ]),
        order: vec![QueryOrder {
            column: QueryColumn::Field(field),
            descending: true,
        }],
        after: None,
        offset: 0,
        limit: 50,
        max_key_bytes: 1 << 20,
        count_matches: false,
    };
    let mut select = Vec::new();
    let mut hydrate = Vec::new();
    for _ in 0..30 {
        let t = std::time::Instant::now();
        let page = store.query_index_page(&request).unwrap().unwrap();
        select.push(t.elapsed());
        let ids: Vec<_> = page.rows.iter().map(|r| r.id).collect();
        let t = std::time::Instant::now();
        let mut budget = QueryBudget::new(1000, 1 << 20);
        store
            .hydrate_query_at(&ids, state.head, &mut budget)
            .unwrap();
        hydrate.push(t.elapsed());
    }
    select.sort();
    hydrate.sort();
    let legacy_query = q(&[
        ("types", Value::List(vec![Value::Text("task".into())])),
        ("where", Value::Text("priority >= 2".into())),
        ("order_by", order("priority", "desc")),
        ("limit", Value::Int(50)),
        ("offset", Value::Int(960)),
    ]);
    let t = std::time::Instant::now();
    node.r.query(node.s, legacy_query, none()).unwrap();
    let legacy = t.elapsed();
    println!(
        "store select p50 {:?}, hydrate(50) p50 {:?}, per-record path (offset 960) {:?}",
        select[15], hydrate[15], legacy
    );
    println!(
        "indexed top-50 over 10k: p50 {:?} p90 {:?} max {:?}",
        samples[15], samples[27], samples[29]
    );
}

fn none() -> Include {
    Include {
        effective: None,
        body: None,
        document: None,
        diagnostics: None,
    }
}

/// A memory-constrained host (WASM app, hosted) answers TaskNotes' open-tasks
/// shape over more records than its per-record budget from the index: cost by
/// matched rows, never a refusal of the whole query.
#[test]
fn constrained_host_answers_negated_filters_from_the_index() {
    let svc = FakeLogService::new();
    let mut node = open(&svc, store("indexed_query_constrained"));
    node.r
        .set_query_execution_profile(mdbn_replica::QueryExecutionProfile::MemoryConstrained);
    seed(&mut node, 3000);
    let types = ("types", Value::List(vec![Value::Text("task".into())]));
    let open_tasks = vec![
        types.clone(),
        ("where", Value::Text("status != \"done\"".into())),
        ("order_by", order("priority", "asc")),
        ("limit", Value::Int(100)),
    ];
    let before = node.r.query_stats();
    let page = node
        .r
        .query(node.s, q(&open_tasks), none())
        .expect("answered, not refused");
    assert_eq!(page.records.len(), 100);
    assert_eq!(node.r.query_stats().indexed, before.indexed + 1);
    // The same query without the index's help (a body search) still refuses
    // explicitly on this host: the budget stands.
    let scan = vec![
        types,
        ("where", Value::Text("file.body.contains(\"Task\")".into())),
        ("limit", Value::Int(100)),
    ];
    let err = node.r.query(node.s, q(&scan), none()).unwrap_err();
    assert_eq!(err.problem().code, "too_large");
}

/// A memory-constrained host streams every match of TaskNotes' open-tasks query
/// in bounded pages from the index (offset paging, has_more), never refusing the
/// whole query; each page stays within the per-request budget.
fn stream_open_tasks(n: u32) {
    let svc = FakeLogService::new();
    let mut node = open(&svc, store(&format!("indexed_query_stream_{n}")));
    node.r
        .set_query_execution_profile(mdbn_replica::QueryExecutionProfile::MemoryConstrained);
    seed(&mut node, n);
    let expected = (1..=n).filter(|i| !i.is_multiple_of(3)).count();
    let mut seen = std::collections::BTreeSet::new();
    let mut offset = 0i64;
    let page_at = |node: &mut Node, offset: i64| {
        node.r.query(
            node.s,
            q(&[
                ("types", Value::List(vec![Value::Text("task".into())])),
                ("where", Value::Text("status != \"done\"".into())),
                ("order_by", order("priority", "asc")),
                ("limit", Value::Int(500)),
                ("offset", Value::Int(offset)),
            ]),
            none(),
        )
    };
    loop {
        if offset > MAX_CONSTRAINED_OFFSET {
            // Deep offsets cost index work per page; a constrained host refuses
            // them explicitly until keyset continuation (bounded offset paging).
            let err = page_at(&mut node, offset).unwrap_err();
            assert_eq!(err.problem().code, "too_large");
            assert_eq!(seen.len() as i64, offset);
            return;
        }
        let before = node.r.query_stats();
        let page = page_at(&mut node, offset).expect("a page, never a refusal");
        assert_eq!(node.r.query_stats().indexed, before.indexed + 1);
        assert!(page.records.len() <= 500);
        for r in &page.records {
            assert!(seen.insert(r.id), "no duplicate across pages");
        }
        offset += page.records.len() as i64;
        if page.has_more != Some(true) {
            break;
        }
    }
    assert_eq!(seen.len(), expected);
}

/// `MAX_CONSTRAINED_OFFSET` in the query driver.
const MAX_CONSTRAINED_OFFSET: i64 = 10_000;

/// A long conjunction is one flat AND, answered from the index like a short one
/// (flat conjunctions: 17+ `&&` clauses used to exceed the nesting bound and fail).
#[test]
fn long_conjunctions_are_answered_from_the_index() {
    let svc = FakeLogService::new();
    let mut node = open(&svc, store("indexed_query_long_and"));
    node.r
        .set_query_execution_profile(mdbn_replica::QueryExecutionProfile::MemoryConstrained);
    seed(&mut node, 300);
    let mut clauses = vec!["status != \"done\"".to_string()];
    clauses.extend((0..24).map(|i| format!("priority != {}", 100 + i)));
    for (connective, n) in [(" && ", 25), (" || ", 25)] {
        let query = [
            ("types", Value::List(vec![Value::Text("task".into())])),
            ("where", Value::Text(clauses[..n].join(connective))),
            ("order_by", order("priority", "asc")),
        ];
        let (indexed, full) = both(&mut node, &query, 0, 100);
        assert_eq!(indexed, full, "{connective}");
        assert!(!indexed.is_empty());
    }
}

#[test]
fn constrained_host_streams_open_tasks_at_10k() {
    stream_open_tasks(10_000);
}

#[test]
#[ignore = "manual: 50k records (run with --release --ignored)"]
fn constrained_host_streams_open_tasks_at_50k() {
    stream_open_tasks(50_000);
}

fn with_cursor(query: &Value, cursor: &str) -> Value {
    let Value::Map(fields) = query else {
        panic!("map query");
    };
    let mut fields = fields.clone();
    fields.retain(|(key, _)| key != "cursor");
    fields.push(("cursor".into(), Value::Text(cursor.into())));
    Value::Map(fields)
}

#[test]
fn query_keysets_equal_core_order_and_pay_initial_offset_only_once() {
    let svc = FakeLogService::new();
    let mut node = open(&svc, store("query_keysets_oracle"));
    seed(&mut node, 1500);
    let compound = |a: &str, b: &str| {
        let Value::List(mut terms) = order("priority", a) else {
            unreachable!()
        };
        let Value::List(second) = order("file.path", b) else {
            unreachable!()
        };
        terms.extend(second);
        Value::List(terms)
    };
    for (label, ordering) in [
        ("priority/asc", order("priority", "asc")),
        ("priority/desc", order("priority", "desc")),
        ("path/desc", order("file.path", "desc")),
        ("priorityasc/pathdesc", compound("asc", "desc")),
        ("prioritydesc/pathasc", compound("desc", "asc")),
        ("prioritydesc/pathdesc", compound("desc", "desc")),
    ] {
        let base = vec![
            ("types", Value::List(vec![Value::Text("task".into())])),
            ("where", Value::Text("status != \"done\"".into())),
            ("order_by", ordering),
        ];
        let full = node.r.query(node.s, q(&base), none()).unwrap();
        let expected: Vec<_> = full.records.iter().skip(37).map(|r| r.id).collect();
        let mut paged = base;
        paged.extend([("offset", Value::Int(37)), ("limit", Value::Int(113))]);
        let original = q(&paged);
        let mut query = original.clone();
        let mut found = Vec::new();
        let mut as_of = None;
        loop {
            let page = node.r.query(node.s, query, none()).unwrap();
            assert!(page.records.len() <= 113);
            assert_eq!(*as_of.get_or_insert(page.as_of), page.as_of);
            found.extend(page.records.iter().map(|r| r.id));
            match page.cursor {
                Some(cursor) => {
                    assert_eq!(page.has_more, Some(true));
                    query = with_cursor(&original, &cursor);
                }
                None => {
                    assert_eq!(page.has_more, Some(false));
                    break;
                }
            }
        }
        assert_eq!(
            found, expected,
            "{label}: ties/null/mixed kinds/full multi-term exclusive frontier"
        );
    }
}

#[test]
fn query_keysets_are_repeatable_bounded_session_bound_and_explicitly_stale() {
    let svc = FakeLogService::new();
    let mut node = open(&svc, store("query_keysets_fences"));
    seed(&mut node, 90);
    let original = q(&[
        ("order_by", order("priority", "desc")),
        ("limit", Value::Int(7)),
    ]);
    let first = node.r.query(node.s, original.clone(), none()).unwrap();
    let cursor = first.cursor.unwrap();
    let resumed = with_cursor(&original, &cursor);
    let a = node.r.query(node.s, resumed.clone(), none()).unwrap();
    node.clock.set(node.clock.get() + 10);
    let b = node.r.query(node.s, resumed.clone(), none()).unwrap();
    assert_eq!(
        a.records.iter().map(|r| r.id).collect::<Vec<_>>(),
        b.records.iter().map(|r| r.id).collect::<Vec<_>>()
    );
    let mut changed = none();
    changed.body = Some(true);
    assert_eq!(
        node.r
            .query(node.s, resumed.clone(), changed)
            .unwrap_err()
            .problem()
            .reason
            .as_deref(),
        Some("invalid_query_cursor")
    );
    assert_eq!(
        node.r
            .query(node.s, with_cursor(&original, "q1.bad"), none())
            .unwrap_err()
            .problem()
            .reason
            .as_deref(),
        Some("invalid_query_cursor")
    );
    assert!(node.r.subscribe(node.s, resumed.clone(), none()).is_err());
    let (other, _) = node
        .r
        .hello(
            SessionAuth::Host,
            HelloParams {
                versions: vec![Version { major: 1, minor: 0 }],
                client_name: "other".into(),
                client_version: "0".into(),
                features: None,
                timezone: None,
            },
        )
        .unwrap();
    assert_eq!(
        node.r
            .query(other, resumed.clone(), none())
            .unwrap_err()
            .problem()
            .reason
            .as_deref(),
        Some("invalid_query_cursor")
    );
    for _ in 0..16 {
        node.r.query(other, original.clone(), none()).unwrap();
    }
    assert!(node.r.query(node.s, resumed.clone(), none()).is_ok()); // OTHER session does not evict ours.
    for _ in 0..16 {
        node.r.query(node.s, original.clone(), none()).unwrap();
    }
    assert_eq!(
        node.r
            .query(node.s, resumed.clone(), none())
            .unwrap_err()
            .problem()
            .reason
            .as_deref(),
        Some("cursor_expired")
    );
    let first = node.r.query(node.s, original.clone(), none()).unwrap();
    let resumed = with_cursor(&original, &first.cursor.unwrap());
    node.clock.set(node.clock.get() + 300_000);
    assert_eq!(
        node.r
            .query(node.s, resumed, none())
            .unwrap_err()
            .problem()
            .reason
            .as_deref(),
        Some("cursor_expired")
    );
    let first = node.r.query(node.s, original.clone(), none()).unwrap();
    let resumed = with_cursor(&original, &first.cursor.unwrap());
    submit(&mut node, vec![create(9999, "tasks/new.md", task(9999))]);
    assert_eq!(
        node.r
            .query(node.s, resumed.clone(), none())
            .unwrap_err()
            .problem()
            .reason
            .as_deref(),
        Some("cursor_stale")
    );
    node.pump();
    assert_eq!(
        node.r
            .query(node.s, resumed.clone(), none())
            .unwrap_err()
            .problem()
            .reason
            .as_deref(),
        Some("cursor_stale")
    );
    node.r.close(node.s);
    assert_eq!(
        node.r
            .query(node.s, resumed, none())
            .unwrap_err()
            .problem()
            .code,
        "unauthenticated"
    );
}

#[test]
#[ignore = "manual: profile actual frame RPC first/mid cursor page over50k"]
fn query_keysets_profile_midpage_50k() {
    use mdbn_replica::frames::Frames;
    use mdbn_wire::client::{ClientFrame, ClientRequest, QueryResult};
    use mdbn_wire::{Cbor, Wire};
    use std::time::{Duration, Instant};
    fn request(id: u64, method: &str, params: Cbor) -> Vec<u8> {
        mdbn_wire::cbor::encode(
            &ClientFrame::Request(ClientRequest {
                id,
                method: method.into(),
                params,
            })
            .to_cbor(),
        )
        .unwrap()
    }
    fn rpc(frames: &mut Frames, node: &mut Node, query: &Value) -> (QueryResult, Duration) {
        let start = Instant::now();
        let input = request(
            2,
            "query",
            Cbor::Map(vec![
                (Cbor::Uint(0), query.to_cbor()),
                (Cbor::Uint(1), none().to_cbor()),
            ]),
        );
        frames.on_frame(&mut node.r, node.s, &input);
        let mut reply = None;
        for (_, bytes) in frames.take_outgoing() {
            if let ClientFrame::Response(response) =
                ClientFrame::from_cbor(&mdbn_wire::cbor::decode(&bytes).unwrap()).unwrap()
            {
                assert!(response.problem.is_none(), "{:?}", response.problem);
                reply = Some(QueryResult::from_cbor(&response.result.unwrap()).unwrap());
            }
        }
        (reply.unwrap(), start.elapsed())
    }
    fn profile(frames: &mut Frames, node: &mut Node, query: &Value, label: &str) -> QueryResult {
        let events = Rc::new(RefCell::new(Vec::new()));
        let capture = events.clone();
        node.r.set_query_trace(Some(Box::new(move |phase| {
            capture.borrow_mut().push((phase, Instant::now()))
        })));
        let (page, total) = rpc(frames, node, query);
        node.r.set_query_trace(None);
        let events = events.borrow();
        let delta = |a: &str, b: &str| {
            let start = events.iter().find(|(label, _)| *label == a).unwrap().1;
            events
                .iter()
                .find(|(label, _)| *label == b)
                .unwrap()
                .1
                .duration_since(start)
        };
        let seek = delta("seek_start", "seek_end");
        let hydration = delta("hydrate_start", "hydrate_end");
        let projection = delta("project_start", "project_end");
        let before = delta("request_start", "capture_before");
        let after = delta("project_end", "check_after");
        let inner = delta("request_start", "request_end");
        let prepare = inner.saturating_sub(seek + hydration + projection + before + after);
        // Residual includes request encoding/decode, outer READ dispatch, result
        // CBOR construction/encode, response decode; NO network/Noise/UI claim.
        let rpc_codec = total.saturating_sub(inner);
        let encode_start = Instant::now();
        let encoded = mdbn_wire::cbor::encode(
            &ClientFrame::Response(mdbn_wire::client::ClientResponse {
                id: 2,
                result: Some(page.to_cbor()),
                problem: None,
            })
            .to_cbor(),
        )
        .unwrap();
        let encode_sample = encode_start.elapsed();
        println!(
            "CURSOR_PAGE_PROFILE {label} rows={} total_us={} seek_us={} hydrate_source_decode_us={} parse_project_us={} read_current_before_us={} read_current_after_us={} prepare_registry_us={} rpc_codec_us={} encode_isolated_sample_us={} response_bytes={} transport=inprocessFrames/no-network",
            page.records.len(),
            total.as_micros(),
            seek.as_micros(),
            hydration.as_micros(),
            projection.as_micros(),
            before.as_micros(),
            after.as_micros(),
            prepare.as_micros(),
            rpc_codec.as_micros(),
            encode_sample.as_micros(),
            encoded.len()
        );
        page
    }
    let svc = FakeLogService::new();
    let mut node = open(&svc, store("query_keysets_profile_50k"));
    seed_with(&mut node, 50_000, all_open);
    node.r
        .set_query_execution_profile(mdbn_replica::QueryExecutionProfile::MemoryConstrained);
    let mut frames = Frames::new();
    let hello = HelloParams {
        versions: vec![Version { major: 1, minor: 0 }],
        client_name: "profile".into(),
        client_version: "0".into(),
        features: None,
        timezone: None,
    };
    node.s = frames
        .hello(
            &mut node.r,
            SessionAuth::Host,
            &request(1, "hello", hello.to_cbor()),
        )
        .session
        .unwrap();
    let original = q(&[
        ("types", Value::List(vec![Value::Text("task".into())])),
        ("where", Value::Text("status != \"done\"".into())),
        ("order_by", order("priority", "asc")),
        ("limit", Value::Int(200)),
    ]);
    node.r.store().index().borrow_mut().explain = true;
    let first = profile(&mut frames, &mut node, &original, "first");
    node.r.store().index().borrow_mut().explain = false;
    let mut cursor = first.cursor.unwrap();
    for _ in 1..125 {
        let page = node
            .r
            .query(node.s, with_cursor(&original, &cursor), none())
            .unwrap();
        cursor = page.cursor.unwrap();
    }
    node.r.store().index().borrow_mut().explain = true;
    let page = profile(
        &mut frames,
        &mut node,
        &with_cursor(&original, &cursor),
        "mid25000",
    );
    node.r.store().index().borrow_mut().explain = false;
    assert_eq!(page.records.len(), 200);
    // Repeat the SAME retained position: no silent restart/prefix offset.
    profile(
        &mut frames,
        &mut node,
        &with_cursor(&original, &cursor),
        "mid25000repeat",
    );
}

#[test]
fn query_keysets_source_budget_is_per_published_page_and_never_silently_truncates() {
    fn large(n: u32) -> String {
        format!(
            "---\npriority: {n}\nstatus: open\n---\n{}",
            "x".repeat(2200)
        )
    }
    let service = FakeLogService::new();
    let mut node = open(&service, store("query_keysets_bytes"));
    seed_with(&mut node, 600, large);
    use mdbn_replica::store::Store as _;
    assert_eq!(
        node.r.store().record_count().unwrap(),
        600,
        "records confirmed, not refused fixture writes"
    );
    let all = q(&[
        ("order_by", order("priority", "asc")),
        ("limit", Value::Int(600)),
    ]);
    let err = node.r.query(node.s, all, none()).unwrap_err();
    assert_eq!(err.problem().code, "too_large");
    assert_eq!(
        err.problem().reason.as_deref(),
        Some("query_budget_exceeded")
    );
    let original = q(&[
        ("order_by", order("priority", "asc")),
        ("limit", Value::Int(300)),
    ]);
    let first = node.r.query(node.s, original.clone(), none()).unwrap();
    assert_eq!(first.records.len(), 300);
    let second = node
        .r
        .query(
            node.s,
            with_cursor(&original, &first.cursor.unwrap()),
            none(),
        )
        .unwrap();
    assert_eq!(second.records.len(), 300);
    assert!(second.cursor.is_none());
    assert_eq!(second.has_more, Some(false));
    assert_ne!(first.records[0].id, second.records[0].id);
}

#[test]
fn query_keysets_recheck_readiness_after_hydration_and_refuse_the_whole_page() {
    let svc = FakeLogService::new();
    let mut node = open(&svc, store("query_keysets_publication_fence"));
    seed(&mut node, 60);
    let original = q(&[
        ("order_by", order("priority", "asc")),
        ("limit", Value::Int(7)),
    ]);
    let first = node.r.query(node.s, original.clone(), none()).unwrap();
    let resumed = with_cursor(&original, &first.cursor.unwrap());
    let index = node.r.store().index();
    let fired = Rc::new(Cell::new(false));
    let observed = fired.clone();
    node.r.set_query_trace(Some(Box::new(move |phase| {
        if phase == "hydrate_end" {
            observed.set(true);
            index
                .borrow_mut()
                .run(&Batch {
                    mode: mdbn_store_file::index::BatchMode::Autocommit,
                    stmts: vec![Stmt::new(
                        "UPDATE st_qstate SET ready=0 WHERE slot=0",
                        vec![],
                    )],
                })
                .unwrap();
        }
    })));
    let error = node.r.query(node.s, resumed, none()).unwrap_err();
    assert!(
        fired.get(),
        "fault occurs only after actual source hydration"
    );
    assert_eq!(error.problem().reason.as_deref(), Some("cursor_stale"));
    node.r.set_query_trace(None);
}

fn all_open(n: u32) -> String {
    task(n).replace("status: done", "status: open")
}

fn browse_keysets(node: &mut Node, count: usize, size: i64) -> Vec<B16> {
    let original = q(&[
        ("types", Value::List(vec![Value::Text("task".into())])),
        ("where", Value::Text("status != \"done\"".into())),
        ("order_by", order("priority", "asc")),
        ("limit", Value::Int(size)),
    ]);
    let mut query = original.clone();
    let mut found = Vec::new();
    loop {
        let page = node.r.query(node.s, query, none()).unwrap();
        assert!(page.records.len() <= size as usize);
        found.extend(page.records.iter().map(|r| r.id));
        if let Some(cursor) = page.cursor {
            query = with_cursor(&original, &cursor);
        } else {
            assert_eq!(page.has_more, Some(false));
            break;
        }
    }
    assert_eq!(found.len(), count);
    assert_eq!(
        found
            .iter()
            .copied()
            .collect::<std::collections::BTreeSet<_>>()
            .len(),
        count
    );
    found
}

#[test]
fn query_keysets_browse_past_constrained_offset_guard_without_raising_caps() {
    let svc = FakeLogService::new();
    let mut node = open(&svc, store("query_keysets_deep"));
    seed_with(&mut node, 12_000, all_open);
    node.r
        .set_query_execution_profile(mdbn_replica::QueryExecutionProfile::MemoryConstrained);
    browse_keysets(&mut node, 12_000, 200);
    let err = node
        .r
        .query(
            node.s,
            q(&[("limit", Value::Int(200)), ("offset", Value::Int(10_001))]),
            none(),
        )
        .unwrap_err();
    assert_eq!(err.problem().code, "too_large"); // Old offset guard still applies.
}

#[test]
#[ignore = "manual: release timing, ALL 50k open tasks, cursor vs offset same SQLite"]
fn query_keysets_benchmark_all_50k_open_tasks() {
    let svc = FakeLogService::new();
    let mut node = open(&svc, store("query_keysets_benchmark_50k"));
    seed_with(&mut node, 50_000, all_open);
    // Compare COMPLETE ordered ID sequences and the same 200-row published-page
    // size. Desktop baseline permits today's deep offset; the cursor uses the
    // constrained profile with unchanged1000-record/1MiB per-RPC caps.
    let start = std::time::Instant::now();
    let mut offset_ids = Vec::new();
    for offset in (0..50_000).step_by(200) {
        let page = node
            .r
            .query(
                node.s,
                q(&[
                    ("types", Value::List(vec![Value::Text("task".into())])),
                    ("where", Value::Text("status != \"done\"".into())),
                    ("order_by", order("priority", "asc")),
                    ("limit", Value::Int(200)),
                    ("offset", Value::Int(offset)),
                ]),
                none(),
            )
            .unwrap();
        assert_eq!(page.records.len(), 200);
        offset_ids.extend(page.records.iter().map(|r| r.id));
    }
    let offset = start.elapsed();
    node.r
        .set_query_execution_profile(mdbn_replica::QueryExecutionProfile::MemoryConstrained);
    let start = std::time::Instant::now();
    let cursor_ids = browse_keysets(&mut node, 50_000, 200);
    let cursor = start.elapsed();
    assert_eq!(cursor_ids, offset_ids);
    println!(
        "ALL50000OPEN_TASKS page200 offset_ms={} cursor_ms={} speedup={:.3}x profile=SQLite/release historical_offset31s_not_same_machine",
        offset.as_millis(),
        cursor.as_millis(),
        offset.as_secs_f64() / cursor.as_secs_f64()
    );
}
