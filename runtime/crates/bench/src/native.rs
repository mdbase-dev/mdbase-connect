//! Native local journey through the public `mdbase` library: the same
//! composition (`FileStore` + SQLite index + `NativePlatform`) as the daemon.
//!
//! Scenarios (all single-threaded, wall time):
//! - `native.open_cold`: open a folder with no index (scan, parse, index all,
//!   until a query reports a complete index);
//! - `native.open_warm`: reopen with the index on disk;
//! - `native.commit`: update one task field (publish to disk + index);
//! - `native.edit_visible`: commit, then re-run the open-tasks query;
//! - `native.query_tasks_open`: open tasks sorted by due, first 100;
//! - `native.query_tasks_all`: every task, sorted by due (a full TaskNotes list);
//! - `native.search_title`: records whose file name contains a word;
//! - `native.backlinks_hub` / `native.backlinks_random`: `links()` of the
//!   most-linked note / a random note;
//! - `native.external_edit_rescan`: append a line to a note on disk, rescan.

use std::path::{Path, PathBuf};

use mdbase::{Collection, Order, Query, Update};

use crate::corpus::{self, Rng, Spec};
use crate::measure::Sample;

/// Files of a written corpus.
pub struct Written {
    /// The corpus root.
    pub root: PathBuf,
    /// Relative paths of task notes.
    pub tasks: Vec<String>,
    /// Relative paths of every other note.
    pub notes: Vec<String>,
    /// The most-linked note (the first project).
    pub hub: String,
    /// Corpus statistics.
    pub stats: corpus::Stats,
}

/// Write `spec` under `dir`, replacing any earlier copy (scenarios edit the
/// corpus, so it is never reused).
pub fn write(spec: &Spec, dir: &Path) -> std::io::Result<Written> {
    let root = dir.join(format!(
        "{:?}-{:?}-{}-s{}",
        spec.profile, spec.attachments, spec.notes, spec.seed
    ));
    if root.exists() {
        std::fs::remove_dir_all(&root)?;
    }
    let mut tasks = Vec::new();
    let mut notes = Vec::new();
    let mut hub = None;
    let mut err = None;
    let stats = corpus::generate(spec, |rel, bytes| {
        if rel.ends_with(".md") && !rel.starts_with("_types/") {
            if rel.starts_with("TaskNotes/Tasks/") {
                tasks.push(rel.to_string());
            } else {
                if hub.is_none() && rel.starts_with("Projects/") {
                    hub = Some(rel.to_string());
                }
                notes.push(rel.to_string());
            }
        }
        if err.is_none() {
            let p = root.join(rel);
            let r = p
                .parent()
                .map_or(Ok(()), std::fs::create_dir_all)
                .and_then(|()| std::fs::write(&p, bytes));
            if let Err(e) = r {
                err = Some(e);
            }
        }
    });
    if let Some(e) = err {
        return Err(e);
    }
    Ok(Written {
        root,
        tasks,
        notes,
        hub: hub.unwrap_or_default(),
        stats,
    })
}

fn open_tasks() -> Query {
    Query::of_type("task")
        .filter("status != \"done\"")
        .order_by("due", Order::Asc)
        .limit(100)
}

fn open_complete(root: &Path) -> Collection {
    open_split(root).expect("open corpus").0
}

/// Open, then wait for a complete index. Returns the collection and the
/// milliseconds spent inside `Collection::open` (scan + initial rescan).
fn open_split(root: &Path) -> Result<(Collection, f64), String> {
    let t = std::time::Instant::now();
    let col = Collection::open(root).map_err(|e| e.to_string())?;
    let open_ms = t.elapsed().as_secs_f64() * 1e3;
    for _ in 0..10_000 {
        let page = col.query(open_tasks()).map_err(|e| e.to_string())?;
        if page.complete {
            return Ok((col, open_ms));
        }
        let _ = col.settle(50);
    }
    Err("index never completed".into())
}

/// Build the index by adding the corpus to an open collection in batches of
/// `batch` files (rename in + rescan), for corpora a cold open cannot index.
fn open_incremental(root: &Path, batch: usize) -> Result<Collection, String> {
    let staging = root.with_extension("staging");
    let _ = std::fs::remove_dir_all(&staging);
    std::fs::rename(root, &staging).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(root.join("_types")).map_err(|e| e.to_string())?;
    for f in ["mdbase.yaml", "_types/task.md"] {
        std::fs::rename(staging.join(f), root.join(f)).map_err(|e| e.to_string())?;
    }
    let _ = std::fs::remove_dir_all(staging.join(".mdbase"));
    let mut files = Vec::new();
    let mut stack = vec![staging.clone()];
    while let Some(d) = stack.pop() {
        for e in std::fs::read_dir(&d).map_err(|e| e.to_string())? {
            let p = e.map_err(|e| e.to_string())?.path();
            if p.is_dir() {
                stack.push(p);
            } else {
                files.push(p);
            }
        }
    }
    files.sort();
    let col = Collection::open(root).map_err(|e| e.to_string())?;
    for chunk in files.chunks(batch) {
        for f in chunk {
            let rel = f.strip_prefix(&staging).map_err(|e| e.to_string())?;
            let to = root.join(rel);
            if let Some(parent) = to.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            std::fs::rename(f, &to).map_err(|e| e.to_string())?;
        }
        col.rescan().map_err(|e| e.to_string())?;
    }
    for _ in 0..10_000 {
        if col.query(open_tasks()).map_err(|e| e.to_string())?.complete {
            let _ = std::fs::remove_dir_all(&staging);
            return Ok(col);
        }
        let _ = col.settle(50);
    }
    Err("index never completed".into())
}

/// Run the native scenarios over `w`, `iters` iterations each (cold opens
/// use `cold` iterations). Results are pushed to `out`.
pub fn run(w: &Written, size: u32, iters: usize, cold: usize, out: &mut Vec<Sample>) {
    let state = w.root.join(".mdbase");
    let mut s = Sample::new(
        "native.open_cold",
        size,
        "Collection::open with no .mdbase state until a query reports a complete index",
    );
    let mut inside = Vec::new();
    let mut failure = None;
    for _ in 0..cold {
        let _ = std::fs::remove_dir_all(&state);
        match s.time(|| open_split(&w.root)) {
            Ok((col, open_ms)) => {
                inside.push(open_ms);
                drop(col);
            }
            Err(e) => {
                failure = Some((s.ms.pop().unwrap_or(f64::NAN), e));
                break;
            }
        }
    }
    match &failure {
        None => s.note.push_str(&format!(
            "; Collection::open itself p50 {:.0} ms",
            crate::measure::percentile(&inside, 50.0)
        )),
        Some((ms, e)) => s.note = format!("FAILED after {ms:.0} ms: {e}"),
    }
    out.push(s);
    if failure.is_some() {
        // Index it the slow way so the steady-state scenarios still run.
        let _ = std::fs::remove_dir_all(&state);
        let mut s = Sample::new(
            "native.open_incremental",
            size,
            "fallback after a failed cold open: add the corpus in batches of 500 files (rename in + rescan)",
        );
        let col = s.time(|| open_incremental(&w.root, 500));
        if let Err(e) = &col {
            s.note = format!("FAILED: {e}");
            out.push(s);
            return;
        }
        drop(col);
        out.push(s);
    }

    let mut s = Sample::new("native.open_warm", size, "reopen with the index on disk");
    for _ in 0..cold.max(3) {
        let col = s.time(|| open_complete(&w.root));
        drop(col);
    }
    out.push(s);

    let col = open_complete(&w.root);
    let mut rng = Rng::new(42);
    let statuses = ["open", "in-progress", "done"];

    let mut s = Sample::new(
        "native.commit",
        size,
        "update one task's status (publish + index), no re-query",
    );
    for i in 0..iters {
        let path = &w.tasks[rng.below(w.tasks.len() as u64) as usize];
        s.time(|| {
            col.update(Update::at(path.as_str()).set("status", statuses[i % 3]))
                .expect("update")
        });
    }
    out.push(s);

    let mut s = Sample::new(
        "native.edit_visible",
        size,
        "update one task's status, then re-run the open-tasks query (limit 100)",
    );
    for i in 0..iters {
        let path = &w.tasks[rng.below(w.tasks.len() as u64) as usize];
        s.time(|| {
            col.update(Update::at(path.as_str()).set("priority", ["low", "high"][i % 2]))
                .expect("update");
            col.query(open_tasks()).expect("query")
        });
    }
    out.push(s);

    let mut s = Sample::new(
        "native.query_tasks_open",
        size,
        "type task, status != done, order by due, limit 100",
    );
    for _ in 0..iters {
        s.time(|| col.query(open_tasks()).expect("query"));
    }
    out.push(s);

    let mut s = Sample::new(
        "native.query_tasks_all",
        size,
        "every task ordered by due (what a full task list loads)",
    );
    let mut n = 0;
    for _ in 0..iters.min(10) {
        n = s
            .time(|| {
                col.query(Query::of_type("task").order_by("due", Order::Asc))
                    .expect("query")
            })
            .records
            .len();
    }
    s.note.push_str(&format!("; {n} rows"));
    out.push(s);

    let mut s = Sample::new(
        "native.search_title",
        size,
        "all records whose file name contains a word (CEL file.name.contains)",
    );
    let words = ["lantern", "orbit", "Willow", "café"];
    let mut rows = 0;
    let mut failed = None;
    for i in 0..iters {
        let q = Query::all().filter(format!("file.name.contains(\"{}\")", words[i % 4]));
        match s.time(|| col.query(q)) {
            Ok(p) => rows = p.records.len(),
            Err(e) => {
                failed = Some(e.to_string());
                break;
            }
        }
    }
    match failed {
        Some(e) => s.note = format!("unsupported: {e}"),
        None => s.note.push_str(&format!("; ~{rows} rows")),
    }
    out.push(s);

    let mut s = Sample::new(
        "native.backlinks_hub",
        size,
        "links() of the most-linked note",
    );
    let mut back = 0;
    for _ in 0..iters {
        back = s
            .time(|| col.links(w.hub.as_str()).expect("links"))
            .backlinks
            .len();
    }
    s.note.push_str(&format!("; {back} backlinks"));
    out.push(s);

    let mut s = Sample::new("native.backlinks_random", size, "links() of a random note");
    for _ in 0..iters {
        let p = &w.notes[rng.below(w.notes.len() as u64) as usize];
        s.time(|| col.links(p.as_str()).expect("links"));
    }
    out.push(s);

    let mut s = Sample::new(
        "native.external_edit_rescan",
        size,
        "append a line to a note on disk (outside the engine), then rescan",
    );
    for i in 0..iters {
        let p = w
            .root
            .join(&w.notes[rng.below(w.notes.len() as u64) as usize]);
        let mut text = std::fs::read_to_string(&p).unwrap_or_default();
        text.push_str(&format!("\nexternal edit {i}\n"));
        std::fs::write(&p, text).expect("write");
        s.time(|| col.rescan().expect("rescan"));
    }
    out.push(s);
    drop(col);
}
