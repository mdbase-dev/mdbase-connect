//! Effect entry-point coverage for the closed mirror gate.
use super::engine::{Node, node};
use crate::fake::FakeLogService;
use crate::mem::MemStore;
use crate::mirror_admission::Fence;
use crate::replica::snapshot::BaseInstall;
use mdbn_wire::common::{B16, B32};

fn closed_node(detached: bool) -> Node {
    let mut n = node(&FakeLogService::default(), 1, MemStore::new());
    let mut shared = MemStore::shared(n.r.store().data());
    let f = Fence::new([1; 16], 1).unwrap();
    f.persist(&mut shared).unwrap();
    if detached {
        f.detached().persist(&mut shared).unwrap();
    }
    // Synthetic late metadata exercises defence-in-depth. Production persists
    // before first open and never installs a fence into a running replica.
    n.r.calls.clear();
    n.r.inflight.clear();
    n
}

struct FixedClock;
impl mdbn_core::host::Clock for FixedClock {
    fn now_ms(&self) -> u64 {
        1_700_000_000_000
    }
}

#[test]
fn mirror_gate_replica_open_before_replay_or_reconcile() {
    for detached in [false, true] {
        let n = closed_node(detached);
        let cfg = n.r.config().clone();
        let store = n.r.into_store();
        let host = crate::Host {
            clock: Box::new(FixedClock),
            entropy: Box::new(crate::crypto::TestEntropy::new(1)),
            zones: Box::new(crate::UtcOnly),
        };
        let result = crate::Replica::open(
            cfg,
            store,
            Box::new(crate::plan::CorePlanner),
            Box::new(crate::seal::PlainSealer::for_device(B16([101; 16]))),
            host,
            crate::DeviceSecrets {
                sign_sk: [1; 32],
                kem_sk: [1; 32],
            },
        );
        assert!(
            matches!(result, Err(crate::replica::OpenError::Mismatch(reason)) if reason.contains("sync: 1 items pending/held"))
        );
    }
}

#[test]
fn mirror_gate_replica_snapshot_build() {
    for detached in [false, true] {
        let mut n = closed_node(detached);
        assert!(n.r.build_snapshot_now().is_err());
        assert!(n.r.build.is_none());
        assert!(n.r.calls.is_empty());
    }
}
#[test]
fn mirror_gate_replica_snapshot_install() {
    for detached in [false, true] {
        let mut n = closed_node(detached);
        n.r.begin_install();
        assert!(!n.r.installing());
        assert!(n.r.calls.is_empty());
    }
}
#[test]
fn mirror_gate_replica_generation_zero_adoption() {
    for detached in [false, true] {
        let mut n = closed_node(detached);
        n.r.begin_base_install(
            BaseInstall {
                seq: 1,
                chain: B32([1; 32]),
                state_digest: B32([2; 32]),
                epoch: 1,
                item: vec![1],
            },
            B32([3; 32]),
            B16([4; 16]),
        );
        assert!(!n.r.installing());
        assert!(n.r.install_base.is_none());
        assert!(n.r.calls.is_empty());
    }
}
#[test]
fn mirror_gate_replica_reconcile_deletes_adoption_and_materialization() {
    for detached in [false, true] {
        let mut n = closed_node(detached);
        assert!(n.r.reconcile_disk().is_err());
        assert!(n.r.materialize().is_err());
        assert!(n.r.calls.is_empty());
    }
}
#[test]
fn mirror_gate_replica_observe_and_ingest() {
    for detached in [false, true] {
        let mut n = closed_node(detached);
        let before = Fence::load(n.r.store()).unwrap();
        assert!(n.r.observe(None).is_err());
        n.r.ingest(vec![]);
        assert_eq!(Fence::load(n.r.store()).unwrap(), before);
        assert!(n.r.calls.is_empty());
    }
}
