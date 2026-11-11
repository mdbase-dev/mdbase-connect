//! What catching up costs in durable commits, as counts.
//!
//! The shipped composition (replica over `FileStore`, `SqlStore` on real
//! SQLite with full durability, the real file system) catches up on a log
//! another replica wrote, read in pages. A commit SQLite syncs is either a
//! write batch run outside a deferred-sync window or the close of a window;
//! [`Counted`] counts both, and how many write batches a window held.
//!
//! The same catch-up runs twice: on an index that declines windows, where
//! every applied item is its own synced commit (how a caught-up item was
//! committed before the page window, and how a host without windows still
//! commits it), and on the native index as shipped. Measured here, pages of 16:
//!
//! | log | pages | synced commits, no window | synced commits, page window |
//! |---|---|---|---|
//! | 42 items (40 entries) | 3 | 92 | 55 (3 of them windows, holding 40 applies) |
//! | 106 items (104 entries) | 7 | 164 | 67 (7 of them windows, holding 104 applies) |
//!
//! The test asserts the relations, not the totals: the windows hold exactly
//! the commits that are no longer synced alone, one per added entry, and an
//! added page costs one synced commit.
use super::*;
use mdbn_store_file::index::{BorrowedBlob, IndexError, IndexInfo, StmtResult};
use mdbn_store_file::{
    SqlStore,
    testing::{replica as r, wire as w},
};
use r::api::{ClientApi, SessionAuth};
use r::log::{EndpointId, LogClient, LogPort, LogPush, LogReply, LogRequest};
use r::{DeviceSecrets, Host, Replica, ReplicaConfig, UtcOnly};
use w::client::{HelloParams, SubmitParams, SyncMode};
use w::common::{B16, Version};
use w::intent::{Create, Op};

const COL: B16 = B16([7; 16]);
const DEV: B16 = B16([101; 16]);
const SIGN: [u8; 32] = [0x31; 32];
const KEM: [u8; 32] = [0x32; 32];
/// Items per read: a catch-up of a few dozen entries spans several pages.
const PAGE: u64 = 16;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct Commits {
    /// Write batches committed and synced on their own.
    alone: u64,
    /// Windows closed: one synced commit each.
    windows: u64,
    /// Write batches held by a window.
    in_window: u64,
}
impl Commits {
    /// Commits SQLite synced.
    fn synced(self) -> u64 {
        self.alone + self.windows
    }
    fn since(self, earlier: Self) -> Self {
        Self {
            alone: self.alone - earlier.alone,
            windows: self.windows - earlier.windows,
            in_window: self.in_window - earlier.in_window,
        }
    }
}

struct Counted {
    inner: SqliteIndex,
    /// Forward windows to the native index; otherwise decline them, as an
    /// index without deferred sync does.
    windows: bool,
    open: bool,
    commits: Rc<Cell<Commits>>,
}
impl Counted {
    fn count(&mut self, batch: &Batch) {
        let reads = batch.stmts.iter().all(|s| {
            let head = s.sql.trim_start().to_ascii_lowercase();
            head.starts_with("select") || head.starts_with("with")
        });
        if reads {
            return;
        }
        let mut c = self.commits.get();
        if self.open {
            // The native index closes a window before a write outside a
            // savepoint; no catch-up statement is one.
            assert_eq!(batch.mode, BatchMode::Transaction);
            c.in_window += 1;
        } else {
            c.alone += 1;
        }
        self.commits.set(c);
    }
}
impl IndexStorage for Counted {
    fn info(&self) -> IndexInfo {
        self.inner.info()
    }
    fn run(&mut self, batch: &Batch) -> Result<Vec<StmtResult>, IndexError> {
        self.count(batch);
        self.inner.run(batch)
    }
    fn run_with_borrowed_blob(
        &mut self,
        batch: &Batch,
        blob: BorrowedBlob<'_>,
    ) -> Result<Vec<StmtResult>, IndexError> {
        self.count(batch);
        self.inner.run_with_borrowed_blob(batch, blob)
    }
    fn reset(&mut self) -> Result<(), IndexError> {
        self.inner.reset()
    }
    fn defer_sync(&mut self, on: bool) -> Result<bool, IndexError> {
        if !self.windows {
            return Ok(false);
        }
        let deferring = self.inner.defer_sync(on)?;
        assert!(deferring, "the durable native index defers");
        if self.open && !on {
            let mut c = self.commits.get();
            c.windows += 1;
            self.commits.set(c);
        }
        self.open = on;
        Ok(true)
    }
}

/// The fake log, serving at most [`PAGE`] items a read.
struct Paged(r::fake::FakeLog);
impl LogClient for Paged {
    fn call(&mut self, mut request: LogRequest) -> LogReply {
        if let LogRequest::Read(read) = &mut request {
            read.limit = read.limit.min(PAGE);
        }
        self.0.call(request)
    }
    fn poll_pushes(&mut self) -> Vec<LogPush> {
        self.0.poll_pushes()
    }
}

fn open<S: r::store::Store>(store: S, replica: u8) -> Replica<S> {
    Replica::open(
        ReplicaConfig {
            collection: COL,
            device_id: DEV,
            replica_id: B16([replica; 16]),
            mode: SyncMode::Synced,
            log_endpoint: EndpointId(1),
            verify: true,
            runtime_version: "apply-window-test".into(),
            trusted_roots: vec![r::testkit::signed_root()],
            trusted_signers: vec![],
            e2e: false,
            user_enabled_cloud_copy: false,
            chosen_state: None,
            expected_genesis: None,
            key_grants_only: false,
            policy_pins: None,
        },
        store,
        Box::new(r::plan::CorePlanner),
        Box::new(r::seal::KeyringSealer::new(COL, DEV, &SIGN, &KEM)),
        Host {
            clock: Box::new(mdbn_core::host::FixedClock(1_700_000_000_000)),
            entropy: Box::new(r::crypto::TestEntropy::new(replica)),
            zones: Box::new(UtcOnly),
        },
        DeviceSecrets {
            sign_sk: SIGN,
            kem_sk: KEM,
        },
    )
    .unwrap()
}

fn settle<S: r::store::Store>(app: &mut Replica<S>, client: &mut dyn LogClient) {
    for _ in 0..40 {
        r::log::pump(app, client, 200);
        app.tick();
    }
}

/// A log holding `entries` created notes, written by another replica.
fn written_log(dir: &std::path::Path, entries: u16) -> (r::fake::FakeLogService, u64) {
    let svc = r::fake::FakeLogService::new();
    r::testkit::TestControlPlane::signed(COL).genesis_with_keys(
        &svc,
        w::policy::CState::E2e,
        DEV,
        &SIGN,
        &KEM,
    );
    let store = SqlStore::open(Rc::new(RefCell::new(
        SqliteIndex::open(dir.join("writer.db"), IndexDurability::Durable).unwrap(),
    )))
    .unwrap();
    let mut writer = open(store, 1);
    let mut client = svc.client(DEV);
    settle(&mut writer, &mut client);
    let session = writer
        .hello(
            SessionAuth::Host,
            HelloParams {
                versions: vec![Version { major: 1, minor: 0 }],
                client_name: "writer".into(),
                client_version: "test".into(),
                features: None,
                timezone: Some("UTC".into()),
            },
        )
        .unwrap()
        .0;
    for n in 0..entries {
        let mut id = [9u8; 16];
        id[..2].copy_from_slice(&n.to_be_bytes());
        let mut mutation = [8u8; 16];
        mutation[..2].copy_from_slice(&n.to_be_bytes());
        writer
            .submit(
                session,
                SubmitParams {
                    ops: vec![Op::Create(Create {
                        id: B16(id),
                        path: Some(format!("note-{n}.md")),
                        type_name: None,
                        frontmatter: None,
                        body: None,
                        document: Some(w::common::Text::Inline(format!("note {n}\n"))),
                    })],
                    mutation_id: Some(B16(mutation)),
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
    assert_eq!(writer.store().pending_count().unwrap(), 0);
    let head = writer.head().seq;
    assert_eq!(svc.head(&COL).0, head);
    (svc, head)
}

/// Catch a fresh replica up on a log of `entries` notes. Returns the log's
/// length in items, the reads the catch-up took and what it committed.
fn catch_up(name: &str, entries: u16, windows: bool) -> (u64, u64, Commits) {
    let dir = scratch(name);
    let vault = dir.join("vault");
    fs::create_dir_all(&vault).unwrap();
    let (svc, head) = written_log(&dir, entries);
    let commits = Rc::new(Cell::new(Commits::default()));
    let index = Rc::new(RefCell::new(Counted {
        inner: SqliteIndex::open(dir.join("reader.db"), IndexDurability::Durable).unwrap(),
        windows,
        open: false,
        commits: commits.clone(),
    }));
    let store = FileStore::open(
        Rc::new(platform(&vault)),
        SqlStore::open(index.clone()).unwrap(),
        SqlDiskDb::open(index.clone()).unwrap(),
        Box::new(mdbn_core::host::FixedClock(1_700_000_000_000)),
        Config::default(),
    )
    .unwrap();
    let mut reader = open(store, 2);
    assert_eq!(reader.head().seq, 0);
    let opened = commits.get();
    let mut client = Paged(svc.client(DEV));
    let mut reads = 0u64;
    for _ in 0..40 {
        for _ in 0..200 {
            let calls = reader.take_log_calls();
            if calls.is_empty() {
                break;
            }
            for call in calls {
                let read = matches!(call.request, LogRequest::Read(_));
                let before = reader.head().seq;
                let reply = client.call(call.request);
                reader.on_log_reply(call.id, reply);
                reads += u64::from(read && reader.head().seq > before);
                assert!(
                    !index.borrow().open,
                    "no window outlives the call that applied a page"
                );
            }
        }
        reader.tick();
    }
    assert_eq!(reader.head().seq, head);
    assert!(!reader.requires_reopen());
    for n in 0..entries {
        assert_eq!(
            fs::read_to_string(vault.join(format!("note-{n}.md"))).unwrap(),
            format!("note {n}\n")
        );
    }
    (head, reads, commits.get().since(opened))
}

#[test]
fn a_caught_up_page_of_entries_is_one_synced_commit() {
    const SMALL: u16 = 40;
    const LARGE: u16 = 104;
    let added = u64::from(LARGE - SMALL);

    let (head, reads, before) = catch_up("apply-window-off-small", SMALL, false);
    let (head_large, reads_large, before_large) = catch_up("apply-window-off-large", LARGE, false);
    let (head_w, reads_w, after) = catch_up("apply-window-on-small", SMALL, true);
    let (head_large_w, reads_large_w, after_large) = catch_up("apply-window-on-large", LARGE, true);
    eprintln!(
        "catching up {head} items in {reads} pages: {before:?} without a window, {after:?} with"
    );
    eprintln!(
        "catching up {head_large} items in {reads_large} pages: {before_large:?} without a \
         window, {after_large:?} with"
    );

    // The same log, read in the same pages, either way.
    assert_eq!((head, reads), (head_w, reads_w));
    assert_eq!((head_large, reads_large), (head_large_w, reads_large_w));
    assert_eq!(head_large - head, added);
    assert_eq!(reads, head.div_ceil(PAGE));
    assert_eq!(reads_large, head_large.div_ceil(PAGE));
    let pages = reads_large - reads;
    assert_eq!(pages, added / PAGE);

    // An index that declines windows never holds a commit back.
    assert_eq!((before.windows, before.in_window), (0, 0));
    assert_eq!((before_large.windows, before_large.in_window), (0, 0));
    // The windows hold the applies and nothing else: every other commit is
    // synced alone, exactly as without them.
    assert_eq!(after.in_window, before.alone - after.alone);
    assert_eq!(
        after_large.in_window,
        before_large.alone - after_large.alone
    );
    // Each added entry's apply moved from a synced commit of its own into a
    // window; each added page of entries costs one synced commit.
    assert_eq!(after_large.in_window - after.in_window, added);
    assert_eq!(after_large.windows - after.windows, pages);
    assert_eq!(
        (before_large.synced() - before.synced()) - (after_large.synced() - after.synced()),
        added - pages
    );
}
