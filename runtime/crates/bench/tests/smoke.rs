//! Every scenario runs end to end on a tiny corpus, so API drift in the
//! crates under test breaks CI here rather than the next baseline run.
#![allow(clippy::disallowed_methods, clippy::disallowed_types)]

use mdbn_bench::corpus::{Attachments, Spec};
use mdbn_bench::{bases, native, sync};

#[test]
fn all_scenarios_run_on_a_tiny_corpus() {
    let work = std::path::PathBuf::from(env!("CARGO_TARGET_TMPDIR"))
        .join(format!("perf-smoke-{}", std::process::id()));
    let mut out = Vec::new();
    let spec = Spec {
        attachments: Attachments::None,
        ..Spec::real(60)
    };
    let w = native::write(&spec, &work).unwrap();
    native::run(&w, 60, 2, 1, &mut out);
    sync::run(&spec, 2, &mut out);
    bases::run(10, 2, &mut out);
    let _ = std::fs::remove_dir_all(&work);
    for name in [
        "native.open_cold",
        "native.edit_visible",
        "native.backlinks_hub",
        "replica.edit_visible",
        "replica.join_snapshot",
        "bases.all_tasks",
    ] {
        let s = out.iter().find(|s| s.scenario == name).unwrap();
        assert!(!s.ms.is_empty(), "{name}: {}", s.note);
    }
}
