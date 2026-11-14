//! Removed attachment-class files reach the synced state while the collection
//! stays open (#1530): a real FileStore over this machine's file system, a
//! durable SQLite store and a synced replica, fed the watcher events the daemon
//! queues. Nothing reopens the store, and nothing asks for a full rescan.
use super::*;
use mdbn_store_file::platform::{FileEvent, FileEventKind};

/// A clock the test moves: the store's missing re-check and move window.
#[derive(Clone, Default)]
struct StepClock(Rc<Cell<u64>>);

impl Clock for StepClock {
    fn now_ms(&self) -> u64 {
        1_700_000_000_000 + self.0.get()
    }
}

type Disk = Replica<FileStore<NativePlatform, SqlStore<SqliteIndex>, SqlDiskDb<SqliteIndex>>>;

fn disk(dir: &std::path::Path, clock: &StepClock) -> Disk {
    let vault = dir.join("vault");
    fs::create_dir_all(&vault).unwrap();
    let index = Rc::new(RefCell::new(
        SqliteIndex::open(dir.join("vault.db"), IndexDurability::Durable).unwrap(),
    ));
    let store = FileStore::open(
        Rc::new(platform(&vault)),
        SqlStore::open(index.clone()).unwrap(),
        SqlDiskDb::open(index).unwrap(),
        Box::new(clock.clone()),
        Config::default(),
    )
    .unwrap();
    open_store(store, 1)
}

const A: &str = "_schemas/tasknotes/task.schema.json";
const B: &str = "_schemas/tasknotes/project.schema.json";

fn event(kind: FileEventKind, path: &str) -> FileEvent {
    FileEvent {
        kind,
        path: RelPath::new(path).unwrap(),
        id: None,
        cookie: None,
    }
}

/// Two attachment-class files (`.json` is not a record extension) under a
/// subfolder, uploaded and acknowledged.
fn synced_pair(tag: &str) -> (PathBuf, StepClock, r::fake::FakeLogService, Disk, [B16; 2]) {
    let dir = scratch(tag);
    let svc = r::fake::FakeLogService::new();
    r::testkit::TestControlPlane::signed(COL).genesis_with_keys(
        &svc,
        CState::E2e,
        DEV,
        &[0x31; 32],
        &[0x32; 32],
    );
    let clock = StepClock::default();
    let mut rep = disk(&dir, &clock);
    settle(&mut rep, &svc);
    let vault = dir.join("vault");
    fs::create_dir_all(vault.join("_schemas/tasknotes")).unwrap();
    fs::write(vault.join(A), br#"{"type":"object","title":"task"}"#).unwrap();
    fs::write(vault.join(B), br#"{"type":"object","title":"project"}"#).unwrap();
    rep.observe(None).unwrap();
    settle(&mut rep, &svc);
    let ids = [A, B].map(|p| {
        let id = rep
            .store()
            .file_at(&mdbn_core::paths::path_key(p))
            .unwrap()
            .unwrap_or_else(|| panic!("{p} synced: {:?}", rep.sync_status().incidents));
        assert!(
            rep.store().disk_revision(p).is_some(),
            "{p}: upload acknowledged"
        );
        id
    });
    (dir, clock, svc, rep, ids)
}

/// Observe the way the daemon's event loop does after watcher events: once
/// after the quiet window, then at the store's own wakeups, past the missing
/// re-check and the move window. Never a requested rescan.
fn observe_through_windows(rep: &mut Disk, clock: &StepClock, svc: &r::fake::FakeLogService) {
    for step in [150, 300, 3_000, 500] {
        clock.0.set(clock.0.get() + step);
        rep.observe(None).unwrap();
        settle(rep, svc);
    }
}

fn assert_deleted(rep: &Disk, ids: [B16; 2]) {
    for (path, id) in [A, B].into_iter().zip(ids) {
        assert!(
            rep.store()
                .file_at(&mdbn_core::paths::path_key(path))
                .unwrap()
                .is_none(),
            "{path} still listed: {:?}",
            rep.sync_status().incidents
        );
        assert!(
            rep.store().tombstone(&id).unwrap().is_some(),
            "{path}: no tombstone"
        );
        assert_eq!(rep.store().pending_count().unwrap(), 0);
    }
}

#[test]
fn removed_attachment_files_are_deleted_from_the_synced_state_without_reopening() {
    let (dir, clock, svc, mut rep, ids) = synced_pair("attachment-delete-files");
    let vault = dir.join("vault");
    fs::remove_file(vault.join(A)).unwrap();
    fs::remove_file(vault.join(B)).unwrap();
    rep.store_mut().on_events(&[
        event(FileEventKind::Removed, A),
        event(FileEventKind::Removed, B),
    ]);
    observe_through_windows(&mut rep, &clock, &svc);
    assert_deleted(&rep, ids);
}

#[test]
fn a_folder_moved_out_of_the_collection_deletes_its_files_without_a_full_rescan() {
    let (dir, clock, svc, mut rep, ids) = synced_pair("attachment-delete-folder-out");
    let vault = dir.join("vault");
    // Linux reports one rename of the folder path; the watcher queues that
    // path as `Changed` (`daemon/src/watch.rs`), nothing for the files.
    fs::rename(vault.join("_schemas/tasknotes"), dir.join("tasknotes")).unwrap();
    rep.store_mut()
        .on_events(&[event(FileEventKind::Changed, "_schemas/tasknotes")]);
    observe_through_windows(&mut rep, &clock, &svc);
    assert_deleted(&rep, ids);
}

#[test]
fn a_folder_renamed_inside_the_collection_moves_its_files() {
    let (dir, clock, svc, mut rep, ids) = synced_pair("attachment-delete-folder-rename");
    let vault = dir.join("vault");
    // Both ends of the rename are folders: only their paths are queued.
    fs::rename(vault.join("_schemas/tasknotes"), vault.join("_schemas/tn")).unwrap();
    rep.store_mut().on_events(&[
        event(FileEventKind::Changed, "_schemas/tasknotes"),
        event(FileEventKind::Changed, "_schemas/tn"),
    ]);
    observe_through_windows(&mut rep, &clock, &svc);
    for (path, id) in [A, B].into_iter().zip(ids) {
        let moved = path.replace("_schemas/tasknotes/", "_schemas/tn/");
        assert_eq!(
            rep.store()
                .file_at(&mdbn_core::paths::path_key(&moved))
                .unwrap(),
            Some(id),
            "{path} moved to {moved}, keeping its file ID: {:?}",
            rep.sync_status().incidents
        );
        assert!(rep.store().tombstone(&id).unwrap().is_none());
    }
    assert_eq!(rep.store().pending_count().unwrap(), 0);
}
