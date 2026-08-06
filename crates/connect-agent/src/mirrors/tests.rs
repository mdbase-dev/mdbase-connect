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

    assert!(terminal_background_error(&upgrade));
    assert!(!terminal_background_error(&transient));
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
