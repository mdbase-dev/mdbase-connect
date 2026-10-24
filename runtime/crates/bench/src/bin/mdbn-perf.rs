//! The performance runner.
//!
//! ```text
//! mdbn-perf run  [--sizes 1000,10000] [--iters 30] [--cold 3]
//!                [--only native,replica,bases] [--work target/perf] [--out report.json]
//! mdbn-perf gate --baseline tools/perf/baseline.json [--work target/perf] [--write]
//! ```
//!
//! `run` prints a table and writes a JSON report. `gate` runs the 1k corpus,
//! divides each scenario's p50 by a fixed calibration workload (so a slower
//! or faster runner cancels out) and fails when a ratio exceeds the
//! baseline's by more than the baseline's `threshold` factor. `--write`
//! rewrites the baseline from this run instead.
#![allow(clippy::disallowed_methods, clippy::disallowed_types)]

use std::path::PathBuf;

use mdbn_bench::corpus::{Attachments, Spec};
use mdbn_bench::measure::{self, Sample};
use mdbn_bench::{bases, native, sync};
use serde_json::json;

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

/// Calibration-normalised minimum per scenario at 1k notes. The minimum, not
/// the median, so a transient burst of other work on a shared machine or
/// runner does not read as a regression.
fn gate_ratios(o: &Opts, cal: f64) -> serde_json::Map<String, serde_json::Value> {
    let gate_opts = Opts {
        sizes: vec![1_000],
        iters: 15,
        cold: 3,
        only: o.only.clone(),
        work: o.work.clone(),
        out: None,
        baseline: None,
        write: false,
        attachments: o.attachments,
    };
    run_all(&gate_opts)
        .iter()
        .filter(|s| s.ms.len() >= 3)
        .map(|s| {
            (
                s.scenario.clone(),
                json!((s.pct(0.0) / cal * 1e4).round() / 1e4),
            )
        })
        .collect()
}

fn gate(o: &Opts, cal: f64, meta: serde_json::Value) {
    let path = o
        .baseline
        .clone()
        .unwrap_or_else(|| usage("--baseline is required"));
    let ratios = gate_ratios(o, cal);
    if o.write {
        // Two runs, the lower ratio of each: a baseline must not absorb noise.
        let again = gate_ratios(o, measure::calibrate());
        let ratios: serde_json::Map<String, serde_json::Value> = ratios
            .into_iter()
            .map(|(k, v)| {
                let a = v.as_f64().unwrap_or(f64::INFINITY);
                let b = again
                    .get(&k)
                    .and_then(serde_json::Value::as_f64)
                    .unwrap_or(a);
                (k, json!(a.min(b)))
            })
            .collect();
        let base = json!({
            "about": "min iteration / calibration_ms per scenario at 1k notes (mdbn-perf gate). A scenario fails when its ratio exceeds baseline x threshold in two consecutive runs. Regenerate with `mdbn-perf gate --baseline tools/perf/baseline.json --write` on a quiet machine and say why in the PR.",
            "threshold": 2.5,
            "meta": meta,
            "ratios": ratios,
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
    let mut failed = Vec::new();
    for (name, want) in base["ratios"].as_object().expect("ratios") {
        let want = want.as_f64().unwrap_or(f64::INFINITY);
        match ratios.get(name).and_then(serde_json::Value::as_f64) {
            Some(got) => {
                let verdict = if got > want * threshold { "FAIL" } else { "ok" };
                eprintln!(
                    "  {verdict:<4} {name:<32} ratio {got:>10.4} baseline {want:>10.4} (x{:.2})",
                    got / want
                );
                if got > want * threshold {
                    failed.push(name.clone());
                }
            }
            None => {
                eprintln!("  FAIL {name:<32} missing from this run");
                failed.push(name.clone());
            }
        }
    }
    if !failed.is_empty() {
        // Confirm in a second run before failing: noise rarely repeats.
        eprintln!(
            "mdbn-perf gate: re-running to confirm {}",
            failed.join(", ")
        );
        let again = gate_ratios(o, measure::calibrate());
        failed.retain(|name| {
            let want = base["ratios"][name.as_str()]
                .as_f64()
                .unwrap_or(f64::INFINITY);
            again
                .get(name)
                .and_then(serde_json::Value::as_f64)
                .is_none_or(|got| got > want * threshold)
        });
    }
    if !failed.is_empty() {
        eprintln!(
            "mdbn-perf gate: {} scenario(s) regressed more than x{threshold}: {}",
            failed.len(),
            failed.join(", ")
        );
        std::process::exit(1);
    }
    eprintln!("mdbn-perf gate: ok (calibration {cal:.1} ms)");
}
