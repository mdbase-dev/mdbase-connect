//! Pinned adversarial oracle regressions. PlainSealer plaintext remains a real
//! violation; these tests prove attack detection, not release-gate acceptance.

use mdbn_sim::oracle::Kind;
use mdbn_sim::scenario::{Opts, run_checked};

#[test]
fn withheld_control_refuses_manifest_on_control_chain_mismatch() {
    let report =
        run_checked("slice-adv-withhold", 3, &Opts { keep_trace: false }).expect("known scenario");
    assert!(report.counters["snapshot.built"] > 0);
    assert!(report.counters["log.control_items"] >= 3);
    assert!(report.counters["adversary.withheld_reads"] > 0);
    assert_eq!(report.counters["snapshot.installed"], 0);
    assert_eq!(report.counters["snapshot.refused_control_chain"], 1);
    assert!(
        report.violations.iter().all(|v| v.kind == Kind::Plaintext),
        "unexpected violation: {:?}",
        report.violations
    );
}

#[test]
fn honest_snapshot_installs_and_converges() {
    let report =
        run_checked("slice-snapshot", 3, &Opts { keep_trace: false }).expect("known scenario");
    assert!(report.counters["snapshot.built"] > 0);
    assert!(report.counters["snapshot.installed"] > 0);
    assert!(
        report.violations.iter().all(|v| v.kind == Kind::Plaintext),
        "unexpected violation: {:?}",
        report.violations
    );
}
