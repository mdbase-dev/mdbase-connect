//! A source-chase regression: freezing an existing folder must capture its
//! original records/config, not only previously indexed or session-authored data.
#![allow(clippy::disallowed_methods, clippy::disallowed_types)]

use mdbn_daemon::runtime::{Runtime, RuntimeConfig};
use mdbn_replica::DeviceSecrets;
use mdbn_wire::common::B16;

struct NoAuthority;
impl mdbn_replica::policy::GrantSource for NoAuthority {
    fn grant(&self, _: &B16) -> Option<mdbn_replica::policy::EffectiveGrant> {
        None
    }
}

fn existing(tag: &str) -> (std::path::PathBuf, Runtime) {
    existing_config(
        tag,
        "name: '[test] inherited local'\nsettings:\n  timezone: UTC\nspec_version: 0.3.0\nx-mdbase-connect:\n  collection_id: 00000000-0000-4000-8000-000000000001\n",
    )
}

fn existing_config(tag: &str, config: &str) -> (std::path::PathBuf, Runtime) {
    let root = std::path::PathBuf::from(env!("CARGO_TARGET_TMPDIR"))
        .join(format!("existing-{tag}-{}", std::process::id()));
    std::fs::create_dir(&root).unwrap();
    let folder = root.join("source");
    std::fs::create_dir_all(folder.join("notes")).unwrap();
    // Toy-redacted old local config; no original account/collection identifiers.
    std::fs::write(folder.join("mdbase.yaml"), config).unwrap();
    for name in ["a", "b"] {
        std::fs::write(
            folder.join(format!("notes/{name}.md")),
            format!(
                "---\ntitle: '[test] existing {name}'\ntags:\n  - test\n---\nOriginal toy body\n"
            ),
        )
        .unwrap();
    }
    let rt = Runtime::open(
        RuntimeConfig {
            collection: [1; 16],
            replica_id: [2; 16],
            device_id: [3; 16],
            root: folder.clone(),
            private_dir: root.join("state"),
            adopt: None,
            id_hints: vec![],
            computer_name: None,
            sync: None,
        },
        DeviceSecrets {
            sign_sk: [4; 32],
            kem_sk: [5; 32],
        },
        Box::new(NoAuthority),
        Default::default(),
    )
    .unwrap();
    (root, rt)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn immediate_freeze_includes_preexisting_markdown_and_config() {
    let (root, rt) = existing("freeze");
    // No sleeps, app writes, inventory query or second observation first:
    // collection.add may be followed immediately by sync.enable.
    let frozen = tokio::time::timeout(std::time::Duration::from_secs(10), rt.freeze())
        .await
        .unwrap()
        .expect("existing-folder freeze must finish");
    assert_eq!(
        (frozen.inventory.0.len(), frozen.inventory.1.len()),
        (2, 1),
        "freeze lost preexisting records/config"
    );
    let paths: Vec<&str> = frozen.inventory.0.iter().map(|(_, p)| p.as_str()).collect();
    assert!(paths.contains(&"notes/a.md") && paths.contains(&"notes/b.md"));
    assert!(frozen.inventory.1.iter().any(|p| p == "mdbase.yaml"));
    assert_eq!(frozen.holds, 0);
    assert_eq!(frozen.unresolved, 0);
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn freeze_refuses_an_invalid_resource_capture_instead_of_an_empty_base() {
    let invalid = "spec_version: 99.0.0\nsettings:\n  timezone: UTC\n";
    let (root, rt) = existing_config("invalid", invalid);
    let frozen = rt.freeze().await;
    assert!(
        frozen.is_none(),
        "a resource-ingest incident is not a successful empty inventory"
    );
    assert_eq!(
        std::fs::read_to_string(root.join("source/mdbase.yaml")).unwrap(),
        invalid
    );
    assert!(root.join("source/notes/a.md").exists() && root.join("source/notes/b.md").exists());
    assert!(
        rt.readiness().await.is_none(),
        "writers remain stopped on failure"
    );
    std::fs::remove_dir_all(root).unwrap();
}

// Diagnostic split: the same ONE observation without stopping lets us inspect
// typed incident metadata. Never print free-form details, paths, IDs or content.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn one_existing_folder_observation_has_no_terminal_incident() {
    let (root, rt) = existing("observe");
    let inventory = rt.inventory().await.unwrap();
    let (status, _, _) = rt.readiness().await.unwrap();
    rt.stop().await;
    let kinds: Vec<_> = status.incidents.iter().map(|i| i.kind).collect();
    let deferred = status.incidents.iter().any(|i| matches!(&i.details,
        Some(mdbn_wire::common::Value::Text(t)) if t == "Resource ingestion deferred: incomplete, unstable, invalid, over-budget or previously refused registry; original observations retained."));
    let bounded_observed_source_unavailable = status.incidents.iter().any(|i| matches!(&i.details,
        Some(mdbn_wire::common::Value::Text(t)) if t == "resource ingest: store i/o: bounded observed resource source unavailable"));
    let bounded_query_unavailable = status.incidents.iter().any(|i| matches!(&i.details,
        Some(mdbn_wire::common::Value::Text(t)) if t == "resource ingest: store i/o: bounded resource query unavailable"));
    let categories: Vec<&str> = status
        .incidents
        .iter()
        .map(|i| match &i.details {
            Some(mdbn_wire::common::Value::Text(t))
                if t.starts_with("resource ingest: store i/o: ") =>
            {
                "resource_ingest_io"
            }
            Some(mdbn_wire::common::Value::Text(t))
                if t.starts_with("resource ingest: store corrupt: ") =>
            {
                "resource_ingest_corrupt"
            }
            Some(mdbn_wire::common::Value::Text(t)) if t == "resource ingest: store full" => {
                "resource_ingest_full"
            }
            Some(mdbn_wire::common::Value::Text(t))
                if t.starts_with("resource ingest: store commit aborted: ") =>
            {
                "resource_ingest_commit_aborted"
            }
            Some(mdbn_wire::common::Value::Text(t)) if t.starts_with("resource ingest: ") => {
                "resource_ingest_store_error"
            }
            Some(mdbn_wire::common::Value::Text(t)) if t.starts_with("ingest refused: ") => {
                "resource_planner_refused"
            }
            Some(mdbn_wire::common::Value::Text(t)) if t.starts_with("store: ") => "store_error",
            Some(mdbn_wire::common::Value::Text(t)) if t.starts_with("Store suspended: ") => {
                "store_suspended"
            }
            _ => "other",
        })
        .collect();
    assert!(
        kinds.is_empty(),
        "typed kinds {kinds:?}; categories {categories:?}; bounded_query_unavailable={bounded_query_unavailable}; bounded_observed_source_unavailable={bounded_observed_source_unavailable}; static resource_deferred={deferred}; records={}, resources={}, pending={}",
        inventory.0.len(),
        inventory.1.len(),
        status.pending
    );
    assert_eq!((inventory.0.len(), inventory.1.len()), (2, 1));
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn status_and_control_stay_responsive_during_4000_file_ingest() {
    let (root, rt) = existing("bulk-status");
    for i in 0..4000 {
        std::fs::write(
            root.join(format!("source/notes/bulk-{i}.md")),
            "---\ntitle: '[test] bulk'\n---\nBulk ingest\n",
        )
        .unwrap();
    }
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(60);
    let mut progress_seen = false;
    let mut inventory_checked = false;
    loop {
        let status = tokio::time::timeout(std::time::Duration::from_secs(5), rt.telemetry())
            .await
            .expect("status waited behind bulk ingest")
            .unwrap();
        if !inventory_checked
            && status.pending > 0
            && status
                .confirmed_record_digest
                .as_ref()
                .is_some_and(|d| d.records + status.pending == 4002)
        {
            let inventory =
                tokio::time::timeout(std::time::Duration::from_secs(10), rt.inventory())
                    .await
                    .unwrap()
                    .unwrap();
            assert_eq!(
                inventory.0.len(),
                4002,
                "inventory discarded queued observations"
            );
            inventory_checked = true;
        }
        progress_seen |= status.pending > 0;
        tokio::time::timeout(std::time::Duration::from_secs(5), rt.grants_barrier())
            .await
            .expect("control waited behind bulk ingest");
        if status
            .confirmed_record_digest
            .as_ref()
            .is_some_and(|d| d.records == 4002)
            && status.pending == 0
        {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "bulk ingest did not finish"
        );
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    assert!(
        progress_seen,
        "unfinished disk ingestion must be visible in status"
    );
    assert!(
        inventory_checked,
        "inventory must inspect an owned ingest queue"
    );
    rt.stop().await;
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn freeze_drains_captured_changes_before_building_the_sync_base() {
    let (root, rt) = existing("bulk-freeze");
    for i in 0..4000 {
        std::fs::write(
            root.join(format!("source/notes/bulk-{i}.md")),
            "[test] queued change\n",
        )
        .unwrap();
    }
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(30);
    loop {
        let telemetry = tokio::time::timeout(std::time::Duration::from_secs(5), rt.telemetry())
            .await
            .unwrap()
            .unwrap();
        if telemetry.pending > 0
            && telemetry
                .confirmed_record_digest
                .as_ref()
                .is_some_and(|d| d.records + telemetry.pending == 4002)
        {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "did not observe captured work"
        );
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    let frozen = tokio::time::timeout(std::time::Duration::from_secs(15), rt.freeze())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        frozen.inventory.0.len(),
        4002,
        "freeze omitted captured disk changes"
    );
    std::fs::remove_dir_all(root).unwrap();
}
