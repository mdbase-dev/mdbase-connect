//! The maintained query index over the real SQL store and SQLite: a replica
//! makes it complete for its confirmed state (backfill) before serving. Stores
//! live under `CARGO_TARGET_TMPDIR`, hence the std fs allowances.
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
use mdbn_store_file::index::IndexDurability;
use mdbn_wire::client::{HelloParams, SubmitParams};
use mdbn_wire::common::{B16, Text, Version};
use mdbn_wire::intent::{Create, Op, ResourcePut};

const COL: B16 = B16([7; 16]);
const TASK: &str = "---\nkind: mdbase.type\nname: task\nmatch: {path_glob: 'tasks/*.md'}\nschema:\n  dialect: json-schema-2020-12\n  value:\n    type: object\n    properties:\n      priority: {}\n      status: {type: string}\n---\n";

type Store = SqlStore<SqliteIndex>;

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

fn store(name: &str) -> Store {
    let dir = std::path::Path::new(env!("CARGO_TARGET_TMPDIR")).join(name);
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let index = SqliteIndex::open(dir.join("index.sqlite"), IndexDurability::Durable).unwrap();
    SqlStore::open(Rc::new(RefCell::new(index))).unwrap()
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
    let host = Host {
        clock: Box::new(TestClock(Rc::new(Cell::new(1_700_000_000_000)))),
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
            .map(|i| create(i, &format!("tasks/t{i:05}.md"), task(i)))
            .collect();
        submit(node, ops);
        node.pump();
        n += 100;
    }
}

/// A store whose index is not ready for the current state (a pre-index store,
/// a crash after an invalidating write) is backfilled on open: ready, under the
/// replica's projection generation, at the confirmed head.
#[test]
fn open_backfills_an_unready_index() {
    use mdbn_replica::store::{Store as _, Tx};
    use mdbn_replica::store_query::QueryIndexTx;
    let svc = FakeLogService::new();
    let mut node = open(&svc, store("query_index_backfill"));
    seed(&mut node, 300);
    let mut store = node.r.into_store();
    let ready = store.query_index_state().unwrap().expect("maintained");
    assert!(ready.ready, "maintained on every confirmed commit");
    let head = store.head().unwrap();
    assert_eq!(ready.head, head);
    // Another generation with no rows: unready until coverage is proven again.
    store
        .commit(Tx {
            query_index: Some(QueryIndexTx {
                generation: [9; 32],
                replace_specs: Some(Vec::new()),
                rows: Vec::new(),
                publish_at: None,
            }),
            ..Tx::default()
        })
        .unwrap();
    assert!(!store.query_index_state().unwrap().unwrap().ready);
    let node = open(&svc, store);
    let state = node.r.store().query_index_state().unwrap().unwrap();
    assert!(state.ready, "backfilled before serving");
    assert_eq!(state.generation, ready.generation);
    assert_eq!(state.fields, ready.fields);
    assert_eq!(state.head, head);
}
