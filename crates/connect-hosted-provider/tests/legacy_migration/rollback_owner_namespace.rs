//! Joined loopback HTTP qualification against real CP and provider PostgreSQL.
use super::*;

#[tokio::test]
#[ignore = "requires disposable loopback PostgreSQL and built server JS dependencies"]
async fn rollback_v2_cp_owner_http_nonidentity() {
    let database = DisposablePostgres::from_projection_env().await;
    let fixture = FileLifecycleFixture::new(database.url()).await;
    fenced(&fixture).await;
    let input = rollback_input(&fixture, vec![]).await;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let token = "rollback-owner-fixture-internal-token-".repeat(2);
    let state = AppState::new(fixture.provider.clone(), &token).unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, app(state)).await.unwrap() });
    // Cargo runs integration tests from the crate directory; pulled binaries
    // may run from the workspace root. Resolve that single workspace boundary
    // from cwd, never from a remote compiler's embedded manifest path.
    let cwd = std::env::current_dir().unwrap();
    let root = cwd
        .ancestors()
        .find(|path| path.join("services/server/package.json").is_file())
        .expect("test must run inside the Connect workspace");
    let mut command = tokio::process::Command::new("node");
    command.arg(root.join("test/fixtures/rollback-owner-cp.mjs")).current_dir(root)
        .env("MDBASE_ROLLBACK_OWNER_FIXTURE", json!({
            "database_url": database.url(), "provider_url": format!("http://{address}"),
            "provider_token": token, "collection": fixture.collection_id,
            "physical_owner": input.owner_account_id, "migration_id": input.provider_migration_id,
            "epoch": input.authority_epoch, "head": input.fixed_head
        }).to_string()).kill_on_drop(true);
    let output = tokio::time::timeout(std::time::Duration::from_secs(120), command.output())
        .await
        .expect("joined CP/provider HTTP fixture is bounded")
        .unwrap();
    server.abort();
    assert!(
        output.status.success(),
        "stdout={} stderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let report: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(report["non_identity"], true);
    assert_eq!(report["original_intent_unchanged"], true);
    assert_eq!(report["receipt_echo_unchanged"], true);
    assert_eq!(report["v1_original_binding_status"], 409);
    assert_eq!(report["v2_provider_mutations"], 1);
    assert_eq!(state_of(&fixture).await, "active");
    let stored = sqlx::query("SELECT owner_account_id, provider_account_id FROM hosted_provider_legacy_rollback_receipts WHERE collection_id=$1")
        .bind(fixture.collection_id).fetch_one(&fixture.pool).await.unwrap();
    let original_owner: Uuid = report["connect_owner"].as_str().unwrap().parse().unwrap();
    assert_ne!(original_owner, input.owner_account_id);
    assert_eq!(stored.get::<Uuid, _>("owner_account_id"), original_owner);
    assert_eq!(
        stored.get::<Uuid, _>("provider_account_id"),
        input.owner_account_id
    );
}

#[tokio::test]
#[ignore = "requires the repository-approved disposable loopback PostgreSQL test target"]
async fn rollback_v2_physical_owner_and_legacy_receipts_cannot_be_relabelled() {
    use mdbase_connect_hosted_provider::LegacyRollbackEnvelope;
    let database = DisposablePostgres::from_projection_env().await;
    let fixture = FileLifecycleFixture::new(database.url()).await;
    fenced(&fixture).await;
    let mut binding = rollback_input(&fixture, vec![]).await;
    let physical = binding.owner_account_id;
    binding.owner_account_id = Uuid::new_v4();
    assert_ne!(binding.owner_account_id, physical);
    let provider = &fixture.provider;
    let id = fixture.collection_id;
    assert_eq!(
        provider
            .rollback_legacy_migration(id, &binding)
            .await
            .unwrap_err()
            .code,
        "legacy_rollback_binding_conflict"
    );
    let mut envelope = LegacyRollbackEnvelope {
        provider_account_id: physical,
        binding,
    };
    assert_eq!(
        provider
            .legacy_migration_rollback_receipt_v2(id, &envelope)
            .await
            .unwrap_err()
            .code,
        "legacy_rollback_receipt_unknown"
    );
    envelope.provider_account_id = Uuid::nil();
    assert_eq!(
        provider
            .rollback_legacy_migration_v2(id, &envelope)
            .await
            .unwrap_err()
            .code,
        "legacy_rollback_binding_invalid"
    );
    envelope.provider_account_id = envelope.binding.owner_account_id;
    assert_eq!(
        provider
            .rollback_legacy_migration_v2(id, &envelope)
            .await
            .unwrap_err()
            .code,
        "legacy_rollback_binding_conflict"
    );
    assert_eq!(state_of(&fixture).await, "migrating");
    let count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM hosted_provider_legacy_rollback_receipts WHERE collection_id=$1",
    )
    .bind(id)
    .fetch_one(&fixture.pool)
    .await
    .unwrap();
    assert_eq!(count, 0);
    envelope.provider_account_id = physical;
    let receipt = provider
        .rollback_legacy_migration_v2(id, &envelope)
        .await
        .unwrap();
    assert_eq!(receipt.binding, envelope.binding);
    assert_eq!(
        provider
            .legacy_migration_rollback_receipt_v2(id, &envelope)
            .await
            .unwrap(),
        receipt
    );
    // A genuine predecessor row has NULL physical owner. Never infer a
    // non-identity user mapping from that missing persisted representation.
    sqlx::query("UPDATE hosted_provider_legacy_rollback_receipts SET provider_account_id=NULL WHERE collection_id=$1")
        .bind(id).execute(&fixture.pool).await.unwrap();
    assert_eq!(
        provider
            .legacy_migration_rollback_receipt_v2(id, &envelope)
            .await
            .unwrap_err()
            .code,
        "legacy_rollback_binding_conflict"
    );
    // Actual identity-only legacy rows remain readable with the original
    // binding; even they cannot be rewritten into a different Connect owner.
    let legacy = FileLifecycleFixture::new(database.url()).await;
    fenced(&legacy).await;
    let old = rollback_input(&legacy, vec![]).await;
    let original = legacy
        .provider
        .rollback_legacy_migration(legacy.collection_id, &old)
        .await
        .unwrap();
    sqlx::query("UPDATE hosted_provider_legacy_rollback_receipts SET provider_account_id=NULL WHERE collection_id=$1")
        .bind(legacy.collection_id).execute(&legacy.pool).await.unwrap();
    let mut identity = LegacyRollbackEnvelope {
        provider_account_id: old.owner_account_id,
        binding: old,
    };
    assert_eq!(
        legacy
            .provider
            .legacy_migration_rollback_receipt_v2(legacy.collection_id, &identity)
            .await
            .unwrap(),
        original
    );
    identity.binding.owner_account_id = Uuid::new_v4();
    assert_eq!(
        legacy
            .provider
            .legacy_migration_rollback_receipt_v2(legacy.collection_id, &identity)
            .await
            .unwrap_err()
            .code,
        "legacy_rollback_binding_conflict"
    );
}
