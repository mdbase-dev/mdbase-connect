//! `mdbn-sim`: seed sweeps, replay and trace tooling.
//!
//! ```text
//! mdbn-sim [--scenario NAME]... [--seeds N] [--first S] [--jobs J]
//!          [--determinism-every K] [--failures DIR] [--max-fail N] [--shard I/N]
//! mdbn-sim --scenario NAME --seed S [--trace] [--grep PAT]
//! mdbn-sim --list
//! ```
//!
//! - A sweep runs every scenario in the sweep set (or the ones named) for seeds
//!   `S..S+N`, in parallel, and exits non-zero on any violation. Every K-th seed
//!   (default 10) runs twice and must produce the same determinism digest.
//! - `--failures DIR` writes the full trace of each failing seed to
//!   `DIR/<scenario>-<seed>.log` (re-run with tracing on; the run is identical).
//! - `--shard I/N` runs only the seeds with `seed % N == I` (CI matrix jobs).
//! - Each sweep summary carries a `HOLDS` line: holds left on replicas per
//!   1,000 writes, by cause. A scenario above its pinned ceiling
//!   (`scenario::HOLD_CEILINGS`) fails the sweep: a rising hold rate is an
//!   engine bug.
//! - `--seed S` replays one seed. `--trace` prints its whole trace; `--grep PAT`
//!   prints the lines matching any `|`-separated pattern.
#![allow(clippy::disallowed_methods, clippy::disallowed_types)]

use std::collections::BTreeMap;
use std::process::ExitCode;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

use mdbn_sim::scenario::{NAMES, Opts, SWEEP, hold_ceiling, known, run_checked, run_seed};
use mdbn_sim::world::Report;

struct Args {
    scenarios: Vec<String>,
    seeds: u64,
    first: u64,
    jobs: usize,
    det_every: u64,
    failures: Option<String>,
    max_fail: u64,
    seed: Option<u64>,
    trace: bool,
    grep: Option<String>,
    /// Run only seeds with `seed % shards == shard`.
    shard: (u64, u64),
}

fn usage() -> ExitCode {
    eprintln!(
        "usage: mdbn-sim [--scenario NAME]... [--seeds N] [--first S] [--jobs J] \
         [--determinism-every K] [--failures DIR] [--max-fail N] [--shard I/N]\n       \
         mdbn-sim --scenario NAME --seed S [--trace] [--grep PAT]\n       mdbn-sim --list"
    );
    ExitCode::from(2)
}

fn parse() -> Result<Option<Args>, ()> {
    let mut a = Args {
        scenarios: Vec::new(),
        seeds: 100,
        first: 1,
        jobs: std::thread::available_parallelism().map_or(1, |n| n.get()),
        det_every: 10,
        failures: None,
        max_fail: 20,
        seed: None,
        trace: false,
        grep: None,
        shard: (0, 1),
    };
    let mut it = std::env::args().skip(1);
    while let Some(k) = it.next() {
        let mut val = || it.next().ok_or(());
        let num = |v: String| v.parse::<u64>().map_err(|_| ());
        match k.as_str() {
            "--list" => {
                for n in NAMES {
                    println!(
                        "{n}{}",
                        if SWEEP.contains(n) {
                            ""
                        } else {
                            " (not in sweep)"
                        }
                    );
                }
                return Ok(None);
            }
            "--scenario" => a.scenarios.push(val()?),
            "--seeds" => a.seeds = num(val()?)?,
            "--first" => a.first = num(val()?)?,
            "--jobs" => a.jobs = num(val()?)?.max(1) as usize,
            "--determinism-every" => a.det_every = num(val()?)?,
            "--failures" => a.failures = Some(val()?),
            "--max-fail" => a.max_fail = num(val()?)?,
            "--seed" => a.seed = Some(num(val()?)?),
            "--trace" => a.trace = true,
            "--grep" => a.grep = Some(val()?),
            "--shard" => {
                let v = val()?;
                let (i, n) = v.split_once('/').ok_or(())?;
                let (i, n) = (num(i.into())?, num(n.into())?);
                if n == 0 || i >= n {
                    return Err(());
                }
                a.shard = (i, n);
            }
            _ => return Err(()),
        }
    }
    if a.scenarios.is_empty() {
        a.scenarios = SWEEP.iter().map(|s| s.to_string()).collect();
    }
    for s in &a.scenarios {
        if !known(s) {
            eprintln!("unknown scenario {s}; --list shows them");
            return Err(());
        }
    }
    Ok(Some(a))
}

fn print_violations(r: &Report) {
    println!(
        "FAIL scenario={} seed={} digest={:016x} state={}",
        r.scenario, r.seed, r.digest, r.state
    );
    for v in r.violations.iter().take(8) {
        let d: String = v.detail.chars().take(4000).collect();
        println!("   {}: {}", v.kind, d);
    }
    if r.violations.len() > 8 {
        println!("   ... {} more", r.violations.len() - 8);
    }
    println!(
        "   replay: cargo run --release -p mdbn-sim -- --scenario {} --seed {} --trace",
        r.scenario, r.seed
    );
}

fn replay(a: &Args) -> ExitCode {
    let seed = a.seed.expect("seed");
    let mut code = ExitCode::SUCCESS;
    for s in &a.scenarios {
        let opts = Opts { keep_trace: true };
        let r = run_seed(s, seed, &opts).expect("known scenario");
        if a.trace {
            for l in &r.trace {
                println!("{l}");
            }
        }
        if let Some(p) = &a.grep {
            for l in r
                .trace
                .iter()
                .filter(|l| p.split('|').any(|x| !x.is_empty() && l.contains(x)))
            {
                println!("{l}");
            }
        }
        println!("counters: {:?}", r.counters);
        if r.clean() {
            println!(
                "ok scenario={s} seed={seed} digest={:016x} state={}",
                r.digest, r.state
            );
        } else {
            print_violations(&r);
            code = ExitCode::FAILURE;
        }
    }
    code
}

fn main() -> ExitCode {
    let a = match parse() {
        Ok(Some(a)) => a,
        Ok(None) => return ExitCode::SUCCESS,
        Err(()) => return usage(),
    };
    if a.seed.is_some() {
        return replay(&a);
    }
    let mut failed_total = 0u64;
    let mut regressions = 0u64;
    for scenario in &a.scenarios {
        let next = AtomicU64::new(a.first);
        let end = a.first + a.seeds;
        let failures: Mutex<Vec<Report>> = Mutex::new(Vec::new());
        let failed = AtomicU64::new(0);
        let totals: Mutex<BTreeMap<String, u64>> = Mutex::new(BTreeMap::new());
        let kinds: Mutex<BTreeMap<String, u64>> = Mutex::new(BTreeMap::new());
        std::thread::scope(|sc| {
            for _ in 0..a.jobs {
                sc.spawn(|| {
                    loop {
                        if failed.load(Ordering::Relaxed) >= a.max_fail {
                            break;
                        }
                        let seed = next.fetch_add(1, Ordering::Relaxed);
                        if seed >= end {
                            break;
                        }
                        if seed % a.shard.1 != a.shard.0 {
                            continue;
                        }
                        let opts = Opts::default();
                        let r = if a.det_every > 0 && seed.is_multiple_of(a.det_every) {
                            run_checked(scenario, seed, &opts)
                        } else {
                            run_seed(scenario, seed, &opts)
                        }
                        .expect("known scenario");
                        {
                            let mut t = totals.lock().unwrap();
                            for (k, v) in &r.counters {
                                *t.entry(k.clone()).or_default() += v;
                            }
                        }
                        if !r.clean() {
                            failed.fetch_add(1, Ordering::Relaxed);
                            let mut k = kinds.lock().unwrap();
                            for v in &r.violations {
                                *k.entry(v.kind.to_string()).or_default() += 1;
                            }
                            failures.lock().unwrap().push(r);
                        }
                    }
                });
            }
        });
        let mut failures = failures.into_inner().unwrap();
        failures.sort_by_key(|r| r.seed);
        for r in &failures {
            print_violations(r);
            if let Some(dir) = &a.failures {
                let _ = std::fs::create_dir_all(dir);
                let full = run_seed(scenario, r.seed, &Opts { keep_trace: true }).expect("known");
                let mut text = full.trace.join("\n");
                text.push('\n');
                for v in &full.violations {
                    text.push_str(&format!("VIOLATION {}: {}\n", v.kind, v.detail));
                }
                let _ = std::fs::write(format!("{dir}/{scenario}-{}.log", r.seed), text);
            }
        }
        let ran = ((a.first..next.load(Ordering::Relaxed).min(end))
            .filter(|s| s % a.shard.1 == a.shard.0)
            .count()) as u64;
        let nfail = failures.len() as u64;
        failed_total += nfail;
        let totals = totals.into_inner().unwrap();
        let kinds = kinds.into_inner().unwrap();
        println!(
            "SUMMARY {scenario}: {}/{ran} clean, seeds {}..{} shard {}/{}, violations {:?}",
            ran - nfail,
            a.first,
            a.first + a.seeds - 1,
            a.shard.0,
            a.shard.1,
            kinds
        );
        println!(
            "   counters: {}",
            totals
                .iter()
                .map(|(k, v)| format!("{k}={v}"))
                .collect::<Vec<_>>()
                .join(" ")
        );
        // Hold rate: holds left on replicas per 1,000 writes, by cause, against
        // the pinned ceiling (a rising hold rate is an engine bug).
        let holds = totals.get("hold.total").copied().unwrap_or(0);
        let writes = totals.get("writes.minted").copied().unwrap_or(0);
        let rate = hold_rate_centi(holds, writes);
        let by_cause: Vec<String> = totals
            .iter()
            .filter(|(k, _)| k.starts_with("hold.") && k.as_str() != "hold.total")
            .map(|(k, v)| format!("{}={v}", &k["hold.".len()..]))
            .collect();
        println!(
            "HOLDS {scenario}: {holds} holds / {writes} writes = {} per 1k writes{}",
            centi(rate),
            if by_cause.is_empty() {
                String::new()
            } else {
                format!(" ({})", by_cause.join(" "))
            }
        );
        if let Some(ceiling) = hold_ceiling(scenario)
            && rate > ceiling
        {
            println!(
                "HOLD RATE REGRESSION {scenario}: {} per 1k writes is above the pinned {} \
                 (mdbn_sim::scenario::HOLD_CEILINGS; a rising hold rate is an engine bug)",
                centi(rate),
                centi(ceiling)
            );
            regressions += 1;
        }
    }
    if failed_total == 0 && regressions == 0 {
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    }
}

/// Holds per 1,000 writes, in hundredths (exact integer arithmetic). Holds
/// without any write are infinite, never zero.
fn hold_rate_centi(holds: u64, writes: u64) -> u64 {
    if writes == 0 {
        return if holds == 0 { 0 } else { u64::MAX };
    }
    holds.saturating_mul(100_000).div_ceil(writes)
}

fn centi(x: u64) -> String {
    if x == u64::MAX {
        return "inf".into();
    }
    format!("{}.{:02}", x / 100, x % 100)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hold_rate_is_exact_rounds_up_and_never_hides_holds() {
        assert_eq!(hold_rate_centi(0, 0), 0);
        assert_eq!(hold_rate_centi(0, 1000), 0);
        assert_eq!(hold_rate_centi(1, 1000), 100);
        assert_eq!(hold_rate_centi(1, 3000), 34);
        assert_eq!(hold_rate_centi(3, 0), u64::MAX);
        assert_eq!(centi(125), "1.25");
        assert_eq!(centi(u64::MAX), "inf");
    }

    #[test]
    fn every_sweep_scenario_has_a_pinned_hold_ceiling() {
        for s in SWEEP {
            assert!(hold_ceiling(s).is_some(), "{s} is swept but not hold-gated");
        }
    }
}
