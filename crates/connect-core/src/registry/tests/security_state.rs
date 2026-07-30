use super::*;

#[test]
fn policy_snapshot_replaces_previous_local_authority() {
    let state = tempdir().unwrap();
    let registry = CollectionRegistry::open(state.path()).unwrap();
    let grant = GrantPolicy {
        id: Uuid::new_v4(),
        application_id: Uuid::new_v4(),
        collection_id: Uuid::new_v4(),
        operations: vec!["read".to_string(), "query".to_string()],
        scope: GrantScope::full_collection(),
        application_name: "Workout Tracker".to_string(),
        application_distribution: "web".to_string(),
        application_homepage: "https://workouts.example".to_string(),
        application_project_url: None,
        application_origin: "https://workouts.example".to_string(),
        application_icon: None,
        collection_name: "Workouts".to_string(),
        notification_criteria: Vec::new(),
        created_at: "2026-07-19T00:00:00Z".to_string(),
        encryption: None,
    };
    registry
        .replace_grants(std::slice::from_ref(&grant))
        .unwrap();
    assert!(registry
        .authorizes(grant.id, grant.application_id, grant.collection_id, "query")
        .unwrap());
    assert!(!registry
        .authorizes(
            grant.id,
            grant.application_id,
            grant.collection_id,
            "update"
        )
        .unwrap());

    registry.replace_grants(&[]).unwrap();
    assert!(!registry
        .authorizes(grant.id, grant.application_id, grant.collection_id, "read")
        .unwrap());
}

#[test]
fn encrypted_replay_window_survives_restart_allows_reordering_and_serializes_duplicates() {
    let state = tempdir().unwrap();
    let grant_id = Uuid::new_v4();
    let first_request = Uuid::new_v4();
    let registry = CollectionRegistry::open(state.path()).unwrap();
    assert_eq!(
        registry
            .claim_encrypted_request(grant_id, "key-1", 40, first_request, "fingerprint-1")
            .unwrap(),
        EncryptedRequestClaim::Fresh
    );
    registry
        .complete_encrypted_request(
            grant_id,
            "key-1",
            first_request,
            "fingerprint-1",
            r#"{"ciphertext":"response"}"#,
        )
        .unwrap();
    drop(registry);

    let registry = CollectionRegistry::open(state.path()).unwrap();
    assert!(matches!(
        registry.claim_encrypted_request(grant_id, "key-1", 40, Uuid::new_v4(), "fingerprint-2"),
        Err(ConnectError::EncryptedRelayRejected)
    ));
    assert_eq!(
        registry
            .claim_encrypted_request(grant_id, "key-1", 40, first_request, "fingerprint-1")
            .unwrap(),
        EncryptedRequestClaim::Completed(r#"{"ciphertext":"response"}"#.to_string())
    );
    assert!(registry
        .claim_encrypted_request(grant_id, "key-1", 41, first_request, "tampered")
        .is_err());
    assert_eq!(
        registry
            .claim_encrypted_request(grant_id, "key-1", 42, Uuid::new_v4(), "fingerprint-42")
            .unwrap(),
        EncryptedRequestClaim::Fresh
    );
    assert_eq!(
        registry
            .claim_encrypted_request(grant_id, "key-1", 41, Uuid::new_v4(), "fingerprint-41")
            .unwrap(),
        EncryptedRequestClaim::Fresh
    );

    let shared = Arc::new(registry);
    let request_id = Uuid::new_v4();
    let threads = (0..8)
        .map(|_| {
            let registry = shared.clone();
            std::thread::spawn(move || {
                registry.claim_encrypted_request(
                    grant_id,
                    "key-1",
                    43,
                    request_id,
                    "fingerprint-43",
                )
            })
        })
        .collect::<Vec<_>>();
    let accepted = threads
        .into_iter()
        .map(|thread| thread.join().unwrap())
        .filter(|result| matches!(result, Ok(EncryptedRequestClaim::Fresh)))
        .count();
    assert_eq!(accepted, 1);
    assert_eq!(
        shared
            .claim_encrypted_request(grant_id, "key-1", 2_000, Uuid::new_v4(), "fingerprint-2000")
            .unwrap(),
        EncryptedRequestClaim::Fresh
    );
    assert!(shared
        .claim_encrypted_request(grant_id, "key-1", 975, Uuid::new_v4(), "fingerprint-stale")
        .is_err());
}

#[test]
fn development_registry_upgrade_adds_origin_receipts_and_a_safe_reorder_floor() {
    let state = tempdir().unwrap();
    let path = state.path().join("connector.sqlite");
    let legacy = Connection::open(&path).unwrap();
    legacy
        .execute_batch(
            "CREATE TABLE grants (
                    id TEXT PRIMARY KEY,
                    application_id TEXT NOT NULL,
                    collection_id TEXT NOT NULL,
                    operations TEXT NOT NULL
                 );
                 CREATE TABLE grant_crypto_state (
                    grant_id TEXT NOT NULL,
                    key_id TEXT NOT NULL,
                    last_request_counter TEXT NOT NULL,
                    PRIMARY KEY (grant_id, key_id)
                 );
                 CREATE TABLE grant_crypto_requests (
                    grant_id TEXT NOT NULL,
                    key_id TEXT NOT NULL,
                    request_id TEXT NOT NULL,
                    received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    PRIMARY KEY (grant_id, key_id, request_id)
                 );",
        )
        .unwrap();
    let grant_id = Uuid::new_v4();
    legacy
        .execute(
            "INSERT INTO grant_crypto_state (grant_id, key_id, last_request_counter)
                 VALUES (?1, 'legacy-key', '40')",
            [grant_id.to_string()],
        )
        .unwrap();
    drop(legacy);

    let registry = CollectionRegistry::open(state.path()).unwrap();
    let connection = registry.connection().unwrap();
    let origin: String = connection
        .query_row(
            "SELECT dflt_value FROM pragma_table_info('grants')
                 WHERE name = 'application_origin'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(origin, "''");
    let floor: String = connection
        .query_row(
            "SELECT reorder_floor FROM grant_crypto_state
                 WHERE grant_id = ?1 AND key_id = 'legacy-key'",
            [grant_id.to_string()],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(floor, "40");
    drop(connection);
    assert_eq!(
        registry
            .claim_encrypted_request(
                grant_id,
                "legacy-key",
                41,
                Uuid::new_v4(),
                "upgraded-fingerprint"
            )
            .unwrap(),
        EncryptedRequestClaim::Fresh
    );
}

#[test]
fn policy_rotation_prunes_only_obsolete_encrypted_replay_windows() {
    let state = tempdir().unwrap();
    let registry = CollectionRegistry::open(state.path()).unwrap();
    let mut grant = GrantPolicy {
        id: Uuid::new_v4(),
        application_id: Uuid::new_v4(),
        collection_id: Uuid::new_v4(),
        operations: vec!["read".to_string()],
        scope: GrantScope::full_collection(),
        application_name: "Encrypted app".to_string(),
        application_distribution: "web".to_string(),
        application_homepage: "https://app.example".to_string(),
        application_project_url: None,
        application_origin: "https://app.example".to_string(),
        application_icon: None,
        collection_name: "Collection".to_string(),
        notification_criteria: Vec::new(),
        created_at: "2026-07-21T00:00:00Z".to_string(),
        encryption: Some(mdbase_connect_protocol::GrantEncryption {
            protocol_version: 1,
            suite: "P256-HKDF-SHA256-AES256GCM".to_string(),
            key_id: "key-1".to_string(),
            scope_epoch: 1,
            connector_id: Uuid::new_v4(),
            collection_id: Uuid::new_v4(),
            application_agreement_public_key: "application-key".to_string(),
            connector_agreement_public_key: "connector-key".to_string(),
        }),
    };
    registry
        .replace_grants(std::slice::from_ref(&grant))
        .unwrap();
    registry
        .claim_encrypted_request(grant.id, "key-1", 7, Uuid::new_v4(), "fingerprint")
        .unwrap();

    registry
        .replace_grants(std::slice::from_ref(&grant))
        .unwrap();
    let preserved = registry
        .connection()
        .unwrap()
        .query_row(
            "SELECT COUNT(*) FROM grant_crypto_state WHERE grant_id = ?1 AND key_id = 'key-1'",
            [grant.id.to_string()],
            |row| row.get::<_, u64>(0),
        )
        .unwrap();
    assert_eq!(preserved, 1);

    grant.encryption.as_mut().unwrap().key_id = "key-2".to_string();
    grant.encryption.as_mut().unwrap().scope_epoch = 2;
    registry
        .replace_grants(std::slice::from_ref(&grant))
        .unwrap();
    let obsolete = registry
        .connection()
        .unwrap()
        .query_row(
            "SELECT COUNT(*) FROM grant_crypto_state WHERE grant_id = ?1 AND key_id = 'key-1'",
            [grant.id.to_string()],
            |row| row.get::<_, u64>(0),
        )
        .unwrap();
    assert_eq!(obsolete, 0);
}
