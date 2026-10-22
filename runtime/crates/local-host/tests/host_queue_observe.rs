//! Real queued Rust FileStore scan; not TS HostLoop/Obsidian or registry admission.
#![allow(clippy::disallowed_methods, clippy::disallowed_types)]
use std::cell::RefCell;
use std::collections::BTreeSet;
use std::rc::Rc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::task::Poll;

use mdbn_core::host::FixedClock;
use mdbn_platform_native::{NativePlatform, OpenOptions, SqliteIndex};
use mdbn_replica::store::{Observed, Store, StoreError, Tx};
use mdbn_store_file::diskdb::SqlDiskDb;
use mdbn_store_file::exec::{Timers, run_ready};
use mdbn_store_file::host::{FileOp, FileOpOutput, HostQueue, OpId, QueuedPlatform};
use mdbn_store_file::index::IndexDurability;
use mdbn_store_file::platform::{FilePlatform, FsError, FsErrorKind, FsResult};
use mdbn_store_file::publish::revision;
use mdbn_store_file::{Config, FileStore, Observing, SqlStore};
use serde_json::Value;

static SERIAL: AtomicU64 = AtomicU64::new(0);
const NOW: u64 = 1_700_000_000_000;
type Disk = FileStore<QueuedPlatform, SqlStore<SqliteIndex>, SqlDiskDb<SqliteIndex>>;

fn physical(p: &NativePlatform, op: FileOp) -> FsResult<FileOpOutput> {
    let timers = Timers::default();
    macro_rules! io {
        ($f:expr) => {
            run_ready(&timers, $f).expect("native IO must complete in-call")
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
        op => panic!("unexpected physical scan IO: {op:?}"),
    }
}

fn fixture() -> (std::path::PathBuf, NativePlatform, HostQueue, Disk) {
    let root = std::path::Path::new(env!("CARGO_TARGET_TMPDIR")).join(format!(
        "host-queue-observe-{}-{}",
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
        SqlDiskDb::open(index).unwrap(),
        Box::new(FixedClock(NOW)),
        Config {
            quiescence_ms: 0,
            move_window_ms: 0,
            ..Config::default()
        },
    );
    for turn in 0..32 {
        match opening.poll(NOW + turn) {
            Poll::Ready(Ok(store)) => return (collection, native, queue, store),
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
    panic!("bounded opening did not finish");
}

fn pending(
    scan: &mut Observing<'_>,
    queue: &HostQueue,
    turn: u64,
    ids: &mut BTreeSet<OpId>,
) -> (OpId, FileOp) {
    assert!(!scan.is_complete());
    let requests = queue.take_requests();
    assert_eq!(requests.len(), 1);
    let (id, op) = requests.into_iter().next().unwrap();
    assert!(ids.insert(id), "original IO IDs never restart");
    for _ in 0..3 {
        assert!(scan.poll(NOW + turn).is_pending());
        assert!(queue.take_requests().is_empty());
    }
    (id, op)
}

#[test]
fn queued_rescan_returns_one_complete_original_eight_resource_observation_batch() {
    let (root, native, queue, mut store) = fixture();
    let bundle: Value = serde_json::from_slice(include_bytes!(
        "fixtures/reader-semantic-digests/bundle.json"
    ))
    .unwrap();
    let resources = bundle["resources"].as_array().unwrap();
    assert_eq!(resources.len(), 8);
    for resource in resources {
        let path = root.join(resource["path"].as_str().unwrap());
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, resource["document"].as_str().unwrap()).unwrap();
    }
    let mut scan = store.start_observe(None);
    let mut ids = BTreeSet::new();
    let mut closes = 0;
    let mut result = None;
    for turn in 0..256 {
        match scan.poll(NOW + turn) {
            Poll::Ready(Ok(observations)) => {
                result = Some(observations);
                break;
            }
            Poll::Ready(Err(e)) => panic!("scan refused: {e:?}"),
            Poll::Pending => {
                let (id, op) = pending(&mut scan, &queue, turn, &mut ids);
                if matches!(op, FileOp::CloseRangeRead { .. }) {
                    closes += 1;
                }
                queue.complete(id, physical(&native, op));
            }
        }
    }
    let observations = result.expect("bounded scan completes");
    assert!(scan.is_complete());
    assert!(matches!(scan.poll(NOW + 300), Poll::Ready(Err(_))));
    drop(scan);
    assert_eq!(queue.in_flight(), 0);
    assert!(queue.take_requests().is_empty());
    assert_eq!(observations.len(), 8);
    assert!(
        closes > 0,
        "schema JSON goes through original range handles"
    );
    let mut tokens = BTreeSet::new();
    for resource in resources {
        let path = resource["path"].as_str().unwrap();
        let bytes = resource["document"].as_str().unwrap().as_bytes();
        let observation = observations.iter().find(|o| o.path == path).unwrap();
        assert!(tokens.insert(observation.token));
        assert_eq!(observation.base, None);
        assert_eq!(observation.moved_from, None);
        match observation.now.as_ref().unwrap() {
            Observed::Text(text) => assert_eq!(text.as_bytes(), bytes),
            Observed::Attachment { digest, size, .. } => {
                assert_eq!(*digest, revision(bytes));
                assert_eq!(*size, bytes.len() as u64);
            }
        }
        assert!(
            store.disk_state(path).is_none(),
            "observing alone never ACKs"
        );
        assert_eq!(std::fs::read(root.join(path)).unwrap(), bytes);
    }
    println!(
        "RETAINED_QUEUED_RESCAN=complete; resources=8; io_count={}; qualification=rust-queued-physical-observations-only; root={}",
        ids.len(),
        root.display()
    );
}

fn drive_source<T>(
    mut future: mdbn_replica::store::StoreFuture<'_, T>,
    native: &NativePlatform,
    queue: &HostQueue,
    ids: &mut BTreeSet<OpId>,
) -> mdbn_replica::store::StoreResult<T> {
    let mut cx = std::task::Context::from_waker(std::task::Waker::noop());
    for _ in 0..256 {
        match future.as_mut().poll(&mut cx) {
            Poll::Ready(result) => return result,
            Poll::Pending => {
                let requests = queue.take_requests();
                assert_eq!(requests.len(), 1);
                let (id, op) = requests.into_iter().next().unwrap();
                assert!(ids.insert(id), "original source IO never restarts");
                for _ in 0..3 {
                    assert!(future.as_mut().poll(&mut cx).is_pending());
                    assert!(queue.take_requests().is_empty());
                }
                queue.complete(id, physical(native, op));
            }
        }
    }
    panic!("bounded original source future did not finish");
}

#[test]
fn queued_resource_hooks_retain_original_eight_physical_sources_and_complete_set_fences() {
    // Real Rust FileStore + SQLite + physical files, NOT async publication,
    // TS HostLoop, registry admission, Obsidian or power-loss qualification.
    let (root, native, queue, mut store) = fixture();
    let bundle: Value = serde_json::from_slice(include_bytes!(
        "fixtures/reader-semantic-digests/bundle.json"
    ))
    .unwrap();
    let resources = bundle["resources"].as_array().unwrap();
    assert_eq!(resources.len(), 8);
    for r in resources {
        let path = root.join(r["path"].as_str().unwrap());
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, r["document"].as_str().unwrap()).unwrap();
    }
    let mut ids = BTreeSet::new();
    let original = drive_source(store.observe_async(None), &native, &queue, &mut ids).unwrap();
    assert_eq!(original.len(), 8);
    let mut selected = original.clone();
    for o in &mut selected {
        let expected = resources
            .iter()
            .find(|r| r["path"].as_str() == Some(&o.path))
            .unwrap()["document"]
            .as_str()
            .unwrap();
        // Also proves the retained hooks remain callable through dyn Store.
        let source: &mut dyn Store = &mut store;
        let text = drive_source(
            source.resource_observation_text_async(o, 1024 * 1024),
            &native,
            &queue,
            &mut ids,
        )
        .unwrap()
        .unwrap();
        assert_eq!(text, expected);
        o.now = Some(Observed::Text(text));
    }
    assert!(
        drive_source(
            store.resource_observation_batch_complete_async(&selected),
            &native,
            &queue,
            &mut ids
        )
        .unwrap()
    );
    let before = ids.len();
    assert!(
        !drive_source(
            store.resource_observation_batch_complete_async(&selected[..7]),
            &native,
            &queue,
            &mut ids
        )
        .unwrap()
    );
    assert_eq!(
        ids.len(),
        before + 1,
        "one retained live-source stat prevents prefix acceptance"
    );
    for o in &selected {
        assert!(
            drive_source(
                store.resource_observation_current_async(o),
                &native,
                &queue,
                &mut ids
            )
            .unwrap()
        );
        let original = original.iter().find(|old| old.path == o.path).unwrap();
        assert_eq!(o.token, original.token);
        assert_eq!(o.base, original.base);
        assert_eq!(o.moved_from, original.moved_from);
        assert!(
            store.disk_state(&o.path).is_none(),
            "source verification never ACKs"
        );
        let Some(Observed::Text(text)) = &o.now else {
            panic!("genuine source text required")
        };
        assert_eq!(std::fs::read(root.join(&o.path)).unwrap(), text.as_bytes());
    }
    assert_eq!(queue.in_flight(), 0);
    assert!(queue.take_requests().is_empty());
}

#[test]
fn queued_resource_source_changed_during_original_read_is_not_ready_or_acknowledged() {
    let (root, native, queue, mut store) = fixture();
    let path = "mdbase.yaml";
    std::fs::write(root.join(path), "spec_version: \"0.3.0\"\n").unwrap();
    let mut ids = BTreeSet::new();
    let observations = drive_source(store.observe_async(None), &native, &queue, &mut ids).unwrap();
    assert_eq!(observations.len(), 1);
    let o = &observations[0];
    let mut future = store.resource_observation_text_async(o, 1024 * 1024);
    let mut cx = std::task::Context::from_waker(std::task::Waker::noop());
    assert!(future.as_mut().poll(&mut cx).is_pending());
    let requests = queue.take_requests();
    assert_eq!(requests.len(), 1);
    let (stat_id, stat) = requests.into_iter().next().unwrap();
    assert!(matches!(stat, FileOp::Stat { .. }));
    queue.complete(stat_id, physical(&native, stat));
    assert!(future.as_mut().poll(&mut cx).is_pending());
    let requests = queue.take_requests();
    assert_eq!(requests.len(), 1);
    let (read_id, read) = requests.into_iter().next().unwrap();
    assert!(matches!(read, FileOp::Read { .. }));
    assert_ne!(read_id, stat_id);
    std::fs::write(root.join(path), "changed original physical source\n").unwrap();
    for _ in 0..3 {
        assert!(future.as_mut().poll(&mut cx).is_pending());
        assert!(queue.take_requests().is_empty());
    }
    queue.complete(read_id, physical(&native, read));
    assert!(matches!(
        future.as_mut().poll(&mut cx),
        Poll::Ready(Ok(None))
    ));
    drop(future);
    assert!(store.disk_state(path).is_none());
    assert!(
        !drive_source(
            store.resource_observation_current_async(o),
            &native,
            &queue,
            &mut ids
        )
        .unwrap()
    );
    assert_eq!(queue.in_flight(), 0);
}

#[test]
fn queued_missing_window_starts_after_original_stat_completion() {
    let (root, native, queue, mut store) = fixture();
    std::fs::write(root.join("known.md"), "genuine observed source").unwrap();
    let mut scan = store.start_observe(None);
    let mut ids = BTreeSet::new();
    let mut observed = None;
    for turn in 0..32 {
        match scan.poll(NOW + turn) {
            Poll::Ready(Ok(out)) => {
                observed = Some(out);
                break;
            }
            Poll::Ready(Err(e)) => panic!("initial source refused: {e:?}"),
            Poll::Pending => {
                let (id, op) = pending(&mut scan, &queue, turn, &mut ids);
                queue.complete(id, physical(&native, op));
            }
        }
    }
    let observed = observed.expect("initial physical observation completes");
    assert_eq!(observed.len(), 1);
    drop(scan);
    // FileStore metadata ACK only, not an app receipt/write-read qualification.
    store
        .commit(Tx {
            ack_observations: vec![observed[0].token],
            ..Tx::default()
        })
        .unwrap();
    std::fs::remove_file(root.join("known.md")).unwrap();
    let paths = vec!["known.md".into()];
    let mut scan = store.start_observe(Some(&paths));
    assert!(scan.poll(NOW + 100).is_pending());
    let requests = queue.take_requests();
    assert_eq!(requests.len(), 1);
    assert!(matches!(&requests[0].1, FileOp::Stat { path } if path.as_str() == "known.md"));
    let original = physical(&native, requests[0].1.clone());
    assert!(matches!(&original, Err(e) if e.kind == FsErrorKind::NotFound));
    assert!(scan.poll(NOW + 10_000).is_pending());
    assert!(queue.take_requests().is_empty());
    queue.complete(requests[0].0, original);
    let Poll::Ready(Ok(out)) = scan.poll(NOW + 10_000) else {
        panic!("a slow initial missing stat must not trigger an immediate recheck/delete");
    };
    assert!(out.is_empty());
    assert!(queue.take_requests().is_empty());
    drop(scan);
    assert_eq!(
        store.next_wakeup(),
        Some(NOW + 10_000 + Config::default().missing_recheck_ms)
    );
    assert!(store.disk_state("known.md").is_some());
}

#[test]
fn queued_partial_capture_refusal_reoffers_original_tokens_without_reminting() {
    let (root, native, queue, mut store) = fixture();
    std::fs::write(root.join("a.md"), "first actual source").unwrap();
    std::fs::write(root.join("z.md"), "last actual source").unwrap();
    let mut scan = store.start_observe(None);
    let mut ids = BTreeSet::new();
    let mut refused = false;
    let mut terminal = false;
    for turn in 0..64 {
        match scan.poll(NOW + turn) {
            Poll::Ready(Err(StoreError::Full)) => {
                terminal = true;
                break;
            }
            Poll::Ready(other) => panic!("partial batch must refuse: {other:?}"),
            Poll::Pending => {
                let (id, op) = pending(&mut scan, &queue, turn, &mut ids);
                if matches!(&op, FileOp::Read { path } if path.as_str() == "z.md") {
                    assert!(!refused);
                    refused = true;
                    queue.complete(
                        id,
                        Err(FsError::new(
                            FsErrorKind::NoSpace,
                            "original last-source refusal",
                        )),
                    );
                } else {
                    queue.complete(id, physical(&native, op));
                }
            }
        }
    }
    assert!(terminal && refused);
    drop(scan);
    assert!(store.disk_state("a.md").is_none());
    let mut scan = store.start_observe(None);
    let mut observations = None;
    for turn in 0..64 {
        match scan.poll(NOW + 100 + turn) {
            Poll::Ready(Ok(out)) => {
                observations = Some(out);
                break;
            }
            Poll::Ready(Err(e)) => panic!("corrected source refused: {e:?}"),
            Poll::Pending => {
                let (id, op) = pending(&mut scan, &queue, 100 + turn, &mut ids);
                queue.complete(id, physical(&native, op));
            }
        }
    }
    let observations = observations.expect("corrected real source finishes");
    assert_eq!(observations.len(), 2);
    let first = observations.iter().find(|o| o.path == "a.md").unwrap();
    let last = observations.iter().find(|o| o.path == "z.md").unwrap();
    assert_eq!(first.token.0, 1, "the ORIGINAL captured token is reoffered");
    assert_eq!(
        last.token.0, 2,
        "a pending/error path must not remint first source"
    );
    assert_eq!(
        first.now,
        Some(Observed::Text("first actual source".into()))
    );
    assert_eq!(last.now, Some(Observed::Text("last actual source".into())));
    assert_eq!(queue.in_flight(), 0);
}

#[test]
fn queued_scan_captures_caller_paths_before_original_io() {
    let (root, native, queue, mut store) = fixture();
    std::fs::write(root.join("selected.md"), "original selection").unwrap();
    std::fs::write(root.join("other.md"), "not selected").unwrap();
    let mut paths = vec!["selected.md".into()];
    let mut scan = store.start_observe(Some(&paths));
    paths[0] = "other.md".into();
    let mut ids = BTreeSet::new();
    let mut observations = None;
    for turn in 0..32 {
        match scan.poll(NOW + turn) {
            Poll::Ready(Ok(out)) => {
                observations = Some(out);
                break;
            }
            Poll::Ready(Err(e)) => panic!("selected scan refused: {e:?}"),
            Poll::Pending => {
                let (id, op) = pending(&mut scan, &queue, turn, &mut ids);
                queue.complete(id, physical(&native, op));
            }
        }
    }
    let observations = observations.expect("captured original path finishes");
    assert_eq!(observations.len(), 1);
    assert_eq!(observations[0].path, "selected.md");
    assert_eq!(
        observations[0].now,
        Some(Observed::Text("original selection".into()))
    );
}

#[test]
fn queued_failed_walk_retains_rescan_and_delivers_original_failure_once() {
    let (root, native, queue, mut store) = fixture();
    std::fs::write(root.join("real.md"), "actual source").unwrap();
    let mut scan = store.start_observe(None);
    assert!(scan.poll(NOW).is_pending());
    let requests = queue.take_requests();
    assert_eq!(requests.len(), 1);
    assert!(matches!(requests[0].1, FileOp::List { .. }));
    queue.complete(
        requests[0].0,
        Err(FsError::new(
            FsErrorKind::NoSpace,
            "original host walk refusal",
        )),
    );
    assert!(matches!(
        scan.poll(NOW + 1),
        Poll::Ready(Err(StoreError::Full))
    ));
    assert!(matches!(scan.poll(NOW + 2), Poll::Ready(Err(_))));
    drop(scan);
    assert_eq!(queue.in_flight(), 0);
    let mut scan = store.start_observe(None);
    let mut ids = BTreeSet::new();
    let mut result = None;
    for turn in 0..32 {
        match scan.poll(NOW + 10 + turn) {
            Poll::Ready(Ok(observations)) => {
                result = Some(observations);
                break;
            }
            Poll::Ready(Err(e)) => panic!("corrected host source refused: {e:?}"),
            Poll::Pending => {
                let (id, op) = pending(&mut scan, &queue, 10 + turn, &mut ids);
                queue.complete(id, physical(&native, op));
            }
        }
    }
    let observations = result.expect("original Rescan obligation still runs");
    assert_eq!(observations.len(), 1);
    assert_eq!(observations[0].path, "real.md");
    assert_eq!(
        observations[0].now,
        Some(Observed::Text("actual source".into()))
    );
}
