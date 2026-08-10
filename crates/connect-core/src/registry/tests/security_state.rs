use super::*;

fn claim_read(
    registry: &CollectionRegistry,
    grant_id: Uuid,
    key_id: &str,
    counter: u64,
    request_id: Uuid,
    fingerprint: &str,
) -> Result<EncryptedRequestClaim, ConnectError> {
    registry.claim_encrypted_request(
        grant_id,
        key_id,
        "read",
        EncryptedReplayClass::Read,
        counter,
        request_id,
        fingerprint,
    )
}

#[test]
fn policy_snapshot_replaces_previous_local_authority() {
    let state = tempdir().unwrap();
    let registry = CollectionRegistry::open(state.path()).unwrap();
    let grant = signed_test_grant(&registry, vec!["read".to_string(), "query".to_string()]);
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
fn policy_snapshots_fail_closed_after_signed_authorization_tampering() {
    let state = tempdir().unwrap();
    let registry = CollectionRegistry::open(state.path()).unwrap();
    let grant = signed_test_grant(&registry, vec!["read".to_string()]);
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
    substituted
        .application_authorization
        .binding
        .installation_signing_public_key = substituted
        .application_authorization
        .binding
        .grant_signing_public_key
        .clone();
    assert!(matches!(
        registry.replace_grants(&[substituted]),
        Err(ConnectError::InvalidInput(_))
    ));

    registry.replace_grants(&[]).unwrap();
    assert!(registry.list_grants().unwrap().is_empty());
}

#[test]
fn encrypted_replay_window_survives_restart_allows_reordering_and_serializes_duplicates() {
    let state = tempdir().unwrap();
    let first_request = Uuid::new_v4();
    let registry = CollectionRegistry::open(state.path()).unwrap();
    let grant = signed_test_grant(&registry, vec!["read".to_string()]);
    let grant_id = grant.id;
    registry.replace_grants(&[grant]).unwrap();
    assert_eq!(
        claim_read(
            &registry,
            grant_id,
            "key-1",
            40,
            first_request,
            "fingerprint-1"
        )
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
        claim_read(
            &registry,
            grant_id,
            "key-1",
            40,
            Uuid::new_v4(),
            "fingerprint-2"
        ),
        Err(ConnectError::EncryptedRelayRejected)
    ));
    assert_eq!(
        claim_read(
            &registry,
            grant_id,
            "key-1",
            40,
            first_request,
            "fingerprint-1"
        )
        .unwrap(),
        EncryptedRequestClaim::FreshRequired
    );
    assert_eq!(
        claim_read(&registry, grant_id, "key-1", 41, first_request, "tampered").unwrap(),
        EncryptedRequestClaim::Conflict
    );
    assert_eq!(
        claim_read(
            &registry,
            grant_id,
            "key-1",
            42,
            Uuid::new_v4(),
            "fingerprint-42"
        )
        .unwrap(),
        EncryptedRequestClaim::Fresh
    );
    assert_eq!(
        claim_read(
            &registry,
            grant_id,
            "key-1",
            41,
            Uuid::new_v4(),
            "fingerprint-41"
        )
        .unwrap(),
        EncryptedRequestClaim::Fresh
    );

    let shared = Arc::new(registry);
    let request_id = Uuid::new_v4();
    let threads = (0..8)
        .map(|_| {
            let registry = shared.clone();
            std::thread::spawn(move || {
                claim_read(
                    &registry,
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
        claim_read(
            &shared,
            grant_id,
            "key-1",
            2_000,
            Uuid::new_v4(),
            "fingerprint-2000"
        )
        .unwrap(),
        EncryptedRequestClaim::Fresh
    );
    assert!(claim_read(
        &shared,
        grant_id,
        "key-1",
        975,
        Uuid::new_v4(),
        "fingerprint-stale"
    )
    .is_err());
}

#[test]
fn encrypted_replay_ledger_accepts_a_full_concurrent_request_burst() {
    const REQUESTS: usize = 32;

    let state = tempdir().unwrap();
    let registry = CollectionRegistry::open(state.path()).unwrap();
    let grant = signed_test_grant(&registry, vec!["read".to_string()]);
    let grant_id = grant.id;
    registry.replace_grants(&[grant]).unwrap();
    let registry = Arc::new(registry);
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
                let claim = claim_read(
                    &registry,
                    grant_id,
                    "key-1",
                    counter,
                    request_id,
                    &fingerprint,
                )?;
                registry.complete_encrypted_request(
                    grant_id,
                    "key-1",
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
fn policy_control_stays_bounded_during_maximum_size_read_completion_burst() {
    const REQUESTS: usize = 48;

    let state = tempdir().unwrap();
    let registry = CollectionRegistry::open(state.path()).unwrap();
    let grant = signed_test_grant(&registry, vec!["read".to_string()]);
    let grant_id = grant.id;
    registry
        .replace_grants(std::slice::from_ref(&grant))
        .unwrap();
    let registry = Arc::new(registry);
    let barrier = Arc::new(Barrier::new(REQUESTS + 1));
    let threads = (0..REQUESTS)
        .map(|index| {
            let registry = registry.clone();
            let barrier = barrier.clone();
            thread::spawn(move || {
                let counter = u64::try_from(index + 1).unwrap();
                let request_id = Uuid::new_v4();
                let fingerprint = format!("large-read-{counter}");
                barrier.wait();
                let claim = claim_read(
                    &registry,
                    grant_id,
                    "key-1",
                    counter,
                    request_id,
                    &fingerprint,
                )?;
                registry.complete_encrypted_request(
                    grant_id,
                    "key-1",
                    request_id,
                    &fingerprint,
                    &format!("{index:04}{}", "x".repeat(1024 * 1024)),
                )?;
                Ok::<_, ConnectError>(claim)
            })
        })
        .collect::<Vec<_>>();

    barrier.wait();
    let started = std::time::Instant::now();
    registry
        .replace_grants_at_revision("stress-policy-revision", std::slice::from_ref(&grant))
        .unwrap();
    assert!(
        started.elapsed() < std::time::Duration::from_secs(2),
        "policy replacement took {:?}",
        started.elapsed()
    );
    for thread in threads {
        assert_eq!(
            thread.join().unwrap().unwrap(),
            EncryptedRequestClaim::Fresh
        );
    }

    let authority = registry.authority.connection().unwrap();
    let page_count: u64 = authority
        .pragma_query_value(None, "page_count", |row| row.get(0))
        .unwrap();
    let page_size: u64 = authority
        .pragma_query_value(None, "page_size", |row| row.get(0))
        .unwrap();
    assert!(page_count * page_size < 8 * 1024 * 1024);
    assert_eq!(
        authority
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('grant_crypto_requests')
                 WHERE name = 'response_envelope'",
                [],
                |row| row.get::<_, u64>(0),
            )
            .unwrap(),
        0
    );
}

#[test]
fn fresh_admission_rechecks_pause_collection_overlay_and_revocation() {
    let state = tempdir().unwrap();
    let registry = CollectionRegistry::open(state.path()).unwrap();
    let grant = signed_test_grant(&registry, vec!["read".to_string()]);
    registry
        .replace_grants(std::slice::from_ref(&grant))
        .unwrap();

    registry.set_paused(true).unwrap();
    assert!(matches!(
        claim_read(&registry, grant.id, "key-1", 1, Uuid::new_v4(), "paused"),
        Err(ConnectError::AccessPaused)
    ));
    registry.set_paused(false).unwrap();
    assert_eq!(
        claim_read(&registry, grant.id, "key-1", 1, Uuid::new_v4(), "resumed").unwrap(),
        EncryptedRequestClaim::Fresh
    );

    let collection_id = grant.collection_id;
    registry
        .authority
        .write(AuthorityWritePriority::Control, move |connection| {
            connection.execute(
                "UPDATE collection_access_overlays SET enabled = 0 WHERE collection_id = ?1",
                [collection_id.to_string()],
            )?;
            Ok(())
        })
        .unwrap();
    assert!(matches!(
        claim_read(&registry, grant.id, "key-1", 2, Uuid::new_v4(), "disabled"),
        Err(ConnectError::AccessDenied(_))
    ));

    registry.replace_grants(&[]).unwrap();
    assert!(matches!(
        claim_read(&registry, grant.id, "key-1", 2, Uuid::new_v4(), "revoked"),
        Err(ConnectError::AccessDenied(_))
    ));
}

#[test]
fn pre_beta28_development_registry_fails_closed_without_reinterpretation() {
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

    assert!(matches!(
        CollectionRegistry::open(state.path()),
        Err(ConnectError::RegistrySchemaIncompatible { found: 0, .. })
    ));
    let preserved = Connection::open(path).unwrap();
    assert_eq!(
        preserved
            .query_row(
                "SELECT last_request_counter FROM grant_crypto_state
                 WHERE grant_id = ?1 AND key_id = 'legacy-key'",
                [grant_id.to_string()],
                |row| row.get::<_, String>(0),
            )
            .unwrap(),
        "40"
    );
}

#[test]
fn authorization_v1_development_registry_is_preserved_but_not_opened() {
    let state = tempdir().unwrap();
    let path = state.path().join("connector.sqlite");
    let legacy = Connection::open(&path).unwrap();
    legacy
        .execute_batch(
            "CREATE TABLE grants (
                 id TEXT PRIMARY KEY,
                 application_id TEXT NOT NULL,
                 collection_id TEXT NOT NULL,
                 operations TEXT NOT NULL,
                 first_contact TEXT,
                 application_authorization TEXT
             );
             CREATE TABLE application_trusts (id TEXT PRIMARY KEY);
             CREATE TABLE pending_application_trusts (request_id TEXT PRIMARY KEY);
             INSERT INTO grants (
                 id, application_id, collection_id, operations,
                 first_contact, application_authorization
             ) VALUES (
                 '01911111-1111-7111-8111-111111111111',
                 '01922222-2222-7222-8222-222222222222',
                 '01933333-3333-7333-8333-333333333333',
                 '[\"read\"]', '{}',
                 '{\"binding\":{\"protocol_version\":1}}'
             );",
        )
        .unwrap();
    drop(legacy);

    assert!(matches!(
        CollectionRegistry::open(state.path()),
        Err(ConnectError::RegistrySchemaIncompatible { found: 0, .. })
    ));
    let connection = Connection::open(path).unwrap();
    let grant_count: i64 = connection
        .query_row("SELECT COUNT(*) FROM grants", [], |row| row.get(0))
        .unwrap();
    assert_eq!(grant_count, 1);
    let first_contact_columns: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info('grants') WHERE name = 'first_contact'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(first_contact_columns, 1);
    let trust_tables: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master
             WHERE type = 'table'
               AND name IN ('application_trusts', 'pending_application_trusts')",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(trust_tables, 2);
}

#[test]
fn policy_rotation_retains_only_authenticated_historical_replay_material() {
    let state = tempdir().unwrap();
    let registry = CollectionRegistry::open(state.path()).unwrap();
    let mut grant = signed_test_grant(&registry, vec!["read".to_string()]);
    registry
        .replace_grants(std::slice::from_ref(&grant))
        .unwrap();
    claim_read(
        &registry,
        grant.id,
        "key-1",
        7,
        Uuid::new_v4(),
        "fingerprint",
    )
    .unwrap();

    registry
        .replace_grants(std::slice::from_ref(&grant))
        .unwrap();
    let preserved = registry
        .authority
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
        .authority
        .connection()
        .unwrap()
        .query_row(
            "SELECT COUNT(*) FROM grant_crypto_state WHERE grant_id = ?1 AND key_id = 'key-1'",
            [grant.id.to_string()],
            |row| row.get::<_, u64>(0),
        )
        .unwrap();
    assert_eq!(obsolete, 1);
    let archived = registry
        .authority
        .connection()
        .unwrap()
        .query_row(
            "SELECT COUNT(*) FROM revoked_grant_replay_material
             WHERE grant_id = ?1 AND key_id = 'key-1'",
            [grant.id.to_string()],
            |row| row.get::<_, u64>(0),
        )
        .unwrap();
    assert_eq!(archived, 1);
}
