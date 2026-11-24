//! Actual read/timer paths with a synthetic stalled state; not key acceptance.
use crate::log::{EndpointId, LogError, LogPort, LogPush, LogRequest, LogResponse};
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
    stalled(IncidentKind::WaitingForKey)
}
fn stalled(kind: IncidentKind) -> (Replica<MemStore>, Rc<Cell<u64>>) {
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
    replica.stalled = Some((kind, 4));
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
fn a_head_hint_schedules_an_immediate_read_without_supplying_authority() {
    let (mut replica, _) = waiting();
    replica.pump();
    replica.on_log_push(LogPush::Head {
        collection: B16([1; 16]),
        head: 100,
        head_chain: B32([9; 32]),
    });
    let calls = replica.take_log_calls();
    assert_eq!(calls.len(), 1, "advancing hint triggers an immediate read");
    assert_eq!(replica.next_wakeup(), None, "one read remains in flight");
    assert_eq!(replica.stalled, Some((IncidentKind::WaitingForKey, 4)));
    assert!(!replica.caught_up);
    replica.on_log_reply(calls[0].id, Err(LogError::Offline));
    assert!(replica.take_log_calls().is_empty());
    assert_eq!(replica.next_wakeup(), Some(2_000));
    // Repeated identical or lower hints do not schedule another read.
    for head in [100, 100, 50] {
        replica.on_log_push(LogPush::Head {
            collection: B16([1; 16]),
            head,
            head_chain: B32([9; 32]),
        });
    }
    assert!(replica.take_log_calls().is_empty());
    assert_eq!(replica.next_wakeup(), Some(2_000));
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
    assert_eq!(replica.stall_read.deadline(4), None);
}
#[test]
fn a_pushed_head_past_the_last_probe_reads_immediately() {
    let (mut replica, clock) = waiting();
    replica.pump();
    clock.set(1_000);
    replica.tick();
    let calls = replica.take_log_calls();
    assert_eq!(calls.len(), 1);
    replica.on_log_reply(calls[0].id, Err(LogError::Offline));
    assert_eq!(replica.next_wakeup(), Some(3_000));
    clock.set(1_200);
    replica.on_log_push(LogPush::Head {
        collection: B16([1; 16]),
        head: 100,
        head_chain: B32([9; 32]),
    });
    let calls = replica.take_log_calls();
    assert_eq!(
        calls.len(),
        1,
        "advancing hint does not wait out FIRST_MS after the last probe"
    );
    assert_eq!(replica.stalled, Some((IncidentKind::WaitingForKey, 4)));
    assert!(!replica.caught_up);
    replica.on_log_reply(calls[0].id, Err(LogError::Offline));
    // Backoff continues doubling from the hint-triggered probe; identical hints wait.
    assert_eq!(replica.next_wakeup(), Some(5_200));
    clock.set(1_250);
    replica.on_log_push(LogPush::Head {
        collection: B16([1; 16]),
        head: 100,
        head_chain: B32([9; 32]),
    });
    assert!(replica.take_log_calls().is_empty());
    assert_eq!(replica.next_wakeup(), Some(5_200));
}
#[test]
fn a_pushed_head_arriving_while_a_probe_is_in_flight_triggers_only_if_newer_than_the_reply() {
    let (mut replica, clock) = waiting();
    replica.pump();
    clock.set(1_000);
    replica.tick();
    let calls = replica.take_log_calls();
    assert_eq!(calls.len(), 1);
    // Push arrives while the probe is in flight; no second concurrent read goes out.
    replica.on_log_push(LogPush::Head {
        collection: B16([1; 16]),
        head: 105,
        head_chain: B32([9; 32]),
    });
    assert!(replica.take_log_calls().is_empty());
    // The in-flight probe only saw head 100, so once it completes, the replica
    // immediately reads for the newer pushed head 105.
    replica.on_log_reply(
        calls[0].id,
        Ok(LogResponse::Read(mdbn_wire::log_service::ReadResult {
            items: vec![],
            head: 100,
            head_chain: B32([9; 32]),
            retained_from: 1,
            behind: false,
            snapshot: None,
            more: true,
        })),
    );
    let follow_up = replica.take_log_calls();
    assert_eq!(follow_up.len(), 1);
    // Once that read returns head 105, no further read is queued.
    replica.on_log_reply(
        follow_up[0].id,
        Ok(LogResponse::Read(mdbn_wire::log_service::ReadResult {
            items: vec![],
            head: 105,
            head_chain: B32([9; 32]),
            retained_from: 1,
            behind: false,
            snapshot: None,
            more: true,
        })),
    );
    assert!(replica.take_log_calls().is_empty());
    assert_eq!(replica.next_wakeup(), Some(5_000));
}
#[test]
fn a_pushed_head_after_a_second_probes_immediately_without_waiting_for_the_backoff() {
    let (mut replica, clock) = waiting();
    replica.pump();
    // Advance through the 1 s, 2 s, 4 s and 8 s backoff steps to the 16 s step (15 s -> 31 s).
    for probe_at in [1_000, 3_000, 7_000, 15_000] {
        clock.set(probe_at);
        replica.tick();
        let calls = replica.take_log_calls();
        assert_eq!(calls.len(), 1);
        replica.on_log_reply(calls[0].id, Err(LogError::Offline));
    }
    assert_eq!(replica.next_wakeup(), Some(31_000));
    // A pushed head at 18 s (more than FIRST_MS after the 15 s probe, 13 s before 31 s)
    // queues the probe immediately without waiting for the 31 s backoff step.
    clock.set(18_000);
    replica.on_log_push(LogPush::Head {
        collection: B16([1; 16]),
        head: 100,
        head_chain: B32([9; 32]),
    });
    assert_eq!(replica.take_log_calls().len(), 1);
    assert_eq!(replica.stalled, Some((IncidentKind::WaitingForKey, 4)));
    assert!(!replica.caught_up);
}
#[test]
fn a_stall_of_any_kind_is_re_read_on_the_backoff_not_from_the_read_reply() {
    for kind in [
        IncidentKind::UpgradeRequired,
        IncidentKind::Integrity,
        IncidentKind::WaitingForKey,
    ] {
        let (mut replica, clock) = stalled(kind);
        replica.pump();
        assert!(replica.take_log_calls().is_empty(), "{kind:?}");
        assert_eq!(replica.next_wakeup(), Some(1_000), "{kind:?}");
        let mut reads = 0;
        // A minute of 20 ms ticks, each read answered with a head past the
        // stall: the reply alone used to re-read at once, without limit.
        for now in (0..60_000).step_by(20) {
            clock.set(now);
            replica.tick();
            for call in replica.take_log_calls() {
                let LogRequest::Read(read) = &call.request else {
                    panic!("ordinary prefix read")
                };
                assert_eq!(read.after, replica.head().seq);
                reads += 1;
                replica.on_log_reply(
                    call.id,
                    Ok(LogResponse::Read(mdbn_wire::log_service::ReadResult {
                        items: vec![],
                        head: 100,
                        head_chain: B32([9; 32]),
                        retained_from: 1,
                        behind: false,
                        snapshot: None,
                        more: true,
                    })),
                );
                assert!(
                    replica.take_log_calls().is_empty(),
                    "{kind:?}: a reply cannot bypass the deadline"
                );
            }
        }
        // Probes at 1 s, 3 s, 7 s, 15 s and 31 s.
        assert_eq!(reads, 5, "{kind:?}");
        assert_eq!(replica.stalled, Some((kind, 4)));
        assert!(!replica.caught_up);
    }
}
