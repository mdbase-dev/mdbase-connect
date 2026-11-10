//! The performance runner.
//!
//! ```text
//! mdbn-perf run  [--sizes 1000,10000] [--iters 30] [--cold 3]
//!                [--only native,replica,bases] [--work target/perf] [--out report.json]
//! mdbn-perf gate --baseline tools/perf/baseline.json [--work target/perf] [--write]
//! ```
//!
//! `run` prints a table and writes a JSON report. `gate` runs the 1k and 10k
//! corpora. At 1k it divides each scenario's fastest iteration by a fixed
//! calibration workload (so a slower or faster runner cancels out) and fails
//! when that ratio exceeds the baseline's by more than the baseline's
//! `threshold` factor. Between 1k and 10k it measures each scenario's growth
//! (the log-log slope of its fastest iteration) and fails when that exceeds
//! the baseline's slope by more than half a complexity class. `--write`
//! rewrites the baseline from this run instead.
#![allow(clippy::disallowed_methods, clippy::disallowed_types)]

use std::collections::BTreeMap;
use std::path::PathBuf;

use mdbn_bench::corpus::{Attachments, Spec};
use mdbn_bench::measure::{self, Sample};
use mdbn_bench::{bases, native, sync};
use serde_json::json;

#[derive(Clone)]
struct Opts {
    sizes: Vec<u32>,
    iters: usize,
    cold: usize,
    only: Vec<String>,
    work: PathBuf,
    out: Option<PathBuf>,
    baseline: Option<PathBuf>,
    write: bool,
    attachments: Attachments,
}

fn parse(mut args: impl Iterator<Item = String>) -> Opts {
    let mut o = Opts {
        sizes: vec![1_000],
        iters: 30,
        cold: 3,
        only: vec!["native".into(), "replica".into(), "bases".into()],
        work: PathBuf::from("target/perf"),
        out: None,
        baseline: None,
        write: false,
        attachments: Attachments::Light,
    };
    while let Some(a) = args.next() {
        let mut val = || {
            args.next()
                .unwrap_or_else(|| usage(&format!("{a} needs a value")))
        };
        match a.as_str() {
            "--sizes" => {
                o.sizes = val()
                    .split(',')
                    .map(|s| s.parse().unwrap_or_else(|_| usage("bad --sizes")))
                    .collect()
            }
            "--iters" => o.iters = val().parse().unwrap_or_else(|_| usage("bad --iters")),
            "--cold" => o.cold = val().parse().unwrap_or_else(|_| usage("bad --cold")),
            "--only" => o.only = val().split(',').map(str::to_string).collect(),
            "--work" => o.work = PathBuf::from(val()),
            "--out" => o.out = Some(PathBuf::from(val())),
            "--baseline" => o.baseline = Some(PathBuf::from(val())),
            "--write" => o.write = true,
            "--attachments" => {
                o.attachments = match val().as_str() {
                    "none" => Attachments::None,
                    "light" => Attachments::Light,
                    "full" => Attachments::Full,
                    _ => usage("--attachments is none, light or full"),
                }
            }
            _ => usage(&format!("unknown argument {a}")),
        }
    }
    o
}

fn usage(msg: &str) -> ! {
    eprintln!(
        "mdbn-perf: {msg}\nusage: mdbn-perf run [--sizes N,..] [--iters N] [--cold N] [--only native,replica,bases] [--attachments none|light|full] [--work DIR] [--out FILE]\n       mdbn-perf gate --baseline FILE [--work DIR] [--write]"
    );
    std::process::exit(2)
}

fn print(samples: &[Sample]) {
    for s in samples {
        eprintln!(
            "  {:<32} {:>7} p50 {:>10.3} ms  p95 {:>10.3} ms  n={:<3} cv={:.2}  {}",
            s.scenario,
            s.size,
            s.pct(50.0),
            s.pct(95.0),
            s.ms.len(),
            s.cv(),
            s.note
        );
    }
}

/// The largest task count the Bases first slice executes.
const BASES_CEILING: u32 = 50;

fn run_all(o: &Opts) -> Vec<Sample> {
    let mut out = Vec::new();
    if o.only.iter().any(|s| s == "bases") && !o.sizes.contains(&BASES_CEILING) {
        // The first-slice executor refuses above ~50-75 tasks (1 MiB
        // allocation estimate), so also time it where it still runs.
        eprintln!("mdbn-perf: bases {BASES_CEILING}");
        let before = out.len();
        bases::run(BASES_CEILING, o.iters.min(20), &mut out);
        print(&out[before..]);
    }
    for &size in &o.sizes {
        if o.only.iter().any(|s| s == "native") {
            eprintln!("mdbn-perf: native {size} (load {:.2})", measure::loadavg());
            let spec = Spec {
                attachments: o.attachments,
                ..Spec::real(size)
            };
            let w = native::write(&spec, &o.work).expect("write corpus");
            let before = out.len();
            native::run(&w, size, o.iters, o.cold, &mut out);
            print(&out[before..]);
            let _ = std::fs::remove_dir_all(&w.root);
        }
        if o.only.iter().any(|s| s == "replica") {
            eprintln!("mdbn-perf: replica {size} (load {:.2})", measure::loadavg());
            let mut spec = Spec::real(size);
            spec.attachments = mdbn_bench::corpus::Attachments::None;
            let before = out.len();
            sync::run(&spec, o.iters, &mut out);
            print(&out[before..]);
        }
        if o.only.iter().any(|s| s == "bases") {
            eprintln!("mdbn-perf: bases {size} (load {:.2})", measure::loadavg());
            let before = out.len();
            bases::run(size, o.iters.min(20), &mut out);
            print(&out[before..]);
        }
    }
    out
}

fn main() {
    let mut args = std::env::args().skip(1);
    let cmd = args.next().unwrap_or_default();
    let o = parse(args);
    std::fs::create_dir_all(&o.work).expect("work dir");
    let cal = measure::calibrate();
    let meta = measure::meta(cal);
    match cmd.as_str() {
        "run" => {
            let samples = run_all(&o);
            let report = json!({
                "meta": meta,
                "loadavg_end": measure::loadavg(),
                "results": samples.iter().map(Sample::to_json).collect::<Vec<_>>(),
            });
            let text = serde_json::to_string_pretty(&report).expect("json");
            match &o.out {
                Some(p) => std::fs::write(p, text).expect("write report"),
                None => println!("{text}"),
            }
        }
        "gate" => gate(&o, cal, meta),
        _ => usage("command is run or gate"),
    }
}

/// The gate's corpus sizes. Ratios are checked at `SMALL`; growth compares
/// `SMALL` with `LARGE`.
const SMALL: u32 = 1_000;
const LARGE: u32 = 10_000;

/// A scenario fails growth when its slope exceeds the baseline's by more than
/// this: half a complexity class, ×√10 in time between 1k and 10k notes. A
/// whole class (flat to linear, linear to quadratic) is ×10.
const GROWTH_MARGIN: f64 = 0.5;

/// What one gate pass measures.
struct Gate {
    /// Fastest iteration at `SMALL` / calibration ms, per scenario.
    ratios: BTreeMap<String, f64>,
    /// Log-log slope of the fastest iteration from `SMALL` to `LARGE`:
    /// 0 flat, 1 linear, 2 quadratic.
    growth: BTreeMap<String, f64>,
}

impl Gate {
    /// The lower value of each scenario in `self` and `other`.
    fn lower(self, other: &Gate) -> Gate {
        let low = |a: BTreeMap<String, f64>, b: &BTreeMap<String, f64>| {
            a.into_iter()
                .map(|(k, v)| {
                    let w = b.get(&k).copied().unwrap_or(v);
                    (k, v.min(w))
                })
                .collect()
        };
        Gate {
            ratios: low(self.ratios, &other.ratios),
            growth: low(self.growth, &other.growth),
        }
    }
}

/// The fastest iteration per scenario. The minimum, not the median, so a
/// transient burst of other work on a shared machine or runner does not read
/// as a regression.
fn fastest(samples: &[Sample], min_iters: usize) -> BTreeMap<String, f64> {
    samples
        .iter()
        .filter(|s| s.ms.len() >= min_iters)
        .map(|s| (s.scenario.clone(), s.pct(0.0)))
        .collect()
}

fn round(x: f64, places: i32) -> f64 {
    let f = 10f64.powi(places);
    (x * f).round() / f
}

/// One gate pass: every area at `SMALL` (15 iterations, 3 cold opens), then
/// native and replica at `LARGE` (5 iterations, 1 cold open). Bases is not run
/// at `LARGE`: its executor refuses above ~50-75 tasks.
fn gate_run(o: &Opts, cal: f64) -> Gate {
    let small = fastest(
        &run_all(&Opts {
            sizes: vec![SMALL],
            iters: 15,
            cold: 3,
            ..o.clone()
        }),
        3,
    );
    let large = fastest(
        &run_all(&Opts {
            sizes: vec![LARGE],
            iters: 5,
            cold: 1,
            only: o.only.iter().filter(|a| *a != "bases").cloned().collect(),
            ..o.clone()
        }),
        1,
    );
    let steps = (f64::from(LARGE) / f64::from(SMALL)).ln();
    Gate {
        growth: large
            .iter()
            .filter_map(|(k, big)| {
                let small = small.get(k)?;
                Some((k.clone(), round((big / small).ln() / steps, 2)))
            })
            .collect(),
        ratios: small
            .into_iter()
            .map(|(k, ms)| (k, round(ms / cal, 4)))
            .collect(),
    }
}

/// The growth class nearest to `slope`, for the log.
fn class(slope: f64) -> &'static str {
    match slope {
        s if s < 0.5 => "flat",
        s if s < 1.5 => "linear",
        _ => "superlinear",
    }
}

#[derive(Clone, Copy, PartialEq)]
enum Kind {
    Ratio,
    Growth,
}

impl Kind {
    fn label(self) -> &'static str {
        match self {
            Kind::Ratio => "ratio",
            Kind::Growth => "growth",
        }
    }
}

/// One baseline check. `limit` is the largest passing value.
struct Check {
    kind: Kind,
    name: String,
    want: f64,
    limit: f64,
}

impl Check {
    fn got(&self, run: &Gate) -> Option<f64> {
        match self.kind {
            Kind::Ratio => run.ratios.get(&self.name),
            Kind::Growth => run.growth.get(&self.name),
        }
        .copied()
    }

    fn fails(&self, run: &Gate) -> bool {
        self.got(run).is_none_or(|got| got > self.limit)
    }

    fn label(&self) -> String {
        format!("{} {}", self.kind.label(), self.name)
    }
}

fn number_map(base: &serde_json::Value, key: &str) -> BTreeMap<String, f64> {
    base[key]
        .as_object()
        .into_iter()
        .flatten()
        .map(|(k, v)| (k.clone(), v.as_f64().expect("baseline numbers")))
        .collect()
}

fn gate(o: &Opts, cal: f64, meta: serde_json::Value) {
    let path = o
        .baseline
        .clone()
        .unwrap_or_else(|| usage("--baseline is required"));
    let run = gate_run(o, cal);
    if o.write {
        // Two runs, the lower value of each: a baseline must not absorb noise.
        let run = run.lower(&gate_run(o, measure::calibrate()));
        let base = json!({
            "about": format!("ratios: fastest iteration / calibration_ms per scenario at {SMALL} notes; a ratio fails above baseline x threshold. growth: log-log slope of the fastest iteration from {SMALL} to {LARGE} notes (0 flat, 1 linear, 2 quadratic); a slope fails above baseline + {GROWTH_MARGIN}. Either fails the gate only in two consecutive runs. Regenerate with `mdbn-perf gate --baseline tools/perf/baseline.json --write` on a quiet machine and say why in the PR."),
            "threshold": 2.5,
            "meta": meta,
            "ratios": run.ratios,
            "growth": run.growth,
        });
        std::fs::write(
            &path,
            serde_json::to_string_pretty(&base).expect("json") + "\n",
        )
        .expect("write baseline");
        eprintln!("mdbn-perf: wrote {}", path.display());
        return;
    }
    let base: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&path).expect("read baseline"))
            .expect("baseline json");
    let threshold = base["threshold"].as_f64().unwrap_or(2.5);
    // A scenario absent from the baseline is not checked; one in the baseline
    // but missing from the run fails.
    let ratios = number_map(&base, "ratios");
    let growth = number_map(&base, "growth");
    let checks: Vec<Check> = ratios
        .iter()
        .map(|(name, &want)| Check {
            kind: Kind::Ratio,
            name: name.clone(),
            want,
            limit: want * threshold,
        })
        .chain(growth.iter().map(|(name, &want)| Check {
            kind: Kind::Growth,
            name: name.clone(),
            want,
            limit: want + GROWTH_MARGIN,
        }))
        .collect();
    for c in &checks {
        let verdict = if c.fails(&run) { "FAIL" } else { "ok" };
        match c.got(&run) {
            Some(got) => eprintln!(
                "  {verdict:<4} {:<6} {:<32} {got:>10.4} baseline {:>10.4} limit {:>10.4}{}",
                c.kind.label(),
                c.name,
                c.want,
                c.limit,
                if c.kind == Kind::Growth {
                    format!(" ({})", class(got))
                } else {
                    String::new()
                }
            ),
            None => eprintln!(
                "  FAIL {:<6} {:<32} missing from this run",
                c.kind.label(),
                c.name
            ),
        }
    }
    for (name, got) in &run.growth {
        if !growth.contains_key(name) {
            eprintln!(
                "  --   growth {name:<32} {got:>10.4} ({}, no baseline)",
                class(*got)
            );
        }
    }
    let mut failed: Vec<&Check> = checks.iter().filter(|c| c.fails(&run)).collect();
    if !failed.is_empty() {
        // Confirm in a second run before failing: noise rarely repeats.
        let names: Vec<String> = failed.iter().map(|c| c.label()).collect();
        eprintln!("mdbn-perf gate: re-running to confirm {}", names.join(", "));
        let again = gate_run(o, measure::calibrate());
        failed.retain(|c| c.fails(&again));
    }
    if !failed.is_empty() {
        let names: Vec<String> = failed.iter().map(|c| c.label()).collect();
        eprintln!(
            "mdbn-perf gate: {} check(s) failed twice (ratio above x{threshold}, or growth above +{GROWTH_MARGIN}): {}",
            failed.len(),
            names.join(", ")
        );
        std::process::exit(1);
    }
    eprintln!("mdbn-perf gate: ok (calibration {cal:.1} ms)");
}
