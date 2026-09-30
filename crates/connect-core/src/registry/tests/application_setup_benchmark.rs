//! Synthetic approval workload: the connector-side work of offering a collection
//! and activating an application that needs contract setup. Never opens a user's
//! collection. The declaration is supplied (for example TaskNotes'
//! `src/generated/mdbase-app.json`) rather than duplicated here.
use super::*;
use std::time::Instant;

fn emit(notes: usize, round: usize, phase: &str, started: Instant) {
    println!(
        "APPLICATION_SETUP_BENCH {}",
        json!({
            "notes": notes,
            "round": round,
            "phase": phase,
            "elapsed_ms": started.elapsed().as_secs_f64() * 1000.0,
        })
    );
}

fn timed<T>(notes: usize, round: usize, phase: &str, work: impl FnOnce() -> T) -> T {
    let started = Instant::now();
    let result = work();
    emit(notes, round, phase, started);
    result
}

/// Connector-side activation as `AuthorizationActivationRequest` performs it,
/// excluding signature and grant bookkeeping that is independent of collection size.
fn activate(
    registry: &CollectionRegistry,
    id: Uuid,
    requirements: &ApplicationRequirements,
    provisions: &ApplicationProvisions,
    notes: usize,
    round: usize,
    label: &str,
) {
    let started = Instant::now();
    timed(notes, round, &format!("{label}.describe_before"), || {
        registry.describe(id).unwrap()
    });
    let setup = timed(notes, round, &format!("{label}.provision"), || {
        registry
            .provision_application_setup(
                id,
                "benchmark.application",
                &format!("sha256:{}", "0".repeat(64)),
                requirements,
                provisions,
                &[],
            )
            .unwrap()
    });
    timed(notes, round, &format!("{label}.finalize"), || {
        registry
            .finalize_runtime_changes(id, &mdbase::OperationCancellation::new())
            .unwrap()
    });
    timed(notes, round, &format!("{label}.describe_after"), || {
        registry.describe(id).unwrap()
    });
    assert!(requirements
        .contracts
        .iter()
        .all(|required| has_contract(&setup.contracts, required)));
    emit(notes, round, &format!("{label}.total"), started);
}

#[test]
#[ignore = "synthetic approval observation; run optimized with MDBASE_APPROVAL_BENCH_MANIFEST"]
fn benchmark_application_setup() {
    let manifest: Value = serde_json::from_slice(
        &std::fs::read(
            std::env::var("MDBASE_APPROVAL_BENCH_MANIFEST")
                .expect("MDBASE_APPROVAL_BENCH_MANIFEST names an application declaration"),
        )
        .unwrap(),
    )
    .unwrap();
    let requirements: ApplicationRequirements =
        serde_json::from_value(manifest["requirements"].clone()).unwrap();
    let provisions: ApplicationProvisions =
        serde_json::from_value(manifest["provisions"].clone()).unwrap();
    let sizes = std::env::var("MDBASE_APPROVAL_BENCH_NOTES")
        .unwrap_or_else(|_| "1000,10000".to_string())
        .split(',')
        .map(|value| {
            value
                .trim()
                .parse::<usize>()
                .expect("note counts are integers")
        })
        .collect::<Vec<_>>();
    let rounds = std::env::var("MDBASE_APPROVAL_BENCH_ROUNDS")
        .map(|value| value.parse::<usize>().expect("rounds must be an integer"))
        .unwrap_or(1);
    let body = "x".repeat(1024);
    for notes in sizes {
        for round in 0..rounds {
            let directory = tempdir().unwrap();
            let registry = CollectionRegistry::open(directory.path().join("state")).unwrap();
            // Users add an existing folder of notes; initialize it after writing them.
            let root = directory.path().join("notes");
            for index in 0..notes {
                let folder = root.join(format!("notes/{:04}", index / 100));
                std::fs::create_dir_all(&folder).unwrap();
                std::fs::write(
                    folder.join(format!("note-{index:08}.md")),
                    format!(
                        "---\nid: bench-{index:08}\ntitle: Synthetic note {index}\ntags: [task]\nstatus: open\npriority: normal\ndateCreated: '2026-01-01T00:00:00Z'\ndateModified: '2026-01-01T00:00:00Z'\n---\n{body}\n"
                    ),
                )
                .unwrap();
            }
            let collection = registry.create(&root, Some("Synthetic"), "UTC").unwrap();
            // A running connector already holds the runtime; exclude its cold open.
            timed(notes, round, "runtime_open", || {
                let cancellation = mdbase::OperationCancellation::new();
                registry
                    .synchronize_runtime(collection.id, &cancellation)
                    .unwrap();
                registry
                    .finalize_runtime_changes(collection.id, &cancellation)
                    .unwrap();
            });
            timed(notes, round, "offer.catalog", || {
                registry.catalog().unwrap()
            });
            activate(
                &registry,
                collection.id,
                &requirements,
                &provisions,
                notes,
                round,
                "first_approval",
            );
            activate(
                &registry,
                collection.id,
                &requirements,
                &provisions,
                notes,
                round,
                "repeat_approval",
            );
            // The application session then verifies its whole declaration on every
            // start, and asks the user to review and apply whatever is not current.
            let session_input = json!({
                "application_id": "benchmark.application",
                "declaration_digest": format!("sha256:{}", "0".repeat(64)),
                "requirements": {"configuration": manifest["requirements"]["configuration"]},
                "provisions": manifest["provisions"],
            });
            let assessed = timed(notes, round, "session.verify", || {
                registry
                    .operation(collection.id, "assess_collection_setup", &session_input)
                    .unwrap()
            });
            assert_eq!(assessed["valid"], true, "{assessed}");
            if assessed["result"]["status"] != "current" {
                let mut apply = session_input.clone();
                apply["expected_assessment_digest"] =
                    assessed["result"]["assessment_digest"].clone();
                apply["expected_collection_revision"] =
                    assessed["result"]["collection_revision"].clone();
                apply["expected_provision_digest"] = assessed["result"]["provision_digest"].clone();
                let applied = timed(notes, round, "session.apply_reviewed", || {
                    registry
                        .operation(collection.id, "apply_collection_setup", &apply)
                        .unwrap()
                });
                assert_eq!(applied["valid"], true, "{applied}");
            }
            let current = timed(notes, round, "session.verify_current", || {
                registry
                    .operation(collection.id, "assess_collection_setup", &session_input)
                    .unwrap()
            });
            assert_eq!(current["result"]["status"], "current", "{current}");
            registry.shutdown_runtimes();
        }
    }
}
