// Freezing and retaining hosted collections for the mdbase-next migration
// (mdbase-next docs/ship/migration.md H6-H10, §6).
#[allow(dead_code, unused_imports)]
mod support;
#[path = "support/test_postgres.rs"]
mod test_postgres;

use chrono::{Duration, Utc};
use mdbase_connect_hosted_provider::{app, AppState};
use mdbase_connect_protocol::*;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use support::FileLifecycleFixture;
use test_postgres::DisposablePostgres;
use uuid::Uuid;

fn upload() -> OpenFileUploadRequest {
    let bytes = b"after the freeze";
    OpenFileUploadRequest {
        protocol_version: FILE_PROTOCOL_VERSION,
        message_type: OpenFileUploadRequestKind::OpenFileUpload,
        transfer_id: Uuid::now_v7(),
        path: format!("frozen-{}.txt", Uuid::now_v7()),
        size: bytes.len() as u64,
        content_digest: format!("sha256:{:x}", Sha256::digest(bytes)),
        media_type: None,
        if_revision: None,
    }
}

async fn state_of(fixture: &FileLifecycleFixture) -> String {
    sqlx::query_scalar("SELECT state FROM hosted_provider_collections WHERE id = $1")
        .bind(fixture.collection_id)
        .fetch_one(&fixture.pool)
        .await
        .unwrap()
}

async fn queued(fixture: &FileLifecycleFixture, key: &str) -> i64 {
    sqlx::query_scalar::<_, i64>(
        "SELECT count(*) FROM hosted_provider_blob_deletions WHERE object_key = $1 AND attempts = 0",
    )
    .bind(key)
    .fetch_one(&fixture.pool)
    .await
    .unwrap()
}

async fn mirror_id(fixture: &FileLifecycleFixture) -> Uuid {
    sqlx::query_scalar("SELECT id FROM hosted_provider_replicas WHERE collection_id = $1")
        .bind(fixture.collection_id)
        .fetch_one(&fixture.pool)
        .await
        .unwrap()
}

#[tokio::test]
#[ignore = "requires the repository-approved disposable loopback PostgreSQL test target"]
async fn migrating_refuses_writes_and_rollback_reopens_them() {
    let database = DisposablePostgres::from_projection_env().await;
    let fixture = FileLifecycleFixture::new(database.url()).await;
    let provider = &fixture.provider;
    let id = fixture.collection_id;

    let status = provider
        .set_legacy_migration_state(id, "migrating", None, false)
        .await
        .unwrap();
    assert!(status.started_at.is_some());
    assert_eq!(state_of(&fixture).await, "migrating");
    let refused = provider
        .open_file_upload(id, &fixture.token, upload(), None)
        .await
        .expect_err("uploads are refused while migrating");
    assert_eq!(refused.status.as_u16(), 404, "{refused:?}");

    // Deletion and compaction keep the legacy data while migrating.
    let deletion = provider.delete_collection(id).await.unwrap_err();
    assert_eq!(deletion.code, "legacy_collection_retained");
    let compaction = provider.compact_through(id, 0).await.unwrap_err();
    assert_eq!(compaction.code, "legacy_collection_retained");

    // Rollback before cutover reopens writes.
    provider
        .set_legacy_migration_state(id, "active", None, false)
        .await
        .unwrap();
    provider
        .open_file_upload(id, &fixture.token, upload(), None)
        .await
        .expect("uploads resume after rollback");
}

#[tokio::test]
#[ignore = "requires the repository-approved disposable loopback PostgreSQL test target"]
async fn migrated_needs_ninety_days_of_retention_and_never_shortens_it() {
    let database = DisposablePostgres::from_projection_env().await;
    let fixture = FileLifecycleFixture::new(database.url()).await;
    let provider = &fixture.provider;
    let id = fixture.collection_id;

    let skipped = provider
        .set_legacy_migration_state(id, "migrated", Some(Utc::now() + Duration::days(31)), false)
        .await
        .unwrap_err();
    assert_eq!(skipped.code, "legacy_migration_transition_invalid");
    provider
        .set_legacy_migration_state(id, "migrating", None, false)
        .await
        .unwrap();
    let short = provider
        .set_legacy_migration_state(id, "migrated", Some(Utc::now() + Duration::days(45)), false)
        .await
        .unwrap_err();
    assert_eq!(short.code, "legacy_retention_too_short");
    let long = Utc::now() + Duration::days(120);
    provider
        .set_legacy_migration_state(id, "migrated", Some(long), false)
        .await
        .unwrap();
    let again = provider
        .set_legacy_migration_state(id, "migrated", Some(Utc::now() + Duration::days(91)), false)
        .await
        .unwrap();
    // PostgreSQL keeps microseconds.
    assert_eq!(
        again.retain_until.map(|t| t.timestamp_micros()),
        Some(long.timestamp_micros()),
        "retention is never shortened"
    );
    let deletion = provider.delete_collection(id).await.unwrap_err();
    assert_eq!(deletion.code, "legacy_collection_retained");

    // After cutover, rollback needs the reverse export verified at R (§6.2).
    let unverified = provider
        .set_legacy_migration_state(id, "active", None, false)
        .await
        .unwrap_err();
    assert_eq!(unverified.code, "legacy_rollback_unverified");
    assert_eq!(state_of(&fixture).await, "migrated");

    // Once retention has passed, the collection can be deleted.
    sqlx::query(
        "UPDATE hosted_provider_collections SET legacy_retain_until = now() - interval '1 second' WHERE id = $1",
    )
    .bind(id)
    .execute(&fixture.pool)
    .await
    .unwrap();
    provider.delete_collection(id).await.unwrap();
}

#[tokio::test]
#[ignore = "requires the repository-approved disposable loopback PostgreSQL test target"]
async fn retained_collections_keep_their_queued_blob_deletions() {
    let database = DisposablePostgres::from_projection_env().await;
    let fixture = FileLifecycleFixture::new(database.url()).await;
    let provider = &fixture.provider;
    let id = fixture.collection_id;
    let key = format!("v1/blobs/{id}/{}", Uuid::now_v7());
    let other = format!("v1/blobs/{}/{}", Uuid::now_v7(), Uuid::now_v7());
    provider
        .set_legacy_migration_state(id, "migrating", None, false)
        .await
        .unwrap();
    // Queued before or during the freeze, from any cause: the worker leaves it alone.
    sqlx::query(
        "INSERT INTO hosted_provider_blob_deletions (object_key, byte_length, reason) VALUES ($1, 1, 'test'), ($2, 1, 'test')",
    )
    .bind(&key)
    .bind(&other)
    .execute(&fixture.pool)
    .await
    .unwrap();
    let _ = provider.delete_pending_blobs(10).await;
    assert_eq!(
        queued(&fixture, &key).await,
        1,
        "a retained collection's object stays queued"
    );
    assert_eq!(
        queued(&fixture, &other).await,
        0,
        "other collections' queue entries are processed"
    );
    provider
        .set_legacy_migration_state(id, "migrated", Some(Utc::now() + Duration::days(91)), false)
        .await
        .unwrap();
    let _ = provider.delete_pending_blobs(10).await;
    assert_eq!(
        queued(&fixture, &key).await,
        1,
        "still retained after cutover"
    );
    // Rollback (before H9 it is direct) releases the entry to the worker again.
    provider
        .set_legacy_migration_state(id, "migrating", None, false)
        .await
        .unwrap();
    provider
        .set_legacy_migration_state(id, "active", None, false)
        .await
        .unwrap();
    let _ = provider.delete_pending_blobs(10).await;
    assert_eq!(
        queued(&fixture, &key).await,
        0,
        "an active collection's entry is attempted"
    );
}

#[tokio::test]
#[ignore = "requires the repository-approved disposable loopback PostgreSQL test target"]
async fn rollback_restores_only_replicas_revoked_during_the_migration() {
    let database = DisposablePostgres::from_projection_env().await;
    let fixture = FileLifecycleFixture::new(database.url()).await;
    let provider = &fixture.provider;
    let id = fixture.collection_id;
    let mirror = mirror_id(&fixture).await;

    // Not while active.
    let early = provider
        .restore_migration_revoked_replicas(id, &[mirror])
        .await
        .unwrap_err();
    assert_eq!(early.code, "legacy_migration_not_started");

    // A replica revoked before the migration stays revoked.
    provider.revoke_replica(mirror).await.unwrap();
    provider
        .set_legacy_migration_state(id, "migrating", None, false)
        .await
        .unwrap();
    let restored = provider
        .restore_migration_revoked_replicas(id, &[mirror])
        .await
        .unwrap();
    assert!(restored.is_empty());

    // One revoked at cutover is restored, over HTTP, and writes again after rollback.
    sqlx::query("UPDATE hosted_provider_replicas SET revoked_at = now() WHERE id = $1")
        .bind(mirror)
        .execute(&fixture.pool)
        .await
        .unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let token = "internal-legacy-migration-test-token-".repeat(2);
    let state = AppState::new(fixture.provider.clone(), &token).unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, app(state)).await.unwrap() });
    let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
    let client = reqwest::Client::new();
    let response = client
        .post(format!(
            "http://{address}/internal/v1/collections/{id}/legacy-migration/restore-replicas"
        ))
        .bearer_auth(&token)
        .json(&json!({ "replica_ids": [mirror, Uuid::now_v7()] }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), reqwest::StatusCode::OK);
    let body: Value = response.json().await.unwrap();
    assert_eq!(body["restored"], json!([mirror]));
    let response = client
        .put(format!(
            "http://{address}/internal/v1/collections/{id}/legacy-migration"
        ))
        .bearer_auth(&token)
        .json(&json!({ "state": "active" }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), reqwest::StatusCode::OK);
    let unauthorized = client
        .put(format!(
            "http://{address}/internal/v1/collections/{id}/legacy-migration"
        ))
        .json(&json!({ "state": "migrating" }))
        .send()
        .await
        .unwrap();
    assert_eq!(unauthorized.status(), reqwest::StatusCode::UNAUTHORIZED);
    server.abort();
    provider
        .open_file_upload(id, &fixture.token, upload(), None)
        .await
        .expect("the restored mirror writes again");
}

#[tokio::test]
#[ignore = "requires the repository-approved disposable loopback PostgreSQL test target"]
async fn drain_status_reports_live_accepted_mutations_until_they_resolve() {
    let database = DisposablePostgres::from_projection_env().await;
    let fixture = FileLifecycleFixture::new(database.url()).await;
    let provider = &fixture.provider;
    let id = fixture.collection_id;
    let mirror = mirror_id(&fixture).await;

    let idle = provider.legacy_migration_drain(id).await.unwrap();
    assert_eq!(
        (idle.state.as_str(), idle.in_flight, idle.unresolved),
        ("active", 0, 0)
    );

    // An accepted mutation still holding a live lease is in flight.
    let request = Uuid::now_v7();
    sqlx::query(
        r#"INSERT INTO hosted_provider_mutation_journal
             (replica_id, request_id, operation_kind, input_schema_version, input_digest,
              state, process_epoch, lease_owner, lease_expires_at, fencing_generation)
           VALUES ($1, $2, 'test', 1, '\x00', 'claimed', $3, $3, now() + interval '1 minute', 1)"#,
    )
    .bind(mirror)
    .bind(request)
    .bind(Uuid::now_v7())
    .execute(&fixture.pool)
    .await
    .unwrap();
    provider
        .set_legacy_migration_state(id, "migrating", None, false)
        .await
        .unwrap();
    let draining = provider.legacy_migration_drain(id).await.unwrap();
    assert_eq!(draining.state, "migrating");
    assert_eq!((draining.in_flight, draining.unresolved), (1, 1));
    assert!(draining.started_at.is_some());

    // Its lease lapses: it can no longer apply (the collection is fenced), so the
    // drain completes while the row stays visible as unresolved evidence.
    sqlx::query(
        "UPDATE hosted_provider_mutation_journal SET lease_expires_at = now() - interval '1 second' WHERE request_id = $1",
    )
    .bind(request)
    .execute(&fixture.pool)
    .await
    .unwrap();
    let drained = provider.legacy_migration_drain(id).await.unwrap();
    assert_eq!((drained.in_flight, drained.unresolved), (0, 1));
    assert_eq!(
        drained.head, draining.head,
        "the head is stable once drained"
    );

    let missing = provider
        .legacy_migration_drain(Uuid::now_v7())
        .await
        .unwrap_err();
    assert_eq!(missing.code, "hosted_collection_not_found");
}
