use super::*;

#[test]
fn overlap_is_component_aware() {
    assert!(paths_overlap(
        Path::new("/notes"),
        Path::new("/notes/tasks")
    ));
    assert!(!paths_overlap(
        Path::new("/notes"),
        Path::new("/notes-archive")
    ));
}

#[test]
fn registry_contains_no_credentials() {
    let temporary = tempfile::tempdir().unwrap();
    let path = temporary.path().join("mirrors.json");
    let entry = MirrorRegistryEntry {
        collection_id: Uuid::new_v4(),
        replica_id: Uuid::new_v4(),
        name: "Notes".to_string(),
        mode: SyncReplicaMode::ReadWrite,
        selective_sync: SelectiveSyncPolicy {
            file_classes: vec![mdbase_connect_protocol::FileMediaClass::Image],
            excluded_folders: vec!["Archive".to_string()],
        },
        path: temporary.path().join("notes"),
        sync_url:
            "https://connect.example/v1/authorities/01900000-0000-7000-8000-000000000000/sync"
                .to_string(),
        control_url: "https://connect.example".to_string(),
        enrollment_id: Uuid::new_v4(),
        access_token_expires_at: "2026-07-28T00:00:00Z".to_string(),
        created_at: "2026-07-27T00:00:00Z".to_string(),
        lifecycle: MirrorLifecycle::Active,
        promotion: None,
    };
    write_registry(&path, &[entry]).unwrap();
    let raw = fs::read_to_string(&path).unwrap();
    assert!(!raw.contains("\"access_token\":"));
    assert!(!raw.contains("\"refresh_token\":"));
    assert!(!raw.contains("Bearer"));
    assert!(raw.contains("\"selective_sync\""));
    assert!(raw.contains("\"file_classes\""));

    fs::write(&path, raw.replace("\"selective_sync\"", "\"files\"")).unwrap();
    let migrated = read_registry(&path).unwrap();
    assert_eq!(
        migrated[0].selective_sync.file_classes,
        vec![mdbase_connect_protocol::FileMediaClass::Image]
    );
    assert_eq!(migrated[0].selective_sync.excluded_folders, vec!["Archive"]);
}

#[test]
fn background_retry_is_bounded_and_jittered() {
    let replica_id = Uuid::parse_str("01900000-0000-7000-8000-000000000123").unwrap();
    let first = background_retry_delay(replica_id, 1);
    let second = background_retry_delay(replica_id, 2);
    let saturated = background_retry_delay(replica_id, u32::MAX);

    assert!((Duration::from_secs(4)..=Duration::from_secs(6)).contains(&first));
    assert!((Duration::from_secs(8)..=Duration::from_secs(12)).contains(&second));
    assert!((Duration::from_secs(4 * 60)..=MAX_BACKGROUND_BACKOFF).contains(&saturated));
    assert_ne!(first, SYNC_INTERVAL);
}

#[test]
fn prerelease_state_upgrade_blocks_background_retry() {
    let upgrade = mirror_error(
        "mirror_state_upgrade_required",
        "Rebuild this prerelease mirror.",
    );
    let transient = mirror_error("mirror_transport_failed", "Try again.");
    let credentials = ConnectError::CredentialStore("The login keyring is locked.".into());

    assert!(terminal_background_error(&upgrade));
    assert!(terminal_background_error(&credentials));
    assert!(!terminal_background_error(&transient));
}

#[test]
fn degraded_manager_rejects_secret_operations_without_touching_the_keyring() {
    let temporary = tempfile::tempdir().unwrap();
    let registry = CollectionRegistry::open(temporary.path()).unwrap();
    let manager = MirrorManager::open(
        temporary.path(),
        registry,
        None,
        Some("The login keyring is locked.".into()),
    )
    .unwrap();

    let credential_error = manager.credentials(Uuid::new_v4()).unwrap_err();
    assert_eq!(credential_error.code(), "credential_store_unavailable");
    assert!(credential_error
        .to_string()
        .contains("login keyring is locked"));

    match manager.cloud() {
        Err(error) => assert_eq!(error.code(), "credential_store_unavailable"),
        Ok(_) => panic!("degraded mirror manager must not expose a cloud client"),
    }
}

#[test]
fn unavailable_mirror_summary_is_structured_and_local_to_one_replica() {
    let temporary = tempfile::tempdir().unwrap();
    let entry = MirrorRegistryEntry {
        collection_id: Uuid::new_v4(),
        replica_id: Uuid::new_v4(),
        name: "Legacy".to_string(),
        mode: SyncReplicaMode::ReadWrite,
        selective_sync: SelectiveSyncPolicy::default(),
        path: temporary.path().join("legacy"),
        sync_url: "https://sync.example/v1/authority".to_string(),
        control_url: "https://connect.example".to_string(),
        enrollment_id: Uuid::new_v4(),
        access_token_expires_at: "2026-08-08T00:00:00Z".to_string(),
        created_at: "2026-08-07T00:00:00Z".to_string(),
        lifecycle: MirrorLifecycle::Active,
        promotion: None,
    };

    let summary = synchronization::unavailable_summary(
        &entry,
        "mirror_state_upgrade_required",
        "Rebuild this prerelease mirror.".to_string(),
    );

    assert_eq!(summary.replica_id, entry.replica_id);
    assert_eq!(summary.state, MirrorState::Offline);
    assert_eq!(
        summary.error_code.as_deref(),
        Some("mirror_state_upgrade_required")
    );
    assert_eq!(summary.pending, 0);
}

#[tokio::test]
async fn aborting_an_operation_releases_the_mirror_guard() {
    let temporary = tempfile::tempdir().unwrap();
    let registry = CollectionRegistry::open(temporary.path()).unwrap();
    let manager = MirrorManager::open(temporary.path(), registry, None, None).unwrap();
    let replica_id = Uuid::new_v4();
    let (started_tx, started_rx) = tokio::sync::oneshot::channel();
    let running = manager.clone();
    let task = tokio::spawn(async move {
        let _guard = running
            .begin_operation_named(replica_id, false, "abort-test")
            .unwrap();
        started_tx.send(()).unwrap();
        std::future::pending::<()>().await;
    });

    started_rx.await.unwrap();
    assert_eq!(
        manager
            .begin_operation(replica_id, false)
            .err()
            .unwrap()
            .code(),
        "mirror_busy"
    );
    task.abort();
    assert!(task.await.unwrap_err().is_cancelled());

    let _replacement = manager.begin_operation(replica_id, false).unwrap();
}

#[tokio::test]
async fn timed_out_sync_future_releases_the_mirror_guard() {
    let temporary = tempfile::tempdir().unwrap();
    let registry = CollectionRegistry::open(temporary.path()).unwrap();
    let manager = MirrorManager::open(temporary.path(), registry, None, None).unwrap();
    let replica_id = Uuid::new_v4();

    let result = async {
        let _guard = manager.begin_operation_named(replica_id, false, "timeout-test")?;
        with_mirror_operation_timeout(
            Duration::from_millis(10),
            std::future::pending::<Result<(), ConnectError>>(),
        )
        .await
    }
    .await;
    assert_eq!(result.unwrap_err().code(), "mirror_sync_timeout");

    let _replacement = manager.begin_operation(replica_id, false).unwrap();
}
