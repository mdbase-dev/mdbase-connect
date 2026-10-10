//! Actual read/timer paths with a synthetic stalled state; not key acceptance.
use crate::log::{EndpointId, LogError, LogPort, LogPush, LogRequest};
use crate::mem::MemStore;
use crate::seal::PlainSealer;
use crate::{DeviceSecrets, Host, Replica, ReplicaConfig, UtcOnly};
use mdbn_core::host::Clock;
use mdbn_wire::client::{IncidentKind, SyncMode};
use mdbn_wire::common::{B16, B32};
use std::{cell::Cell, rc::Rc};
struct Now(Rc<Cell<u64>>);
impl Clock for Now {
    fn now_ms(&self) -> u64 {
        self.0.get()
    }
}
fn waiting() -> (Replica<MemStore>, Rc<Cell<u64>>) {
    let clock = Rc::new(Cell::new(0));
    let mut replica = Replica::open(
        ReplicaConfig {
            collection: B16([1; 16]),
            replica_id: B16([2; 16]),
            device_id: B16([3; 16]),
            mode: SyncMode::Synced,
            log_endpoint: EndpointId(1),
            verify: false,
            runtime_version: "test".into(),
            trusted_roots: vec![],
            trusted_signers: vec![],
            e2e: false,
            user_enabled_cloud_copy: false,
            chosen_state: None,
            expected_genesis: None,
            key_grants_only: false,
            policy_pins: None,
        },
        MemStore::new(),
        Box::new(crate::plan::CorePlanner),
        Box::new(PlainSealer::for_device(B16([3; 16]))),
        Host {
            clock: Box::new(Now(clock.clone())),
            entropy: Box::new(crate::crypto::TestEntropy::new(1)),
            zones: Box::new(UtcOnly),
        },
        DeviceSecrets {
            sign_sk: [1; 32],
            kem_sk: [2; 32],
        },
    )
    .unwrap();
    replica.calls.clear();
    replica.inflight.clear();
    replica.reading = false;
    replica.stalled = Some((IncidentKind::WaitingForKey, 4));
    replica.head_known = 4;
    (replica, clock)
}
#[test]
fn key_wait_actual_pump_tick_and_reply_do_not_immediately_repeat_reads() {
    let (mut replica, clock) = waiting();
    replica.pump();
    assert!(replica.take_log_calls().is_empty());
    assert_eq!(replica.next_wakeup(), Some(1_000));
    for _ in 0..100 {
        replica.pump();
        replica.tick();
    }
    assert!(replica.take_log_calls().is_empty());
    clock.set(1_000);
    replica.tick();
    let calls = replica.take_log_calls();
    assert_eq!(calls.len(), 1);
    let LogRequest::Read(read) = &calls[0].request else {
        panic!("ordinary prefix read")
    };
    assert_eq!(read.after, replica.head().seq);
    assert_eq!(read.kinds, None);
    assert_eq!(replica.next_wakeup(), None, "one read remains in flight");
    replica.on_log_reply(calls[0].id, Err(LogError::Offline));
    assert!(
        replica.take_log_calls().is_empty(),
        "reply cannot bypass deadline"
    );
    assert_eq!(replica.next_wakeup(), Some(3_000));
    clock.set(2_999);
    replica.tick();
    assert!(replica.take_log_calls().is_empty());
    clock.set(3_000);
    replica.tick();
    assert_eq!(
        replica.take_log_calls().len(),
        1,
        "bounded probes never stop permanently"
    );
    assert_eq!(replica.stalled, Some((IncidentKind::WaitingForKey, 4)));
    assert!(!replica.caught_up);
}
#[test]
fn a_head_hint_does_not_supply_authority_or_reset_key_wait_deadline() {
    let (mut replica, _) = waiting();
    replica.pump();
    replica.on_log_push(LogPush::Head {
        collection: B16([1; 16]),
        head: 100,
        head_chain: B32([9; 32]),
    });
    assert!(replica.take_log_calls().is_empty());
    assert_eq!(replica.next_wakeup(), Some(1_000));
    assert_eq!(replica.stalled, Some((IncidentKind::WaitingForKey, 4)));
    assert!(!replica.caught_up);
}
#[test]
fn cleared_key_stall_resumes_prefix_reads_without_waiting_for_the_old_deadline() {
    let (mut replica, _) = waiting();
    replica.pump();
    // Model the existing verified-key event path clearing the stall. This fixture
    // intentionally makes no cryptographic acceptance or policy authority claim.
    replica.stalled = None;
    replica.pump();
    assert_eq!(replica.take_log_calls().len(), 1);
    assert_eq!(replica.key_wait_read.deadline(4), None);
}
