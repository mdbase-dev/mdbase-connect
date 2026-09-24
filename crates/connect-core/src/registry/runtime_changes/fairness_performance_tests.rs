#[test]
#[ignore = "synthetic performance observation; run optimized and single-threaded"]
fn benchmark_finalizer_fair_turns() {
    for round in 0..rounds() {
        let fixture = Fixture::new();
        let quiet = fixture
            .registry
            .create(fixture.directory.path().join("quiet"), Some("Quiet"), "UTC")
            .unwrap();
        fixture.enqueue(257);
        enqueue(&fixture.registry, quiet.id, 1);
        let cancellation = mdbase::OperationCancellation::new();
        let start = Instant::now();
        let first = fixture
            .registry
            .finalize_runtime_turn(fixture.collection.id, None, &cancellation)
            .unwrap();
        assert!(!first.complete);
        let mut busy_events = first.events;
        let quiet_start = Instant::now();
        let quiet_turn = fixture
            .registry
            .finalize_runtime_turn(quiet.id, None, &cancellation)
            .unwrap();
        let quiet_service = quiet_start.elapsed();
        let quiet_completion = start.elapsed();
        assert!(quiet_turn.complete);
        assert_ordered(&quiet_turn.events, 0, 1);
        loop {
            let turn = fixture
                .registry
                .finalize_runtime_turn(fixture.collection.id, Some(first.target), &cancellation)
                .unwrap();
            busy_events.extend(turn.events);
            if turn.complete {
                break;
            }
        }
        assert_ordered(&busy_events, 0, 257);
        emit(
            "fair_multi_collection_drain",
            round,
            json!({
                "busy_events":257,"quiet_events":1,"quiet_service_ms":quiet_service.as_secs_f64()*1000.0,
                "quiet_completion_ms":quiet_completion.as_secs_f64()*1000.0,
                "total_drain_ms":start.elapsed().as_secs_f64()*1000.0,
            }),
        );
    }
}
