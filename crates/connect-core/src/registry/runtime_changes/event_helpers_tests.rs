impl CollectionRegistry {
    fn append_runtime_change(
        &self,
        collection_id: Uuid,
        receipt_key: &str,
        runtime_event: &RuntimeChangeEvent,
        events: &[mdbase::watch::WatchEvent],
    ) -> Result<(Vec<mdbase::watch::WatchEvent>, Vec<u64>), ConnectError> {
        self.append_runtime_change_in(
            &mut self.connection()?,
            collection_id,
            receipt_key,
            runtime_event,
            events,
        )
    }
}

fn collect_external_events(
    registry: &CollectionRegistry,
    collection_id: Uuid,
    expected: usize,
) -> Vec<(mdbase::watch::WatchEvent, u64)> {
    let cancellation = mdbase::OperationCancellation::new();
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut events = Vec::new();
    while events.len() < expected && Instant::now() < deadline {
        registry
            .ingest_runtime_external(collection_id, Duration::from_millis(100), &cancellation)
            .unwrap();
        events.extend(
            registry
                .finalize_runtime_changes(collection_id, &cancellation)
                .unwrap(),
        );
    }
    assert_eq!(
        events.len(),
        expected,
        "timed out waiting for watcher events"
    );
    events
}

fn assert_runtime_feed_quiet(registry: &CollectionRegistry, collection_id: Uuid) {
    let cancellation = mdbase::OperationCancellation::new();
    assert!(!registry
        .ingest_runtime_external(collection_id, Duration::from_millis(200), &cancellation)
        .unwrap());
    assert!(registry
        .finalize_runtime_changes(collection_id, &cancellation)
        .unwrap()
        .is_empty());
}

fn event_paths(
    events: &[(mdbase::watch::WatchEvent, u64)],
) -> BTreeSet<(String, String, Option<String>)> {
    events
        .iter()
        .map(|(event, _)| {
            (
                event.event_type.clone(),
                event
                    .payload
                    .get("path")
                    .or_else(|| event.payload.get("to"))
                    .and_then(Value::as_str)
                    .expect("record event has path or rename target")
                    .to_string(),
                event.payload["from"].as_str().map(str::to_string),
            )
        })
        .collect()
}
