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
    trace: Vec<&'static str>,
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
        plan.trace.push(kind);
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

/// A compacted log with 20 control items (2 pages under `Paged`) and enough
/// record bytes to split the snapshot into multiple waves of 6 chunks.
fn compacted_snapshot_log(dir: &Path) -> (r::fake::FakeLogService, u64) {
    let svc = r::fake::FakeLogService::new();
    let mut cp = r::testkit::TestControlPlane::signed(COL);
    cp.genesis_with_keys(&svc, w::policy::CState::E2e, DEV, &SIGN, &KEM);
    for b in 1..=18u8 {
        cp.append(
            &svc,
            vec![w::policy::PolicyOp::DeviceEnrol(w::policy::DeviceEnrol {
                device: w::common::B16([b.wrapping_add(50); 16]),
                account: r::testkit::TEST_OWNER,
                kind: w::policy::DeviceKind::Desktop,
                sign_pk: w::common::B32([b; 32]),
                kem_pk: w::common::B32([b.wrapping_add(1); 32]),
                noise_pk: w::common::B32([b.wrapping_add(2); 32]),
                sas_commit: None,
                local_root: None,
            })],
        );
    }
    let store = mdbn_store_file::SqlStore::open(Rc::new(RefCell::new(
        SqliteIndex::open(dir.join("writer.db"), IndexDurability::Durable).unwrap(),
    )))
    .unwrap();
    let mut writer = open(store, 1);
    let mut client = svc.client(DEV);
    settle(&mut writer, &mut client);
    let session = host_session(&mut writer);
    let pad = "x".repeat(48 * 1024);
    for batch in 0..4u16 {
        let ops = (0..10u16)
            .map(|j| {
                let n = batch * 10 + j;
                let mut id = [9u8; 16];
                id[..2].copy_from_slice(&n.to_be_bytes());
                w::intent::Op::Create(w::intent::Create {
                    id: w::common::B16(id),
                    path: Some(format!("note-{n:03}.md")),
                    type_name: None,
                    frontmatter: None,
                    body: None,
                    document: Some(w::common::Text::Inline(format!("note {n}\n{pad}\n"))),
                })
            })
            .collect();
        writer
            .submit(
                session,
                w::client::SubmitParams {
                    ops,
                    mutation_id: None,
                    conflict_mode: None,
                    timezone: None,
                    allow_partial: None,
                    mutation_ids: None,
                    dry_run: None,
                    include: None,
                    wait: None,
                    validation: None,
                },
            )
            .unwrap();
        settle(&mut writer, &mut client);
    }
    writer.build_snapshot_now().unwrap();
    settle(&mut writer, &mut client);
    assert_eq!(writer.stats.snapshots_built, 1);
    let head = writer.head().seq;
    svc.compact(&COL, head);
    (svc, head)
}

#[test]
fn the_app_store_batches_snapshot_install_control_pages_and_chunk_waves() {
    let dir = scratch("app-snapshot-install-counts");
    let (svc, head) = compacted_snapshot_log(&dir);

    let install = |name: &str, windows: bool| -> (Commits, u64, u64) {
        let commits = Rc::new(Cell::new(Commits::default()));
        let index = Rc::new(RefCell::new(Counted {
            inner: SqliteIndex::open(dir.join(format!("{name}.db")), IndexDurability::Durable)
                .unwrap(),
            windows,
            open: false,
            commits: commits.clone(),
        }));
        let store = TentativeStore::open(index.clone(), SqlStoreLimits::MOBILE).unwrap();
        let mut reader = open(store, 2);
        let opened = commits.get();
        let mut client = Paged(svc.client(DEV));
        let mut control_pages = 0u64;
        let mut control_commits = 0u64;
        for _ in 0..40 {
            for _ in 0..200 {
                let calls = reader.take_log_calls();
                if calls.is_empty() {
                    break;
                }
                for call in calls {
                    let is_ctl = matches!(
                        call.request,
                        r::log::LogRequest::Read(ref p)
                            if p.kinds == Some(w::log_service::ReadKinds::Control)
                    );
                    let before = commits.get();
                    let reply = r::log::LogClient::call(&mut client, call.request);
                    reader.on_log_reply(call.id, reply);
                    assert!(
                        !index.borrow().open,
                        "no window outlives a snapshot-install reply"
                    );
                    if is_ctl {
                        control_pages += 1;
                        control_commits += commits.get().since(before).synced();
                    }
                }
            }
            reader.tick();
        }
        assert_eq!(reader.head().seq, head);
        assert_eq!(reader.stats.snapshots_installed, 1);
        assert_eq!(reader.confirmed_records().unwrap().len(), 40);
        assert!(reader.sync_status().incidents.is_empty());
        (commits.get().since(opened), control_pages, control_commits)
    };

    let (off, ctl_pages_off, ctl_commits_off) = install("off", false);
    let (on, ctl_pages_on, ctl_commits_on) = install("on", true);
    eprintln!(
        "app-snapshot-install: 20 control items in {ctl_pages_on} pages ({ctl_commits_on} commits); \
         {off:?} without chunk windows, {on:?} with"
    );
    assert_eq!(ctl_pages_off, 2);
    assert_eq!(ctl_pages_on, 2);
    // 20 control items over 2 pages = 2 synced commits total, not 20.
    assert_eq!(ctl_commits_off, 2);
    assert_eq!(ctl_commits_on, 2);
    // Multiple chunk waves each hold multiple chunk Stage::Put commits in one window.
    assert_eq!((off.windows, off.in_window), (0, 0));
    assert!(on.windows >= 2, "expected >= 2 chunk waves, got {on:?}");
    assert!(
        on.in_window > on.windows,
        "chunk waves must batch multiple Stage::Put writes per window: {on:?}"
    );
    assert_eq!(on.in_window, off.alone - on.alone);
    assert!(on.synced() < off.synced());
}

#[test]
fn snapshot_install_killed_during_chunk_staging_restarts_cleanly_on_sqlite() {
    let root = scratch("sqlite-snapshot-install-kill");
    let (svc, head) = compacted_snapshot_log(&root);

    let run_once = |tag: &str, at: Option<u64>, swap_point: Option<u64>| -> (Outcome, Plan) {
        let dir = root.join(format!("{tag}-db"));
        let image = root.join(format!("{tag}-img"));
        fs::create_dir_all(&dir).unwrap();
        let plan = Rc::new(RefCell::new(Plan {
            at,
            ..Plan::default()
        }));
        let open_sql = |path: &Path, p: &Rc<RefCell<Plan>>| {
            let index = Killable {
                inner: SqliteIndex::open(path.join("replica.db"), IndexDurability::Durable)
                    .unwrap(),
                dir: path.to_path_buf(),
                image: image.clone(),
                plan: p.clone(),
                open: false,
            };
            let store = mdbn_store_file::SqlStore::open(Rc::new(RefCell::new(index))).unwrap();
            open(store, 2)
        };

        let mut reader = open_sql(&dir, &plan);
        let mut client = Paged(svc.client(DEV));
        'install: for _ in 0..40 {
            for _ in 0..200 {
                let calls = reader.take_log_calls();
                if calls.is_empty() {
                    break;
                }
                let in_chunks = reader.install_status().is_some_and(|(_, total)| total > 0);
                if in_chunks {
                    plan.borrow_mut().armed = true;
                }
                for call in calls {
                    let reply = r::log::LogClient::call(&mut client, call.request);
                    reader.on_log_reply(call.id, reply);
                    if plan.borrow().killed.is_some() {
                        break 'install;
                    }
                }
                if in_chunks && reader.install_status().is_none() {
                    plan.borrow_mut().armed = false;
                }
            }
            reader.tick();
            if plan.borrow().killed.is_some() {
                break;
            }
        }
        plan.borrow_mut().armed = false;
        let mut expected_installed = 1;
        if let Some(kind) = plan.borrow().killed {
            drop(reader);
            let unarmed = Rc::new(RefCell::new(Plan::default()));
            reader = open_sql(&image, &unarmed);
            let point = at.unwrap();
            if point <= swap_point.unwrap() {
                // Killed during chunk staging (inside a wave window, at window
                // closing/closed, or right before Stage::Swap): confirmed state
                // is completely untouched and reopen re-installs cleanly.
                assert_eq!(
                    reader.head().seq,
                    0,
                    "{tag} ({kind}): confirmed head untouched before swap"
                );
                assert!(
                    reader.confirmed_records().unwrap().is_empty(),
                    "{tag} ({kind}): confirmed records untouched before swap"
                );
            } else {
                // Killed after Stage::Swap landed (during post-swap query-index
                // backfill): confirmed state is already at the snapshot head.
                assert_eq!(reader.head().seq, head, "{tag} ({kind}): post-swap head");
                expected_installed = 0;
            }
            settle(&mut reader, &mut client);
        }
        assert_eq!(reader.head().seq, head, "{tag}");
        assert_eq!(
            reader.stats.snapshots_installed, expected_installed,
            "{tag}"
        );
        assert!(reader.sync_status().incidents.is_empty(), "{tag}");
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
        (outcome, plan)
    };

    let (reference, plan) = run_once("ref", None, None);
    // First non-window write after chunk staging starts is `Stage::Swap`.
    let swap_point = plan
        .trace
        .iter()
        .position(|k| *k == "write")
        .map(|i| i as u64 + 1)
        .expect("Stage::Swap write point");
    let before_swap = &plan.trace[..(swap_point as usize - 1)];
    assert!(
        before_swap
            .iter()
            .filter(|k| **k == "write in a window")
            .count()
            >= 6,
        "expected >= 6 chunk staging writes before swap: {before_swap:?}"
    );
    assert!(
        before_swap
            .iter()
            .filter(|k| **k == "window closing")
            .count()
            >= 2,
        "expected >= 2 chunk staging windows before swap: {before_swap:?}"
    );
    assert_eq!(
        before_swap
            .iter()
            .filter(|k| **k == "window closing")
            .count(),
        before_swap
            .iter()
            .filter(|k| **k == "window closed")
            .count(),
    );
    for point in 1..=plan.seen {
        let (outcome, run) = run_once(&format!("kill-{point}"), Some(point), Some(swap_point));
        assert!(run.killed.is_some(), "point {point} must kill");
        assert_eq!(outcome, reference, "point {point} ({:?})", run.killed);
    }
}

#[test]
fn the_app_store_batches_control_items_in_one_window_and_survives_kill() {
    let root = scratch("app-control-apply-window");
    let svc = r::fake::FakeLogService::new();
    let mut cp = r::testkit::TestControlPlane::signed(COL);
    cp.genesis_with_keys(&svc, w::policy::CState::E2e, DEV, &SIGN, &KEM);
    for b in 1..=24u8 {
        cp.append(
            &svc,
            vec![w::policy::PolicyOp::DeviceEnrol(w::policy::DeviceEnrol {
                device: w::common::B16([b.wrapping_add(110); 16]),
                account: r::testkit::TEST_OWNER,
                kind: w::policy::DeviceKind::Desktop,
                sign_pk: w::common::B32([b; 32]),
                kem_pk: w::common::B32([b.wrapping_add(1); 32]),
                noise_pk: w::common::B32([b.wrapping_add(2); 32]),
                sas_commit: None,
                local_root: None,
            })],
        );
    }
    // Settle the initial writer once (e.g. initial rekey) so `reader` only catches up.
    let mut writer = open(MemStore::new(), 1);
    let mut writer_client = svc.client(DEV);
    settle(&mut writer, &mut writer_client);
    let head = svc.head(&COL).0;
    assert_eq!(head, 26);

    // Count synced commits on a full-page read of 26 control items: with
    // windows enabled, all 26 control items share ONE synced commit instead of 26.
    let count_run = |name: &str, windows: bool| -> Commits {
        let dir = root.join(name);
        fs::create_dir_all(&dir).unwrap();
        let commits = Rc::new(Cell::new(Commits::default()));
        let index = Rc::new(RefCell::new(Counted {
            inner: SqliteIndex::open(dir.join("app.db"), IndexDurability::Durable).unwrap(),
            windows,
            open: false,
            commits: commits.clone(),
        }));
        let store = TentativeStore::open(index.clone(), SqlStoreLimits::MOBILE).unwrap();
        let mut reader = open(store, 2);
        let opened = commits.get();
        let mut client = svc.client(DEV);
        settle(&mut reader, &mut client);
        assert_eq!(reader.head().seq, head);
        assert!(!reader.store().durability_deferred());
        commits.get().since(opened)
    };
    let off = count_run("off", false);
    let on = count_run("on", true);
    assert_eq!((off.windows, off.in_window), (0, 0));
    assert_eq!(
        on.windows, 1,
        "one page of control items = one window: {on:?}"
    );
    assert_eq!(
        on.in_window, head,
        "all {head} control items ran in the window: {on:?}"
    );
    assert_eq!(on.in_window, off.alone - on.alone);
    assert!(on.synced() + head - 1 == off.synced());

    // Kill at every write / window boundary of the control-item page and verify
    // reopening replays cleanly to the identical head and policy state.
    let kill_run = |tag: &str, at: Option<u64>| -> (u64, Plan) {
        let dir = root.join(format!("{tag}-db"));
        let image = root.join(format!("{tag}-img"));
        fs::create_dir_all(&dir).unwrap();
        let plan = Rc::new(RefCell::new(Plan {
            at,
            ..Plan::default()
        }));
        let mut reader = app(&dir, &image, &plan);
        let mut client = svc.client(DEV);
        plan.borrow_mut().armed = true;
        'run: for _ in 0..20 {
            for call in reader.take_log_calls() {
                let reply = r::log::LogClient::call(&mut client, call.request);
                reader.on_log_reply(call.id, reply);
                if plan.borrow().killed.is_some() {
                    break 'run;
                }
            }
            reader.tick();
        }
        plan.borrow_mut().armed = false;
        if let Some(kind) = plan.borrow().killed {
            drop(reader);
            let unarmed = Rc::new(RefCell::new(Plan::default()));
            reader = app(&image, &root.join("unused"), &unarmed);
            if matches!(kind, "write in a window" | "window closing") {
                assert_eq!(
                    reader.head().seq,
                    0,
                    "{tag} ({kind}): uncommitted control window must roll back to 0"
                );
            }
            settle(&mut reader, &mut client);
        }
        assert_eq!(reader.head().seq, head, "{tag}");
        assert_eq!(reader.sync_status().incidents, vec![], "{tag}");
        let p = std::mem::take(&mut *plan.borrow_mut());
        (reader.head().seq, p)
    };
    let (ref_head, ref_plan) = kill_run("ref", None);
    assert_eq!(ref_head, head);
    assert!(ref_plan.kinds["write in a window"] >= head);
    assert_eq!(ref_plan.kinds["window closing"], 1);
    for point in 1..=ref_plan.seen {
        let (h, run) = kill_run(&format!("kill-{point}"), Some(point));
        assert!(run.killed.is_some(), "point {point} must kill");
        assert_eq!(h, head, "point {point} ({:?})", run.killed);
    }
}
