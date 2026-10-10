//! The replica engine end to end: submit, append loop, apply, receipts, rebase,
//! restarts, over the in-memory store and fake log service.
//!
//! Core planning is still a stub, so these tests use a small planner that handles
//! `create` (explicit path, `document` or `body`), `document` (blind replace) and
//! `delete`, with path collisions decided at the head.

use std::cell::Cell;
use std::rc::Rc;

use crate::api::{ClientApi, ErrorCode, Push, SessionAuth, SessionId};
use crate::fake::{FakeLog, FakeLogService};
use crate::log::{EndpointId, LogPort, pump};
use crate::mem::MemStore;
use crate::plan::Planner;
use crate::seal::PlainSealer;
use crate::{DeviceSecrets, Host, Replica, ReplicaConfig, UtcOnly};
use mdbn_core::host::Clock;
use mdbn_core::ids::Uuid as CUuid;
use mdbn_core::intent::{Mutation as CMutation, Op as COp};
use mdbn_core::plan::{Effect, PlanOptions, Planned, RejectCode, Rejection};
use mdbn_core::state::StateView;
use mdbn_wire::client::{HelloParams, ReceiptState, SubmitParams};
use mdbn_wire::common::{B16, B32, Text, Version};
use mdbn_wire::intent::{Create, Delete, Op};

struct TestPlanner;

impl Planner for TestPlanner {
    fn plan(
        &self,
        m: &CMutation,
        state: &dyn StateView,
        _opts: &PlanOptions,
    ) -> Result<Planned, Rejection> {
        let mut out = Planned::noop();
        for op in &m.ops {
            match op {
                COp::Create(c) => {
                    let path = c.path.clone().unwrap_or_else(|| format!("{}.md", c.id));
                    let key = mdbn_core::paths::path_key(&path);
                    if state.at_path_key(&key).is_some() || out.effects.iter().any(|e| matches!(e, Effect::PutRecord { path: p, .. } if mdbn_core::paths::path_key(p) == key)) {
                        return Err(Rejection::new(RejectCode::Conflict, Some("path_taken"), "path taken"));
                    }
                    if state.record(&c.id).is_some() {
                        return Err(Rejection::new(
                            RejectCode::InvalidRequest,
                            Some("duplicate_id"),
                            "id exists",
                        ));
                    }
                    let doc = c.document.clone().or(c.body.clone()).unwrap_or_default();
                    out.effects.push(Effect::PutRecord {
                        id: c.id,
                        path,
                        doc,
                    });
                }
                COp::Document(d) => match (&d.new, state.record(&d.id)) {
                    (Some(n), _) => out.effects.push(Effect::PutRecord {
                        id: d.id,
                        path: n.path.clone(),
                        doc: n.doc.clone(),
                    }),
                    (None, Some(r)) => out.effects.push(Effect::RemoveRecord {
                        id: d.id,
                        path: r.path,
                    }),
                    (None, None) => {}
                },
                COp::Delete(d) => {
                    if let Some(r) = state.record(&d.id) {
                        out.effects.push(Effect::RemoveRecord {
                            id: d.id,
                            path: r.path,
                        });
                    }
                }
                _ => {
                    return Err(Rejection::new(
                        RejectCode::InvalidRequest,
                        Some("unsupported"),
                        "test planner",
                    ));
                }
            }
        }
        Ok(out)
    }
}

#[derive(Clone)]
struct TestClock(Rc<Cell<u64>>);

impl Clock for TestClock {
    fn now_ms(&self) -> u64 {
        self.0.get()
    }
}

mod bases;
mod collection_setup;
mod receipt_fanout;

pub(super) const COL: B16 = B16([7; 16]);

/// Items the test control plane writes before any test entry (genesis, initial rekey).
const BOOT: u64 = 2;

/// Every device a test node can be (`n + 100` for nodes 1..=9).
fn test_devices() -> Vec<B16> {
    (101..=109u8).map(|d| B16([d; 16])).collect()
}

pub(super) struct Node {
    pub(super) r: Replica<MemStore>,
    pub(super) log: FakeLog,
    pub(super) s: SessionId,
    pub(super) clock: Rc<Cell<u64>>,
    /// The trusted host's authenticated log session: bound lazily, rebound after
    /// every lifecycle event (exactly what a native adapter does).
    session: Option<crate::replica::AuthenticatedLogSession>,
}

pub(super) fn node(svc: &FakeLogService, n: u8, store: MemStore) -> Node {
    node_with(svc, n, store, test_devices(), None)
}

/// A node with chosen trusted signers and, optionally, a production sealer (whose
/// genesis the test writes itself).
pub(super) fn node_with(
    svc: &FakeLogService,
    n: u8,
    store: MemStore,
    trusted: Vec<B16>,
    sealer: Option<Box<dyn crate::seal::Sealer>>,
) -> Node {
    node_pinned(svc, n, store, trusted, sealer, None)
}

/// [`node_with`], with the genesis pinned by the host.
fn node_pinned(
    svc: &FakeLogService,
    n: u8,
    store: MemStore,
    trusted: Vec<B16>,
    sealer: Option<Box<dyn crate::seal::Sealer>>,
    expected_genesis: Option<mdbn_wire::common::Hash>,
) -> Node {
    let clock = Rc::new(Cell::new(1_700_000_000_000));
    let real = sealer.is_some();
    let cfg = ReplicaConfig {
        collection: COL,
        replica_id: B16([n; 16]),
        device_id: B16([n + 100; 16]),
        mode: mdbn_wire::client::SyncMode::Synced,
        log_endpoint: EndpointId(1),
        verify: true,
        runtime_version: "test".into(),
        trusted_roots: vec![crate::testkit::TEST_ROOT, crate::testkit::signed_root()],
        e2e: false,
        trusted_signers: trusted,
        user_enabled_cloud_copy: false,
        chosen_state: None,
        key_grants_only: false,
        expected_genesis,
        policy_pins: None,
    };
    if svc.head(&COL).0 == 0 && !real {
        crate::testkit::TestControlPlane::new(COL).bootstrap(
            svc,
            mdbn_wire::policy::CState::E2e,
            &test_devices(),
        );
    }
    let host = Host {
        clock: Box::new(TestClock(clock.clone())),
        entropy: Box::new(crate::crypto::TestEntropy::new(n)),
        zones: Box::new(UtcOnly),
    };
    let mut r = Replica::open(
        cfg,
        store,
        Box::new(TestPlanner),
        sealer.unwrap_or_else(|| Box::new(PlainSealer::for_device(B16([n + 100; 16])))),
        host,
        DeviceSecrets {
            sign_sk: [n; 32],
            kem_sk: [n; 32],
        },
    )
    .expect("open");
    let (s, _) = r
        .hello(
            SessionAuth::Host,
            HelloParams {
                versions: vec![Version { major: 1, minor: 0 }],
                client_name: "test".into(),
                client_version: "0".into(),
                features: None,
                timezone: None,
            },
        )
        .expect("hello");
    Node {
        r,
        log: svc.client(B16([n + 100; 16])),
        s,
        clock,
        session: None,
    }
}

impl Node {
    /// The current authenticated session, binding a fresh one when none is
    /// current (first use, or after a lifecycle event retired the old one).
    fn session(&mut self) -> Option<crate::replica::AuthenticatedLogSession> {
        if let Some(s) = &self.session {
            return Some(s.clone());
        }
        let endpoint = self.r.log_endpoint();
        let s = self.r.bind_authenticated_log(endpoint, COL).ok()?;
        self.session = Some(s.clone());
        Some(s)
    }

    /// Exchange calls and pushes with the fake service through the authenticated
    /// session API, as the native adapter does; legacy `LogPort`
    /// delivery stays available to tests that drive it by hand.
    pub(super) fn pump(&mut self) {
        use crate::log::LogClient;
        use crate::replica::LogSessionError;
        for _ in 0..100 {
            let mut progressed = false;
            let Some(session) = self.session() else {
                return; // a fenced replica serves nothing
            };
            for push in self.log.poll_pushes() {
                progressed = true;
                let _ = self.r.on_authenticated_log_push(&session, |_| Ok(push));
            }
            let calls = match self.r.take_authenticated_log_calls(&session) {
                Ok(calls) => calls,
                Err(LogSessionError::Stale | LogSessionError::WrongBinding) => {
                    // Retired by a lifecycle event or a log move: reconnect.
                    self.session = None;
                    continue;
                }
                Err(LogSessionError::ReopenRequired) => return,
                Err(LogSessionError::WrongShape) => unreachable!("take has no shape"),
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
    pub(super) fn create(&mut self, id: u8, path: &str, doc: &str) -> mdbn_wire::client::Receipt {
        let mut r = self
            .r
            .submit(
                self.s,
                SubmitParams {
                    ops: vec![Op::Create(Create {
                        id: B16([id; 16]),
                        path: Some(path.into()),
                        type_name: None,
                        frontmatter: None,
                        body: None,
                        document: Some(Text::Inline(doc.into())),
                    })],
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
        r.remove(0)
    }
    pub(super) fn doc(&self, id: u8) -> Option<String> {
        crate::Store::record(self.r.store(), &B16([id; 16]))
            .unwrap()
            .map(|r| r.doc)
    }
}

pub(super) fn settle(nodes: &mut [&mut Node]) {
    for _ in 0..20 {
        for n in nodes.iter_mut() {
            n.pump();
            n.r.tick();
        }
    }
}

#[test]
fn retained_tail_is_exact_and_own_handover_survives_reopen() {
    use crate::Store;
    let svc = FakeLogService::new();
    let mut a = node(&svc, 1, MemStore::new());
    let mut b = node(&svc, 2, MemStore::new());
    settle(&mut [&mut a, &mut b]);
    let receipt = a.create(1, "one.md", "retained plaintext");
    settle(&mut [&mut a, &mut b]);
    let raw = svc.items(&COL);
    for n in [&a, &b] {
        let tail = n.r.store().tail(0, 100).unwrap();
        assert_eq!(tail.iter().map(|r| r.item.clone()).collect::<Vec<_>>(), raw);
        assert_eq!(tail.first().unwrap().seq, 1);
        assert_eq!(tail.last().unwrap().seq, n.r.head().seq);
        assert_eq!(n.r.tail_stats, n.r.store().tail_stats().unwrap());
        assert!(
            n.r.retaining.is_none(),
            "no apply candidate survives the attempt"
        );
    }
    assert!(
        a.r.store()
            .pending_get(&receipt.mutation)
            .unwrap()
            .is_none()
    );
    let own = a.r.store().own_retained(0, 100).unwrap();
    assert_eq!(own.len(), 1);
    assert_eq!(own[0].0, a.r.head().seq);
    assert_eq!(own[0].1.mutation.id, receipt.mutation);
    assert!(b.r.store().own_retained(0, 100).unwrap().is_empty());
    let mut reopened = node(&svc, 1, a.r.into_store());
    settle(&mut [&mut reopened]);
    assert_eq!(reopened.r.store().own_retained(0, 100).unwrap(), own);
    assert_eq!(
        reopened.r.tail_stats,
        reopened.r.store().tail_stats().unwrap()
    );
}

#[test]
fn retained_tail_and_own_handover_are_atomic_on_commit_failure() {
    use crate::Store;
    let svc = FakeLogService::new();
    let mut a = node(&svc, 1, MemStore::new());
    settle(&mut [&mut a]);
    let before = a.r.head();
    let receipt = a.create(1, "atomic.md", "x");
    let original = a.r.store().pending_get(&receipt.mutation).unwrap().unwrap();
    a.r.store().fail_commits(1);
    pump(&mut a.r, &mut a.log, 1);
    assert_eq!(a.r.head(), before, "failed apply does not advance head");
    assert_eq!(
        a.r.store().pending_get(&receipt.mutation).unwrap(),
        Some(original.clone())
    );
    assert!(a.r.store().own_retained(0, 100).unwrap().is_empty());
    assert_eq!(a.r.store().tail_stats().unwrap().last, before.seq);
    assert!(
        a.r.retaining.is_none(),
        "failed apply must drop its exact-byte candidate"
    );
    settle(&mut [&mut a]);
    assert!(
        a.r.store()
            .pending_get(&receipt.mutation)
            .unwrap()
            .is_none()
    );
    assert_eq!(
        a.r.store().own_retained(0, 100).unwrap(),
        vec![(before.seq + 1, original)]
    );
    assert_eq!(a.r.store().tail_stats().unwrap().last, before.seq + 1);
}

#[test]
fn retained_tail_window_covers_positions_or_age_and_prunes_own_together() {
    use crate::Store;
    use crate::store::TailRetention;
    let svc = FakeLogService::new();
    let mut a = node(&svc, 1, MemStore::new());
    a.r.set_tail_retention(TailRetention {
        min_positions: 1,
        min_age_ms: 500,
        max_bytes: u64::MAX,
    });
    settle(&mut [&mut a]);
    for i in 0..5 {
        a.clock.set(a.clock.get() + 10);
        a.create(i, &format!("n{i}.md"), "x");
        settle(&mut [&mut a]);
    }
    assert_eq!(
        a.r.store().tail(0, 100).unwrap().len(),
        7,
        "age extends the window"
    );
    a.clock.set(a.clock.get() + 1_000);
    a.create(8, "last.md", "x");
    settle(&mut [&mut a]);
    let tail = a.r.store().tail(0, 100).unwrap();
    assert_eq!(tail.len(), 1);
    let own = a.r.store().own_retained(0, 100).unwrap();
    assert_eq!(own.len(), 1);
    assert_eq!(own[0].0, tail[0].seq);
    a.r.set_tail_retention(TailRetention {
        min_positions: 2,
        min_age_ms: 0,
        max_bytes: u64::MAX,
    });
    for i in 10..16 {
        a.clock.set(a.clock.get() + 10);
        a.create(i, &format!("n{i}.md"), "x");
        settle(&mut [&mut a]);
    }
    let tail = a.r.store().tail(0, 100).unwrap();
    assert!((2..=3).contains(&tail.len()), "batched position bound");
    assert!(
        a.r.store()
            .own_retained(0, 100)
            .unwrap()
            .iter()
            .all(|(seq, _)| *seq >= tail[0].seq)
    );
}

#[test]
fn retained_counter_read_failure_immediately_blocks_new_client_actions() {
    use crate::Store;
    for abort_label in [false, true] {
        let svc = FakeLogService::new();
        let mut a = node(&svc, 1, MemStore::new());
        settle(&mut [&mut a]);
        let first = a.create(1, "first.md", "x");
        a.r.store().fail_tail_stats(1, abort_label);
        pump(&mut a.r, &mut a.log, 1);
        assert_eq!(
            a.r.store()
                .local_receipt(&first.mutation)
                .unwrap()
                .unwrap()
                .state,
            ReceiptState::Confirmed,
            "the successful commit remains confirmed"
        );
        assert!(
            a.r.requires_reopen(),
            "the FIRST accounting failure must fence, not wait for another apply"
        );
        assert_eq!(
            a.r.receipt(a.s, first.mutation)
                .unwrap_err()
                .0
                .reason
                .as_deref(),
            Some("apply_reopen_required"),
            "new client actions must not use unhealthy storage"
        );
        assert!(a.r.take_log_calls().is_empty());
        assert!(
            a.r.take_pushes()
                .iter()
                .all(|(_, p)| matches!(p, Push::Closed(_)))
        );
    }
}

#[test]
fn retained_counter_read_failure_confirms_then_fences_immediately_until_reopen() {
    use crate::Store;
    for abort_label in [false, true] {
        let svc = FakeLogService::new();
        let mut a = node(&svc, 1, MemStore::new());
        settle(&mut [&mut a]);
        let before = a.r.head().seq;
        let first = a.create(1, "first.md", "x");
        // Both intents were captured while healthy. The fence must preserve the
        // second pending row, not accept a NEW submit after the first read fault.
        let second = a.create(2, "second.md", "x");
        a.r.store().fail_tail_stats(1, abort_label);
        pump(&mut a.r, &mut a.log, 1);
        assert_eq!(
            a.r.head().seq,
            before + 1,
            "known successful commit must confirm"
        );
        assert!(a.r.tail_stats_dirty);
        assert!(a.r.store().pending_get(&first.mutation).unwrap().is_none());
        assert_eq!(
            a.r.store().own_retained(0, 100).unwrap()[0].1.mutation.id,
            first.mutation
        );
        assert_eq!(
            a.r.store()
                .local_receipt(&first.mutation)
                .unwrap()
                .unwrap()
                .state,
            ReceiptState::Confirmed,
            "confirmation remains durably available after fresh reopen"
        );
        assert!(
            a.r.take_pushes()
                .iter()
                .all(|(_, p)| matches!(p, Push::Closed(_))),
            "quarantine drops plaintext/serialized ACKs, not the durable proof"
        );
        pump(&mut a.r, &mut a.log, 1);
        assert_eq!(
            a.r.head().seq,
            before + 1,
            "the immediate fence must prevent the next policy evaluation"
        );
        assert!(
            a.r.requires_reopen(),
            "ANY accounting read failure is unknown, not a strong commit abort"
        );
        assert!(a.r.store().pending_get(&second.mutation).unwrap().is_some());
        assert!(a.r.retaining.is_none());
        let commits = a.r.store().data().borrow().commits;
        settle(&mut [&mut a]);
        assert_eq!(
            a.r.store().data().borrow().commits,
            commits,
            "terminal engine must not write again"
        );
        let mut reopened = node(&svc, 1, a.r.into_store());
        settle(&mut [&mut reopened]);
        assert_eq!(reopened.r.head().seq, before + 2);
        assert!(!reopened.r.tail_stats_dirty);
        assert_eq!(
            reopened.r.tail_stats,
            reopened.r.store().tail_stats().unwrap()
        );
        assert!(
            reopened
                .r
                .store()
                .pending_get(&second.mutation)
                .unwrap()
                .is_none()
        );
        assert_eq!(reopened.r.store().own_retained(0, 100).unwrap().len(), 2);
        assert_eq!(
            reopened
                .r
                .receipt(reopened.s, first.mutation)
                .unwrap()
                .state,
            ReceiptState::Confirmed,
            "the original acknowledged mutation is still confirmed"
        );
    }
}

#[test]
fn retained_postcommit_fence_does_not_publish_fresh_query_context() {
    use crate::Store;
    let svc = FakeLogService::new();
    let mut a = node(&svc, 1, MemStore::new());
    settle(&mut [&mut a]);
    // Force a fresh optional context capture during this apply, not a reuse of
    // the old one. This is disposable derived state, never serving permission.
    a.r.query_context = None;
    assert!(
        a.r.prepare_query_index(&mut crate::store::Tx::default())
            .unwrap()
            .is_some(),
        "this fixture can capture a fresh optional context"
    );
    let first = a.create(1, "first.md", "x");
    a.r.store().fail_tail_stats(1, false);
    pump(&mut a.r, &mut a.log, 1);
    assert!(a.r.requires_reopen());
    assert!(a.r.query_context.is_none());
    let head = a.r.head();
    // MemStore does not implement the optional persistent query index. Do not
    // turn this portable publication/fence test into a native-persistence claim.
    assert!(a.r.store().query_index_state().unwrap().is_none());
    assert_eq!(a.r.store().tail_stats().unwrap().last, head.seq);
    assert!(a.r.store().pending_get(&first.mutation).unwrap().is_none());
    let reopened = node(&svc, 1, a.r.into_store());
    assert_eq!(reopened.r.head(), head);
    assert!(reopened.r.store().query_index_state().unwrap().is_none());
}

#[test]
fn private_query_projection_read_cannot_certify_commit_abort() {
    use crate::Store;
    let svc = FakeLogService::new();
    let mut a = node(&svc, 1, MemStore::new());
    settle(&mut [&mut a]);
    let head = a.r.head();
    let mutation = a.create(1, "read-probe.md", "x");
    let commits = a.r.store().data().borrow().commits;
    a.r.store().data().borrow_mut().query_read_abort_probe = true;
    pump(&mut a.r, &mut a.log, 1);
    assert_eq!(a.r.head(), head);
    assert_eq!(a.r.store().data().borrow().commits, commits);
    assert!(
        a.r.store()
            .pending_get(&mutation.mutation)
            .unwrap()
            .is_some()
    );
    assert!(
        a.r.requires_reopen(),
        "a query-index READ result cannot guarantee a durable prior outer state"
    );
}

#[test]
fn retained_tail_byte_cap_overrides_both_windows() {
    use crate::Store;
    use crate::store::TailRetention;
    let svc = FakeLogService::new();
    let mut a = node(&svc, 1, MemStore::new());
    settle(&mut [&mut a]);
    a.create(0, "n0.md", "x");
    settle(&mut [&mut a]);
    let cap = svc.items(&COL).last().unwrap().len() as u64 * 2;
    a.r.set_tail_retention(TailRetention {
        min_positions: 100_000,
        min_age_ms: i64::MAX,
        max_bytes: cap,
    });
    for i in 1..5 {
        a.create(i, &format!("n{i}.md"), "x");
        settle(&mut [&mut a]);
        assert!(a.r.store().tail_stats().unwrap().bytes <= cap);
        let tail = a.r.store().tail(0, 100).unwrap();
        assert!(
            a.r.store()
                .own_retained(0, 100)
                .unwrap()
                .iter()
                .all(|(seq, _)| *seq >= tail[0].seq)
        );
    }
    a.r.set_tail_retention(TailRetention {
        max_bytes: 1,
        ..TailRetention::DESKTOP
    });
    a.create(9, "oversize.md", "x");
    settle(&mut [&mut a]);
    assert_eq!(
        a.r.store().tail_stats().unwrap(),
        crate::store::TailStats::default()
    );
    assert!(a.r.store().own_retained(0, 100).unwrap().is_empty());
    assert!(
        a.doc(9).is_some(),
        "retention never changes apply semantics"
    );
}

#[test]
fn local_revocation_erases_retained_material_and_does_not_repopulate_it() {
    use crate::Store;
    let svc = FakeLogService::new();
    let mut a = node(&svc, 1, MemStore::new());
    let mut b = node(&svc, 2, MemStore::new());
    settle(&mut [&mut a, &mut b]);
    b.create(1, "before.md", "x");
    settle(&mut [&mut a, &mut b]);
    assert!(!b.r.store().own_retained(0, 100).unwrap().is_empty());
    crate::testkit::TestControlPlane::new(COL).revoke(&svc, B16([102; 16]));
    a.create(2, "after.md", "x");
    settle(&mut [&mut a, &mut b]);
    assert_eq!(
        b.r.store().tail_stats().unwrap(),
        crate::store::TailStats::default()
    );
    assert!(b.r.store().own_retained(0, 100).unwrap().is_empty());
    assert!(
        !a.r.store().tail(0, 100).unwrap().is_empty(),
        "other devices retain repair material"
    );
    assert!(!b.r.policy.devices[&B16([102; 16])].active);
    let reopened = node(&svc, 2, b.r.into_store());
    assert!(
        !reopened.r.policy.devices[&B16([102; 16])].active,
        "paired erasure must preserve durable revocation"
    );
}

#[test]
fn retained_void_and_read_ahead_control_keep_exact_head_bytes() {
    use crate::Store;
    use mdbn_wire::schema::Wire;
    let svc = FakeLogService::new();
    let mut a = node(&svc, 1, MemStore::new());
    settle(&mut [&mut a]);
    let seq = crate::testkit::TestControlPlane::new(COL).revoke(&svc, B16([109; 16]));
    let raw = svc.items(&COL)[seq as usize - 1].clone();
    a.r.evaluate_control_bytes(seq, &raw).unwrap();
    let before = a.r.head();
    assert!(a.r.policy.seq > before.seq);
    a.r.apply_items(vec![mdbn_wire::log_service::SeqItem {
        seq,
        item: mdbn_wire::common::Bytes(raw.clone()),
    }]);
    assert_eq!(a.r.store().tail(before.seq, 1).unwrap()[0].item, raw);
    assert_eq!(a.r.head().seq, seq);
    let mut item = mdbn_wire::envelope::Item::from_bytes(&svc.items(&COL)[1]).unwrap();
    item.kind = mdbn_wire::envelope::ItemKind::Entry;
    item.seq = Some(seq + 1);
    item.prev = Some(a.r.head_chain());
    item.epoch = Some(1);
    item.salt = Some(B16([0; 16]));
    item.idem = Some(B16([9; 16]));
    item.body = mdbn_wire::common::Bytes(Vec::new());
    let raw = item.to_bytes().unwrap();
    a.r.apply_items(vec![mdbn_wire::log_service::SeqItem {
        seq: seq + 1,
        item: mdbn_wire::common::Bytes(raw.clone()),
    }]);
    assert_eq!(a.r.head().seq, seq + 1);
    assert_eq!(a.r.stats.voided, 1);
    assert_eq!(a.r.store().tail(seq, 1).unwrap()[0].item, raw);
    assert!(a.r.retaining.is_none());
}

#[test]
fn create_propagates_and_confirms() {
    let svc = FakeLogService::new();
    let mut a = node(&svc, 1, MemStore::new());
    let mut b = node(&svc, 2, MemStore::new());
    settle(&mut [&mut a, &mut b]);
    let rc = a.create(10, "a.md", "hello");
    assert_eq!(rc.state, ReceiptState::Pending);
    assert_eq!(
        rc.records.as_ref().map(Vec::len),
        Some(1),
        "optimistic result"
    );
    settle(&mut [&mut a, &mut b]);
    assert_eq!(a.r.head().seq, BOOT + 1);
    assert_eq!(b.r.head().seq, BOOT + 1);
    assert_eq!(a.doc(10).as_deref(), Some("hello"));
    assert_eq!(b.doc(10).as_deref(), Some("hello"), "propagated");
    let pushes = a.r.take_pushes();
    assert!(pushes.iter().any(|(_, p)| matches!(p, Push::Receipt(r) if r.state == ReceiptState::Confirmed && r.seq == Some(BOOT + 1))));
    assert_eq!(b.r.stats.verified, 1, "B re-executed A's entry");
    assert_eq!(a.r.sync_status().pending, 0);
}

#[test]
fn first_valid_wins_on_a_path() {
    let svc = FakeLogService::new();
    let mut a = node(&svc, 1, MemStore::new());
    let mut b = node(&svc, 2, MemStore::new());
    settle(&mut [&mut a, &mut b]);
    // Both create at the same path before seeing each other.
    a.create(10, "same.md", "from a");
    b.create(20, "same.md", "from b");
    settle(&mut [&mut a, &mut b]);
    assert_eq!(a.r.head(), b.r.head(), "converged");
    let winners = [a.doc(10).is_some(), a.doc(20).is_some()];
    assert_eq!(
        winners.iter().filter(|w| **w).count(),
        1,
        "exactly one create landed"
    );
    let loser = if winners[0] { &mut b } else { &mut a };
    let pushes = loser.r.take_pushes();
    assert!(
        pushes.iter().any(
            |(_, p)| matches!(p, Push::Receipt(r) if r.state == ReceiptState::Rejected
            && r.problem.as_ref().is_some_and(|p| p.code == ErrorCode::Conflict.as_str()))
        ),
        "the loser's receipt is rejected with conflict"
    );
    assert_eq!(a.r.sync_status().pending + b.r.sync_status().pending, 0);
}

#[test]
fn concurrent_writers_interleave_without_loss() {
    let svc = FakeLogService::new();
    let mut a = node(&svc, 1, MemStore::new());
    let mut b = node(&svc, 2, MemStore::new());
    settle(&mut [&mut a, &mut b]);
    for i in 0..20u8 {
        a.create(i, &format!("a{i}.md"), "a");
        b.create(100 + i, &format!("b{i}.md"), "b");
        a.pump();
        b.pump();
    }
    settle(&mut [&mut a, &mut b]);
    assert_eq!(a.r.head().seq, BOOT + 40);
    assert_eq!(a.r.head(), b.r.head());
    assert_eq!(
        a.r.confirmed_records().unwrap(),
        b.r.confirmed_records().unwrap()
    );
    assert!(
        a.r.stats.head_moved + b.r.stats.head_moved > 0,
        "the race happened"
    );
}

#[test]
fn lost_reply_retries_same_bytes() {
    let svc = FakeLogService::new();
    let mut a = node(&svc, 1, MemStore::new());
    settle(&mut [&mut a]);
    a.log.faults.lose_replies = 1;
    a.create(1, "x.md", "x");
    a.pump();
    assert_eq!(svc.head(&COL).0, BOOT + 1, "committed at the service");
    // The subscription push may already have confirmed it (an applied item
    // carrying the mutation confirms it); either way it must not be appended twice.
    a.clock.set(a.clock.get() + 5_000);
    settle(&mut [&mut a]);
    assert_eq!(svc.head(&COL).0, BOOT + 1, "not appended twice");
    assert_eq!(a.r.sync_status().pending, 0);
    assert_eq!(a.doc(1).as_deref(), Some("x"));
}

#[test]
fn offline_submits_survive_restart() {
    let svc = FakeLogService::new();
    let store = MemStore::new();
    let data = store.data();
    let mut a = node(&svc, 1, store);
    a.log.faults.offline = true;
    a.create(1, "x.md", "x");
    a.create(2, "y.md", "y");
    settle(&mut [&mut a]);
    assert_eq!(a.r.sync_status().pending, 2);
    drop(a);
    let mut a = node(&svc, 1, MemStore::shared(data));
    assert_eq!(a.r.sync_status().pending, 2, "pending survived");
    settle(&mut [&mut a]);
    assert_eq!(a.r.sync_status().pending, 0);
    assert_eq!(svc.head(&COL).0, BOOT + 2);
}

#[test]
fn rebase_reflects_remote_changes() {
    let svc = FakeLogService::new();
    let mut a = node(&svc, 1, MemStore::new());
    let mut b = node(&svc, 2, MemStore::new());
    a.create(1, "x.md", "x");
    settle(&mut [&mut a, &mut b]);
    // B deletes it while A, offline, deletes it too.
    a.log.faults.offline = true;
    let _ =
        a.r.submit(
            a.s,
            SubmitParams {
                ops: vec![Op::Delete(Delete {
                    id: B16([1; 16]),
                    base_revision: None,
                    if_revision: None,
                })],
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
        .unwrap();
    let _ =
        b.r.submit(
            b.s,
            SubmitParams {
                ops: vec![Op::Delete(Delete {
                    id: B16([1; 16]),
                    base_revision: None,
                    if_revision: None,
                })],
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
        .unwrap();
    settle(&mut [&mut b]);
    a.log.faults.offline = false;
    a.r.on_log_push(crate::log::LogPush::Reconnected);
    settle(&mut [&mut a, &mut b]);
    assert_eq!(a.r.head(), b.r.head());
    assert!(a.doc(1).is_none() && b.doc(1).is_none());
    assert_eq!(
        a.r.sync_status().pending,
        0,
        "the redundant delete still confirms (a no-op entry)"
    );
}

#[test]
fn many_pending_submits() {
    let svc = FakeLogService::new();
    let mut a = node(&svc, 1, MemStore::new());
    a.log.faults.offline = true;
    for i in 0..2000u32 {
        let b = i.to_be_bytes();
        let id = [b[0], b[1], b[2], b[3], 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9];
        let r =
            a.r.submit(
                a.s,
                SubmitParams {
                    ops: vec![Op::Create(Create {
                        id: B16(id),
                        path: Some(format!("n{i}.md")),
                        type_name: None,
                        frontmatter: None,
                        body: Some(Text::Inline("x".into())),
                        document: None,
                    })],
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
            .unwrap();
        assert_eq!(r[0].state, ReceiptState::Pending);
    }
    a.log.faults.offline = false;
    a.r.on_log_push(crate::log::LogPush::Reconnected);
    settle(&mut [&mut a]);
    assert_eq!(a.r.sync_status().pending, 0);
    assert_eq!(svc.head(&COL).0, BOOT + 2000);
    let _ = CUuid([0; 16]);
}

#[test]
fn live_query_and_change_feed() {
    use mdbn_wire::client::{Include, UpdateKind};
    let svc = FakeLogService::new();
    let mut a = node(&svc, 1, MemStore::new());
    let mut b = node(&svc, 2, MemStore::new());
    settle(&mut [&mut a, &mut b]);
    let inc = Include {
        effective: None,
        body: None,
        document: None,
        diagnostics: None,
    };
    let sub =
        b.r.subscribe(b.s, mdbn_wire::common::Value::Map(vec![]), inc)
            .expect("subscribe");
    let feed = b.r.changes(b.s, None, None, false).unwrap();
    let first = b.r.take_pushes();
    assert!(first.iter().any(
        |(_, p)| matches!(p, Push::QueryUpdate(u) if u.sub == sub && u.kind == UpdateKind::Snapshot)
    ));
    a.create(10, "a.md", "hello");
    settle(&mut [&mut a, &mut b]);
    let pushes = b.r.take_pushes();
    assert!(
        pushes.iter().any(
            |(_, p)| matches!(p, Push::QueryUpdate(u) if u.kind == UpdateKind::Diff
            && u.added.as_ref().is_some_and(|v| v.len() == 1 && v[0].path == "a.md"))
        ),
        "{pushes:?}"
    );
    let ch = b.r.changes(b.s, Some(feed.cursor), None, false).unwrap();
    assert!(!ch.reset);
    assert!(ch.changes.iter().any(|c| c.path == "a.md"));
    let bad = b.r.changes(b.s, Some("1:1".into()), None, false).unwrap();
    assert!(bad.reset, "a cursor from another instance resets");
}

/// Live queries are capped per session (each is
/// re-run on every change); an unsubscribe frees a slot; other sessions are
/// unaffected.
#[test]
fn live_queries_are_capped_per_session() {
    use mdbn_wire::client::Include;
    const MAX_LIVE_SUBS_PER_SESSION: usize = 32;
    let svc = FakeLogService::new();
    let mut b = node(&svc, 2, MemStore::new());
    settle(&mut [&mut b]);
    let inc = || Include {
        effective: None,
        body: None,
        document: None,
        diagnostics: None,
    };
    let q = || mdbn_wire::common::Value::Map(vec![]);
    let subs: Vec<u64> = (0..MAX_LIVE_SUBS_PER_SESSION)
        .map(|_| b.r.subscribe(b.s, q(), inc()).expect("within the cap"))
        .collect();
    let over = b.r.subscribe(b.s, q(), inc()).unwrap_err();
    assert_eq!(over.problem().code, "too_large");
    assert_eq!(over.problem().reason.as_deref(), Some("subscription_limit"));
    b.r.unsubscribe(b.s, subs[0]).unwrap();
    assert!(b.r.subscribe(b.s, q(), inc()).is_ok());
}

/// A reconnect while an
/// append is in flight must resend the same bytes, and a reply to the earlier call
/// must never confirm a different batch.
#[test]
fn reconnect_during_append_never_misconfirms() {
    use crate::log::{LogClient, LogPush};
    let svc = FakeLogService::new();
    let mut a = node(&svc, 1, MemStore::new());
    settle(&mut [&mut a]);
    a.create(1, "one.md", "1");
    // The first append call, held by the "network".
    let first: Vec<_> = a.r.take_log_calls();
    assert!(
        first
            .iter()
            .any(|c| matches!(c.request, crate::log::LogRequest::Append(_)))
    );
    // The connection drops and comes back twice while it is outstanding.
    a.r.on_log_push(LogPush::Disconnected);
    a.r.on_log_push(LogPush::Reconnected);
    a.r.on_log_push(LogPush::Reconnected);
    // More writes arrive meanwhile.
    for i in 2..12u8 {
        a.create(i, &format!("n{i}.md"), "x");
    }
    // The re-subscribes are answered first; whatever the replica sends then is
    // collected too.
    let mut held = Vec::new();
    for _ in 0..3 {
        for c in a.r.take_log_calls() {
            if matches!(c.request, crate::log::LogRequest::Append(_)) {
                held.push(c);
            } else {
                let r = a.log.call(c.request);
                a.r.on_log_reply(c.id, r);
            }
        }
    }
    // Every append call carries the same one-item batch.
    for c in first.iter().chain(held.iter()) {
        if let crate::log::LogRequest::Append(p) = &c.request {
            assert_eq!(p.items.len(), 1, "no new batch while one is outstanding");
            assert_eq!(p.expect_seq, BOOT + 1);
        }
    }
    // The original call lands now and its reply arrives late.
    for c in first {
        let r = a.log.call(c.request);
        a.r.on_log_reply(c.id, r);
    }
    for c in held {
        let r = a.log.call(c.request);
        a.r.on_log_reply(c.id, r);
    }
    settle(&mut [&mut a]);
    assert_eq!(svc.head(&COL).0, BOOT + 11);
    assert_eq!(
        a.r.head().seq,
        BOOT + 11,
        "the head never runs ahead of the log"
    );
    assert_eq!(a.r.sync_status().pending, 0);
    let mut confirmed = 0;
    for (_, p) in a.r.take_pushes() {
        if let Push::Receipt(r) = p
            && r.state == ReceiptState::Confirmed
        {
            assert!(
                r.seq.is_some_and(|s| s <= BOOT + 11),
                "confirmed at a real position"
            );
            confirmed += 1;
        }
    }
    assert_eq!(confirmed, 11);
}

/// Unsafe paths are rejected at submit and void at apply.
#[test]
fn unsafe_paths_rejected_and_void() {
    use crate::log::{LogClient, LogRequest};
    use mdbn_wire::common::{B32, B64, Bytes};
    use mdbn_wire::entry::{Effect as WE, EntryPayload, PutRecord, Status};
    use mdbn_wire::envelope::{Item, ItemKind};
    use mdbn_wire::intent::{Mutation, OpClock, Source};
    use mdbn_wire::schema::Wire;

    let svc = FakeLogService::new();
    let mut a = node(&svc, 1, MemStore::new());
    settle(&mut [&mut a]);
    let r = a.create(1, ".obsidian/plugins/x/main.md", "evil");
    assert_eq!(r.state, ReceiptState::Rejected);
    assert_eq!(
        r.problem.as_ref().and_then(|p| p.reason.as_deref()),
        Some("unsafe_path")
    );

    // A malicious writer appends an entry whose effect writes an unsafe path.
    let m = Mutation {
        id: B16([9; 16]),
        origin: B16([66; 16]),
        base_seq: 0,
        clock: OpClock {
            instant: 1,
            tz: "UTC".into(),
            local_date: "1970-01-01".into(),
        },
        seed: B32([0; 32]),
        source: Source::Api,
        ops: vec![Op::Create(Create {
            id: B16([9; 16]),
            path: Some("C:evil.md".into()),
            type_name: None,
            frontmatter: None,
            body: None,
            document: Some(Text::Inline("x".into())),
        })],
        on_behalf: None,
        conflict_mode: None,
        validated_at: None,
        room: None,
    };
    let payload = EntryPayload {
        resurrect: None,
        sem: Version { major: 1, minor: 0 },
        mutation: m,
        status: Status::Applied,
        effects: vec![WE::PutRecord(PutRecord {
            id: B16([9; 16]),
            path: "C:evil.md".into(),
            doc: Text::Inline("x".into()),
        })],
        conflicts: None,
        aliases: None,
        texts: None,
    };
    let (seq, prev) = svc.head(&COL);
    let item = Item {
        kind: ItemKind::Entry,
        collection: COL,
        seq: Some(seq + 1),
        prev: Some(prev),
        epoch: Some(1),
        signer: Some(B16([66; 16])),
        salt: Some(B16([0; 16])),
        idem: Some(B16([9; 16])),
        refs: None,
        stream: None,
        body: Bytes(payload.to_bytes().unwrap()),
        sig: Some(B64([0; 64])),
    };
    let mut evil = svc.client(B16([66; 16]));
    evil.call(LogRequest::Append(mdbn_wire::log_service::AppendParams {
        collection: COL,
        expect_seq: seq + 1,
        expect_prev: prev,
        items: vec![Bytes(item.to_bytes().unwrap())],
    }))
    .unwrap();
    a.r.on_log_push(crate::log::LogPush::Head {
        collection: COL,
        head: seq + 1,
        head_chain: B32([0; 32]),
    });
    settle(&mut [&mut a]);
    assert_eq!(
        a.r.head().seq,
        seq + 1,
        "the void item still advances the head"
    );
    assert!(a.doc(9).is_none(), "nothing applied");
    assert_eq!(a.r.stats.voided, 1);
}

#[test]
fn snapshot_build_install_and_endorse() {
    snapshot_build_install(MemStore::new());
}

/// A store without a staging area: the install stages rows in memory instead.
#[test]
fn snapshot_install_without_a_staging_store() {
    snapshot_build_install(MemStore::new().without_staging());
}

fn snapshot_build_install(b_store: MemStore) {
    let svc = FakeLogService::new();
    let mut a = node(&svc, 1, MemStore::new());
    for i in 0..30u8 {
        a.create(i, &format!("n{i}.md"), &format!("doc {i}"));
    }
    settle(&mut [&mut a]);
    assert_eq!(a.r.head().seq, BOOT + 30);
    a.r.build_snapshot_now().unwrap();
    settle(&mut [&mut a]);
    assert_eq!(a.r.stats.snapshots_built, 1);
    // More entries after the snapshot, then compact everything below it.
    for i in 30..35u8 {
        a.create(i, &format!("n{i}.md"), &format!("doc {i}"));
    }
    settle(&mut [&mut a]);
    svc.compact(&COL, BOOT + 30);
    // A new replica cannot read from 1: it installs the snapshot and reads the tail.
    let mut b = node(&svc, 2, b_store);
    settle(&mut [&mut a, &mut b]);
    assert_eq!(b.r.stats.snapshots_installed, 1);
    assert_eq!(b.r.head(), a.r.head());
    assert_eq!(
        b.r.confirmed_records().unwrap(),
        a.r.confirmed_records().unwrap()
    );
    assert_eq!(
        crate::replica::state_digest(b.r.store()).unwrap(),
        crate::replica::state_digest(a.r.store()).unwrap()
    );
    assert_eq!(b.r.sync_status().incidents, vec![]);
}

#[test]
fn endorsement_requires_matching_state() {
    let svc = FakeLogService::new();
    let mut a = node(&svc, 1, MemStore::new());
    let mut b = node(&svc, 2, MemStore::new());
    a.create(1, "x.md", "x");
    settle(&mut [&mut a, &mut b]);
    a.r.build_snapshot_now().unwrap();
    settle(&mut [&mut a, &mut b]);
    b.r.check_snapshots();
    settle(&mut [&mut a, &mut b]);
    let mut c = a.log.service().client(B16([9; 16]));
    let r = mdbn_replica_get_snapshot(&mut c);
    assert!(r.iter().any(|p| p.endorsed), "B endorsed A's snapshot");
}

fn mdbn_replica_get_snapshot(c: &mut FakeLog) -> Vec<mdbn_wire::log_service::SnapshotPointer> {
    use crate::log::{LogClient, LogRequest, LogResponse};
    match c.call(LogRequest::GetSnapshot { collection: COL }) {
        Ok(LogResponse::GetSnapshot(v)) => v,
        other => panic!("{other:?}"),
    }
}

/// A crash in the middle of a staged install: what was staged survives in the
/// store, the reopened replica still shows its complete previous state, never
/// consumes the leftovers, discarded first, installs from the start
/// and swaps atomically, leaving the staging area empty.
#[test]
fn a_restart_mid_install_keeps_prior_state_and_installs_cleanly() {
    let svc = FakeLogService::new();
    let mut a = node(&svc, 1, MemStore::new());
    let mut b = node(&svc, 2, MemStore::new());
    for i in 0..10u8 {
        a.create(i, &format!("n{i}.md"), &format!("doc {i}"));
    }
    settle(&mut [&mut a, &mut b]);
    let Node { r, .. } = b;
    let data = r.into_store().data();
    for i in 10..30u8 {
        a.create(i, &format!("n{i}.md"), &format!("doc {i}"));
    }
    settle(&mut [&mut a]);
    a.r.build_snapshot_now().unwrap();
    settle(&mut [&mut a]);
    svc.compact(&COL, BOOT + 30);
    let mut b = node(&svc, 2, MemStore::shared(data.clone()));
    for _ in 0..400 {
        pump(&mut b.r, &mut b.log, 1);
        b.r.tick();
        if b.r.installing() && b.r.store().staged_rows() > 0 {
            break;
        }
    }
    assert!(b.r.installing() && b.r.store().staged_rows() > 0);
    drop(b); // crash between chunks

    let mut b = node(&svc, 2, MemStore::shared(data));
    assert!(b.r.store().staged_rows() > 0, "staging is durable");
    assert_eq!(b.r.head().seq, BOOT + 10, "prior head");
    assert_eq!(b.r.confirmed_records().unwrap().len(), 10, "prior state");
    settle(&mut [&mut a, &mut b]);
    assert_eq!(b.r.stats.snapshots_installed, 1);
    assert_eq!(b.r.store().staged_rows(), 0);
    assert_eq!(b.r.head(), a.r.head());
    assert_eq!(
        b.r.confirmed_records().unwrap(),
        a.r.confirmed_records().unwrap()
    );
    assert_eq!(b.r.sync_status().incidents, vec![]);
}

// ---- Snapshot-install regressions ----

/// A malicious service answers `behind` to a caught-up replica and serves its older
/// retained snapshot. The replica must not go below its own head.
#[test]
fn sec2_poc_behind_rolls_back_a_caught_up_replica() {
    let svc = FakeLogService::new();
    let mut a = node(&svc, 1, MemStore::new());
    let mut b = node(&svc, 2, MemStore::new());
    for i in 0..30u8 {
        a.create(i, &format!("n{i}.md"), &format!("doc {i}"));
    }
    settle(&mut [&mut a, &mut b]);
    a.r.build_snapshot_now().unwrap();
    settle(&mut [&mut a, &mut b]);
    for i in 30..35u8 {
        a.create(i, &format!("n{i}.md"), &format!("doc {i}"));
    }
    settle(&mut [&mut a, &mut b]);
    assert_eq!(a.r.head().seq, BOOT + 35);
    let before = a.r.confirmed_records().unwrap().len();
    assert_eq!(before, 35);
    // The service lies: it claims everything up to 40 is compacted.
    let Node { r, .. } = a;
    let store = r.into_store();
    b.create(200, "b.md", "from b");
    for _ in 0..5 {
        b.pump();
        b.r.tick();
    }
    let r_store = store;
    let mut a = node(&svc, 1, r_store);
    a.log.faults.lie_behind = 1;
    let mut min_head = a.r.head().seq;
    let mut min_records = before;
    for _ in 0..40 {
        b.pump();
        b.r.tick();
        pump(&mut a.r, &mut a.log, 1);
        a.r.tick();
        min_head = min_head.min(a.r.head().seq);
        min_records = min_records.min(a.r.confirmed_records().unwrap().len());
    }
    let integrity =
        a.r.sync_status()
            .incidents
            .iter()
            .any(|i| i.kind == mdbn_wire::client::IncidentKind::Integrity);
    eprintln!(
        "PoC1: head 35 -> min {min_head}; confirmed records 35 -> min {min_records}; installs {}; integrity incident: {integrity}",
        a.r.stats.snapshots_installed
    );
    assert!(
        min_head >= BOOT + 35 && min_records >= 35,
        "replica went below its own head (to {min_head}, {min_records} records)"
    );
}

/// A replica genuinely behind retention installs off to the side: while chunks are
/// fetched (and when a fetch fails) its previous confirmed state and head stay
/// intact, a transient failure resumes the install, and the swap is atomic.
#[test]
fn install_is_staged_and_survives_a_failed_fetch() {
    let svc = FakeLogService::new();
    let mut a = node(&svc, 1, MemStore::new());
    let mut b = node(&svc, 2, MemStore::new());
    for i in 0..10u8 {
        a.create(i, &format!("n{i}.md"), &format!("doc {i}"));
    }
    settle(&mut [&mut a, &mut b]);
    assert_eq!(b.r.head().seq, BOOT + 10);
    // B goes away; A writes on, snapshots and compacts past B.
    let Node { r, .. } = b;
    let b_store = r.into_store();
    for i in 10..30u8 {
        a.create(i, &format!("n{i}.md"), &format!("doc {i}"));
    }
    settle(&mut [&mut a]);
    a.r.build_snapshot_now().unwrap();
    settle(&mut [&mut a]);
    svc.compact(&COL, BOOT + 30);
    let mut b = node(&svc, 2, b_store);
    let mut failed = false;
    let mut staged_max = 0;
    for _ in 0..400 {
        if b.r.installing() && !failed {
            // Fail the next call once installing, whatever step it is.
            b.log.faults.fail_next = Some(crate::log::LogErrorCode::RateLimited);
            pump(&mut b.r, &mut b.log, 1);
            failed = true;
            assert_eq!(b.r.head().seq, BOOT + 10, "head unchanged while staging");
            assert_eq!(
                b.r.confirmed_records().unwrap().len(),
                10,
                "old state intact"
            );
        }
        pump(&mut b.r, &mut b.log, 1);
        b.r.tick();
        if b.r.installing() {
            assert!(
                b.r.confirmed_records().unwrap().len() == 10,
                "never a partial confirmed state"
            );
            // Bounded memory: rows go to the store's staging area chunk by chunk;
            // the replica holds none of them.
            assert!(b.r.install_staged.records_put.is_empty());
            staged_max = staged_max.max(b.r.store().staged_rows());
        }
    }
    assert!(staged_max > 0, "rows were staged in the store");
    assert_eq!(
        b.r.store().staged_rows(),
        0,
        "the swap emptied the staging area"
    );
    assert!(failed, "the install was exercised");
    assert_eq!(
        b.r.stats.snapshots_installed, 1,
        "the install resumed and finished"
    );
    assert_eq!(b.r.head(), a.r.head());
    assert_eq!(
        b.r.confirmed_records().unwrap(),
        a.r.confirmed_records().unwrap()
    );
}

/// Install cleanup cannot mutate a terminally faulted store.
#[test]
fn failed_control_read_requires_reopen_without_staging_cleanup_commit() {
    use crate::store::{Stage, Store, Tx};
    let svc = FakeLogService::new();
    let mut a = node(&svc, 1, MemStore::new());
    a.create(1, "confirmed.md", "confirmed");
    settle(&mut [&mut a]);
    let mut stale = a.r.store().record(&B16([1; 16])).unwrap().unwrap();
    stale.id = B16([90; 16]);
    stale.path = "staged.md".into();
    stale.path_key = "staged.md".into();
    a.r.store_mut()
        .commit(Tx {
            stage: Stage::Put,
            records_put: vec![stale],
            ..Tx::default()
        })
        .unwrap();
    let before = a.r.store().data().borrow().commits;
    let head = a.r.head();
    let seq = crate::testkit::TestControlPlane::new(COL).revoke(&svc, B16([109; 16]));
    a.r.install = Some(crate::replica::TestInstall::Control);
    a.r.store().fail_after_commit(1);
    a.r.on_install_reply(Ok(crate::log::LogResponse::Read(
        mdbn_wire::log_service::ReadResult {
            items: vec![mdbn_wire::log_service::SeqItem {
                seq,
                item: mdbn_wire::common::Bytes(svc.items(&COL)[seq as usize - 1].clone()),
            }],
            head: seq,
            head_chain: svc.head(&COL).1,
            retained_from: 1,
            behind: false,
            snapshot: None,
            more: false,
        },
    )));
    assert!(a.r.requires_reopen());
    assert_eq!(a.r.head(), head);
    assert_eq!(
        a.r.store().data().borrow().commits,
        before + 1,
        "terminal control failure must not commit staging cleanup afterward"
    );
    assert_eq!(
        a.r.store().staged_rows(),
        1,
        "staging evidence remains for durable reopen"
    );
    assert!(a.r.take_log_calls().is_empty());
    a.r.tick();
    assert_eq!(a.r.store().data().borrow().commits, before + 1);
    assert!(
        a.r.take_pushes()
            .iter()
            .all(|(_, p)| matches!(p, Push::Closed(_)))
    );
    let reopened = node(&svc, 1, a.r.into_store());
    assert!(!reopened.r.requires_reopen());
    assert!(!reopened.r.policy.devices[&B16([109; 16])].active);
    assert_eq!(reopened.r.store().staged_rows(), 1);
}

/// Failed cleanup and a crash cannot let old staged rows enter a new
/// snapshot whose digest authenticates only the new rows.
#[test]
fn failed_staging_discard_blocks_install_until_retry() {
    use crate::store::{AliasRow, ReceiptRow, Stage, Store, Tx};
    let svc = FakeLogService::new();
    let mut a = node(&svc, 1, MemStore::new());
    let mut b = node(&svc, 2, MemStore::new());
    a.create(1, "old.md", "confirmed");
    settle(&mut [&mut a, &mut b]);
    let old_head = b.r.head();
    let old_records = b.r.confirmed_records().unwrap();
    let stale_id = B16([90; 16]);
    let mut stale = b.r.store().record(&B16([1; 16])).unwrap().unwrap();
    stale.id = stale_id;
    stale.path = "stale.md".into();
    stale.path_key = "stale.md".into();
    b.r.store_mut()
        .commit(Tx {
            stage: Stage::Put,
            records_put: vec![stale],
            aliases_put: vec![AliasRow {
                path_key: "stale-alias.md".into(),
                path: "stale-alias.md".into(),
                record: stale_id,
            }],
            receipts_put: vec![ReceiptRow {
                mutation: stale_id,
                seq: 1,
                time: 0,
            }],
            ..Tx::default()
        })
        .unwrap();
    // An aborted install A fails to discard its staged rows.
    b.r.install = Some(crate::replica::TestInstall::Pointer);
    b.r.store().fail_commits(1);
    b.r.on_install_reply(Ok(crate::log::LogResponse::GetSnapshot(vec![])));
    assert_eq!(b.r.store().staged_rows(), 1);
    assert_eq!(b.r.head(), old_head);
    assert_eq!(b.r.confirmed_records().unwrap(), old_records);
    let b_store = b.r.into_store();
    for i in 2..5u8 {
        a.create(i, &format!("n{i}.md"), "new");
    }
    settle(&mut [&mut a]);
    a.r.build_snapshot_now().unwrap();
    settle(&mut [&mut a]);
    svc.compact(&COL, a.r.head().seq);
    // Crash/reopen retains A's staging, but not the replica's digest index.
    let mut b = node(&svc, 2, b_store);
    let mut blocked = false;
    for _ in 0..100 {
        if matches!(b.r.install, Some(crate::replica::TestInstall::Chain(_, _))) {
            b.r.store().fail_commits(1);
            pump(&mut b.r, &mut b.log, 1);
            assert!(matches!(
                b.r.install,
                Some(crate::replica::TestInstall::Reset(_))
            ));
            assert!(
                b.r.take_log_calls().is_empty(),
                "no chunks queued before discard succeeds"
            );
            assert_eq!(b.r.stats.snapshots_installed, 0);
            assert_eq!(b.r.head(), old_head);
            assert_eq!(b.r.confirmed_records().unwrap(), old_records);
            assert_eq!(b.r.store().staged_rows(), 1);
            // A second failure on retry must still leave confirmed state untouched.
            b.r.store().fail_commits(1);
            b.r.tick();
            assert!(matches!(
                b.r.install,
                Some(crate::replica::TestInstall::Reset(_))
            ));
            assert_eq!(b.r.head(), old_head);
            assert_eq!(b.r.confirmed_records().unwrap(), old_records);
            blocked = true;
            break;
        }
        pump(&mut b.r, &mut b.log, 1);
        b.r.tick();
    }
    assert!(
        blocked,
        "failed B's initial discard after A's cleanup failure and reopen"
    );
    settle(&mut [&mut b]);
    assert_eq!(b.r.stats.snapshots_installed, 1);
    assert_eq!(b.r.head(), a.r.head());
    assert_eq!(
        b.r.confirmed_records().unwrap(),
        a.r.confirmed_records().unwrap()
    );
    assert!(b.r.store().record(&stale_id).unwrap().is_none());
    assert!(b.r.store().alias("stale-alias.md").unwrap().is_none());
    assert!(b.r.store().receipt(&stale_id).unwrap().is_none());
    assert_eq!(b.r.store().staged_rows(), 0);
}

// ---- policy and keyring wiring ----

/// A revocation puts the log into rekey-required: the writer rekeys first, and
/// content from the revoked device is void.
#[test]
fn revocation_forces_a_rekey_before_content() {
    let svc = FakeLogService::new();
    let mut a = node(&svc, 1, MemStore::new());
    let mut b = node(&svc, 2, MemStore::new());
    settle(&mut [&mut a, &mut b]);
    let revoked = B16([109; 16]);
    let at = crate::testkit::TestControlPlane::new(COL).revoke(&svc, revoked);
    a.create(1, "after.md", "x");
    settle(&mut [&mut a, &mut b]);
    let items = svc.items(&COL);
    let kind = |i: usize| {
        use mdbn_wire::schema::Wire;
        mdbn_wire::envelope::Item::from_bytes(&items[i])
            .unwrap()
            .kind
    };
    let at = usize::try_from(at).unwrap();
    assert_eq!(
        kind(at),
        mdbn_wire::envelope::ItemKind::Rekey,
        "the next item is the rekey"
    );
    assert_eq!(kind(at + 1), mdbn_wire::envelope::ItemKind::Entry);
    assert_eq!(a.r.policy.epoch, 2);
    assert!(!a.r.policy.rekey_required);
    assert_eq!(
        b.doc(1).as_deref(),
        Some("x"),
        "B was rewrapped and reads the new epoch"
    );
    assert_eq!(a.r.head(), b.r.head());
}

/// A key delivered by a device this user never approved is not used:
/// the device keeps its writes pending and reports it.
#[test]
fn untrusted_key_is_not_used_for_writing() {
    let svc = FakeLogService::new();
    let mut a = node(&svc, 1, MemStore::new());
    let mut b = node_with(&svc, 2, MemStore::new(), vec![], None);
    settle(&mut [&mut a, &mut b]);
    b.create(1, "b.md", "from b");
    settle(&mut [&mut a, &mut b]);
    assert_eq!(
        b.r.sync_status().pending,
        1,
        "B must not append under an untrusted key"
    );
    assert!(
        b.r.sync_status()
            .incidents
            .iter()
            .any(|i| i.kind == mdbn_wire::client::IncidentKind::KeyInconsistent)
    );
    // It still reads.
    a.create(2, "a.md", "from a");
    settle(&mut [&mut a, &mut b]);
    assert_eq!(b.doc(2).as_deref(), Some("from a"));
}

fn sec047_app_hello() -> HelloParams {
    HelloParams {
        versions: vec![Version { major: 1, minor: 0 }],
        client_name: "account-bound app".into(),
        client_version: "0".into(),
        features: None,
        timezone: None,
    }
}

fn sec047_member_nodes() -> (FakeLogService, Node, Node) {
    use crate::testkit::{TEST_OWNER, TestControlPlane, TestDevice};
    use mdbn_wire::policy::{CState, DeviceKind};
    let svc = FakeLogService::new();
    let mut cp = TestControlPlane::new(COL);
    cp.genesis(
        &svc,
        CState::E2e,
        &[
            TestDevice {
                device: B16([101; 16]),
                account: TEST_OWNER,
                kind: DeviceKind::Desktop,
            },
            TestDevice {
                device: B16([102; 16]),
                account: B16([0xb0; 16]),
                kind: DeviceKind::Desktop,
            },
        ],
    );
    let mut a = node(&svc, 1, MemStore::new());
    settle(&mut [&mut a]);
    assert_eq!(a.r.policy.epoch, 1);
    // Initial rekey wraps only the owner's account in e2e. The owner explicitly
    // approves the other member's device, so V1 and key acquisition are valid.
    use mdbn_wire::common::{B32, Bytes};
    use mdbn_wire::envelope::{ItemKind, KeyGrantPayload, KeyWrap};
    use mdbn_wire::schema::Wire;
    cp.append_item(
        &svc,
        ItemKind::KeyGrant,
        B16([101; 16]),
        KeyGrantPayload {
            recipient: B16([102; 16]),
            epoch: 1,
            wrap: KeyWrap {
                device: B16([102; 16]),
                enc: B32([0; 32]),
                ct: Bytes(vec![0; 48]),
            },
        }
        .to_bytes()
        .unwrap(),
    );
    let mut b = node(&svc, 2, MemStore::new());
    settle(&mut [&mut a, &mut b]);
    assert_eq!(b.r.policy.epoch, 1);
    assert!(b.r.policy.devices[&B16([102; 16])].keyed);
    (svc, a, b)
}

#[test]
fn hello_binds_grant_to_serving_device_account() {
    let (svc, mut a, mut b) = sec047_member_nodes();
    let gid = B16([0x55; 16]);
    let mut cp = crate::testkit::TestControlPlane::new(COL);
    cp.approved_grant(
        &svc,
        gid,
        [0x57; 32],
        &["collection.read", "records.create"],
        None,
        B16([101; 16]),
    );
    settle(&mut [&mut a, &mut b]);
    let auth = || SessionAuth::Grant {
        grant: gid,
        client_pk: [0x57; 32],
    };
    assert_eq!(
        b.r.hello(auth(), sec047_app_hello()).unwrap_err().code(),
        Some(ErrorCode::Forbidden)
    );
    let (s, _) =
        a.r.hello(auth(), sec047_app_hello())
            .expect("own account's grant");
    assert!(a.r.describe(s).is_ok());
    cp.revoke(&svc, B16([101; 16]));
    settle(&mut [&mut a, &mut b]);
    assert_eq!(
        a.r.describe(s).unwrap_err().code(),
        Some(ErrorCode::Forbidden),
        "existing sessions recheck the serving device"
    );
    assert_eq!(
        a.r.hello(auth(), sec047_app_hello()).unwrap_err().code(),
        Some(ErrorCode::Forbidden)
    );
}

#[test]
fn only_hosted_cloud_copy_can_serve_another_accounts_grant() {
    use crate::testkit::{TEST_OWNER, TestControlPlane, TestDevice};
    use mdbn_wire::policy::{CState, DeviceKind};
    let svc = FakeLogService::new();
    let mut cp = TestControlPlane::new(COL);
    cp.genesis(
        &svc,
        CState::CloudCopy,
        &[
            TestDevice {
                device: B16([101; 16]),
                account: TEST_OWNER,
                kind: DeviceKind::Desktop,
            },
            TestDevice {
                device: B16([102; 16]),
                account: crate::policy::SERVICE_ACCOUNT,
                kind: DeviceKind::Hosted,
            },
            TestDevice {
                device: B16([103; 16]),
                account: crate::policy::SERVICE_ACCOUNT,
                kind: DeviceKind::Escrow,
            },
        ],
    );
    let mut a = node(&svc, 1, MemStore::new());
    a.r.cfg.user_enabled_cloud_copy = true;
    settle(&mut [&mut a]);
    let mut hosted = node(&svc, 2, MemStore::new());
    hosted.r.cfg.user_enabled_cloud_copy = true;
    let mut escrow = node(&svc, 3, MemStore::new());
    escrow.r.cfg.user_enabled_cloud_copy = true;
    cp.approved_grant(
        &svc,
        B16([0x55; 16]),
        [0x57; 32],
        &["collection.read"],
        None,
        B16([101; 16]),
    );
    settle(&mut [&mut a, &mut hosted, &mut escrow]);
    let auth = || SessionAuth::Grant {
        grant: B16([0x55; 16]),
        client_pk: [0x57; 32],
    };
    assert!(hosted.r.hello(auth(), sec047_app_hello()).is_ok());
    assert_eq!(
        escrow
            .r
            .hello(auth(), sec047_app_hello())
            .unwrap_err()
            .code(),
        Some(ErrorCode::Forbidden)
    );
}

/// Cloud-copy genesis enrolling `members` (editors other than the owner become
/// editors), the hosted replica (102) and the escrow (103). No initial rekey.
fn cloud_copy_genesis(
    svc: &FakeLogService,
    members: &[(u8, B16, mdbn_wire::policy::DeviceKind)],
) -> crate::testkit::TestControlPlane {
    use crate::testkit::{TestControlPlane, TestDevice};
    use mdbn_wire::policy::{CState, DeviceKind};
    let mut devices: Vec<TestDevice> = members
        .iter()
        .map(|(d, account, kind)| TestDevice {
            device: B16([*d; 16]),
            account: *account,
            kind: *kind,
        })
        .collect();
    for (d, kind) in [(102u8, DeviceKind::Hosted), (103, DeviceKind::Escrow)] {
        devices.push(TestDevice {
            device: B16([d; 16]),
            account: crate::policy::SERVICE_ACCOUNT,
            kind,
        });
    }
    let mut cp = TestControlPlane::new(COL);
    cp.genesis(svc, CState::CloudCopy, &devices);
    cp
}

/// Node `n` performs the initial rekey; the devices it keyed.
fn initial_rekey_by(svc: &FakeLogService, n: u8) -> Vec<u8> {
    let mut node = node(svc, n, MemStore::new());
    node.r.cfg.user_enabled_cloud_copy = true;
    settle(&mut [&mut node]);
    assert_eq!(node.r.policy.epoch, 1);
    node.r
        .policy
        .devices
        .iter()
        .filter(|(_, d)| d.keyed)
        .map(|(id, _)| id.0[0])
        .collect()
}

const OTHER: B16 = B16([0xb0; 16]);

/// For sealed-envelope §7.1 (policy.md §9), an Owner's desktop
/// keys the whole cloud copy in its initial rekey: every active desktop, the hosted
/// replica and the escrow. No escrow-to-hosted wrap.
#[test]
fn owner_desktops_initial_cloud_copy_rekey_keys_all_desktops_hosted_and_escrow() {
    use crate::testkit::TEST_OWNER;
    use mdbn_wire::policy::DeviceKind::{Desktop, Mobile};
    let svc = FakeLogService::new();
    cloud_copy_genesis(
        &svc,
        &[
            (101, TEST_OWNER, Desktop),
            (105, TEST_OWNER, Desktop),
            (104, OTHER, Desktop),
            (106, TEST_OWNER, Mobile),
        ],
    );
    assert_eq!(initial_rekey_by(&svc, 1), vec![101, 102, 103, 104, 105]);
}

/// Another member's editor desktop may sign the initial rekey: it keys itself, the
/// escrow and hosted (required in cloud copy), but not the owner's devices.
#[test]
fn a_non_owners_initial_cloud_copy_rekey_keys_itself_and_the_services() {
    use crate::testkit::TEST_OWNER;
    use mdbn_wire::policy::DeviceKind::Desktop;
    let svc = FakeLogService::new();
    cloud_copy_genesis(&svc, &[(101, TEST_OWNER, Desktop), (104, OTHER, Desktop)]);
    assert_eq!(initial_rekey_by(&svc, 4), vec![102, 103, 104]);
}

/// Only a desktop of the Owner keys the other desktops; the Owner's CLI device keys
/// itself and the services.
#[test]
fn an_owners_non_desktop_device_keys_only_itself_and_the_services() {
    use crate::testkit::TEST_OWNER;
    use mdbn_wire::policy::DeviceKind::{Cli, Desktop};
    let svc = FakeLogService::new();
    cloud_copy_genesis(&svc, &[(101, TEST_OWNER, Cli), (104, OTHER, Desktop)]);
    assert_eq!(initial_rekey_by(&svc, 1), vec![101, 102, 103]);
}

/// The current signed Owner role decides, not the genesis creator: after a transfer
/// the new Owner's desktop keys every desktop; the creator's (now Editor) does not.
#[test]
fn after_an_owner_transfer_the_current_owners_desktop_keys_every_desktop() {
    use crate::testkit::TEST_OWNER;
    use mdbn_wire::policy::DeviceKind::Desktop;
    use mdbn_wire::policy::{MemberSet, PolicyOp, Role};
    let transfer = |svc: &FakeLogService| {
        let mut cp = cloud_copy_genesis(svc, &[(101, TEST_OWNER, Desktop), (104, OTHER, Desktop)]);
        cp.append(
            svc,
            vec![
                PolicyOp::MemberSet(MemberSet {
                    account: OTHER,
                    role: Role::Owner,
                }),
                PolicyOp::MemberSet(MemberSet {
                    account: TEST_OWNER,
                    role: Role::Editor,
                }),
            ],
        );
    };
    let svc = FakeLogService::new();
    transfer(&svc);
    assert_eq!(
        initial_rekey_by(&svc, 1),
        vec![101, 102, 103],
        "the creator, now Editor"
    );
    let svc = FakeLogService::new();
    transfer(&svc);
    assert_eq!(
        initial_rekey_by(&svc, 4),
        vec![101, 102, 103, 104],
        "the new Owner"
    );
}

/// Service-created cloud copy scenario: hosted (102) is the first member
/// and keys hosted and escrow (103); when the account's desktop (101) is enrolled,
/// hosted wraps the current key to it, and that desktop can then decrypt.
#[test]
fn hosted_keys_a_service_created_cloud_copy_and_grants_a_joining_desktop() {
    use crate::testkit::{TEST_OWNER, TestDevice};
    use mdbn_wire::policy::DeviceKind;
    let svc = FakeLogService::new();
    let mut cp = cloud_copy_genesis(&svc, &[]);
    assert_eq!(initial_rekey_by(&svc, 2), vec![102, 103]);
    cp.enrol(
        &svc,
        TestDevice {
            device: B16([101; 16]),
            account: TEST_OWNER,
            kind: DeviceKind::Desktop,
        },
    );
    let mut hosted = node(&svc, 2, MemStore::new());
    hosted.r.cfg.user_enabled_cloud_copy = true;
    settle(&mut [&mut hosted]);
    assert!(hosted.r.policy.devices[&B16([101; 16])].keyed);
    assert_eq!(
        hosted.r.policy.devices[&B16([101; 16])].delivered_by,
        Some(B16([102; 16]))
    );
    let mut desktop = node(&svc, 1, MemStore::new());
    desktop.r.cfg.user_enabled_cloud_copy = true;
    settle(&mut [&mut desktop, &mut hosted]);
    assert_eq!(desktop.r.policy.epoch, 1);
    assert!(desktop.r.policy.devices[&B16([101; 16])].keyed);
}

/// An account device enrolled before hosted bootstraps (and offline)
/// does not stall a service-created cloud copy: hosted keys it in its initial rekey.
#[test]
fn hosted_keys_an_account_device_enrolled_before_bootstrap() {
    use crate::testkit::TEST_OWNER;
    use mdbn_wire::policy::DeviceKind::Desktop;
    let svc = FakeLogService::new();
    cloud_copy_genesis(&svc, &[(101, TEST_OWNER, Desktop)]);
    assert_eq!(initial_rekey_by(&svc, 2), vec![101, 102, 103]);
}

#[test]
fn apply_voids_a_members_entry_on_another_accounts_grant() {
    use crate::log::{LogClient, LogRequest};
    use mdbn_wire::entry::EntryPayload;
    use mdbn_wire::envelope::Item;
    use mdbn_wire::schema::Wire;
    let (svc, mut a, mut b) = sec047_member_nodes();
    let gid = B16([0x55; 16]);
    crate::testkit::TestControlPlane::new(COL).approved_grant(
        &svc,
        gid,
        [0x57; 32],
        &["collection.read", "records.create"],
        None,
        B16([101; 16]),
    );
    settle(&mut [&mut a, &mut b]);
    let before = a.r.head().seq;
    assert_eq!(a.r.stats.voided, 0);
    b.create(99, "forged-author.md", "cannot write as another account");
    let calls = b.r.take_log_calls();
    assert_eq!(calls.len(), 1);
    for mut call in calls {
        let LogRequest::Append(ref mut params) = call.request else {
            panic!("expected append")
        };
        assert_eq!(params.items.len(), 1);
        let mut item = Item::from_bytes(&params.items[0].0).unwrap();
        assert_eq!(item.signer, Some(B16([102; 16])));
        // PlainSealer/ZeroVerifier let the malicious member alter its own signed
        // payload; V1/V2 remain valid. Only V6 binds its signer to this grant.
        let mut payload = EntryPayload::from_bytes(&item.body.0).unwrap();
        payload.mutation.on_behalf = Some(gid);
        item.body.0 = payload.to_bytes().unwrap();
        params.items[0].0 = item.to_bytes().unwrap();
        let result = b.log.call(call.request);
        b.r.on_log_reply(call.id, result);
    }
    settle(&mut [&mut a]);
    assert_eq!(a.r.head().seq, before + 1, "void still advances the chain");
    assert_eq!(a.r.stats.voided, 1);
    assert_eq!(
        a.doc(99),
        None,
        "forged authorship has no persisted effects"
    );
    let r = a.create(100, "honest.md", "still flows");
    settle(&mut [&mut a]);
    assert_eq!(
        a.r.receipt(a.s, r.mutation).unwrap().state,
        ReceiptState::Confirmed
    );
}

#[test]
fn host_trust_validation_requires_local_persisted_synced_choices() {
    use mdbn_wire::client::SyncMode;
    use mdbn_wire::policy::CState;
    let svc = FakeLogService::new();
    let a = node(&svc, 1, MemStore::new());
    let mut cfg = a.r.config().clone();
    assert!(
        cfg.validate_host_trust().is_err(),
        "synced chosen_state is mandatory"
    );
    cfg.chosen_state = Some(CState::E2e);
    assert!(cfg.validate_host_trust().is_err(), "e2e bit must match");
    cfg.e2e = true;
    assert!(cfg.validate_host_trust().is_ok());
    let good = cfg.clone();
    cfg.trusted_roots.clear();
    assert!(
        cfg.validate_host_trust().is_err(),
        "no default remote root trust"
    );
    cfg = good;
    cfg.user_enabled_cloud_copy = true;
    assert!(
        cfg.validate_host_trust().is_err(),
        "opt-in may not contradict chosen state"
    );
    cfg.chosen_state = Some(CState::CloudCopy);
    assert!(
        cfg.validate_host_trust().is_err(),
        "cloud-copy may not claim e2e"
    );
    cfg.e2e = false;
    assert!(cfg.validate_host_trust().is_ok());
    cfg.user_enabled_cloud_copy = false;
    cfg.trusted_signers.clear(); // New device still awaiting SAS may read control.
    let before = cfg.clone();
    assert!(cfg.validate_host_trust().is_ok());
    assert_eq!(
        cfg, before,
        "validation never infers opt-in or signers from policy"
    );
    cfg.mode = SyncMode::LocalOnly;
    assert!(
        cfg.validate_host_trust().is_err(),
        "local-only has no synced choice"
    );
    cfg.chosen_state = None;
    assert!(cfg.validate_host_trust().is_ok());
    cfg.e2e = true;
    assert!(cfg.validate_host_trust().is_err());
    cfg.e2e = false;
    cfg.user_enabled_cloud_copy = true;
    assert!(cfg.validate_host_trust().is_err());
}

#[test]
fn log_hello_proof_is_context_fixed_bounded_and_synced_only() {
    use crate::crypto::sign::{DeviceSigner, Ed25519Verifier};
    use crate::seal::{KeyringSealer, MAX_LOG_TOKEN_BYTES};
    use mdbn_wire::client::SyncMode;
    use mdbn_wire::hash::h;
    let svc = FakeLogService::new();
    let seed = [0x31; 32];
    let mut a = node_with(
        &svc,
        1,
        MemStore::new(),
        vec![],
        Some(Box::new(KeyringSealer::new(
            COL,
            B16([101; 16]),
            &seed,
            &[0x32; 32],
        ))),
    );
    let nonce = [42; 32];
    assert!(
        a.r.log_hello_proof(nonce, "token").is_err(),
        "unpersisted trust shape refused"
    );
    a.r.cfg.chosen_state = Some(mdbn_wire::policy::CState::E2e);
    a.r.cfg.e2e = true;
    assert!(
        a.r.sealer.current_epoch().is_none(),
        "proof works before acquiring any epoch key"
    );
    let pk = DeviceSigner::from_seed(&seed).public();
    let digest =
        |tag, n: &[u8; 32], token: &str| h(tag, &[n.as_slice(), token.as_bytes()].concat());
    let token = "test-UTF8-token-\u{e9}";
    let sig = a.r.log_hello_proof(nonce, token).unwrap();
    assert!(Ed25519Verifier.verify(&pk, &digest("mdbase/v1/ls-hello", &nonce, token).0, &sig.0));
    assert!(!Ed25519Verifier.verify(&pk, &digest("mdbase/v1/item-sig", &nonce, token).0, &sig.0));
    assert!(!Ed25519Verifier.verify(&pk, &digest("mdbase/v1/ls-http", &nonce, token).0, &sig.0));
    assert!(!Ed25519Verifier.verify(
        &pk,
        &digest("mdbase/v1/ls-hello", &[43; 32], token).0,
        &sig.0
    ));
    assert!(!Ed25519Verifier.verify(
        &pk,
        &digest("mdbase/v1/ls-hello", &nonce, "other-token").0,
        &sig.0
    ));
    assert!(a.r.log_hello_proof(nonce, "").is_err());
    let limit = "\u{e9}".repeat(MAX_LOG_TOKEN_BYTES / 2);
    assert!(a.r.log_hello_proof(nonce, &limit).is_ok());
    assert!(
        a.r.log_hello_proof(nonce, &(limit + "a")).is_err(),
        "bound counts UTF8 bytes, not characters"
    );
    a.r.cfg.trusted_roots.clear();
    assert!(a.r.log_hello_proof(nonce, token).is_err());
    a.r.cfg.mode = SyncMode::LocalOnly;
    a.r.cfg.chosen_state = None;
    a.r.cfg.e2e = false;
    assert!(a.r.cfg.validate_host_trust().is_ok());
    assert!(
        a.r.log_hello_proof(nonce, token).is_err(),
        "local-only never authenticates a log"
    );
}

/// Grants: an e2e grant without the user's approval allows nothing.
#[test]
fn unapproved_grant_gets_no_session() {
    let svc = FakeLogService::new();
    let mut a = node(&svc, 1, MemStore::new());
    settle(&mut [&mut a]);
    let gid = B16([0x55; 16]);
    crate::testkit::TestControlPlane::new(COL).append(
        &svc,
        vec![mdbn_wire::policy::PolicyOp::Grant(
            mdbn_wire::policy::Grant {
                grant: gid,
                installation: B16([0x56; 16]),
                app_id: "app".into(),
                account: crate::testkit::TEST_OWNER,
                capabilities: vec!["collection.read".into()],
                client_pk: mdbn_wire::common::B32([0x57; 32]),
                file_folders: None,
                folder_scoped: None,
            },
        )],
    );
    settle(&mut [&mut a]);
    let r = a.r.hello(
        SessionAuth::Grant {
            grant: gid,
            client_pk: [0x57; 32],
        },
        HelloParams {
            versions: vec![Version { major: 1, minor: 0 }],
            client_name: "app".into(),
            client_version: "0".into(),
            features: None,
            timezone: None,
        },
    );
    assert_eq!(r.unwrap_err().code(), Some(ErrorCode::Unauthenticated));
}

/// The production sealer end to end: real Ed25519 control items and entries, the
/// initial rekey by the device itself (HPKE wrap), sealed entries, and a fresh
/// replica of the same device reading everything back. No plaintext reaches the
/// log service.
#[test]
fn keyring_sealer_round_trip() {
    use crate::seal::KeyringSealer;
    let svc = FakeLogService::new();
    let dev = B16([101; 16]);
    let (sign, kem) = ([0x31u8; 32], [0x32u8; 32]);
    crate::testkit::TestControlPlane::signed(COL).genesis_with_keys(
        &svc,
        mdbn_wire::policy::CState::E2e,
        dev,
        &sign,
        &kem,
    );
    let mut a = node_with(
        &svc,
        1,
        MemStore::new(),
        vec![],
        Some(Box::new(KeyringSealer::new(COL, dev, &sign, &kem))),
    );
    settle(&mut [&mut a]);
    assert_eq!(a.r.policy.epoch, 1, "the device did the initial rekey");
    a.create(1, "secret.md", "a very secret body");
    settle(&mut [&mut a]);
    assert_eq!(a.r.sync_status().pending, 0);
    let keys = a.r.testing_epoch_keys();
    assert_eq!(keys.len(), 1, "epoch 1");
    let objects = svc.objects(&COL).into_iter().map(|(_, b)| b);
    for item in svc.items(&COL).into_iter().chain(objects) {
        assert!(
            !item.windows(11).any(|w| w == b"very secret"),
            "plaintext reached the log service"
        );
        for (_, k) in &keys {
            assert!(
                !item.windows(32).any(|w| w == &k[..]),
                "an epoch key reached the log service"
            );
        }
    }
    // The same device on a new store: it unwraps the key from the rekey and reads.
    let mut a2 = node_with(
        &svc,
        1,
        MemStore::new(),
        vec![],
        Some(Box::new(KeyringSealer::new(COL, dev, &sign, &kem))),
    );
    settle(&mut [&mut a2]);
    assert_eq!(a2.doc(1).as_deref(), Some("a very secret body"));
    assert_eq!(a2.r.stats.voided, 0);
}

/// The app composition (`KeyringPersistence::RebuildOnOpen`): the replica never
/// hands the store its keyring, yet after a reopen it rebuilds the keys from the
/// log's verified control items with the device KEM key, decrypts entries it had
/// not applied, and seals new ones. Offline captures made before the rebuild
/// finishes are kept pending and append afterwards.
#[test]
fn app_keyring_is_never_stored_and_is_rebuilt_from_the_log_on_reopen() {
    use crate::seal::KeyringSealer;
    use crate::store::meta_keys::KEYRING;
    let svc = FakeLogService::new();
    let dev = B16([101; 16]);
    let (sign, kem) = ([0x31u8; 32], [0x32u8; 32]);
    crate::testkit::TestControlPlane::signed(COL).genesis_with_keys(
        &svc,
        mdbn_wire::policy::CState::E2e,
        dev,
        &sign,
        &kem,
    );
    let sealer = || -> Option<Box<dyn crate::seal::Sealer>> {
        Some(Box::new(KeyringSealer::new(COL, dev, &sign, &kem)))
    };
    let store = MemStore::new().with_keyring_rebuild();
    let data = store.data();
    let mut a = node_with(&svc, 1, store, vec![], sealer());
    settle(&mut [&mut a]);
    assert_eq!(a.r.policy.epoch, 1, "keyed");
    a.create(1, "first.md", "first secret body");
    settle(&mut [&mut a]);
    assert_eq!(a.r.sync_status().pending, 0);
    assert_eq!(
        data.borrow().keyring_writes,
        0,
        "no commit carried the keyring"
    );
    assert_eq!(crate::Store::meta(a.r.store(), KEYRING).unwrap(), None);
    drop(a);

    // The same device elsewhere writes an entry the app store has not applied.
    let mut other = node_with(&svc, 1, MemStore::new(), vec![], sealer());
    settle(&mut [&mut other]);
    other.create(2, "second.md", "second secret body");
    settle(&mut [&mut other]);
    drop(other);

    // Reopen: no keyring at rest, so the replica rebuilds it before syncing.
    let mut a = node_with(&svc, 1, MemStore::shared(data.clone()), vec![], sealer());
    assert!(a.r.keyring_rebuilding());
    assert!(a.r.testing_epoch_keys().is_empty(), "no keys until rebuilt");
    // Reads and offline captures work meanwhile.
    assert_eq!(a.doc(1).as_deref(), Some("first secret body"));
    // (An explicit mutation ID: the test entropy repeats across reopens.)
    let rc =
        a.r.submit(
            a.s,
            SubmitParams {
                ops: vec![Op::Create(Create {
                    id: B16([3; 16]),
                    path: Some("offline.md".into()),
                    type_name: None,
                    frontmatter: None,
                    body: None,
                    document: Some(Text::Inline("captured before the rebuild".into())),
                })],
                mutation_id: Some(B16([0x33; 16])),
                conflict_mode: None,
                timezone: None,
                allow_partial: None,
                mutation_ids: None,
                dry_run: None,
                include: None,
                wait: None,
            },
        )
        .expect("offline capture")
        .remove(0);
    assert_eq!(rc.state, mdbn_wire::client::ReceiptState::Pending);
    assert_eq!(a.r.sync_status().pending, 1, "not yet synced");
    settle(&mut [&mut a]);
    assert!(!a.r.keyring_rebuilding() && !a.r.keyring_rebuild_failed());
    assert_eq!(a.r.testing_epoch_keys().len(), 1, "epoch 1 rebuilt");
    assert_eq!(a.doc(2).as_deref(), Some("second secret body"), "decrypted");
    assert_eq!(a.r.sync_status().pending, 0, "the capture appended");
    assert_eq!(a.r.sync_status().incidents, vec![]);
    assert_eq!(data.borrow().keyring_writes, 0);
    // A plaintext-keyring replica of the same device reads the new entry.
    let mut check = node_with(&svc, 1, MemStore::new(), vec![], sealer());
    settle(&mut [&mut check]);
    assert_eq!(check.doc(3).as_deref(), Some("captured before the rebuild"));
}

/// A store whose policy disagrees with the log's control prefix is not
/// trusted: the rebuild fails as an integrity incident and nothing syncs.
#[test]
fn app_keyring_rebuild_refuses_a_store_whose_policy_differs() {
    use crate::seal::KeyringSealer;
    use crate::store::meta_keys::POLICY;
    let svc = FakeLogService::new();
    let dev = B16([101; 16]);
    let (sign, kem) = ([0x31u8; 32], [0x32u8; 32]);
    crate::testkit::TestControlPlane::signed(COL).genesis_with_keys(
        &svc,
        mdbn_wire::policy::CState::E2e,
        dev,
        &sign,
        &kem,
    );
    let sealer = || -> Option<Box<dyn crate::seal::Sealer>> {
        Some(Box::new(KeyringSealer::new(COL, dev, &sign, &kem)))
    };
    let store = MemStore::new().with_keyring_rebuild();
    let data = store.data();
    let mut a = node_with(&svc, 1, store, vec![], sealer());
    settle(&mut [&mut a]);
    // Tamper: the stored policy claims a later epoch than the log granted.
    let mut p = a.r.policy.clone();
    p.epoch += 1;
    let mut s = MemStore::shared(data.clone());
    crate::Store::commit(
        &mut s,
        crate::Tx {
            meta: vec![(POLICY.into(), p.to_bytes().ok())],
            ..crate::Tx::default()
        },
    )
    .unwrap();
    drop(a);
    let mut a = node_with(&svc, 1, MemStore::shared(data), vec![], sealer());
    settle(&mut [&mut a]);
    assert!(a.r.keyring_rebuild_failed());
    assert!(
        a.r.sync_status()
            .incidents
            .iter()
            .any(|i| i.kind == mdbn_wire::client::IncidentKind::Integrity)
    );
    assert!(a.r.testing_epoch_keys().len() <= 1);
}

/// AK1 end to end with the production sealer: device A keys the account's recovery
/// device (checked against the keys derived from `R`); a later device B of the same
/// account, alone, recovers `R`, self-grants as the recovery device, and reads A's
/// content. Mismatched enrolments and other accounts' devices are refused.
#[test]
fn account_key_unlocks_a_new_device_without_another_device() {
    use crate::crypto::recovery::RecoveryKey;
    use crate::replica::AccountKeyRefusal;
    use crate::seal::KeyringSealer;
    use mdbn_wire::common::B32;
    use mdbn_wire::policy::{DeviceEnrol, DeviceKind, PolicyOp};
    let svc = FakeLogService::new();
    let (a_dev, b_dev) = (B16([101; 16]), B16([102; 16]));
    let (a_sign, a_kem) = ([0x31u8; 32], [0x32u8; 32]);
    let (b_sign, b_kem) = ([0x41u8; 32], [0x42u8; 32]);
    let mut cp = crate::testkit::TestControlPlane::signed(COL);
    cp.genesis_with_keys(&svc, mdbn_wire::policy::CState::E2e, a_dev, &a_sign, &a_kem);
    let mut a = node_with(
        &svc,
        1,
        MemStore::new(),
        vec![],
        Some(Box::new(KeyringSealer::new(COL, a_dev, &a_sign, &a_kem))),
    );
    settle(&mut [&mut a]);
    assert_eq!(a.r.policy.epoch, 1);
    // The automatic witness uses the actual member signing seed and a trusted
    // current host source (synthetic source, real policy/sealer/application).
    a.r.secrets.sign_sk = a_sign;
    struct WitnessSource(Rc<Cell<bool>>);
    impl crate::policy::GrantSource for WitnessSource {
        fn grant(&self, _: &B16) -> Option<crate::policy::EffectiveGrant> {
            None
        }
        fn active_account(&self) -> Option<B16> {
            self.0.get().then_some(crate::testkit::TEST_OWNER)
        }
        fn authority_epoch(&self) -> Option<u64> {
            self.0.get().then_some(1)
        }
    }
    let witness_source = Rc::new(Cell::new(true));
    a.r.grant_source = Some(Box::new(WitnessSource(witness_source.clone())));
    // Setup: R, and the control plane enrols the recovery device for the account.
    let mut e = crate::crypto::TestEntropy::new(5);
    let r = RecoveryKey::generate(&mut e);
    let rk = r.derive(&COL);
    let enrol = |device, sign_pk: [u8; 32], kem_pk: [u8; 32], kind, noise: [u8; 32]| {
        PolicyOp::DeviceEnrol(DeviceEnrol {
            device,
            account: crate::testkit::TEST_OWNER,
            kind,
            sign_pk: B32(sign_pk),
            kem_pk: B32(kem_pk),
            noise_pk: B32(noise),
            sas_commit: None,
            local_root: None,
        })
    };
    // A control plane substituting its own KEM key is never keyed.
    let wrong = RecoveryKey::generate(&mut e).derive(&COL);
    cp.append(
        &svc,
        vec![enrol(
            rk.device,
            rk.signer.public(),
            wrong.kem.pk,
            DeviceKind::Recovery,
            [0; 32],
        )],
    );
    settle(&mut [&mut a]);
    assert_eq!(
        a.r.key_account_key_device(&rk),
        Err(AccountKeyRefusal::EnrolmentMismatch)
    );
    // The genuine enrolment (a fresh R; device IDs are never reused).
    let r = RecoveryKey::generate(&mut e);
    let rk = r.derive(&COL);
    cp.append(
        &svc,
        vec![enrol(
            rk.device,
            rk.signer.public(),
            rk.kem.pk,
            DeviceKind::Recovery,
            [0; 32],
        )],
    );
    settle(&mut [&mut a]);
    a.r.key_account_key_device(&rk).unwrap();
    settle(&mut [&mut a]);
    assert_eq!(a.r.account_key_device_keyed(&rk), Ok(true));
    a.create(1, "secret.md", "for my other devices");
    settle(&mut [&mut a]);
    // Device B of the same account signs in; no other device helps it.
    let b_kem_pk = crate::crypto::hpke::KemKeyPair::from_secret(&b_kem).pk;
    let b_sign_pk = crate::crypto::sign::DeviceSigner::from_seed(&b_sign).public();
    cp.append(
        &svc,
        vec![enrol(
            b_dev,
            b_sign_pk,
            b_kem_pk,
            DeviceKind::Desktop,
            [9; 32],
        )],
    );
    let mut b = node_with(
        &svc,
        2,
        MemStore::new(),
        vec![],
        Some(Box::new(KeyringSealer::new(COL, b_dev, &b_sign, &b_kem))),
    );
    settle(&mut [&mut b]);
    assert_eq!(b.doc(1), None, "not keyed yet");
    // A refused local commit leaves nothing behind (no key installed, no trust).
    b.r.store().fail_commits(1);
    b.r.self_grant_with_account_key(RecoveryKey::from_bytes(*r.expose()).derive(&COL))
        .unwrap();
    settle(&mut [&mut b]);
    assert_eq!(
        b.r.account_key_unlock_state(),
        Err(AccountKeyRefusal::Failed)
    );
    assert!(
        b.r.testing_epoch_keys().is_empty(),
        "no key after a refused commit"
    );
    assert!(!b.r.account_key_unlocked());
    // The user types the password (or recovery key): R is recovered locally.
    let unlocked = RecoveryKey::from_bytes(*r.expose()).derive(&COL);
    b.r.self_grant_with_account_key(unlocked).unwrap();
    assert!(
        !b.r.account_key_unlocked(),
        "started is not unlocked: the grant is not applied yet"
    );
    settle(&mut [&mut a, &mut b]);
    assert!(b.r.policy.devices[&b_dev].keyed);
    assert!(b.r.account_key_unlocked(), "keyed in P and trusted");
    assert_eq!(b.r.policy.devices[&b_dev].delivered_by, Some(rk.device));
    assert_eq!(b.doc(1).as_deref(), Some("for my other devices"));
    assert!(!b.r.key_untrusted, "B trusts the account key it unlocked");
    assert_eq!(b.r.stats.voided, 0);
    // Strict mode: the control plane revokes the account-key device; a keyed
    // member rekeys it out, and R keys nothing from then on.
    assert!(
        a.r.account_key_strict_witness(crate::testkit::TEST_OWNER, rk.device, 7, 1)
            .is_none(),
        "an active recovery device cannot be attested as excluded"
    );
    cp.revoke(&svc, rk.device);
    let revoked_at = svc.head(&COL).0;
    assert!(
        a.r.account_key_strict_witness(crate::testkit::TEST_OWNER, rk.device, 7, revoked_at)
            .is_none(),
        "CP admission has not been applied here"
    );
    settle(&mut [&mut a, &mut b]);
    assert_eq!(a.r.policy.epoch, 2, "the revocation was rekeyed");
    let witness =
        a.r.account_key_strict_witness(crate::testkit::TEST_OWNER, rk.device, 7, revoked_at)
            .unwrap();
    assert_eq!(witness.epoch, 2);
    assert_eq!(witness.revoked_at, revoked_at);
    assert!(witness.applied_at >= revoked_at);
    assert!(crate::crypto::sign::verify_digest(
        &crate::crypto::sign::DeviceSigner::from_seed(&a_sign).public(),
        &witness.digest().0,
        &witness.signature.0,
    ));
    let mut changed = witness.clone();
    changed.version += 1;
    assert!(
        !crate::crypto::sign::verify_digest(
            &crate::crypto::sign::DeviceSigner::from_seed(&a_sign).public(),
            &changed.digest().0,
            &changed.signature.0,
        ),
        "the strict generation is signed"
    );
    witness_source.set(false);
    assert!(
        a.r.account_key_strict_witness(crate::testkit::TEST_OWNER, rk.device, 7, revoked_at)
            .is_none(),
        "a stale or logged-out source cannot sign"
    );
    witness_source.set(true);
    a.r.policy.rekey_required = true;
    assert!(
        a.r.account_key_strict_witness(crate::testkit::TEST_OWNER, rk.device, 7, revoked_at)
            .is_none(),
        "an outstanding rekey, including a void rekey, cannot complete strict"
    );
    a.r.policy.rekey_required = false;
    a.r.apply_fault = true;
    assert!(
        a.r.account_key_strict_witness(crate::testkit::TEST_OWNER, rk.device, 7, revoked_at)
            .is_none(),
        "uncertain durability must not attest application"
    );
    a.r.apply_fault = false;
    // Only a healthy, current applied state attests.
    let witness_now = |a: &mut Node| {
        a.r.account_key_strict_witness(crate::testkit::TEST_OWNER, rk.device, 7, revoked_at)
    };
    assert!(witness_now(&mut a).is_some());
    a.r.regressed_at = Some(1);
    assert!(
        witness_now(&mut a).is_none(),
        "inside a log-regression window"
    );
    a.r.regressed_at = None;
    a.r.latch.devices.insert(B16([0xee; 16]));
    assert!(
        witness_now(&mut a).is_none(),
        "lost control pending (latch)"
    );
    a.r.latch.devices.clear();
    let head = a.r.head.seq;
    a.r.testing_start_repair(head.saturating_sub(1));
    a.r.regressed_at = None;
    assert!(a.r.repair.is_some());
    assert!(witness_now(&mut a).is_none(), "during a lost-tail repair");
    a.r.repair = None;
    // Policy read ahead of the head (as after a snapshot install) is not the
    // applied prefix `applied_at` names (applied-prefix fence).
    let policy_seq = a.r.policy.seq;
    a.r.policy.seq = a.r.head.seq + 1;
    assert!(
        witness_now(&mut a).is_none(),
        "policy ahead of the applied head"
    );
    a.r.policy.seq = policy_seq;
    assert!(witness_now(&mut a).is_some_and(|w| w.applied_at >= a.r.policy.seq));
    let epoch = a.r.policy.epoch;
    a.r.policy.epoch = epoch + 1;
    assert!(
        witness_now(&mut a).is_none(),
        "the sealer does not hold the policy's current epoch key"
    );
    a.r.policy.epoch = epoch;
    assert!(witness_now(&mut a).is_some(), "healthy again");
    assert_eq!(a.r.account_key_revoked_and_rekeyed(&rk.device), Some(true));
    assert!(!a.r.policy.rekey_required);
    assert!(!a.r.policy.devices[&rk.device].keyed);
    assert!(b.r.policy.devices[&b_dev].keyed, "B stays keyed");
    assert_eq!(
        b.r.account_key_device_keyed(&RecoveryKey::from_bytes(*r.expose()).derive(&COL)),
        Err(AccountKeyRefusal::DeviceMissing)
    );
    // A device that unlocks with R only after the revocation (it still sees the
    // old wrap at its blocked position) is refused once it catches up: typed,
    // not left waiting forever.
    let (c_dev, c_sign, c_kem) = (B16([103; 16]), [0x51u8; 32], [0x52u8; 32]);
    cp.append(
        &svc,
        vec![enrol(
            c_dev,
            crate::crypto::sign::DeviceSigner::from_seed(&c_sign).public(),
            crate::crypto::hpke::KemKeyPair::from_secret(&c_kem).pk,
            DeviceKind::Desktop,
            [9; 32],
        )],
    );
    let mut c = node_with(
        &svc,
        3,
        MemStore::new(),
        vec![],
        Some(Box::new(KeyringSealer::new(COL, c_dev, &c_sign, &c_kem))),
    );
    settle(&mut [&mut c]);
    c.r.self_grant_with_account_key(RecoveryKey::from_bytes(*r.expose()).derive(&COL))
        .unwrap();
    settle(&mut [&mut a, &mut b, &mut c]);
    // C still waits at its first entry; it never becomes keyed.
    assert!(c.r.policy.devices.get(&c_dev).is_none_or(|d| !d.keyed));
    assert_eq!(
        c.r.account_key_unlock_state(),
        Err(AccountKeyRefusal::DeviceMissing),
        "checked at the head: the account key was revoked"
    );
    assert!(
        c.r.testing_epoch_keys().is_empty(),
        "nothing installed for a revoked account key"
    );
    // A reopened B still trusts it (persisted).
    let b2 = node_with(
        &svc,
        2,
        b.r.into_store(),
        vec![],
        Some(Box::new(KeyringSealer::new(COL, b_dev, &b_sign, &b_kem))),
    );
    assert!(!b2.r.key_untrusted);
}

/// AK1: an unknown self-grant commit faults the replica (no key use until reopen).
#[test]
fn account_key_unknown_commit_faults_until_reopen() {
    use crate::crypto::recovery::RecoveryKey;
    use crate::replica::AccountKeyRefusal;
    use crate::seal::KeyringSealer;
    use mdbn_wire::common::B32;
    use mdbn_wire::policy::{DeviceEnrol, DeviceKind, PolicyOp};
    let svc = FakeLogService::new();
    let (a_dev, b_dev) = (B16([101; 16]), B16([102; 16]));
    let (a_sign, a_kem, b_sign, b_kem) = ([0x31u8; 32], [0x32u8; 32], [0x41u8; 32], [0x42u8; 32]);
    let mut cp = crate::testkit::TestControlPlane::signed(COL);
    cp.genesis_with_keys(&svc, mdbn_wire::policy::CState::E2e, a_dev, &a_sign, &a_kem);
    let mut a = node_with(
        &svc,
        1,
        MemStore::new(),
        vec![],
        Some(Box::new(KeyringSealer::new(COL, a_dev, &a_sign, &a_kem))),
    );
    settle(&mut [&mut a]);
    let r = RecoveryKey::generate(&mut crate::crypto::TestEntropy::new(7));
    let rk = r.derive(&COL);
    let enrol = |device, sign_pk: [u8; 32], kem_pk: [u8; 32], kind, noise: [u8; 32]| {
        PolicyOp::DeviceEnrol(DeviceEnrol {
            device,
            account: crate::testkit::TEST_OWNER,
            kind,
            sign_pk: B32(sign_pk),
            kem_pk: B32(kem_pk),
            noise_pk: B32(noise),
            sas_commit: None,
            local_root: None,
        })
    };
    cp.append(
        &svc,
        vec![enrol(
            rk.device,
            rk.signer.public(),
            rk.kem.pk,
            DeviceKind::Recovery,
            [0; 32],
        )],
    );
    settle(&mut [&mut a]);
    a.r.key_account_key_device(&rk).unwrap();
    settle(&mut [&mut a]);
    let b_kem_pk = crate::crypto::hpke::KemKeyPair::from_secret(&b_kem).pk;
    let b_sign_pk = crate::crypto::sign::DeviceSigner::from_seed(&b_sign).public();
    cp.append(
        &svc,
        vec![enrol(
            b_dev,
            b_sign_pk,
            b_kem_pk,
            DeviceKind::Desktop,
            [9; 32],
        )],
    );
    let mut b = node_with(
        &svc,
        2,
        MemStore::new(),
        vec![],
        Some(Box::new(KeyringSealer::new(COL, b_dev, &b_sign, &b_kem))),
    );
    settle(&mut [&mut b]);
    b.r.store().fail_after_commit(1);
    b.r.self_grant_with_account_key(RecoveryKey::from_bytes(*r.expose()).derive(&COL))
        .unwrap();
    settle(&mut [&mut b]);
    assert_eq!(
        b.r.account_key_unlock_state(),
        Err(AccountKeyRefusal::OutcomeUnknown)
    );
    assert!(b.r.apply_fault);
    assert_eq!(
        b.r.self_grant_with_account_key(RecoveryKey::from_bytes(*r.expose()).derive(&COL)),
        Err(AccountKeyRefusal::OutcomeUnknown)
    );
}

/// AK1, a private collection created after the account key was set up (LAB
/// two-device run 10070637): device B unlocks before any device holding `R` has
/// enrolled and keyed the collection's account-key device. The unlock is refused
/// with a typed, retryable reason and the collection keeps serving (no integrity
/// incident). Once A (which holds `R`) enrols and keys it, idempotently, B's next
/// unlock succeeds with the password alone.
#[test]
fn account_key_unlock_before_the_collection_is_keyed_is_retryable() {
    use crate::crypto::recovery::RecoveryKey;
    use crate::replica::AccountKeyRefusal;
    use crate::seal::KeyringSealer;
    use mdbn_wire::client::IncidentKind;
    use mdbn_wire::common::B32;
    use mdbn_wire::policy::{DeviceEnrol, DeviceKind, PolicyOp};
    let svc = FakeLogService::new();
    let (a_dev, b_dev) = (B16([101; 16]), B16([102; 16]));
    let (a_sign, a_kem, b_sign, b_kem) = ([0x31u8; 32], [0x32u8; 32], [0x41u8; 32], [0x42u8; 32]);
    let mut cp = crate::testkit::TestControlPlane::signed(COL);
    cp.genesis_with_keys(&svc, mdbn_wire::policy::CState::E2e, a_dev, &a_sign, &a_kem);
    let mut a = node_with(
        &svc,
        1,
        MemStore::new(),
        vec![],
        Some(Box::new(KeyringSealer::new(COL, a_dev, &a_sign, &a_kem))),
    );
    settle(&mut [&mut a]);
    // R existed before this collection: nothing enrolled its account-key device.
    let r = RecoveryKey::generate(&mut crate::crypto::TestEntropy::new(11));
    let rk = r.derive(&COL);
    a.create(1, "later.md", "created after setup");
    settle(&mut [&mut a]);
    let enrol = |device, sign_pk: [u8; 32], kem_pk: [u8; 32], kind, noise: [u8; 32]| {
        PolicyOp::DeviceEnrol(DeviceEnrol {
            device,
            account: crate::testkit::TEST_OWNER,
            kind,
            sign_pk: B32(sign_pk),
            kem_pk: B32(kem_pk),
            noise_pk: B32(noise),
            sas_commit: None,
            local_root: None,
        })
    };
    cp.append(
        &svc,
        vec![enrol(
            b_dev,
            crate::crypto::sign::DeviceSigner::from_seed(&b_sign).public(),
            crate::crypto::hpke::KemKeyPair::from_secret(&b_kem).pk,
            DeviceKind::Desktop,
            [9; 32],
        )],
    );
    let mut b = node_with(
        &svc,
        2,
        MemStore::new(),
        vec![],
        Some(Box::new(KeyringSealer::new(COL, b_dev, &b_sign, &b_kem))),
    );
    settle(&mut [&mut a, &mut b]);
    assert_eq!(b.doc(1), None, "not keyed yet");
    // Only a keyed editor device may key the account-key device.
    assert_eq!(a.r.account_key_can_key(), Ok(true));
    // B waits for a key at A's first entry, before its own enrolment applies.
    assert_eq!(
        b.r.account_key_can_key(),
        Err(AccountKeyRefusal::NotEnrolled)
    );
    assert_eq!(
        a.r.account_key_device_keyed(&rk),
        Err(AccountKeyRefusal::DeviceMissing)
    );
    // B unlocks first: typed refusal, nothing installed, still serving.
    b.r.self_grant_with_account_key(RecoveryKey::from_bytes(*r.expose()).derive(&COL))
        .unwrap();
    settle(&mut [&mut a, &mut b]);
    assert_eq!(
        b.r.account_key_unlock_state(),
        Err(AccountKeyRefusal::DeviceMissing)
    );
    assert!(b.r.testing_epoch_keys().is_empty());
    let incidents = b.r.sync_status().incidents;
    assert!(
        !incidents.iter().any(|i| matches!(
            i.kind,
            IncidentKind::KeyInconsistent | IncidentKind::Integrity
        )),
        "a not-yet-keyed account key must not fail the collection: {incidents:?}"
    );
    assert!(!b.r.apply_fault);
    // A holds R: the control plane enrols the account-key device (proof of
    // possession; a repeated enrolment is answered from the prior one, Connect
    // #635), A keys it. Keying again is a no-op.
    cp.append(
        &svc,
        vec![enrol(
            rk.device,
            rk.signer.public(),
            rk.kem.pk,
            DeviceKind::Recovery,
            [0; 32],
        )],
    );
    settle(&mut [&mut a]);
    // Queued twice before it applies: one grant is sent.
    a.r.key_account_key_device(&rk).unwrap();
    a.r.key_account_key_device(&rk).unwrap();
    settle(&mut [&mut a]);
    assert_eq!(a.r.account_key_device_keyed(&rk), Ok(true));
    a.r.key_account_key_device(&rk).unwrap();
    let head = svc.head(&COL).0;
    settle(&mut [&mut a]);
    assert_eq!(
        svc.head(&COL).0,
        head,
        "keying a keyed device appends nothing"
    );
    // B (online, it has heard the new head) retries: unlocked, and reads A's content.
    settle(&mut [&mut b]);
    b.r.self_grant_with_account_key(RecoveryKey::from_bytes(*r.expose()).derive(&COL))
        .unwrap();
    settle(&mut [&mut a, &mut b]);
    assert_eq!(b.r.account_key_unlock_state(), Ok(true));
    assert_eq!(b.doc(1).as_deref(), Some("created after setup"));
    assert_eq!(b.r.stats.voided, 0);
    // B is keyed and an editor too: it could now key the device itself.
    assert_eq!(b.r.account_key_can_key(), Ok(true));
}

/// LAB race (two-device run attp-10071841): B unlocks right after joining, before
/// its replica has applied the collection's policy. That is `NotReady` (retry
/// shortly), never the settled `NotPrivate`; once the policy applies, the same
/// unlock succeeds. Nothing is installed and the collection keeps serving.
#[test]
fn account_key_unlock_before_the_policy_applies_is_not_ready() {
    use crate::crypto::recovery::RecoveryKey;
    use crate::replica::AccountKeyRefusal;
    use crate::seal::KeyringSealer;
    use mdbn_wire::client::IncidentKind;
    use mdbn_wire::common::B32;
    use mdbn_wire::policy::{DeviceEnrol, DeviceKind, PolicyOp};
    let svc = FakeLogService::new();
    let (a_dev, b_dev) = (B16([101; 16]), B16([102; 16]));
    let (a_sign, a_kem, b_sign, b_kem) = ([0x31u8; 32], [0x32u8; 32], [0x41u8; 32], [0x42u8; 32]);
    let mut cp = crate::testkit::TestControlPlane::signed(COL);
    cp.genesis_with_keys(&svc, mdbn_wire::policy::CState::E2e, a_dev, &a_sign, &a_kem);
    let mut a = node_with(
        &svc,
        1,
        MemStore::new(),
        vec![],
        Some(Box::new(KeyringSealer::new(COL, a_dev, &a_sign, &a_kem))),
    );
    settle(&mut [&mut a]);
    let r = RecoveryKey::generate(&mut crate::crypto::TestEntropy::new(13));
    let rk = r.derive(&COL);
    let enrol = |device, sign_pk: [u8; 32], kem_pk: [u8; 32], kind, noise: [u8; 32]| {
        PolicyOp::DeviceEnrol(DeviceEnrol {
            device,
            account: crate::testkit::TEST_OWNER,
            kind,
            sign_pk: B32(sign_pk),
            kem_pk: B32(kem_pk),
            noise_pk: B32(noise),
            sas_commit: None,
            local_root: None,
        })
    };
    // A holds R and has keyed the account-key device; B is enrolled.
    cp.append(
        &svc,
        vec![enrol(
            rk.device,
            rk.signer.public(),
            rk.kem.pk,
            DeviceKind::Recovery,
            [0; 32],
        )],
    );
    settle(&mut [&mut a]);
    a.r.key_account_key_device(&rk).unwrap();
    settle(&mut [&mut a]);
    assert_eq!(a.r.account_key_device_keyed(&rk), Ok(true));
    a.create(1, "secret.md", "for my other devices");
    settle(&mut [&mut a]);
    cp.append(
        &svc,
        vec![enrol(
            b_dev,
            crate::crypto::sign::DeviceSigner::from_seed(&b_sign).public(),
            crate::crypto::hpke::KemKeyPair::from_secret(&b_kem).pk,
            DeviceKind::Desktop,
            [9; 32],
        )],
    );
    settle(&mut [&mut a]);
    // B has just joined: its runtime is open, nothing is applied yet.
    let mut b = node_with(
        &svc,
        2,
        MemStore::new(),
        vec![],
        Some(Box::new(KeyringSealer::new(COL, b_dev, &b_sign, &b_kem))),
    );
    assert_eq!(b.r.policy.cstate, None);
    assert_eq!(b.r.account_key_can_key(), Err(AccountKeyRefusal::NotReady));
    assert_eq!(
        b.r.account_key_device_keyed(&rk),
        Err(AccountKeyRefusal::NotEnrolled),
        "no member account before the policy applies"
    );
    let unlock = || RecoveryKey::from_bytes(*r.expose()).derive(&COL);
    match b.r.self_grant_with_account_key(unlock()) {
        Ok(()) => {}
        Err(e) => assert_eq!(e, AccountKeyRefusal::NotReady),
    }
    assert_eq!(
        b.r.account_key_unlock_state(),
        Err(AccountKeyRefusal::NotReady),
        "not ready, never the settled not_private"
    );
    assert!(b.r.testing_epoch_keys().is_empty());
    assert!(!b.r.apply_fault);
    // The policy applies: the same unlock now succeeds.
    settle(&mut [&mut a, &mut b]);
    assert_eq!(b.r.policy.cstate, Some(mdbn_wire::policy::CState::E2e));
    b.r.self_grant_with_account_key(unlock()).unwrap();
    settle(&mut [&mut a, &mut b]);
    assert_eq!(b.r.account_key_unlock_state(), Ok(true));
    assert_eq!(b.doc(1).as_deref(), Some("for my other devices"));
    let incidents = b.r.sync_status().incidents;
    assert!(
        !incidents.iter().any(|i| matches!(
            i.kind,
            IncidentKind::KeyInconsistent | IncidentKind::Integrity
        )),
        "{incidents:?}"
    );
}

/// A collection that really is a cloud copy stays the settled, typed `NotPrivate`
/// once its policy is applied: unlock, keying and status are all refused.
#[test]
fn account_key_on_a_cloud_copy_collection_is_not_private() {
    use crate::crypto::recovery::RecoveryKey;
    use crate::replica::AccountKeyRefusal;
    use crate::seal::KeyringSealer;
    let svc = FakeLogService::new();
    let a_dev = B16([101; 16]);
    let (a_sign, a_kem) = ([0x31u8; 32], [0x32u8; 32]);
    let mut cp = crate::testkit::TestControlPlane::signed(COL);
    cp.genesis_with_keys(
        &svc,
        mdbn_wire::policy::CState::CloudCopy,
        a_dev,
        &a_sign,
        &a_kem,
    );
    let mut a = node_with(
        &svc,
        1,
        MemStore::new(),
        vec![],
        Some(Box::new(KeyringSealer::new(COL, a_dev, &a_sign, &a_kem))),
    );
    settle(&mut [&mut a]);
    assert_eq!(
        a.r.policy.cstate,
        Some(mdbn_wire::policy::CState::CloudCopy)
    );
    let rk = RecoveryKey::generate(&mut crate::crypto::TestEntropy::new(17)).derive(&COL);
    assert_eq!(
        a.r.account_key_can_key(),
        Err(AccountKeyRefusal::NotPrivate)
    );
    assert_eq!(
        a.r.account_key_device_keyed(&rk),
        Err(AccountKeyRefusal::NotPrivate)
    );
    assert_eq!(
        a.r.key_account_key_device(&rk),
        Err(AccountKeyRefusal::NotPrivate)
    );
    a.r.self_grant_with_account_key(rk).unwrap();
    settle(&mut [&mut a]);
    assert_eq!(
        a.r.account_key_unlock_state(),
        Err(AccountKeyRefusal::NotPrivate)
    );
    assert!(!a.r.apply_fault);
}

/// A manifest with a forged signature, or one whose control chain differs
/// from the control items read, is refused.
#[test]
fn forged_manifest_is_refused() {
    use mdbn_wire::schema::Wire;
    let svc = FakeLogService::new();
    let mut a = node(&svc, 1, MemStore::new());
    a.create(1, "x.md", "x");
    settle(&mut [&mut a]);
    a.r.build_snapshot_now().unwrap();
    settle(&mut [&mut a]);
    let (addr, bytes) = svc
        .objects(&COL)
        .into_iter()
        .find(|(_, b)| {
            mdbn_wire::envelope::Item::from_bytes(b)
                .is_ok_and(|i| i.kind == mdbn_wire::envelope::ItemKind::Manifest)
        })
        .expect("a manifest");
    let _ = addr;
    let item = mdbn_wire::envelope::Item::from_bytes(&bytes).unwrap();
    let m = mdbn_wire::attachment_runtime_v1::ManifestPayload::from_bytes(&item.body.0).unwrap();
    let pol = a.r.policy.clone();
    assert!(
        a.r.verify_manifest(&bytes, &item, &m, &pol).is_ok(),
        "the genuine manifest verifies"
    );
    let mut forged = item.clone();
    forged.sig = Some(mdbn_wire::common::B64([1; 64]));
    let fb = forged.to_bytes().unwrap();
    assert!(
        a.r.verify_manifest(&fb, &forged, &m, &pol).is_err(),
        "forged signature"
    );
    let mut wrong_ctl = m.clone();
    wrong_ctl.control_chain = mdbn_wire::common::B32([9; 32]);
    assert!(
        a.r.verify_manifest(&bytes, &item, &wrong_ctl, &pol)
            .is_err(),
        "wrong control chain"
    );
    let mut unknown = item.clone();
    unknown.signer = Some(B16([66; 16]));
    let ub = unknown.to_bytes().unwrap();
    assert!(
        a.r.verify_manifest(&ub, &unknown, &m, &pol).is_err(),
        "unauthorized signer"
    );
}

/// A snapshot whose rows break the path policy or carry an out-of-range
/// blob ref is refused, and the replica keeps its state.
#[test]
fn install_rejects_unsafe_rows() {
    use crate::store::{RecordMeta, RecordRow, Tx, bucket16};
    let svc = FakeLogService::new();
    let mut a = node(&svc, 1, MemStore::new());
    let mut b = node(&svc, 2, MemStore::new());
    for i in 0..5u8 {
        a.create(i, &format!("n{i}.md"), "x");
    }
    settle(&mut [&mut a, &mut b]);
    let Node { r, .. } = b;
    let b_store = r.into_store();
    // A writes an unsafe row straight into its own store (a malicious builder), then
    // snapshots it.
    let id = B16([0xee; 16]);
    let bad = RecordRow {
        id,
        path: ".obsidian/plugins/x/main.md".into(),
        path_key: ".obsidian/plugins/x/main.md".into(),
        doc: "evil".into(),
        revision: mdbn_wire::hash::sha256(b"evil"),
        modified_seq: 1,
        bucket: bucket16(&id),
        meta: RecordMeta::default(),
    };
    crate::Store::commit(
        a.r.store_mut(),
        Tx {
            records_put: vec![bad],
            ..Tx::default()
        },
    )
    .unwrap();
    for i in 5..30u8 {
        a.create(i, &format!("n{i}.md"), "x");
    }
    settle(&mut [&mut a]);
    a.r.build_snapshot_now().unwrap();
    settle(&mut [&mut a]);
    svc.compact(&COL, BOOT + 40);
    let mut b = node(&svc, 2, b_store);
    settle(&mut [&mut a, &mut b]);
    assert_eq!(
        b.r.stats.snapshots_installed, 0,
        "the unsafe snapshot was not installed"
    );
    assert_eq!(
        b.r.confirmed_records().unwrap().len(),
        5,
        "the old state is intact"
    );
    assert_eq!(
        b.r.store().staged_rows(),
        0,
        "a refused install leaves nothing staged"
    );
    assert!(
        b.r.sync_status()
            .incidents
            .iter()
            .any(|i| i.kind == mdbn_wire::client::IncidentKind::Integrity)
    );
    let why = format!("{:?}", b.r.sync_status().incidents);
    assert!(why.contains("row path"), "refused for its row path: {why}");
}

/// A grant scoped to folders sees and touches only files inside them.
#[test]
fn folder_scoped_grant_sees_only_its_files() {
    use crate::api::{ListFiles, Target};
    use mdbn_wire::intent::{BlobRef, FilePut};
    let svc = FakeLogService::new();
    let mut a = node(&svc, 1, MemStore::new());
    settle(&mut [&mut a]);
    let blob = |n: u8| BlobRef {
        plain_hash: mdbn_wire::common::B32([n; 32]),
        size: 3,
        blob_id: mdbn_wire::common::B32([n; 32]),
        id_epoch: 1,
        part_size: 8 << 20,
    };
    // Two files written by the hosting app.
    for (id, path) in [(0x61u8, "photos/a.png"), (0x62u8, "private/b.png")] {
        let mut st = crate::store::Tx::default();
        st.files_put.push(crate::store::FileRow {
            kind: mdbn_wire::unindexed_markdown::FileKindV1::Ordinary,
            id: B16([id; 16]),
            path: path.into(),
            path_key: path.into(),
            content: mdbn_wire::attachment::FileContent::Blob(blob(id)),
            media: mdbn_wire::intent::MediaClass::Image,
            modified_seq: 1,
            bucket: crate::store::bucket16(&B16([id; 16])),
            local: crate::store::FileLocal::Remote,
        });
        crate::Store::commit(a.r.store_mut(), st).unwrap();
    }
    let gid = B16([0x55; 16]);
    crate::testkit::TestControlPlane::new(COL).approved_grant(
        &svc,
        gid,
        [0x57; 32],
        &["collection.read", "records.create", "records.edit"],
        Some(vec!["photos".into()]),
        B16([101; 16]),
    );
    settle(&mut [&mut a]);
    let (s, _) =
        a.r.hello(
            SessionAuth::Grant {
                grant: gid,
                client_pk: [0x57; 32],
            },
            HelloParams {
                versions: vec![Version { major: 1, minor: 0 }],
                client_name: "app".into(),
                client_version: "0".into(),
                features: None,
                timezone: None,
            },
        )
        .expect("approved grant session");
    let list = a.r.list_files(s, ListFiles::default()).unwrap();
    assert_eq!(
        list.files
            .iter()
            .map(|f| f.path.as_str())
            .collect::<Vec<_>>(),
        vec!["photos/a.png"]
    );
    assert_eq!(
        a.r.get_file(s, Target::Path("private/b.png".into()))
            .unwrap_err()
            .code(),
        Some(ErrorCode::NotFound)
    );
    assert!(a.r.get_file(s, Target::Path("photos/a.png".into())).is_ok());
    let put = |path: &str| SubmitParams {
        ops: vec![Op::FilePut(FilePut {
            id: B16([0x63; 16]),
            path: path.into(),
            blob: blob(0x63),
            if_revision: None,
            base: None,
        })],
        mutation_id: None,
        conflict_mode: None,
        timezone: None,
        allow_partial: None,
        mutation_ids: None,
        dry_run: None,
        include: None,
        wait: None,
    };
    assert_eq!(
        a.r.submit(s, put("private/c.png")).unwrap_err().code(),
        Some(ErrorCode::Forbidden)
    );
    // The hosting app is unrestricted.
    assert_eq!(
        a.r.list_files(a.s, ListFiles::default())
            .unwrap()
            .files
            .len(),
        2
    );
}

#[test]
fn owner_repro_faulted_public_ingest_must_not_commit() {
    let svc = FakeLogService::new();
    let mut a = node(&svc, 1, MemStore::new());
    settle(&mut [&mut a]);
    let seq = crate::testkit::TestControlPlane::new(COL).revoke(&svc, B16([109; 16]));
    a.r.store().fail_unknown_commits(1);
    a.r.apply_items(vec![mdbn_wire::log_service::SeqItem {
        seq,
        item: mdbn_wire::common::Bytes(svc.items(&COL)[seq as usize - 1].clone()),
    }]);
    assert!(a.r.requires_reopen());
    let before = a.r.store().data().borrow().commits;
    a.r.ingest(vec![crate::store::Observation {
        token: crate::store::ObservationId(999),
        path: "while-faulted.md".into(),
        base: None,
        now: Some(crate::store::Observed::Text("file watcher edit".into())),
        moved_from: None,
        provenance: crate::store::Provenance::Normal,
    }]);
    assert_eq!(
        a.r.store().data().borrow().commits,
        before,
        "faulted file watcher ingest must not mutate or acknowledge storage"
    );
}

#[test]
fn control_commit_failure_retry_persists_policy_on_reopen() {
    let svc = FakeLogService::new();
    let mut a = node(&svc, 1, MemStore::new());
    settle(&mut [&mut a]);
    let before = a.r.head();
    let revoked = B16([109; 16]);
    let seq = crate::testkit::TestControlPlane::new(COL).revoke(&svc, revoked);
    let item = mdbn_wire::log_service::SeqItem {
        seq,
        item: mdbn_wire::common::Bytes(svc.items(&COL)[seq as usize - 1].clone()),
    };
    a.r.store().fail_commits(1);
    a.r.apply_items(vec![item.clone()]);
    assert_eq!(
        a.r.head(),
        before,
        "failed control commit must not advance head"
    );
    a.r.apply_items(vec![item]);
    assert!(!a.r.policy.devices[&revoked].active);
    let reopened = node(&svc, 1, a.r.into_store());
    assert!(
        !reopened.r.policy.devices[&revoked].active,
        "successful retry must persist the revocation, not only its head"
    );
}

#[test]
fn real_rekey_commit_failure_retry_persists_keys_on_reopen() {
    use crate::seal::KeyringSealer;
    let svc = FakeLogService::new();
    let dev = B16([101; 16]);
    let (sign, kem) = ([0x31u8; 32], [0x32u8; 32]);
    crate::testkit::TestControlPlane::signed(COL).genesis_with_keys(
        &svc,
        mdbn_wire::policy::CState::E2e,
        dev,
        &sign,
        &kem,
    );
    let keyed = || {
        Some(Box::new(KeyringSealer::new(COL, dev, &sign, &kem)) as Box<dyn crate::seal::Sealer>)
    };
    let mut source = node_with(&svc, 1, MemStore::new(), vec![], keyed());
    settle(&mut [&mut source]);
    assert_eq!(source.r.sealer.current_epoch(), Some(1));
    let raw = svc.items(&COL);
    let mut target = node_with(&svc, 1, MemStore::new(), vec![], keyed());
    target.r.apply_items(vec![mdbn_wire::log_service::SeqItem {
        seq: 1,
        item: mdbn_wire::common::Bytes(raw[0].clone()),
    }]);
    let rekey = mdbn_wire::log_service::SeqItem {
        seq: 2,
        item: mdbn_wire::common::Bytes(raw[1].clone()),
    };
    target.r.store().fail_commits(1);
    target.r.apply_items(vec![rekey.clone()]);
    assert_eq!(target.r.head().seq, 1);
    assert_eq!(
        target.r.policy.epoch, 0,
        "failed rekey restores in-memory policy"
    );
    assert_eq!(
        target.r.sealer.current_epoch(),
        None,
        "failed rekey restores in-memory keys"
    );
    assert_eq!(
        target.r.status(target.s).unwrap_err().code(),
        Some(ErrorCode::Unavailable)
    );
    target.r.apply_items(vec![rekey]);
    assert_eq!(target.r.head().seq, 2);
    assert_eq!(target.r.sealer.current_epoch(), Some(1));
    let reopened = node_with(&svc, 1, target.r.into_store(), vec![], keyed());
    assert_eq!(
        reopened.r.policy.epoch, 1,
        "retry must persist the rekey's policy epoch"
    );
    assert_eq!(
        reopened.r.sealer.current_epoch(),
        Some(1),
        "retry must persist HPKE-unwrapped keys"
    );
}

#[test]
fn failed_control_retry_rechecks_changed_bytes_at_the_same_position() {
    let svc = FakeLogService::new();
    let mut a = node(&svc, 1, MemStore::new());
    settle(&mut [&mut a]);
    let revoked = B16([109; 16]);
    let seq = crate::testkit::TestControlPlane::new(COL).revoke(&svc, revoked);
    a.r.store().fail_commits(1);
    a.r.apply_items(vec![mdbn_wire::log_service::SeqItem {
        seq,
        item: mdbn_wire::common::Bytes(svc.items(&COL)[seq as usize - 1].clone()),
    }]);
    assert!(
        a.r.policy.devices[&revoked].active,
        "uncommitted revocation is not cached as applied"
    );
    assert_eq!(
        a.r.status(a.s).unwrap_err().code(),
        Some(ErrorCode::Unavailable)
    );
    svc.lose_tail(&COL, 1);
    let replaced = crate::testkit::TestControlPlane::new(COL).append(
        &svc,
        vec![mdbn_wire::policy::PolicyOp::Freeze(
            mdbn_wire::policy::Freeze {
                frozen: true,
                reason: None,
            },
        )],
    );
    assert_eq!(replaced, seq);
    a.r.apply_items(vec![mdbn_wire::log_service::SeqItem {
        seq,
        item: mdbn_wire::common::Bytes(svc.items(&COL)[seq as usize - 1].clone()),
    }]);
    assert!(a.r.policy.frozen, "changed control bytes must be evaluated");
    assert!(
        a.r.policy.devices[&revoked].active,
        "failed cached control must not substitute for replacement bytes"
    );
    let reopened = node(&svc, 1, a.r.into_store());
    assert!(reopened.r.policy.frozen);
    assert!(reopened.r.policy.devices[&revoked].active);
}

#[test]
fn opaque_checkpoint_failures_fault_until_reopen_without_serving_or_sealing() {
    for opaque_export in [true, false] {
        let svc = FakeLogService::new();
        let mut base = node(&svc, 1, MemStore::new());
        settle(&mut [&mut base]);
        let no_export = Rc::new(Cell::new(false));
        let fail_import = Rc::new(Cell::new(false));
        let adapter = super::fault_sealer::FaultSealer {
            inner: Box::new(PlainSealer::for_device(B16([101; 16]))),
            no_export: no_export.clone(),
            fail_import: fail_import.clone(),
        };
        let mut a = node_with(
            &svc,
            1,
            base.r.into_store(),
            test_devices(),
            Some(Box::new(adapter)),
        );
        no_export.set(opaque_export);
        fail_import.set(!opaque_export);
        let seq = crate::testkit::TestControlPlane::new(COL).revoke(&svc, B16([109; 16]));
        let item = mdbn_wire::log_service::SeqItem {
            seq,
            item: mdbn_wire::common::Bytes(svc.items(&COL)[seq as usize - 1].clone()),
        };
        a.r.store().fail_commits(1);
        a.r.apply_items(vec![item.clone()]);
        assert!(a.r.apply_fault, "opaque state is never assumed restored");
        assert_eq!(
            a.r.status(a.s).unwrap_err().code(),
            Some(ErrorCode::Unavailable)
        );
        assert!(a.r.build_snapshot_now().is_err(), "no new object sealing");
        a.r.apply_items(vec![item]);
        a.r.tick();
        assert_eq!(a.r.head().seq, BOOT, "faulted control retry cannot apply");
        assert!(
            a.r.take_log_calls().is_empty(),
            "faulted state cannot append or retry"
        );
        let mut reopened = node(&svc, 1, a.r.into_store());
        settle(&mut [&mut reopened]);
        assert!(!reopened.r.apply_fault);
        assert!(!reopened.r.policy.devices[&B16([109; 16])].active);
    }
}

#[test]
fn unknown_control_commit_outcome_or_durability_read_faults_until_reopen() {
    use crate::Store;
    for mode in 0..3 {
        let committed = mode == 0;
        let svc = FakeLogService::new();
        let mut a = node(&svc, 1, MemStore::new());
        settle(&mut [&mut a]);
        let before = a.r.head();
        let seq = crate::testkit::TestControlPlane::new(COL).revoke(&svc, B16([109; 16]));
        let item = mdbn_wire::log_service::SeqItem {
            seq,
            item: mdbn_wire::common::Bytes(svc.items(&COL)[seq as usize - 1].clone()),
        };
        match mode {
            0 => a.r.store().fail_after_commit(1),
            1 => {
                a.r.store().fail_commits(1);
                a.r.store().fail_head_reads(1);
            }
            _ => a.r.store().fail_unknown_commits(1),
        }
        a.r.apply_items(vec![item.clone()]);
        assert!(
            a.r.requires_reopen(),
            "unknown durable state is not guessed, even with unchanged logical reads"
        );
        assert_eq!(
            a.r.status(a.s).unwrap_err().problem().reason.as_deref(),
            Some("apply_reopen_required")
        );
        assert_eq!(a.r.head(), before);
        assert_eq!(
            a.r.store().head().unwrap().seq,
            if committed { seq } else { before.seq }
        );
        assert_eq!(
            a.r.status(a.s).unwrap_err().code(),
            Some(ErrorCode::Unavailable)
        );
        a.r.apply_items(vec![item]);
        a.r.tick();
        assert!(a.r.take_log_calls().is_empty());
        let mut reopened = node(&svc, 1, a.r.into_store());
        settle(&mut [&mut reopened]);
        assert!(!reopened.r.apply_fault);
        assert!(!reopened.r.policy.devices[&B16([109; 16])].active);
    }
}

#[test]
fn control_read_ahead_metadata_failure_restores_policy_before_retry() {
    let svc = FakeLogService::new();
    let mut a = node(&svc, 1, MemStore::new());
    settle(&mut [&mut a]);
    let before = a.r.head();
    let revoked = B16([109; 16]);
    let seq = crate::testkit::TestControlPlane::new(COL).revoke(&svc, revoked);
    let raw = svc.items(&COL)[seq as usize - 1].clone();
    a.r.store().fail_commits(1);
    assert!(a.r.evaluate_control_bytes(seq, &raw).is_err());
    assert!(a.r.policy.devices[&revoked].active);
    assert_eq!(a.r.head(), before);
    assert!(!a.r.apply_fault, "known abort may retry");
    assert_eq!(
        a.r.status(a.s).unwrap_err().code(),
        Some(ErrorCode::Unavailable)
    );
    a.r.evaluate_control_bytes(seq, &raw).unwrap();
    assert!(!a.r.requires_reopen());
    assert_eq!(
        a.r.status(a.s).unwrap_err().problem().reason.as_deref(),
        Some("apply_recovering"),
        "read-ahead alone does not release the barrier"
    );
    assert!(!a.r.policy.devices[&revoked].active);
    assert_eq!(
        a.r.head(),
        before,
        "read-ahead does not install confirmed head"
    );
    a.r.apply_items(vec![mdbn_wire::log_service::SeqItem {
        seq,
        item: mdbn_wire::common::Bytes(raw),
    }]);
    let reopened = node(&svc, 1, a.r.into_store());
    assert!(!reopened.r.policy.devices[&revoked].active);
}

#[test]
fn failed_grant_approval_is_not_served_before_a_verified_retry() {
    let svc = FakeLogService::new();
    let mut a = node(&svc, 1, MemStore::new());
    settle(&mut [&mut a]);
    let grant = B16([0x55; 16]);
    let pk = [0x57; 32];
    let approval = crate::testkit::TestControlPlane::new(COL).approved_grant(
        &svc,
        grant,
        pk,
        &["collection.read"],
        None,
        B16([101; 16]),
    );
    let raw = svc.items(&COL);
    a.r.apply_items(vec![mdbn_wire::log_service::SeqItem {
        seq: approval - 1,
        item: mdbn_wire::common::Bytes(raw[approval as usize - 2].clone()),
    }]);
    assert!(a.r.policy.grant_for_client(&grant, &pk).is_none());
    let item = mdbn_wire::log_service::SeqItem {
        seq: approval,
        item: mdbn_wire::common::Bytes(raw[approval as usize - 1].clone()),
    };
    a.r.store().fail_commits(1);
    a.r.apply_items(vec![item.clone()]);
    assert!(
        a.r.policy.grant_for_client(&grant, &pk).is_none(),
        "failed approval is not effective in memory"
    );
    let hello = || HelloParams {
        versions: vec![Version { major: 1, minor: 0 }],
        client_name: "app".into(),
        client_version: "0".into(),
        features: None,
        timezone: None,
    };
    assert_eq!(
        a.r.hello(
            SessionAuth::Grant {
                grant,
                client_pk: pk
            },
            hello()
        )
        .unwrap_err()
        .code(),
        Some(ErrorCode::Unavailable)
    );
    a.r.apply_items(vec![item]);
    assert!(
        a.r.hello(
            SessionAuth::Grant {
                grant,
                client_pk: pk
            },
            hello()
        )
        .is_ok()
    );
    let mut reopened = node(&svc, 1, a.r.into_store());
    assert!(
        reopened
            .r
            .hello(
                SessionAuth::Grant {
                    grant,
                    client_pk: pk
                },
                hello()
            )
            .is_ok()
    );
}

#[test]
fn sec3_lost_tail_latch_must_deny_granted_reads() {
    let svc = FakeLogService::new();
    let mut a = node(&svc, 1, MemStore::new());
    let mut b = node(&svc, 2, MemStore::new());
    settle(&mut [&mut a, &mut b]);
    let grant = B16([0x55; 16]);
    let pk = [0x57; 32];
    let mut cp = crate::testkit::TestControlPlane::new(COL);
    cp.approved_grant(&svc, grant, pk, &["collection.read"], None, B16([101; 16]));
    settle(&mut [&mut a, &mut b]);
    a.create(1, "one.md", "private content");
    settle(&mut [&mut a, &mut b]);
    let common = svc.head(&COL).0;
    let revoked = B16([109; 16]);
    let seq = cp.revoke(&svc, revoked);
    a.r.apply_items(vec![mdbn_wire::log_service::SeqItem {
        seq,
        item: mdbn_wire::common::Bytes(svc.items(&COL)[seq as usize - 1].clone()),
    }]);
    svc.lose_tail(&COL, svc.head(&COL).0 - common);
    b.create(4, "four.md", "gap");
    settle(&mut [&mut b]);
    a.r.on_log_push(crate::log::LogPush::Reconnected);
    settle(&mut [&mut a]);
    assert!(a.r.latch().devices.contains(&revoked));
    assert_eq!(
        a.r.repair_status().unwrap().phase,
        crate::replica::RepairPhase::AwaitingControl
    );
    assert!(
        a.r.hello(
            SessionAuth::Grant {
                grant,
                client_pk: pk
            },
            recovery_hello()
        )
        .is_err(),
        "SEC-048: only hosting-app reads may be served while lost control is latched"
    );
}

/// An app session open before the lost tail is closed
/// when the fallback latches lost control, nothing more reaches it, a new granted
/// hello is refused while latched, and apps are served again once control is
/// restored.
#[test]
fn app_sessions_close_while_lost_control_is_latched_and_return_after() {
    let svc = FakeLogService::new();
    let mut a = node(&svc, 1, MemStore::new());
    let mut b = node(&svc, 2, MemStore::new());
    settle(&mut [&mut a, &mut b]);
    let grant = B16([0x55; 16]);
    let pk = [0x57; 32];
    let mut cp = crate::testkit::TestControlPlane::new(COL);
    cp.approved_grant(&svc, grant, pk, &["collection.read"], None, B16([101; 16]));
    settle(&mut [&mut a, &mut b]);
    a.create(1, "one.md", "private content");
    settle(&mut [&mut a, &mut b]);
    let (app, _) =
        a.r.hello(
            SessionAuth::Grant {
                grant,
                client_pk: pk,
            },
            recovery_hello(),
        )
        .expect("app session before the loss");
    let common = svc.head(&COL).0;
    let revoked = B16([109; 16]);
    let seq = cp.revoke(&svc, revoked);
    a.r.apply_items(vec![mdbn_wire::log_service::SeqItem {
        seq,
        item: mdbn_wire::common::Bytes(svc.items(&COL)[seq as usize - 1].clone()),
    }]);
    let _ = crate::log::LogClient::poll_pushes(&mut b.log);
    svc.lose_tail(&COL, svc.head(&COL).0 - common);
    b.create(4, "four.md", "gap");
    settle(&mut [&mut b]);
    a.r.take_pushes();
    a.r.on_log_push(crate::log::LogPush::Reconnected);
    settle(&mut [&mut a]);
    assert!(a.r.latch().devices.contains(&revoked));
    let pushes = a.r.take_pushes();
    assert!(
        pushes
            .iter()
            .any(|(s, p)| *s == app && matches!(p, Push::Closed(_))),
        "the app session was closed"
    );
    assert!(
        pushes
            .iter()
            .all(|(s, p)| *s != app || matches!(p, Push::Closed(_))),
        "nothing else reached it"
    );
    assert!(
        a.r.status(app).is_err(),
        "the closed session serves nothing"
    );
    assert!(
        a.r.hello(
            SessionAuth::Grant {
                grant,
                client_pk: pk
            },
            recovery_hello()
        )
        .is_err()
    );
    assert!(a.r.status(a.s).is_ok(), "the hosting app is still served");
    cp.revoke(&svc, revoked);
    settle(&mut [&mut a, &mut b]);
    assert!(a.r.latch().is_empty());
    assert!(
        a.r.hello(
            SessionAuth::Grant {
                grant,
                client_pk: pk
            },
            recovery_hello()
        )
        .is_ok(),
        "apps are served again once control is restored"
    );
}

#[test]
fn sec3_member_latch_must_restrict_current_authority() {
    let svc = FakeLogService::new();
    let mut a = node(&svc, 1, MemStore::new());
    settle(&mut [&mut a]);
    let owner = crate::testkit::TEST_OWNER;
    a.r.latch.members.insert(owner);
    assert!(
        a.r.authorize(owner, COL).is_none(),
        "latched member must not be locally authorized"
    );
}

fn recovery_hello() -> HelloParams {
    HelloParams {
        versions: vec![Version { major: 1, minor: 0 }],
        client_name: "recovery".into(),
        client_version: "0".into(),
        features: None,
        timezone: None,
    }
}

#[test]
fn read_ahead_failure_barrier_survives_a_successful_lower_prefix() {
    let svc = FakeLogService::new();
    let mut a = node(&svc, 1, MemStore::new());
    let mut b = node(&svc, 2, MemStore::new());
    settle(&mut [&mut a, &mut b]);
    let grant = B16([0x55; 16]);
    let pk = [0x57; 32];
    let mut cp = crate::testkit::TestControlPlane::new(COL);
    cp.approved_grant(&svc, grant, pk, &["collection.read"], None, B16([101; 16]));
    settle(&mut [&mut a, &mut b]);
    b.create(10, "old.md", "old private");
    settle(&mut [&mut a, &mut b]);
    let (client, _) =
        a.r.hello(
            SessionAuth::Grant {
                grant,
                client_pk: pk,
            },
            recovery_hello(),
        )
        .unwrap();
    a.r.subscribe(
        client,
        mdbn_wire::common::Value::Map(vec![]),
        mdbn_wire::client::Include {
            effective: None,
            body: Some(true),
            document: Some(true),
            diagnostics: None,
        },
    )
    .unwrap();
    assert!(a.r.pushes.iter().any(|(s, p)| *s == client && matches!(p, Push::QueryUpdate(u) if u.added.as_ref().is_some_and(|r| r.iter().any(|r| r.path == "old.md")))));
    a.r.build_snapshot_now().unwrap();
    assert!(a.r.build.is_some());
    b.create(11, "prefix.md", "private");
    settle(&mut [&mut b]);
    let prefix = svc.head(&COL).0;
    let target = cp.append(
        &svc,
        vec![mdbn_wire::policy::PolicyOp::GrantRevoke(
            mdbn_wire::policy::GrantRevoke { grant },
        )],
    );
    let raw = svc.items(&COL);
    a.r.store().fail_commits(1);
    assert!(
        a.r.evaluate_control_bytes(target, &raw[target as usize - 1])
            .is_err()
    );
    a.r.apply_items(vec![mdbn_wire::log_service::SeqItem {
        seq: prefix,
        item: mdbn_wire::common::Bytes(raw[prefix as usize - 1].clone()),
    }]);
    assert_eq!(a.r.head().seq, prefix);
    assert_eq!(a.r.apply_blocked, Some(target));
    assert!(
        a.r.build.is_none(),
        "late snapshot replies cannot seal while recovering"
    );
    assert!(a.r.endorse.is_none());
    assert!(!a.r.requires_reopen());
    assert_eq!(
        a.r.status(a.s).unwrap_err().problem().reason.as_deref(),
        Some("apply_recovering")
    );
    assert!(a.r.build_snapshot_now().is_err());
    assert!(
        a.r.take_pushes()
            .iter()
            .all(|(_, p)| matches!(p, Push::Closed(_)))
    );
    a.r.evaluate_control_bytes(target, &raw[target as usize - 1])
        .unwrap();
    assert!(
        a.r.is_apply_recovering(),
        "policy read-ahead is not an applied prefix"
    );
    a.r.apply_items(vec![mdbn_wire::log_service::SeqItem {
        seq: target,
        item: mdbn_wire::common::Bytes(raw[target as usize - 1].clone()),
    }]);
    assert!(!a.r.is_apply_recovering());
    assert_eq!(
        a.r.status(a.s).unwrap_err().code(),
        Some(ErrorCode::Unauthenticated),
        "old sessions do not revive"
    );
    assert!(
        a.r.hello(
            SessionAuth::Grant {
                grant,
                client_pk: pk
            },
            recovery_hello()
        )
        .is_err(),
        "old queued snapshot is never released to a revoked grant after recovery"
    );
    assert!(
        a.r.take_pushes()
            .iter()
            .all(|(s, p)| *s != client || !matches!(p, Push::QueryUpdate(_)))
    );
    let (fresh, _) = a.r.hello(SessionAuth::Host, recovery_hello()).unwrap();
    assert!(
        a.r.get(
            fresh,
            crate::api::Target::Path("prefix.md".into()),
            mdbn_wire::client::Include {
                effective: None,
                body: Some(true),
                document: None,
                diagnostics: None
            }
        )
        .is_ok()
    );
}

#[test]
fn prefix_then_unknown_grant_revocation_quarantines_queued_and_new_plaintext() {
    use crate::Store;
    use mdbn_wire::policy::{GrantRevoke, PolicyOp};
    let svc = FakeLogService::new();
    let mut a = node(&svc, 1, MemStore::new());
    let mut b = node(&svc, 2, MemStore::new());
    settle(&mut [&mut a, &mut b]);
    let grant = B16([0x55; 16]);
    let pk = [0x57; 32];
    let mut cp = crate::testkit::TestControlPlane::new(COL);
    cp.approved_grant(&svc, grant, pk, &["collection.read"], None, B16([101; 16]));
    settle(&mut [&mut a, &mut b]);
    b.create(10, "private/old.md", "old secret");
    settle(&mut [&mut a, &mut b]);
    let (client, _) =
        a.r.hello(
            SessionAuth::Grant {
                grant,
                client_pk: pk,
            },
            recovery_hello(),
        )
        .unwrap();
    a.r.subscribe(
        client,
        mdbn_wire::common::Value::Map(vec![]),
        mdbn_wire::client::Include {
            effective: None,
            body: Some(true),
            document: Some(true),
            diagnostics: None,
        },
    )
    .unwrap();
    assert!(a.r.pushes.iter().any(|(s, p)| *s == client && matches!(p, Push::QueryUpdate(u) if u.added.as_ref().is_some_and(|r| r.iter().any(|r| r.path == "private/old.md")))), "already queued private snapshot is non-vacuous");
    b.create(11, "private/prefix.md", "prefix secret");
    settle(&mut [&mut b]);
    let prefix = svc.head(&COL).0;
    let target = cp.append(&svc, vec![PolicyOp::GrantRevoke(GrantRevoke { grant })]);
    let raw = svc.items(&COL);
    a.r.store().fail_after_head_commit(target);
    a.r.apply_items(vec![
        mdbn_wire::log_service::SeqItem {
            seq: prefix,
            item: mdbn_wire::common::Bytes(raw[prefix as usize - 1].clone()),
        },
        mdbn_wire::log_service::SeqItem {
            seq: target,
            item: mdbn_wire::common::Bytes(raw[target as usize - 1].clone()),
        },
    ]);
    assert!(a.r.requires_reopen());
    assert_eq!(a.r.head().seq, prefix);
    assert_eq!(
        a.r.store().head().unwrap().seq,
        target,
        "commit really happened, despite its error"
    );
    let pushes = a.r.take_pushes();
    assert!(
        pushes
            .iter()
            .any(|(s, p)| *s == client && matches!(p, Push::Closed(_)))
    );
    assert!(
        pushes.iter().all(|(_, p)| matches!(p, Push::Closed(_))),
        "neither stale queued nor prefix data escapes: {pushes:?}"
    );
    assert!(a.r.sessions.is_empty());
    assert!(a.r.build_snapshot_now().is_err());
    let mut reopened = node(&svc, 1, a.r.into_store());
    settle(&mut [&mut reopened]);
    assert!(!reopened.r.requires_reopen());
    assert!(reopened.r.policy.grant_for_client(&grant, &pk).is_none());
    assert!(
        reopened
            .r
            .hello(
                SessionAuth::Grant {
                    grant,
                    client_pk: pk
                },
                recovery_hello()
            )
            .is_err(),
        "reopen does not revive revoked client"
    );
    assert!(
        reopened
            .r
            .take_pushes()
            .iter()
            .all(|(s, p)| *s != client || !matches!(p, Push::QueryUpdate(_))),
        "old private query cannot flush after reopen"
    );
}

/// The fake service can lose its tail (failover to a lagging node). A replica that
/// applied the lost items and still retains their bytes repairs the service by
/// re-appending exactly those bytes after the surviving prefix (lost-tail §4):
/// nothing applied is rolled back, nothing is re-sealed, no `integrity` incident.
#[test]
fn lost_tail_is_repaired_with_the_exact_retained_bytes() {
    let svc = FakeLogService::new();
    let mut a = node(&svc, 1, MemStore::new());
    settle(&mut [&mut a]);
    for i in 0..3u8 {
        a.create(i, &format!("n{i}.md"), "x");
    }
    settle(&mut [&mut a]);
    let (h, chain) = svc.head(&COL);
    let before = svc.items(&COL);
    svc.lose_tail(&COL, 2);
    assert_eq!(svc.head(&COL).0, h - 2);
    a.r.on_log_push(crate::log::LogPush::Reconnected);
    settle(&mut [&mut a]);
    assert_eq!(svc.head(&COL), (h, chain), "service restored to our head");
    assert_eq!(svc.items(&COL), before, "exactly the bytes that were lost");
    assert_eq!(a.r.head().seq, h, "nothing applied is rolled back");
    assert_eq!(a.r.repair_status(), None);
    let stats = a.r.repair_stats();
    assert_eq!(
        (stats.repaired, stats.reappended, stats.fallback),
        (1, 2, 0)
    );
    assert!(
        !a.r.sync_status()
            .incidents
            .iter()
            .any(|i| i.kind == mdbn_wire::client::IncidentKind::Integrity),
        "{:?}",
        a.r.sync_status().incidents
    );
    // The append loop resumes after the repair.
    a.create(9, "after.md", "y");
    settle(&mut [&mut a]);
    assert_eq!(svc.head(&COL).0, h + 1);
    assert_eq!(a.r.sync_status().pending, 0);
}

/// Status during and after a repair: `resyncing` while active (not an incident),
/// then gone; `log_regressed` raised on detection (pending), updated with the
/// outcome, persisted across reopen and cleared after 24 hours.
#[test]
fn repair_status_and_the_log_regressed_signal() {
    use mdbn_wire::client::{IncidentKind, ResyncPhase};
    let svc = FakeLogService::new();
    let mut a = node(&svc, 1, MemStore::new());
    settle(&mut [&mut a]);
    for i in 0..3u8 {
        a.create(i, &format!("n{i}.md"), "x");
    }
    settle(&mut [&mut a]);
    let (h, _) = svc.head(&COL);
    svc.lose_tail(&COL, 2);
    a.r.on_log_push(crate::log::LogPush::Reconnected);
    pump(&mut a.r, &mut a.log, 1);
    let st = a.r.sync_status();
    let resync = st.resyncing.expect("re-syncing while active");
    assert!(matches!(
        resync.phase,
        ResyncPhase::Probing | ResyncPhase::Repairing
    ));
    assert_eq!(resync.positions, 2);
    let regressed = |n: &Node| {
        n.r.sync_status()
            .incidents
            .into_iter()
            .find(|i| i.kind == IncidentKind::LogRegressed)
            .and_then(|i| i.details)
    };
    let outcome = |d: Option<mdbn_wire::common::Value>| match d {
        Some(mdbn_wire::common::Value::Map(m)) => {
            m.into_iter().find(|(k, _)| k == "outcome").map(|(_, v)| v)
        }
        _ => None,
    };
    assert_eq!(
        outcome(regressed(&a)),
        Some(mdbn_wire::common::Value::Int(2))
    );
    settle(&mut [&mut a]);
    assert_eq!(a.r.sync_status().resyncing, None);
    assert_eq!(
        outcome(regressed(&a)),
        Some(mdbn_wire::common::Value::Int(0))
    );
    assert_eq!(svc.head(&COL).0, h);
    // Persisted: a reopen still shows it.
    let mut a = node(&svc, 1, a.r.into_store());
    assert_eq!(
        outcome(regressed(&a)),
        Some(mdbn_wire::common::Value::Int(0))
    );
    // Cleared after 24 hours.
    a.clock.set(a.clock.get() + 24 * 60 * 60 * 1000 + 1);
    a.r.tick();
    assert_eq!(regressed(&a), None);
}

/// Missing blob parts (§4.1): a repair batch refused `refs_missing` waits for
/// another holder to upload them, then continues; if nobody does within
/// `REPAIR_REFS_WAIT`, it takes the fallback instead of staying stuck.
#[test]
fn a_repair_waits_bounded_for_missing_blob_parts() {
    for parts_return in [true, false] {
        let svc = FakeLogService::new();
        let mut a = node(&svc, 1, MemStore::new());
        settle(&mut [&mut a]);
        for i in 0..3u8 {
            a.create(i, &format!("n{i}.md"), "x");
        }
        settle(&mut [&mut a]);
        let (h, chain) = svc.head(&COL);
        svc.lose_tail(&COL, 2);
        a.log.faults.refs_missing_appends = if parts_return { 2 } else { u32::MAX };
        a.r.on_log_push(crate::log::LogPush::Reconnected);
        for _ in 0..3 {
            settle(&mut [&mut a]);
            a.clock.set(a.clock.get() + 1_001);
        }
        if parts_return {
            settle(&mut [&mut a]);
            assert_eq!(
                svc.head(&COL),
                (h, chain),
                "repaired once the parts are back"
            );
            assert_eq!(a.r.repair_status(), None);
        } else {
            assert_eq!(
                a.r.repair_status().map(|s| s.phase),
                Some(crate::replica::RepairPhase::Repairing),
                "still waiting inside the bound"
            );
            a.clock
                .set(a.clock.get() + crate::replica::lost_tail_refs_wait_ms() as u64 + 1);
            a.r.tick();
            settle(&mut [&mut a]);
            assert_eq!(
                a.r.repair_stats().fallback,
                1,
                "never stuck: fallback taken"
            );
        }
    }
}

/// Writes made while the service is short are held until it is repaired, and are
/// then appended after the restored items, never into the gap.
#[test]
fn writes_wait_for_the_repair_and_land_after_it() {
    let svc = FakeLogService::new();
    let mut a = node(&svc, 1, MemStore::new());
    settle(&mut [&mut a]);
    for i in 0..3u8 {
        a.create(i, &format!("n{i}.md"), "x");
    }
    settle(&mut [&mut a]);
    let (h, _) = svc.head(&COL);
    let before = svc.items(&COL);
    svc.lose_tail(&COL, 3);
    a.r.on_log_push(crate::log::LogPush::Reconnected);
    a.create(7, "during.md", "z");
    settle(&mut [&mut a]);
    let after = svc.items(&COL);
    assert_eq!(&after[..before.len()], &before[..], "restored prefix first");
    assert_eq!(after.len() as u64, h + 1, "then the held write");
    assert_eq!(a.doc(7).as_deref(), Some("z"));
    assert_eq!(a.r.sync_status().pending, 0);
}

/// Two devices that both applied the lost items repair concurrently; they converge
/// on the same restored log (I4), and a device that never saw the lost items reads
/// them normally.
#[test]
fn concurrent_repairers_converge_and_late_devices_read_the_restored_items() {
    let svc = FakeLogService::new();
    let mut a = node(&svc, 1, MemStore::new());
    let mut b = node(&svc, 2, MemStore::new());
    settle(&mut [&mut a, &mut b]);
    for i in 0..4u8 {
        a.create(i, &format!("n{i}.md"), "x");
    }
    settle(&mut [&mut a, &mut b]);
    let (h, chain) = svc.head(&COL);
    let before = svc.items(&COL);
    svc.lose_tail(&COL, 3);
    a.r.on_log_push(crate::log::LogPush::Reconnected);
    b.r.on_log_push(crate::log::LogPush::Reconnected);
    settle(&mut [&mut a, &mut b]);
    assert_eq!(svc.head(&COL), (h, chain));
    assert_eq!(svc.items(&COL), before);
    assert_eq!(a.r.head(), b.r.head());
    assert_eq!(a.r.repair_status(), None);
    assert_eq!(b.r.repair_status(), None);
    let mut c = node(&svc, 3, MemStore::new());
    settle(&mut [&mut a, &mut b, &mut c]);
    assert_eq!(c.r.head().seq, h);
    assert_eq!(c.doc(3).as_deref(), Some("x"));
}

/// When another writer already took the lost positions (`L < S`), re-appending is
/// impossible. The fallback (§5) rolls this replica back to the service's history
/// and resurrects its own acknowledged writes at new positions: no acknowledged
/// write is lost, nothing is appended into the gap, and both devices converge.
#[test]
fn an_overwritten_gap_rolls_back_and_resurrects_own_acknowledged_writes() {
    let svc = FakeLogService::new();
    let mut a = node(&svc, 1, MemStore::new());
    let mut b = node(&svc, 2, MemStore::new());
    settle(&mut [&mut a, &mut b]);
    a.create(1, "one.md", "x");
    settle(&mut [&mut a, &mut b]);
    let common = svc.head(&COL).0;
    // A applies two more writes that B never sees, then the service loses them.
    let m2 = a.create(2, "two.md", "a2").mutation;
    let m3 = a.create(3, "three.md", "a3").mutation;
    a.pump();
    let lost = svc.head(&COL).0;
    assert!(lost > common);
    let lost_bytes = svc.items(&COL)[common as usize..].to_vec();
    svc.lose_tail(&COL, lost - common);
    // B writes into the gap before A reconnects.
    b.create(4, "four.md", "b4");
    settle(&mut [&mut b]);
    a.create(5, "five.md", "a5");
    a.r.on_log_push(crate::log::LogPush::Reconnected);
    settle(&mut [&mut a, &mut b]);
    assert_eq!(a.r.repair_status(), None);
    let stats = a.r.repair_stats();
    assert_eq!(
        (stats.fallback, stats.rolled_back, stats.resurrected),
        (1, 1, 2)
    );
    // Every acknowledged write is in the log once, at a new position, alongside B's.
    for (id, doc) in [(1, "x"), (2, "a2"), (3, "a3"), (4, "b4"), (5, "a5")] {
        assert_eq!(a.doc(id).as_deref(), Some(doc), "a: {id}");
        assert_eq!(b.doc(id).as_deref(), Some(doc), "b: {id}");
    }
    let items = svc.items(&COL);
    assert!(
        lost_bytes.iter().all(|lost| !items.contains(lost)),
        "the lost bytes were not re-appended over the new history"
    );
    assert_eq!(a.r.head(), b.r.head());
    assert_eq!(a.r.sync_status().pending, 0);
    assert!(a.r.resurrected.is_empty(), "resurrection set drained");
    // Their log receipts are at the new positions.
    for m in [m2, m3] {
        let r = crate::Store::receipt(a.r.store(), &m)
            .unwrap()
            .expect("receipt");
        assert!(r.seq > common + 1, "{m:?}: {}", r.seq);
    }
}

/// Another author's entry lost with the tail is an orphan here: not re-appended
/// by this replica, cleared once its author resurrects it, and reported in
/// `lost_entries` only if it is still missing after the grace.
#[test]
fn other_authors_lost_entries_are_orphans_until_their_author_resurrects_them() {
    for author_returns in [true, false] {
        let svc = FakeLogService::new();
        let mut a = node(&svc, 1, MemStore::new());
        let mut b = node(&svc, 2, MemStore::new());
        let mut c = node(&svc, 3, MemStore::new());
        settle(&mut [&mut a, &mut b, &mut c]);
        a.create(1, "one.md", "x");
        settle(&mut [&mut a, &mut b, &mut c]);
        let common = svc.head(&COL).0;
        // B writes; A and B apply it; C never sees it; the service loses it.
        b.create(2, "b2.md", "from b");
        settle(&mut [&mut a, &mut b]);
        assert_eq!(a.doc(2).as_deref(), Some("from b"));
        // C was offline: it never receives B's write.
        let _ = crate::log::LogClient::poll_pushes(&mut c.log);
        svc.lose_tail(&COL, svc.head(&COL).0 - common);
        c.r.on_log_push(crate::log::LogPush::Reconnected);
        c.create(3, "c3.md", "from c");
        settle(&mut [&mut c]);
        a.r.set_orphan_grace(60_000);
        a.r.on_log_push(crate::log::LogPush::Reconnected);
        settle(&mut [&mut a, &mut c]);
        assert_eq!(
            a.r.repair_stats().rolled_back,
            1,
            "{:?} {:?} {:?} svc {} a {}",
            a.r.repair_stats(),
            a.r.repair_status(),
            a.r.sync_status().incidents,
            svc.head(&COL).0,
            a.r.head().seq
        );
        assert_eq!(
            a.doc(2),
            None,
            "B's lost write is not in the service's history"
        );
        assert_eq!(a.r.orphans().len(), 1);
        assert_eq!(a.r.orphans()[0].author, B16([102; 16]));
        if author_returns {
            b.r.on_log_push(crate::log::LogPush::Reconnected);
            settle(&mut [&mut a, &mut b, &mut c]);
            assert_eq!(b.r.repair_stats().resurrected, 1);
            assert_eq!(
                a.doc(2).as_deref(),
                Some("from b"),
                "resurrected by its author"
            );
            assert!(a.r.orphans().is_empty(), "orphan cleared");
        } else {
            a.clock.set(a.clock.get() + 60_001);
            a.r.tick();
            assert!(a.r.orphans()[0].lost);
            let lost =
                a.r.sync_status()
                    .incidents
                    .into_iter()
                    .find(|i| i.kind == mdbn_wire::client::IncidentKind::LostEntries)
                    .expect("lost_entries after the grace");
            let text = format!("{:?}", lost.details);
            assert!(
                text.contains("66666666-6666-6666-6666-666666666666"),
                "{text}"
            );
        }
    }
}

/// Resurrection mode (core-B `Stage::Resurrect`) with the real planner: a lost
/// create whose path another device took meanwhile is not rejected; it lands at
/// the collision rule's path, and other devices verify it in the same stage.
#[test]
fn a_resurrected_create_at_a_taken_path_lands_renamed_and_verifies() {
    let svc = FakeLogService::new();
    let mut a = node(&svc, 1, MemStore::new());
    let mut b = node(&svc, 2, MemStore::new());
    a.r.planner = Box::new(crate::plan::CorePlanner);
    b.r.planner = Box::new(crate::plan::CorePlanner);
    settle(&mut [&mut a, &mut b]);
    let config =
        a.r.submit(
            a.s,
            SubmitParams {
                ops: vec![Op::ResourcePut(mdbn_wire::intent::ResourcePut {
                    path: "mdbase.yaml".into(),
                    doc: Text::Inline("spec_version: \"0.3.0\"\n".into()),
                    base_revision: None,
                    must_not_exist: None,
                })],
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
        .expect("config");
    assert!(config[0].problem.is_none(), "{:?}", config[0].problem);
    settle(&mut [&mut a, &mut b]);
    let first = a.create(1, "one.md", "x");
    assert!(first.problem.is_none(), "{:?}", first.problem);
    settle(&mut [&mut a, &mut b]);
    let common = svc.head(&COL).0;
    let second = a.create(2, "same.md", "from a");
    assert!(second.problem.is_none(), "{:?}", second.problem);
    settle(&mut [&mut a]);
    assert!(a.r.head().seq > common, "A applied its write");
    svc.lose_tail(&COL, svc.head(&COL).0 - common);
    b.create(4, "same.md", "from b");
    settle(&mut [&mut b]);
    a.r.on_log_push(crate::log::LogPush::Reconnected);
    settle(&mut [&mut a, &mut b]);
    assert_eq!(
        a.r.repair_stats().rolled_back,
        1,
        "{:?} {:?} {:?}",
        a.r.repair_stats(),
        a.r.repair_status(),
        a.r.sync_status().incidents
    );
    let path = |n: &Node, id: u8| {
        crate::Store::record(n.r.store(), &B16([id; 16]))
            .unwrap()
            .map(|r| r.path)
    };
    assert_eq!(
        path(&a, 4).as_deref(),
        Some("same.md"),
        "B's write keeps the path"
    );
    let moved = path(&a, 2).expect("A's acknowledged write is not lost");
    assert_ne!(moved, "same.md", "resurrected at the collision rule's path");
    assert_eq!(path(&b, 2), Some(moved));
    assert_eq!(
        b.r.stats.verify_mismatch, 0,
        "B re-executed it in resurrection mode"
    );
    assert_eq!(a.r.head(), b.r.head());
}

/// The fallback against a compacted service (§5 step 2, primary): after the
/// rollback to genesis, the ordinary path installs the service's snapshot through
/// the verified install, reads the tail, and the own lost writes are resurrected.
#[test]
fn rollback_against_a_compacted_service_installs_its_snapshot() {
    let svc = FakeLogService::new();
    let mut a = node(&svc, 1, MemStore::new());
    let mut b = node(&svc, 2, MemStore::new());
    settle(&mut [&mut a, &mut b]);
    for i in 0..5u8 {
        b.create(i, &format!("n{i}.md"), "x");
    }
    settle(&mut [&mut a, &mut b]);
    b.r.build_snapshot_now().unwrap();
    settle(&mut [&mut a, &mut b]);
    let common = svc.head(&COL).0;
    svc.compact(&COL, common);
    // A applies two writes that B never sees; the service loses them.
    a.create(10, "a10.md", "lost 1");
    a.create(11, "a11.md", "lost 2");
    settle(&mut [&mut a]);
    let _ = crate::log::LogClient::poll_pushes(&mut b.log);
    svc.lose_tail(&COL, svc.head(&COL).0 - common);
    b.create(20, "b20.md", "gap");
    settle(&mut [&mut b]);
    let installed = a.r.stats.snapshots_installed;
    a.r.on_log_push(crate::log::LogPush::Reconnected);
    settle(&mut [&mut a, &mut b]);
    assert_eq!(
        a.r.repair_stats().rolled_back,
        1,
        "{:?} {:?} {:?} svc {} a {} inst {}",
        a.r.repair_stats(),
        a.r.repair_status(),
        a.r.sync_status().incidents,
        svc.head(&COL).0,
        a.r.head().seq,
        a.r.installing()
    );
    assert_eq!(
        a.r.stats.snapshots_installed,
        installed + 1,
        "verified install"
    );
    for (id, doc) in [(0, "x"), (10, "lost 1"), (11, "lost 2"), (20, "gap")] {
        assert_eq!(a.doc(id).as_deref(), Some(doc), "a: {id}");
        assert_eq!(b.doc(id).as_deref(), Some(doc), "b: {id}");
    }
    assert_eq!(a.r.head(), b.r.head());
}

/// A lost control-plane revocation is latched: after the rollback
/// the revoked device is active again in the service's history, but this replica
/// keeps enforcing the revocation and plans and seals nothing until the control
/// plane re-issues it. Then the latch clears and held work proceeds.
#[test]
fn a_lost_revocation_is_latched_until_the_control_plane_reissues_it() {
    let svc = FakeLogService::new();
    let mut a = node(&svc, 1, MemStore::new());
    let mut b = node(&svc, 2, MemStore::new());
    settle(&mut [&mut a, &mut b]);
    a.create(1, "one.md", "x");
    settle(&mut [&mut a, &mut b]);
    let common = svc.head(&COL).0;
    let revoked = B16([109; 16]);
    let seq = crate::testkit::TestControlPlane::new(COL).revoke(&svc, revoked);
    // A applies the revocation (and nothing else) before the service loses it.
    a.r.apply_items(vec![mdbn_wire::log_service::SeqItem {
        seq,
        item: mdbn_wire::common::Bytes(svc.items(&COL)[seq as usize - 1].clone()),
    }]);
    assert!(!a.r.policy.devices[&revoked].active);
    svc.lose_tail(&COL, svc.head(&COL).0 - common);
    b.create(4, "four.md", "b4");
    settle(&mut [&mut b]);
    let service = svc.head(&COL);
    a.create(5, "five.md", "held");
    a.r.on_log_push(crate::log::LogPush::Reconnected);
    settle(&mut [&mut a]);
    assert_eq!(a.r.repair_stats().rolled_back, 1);
    assert!(
        a.r.policy.devices[&revoked].active,
        "the service's history lacks it"
    );
    assert!(
        a.r.latch().devices.contains(&revoked),
        "but this replica latched it"
    );
    assert_eq!(
        a.r.repair_status().map(|s| s.phase),
        Some(crate::replica::RepairPhase::AwaitingControl)
    );
    assert_eq!(
        svc.head(&COL),
        service,
        "nothing planned or sealed while latched"
    );
    assert_eq!(a.doc(4).as_deref(), Some("b4"), "reads continue");
    // Reopen: the latch is durable.
    let a2 = node(&svc, 1, a.r.into_store());
    assert!(a2.r.latch().devices.contains(&revoked));
    let mut a = a2;
    // The control plane's outbox re-issues the revocation at a new position.
    crate::testkit::TestControlPlane::new(COL).revoke(&svc, revoked);
    settle(&mut [&mut a, &mut b]);
    assert!(
        a.r.latch().is_empty(),
        "restored revocation clears the latch"
    );
    assert_eq!(a.r.repair_status(), None);
    assert!(!a.r.policy.devices[&revoked].active);
    assert_eq!(a.doc(5).as_deref(), Some("held"));
    assert_eq!(
        b.doc(5).as_deref(),
        Some("held"),
        "held write appended after"
    );
    assert_eq!(a.r.sync_status().pending, 0);
}

/// A lost window holding device-authored control items (here A's rekey after a
/// revocation) is restored by the protocol: the lost revocation is latched until
/// the control plane re-issues it, the restored revocation sets `rekey_required`
/// again, and a fresh rekey precedes any content. Nothing is sealed meanwhile.
#[test]
fn a_lost_revocation_rekey_is_recreated_after_the_revocation_returns() {
    use mdbn_wire::envelope::ItemKind;
    let svc = FakeLogService::new();
    let mut a = node(&svc, 1, MemStore::new());
    let mut b = node(&svc, 2, MemStore::new());
    settle(&mut [&mut a, &mut b]);
    a.create(1, "one.md", "x");
    settle(&mut [&mut a, &mut b]);
    let common = svc.head(&COL).0;
    let revoked = B16([109; 16]);
    crate::testkit::TestControlPlane::new(COL).revoke(&svc, revoked);
    settle(&mut [&mut a]);
    let kinds = |from: u64| -> Vec<ItemKind> {
        svc.items(&COL)[from as usize..]
            .iter()
            .map(|b| {
                <mdbn_wire::envelope::Item as mdbn_wire::schema::Wire>::from_bytes(b)
                    .unwrap()
                    .kind
            })
            .collect()
    };
    assert!(
        kinds(common).contains(&ItemKind::Rekey),
        "A rekeyed after the revocation"
    );
    let _ = crate::log::LogClient::poll_pushes(&mut b.log);
    svc.lose_tail(&COL, svc.head(&COL).0 - common);
    b.create(4, "four.md", "b4");
    settle(&mut [&mut b]);
    let service = svc.head(&COL);
    a.create(5, "five.md", "held");
    a.r.on_log_push(crate::log::LogPush::Reconnected);
    settle(&mut [&mut a]);
    assert_eq!(a.r.repair_stats().rolled_back, 1);
    assert!(a.r.latch().devices.contains(&revoked));
    assert_eq!(
        svc.head(&COL),
        service,
        "nothing sealed while the revocation is lost"
    );
    // The control plane's outbox re-issues the revocation.
    let reissued = crate::testkit::TestControlPlane::new(COL).revoke(&svc, revoked);
    settle(&mut [&mut a, &mut b]);
    assert!(a.r.latch().is_empty());
    let after = kinds(reissued);
    let rekey = after
        .iter()
        .position(|k| *k == ItemKind::Rekey)
        .expect("rekey re-created");
    let content = after
        .iter()
        .position(|k| *k == ItemKind::Entry)
        .expect("held write");
    assert!(rekey < content, "the rekey precedes any content: {after:?}");
    assert_eq!(
        b.doc(5).as_deref(),
        Some("held"),
        "readable under the fresh epoch"
    );
    assert_eq!(a.r.head(), b.r.head());
}

/// A false `duplicate` for a position holding someone else's item is
/// reported, never confirms the write, and doesn't stop the append loop: the
/// mutation stays pending and is appended once the service answers honestly.
#[test]
fn false_duplicate_does_not_stop_appending() {
    let svc = FakeLogService::new();
    let mut a = node(&svc, 1, MemStore::new());
    settle(&mut [&mut a]);
    a.create(1, "one.md", "x");
    settle(&mut [&mut a]);
    let at = a.r.head().seq;
    // Every append for a while is answered "duplicate at 1" (someone else's item);
    // then for a position beyond the head.
    a.log.faults.false_duplicate = Some((3, 1));
    let r = a.create(2, "two.md", "y");
    for _ in 0..5 {
        a.pump();
        a.clock.set(a.clock.get() + 10_000);
        a.r.tick();
    }
    a.log.faults.false_duplicate = Some((2, at + 50));
    for _ in 0..5 {
        a.pump();
        a.clock.set(a.clock.get() + 10_000);
        a.r.tick();
    }
    settle(&mut [&mut a]);
    let got = a.r.receipt(a.s, r.mutation).unwrap();
    assert_eq!(got.state, ReceiptState::Confirmed);
    assert_eq!(got.seq, Some(at + 1), "appended at the next real position");
    // Later writes keep flowing.
    let r3 = a.create(3, "three.md", "z");
    settle(&mut [&mut a]);
    assert_eq!(
        a.r.receipt(a.s, r3.mutation).unwrap().state,
        ReceiptState::Confirmed
    );
    assert!(
        a.r.sync_status()
            .incidents
            .iter()
            .any(|i| i.kind == mdbn_wire::client::IncidentKind::Integrity)
    );
}

#[test]
fn sec3_repair_head_moved_mid_batch_must_reprobe() {
    use crate::log::{LogClient, LogRequest};
    let svc = FakeLogService::new();
    let mut a = node(&svc, 1, MemStore::new());
    let mut b = node(&svc, 2, MemStore::new());
    settle(&mut [&mut a, &mut b]);
    for id in 1..=70u8 {
        a.create(id, &format!("{id}.md"), "retained");
        settle(&mut [&mut a]);
    }
    let h = a.r.head().seq;
    svc.lose_tail(&COL, h - BOOT);
    let _ = LogClient::poll_pushes(&mut b.log);
    // The host reconnects: a fresh authenticated session (which also dispatches
    // `Reconnected`), then one call at a time by hand.
    a.session = None;
    let session = a.session().unwrap();
    let take = |a: &mut Node, want: fn(&LogRequest) -> bool| {
        let mut calls = a.r.take_authenticated_log_calls(&session).unwrap();
        let i = calls
            .iter()
            .position(|(c, _)| want(&c.request))
            .expect("expected call");
        calls.swap_remove(i)
    };
    let (subscribed, scope) = take(&mut a, |r| matches!(r, LogRequest::Subscribe { .. }));
    let answer = a.log.call(subscribed.request);
    a.r.on_authenticated_log_reply(scope, move |_, _| answer)
        .unwrap();
    let (probe, scope) = take(&mut a, |r| matches!(r, LogRequest::Read(_)));
    let answer = a.log.call(probe.request);
    a.r.on_authenticated_log_reply(scope, move |_, _| answer)
        .unwrap();
    let (repair, scope) = take(&mut a, |r| matches!(r, LogRequest::Append(_)));
    // A stale ordinary writer wins one position while the repair batch is in flight.
    b.create(250, "gap.md", "other writer");
    settle(&mut [&mut b]);
    assert_eq!(svc.head(&COL).0, BOOT + 1);
    let answer = a.log.call(repair.request);
    assert!(matches!(
        answer,
        Ok(crate::log::LogResponse::Append(
            mdbn_wire::log_service::AppendResult::HeadMoved(_)
        ))
    ));
    a.r.on_authenticated_log_reply(scope, move |_, _| answer)
        .unwrap();
    a.r.tick();
    assert!(
        !a.r.take_log_calls().is_empty(),
        "honest head_moved inside repair range must schedule a fresh probe, not leave a dead in-flight call"
    );
}

/// A probe reply delivered without authenticated provenance (legacy `LogPort`)
/// is never prefix evidence: the probe parks (nothing re-appended, nothing
/// rolled back, no incident) until an authenticated session re-detects the
/// lost tail, and then the exact bytes are repaired as usual.
#[test]
fn a_legacy_probe_reply_parks_the_repair_until_an_authenticated_session_proves_it() {
    let svc = FakeLogService::new();
    let mut a = node(&svc, 1, MemStore::new());
    settle(&mut [&mut a]);
    for i in 0..3u8 {
        a.create(i, &format!("n{i}.md"), "x");
    }
    settle(&mut [&mut a]);
    let (h, chain) = svc.head(&COL);
    svc.lose_tail(&COL, 2);
    // Legacy delivery: the lifecycle push retires the session, the generic pump
    // answers the subscribe and the probe without provenance.
    a.r.on_log_push(crate::log::LogPush::Reconnected);
    pump(&mut a.r, &mut a.log, 20);
    assert_eq!(
        svc.head(&COL).0,
        h - 2,
        "nothing re-appended on a parked probe"
    );
    assert!(matches!(
        a.r.repair_status(),
        Some(crate::replica::RepairStatus {
            phase: crate::replica::RepairPhase::Probing,
            ..
        })
    ));
    assert_eq!(a.r.repair_stats().refused, 1);
    assert!(a.r.take_log_calls().is_empty(), "parked: no re-sent probe");
    assert!(
        !a.r.sync_status()
            .incidents
            .iter()
            .any(|i| i.kind == mdbn_wire::client::IncidentKind::Integrity)
    );
    // The host binds an authenticated session: re-detection, proof, repair.
    settle(&mut [&mut a]);
    assert_eq!(svc.head(&COL), (h, chain));
    assert_eq!(a.r.repair_status(), None);
    assert_eq!(a.r.repair_stats().repaired, 1);
}

/// An unretained-member regression: a validated member-remove this
/// replica applied but did not retain must not be forgotten. With `L` unproven
/// the fallback holds (fails closed) instead of rolling back; the removed account
/// stays unauthorized and apps stay closed. Holding instead of rolling back
/// preserves revocation when coverage is unknown.
#[test]
fn sec3_unretained_member_removal_must_remain_locally_revoked() {
    use mdbn_wire::policy::{MemberRemove, MemberSet, PolicyOp, Role};
    let svc = FakeLogService::new();
    let mut a = node(&svc, 1, MemStore::new());
    let mut b = node(&svc, 2, MemStore::new());
    settle(&mut [&mut a, &mut b]);
    let removed = B16([0x88; 16]);
    let mut cp = crate::testkit::TestControlPlane::new(COL);
    cp.append(
        &svc,
        vec![PolicyOp::MemberSet(MemberSet {
            account: removed,
            role: Role::Editor,
        })],
    );
    settle(&mut [&mut a, &mut b]);
    let common = svc.head(&COL).0;
    a.r.set_tail_retention(crate::store::TailRetention {
        min_positions: 0,
        min_age_ms: 0,
        max_bytes: 1,
    });
    let seq = cp.append(
        &svc,
        vec![PolicyOp::MemberRemove(MemberRemove { account: removed })],
    );
    a.r.apply_items(vec![mdbn_wire::log_service::SeqItem {
        seq,
        item: mdbn_wire::common::Bytes(svc.items(&COL)[seq as usize - 1].clone()),
    }]);
    assert!(!a.r.policy.members.contains_key(&removed));
    assert_eq!(a.r.tail_stats.count, 0);
    svc.lose_tail(&COL, svc.head(&COL).0 - common);
    let _ = crate::log::LogClient::poll_pushes(&mut b.log);
    b.create(250, "gap.md", "other writer");
    settle(&mut [&mut b]);
    a.r.on_log_push(crate::log::LogPush::Reconnected);
    settle(&mut [&mut a]);
    assert_eq!(
        a.r.repair_stats().rolled_back,
        0,
        "unproven L: held, not rolled back"
    );
    assert_eq!(
        a.r.repair_status().map(|s| s.phase),
        Some(crate::replica::RepairPhase::FallbackRequired)
    );
    assert!(
        a.r.authorize(removed, COL).is_none(),
        "unknown retained window must not forget applied member removal and authorize the account again"
    );
    assert!(a.r.lost_control_pending(), "apps stay closed while held");
    // User-visible: re-syncing (awaiting control) plus a needs-attention reason.
    let status = a.r.sync_status();
    assert_eq!(
        status.resyncing.map(|r| r.phase),
        Some(mdbn_wire::client::ResyncPhase::AwaitingControl)
    );
    let lost = status
        .incidents
        .iter()
        .find(|i| i.kind == mdbn_wire::client::IncidentKind::LostEntries)
        .expect("lost_entries incident");
    let text = format!("{:?}", lost.details);
    assert!(
        text.contains("needs_attention") && text.contains("lost_tail_unprovable"),
        "{text}"
    );
}

fn has_integrity(n: &Node) -> bool {
    n.r.sync_status()
        .incidents
        .iter()
        .any(|i| i.kind == mdbn_wire::client::IncidentKind::Integrity)
}

/// Open `store` as node `n` with the genesis pinned (no hello, no settle).
fn open_pinned(
    n: u8,
    store: MemStore,
    pin: mdbn_wire::common::Hash,
) -> Result<Replica<MemStore>, crate::replica::OpenError> {
    let cfg = ReplicaConfig {
        collection: COL,
        replica_id: B16([n; 16]),
        device_id: B16([n + 100; 16]),
        mode: mdbn_wire::client::SyncMode::Synced,
        log_endpoint: EndpointId(1),
        verify: true,
        runtime_version: "test".into(),
        trusted_roots: vec![crate::testkit::TEST_ROOT, crate::testkit::signed_root()],
        e2e: false,
        trusted_signers: test_devices(),
        user_enabled_cloud_copy: false,
        chosen_state: None,
        expected_genesis: Some(pin),
        policy_pins: None,
        key_grants_only: false,
    };
    Replica::open(
        cfg,
        store,
        Box::new(TestPlanner),
        Box::new(PlainSealer::for_device(B16([n + 100; 16]))),
        Host {
            clock: Box::new(TestClock(Rc::new(Cell::new(1_700_000_000_000)))),
            entropy: Box::new(crate::crypto::TestEntropy::new(n)),
            zones: Box::new(UtcOnly),
        },
        DeviceSecrets {
            sign_sk: [n; 32],
            kem_sk: [n; 32],
        },
    )
}

fn genesis_of(svc: &FakeLogService) -> mdbn_wire::common::Hash {
    mdbn_wire::hash::chain_hash(&svc.items(&COL)[0])
}

/// The pinned genesis syncs normally, cold and after a warm reopen (reconnect).
#[test]
fn pinned_genesis_matching_syncs_and_reopens() {
    let svc = FakeLogService::new();
    let mut boot = node(&svc, 1, MemStore::new());
    settle(&mut [&mut boot]);
    let genesis = genesis_of(&svc);
    let mut b = node_pinned(
        &svc,
        2,
        MemStore::new(),
        test_devices(),
        None,
        Some(genesis),
    );
    boot.create(1, "x.md", "x");
    settle(&mut [&mut boot, &mut b]);
    assert_eq!(b.r.head(), boot.r.head());
    assert_eq!(b.r.sync_status().incidents, vec![]);
    let mut b = node_pinned(
        &svc,
        2,
        b.r.into_store(),
        test_devices(),
        None,
        Some(genesis),
    );
    boot.create(2, "y.md", "y");
    settle(&mut [&mut boot, &mut b]);
    assert_eq!(b.r.head(), boot.r.head());
    assert_eq!(b.r.confirmed_records().unwrap().len(), 2);
    assert!(!b.r.requires_reopen());
}

/// Cold: a log whose seq 1 differs from the pin is a terminal integrity incident;
/// nothing is applied and nothing is served, including to an open session.
#[test]
fn pinned_genesis_cold_mismatch_is_terminal() {
    let svc = FakeLogService::new();
    let mut boot = node(&svc, 1, MemStore::new());
    boot.create(1, "x.md", "x");
    settle(&mut [&mut boot]);
    let mut other = genesis_of(&svc);
    other.0[0] ^= 1;
    let mut a = node_pinned(&svc, 2, MemStore::new(), test_devices(), None, Some(other));
    settle(&mut [&mut a]);
    assert_eq!(a.r.head().seq, 0, "nothing applied");
    assert!(a.r.confirmed_records().unwrap().is_empty());
    assert!(has_integrity(&a));
    assert!(a.r.requires_reopen());
    assert_eq!(
        a.r.status(a.s).unwrap_err().code(),
        Some(ErrorCode::Unavailable),
        "the open session is closed"
    );
    assert!(
        a.r.take_pushes()
            .iter()
            .all(|(_, p)| matches!(p, Push::Closed(_)))
    );
    assert!(node_hello(&mut a.r).is_err(), "no new session");
    assert!(a.r.take_log_calls().is_empty(), "no further log traffic");
}

/// Same collection ID, same trusted root, a different genesis: refused.
#[test]
fn pinned_genesis_refuses_another_log_with_the_same_collection_and_root() {
    let theirs = FakeLogService::new();
    crate::testkit::TestControlPlane::new(COL).bootstrap(
        &theirs,
        mdbn_wire::policy::CState::CloudCopy,
        &test_devices(),
    );
    let ours = FakeLogService::new();
    crate::testkit::TestControlPlane::new(COL).bootstrap(
        &ours,
        mdbn_wire::policy::CState::E2e,
        &test_devices(),
    );
    assert_ne!(genesis_of(&theirs), genesis_of(&ours));
    let mut a = node_pinned(
        &theirs,
        2,
        MemStore::new(),
        test_devices(),
        None,
        Some(genesis_of(&ours)),
    );
    settle(&mut [&mut a]);
    assert_eq!(a.r.head().seq, 0);
    assert!(has_integrity(&a));
    assert!(a.r.requires_reopen());
}

/// Warm: a store built from another genesis, or with no recorded genesis, is
/// refused at open, before anything is served.
#[test]
fn pinned_genesis_warm_mismatch_refuses_open() {
    let svc = FakeLogService::new();
    let mut a = node(&svc, 1, MemStore::new());
    a.create(1, "x.md", "x");
    settle(&mut [&mut a]);
    let genesis = genesis_of(&svc);
    let mut other = genesis;
    other.0[0] ^= 1;
    let mut store = a.r.into_store();
    assert!(matches!(
        open_pinned(1, store.clone(), other),
        Err(crate::replica::OpenError::Mismatch(_))
    ));
    assert!(open_pinned(1, store.clone(), genesis).is_ok());
    crate::store::Store::commit(
        &mut store,
        crate::store::Tx {
            meta: vec![(crate::store::meta_keys::GENESIS.into(), None)],
            ..crate::store::Tx::default()
        },
    )
    .unwrap();
    assert!(matches!(
        open_pinned(1, store, genesis),
        Err(crate::replica::OpenError::Mismatch(_))
    ));
}

/// The snapshot-install control path checks the pin too, and a store that has not
/// applied the pinned seq 1 evaluates no later control item.
#[test]
fn pinned_genesis_guards_the_install_path() {
    let svc = FakeLogService::new();
    let mut a = node(&svc, 1, MemStore::new());
    for i in 0..30u8 {
        a.create(i, &format!("n{i}.md"), &format!("doc {i}"));
    }
    settle(&mut [&mut a]);
    a.r.build_snapshot_now().unwrap();
    settle(&mut [&mut a]);
    svc.compact(&COL, BOOT + 30);
    let genesis = genesis_of(&svc);
    let mut other = genesis;
    other.0[0] ^= 1;

    let mut b = node_pinned(
        &svc,
        2,
        MemStore::new(),
        test_devices(),
        None,
        Some(genesis),
    );
    settle(&mut [&mut a, &mut b]);
    assert_eq!(b.r.stats.snapshots_installed, 1);
    assert_eq!(b.r.head(), a.r.head());
    assert_eq!(b.r.sync_status().incidents, vec![]);
    // The installed store recorded the genesis: it reopens warm under the pin.
    let mut b = node_pinned(
        &svc,
        2,
        b.r.into_store(),
        test_devices(),
        None,
        Some(genesis),
    );
    a.create(99, "after.md", "after");
    settle(&mut [&mut a, &mut b]);
    assert_eq!(b.r.head(), a.r.head());

    let mut c = node_pinned(&svc, 3, MemStore::new(), test_devices(), None, Some(other));
    settle(&mut [&mut a, &mut c]);
    assert_eq!(c.r.stats.snapshots_installed, 0);
    assert_eq!(c.r.head().seq, 0);
    assert!(c.r.confirmed_records().unwrap().is_empty());
    assert!(c.r.requires_reopen());

    let raw = svc.items(&COL);
    let mut d = node_pinned(
        &svc,
        4,
        MemStore::new(),
        test_devices(),
        None,
        Some(genesis),
    );
    assert!(
        d.r.evaluate_control_bytes(2, &raw[1]).is_err(),
        "seq 1 first"
    );
    assert!(d.r.requires_reopen());
    let mut e = node_pinned(
        &svc,
        5,
        MemStore::new(),
        test_devices(),
        None,
        Some(genesis),
    );
    e.r.evaluate_control_bytes(1, &raw[0]).unwrap();
    e.r.evaluate_control_bytes(2, &raw[1]).unwrap();
}

/// The genesis marker is part of the apply checkpoint: an aborted seq 1 leaves no
/// marker in RAM or durably, an outer abort after an inner seq-1 commit restores the
/// prior marker, and an uncertain seq-1 commit is terminal with the durable state
/// read on reopen.
#[test]
fn pinned_genesis_marker_follows_the_apply_checkpoint() {
    let svc = FakeLogService::new();
    let mut boot = node(&svc, 1, MemStore::new());
    settle(&mut [&mut boot]);
    let genesis = genesis_of(&svc);
    let raw = svc.items(&COL);

    // Typed abort at seq 1 (install path): nothing recorded, retry succeeds.
    let mut a = node_pinned(
        &svc,
        2,
        MemStore::new(),
        test_devices(),
        None,
        Some(genesis),
    );
    a.r.store().fail_commits(1);
    assert!(a.r.evaluate_control_bytes(1, &raw[0]).is_err());
    assert_eq!(a.r.genesis, None);
    assert_eq!(
        crate::store::Store::meta(a.r.store(), crate::store::meta_keys::GENESIS).unwrap(),
        None
    );
    assert!(!a.r.requires_reopen(), "known abort may retry");
    a.r.evaluate_control_bytes(1, &raw[0]).unwrap();
    assert_eq!(a.r.genesis, Some(genesis));

    // An outer known abort after the inner seq-1 commit restores the prior marker.
    let mut b = node_pinned(
        &svc,
        3,
        MemStore::new(),
        test_devices(),
        None,
        Some(genesis),
    );
    let checkpoint = crate::replica::apply_checkpoint::Checkpoint::capture(&b.r);
    b.r.genesis = Some(genesis);
    let _ = checkpoint.restore(&mut b.r, true);
    assert_eq!(b.r.genesis, None);

    // Uncertain seq-1 commit (applied, reported failed): terminal; reopen reads it.
    let mut c = node_pinned(
        &svc,
        4,
        MemStore::new(),
        test_devices(),
        None,
        Some(genesis),
    );
    c.r.store().fail_after_commit(1);
    settle(&mut [&mut c]);
    assert!(c.r.requires_reopen(), "unknown outcome is terminal");
    assert_eq!(c.r.genesis, None, "RAM never ahead of a verified commit");
    let mut c = node_pinned(
        &svc,
        4,
        c.r.into_store(),
        test_devices(),
        None,
        Some(genesis),
    );
    settle(&mut [&mut c]);
    assert_eq!(c.r.genesis, Some(genesis));
    assert_eq!(c.r.head(), boot.r.head());
}

fn node_hello(r: &mut Replica<MemStore>) -> crate::api::ApiResult<SessionId> {
    r.hello(
        SessionAuth::Host,
        HelloParams {
            versions: vec![Version { major: 1, minor: 0 }],
            client_name: "test".into(),
            client_version: "0".into(),
            features: None,
            timezone: None,
        },
    )
    .map(|(s, _)| s)
}

/// A store reopened under published policy pins must have been built under them;
/// malformed pins never open.
#[test]
fn pinned_open_validates_the_host_trust_shape_first() {
    // A pinned (production) host's inconsistent trust shape is
    // refused before anything is read or opened over the store.
    let pins = crate::policy::PolicyPins {
        roots: vec![],
        policy_keys: vec![],
    };
    let base = ReplicaConfig {
        collection: COL,
        replica_id: B16([1; 16]),
        device_id: B16([101; 16]),
        mode: mdbn_wire::client::SyncMode::Synced,
        log_endpoint: EndpointId(1),
        verify: true,
        runtime_version: "test".into(),
        trusted_roots: vec![crate::testkit::TEST_ROOT],
        e2e: false,
        trusted_signers: vec![],
        user_enabled_cloud_copy: false,
        chosen_state: Some(mdbn_wire::policy::CState::CloudCopy),
        key_grants_only: false,
        expected_genesis: None,
        policy_pins: Some(pins),
    };
    let open = |cfg: ReplicaConfig| {
        Replica::open(
            cfg,
            MemStore::new(),
            Box::new(TestPlanner),
            Box::new(crate::seal::KeyringSealer::new(
                COL,
                B16([101; 16]),
                &[0x31; 32],
                &[0x32; 32],
            )),
            Host {
                clock: Box::new(TestClock(Rc::new(Cell::new(1_700_000_000_000)))),
                entropy: Box::new(crate::crypto::TestEntropy::new(1)),
                zones: Box::new(UtcOnly),
            },
            DeviceSecrets {
                sign_sk: [0x31; 32],
                kem_sk: [0x32; 32],
            },
        )
    };
    for (cfg, why) in [
        (
            ReplicaConfig {
                chosen_state: None,
                ..base.clone()
            },
            "no persisted chosen_state",
        ),
        (
            ReplicaConfig {
                trusted_roots: vec![],
                ..base.clone()
            },
            "no trust roots",
        ),
        (
            ReplicaConfig {
                e2e: true,
                ..base.clone()
            },
            "e2e flag differs",
        ),
        (
            ReplicaConfig {
                mode: mdbn_wire::client::SyncMode::LocalOnly,
                ..base.clone()
            },
            "local-only carrying synced trust choices",
        ),
    ] {
        assert!(
            matches!(open(cfg), Err(crate::replica::OpenError::HostTrust(_))),
            "{why}"
        );
    }
    // Unpinned hosts (tests, the legacy generic runtime) are unchanged.
    assert!(
        open(ReplicaConfig {
            chosen_state: None,
            policy_pins: None,
            ..base
        })
        .is_ok()
    );
}

#[test]
fn policy_pins_gate_a_warm_reopen() {
    use crate::crypto::sign::DeviceSigner;
    use crate::policy::{PolicyKeyPin, PolicyPins, RootPin, key_id};
    let svc = FakeLogService::new();
    // The signing test control plane (real Ed25519 root and policy keys).
    let dev = B16([101; 16]);
    let (sign, kem) = ([0x31u8; 32], [0x32u8; 32]);
    crate::testkit::TestControlPlane::signed(COL).genesis_with_keys(
        &svc,
        mdbn_wire::policy::CState::E2e,
        dev,
        &sign,
        &kem,
    );
    let mut a = node_with(
        &svc,
        1,
        MemStore::new(),
        vec![],
        Some(Box::new(crate::seal::KeyringSealer::new(
            COL, dev, &sign, &kem,
        ))),
    );
    settle(&mut [&mut a]);
    assert!(a.r.policy.root.is_some() && !a.r.policy.signed_by_key.is_empty());
    let store = a.r.into_store();
    let reopen = |store: MemStore, pins: PolicyPins| {
        let cfg = ReplicaConfig {
            collection: COL,
            replica_id: B16([1; 16]),
            device_id: dev,
            mode: mdbn_wire::client::SyncMode::Synced,
            log_endpoint: EndpointId(1),
            verify: true,
            runtime_version: "test".into(),
            trusted_roots: vec![crate::testkit::TEST_ROOT, crate::testkit::signed_root()],
            e2e: true,
            trusted_signers: vec![],
            user_enabled_cloud_copy: false,
            chosen_state: Some(mdbn_wire::policy::CState::E2e),
            key_grants_only: false,
            expected_genesis: None,
            policy_pins: Some(pins),
        };
        Replica::open(
            cfg,
            store,
            Box::new(TestPlanner),
            Box::new(crate::seal::KeyringSealer::new(COL, dev, &sign, &kem)),
            Host {
                clock: Box::new(TestClock(Rc::new(Cell::new(1_700_000_000_000)))),
                entropy: Box::new(crate::crypto::TestEntropy::new(1)),
                zones: Box::new(UtcOnly),
            },
            DeviceSecrets {
                sign_sk: sign,
                kem_sk: kem,
            },
        )
    };
    // The test control plane's published keys: the store reopens under them.
    let tk_root = crate::testkit::signed_root();
    let tk_key = DeviceSigner::from_seed(&crate::testkit::SIGNED_CP_SEED).public();
    let published = PolicyPins {
        roots: vec![RootPin {
            root_id: key_id(&tk_root),
            root_pk: B32(tk_root),
        }],
        policy_keys: vec![PolicyKeyPin {
            key_id: key_id(&tk_key),
            policy_pk: B32(tk_key),
            root_id: key_id(&tk_root),
        }],
    };
    // Warm probe: this store's root still pinned, plus a strong second
    // root R2, and the store's policy key pinned only under R2. Refused.
    let r2 = DeviceSigner::from_seed(&[0x33; 32]).public();
    let mut misattributed = published.clone();
    misattributed.roots.push(RootPin {
        root_id: key_id(&r2),
        root_pk: B32(r2),
    });
    misattributed.roots.sort_by_key(|r| r.root_id);
    misattributed.policy_keys[0].root_id = key_id(&r2);
    assert_eq!(misattributed.validate(), Ok(()));
    assert!(matches!(
        reopen(store.clone(), misattributed),
        Err(crate::replica::OpenError::Mismatch(_))
    ));
    let published_again = || published.clone();
    let opened = reopen(store.clone(), published.clone());
    assert!(opened.is_ok(), "{:?}", opened.err());
    let root = DeviceSigner::from_seed(&[0x31; 32]).public();
    let key = DeviceSigner::from_seed(&[0x32; 32]).public();
    let other = PolicyPins {
        roots: vec![RootPin {
            root_id: key_id(&root),
            root_pk: B32(root),
        }],
        policy_keys: vec![PolicyKeyPin {
            key_id: key_id(&key),
            policy_pk: B32(key),
            root_id: key_id(&root),
        }],
    };
    assert!(
        matches!(
            reopen(store.clone(), other.clone()),
            Err(crate::replica::OpenError::Mismatch(_))
        ),
        "built under keys that are not pinned"
    );
    // Applying from the log under pins: the published keys apply, others are void.
    let sync = |pins: PolicyPins| {
        let mut r = reopen(MemStore::new(), pins).unwrap();
        let mut log = svc.client(dev);
        for _ in 0..20 {
            pump(&mut r, &mut log, 100);
            r.tick();
        }
        (r.policy.root.is_some(), r.policy.voids)
    };
    assert!(sync(published_again()).0, "published keys apply");
    let (applied, voids) = sync(other.clone());
    assert!(!applied && voids >= 1, "unpinned keys are void");
    let malformed = PolicyPins {
        policy_keys: vec![],
        ..other
    };
    assert!(
        matches!(
            reopen(MemStore::new(), malformed),
            Err(crate::replica::OpenError::Mismatch(_))
        ),
        "malformed pins never open"
    );
}

fn grants_in(svc: &FakeLogService) -> Vec<(B16, B16)> {
    use mdbn_wire::envelope::{Item, ItemKind, KeyGrantPayload};
    use mdbn_wire::schema::Wire;
    svc.items(&COL)
        .iter()
        .filter_map(|b| {
            let i = Item::from_bytes(b).ok()?;
            (i.kind == ItemKind::KeyGrant).then(|| {
                let g = KeyGrantPayload::from_bytes(&i.body.0).unwrap();
                (i.signer.unwrap(), g.recipient)
            })
        })
        .collect()
}

fn service(n: u8, kind: mdbn_wire::policy::DeviceKind) -> crate::testkit::TestDevice {
    crate::testkit::TestDevice {
        device: B16([n + 100; 16]),
        account: crate::policy::SERVICE_ACCOUNT,
        kind,
    }
}

fn desktop(n: u8) -> crate::testkit::TestDevice {
    crate::testkit::TestDevice {
        device: B16([n + 100; 16]),
        account: crate::testkit::TEST_OWNER,
        kind: mdbn_wire::policy::DeviceKind::Desktop,
    }
}

/// Without an active hosted device, the escrow grants the key to a newly enrolled
/// account device at once (cloud copy).
#[test]
fn escrow_grants_when_no_hosted_device_is_active() {
    use mdbn_wire::policy::{CState, DeviceKind};
    let svc = FakeLogService::new();
    let mut cp = crate::testkit::TestControlPlane::new(COL);
    cp.genesis(
        &svc,
        CState::CloudCopy,
        &[service(2, DeviceKind::Escrow), desktop(3)],
    );
    let mut escrow = node(&svc, 2, MemStore::new());
    let mut owner = node(&svc, 3, MemStore::new());
    settle(&mut [&mut owner, &mut escrow]);
    assert!(
        escrow.r.policy.devices[&B16([102; 16])].keyed,
        "owner's initial rekey keys the escrow"
    );
    cp.enrol(&svc, desktop(4));
    settle(&mut [&mut escrow]);
    assert_eq!(grants_in(&svc), vec![(B16([102; 16]), B16([104; 16]))]);
    assert!(
        escrow.r.policy.devices[&B16([104; 16])].keyed,
        "a valid grant, not void"
    );
    // Only to devices of member accounts: a device of an account that is not a
    // member gets nothing.
    let stranger = B16([0xb7; 16]);
    cp.enrol(
        &svc,
        crate::testkit::TestDevice {
            device: B16([106; 16]),
            account: stranger,
            kind: DeviceKind::Desktop,
        },
    );
    settle(&mut [&mut escrow]);
    assert_eq!(
        grants_in(&svc).len(),
        1,
        "no grant to a non-member's device"
    );
    // Only to account devices: a service device is never a recipient.
    cp.enrol(&svc, service(5, DeviceKind::Hosted));
    settle(&mut [&mut escrow]);
    assert_eq!(grants_in(&svc).len(), 1);
}

/// With hosted enrolled, hosted grants; the escrow waits ESCROW_GRANT_AFTER_MS after
/// the enrolment (and tells the host when to wake), then grants as a fallback.
#[test]
fn escrow_grants_as_a_fallback_when_hosted_does_not() {
    use crate::replica::ESCROW_GRANT_AFTER_MS;
    use mdbn_wire::policy::{CState, DeviceKind};
    let svc = FakeLogService::new();
    let mut cp = crate::testkit::TestControlPlane::new(COL);
    cp.genesis(
        &svc,
        CState::CloudCopy,
        &[
            service(1, DeviceKind::Hosted),
            service(2, DeviceKind::Escrow),
        ],
    );
    let mut hosted = node(&svc, 1, MemStore::new());
    let mut escrow = node(&svc, 2, MemStore::new());
    settle(&mut [&mut hosted, &mut escrow]);
    assert!(
        escrow.r.policy.devices[&B16([102; 16])].keyed,
        "hosted keys the escrow"
    );
    // Hosted is idle from here. The enrolment is issued at this CP's time.
    cp.enrol(&svc, desktop(3));
    let issued = escrow.r.policy.last_issued_at.unwrap_or(0);
    escrow.clock.set(u64::try_from(issued).unwrap());
    settle(&mut [&mut escrow]);
    let issued = escrow.r.policy.last_issued_at.unwrap();
    assert!(grants_in(&svc).is_empty(), "hosted's turn first");
    assert_eq!(escrow.r.next_wakeup(), Some(issued + ESCROW_GRANT_AFTER_MS));
    escrow
        .clock
        .set(u64::try_from(issued + ESCROW_GRANT_AFTER_MS).unwrap());
    settle(&mut [&mut escrow]);
    assert_eq!(grants_in(&svc), vec![(B16([102; 16]), B16([103; 16]))]);
    assert!(
        escrow.r.policy.devices[&B16([103; 16])].keyed,
        "a valid grant, not void"
    );
    assert_eq!(escrow.r.next_wakeup(), None, "nothing left to grant");

    // Hosted, when active and caught up, grants at once and the escrow then has
    // nothing to do.
    cp.enrol(&svc, desktop(4));
    settle(&mut [&mut hosted]);
    settle(&mut [&mut escrow]);
    let g = grants_in(&svc);
    assert_eq!(g.last(), Some(&(B16([101; 16]), B16([104; 16]))));
    assert_eq!(g.iter().filter(|(_, to)| *to == B16([104; 16])).count(), 1);
}

/// The minimal escrow's emission profile (`key_grants_only`): it still grants, but
/// never rekeys, even where the protocol would allow a keyed escrow to (a revocation
/// pending its rekey). Without the profile the same escrow does rekey.
#[test]
fn a_grant_only_escrow_never_rekeys() {
    use mdbn_wire::envelope::{Item, ItemKind};
    use mdbn_wire::policy::{CState, DeviceKind};
    use mdbn_wire::schema::Wire;
    let escrow_rekeys = |grant_only: bool| {
        let svc = FakeLogService::new();
        let mut cp = crate::testkit::TestControlPlane::new(COL);
        cp.genesis(
            &svc,
            CState::CloudCopy,
            &[service(2, DeviceKind::Escrow), desktop(3)],
        );
        let mut escrow = node(&svc, 2, MemStore::new());
        escrow.r.cfg.key_grants_only = grant_only;
        let mut owner = node(&svc, 3, MemStore::new());
        settle(&mut [&mut owner, &mut escrow]);
        cp.enrol(&svc, desktop(4));
        settle(&mut [&mut escrow]);
        assert_eq!(
            grants_in(&svc),
            vec![(B16([102; 16]), B16([104; 16]))],
            "grants either way"
        );
        cp.revoke(&svc, B16([104; 16]));
        settle(&mut [&mut escrow]);
        svc.items(&COL)
            .iter()
            .filter_map(|b| Item::from_bytes(b).ok())
            .filter(|i| i.kind == ItemKind::Rekey && i.signer == Some(B16([102; 16])))
            .count()
    };
    assert_eq!(escrow_rekeys(true), 0, "grant-only: never a rekey");
    assert_eq!(escrow_rekeys(false), 1, "the protocol itself allows it");
}

/// A service that compacted through the lost positions cannot prove a prefix by
/// presenting a forged item that merely links from this replica's chain: the
/// observed item must carry a known signer's valid signature before it counts
/// (replica-repair's forged-link scenario). The repair holds, unprovable; nothing
/// is rolled back and no probe reply is trusted.
#[test]
fn a_forged_linking_item_from_the_service_never_proves_the_anchor() {
    use mdbn_wire::common::{B64, Bytes};
    use mdbn_wire::envelope::{Item, ItemKind};
    use mdbn_wire::hash::chain_hash;
    use mdbn_wire::schema::Wire;
    let svc = FakeLogService::new();
    let mut a = node(&svc, 1, MemStore::new());
    settle(&mut [&mut a]);
    for i in 0..5u8 {
        a.create(i, &format!("n{i}.md"), "x");
    }
    settle(&mut [&mut a]);
    let h = a.r.head().seq;
    assert_eq!(h, BOOT + 5);
    // The service loses three items, compacts through its shortened head, then
    // holds one shape-valid item at retained_from whose `prev` is our chain(4)
    // but whose signer is nobody this collection knows.
    svc.lose_tail(&COL, 3);
    svc.compact(&COL, h - 3);
    let prev = chain_hash(&svc.items(&COL)[(h - 3 - 1) as usize]);
    let forged = Item {
        kind: ItemKind::Entry,
        collection: COL,
        seq: Some(h - 2),
        prev: Some(prev),
        epoch: Some(1),
        signer: Some(B16([250; 16])),
        salt: Some(B16([1; 16])),
        idem: Some(B16([2; 16])),
        refs: None,
        stream: None,
        body: Bytes(vec![1, 2, 3]),
        sig: Some(B64([0; 64])),
    }
    .to_bytes()
    .unwrap();
    svc.push_raw(&COL, forged);
    assert_eq!(svc.head(&COL).0, h - 2);
    a.r.on_log_push(crate::log::LogPush::Reconnected);
    settle(&mut [&mut a]);
    assert_eq!(a.r.head().seq, h, "nothing rolled back");
    assert_eq!(a.r.repair_stats().rolled_back, 0);
    assert_eq!(a.r.repair_stats().reappended, 0);
    assert_eq!(
        a.r.held_unprovable(),
        Some((h, h - 2)),
        "held: the forged link is not evidence and everything below is compacted"
    );
    assert!(a.r.repair_stats().refused >= 1);
    assert!(
        !a.r.sync_status()
            .incidents
            .iter()
            .any(|i| i.kind == mdbn_wire::client::IncidentKind::Integrity)
    );
}

/// The store row keeps an attachment's complete descriptor as its own arm: the
/// planner's view sees it typed, the state digest covers it by its signed
/// whole-file hash, and a snapshot build waits for its complete object
/// inventory (typed) rather than dropping the row, its roots, or writing a
/// fabricated blob.
#[test]
fn attachment_rows_are_typed_in_the_store_and_wait_for_their_snapshot_inventory() {
    use crate::plan::StoreView;
    use crate::store::{FileLocal, FileRow, Store, TombstoneLast, TombstoneRow, Tx, bucket16};
    use mdbn_core::intent::FileContent as CFileContent;
    use mdbn_core::state::Tombstone;
    use mdbn_core::types::Catalog;
    use mdbn_wire::attachment::{AttachmentContentV1, AttachmentRefV1, FileContent};
    use mdbn_wire::common::B32;
    use mdbn_wire::intent::MediaClass;
    use mdbn_wire::snapshot::EntityKind;
    use std::sync::Arc;

    let svc = FakeLogService::new();
    let mut a = node(&svc, 1, MemStore::new());
    a.create(1, "n1.md", "doc 1");
    settle(&mut [&mut a]);
    let before = crate::replica::state_digest(a.r.store()).unwrap();
    let att = AttachmentContentV1 {
        reference: AttachmentRefV1 {
            collection: B16([7; 16]),
            key_epoch: 1,
            attachment_id: B32([8; 32]),
            manifest_cipher_hash: B32([9; 32]),
        },
        whole_plain_hash: B32([10; 32]),
        total_plain_bytes: 1234,
    };
    let fid = B16([0x71; 16]);
    let tid = B16([0x72; 16]);

    // An attachment tombstone alone: the Tombstones section refuses.
    let mut tx = Tx::default();
    tx.tombstones_put.push(TombstoneRow {
        id: tid,
        kind: EntityKind::File,
        path: "att/gone.png".into(),
        path_key: "att/gone.png".into(),
        last: TombstoneLast::Attachment(att.clone()),
        seq: 1,
        time: 0,
    });
    a.r.store_mut().commit(tx).unwrap();
    // A snapshot carries it in section 11, with its complete object inventory:
    // unknown here, so the build waits for it rather than dropping roots.
    a.r.build_snapshot_now().unwrap();
    assert_eq!(
        a.r.snapshot_blocked(),
        Some(crate::replica::SnapshotBlocked::InventoryPending { attachments: 1 })
    );
    assert_eq!(a.r.stats.snapshots_built, 0);

    // An attachment file row: the Files section refuses.
    let mut tx = Tx::default();
    tx.files_put.push(FileRow {
        kind: mdbn_wire::unindexed_markdown::FileKindV1::Ordinary,
        id: fid,
        path: "att/a.png".into(),
        path_key: "att/a.png".into(),
        content: FileContent::AttachmentV1(att.clone()),
        media: MediaClass::Image,
        modified_seq: 1,
        bucket: bucket16(&fid),
        local: FileLocal::Remote,
    });
    a.r.store_mut().commit(tx).unwrap();
    // Section 10 likewise; both rows hold the same manifest, read once.
    a.r.build_snapshot_now().unwrap();
    assert_eq!(
        a.r.snapshot_blocked(),
        Some(crate::replica::SnapshotBlocked::InventoryPending { attachments: 1 })
    );
    assert_eq!(a.r.stats.snapshots_built, 0);

    // Nothing was dropped: both rows are still there, typed.
    assert_eq!(
        a.r.store().file(&fid).unwrap().unwrap().content,
        FileContent::AttachmentV1(att.clone())
    );
    assert_eq!(
        a.r.store().tombstone(&tid).unwrap().unwrap().last,
        TombstoneLast::Attachment(att.clone())
    );
    // The state digest covers the rows.
    assert_ne!(crate::replica::state_digest(a.r.store()).unwrap(), before);

    // The planner's view carries each arm as itself, with no store error.
    let view = StoreView::new(
        a.r.store(),
        Arc::new(Catalog::load(std::iter::empty::<(&str, &str)>())),
    );
    let core_att = CFileContent::AttachmentV1(crate::convert::attachment_content(&att));
    let f = view.file(&crate::convert::uuid(&fid)).unwrap();
    assert_eq!(f.path, "att/a.png");
    assert_eq!(f.content, core_att);
    assert_eq!(f.kind, mdbn_core::intent::FileKind::Ordinary);
    match view.tombstone(&crate::convert::uuid(&tid)).unwrap() {
        Tombstone::File {
            path,
            content,
            kind,
        } => {
            assert_eq!(path, "att/gone.png");
            assert_eq!(content, core_att);
            assert_eq!(kind, mdbn_core::intent::FileKind::Ordinary);
        }
        Tombstone::Record { .. } => panic!("file tombstone read as a record"),
    }
    assert!(view.error().is_none());
}

/// Runtime activation with apply (T2, T5): an entry carrying attachment content
/// decodes with the runtime family and applies WHOLE: its record and its
/// attachment row (the signed descriptor) land together. An older build's
/// legacy decoder still rejects the same bytes as an unknown critical variant.
#[test]
fn attachment_entry_applies_whole_with_its_legacy_effects() {
    use crate::log::{LogClient, LogRequest};
    use mdbn_wire::attachment::{AttachmentContentV1, AttachmentRefV1, PutAttachmentFile};
    use mdbn_wire::attachment_runtime_v1 as rt;
    use mdbn_wire::common::B32;
    use mdbn_wire::entry::EntryPayload;
    use mdbn_wire::envelope::Item;
    use mdbn_wire::schema::Wire;
    let svc = FakeLogService::new();
    let mut a = node(&svc, 1, MemStore::new());
    let mut b = node(&svc, 2, MemStore::new());
    settle(&mut [&mut a, &mut b]);
    let before = a.r.head().seq;
    b.create(10, "a.md", "hello");
    let calls = b.r.take_log_calls();
    assert_eq!(calls.len(), 1);
    for mut call in calls {
        let LogRequest::Append(ref mut params) = call.request else {
            panic!("expected append")
        };
        let mut item = Item::from_bytes(&params.items[0].0).unwrap();
        let legacy = EntryPayload::from_bytes(&item.body.0).unwrap();
        let mut payload = rt::EntryPayload::from(legacy);
        payload
            .effects
            .push(rt::Effect::PutAttachmentFile(PutAttachmentFile {
                id: B16([0x33; 16]),
                path: "assets/big.bin".into(),
                content: AttachmentContentV1 {
                    reference: AttachmentRefV1 {
                        collection: COL,
                        key_epoch: 1,
                        attachment_id: B32([8; 32]),
                        manifest_cipher_hash: B32([9; 32]),
                    },
                    whole_plain_hash: B32([10; 32]),
                    total_plain_bytes: 50_000_000,
                },
            }));
        item.body.0 = payload.to_bytes().unwrap();
        assert!(
            EntryPayload::from_bytes(&item.body.0)
                .unwrap_err()
                .is_unknown(),
            "a legacy build sees an unknown critical variant and stalls"
        );
        params.items[0].0 = item.to_bytes().unwrap();
        let result = b.log.call(call.request);
        b.r.on_log_reply(call.id, result);
    }
    settle(&mut [&mut a]);
    assert_eq!(a.r.stalled, None);
    assert_eq!(a.r.head().seq, before + 1);
    assert_eq!(a.r.stats.voided, 0, "never voided");
    assert_eq!(a.doc(10).as_deref(), Some("hello"));
    let row = crate::Store::file(a.r.store(), &B16([0x33; 16]))
        .unwrap()
        .expect("attachment row");
    assert_eq!(row.path, "assets/big.bin");
    assert!(matches!(
        row.content,
        mdbn_wire::attachment::FileContent::AttachmentV1(ref c) if c.total_plain_bytes == 50_000_000
    ));
    assert_eq!(row.local, crate::store::FileLocal::Remote);
}

/// `hello` grants the bare `attachment-v1` codec feature (`intent.md` §3.11)
/// and `.read` on a synced device replica; `.materialize` only where the store
/// materializes (not this in-memory one), and never `.write` yet.
#[test]
fn hello_grants_bare_attachment_v1_and_qualified_directions() {
    let svc = FakeLogService::new();
    let mut a = node(&svc, 1, MemStore::new());
    let ask = |features: Option<Vec<&str>>| HelloParams {
        versions: vec![Version { major: 1, minor: 0 }],
        client_name: "app".into(),
        client_version: "0".into(),
        features: features.map(|f| f.into_iter().map(String::from).collect()),
        timezone: None,
    };
    let (_, granted) =
        a.r.hello(
            SessionAuth::Host,
            ask(Some(vec![
                "presence",
                "attachment-v1",
                "attachment-v1.read",
                "attachment-v1.write",
                "attachment-v1.materialize",
            ])),
        )
        .unwrap();
    assert_eq!(
        granted.features,
        vec!["presence", "attachment-v1", "attachment-v1.read"]
    );
    let (_, legacy) = a.r.hello(SessionAuth::Host, ask(None)).unwrap();
    assert!(legacy.features.is_empty(), "granted only when asked");
}

/// Streaming projection shares the indexed path's fence: a store without the
/// bounded raw projection declines, never answers empty.
#[test]
fn indexed_projection_declines_without_store_support() {
    let svc = FakeLogService::new();
    let mut a = node(&svc, 1, MemStore::new());
    settle(&mut [&mut a]);
    let out =
        a.r.indexed_projection(
            crate::store_query::QueryPredicate::All,
            vec!["status".into()],
            true,
            None,
            16,
            1 << 16,
        )
        .unwrap();
    assert_eq!(out.unwrap_err(), crate::replica::QueryDecline::Projection);
}
