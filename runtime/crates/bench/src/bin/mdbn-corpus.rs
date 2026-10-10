//! Write a deterministic synthetic vault to disk.
//!
//! ```text
//! mdbn-corpus --notes 10000 [--profile real|tasks] [--attachments none|light|full]
//!             [--seed 1] --out <dir>
//! ```
//!
//! Prints the corpus statistics as JSON. The output folder must not exist or
//! must be empty, so a corpus is never mixed into real files.
#![allow(clippy::disallowed_methods, clippy::disallowed_types)]

use mdbn_bench::corpus::{Attachments, Profile, Spec, write_to};

fn main() {
    let mut spec = Spec::real(1_000);
    let mut out = None;
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        let mut val = || {
            args.next()
                .unwrap_or_else(|| usage(&format!("{a} needs a value")))
        };
        match a.as_str() {
            "--notes" => spec.notes = val().parse().unwrap_or_else(|_| usage("bad --notes")),
            "--seed" => spec.seed = val().parse().unwrap_or_else(|_| usage("bad --seed")),
            "--profile" => {
                spec.profile = match val().as_str() {
                    "real" => Profile::RealShaped,
                    "tasks" => Profile::Tasks,
                    _ => usage("--profile is real or tasks"),
                }
            }
            "--attachments" => {
                spec.attachments = match val().as_str() {
                    "none" => Attachments::None,
                    "light" => Attachments::Light,
                    "full" => Attachments::Full,
                    _ => usage("--attachments is none, light or full"),
                }
            }
            "--out" => out = Some(std::path::PathBuf::from(val())),
            _ => usage(&format!("unknown argument {a}")),
        }
    }
    let out = out.unwrap_or_else(|| usage("--out is required"));
    if out.exists()
        && std::fs::read_dir(&out)
            .map(|mut d| d.next().is_some())
            .unwrap_or(true)
    {
        usage("--out must not exist or be empty");
    }
    let t = std::time::Instant::now();
    let s = write_to(&spec, &out).unwrap_or_else(|e| {
        eprintln!("mdbn-corpus: {e}");
        std::process::exit(1)
    });
    println!(
        "{}",
        serde_json::json!({
            "spec": format!("{spec:?}"),
            "markdown_files": s.markdown_files,
            "markdown_bytes": s.markdown_bytes,
            "task_notes": s.task_notes,
            "links": s.links,
            "checkboxes": s.checkboxes,
            "attachment_files": s.attachment_files,
            "attachment_bytes": s.attachment_bytes,
            "folders": s.folders,
            "write_ms": t.elapsed().as_millis() as u64,
        })
    );
}

fn usage(msg: &str) -> ! {
    eprintln!(
        "mdbn-corpus: {msg}\nusage: mdbn-corpus --notes N [--profile real|tasks] [--attachments none|light|full] [--seed S] --out DIR"
    );
    std::process::exit(2)
}
