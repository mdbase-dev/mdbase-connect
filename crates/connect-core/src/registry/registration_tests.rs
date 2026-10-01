use super::*;

#[test]
fn registration_reset_revokes_grants_preserves_local_authority_and_allows_new_pin() {
    let directory = tempfile::tempdir().unwrap();
    let collections = tempfile::tempdir().unwrap();
    let registry = CollectionRegistry::open(directory.path()).unwrap();
    let collection = registry
        .create(collections.path().join("notes"), Some("Notes"), "UTC")
        .unwrap();
    let transfer_id = Uuid::new_v4();
    registry.set_paused(true).unwrap();
    registry.set_enabled(collection.id, false).unwrap();
    registry
        .fence_authority(collection.id, transfer_id)
        .unwrap();
    let grant = super::super::tests::signed_test_grant(&registry, vec!["query".into()]);
    let old_id = grant.encryption.as_ref().unwrap().connector_id;
    let now = super::super::authority_store::current_time_ms();
    registry
        .replace_remote_grants_at_revision(
            old_id,
            "old",
            578,
            now,
            now + 60_000,
            std::slice::from_ref(&grant),
        )
        .unwrap();
    let new_id = Uuid::new_v4();
    let error = registry
        .replace_remote_grants_at_revision(new_id, "new", 1, now, now + 60_000, &[])
        .unwrap_err();
    assert_eq!(error.code(), "policy_authority_mismatch");
    assert_eq!(
        registry.remote_policy_authority().unwrap().connector_id,
        Some(old_id)
    );
    registry.reset_remote_policy().unwrap();
    assert!(registry.list_grants().unwrap().is_empty());
    assert!(
        registry
            .grant_replay_context(grant.id, "key-1")
            .unwrap()
            .unwrap()
            .revoked
    );
    assert!(!registry.remote_policy_is_usable().unwrap());
    assert!(!registry.remote_policy_is_fresh().unwrap());
    assert!(registry
        .remote_policy_authority()
        .unwrap()
        .authority_digest
        .is_none());
    assert!(registry.paused().unwrap());
    let preserved = registry.get(collection.id).unwrap();
    assert_eq!(preserved.path, collection.path);
    assert!(!preserved.enabled);
    assert_eq!(
        preserved.authority_transfer.unwrap().transfer_id,
        transfer_id
    );
    drop(registry);
    let registry = CollectionRegistry::open(directory.path()).unwrap();
    registry.reset_remote_policy().unwrap(); // crash recovery is idempotent
    registry
        .replace_remote_grants_at_revision(new_id, "new", 1, now, now + 60_000, &[])
        .unwrap();
    drop(registry);
    let registry = CollectionRegistry::open(directory.path()).unwrap();
    assert_eq!(
        registry.remote_policy_authority().unwrap().connector_id,
        Some(new_id)
    );
    assert_eq!(registry.remote_policy_authority().unwrap().sequence, 1);
    assert!(registry
        .replace_remote_grants_at_revision(old_id, "old", 579, now, now + 60_000, &[])
        .is_err());
}

#[test]
fn registration_reset_is_atomic_on_storage_failure() {
    let directory = tempfile::tempdir().unwrap();
    let registry = CollectionRegistry::open(directory.path()).unwrap();
    let grant = super::super::tests::signed_test_grant(&registry, vec!["query".into()]);
    let connector_id = grant.encryption.as_ref().unwrap().connector_id;
    let now = super::super::authority_store::current_time_ms();
    registry
        .replace_remote_grants_at_revision(
            connector_id,
            "old",
            2,
            now,
            now + 60_000,
            std::slice::from_ref(&grant),
        )
        .unwrap();
    registry.authority.connection().unwrap().execute_batch(
        "CREATE TRIGGER fail_reset BEFORE UPDATE ON policy_state BEGIN SELECT RAISE(FAIL, 'reset failed'); END;"
    ).unwrap();
    assert!(registry.reset_remote_policy().is_err());
    assert!(registry.grant_context(grant.id).unwrap().is_some());
    assert!(
        !registry
            .grant_replay_context(grant.id, "key-1")
            .unwrap()
            .unwrap()
            .revoked
    );
    assert_eq!(
        registry.remote_policy_authority().unwrap().connector_id,
        Some(connector_id)
    );
}

#[test]
fn missing_policy_singleton_fails_explicitly_without_recreating_trust() {
    let directory = tempfile::tempdir().unwrap();
    let registry = CollectionRegistry::open(directory.path()).unwrap();
    registry
        .authority
        .connection()
        .unwrap()
        .execute("DELETE FROM policy_state", [])
        .unwrap();
    let now = super::super::authority_store::current_time_ms();
    for error in [
        registry.replace_grants(&[]).unwrap_err(),
        registry.remote_policy_authority().unwrap_err(),
        registry
            .prevalidate_remote_grants_at_revision(Uuid::new_v4(), "new", 1, now, now + 60_000, &[])
            .unwrap_err(),
        registry
            .replace_remote_grants_at_revision(Uuid::new_v4(), "new", 1, now, now + 60_000, &[])
            .unwrap_err(),
        registry.reset_remote_policy().unwrap_err(),
    ] {
        assert_eq!(error.code(), "policy_state_missing");
    }
    let count: u64 = registry
        .authority
        .connection()
        .unwrap()
        .query_row("SELECT count(*) FROM policy_state", [], |row| row.get(0))
        .unwrap();
    assert_eq!(count, 0);
}
