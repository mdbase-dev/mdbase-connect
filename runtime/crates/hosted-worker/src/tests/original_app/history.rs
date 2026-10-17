//! Actual native semantic/key replay and exact-original lifecycle, no CPP/DO GO.
use super::*;
mod faults;
mod hint_data;
mod migration_creation;
mod migration_gen0;
mod migration_members;

#[test]
fn native_target_binds_complete_accepted_originals_and_refuses_changed_delivery() {
    let (svc, _, pins, peer) = fixture();
    let mut h = open(&svc);
    h.pump(false);
    let observed =
        h.e.observe_native_target()
            .expect("actual FULL target originals");
    assert_eq!(observed.genesis_owner(), TEST_OWNER);
    let originals = observed.originals();
    let rows = svc.items(&COL);
    assert_eq!(originals[0].0.position(), 1);
    assert_eq!(originals[0].1, rows[0]);
    assert_eq!(originals[1].0.position(), 1);
    assert_eq!(originals[1].1, rows[0]);
    assert_eq!(originals[2].0.position(), 2);
    assert_eq!(originals[2].1, rows[1]);
    assert_eq!(observed.admission().key_delivery_seq(), 2);
    assert!(h.e.recheck_native_target(&observed).is_ok());
    assert!(h.e.original_app_query(&peer, &declarations(&pins)).is_ok());
    assert!(
        h.e.replica()
            .store()
            .meta("replica.original_history_hints.v1")
            .unwrap()
            .is_some()
    );
    // No native semantics are re-evaluated here: changed bytes must NOT inherit
    // the earlier accepted original observation merely from their row position.
    let mut changed = rows[1].clone();
    *changed.last_mut().unwrap() ^= 1;
    h.e.replica_mut()
        .store_mut()
        .commit(Tx {
            tail_put: vec![TailRow {
                seq: 2,
                item: changed,
                applied_at: 0,
            }],
            ..Default::default()
        })
        .unwrap();
    assert!(h.e.observe_native_target().is_err());
    assert!(h.e.recheck_native_target(&observed).is_err());
    assert!(h.e.original_app_query(&peer, &declarations(&pins)).is_err());
}

#[test]
fn warm_hints_are_not_observations_but_actual_native_replay_can_reestablish_them() {
    let (svc, _, pins, peer) = fixture();
    let mut cold = open(&svc);
    cold.pump(false);
    let before = cold.e.observe_native_target().unwrap();
    let store = cold.e.replica().store().inner().clone();
    assert!(
        store
            .meta("replica.original_history_hints.v1")
            .unwrap()
            .is_some()
    );
    let clock = Rc::new(Cell::new(1_700_000_000_000));
    let host = Host {
        clock: Box::new(TestClock(clock.clone())),
        entropy: Box::new(mdbn_replica::crypto::TestEntropy::new(3)),
        zones: Box::new(UtcOnly),
    };
    let mut e = Engine::open(config(&svc), store, host, HostedProfile::default()).unwrap();
    assert!(e.replica().observed_original_genesis().is_none());
    assert!(e.replica().observed_original_grant(&APP_GRANT).is_none());
    assert!(e.observe_native_target().is_err());
    assert!(e.recheck_native_target(&before).is_err());
    assert!(e.bind_log(COL));
    let mut warm = AppHosted {
        e,
        log: svc.client(HOSTED_DEV),
        clock,
    };
    warm.pump(false);
    assert!(
        matches!(
            warm.e.admission(),
            mdbn_replica::HostedAdmission::Verified(_)
        ),
        "native warm admission: {:?}",
        warm.e.admission()
    );
    assert!(
        warm.e.replica().observed_original_genesis().is_some(),
        "warm genesis correlation absent"
    );
    assert!(
        warm.e
            .replica()
            .observed_original_device(&HOSTED_DEV)
            .is_some(),
        "warm enrollment correlation absent"
    );
    assert!(
        warm.e.replica().observed_original_key_delivery().is_some(),
        "warm current delivery correlation absent"
    );
    let after = warm
        .e
        .observe_native_target()
        .expect("actual complete native warm replay");
    assert_eq!(after.originals(), before.originals());
    assert_eq!(after.genesis_owner(), before.genesis_owner());
    assert_ne!(
        after.admission().wake_instance(),
        before.admission().wake_instance()
    );
    assert!(warm.e.recheck_native_target(&before).is_err());
    assert!(warm.e.recheck_native_target(&after).is_ok());
    assert!(
        warm.e
            .original_app_query(&peer, &declarations(&pins))
            .is_ok()
    );
    warm.e.retire_log();
    assert!(warm.e.recheck_native_target(&after).is_err());
}

#[test]
fn native_target_recheck_binds_actual_engine_even_when_all_public_native_points_equal() {
    let (svc, _, _, _) = fixture();
    let mut a = open(&svc);
    a.pump(false);
    let mut b = open(&svc);
    b.pump(false);
    // Deliberately identical TEST entropy/config/clock; an actual instance
    // identity must not collapse to the resulting equal native DATA tuple.
    let old = a.e.observe_native_target().unwrap();
    let other = b.e.observe_native_target().unwrap();
    assert_eq!(old.admission(), other.admission());
    assert_eq!(old.originals(), other.originals());
    assert!(a.e.recheck_native_target(&old).is_ok());
    assert!(b.e.recheck_native_target(&old).is_err());
    assert!(b.e.recheck_native_target(&other).is_ok());
}

#[test]
fn native_target_recheck_refuses_head_drift_while_fresh_full_target_stays_available() {
    let (svc, mut cp, _, _) = fixture();
    let mut h = open(&svc);
    h.pump(false);
    let old = h.e.observe_native_target().unwrap();
    cp.append(
        &svc,
        vec![PolicyOp::MemberSet(MemberSet {
            account: TEST_OWNER,
            role: Role::Owner,
        })],
    );
    h.pump(false);
    let current = h.e.observe_native_target().unwrap();
    assert_ne!(
        current.admission().applied_head(),
        old.admission().applied_head()
    );
    assert_eq!(current.originals(), old.originals());
    assert!(h.e.recheck_native_target(&old).is_err());
    assert!(h.e.recheck_native_target(&current).is_ok());
}
