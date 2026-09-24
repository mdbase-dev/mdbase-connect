#[test]
fn finalizer_serves_a_quiet_collection_before_a_busy_feed_drains() {
    let root = tempfile::tempdir().unwrap();
    let registry = CollectionRegistry::open(root.path().join("state")).unwrap();
    let mut collections = [
        registry.create(root.path().join("a"), None, "UTC").unwrap(),
        registry.create(root.path().join("b"), None, "UTC").unwrap(),
    ];
    collections.sort_by_key(|collection| collection.id);
    let busy = &collections[0];
    let quiet = &collections[1];
    for index in 0..80 {
        registry
            .operation(
                busy.id,
                "create",
                &serde_json::json!({"path":format!("busy-{index:03}.md"),"frontmatter":{}}),
            )
            .unwrap();
    }
    registry
        .operation(
            quiet.id,
            "create",
            &serde_json::json!({"path":"quiet.md","frontmatter":{}}),
        )
        .unwrap();
    let (sender, mut receiver) = tokio::sync::mpsc::channel(256);
    let service = CollectionWatchService::start_with_runtime_events(registry.clone(), Some(sender));
    // Startup discovers registered residents. Start consuming immediately:
    // barriers require the independent durable-admission worker to be running.
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    let mut busy_seen = 0;
    let mut quiet_seen = false;
    while busy_seen < 80 || !quiet_seen {
        assert!(
            std::time::Instant::now() < deadline,
            "finalizer did not drain both collections"
        );
        match receiver.try_recv() {
            Ok(delivery) => {
                delivery.admitted.send(Ok(())).unwrap();
                let event = delivery.change;
                if event.collection_id == quiet.id {
                    assert!(
                        busy_seen < 80,
                        "quiet collection waited behind the entire busy backlog"
                    );
                    quiet_seen = true;
                } else {
                    assert_eq!(event.collection_id, busy.id);
                    busy_seen += 1;
                    assert_eq!(event.cursor, busy_seen);
                }
            }
            Err(tokio::sync::mpsc::error::TryRecvError::Empty) => {
                std::thread::sleep(Duration::from_millis(1))
            }
            Err(error) => panic!("event channel closed: {error}"),
        }
    }
    drop(service);
}

#[test]
fn shutdown_interrupts_notification_channel_backpressure() {
    let root = tempfile::tempdir().unwrap();
    let registry = CollectionRegistry::open(root.path().join("state")).unwrap();
    let collection = registry
        .create(root.path().join("notes"), None, "UTC")
        .unwrap();
    for index in 0..20 {
        registry
            .operation(
                collection.id,
                "create",
                &serde_json::json!({"path":format!("note-{index}.md"),"frontmatter":{}}),
            )
            .unwrap();
    }
    let (sender, _receiver) = tokio::sync::mpsc::channel(1);
    let service =
        CollectionWatchService::start_with_runtime_events(registry.clone(), Some(sender.clone()));
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while sender.capacity() != 0 {
        assert!(std::time::Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(1));
    }
    let (stopped, receiver) = mpsc::sync_channel(1);
    let thread = std::thread::spawn(move || {
        drop(service);
        stopped.send(()).unwrap();
    });
    receiver
        .recv_timeout(Duration::from_secs(5))
        .expect("shutdown waited for the stalled admission receiver");
    thread.join().unwrap();
    // The queued event was never durably admitted. All provider events remain
    // replayable, including the prefix already appended to public changes.
    let replay = registry
        .finalize_runtime_changes(collection.id, &mdbase::OperationCancellation::new())
        .unwrap();
    assert_eq!(replay.len(), 20);
    assert_eq!(
        registry
            .changes(collection.id, &serde_json::json!({"after":0}))
            .unwrap()
            .events
            .len(),
        20
    );
}
