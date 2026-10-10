//! `mdbn-rehearse`: commands for
//! migration rehearsal.
//!
//! ```text
//! mdbn-rehearse generate <empty-dir> [small|hazards|10k|100k] [seed]
//! mdbn-rehearse check <ledger.jsonl> <final-folder> [--renames renames.jsonl] [kept-dir ...]
//! ```
//!
//! `generate` writes a synthetic, real-shaped collection. `check` runs the
//! oracle and exits 1 unless it has both evidence kinds and no losses. Malformed
//! ledger evidence exits 2. Output is counts and row identities, never content.
//! A green loss check does not prove migration/scenario/backend coverage.
#![allow(clippy::disallowed_methods, clippy::disallowed_types)]

use std::path::PathBuf;
use std::process::ExitCode;

use mdbn_migrate::rehearsal::{oracle, shape};

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("generate") if args.len() >= 2 => {
            let profile = match args.get(2).map(String::as_str).unwrap_or("small") {
                "small" => shape::Profile::SMALL,
                "10k" => shape::Profile::R10K,
                "100k" => shape::Profile::R100K,
                "hazards" => shape::Profile::HAZARDS,
                other => {
                    eprintln!("unknown profile {other}");
                    return ExitCode::from(2);
                }
            };
            let seed = args.get(3).and_then(|s| s.parse().ok()).unwrap_or(1);
            match shape::generate(&PathBuf::from(&args[1]), &profile, seed) {
                Ok(g) => {
                    println!(
                        "{{\"records\":{},\"record_bytes\":{},\"attachments\":{},\"attachment_bytes\":{}}}",
                        g.records, g.record_bytes, g.attachments, g.attachment_bytes
                    );
                    ExitCode::SUCCESS
                }
                Err(e) => {
                    eprintln!("{e}");
                    ExitCode::from(2)
                }
            }
        }
        Some("check") if args.len() >= 3 => {
            let mut rest = &args[3..];
            let mut renames = std::collections::BTreeMap::new();
            if rest.first().map(String::as_str) == Some("--renames") && rest.len() >= 2 {
                match oracle::read_renames(&PathBuf::from(&rest[1])) {
                    Ok(r) => renames = r,
                    Err(e) => {
                        eprintln!("{e}");
                        return ExitCode::from(2);
                    }
                }
                rest = &rest[2..];
            }
            let kept: Vec<PathBuf> = rest.iter().map(PathBuf::from).collect();
            match oracle::check_folder_renamed(
                &PathBuf::from(&args[1]),
                &PathBuf::from(&args[2]),
                &kept,
                renames,
            ) {
                Ok(v) => {
                    let green = v.green() && v.has_required_evidence();
                    println!(
                        "{{\"green\":{},\"evidence_complete\":{},\"acked\":{},\"must_survive\":{},\"not_acked\":{},\"violations\":{}}}",
                        green,
                        v.has_required_evidence(),
                        v.acked,
                        v.must_survive,
                        v.not_acked,
                        v.violations.len()
                    );
                    for x in &v.violations {
                        let (kind, r) = match x {
                            oracle::Violation::LostAck { row, .. } => ("lost_ack", row),
                            oracle::Violation::LostUserBytes { row } => ("lost_user_bytes", row),
                        };
                        println!(
                            "{}",
                            serde_json::json!({
                                "violation": kind,
                                "order": r.order,
                                "writer": r.writer,
                                "path": r.path,
                                "field": r.field,
                                "phase": r.phase,
                            })
                        );
                    }
                    if green {
                        ExitCode::SUCCESS
                    } else {
                        ExitCode::from(1)
                    }
                }
                Err(e) => {
                    eprintln!("{e}");
                    ExitCode::from(2)
                }
            }
        }
        _ => {
            eprintln!(
                "usage: mdbn-rehearse generate <dir> [small|hazards|10k|100k] [seed]\n       mdbn-rehearse check <ledger> <folder> [--renames file] [kept-dir ...]"
            );
            ExitCode::from(2)
        }
    }
}
