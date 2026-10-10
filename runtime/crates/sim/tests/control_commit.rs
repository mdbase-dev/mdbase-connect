//! Public actor retry/reopen control durability regressions.

use mdbn_sim::scenario::{Opts, run_checked};

#[test]
fn sealed_and_temporal_scenario_names_remain_independently_registered() {
    for name in [
        "slice-sealed",
        "slice-sealed-chaos",
        "control-commit",
        "control-commit-fault",
        "control-commit-fault-crash",
    ] {
        assert!(mdbn_sim::scenario::known(name), "CLI must recognize {name}");
        assert_eq!(
            mdbn_sim::scenario::NAMES
                .iter()
                .filter(|n| **n == name)
                .count(),
            1,
            "each sealed/temporal scenario must retain its own list entry"
        );
    }
}

#[test]
fn honest_control_revocation_survives_reopen() {
    let r = run_checked("control-commit", 3, &Opts::default()).unwrap();
    assert!(r.violations.is_empty(), "{:?}", r.violations);
    assert_eq!(r.counters["control.commit_faults"], 0);
    assert_eq!(r.counters["control.reopened_victim_active"], 0);
}

#[test]
fn atomic_control_commit_failure_cannot_acknowledge_missing_revocation() {
    let r = run_checked("control-commit-fault", 3, &Opts::default()).unwrap();
    assert_eq!(r.counters["control.commit_faults"], 1);
    assert_eq!(
        r.counters["control.reopened_victim_active"], 0,
        "{:?}",
        r.violations
    );
    assert!(r.violations.is_empty(), "{:?}", r.violations);
}

#[test]
fn crash_after_retried_head_commit_cannot_revive_a_revoked_device() {
    let r = run_checked("control-commit-fault-crash", 3, &Opts::default()).unwrap();
    assert_eq!(r.counters["control.commit_faults"], 1);
    assert_eq!(
        r.counters["control.reopened_victim_active"], 0,
        "{:?}",
        r.violations
    );
    assert!(r.violations.is_empty(), "{:?}", r.violations);
}
