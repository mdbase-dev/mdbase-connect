//! Defensive origin refusal at the actual native settled apply boundary.
use super::*;

fn first_read_with_fault(h: &mut AppHosted, fault: u8) {
    for _ in 0..50 {
        h.e.tick(i64::try_from(h.clock.get()).unwrap());
        for call in h.e.take_log_calls() {
            let read = matches!(call.request, LogRequest::Read(_));
            let reply = h.log.call(call.request);
            if read {
                let store = h.e.replica().store().inner();
                match fault {
                    0 => store.fail_commits(1),
                    1 => store.fail_unknown_head_commit(1),
                    2 => store.fail_after_head_commit(1),
                    3 => store.fail_tail_stats(1, false),
                    4 => store.fail_tail_stats(1, true),
                    5 => store.fail_unknown_commits(1),
                    6 => store.fail_after_commit(1),
                    _ => unreachable!(),
                }
            }
            let _ = h.e.on_log_reply(call.id, reply);
            if read {
                return;
            }
        }
    }
    panic!("actual first native log read was not delivered");
}

#[test]
fn apply_abort_unknown_and_landed_read_fault_never_publish_original_observations() {
    let (svc, _, pins, peer) = fixture();
    for fault in 0..5 {
        let mut h = open(&svc);
        first_read_with_fault(&mut h, fault);
        assert!(
            h.e.replica().observed_original_genesis().is_none(),
            "fault{fault}"
        );
        assert!(
            h.e.replica()
                .observed_original_device(&HOSTED_DEV)
                .is_none(),
            "fault{fault}"
        );
        assert!(
            h.e.replica().observed_original_grant(&APP_GRANT).is_none(),
            "fault{fault}"
        );
        assert!(h.e.observe_native_target().is_err(), "fault{fault}");
        assert!(
            h.e.original_app_query(&peer, &declarations(&pins)).is_err(),
            "fault{fault}"
        );
        let landed = h.e.replica().store().head().unwrap().seq;
        assert_eq!(landed, if fault >= 2 { 1 } else { 0 }, "fault{fault}");
        // HostedCache downgrades an INNER CommitAborted to UNKNOWN: its RAM
        // keys/pending state were not a durably certified preceding state.
        assert!(h.e.replica().requires_reopen(), "fault{fault}");
        if fault >= 2 {
            assert!(
                h.e.replica()
                    .store()
                    .meta("replica.original_history_hints.v1")
                    .unwrap()
                    .is_some(),
                "landed hints are DATA only"
            );
        }
        h.pump(false);
        assert!(
            h.e.observe_native_target().is_err(),
            "unknown/fault instance stays fenced"
        );
    }
}

#[test]
fn pruned_complete_originals_refuse_even_when_native_full_and_hints_remain() {
    let (svc, _, pins, peer) = fixture();
    for tx in [
        Tx {
            tail_drop_below: Some(2),
            ..Default::default()
        },
        Tx {
            tail_drop_above: Some(1),
            ..Default::default()
        },
    ] {
        let mut h = open(&svc);
        h.pump(false);
        let before = h.e.observe_native_target().unwrap();
        h.e.replica_mut().store_mut().commit(tx).unwrap();
        assert!(
            matches!(h.e.admission(), mdbn_replica::HostedAdmission::Verified(_)),
            "FULL projection alone cannot substitute a complete original"
        );
        assert!(
            h.e.replica()
                .store()
                .meta("replica.original_history_hints.v1")
                .unwrap()
                .is_some()
        );
        assert!(h.e.observe_native_target().is_err());
        assert!(h.e.recheck_native_target(&before).is_err());
        assert!(h.e.original_app_query(&peer, &declarations(&pins)).is_err());
    }
}

#[test]
fn whole_control_void_retains_raw_row_without_minting_partial_grant_origin() {
    let (svc, mut cp, pins, peer) = fixture();
    let mut h = open(&svc);
    h.pump(false);
    let first = h.e.replica().observed_original_grant(&APP_GRANT).unwrap();
    let new_grant = B16([0x73; 16]);
    let make = |grant| {
        PolicyOp::Grant(Grant {
            grant,
            installation: pins.installation,
            app_id: "synthetic.app".into(),
            account: TEST_OWNER,
            capabilities: vec!["collection.read".into()],
            client_pk: peer.client_pk(),
            file_folders: None,
            folder_scoped: None,
        })
    };
    // First operation could succeed alone; second reuses an existing immutable
    // grant ID. Native whole-control atomic refusal must publish neither delta.
    let position = cp.append(&svc, vec![make(new_grant), make(APP_GRANT)]);
    h.pump(false);
    let retained = h.e.replica().store().tail(position - 1, 1).unwrap();
    assert_eq!(retained.len(), 1, "inventory includes semantic voids");
    assert_eq!(retained[0].seq, position);
    assert_eq!(h.e.replica().head().seq, position);
    assert!(!h.e.grant_authorized(&new_grant, &peer.client_pk().0));
    assert!(h.e.replica().observed_original_grant(&new_grant).is_none());
    assert_eq!(
        h.e.replica().observed_original_grant(&APP_GRANT),
        Some(first)
    );
    assert!(h.e.original_app_query(&peer, &declarations(&pins)).is_ok());
}

#[test]
fn warm_replay_hint_commit_or_read_fault_never_installs_a_candidate_observation() {
    let (svc, _, pins, peer) = fixture();
    for fault in [0, 3, 4, 5, 6] {
        let mut cold = open(&svc);
        cold.pump(false);
        let prior = cold.e.observe_native_target().unwrap();
        let store = cold.e.replica().store().inner().clone();
        let saved_head = store.head().unwrap();
        let clock = Rc::new(Cell::new(1_700_000_000_000));
        let host = Host {
            clock: Box::new(TestClock(clock.clone())),
            entropy: Box::new(mdbn_replica::crypto::TestEntropy::new(3)),
            zones: Box::new(UtcOnly),
        };
        let mut e = Engine::open(config(&svc), store, host, HostedProfile::default()).unwrap();
        assert!(e.bind_log(COL));
        let mut warm = AppHosted {
            e,
            log: svc.client(HOSTED_DEV),
            clock,
        };
        first_read_with_fault(&mut warm, fault);
        assert!(warm.e.replica().hosted_needs_reset(), "fault{fault}");
        assert!(
            warm.e.replica().observed_original_genesis().is_none(),
            "fault{fault}"
        );
        assert!(warm.e.observe_native_target().is_err(), "fault{fault}");
        assert!(
            warm.e.recheck_native_target(&prior).is_err(),
            "fault{fault}"
        );
        assert!(
            warm.e
                .original_app_query(&peer, &declarations(&pins))
                .is_err(),
            "fault{fault}"
        );
        assert_eq!(
            warm.e.replica().store().head().unwrap(),
            saved_head,
            "hint-only commit cannot advance head"
        );
        warm.pump(false);
        assert!(
            warm.e.observe_native_target().is_err(),
            "fault instance remains unavailable"
        );
    }
}
