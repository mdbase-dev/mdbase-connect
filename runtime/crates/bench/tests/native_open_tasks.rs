//! The TaskNotes open-tasks list through the public library over perf's
//! real-shaped corpus: answered at 10k (and 50k, manual) notes, never refused by
//! the memory-constrained query budget (regression case: `too_large`).
//! Corpora live under `CARGO_TARGET_TMPDIR`, hence the std fs allowances.
#![allow(clippy::disallowed_methods, clippy::disallowed_types)]

use mdbase::{Collection, Order, Query};
use mdbn_bench::corpus::Spec;

fn open_tasks_answer(notes: u32) {
    let dir = std::path::Path::new(env!("CARGO_TARGET_TMPDIR")).join("native-open-tasks");
    std::fs::create_dir_all(&dir).unwrap();
    let written = mdbn_bench::native::write(&Spec::real(notes), &dir).unwrap();
    assert!(
        written.tasks.len() > 1000,
        "more tasks than the constrained budget"
    );
    let col = Collection::open(&written.root).unwrap();
    let query = || {
        Query::of_type("task")
            .filter("status != \"done\"")
            .order_by("due", Order::Asc)
            .limit(100)
    };
    let mut page = col
        .query(query())
        .expect("open tasks answered, not refused");
    for _ in 0..10_000 {
        if page.complete {
            break;
        }
        let _ = col.settle(50);
        page = col
            .query(query())
            .expect("open tasks answered, not refused");
    }
    assert!(page.complete);
    assert_eq!(page.records.len(), 100);
    let _ = std::fs::remove_dir_all(&written.root);
}

#[test]
fn open_tasks_at_10k_notes() {
    open_tasks_answer(10_000);
}

#[test]
#[ignore = "manual: 50k-note corpus (run with --release --ignored)"]
fn open_tasks_at_50k_notes() {
    open_tasks_answer(50_000);
}
