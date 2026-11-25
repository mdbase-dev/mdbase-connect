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

pub(super) const COL: B16 = B16([7; 16]);
pub(super) const DEV: B16 = B16([101; 16]);
pub(super) const SIGN: [u8; 32] = [0x31; 32];
pub(super) const KEM: [u8; 32] = [0x32; 32];
/// Items per read: a catch-up of a few dozen entries spans several pages.
pub(super) const PAGE: u64 = 16;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(super) struct Commits {
    /// Write batches committed and synced on their own.
    pub(super) alone: u64,
    /// Windows closed: one synced commit each.
    pub(super) windows: u64,
    /// Write batches held by a window.
    pub(super) in_window: u64,
}
impl Commits {
    /// Commits SQLite synced.
    pub(super) fn synced(self) -> u64 {
        self.alone + self.windows
    }
    pub(super) fn since(self, earlier: Self) -> Self {
        Self {
            alone: self.alone - earlier.alone,
            windows: self.windows - earlier.windows,
            in_window: self.in_window - earlier.in_window,
        }
    }
}

pub(super) struct Counted {
    pub(super) inner: SqliteIndex,
    /// Forward windows to the native index; otherwise decline them, as an
    /// index without deferred sync does.
    pub(super) windows: bool,
    pub(super) open: bool,
    pub(super) commits: Rc<Cell<Commits>>,
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
pub(super) struct Paged(pub(super) r::fake::FakeLog);
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

pub(super) fn open<S: r::store::Store>(store: S, replica: u8) -> Replica<S> {
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

/// A host session on `app`.
pub(super) fn host_session<S: r::store::Store>(app: &mut Replica<S>) -> r::api::SessionId {
    app.hello(
        SessionAuth::Host,
        HelloParams {
            versions: vec![Version { major: 1, minor: 0 }],
            client_name: "host".into(),
            client_version: "test".into(),
            features: None,
            timezone: Some("UTC".into()),
        },
    )
    .unwrap()
    .0
}

/// Create `note-<n>.md`.
pub(super) fn note(n: u16) -> SubmitParams {
    let mut id = [9u8; 16];
    id[..2].copy_from_slice(&n.to_be_bytes());
    let mut mutation = [8u8; 16];
    mutation[..2].copy_from_slice(&n.to_be_bytes());
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
    }
}

pub(super) fn settle<S: r::store::Store>(app: &mut Replica<S>, client: &mut dyn LogClient) {
    for _ in 0..40 {
        r::log::pump(app, client, 200);
        app.tick();
    }
}

/// A log holding `entries` created notes, written by another replica.
pub(super) fn written_log(dir: &std::path::Path, entries: u16) -> (r::fake::FakeLogService, u64) {
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
    let session = host_session(&mut writer);
    for n in 0..entries {
        writer.submit(session, note(n)).unwrap();
        settle(&mut writer, &mut client);
    }
    assert_eq!(writer.store().pending_count().unwrap(), 0);
    let head = writer.head().seq;
    assert_eq!(svc.head(&COL).0, head);
    (svc, head)
}

/// Drive `reader` over the log in pages until it is quiet. Returns the reads
/// that advanced it.
pub(super) fn read_pages<S: r::store::Store>(
    reader: &mut Replica<S>,
    svc: &r::fake::FakeLogService,
    index: &Rc<RefCell<Counted>>,
) -> u64 {
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
    reads
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
    let reads = read_pages(&mut reader, &svc, &index);
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
    a_page_of_entries_is_one_synced_commit("apply-window", catch_up);
}

/// `catch_up(name, entries, windows)` on two log sizes, with and without
/// windows: the relations the module docs state.
pub(super) fn a_page_of_entries_is_one_synced_commit(
    tag: &str,
    catch_up: impl Fn(&str, u16, bool) -> (u64, u64, Commits),
) {
    const SMALL: u16 = 40;
    const LARGE: u16 = 104;
    let added = u64::from(LARGE - SMALL);

    let (head, reads, before) = catch_up(&format!("{tag}-off-small"), SMALL, false);
    let (head_large, reads_large, before_large) =
        catch_up(&format!("{tag}-off-large"), LARGE, false);
    let (head_w, reads_w, after) = catch_up(&format!("{tag}-on-small"), SMALL, true);
    let (head_large_w, reads_large_w, after_large) =
        catch_up(&format!("{tag}-on-large"), LARGE, true);
    eprintln!(
        "{tag}: catching up {head} items in {reads} pages: {before:?} without a window, \
         {after:?} with"
    );
    eprintln!(
        "{tag}: catching up {head_large} items in {reads_large} pages: {before_large:?} \
         without a window, {after_large:?} with"
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

/// On the desktop (`FileStore` over SQLite), a sealed `grant_approval` can
/// share a deferred-durability window with a later attachment-delete entry.
/// When the delete's filesystem reconciliation (`attachment_remove`) fails to
/// close the window inside `FileStore`, the failed barrier must stay sticky so
/// `close_apply_window()` fences the replica instead of getting a false no-op
/// `Ok` and serving `hello` from the rolled-back in-memory grant approval.
#[test]
fn failed_internal_barrier_during_attachment_delete_fences_replica_and_refuses_rolled_back_grant() {
    struct FailCloseIndex {
        inner: Option<SqliteIndex>,
        db_dir: std::path::PathBuf,
        image_dir: std::path::PathBuf,
        fail_close: Rc<Cell<bool>>,
        failed_closes: Rc<Cell<u32>>,
    }
    impl FailCloseIndex {
        fn index(&mut self) -> Result<&mut SqliteIndex, IndexError> {
            self.inner
                .as_mut()
                .ok_or_else(|| IndexError::new(IndexErrorKind::Other, "index closed after failure"))
        }
    }
    impl IndexStorage for FailCloseIndex {
        fn info(&self) -> IndexInfo {
            self.inner
                .as_ref()
                .map(IndexStorage::info)
                .unwrap_or(IndexInfo {
                    durability: IndexDurability::Durable,
                    opened: mdbn_store_file::index::OpenState::Unclean,
                    sqlite_version: 3_045_000,
                })
        }
        fn run(&mut self, batch: &Batch) -> Result<Vec<StmtResult>, IndexError> {
            self.index()?.run(batch)
        }
        fn run_with_borrowed_blob(
            &mut self,
            batch: &Batch,
            blob: BorrowedBlob<'_>,
        ) -> Result<Vec<StmtResult>, IndexError> {
            self.index()?.run_with_borrowed_blob(batch, blob)
        }
        fn reset(&mut self) -> Result<(), IndexError> {
            self.index()?.reset()
        }
        fn defer_sync(&mut self, on: bool) -> Result<bool, IndexError> {
            if !on && self.fail_close.get() {
                self.failed_closes.set(self.failed_closes.get() + 1);
                // Snapshot the on-disk SQLite files BEFORE `SqliteIndex::drop`
                // runs its clean-close commit: models a failed COMMIT / crash
                // where the uncommitted window rolls back on disk.
                fs::create_dir_all(&self.image_dir).unwrap();
                for entry in fs::read_dir(&self.db_dir).unwrap() {
                    let entry = entry.unwrap();
                    fs::copy(entry.path(), self.image_dir.join(entry.file_name())).unwrap();
                }
                let _ = self.inner.take();
                return Err(IndexError::new(
                    IndexErrorKind::Other,
                    "injected sqlite barrier close failure",
                ));
            }
            self.index()?.defer_sync(on)
        }
    }

    struct MemSource(Vec<u8>);
    impl r::replica::AttachmentSource for MemSource {
        fn len(&self) -> u64 {
            self.0.len() as u64
        }
        fn read_at(&mut self, offset: u64, buf: &mut [u8]) -> Result<(), String> {
            let start = usize::try_from(offset).map_err(|_| "offset".to_string())?;
            let end = start + buf.len();
            if end > self.0.len() {
                return Err("eof".into());
            }
            buf.copy_from_slice(&self.0[start..end]);
            Ok(())
        }
    }

    let dir = scratch("failed-internal-barrier-grant-approval");
    let vault = dir.join("vault");
    let db_dir = dir.join("db");
    let image_dir = dir.join("image");
    fs::create_dir_all(&vault).unwrap();
    fs::create_dir_all(&db_dir).unwrap();
    let db_path = db_dir.join("reader.db");

    let svc = r::fake::FakeLogService::new();
    let mut cp = r::testkit::TestControlPlane::signed(COL);
    cp.genesis_with_keys(&svc, w::policy::CState::E2e, DEV, &SIGN, &KEM);
    let grant = B16([0x55; 16]);
    let client_pk = [0x66u8; 32];
    cp.append(
        &svc,
        vec![w::policy::PolicyOp::Grant(w::policy::Grant {
            grant,
            app_id: "app".into(),
            account: r::testkit::TEST_OWNER,
            capabilities: vec!["collection.read".into()],
            client_pk: w::common::B32(client_pk),
            file_folders: None,
            folder_scoped: None,
            installation: B16([0x56; 16]),
        })],
    );

    let mut writer = open(MemStore::new(), 1);
    let mut writer_log = svc.client(DEV);
    settle(&mut writer, &mut writer_log);
    let writer_session = host_session(&mut writer);

    // Upload an attachment-v1 file on writer and settle it onto the log.
    let file_id = B16([0x77; 16]);
    let file_path = "media/pic.bin";
    let payload = vec![0xab; 4096];
    let upload_m = writer
        .start_attachment_upload(
            r::replica::AttachmentUploadParams {
                file: file_id,
                path: file_path.into(),
                if_revision: None,
                mutation: None,
            },
            Box::new(MemSource(payload.clone())),
        )
        .unwrap();
    for _ in 0..80 {
        for call in writer.take_log_calls() {
            let reply = writer_log.call(call.request);
            writer.on_log_reply(call.id, reply);
        }
        writer.tick();
        if writer.head().seq == svc.head(&COL).0
            && matches!(
                writer.attachment_upload_status(&upload_m),
                Some(r::replica::AttachmentUploadStatus::Captured(_)) | None
            )
            && writer.store().file(&file_id).unwrap().is_some()
        {
            break;
        }
    }
    assert!(writer.store().file(&file_id).unwrap().is_some());

    // Open desktop reader (FileStore + SqlStore over real SQLite) and
    // materialize the attachment on disk.
    let fail_close = Rc::new(Cell::new(false));
    let failed_closes = Rc::new(Cell::new(0));
    let index = Rc::new(RefCell::new(FailCloseIndex {
        inner: Some(SqliteIndex::open(&db_path, IndexDurability::Durable).unwrap()),
        db_dir: db_dir.clone(),
        image_dir: image_dir.clone(),
        fail_close: fail_close.clone(),
        failed_closes: failed_closes.clone(),
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
    let mut reader_log = svc.client(DEV);
    settle(&mut reader, &mut reader_log);
    assert_eq!(fs::read(vault.join(file_path)).unwrap(), payload);
    let head_before = reader.head().seq;

    let hello = HelloParams {
        versions: vec![Version { major: 1, minor: 0 }],
        client_name: "app".into(),
        client_version: "0".into(),
        features: None,
        timezone: None,
    };
    assert!(
        reader
            .hello(SessionAuth::Grant { grant, client_pk }, hello.clone())
            .is_err(),
        "unapproved grant must be refused before approval"
    );

    // Writer now appends a sealed grant_approval AND an attachment-delete entry
    // while the desktop reader is not reading yet.
    writer
        .approve_grant(writer_session, grant, vec!["collection.read".into()], None)
        .unwrap();
    settle(&mut writer, &mut writer_log);
    writer
        .submit(
            writer_session,
            SubmitParams {
                ops: vec![Op::FileDelete(w::intent::FileDelete {
                    id: file_id,
                    if_revision: None,
                    base: None,
                })],
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
    settle(&mut writer, &mut writer_log);
    assert_eq!(svc.head(&COL).0, head_before + 2);

    // Arm the barrier-close failure and reconnect so the reader fetches both
    // new items in ONE Read page (sharing one deferred-durability window).
    let _ = reader_log.poll_pushes();
    reader.on_log_push(LogPush::Disconnected);
    reader.on_log_push(LogPush::Reconnected);
    fail_close.set(true);
    let mut delivered = false;
    for _ in 0..10 {
        for call in reader.take_log_calls() {
            let is_read = matches!(call.request, LogRequest::Read(_));
            let reply = reader_log.call(call.request);
            reader.on_log_reply(call.id, reply);
            if is_read {
                delivered = true;
            }
        }
        if delivered {
            break;
        }
        reader.tick();
    }
    assert!(delivered, "reader must have processed the read page");
    assert_eq!(
        failed_closes.get(),
        1,
        "attachment_remove's internal barrier must have triggered the failed close once"
    );
    assert!(
        reader.requires_reopen(),
        "failed internal barrier must fence the replica when close_apply_window runs"
    );
    assert_eq!(reader.fence(), Some(r::Fence::Store));
    let err = reader
        .hello(SessionAuth::Grant { grant, client_pk }, hello.clone())
        .unwrap_err();
    assert_eq!(
        err.problem().reason.as_deref(),
        Some("apply_reopen_required"),
        "fenced replica must never authorize hello from rolled-back grant approval"
    );
    assert_eq!(
        fs::read(vault.join(file_path)).unwrap(),
        payload,
        "failed barrier must prevent unlinking the attachment file"
    );

    // Reopen from the on-disk SQLite snapshot taken at the failed barrier:
    // the uncommitted window rolled back, so neither the grant approval nor
    // the delete landed.
    drop(reader);
    let reopened_index = Rc::new(RefCell::new(
        SqliteIndex::open(image_dir.join("reader.db"), IndexDurability::Durable).unwrap(),
    ));
    let reopened_store = FileStore::open(
        Rc::new(platform(&vault)),
        SqlStore::open(reopened_index.clone()).unwrap(),
        SqlDiskDb::open(reopened_index.clone()).unwrap(),
        Box::new(mdbn_core::host::FixedClock(1_700_000_000_000)),
        Config::default(),
    )
    .unwrap();
    let mut reopened = open(reopened_store, 2);
    assert_eq!(
        reopened.head().seq,
        head_before,
        "SQLite rolled back the uncommitted window"
    );
    assert!(
        reopened
            .hello(SessionAuth::Grant { grant, client_pk }, hello)
            .is_err(),
        "rolled-back grant approval must not be active after reopen"
    );
}
