use super::*;

#[test]
fn policy_snapshot_replaces_previous_local_authority() {
    let state = tempdir().unwrap();
    let registry = CollectionRegistry::open(state.path()).unwrap();
    let grant = trusted_test_grant(&registry, vec!["read".to_string(), "query".to_string()]);
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
fn policy_snapshots_fail_closed_after_tampering_or_local_trust_revocation() {
    let state = tempdir().unwrap();
    let registry = CollectionRegistry::open(state.path()).unwrap();
    let grant = trusted_test_grant(&registry, vec!["read".to_string()]);
    registry
        .replace_grants(std::slice::from_ref(&grant))
        .unwrap();

    let mut expanded = grant.clone();
    expanded.operations.push("update".to_string());
    assert!(matches!(
        registry.replace_grants(&[expanded]),
        Err(ConnectError::InvalidInput(_))
    ));
    assert!(registry
        .authorizes(grant.id, grant.application_id, grant.collection_id, "read")
        .unwrap());

    let mut substituted = grant.clone();
    substituted.first_contact.application_signing_public_key = substituted
        .application_authorization
        .binding
        .grant_signing_public_key
        .clone();
    assert!(matches!(
        registry.replace_grants(&[substituted]),
        Err(ConnectError::InvalidInput(_))
    ));

    let trust_id = registry.application_trusts().unwrap()[0].id;
    assert!(registry.revoke_application_trust(trust_id).unwrap());
    assert!(registry.list_grants().unwrap().is_empty());
    assert!(matches!(
        registry.replace_grants(&[grant]),
        Err(ConnectError::AccessDenied(_))
    ));
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
fn encrypted_replay_ledger_accepts_a_full_concurrent_request_burst() {
    const REQUESTS: usize = 32;

    let state = tempdir().unwrap();
    let registry = Arc::new(CollectionRegistry::open(state.path()).unwrap());
    let grant_id = Uuid::new_v4();
    let barrier = Arc::new(Barrier::new(REQUESTS));
    let threads = (0..REQUESTS)
        .map(|index| {
            let registry = registry.clone();
            let barrier = barrier.clone();
            thread::spawn(move || {
                let counter = u64::try_from(index + 1).unwrap();
                let request_id = Uuid::new_v4();
                let fingerprint = format!("fingerprint-{counter}");
                barrier.wait();
                let claim = registry.claim_encrypted_request(
                    grant_id,
                    "burst-key",
                    counter,
                    request_id,
                    &fingerprint,
                )?;
                registry.complete_encrypted_request(
                    grant_id,
                    "burst-key",
                    request_id,
                    &fingerprint,
                    r#"{"ciphertext":"response"}"#,
                )?;
                Ok::<_, ConnectError>(claim)
            })
        })
        .collect::<Vec<_>>();

    let claims = threads
        .into_iter()
        .map(|thread| thread.join().unwrap().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(claims, vec![EncryptedRequestClaim::Fresh; REQUESTS]);
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
    let mut grant = trusted_test_grant(&registry, vec!["read".to_string()]);
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
