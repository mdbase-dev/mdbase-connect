//! Synthetic, transport-free finalizer workloads. Never opens a user's collection.
use super::*;
use std::time::Instant;

include!("batching_tests.rs");
include!("fairness_performance.rs");

struct Fixture {
    registry: CollectionRegistry,
    collection: CollectionSummary,
    executor: Arc<CollectionExecutor>,
    directory: tempfile::TempDir,
}

impl Fixture {
    fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let registry = CollectionRegistry::open(directory.path().join("state")).unwrap();
        let collection = registry
            .create(directory.path().join("notes"), Some("Synthetic"), "UTC")
            .unwrap();
        let executor = registry.executor_for(&collection).unwrap();
        Self {
            registry,
            collection,
            executor,
            directory,
        }
    }

    fn enqueue(&self, count: usize) {
        // Unacknowledged canonical mutations are capped at 128 by mdbase-rs.
        // External observations can legitimately span multiple 256-event pages.
        // Reconcile each write so the fixture contains one provider event per file,
        // independent of OS watcher coalescing. Setup is outside measured time.
        let cancellation = mdbase::OperationCancellation::new();
        for index in 0..count {
            std::fs::write(
                Path::new(&self.collection.path).join(format!("record-{index:05}.md")),
                format!("---\ntitle: Record {index}\n---\n"),
            )
            .unwrap();
            self.registry
                .synchronize_runtime(self.collection.id, &cancellation)
                .unwrap();
        }
    }

    fn drain(&self) -> Vec<(mdbase::watch::WatchEvent, u64)> {
        self.registry
            .finalize_runtime_changes(self.collection.id, &mdbase::OperationCancellation::new())
            .unwrap()
    }
}

fn enqueue(registry: &CollectionRegistry, collection_id: Uuid, count: usize) {
    for index in 0..count {
        let output = registry
            .operation(
                collection_id,
                "create",
                &json!({
                    "path": format!("record-{index:05}.md"),
                    "frontmatter": {"title": format!("Record {index}")},
                }),
            )
            .unwrap();
        assert_eq!(output["valid"], true);
    }
}

fn assert_ordered(events: &[(mdbase::watch::WatchEvent, u64)], start: usize, count: usize) {
    assert_eq!(events.len(), count);
    for (index, (event, cursor)) in events.iter().enumerate() {
        assert_eq!(*cursor, (start + index + 1) as u64);
        assert_eq!(event.event_type, "mdbase.record.created");
        assert_eq!(
            event.payload["path"],
            format!("record-{:05}.md", start + index)
        );
    }
}

#[test]
#[ignore = "synthetic multi-page workload can exceed provider deadlines on saturated CI hosts"]
fn benchmark_finalizer_consumes_full_pages_once_and_preserves_order() {
    let fixture = Fixture::new();
    fixture.enqueue(257);
    assert_ordered(&fixture.drain(), 0, 257);
    // Two populated pages plus the empty read establishing that the feed drained.
    assert_eq!(*fixture.executor.feed_read_work.lock().unwrap(), (3, 257));
    assert!(fixture.drain().is_empty());
    assert_eq!(*fixture.executor.feed_read_work.lock().unwrap(), (4, 257));
}

#[test]
fn finalizer_mid_page_failure_leaves_later_events_unacknowledged() {
    let fixture = Fixture::new();
    enqueue(&fixture.registry, fixture.collection.id, 5);
    fixture
        .registry
        .connection()
        .unwrap()
        .execute_batch(
            "CREATE TRIGGER fail_third_change BEFORE INSERT ON collection_changes
         WHEN NEW.cursor = 3 BEGIN SELECT RAISE(ABORT, 'injected append failure'); END;",
        )
        .unwrap();
    assert!(fixture
        .registry
        .finalize_runtime_changes(fixture.collection.id, &mdbase::OperationCancellation::new(),)
        .is_err());
    let context = runtime_context(&mdbase::OperationCancellation::new());
    let remaining = fixture.executor.read_change_events(None, &context).unwrap();
    assert_eq!(remaining.events.len(), 3);
    fixture
        .registry
        .connection()
        .unwrap()
        .execute_batch("DROP TRIGGER fail_third_change;")
        .unwrap();
    assert_ordered(&fixture.drain(), 2, 3);
    assert!(fixture.drain().is_empty());
    let public = fixture
        .registry
        .changes(fixture.collection.id, &json!({"after": 0}))
        .unwrap();
    assert_eq!(public.events.len(), 5);
    assert_eq!(
        public
            .events
            .iter()
            .map(|event| event.cursor)
            .collect::<Vec<_>>(),
        vec![1, 2, 3, 4, 5]
    );
}

#[test]
#[ignore = "synthetic performance observation; run optimized and single-threaded"]
fn benchmark_finalizer_cold_open_interference() {
    use std::sync::Barrier;

    const COLD_RECORDS: usize = 2000;
    const WARM_READS: usize = 100;
    for round in 0..rounds() {
        let directory = tempfile::tempdir().unwrap();
        let registry = CollectionRegistry::open(directory.path().join("state")).unwrap();
        let warm = registry
            .create(directory.path().join("warm"), Some("Warm"), "UTC")
            .unwrap();
        let cold = registry
            .create(directory.path().join("cold"), Some("Cold"), "UTC")
            .unwrap();
        enqueue(&registry, warm.id, 1);
        registry
            .finalize_runtime_changes(warm.id, &mdbase::OperationCancellation::new())
            .unwrap();
        registry.shutdown_runtimes();
        for index in 0..COLD_RECORDS {
            std::fs::write(
                Path::new(&cold.path).join(format!("record-{index:05}.md")),
                format!("---\ntitle: Record {index}\n---\n"),
            )
            .unwrap();
        }
        let read_warm = || {
            let output = registry
                .operation(warm.id, "read", &json!({"path": "record-00000.md"}))
                .unwrap();
            assert_eq!(output["valid"], true);
        };
        read_warm();
        assert_eq!(registry.resident_collection_ids().unwrap(), vec![warm.id]);
        let baseline = Instant::now();
        for _ in 0..WARM_READS {
            read_warm();
        }
        let baseline = baseline.elapsed();
        let barrier = Arc::new(Barrier::new(2));
        let cold_worker = {
            let registry = registry.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                let started = Instant::now();
                let output = registry
                    .operation(cold.id, "query", &json!({"limit": 1}))
                    .unwrap();
                let elapsed = started.elapsed();
                assert_eq!(output["valid"], true);
                elapsed
            })
        };
        barrier.wait();
        let mut warm_samples = Vec::with_capacity(WARM_READS);
        for _ in 0..WARM_READS {
            let started = Instant::now();
            read_warm();
            warm_samples.push(started.elapsed().as_secs_f64() * 1000.0);
        }
        let cold_elapsed = cold_worker.join().unwrap();
        warm_samples.sort_by(f64::total_cmp);
        emit(
            "cold_open_interference",
            round,
            json!({
                "cold_records": COLD_RECORDS,
                "warm_reads": WARM_READS,
                "baseline_warm_total_ms": baseline.as_secs_f64() * 1000.0,
                "contended_warm_total_ms": warm_samples.iter().sum::<f64>(),
                "contended_warm_p95_ms": warm_samples[94],
                "contended_warm_max_ms": warm_samples[99],
                "cold_query_ms": cold_elapsed.as_secs_f64() * 1000.0,
            }),
        );
        registry.shutdown_runtimes();
    }
}

fn rounds() -> usize {
    let rounds = std::env::var("MDBASE_FINALIZER_BENCH_ROUNDS")
        .map(|value| value.parse::<usize>().expect("rounds must be an integer"))
        .unwrap_or(3);
    assert!(rounds > 0, "rounds must be positive");
    rounds
}

fn emit(name: &str, round: usize, measurements: Value) {
    println!(
        "FINALIZER_BENCH {}",
        json!({
            "schema_version": 1,
            "name": name,
            "round": round,
            "connect_version": env!("CARGO_PKG_VERSION"),
            "os": std::env::consts::OS,
            "arch": std::env::consts::ARCH,
            "measurements": measurements,
        })
    );
}

#[test]
#[ignore = "synthetic performance observation; run optimized and single-threaded"]
fn benchmark_finalizer_backlog() {
    for count in [1, 256, 257, 1024] {
        for round in 0..rounds() {
            let fixture = Fixture::new();
            fixture.enqueue(count);
            let started = Instant::now();
            let events = fixture.drain();
            let elapsed = started.elapsed();
            assert_ordered(&events, 0, count);
            let (page_reads, events_loaded) = *fixture.executor.feed_read_work.lock().unwrap();
            assert_eq!(page_reads, count.div_ceil(256) + 1);
            assert_eq!(events_loaded, count);
            emit(
                "backlog_drain",
                round,
                json!({
                    "events": count,
                    "elapsed_ms": elapsed.as_secs_f64() * 1000.0,
                    "events_per_second": count as f64 / elapsed.as_secs_f64(),
                    "page_reads": page_reads,
                    "events_loaded": events_loaded,
                }),
            );
            assert!(fixture.drain().is_empty());
        }
    }
}

#[test]
#[ignore = "synthetic performance observation; run optimized and single-threaded"]
fn benchmark_finalizer_multi_collection() {
    for round in 0..rounds() {
        let fixture = Fixture::new();
        let quiet = fixture
            .registry
            .create(fixture.directory.path().join("quiet"), Some("Quiet"), "UTC")
            .unwrap();
        let quiet_executor = fixture.registry.executor_for(&quiet).unwrap();
        fixture.enqueue(257);
        enqueue(&fixture.registry, quiet.id, 1);
        let started = Instant::now();
        let busy_events = fixture.drain();
        let busy_elapsed = started.elapsed();
        // Model the process-wide finalizer's serial drain order explicitly.
        let quiet_started = Instant::now();
        let quiet_events = fixture
            .registry
            .finalize_runtime_changes(quiet.id, &mdbase::OperationCancellation::new())
            .unwrap();
        let quiet_service = quiet_started.elapsed();
        let quiet_completion = started.elapsed();
        assert_ordered(&busy_events, 0, 257);
        assert_ordered(&quiet_events, 0, 1);
        assert_eq!(*fixture.executor.feed_read_work.lock().unwrap(), (3, 257));
        assert_eq!(*quiet_executor.feed_read_work.lock().unwrap(), (2, 1));
        emit(
            "serial_multi_collection_drain",
            round,
            json!({
                "collections": 2,
                "busy_events": 257,
                "quiet_events": 1,
                "busy_drain_ms": busy_elapsed.as_secs_f64() * 1000.0,
                "quiet_service_ms": quiet_service.as_secs_f64() * 1000.0,
                "quiet_completion_ms": quiet_completion.as_secs_f64() * 1000.0,
            }),
        );
    }
}

#[test]
#[ignore = "synthetic performance observation; run optimized and single-threaded"]
fn benchmark_finalizer_idle_poll() {
    for count in [1, 8] {
        for round in 0..rounds() {
            let fixture = Fixture::new();
            for index in 1..count {
                fixture
                    .registry
                    .create(
                        fixture.directory.path().join(format!("idle-{index}")),
                        Some("Idle"),
                        "UTC",
                    )
                    .unwrap();
            }
            let collections = fixture.registry.resident_collection_ids().unwrap();
            assert_eq!(collections.len(), count);
            let cancellation = mdbase::OperationCancellation::new();
            // Twenty passes represent one second's nominal 50 ms poll cadence.
            // No sleeps: report work time rather than timer/scheduler latency.
            let started = Instant::now();
            for _ in 0..20 {
                for id in fixture.registry.resident_collection_ids().unwrap() {
                    assert!(!fixture
                        .registry
                        .ingest_runtime_external(id, Duration::ZERO, &cancellation,)
                        .unwrap());
                }
            }
            emit(
                "idle_poll_work",
                round,
                json!({
                    "collections": count,
                    "passes": 20,
                    "ingestions": count * 20,
                    "elapsed_ms": started.elapsed().as_secs_f64() * 1000.0,
                }),
            );
        }
    }
}
