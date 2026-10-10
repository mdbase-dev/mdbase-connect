//! Run the vendored spec fixtures against the core and enforce the ratchet.
//!
//! ```text
//! spec-conformance                 # check; exit 1 on any ratchet violation
//! spec-conformance --bless         # rewrite conformance/spec-expectations.txt
//! spec-conformance --bless --accept-regressions
//! spec-conformance --verbose       # list every case and outcome
//! ```
//!
//! Writes a Markdown summary to `$GITHUB_STEP_SUMMARY` when set.
#![allow(clippy::disallowed_methods, clippy::disallowed_types)]

use std::io::Write as _;
use std::process::ExitCode;

use mdbn_conformance::spec;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let has = |f: &str| args.iter().any(|a| a == f);
    if let Some(bad) = args
        .iter()
        .find(|a| !["--bless", "--accept-regressions", "--verbose"].contains(&a.as_str()))
    {
        eprintln!("unknown argument {bad}");
        return ExitCode::from(2);
    }
    let root = mdbn_conformance::repo_root();
    let run = match spec::run_repo(&root) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("error: {e}");
            return ExitCode::FAILURE;
        }
    };
    if has("--verbose") {
        for (case, status, outcome) in &run.results {
            println!("{:<55} {:<8} {:?}", case.id, format!("{status:?}"), outcome);
        }
    }
    if has("--bless") {
        return match spec::blessed(&run, has("--accept-regressions")) {
            Ok(text) => match std::fs::write(root.join(spec::EXPECTATIONS), text) {
                Ok(()) => {
                    println!("wrote {}", spec::EXPECTATIONS);
                    ExitCode::SUCCESS
                }
                Err(e) => {
                    eprintln!("error: {e}");
                    ExitCode::FAILURE
                }
            },
            Err(e) => {
                eprintln!("error: {e}");
                ExitCode::FAILURE
            }
        };
    }
    let summary = spec::summary(&run);
    print!("{summary}");
    if let Some(path) = std::env::var_os("GITHUB_STEP_SUMMARY")
        && let Ok(mut f) = std::fs::OpenOptions::new()
            .append(true)
            .create(true)
            .open(path)
    {
        let _ = writeln!(f, "{summary}");
    }
    if run.violations.is_empty() {
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    }
}
