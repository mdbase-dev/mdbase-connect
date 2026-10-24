//! The vertical slice over the real log service and the exact-frame network
//! (`slice-real-chaos`): these seeds were part of the first clean 50-seed sweep
//! and must stay clean, with the workload and the transport both non-vacuous.

use mdbn_sim::scenario::{Opts, run_checked};

#[test]
fn slice_real_chaos_stays_clean_with_real_faults_and_reauthentication() {
    for seed in [2, 16, 33, 47] {
        let r = run_checked("slice-real-chaos", seed, &Opts::default()).unwrap();
        assert!(r.clean(), "seed={seed}: {:?}", r.violations);
        assert!(r.counters["slice.confirmed"] > 0, "seed={seed}");
        assert!(r.counters["log.items"] > 0, "seed={seed}");
        // The real service saw exact frames and the devices re-authenticated.
        assert!(r.counters["tap.path.real:request"] > 0, "seed={seed}");
        assert!(r.counters["tap.path.state"] > 0, "seed={seed}");
        assert!(r.counters["real.admitted"] >= 2, "seed={seed}");
        assert_eq!(
            r.counters.get("real.A.refused").copied().unwrap_or(0),
            0,
            "seed={seed}"
        );
        assert_eq!(
            r.counters.get("real.B.refused").copied().unwrap_or(0),
            0,
            "seed={seed}"
        );
        assert_eq!(
            r.counters
                .get("real.A.unmodeled_direct")
                .copied()
                .unwrap_or(0),
            0
        );
        assert_eq!(
            r.counters
                .get("real.B.unmodeled_direct")
                .copied()
                .unwrap_or(0),
            0
        );
    }
}

#[test]
fn slice_real_calm_converges_and_restarts_b() {
    for seed in [1, 7, 19] {
        let r = run_checked("slice-real", seed, &Opts::default()).unwrap();
        assert!(r.clean(), "seed={seed}: {:?}", r.violations);
        assert!(r.counters["slice.confirmed"] > 0, "seed={seed}");
        // B's scripted restart means a second admission for B.
        assert!(
            r.counters["real.B.admitted"] >= 2,
            "seed={seed}: {:?}",
            r.counters
        );
    }
}

/// Snapshots over the real service: A builds them, their manifests and chunks
/// go up as objects without any direct transfer, and B joining late converges.
#[test]
fn slice_real_snapshots_go_up_as_objects_and_b_converges() {
    for seed in [1, 3] {
        let r = run_checked("slice-real-snapshots", seed, &Opts::default()).unwrap();
        assert!(r.clean(), "seed={seed}: {:?}", r.violations);
        assert!(r.counters["snapshot.built"] > 0, "seed={seed}");
        assert_eq!(
            r.counters
                .get("real.A.unmodeled_direct")
                .copied()
                .unwrap_or(0),
            0
        );
        assert_eq!(
            r.counters
                .get("real.B.unmodeled_direct")
                .copied()
                .unwrap_or(0),
            0
        );
        assert!(r.counters["slice.confirmed"] > 0, "seed={seed}");
    }
}

/// A device joining behind retention installs the snapshot over the real
/// service and converges.
#[test]
fn slice_real_snapshot_install_behind_retention() {
    for seed in [1, 3] {
        let r = run_checked("slice-real-snapshot-install", seed, &Opts::default()).unwrap();
        assert!(r.clean(), "seed={seed}: {:?}", r.violations);
        assert!(r.counters["snapshot.built"] > 0, "seed={seed}");
        assert!(r.counters["snapshot.installed"] > 0, "seed={seed}");
        assert!(r.counters["log.retained_from"] > 2, "seed={seed}");
    }
}

/// Lost tail on the real service, repaired by the runtime and the authenticated
/// prefix observer: every acknowledged write is back on every
/// device, the regression was reported, nothing leaks. Non-vacuous: each run
/// loses acknowledged writes. The probe-cut variant also proves that probes
/// without a reply were actually cut (calls failed as unknown) and re-issued.
#[test]
fn lost_tail_over_the_real_service_is_repaired() {
    for scenario in [
        "slice-real-lost-tail",
        "slice-real-lost-tail-holder",
        "slice-real-lost-tail-fallback",
        "slice-real-lost-tail-probe-cut",
        "slice-real-lost-tail-compacted",
    ] {
        for seed in [1, 2, 3] {
            let r = run_checked(scenario, seed, &Opts::default()).unwrap();
            assert!(
                r.counters["lost_tail.acked_lost"] > 0,
                "{scenario} seed={seed}: vacuous"
            );
            assert!(
                r.counters["lost_tail.regressed_incidents"] > 0,
                "{scenario} seed={seed}: no regression reported: {:?}",
                r.violations
            );
            if scenario.ends_with("probe-cut") {
                let unknown = r.counters.get("real.A.no_response").copied().unwrap_or(0)
                    + r.counters.get("real.B.no_response").copied().unwrap_or(0);
                assert!(unknown > 0, "{scenario} seed={seed}: no call was cut");
                assert!(
                    r.counters.get("hook.probe_cuts").copied().unwrap_or(0) == 2,
                    "{scenario} seed={seed}: both probes should have been cut"
                );
            }
            if scenario.ends_with("compacted") {
                assert!(
                    r.counters
                        .get("lost_tail.compacted_through")
                        .copied()
                        .unwrap_or(0)
                        > 0,
                    "{scenario} seed={seed}: nothing compacted"
                );
            }
            assert!(r.clean(), "{scenario} seed={seed}: {:?}", r.violations);
        }
    }
}

/// The service compacts through the shortened head right after the loss: the
/// interval a device must compare is gone, so the prefix is unprovable. The
/// runtime must park (fail closed) with a `lost_entries` incident on every
/// device: nothing is rolled back, nothing is relocated, nothing is appended,
/// and the only consequences are liveness ones (devices do not settle, heads
/// stay above the service's, queued writes never confirm). Non-vacuous: each
/// run loses acknowledged writes and the service really compacted.
#[test]
fn a_compacted_interval_parks_the_repair_with_an_incident() {
    use mdbn_sim::oracle::Kind;
    for seed in [1, 2] {
        let r = run_checked("slice-real-lost-tail-unprovable", seed, &Opts::default()).unwrap();
        let c = |k: &str| r.counters.get(k).copied().unwrap_or(0);
        assert!(c("lost_tail.acked_lost") > 0, "seed={seed}: vacuous");
        assert_eq!(c("lost_tail.regressed_incidents"), 2, "seed={seed}");
        assert_eq!(
            c("lost_tail.lost_entries_incidents"),
            2,
            "seed={seed}: both devices must report lost entries"
        );
        assert_eq!(c("slice.relocated"), 0, "seed={seed}: nothing relocated");
        assert_eq!(
            c("log.items"),
            0,
            "seed={seed}: nothing appended after the compaction"
        );
        let liveness_only = r.violations.iter().all(|v| {
            matches!(
                v.kind,
                Kind::NoQuiesce | Kind::Divergence | Kind::LostEdit | Kind::FileMismatch
            )
        });
        let kinds: std::collections::BTreeSet<String> =
            r.violations.iter().map(|v| v.kind.to_string()).collect();
        assert!(liveness_only, "seed={seed}: violation kinds {kinds:?}");
        assert!(!r.clean(), "seed={seed}: a parked repair cannot be clean");
    }
}

/// In this scenario, B is enrolled and granted a
/// key only after A's sealed entries; it reads control items ahead to its grant,
/// decrypts and converges, whether the grant is logged before B starts or while
/// it is already waiting.
#[test]
fn join_ahead_device_keyed_after_content_converges() {
    for name in ["slice-real-join-ahead", "slice-real-join-ahead-waiting"] {
        for seed in [1, 7, 23] {
            let r = run_checked(name, seed, &Opts::default()).unwrap();
            assert!(r.clean(), "{name} seed={seed}: {:?}", r.violations);
            assert!(r.counters["slice.confirmed"] > 0, "{name} seed={seed}");
        }
    }
    let r = run_checked("slice-real-join-ahead-waiting", 1, &Opts::default()).unwrap();
    assert_eq!(
        r.counters["join_ahead.waited"], 1,
        "B waited before its grant"
    );
}
