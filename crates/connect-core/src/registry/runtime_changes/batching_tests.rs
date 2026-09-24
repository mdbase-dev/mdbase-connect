#[test]
fn batching_settles_only_successful_prefix_at_every_batch_boundary() {
    for failed_cursor in [1, 3, 16, 17, 33] {
        let fixture = Fixture::new();
        enqueue(&fixture.registry, fixture.collection.id, 40);
        fixture.registry.connection().unwrap().execute_batch(&format!(
            "CREATE TRIGGER fail_change BEFORE INSERT ON collection_changes WHEN NEW.cursor = {failed_cursor} BEGIN SELECT RAISE(ABORT, 'injected'); END;"
        )).unwrap();
        assert!(fixture
            .registry
            .finalize_runtime_changes(fixture.collection.id, &mdbase::OperationCancellation::new())
            .is_err());
        let remaining = fixture
            .executor
            .read_change_events(
                None,
                &runtime_context(&mdbase::OperationCancellation::new()),
            )
            .unwrap();
        assert_eq!(remaining.events.len(), 41 - failed_cursor);
        fixture
            .registry
            .connection()
            .unwrap()
            .execute_batch("DROP TRIGGER fail_change")
            .unwrap();
        assert_ordered(&fixture.drain(), failed_cursor - 1, 41 - failed_cursor);
        assert!(fixture.drain().is_empty());
        let changes = fixture
            .registry
            .changes(fixture.collection.id, &json!({"after":0}))
            .unwrap();
        assert_eq!(changes.events.len(), 40);
    }
}

#[test]
fn acknowledgement_before_cleanup_failure_is_recovered_without_duplicate_changes() {
    let fixture = Fixture::new();
    enqueue(&fixture.registry, fixture.collection.id, 20);
    fixture.registry.connection().unwrap().execute_batch(
        "CREATE TRIGGER fail_cleanup BEFORE DELETE ON settings WHEN OLD.key GLOB 'runtime_change_receipt:*' BEGIN SELECT RAISE(ABORT, 'injected'); END;"
    ).unwrap();
    assert!(fixture
        .registry
        .finalize_runtime_changes(fixture.collection.id, &mdbase::OperationCancellation::new())
        .is_err());
    let remaining = fixture
        .executor
        .read_change_events(
            None,
            &runtime_context(&mdbase::OperationCancellation::new()),
        )
        .unwrap();
    assert_eq!(remaining.events.len(), 4);
    fixture
        .registry
        .connection()
        .unwrap()
        .execute_batch("DROP TRIGGER fail_cleanup")
        .unwrap();
    assert_ordered(&fixture.drain(), 16, 4);
    let receipts: u64 = fixture
        .registry
        .connection()
        .unwrap()
        .query_row(
            "SELECT count(*) FROM settings WHERE key GLOB 'runtime_change_receipt:*'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(receipts, 0);
    assert_eq!(
        fixture
            .registry
            .changes(fixture.collection.id, &json!({"after":0}))
            .unwrap()
            .events
            .len(),
        20
    );
}

#[test]
fn acknowledgement_fencing_retains_receipts_and_restart_replays_without_duplicates() {
    let fixture = Fixture::new();
    enqueue(&fixture.registry, fixture.collection.id, 32);
    fixture.registry.connection().unwrap().execute_batch(
        "CREATE TRIGGER slow_append AFTER INSERT ON collection_changes BEGIN
         SELECT sum(x) FROM (WITH RECURSIVE delay(x) AS (VALUES(0) UNION ALL SELECT x+1 FROM delay WHERE x<200000) SELECT x FROM delay);
         END;"
    ).unwrap();
    let fencing = {
        let registry = fixture.registry.clone();
        let runtime = fixture.executor.runtime().unwrap();
        let id = fixture.collection.id;
        std::thread::spawn(move || {
            let connection = registry.connection().unwrap();
            let deadline = Instant::now() + Duration::from_secs(10);
            loop {
                let count: u64 = connection
                    .query_row("SELECT count(*) FROM collection_changes", [], |row| {
                        row.get(0)
                    })
                    .unwrap();
                if count > 0 {
                    break;
                }
                assert!(Instant::now() < deadline);
                std::thread::sleep(Duration::from_millis(1));
            }
            let owner: String = connection
                .query_row(
                    "SELECT value FROM settings WHERE key=?1",
                    [format!("runtime_feed_owner:{id}")],
                    |row| row.get(0),
                )
                .unwrap();
            let owner: mdbase::runtime::ChangeFeedOwnerId =
                serde_json::from_value(json!(owner)).unwrap();
            runtime
                .open_change_feed(
                    &owner,
                    &runtime_context(&mdbase::OperationCancellation::new()),
                )
                .unwrap();
        })
    };
    assert!(fixture
        .registry
        .finalize_runtime_changes(fixture.collection.id, &mdbase::OperationCancellation::new())
        .is_err());
    fencing.join().unwrap();
    fixture
        .registry
        .connection()
        .unwrap()
        .execute_batch("DROP TRIGGER slow_append")
        .unwrap();
    let receipts: u64 = fixture
        .registry
        .connection()
        .unwrap()
        .query_row(
            "SELECT count(*) FROM settings WHERE key GLOB 'runtime_change_receipt:*'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert!(receipts > 0);
    fixture.registry.shutdown_runtimes();
    assert_ordered(&fixture.drain(), 0, 32);
    assert_eq!(
        fixture
            .registry
            .changes(fixture.collection.id, &json!({"after":0}))
            .unwrap()
            .events
            .len(),
        32
    );
}

#[test]
fn bounded_turn_pins_its_head_and_new_mutations_do_not_extend_the_barrier() {
    let fixture = Fixture::new();
    enqueue(&fixture.registry, fixture.collection.id, 32);
    let mut turn = fixture
        .registry
        .finalize_runtime_turn(
            fixture.collection.id,
            None,
            &mdbase::OperationCancellation::new(),
        )
        .unwrap();
    let target = turn.target;
    assert_eq!(target, 32);
    assert!(!turn.complete);
    assert!(turn.events.len() <= 16);
    fixture
        .registry
        .operation(
            fixture.collection.id,
            "create",
            &json!({"path":"later.md", "frontmatter":{"title":"Later"}}),
        )
        .unwrap();
    let mut events = turn.events;
    loop {
        turn = fixture
            .registry
            .finalize_runtime_turn(
                fixture.collection.id,
                Some(target),
                &mdbase::OperationCancellation::new(),
            )
            .unwrap();
        assert_eq!(turn.target, target);
        assert!(turn.events.len() <= 16);
        events.extend(turn.events);
        if turn.complete {
            break;
        }
    }
    assert_ordered(&events, 0, 32);
    let later = fixture.drain();
    assert_eq!(later.len(), 1);
    assert_eq!(later[0].0.payload["path"], "later.md");
}

#[test]
fn failed_admission_replays_the_same_cursors_before_feed_acknowledgement() {
    let fixture = Fixture::new();
    enqueue(&fixture.registry, fixture.collection.id, 32);
    let cancellation = mdbase::OperationCancellation::new();
    let mut admitted = std::collections::BTreeSet::new();
    let first = fixture.registry.finalize_runtime_turn_delivering(
        fixture.collection.id,
        None,
        &cancellation,
        false,
        |events| {
            admitted.insert(events[0].1);
            Err(ConnectError::CollectionOpen(
                "injected partial admission failure".into(),
            ))
        },
    );
    assert!(first.is_err());
    assert_eq!(
        fixture
            .executor
            .read_change_events(None, &runtime_context(&cancellation))
            .unwrap()
            .events
            .len(),
        32
    );
    let mut replay = Vec::new();
    let mut duplicates = 0;
    loop {
        let turn = fixture
            .registry
            .finalize_runtime_turn_delivering(
                fixture.collection.id,
                None,
                &cancellation,
                false,
                |events| {
                    for (_, cursor) in events {
                        if !admitted.insert(*cursor) {
                            duplicates += 1;
                        }
                    }
                    Ok(())
                },
            )
            .unwrap();
        replay.extend(turn.events);
        if turn.complete {
            break;
        }
    }
    assert_eq!(duplicates, 1);
    assert_eq!(admitted.len(), 32);
    assert_ordered(&replay, 0, 32);
    assert_eq!(
        fixture
            .registry
            .changes(fixture.collection.id, &json!({"after":0}))
            .unwrap()
            .events
            .len(),
        32
    );
}

#[test]
fn cancellation_during_append_settles_exactly_the_durable_prefix() {
    let fixture = Fixture::new();
    enqueue(&fixture.registry, fixture.collection.id, 32);
    // Widen the cancellation window without a production hook or weakening
    // durability: the trigger is part of the real append transaction.
    fixture.registry.connection().unwrap().execute_batch(
        "CREATE TRIGGER slow_append AFTER INSERT ON collection_changes BEGIN
         SELECT sum(x) FROM (WITH RECURSIVE delay(x) AS (VALUES(0) UNION ALL SELECT x+1 FROM delay WHERE x<200000) SELECT x FROM delay);
         END;"
    ).unwrap();
    let cancellation = mdbase::OperationCancellation::new();
    let cancelling = {
        let registry = fixture.registry.clone();
        let cancellation = cancellation.clone();
        std::thread::spawn(move || {
            let connection = registry.connection().unwrap();
            let deadline = Instant::now() + Duration::from_secs(10);
            loop {
                let count: u64 = connection
                    .query_row("SELECT count(*) FROM collection_changes", [], |row| {
                        row.get(0)
                    })
                    .unwrap();
                if count > 0 {
                    cancellation.cancel();
                    return;
                }
                assert!(Instant::now() < deadline);
                std::thread::sleep(Duration::from_millis(1));
            }
        })
    };
    let result = fixture
        .registry
        .finalize_runtime_changes(fixture.collection.id, &cancellation);
    cancelling.join().unwrap();
    assert!(result.is_err());
    let published: usize = fixture
        .registry
        .connection()
        .unwrap()
        .query_row("SELECT count(*) FROM collection_changes", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert!((1..32).contains(&published));
    let remaining = fixture
        .executor
        .read_change_events(
            None,
            &runtime_context(&mdbase::OperationCancellation::new()),
        )
        .unwrap();
    assert_eq!(remaining.events.len(), 32 - published);
    fixture
        .registry
        .connection()
        .unwrap()
        .execute_batch("DROP TRIGGER slow_append")
        .unwrap();
    assert_ordered(&fixture.drain(), published, 32 - published);
}

#[test]
fn cancelled_finalization_does_not_acknowledge_unpersisted_events() {
    let fixture = Fixture::new();
    enqueue(&fixture.registry, fixture.collection.id, 5);
    let cancellation = mdbase::OperationCancellation::new();
    cancellation.cancel();
    assert!(fixture
        .registry
        .finalize_runtime_changes(fixture.collection.id, &cancellation)
        .is_err());
    assert_ordered(&fixture.drain(), 0, 5);
}
