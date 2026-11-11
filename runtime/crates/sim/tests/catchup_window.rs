//! Catch-up in deferred-durability windows ends where per-item commits do,
//! whatever point the process crashes at.

use std::collections::BTreeMap;

use mdbn_sim::oracle::{Kind, Violation};
use mdbn_sim::scenario::{Opts, run_checked, run_seed};
use mdbn_sim::world::Report;

/// The scenario runs the test-only `PlainSealer`, so the tap sees plaintext;
/// every other violation counts.
fn violations(report: &Report) -> Vec<&Violation> {
    report
        .violations
        .iter()
        .filter(|v| v.kind != Kind::Plaintext)
        .collect()
}

const SEEDS: [u64; 2] = [3, 11];

#[test]
fn catch_up_scenarios_are_registered() {
    for name in [
        "catchup-per-item",
        "catchup-window",
        "catchup-window-crash-1",
    ] {
        assert!(mdbn_sim::scenario::known(name), "CLI must recognize {name}");
    }
    assert!(!mdbn_sim::scenario::known("catchup-window-crash-0"));
}

/// One durable commit a page, not one an entry: the windows of the catch-up
/// are counted against its entries, and the run ends in the per-item state.
#[test]
fn a_windowed_catch_up_matches_per_item_commits() {
    for seed in SEEDS {
        let reference = run_checked("catchup-per-item", seed, &Opts::default()).unwrap();
        assert!(
            violations(&reference).is_empty(),
            "{:?}",
            violations(&reference)
        );
        assert_eq!(reference.counters["catchup.windows"], 0);
        assert!(
            !reference
                .counters
                .contains_key("catchup.points.window closed")
        );

        let window = run_checked("catchup-window", seed, &Opts::default()).unwrap();
        assert!(violations(&window).is_empty(), "{:?}", violations(&window));
        assert_eq!(window.state, reference.state, "seed {seed}");
        let items = window.counters["catchup.items"];
        let windows = window.counters["catchup.windows"];
        assert!(items >= 32, "several pages: {items} items");
        // One window per page read, split once by the control item, and one for
        // the device's own appended write.
        assert!(
            windows >= 4 && windows <= items / 8 + 3,
            "seed {seed}: {windows} windows for {items} items"
        );
        assert_eq!(
            window.counters["catchup.points.window closed"], windows,
            "every window crossed its barrier"
        );
    }
}

/// The crash matrix: the catch-up is crashed at each of its points in turn.
#[test]
fn a_crash_at_any_point_of_a_windowed_catch_up_ends_in_the_per_item_state() {
    for seed in SEEDS {
        let reference = run_seed("catchup-per-item", seed, &Opts::default()).unwrap();
        let window = run_seed("catchup-window", seed, &Opts::default()).unwrap();
        assert!(
            violations(&reference).is_empty(),
            "{:?}",
            violations(&reference)
        );
        assert!(violations(&window).is_empty(), "{:?}", violations(&window));
        let points = window.counters["catchup.points"];
        assert!(points > 100, "seed {seed}: only {points} crash points");

        let mut crashed_at: BTreeMap<String, u64> = BTreeMap::new();
        let mut in_window = 0;
        let mut windows_lost = 0;
        for point in 1..=points {
            let name = format!("catchup-window-crash-{point}");
            let run = run_seed(&name, seed, &Opts::default()).unwrap();
            let kind = run
                .counters
                .keys()
                .find_map(|k| k.strip_prefix("catchup.crashed_at."))
                .unwrap_or("nowhere")
                .to_string();
            assert!(
                violations(&run).is_empty(),
                "seed {seed}, crash at point {point} ({kind}): {:?}",
                violations(&run)
            );
            assert_eq!(run.counters["catchup.crashed"], 1, "{name}");
            assert_eq!(
                run.state, reference.state,
                "seed {seed}, crash at point {point} ({kind})"
            );
            *crashed_at.entry(kind).or_default() += 1;
            in_window += run.counters["catchup.crashed_in_window"];
            windows_lost += run.counters.get("sim.windows_lost").copied().unwrap_or(0);
        }
        eprintln!(
            "seed {seed}: {} items caught up in {} windows; crashed at each of {points} points \
             ({in_window} inside a window): {crashed_at:?}",
            window.counters["catchup.items"], window.counters["catchup.windows"],
        );
        // Every point of the uncrashed run was crashed at, by kind.
        for (key, n) in &window.counters {
            if let Some(kind) = key.strip_prefix("catchup.points.") {
                assert_eq!(crashed_at.get(kind), Some(n), "seed {seed}: {kind}");
            }
        }
        // Not vacuous: crashes inside windows, each losing the window's
        // commits, including one after a page's last entry is applied and
        // before its window closes.
        assert!(
            in_window > 20,
            "seed {seed}: {in_window} crashes in a window"
        );
        assert_eq!(windows_lost, in_window, "seed {seed}");
        assert!(crashed_at["window closing"] >= 4, "{crashed_at:?}");
        assert!(crashed_at["window closed"] >= 4, "{crashed_at:?}");
        assert!(crashed_at["folder write"] > 0, "{crashed_at:?}");
        assert!(crashed_at["outputs left"] > 0, "{crashed_at:?}");
    }
}
