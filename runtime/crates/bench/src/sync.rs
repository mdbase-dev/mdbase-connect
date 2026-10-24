//! The replica engine in memory: two or three devices with production
//! sealing (`KeyringSealer`: Ed25519 + HPKE + ChaCha20-Poly1305) syncing
//! through the in-process fake log service, with the real `CorePlanner`.
//!
//! This is the CPU cost of the sync pipeline without network or disk; LAB
//! measures the rest. The harness mirrors the replica's own engine tests
//! (`crates/replica/src/tests/engine.rs`, `join_ahead.rs`).
//!
//! Scenarios:
//! - `replica.seed`: submit every note of the corpus on device A, append all;
//! - `replica.join_replay`: device B opens empty and replays the whole log;
//! - `replica.snapshot_build`: A builds and uploads a snapshot;
//! - `replica.join_snapshot`: device C opens empty after compaction, installs
//!   the snapshot (new device join);
//! - `replica.commit`: one field update on A (plan + local apply), no sync;
//! - `replica.edit_visible`: update on A, append, B receives + applies, B's
//!   store shows the new revision (device-to-device, CPU only);
//! - `replica.catchup_1k`: B offline while A makes 1,000 edits; B catches up;
//! - `replica.query_tasks_open`: the open-tasks query through `ClientApi`.

use std::cell::Cell;
use std::rc::Rc;

use mdbn_core::host::Clock;
use mdbn_replica::api::{ClientApi, SessionAuth, SessionId};
use mdbn_replica::crypto::TestEntropy;
use mdbn_replica::crypto::hpke::KemKeyPair;
use mdbn_replica::crypto::sign::DeviceSigner;
use mdbn_replica::fake::{FakeLog, FakeLogService};
use mdbn_replica::log::{EndpointId, LogClient};
use mdbn_replica::mem::MemStore;
use mdbn_replica::policy::SERVICE_ACCOUNT;
use mdbn_replica::replica::{AuthenticatedLogSession, LogSessionError};
use mdbn_replica::seal::KeyringSealer;
use mdbn_replica::testkit::{TEST_OWNER, TestControlPlane};
use mdbn_replica::{CorePlanner, DeviceSecrets, Host, Replica, ReplicaConfig, Store, UtcOnly};
use mdbn_wire::client::{HelloParams, Include, SubmitParams};
use mdbn_wire::common::{B16, B32, DataMap, Text, Value, Version};
use mdbn_wire::intent::{Create, Op, ResourcePut, Update};
use mdbn_wire::policy::{CState, DeviceEnrol, DeviceKind, PolicyOp};

use crate::corpus::{self, Rng, Spec};
use crate::measure::Sample;

/// The benchmark collection.
pub const COL: B16 = B16([7; 16]);

/// Device keys (sign seed, KEM secret) for devices 1..=3.
fn keys(n: u8) -> ([u8; 32], [u8; 32]) {
    ([0x30 + n; 32], [0x40 + n; 32])
}

fn device(n: u8) -> B16 {
    B16([100 + n; 16])
}

#[derive(Clone)]
struct BenchClock(Rc<Cell<u64>>);

impl Clock for BenchClock {
    fn now_ms(&self) -> u64 {
        self.0.get()
    }
}

/// One device: a replica over `MemStore` and its log client.
pub struct Node {
    /// The replica.
    pub r: Replica<MemStore>,
    log: FakeLog,
    /// Host session.
    pub s: SessionId,
    /// The test clock (ms).
    pub clock: Rc<Cell<u64>>,
    session: Option<AuthenticatedLogSession>,
}

/// A collection whose genesis enrols devices 1..=`devices` with real keys.
pub fn world(devices: u8, state: CState) -> FakeLogService {
    let svc = FakeLogService::new();
    let mut cp = TestControlPlane::signed(COL);
    let (s1, k1) = keys(1);
    cp.genesis_with_keys(&svc, state, device(1), &s1, &k1);
    let enrol = |n: u8, account: B16, kind: DeviceKind| {
        let (s, k) = keys(n);
        PolicyOp::DeviceEnrol(DeviceEnrol {
            device: device(n),
            account,
            kind,
            sign_pk: B32(DeviceSigner::from_seed(&s).public()),
            kem_pk: B32(KemKeyPair::from_secret(&k).pk),
            noise_pk: B32([100 + n; 32]),
            sas_commit: None,
            local_root: None,
        })
    };
    if state == CState::CloudCopy {
        // Cloud copy keys the escrow in the initial rekey.
        cp.append(&svc, vec![enrol(9, SERVICE_ACCOUNT, DeviceKind::Escrow)]);
    }
    for n in 2..=devices {
        cp.append(&svc, vec![enrol(n, TEST_OWNER, DeviceKind::Desktop)]);
    }
    svc
}

impl Node {
    /// Open device `n` (1..=3) on `svc`.
    pub fn open(svc: &FakeLogService, n: u8) -> Node {
        let (sign, kem) = keys(n);
        let clock = Rc::new(Cell::new(1_767_225_600_000)); // 2026-01-01
        let cfg = ReplicaConfig {
            collection: COL,
            replica_id: B16([n; 16]),
            device_id: device(n),
            mode: mdbn_wire::client::SyncMode::Synced,
            log_endpoint: EndpointId(1),
            verify: true,
            runtime_version: "bench".into(),
            trusted_roots: vec![
                mdbn_replica::testkit::TEST_ROOT,
                mdbn_replica::testkit::signed_root(),
            ],
            e2e: false,
            trusted_signers: vec![device(1)],
            user_enabled_cloud_copy: false,
            chosen_state: None,
            key_grants_only: false,
            expected_genesis: None,
            policy_pins: None,
        };
        let host = Host {
            clock: Box::new(BenchClock(clock.clone())),
            entropy: Box::new(TestEntropy::new(n)),
            zones: Box::new(UtcOnly),
        };
        let mut r = Replica::open(
            cfg,
            MemStore::new(),
            Box::new(CorePlanner),
            Box::new(KeyringSealer::new(COL, device(n), &sign, &kem)),
            host,
            DeviceSecrets {
                sign_sk: sign,
                kem_sk: kem,
            },
        )
        .expect("open replica");
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
            log: svc.client(device(n)),
            s,
            clock,
            session: None,
        }
    }

    fn session(&mut self) -> Option<AuthenticatedLogSession> {
        if let Some(s) = &self.session {
            return Some(s.clone());
        }
        let endpoint = self.r.log_endpoint();
        let s = self.r.bind_authenticated_log(endpoint, COL).ok()?;
        self.session = Some(s.clone());
        Some(s)
    }

    /// Exchange calls and pushes with the log until quiet.
    pub fn pump(&mut self) {
        for _ in 0..1_000 {
            let mut progressed = false;
            let Some(session) = self.session() else {
                return;
            };
            for push in self.log.poll_pushes() {
                progressed = true;
                let _ = self.r.on_authenticated_log_push(&session, |_| Ok(push));
            }
            let calls = match self.r.take_authenticated_log_calls(&session) {
                Ok(calls) => calls,
                Err(LogSessionError::Stale | LogSessionError::WrongBinding) => {
                    self.session = None;
                    continue;
                }
                Err(_) => return,
            };
            for (call, scope) in calls {
                progressed = true;
                let reply = self.log.call(call.request);
                let _ = self.r.on_authenticated_log_reply(scope, move |_, _| reply);
            }
            if !progressed {
                break;
            }
        }
    }

    /// One pump + tick round.
    pub fn step(&mut self) {
        self.pump();
        self.r.tick();
    }

    /// Submit `ops` as one mutation.
    pub fn submit(&mut self, ops: Vec<Op>) {
        self.r
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
                },
            )
            .expect("submit");
    }

    /// The document of record `id`, if present.
    pub fn doc(&self, id: B16) -> Option<String> {
        Store::record(self.r.store(), &id)
            .ok()
            .flatten()
            .map(|r| r.doc)
    }

    /// Run a query (JSON spec 11 object) and return the row count.
    pub fn query(&mut self, q: &serde_json::Value) -> usize {
        self.r
            .query(
                self.s,
                json_to_wire(q),
                Include {
                    effective: None,
                    body: Some(false),
                    document: Some(false),
                    diagnostics: Some(false),
                },
            )
            .expect("query")
            .records
            .len()
    }
}

/// Step every node until nothing is pending and each node's applied head
/// matches the log, at most `rounds` rounds. Returns the rounds used.
pub fn settle(svc: &FakeLogService, nodes: &mut [&mut Node], rounds: usize) -> usize {
    for round in 0..rounds {
        for n in nodes.iter_mut() {
            n.step();
        }
        let head = svc.head(&COL).0;
        if nodes
            .iter()
            .all(|n| n.r.sync_status().pending == 0 && n.r.head().seq >= head)
        {
            return round + 1;
        }
    }
    for n in nodes.iter() {
        eprintln!(
            "mdbn-perf: settle gave up after {rounds} rounds: log head {}, node head {}, status {:?}, key wait {:?}, stats {:?}",
            svc.head(&COL).0,
            n.r.head().seq,
            n.r.sync_status(),
            n.r.key_wait_reason(),
            n.r.stats
        );
    }
    rounds
}

/// Serde JSON to the wire value type.
pub fn json_to_wire(v: &serde_json::Value) -> Value {
    use serde_json::Value as J;
    match v {
        J::Null => Value::Null,
        J::Bool(b) => Value::Bool(*b),
        J::Number(n) => n
            .as_i64()
            .map_or_else(|| Value::Float(n.as_f64().unwrap_or(0.0)), Value::Int),
        J::String(s) => Value::Text(s.clone()),
        J::Array(a) => Value::List(a.iter().map(json_to_wire).collect()),
        J::Object(o) => Value::Map(
            o.iter()
                .map(|(k, v)| (k.clone(), json_to_wire(v)))
                .collect(),
        ),
    }
}

/// A record ID for corpus note `i`.
pub fn id(i: u64) -> B16 {
    let mut b = [0u8; 16];
    b[0] = 0x0b;
    b[8..].copy_from_slice(&i.to_be_bytes());
    B16(b)
}

/// The corpus as replica ops: resources (`mdbase.yaml`, replaced by `config`
/// when given; types) and one `Create` per Markdown note. Attachments and
/// `.base` files are skipped. Also returns the task notes' IDs and paths.
pub type CorpusOps = (Vec<Op>, Vec<Op>, Vec<(B16, String)>);

/// See [`CorpusOps`].
pub fn corpus_ops(spec: &Spec, config: Option<&str>) -> CorpusOps {
    let mut resources = Vec::new();
    let mut creates = Vec::new();
    let mut tasks = Vec::new();
    let mut i = 0u64;
    corpus::generate(spec, |rel, bytes| {
        let Ok(text) = std::str::from_utf8(bytes) else {
            return;
        };
        if rel == "mdbase.yaml" || rel.starts_with("_types/") {
            let doc = match config {
                Some(c) if rel == "mdbase.yaml" => c.to_string(),
                _ => text.to_string(),
            };
            resources.push(Op::ResourcePut(ResourcePut {
                path: rel.into(),
                doc: Text::Inline(doc),
                base_revision: None,
                must_not_exist: None,
            }));
        } else if rel.ends_with(".md") {
            i += 1;
            if rel.starts_with("TaskNotes/Tasks/") {
                tasks.push((id(i), rel.to_string()));
            }
            creates.push(Op::Create(Create {
                id: id(i),
                path: Some(rel.into()),
                type_name: None,
                frontmatter: None,
                body: None,
                document: Some(Text::Inline(text.into())),
            }));
        }
    });
    (resources, creates, tasks)
}

/// A field update op.
pub fn set_field(id: B16, key: &str, value: &str) -> Op {
    Op::Update(Update {
        id,
        patch: Some(DataMap(
            [(key.to_string(), Value::Text(value.into()))]
                .into_iter()
                .collect(),
        )),
        unset: None,
        add: None,
        remove: None,
        body: None,
        body_edits: None,
        body_base: None,
        body_base_text: None,
        base: None,
        if_revision: None,
    })
}

/// Seed device A with the corpus in batches of `batch` creates.
pub fn seed(
    svc: &FakeLogService,
    a: &mut Node,
    resources: Vec<Op>,
    creates: Vec<Op>,
    batch: usize,
) {
    a.submit(resources);
    settle(svc, &mut [&mut *a], 50);
    let mut it = creates.into_iter().peekable();
    while it.peek().is_some() {
        let ops: Vec<Op> = it.by_ref().take(batch).collect();
        a.submit(ops);
        a.step();
    }
    settle(svc, &mut [&mut *a], 2_000);
}

fn open_tasks_query() -> serde_json::Value {
    serde_json::json!({
        "types": ["task"],
        "where": "status != \"done\"",
        "order_by": [{"field": "due", "direction": "asc"}],
        "limit": 100
    })
}

/// Run the replica scenarios for `spec`.
pub fn run(spec: &Spec, iters: usize, out: &mut Vec<Sample>) {
    let size = spec.notes;
    let (resources, creates, tasks) = corpus_ops(spec, None);
    let svc = world(3, CState::CloudCopy);
    let mut a = Node::open(&svc, 1);
    settle(&svc, &mut [&mut a], 50);

    let mut s = Sample::new(
        "replica.seed",
        size,
        "device A: submit every note (batches of 200) and append all to the log",
    );
    s.time(|| seed(&svc, &mut a, resources, creates, 200));
    let head = svc.head(&COL).0;
    s.note.push_str(&format!("; log head {head}"));
    out.push(s);

    let mut s = Sample::new(
        "replica.join_replay",
        size,
        "device B opens empty and replays the whole log (no snapshot)",
    );
    let mut b = s.time(|| {
        let mut b = Node::open(&svc, 2);
        settle(&svc, &mut [&mut b], 2_000);
        b
    });
    assert!(
        b.doc(tasks[0].0).is_some(),
        "B did not receive A's notes: head {} / log {}, key wait {:?}, stats {:?}",
        b.r.head().seq,
        svc.head(&COL).0,
        b.r.key_wait_reason(),
        b.r.stats
    );
    out.push(s);

    // Device-to-device edit.
    let mut s = Sample::new(
        "replica.edit_visible",
        size,
        "A updates a task, appends; B receives, verifies, decrypts, applies (CPU only, no network)",
    );
    let mut rng = Rng::new(7);
    for i in 0..iters {
        let (tid, _) = tasks[rng.below(tasks.len() as u64) as usize];
        let want = format!("v{i}");
        s.time(|| {
            a.submit(vec![set_field(tid, "status", &want)]);
            for _ in 0..1_000 {
                a.step();
                b.step();
                if b.doc(tid).is_some_and(|d| d.contains(&want)) {
                    return;
                }
            }
            panic!("edit never reached B");
        });
    }
    out.push(s);

    let mut s = Sample::new(
        "replica.commit",
        size,
        "A: one field update through submit (plan + local apply), no sync",
    );
    for i in 0..iters {
        let (tid, _) = tasks[rng.below(tasks.len() as u64) as usize];
        s.time(|| a.submit(vec![set_field(tid, "priority", ["low", "high"][i % 2])]));
    }
    settle(&svc, &mut [&mut a, &mut b], 2_000);
    out.push(s);

    let mut s = Sample::new(
        "replica.query_tasks_open",
        size,
        "ClientApi::query: type task, status != done, order by due, limit 100 (MemStore)",
    );
    for _ in 0..iters {
        s.time(|| a.query(&open_tasks_query()));
    }
    out.push(s);

    let mut s = Sample::new(
        "replica.catchup_1k",
        size,
        "B offline while A makes 1,000 single-field edits; B catches up",
    );
    for i in 0..1_000 {
        let (tid, _) = tasks[rng.below(tasks.len() as u64) as usize];
        a.submit(vec![set_field(tid, "status", &format!("c{i}"))]);
        if i % 50 == 0 {
            a.step();
        }
    }
    settle(&svc, &mut [&mut a], 2_000);
    s.time(|| settle(&svc, &mut [&mut b], 2_000));
    out.push(s);
    drop(b);

    let mut s = Sample::new(
        "replica.snapshot_build",
        size,
        "A builds a snapshot and uploads it",
    );
    s.time(|| {
        a.r.build_snapshot_now().expect("snapshot");
        settle(&svc, &mut [&mut a], 2_000);
    });
    let built = a.r.stats.snapshots_built;
    s.note.push_str(&format!("; built {built}"));
    out.push(s);

    svc.compact(&COL, a.r.head().seq);
    let mut s = Sample::new(
        "replica.join_snapshot",
        size,
        "device C opens empty after compaction and installs the snapshot",
    );
    let c = s.time(|| {
        let mut c = Node::open(&svc, 3);
        settle(&svc, &mut [&mut c], 2_000);
        c
    });
    s.note
        .push_str(&format!("; installed {}", c.r.stats.snapshots_installed));
    assert!(
        c.doc(tasks[0].0).is_some(),
        "C did not install the snapshot"
    );
    out.push(s);
}
