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
    let raw = fs::read_to_string(path).unwrap();
    assert!(!raw.contains("\"access_token\":"));
    assert!(!raw.contains("\"refresh_token\":"));
    assert!(!raw.contains("Bearer"));
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
