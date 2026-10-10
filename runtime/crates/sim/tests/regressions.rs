//! Seeds that once found a bug. Each must stay free of the violations it showed.

use mdbn_sim::oracle::Kind;
use mdbn_sim::scenario::{Opts, run_seed};

fn assert_free_of(scenario: &str, seed: u64, kinds: &[Kind]) {
    let r = run_seed(scenario, seed, &Opts { keep_trace: false }).expect("known scenario");
    let bad: Vec<_> = r
        .violations
        .iter()
        .filter(|v| kinds.contains(&v.kind))
        .collect();
    assert!(bad.is_empty(), "{scenario} seed {seed}: {bad:?}");
}

/// A publish completed by crash recovery was recorded as known before its directory
/// flush; a later power loss brought the old bytes back and they were ingested as a
/// user edit, reverting a confirmed write.
#[test]
fn slice_chaos_storm_116_recovered_publish_is_durable() {
    assert_free_of(
        "slice-chaos-storm",
        116,
        &[Kind::LostEdit, Kind::LostAck, Kind::Divergence],
    );
}

/// Two appends in flight: a late reply confirmed the other batch.
#[test]
fn slice_chaos_storm_2_one_append_in_flight() {
    assert_free_of(
        "slice-chaos-storm",
        2,
        &[Kind::LostEdit, Kind::LostAck, Kind::Divergence],
    );
}
