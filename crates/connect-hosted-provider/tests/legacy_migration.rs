// Freezing and retaining hosted collections for the mdbase-next migration
// (mdbase-next docs/ship/migration.md H6-H10, §6).
#[allow(dead_code, unused_imports)]
mod support;
#[path = "support/test_postgres.rs"]
mod test_postgres;

use chrono::{Duration, Utc};
use mdbase_connect_hosted_provider::{app, AppState, LegacyRollbackRequest};
use mdbase_connect_protocol::*;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::Row;
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
        .set_legacy_migration_state(id, "migrating", None, false, &[])
        .await
        .unwrap();
    assert!(status.started_at.is_some());
    assert!(status.migration_id.is_some());
    assert_eq!(state_of(&fixture).await, "migrating");
    let refused = provider
        .open_file_upload(id, &fixture.token, upload(), None)
        .await
        .expect_err("uploads are refused while migrating");
    assert_eq!(refused.status.as_u16(), 404, "{refused:?}");

    // Compaction keeps the legacy data while migrating.
    let compaction = provider.compact_through(id, 0).await.unwrap_err();
    assert_eq!(compaction.code, "legacy_collection_retained");

    // Rollback before cutover reopens writes.
    provider
        .set_legacy_migration_state(id, "active", None, false, &[])
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
        .set_legacy_migration_state(
            id,
            "migrated",
            Some(Utc::now() + Duration::days(31)),
            false,
            &[],
        )
        .await
        .unwrap_err();
    assert_eq!(skipped.code, "legacy_migration_transition_invalid");
    provider
        .set_legacy_migration_state(id, "migrating", None, false, &[])
        .await
        .unwrap();
    let short = provider
        .set_legacy_migration_state(
            id,
            "migrated",
            Some(Utc::now() + Duration::days(45)),
            false,
            &[],
        )
        .await
        .unwrap_err();
    assert_eq!(short.code, "legacy_retention_too_short");
    let long = Utc::now() + Duration::days(120);
    provider
        .set_legacy_migration_state(id, "migrated", Some(long), false, &[])
        .await
        .unwrap();
    let again = provider
        .set_legacy_migration_state(
            id,
            "migrated",
            Some(Utc::now() + Duration::days(91)),
            false,
            &[],
        )
        .await
        .unwrap();
    // PostgreSQL keeps microseconds.
    assert_eq!(
        again.retain_until.map(|t| t.timestamp_micros()),
        Some(long.timestamp_micros()),
        "retention is never shortened"
    );
    let compaction = provider.compact_through(id, 0).await.unwrap_err();
    assert_eq!(compaction.code, "legacy_collection_retained");

    // After cutover, rollback needs the reverse export verified at R (§6.2).
    let unverified = provider
        .set_legacy_migration_state(id, "active", None, false, &[])
        .await
        .unwrap_err();
    assert_eq!(unverified.code, "legacy_rollback_unverified");
    assert_eq!(state_of(&fixture).await, "migrated");
}

#[tokio::test]
#[ignore = "requires the repository-approved disposable loopback PostgreSQL test target"]
async fn deletion_is_terminal_during_retention_purges_and_refuses_rollback() {
    // Callum 2026-10-08: an account (or collection) deleted during migration is
    // deleted immediately; retention does not apply and rollback cannot revive it.
    let database = DisposablePostgres::from_projection_env().await;
    let fixture = FileLifecycleFixture::new(database.url()).await;
    let provider = &fixture.provider;
    let id = fixture.collection_id;
    let key = format!("v1/blobs/{id}/{}", Uuid::now_v7());
    provider
        .set_legacy_migration_state(id, "migrating", None, false, &[])
        .await
        .unwrap();
    provider
        .set_legacy_migration_state(
            id,
            "migrated",
            Some(Utc::now() + Duration::days(91)),
            false,
            &[],
        )
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO hosted_provider_blob_deletions (object_key, byte_length, reason) VALUES ($1, 1, 'test')",
    )
    .bind(&key)
    .execute(&fixture.pool)
    .await
    .unwrap();
    let _ = provider.delete_pending_blobs(10).await;
    assert_eq!(queued(&fixture, &key).await, 1, "retained while migrated");

    provider
        .delete_collection(id)
        .await
        .expect("deletion overrides retention");
    // The retained objects are released to the deletion worker (purged).
    let _ = provider.delete_pending_blobs(10).await;
    assert_eq!(queued(&fixture, &key).await, 0, "purged after deletion");
    // No rollback path accepts a deleted collection.
    for target in ["active", "migrating"] {
        let refused = provider
            .set_legacy_migration_state(id, target, None, true, &[])
            .await
            .unwrap_err();
        assert!(
            matches!(
                refused.code.as_str(),
                "collection_not_migratable" | "hosted_collection_not_found"
            ),
            "{refused:?}"
        );
    }
    let restore = provider
        .restore_migration_revoked_replicas(id, &[Uuid::now_v7()])
        .await
        .unwrap_err();
    assert!(
        matches!(
            restore.code.as_str(),
            "collection_not_migratable" | "hosted_collection_not_found"
        ),
        "{restore:?}"
    );
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
        .set_legacy_migration_state(id, "migrating", None, false, &[])
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
        .set_legacy_migration_state(
            id,
            "migrated",
            Some(Utc::now() + Duration::days(91)),
            false,
            &[],
        )
        .await
        .unwrap();
    let _ = provider.delete_pending_blobs(10).await;
    assert_eq!(
        queued(&fixture, &key).await,
        1,
        "still retained after cutover"
    );
    // Once cut over, going back through `migrating` does not reopen it: the
    // rollback to active needs the verified reverse export (review B1).
    provider
        .set_legacy_migration_state(id, "migrating", None, false, &[])
        .await
        .unwrap();
    let bypass = provider
        .set_legacy_migration_state(id, "active", None, false, &[])
        .await
        .unwrap_err();
    assert_eq!(bypass.code, "legacy_rollback_unverified");
    let _ = provider.delete_pending_blobs(10).await;
    assert_eq!(
        queued(&fixture, &key).await,
        1,
        "still retained while migrating"
    );
    provider
        .set_legacy_migration_state(id, "active", None, true, &[])
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
async fn rollback_restores_only_owned_replicas_and_h8_uses_internal_auth() {
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
        .set_legacy_migration_state(id, "migrating", None, false, &[])
        .await
        .unwrap();
    let restored = provider
        .restore_migration_revoked_replicas(id, &[mirror])
        .await
        .unwrap();
    assert!(restored.is_empty());

    // A different, live mirror is revoked by H8 and restored over HTTP.
    let fixture = FileLifecycleFixture::new(database.url()).await;
    let provider = &fixture.provider;
    let id = fixture.collection_id;
    let mirror = mirror_id(&fixture).await;
    provider
        .set_legacy_migration_state(id, "migrating", None, false, &[])
        .await
        .unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let token = "internal-legacy-migration-test-token-".repeat(2);
    let state = AppState::new(fixture.provider.clone(), &token).unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, app(state)).await.unwrap() });
    let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
    let client = reqwest::Client::new();
    let revoke_url =
        format!("http://{address}/internal/v1/collections/{id}/legacy-migration/revoke-replicas");
    let unauthorized = client
        .post(&revoke_url)
        .json(&json!({ "replica_ids": [mirror] }))
        .send()
        .await
        .unwrap();
    assert_eq!(unauthorized.status(), reqwest::StatusCode::UNAUTHORIZED);
    let revoked = client
        .post(&revoke_url)
        .bearer_auth(&token)
        .json(&json!({ "replica_ids": [mirror] }))
        .send()
        .await
        .unwrap();
    assert_eq!(revoked.status(), reqwest::StatusCode::OK);
    assert_eq!(
        revoked.json::<Value>().await.unwrap()["revoked"],
        json!([mirror])
    );
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
        .set_legacy_migration_state(id, "migrating", None, false, &[])
        .await
        .unwrap();
    let draining = provider.legacy_migration_drain(id).await.unwrap();
    // The provider itself refuses cutover while a write is in flight (review M1).
    let early = provider
        .set_legacy_migration_state(
            id,
            "migrated",
            Some(Utc::now() + Duration::days(91)),
            false,
            &[],
        )
        .await
        .unwrap_err();
    assert_eq!(early.code, "legacy_migration_not_drained");
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
    provider
        .set_legacy_migration_state(
            id,
            "migrated",
            Some(Utc::now() + Duration::days(91)),
            false,
            &[],
        )
        .await
        .expect("drained: cutover allowed");
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

#[tokio::test]
#[ignore = "requires the repository-approved disposable loopback PostgreSQL test target"]
async fn rollback_restores_revoked_replicas_atomically_and_the_fence_is_not_a_deletion() {
    let database = DisposablePostgres::from_projection_env().await;
    let fixture = FileLifecycleFixture::new(database.url()).await;
    let provider = &fixture.provider;
    let id = fixture.collection_id;
    let mirror = mirror_id(&fixture).await;
    provider
        .set_legacy_migration_state(id, "migrating", None, false, &[])
        .await
        .unwrap();
    // H8 records ownership of the revocation in the same transaction.
    assert_eq!(
        provider
            .revoke_migration_replicas(id, &[mirror])
            .await
            .unwrap(),
        vec![mirror]
    );
    assert_eq!(
        provider
            .revoke_migration_replicas(id, &[mirror])
            .await
            .unwrap(),
        vec![mirror],
        "retry is idempotent"
    );
    // Restore names are only accepted with the rollback itself.
    let wrong = provider
        .set_legacy_migration_state(id, "migrating", None, false, &[mirror])
        .await
        .unwrap_err();
    assert_eq!(wrong.code, "legacy_restore_requires_rollback");
    // Rotating a token on a frozen collection answers the distinct migrating
    // code, never the not-found that the control plane treats as deletion.
    let rotate = provider
        .rotate_replica_token(mirror, &"t".repeat(40), None)
        .await
        .unwrap_err();
    assert_eq!(rotate.code, "collection_migrating");
    let status = provider
        .set_legacy_migration_state(id, "active", None, false, &[mirror])
        .await
        .unwrap();
    assert_eq!(status.restored, vec![mirror]);
    let revoked: Option<chrono::DateTime<Utc>> =
        sqlx::query_scalar("SELECT revoked_at FROM hosted_provider_replicas WHERE id = $1")
            .bind(mirror)
            .fetch_one(&fixture.pool)
            .await
            .unwrap();
    assert!(revoked.is_none(), "restored in the same transaction");
    provider
        .open_file_upload(id, &fixture.token, upload(), None)
        .await
        .expect("writes again after rollback");
}

#[tokio::test]
#[ignore = "requires the repository-approved disposable loopback PostgreSQL test target"]
async fn independent_or_rewritten_revocations_are_never_restored_by_rollback() {
    let database = DisposablePostgres::from_projection_env().await;
    for mode in [
        "user_before_h8",
        "user_after_h8",
        "no_provenance",
        "rewritten",
        "old_run",
        "no_run",
    ] {
        let fixture = FileLifecycleFixture::new(database.url()).await;
        let provider = &fixture.provider;
        let id = fixture.collection_id;
        let mirror = mirror_id(&fixture).await;
        let started = provider
            .set_legacy_migration_state(id, "migrating", None, false, &[])
            .await
            .unwrap();
        match mode {
            "user_before_h8" => {
                provider.revoke_replica(mirror).await.unwrap();
                assert!(provider
                    .revoke_migration_replicas(id, &[mirror])
                    .await
                    .unwrap()
                    .is_empty());
            }
            "user_after_h8" => {
                provider
                    .revoke_migration_replicas(id, &[mirror])
                    .await
                    .unwrap();
                // The user reaffirms the revocation while the collection is fenced.
                provider.revoke_replica(mirror).await.unwrap();
                assert!(
                    provider
                        .revoke_migration_replicas(id, &[mirror])
                        .await
                        .unwrap()
                        .is_empty(),
                    "H8 retries cannot adopt a user's revocation"
                );
            }
            "no_provenance" => {
                sqlx::query("UPDATE hosted_provider_replicas SET revoked_at = now() WHERE id = $1")
                    .bind(mirror)
                    .execute(&fixture.pool)
                    .await
                    .unwrap();
            }
            "rewritten" => {
                provider
                    .revoke_migration_replicas(id, &[mirror])
                    .await
                    .unwrap();
                sqlx::query("UPDATE hosted_provider_replicas SET revoked_at = revoked_at + interval '1 second' WHERE id = $1").bind(mirror).execute(&fixture.pool).await.unwrap();
            }
            "old_run" => {
                provider
                    .revoke_migration_replicas(id, &[mirror])
                    .await
                    .unwrap();
                provider
                    .set_legacy_migration_state(id, "active", None, false, &[])
                    .await
                    .unwrap();
                let fresh = provider
                    .set_legacy_migration_state(id, "migrating", None, false, &[])
                    .await
                    .unwrap();
                assert_ne!(fresh.migration_id, started.migration_id);
            }
            "no_run" => {
                provider
                    .revoke_migration_replicas(id, &[mirror])
                    .await
                    .unwrap();
                sqlx::query("UPDATE hosted_provider_collections SET legacy_migration_id = NULL WHERE id = $1").bind(id).execute(&fixture.pool).await.unwrap();
            }
            _ => unreachable!(),
        }
        assert!(
            provider
                .restore_migration_revoked_replicas(id, &[mirror])
                .await
                .unwrap()
                .is_empty(),
            "{mode}: standalone restore must refuse"
        );
        let rolled_back = provider
            .set_legacy_migration_state(id, "active", None, false, &[mirror])
            .await
            .unwrap();
        assert!(
            rolled_back.restored.is_empty(),
            "{mode}: caller's list is not provenance"
        );
        let revoked: Option<chrono::DateTime<Utc>> =
            sqlx::query_scalar("SELECT revoked_at FROM hosted_provider_replicas WHERE id = $1")
                .bind(mirror)
                .fetch_one(&fixture.pool)
                .await
                .unwrap();
        assert!(
            revoked.is_some(),
            "{mode}: mirror stays revoked; re-link required"
        );
    }
}

#[tokio::test]
#[ignore = "requires the repository-approved disposable loopback PostgreSQL test target"]
async fn rollback_receipt_requires_drain_and_refuses_foreign_replica_scope() {
    let database = DisposablePostgres::from_projection_env().await;
    let fixture = FileLifecycleFixture::new(database.url()).await;
    let foreign = FileLifecycleFixture::new(database.url()).await;
    let id = fixture.collection_id;
    let mirror = mirror_id(&fixture).await;
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
    fenced(&fixture).await;
    let input = rollback_input(&fixture, vec![mirror]).await;
    assert_eq!(
        fixture
            .provider
            .rollback_legacy_migration(id, &input)
            .await
            .unwrap_err()
            .code,
        "legacy_migration_not_drained"
    );
    assert_eq!(state_of(&fixture).await, "migrating");
    sqlx::query("UPDATE hosted_provider_mutation_journal SET lease_expires_at = now() - interval '1 second' WHERE request_id = $1")
        .bind(request).execute(&fixture.pool).await.unwrap();
    let mut wrong = input.clone();
    wrong.replica_ids.push(mirror_id(&foreign).await);
    assert_eq!(
        fixture
            .provider
            .rollback_legacy_migration(id, &wrong)
            .await
            .unwrap_err()
            .code,
        "legacy_rollback_binding_conflict"
    );
    let receipt = fixture
        .provider
        .rollback_legacy_migration(id, &input)
        .await
        .unwrap();
    assert!(receipt.restored_ids.is_empty()); // this mirror was not migration-revoked
}

#[tokio::test]
#[ignore = "requires the repository-approved disposable loopback PostgreSQL test target"]
async fn rollback_receipt_replaced_or_deleted_collection_cannot_reuse_the_old_run() {
    let database = DisposablePostgres::from_projection_env().await;
    let fixture = FileLifecycleFixture::new(database.url()).await;
    let id = fixture.collection_id;
    fenced(&fixture).await;
    let input = rollback_input(&fixture, vec![]).await;
    fixture
        .provider
        .rollback_legacy_migration(id, &input)
        .await
        .unwrap();
    sqlx::query("DELETE FROM hosted_provider_collections WHERE id = $1")
        .bind(id)
        .execute(&fixture.pool)
        .await
        .unwrap();
    assert_eq!(
        fixture
            .provider
            .legacy_migration_rollback_receipt(id, &input)
            .await
            .unwrap_err()
            .code,
        "hosted_collection_not_found"
    );
    fixture
        .provider
        .create_collection(input.owner_account_id, id, "mdbase", "Replacement", "UTC")
        .await
        .unwrap();
    fenced(&fixture).await;
    assert_eq!(
        fixture
            .provider
            .rollback_legacy_migration(id, &input)
            .await
            .unwrap_err()
            .code,
        "legacy_rollback_binding_conflict"
    );
    assert_eq!(state_of(&fixture).await, "migrating");
}

async fn rollback_input(
    fixture: &FileLifecycleFixture,
    replica_ids: Vec<Uuid>,
) -> LegacyRollbackRequest {
    let row = sqlx::query("SELECT account_id, legacy_migration_id, authority_epoch, head FROM hosted_provider_collections WHERE id = $1")
        .bind(fixture.collection_id).fetch_one(&fixture.pool).await.unwrap();
    LegacyRollbackRequest {
        owner_account_id: row.get::<Option<Uuid>, _>("account_id").unwrap(),
        provider_migration_id: row.get::<Option<Uuid>, _>("legacy_migration_id").unwrap(),
        authority_epoch: row.get("authority_epoch"),
        fixed_head: row.get("head"),
        driver_id: Uuid::new_v4(),
        action_id: Uuid::new_v4(),
        replica_ids,
    }
}

async fn fenced(fixture: &FileLifecycleFixture) {
    fixture
        .provider
        .set_legacy_migration_state(fixture.collection_id, "migrating", None, false, &[])
        .await
        .unwrap();
}

#[tokio::test]
#[ignore = "requires the repository-approved disposable loopback PostgreSQL test target"]
async fn rollback_receipt_restores_owned_ids_and_survives_lost_reply_and_old_writes() {
    let database = DisposablePostgres::from_projection_env().await;
    let fixture = FileLifecycleFixture::new(database.url()).await;
    let id = fixture.collection_id;
    let mirror = mirror_id(&fixture).await;
    fenced(&fixture).await;
    assert_eq!(
        fixture
            .provider
            .revoke_migration_replicas(id, &[mirror])
            .await
            .unwrap(),
        vec![mirror]
    );
    let input = rollback_input(&fixture, vec![mirror]).await;
    let receipt = fixture
        .provider
        .rollback_legacy_migration(id, &input)
        .await
        .unwrap();
    assert_eq!(receipt.binding, input);
    assert_eq!(receipt.restored_ids, vec![mirror]);
    assert_eq!(state_of(&fixture).await, "active");
    fixture
        .provider
        .open_file_upload(id, &fixture.token, upload(), None)
        .await
        .unwrap();
    // Model ordinary old writes advancing the already-reopened source head.
    sqlx::query("UPDATE hosted_provider_collections SET head = head + 1 WHERE id = $1")
        .bind(id)
        .execute(&fixture.pool)
        .await
        .unwrap();
    let reopened = fixture.provider.clone();
    assert_eq!(
        reopened
            .legacy_migration_rollback_receipt(id, &input)
            .await
            .unwrap(),
        receipt
    );
    assert_eq!(
        reopened
            .rollback_legacy_migration(id, &input)
            .await
            .unwrap(),
        receipt
    );
}

#[tokio::test]
#[ignore = "requires the repository-approved disposable loopback PostgreSQL test target"]
async fn rollback_receipt_empty_scope_and_missing_lookup_never_infer_success() {
    let database = DisposablePostgres::from_projection_env().await;
    let fixture = FileLifecycleFixture::new(database.url()).await;
    let id = fixture.collection_id;
    fenced(&fixture).await;
    let input = rollback_input(&fixture, vec![]).await;
    assert_eq!(
        fixture
            .provider
            .legacy_migration_rollback_receipt(id, &input)
            .await
            .unwrap_err()
            .code,
        "legacy_rollback_receipt_unknown"
    );
    assert_eq!(state_of(&fixture).await, "migrating");
    let receipt = fixture
        .provider
        .rollback_legacy_migration(id, &input)
        .await
        .unwrap();
    assert!(receipt.restored_ids.is_empty());
    assert_eq!(
        fixture
            .provider
            .legacy_migration_rollback_receipt(id, &input)
            .await
            .unwrap(),
        receipt
    );

    let fixture = FileLifecycleFixture::new(database.url()).await;
    fenced(&fixture).await;
    let input = rollback_input(&fixture, vec![]).await;
    fixture
        .provider
        .set_legacy_migration_state(fixture.collection_id, "active", None, false, &[])
        .await
        .unwrap();
    assert_eq!(
        fixture
            .provider
            .legacy_migration_rollback_receipt(fixture.collection_id, &input)
            .await
            .unwrap_err()
            .code,
        "legacy_rollback_receipt_unknown"
    );
    assert_eq!(
        fixture
            .provider
            .rollback_legacy_migration(fixture.collection_id, &input)
            .await
            .unwrap_err()
            .code,
        "legacy_rollback_binding_conflict"
    );
}

#[tokio::test]
#[ignore = "requires the repository-approved disposable loopback PostgreSQL test target"]
async fn rollback_receipt_source_and_replay_bindings_fail_closed() {
    let database = DisposablePostgres::from_projection_env().await;
    let fixture = FileLifecycleFixture::new(database.url()).await;
    let id = fixture.collection_id;
    fenced(&fixture).await;
    let input = rollback_input(&fixture, vec![]).await;
    for field in [
        "owner_account_id",
        "provider_migration_id",
        "authority_epoch",
        "fixed_head",
    ] {
        let mut wrong = input.clone();
        match field {
            "owner_account_id" => wrong.owner_account_id = Uuid::new_v4(),
            "provider_migration_id" => wrong.provider_migration_id = Uuid::new_v4(),
            "authority_epoch" => wrong.authority_epoch += 1,
            "fixed_head" => wrong.fixed_head += 1,
            _ => unreachable!(),
        }
        assert_eq!(
            fixture
                .provider
                .rollback_legacy_migration(id, &wrong)
                .await
                .unwrap_err()
                .code,
            "legacy_rollback_binding_conflict",
            "{field}"
        );
        assert_eq!(state_of(&fixture).await, "migrating");
    }
    let receipt = fixture
        .provider
        .rollback_legacy_migration(id, &input)
        .await
        .unwrap();
    for field in ["driver_id", "action_id", "replica_ids"] {
        let mut wrong = input.clone();
        match field {
            "driver_id" => wrong.driver_id = Uuid::new_v4(),
            "action_id" => wrong.action_id = Uuid::new_v4(),
            "replica_ids" => wrong.replica_ids.push(Uuid::new_v4()),
            _ => unreachable!(),
        }
        assert_eq!(
            fixture
                .provider
                .legacy_migration_rollback_receipt(id, &wrong)
                .await
                .unwrap_err()
                .code,
            "legacy_rollback_binding_conflict",
            "{field}"
        );
        assert_eq!(
            fixture
                .provider
                .rollback_legacy_migration(id, &wrong)
                .await
                .unwrap_err()
                .code,
            "legacy_rollback_binding_conflict",
            "{field}"
        );
    }
    assert_eq!(
        fixture
            .provider
            .legacy_migration_rollback_receipt(id, &input)
            .await
            .unwrap(),
        receipt
    );
}

#[tokio::test]
#[ignore = "requires the repository-approved disposable loopback PostgreSQL test target"]
async fn rollback_receipt_preserves_independent_revocations() {
    let database = DisposablePostgres::from_projection_env().await;
    let fixture = FileLifecycleFixture::new(database.url()).await;
    let id = fixture.collection_id;
    let mirror = mirror_id(&fixture).await;
    fenced(&fixture).await;
    fixture
        .provider
        .revoke_migration_replicas(id, &[mirror])
        .await
        .unwrap();
    fixture.provider.revoke_replica(mirror).await.unwrap();
    let input = rollback_input(&fixture, vec![mirror]).await;
    let receipt = fixture
        .provider
        .rollback_legacy_migration(id, &input)
        .await
        .unwrap();
    assert!(receipt.restored_ids.is_empty());
    let revoked: Option<chrono::DateTime<Utc>> =
        sqlx::query_scalar("SELECT revoked_at FROM hosted_provider_replicas WHERE id = $1")
            .bind(mirror)
            .fetch_one(&fixture.pool)
            .await
            .unwrap();
    assert!(revoked.is_some());
    assert!(fixture
        .provider
        .open_file_upload(id, &fixture.token, upload(), None)
        .await
        .is_err());
}

#[tokio::test]
#[ignore = "requires the repository-approved disposable loopback PostgreSQL test target"]
async fn rollback_receipt_insert_failure_rolls_back_restore_and_active() {
    let database = DisposablePostgres::from_projection_env().await;
    let first = FileLifecycleFixture::new(database.url()).await;
    fenced(&first).await;
    let first_input = rollback_input(&first, vec![]).await;
    first
        .provider
        .rollback_legacy_migration(first.collection_id, &first_input)
        .await
        .unwrap();
    let fixture = FileLifecycleFixture::new(database.url()).await;
    let id = fixture.collection_id;
    let mirror = mirror_id(&fixture).await;
    fenced(&fixture).await;
    fixture
        .provider
        .revoke_migration_replicas(id, &[mirror])
        .await
        .unwrap();
    let mut input = rollback_input(&fixture, vec![mirror]).await;
    input.driver_id = first_input.driver_id;
    input.action_id = first_input.action_id;
    assert_eq!(
        fixture
            .provider
            .rollback_legacy_migration(id, &input)
            .await
            .unwrap_err()
            .code,
        "legacy_rollback_binding_conflict"
    );
    assert_eq!(state_of(&fixture).await, "migrating");
    let revoked: Option<chrono::DateTime<Utc>> =
        sqlx::query_scalar("SELECT revoked_at FROM hosted_provider_replicas WHERE id = $1")
            .bind(mirror)
            .fetch_one(&fixture.pool)
            .await
            .unwrap();
    assert!(revoked.is_some());
    input.action_id = Uuid::new_v4();
    assert_eq!(
        fixture
            .provider
            .rollback_legacy_migration(id, &input)
            .await
            .unwrap()
            .restored_ids,
        vec![mirror]
    );
}

#[tokio::test]
#[ignore = "requires the repository-approved disposable loopback PostgreSQL test target"]
async fn rollback_receipt_is_not_revived_by_a_later_migration_or_reverse_flag() {
    let database = DisposablePostgres::from_projection_env().await;
    let fixture = FileLifecycleFixture::new(database.url()).await;
    let id = fixture.collection_id;
    fenced(&fixture).await;
    let input = rollback_input(&fixture, vec![]).await;
    fixture
        .provider
        .rollback_legacy_migration(id, &input)
        .await
        .unwrap();
    fenced(&fixture).await;
    assert_eq!(
        fixture
            .provider
            .legacy_migration_rollback_receipt(id, &input)
            .await
            .unwrap_err()
            .code,
        "legacy_rollback_binding_conflict"
    );
    fixture
        .provider
        .set_legacy_migration_state(id, "active", None, false, &[])
        .await
        .unwrap();
    assert_eq!(
        fixture
            .provider
            .rollback_legacy_migration(id, &input)
            .await
            .unwrap_err()
            .code,
        "legacy_rollback_binding_conflict"
    );
    fenced(&fixture).await;
    let input = rollback_input(&fixture, vec![]).await;
    fixture
        .provider
        .set_legacy_migration_state(
            id,
            "migrated",
            Some(Utc::now() + Duration::days(91)),
            false,
            &[],
        )
        .await
        .unwrap();
    assert_eq!(
        fixture
            .provider
            .rollback_legacy_migration(id, &input)
            .await
            .unwrap_err()
            .code,
        "legacy_rollback_binding_conflict"
    );
    assert_eq!(state_of(&fixture).await, "migrated");
}

#[tokio::test]
#[ignore = "requires the repository-approved disposable loopback PostgreSQL test target"]
async fn rollback_receipt_owner_is_checked_after_collection_lock_wait() {
    let database = DisposablePostgres::from_projection_env().await;
    let fixture = FileLifecycleFixture::new(database.url()).await;
    let id = fixture.collection_id;
    fenced(&fixture).await;
    let input = rollback_input(&fixture, vec![]).await;
    let mut transaction = fixture.pool.begin().await.unwrap();
    sqlx::query("UPDATE hosted_provider_collections SET account_id = NULL WHERE id = $1")
        .bind(id)
        .execute(&mut *transaction)
        .await
        .unwrap();
    let provider = fixture.provider.clone();
    let task = tokio::spawn(async move { provider.rollback_legacy_migration(id, &input).await });
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    assert!(!task.is_finished());
    transaction.commit().await.unwrap();
    assert_eq!(
        task.await.unwrap().unwrap_err().code,
        "legacy_rollback_binding_conflict"
    );
    assert_eq!(state_of(&fixture).await, "migrating");
}

#[tokio::test]
#[ignore = "requires the repository-approved disposable loopback PostgreSQL test target"]
async fn rollback_receipt_http_requires_internal_auth_and_lookup_is_read_only() {
    let database = DisposablePostgres::from_projection_env().await;
    let fixture = FileLifecycleFixture::new(database.url()).await;
    let id = fixture.collection_id;
    fenced(&fixture).await;
    let input = rollback_input(&fixture, vec![]).await;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let token = "internal-rollback-receipt-test-token-".repeat(2);
    let state = AppState::new(fixture.provider.clone(), &token).unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, app(state)).await.unwrap() });
    let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
    let client = reqwest::Client::new();
    let base = format!("http://{address}/internal/v1/collections/{id}/legacy-migration");
    for path in ["rollback", "rollback-receipt"] {
        assert_eq!(
            client
                .post(format!("{base}/{path}"))
                .json(&input)
                .send()
                .await
                .unwrap()
                .status(),
            reqwest::StatusCode::UNAUTHORIZED
        );
    }
    assert_eq!(
        client
            .post(format!("{base}/rollback-receipt"))
            .bearer_auth(&token)
            .json(&input)
            .send()
            .await
            .unwrap()
            .status(),
        reqwest::StatusCode::NOT_FOUND
    );
    assert_eq!(state_of(&fixture).await, "migrating");
    let response = client
        .post(format!("{base}/rollback"))
        .bearer_auth(&token)
        .json(&input)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), reqwest::StatusCode::OK);
    let receipt: Value = response.json().await.unwrap();
    let response = client
        .post(format!("{base}/rollback-receipt"))
        .bearer_auth(&token)
        .json(&input)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), reqwest::StatusCode::OK);
    assert_eq!(response.json::<Value>().await.unwrap(), receipt);
    server.abort();
}
