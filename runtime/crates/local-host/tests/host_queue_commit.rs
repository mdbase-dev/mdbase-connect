//! Actual queued Rust FileStore/SQLite/physical publication foundation.
//! Not Replica deferred/progress integration, TS HostLoop, Obsidian or durability.
#![allow(clippy::disallowed_methods, clippy::disallowed_types)]
use mdbn_core::host::FixedClock;
use mdbn_platform_native::{NativePlatform, OpenOptions, SqliteIndex};
use mdbn_replica::store::{Content, Expect, Publish, Store, StoreError, Tx};
use mdbn_store_file::codec::IntentRec;
use mdbn_store_file::diskdb::{DiskDb, Kind, SqlDiskDb};
use mdbn_store_file::exec::{Timers, run_ready};
use mdbn_store_file::host::{FileOp, FileOpOutput, HostQueue, OpId, QueuedPlatform};
use mdbn_store_file::index::IndexDurability;
use mdbn_store_file::platform::{FilePlatform, FsError, FsErrorKind, FsResult};
use mdbn_store_file::publish::revision;
use mdbn_store_file::{Committing, Config, FileStore, SqlStore};
use mdbn_wire::common::B16;
use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet};
use std::rc::Rc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::task::Poll;

#[path = "host_queue_commit/deferred.rs"]
mod deferred_queue_tests;
#[path = "host_queue_commit/replica.rs"]
mod replica_tests;

static SERIAL: AtomicU64 = AtomicU64::new(0);
const NOW: u64 = 1_700_000_000_000;
type Disk = FileStore<QueuedPlatform, SqlStore<SqliteIndex>, SqlDiskDb<SqliteIndex>>;

fn physical(p: &NativePlatform, op: FileOp) -> FsResult<FileOpOutput> {
    let timers = Timers::default();
    macro_rules! io {
        ($f:expr) => {
            run_ready(&timers, $f).expect("native original IO completes in-call")
        };
    }
    match op {
        FileOp::CreateDirAll { dir } => io!(p.create_dir_all(&dir)).map(|()| FileOpOutput::Unit),
        FileOp::List { dir } => io!(p.list(&dir)).map(FileOpOutput::Entries),
        FileOp::Stat { path } => io!(p.stat(&path)).map(FileOpOutput::Meta),
        FileOp::Read { path } => io!(p.read(&path)).map(FileOpOutput::Read),
        FileOp::OpenRangeRead { path } => {
            io!(p.open_range_read(&path)).map(|(handle, meta)| FileOpOutput::Range { handle, meta })
        }
        FileOp::ReadAt {
            handle,
            offset,
            len,
        } => io!(p.read_at(handle, offset, len)).map(FileOpOutput::Bytes),
        FileOp::RangeMeta { handle } => io!(p.range_meta(handle)).map(FileOpOutput::Meta),
        FileOp::CloseRangeRead { handle } => {
            io!(p.close_range_read(handle)).map(|()| FileOpOutput::Unit)
        }
        FileOp::WriteNew {
            path,
            bytes,
            durable,
        } => io!(p.write_new(&path, &bytes, durable)).map(FileOpOutput::Meta),
        FileOp::RenameNoreplace { from, to } => {
            io!(p.rename_noreplace(&from, &to)).map(|()| FileOpOutput::Unit)
        }
        FileOp::RemoveFile { path } => io!(p.remove_file(&path)).map(|()| FileOpOutput::Unit),
        FileOp::Flush { scope } => io!(p.flush(scope)).map(|()| FileOpOutput::Unit),
        FileOp::Exchange { a, b } => io!(p.exchange(&a, &b)).map(|()| FileOpOutput::Unit),
        FileOp::CopyMetadata { from, to } => {
            io!(p.copy_metadata(&from, &to)).map(|()| FileOpOutput::Unit)
        }
        op => panic!("unexpected publication foundation IO: {op:?}"),
    }
}
fn fixture() -> (
    std::path::PathBuf,
    NativePlatform,
    HostQueue,
    Disk,
    Rc<RefCell<SqliteIndex>>,
) {
    fixture_mode(false)
}
fn fixture_mode(
    queued_publication: bool,
) -> (
    std::path::PathBuf,
    NativePlatform,
    HostQueue,
    Disk,
    Rc<RefCell<SqliteIndex>>,
) {
    let root = std::path::Path::new(env!("CARGO_TARGET_TMPDIR")).join(format!(
        "host-queue-commit-{}-{}",
        std::process::id(),
        SERIAL.fetch_add(1, Ordering::Relaxed)
    ));
    std::fs::create_dir(&root).unwrap();
    let collection = root.join("collection");
    std::fs::create_dir(&collection).unwrap();
    let native = NativePlatform::open(&collection, &OpenOptions::default()).unwrap();
    let index = Rc::new(RefCell::new(
        SqliteIndex::open(root.join("index.sqlite"), IndexDurability::Durable).unwrap(),
    ));
    let (platform, queue) = QueuedPlatform::new(native.capabilities().clone());
    let mut opening = FileStore::start_open(
        Rc::new(platform),
        SqlStore::open(index.clone()).unwrap(),
        SqlDiskDb::open(index.clone()).unwrap(),
        Box::new(FixedClock(NOW)),
        Config {
            quiescence_ms: 0,
            move_window_ms: 0,
            queued_publication,
            ..Config::default()
        },
    );
    for turn in 0..32 {
        match opening.poll(NOW + turn) {
            Poll::Ready(Ok(store)) => return (collection, native, queue, store, index),
            Poll::Ready(Err(e)) => panic!("opening refused: {e:?}"),
            Poll::Pending => {
                let requests = queue.take_requests();
                assert_eq!(requests.len(), 1);
                for (id, op) in requests {
                    queue.complete(id, physical(&native, op));
                }
            }
        }
    }
    panic!("bounded original opening did not complete");
}
fn audit_intents(
    index: &Rc<RefCell<SqliteIndex>>,
    originals: &mut BTreeMap<u64, Vec<u8>>,
) -> usize {
    let rows = SqlDiskDb::open(index.clone()).unwrap().load().unwrap();
    let mut live = 0;
    for (kind, _, bytes) in rows {
        if kind == Kind::Intent {
            live += 1;
            let rec = IntentRec::from_bytes(&bytes).unwrap();
            if let Some(old) = originals.get(&rec.n) {
                assert_eq!(
                    old, &bytes,
                    "ORIGINAL intent counter/names/bytes/CAS never change while suspended"
                );
            } else {
                originals.insert(rec.n, bytes);
            }
        }
    }
    live
}
fn drive(
    commit: &mut Committing<'_>,
    p: &NativePlatform,
    q: &HostQueue,
    index: &Rc<RefCell<SqliteIndex>>,
    ids: &mut BTreeSet<OpId>,
    intents: &mut BTreeMap<u64, Vec<u8>>,
) -> mdbn_replica::store::StoreResult<mdbn_replica::store::CommitReport> {
    for turn in 0..256 {
        match commit.poll(NOW + turn) {
            Poll::Ready(result) => return result,
            Poll::Pending => {
                let requests = q.take_requests();
                assert_eq!(requests.len(), 1);
                let (id, op) = requests.into_iter().next().unwrap();
                assert!(ids.insert(id), "original operation IDs never restart");
                let live = audit_intents(index, intents);
                for _ in 0..3 {
                    assert!(commit.poll(NOW + turn).is_pending());
                    assert!(q.take_requests().is_empty());
                    assert_eq!(audit_intents(index, intents), live);
                }
                q.complete(id, physical(p, op));
            }
        }
    }
    panic!("bounded retained original commit did not finish");
}
fn write(path: &str, expect: Expect, text: &str) -> Publish {
    Publish::Write {
        id: Some(B16([11; 16])),
        path: path.into(),
        expect,
        content: Content::Text(text.into()),
    }
}
#[test]
fn queued_commit_create_replace_move_delete_preserves_original_intents_and_cas() {
    let (root, native, queue, mut store, index) = fixture();
    let mut ids = BTreeSet::new();
    let mut intents = BTreeMap::new();
    let operations = [
        write(
            "docs/original.md",
            Expect::Absent,
            "original physical document",
        ),
        write(
            "docs/original.md",
            Expect::Revision(revision(b"original physical document")),
            "second physical document",
        ),
        Publish::Move {
            id: B16([11; 16]),
            from: "docs/original.md".into(),
            to: "docs/moved.md".into(),
            expect: Expect::Revision(revision(b"second physical document")),
            content: None,
        },
        Publish::Delete {
            id: Some(B16([11; 16])),
            path: "docs/moved.md".into(),
            expect: Expect::Revision(revision(b"second physical document")),
        },
    ];
    for (step, op) in operations.into_iter().enumerate() {
        let mut commit = store.start_commit(Tx {
            publish: vec![op],
            ..Tx::default()
        });
        let report = drive(&mut commit, &native, &queue, &index, &mut ids, &mut intents).unwrap();
        assert!(commit.is_complete());
        assert!(report.drifts.is_empty());
        assert_eq!(report.deferred, None);
        assert!(matches!(commit.poll(NOW + 300), Poll::Ready(Err(_))));
        drop(commit);
        assert_eq!(audit_intents(&index, &mut intents), 0);
        match step {
            0 => assert_eq!(
                std::fs::read(root.join("docs/original.md")).unwrap(),
                b"original physical document"
            ),
            1 => assert_eq!(
                std::fs::read(root.join("docs/original.md")).unwrap(),
                b"second physical document"
            ),
            2 => {
                assert!(!root.join("docs/original.md").exists());
                assert_eq!(
                    std::fs::read(root.join("docs/moved.md")).unwrap(),
                    b"second physical document"
                );
            }
            _ => assert!(!root.join("docs/moved.md").exists()),
        }
        assert_eq!(queue.in_flight(), 0);
        assert!(queue.take_requests().is_empty());
    }
    assert_eq!(
        intents.len(),
        5,
        "create+replace+two-phase move+delete retain exactly five ORIGINAL intents"
    );
    assert!(store.disk_state("docs/original.md").is_none());
    assert!(store.disk_state("docs/moved.md").is_none());
}
#[test]
fn queued_commit_changed_physical_source_drifts_without_clobber_or_replacement_intent() {
    let (root, native, queue, mut store, index) = fixture();
    let mut ids = BTreeSet::new();
    let mut intents = BTreeMap::new();
    let mut create = store.start_commit(Tx {
        publish: vec![write("source.md", Expect::Absent, "original")],
        ..Tx::default()
    });
    assert!(
        drive(&mut create, &native, &queue, &index, &mut ids, &mut intents)
            .unwrap()
            .drifts
            .is_empty()
    );
    drop(create);
    std::fs::write(root.join("source.md"), "outside writer's genuine document").unwrap();
    let original = write(
        "source.md",
        Expect::Revision(revision(b"original")),
        "must not clobber",
    );
    let mut replace = store.start_commit(Tx {
        publish: vec![original.clone()],
        ..Tx::default()
    });
    let report = drive(
        &mut replace,
        &native,
        &queue,
        &index,
        &mut ids,
        &mut intents,
    )
    .unwrap();
    drop(replace);
    assert_eq!(report.drifts.len(), 1);
    assert_eq!(report.drifts[0].publish, original);
    assert_eq!(report.drifts[0].reason, "changed");
    assert_eq!(
        std::fs::read(root.join("source.md")).unwrap(),
        b"outside writer's genuine document"
    );
    assert_eq!(intents.len(), 2);
    assert_eq!(audit_intents(&index, &mut intents), 0);
}
#[test]
fn queued_commit_failed_flush_retains_original_journal_and_reports_terminal_failure_once() {
    let (root, native, queue, mut store, index) = fixture();
    let mut originals = BTreeMap::new();
    let mut commit = store.start_commit(Tx {
        publish: vec![write(
            "source.md",
            Expect::Absent,
            "original flush-bound document",
        )],
        ..Tx::default()
    });
    let mut failed = false;
    let mut terminal = false;
    let mut ids = BTreeSet::new();
    for turn in 0..64 {
        match commit.poll(NOW + turn) {
            Poll::Ready(Err(StoreError::Full)) => {
                terminal = true;
                break;
            }
            Poll::Ready(other) => panic!("flush failure must not be ready/published: {other:?}"),
            Poll::Pending => {
                let requests = queue.take_requests();
                assert_eq!(requests.len(), 1);
                let (id, op) = requests.into_iter().next().unwrap();
                assert!(ids.insert(id));
                assert_eq!(audit_intents(&index, &mut originals), 1);
                for _ in 0..3 {
                    assert!(commit.poll(NOW + turn).is_pending());
                    assert!(queue.take_requests().is_empty());
                }
                if matches!(op, FileOp::Flush { .. }) {
                    assert!(!failed);
                    failed = true;
                    queue.complete(
                        id,
                        Err(FsError::new(FsErrorKind::NoSpace, "original flush refused")),
                    );
                } else {
                    queue.complete(id, physical(&native, op));
                }
            }
        }
    }
    assert!(failed && terminal);
    assert!(commit.is_complete());
    assert!(matches!(commit.poll(NOW + 100), Poll::Ready(Err(_))));
    drop(commit);
    assert_eq!(audit_intents(&index, &mut originals), 1);
    assert_eq!(originals.len(), 1);
    assert_eq!(
        std::fs::read(root.join("source.md")).unwrap(),
        b"original flush-bound document"
    );
    assert!(
        store.disk_state("source.md").is_none(),
        "failed durability step cannot record published state"
    );
    assert_eq!(queue.in_flight(), 0);
    assert!(queue.take_requests().is_empty());
    drop(store);
    let (platform, recovery_queue) = QueuedPlatform::new(native.capabilities().clone());
    let mut opening = FileStore::start_open(
        Rc::new(platform),
        SqlStore::open(index.clone()).unwrap(),
        SqlDiskDb::open(index.clone()).unwrap(),
        Box::new(FixedClock(NOW)),
        Config::default(),
    );
    let mut recovered = None;
    for turn in 0..64 {
        match opening.poll(NOW + 200 + turn) {
            Poll::Ready(Ok(s)) => {
                recovered = Some(s);
                break;
            }
            Poll::Ready(Err(e)) => panic!("original intent recovery refused: {e:?}"),
            Poll::Pending => {
                let requests = recovery_queue.take_requests();
                assert_eq!(requests.len(), 1);
                let (id, op) = requests.into_iter().next().unwrap();
                assert_eq!(
                    audit_intents(&index, &mut originals),
                    1,
                    "original intent survives EVERY recovery suspension and final flush"
                );
                recovery_queue.complete(id, physical(&native, op));
            }
        }
    }
    let recovered = recovered.expect("bounded original intent recovery completes");
    assert_eq!(recovered.stats.recovered, 1);
    assert_eq!(
        originals.len(),
        1,
        "recovery never allocates a replacement intent"
    );
    assert_eq!(audit_intents(&index, &mut originals), 0);
    assert_eq!(
        recovered.disk_state("source.md").unwrap().rev,
        revision(b"original flush-bound document")
    );
    assert_eq!(
        std::fs::read(root.join("source.md")).unwrap(),
        b"original flush-bound document"
    );
    assert_eq!(recovery_queue.in_flight(), 0);
}
#[test]
fn queued_commit_mirror_closure_drains_original_write_but_refuses_rename_and_certification() {
    let (root, native, queue, mut store, index) = fixture();
    let mut control = SqlStore::open(index.clone()).unwrap();
    let mut commit = store.start_commit(Tx {
        publish: vec![write(
            "source.md",
            Expect::Absent,
            "original gated document",
        )],
        ..Tx::default()
    });
    assert!(commit.poll(NOW).is_pending());
    let requests = queue.take_requests();
    assert_eq!(requests.len(), 1);
    let (id, op) = requests.into_iter().next().unwrap();
    let FileOp::WriteNew { path, .. } = &op else {
        panic!("original private write required")
    };
    let private_path = path.clone();
    let mut originals = BTreeMap::new();
    assert_eq!(audit_intents(&index, &mut originals), 1);
    mdbn_replica::mirror_admission::Fence::new([31; 16], 1)
        .unwrap()
        .persist(&mut control)
        .unwrap();
    // Complete the original physical write, not a replacement/retry. Its
    // completion is drained before closed admission refuses the next request.
    queue.complete(id, physical(&native, op));
    assert!(matches!(commit.poll(NOW + 1), Poll::Ready(Err(_))));
    assert!(commit.is_complete());
    drop(commit);
    assert_eq!(queue.in_flight(), 0);
    assert!(queue.take_requests().is_empty());
    assert!(!root.join("source.md").exists());
    assert_eq!(
        std::fs::read(root.join(private_path.as_str())).unwrap(),
        b"original gated document"
    );
    assert_eq!(audit_intents(&index, &mut originals), 1);
    assert_eq!(originals.len(), 1);
    let mut denied = store.start_commit(Tx {
        publish: vec![write("denied.md", Expect::Absent, "must not queue")],
        ..Tx::default()
    });
    assert!(matches!(denied.poll(NOW + 2), Poll::Ready(Err(_))));
    drop(denied);
    assert!(queue.take_requests().is_empty());
    assert_eq!(audit_intents(&index, &mut originals), 1);
}

#[test]
fn queued_commit_evidence_ack_waits_for_original_physical_cleanup_before_removing_obligation() {
    use mdbn_store_file::codec::{EvidenceRec, counter_bytes};
    use mdbn_store_file::platform::RelPath;
    // Seeded evidence provenance fixture, not a real signed-log/recovery origin.
    // Cleanup itself uses genuine SQLite, queued IO and a physical evidence file.
    let (root, native, _old_queue, store, index) = fixture();
    drop(store);
    let evidence_path = RelPath::new(".mdbase/held/original-evidence").unwrap();
    std::fs::write(
        root.join(evidence_path.as_str()),
        "original evidence document",
    )
    .unwrap();
    let evidence = EvidenceRec {
        path: "evidence.md".into(),
        evidence: evidence_path.clone(),
        base: None,
        suspect: false,
    };
    SqlDiskDb::open(index.clone())
        .unwrap()
        .apply(vec![(
            Kind::Observation,
            counter_bytes(41),
            Some(evidence.to_bytes()),
        )])
        .unwrap();
    let (platform, queue) = QueuedPlatform::new(native.capabilities().clone());
    let mut opening = FileStore::start_open(
        Rc::new(platform),
        SqlStore::open(index.clone()).unwrap(),
        SqlDiskDb::open(index.clone()).unwrap(),
        Box::new(FixedClock(NOW)),
        Config::default(),
    );
    let mut ready = None;
    for turn in 0..32 {
        match opening.poll(NOW + turn) {
            Poll::Ready(Ok(s)) => {
                ready = Some(s);
                break;
            }
            Poll::Ready(Err(e)) => panic!("evidence fixture open refused: {e:?}"),
            Poll::Pending => {
                for (id, op) in queue.take_requests() {
                    queue.complete(id, physical(&native, op));
                }
            }
        }
    }
    let mut store = ready.expect("original evidence fixture opens");
    let mut scan = store.start_observe(Some(&[]));
    let mut observed = None;
    for turn in 0..64 {
        match scan.poll(NOW + turn) {
            Poll::Ready(Ok(o)) => {
                observed = Some(o);
                break;
            }
            Poll::Ready(Err(e)) => panic!("original evidence read refused: {e:?}"),
            Poll::Pending => {
                for (id, op) in queue.take_requests() {
                    queue.complete(id, physical(&native, op));
                }
            }
        }
    }
    drop(scan);
    let observed = observed.expect("original evidence observation ready");
    assert_eq!(observed.len(), 1);
    assert_eq!(observed[0].token, mdbn_replica::store::ObservationId(41));
    assert_eq!(
        observed[0].now,
        Some(mdbn_replica::store::Observed::Text(
            "original evidence document".into()
        ))
    );
    let mut commit = store.start_commit(Tx {
        ack_observations: vec![observed[0].token],
        ..Tx::default()
    });
    assert!(commit.poll(NOW + 100).is_pending());
    let requests = queue.take_requests();
    assert_eq!(requests.len(), 1);
    let (id, op) = requests.into_iter().next().unwrap();
    assert_eq!(
        op,
        FileOp::RemoveFile {
            path: evidence_path.clone()
        }
    );
    for _ in 0..3 {
        assert!(commit.poll(NOW + 101).is_pending());
        assert!(queue.take_requests().is_empty());
        assert!(root.join(evidence_path.as_str()).exists());
        assert!(
            SqlDiskDb::open(index.clone())
                .unwrap()
                .load()
                .unwrap()
                .iter()
                .any(|(kind, key, _)| *kind == Kind::Observation && key == &counter_bytes(41))
        );
    }
    queue.complete(id, physical(&native, op));
    assert!(matches!(commit.poll(NOW + 102), Poll::Ready(Ok(_))));
    drop(commit);
    assert!(!root.join(evidence_path.as_str()).exists());
    assert!(
        !SqlDiskDb::open(index)
            .unwrap()
            .load()
            .unwrap()
            .iter()
            .any(|(kind, key, _)| *kind == Kind::Observation && key == &counter_bytes(41))
    );
    assert_eq!(queue.in_flight(), 0);
}

#[test]
fn dropped_pending_commit_is_not_drain_ack_and_cannot_restart_original_work() {
    let (_root, native, queue, mut store, index) = fixture();
    let mut commit = store.start_commit(Tx {
        publish: vec![write(
            "source.md",
            Expect::Absent,
            "original abandoned owner",
        )],
        ..Tx::default()
    });
    assert!(commit.poll(NOW).is_pending());
    let requests = queue.take_requests();
    assert_eq!(requests.len(), 1);
    let (original_id, original_op) = requests.into_iter().next().unwrap();
    drop(commit);
    assert_eq!(
        queue.in_flight(),
        1,
        "dropping the owner never acknowledges original IO"
    );
    assert!(store.head().is_err());
    assert!(store.meta("authority-check").is_err());
    let mut replacement = store.start_commit(Tx::default());
    assert!(matches!(replacement.poll(NOW + 1), Poll::Ready(Err(_))));
    drop(replacement);
    assert!(queue.take_requests().is_empty());
    let mut originals = BTreeMap::new();
    assert_eq!(audit_intents(&index, &mut originals), 1);
    // Actually finish the ORIGINAL physical IO. With no owner to collect its
    // result, HostQueue truthfully remains unresolved; never fake a drain ACK.
    queue.complete(original_id, physical(&native, original_op));
    assert_eq!(queue.in_flight(), 1);
    assert!(
        store.head().is_err(),
        "host completion alone cannot certify abandoned commit"
    );
    assert_eq!(audit_intents(&index, &mut originals), 1);
}
