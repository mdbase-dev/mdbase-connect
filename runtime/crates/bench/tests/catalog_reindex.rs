//! A device replica's catalog change over the real SQL store and SQLite: the
//! record-meta pass and the query-index rebuild that follow a catalog-changing
//! entry a catching-up device applies. Stores live under `CARGO_TARGET_TMPDIR`,
//! hence the std fs allowances.
//!
//! Release-only timing (#1648):
//! `rcargo test --release -p mdbn-bench --test catalog_reindex -- --ignored --nocapture`.
#![allow(clippy::disallowed_methods, clippy::disallowed_types)]

use std::cell::{Cell, RefCell};
use std::collections::BTreeMap;
use std::rc::Rc;
use std::time::{Duration, Instant};

use mdbn_platform_native::SqliteIndex;
use mdbn_replica::api::{ClientApi, SessionAuth, SessionId};
use mdbn_replica::fake::{FakeLog, FakeLogService};
use mdbn_replica::log::{EndpointId, pump};
use mdbn_replica::replica::{DeviceSecrets, Host, Replica, ReplicaConfig, UtcOnly};
use mdbn_replica::seal::PlainSealer;
use mdbn_replica::store::Store as _;
use mdbn_replica::testkit::{TEST_ROOT, TestControlPlane, signed_root};
use mdbn_replica::{Clock, CorePlanner};
use mdbn_store_file::SqlStore;
use mdbn_store_file::index::{
    Batch, BatchMode, BorrowedBlob, IndexDurability, IndexError, IndexInfo, IndexStorage,
    StmtResult,
};
use mdbn_wire::client::{HelloParams, SubmitParams};
use mdbn_wire::common::{B16, Text, Version};
use mdbn_wire::intent::{Create, Op, ResourcePut};

const COL: B16 = B16([7; 16]);

/// SQLite with time and statement counts per statement kind. Profiling runs
/// each statement of a transaction batch as its own transaction batch (a
/// savepoint inside the apply's deferred window), so the split is per
/// statement; the wall-clock runs leave batches whole and attribute each to its
/// first statement.
struct Profiled {
    inner: SqliteIndex,
    split: bool,
    stats: Rc<RefCell<BTreeMap<String, (u32, Duration)>>>,
}

/// `<verb>:<first table>`: `insert`, `delete`, `update` or `read`, and
/// `coverage` for the whole-index readiness checks.
fn kind(sql: &str) -> String {
    let table = sql
        .split(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
        .find(|w| w.starts_with("st_"))
        .unwrap_or("-");
    let verb = if sql.contains("ready=CASE") || sql.contains("ready=0 WHERE slot=0 AND (") {
        "coverage"
    } else if sql.starts_with("SELECT") || sql.starts_with("WITH") {
        "read"
    } else {
        let word = sql.split_whitespace().next().unwrap_or("-");
        return format!("{}:{table}", word.to_ascii_lowercase());
    };
    format!("{verb}:{table}")
}

impl IndexStorage for Profiled {
    fn info(&self) -> IndexInfo {
        self.inner.info()
    }
    fn run(&mut self, batch: &Batch) -> Result<Vec<StmtResult>, IndexError> {
        if !self.split || batch.mode != BatchMode::Transaction || batch.stmts.len() < 2 {
            let start = Instant::now();
            let out = self.inner.run(batch)?;
            let key = batch.stmts.first().map_or("-".into(), |s| kind(&s.sql));
            let mut stats = self.stats.borrow_mut();
            let e = stats.entry(key).or_default();
            e.0 += batch.stmts.len() as u32;
            e.1 += start.elapsed();
            return Ok(out);
        }
        let mut out = Vec::new();
        for stmt in &batch.stmts {
            let start = Instant::now();
            out.extend(self.inner.run(&Batch {
                mode: BatchMode::Transaction,
                stmts: vec![stmt.clone()],
            })?);
            let mut stats = self.stats.borrow_mut();
            let e = stats.entry(kind(&stmt.sql)).or_default();
            e.0 += 1;
            e.1 += start.elapsed();
        }
        Ok(out)
    }
    fn run_with_borrowed_blob(
        &mut self,
        batch: &Batch,
        blob: BorrowedBlob<'_>,
    ) -> Result<Vec<StmtResult>, IndexError> {
        self.inner.run_with_borrowed_blob(batch, blob)
    }
    fn reset(&mut self) -> Result<(), IndexError> {
        self.inner.reset()
    }
    fn defer_sync(&mut self, on: bool) -> Result<bool, IndexError> {
        self.inner.defer_sync(on)
    }
}

type Store = SqlStore<Profiled>;
type Stats = Rc<RefCell<BTreeMap<String, (u32, Duration)>>>;

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
}

fn store(name: &str, split: bool) -> (Store, Stats) {
    let dir = std::path::Path::new(env!("CARGO_TARGET_TMPDIR")).join(name);
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let stats = Stats::default();
    let index = Profiled {
        inner: SqliteIndex::open(dir.join("index.sqlite"), IndexDurability::Durable).unwrap(),
        split,
        stats: stats.clone(),
    };
    (SqlStore::open(Rc::new(RefCell::new(index))).unwrap(), stats)
}

const DEVICES: std::ops::RangeInclusive<u8> = 101..=109;

fn open(svc: &FakeLogService, store: Store, device: u8) -> Node {
    let devices: Vec<B16> = DEVICES.map(|d| B16([d; 16])).collect();
    if svc.head(&COL).0 == 0 {
        TestControlPlane::new(COL).bootstrap(svc, mdbn_wire::policy::CState::E2e, &devices);
    }
    let cfg = ReplicaConfig {
        collection: COL,
        replica_id: B16([device - 100; 16]),
        device_id: B16([device; 16]),
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
    let host = Host {
        clock: Box::new(TestClock(Rc::new(Cell::new(1_700_000_000_000)))),
        entropy: Box::new(mdbn_replica::crypto::TestEntropy::new(device)),
        zones: Box::new(UtcOnly),
    };
    let mut r = Replica::open(
        cfg,
        store,
        Box::new(CorePlanner),
        Box::new(PlainSealer::for_device(B16([device; 16]))),
        host,
        DeviceSecrets {
            sign_sk: [device; 32],
            kem_sk: [device; 32],
        },
    )
    .expect("open");
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
        log: svc.client(B16([device; 16])),
        s,
    }
}

impl Node {
    /// Until this replica has applied everything the log holds.
    fn sync(&mut self, svc: &FakeLogService) {
        for _ in 0..10_000 {
            pump(&mut self.r, &mut self.log, 100);
            self.r.tick();
            if self.r.head().seq >= svc.head(&COL).0 {
                return;
            }
        }
        panic!("did not catch up");
    }

    fn submit(&mut self, ops: Vec<Op>) {
        let receipts = self
            .r
            .submit(
                self.s,
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
                    validation: None,
                },
            )
            .expect("submit");
        for r in &receipts {
            assert!(r.problem.is_none(), "submit refused: {:?}", r.problem);
        }
    }
}

fn id(n: u32) -> B16 {
    let mut b = [0u8; 16];
    b[..4].copy_from_slice(&n.to_be_bytes());
    b[4..8].copy_from_slice(&n.wrapping_mul(2_654_435_761).to_be_bytes());
    B16(b)
}

fn put_type(path: &str, doc: String) -> Op {
    Op::ResourcePut(ResourcePut {
        path: path.into(),
        doc: Text::Inline(doc),
        base_revision: None,
        must_not_exist: None,
    })
}

/// The task type; `extra` lands inside `schema.value.properties`, `collection`
/// is the type's `collection:` block.
fn task_type(extra: &str, collection: &str) -> String {
    format!(
        "---\nkind: mdbase.type\nname: task\nmatch: {{path_glob: 'tasks/*.md'}}\nschema:\n  dialect: json-schema-2020-12\n  value:\n    type: object\n    properties:\n      priority: {{}}\n      status: {{type: string}}\n      project: {{type: string}}\n      slug: {{type: string}}\n{extra}{collection}---\n"
    )
}

fn task(n: u32) -> String {
    format!(
        "---\npriority: {}\nstatus: {}\nproject: projects/p{}\nslug: t{n}\nrelated: '[[t{:05}]]'\n---\nTask {n} for [[p{}]]\n",
        n % 7,
        if n.is_multiple_of(3) { "done" } else { "open" },
        n % 50,
        (n * 7) % 10_000 + 1,
        n % 50,
    )
}

/// `count` tasks and 50 projects, in entries of 100 creates.
fn seed(node: &mut Node, svc: &FakeLogService, count: u32) {
    node.submit(vec![put_type("_types/task.md", task_type("", ""))]);
    node.sync(svc);
    let mut docs: Vec<(String, String)> = (0..50)
        .map(|p| (format!("projects/p{p}.md"), format!("# Project {p}\n")))
        .collect();
    docs.extend((1..=count).map(|n| (format!("tasks/t{n:05}.md"), task(n))));
    for (at, chunk) in docs.chunks(100).enumerate() {
        let ops = chunk
            .iter()
            .enumerate()
            .map(|(i, (path, doc))| {
                Op::Create(Create {
                    id: id((at * 100 + i) as u32 + 1),
                    path: Some(path.clone()),
                    type_name: None,
                    frontmatter: None,
                    body: None,
                    document: Some(Text::Inline(doc.clone())),
                })
            })
            .collect();
        node.submit(ops);
        node.sync(svc);
    }
}

/// A type matching `glob` that declares `project` a link: the types and links
/// of the tasks it matches change.
fn batch_type(glob: &str) -> Op {
    put_type(
        "_types/batch.md",
        format!(
            "---\nkind: mdbase.type\nname: batch\nmatch: {{path_glob: '{glob}'}}\nschema:\n  dialect: json-schema-2020-12\n  value: {{type: object}}\ncollection:\n  links:\n    project: {{}}\n---\n"
        ),
    )
}

/// A new schema property: no record's metadata changes.
fn schema_only() -> Op {
    put_type(
        "_types/task.md",
        task_type("      estimate: {type: number}\n", ""),
    )
}

/// A `unique` rule on `slug`, which every task holds: every task's metadata
/// changes.
fn unique_slug() -> Op {
    put_type(
        "_types/task.md",
        task_type(
            "      estimate: {type: number}\n",
            "collection:\n  unique:\n    - field: slug\n      enforce: report\n",
        ),
    )
}

fn report(label: &str, elapsed: Duration, stats: &Stats) {
    let stats = stats.borrow();
    let sql: Duration = stats.values().map(|(_, d)| *d).sum();
    eprintln!(
        "{label}: wall {:.0} ms, sql {:.0} ms, outside sql {:.0} ms",
        elapsed.as_secs_f64() * 1e3,
        sql.as_secs_f64() * 1e3,
        elapsed.saturating_sub(sql).as_secs_f64() * 1e3
    );
    let statements: u32 = stats.values().map(|(n, _)| *n).sum();
    eprintln!("    {statements} statements");
    let mut rows: Vec<_> = stats.iter().collect();
    rows.sort_by_key(|(_, (_, d))| std::cmp::Reverse(*d));
    for (k, (n, d)) in rows.into_iter().take(14) {
        eprintln!("    {k:<26} {n:>7} stmts {:>9.1} ms", d.as_secs_f64() * 1e3);
    }
}

/// A device catching up applies three catalog-changing entries after 10k
/// records: a new type matching 10% of them with a declared link field (meta
/// changes for those), a schema-only change (no record meta changes), and a
/// `unique` rule every task holds a value for (meta changes for all of them).
#[test]
#[ignore = "manual release timing (#1648)"]
fn device_catch_up_catalog_changes_at_10k() {
    const TASKS: u32 = 10_000;
    for split in [false, true] {
        let svc = FakeLogService::new();
        let (producer_store, _) = store(&format!("catalog_reindex_producer_{split}"), false);
        let mut producer = open(&svc, producer_store, 101);
        let started = Instant::now();
        seed(&mut producer, &svc, TASKS);
        eprintln!("seeded {TASKS} in {:?}", started.elapsed());
        let (follower_store, stats) = store(&format!("catalog_reindex_follower_{split}"), split);
        let mut follower = open(&svc, follower_store, 102);
        let started = Instant::now();
        follower.sync(&svc);
        eprintln!("follower caught up in {:?}", started.elapsed());
        for (label, op) in [
            (
                "new type over 10% + link field",
                batch_type("tasks/t01*.md"),
            ),
            ("schema-only", schema_only()),
            ("unique rule over every task", unique_slug()),
        ] {
            producer.submit(vec![op]);
            producer.sync(&svc);
            stats.borrow_mut().clear();
            let before = follower.r.stats.reindexed;
            let started = Instant::now();
            follower.sync(&svc);
            let elapsed = started.elapsed();
            let mode = if split { "per statement" } else { "durable" };
            report(&format!("{label} ({mode})"), elapsed, &stats);
            eprintln!("    reindexed {} rows", follower.r.stats.reindexed - before);
            let state = follower.r.store().query_index_state().unwrap().unwrap();
            assert!(state.ready, "{label}: index ready after the entry");
        }
    }
}

/// A writer with `count` tasks and a device caught up with it whose store
/// counts statements one by one.
fn pair(name: &str, count: u32) -> (FakeLogService, Node, Node, Stats) {
    let svc = FakeLogService::new();
    let (store_a, _) = store(&format!("{name}_writer"), false);
    let mut writer = open(&svc, store_a, 101);
    seed(&mut writer, &svc, count);
    let (store_b, stats) = store(&format!("{name}_device"), true);
    let mut device = open(&svc, store_b, 102);
    device.sync(&svc);
    (svc, writer, device, stats)
}

/// The device applies `op` from the writer; the statements it ran, by kind.
fn apply_on_device(
    svc: &FakeLogService,
    writer: &mut Node,
    device: &mut Node,
    stats: &Stats,
    op: Op,
) -> BTreeMap<String, u32> {
    writer.submit(vec![op]);
    writer.sync(svc);
    stats.borrow_mut().clear();
    device.sync(svc);
    stats
        .borrow()
        .iter()
        .map(|(k, (n, _))| (k.clone(), *n))
        .collect()
}

fn ran(stats: &BTreeMap<String, u32>, kind: &str) -> u32 {
    stats.get(kind).copied().unwrap_or(0)
}

/// How many records of `type_name` an indexed window returns.
fn indexed_count(device: &mut Node, type_name: &str) -> usize {
    use mdbn_wire::common::Value;
    let before = device.r.query_stats().indexed;
    let query = Value::Map(vec![
        (
            "types".into(),
            Value::List(vec![Value::Text(type_name.into())]),
        ),
        (
            "order_by".into(),
            Value::List(vec![Value::Map(vec![
                ("field".into(), Value::Text("priority".into())),
                ("direction".into(), Value::Text("asc".into())),
            ])]),
        ),
        ("limit".into(), Value::Int(1000)),
    ]);
    let include = mdbn_wire::client::Include {
        effective: None,
        body: None,
        document: None,
        diagnostics: None,
    };
    let records = device
        .r
        .query(device.s, query, include)
        .expect("query")
        .records
        .len();
    assert_eq!(
        device.r.query_stats().indexed,
        before + 1,
        "the index answered: {:?}",
        device.r.query_stats().last_decline
    );
    records
}

/// A schema change leaves record metadata alone: the device writes no record
/// and rebuilds the query index for its new generation in one pass, checking
/// coverage once at the end rather than on every page.
#[test]
fn a_schema_only_change_writes_no_record_and_rebuilds_the_index_once() {
    const TASKS: u32 = 400;
    let (svc, mut writer, mut device, stats) = pair("catalog_reindex_schema_only", TASKS);
    let before = device.r.store().query_index_state().unwrap().unwrap();
    let stats = apply_on_device(&svc, &mut writer, &mut device, &stats, schema_only());
    for table in ["st_rec", "st_link", "st_uniq"] {
        for verb in ["insert", "delete"] {
            assert_eq!(ran(&stats, &format!("{verb}:{table}")), 0, "{verb}:{table}");
        }
    }
    assert_eq!(device.r.stats.reindexed, 0);
    // The entry's own commit, and the rebuild's last page.
    assert_eq!(ran(&stats, "coverage:st_qstate"), 2, "{stats:?}");
    let store = device.r.store();
    let after = store.query_index_state().unwrap().unwrap();
    assert!(after.ready);
    assert_ne!(after.generation, before.generation);
    assert_eq!(after.head, store.head().unwrap());
    assert!(store.query_projection_state().unwrap().unwrap().ready);
    assert_eq!(indexed_count(&mut device, "task"), TASKS as usize);
}

/// A new type over a quarter of the tasks: the device writes those records
/// back and no other, in the same pass that rebuilds the index, and indexed
/// queries see the new type.
#[test]
fn a_catalog_change_writes_back_only_the_records_it_changes() {
    const TASKS: u32 = 400;
    let (svc, mut writer, mut device, stats) = pair("catalog_reindex_changed", TASKS);
    let stats = apply_on_device(
        &svc,
        &mut writer,
        &mut device,
        &stats,
        batch_type("tasks/t001*.md"),
    );
    assert_eq!(ran(&stats, "insert:st_rec"), 100, "{stats:?}");
    assert_eq!(ran(&stats, "coverage:st_qstate"), 2, "{stats:?}");
    assert_eq!(device.r.stats.reindexed, u64::from(TASKS) + 50);
    let store = device.r.store();
    assert!(store.query_index_state().unwrap().unwrap().ready);
    assert!(store.query_projection_state().unwrap().unwrap().ready);
    let catalog = mdbn_replica::plan::load_catalog(store).unwrap();
    assert_eq!(
        store
            .meta(mdbn_replica::store::meta_keys::RECORD_META)
            .unwrap(),
        Some(mdbn_replica::plan::record_meta_stamp(&catalog))
    );
    for row in store
        .records(mdbn_replica::store::Page {
            after: None,
            limit: 1000,
        })
        .unwrap()
    {
        assert_eq!(
            row.meta,
            mdbn_replica::plan::record_meta(&catalog, &row.path, &row.doc)
        );
    }
    assert_eq!(indexed_count(&mut device, "batch"), 100);
    assert_eq!(indexed_count(&mut device, "task"), TASKS as usize);
}
