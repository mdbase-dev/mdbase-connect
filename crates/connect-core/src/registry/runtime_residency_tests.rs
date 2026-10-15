use super::*;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, OnceLock};
use std::time::Duration;

#[test]
fn cold_initialization_does_not_hold_map_and_shutdown_fences_publication() {
    let root = tempfile::tempdir().unwrap();
    let registry = CollectionRegistry::open(root.path().join("state")).unwrap();
    let warm = registry
        .create(root.path().join("warm"), Some("Warm"), "UTC")
        .unwrap();
    let cold = registry
        .create(root.path().join("cold"), Some("Cold"), "UTC")
        .unwrap();
    registry.shutdown_runtimes();
    registry.executor_for(&warm).unwrap();
    let armed = Arc::new(AtomicBool::new(false));
    let opener = Arc::new(OnceLock::<std::thread::ThreadId>::new());
    let cold_thread = opener.clone();
    let (entered, entry) = mpsc::sync_channel(1);
    let (release, wait) = mpsc::sync_channel(1);
    let wait = Mutex::new(wait);
    let arm = armed.clone();
    // Only the cold opener's synchronous installation wake is this boundary.
    // Warm/native watcher notifications must not consume or block on the gate.
    registry.set_runtime_waker(Arc::new(move || {
        if cold_thread.get() == Some(&std::thread::current().id())
            && arm.swap(false, Ordering::AcqRel)
        {
            entered.send(()).unwrap();
            wait.lock().unwrap().recv().unwrap();
        }
    }));
    armed.store(true, Ordering::Release);
    let (notified, notification) = mpsc::sync_channel(1);
    let unrelated = {
        let registry = registry.clone();
        std::thread::spawn(move || {
            registry.runtime_wakeup.wake();
            notified.send(()).unwrap();
        })
    };
    let notification = notification.recv_timeout(Duration::from_secs(5));
    if notification.is_err() {
        // Release a wrongly captured notifier before reporting the regression.
        release.send(()).unwrap();
    }
    unrelated.join().unwrap();
    notification.expect("unrelated readiness notification consumed the cold-open gate");
    let opening = {
        let registry = registry.clone();
        std::thread::spawn(move || {
            opener.set(std::thread::current().id()).unwrap();
            registry.executor_for(&cold).map(|_| ())
        })
    };
    entry.recv_timeout(Duration::from_secs(5)).unwrap();
    assert!(registry.executors.try_lock().is_ok());
    assert!(matches!(
        registry.runtime_lifecycle.try_lock(),
        Err(std::sync::TryLockError::WouldBlock)
    ));
    let (read_done, read_result) = mpsc::sync_channel(1);
    let reader = {
        let registry = registry.clone();
        std::thread::spawn(move || {
            read_done
                .send(registry.executor_for(&warm).map(|_| ()))
                .unwrap()
        })
    };
    // The cold open is released only after this wait, so a warm read blocked
    // behind it never arrives; the bound only absorbs a loaded runner.
    let warm_result = read_result.recv_timeout(Duration::from_secs(20));
    // This fixture schedules no file warmups (whose drain has its own 30s bound).
    assert!(registry.file_warmups.lock().unwrap().is_empty());
    let (stopping, stop_started) = mpsc::sync_channel(1);
    let (stopped, stop_result) = mpsc::sync_channel(1);
    let shutdown = {
        let registry = registry.clone();
        std::thread::spawn(move || {
            stopping.send(()).unwrap();
            registry.shutdown_runtimes();
            stopped.send(()).unwrap();
        })
    };
    stop_started.recv_timeout(Duration::from_secs(5)).unwrap();
    assert!(matches!(
        stop_result.try_recv(),
        Err(mpsc::TryRecvError::Empty)
    ));
    release.send(()).unwrap();
    warm_result.unwrap().unwrap();
    reader.join().unwrap();
    opening.join().unwrap().unwrap();
    let completion_bound = Duration::from_secs(5);
    // Shutdown's Windows contract allows a separate delete-share wait for EACH
    // root, after the lifecycle fence. Warm+cold can consume 2*5s, so the old
    // 5s total raced legitimate cleanup, even in the isolated CI retry.
    #[cfg(windows)]
    let completion_bound = completion_bound + WINDOWS_DELETE_SHARE_WAIT * 2;
    stop_result.recv_timeout(completion_bound).unwrap();
    shutdown.join().unwrap();
    assert!(registry.resident_collection_ids().unwrap().is_empty());
}

#[cfg(windows)]
#[test]
fn shutdown_waits_for_windows_delete_sharing_after_clearing_residency() {
    use std::os::windows::fs::OpenOptionsExt;
    use windows_sys::Win32::Storage::FileSystem::{FILE_SHARE_READ, FILE_SHARE_WRITE};

    let root = tempfile::tempdir().unwrap();
    let registry = CollectionRegistry::open(root.path().join("state")).unwrap();
    let collection = registry
        .create(root.path().join("notes"), None, "UTC")
        .unwrap();
    // Known fixture handle, not a scheduler delay or an external scanner guess.
    let private = Path::new(&collection.path).join(".mdbase");
    std::fs::create_dir_all(&private).unwrap();
    let path = private.join("delete-share-fixture.lock");
    std::fs::write(&path, b"").unwrap();
    let blocker = std::fs::OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        .open(&path)
        .unwrap();
    assert!(!windows_tree_is_delete_shared(Path::new(&collection.path)));
    let (stopped, result) = mpsc::sync_channel(1);
    let shutdown = {
        let registry = registry.clone();
        std::thread::spawn(move || {
            registry.shutdown_runtimes();
            stopped.send(()).unwrap();
        })
    };
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while !registry.resident_collection_ids().unwrap().is_empty() {
        assert!(
            std::time::Instant::now() < deadline,
            "residency did not clear"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(matches!(
        result.recv_timeout(Duration::from_millis(100)),
        Err(mpsc::RecvTimeoutError::Timeout)
    ));
    drop(blocker);
    result
        .recv_timeout(WINDOWS_DELETE_SHARE_WAIT + Duration::from_secs(5))
        .unwrap();
    shutdown.join().unwrap();
    assert!(windows_tree_is_delete_shared(Path::new(&collection.path)));
}

#[test]
fn stale_cold_registration_cannot_republish_removed_or_disabled_runtime() {
    let root = tempfile::tempdir().unwrap();
    let registry = CollectionRegistry::open(root.path().join("state")).unwrap();
    let collection = registry
        .create(root.path().join("notes"), None, "UTC")
        .unwrap();
    registry.shutdown_runtimes();
    registry.set_enabled(collection.id, false).unwrap();
    assert!(registry.executor_for(&collection).is_err());
    assert!(registry.resident_collection_ids().unwrap().is_empty());
    registry.remove(collection.id).unwrap();
    assert!(registry.executor_for(&collection).is_err());
    assert!(registry.resident_collection_ids().unwrap().is_empty());
}

#[test]
fn concurrent_cold_requests_share_one_executor() {
    let root = tempfile::tempdir().unwrap();
    let registry = CollectionRegistry::open(root.path().join("state")).unwrap();
    let collection = registry
        .create(root.path().join("notes"), None, "UTC")
        .unwrap();
    registry.shutdown_runtimes();
    let barrier = Arc::new(std::sync::Barrier::new(8));
    let jobs: Vec<_> = (0..8)
        .map(|_| {
            let registry = registry.clone();
            let collection = collection.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                registry.executor_for(&collection).unwrap()
            })
        })
        .collect();
    let results: Vec<_> = jobs.into_iter().map(|job| job.join().unwrap()).collect();
    for result in &results {
        assert!(Arc::ptr_eq(&results[0], result));
    }
}
