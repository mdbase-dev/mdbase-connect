//! Ordinary signed device revocation while the surviving replicas keep writing.

use mdbn_sim::scenario::{Opts, run_checked};

#[test]
fn revocation_preserves_acknowledgements_and_rekeys_surviving_writers() {
    for seed in [1, 2, 7, 16, 33, 47] {
        let r = run_checked("slice-real-revocation", seed, &Opts::default()).unwrap();
        assert!(r.clean(), "seed={seed}: {:?}", r.violations);
        for counter in [
            "revocation.confirmed_before",
            "revocation.confirmed_after",
            "revocation.policy_seq",
            "revocation.rekeys",
            "revocation.new_epoch_entries",
            "tap.path.real:request",
            "tap.path.real:response",
            "tap.path.state",
        ] {
            assert!(r.counters[counter] > 0, "seed={seed}: {counter}");
        }
        assert_eq!(r.counters["revocation.survivors_applied"], 2, "seed={seed}");
        assert!(r.counters["real.B.admitted"] >= 2, "seed={seed}");
        for device in ["A", "B"] {
            for suffix in ["refused", "unmodeled_direct"] {
                assert_eq!(
                    r.counters
                        .get(&format!("real.{device}.{suffix}"))
                        .copied()
                        .unwrap_or(0),
                    0,
                    "seed={seed}: {device} {suffix}"
                );
            }
        }
    }
}
