//! Named scenarios and the single-seed entry point.

use crate::oracle::Kind;
use crate::scenarios;
use crate::world::{Report, World};

/// Options for one run.
#[derive(Debug, Clone, Default)]
pub struct Opts {
    /// Keep trace lines in the report.
    pub keep_trace: bool,
}

/// Every scenario name, in the order a sweep runs them.
pub const NAMES: &[&str] = &[
    "journal",
    "journal-unsafe",
    // Day 1 vertical slice: real replica engine + file store + log service.
    "slice",
    "slice-chaos",
    "slice-chaos-storm",
    // The same slice over the real log service and the exact-frame network.
    "slice-real",
    "slice-real-chaos",
    "slice-real-snapshots",
    "slice-real-snapshot-install",
    // The join-ahead keying order: B enrolled and granted after A's content.
    "slice-real-join-ahead",
    "slice-real-join-ahead-waiting",
    // Lost tail on the real service (expected RED until the repair runtime lands;
    // pinned by tests, not in the sweep).
    "slice-real-lost-tail",
    "slice-real-lost-tail-holder",
    "slice-real-lost-tail-fallback",
    "slice-real-lost-tail-probe-cut",
    "slice-real-lost-tail-compacted",
    "slice-real-lost-tail-unprovable",
    // Adversarial log service: lost-tail, fork and refusal scenarios.
    "slice-adv-dup",
    "slice-snapshot",
    "slice-adv-withhold",
    // Real KeyringSealer: one device, then restore onto a fresh store.
    "slice-sealed",
    "slice-sealed-chaos",
    // Control durability: public reply/tick retry followed by process reopen.
    "control-commit",
    "control-commit-fault",
    "control-commit-fault-crash",
    // Untrusted-party oracle self-tests: only tap-sealed is clean.
    "tap-sealed",
    "tap-plain",
    "tap-deflate",
    "tap-keyleak",
    "tap-silent",
    // The real mdbn-store-file publish + settle on the simulated OS models.
    "race-linux-R-mixed",
    "race-macos-R-mixed",
    "race-windows-R-mixed",
    "race-windows-R-mixed-overload",
    "race-fat32-R-libuv_trunc",
    "race-linux-R-mixed-overload",
    "race-macos-R-mixed-overload",
    // Known residual: macOS when proc_listpidspath cannot see the holder.
    "race-macoshidden-R-mixed-overload",
    // Obsidian: revert-on-save loses publishes; the editor fence prevents it.
    "race-linux-R-obsidian-fence",
    "race-macos-R-obsidian-fence",
    "race-windows-R-obsidian-fence",
    "race-linux-R-obsidian-fence-overload",
    "race-linux-R-obsidian",
    "race-windows-R-obsidian",
    // Reference publish protocols against every modelled editor save mode.
    "race-linux-PSE-mixed",
    "race-macos-PSE-mixed",
    "race-windows-D-mixed",
    "race-windows-D-mixed-overload",
    // Lease-checked retention protects displaced inodes against late editor writes.
    "race-linux-PSL-mixed",
    "race-linux-PSL-mixed-overload",
    // Known residuals: lose saves under overload today (tracked by tests).
    "race-linux-PSE-mixed-overload",
    "race-macos-PSE-mixed-overload",
    "race-linux-X-libuv_trunc-overload",
    // Unsafe strategies (negative controls; must lose).
    "race-linux-N-mixed",
    "race-linux-P-mixed-overload",
    "race-linux-PS-mixed-overload",
    "race-windows-N-mixed",
    "race-fat32-PS-libuv_trunc",
];

/// Pinned hold-rate ceilings for the sweep: holds left on replicas per 1,000
/// writes, in hundredths (`125` = 1.25 per 1k), by scenario. The sweep fails
/// when a scenario's measured rate is above its ceiling. A rising hold rate is
/// an engine bug: a ceiling goes DOWN when the engine improves
/// (ratchet) and goes up only with a reviewed reason. Scenarios absent here are
/// reported but not gated (no replica holds possible, or not yet measured).
///
/// Measured 2026-10-06 on main 7115b748 over seeds 1..1000: zero holds in every
/// sweep scenario, so every one is pinned at zero (any hold is a regression).
pub const HOLD_CEILINGS: &[(&str, u64)] = &[
    ("journal", 0),
    ("tap-sealed", 0),
    // Measured 2026-10-07 on main 77f8f1f9 over seeds 1..1000: zero holds.
    ("slice-real", 0),
    ("slice-real-snapshots", 0),
    // Join-ahead keying measured across seeds 1..1000: zero holds.
    ("slice-real-join-ahead", 0),
    ("slice-real-join-ahead-waiting", 0),
    ("race-linux-R-mixed", 0),
    ("race-macos-R-mixed", 0),
    ("race-windows-R-mixed", 0),
    ("race-windows-R-mixed-overload", 0),
    ("race-fat32-R-libuv_trunc", 0),
    ("race-linux-R-mixed-overload", 0),
    ("race-macos-R-mixed-overload", 0),
    ("race-linux-R-obsidian-fence", 0),
    ("race-macos-R-obsidian-fence", 0),
    ("race-windows-R-obsidian-fence", 0),
    ("race-linux-R-obsidian-fence-overload", 0),
    ("race-linux-PSE-mixed", 0),
    ("race-macos-PSE-mixed", 0),
    ("race-windows-D-mixed", 0),
    ("race-windows-D-mixed-overload", 0),
    ("race-linux-PSL-mixed", 0),
    ("race-linux-PSL-mixed-overload", 0),
    // Lost-tail repair scenarios with head movement and bounded recovery.
    ("slice-real-lost-tail", 0),
    ("slice-real-lost-tail-holder", 0),
    ("slice-real-lost-tail-fallback", 0),
    ("slice-real-lost-tail-probe-cut", 0),
    ("slice-real-lost-tail-compacted", 0),
];

/// The pinned ceiling for `name`, if it is gated.
pub fn hold_ceiling(name: &str) -> Option<u64> {
    HOLD_CEILINGS
        .iter()
        .find(|(n, _)| *n == name)
        .map(|(_, c)| *c)
}

/// Scenarios a CI sweep runs: everything that must be clean. Negative controls
/// and known residuals are excluded here and pinned by tests instead.
pub const SWEEP: &[&str] = &[
    "journal",
    "tap-sealed",
    "slice-real",
    "slice-real-snapshots",
    "slice-real-join-ahead",
    "slice-real-join-ahead-waiting",
    "slice-real-lost-tail",
    "slice-real-lost-tail-holder",
    "slice-real-lost-tail-fallback",
    "slice-real-lost-tail-probe-cut",
    "slice-real-lost-tail-compacted",
    "race-linux-R-mixed",
    "race-macos-R-mixed",
    "race-windows-R-mixed",
    "race-windows-R-mixed-overload",
    "race-fat32-R-libuv_trunc",
    "race-linux-R-mixed-overload",
    "race-macos-R-mixed-overload",
    "race-linux-R-obsidian-fence",
    "race-macos-R-obsidian-fence",
    "race-windows-R-obsidian-fence",
    "race-linux-R-obsidian-fence-overload",
    "race-linux-PSE-mixed",
    "race-macos-PSE-mixed",
    "race-windows-D-mixed",
    "race-windows-D-mixed-overload",
    "race-linux-PSL-mixed",
    "race-linux-PSL-mixed-overload",
];

/// Is `name` a scenario (listed, or a parseable parameterised name)?
pub fn known(name: &str) -> bool {
    NAMES.contains(&name)
        || scenarios::race::Race::parse(name).is_some()
        || scenarios::tapcheck::Variant::parse(name).is_some()
}

/// Run `name` for `seed`. `None` if the scenario is unknown.
pub fn run_seed(name: &str, seed: u64, opts: &Opts) -> Option<Report> {
    let mut w = World::new(seed, opts.keep_trace);
    let state = match name {
        "journal" => scenarios::journal::run(&mut w, true),
        "journal-unsafe" => scenarios::journal::run(&mut w, false),
        "slice" => scenarios::slice::run(&mut w, false, false),
        "slice-chaos" => scenarios::slice::run(&mut w, true, false),
        "slice-adv-dup" => scenarios::slice::run_false_duplicate(&mut w),
        "slice-snapshot" => scenarios::slice::run_snapshot(&mut w, scenarios::slice::Lie::Honest),
        "slice-adv-withhold" => {
            scenarios::slice::run_snapshot(&mut w, scenarios::slice::Lie::WithholdControl)
        }
        "slice-sealed" => scenarios::slice::run_sealed(&mut w, false),
        "slice-sealed-chaos" => scenarios::slice::run_sealed(&mut w, true),
        "slice-chaos-storm" => scenarios::slice::run(&mut w, true, true),
        "slice-real" => scenarios::slice_real::run(&mut w, false),
        "slice-real-chaos" => scenarios::slice_real::run(&mut w, true),
        "slice-real-snapshots" => scenarios::slice_real::run_snapshots(&mut w),
        "slice-real-snapshot-install" => scenarios::slice_real::run_snapshot_install(&mut w),
        "slice-real-join-ahead" => scenarios::slice_real::run_join_ahead(&mut w, false),
        "slice-real-join-ahead-waiting" => scenarios::slice_real::run_join_ahead(&mut w, true),
        "slice-real-lost-tail" => {
            scenarios::slice_real::run_lost_tail(&mut w, scenarios::slice_real::LostTail::Online)
        }
        "slice-real-lost-tail-holder" => scenarios::slice_real::run_lost_tail(
            &mut w,
            scenarios::slice_real::LostTail::AuthorCrash,
        ),
        "slice-real-lost-tail-probe-cut" => {
            scenarios::slice_real::run_lost_tail(&mut w, scenarios::slice_real::LostTail::ProbeCut)
        }
        "slice-real-lost-tail-compacted" => {
            scenarios::slice_real::run_lost_tail(&mut w, scenarios::slice_real::LostTail::Compacted)
        }
        "slice-real-lost-tail-unprovable" => scenarios::slice_real::run_lost_tail(
            &mut w,
            scenarios::slice_real::LostTail::Unprovable,
        ),
        "slice-real-lost-tail-fallback" => {
            scenarios::slice_real::run_lost_tail(&mut w, scenarios::slice_real::LostTail::Overwrite)
        }
        "control-commit" => scenarios::control_commit::run(&mut w, false, false),
        "control-commit-fault" => scenarios::control_commit::run(&mut w, true, false),
        "control-commit-fault-crash" => scenarios::control_commit::run(&mut w, true, true),
        n if n.starts_with("tap-") => {
            scenarios::tapcheck::run(&mut w, scenarios::tapcheck::Variant::parse(n)?)
        }
        n => scenarios::race::run(&mut w, &scenarios::race::Race::parse(n)?),
    };
    Some(w.report(name, state))
}

/// Run `name` for `seed` twice and add a violation if the runs differ.
pub fn run_checked(name: &str, seed: u64, opts: &Opts) -> Option<Report> {
    let mut a = run_seed(name, seed, opts)?;
    let b = run_seed(name, seed, &Opts::default())?;
    if a.digest != b.digest || a.state != b.state {
        a.violations.push(crate::oracle::Violation {
            kind: Kind::Nondeterminism,
            detail: format!(
                "digest {:016x} vs {:016x}, state {:?} vs {:?}",
                a.digest, b.digest, a.state, b.state
            ),
        });
    }
    Some(a)
}
