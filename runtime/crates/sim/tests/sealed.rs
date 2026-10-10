//! Real-sealer workload non-vacuity: establish acknowledgements before faults.

use mdbn_sim::scenario::{Opts, run_checked};

#[test]
fn sealed_chaos_has_confirmed_writes_before_faults() {
    // Previously these trajectories could exercise no acknowledged writes (or
    // no entries at all). Keep every oracle; strengthen the workload setup.
    for seed in [2, 16, 53, 137] {
        let r = run_checked("slice-sealed-chaos", seed, &Opts::default()).unwrap();
        assert!(r.clean(), "seed={seed}: {:?}", r.violations);
        assert!(r.counters["sealed.warm_confirmed"] > 0, "seed={seed}");
        assert!(r.counters["slice.confirmed"] > 0, "seed={seed}");
        assert!(r.counters["tap.path.item:entry"] > 0, "seed={seed}");
        assert!(r.counters["tap.path.stored:item:entry"] > 0, "seed={seed}");
    }
}
