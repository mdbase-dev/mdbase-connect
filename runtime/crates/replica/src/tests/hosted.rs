//! Hosted mode (`replica/hosted.rs`): the log-ACK barrier, RAM-only pending state,
//! unknown append outcomes, and log-derived, grant-isolated receipts across cold
//! restarts and cache drops.

use std::cell::Cell;
use std::rc::Rc;

use mdbn_core::host::Clock;
use mdbn_core::intent::{Mutation as CMutation, Op as COp};
use mdbn_core::plan::{Effect, PlanOptions, Planned, RejectCode, Rejection};
use mdbn_core::state::StateView;
use mdbn_wire::client::{HelloParams, Receipt, ReceiptState, SubmitParams};
use mdbn_wire::common::{B16, Bytes, Text, Uuid, Version};
use mdbn_wire::envelope::{ItemKind, KeyWrap, RekeyPayload, RekeyReason, SealedBox};
use mdbn_wire::intent::{Create, Op};
use mdbn_wire::policy::{CState, DeviceKind};
use mdbn_wire::schema::Wire;

use crate::api::{ClientApi, ErrorCode, SessionAuth, SessionId};
use crate::fake::{FakeLog, FakeLogService};
use crate::log::{EndpointId, LogClient, LogError, LogPort, LogRequest, pump};
use crate::mem::MemStore;
use crate::plan::Planner;
use crate::seal::PlainSealer;
use crate::store::{Store, Tx};
use crate::testkit::{TEST_OWNER, TestControlPlane, TestDevice};
use crate::{
    DeviceSecrets, Host, HostedCache, HostedProfile, Replica, ReplicaConfig, SubmitTicket, UtcOnly,
};

const COL: B16 = B16([0x0c; 16]);
const OWNER_DEV: B16 = B16([101; 16]);
const HOSTED_DEV: B16 = B16([102; 16]);
const ESCROW_DEV: B16 = B16([103; 16]);
const G1: B16 = B16([0x51; 16]);
const G2: B16 = B16([0x52; 16]);

/// Creates at an explicit path; a taken path is a conflict.
struct CreatePlanner;

impl Planner for CreatePlanner {
    fn plan(
        &self,
        m: &CMutation,
        state: &dyn StateView,
        _opts: &PlanOptions,
    ) -> Result<Planned, Rejection> {
        let mut out = Planned::noop();
        for op in &m.ops {
            let COp::Create(c) = op else {
                return Err(Rejection::new(
                    RejectCode::InvalidRequest,
                    Some("unsupported"),
                    "test planner",
                ));
            };
            let path = c.path.clone().unwrap_or_else(|| format!("{}.md", c.id));
            if state
                .at_path_key(&mdbn_core::paths::path_key(&path))
                .is_some()
            {
                return Err(Rejection::new(
                    RejectCode::Conflict,
                    Some("path_taken"),
                    "path taken",
                ));
            }
            out.effects.push(Effect::PutRecord {
                id: c.id,
                path,
                doc: c.document.clone().unwrap_or_default(),
            });
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

/// A cloud-copy collection: the owner's desktop, the hosted device and the escrow,
/// keyed at epoch 1, with two approved app grants.
fn world() -> FakeLogService {
    world_with_device_order(false)
}

fn world_with_device_order(reverse: bool) -> FakeLogService {
    let svc = FakeLogService::new();
    let mut cp = TestControlPlane::new(COL);
    let mut devices = vec![
        TestDevice {
            device: OWNER_DEV,
            account: TEST_OWNER,
            kind: DeviceKind::Desktop,
        },
        TestDevice {
            device: HOSTED_DEV,
            account: crate::policy::SERVICE_ACCOUNT,
            kind: DeviceKind::Hosted,
        },
        TestDevice {
            device: ESCROW_DEV,
            account: crate::policy::SERVICE_ACCOUNT,
            kind: DeviceKind::Escrow,
        },
    ];
    if reverse {
        devices.reverse();
    }
    cp.genesis(&svc, CState::CloudCopy, &devices);
    let rekey = RekeyPayload {
        epoch: 1,
        from: 0,
        commit: mdbn_wire::common::B32([0; 32]),
        wraps: [OWNER_DEV, HOSTED_DEV, ESCROW_DEV]
            .into_iter()
            .map(|device| KeyWrap {
                device,
                enc: mdbn_wire::common::B32([0; 32]),
                ct: Bytes(vec![0; 48]),
            })
            .collect(),
        history: SealedBox {
            salt: B16([0; 16]),
            ct: Bytes(Vec::new()),
        },
        reason: RekeyReason::Initial,
    };
    cp.append_item(&svc, ItemKind::Rekey, OWNER_DEV, rekey.to_bytes().unwrap());
    for g in [G1, G2] {
        cp.approved_grant(
            &svc,
            g,
            g.0[0..1].repeat(32).try_into().unwrap(),
            &["collection.read", "records.create"],
            None,
            OWNER_DEV,
        );
    }
    svc
}

struct Hosted {
    r: Replica<HostedCache<MemStore>>,
    log: FakeLog,
    clock: Rc<Cell<u64>>,
}

fn open(svc: &FakeLogService, store: MemStore) -> Hosted {
    try_open(svc, store, None, HostedProfile::default()).expect("open hosted")
}

/// Reopen after a cold restart. `keys` stands in for the KMS unwrap: the cache never
/// holds them, so the host hands the sealer its keys at open.
fn reopen(svc: &FakeLogService, store: MemStore, keys: Vec<u8>) -> Hosted {
    try_open(svc, store, Some(keys), HostedProfile::default()).expect("reopen hosted")
}

fn reopen_with(
    svc: &FakeLogService,
    store: MemStore,
    keys: Vec<u8>,
    planner: Box<dyn Planner>,
) -> Hosted {
    try_open_with(svc, store, Some(keys), HostedProfile::default(), planner).expect("reopen hosted")
}

fn try_open(
    svc: &FakeLogService,
    store: MemStore,
    keys: Option<Vec<u8>>,
    profile: HostedProfile,
) -> Result<Hosted, crate::replica::OpenError> {
    try_open_with(svc, store, keys, profile, Box::new(CreatePlanner))
}

fn try_open_with(
    svc: &FakeLogService,
    store: MemStore,
    keys: Option<Vec<u8>>,
    profile: HostedProfile,
    planner: Box<dyn Planner>,
) -> Result<Hosted, crate::replica::OpenError> {
    try_open_with_pin(svc, store, keys, profile, planner, None)
}

fn try_open_with_pin(
    svc: &FakeLogService,
    store: MemStore,
    keys: Option<Vec<u8>>,
    profile: HostedProfile,
    planner: Box<dyn Planner>,
    expected_genesis: Option<mdbn_wire::common::Hash>,
) -> Result<Hosted, crate::replica::OpenError> {
    let clock = Rc::new(Cell::new(1_700_000_000_000));
    let cfg = ReplicaConfig {
        collection: COL,
        replica_id: B16([2; 16]),
        device_id: HOSTED_DEV,
        mode: mdbn_wire::client::SyncMode::Synced,
        log_endpoint: EndpointId(1),
        verify: true,
        runtime_version: "test".into(),
        trusted_roots: vec![crate::testkit::TEST_ROOT],
        e2e: false,
        trusted_signers: vec![OWNER_DEV, HOSTED_DEV, ESCROW_DEV],
        user_enabled_cloud_copy: true,
        chosen_state: Some(CState::CloudCopy),
        key_grants_only: false,
        expected_genesis,
        policy_pins: None,
    };
    let host = Host {
        clock: Box::new(TestClock(clock.clone())),
        entropy: Box::new(crate::crypto::TestEntropy::new(2)),
        zones: Box::new(UtcOnly),
    };
    let mut sealer = PlainSealer::for_device(HOSTED_DEV);
    if let Some(k) = keys {
        crate::seal::Sealer::import(&mut sealer, &k).expect("keys");
    }
    let r = Replica::open_hosted(
        cfg,
        store,
        planner,
        Box::new(sealer),
        host,
        DeviceSecrets {
            sign_sk: [2; 32],
            kem_sk: [2; 32],
        },
        profile,
    )?;
    Ok(Hosted {
        r,
        log: svc.client(HOSTED_DEV),
        clock,
    })
}

fn hello() -> HelloParams {
    HelloParams {
        versions: vec![Version { major: 1, minor: 0 }],
        client_name: "app".into(),
        client_version: "0".into(),
        features: None,
        timezone: None,
    }
}

fn grant_auth(g: B16) -> SessionAuth {
    SessionAuth::Grant {
        grant: g,
        client_pk: g.0[0..1].repeat(32).try_into().unwrap(),
    }
}

fn create(id: u8, path: &str, mutation: Option<Uuid>) -> SubmitParams {
    SubmitParams {
        ops: vec![Op::Create(Create {
            id: B16([id; 16]),
            path: Some(path.into()),
            type_name: None,
            frontmatter: None,
            body: None,
            document: Some(Text::Inline(format!("doc {id}"))),
        })],
        mutation_id: mutation,
        conflict_mode: None,
        timezone: None,
        allow_partial: None,
        mutation_ids: None,
        dry_run: None,
        include: None,
        wait: None,
    }
}

impl Hosted {
    /// The keys the sealer holds (RAM only), as a KMS unwrap would re-supply them.
    fn keys(&self) -> Vec<u8> {
        assert_eq!(
            self.r
                .store()
                .inner()
                .meta(crate::store::meta_keys::KEYRING)
                .unwrap(),
            None,
            "no key material at rest in the cache"
        );
        self.r
            .store()
            .meta(crate::store::meta_keys::KEYRING)
            .unwrap()
            .expect("keyed")
    }

    fn pump(&mut self) {
        for _ in 0..10 {
            pump(&mut self.r, &mut self.log, 100);
            self.r.tick();
        }
    }

    fn session(&mut self, g: B16) -> SessionId {
        self.r.hello(grant_auth(g), hello()).expect("hello").0
    }

    /// The single receipt of the single completed ticket `t`.
    fn ack(&mut self, t: SubmitTicket) -> Receipt {
        let acks = self.r.take_acks();
        assert_eq!(acks.len(), 1, "{acks:?}");
        assert_eq!(acks[0].ticket, t);
        assert_eq!(acks[0].receipts.len(), 1);
        acks[0].receipts[0].clone()
    }
}

fn mid(n: u8) -> Uuid {
    B16([n; 16])
}

fn rebuilding(e: crate::api::ApiError) {
    assert_eq!(e.code(), Some(ErrorCode::Unavailable));
    assert_eq!(e.problem().reason.as_deref(), Some("hosted_rebuilding"));
}

#[test]
fn ack_only_after_the_log_append() {
    let svc = world();
    let mut h = open(&svc, MemStore::new());
    h.pump();
    let s = h.session(G1);
    let head = svc.head(&COL).0;
    let t =
        h.r.submit_logged(s, create(1, "a.md", Some(mid(0xa1))))
            .unwrap();
    // Captured and planned, but not acknowledged and not persisted.
    assert!(h.r.take_acks().is_empty(), "no ack before the append");
    assert_eq!(h.r.store().pending_count().unwrap(), 1, "pending in RAM");
    assert_eq!(
        h.r.store().inner().pending_count().unwrap(),
        0,
        "nothing unlogged reaches the cache"
    );
    assert_eq!(svc.head(&COL).0, head);
    h.pump();
    let r = h.ack(t);
    assert_eq!(r.state, ReceiptState::Confirmed);
    assert_eq!(r.seq, Some(head + 1));
    assert_eq!(svc.head(&COL).0, head + 1);
    assert_eq!(h.r.store().pending_count().unwrap(), 0);
    // The generic submit, whose `pending` answer is not an ack, is refused.
    let e = h.r.submit(s, create(2, "b.md", None)).unwrap_err();
    assert_eq!(e.code(), Some(ErrorCode::Internal));
    assert_eq!(svc.head(&COL).0, head + 1);
}

#[test]
fn pre_log_rejection_is_acked_and_never_persisted() {
    let svc = world();
    let mut h = open(&svc, MemStore::new());
    h.pump();
    let s = h.session(G1);
    let t = h.r.submit_logged(s, create(1, "a.md", None)).unwrap();
    h.pump();
    assert_eq!(h.ack(t).state, ReceiptState::Confirmed);
    let t =
        h.r.submit_logged(s, create(2, "a.md", Some(mid(0xa2))))
            .unwrap();
    let r = h.ack(t);
    assert_eq!(r.state, ReceiptState::Rejected);
    assert_eq!(
        h.r.store().inner().local_receipt(&mid(0xa2)).unwrap(),
        None,
        "a pre-log decision is not cached"
    );
    assert_eq!(
        h.r.receipt(s, mid(0xa2)).unwrap().state,
        ReceiptState::Rejected
    );
}

#[test]
fn append_failure_is_never_acked() {
    let svc = world();
    let mut h = open(&svc, MemStore::new());
    h.pump();
    let s = h.session(G1);
    let head = svc.head(&COL).0;
    // A refused append (forbidden): stopped, nothing acked either way.
    h.log.faults.fail_next = Some(crate::log::LogErrorCode::Forbidden);
    let t =
        h.r.submit_logged(s, create(1, "a.md", Some(mid(0xb1))))
            .unwrap();
    h.pump();
    assert!(h.r.take_acks().is_empty(), "no ack after a failed append");
    assert_eq!(h.r.open_tickets(), 1);
    assert_eq!(h.r.store().inner().pending_count().unwrap(), 0);
    assert_eq!(svc.head(&COL).0, head);
    // Offline: still nothing, and no definitive failure.
    let mut h2 = open(&world(), MemStore::new());
    h2.pump();
    let s2 = h2.session(G1);
    h2.log.faults.offline = true;
    let t2 = h2.r.submit_logged(s2, create(1, "a.md", None)).unwrap();
    h2.pump();
    assert!(h2.r.take_acks().is_empty());
    h2.log.faults.offline = false;
    h2.r.on_log_push(crate::log::LogPush::Reconnected);
    h2.pump();
    assert_eq!(h2.ack(t2).state, ReceiptState::Confirmed);
    let _ = t;
}

#[test]
fn unknown_outcome_retries_identical_bytes() {
    let svc = world();
    let mut h = open(&svc, MemStore::new());
    h.pump();
    let s = h.session(G1);
    let head = svc.head(&COL).0;
    let t =
        h.r.submit_logged(s, create(1, "a.md", Some(mid(0xc1))))
            .unwrap();
    // First attempt: lands at the service, reply lost.
    let calls = h.r.take_log_calls();
    let append: Vec<_> = calls
        .into_iter()
        .filter(|c| matches!(c.request, LogRequest::Append(_)))
        .collect();
    assert_eq!(append.len(), 1);
    let LogRequest::Append(first) = append[0].request.clone() else {
        unreachable!()
    };
    let _ = h.log.call(append[0].request.clone());
    h.r.on_log_reply(append[0].id, Err(LogError::NoResponse));
    assert!(h.r.take_acks().is_empty(), "unknown outcome is not an ack");
    assert_eq!(h.r.open_tickets(), 1, "nor a failure");
    assert!(
        !h.r.hosted_serving(),
        "an unknown outcome drops Ready until a fresh head fetch"
    );
    // The retry carries exactly the same sealed bytes.
    h.clock.set(h.clock.get() + 5_000);
    h.r.tick();
    let (retry, others): (Vec<_>, Vec<_>) =
        h.r.take_log_calls()
            .into_iter()
            .partition(|c| matches!(c.request, LogRequest::Append(_)));
    assert_eq!(retry.len(), 1);
    // The unknown outcome also re-fetches the head (Ready needs a fresh one).
    assert!(
        others
            .iter()
            .any(|c| matches!(c.request, LogRequest::Subscribe { .. }))
    );
    for c in others {
        let reply = h.log.call(c.request);
        h.r.on_log_reply(c.id, reply);
    }
    let LogRequest::Append(second) = retry[0].request.clone() else {
        unreachable!()
    };
    assert_eq!(second, first, "identical bytes");
    let reply = h.log.call(retry[0].request.clone());
    h.r.on_log_reply(retry[0].id, reply);
    h.pump();
    let r = h.ack(t);
    assert_eq!(r.state, ReceiptState::Confirmed);
    assert_eq!(r.seq, Some(head + 1));
    assert_eq!(svc.head(&COL).0, head + 1, "appended once");
}

/// The replica dies with an append of unknown outcome. The app retries the same
/// mutation ID against the restarted replica: it is found in the log, confirmed for
/// its grant, refused for another grant, and never appended twice.
#[test]
fn cold_restart_with_unknown_append_finds_the_mutation_in_the_log() {
    for landed in [true, false] {
        let svc = world();
        let store = MemStore::new();
        let data = store.data();
        let mut h = open(&svc, store);
        h.pump();
        let s = h.session(G1);
        let head = svc.head(&COL).0;
        let _ =
            h.r.submit_logged(s, create(1, "a.md", Some(mid(0xd1))))
                .unwrap();
        for c in h.r.take_log_calls() {
            if matches!(c.request, LogRequest::Append(_)) && landed {
                let _ = h.log.call(c.request);
            }
        }
        let keys = h.keys();
        drop(h); // cold: RAM pending, sealed bytes, tickets and keys are gone
        assert_eq!(svc.head(&COL).0, head + u64::from(landed));

        let mut h = reopen(&svc, MemStore::shared(data), keys);
        rebuilding(h.r.hello(grant_auth(G1), hello()).unwrap_err());
        h.pump();
        assert!(h.r.hosted_serving());
        let s1 = h.session(G1);
        let s2 = h.session(G2);
        let e = h.r.submit_logged(s2, create(9, "z.md", Some(mid(0xd1))));
        if landed {
            let e = e.unwrap_err();
            assert_eq!(e.problem().reason.as_deref(), Some("mutation_id_in_use"));
        } else {
            // Not in the log: G2 may use the ID; G1's retry is then refused.
            let t = e.unwrap();
            h.pump();
            assert_eq!(h.ack(t).state, ReceiptState::Confirmed);
        }
        let t = h.r.submit_logged(s1, create(1, "a.md", Some(mid(0xd1))));
        if landed {
            let t = t.unwrap();
            let r = h.ack(t);
            assert_eq!(r.state, ReceiptState::Confirmed, "found in the log");
            assert_eq!(r.seq, Some(head + 1));
            h.pump();
            assert_eq!(svc.head(&COL).0, head + 1, "never appended twice");
            assert_eq!(
                h.r.receipt(s2, mid(0xd1)).unwrap_err().code(),
                Some(ErrorCode::NotFound),
                "grant-isolated"
            );
        } else {
            let e = t.unwrap_err();
            assert_eq!(e.problem().reason.as_deref(), Some("mutation_id_in_use"));
            assert_eq!(svc.head(&COL).0, head + 1);
        }
    }
}

/// A cold restart while the lost append is still in flight: the restarted replica
/// re-plans the same mutation ID (new bytes). The stale bytes land first; the new
/// copy can never land (head moved / duplicate token), and the ack reports the
/// stale bytes' position. One entry carries the mutation.
#[test]
fn cold_restart_replan_never_double_applies() {
    let svc = world();
    let store = MemStore::new();
    let data = store.data();
    let mut h = open(&svc, store);
    h.pump();
    let s = h.session(G1);
    let head = svc.head(&COL).0;
    let _ =
        h.r.submit_logged(s, create(1, "a.md", Some(mid(0xe1))))
            .unwrap();
    let stale: Vec<_> =
        h.r.take_log_calls()
            .into_iter()
            .filter(|c| matches!(c.request, LogRequest::Append(_)))
            .collect();
    let keys = h.keys();
    drop(h);
    let mut h = reopen(&svc, MemStore::shared(data), keys);
    h.pump();
    let s = h.session(G1);
    let t =
        h.r.submit_logged(s, create(1, "a.md", Some(mid(0xe1))))
            .unwrap();
    // The stale request arrives now, before the replanned copy.
    let mut c = svc.client(HOSTED_DEV);
    for call in stale {
        assert!(matches!(
            c.call(call.request),
            Ok(crate::log::LogResponse::Append(
                mdbn_wire::log_service::AppendResult::Appended(_)
            ))
        ));
    }
    h.pump();
    let r = h.ack(t);
    assert_eq!(r.state, ReceiptState::Confirmed);
    assert_eq!(r.seq, Some(head + 1));
    assert_eq!(svc.head(&COL).0, head + 1, "one entry carries the mutation");
}

/// The whole cache is lost after the log ACK. A fresh replica rebuilds from the log
/// and serves the same grant-scoped receipts.
#[test]
fn cache_drop_rebuild_keeps_grant_isolated_receipts() {
    let svc = world();
    let mut h = open(&svc, MemStore::new());
    h.pump();
    let s1 = h.session(G1);
    let s2 = h.session(G2);
    let t1 =
        h.r.submit_logged(s1, create(1, "a.md", Some(mid(0xf1))))
            .unwrap();
    let t2 =
        h.r.submit_logged(s2, create(2, "b.md", Some(mid(0xf2))))
            .unwrap();
    h.pump();
    let acks = h.r.take_acks();
    assert_eq!(acks.len(), 2);
    let before: Vec<Receipt> = [(s1, 0xf1), (s2, 0xf2)]
        .iter()
        .map(|(s, m)| h.r.receipt(*s, mid(*m)).unwrap())
        .collect();
    let _ = (t1, t2);
    let head = svc.head(&COL).0;
    drop(h);

    let mut h = open(&svc, MemStore::new());
    rebuilding(h.r.hello(grant_auth(G1), hello()).unwrap_err());
    h.pump();
    let s1 = h.session(G1);
    let s2 = h.session(G2);
    assert_eq!(h.r.receipt(s1, mid(0xf1)).unwrap(), before[0]);
    assert_eq!(h.r.receipt(s2, mid(0xf2)).unwrap(), before[1]);
    for (s, m) in [(s1, 0xf2), (s2, 0xf1)] {
        assert_eq!(
            h.r.receipt(s, mid(m)).unwrap_err().code(),
            Some(ErrorCode::NotFound),
            "another grant's receipt stays hidden"
        );
        let e =
            h.r.submit_logged(s, create(7, "c.md", Some(mid(m))))
                .unwrap_err();
        assert_eq!(e.problem().reason.as_deref(), Some("mutation_id_in_use"));
    }
    // Idempotent retries by the owners.
    let t =
        h.r.submit_logged(s1, create(1, "a.md", Some(mid(0xf1))))
            .unwrap();
    assert_eq!(h.ack(t).state, ReceiptState::Confirmed);
    h.pump();
    assert_eq!(svc.head(&COL).0, head, "nothing re-appended");
}

/// A confirmed receipt with no known owner (here: the ownership rows were lost) is
/// never refused as another client's: the owner is read back from the log.
#[test]
fn unknown_owner_is_looked_up_in_the_log() {
    let svc = world();
    let mut h = open(&svc, MemStore::new());
    h.pump();
    let s1 = h.session(G1);
    let s2 = h.session(G2);
    let t =
        h.r.submit_logged(s1, create(1, "a.md", Some(mid(0x91))))
            .unwrap();
    h.pump();
    let confirmed = h.ack(t);
    h.r.store_mut()
        .inner_mut()
        .commit(Tx {
            local_receipts_prune: Some(i64::MAX),
            ..Tx::default()
        })
        .unwrap();
    for s in [s1, s2] {
        let e = h.r.receipt(s, mid(0x91)).unwrap_err();
        assert_eq!(e.code(), Some(ErrorCode::Unavailable));
        assert_eq!(e.problem().reason.as_deref(), Some("receipt_owner_pending"));
    }
    h.pump();
    let r = h.r.receipt(s1, mid(0x91)).unwrap();
    assert_eq!((r.state, r.seq), (ReceiptState::Confirmed, confirmed.seq));
    assert_eq!(
        h.r.receipt(s2, mid(0x91)).unwrap_err().code(),
        Some(ErrorCode::NotFound)
    );
}

/// After a snapshot install over a compacted log, an owner the log no longer
/// retains is `outcome_unknown`, never `mutation_id_in_use`.
#[test]
fn snapshot_rebuild_without_retained_entry_is_outcome_unknown() {
    let svc = world();
    let mut h = open(&svc, MemStore::new());
    h.pump();
    let s1 = h.session(G1);
    let t =
        h.r.submit_logged(s1, create(1, "a.md", Some(mid(0x81))))
            .unwrap();
    h.pump();
    assert_eq!(h.ack(t).state, ReceiptState::Confirmed);
    h.r.build_snapshot_now().unwrap();
    h.pump();
    assert_eq!(h.r.stats.snapshots_built, 1);
    let s1b = h.session(G1);
    let t =
        h.r.submit_logged(s1b, create(2, "b.md", Some(mid(0x82))))
            .unwrap();
    h.pump();
    assert_eq!(h.ack(t).state, ReceiptState::Confirmed);
    let snap = h.r.head().seq - 1;
    svc.compact(&COL, snap);
    drop(h);

    let mut h = open(&svc, MemStore::new());
    h.pump();
    assert_eq!(h.r.stats.snapshots_installed, 1);
    let s1 = h.session(G1);
    let s2 = h.session(G2);
    // In the tail: log-derived, served at once.
    assert_eq!(
        h.r.receipt(s1, mid(0x82)).unwrap().state,
        ReceiptState::Confirmed
    );
    // In the snapshot only: looked up, not retained.
    assert_eq!(
        h.r.receipt(s1, mid(0x81)).unwrap_err().code(),
        Some(ErrorCode::Unavailable)
    );
    h.pump();
    for s in [s1, s2] {
        assert_eq!(
            h.r.receipt(s, mid(0x81)).unwrap_err().code(),
            Some(ErrorCode::OutcomeUnknown)
        );
        let e =
            h.r.submit_logged(s, create(1, "a.md", Some(mid(0x81))))
                .unwrap_err();
        assert_eq!(e.code(), Some(ErrorCode::OutcomeUnknown));
    }
}

#[test]
fn open_hosted_refuses_a_store_with_durable_pending_rows() {
    let svc = world();
    let mut store = MemStore::new();
    store
        .commit(Tx {
            pending_put: vec![crate::store::PendingRow {
                order: 1,
                mutation: mdbn_wire::intent::Mutation {
                    id: mid(1),
                    origin: B16([2; 16]),
                    base_seq: 0,
                    clock: mdbn_wire::intent::OpClock {
                        instant: 1,
                        tz: "UTC".into(),
                        local_date: "1970-01-01".into(),
                    },
                    seed: mdbn_wire::common::B32([0; 32]),
                    source: mdbn_wire::intent::Source::Api,
                    ops: Vec::new(),
                    on_behalf: None,
                    conflict_mode: None,
                    validated_at: None,
                    room: None,
                }
                .into(),
                effects: Vec::new(),
                touches: Vec::new(),
                grant: None,
                uploads: Vec::new(),
                refs: Vec::new(),
            }],
            ..Tx::default()
        })
        .unwrap();
    assert!(
        matches!(
            try_open(&svc, store, None, HostedProfile::default()),
            Err(crate::replica::OpenError::Mismatch(_))
        ),
        "a durable pending row is a migration blocker"
    );
}

/// Another replica (the owner's desktop, serving grant G2) logs a mutation ID that
/// the hosted replica holds pending for G1. The log names G2: G1's write is refused
/// as in use, and G1 never receives G2's result.
#[test]
fn foreign_grant_entry_never_confirms_a_pending_row() {
    let svc = world();
    let mut h = open(&svc, MemStore::new());
    h.pump();
    let s1 = h.session(G1);
    h.log.faults.offline = true;
    let t =
        h.r.submit_logged(s1, create(1, "a.md", Some(mid(0x71))))
            .unwrap();
    h.pump();
    assert!(h.r.take_acks().is_empty());

    let clock = Rc::new(Cell::new(1_700_000_000_000));
    let mut d = Replica::open(
        ReplicaConfig {
            replica_id: B16([1; 16]),
            device_id: OWNER_DEV,
            ..h.r.config().clone()
        },
        MemStore::new(),
        Box::new(CreatePlanner),
        Box::new(PlainSealer::for_device(OWNER_DEV)),
        Host {
            clock: Box::new(TestClock(clock)),
            entropy: Box::new(crate::crypto::TestEntropy::new(1)),
            zones: Box::new(UtcOnly),
        },
        DeviceSecrets {
            sign_sk: [1; 32],
            kem_sk: [1; 32],
        },
    )
    .unwrap();
    let mut dlog = svc.client(OWNER_DEV);
    pump(&mut d, &mut dlog, 100);
    let (ds, _) = d.hello(grant_auth(G2), hello()).unwrap();
    d.submit(ds, create(2, "b.md", Some(mid(0x71)))).unwrap();
    pump(&mut d, &mut dlog, 100);
    let head = svc.head(&COL).0;

    h.log.faults.offline = false;
    h.r.on_log_push(crate::log::LogPush::Reconnected);
    h.pump();
    let r = h.ack(t);
    assert_eq!(r.state, ReceiptState::Rejected);
    assert_eq!(
        r.problem.and_then(|p| p.reason).as_deref(),
        Some("mutation_id_in_use")
    );
    assert_eq!(r.seq, None, "no foreign result leaks");
    assert_eq!(svc.head(&COL).0, head, "G1's copy never lands");
    assert_eq!(
        h.r.receipt(s1, mid(0x71)).unwrap_err().code(),
        Some(ErrorCode::NotFound)
    );
}

/// An app that disconnects mid-write does not cancel or fail it: the write still
/// reaches the log, its ack is not delivered to a dead session, and a new session of
/// the same grant reads the confirmed receipt.
#[test]
fn closed_session_keeps_the_write_and_drops_the_ack() {
    let svc = world();
    let mut h = open(&svc, MemStore::new());
    h.pump();
    let s = h.session(G1);
    let head = svc.head(&COL).0;
    let _ =
        h.r.submit_logged(s, create(1, "a.md", Some(mid(0x61))))
            .unwrap();
    h.r.close(s);
    h.pump();
    assert!(h.r.take_acks().is_empty());
    assert_eq!(h.r.open_tickets(), 0);
    assert_eq!(svc.head(&COL).0, head + 1, "the write still lands");
    let s = h.session(G1);
    assert_eq!(
        h.r.receipt(s, mid(0x61)).unwrap().state,
        ReceiptState::Confirmed
    );
}

/// `CommitAborted` certifies the whole preceding state durable. The hosted cache's
/// RAM part never is, so neither its refusals nor an inner abort report it.
#[test]
fn hosted_cache_never_reports_commit_aborted() {
    let inner = MemStore::new();
    let data = inner.data();
    let mut c = HostedCache::new(inner, &HostedProfile::default());
    let row = |n: u8| crate::store::PendingRow {
        order: u64::from(n),
        mutation: mdbn_wire::intent::Mutation {
            id: mid(n),
            origin: B16([2; 16]),
            base_seq: 0,
            clock: mdbn_wire::intent::OpClock {
                instant: 1,
                tz: "UTC".into(),
                local_date: "1970-01-01".into(),
            },
            seed: mdbn_wire::common::B32([0; 32]),
            source: mdbn_wire::intent::Source::Api,
            ops: Vec::new(),
            on_behalf: None,
            conflict_mode: None,
            validated_at: None,
            room: None,
        }
        .into(),
        effects: Vec::new(),
        touches: Vec::new(),
        grant: None,
        uploads: Vec::new(),
        refs: Vec::new(),
    };
    c.commit(Tx {
        pending_put: vec![row(1)],
        ..Tx::default()
    })
    .unwrap();
    // Unsupported part: refused as Io, nothing applied.
    let e = c
        .commit(Tx {
            pending_put: vec![row(2)],
            blobs_del: vec![mdbn_wire::common::B32([1; 32])],
            ..Tx::default()
        })
        .unwrap_err();
    assert!(matches!(e, crate::store::StoreError::Io(_)), "{e:?}");
    // Inner abort: downgraded to Io, RAM part not applied.
    data.borrow_mut().fail_next = 1;
    let e = c
        .commit(Tx {
            pending_put: vec![row(3)],
            meta: vec![("x".into(), Some(vec![1]))],
            ..Tx::default()
        })
        .unwrap_err();
    assert!(matches!(e, crate::store::StoreError::Io(_)), "{e:?}");
    assert_eq!(c.pending_count().unwrap(), 1);
    assert_eq!(c.inner().pending_count().unwrap(), 0);
}

/// `allow_partial`: a later group that fails (its ID belongs to another grant) is
/// reported in the ticket for that group alone; the earlier, captured group is
/// still acknowledged once logged. The API never claims nothing was captured.
#[test]
fn partial_submit_reports_a_failed_group_without_hiding_a_captured_one() {
    let svc = world();
    let mut h = open(&svc, MemStore::new());
    h.pump();
    let s1 = h.session(G1);
    let s2 = h.session(G2);
    let t =
        h.r.submit_logged(s2, create(9, "z.md", Some(mid(0x41))))
            .unwrap();
    h.pump();
    assert_eq!(h.ack(t).state, ReceiptState::Confirmed);
    let mut p = create(1, "a.md", None);
    let SubmitParams { ops, .. } = create(2, "b.md", None);
    p.ops.extend(ops);
    p.allow_partial = Some(true);
    p.mutation_ids = Some(vec![mid(0x42), mid(0x41)]);
    let t = h.r.submit_logged(s1, p).unwrap();
    h.pump();
    let acks = h.r.take_acks();
    assert_eq!(acks.len(), 1);
    assert_eq!(acks[0].ticket, t);
    let r = &acks[0].receipts;
    assert_eq!(
        (r[0].mutation, r[0].state),
        (mid(0x42), ReceiptState::Confirmed)
    );
    assert_eq!(
        (r[1].mutation, r[1].state),
        (mid(0x41), ReceiptState::Rejected)
    );
    assert_eq!(
        r[1].problem.as_ref().and_then(|p| p.reason.as_deref()),
        Some("mutation_id_in_use")
    );
}

/// RAM-only state is bounded in bytes as well as counts, prospectively: a row that
/// would cross the budget is refused before it is captured, alone or as a later
/// group of a partial submit (earlier groups keep their place).
#[test]
fn pending_bytes_are_bounded() {
    let svc = world();
    let profile = HostedProfile {
        max_pending_bytes: 2_500,
        ..HostedProfile::default()
    };
    let mut h = try_open(&svc, MemStore::new(), None, profile).unwrap();
    h.pump();
    let s = h.session(G1);
    h.log.faults.offline = true;
    let big = |id: u8, path: &str, n: usize| {
        let mut p = create(id, path, None);
        if let Op::Create(c) = &mut p.ops[0] {
            c.document = Some(Text::Inline("x".repeat(n)));
        }
        p
    };
    // One oversized row: refused, nothing captured.
    let e = h.r.submit_logged(s, big(1, "a.md", 5_000)).unwrap_err();
    assert_eq!(e.code(), Some(ErrorCode::RateLimited));
    assert_eq!(h.r.store().pending_count().unwrap(), 0);
    assert_eq!(h.r.store().pending_bytes(), 0);
    // Groups that together cross it: the first is captured, the crossing one is a
    // rate-limited (never captured) receipt in the ticket.
    let mut p = big(2, "b.md", 900);
    let SubmitParams { ops, .. } = big(3, "c.md", 900);
    p.ops.extend(ops);
    let SubmitParams { ops, .. } = big(4, "d.md", 900);
    p.ops.extend(ops);
    p.allow_partial = Some(true);
    let t = h.r.submit_logged(s, p).unwrap();
    assert!(h.r.store().pending_bytes() <= 2_500);
    assert_eq!(h.r.store().pending_count().unwrap(), 1);
    h.log.faults.offline = false;
    h.r.on_log_push(crate::log::LogPush::Reconnected);
    h.pump();
    let acks = h.r.take_acks();
    assert_eq!(acks.len(), 1);
    assert_eq!(acks[0].ticket, t);
    let states: Vec<ReceiptState> = acks[0].receipts.iter().map(|r| r.state).collect();
    assert_eq!(states.len(), 3);
    assert_eq!(states[0], ReceiptState::Confirmed);
    for refused in &acks[0].receipts[1..] {
        assert_eq!(refused.state, ReceiptState::Rejected);
        assert_eq!(
            refused.problem.as_ref().map(|p| p.code.as_str()),
            Some("rate_limited")
        );
    }
}

/// A planner that accepts at submit but refuses `head.md` at the head: the refusal
/// happens inside `submit_logged`'s own pump, before its ticket exists.
struct HeadRefuses;

impl Planner for HeadRefuses {
    fn plan(
        &self,
        m: &CMutation,
        state: &dyn StateView,
        opts: &PlanOptions,
    ) -> Result<Planned, Rejection> {
        let head = matches!(opts.stage, mdbn_core::plan::Stage::Head);
        let refuse = m
            .ops
            .iter()
            .any(|op| matches!(op, COp::Create(c) if c.path.as_deref() == Some("head.md")));
        if head && refuse {
            return Err(Rejection::new(
                RejectCode::Conflict,
                Some("at_head"),
                "refused at head",
            ));
        }
        CreatePlanner.plan(m, state, opts)
    }
}

#[test]
fn outcome_reached_during_capture_completes_the_ticket() {
    let svc = world();
    let mut h = open(&svc, MemStore::new());
    h.pump();
    let keys = h.keys();
    let store = h.r.into_store().into_inner();
    let mut h = reopen_with(&svc, store, keys, Box::new(HeadRefuses));
    h.pump();
    let s = h.session(G1);
    let t =
        h.r.submit_logged(s, create(1, "head.md", Some(mid(0x31))))
            .unwrap();
    let r = h.ack(t);
    assert_eq!(r.state, ReceiptState::Rejected);
    assert_eq!(h.r.open_tickets(), 0, "no stranded ticket");
}

/// A later group whose ID is confirmed but whose owner is no longer provable is
/// reported `unknown`, never as a definitive rejection.
#[test]
fn partial_group_with_unprovable_owner_is_unknown() {
    let svc = world();
    let mut h = open(&svc, MemStore::new());
    h.pump();
    let s = h.session(G1);
    let t =
        h.r.submit_logged(s, create(1, "a.md", Some(mid(0x21))))
            .unwrap();
    h.pump();
    assert_eq!(h.ack(t).state, ReceiptState::Confirmed);
    h.r.build_snapshot_now().unwrap();
    h.pump();
    let t = h.r.submit_logged(s, create(2, "b.md", None)).unwrap();
    h.pump();
    let _ = h.ack(t);
    svc.compact(&COL, h.r.head().seq - 1);
    drop(h);
    let mut h = open(&svc, MemStore::new());
    h.pump();
    let s = h.session(G1);
    let mut p = create(3, "c.md", None);
    let SubmitParams { ops, .. } = create(1, "a.md", None);
    p.ops.extend(ops);
    p.allow_partial = Some(true);
    p.mutation_ids = Some(vec![mid(0x22), mid(0x21)]);
    let t = h.r.submit_logged(s, p).unwrap();
    h.pump();
    let acks = h.r.take_acks();
    assert_eq!(acks.len(), 1);
    assert_eq!(acks[0].ticket, t);
    assert_eq!(acks[0].receipts[0].state, ReceiptState::Confirmed);
    assert_eq!(acks[0].receipts[1].state, ReceiptState::Unknown);
}

/// An owner lookup accepts only the entry that chains to this replica's applied
/// head: a validly signed rival candidate for the same mutation at that position is
/// never recorded as the owner.
#[test]
fn owner_lookup_refuses_a_rival_candidate() {
    use crate::log::{LogClient, LogResponse};
    use mdbn_wire::entry::EntryPayload;
    use mdbn_wire::envelope::Item;
    let svc = world();
    let mut h = open(&svc, MemStore::new());
    h.pump();
    let s1 = h.session(G1);
    let s2 = h.session(G2);
    let t =
        h.r.submit_logged(s1, create(1, "a.md", Some(mid(0x11))))
            .unwrap();
    h.pump();
    let _ = h.ack(t);
    h.r.store_mut()
        .inner_mut()
        .commit(Tx {
            local_receipts_prune: Some(i64::MAX),
            ..Tx::default()
        })
        .unwrap();
    let _ = h.r.receipt(s2, mid(0x11)).unwrap_err();
    let calls = h.r.take_log_calls();
    let read = calls
        .iter()
        .find(|c| matches!(c.request, LogRequest::Read(_)))
        .unwrap();
    let mut reply = h.log.call(read.request.clone());
    // The service swaps in a rival: same mutation, same position, now on G2's behalf.
    if let Ok(LogResponse::Read(r)) = &mut reply {
        let it = &mut r.items[0];
        let mut item = Item::from_bytes(&it.item.0).unwrap();
        let mut payload = EntryPayload::from_bytes(&item.body.0).unwrap();
        payload.mutation.on_behalf = Some(G2);
        item.body.0 = payload.to_bytes().unwrap();
        it.item.0 = item.to_bytes().unwrap();
    }
    h.r.on_log_reply(read.id, reply);
    assert_eq!(
        h.r.store().inner().local_receipt(&mid(0x11)).unwrap(),
        None,
        "the rival never becomes the owner"
    );
    assert_eq!(
        h.r.receipt(s1, mid(0x11)).unwrap_err().code(),
        Some(ErrorCode::Unavailable),
        "looked up again, never answered from the rival"
    );
    h.pump();
    assert_eq!(
        h.r.receipt(s1, mid(0x11)).unwrap().state,
        ReceiptState::Confirmed,
        "the applied entry still resolves it"
    );
    assert_eq!(
        h.r.receipt(s2, mid(0x11)).unwrap_err().code(),
        Some(ErrorCode::NotFound)
    );
}

/// Byte accounting is exact over the final RAM state: a growing re-plan of a held row
/// is kept (never refused, never dropped), but no new mutation is admitted while the
/// total is over budget; a delete makes room again.
#[test]
fn growing_replan_closes_admission_until_drained() {
    let profile = HostedProfile {
        max_pending_bytes: 600,
        ..HostedProfile::default()
    };
    let mut c = HostedCache::new(MemStore::new(), &profile);
    let row = |n: u8, order: u64, pad: usize| crate::store::PendingRow {
        order,
        mutation: mdbn_wire::intent::Mutation {
            id: mid(n),
            origin: B16([2; 16]),
            base_seq: 0,
            clock: mdbn_wire::intent::OpClock {
                instant: 1,
                tz: "UTC".into(),
                local_date: "1970-01-01".into(),
            },
            seed: mdbn_wire::common::B32([0; 32]),
            source: mdbn_wire::intent::Source::Api,
            ops: Vec::new(),
            on_behalf: None,
            conflict_mode: None,
            validated_at: None,
            room: None,
        }
        .into(),
        effects: Vec::new(),
        touches: vec!["k".repeat(pad)],
        grant: None,
        uploads: Vec::new(),
        refs: Vec::new(),
    };
    let put = |c: &mut HostedCache<MemStore>, r| {
        c.commit(Tx {
            pending_put: vec![r],
            ..Tx::default()
        })
    };
    put(&mut c, row(1, 1, 10)).unwrap();
    let small = c.pending_bytes();
    // Re-plan grows the held row past the budget: kept, exactly accounted.
    put(&mut c, row(1, 1, 1_000)).unwrap();
    assert!(c.pending_bytes() > 600);
    assert_eq!(c.pending_count().unwrap(), 1);
    assert!(matches!(
        put(&mut c, row(2, 2, 10)),
        Err(crate::store::StoreError::Full)
    ));
    assert_eq!(c.pending_count().unwrap(), 1);
    // Shrinking back (or draining) reopens admission.
    put(&mut c, row(1, 1, 10)).unwrap();
    assert_eq!(c.pending_bytes(), small);
    put(&mut c, row(2, 2, 10)).unwrap();
    c.commit(Tx {
        pending_del: vec![mid(1), mid(2)],
        ..Tx::default()
    })
    .unwrap();
    assert_eq!(c.pending_bytes(), 0);
}

/// The hard per-row cap applies to re-plans too: the RAM bound is
/// `max_pending × max_row_bytes` whatever the soft admission budget allows.
#[test]
fn replans_are_hard_capped_per_row() {
    let profile = HostedProfile {
        max_pending_bytes: 600,
        max_row_bytes: 2_000,
        ..HostedProfile::default()
    };
    let mut c = HostedCache::new(MemStore::new(), &profile);
    let row = |pad: usize| crate::store::PendingRow {
        order: 1,
        mutation: mdbn_wire::intent::Mutation {
            id: mid(1),
            origin: B16([2; 16]),
            base_seq: 0,
            clock: mdbn_wire::intent::OpClock {
                instant: 1,
                tz: "UTC".into(),
                local_date: "1970-01-01".into(),
            },
            seed: mdbn_wire::common::B32([0; 32]),
            source: mdbn_wire::intent::Source::Api,
            ops: Vec::new(),
            on_behalf: None,
            conflict_mode: None,
            validated_at: None,
            room: None,
        }
        .into(),
        effects: Vec::new(),
        touches: vec!["k".repeat(pad)],
        grant: None,
        uploads: Vec::new(),
        refs: Vec::new(),
    };
    let put = |c: &mut HostedCache<MemStore>, r| {
        c.commit(Tx {
            pending_put: vec![r],
            ..Tx::default()
        })
    };
    put(&mut c, row(10)).unwrap();
    put(&mut c, row(1_000)).unwrap();
    let before = c.pending_bytes();
    assert!(matches!(
        put(&mut c, row(5_000)),
        Err(crate::store::StoreError::Full)
    ));
    assert_eq!(c.pending_bytes(), before, "refused re-plan changes nothing");
}

/// The owner-lookup memo is bounded: a settled entry is evicted to make room, and
/// with every slot in flight no further read is started (the caller is told to retry).
#[test]
fn owner_lookup_memo_is_bounded() {
    let svc = world();
    let mut h = open(&svc, MemStore::new());
    h.pump();
    let s1 = h.session(G1);
    let t =
        h.r.submit_logged(s1, create(1, "a.md", Some(mid(0x51))))
            .unwrap();
    h.pump();
    let _ = h.ack(t);
    h.r.store_mut()
        .inner_mut()
        .commit(Tx {
            local_receipts_prune: Some(i64::MAX),
            ..Tx::default()
        })
        .unwrap();
    let reads = |h: &mut Hosted| {
        h.r.take_log_calls()
            .into_iter()
            .filter(|c| matches!(c.request, LogRequest::Read(_)))
            .count()
    };
    let _ = reads(&mut h);
    // All slots in flight: pending answer, no new read.
    h.r.testing_fill_lookups(1024, false);
    let e = h.r.receipt(s1, mid(0x51)).unwrap_err();
    assert_eq!(e.problem().reason.as_deref(), Some("receipt_owner_pending"));
    assert_eq!(reads(&mut h), 0);
    assert_eq!(h.r.testing_lookups(), 1024);
    // A full memo of settled entries: one is evicted and the lookup starts.
    let mut h2 = open(&svc, MemStore::new());
    h2.pump();
    let s = h2.session(G1);
    h2.r.store_mut()
        .inner_mut()
        .commit(Tx {
            local_receipts_prune: Some(i64::MAX),
            ..Tx::default()
        })
        .unwrap();
    let _ = reads(&mut h2);
    h2.r.testing_fill_lookups(1024, true);
    let _ = h2.r.receipt(s, mid(0x51)).unwrap_err();
    assert_eq!(h2.r.testing_lookups(), 1024);
    let calls = h2.r.take_log_calls();
    assert_eq!(
        calls
            .iter()
            .filter(|c| matches!(c.request, LogRequest::Read(_)))
            .count(),
        1
    );
    for c in calls {
        let reply = h2.log.call(c.request);
        h2.r.on_log_reply(c.id, reply);
    }
    assert_eq!(
        h2.r.receipt(s, mid(0x51)).unwrap().state,
        ReceiptState::Confirmed
    );
}

/// `dry_run` completes its ticket at once with a preview: nothing captured.
#[test]
fn dry_run_ticket_is_a_preview() {
    let svc = world();
    let mut h = open(&svc, MemStore::new());
    h.pump();
    let s = h.session(G1);
    let mut p = create(1, "a.md", None);
    p.dry_run = Some(true);
    let t = h.r.submit_logged(s, p).unwrap();
    let r = h.ack(t);
    assert_eq!(r.state, ReceiptState::Pending);
    assert_eq!(h.r.store().pending_count().unwrap(), 0);
}

#[test]
fn pinned_warm_replay_refuses_semantically_equal_wrong_raw_genesis() {
    for alter_genesis in [false, true] {
        let svc = world();
        let original = svc.items(&COL)[0].clone();
        let pin = mdbn_wire::hash::chain_hash(&original);
        let store = MemStore::new();
        let data = store.data();
        let mut h = try_open_with_pin(
            &svc,
            store,
            None,
            HostedProfile::default(),
            Box::new(CreatePlanner),
            Some(pin),
        )
        .unwrap();
        h.pump();
        assert!(h.r.hosted_serving());
        assert_eq!(
            h.r.store().meta(crate::store::meta_keys::GENESIS).unwrap(),
            Some(pin.0.to_vec())
        );
        drop(h);
        let other = world_with_device_order(alter_genesis);
        let mut other_h = open(&other, MemStore::new());
        other_h.pump();
        let other_head = other_h.r.head;
        let other_policy = other_h
            .r
            .store()
            .meta(crate::store::meta_keys::POLICY)
            .unwrap();
        // Disposable cached policy/head are not authority. Keep the correct stored
        // GENESIS marker, but give the cache the other valid same-root control prefix.
        let mut cache = MemStore::shared(data.clone());
        cache
            .commit(Tx {
                head: Some(other_head),
                meta: vec![(crate::store::meta_keys::POLICY.into(), other_policy)],
                ..Tx::default()
            })
            .unwrap();
        assert_eq!(
            cache.meta(crate::store::meta_keys::GENESIS).unwrap(),
            Some(pin.0.to_vec())
        );
        assert_eq!(
            mdbn_wire::hash::chain_hash(&other.items(&COL)[0]) == pin,
            !alter_genesis
        );
        let mut h = try_open_with_pin(
            &other,
            MemStore::shared(data),
            None,
            HostedProfile::default(),
            Box::new(CreatePlanner),
            Some(pin),
        )
        .unwrap();
        h.pump();
        if alter_genesis {
            assert!(
                !h.r.hosted_serving(),
                "wrong raw pinned genesis must never serve even when policy equality succeeds"
            );
            assert!(h.r.apply_fault, "raw genesis mismatch must be terminal");
        } else {
            assert!(
                h.r.hosted_serving(),
                "unchanged pinned warm replay remains supported"
            );
        }
    }
}

/// Warm wake: keys are RAM-only, so a reopen over the persisted cache re-derives
/// them from the log's control prefix (fresh policy, full checks) before serving.
#[test]
fn warm_wake_rederives_keys_from_the_log() {
    let svc = world();
    let store = MemStore::new();
    let data = store.data();
    let mut h = open(&svc, store);
    h.pump();
    let s = h.session(G1);
    let t = h.r.submit_logged(s, create(1, "a.md", None)).unwrap();
    h.pump();
    assert_eq!(h.ack(t).state, ReceiptState::Confirmed);
    drop(h);
    // No keys handed in: the reopened replica must find them in the log.
    let mut h = open(&svc, MemStore::shared(data));
    assert!(!h.r.hosted_serving());
    h.pump();
    assert!(h.r.hosted_serving());
    assert!(!h.r.hosted_needs_reset());
    let s = h.session(G1);
    let t = h.r.submit_logged(s, create(2, "b.md", None)).unwrap();
    h.pump();
    assert_eq!(
        h.ack(t).state,
        ReceiptState::Confirmed,
        "sealed with re-derived keys"
    );
}

/// A cache whose policy disagrees with the log's control prefix is never served.
#[test]
fn warm_wake_refuses_a_cache_that_disagrees_with_the_log() {
    let svc = world();
    let store = MemStore::new();
    let data = store.data();
    let mut h = open(&svc, store);
    h.pump();
    drop(h);
    let mut tampered = MemStore::shared(data.clone());
    tampered
        .commit(Tx {
            // A well-formed policy the log never produced (no devices, no grants).
            meta: vec![(
                crate::store::meta_keys::POLICY.into(),
                Some(crate::policy::PolicyState::new().to_bytes().unwrap()),
            )],
            ..Tx::default()
        })
        .unwrap();
    let mut h = open(&svc, MemStore::shared(data));
    h.pump();
    assert!(h.r.hosted_needs_reset());
    assert!(!h.r.hosted_serving());
    rebuilding(h.r.hello(grant_auth(G1), hello()).unwrap_err());
}

/// A log whose head is below the cache (lost tail, or another log) is never trusted
/// for a warm wake: the cache must be dropped and rebuilt.
#[test]
fn warm_wake_refuses_a_log_behind_the_cache() {
    let svc = world();
    let store = MemStore::new();
    let data = store.data();
    let mut h = open(&svc, store);
    h.pump();
    let s = h.session(G1);
    let t = h.r.submit_logged(s, create(1, "a.md", None)).unwrap();
    h.pump();
    assert_eq!(h.ack(t).state, ReceiptState::Confirmed);
    drop(h);
    svc.lose_tail(&COL, 1);
    let mut h = open(&svc, MemStore::shared(data));
    h.pump();
    assert!(h.r.hosted_needs_reset());
    assert!(!h.r.hosted_serving());
}

/// Ready requires the verified policy to keep this hosted device a member: a
/// revocation drops it (and a fresh head fetch alone does not restore it).
#[test]
fn revoking_the_hosted_device_drops_ready() {
    let svc = world();
    let mut h = open(&svc, MemStore::new());
    h.pump();
    assert!(h.r.hosted_serving());
    // A fresh test control plane must issue after world()'s policy items.
    let mut cp = TestControlPlane::new(COL);
    for _ in 0..4 {
        cp.append(&svc, Vec::new());
    }
    cp.revoke(&svc, HOSTED_DEV);
    h.pump();
    assert_eq!(
        h.r.policy.devices.get(&HOSTED_DEV).map(|d| d.active),
        Some(false)
    );
    assert!(!h.r.hosted_serving());
    rebuilding(h.r.hello(grant_auth(G1), hello()).unwrap_err());
}

/// The Ready fact names the fetched head and its fault generation; a fault bumps
/// the generation and the fact is re-established only from a fresh fetch.
#[test]
fn ready_fact_binds_the_fetched_head_and_generation() {
    let svc = world();
    let mut h = open(&svc, MemStore::new());
    h.pump();
    let f = h.r.hosted_fresh_head().expect("ready");
    assert_eq!(f.applied, (h.r.head().seq, h.r.head().chain));
    assert!(f.fetched.0 <= f.applied.0);
    h.r.on_log_push(crate::log::LogPush::Disconnected);
    assert!(h.r.hosted_fresh_head().is_none());
    h.pump();
    let g = h.r.hosted_fresh_head().expect("ready again");
    assert!(g.generation > f.generation);
}

/// Readiness gate edges: a head fetch sent before a fault, or a reply of the
/// wrong shape, never restores Ready; a newer reported head that is not applied
/// yet withholds it.
#[test]
fn ready_needs_a_post_fault_fetch_of_the_right_shape_and_the_newest_head() {
    use crate::log::{LogPush, LogResponse};
    let svc = world();
    let mut h = open(&svc, MemStore::new());
    h.pump();
    assert!(h.r.hosted_serving());
    // Fault 1 queues fetch A; fault 2 queues fetch B. A's reply is pre-fault.
    h.r.on_log_push(LogPush::Disconnected);
    let a: Vec<_> = h.r.take_log_calls();
    h.r.on_log_push(LogPush::Disconnected);
    let b: Vec<_> = h.r.take_log_calls();
    let sub = |calls: &Vec<crate::log::LogCall>| {
        calls
            .iter()
            .find(|c| matches!(c.request, LogRequest::Subscribe { .. }))
            .cloned()
            .unwrap()
    };
    let (a, b) = (sub(&a), sub(&b));
    let reply = h.log.call(a.request.clone());
    h.r.on_log_reply(a.id, reply);
    assert!(
        !h.r.hosted_serving(),
        "a pre-fault fetch is not a fresh fence"
    );
    // A wrong-shaped answer to the current fetch does not count either.
    h.r.on_log_reply(b.id, Ok(LogResponse::PutSnapshot(true)));
    assert!(!h.r.hosted_serving());
    h.pump();
    assert!(h.r.hosted_serving(), "a later fresh fetch restores Ready");
    // A newer head reported but not yet applied withholds Ready.
    let head = h.r.head().seq;
    h.r.on_log_push(LogPush::Head {
        collection: COL,
        head: head + 5,
        head_chain: mdbn_wire::common::B32([1; 32]),
    });
    assert!(!h.r.hosted_serving());
}

/// A fully caught-up plaintext fixture is still not verified cryptographic custody.
/// Also pin fail-closed live head, root, membership, and cache-health checks.
#[test]
fn verified_observer_never_promotes_plain_or_substituted_state() {
    use crate::{HostedAdmission, HostedAdmissionDenial as D};
    let svc = world();
    let mut h = open(&svc, MemStore::new());
    assert_eq!(
        h.r.verified_hosted_admission(),
        HostedAdmission::Deny(D::HeadUnproven)
    );
    h.pump();
    assert!(h.r.hosted_serving());
    assert_eq!(
        h.r.verified_hosted_admission(),
        HostedAdmission::Deny(D::IdentityUnavailable)
    );
    let old_kind = h.r.policy.devices[&HOSTED_DEV].kind;
    h.r.policy.devices.get_mut(&HOSTED_DEV).unwrap().kind = DeviceKind::Desktop;
    assert_eq!(
        h.r.verified_hosted_admission(),
        HostedAdmission::Deny(D::MembershipInvalid)
    );
    h.r.policy.devices.get_mut(&HOSTED_DEV).unwrap().kind = old_kind;
    let roots = h.r.cfg.trusted_roots.clone();
    h.r.cfg.trusted_roots = vec![[0x99; 32]];
    assert_eq!(
        h.r.verified_hosted_admission(),
        HostedAdmission::Deny(D::PolicyMismatch)
    );
    h.r.cfg.trusted_roots = roots;
    let head = h.r.head;
    h.r.head.chain = mdbn_wire::common::B32([0x99; 32]);
    assert_eq!(
        h.r.verified_hosted_admission(),
        HostedAdmission::Deny(D::HeadUnproven)
    );
    h.r.head = head;
    h.r.apply_fault = true;
    assert_eq!(
        h.r.verified_hosted_admission(),
        HostedAdmission::Deny(D::CacheUnavailable)
    );
    h.r.apply_fault = false;
    h.r.on_log_push(crate::log::LogPush::Disconnected);
    assert_eq!(
        h.r.verified_hosted_admission(),
        HostedAdmission::Deny(D::HeadUnproven)
    );
}

/// Policy origin facts: cold opens never use cached policy bytes (head 0 with an
/// injected POLICY starts fresh and applies from genesis); a warm wake reports the
/// verified replay through the cache's head.
#[test]
fn policy_origin_is_genesis_cold_and_replayed_warm() {
    use crate::replica::PolicyOrigin;
    let svc = world();
    // Cold, with policy bytes injected into an empty cache: not used.
    let mut injected = MemStore::new();
    let mut fake = crate::policy::PolicyState::new();
    fake.cstate = Some(mdbn_wire::policy::CState::CloudCopy);
    injected
        .commit(Tx {
            meta: vec![(
                crate::store::meta_keys::POLICY.into(),
                Some(fake.to_bytes().unwrap()),
            )],
            ..Tx::default()
        })
        .unwrap();
    let data = injected.data();
    let mut h = open(&svc, injected);
    assert_eq!(h.r.policy.cstate, None, "injected cold policy ignored");
    assert_eq!(h.r.hosted_policy_origin(), PolicyOrigin::Genesis);
    assert!(!h.r.hosted_serving());
    h.pump();
    assert!(h.r.hosted_serving());
    let head = h.r.head().seq;
    drop(h);
    let mut h = open(&svc, MemStore::shared(data));
    h.pump();
    assert_eq!(
        h.r.hosted_policy_origin(),
        PolicyOrigin::Replayed { target: head }
    );
}

/// Paged hosted reads ask for the DO apply byte budget (logsvc `read.max_bytes`), and a
/// byte-truncated answer (`more` after fewer items than the limit) keeps the replica
/// reading until it reaches the head.
#[test]
fn hosted_reads_ask_for_the_byte_budget_and_page_on_truncation() {
    use crate::log::LogResponse;
    use crate::replica::HOSTED_READ_BYTES;
    let svc = world();
    let mut full = open(&svc, MemStore::new());
    full.pump();
    let mut h = open(&svc, MemStore::new());
    let mut paged = Vec::new();
    for _ in 0..200 {
        let calls = h.r.take_log_calls();
        for c in calls {
            let mut reply = h.log.call(c.request.clone());
            if let LogRequest::Read(p) = &c.request {
                if p.limit > 1 {
                    paged.push(p.max_bytes);
                }
                // A byte-capped server: one item per answer.
                if let Ok(LogResponse::Read(r)) = &mut reply
                    && r.items.len() > 1
                {
                    r.items.truncate(1);
                    r.more = true;
                }
            }
            h.r.on_log_reply(c.id, reply);
        }
        h.r.tick();
    }
    assert!(paged.len() > 1, "{paged:?}");
    assert!(
        paged.iter().all(|m| *m == Some(HOSTED_READ_BYTES)),
        "{paged:?}"
    );
    assert_eq!(h.r.head(), full.r.head());
    assert!(h.r.head().seq > 1);
}

const OWNER_SIGN: [u8; 32] = [0x31; 32];
const OWNER_KEM: [u8; 32] = [0x32; 32];
const HOST_SIGN: [u8; 32] = [0x33; 32];
const HOST_KEM: [u8; 32] = [0x34; 32];
const ESCROW_SIGN: [u8; 32] = [0x35; 32];
const ESCROW_KEM: [u8; 32] = [0x36; 32];

/// Real signed genesis/enrollments; the FakeLog models the trusted authenticated
/// transport boundary, not actual service-binding/token/PoP execution.
fn crypto_world() -> (FakeLogService, TestControlPlane) {
    use crate::crypto::{hpke::KemKeyPair, sign::DeviceSigner};
    use mdbn_wire::common::B32;
    use mdbn_wire::policy::{DeviceEnrol, PolicyOp};
    let svc = FakeLogService::new();
    let mut cp = TestControlPlane::signed(COL);
    cp.genesis_with_keys(&svc, CState::CloudCopy, OWNER_DEV, &OWNER_SIGN, &OWNER_KEM);
    cp.append(
        &svc,
        [
            (HOSTED_DEV, DeviceKind::Hosted, HOST_SIGN, HOST_KEM),
            (ESCROW_DEV, DeviceKind::Escrow, ESCROW_SIGN, ESCROW_KEM),
        ]
        .into_iter()
        .map(|(device, kind, sign, kem)| {
            PolicyOp::DeviceEnrol(DeviceEnrol {
                device,
                account: crate::policy::SERVICE_ACCOUNT,
                kind,
                sign_pk: B32(DeviceSigner::from_seed(&sign).public()),
                kem_pk: B32(KemKeyPair::from_secret(&kem).pk),
                noise_pk: B32([device.0[0]; 32]),
                sas_commit: None,
                local_root: None,
            })
        })
        .collect(),
    );
    (svc, cp)
}

fn crypto_wrap(svc: &FakeLogService, signer: B16) {
    use crate::crypto::{hpke::KemKeyPair, keys::Recipient};
    use crate::log::LogResponse;
    use crate::seal::{KeyringSealer, Sealer};
    use mdbn_wire::log_service::AppendParams;
    let (sign, kem) = if signer == OWNER_DEV {
        (OWNER_SIGN, OWNER_KEM)
    } else if signer == HOSTED_DEV {
        (HOST_SIGN, HOST_KEM)
    } else {
        (ESCROW_SIGN, ESCROW_KEM)
    };
    let mut custody = KeyringSealer::new(COL, signer, &sign, &kem);
    let recipients = [
        (OWNER_DEV, OWNER_KEM),
        (HOSTED_DEV, HOST_KEM),
        (ESCROW_DEV, ESCROW_KEM),
    ]
    .into_iter()
    .map(|(device, kem)| Recipient {
        device,
        kem_pk: KemKeyPair::from_secret(&kem).pk,
    })
    .collect::<Vec<_>>();
    let payload = custody
        .build_rekey(
            0,
            &recipients,
            RekeyReason::Initial,
            &mut crate::crypto::TestEntropy::new(71),
        )
        .unwrap();
    let (head, prev) = svc.head(&COL);
    let mut item = mdbn_wire::envelope::Item {
        kind: ItemKind::Rekey,
        collection: COL,
        seq: Some(head + 1),
        prev: Some(prev),
        epoch: None,
        signer: Some(signer),
        salt: None,
        idem: None,
        refs: None,
        stream: None,
        body: Bytes(payload.to_bytes().unwrap()),
        sig: None,
    };
    custody.sign(&mut item).unwrap();
    let reply = svc.client(signer).call(LogRequest::Append(AppendParams {
        collection: COL,
        expect_seq: head + 1,
        expect_prev: prev,
        items: vec![Bytes(item.to_bytes().unwrap())],
    }));
    assert!(matches!(reply, Ok(LogResponse::Append(_))), "{reply:?}");
}

fn crypto_open(svc: &FakeLogService, store: MemStore) -> Hosted {
    let mut cfg = open(svc, MemStore::new()).r.cfg.clone();
    cfg.trusted_roots = vec![crate::testkit::signed_root()];
    let clock = Rc::new(Cell::new(1_700_000_000_000));
    let r = Replica::open_hosted(
        cfg,
        store,
        Box::new(CreatePlanner),
        Box::new(crate::seal::KeyringSealer::new(
            COL, HOSTED_DEV, &HOST_SIGN, &HOST_KEM,
        )),
        Host {
            clock: Box::new(TestClock(clock.clone())),
            entropy: Box::new(crate::crypto::TestEntropy::new(91)),
            zones: Box::new(UtcOnly),
        },
        DeviceSecrets {
            sign_sk: HOST_SIGN,
            kem_sk: HOST_KEM,
        },
        HostedProfile::default(),
    )
    .unwrap();
    Hosted {
        r,
        log: svc.client(HOSTED_DEV),
        clock,
    }
}

fn verified(h: &Hosted) -> crate::VerifiedHostedAdmission {
    match h.r.verified_hosted_admission() {
        crate::HostedAdmission::Verified(evidence) => *evidence,
        other => panic!("expected verified hosted state, got {other:?}"),
    }
}

#[test]
fn verified_observer_real_owner_wrap_wake_and_fault_generation() {
    use crate::{HostedAdmission, HostedAdmissionDenial as D};
    let (svc, _) = crypto_world();
    crypto_wrap(&svc, OWNER_DEV);
    let store = MemStore::new();
    let data = store.data();
    let mut h = crypto_open(&svc, store);
    assert_eq!(
        h.r.verified_hosted_admission(),
        HostedAdmission::Deny(D::HeadUnproven)
    );
    h.pump();
    let evidence = verified(&h);
    assert_eq!(evidence.collection(), COL);
    assert_eq!(evidence.device(), HOSTED_DEV);
    assert_eq!(evidence.epoch(), 1);
    assert_eq!(evidence.key_delivery_device(), OWNER_DEV);
    assert_eq!(evidence.key_delivery_seq(), 3);
    assert_eq!(evidence.applied_head(), h.r.head());
    h.r.on_log_push(crate::log::LogPush::Disconnected);
    assert_eq!(
        h.r.verified_hosted_admission(),
        HostedAdmission::Deny(D::HeadUnproven)
    );
    h.pump();
    assert!(verified(&h).generation() > evidence.generation());
    h.r.apply_fault = true;
    assert_eq!(
        h.r.verified_hosted_admission(),
        HostedAdmission::Deny(D::CacheUnavailable)
    );
    drop(h);
    let mut h = crypto_open(&svc, MemStore::shared(data));
    assert_eq!(
        h.r.verified_hosted_admission(),
        HostedAdmission::Deny(D::HeadUnproven)
    );
    h.pump();
    assert_eq!(verified(&h).key_delivery_device(), OWNER_DEV);
}

#[test]
fn verified_observer_keyless_denied_actual_cloud_hosted_delivery_proven() {
    use crate::{HostedAdmission, HostedAdmissionDenial as D};
    let (svc, _) = crypto_world();
    let mut h = crypto_open(&svc, MemStore::new());
    let held = cloud_keying::prekey(&mut h);
    assert_eq!(
        h.r.verified_hosted_admission(),
        HostedAdmission::Deny(D::KeyUnavailable)
    );
    // Observe healthy pre-key proof before actually dispatching the producer's
    // signed Hosted bootstrap. Eligibility itself does not learn or ACK a key.
    assert!(matches!(
        h.r.verified_hosted_bootstrap(),
        crate::HostedBootstrapAdmission::Eligible(_)
    ));
    assert_eq!(held.len(), 1);
    for call in held {
        let reply = h.log.call(call.request);
        h.r.on_log_reply(call.id, reply);
    }
    h.pump();
    assert_eq!(h.r.sealer.current_epoch(), Some(1));
    assert_eq!(h.r.policy.epoch, 1);
    assert_eq!(verified(&h).key_delivery_device(), HOSTED_DEV);
    assert_eq!(verified(&h).key_delivery_seq(), 3);
    assert_eq!(
        h.r.verified_hosted_bootstrap(),
        crate::HostedBootstrapAdmission::Deny(D::EpochAlreadyCreated)
    );
}

#[test]
fn verified_observer_promotion_does_not_rewrite_historical_delivery() {
    use crate::{HostedAdmission, HostedAdmissionDenial as D};
    use mdbn_wire::policy::{MemberSet, PolicyOp, Role};
    let (svc, mut cp) = crypto_world();
    cp.append(
        &svc,
        vec![
            PolicyOp::MemberSet(MemberSet {
                account: B16([0xaa; 16]),
                role: Role::Owner,
            }),
            PolicyOp::MemberSet(MemberSet {
                account: TEST_OWNER,
                role: Role::Editor,
            }),
        ],
    );
    // Authenticated cloud-legal delivery is no longer owner-only. But a current
    // promotion/cached delivered_by still cannot reconstruct a lost RAM proof.
    crypto_wrap(&svc, OWNER_DEV);
    let mut h = crypto_open(&svc, MemStore::new());
    h.pump();
    assert_eq!(h.r.sealer.current_epoch(), Some(1));
    assert_eq!(verified(&h).key_delivery_device(), OWNER_DEV);
    h.r.hosted_key_delivery = None;
    assert_eq!(
        h.r.verified_hosted_admission(),
        HostedAdmission::Deny(D::KeyDeliveryUnproven)
    );
    cp.append(
        &svc,
        vec![PolicyOp::MemberSet(MemberSet {
            account: TEST_OWNER,
            role: Role::Owner,
        })],
    );
    h.pump();
    assert_eq!(h.r.policy.members[&TEST_OWNER], Role::Owner);
    assert_eq!(
        h.r.verified_hosted_admission(),
        HostedAdmission::Deny(D::KeyDeliveryUnproven)
    );
}

#[test]
fn verified_observer_log_closed_requires_a_new_authenticated_head() {
    use crate::log::LogPush;
    use crate::{HostedAdmission, HostedAdmissionDenial as D};
    let (svc, _) = crypto_world();
    crypto_wrap(&svc, OWNER_DEV);
    let mut h = crypto_open(&svc, MemStore::new());
    h.pump();
    let before = verified(&h);
    // A different collection's event cannot invalidate this instance's proof.
    h.r.on_log_push(LogPush::Closed {
        collection: B16([0xaa; 16]),
        reason: "forbidden".into(),
    });
    assert_eq!(verified(&h).generation(), before.generation());
    h.r.on_log_push(LogPush::Closed {
        collection: COL,
        reason: "forbidden".into(),
    });
    assert_eq!(
        h.r.verified_hosted_admission(),
        HostedAdmission::Deny(D::HeadUnproven)
    );
    let calls = h.r.take_log_calls();
    assert!(
        calls
            .iter()
            .any(|call| matches!(call.request, LogRequest::Subscribe { .. }))
    );
    // Not restored merely by tick, retained policy or the old applied head.
    h.r.tick();
    assert_eq!(
        h.r.verified_hosted_admission(),
        HostedAdmission::Deny(D::HeadUnproven)
    );
    for call in calls {
        let reply = h.log.call(call.request);
        h.r.on_log_reply(call.id, reply);
    }
    h.pump();
    let after = verified(&h);
    assert_eq!(after.wake_instance(), before.wake_instance());
    assert!(after.generation() > before.generation());
    assert_eq!(after.authenticated_head(), h.r.head());
}

#[test]
fn verified_observer_unknown_committed_key_delivery_never_publishes_attempt() {
    use crate::{HostedAdmission, HostedAdmissionDenial as D};
    let (svc, _) = crypto_world();
    let store = MemStore::new();
    let data = store.data();
    let mut h = crypto_open(&svc, store);
    let held = cloud_keying::prekey(&mut h);
    assert_eq!(h.r.head.seq, 2);
    assert_eq!(held.len(), 1);
    data.borrow_mut().fail_after_head_commit = Some(3);
    for call in held {
        let reply = h.log.call(call.request);
        h.r.on_log_reply(call.id, reply);
    }
    h.pump();
    assert!(h.r.apply_fault);
    assert_eq!(
        h.r.verified_hosted_bootstrap(),
        crate::HostedBootstrapAdmission::Deny(D::CacheUnavailable)
    );
    assert!(
        h.r.hosted_key_delivery.is_none(),
        "attempted authenticated cloud delivery proof rolled back"
    );
    assert_eq!(
        h.r.verified_hosted_admission(),
        HostedAdmission::Deny(D::CacheUnavailable)
    );
    h.r.on_log_push(crate::log::LogPush::Reconnected);
    h.pump();
    assert_eq!(
        h.r.verified_hosted_admission(),
        HostedAdmission::Deny(D::CacheUnavailable)
    );
    drop(h);
    // Fresh generation: the successful committed prefix is verified anew from
    // genesis/control, keys are re-derived, then a NEW authenticated head fetched.
    let mut h = crypto_open(&svc, MemStore::shared(data));
    assert_eq!(
        h.r.verified_hosted_admission(),
        HostedAdmission::Deny(D::HeadUnproven)
    );
    h.pump();
    assert_eq!(verified(&h).key_delivery_seq(), 3);
}

#[test]
fn verified_observer_failed_cloud_unwrap_never_relabels_a_prior_key() {
    use crate::{HostedAdmission, HostedAdmissionDenial as D};
    use mdbn_wire::common::B32;
    use mdbn_wire::envelope::{Item, KeyGrantPayload};
    use mdbn_wire::log_service::AppendParams;
    let (svc, _) = crypto_world();
    crypto_wrap(&svc, HOSTED_DEV);
    let mut h = crypto_open(&svc, MemStore::new());
    h.pump();
    assert_eq!(h.r.sealer.current_epoch(), Some(1));
    let (head, prev) = svc.head(&COL);
    let payload = KeyGrantPayload {
        recipient: HOSTED_DEV,
        epoch: 1,
        wrap: KeyWrap {
            device: HOSTED_DEV,
            enc: B32([0; 32]),
            ct: Bytes(vec![0; 48]),
        },
    };
    let mut item = Item {
        kind: ItemKind::KeyGrant,
        collection: COL,
        seq: Some(head + 1),
        prev: Some(prev),
        epoch: None,
        signer: Some(OWNER_DEV),
        salt: None,
        idem: None,
        refs: None,
        stream: None,
        body: Bytes(payload.to_bytes().unwrap()),
        sig: None,
    };
    crate::crypto::sign::DeviceSigner::from_seed(&OWNER_SIGN)
        .sign_item(&mut item)
        .unwrap();
    svc.client(OWNER_DEV)
        .call(LogRequest::Append(AppendParams {
            collection: COL,
            expect_seq: head + 1,
            expect_prev: prev,
            items: vec![Bytes(item.to_bytes().unwrap())],
        }))
        .unwrap();
    h.pump();
    assert_eq!(
        h.r.policy.devices[&HOSTED_DEV].delivered_by,
        Some(OWNER_DEV)
    );
    assert_eq!(
        h.r.sealer.current_epoch(),
        Some(1),
        "prior authenticated hosted key remains held"
    );
    assert_eq!(
        h.r.verified_hosted_admission(),
        HostedAdmission::Deny(D::KeyDeliveryUnproven)
    );
}

#[test]
fn verified_observer_owner_transfer_does_not_erase_authenticated_cloud_delivery() {
    use mdbn_wire::policy::{MemberSet, PolicyOp, Role};
    let (svc, mut cp) = crypto_world();
    crypto_wrap(&svc, OWNER_DEV);
    let mut h = crypto_open(&svc, MemStore::new());
    h.pump();
    verified(&h);
    cp.append(
        &svc,
        vec![
            PolicyOp::MemberSet(MemberSet {
                account: B16([0xaa; 16]),
                role: Role::Owner,
            }),
            PolicyOp::MemberSet(MemberSet {
                account: TEST_OWNER,
                role: Role::Editor,
            }),
        ],
    );
    h.pump();
    assert_eq!(h.r.policy.members[&TEST_OWNER], Role::Editor);
    // New decision removes the extra current-owner availability gate. Prior
    // authentic delivery remains historical fact; normal rekey/fault gates stay.
    assert_eq!(verified(&h).key_delivery_device(), OWNER_DEV);
    assert_eq!(verified(&h).key_delivery_seq(), 3);
}

/// A log call failing during the warm-key replay bumps the
/// fault generation; the head fetch queued when the replay finishes belongs to that
/// generation, so Ready comes back without another fault.
#[test]
fn a_failure_during_warm_key_replay_still_reaches_ready() {
    use crate::log::LogError;
    let svc = world();
    let store = MemStore::new();
    let data = store.data();
    let mut h = open(&svc, store);
    h.pump();
    drop(h);
    let mut h = open(&svc, MemStore::shared(data));
    let calls = h.r.take_log_calls();
    let rebuild = calls
        .iter()
        .find(|c| matches!(&c.request, LogRequest::Read(p) if p.kinds.is_some()))
        .expect("a warm-key control read")
        .clone();
    for c in calls {
        if c.id != rebuild.id {
            let reply = h.log.call(c.request);
            h.r.on_log_reply(c.id, reply);
        }
    }
    h.r.on_log_reply(rebuild.id, Err(LogError::NoResponse));
    assert!(!h.r.hosted_serving());
    h.pump();
    assert!(
        h.r.hosted_serving(),
        "the replay's own head fetch restores Ready"
    );
    assert!(h.r.hosted_fresh_head().expect("ready").generation >= 1);
}

/// Head fetches that failed, came back with the wrong shape
/// or belong to an earlier generation are not kept.
#[test]
fn head_fetch_tracking_stays_bounded_across_faults() {
    use crate::log::{LogPush, LogResponse};
    let svc = world();
    let mut h = open(&svc, MemStore::new());
    h.pump();
    for _ in 0..50 {
        h.r.on_log_push(LogPush::Disconnected);
    }
    assert!(h.r.testing_fetches() <= 1, "{}", h.r.testing_fetches());
    for c in h.r.take_log_calls() {
        if matches!(c.request, LogRequest::Subscribe { .. }) {
            h.r.on_log_reply(c.id, Ok(LogResponse::PutSnapshot(true)));
        }
    }
    assert_eq!(
        h.r.testing_fetches(),
        1,
        "the failed fetch's fault queued one new fetch"
    );
    h.pump();
    assert!(h.r.hosted_serving());
    assert_eq!(h.r.testing_fetches(), 0);
}

/// Owner lookups are byte-bounded too. A window that does not
/// fit the budget (the answer stops before the applied head, with `more`) leaves the
/// owner unknown: `outcome_unknown`, never an unbounded proof read.
#[test]
fn an_owner_window_over_the_byte_budget_is_outcome_unknown() {
    use crate::log::LogResponse;
    use crate::replica::HOSTED_READ_BYTES;
    let svc = world();
    let mut h = open(&svc, MemStore::new());
    h.pump();
    let s1 = h.session(G1);
    for (n, path, m) in [(1, "a.md", 0x61), (2, "b.md", 0x62)] {
        let t =
            h.r.submit_logged(s1, create(n, path, Some(mid(m))))
                .unwrap();
        h.pump();
        let _ = h.ack(t);
    }
    h.r.store_mut()
        .inner_mut()
        .commit(Tx {
            local_receipts_prune: Some(i64::MAX),
            ..Tx::default()
        })
        .unwrap();
    let e = h.r.receipt(s1, mid(0x61)).unwrap_err();
    assert_eq!(e.problem().reason.as_deref(), Some("receipt_owner_pending"));
    let calls = h.r.take_log_calls();
    let read = calls
        .iter()
        .find(|c| matches!(c.request, LogRequest::Read(_)))
        .unwrap();
    let LogRequest::Read(p) = &read.request else {
        unreachable!()
    };
    assert_eq!(p.max_bytes, Some(HOSTED_READ_BYTES));
    assert!(p.limit >= 2);
    let mut reply = h.log.call(read.request.clone());
    if let Ok(LogResponse::Read(r)) = &mut reply {
        r.items.truncate(1);
        r.more = true;
    }
    h.r.on_log_reply(read.id, reply);
    let e = h.r.receipt(s1, mid(0x61)).unwrap_err();
    assert_eq!(e.code(), Some(ErrorCode::OutcomeUnknown));
    assert_eq!(e.problem().reason.as_deref(), Some("receipt_owner_unknown"));
}
/// The log closing this collection (authority
/// or transport loss) drops Ready and its head evidence; only a fresh fetch after
/// re-establishing restores it.
#[test]
fn a_closed_log_drops_ready_until_a_fresh_fetch() {
    use crate::log::LogPush;
    let svc = world();
    let mut h = open(&svc, MemStore::new());
    h.pump();
    let before = h.r.hosted_fresh_head().expect("ready");
    h.r.on_log_push(LogPush::Closed {
        collection: COL,
        reason: "forbidden".into(),
    });
    assert!(!h.r.hosted_serving());
    assert!(h.r.hosted_fresh_head().is_none());
    h.r.on_log_push(LogPush::Reconnected);
    h.pump();
    let after = h.r.hosted_fresh_head().expect("ready after a fresh fetch");
    assert!(after.generation > before.generation);
}

#[path = "hosted_attachment_upload.rs"]
mod delegated_attachment_create;

#[path = "hosted_cloud.rs"]
mod cloud_keying;
