//! First ingest of an existing folder commits in deferred-durability windows
//! (one outer SQLite transaction per window, committed FULL at its end). These
//! tests stop a real child process mid-ingest and check that every reopen
//! converges to exactly the folder:
//! - SIGKILL mid-ingest (process crash: the open window is rolled back);
//! - a power-loss image (the child is frozen with SIGSTOP and the folder,
//!   index and WAL copied; SQLite recovery drops the uncommitted window, which
//!   is exactly what a power loss after the last barrier leaves);
//! - a power-loss image taken right after the first acknowledged client write
//!   that follows the ingest (local-only has no log: the client receipt is the
//!   first thing that leaves the replica).
//!
//! Before any rescan, an image must never hold a file-store acknowledgement
//! (disk state) without the record it acknowledges.
#![cfg(unix)]
#![allow(clippy::disallowed_methods, clippy::disallowed_types)]

use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::time::{Duration, Instant};

use mdbn_local_host::{
    Descriptor, HostKind, HostLock, Identity, LocalReplica, OsEntropy, ReplicaOptions,
    StoreOptions, SystemClock, open_store,
};
use mdbn_replica::api::ClientApi;
use mdbn_replica::store::{Page, Store};
use mdbn_wire::client::{ReceiptState, SubmitParams};
use mdbn_wire::common::{B16, DataMap, Text, Value};
use mdbn_wire::intent::{Create, Op};

/// More than one window (64 flushes of 64 documents), so a stop can land
/// after a committed window and inside the next one.
const NOTES: usize = 6000;
const CHILD_ENV: &str = "MDBN_INGEST_CRASH_CHILD";
const CHILD_MODE_ENV: &str = "MDBN_INGEST_CRASH_MODE";

fn test_dir(tag: &str) -> PathBuf {
    let p =
        PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(format!("{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&p);
    std::fs::create_dir_all(&p).unwrap();
    p
}

/// `NOTES` small linked notes (a quarter of them typed tasks) and a type.
fn write_corpus(root: &Path) {
    std::fs::write(root.join("mdbase.yaml"), "spec_version: \"0.3.0\"\n").unwrap();
    std::fs::create_dir_all(root.join("_types")).unwrap();
    std::fs::write(
        root.join("_types/task.md"),
        "---\nkind: mdbase.type\nname: task\nversion: 1\nmatch:\n  path_glob: \"Tasks/**/*.md\"\nschema:\n  dialect: json-schema-2020-12\n  value:\n    type: object\n    properties:\n      status: { type: string }\n---\n",
    )
    .unwrap();
    for i in 0..NOTES {
        let (dir, body) = if i % 4 == 0 {
            (
                format!("Tasks/{:02}", i % 7),
                format!(
                    "---\nstatus: open\n---\nTask {i}, see [[Note {}]].\n",
                    i / 2
                ),
            )
        } else {
            (
                format!("Area {:02}/Sub {}", i % 13, i % 3),
                format!(
                    "---\ntags: [n{}]\n---\nNote {i} links [[Note {}]].\n",
                    i % 5,
                    i / 3
                ),
            )
        };
        let d = root.join(&dir);
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join(format!("Note {i}.md")), body).unwrap();
    }
}

fn open(root: &Path) -> (HostLock, LocalReplica) {
    let opts = StoreOptions::default();
    let lock = HostLock::try_acquire(
        root,
        &opts.private_dir,
        Some(Descriptor::new(HostKind::Library, 1)),
    )
    .unwrap();
    let state = opts.state_dir(root);
    std::fs::create_dir_all(&state).unwrap();
    let identity =
        Identity::load_or_create(&state.join("identity.json"), 1, &mut OsEntropy).unwrap();
    let store = open_store(root, &opts, Box::new(SystemClock)).unwrap();
    let rep = LocalReplica::open(store, &identity, ReplicaOptions::default()).unwrap();
    (lock, rep)
}

/// The child: open, ingest the whole folder, then (in `ack` mode) submit one
/// client create and report its confirmed receipt by creating `acked`.
#[test]
fn ingest_crash_child() {
    let Some(root) = std::env::var_os(CHILD_ENV) else {
        return;
    };
    let root = PathBuf::from(root);
    let (_lock, mut rep) = open(&root);
    rep.rescan().unwrap();
    if std::env::var(CHILD_MODE_ENV).as_deref() == Ok("ack") {
        let session = rep.session();
        let id = B16(mdbn_local_host::host::uuid_v7(
            1_700_000_000_000,
            &mut OsEntropy,
        ));
        let receipts = rep
            .replica()
            .submit(
                session,
                SubmitParams {
                    ops: vec![Op::Create(Create {
                        id,
                        path: Some("Acked/client.md".into()),
                        type_name: None,
                        frontmatter: Some(DataMap(vec![(
                            "title".into(),
                            Value::Text("acked".into()),
                        )])),
                        body: Some(Text::Inline("Client write.\n".into())),
                        document: None,
                    })],
                    mutation_id: None,
                    conflict_mode: None,
                    timezone: None,
                    allow_partial: None,
                    mutation_ids: None,
                    dry_run: None,
                    include: None,
                    wait: None,
                },
            )
            .unwrap();
        rep.tick();
        let receipt = rep
            .replica()
            .receipt(session, receipts[0].mutation)
            .unwrap();
        assert_eq!(receipt.state, ReceiptState::Confirmed, "{receipt:?}");
        std::fs::write(root.with_extension("acked"), b"").unwrap();
    }
    // Stay alive until the parent stops us.
    std::thread::sleep(Duration::from_secs(600));
}

fn spawn_child(root: &Path, mode: &str) -> Child {
    Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "ingest_crash_child",
            "--nocapture",
            "--test-threads=1",
        ])
        .env(CHILD_ENV, root)
        .env(CHILD_MODE_ENV, mode)
        .spawn()
        .unwrap()
}

/// Wait until the child reports its acknowledged write.
fn wait_for(child: &mut Child, ack: &Path) {
    let start = Instant::now();
    loop {
        assert!(
            child.try_wait().unwrap().is_none(),
            "child exited before the stop point"
        );
        if ack.exists() {
            return;
        }
        assert!(
            start.elapsed() < Duration::from_secs(300),
            "child never reached the stop point"
        );
        std::thread::sleep(Duration::from_millis(2));
    }
}

/// Freeze the child (SIGSTOP): its writes so far are in the OS, nothing more.
fn freeze(child: &Child) {
    let ok = Command::new("kill")
        .args(["-STOP", &child.id().to_string()])
        .status()
        .unwrap()
        .success();
    assert!(ok, "kill -STOP");
}

fn resume(child: &Child) {
    let ok = Command::new("kill")
        .args(["-CONT", &child.id().to_string()])
        .status()
        .unwrap()
        .success();
    assert!(ok, "kill -CONT");
}

/// Freeze the child at a moment when at least one ingest window has
/// committed and the ingest is not finished, and return the power-loss image
/// taken there with its committed record count.
fn freeze_mid_ingest(child: &mut Child, root: &Path) -> (PathBuf, u64) {
    let image = root.with_extension("image");
    let start = Instant::now();
    loop {
        assert!(
            child.try_wait().unwrap().is_none(),
            "child exited mid-ingest"
        );
        std::thread::sleep(Duration::from_millis(20));
        freeze(child);
        let _ = std::fs::remove_dir_all(&image);
        copy_tree(root, &image);
        let records = acks_have_commits(&image);
        if records > 0 {
            assert!(
                records < NOTES as u64,
                "ingest finished before a mid-ingest stop; raise NOTES"
            );
            return (image, records);
        }
        resume(child);
        assert!(
            start.elapsed() < Duration::from_secs(300),
            "no window ever committed"
        );
    }
}

fn copy_tree(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).unwrap();
    for e in std::fs::read_dir(from).unwrap() {
        let e = e.unwrap();
        let t = to.join(e.file_name());
        if e.file_type().unwrap().is_dir() {
            copy_tree(&e.path(), &t);
        } else if e.file_type().unwrap().is_file() {
            std::fs::copy(e.path(), &t).unwrap();
        }
    }
}

/// Without rescanning: every path the file store acknowledges as known on
/// disk is held by a record with exactly those bytes. Returns how many
/// records the image holds.
fn acks_have_commits(root: &Path) -> u64 {
    let (_lock, rep) = open(root);
    let store = rep.replica_ref().store();
    for (path, rev) in store.disk_paths() {
        if !path.ends_with(".md") || path.starts_with("_types/") {
            continue;
        }
        let id = store
            .record_at(&mdbn_core::paths::path_key(&path))
            .unwrap()
            .unwrap_or_else(|| panic!("{path}: acknowledged on disk without its record"));
        let rec = store.record(&id).unwrap().unwrap();
        assert_eq!(rec.revision, rev, "{path}: acknowledged bytes differ");
    }
    store.record_count().unwrap()
}

/// Reopen, rescan and settle: the records are exactly the folder's notes,
/// with the files' bytes, typed by the folder's type, and nothing is held.
fn converges(root: &Path, extra: &[&str]) {
    let (_lock, mut rep) = open(root);
    rep.rescan().unwrap();
    rep.settle(2_000).unwrap();
    let store = rep.replica_ref().store();
    let mut seen = std::collections::BTreeMap::new();
    let mut after = None;
    loop {
        let rows = store.records(Page { after, limit: 1000 }).unwrap();
        let Some(last) = rows.last() else { break };
        after = Some(last.id);
        for r in rows {
            assert!(
                seen.insert(r.path.clone(), r).is_none(),
                "duplicate record path"
            );
        }
    }
    assert_eq!(seen.len(), NOTES + extra.len(), "record count");
    for i in (0..NOTES).step_by(97) {
        let rec = seen
            .values()
            .find(|r| r.path.ends_with(&format!("/Note {i}.md")))
            .unwrap_or_else(|| panic!("Note {i} missing"));
        let disk = std::fs::read_to_string(root.join(&rec.path)).unwrap();
        assert_eq!(rec.doc, disk, "{}", rec.path);
        assert_eq!(
            rec.meta.types.iter().any(|t| t == "task"),
            i % 4 == 0,
            "{} types {:?}",
            rec.path,
            rec.meta.types
        );
    }
    for p in extra {
        assert!(seen.contains_key(*p), "{p} lost");
    }
    assert!(store.holds().unwrap().is_empty(), "nothing is held");
    let status = rep.replica_ref().sync_status();
    assert!(status.incidents.is_empty(), "{status:?}");
    assert_eq!(status.pending, 0, "{status:?}");
}

#[test]
fn sigkill_mid_ingest_converges() {
    let root = test_dir("ingest-kill");
    write_corpus(&root);
    let mut child = spawn_child(&root, "ingest");
    let (image, frozen) = freeze_mid_ingest(&mut child, &root);
    resume(&child);
    std::thread::sleep(Duration::from_millis(50));
    child.kill().unwrap();
    child.wait().unwrap();
    let records = acks_have_commits(&root);
    eprintln!("sigkill: {frozen} records committed at freeze, {records} at kill, of {NOTES}");
    assert!(records >= frozen && records <= NOTES as u64, "{records}");
    converges(&root, &[]);
    let _ = std::fs::remove_dir_all(&image);
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn power_loss_image_mid_ingest_converges() {
    let root = test_dir("ingest-power");
    write_corpus(&root);
    let mut child = spawn_child(&root, "ingest");
    let (image, records) = freeze_mid_ingest(&mut child, &root);
    child.kill().unwrap();
    child.wait().unwrap();
    eprintln!("power-loss image: {records} of {NOTES} records committed");
    converges(&image, &[]);
    let _ = std::fs::remove_dir_all(&image);
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn power_loss_image_after_first_acknowledged_write_keeps_it() {
    let root = test_dir("ingest-ack");
    write_corpus(&root);
    let acked = root.with_extension("acked");
    let _ = std::fs::remove_file(&acked);
    let mut child = spawn_child(&root, "ack");
    wait_for(&mut child, &acked);
    freeze(&child);
    let image = root.with_extension("image");
    let _ = std::fs::remove_dir_all(&image);
    copy_tree(&root, &image);
    child.kill().unwrap();
    child.wait().unwrap();
    // Everything ingested before the acknowledged write is committed with it.
    assert_eq!(acks_have_commits(&image), NOTES as u64 + 1);
    converges(&image, &["Acked/client.md"]);
    let _ = std::fs::remove_dir_all(&image);
    let _ = std::fs::remove_file(&acked);
    let _ = std::fs::remove_dir_all(&root);
}
