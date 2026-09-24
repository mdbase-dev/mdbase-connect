use super::*;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
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
    let (entered, entry) = mpsc::sync_channel(1);
    let (release, wait) = mpsc::sync_channel(1);
    let wait = Mutex::new(wait);
    let arm = armed.clone();
    // Test barrier at the installed-runtime boundary, before map publication.
    registry.set_runtime_waker(Arc::new(move || {
        if arm.swap(false, Ordering::AcqRel) {
            entered.send(()).unwrap();
            wait.lock().unwrap().recv().unwrap();
        }
    }));
    armed.store(true, Ordering::Release);
    let opening = {
        let registry = registry.clone();
        std::thread::spawn(move || registry.executor_for(&cold).map(|_| ()))
    };
    entry.recv_timeout(Duration::from_secs(5)).unwrap();
    assert!(registry.executors.try_lock().is_ok());
    let (read_done, read_result) = mpsc::sync_channel(1);
    let reader = {
        let registry = registry.clone();
        std::thread::spawn(move || {
            read_done
                .send(registry.executor_for(&warm).map(|_| ()))
                .unwrap()
        })
    };
    let warm_result = read_result.recv_timeout(Duration::from_secs(2));
    let (stopped, stop_result) = mpsc::sync_channel(1);
    let shutdown = {
        let registry = registry.clone();
        std::thread::spawn(move || {
            registry.shutdown_runtimes();
            stopped.send(()).unwrap();
        })
    };
    assert!(stop_result.try_recv().is_err());
    release.send(()).unwrap();
    warm_result.unwrap().unwrap();
    reader.join().unwrap();
    opening.join().unwrap().unwrap();
    stop_result.recv_timeout(Duration::from_secs(5)).unwrap();
    shutdown.join().unwrap();
    assert!(registry.resident_collection_ids().unwrap().is_empty());
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
