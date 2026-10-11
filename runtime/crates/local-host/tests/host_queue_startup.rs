//! Genuine suspended startup with SQLite, original resource bytes and real disk IO.
//! Opening qualification only; async Rescan/publication and the TS driver are separate.
#![allow(clippy::disallowed_methods, clippy::disallowed_types)]
use mdbn_core::host::FixedClock;
use mdbn_platform_native::SqliteIndex;
use mdbn_replica::store::StoreError;
use mdbn_store_file::diskdb::SqlDiskDb;
use mdbn_store_file::host::{FileOp, FileOpOutput, QueuedPlatform};
use mdbn_store_file::index::IndexDurability;
use mdbn_store_file::platform::{
    Capabilities, CaseSensitivity, Durability, EventFidelity, FsError, FsErrorKind, RelPath,
    ReplaceStrategy,
};
use mdbn_store_file::{Config, FileStore, SqlStore};
use serde_json::Value;
use std::cell::RefCell;
use std::rc::Rc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::task::Poll;
static SERIAL: AtomicU64 = AtomicU64::new(0);

fn caps() -> Capabilities {
    // The desktop VaultPlatform declarations, not native fsync/atomic replacement.
    Capabilities {
        replace: ReplaceStrategy::GuardedInPlace,
        exclusive_create: false,
        durability: Durability::None,
        case: CaseSensitivity::Sensitive,
        file_ids: false,
        mtime_resolution_ns: 1_000_000,
        events: EventFidelity::Hint,
        transient_missing: false,
        private_dir: RelPath::new(".mdbase").unwrap(),
    }
}
fn fixture() -> (std::path::PathBuf, Rc<RefCell<SqliteIndex>>) {
    let root = std::path::Path::new(env!("CARGO_TARGET_TMPDIR")).join(format!(
        "host-queue-startup-{}-{}",
        std::process::id(),
        SERIAL.fetch_add(1, Ordering::Relaxed)
    ));
    std::fs::create_dir(&root).unwrap();
    let index = Rc::new(RefCell::new(
        SqliteIndex::open(root.join("probe.sqlite"), IndexDurability::Durable).unwrap(),
    ));
    (root, index)
}

#[test]
fn queued_file_store_open_retains_one_future_until_real_directory_io_completes() {
    let (root, index) = fixture();
    let bundle: Value = serde_json::from_slice(include_bytes!(
        "fixtures/reader-semantic-digests/bundle.json"
    ))
    .unwrap();
    let resources = bundle["resources"].as_array().unwrap();
    assert_eq!(resources.len(), 8);
    for r in resources {
        let p = root.join(r["path"].as_str().unwrap());
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, r["document"].as_str().unwrap()).unwrap();
    }
    let (platform, queue) = QueuedPlatform::new(caps());
    let mut opening = FileStore::start_open(
        Rc::new(platform),
        SqlStore::open(index.clone()).unwrap(),
        SqlDiskDb::open(index).unwrap(),
        Box::new(FixedClock(1_700_000_000_000)),
        Config::default(),
    );
    let mut completed = Vec::new();
    let mut store = None;
    for turn in 0..32 {
        match opening.poll(1_700_000_000_000 + turn) {
            Poll::Ready(Ok(s)) => {
                store = Some(s);
                break;
            }
            Poll::Ready(Err(e)) => panic!("unexpected opening refusal: {e:?}"),
            Poll::Pending => {}
        }
        assert!(!opening.is_complete());
        let requests = queue.take_requests();
        assert_eq!(requests.len(), 1);
        let (id, op) = &requests[0];
        assert!(!completed.contains(id));
        // Multiple polls before completion neither restart nor mint another IO ID.
        assert!(opening.poll(1_700_000_000_000 + turn).is_pending());
        assert!(queue.take_requests().is_empty());
        let FileOp::CreateDirAll { dir } = op else {
            panic!("unexpected startup request: {op:?}");
        };
        let actual = root.join(dir.as_str());
        std::fs::create_dir_all(&actual).unwrap();
        assert!(actual.is_dir());
        queue.complete(*id, Ok(FileOpOutput::Unit));
        completed.push(*id);
    }
    let store = store.expect("startup must finish within the bounded host drive");
    assert!(opening.is_complete());
    assert_eq!(queue.in_flight(), 0);
    assert!(queue.take_requests().is_empty());
    assert!(!completed.is_empty());
    assert!(matches!(
        opening.poll(1_700_000_000_100),
        Poll::Ready(Err(_))
    ));
    for r in resources {
        assert_eq!(
            std::fs::read(root.join(r["path"].as_str().unwrap())).unwrap(),
            r["document"].as_str().unwrap().as_bytes()
        );
    }
    println!(
        "RETAINED_QUEUED_OPEN=ready; original_resources=8; io_count={}; root={}",
        completed.len(),
        root.display()
    );
    drop(store);
    // Preserve the owned resource/index root for inspecting this execution.
}

#[test]
fn queued_open_refusal_is_delivered_once_without_restarting_original_io() {
    let (_root, index) = fixture();
    let (platform, queue) = QueuedPlatform::new(caps());
    let mut opening = FileStore::start_open(
        Rc::new(platform),
        SqlStore::open(index.clone()).unwrap(),
        SqlDiskDb::open(index).unwrap(),
        Box::new(FixedClock(1_700_000_000_000)),
        Config::default(),
    );
    assert!(opening.poll(1_700_000_000_000).is_pending());
    let requests = queue.take_requests();
    assert_eq!(requests.len(), 1);
    queue.complete(
        requests[0].0,
        Err(FsError::new(FsErrorKind::NoSpace, "host refused")),
    );
    assert!(matches!(
        opening.poll(1_700_000_000_001),
        Poll::Ready(Err(StoreError::Full))
    ));
    assert!(opening.is_complete());
    assert_eq!(queue.in_flight(), 0);
    assert!(queue.take_requests().is_empty());
    assert!(matches!(
        opening.poll(1_700_000_000_002),
        Poll::Ready(Err(_))
    ));
    assert!(queue.take_requests().is_empty());
}
