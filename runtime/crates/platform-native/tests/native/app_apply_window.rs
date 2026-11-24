//! Catching up on the app-local store: what it commits, and what a process
//! killed during it reopens to.
//!
//! The browser composition is the replica over `TentativeStore`, whose index
//! holds a deferred-sync window as one outer SQLite transaction. Here the
//! same replica and store run on the native index, whose window is that
//! transaction on real SQLite. The browser's own index (`AppIndex`, which
//! this crate may not depend on) is tested in `mdbn-wasm` for the statements
//! it sends its host: one `BEGIN IMMEDIATE` and one `COMMIT` a window.
//!
//! **Counts.** The same relations as the desktop composition
//! (`apply_window.rs`): a page of entries is one synced commit instead of
//! one an entry, and every other commit is synced alone exactly as before.
//!
//! **Crashes.** A device with a write of its own still pending catches up
//! over several pages and then appends that write. The run is repeated with
//! the process killed at every write the catch-up makes and on both sides of
//! every window's commit. A kill is modelled as the database files exactly as
//! they are on disk at that instant, opened by a new process. Each reopened
//! store must hold an earlier head with the pending write intact, and must
//! end in the state of the run that was never killed: the same head, records
//! and log length, the device's own write confirmed once, nothing pending.
//!
//! **A fence inside a window.** A write refused before it reaches the
//! database fences the store with a window open. The window is still closed
//! on the index, so the connection is not left inside its transaction, and
//! the entries applied before the refusal are committed, as they were when
//! each was committed alone.
use super::apply_window::{
    COL, Commits, Counted, DEV, KEM, PAGE, Paged, SIGN, a_page_of_entries_is_one_synced_commit,
    host_session, note, open, read_pages, settle, written_log,
};
use super::*;
use mdbn_store_file::index::{BorrowedBlob, IndexError, IndexInfo, StmtResult};
use mdbn_store_file::testing::{replica as r, wire as w};
use mdbn_store_file::{SqlStoreLimits, TentativeStore};
use r::Replica;
use r::api::ClientApi;
use r::log::LogPort;
use r::store::Store;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

fn app_catch_up(name: &str, entries: u16, windows: bool) -> (u64, u64, Commits) {
    let dir = scratch(name);
    let (svc, head) = written_log(&dir, entries);
    let commits = Rc::new(Cell::new(Commits::default()));
    let index = Rc::new(RefCell::new(Counted {
        inner: SqliteIndex::open(dir.join("app.db"), IndexDurability::Durable).unwrap(),
        windows,
        open: false,
        commits: commits.clone(),
    }));
    let store = TentativeStore::open(index.clone(), SqlStoreLimits::MOBILE).unwrap();
    let mut reader = open(store, 2);
    assert_eq!(reader.head().seq, 0);
    let opened = commits.get();
    let reads = read_pages(&mut reader, &svc, &index);
    assert_eq!(reader.head().seq, head);
    assert!(!reader.requires_reopen());
    assert_eq!(reader.store().fenced(), None);
    assert!(!reader.store().durability_deferred());
    assert_eq!(
        reader.confirmed_records().unwrap().len(),
        usize::from(entries)
    );
    (head, reads, commits.get().since(opened))
}

#[test]
fn the_app_store_commits_a_caught_up_page_of_entries_once() {
    a_page_of_entries_is_one_synced_commit("app-apply-window", app_catch_up);
}

/// Where to kill the process, and what the run met.
#[derive(Default)]
struct Plan {
    armed: bool,
    /// Kill at this point (1-based).
    at: Option<u64>,
    seen: u64,
    kinds: BTreeMap<&'static str, u64>,
    /// The point's kind, once killed.
    killed: Option<&'static str>,
    /// Refuse the call at `at` instead, before it reaches the database, and
    /// carry on: an error the database did not cause.
    refuse: bool,
    refused: bool,
    /// A window was closed on the database after the refusal.
    closed_after_refusal: bool,
}

/// The native index, killed at one numbered point: the database files are
/// copied as they are on disk, and this handle then fails every call.
struct Killable {
    inner: SqliteIndex,
    /// The database's directory, and where its image goes.
    dir: PathBuf,
    image: PathBuf,
    plan: Rc<RefCell<Plan>>,
    open: bool,
}
impl Killable {
    fn dead() -> IndexError {
        IndexError::new(IndexErrorKind::Other, "process killed")
    }
    /// One point. True when the process dies here.
    fn point(&mut self, kind: &'static str) -> bool {
        let mut plan = self.plan.borrow_mut();
        if plan.killed.is_some() {
            return true;
        }
        if !plan.armed {
            return false;
        }
        plan.seen += 1;
        *plan.kinds.entry(kind).or_default() += 1;
        if plan.at != Some(plan.seen) {
            return false;
        }
        if plan.refuse {
            plan.refused = true;
            return true;
        }
        fs::create_dir_all(&self.image).unwrap();
        for entry in fs::read_dir(&self.dir).unwrap() {
            let entry = entry.unwrap();
            fs::copy(entry.path(), self.image.join(entry.file_name())).unwrap();
        }
        plan.killed = Some(kind);
        true
    }
    fn before(&mut self, batch: &Batch) -> Result<(), IndexError> {
        if self.plan.borrow().killed.is_some() {
            return Err(Self::dead());
        }
        let reads = batch.stmts.iter().all(|s| {
            let head = s.sql.trim_start().to_ascii_lowercase();
            head.starts_with("select") || head.starts_with("with")
        });
        let kind = if self.open {
            "write in a window"
        } else {
            "write"
        };
        if !reads && self.point(kind) {
            return Err(Self::dead());
        }
        Ok(())
    }
}
impl IndexStorage for Killable {
    fn info(&self) -> IndexInfo {
        self.inner.info()
    }
    fn run(&mut self, batch: &Batch) -> Result<Vec<StmtResult>, IndexError> {
        self.before(batch)?;
        self.inner.run(batch)
    }
    fn run_with_borrowed_blob(
        &mut self,
        batch: &Batch,
        blob: BorrowedBlob<'_>,
    ) -> Result<Vec<StmtResult>, IndexError> {
        self.before(batch)?;
        self.inner.run_with_borrowed_blob(batch, blob)
    }
    fn reset(&mut self) -> Result<(), IndexError> {
        self.inner.reset()
    }
    fn defer_sync(&mut self, on: bool) -> Result<bool, IndexError> {
        if self.plan.borrow().killed.is_some() {
            return Err(Self::dead());
        }
        if on || !self.open {
            self.open = self.inner.defer_sync(on)? && on;
            return Ok(true);
        }
        // Every entry of the page is applied; none is committed.
        if self.point("window closing") {
            return Err(Self::dead());
        }
        self.inner.defer_sync(false)?;
        self.open = false;
        let mut plan = self.plan.borrow_mut();
        plan.closed_after_refusal = plan.refused;
        drop(plan);
        // Committed, and the replica never learns.
        if self.point("window closed") {
            return Err(Self::dead());
        }
        Ok(true)
    }
}

type App = Replica<TentativeStore<Killable>>;

fn app(dir: &Path, image: &Path, plan: &Rc<RefCell<Plan>>) -> App {
    let index = Killable {
        inner: SqliteIndex::open(dir.join("app.db"), IndexDurability::Durable).unwrap(),
        dir: dir.to_path_buf(),
        image: image.to_path_buf(),
        plan: plan.clone(),
        open: false,
    };
    let store = TentativeStore::open(Rc::new(RefCell::new(index)), SqlStoreLimits::MOBILE).unwrap();
    open(store, 2)
}

/// What a run ended in.
#[derive(Debug, PartialEq, Eq)]
struct Outcome {
    head: u64,
    log_items: usize,
    records: Vec<(String, String)>,
    pending: u64,
}

/// The reader's own write, made while it is offline.
const MINE: u16 = 900;
/// Notes another replica writes meanwhile: three pages.
const ENTRIES: u16 = 40;

/// One run, killed at `at` (or, with `refuse`, refused there). Returns the
/// outcome, the plan (points seen, kind killed at) and the head the reopened
/// store held.
fn run(name: &str, at: Option<u64>, refuse: bool) -> (Outcome, Plan, Option<u64>) {
    let root = scratch(name);
    let (dir, image) = (root.join("db"), root.join("image"));
    fs::create_dir_all(&dir).unwrap();
    let svc = r::fake::FakeLogService::new();
    r::testkit::TestControlPlane::signed(COL).genesis_with_keys(
        &svc,
        w::policy::CState::E2e,
        DEV,
        &SIGN,
        &KEM,
    );
    let mut writer = open(MemStore::new(), 1);
    let mut writer_log = svc.client(DEV);
    settle(&mut writer, &mut writer_log);
    let writer_session = host_session(&mut writer);

    let plan = Rc::new(RefCell::new(Plan {
        at,
        refuse,
        ..Plan::default()
    }));
    let mut reader = app(&dir, &image, &plan);
    let mut reader_log = Paged(svc.client(DEV));
    settle(&mut reader, &mut reader_log);
    let session = host_session(&mut reader);
    // The reader writes and goes offline before the write is appended.
    reader.submit(session, note(MINE)).unwrap();
    assert_eq!(reader.sync_status().pending, 1);
    let behind = reader.head().seq;
    for n in 0..ENTRIES {
        writer.submit(writer_session, note(n)).unwrap();
        settle(&mut writer, &mut writer_log);
    }
    assert_eq!(svc.head(&COL).0, behind + u64::from(ENTRIES));

    // Back online: catch up, then append the pending write.
    plan.borrow_mut().armed = true;
    let mut before_call = behind;
    'run: for _ in 0..40 {
        for _ in 0..200 {
            let calls = reader.take_log_calls();
            if calls.is_empty() {
                break;
            }
            for call in calls {
                before_call = reader.head().seq;
                let reply = r::log::LogClient::call(&mut reader_log, call.request);
                reader.on_log_reply(call.id, reply);
                if plan.borrow().killed.is_some() || plan.borrow().refused {
                    break 'run;
                }
            }
        }
        reader.tick();
        if plan.borrow().killed.is_some() {
            break;
        }
    }
    plan.borrow_mut().armed = false;
    let killed = plan.borrow().killed;
    let mut reopened_at = None;
    if plan.borrow().refused {
        assert!(reader.requires_reopen(), "{name}");
        assert!(reader.store().fenced().is_some(), "{name}");
        assert!(!reader.store().durability_deferred(), "{name}");
        assert!(
            plan.borrow().closed_after_refusal,
            "{name}: the fenced store's window is closed on the database"
        );
        // The same database, opened again: the entries applied before the
        // refusal are there, each one whole.
        drop(reader);
        let unarmed = Rc::new(RefCell::new(Plan::default()));
        reader = app(&dir, &root.join("unused"), &unarmed);
        let head = reader.head().seq;
        reopened_at = Some(head);
        assert_eq!(
            head,
            before_call + at.unwrap() - 1,
            "{name}: the writes before the refused one"
        );
        assert_eq!(reader.sync_status().pending, 1, "{name}");
        settle(&mut reader, &mut reader_log);
    } else if let Some(kind) = killed {
        // The process is gone: whatever it had queued is never sent.
        drop(reader);
        let unarmed = Rc::new(RefCell::new(Plan::default()));
        reader = app(&image, &root.join("unused"), &unarmed);
        let head = reader.head().seq;
        reopened_at = Some(head);
        match kind {
            // Nothing of the window was committed: the page is applied again.
            "write in a window" | "window closing" => assert_eq!(
                head, before_call,
                "{name}: a window killed before its commit leaves the head it started from"
            ),
            // The whole page is there, or the commit the kill came before is not.
            _ => assert!(head >= before_call, "{name}: head {head} < {before_call}"),
        }
        // The reader's own write is still there to be sent, unless the kill
        // came after the commit that confirmed it.
        let pending = reader.sync_status().pending;
        assert!(
            pending == 1 || (pending == 0 && head == svc.head(&COL).0),
            "{name}: {pending} pending at head {head}"
        );
        settle(&mut reader, &mut reader_log);
    }
    assert!(!reader.requires_reopen(), "{name}");
    assert_eq!(reader.store().fenced(), None, "{name}");
    let mut records: Vec<(String, String)> = reader
        .confirmed_records()
        .unwrap()
        .into_iter()
        .map(|row| (row.path, row.doc))
        .collect();
    records.sort();
    let outcome = Outcome {
        head: reader.head().seq,
        log_items: svc.items(&COL).len(),
        records,
        pending: reader.sync_status().pending,
    };
    let plan = std::mem::take(&mut *plan.borrow_mut());
    (outcome, plan, reopened_at)
}

#[test]
fn the_app_store_killed_at_any_point_of_a_catch_up_ends_where_it_would_have() {
    let (reference, plan, _) = run("app-kill-none", None, false);
    assert_eq!(reference.pending, 0);
    assert_eq!(reference.head, reference.log_items as u64);
    assert_eq!(reference.records.len(), usize::from(ENTRIES) + 1);
    assert_eq!(
        reference
            .records
            .iter()
            .filter(|(path, _)| *path == format!("note-{MINE}.md"))
            .count(),
        1
    );
    // Three pages of entries, each one window; the pending write's append is
    // applied in a window of its own.
    assert!(u64::from(ENTRIES) > 2 * PAGE);
    assert!(plan.kinds["window closing"] >= 3, "{:?}", plan.kinds);
    assert_eq!(plan.kinds["window closing"], plan.kinds["window closed"]);
    assert!(
        plan.kinds["write in a window"] >= u64::from(ENTRIES),
        "{:?}",
        plan.kinds
    );

    let mut killed_at: BTreeMap<&'static str, u64> = BTreeMap::new();
    let mut rolled_back = 0;
    for point in 1..=plan.seen {
        let name = format!("app-kill-{point}");
        let (outcome, run, reopened_at) = self::run(&name, Some(point), false);
        let kind = run.killed.unwrap_or_else(|| panic!("{name}: not killed"));
        assert_eq!(outcome, reference, "{name} ({kind})");
        *killed_at.entry(kind).or_default() += 1;
        rolled_back += u64::from(reopened_at.is_some_and(|head| head < reference.head));
    }
    eprintln!(
        "app store: killed at each of {} points of a {}-entry catch-up: {killed_at:?}; \
         {rolled_back} reopened behind the log",
        plan.seen, ENTRIES
    );
    assert_eq!(
        killed_at, plan.kinds,
        "every point of the run was killed at"
    );
    assert!(rolled_back >= u64::from(ENTRIES));
}

#[test]
fn the_app_store_fenced_inside_a_window_still_closes_it() {
    let (reference, plan, _) = run("app-fence-none", None, false);
    // The fifth entry of the first page: four are applied in the window.
    let at = 5;
    assert!(PAGE > at && plan.kinds["write in a window"] > at);
    let (outcome, plan, reopened_at) = run("app-fence", Some(at), true);
    assert!(plan.refused && plan.killed.is_none());
    assert!(reopened_at.is_some_and(|head| head < reference.head));
    assert_eq!(outcome, reference);
}
