#![allow(dead_code, unused_imports)]

mod support;

use chrono::{DateTime, SecondsFormat, Utc};
use mdbase_connect_hosted_provider::{RegisterReplica, ReplicaPurpose};
use mdbase_connect_protocol::{
    SyncMutation, SyncMutationOperation, SyncMutationReceipt, SyncReplicaMode,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::Row;
use std::time::{Duration, Instant};
use support::{wait_for_database_condition, wait_for_query_blocked, FileLifecycleFixture};
use uuid::Uuid;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires a clean MDBASE_PROJECTION_DATABASE_URL disposable PostgreSQL database"]
async fn candidate_b_migration_0040_upgrades_a_live_legacy_base_cursor() {
    let database_url = std::env::var("MDBASE_PROJECTION_DATABASE_URL")
        .expect("MDBASE_PROJECTION_DATABASE_URL is required");
    let pool = sqlx::PgPool::connect(&database_url).await.unwrap();
    let mut pre_invocation = sqlx::migrate!("./migrations");
    pre_invocation
        .migrations
        .to_mut()
        .retain(|migration| migration.version < 40);
    pre_invocation.run(&pool).await.unwrap();

    let collection_id = Uuid::now_v7();
    let replica_id = Uuid::now_v7();
    let cursor_id = Uuid::now_v7();
    sqlx::query(
        r#"INSERT INTO hosted_provider_collections
             (id, template, spec_version, max_records, max_content_bytes,
              max_document_bytes, max_mirror_replicas, resource_revision,
              wrapped_data_key, resources_ciphertext, timezone,
              max_application_replicas)
           VALUES ($1, 'blank', '0.3', 10000, 1073741824, 16777216, 5,
                   'legacy-catalog', '\x00', '\x00', 'UTC', 5)"#,
    )
    .bind(collection_id)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        r#"INSERT INTO hosted_provider_replicas
             (id, collection_id, name, purpose, mode, full_collection,
              token_hash, token_expires_at)
           VALUES ($1, $2, 'legacy Base cursor', 'application', 'read_only', true,
                   decode(repeat('11', 32), 'hex'), now() + interval '1 day')"#,
    )
    .bind(replica_id)
    .bind(collection_id)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        r#"INSERT INTO hosted_provider_query_cursors
             (cursor_id, collection_id, replica_id, scope_epoch, snapshot_head,
              catalog_revision, projection_format_version,
              semantic_engine_version, query_plan_version, query_digest,
              query_plan, emitted_rows, expires_at, hard_expires_at,
              request_kind, request_digest, result_meta, base_plan,
              base_context, base_operation_clock)
           VALUES ($1, $2, $3, 1, 0, 'legacy-catalog', 3, '0.4.0-rc.4', 1,
                   decode(repeat('22', 32), 'hex'), '{}'::jsonb, 1,
                   now() + interval '5 minutes', now() + interval '1 hour',
                   'obsidian_base', decode(repeat('33', 32), 'hex'), '{}'::jsonb,
                   '{"plan_version":3}'::jsonb, '{"path":"context.md"}'::jsonb,
                   '2026-08-16T00:00:00Z')"#,
    )
    .bind(cursor_id)
    .bind(collection_id)
    .bind(replica_id)
    .execute(&pool)
    .await
    .unwrap();

    let mut pre_ciphertext_proof = sqlx::migrate!("./migrations");
    pre_ciphertext_proof
        .migrations
        .to_mut()
        .retain(|migration| migration.version < 50);
    pre_ciphertext_proof.run(&pool).await.unwrap();
    let migrated = sqlx::query(
        r#"SELECT c.base_invocation_id, c.base_plan, c.base_context,
                  c.base_operation_clock, i.base_plan AS invocation_plan,
                  i.base_context AS invocation_context
           FROM hosted_provider_query_cursors c
           JOIN hosted_provider_base_query_invocations i
             ON i.invocation_id = c.base_invocation_id
           WHERE c.cursor_id = $1"#,
    )
    .bind(cursor_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(migrated.get::<Uuid, _>("base_invocation_id"), cursor_id);
    assert!(migrated
        .get::<Option<serde_json::Value>, _>("base_plan")
        .is_none());
    assert!(migrated
        .get::<Option<serde_json::Value>, _>("base_context")
        .is_none());
    assert!(migrated
        .get::<Option<String>, _>("base_operation_clock")
        .is_none());
    assert_eq!(
        migrated.get::<serde_json::Value, _>("invocation_plan")["plan_version"],
        3
    );
    assert_eq!(
        migrated.get::<serde_json::Value, _>("invocation_context")["path"],
        "context.md"
    );
    sqlx::query("DELETE FROM hosted_provider_query_cursors WHERE cursor_id = $1")
        .bind(cursor_id)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM hosted_provider_base_query_invocations WHERE invocation_id = $1")
        .bind(cursor_id)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::migrate!("./migrations").run(&pool).await.unwrap();

    // A pre-0050 rollback binary omits scan_budget_ciphertext_bytes. The
    // expand migration must keep that writer operational until rollout ends.
    let rollback_cursor_id = Uuid::now_v7();
    sqlx::query(
        r#"INSERT INTO hosted_provider_query_cursors
             (cursor_id, collection_id, replica_id, scope_epoch, snapshot_head,
              generation_id, catalog_revision, projection_format_version,
              semantic_engine_version, query_plan_version, query_digest, query_plan,
              request_kind, request_digest, result_meta, exact_context_ciphertext,
              base_plan, base_context, base_operation_clock, base_invocation_id,
              last_order_values, last_record_id, emitted_rows, expires_at, hard_expires_at,
              execution_proof_version, execution_proof_ciphertext,
              execution_proof_bytes, snapshot_record_count, scan_budget_records,
              projection_integrity_epoch, cursor_bytes)
           VALUES ($1, $2, $3, 1, 0, NULL, 'legacy-catalog', 3,
                   '0.4.0-rc.4', 1, decode(repeat('44', 32), 'hex'), '{}'::jsonb,
                   'query', decode(repeat('55', 32), 'hex'), '{}'::jsonb, NULL,
                   NULL, NULL, NULL, NULL, NULL, NULL, 0,
                   now() + interval '5 minutes', now() + interval '1 hour',
                   1, decode('01', 'hex'), 1, 0, 100000, NULL, 1)"#,
    )
    .bind(rollback_cursor_id)
    .bind(collection_id)
    .bind(replica_id)
    .execute(&pool)
    .await
    .unwrap();
    let rollback_ciphertext_budget: i64 = sqlx::query_scalar(
        "SELECT scan_budget_ciphertext_bytes FROM hosted_provider_query_cursors WHERE cursor_id = $1",
    )
    .bind(rollback_cursor_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(rollback_ciphertext_budget, 1_073_741_824);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires MDBASE_PROJECTION_DATABASE_URL; run against a disposable PostgreSQL database"]
async fn candidate_b_projection_rebuild_abandons_an_oversized_first_record() {
    let database_url = std::env::var("MDBASE_PROJECTION_DATABASE_URL")
        .expect("MDBASE_PROJECTION_DATABASE_URL is required");
    let fixture = FileLifecycleFixture::new(&database_url).await;
    let replica = sqlx::query(
        "SELECT id, scope_epoch FROM hosted_provider_replicas WHERE collection_id = $1",
    )
    .bind(fixture.collection_id)
    .fetch_one(&fixture.pool)
    .await
    .unwrap();
    let record_id = Uuid::now_v7();
    put(
        &fixture,
        replica.get("id"),
        u64::try_from(replica.get::<i64, _>("scope_epoch")).unwrap(),
        record_id,
        None,
        "oversized.md",
        "Small canonical record before the corruption fixture.\n",
    )
    .await;
    sqlx::query(
        r#"UPDATE hosted_provider_record_versions
           SET payload_ciphertext = decode(repeat('00', 16777217), 'hex')
           WHERE collection_id = $1 AND record_id = $2 AND deleted = false"#,
    )
    .bind(fixture.collection_id)
    .bind(record_id)
    .execute(&fixture.pool)
    .await
    .unwrap();

    let generation = fixture
        .provider
        .start_projection_generation(fixture.collection_id)
        .await
        .unwrap();
    let error = fixture
        .provider
        .project_generation_batch(fixture.collection_id, generation.generation_id, 1)
        .await
        .unwrap_err();
    assert_eq!(error.code, "projection_record_too_large");
    assert_eq!(error.details.as_ref().unwrap()["terminal"], true);
    let state = sqlx::query(
        r#"SELECT status, last_error_code, lease_owner, abandoned_at
           FROM hosted_provider_projection_generations
           WHERE collection_id = $1 AND generation_id = $2"#,
    )
    .bind(fixture.collection_id)
    .bind(generation.generation_id)
    .fetch_one(&fixture.pool)
    .await
    .unwrap();
    assert_eq!(state.get::<String, _>("status"), "abandoned");
    assert_eq!(
        state.get::<Option<String>, _>("last_error_code").as_deref(),
        Some("projection_record_too_large")
    );
    assert!(state.get::<Option<Uuid>, _>("lease_owner").is_none());
    assert!(state
        .get::<Option<DateTime<Utc>>, _>("abandoned_at")
        .is_some());
    let generation_count_before: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM hosted_provider_projection_generations WHERE collection_id = $1",
    )
    .bind(fixture.collection_id)
    .fetch_one(&fixture.pool)
    .await
    .unwrap();
    fixture
        .provider
        .recover_projection_generations(100)
        .await
        .unwrap();
    let generation_count_after: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM hosted_provider_projection_generations WHERE collection_id = $1",
    )
    .bind(fixture.collection_id)
    .fetch_one(&fixture.pool)
    .await
    .unwrap();
    assert_eq!(generation_count_after, generation_count_before);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires MDBASE_PROJECTION_DATABASE_URL; run against a disposable PostgreSQL database"]
async fn candidate_b_projection_rebuild_quarantines_an_oversized_semantic_projection() {
    let database_url = std::env::var("MDBASE_PROJECTION_DATABASE_URL")
        .expect("MDBASE_PROJECTION_DATABASE_URL is required");
    let fixture = FileLifecycleFixture::new(&database_url).await;
    let replica = sqlx::query(
        "SELECT id, scope_epoch FROM hosted_provider_replicas WHERE collection_id = $1",
    )
    .bind(fixture.collection_id)
    .fetch_one(&fixture.pool)
    .await
    .unwrap();
    let document = format!(
        "---\ntitle: {}\n---\nBounded exact body.\n",
        "x".repeat(300_000)
    );
    put(
        &fixture,
        replica.get("id"),
        u64::try_from(replica.get::<i64, _>("scope_epoch")).unwrap(),
        Uuid::now_v7(),
        None,
        "semantic-oversized.md",
        &document,
    )
    .await;

    let generation = fixture
        .provider
        .start_projection_generation(fixture.collection_id)
        .await
        .unwrap();
    let error = fixture
        .provider
        .project_generation_batch(fixture.collection_id, generation.generation_id, 1)
        .await
        .unwrap_err();
    assert_eq!(error.code, "projection_record_too_large");
    assert_eq!(
        error.details.as_ref().unwrap()["budget"],
        "semantic_projection_bytes"
    );
    assert_eq!(error.details.as_ref().unwrap()["terminal"], true);
    let state = sqlx::query(
        r#"SELECT status, last_error_code, lease_owner, abandoned_at
           FROM hosted_provider_projection_generations
           WHERE collection_id = $1 AND generation_id = $2"#,
    )
    .bind(fixture.collection_id)
    .bind(generation.generation_id)
    .fetch_one(&fixture.pool)
    .await
    .unwrap();
    assert_eq!(state.get::<String, _>("status"), "abandoned");
    assert_eq!(
        state.get::<Option<String>, _>("last_error_code").as_deref(),
        Some("projection_record_too_large")
    );
    assert!(state.get::<Option<Uuid>, _>("lease_owner").is_none());

    let generation_count_before: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM hosted_provider_projection_generations WHERE collection_id = $1",
    )
    .bind(fixture.collection_id)
    .fetch_one(&fixture.pool)
    .await
    .unwrap();
    fixture
        .provider
        .recover_projection_generations(100)
        .await
        .unwrap();
    let generation_count_after: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM hosted_provider_projection_generations WHERE collection_id = $1",
    )
    .bind(fixture.collection_id)
    .fetch_one(&fixture.pool)
    .await
    .unwrap();
    assert_eq!(generation_count_after, generation_count_before);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires MDBASE_PROJECTION_DATABASE_URL; run against a disposable PostgreSQL database"]
async fn candidate_b_projection_resolution_quarantines_an_oversized_final_projection() {
    let database_url = std::env::var("MDBASE_PROJECTION_DATABASE_URL")
        .expect("MDBASE_PROJECTION_DATABASE_URL is required");
    let fixture = FileLifecycleFixture::new(&database_url).await;
    let replica = sqlx::query(
        "SELECT id, scope_epoch FROM hosted_provider_replicas WHERE collection_id = $1",
    )
    .bind(fixture.collection_id)
    .fetch_one(&fixture.pool)
    .await
    .unwrap();
    let replica_id = replica.get("id");
    let scope_epoch = u64::try_from(replica.get::<i64, _>("scope_epoch")).unwrap();
    put(
        &fixture,
        replica_id,
        scope_epoch,
        Uuid::now_v7(),
        None,
        "target.md",
        "Target.\n",
    )
    .await;
    let source_id = Uuid::now_v7();
    let source_document = format!("# Source\n{}", "[[target]]\n".repeat(905));
    put(
        &fixture,
        replica_id,
        scope_epoch,
        source_id,
        None,
        "source.md",
        &source_document,
    )
    .await;

    let generation = fixture
        .provider
        .start_projection_generation(fixture.collection_id)
        .await
        .unwrap();
    loop {
        let batch = fixture
            .provider
            .project_generation_batch(fixture.collection_id, generation.generation_id, 200)
            .await
            .unwrap();
        if batch.generation.phase == "resolution" {
            break;
        }
    }
    let prepared_bytes: i32 = sqlx::query_scalar(
        r#"SELECT projection_bytes FROM hosted_provider_record_projections
           WHERE collection_id = $1 AND generation_id = $2 AND record_id = $3
             AND valid_to_sequence IS NULL"#,
    )
    .bind(fixture.collection_id)
    .bind(generation.generation_id)
    .bind(source_id)
    .fetch_one(&fixture.pool)
    .await
    .unwrap();
    assert!(prepared_bytes < 262_144);

    let error = fixture
        .provider
        .resolve_generation_batch(fixture.collection_id, generation.generation_id, 200)
        .await
        .unwrap_err();
    assert_eq!(error.code, "projection_record_too_large");
    assert_eq!(
        error.details.as_ref().unwrap()["budget"],
        "semantic_projection_bytes"
    );
    let state = sqlx::query(
        r#"SELECT status, phase, last_error_code, lease_owner
           FROM hosted_provider_projection_generations
           WHERE collection_id = $1 AND generation_id = $2"#,
    )
    .bind(fixture.collection_id)
    .bind(generation.generation_id)
    .fetch_one(&fixture.pool)
    .await
    .unwrap();
    assert_eq!(state.get::<String, _>("status"), "abandoned");
    assert_eq!(state.get::<String, _>("phase"), "resolution");
    assert_eq!(
        state.get::<Option<String>, _>("last_error_code").as_deref(),
        Some("projection_record_too_large")
    );
    assert!(state.get::<Option<Uuid>, _>("lease_owner").is_none());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires MDBASE_PROJECTION_DATABASE_URL; run against a disposable PostgreSQL database"]
async fn candidate_b_projection_resolution_quarantines_corrupt_prepared_state() {
    let database_url = std::env::var("MDBASE_PROJECTION_DATABASE_URL")
        .expect("MDBASE_PROJECTION_DATABASE_URL is required");
    let fixture = FileLifecycleFixture::new(&database_url).await;
    let replica = sqlx::query(
        "SELECT id, scope_epoch FROM hosted_provider_replicas WHERE collection_id = $1",
    )
    .bind(fixture.collection_id)
    .fetch_one(&fixture.pool)
    .await
    .unwrap();
    put(
        &fixture,
        replica.get("id"),
        u64::try_from(replica.get::<i64, _>("scope_epoch")).unwrap(),
        Uuid::now_v7(),
        None,
        "corrupt-resolution.md",
        "Prepared state will be corrupted after projection.\n",
    )
    .await;
    let generation = fixture
        .provider
        .start_projection_generation(fixture.collection_id)
        .await
        .unwrap();
    loop {
        let batch = fixture
            .provider
            .project_generation_batch(fixture.collection_id, generation.generation_id, 200)
            .await
            .unwrap();
        if batch.generation.phase == "resolution" {
            break;
        }
    }
    sqlx::query(
        r#"UPDATE hosted_provider_record_projections
           SET semantic_projection = '{}'::jsonb
           WHERE collection_id = $1 AND generation_id = $2
             AND valid_to_sequence IS NULL"#,
    )
    .bind(fixture.collection_id)
    .bind(generation.generation_id)
    .execute(&fixture.pool)
    .await
    .unwrap();

    let error = fixture
        .provider
        .resolve_generation_batch(fixture.collection_id, generation.generation_id, 200)
        .await
        .unwrap_err();
    assert_eq!(error.code, "projection_state_invalid");
    assert_eq!(error.details.as_ref().unwrap()["terminal"], true);
    let state = sqlx::query(
        r#"SELECT status, last_error_code, lease_owner
           FROM hosted_provider_projection_generations
           WHERE collection_id = $1 AND generation_id = $2"#,
    )
    .bind(fixture.collection_id)
    .bind(generation.generation_id)
    .fetch_one(&fixture.pool)
    .await
    .unwrap();
    assert_eq!(state.get::<String, _>("status"), "abandoned");
    assert_eq!(
        state.get::<Option<String>, _>("last_error_code").as_deref(),
        Some("projection_state_invalid")
    );
    assert!(state.get::<Option<Uuid>, _>("lease_owner").is_none());
    assert_eq!(
        fixture
            .provider
            .recover_projection_generations(100)
            .await
            .unwrap(),
        0
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires MDBASE_PROJECTION_DATABASE_URL; run against a disposable PostgreSQL database"]
async fn candidate_b_sync_mutation_rechecks_revocation_at_commit() {
    let database_url = std::env::var("MDBASE_PROJECTION_DATABASE_URL")
        .expect("MDBASE_PROJECTION_DATABASE_URL is required");
    let fixture = FileLifecycleFixture::new(&database_url).await;
    let replica = sqlx::query(
        "SELECT id, scope_epoch FROM hosted_provider_replicas WHERE collection_id = $1",
    )
    .bind(fixture.collection_id)
    .fetch_one(&fixture.pool)
    .await
    .unwrap();
    let replica_id: Uuid = replica.get("id");
    let scope_epoch = u64::try_from(replica.get::<i64, _>("scope_epoch")).unwrap();
    let record_id = Uuid::now_v7();
    let mutation_id = Uuid::new_v4();
    let mut revocation = fixture.pool.begin().await.unwrap();
    sqlx::query("SELECT id FROM hosted_provider_replicas WHERE id = $1 FOR UPDATE")
        .bind(replica_id)
        .fetch_one(&mut *revocation)
        .await
        .unwrap();

    let provider = fixture.provider.clone();
    let collection_id = fixture.collection_id;
    let token = fixture.token.clone();
    let mutation = tokio::spawn(async move {
        provider
            .mutate(
                collection_id,
                &token,
                SyncMutation {
                    mutation_id,
                    replica_id,
                    scope_epoch,
                    operation: SyncMutationOperation::Put,
                    record_id,
                    base_revision: None,
                    path: Some("revoked-before-commit.md".to_string()),
                    document: Some("This write must not commit.\n".to_string()),
                    created_at: Utc::now().to_rfc3339(),
                    causal_predecessor: None,
                },
                None,
            )
            .await
    });
    wait_for_query_blocked(&fixture.pool, "FROM hosted_provider_replicas").await;
    sqlx::query("UPDATE hosted_provider_replicas SET revoked_at = now() WHERE id = $1")
        .bind(replica_id)
        .execute(&mut *revocation)
        .await
        .unwrap();
    revocation.commit().await.unwrap();

    let error = mutation.await.unwrap().unwrap_err();
    assert_eq!(error.code, "invalid_replica_token");
    let committed: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM hosted_provider_records WHERE collection_id = $1 AND record_id = $2)",
    )
    .bind(fixture.collection_id)
    .bind(record_id)
    .fetch_one(&fixture.pool)
    .await
    .unwrap();
    assert!(!committed);
    let journal_state: String = sqlx::query_scalar(
        r#"SELECT state FROM hosted_provider_mutation_journal
           WHERE replica_id = $1 AND request_id = $2"#,
    )
    .bind(replica_id)
    .bind(mutation_id)
    .fetch_one(&fixture.pool)
    .await
    .unwrap();
    assert_eq!(journal_state, "completed");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires MDBASE_PROJECTION_DATABASE_URL; run against a disposable PostgreSQL database"]
async fn candidate_b_sync_mutation_rechecks_token_rotation_at_commit() {
    let database_url = std::env::var("MDBASE_PROJECTION_DATABASE_URL")
        .expect("MDBASE_PROJECTION_DATABASE_URL is required");
    let fixture = FileLifecycleFixture::new(&database_url).await;
    let replica = sqlx::query(
        "SELECT id, scope_epoch FROM hosted_provider_replicas WHERE collection_id = $1",
    )
    .bind(fixture.collection_id)
    .fetch_one(&fixture.pool)
    .await
    .unwrap();
    let replica_id: Uuid = replica.get("id");
    let scope_epoch = u64::try_from(replica.get::<i64, _>("scope_epoch")).unwrap();
    let record_id = Uuid::now_v7();
    let mutation_id = Uuid::new_v4();
    let mut rotation = fixture.pool.begin().await.unwrap();
    sqlx::query("SELECT id FROM hosted_provider_replicas WHERE id = $1 FOR UPDATE")
        .bind(replica_id)
        .fetch_one(&mut *rotation)
        .await
        .unwrap();

    let provider = fixture.provider.clone();
    let collection_id = fixture.collection_id;
    let token = fixture.token.clone();
    let mutation = tokio::spawn(async move {
        provider
            .mutate(
                collection_id,
                &token,
                SyncMutation {
                    mutation_id,
                    replica_id,
                    scope_epoch,
                    operation: SyncMutationOperation::Put,
                    record_id,
                    base_revision: None,
                    path: Some("rotated-before-commit.md".to_string()),
                    document: Some("This old-credential write must not commit.\n".to_string()),
                    created_at: Utc::now().to_rfc3339(),
                    causal_predecessor: None,
                },
                None,
            )
            .await
    });
    wait_for_query_blocked(&fixture.pool, "FROM hosted_provider_replicas").await;
    let replacement_token = format!("replacement-credential-{}", Uuid::new_v4());
    sqlx::query(
        r#"UPDATE hosted_provider_replicas
           SET token_hash = $2, token_expires_at = now() + interval '1 hour'
           WHERE id = $1"#,
    )
    .bind(replica_id)
    .bind(Sha256::digest(replacement_token.as_bytes()).to_vec())
    .execute(&mut *rotation)
    .await
    .unwrap();
    rotation.commit().await.unwrap();

    let error = mutation.await.unwrap().unwrap_err();
    assert_eq!(error.code, "invalid_replica_token");
    let committed: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM hosted_provider_records WHERE collection_id = $1 AND record_id = $2)",
    )
    .bind(fixture.collection_id)
    .bind(record_id)
    .fetch_one(&fixture.pool)
    .await
    .unwrap();
    assert!(!committed);
    let journal_state: String = sqlx::query_scalar(
        r#"SELECT state FROM hosted_provider_mutation_journal
           WHERE replica_id = $1 AND request_id = $2"#,
    )
    .bind(replica_id)
    .bind(mutation_id)
    .fetch_one(&fixture.pool)
    .await
    .unwrap();
    assert_eq!(journal_state, "completed");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires MDBASE_PROJECTION_DATABASE_URL; run against a disposable PostgreSQL database"]
async fn candidate_b_projection_recovery_quarantines_invalid_exact_authority_without_poisoning() {
    let database_url = std::env::var("MDBASE_PROJECTION_DATABASE_URL")
        .expect("MDBASE_PROJECTION_DATABASE_URL is required");
    let fixture = FileLifecycleFixture::new(&database_url).await;
    let replica = sqlx::query(
        "SELECT id, scope_epoch FROM hosted_provider_replicas WHERE collection_id = $1",
    )
    .bind(fixture.collection_id)
    .fetch_one(&fixture.pool)
    .await
    .unwrap();
    let record_id = Uuid::now_v7();
    put(
        &fixture,
        replica.get("id"),
        u64::try_from(replica.get::<i64, _>("scope_epoch")).unwrap(),
        record_id,
        None,
        "invalid-authority.md",
        "---\ntitle: Exact\n---\nEncrypted authority.\n",
    )
    .await;
    let generation_id = complete_generation(&fixture).await;
    sqlx::query(
        r#"UPDATE hosted_provider_record_versions
           SET payload_ciphertext = NULL
           WHERE collection_id = $1 AND record_id = $2 AND deleted = false"#,
    )
    .bind(fixture.collection_id)
    .bind(record_id)
    .execute(&fixture.pool)
    .await
    .unwrap();
    sqlx::query(
        r#"UPDATE hosted_provider_record_projections
           SET semantic_projection = jsonb_set(
                 semantic_projection, '{path}', '"invalid.md"'::jsonb
               )
           WHERE collection_id = $1 AND generation_id = $2
             AND record_id = $3 AND valid_to_sequence IS NULL"#,
    )
    .bind(fixture.collection_id)
    .bind(generation_id)
    .bind(record_id)
    .execute(&fixture.pool)
    .await
    .unwrap();

    fixture
        .provider
        .recover_projection_generations(100)
        .await
        .unwrap();
    let terminal_generation_id: Uuid = sqlx::query_scalar(
        r#"SELECT generation_id FROM hosted_provider_projection_generations
           WHERE collection_id = $1 AND status = 'abandoned'
             AND last_error_code = 'projection_authority_invalid'"#,
    )
    .bind(fixture.collection_id)
    .fetch_one(&fixture.pool)
    .await
    .unwrap();
    fixture
        .provider
        .recover_projection_generations(100)
        .await
        .unwrap();
    let terminal_generation_id_after_retry: Uuid = sqlx::query_scalar(
        r#"SELECT generation_id FROM hosted_provider_projection_generations
           WHERE collection_id = $1 AND status = 'abandoned'
             AND last_error_code = 'projection_authority_invalid'"#,
    )
    .bind(fixture.collection_id)
    .fetch_one(&fixture.pool)
    .await
    .unwrap();
    assert_eq!(terminal_generation_id_after_retry, terminal_generation_id);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires MDBASE_PROJECTION_DATABASE_URL; run against a disposable PostgreSQL database"]
async fn candidate_b_projection_recovery_quarantines_corrupt_and_mismatched_authority() {
    let database_url = std::env::var("MDBASE_PROJECTION_DATABASE_URL")
        .expect("MDBASE_PROJECTION_DATABASE_URL is required");
    for corrupt_ciphertext in [true, false] {
        let fixture = FileLifecycleFixture::new(&database_url).await;
        let replica = sqlx::query(
            "SELECT id, scope_epoch FROM hosted_provider_replicas WHERE collection_id = $1",
        )
        .bind(fixture.collection_id)
        .fetch_one(&fixture.pool)
        .await
        .unwrap();
        let record_id = Uuid::now_v7();
        put(
            &fixture,
            replica.get("id"),
            u64::try_from(replica.get::<i64, _>("scope_epoch")).unwrap(),
            record_id,
            None,
            "authority-integrity.md",
            "---\ntitle: Exact\n---\nEncrypted authority.\n",
        )
        .await;
        let generation_id = complete_generation(&fixture).await;
        let tamper = if corrupt_ciphertext {
            sqlx::query(
                r#"UPDATE hosted_provider_record_versions
                   SET payload_ciphertext = decode('00', 'hex')
                   WHERE collection_id = $1 AND record_id = $2 AND deleted = false"#,
            )
        } else {
            sqlx::query(
                r#"UPDATE hosted_provider_record_versions
                   SET revision = 'mismatched-revision'
                   WHERE collection_id = $1 AND record_id = $2 AND deleted = false"#,
            )
        };
        tamper
            .bind(fixture.collection_id)
            .bind(record_id)
            .execute(&fixture.pool)
            .await
            .unwrap();
        sqlx::query(
            r#"UPDATE hosted_provider_record_projections
               SET semantic_projection = jsonb_set(
                     semantic_projection, '{path}', '"invalid.md"'::jsonb
                   )
               WHERE collection_id = $1 AND generation_id = $2
                 AND record_id = $3 AND valid_to_sequence IS NULL"#,
        )
        .bind(fixture.collection_id)
        .bind(generation_id)
        .bind(record_id)
        .execute(&fixture.pool)
        .await
        .unwrap();

        fixture
            .provider
            .recover_projection_generations(100)
            .await
            .unwrap();
        let terminal: i64 = sqlx::query_scalar(
            r#"SELECT count(*) FROM hosted_provider_projection_generations
               WHERE collection_id = $1 AND status = 'abandoned'
                 AND last_error_code = 'projection_authority_invalid'"#,
        )
        .bind(fixture.collection_id)
        .fetch_one(&fixture.pool)
        .await
        .unwrap();
        assert_eq!(
            terminal, 1,
            "authority tamper was not terminally quarantined (corrupt ciphertext: {corrupt_ciphertext})"
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires MDBASE_PROJECTION_DATABASE_URL; run against a disposable PostgreSQL database"]
async fn candidate_b_query_receipt_window_does_not_stall_long_pagination() {
    let database_url = std::env::var("MDBASE_PROJECTION_DATABASE_URL")
        .expect("MDBASE_PROJECTION_DATABASE_URL is required");
    let fixture = FileLifecycleFixture::new(&database_url).await;
    let mirror = sqlx::query(
        "SELECT id, scope_epoch FROM hosted_provider_replicas WHERE collection_id = $1",
    )
    .bind(fixture.collection_id)
    .fetch_one(&fixture.pool)
    .await
    .unwrap();
    let mirror_id: Uuid = mirror.get("id");
    let scope_epoch = u64::try_from(mirror.get::<i64, _>("scope_epoch")).unwrap();
    for index in 0..70 {
        put(
            &fixture,
            mirror_id,
            scope_epoch,
            Uuid::now_v7(),
            None,
            &format!("receipts/{index:03}.md"),
            &format!("---\ntitle: Receipt {index}\n---\nBounded page.\n"),
        )
        .await;
    }
    complete_generation(&fixture).await;

    let application_replica_id = Uuid::now_v7();
    let application_token = format!("candidate-b-receipt-window-{}", Uuid::new_v4());
    fixture
        .provider
        .register_replica(
            fixture.collection_id,
            RegisterReplica {
                replica_id: application_replica_id,
                name: "Candidate B receipt-window reader".to_string(),
                purpose: ReplicaPurpose::Application,
                mode: SyncReplicaMode::ReadOnly,
                allowed_types: Vec::new(),
                contract_scope: Vec::new(),
                full_collection: true,
                allowed_operations: vec!["query".to_string()],
                operation_transport_protocol: Some(3),
                operation_transport_recovery_protocols: Vec::new(),
                file_capability: None,
                allowed_origin: None,
                proof_public_key: None,
                grant_id: Some(Uuid::now_v7()),
                application_declaration_id: None,
                application_declaration_digest: None,
                token: application_token.clone(),
                token_ttl_seconds: None,
            },
        )
        .await
        .unwrap();

    let mut cursor = None::<String>;
    let mut paths = Vec::new();
    let mut final_request = None;
    for page in 0..70 {
        let mut input = json!({
            "pagination": "cursor",
            "limit": 1,
            "order_by": [{"field": "file.path", "direction": "asc"}],
        });
        if let Some(cursor) = cursor.as_ref() {
            input["cursor"] = json!(cursor);
        }
        let request_id = Uuid::new_v4();
        let result = fixture
            .provider
            .operation(
                fixture.collection_id,
                &application_token,
                "query",
                request_id,
                input.clone(),
                None,
            )
            .await
            .unwrap();
        paths.push(
            result["result"]["results"][0]["path"]
                .as_str()
                .unwrap()
                .to_string(),
        );
        cursor = result["result"]["meta"]["cursor"]
            .as_str()
            .map(str::to_string);
        if page == 69 {
            final_request = Some((request_id, input, result));
        }
    }
    assert!(cursor.is_none());
    assert_eq!(paths.first().unwrap(), "receipts/000.md");
    assert_eq!(paths.last().unwrap(), "receipts/069.md");
    let receipt_count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM hosted_provider_query_page_receipts WHERE replica_id = $1",
    )
    .bind(application_replica_id)
    .fetch_one(&fixture.pool)
    .await
    .unwrap();
    assert_eq!(receipt_count, 64);

    let (request_id, input, expected) = final_request.unwrap();
    let replay = fixture
        .provider
        .operation(
            fixture.collection_id,
            &application_token,
            "query",
            request_id,
            input,
            None,
        )
        .await
        .unwrap();
    assert_eq!(
        replay, expected,
        "the newest lost response remains replayable"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires MDBASE_PROJECTION_DATABASE_URL; run against a disposable PostgreSQL database"]
async fn candidate_b_query_cursor_proof_is_encrypted_bound_and_tamper_evident() {
    let database_url = std::env::var("MDBASE_PROJECTION_DATABASE_URL")
        .expect("MDBASE_PROJECTION_DATABASE_URL is required");
    let fixture = FileLifecycleFixture::new(&database_url).await;
    let mirror = sqlx::query(
        "SELECT id, scope_epoch FROM hosted_provider_replicas WHERE collection_id = $1",
    )
    .bind(fixture.collection_id)
    .fetch_one(&fixture.pool)
    .await
    .unwrap();
    let mirror_id: Uuid = mirror.get("id");
    let scope_epoch = u64::try_from(mirror.get::<i64, _>("scope_epoch")).unwrap();
    for (path, title) in [("proof/a.md", "Proof A"), ("proof/b.md", "Proof B")] {
        put(
            &fixture,
            mirror_id,
            scope_epoch,
            Uuid::now_v7(),
            None,
            path,
            &format!("---\ntitle: {title}\n---\nEncrypted authority.\n"),
        )
        .await;
    }
    complete_generation(&fixture).await;
    let (application_replica_id, application_token) =
        register_query_application(&fixture, Vec::new()).await;
    let first = fixture
        .provider
        .operation(
            fixture.collection_id,
            &application_token,
            "query",
            Uuid::new_v4(),
            json!({
                "pagination": "cursor",
                "limit": 1,
                "order_by": [{"field": "file.path", "direction": "asc"}],
            }),
            None,
        )
        .await
        .unwrap();
    let cursor = first["result"]["meta"]["cursor"].as_str().unwrap();
    let proof = sqlx::query(
        r#"SELECT cursor_id, execution_proof_version, execution_proof_ciphertext,
                  execution_proof_bytes, snapshot_record_count, scan_budget_records,
                  scan_budget_ciphertext_bytes, projection_integrity_epoch
           FROM hosted_provider_query_cursors
           WHERE replica_id = $1
           ORDER BY created_at DESC, cursor_id DESC
           LIMIT 1"#,
    )
    .bind(application_replica_id)
    .fetch_one(&fixture.pool)
    .await
    .unwrap();
    assert_eq!(proof.get::<i32, _>("execution_proof_version"), 2);
    let ciphertext: Vec<u8> = proof.get("execution_proof_ciphertext");
    assert_eq!(
        i64::try_from(ciphertext.len()).unwrap(),
        proof.get::<i64, _>("execution_proof_bytes")
    );
    assert_eq!(proof.get::<i64, _>("snapshot_record_count"), 2);
    assert_eq!(proof.get::<i64, _>("scan_budget_records"), 100_000);
    assert_eq!(
        proof.get::<i64, _>("scan_budget_ciphertext_bytes"),
        1_073_741_824
    );
    assert!(proof
        .get::<Option<i64>, _>("projection_integrity_epoch")
        .is_some());
    assert!(!ciphertext.starts_with(b"{"));

    let cursor_id: Uuid = proof.get("cursor_id");
    sqlx::query(
        r#"UPDATE hosted_provider_query_cursors
           SET execution_proof_ciphertext = set_byte(
                 execution_proof_ciphertext, 0,
                 (get_byte(execution_proof_ciphertext, 0) # 1)
               )
           WHERE cursor_id = $1"#,
    )
    .bind(cursor_id)
    .execute(&fixture.pool)
    .await
    .unwrap();
    let error = fixture
        .provider
        .operation(
            fixture.collection_id,
            &application_token,
            "query",
            Uuid::new_v4(),
            json!({
                "cursor": cursor,
                "limit": 1,
                "order_by": [{"field": "file.path", "direction": "asc"}],
            }),
            None,
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, "query_cursor_invalidated");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires MDBASE_PROJECTION_DATABASE_URL; run against a disposable PostgreSQL database"]
async fn candidate_b_cursor_admission_bounds_expiry_cleanup_and_uses_manifest_ttls() {
    let database_url = std::env::var("MDBASE_PROJECTION_DATABASE_URL")
        .expect("MDBASE_PROJECTION_DATABASE_URL is required");
    let fixture = FileLifecycleFixture::new(&database_url).await;
    let primary = sqlx::query(
        "SELECT id, scope_epoch FROM hosted_provider_replicas WHERE collection_id = $1",
    )
    .bind(fixture.collection_id)
    .fetch_one(&fixture.pool)
    .await
    .unwrap();
    put(
        &fixture,
        primary.get("id"),
        u64::try_from(primary.get::<i64, _>("scope_epoch")).unwrap(),
        Uuid::now_v7(),
        None,
        "notes/one.md",
        "---\ntitle: One\n---\nFirst note.\n",
    )
    .await;
    put(
        &fixture,
        primary.get("id"),
        u64::try_from(primary.get::<i64, _>("scope_epoch")).unwrap(),
        Uuid::now_v7(),
        None,
        "notes/two.md",
        "---\ntitle: Two\n---\nSecond note.\n",
    )
    .await;
    complete_generation(&fixture).await;
    let (application_replica_id, application_token) =
        register_query_application(&fixture, Vec::new()).await;
    let first = fixture
        .provider
        .operation(
            fixture.collection_id,
            &application_token,
            "query",
            Uuid::new_v4(),
            json!({"pagination": "cursor", "limit": 1}),
            None,
        )
        .await
        .unwrap();
    assert!(first["result"]["meta"]["cursor"].is_string());
    let template_cursor_id: Uuid = sqlx::query_scalar(
        "SELECT cursor_id FROM hosted_provider_query_cursors WHERE replica_id = $1",
    )
    .bind(application_replica_id)
    .fetch_one(&fixture.pool)
    .await
    .unwrap();

    let inserted = sqlx::query(
        r#"INSERT INTO hosted_provider_query_cursors
             (cursor_id, collection_id, replica_id, scope_epoch, snapshot_head,
              generation_id, catalog_revision, projection_format_version,
              semantic_engine_version, query_plan_version, query_digest, query_plan,
              last_order_values, last_record_id, emitted_rows, remaining_rows,
              expires_at, hard_expires_at, created_at, last_used_at, request_kind,
              request_digest, result_meta, exact_context_ciphertext, base_plan,
              base_context, base_operation_clock, base_invocation_id,
              execution_proof_version, execution_proof_ciphertext,
              execution_proof_bytes, snapshot_record_count, scan_budget_records,
              projection_integrity_epoch, cursor_bytes, scan_budget_ciphertext_bytes)
           SELECT md5('expired-query-cursor-' || series::text)::uuid,
                  cursor.collection_id, cursor.replica_id, cursor.scope_epoch,
                  cursor.snapshot_head, cursor.generation_id, cursor.catalog_revision,
                  cursor.projection_format_version, cursor.semantic_engine_version,
                  cursor.query_plan_version, cursor.query_digest, cursor.query_plan,
                  cursor.last_order_values, cursor.last_record_id, cursor.emitted_rows,
                  cursor.remaining_rows, now() - interval '2 hours',
                  now() - interval '1 hour', now() - interval '3 hours',
                  now() - interval '2 hours', cursor.request_kind,
                  cursor.request_digest, cursor.result_meta,
                  cursor.exact_context_ciphertext, cursor.base_plan,
                  cursor.base_context, cursor.base_operation_clock,
                  cursor.base_invocation_id, cursor.execution_proof_version,
                  cursor.execution_proof_ciphertext, cursor.execution_proof_bytes,
                  cursor.snapshot_record_count, cursor.scan_budget_records,
                  cursor.projection_integrity_epoch, cursor.cursor_bytes,
                  cursor.scan_budget_ciphertext_bytes
           FROM hosted_provider_query_cursors cursor
           CROSS JOIN generate_series(1, 1005) AS series
           WHERE cursor.cursor_id = $1"#,
    )
    .bind(template_cursor_id)
    .execute(&fixture.pool)
    .await
    .unwrap()
    .rows_affected();
    assert_eq!(inserted, 1005);

    let second = fixture
        .provider
        .operation(
            fixture.collection_id,
            &application_token,
            "query",
            Uuid::new_v4(),
            json!({"pagination": "cursor", "limit": 1}),
            None,
        )
        .await
        .unwrap();
    assert!(second["result"]["meta"]["cursor"].is_string());
    let expired_remaining: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM hosted_provider_query_cursors \
         WHERE collection_id = $1 AND (expires_at <= now() OR hard_expires_at <= now())",
    )
    .bind(fixture.collection_id)
    .fetch_one(&fixture.pool)
    .await
    .unwrap();
    assert_eq!(
        expired_remaining, 5,
        "one admission deletes at most 1000 rows"
    );
    let (idle_seconds, hard_seconds): (f64, f64) = sqlx::query_as(
        r#"SELECT EXTRACT(epoch FROM expires_at - now())::double precision,
                  EXTRACT(epoch FROM hard_expires_at - now())::double precision
           FROM hosted_provider_query_cursors
           WHERE collection_id = $1 AND expires_at > now()
           ORDER BY created_at DESC, cursor_id DESC
           LIMIT 1"#,
    )
    .bind(fixture.collection_id)
    .fetch_one(&fixture.pool)
    .await
    .unwrap();
    assert!(
        (850.0..=905.0).contains(&idle_seconds),
        "idle TTL: {idle_seconds}"
    );
    assert!(
        (3550.0..=3605.0).contains(&hard_seconds),
        "hard TTL: {hard_seconds}"
    );

    seed_expired_query_cursors(
        &fixture,
        template_cursor_id,
        "compaction-expired-query-cursor-",
        1005,
    )
    .await;
    seed_expired_base_invocations(
        &fixture,
        application_replica_id,
        "compaction-expired-base-invocation-",
        1005,
    )
    .await;
    seed_expired_snapshot_leases(
        &fixture,
        primary.get("id"),
        "compaction-expired-snapshot-lease-",
        1005,
    )
    .await;
    fixture
        .provider
        .compact_through(fixture.collection_id, 0)
        .await
        .unwrap();
    assert_eq!(expired_query_cursor_count(&fixture).await, 10);
    assert_eq!(expired_base_invocation_count(&fixture).await, 5);
    assert_eq!(expired_snapshot_lease_count(&fixture).await, 5);

    seed_expired_snapshot_leases(
        &fixture,
        primary.get("id"),
        "session-expired-snapshot-lease-",
        1005,
    )
    .await;
    fixture
        .provider
        .open_session(fixture.collection_id, &fixture.token, None)
        .await
        .unwrap();
    assert_eq!(
        expired_snapshot_lease_count(&fixture).await,
        10,
        "session admission cleans one bounded batch and leaves its new live lease"
    );

    seed_expired_query_cursors(
        &fixture,
        template_cursor_id,
        "pruning-expired-query-cursor-",
        1005,
    )
    .await;
    seed_expired_base_invocations(
        &fixture,
        application_replica_id,
        "pruning-expired-base-invocation-",
        1005,
    )
    .await;
    fixture
        .provider
        .start_projection_generation(fixture.collection_id)
        .await
        .unwrap();
    assert_eq!(expired_query_cursor_count(&fixture).await, 15);
    assert_eq!(expired_base_invocation_count(&fixture).await, 10);
}

async fn seed_expired_query_cursors(
    fixture: &FileLifecycleFixture,
    template_cursor_id: Uuid,
    identity_prefix: &str,
    count: i64,
) {
    let inserted = sqlx::query(
        r#"INSERT INTO hosted_provider_query_cursors
             (cursor_id, collection_id, replica_id, scope_epoch, snapshot_head,
              generation_id, catalog_revision, projection_format_version,
              semantic_engine_version, query_plan_version, query_digest, query_plan,
              last_order_values, last_record_id, emitted_rows, remaining_rows,
              expires_at, hard_expires_at, created_at, last_used_at, request_kind,
              request_digest, result_meta, exact_context_ciphertext, base_plan,
              base_context, base_operation_clock, base_invocation_id,
              execution_proof_version, execution_proof_ciphertext,
              execution_proof_bytes, snapshot_record_count, scan_budget_records,
              projection_integrity_epoch, cursor_bytes, scan_budget_ciphertext_bytes)
           SELECT md5($2 || series::text)::uuid,
                  cursor.collection_id, cursor.replica_id, cursor.scope_epoch,
                  cursor.snapshot_head, cursor.generation_id, cursor.catalog_revision,
                  cursor.projection_format_version, cursor.semantic_engine_version,
                  cursor.query_plan_version, cursor.query_digest, cursor.query_plan,
                  cursor.last_order_values, cursor.last_record_id, cursor.emitted_rows,
                  cursor.remaining_rows, now() - interval '2 hours',
                  now() - interval '1 hour', now() - interval '3 hours',
                  now() - interval '2 hours', cursor.request_kind,
                  cursor.request_digest, cursor.result_meta,
                  cursor.exact_context_ciphertext, cursor.base_plan,
                  cursor.base_context, cursor.base_operation_clock,
                  cursor.base_invocation_id, cursor.execution_proof_version,
                  cursor.execution_proof_ciphertext, cursor.execution_proof_bytes,
                  cursor.snapshot_record_count, cursor.scan_budget_records,
                  cursor.projection_integrity_epoch, cursor.cursor_bytes,
                  cursor.scan_budget_ciphertext_bytes
           FROM hosted_provider_query_cursors cursor
           CROSS JOIN generate_series(1, $3::bigint) AS series
           WHERE cursor.cursor_id = $1"#,
    )
    .bind(template_cursor_id)
    .bind(identity_prefix)
    .bind(count)
    .execute(&fixture.pool)
    .await
    .unwrap()
    .rows_affected();
    assert_eq!(inserted, u64::try_from(count).unwrap());
}

async fn seed_expired_base_invocations(
    fixture: &FileLifecycleFixture,
    replica_id: Uuid,
    identity_prefix: &str,
    count: i64,
) {
    let inserted = sqlx::query(
        r#"INSERT INTO hosted_provider_base_query_invocations
             (invocation_id, collection_id, replica_id, scope_epoch, base_plan,
              base_context, base_operation_clock, hard_expires_at, created_at)
           SELECT md5($3 || series::text)::uuid, $1, replica.id,
                  replica.scope_epoch, '{}'::jsonb, NULL, '2026-08-17T00:00:00Z',
                  now() - interval '1 hour', now() - interval '2 hours'
           FROM hosted_provider_replicas replica
           CROSS JOIN generate_series(1, $4::bigint) AS series
           WHERE replica.collection_id = $1 AND replica.id = $2"#,
    )
    .bind(fixture.collection_id)
    .bind(replica_id)
    .bind(identity_prefix)
    .bind(count)
    .execute(&fixture.pool)
    .await
    .unwrap()
    .rows_affected();
    assert_eq!(inserted, u64::try_from(count).unwrap());
}

async fn expired_query_cursor_count(fixture: &FileLifecycleFixture) -> i64 {
    sqlx::query_scalar(
        "SELECT count(*) FROM hosted_provider_query_cursors \
         WHERE collection_id = $1 AND (expires_at <= now() OR hard_expires_at <= now())",
    )
    .bind(fixture.collection_id)
    .fetch_one(&fixture.pool)
    .await
    .unwrap()
}

async fn expired_base_invocation_count(fixture: &FileLifecycleFixture) -> i64 {
    sqlx::query_scalar(
        "SELECT count(*) FROM hosted_provider_base_query_invocations \
         WHERE collection_id = $1 AND hard_expires_at <= now()",
    )
    .bind(fixture.collection_id)
    .fetch_one(&fixture.pool)
    .await
    .unwrap()
}

async fn seed_expired_snapshot_leases(
    fixture: &FileLifecycleFixture,
    replica_id: Uuid,
    identity_prefix: &str,
    count: i64,
) {
    let inserted = sqlx::query(
        r#"INSERT INTO hosted_provider_snapshot_leases
             (id, collection_id, replica_id, scope_epoch, cursor,
              resource_revision, expires_at, created_at)
           SELECT md5($3 || series::text)::uuid, collection.id, replica.id,
                  replica.scope_epoch, collection.head, collection.resource_revision,
                  now() - interval '1 hour', now() - interval '2 hours'
           FROM hosted_provider_collections collection
           JOIN hosted_provider_replicas replica
             ON replica.collection_id = collection.id AND replica.id = $2
           CROSS JOIN generate_series(1, $4::bigint) AS series
           WHERE collection.id = $1"#,
    )
    .bind(fixture.collection_id)
    .bind(replica_id)
    .bind(identity_prefix)
    .bind(count)
    .execute(&fixture.pool)
    .await
    .unwrap()
    .rows_affected();
    assert_eq!(inserted, u64::try_from(count).unwrap());
}

async fn expired_snapshot_lease_count(fixture: &FileLifecycleFixture) -> i64 {
    sqlx::query_scalar(
        "SELECT count(*) FROM hosted_provider_snapshot_leases \
         WHERE collection_id = $1 AND expires_at <= now()",
    )
    .bind(fixture.collection_id)
    .fetch_one(&fixture.pool)
    .await
    .unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires a clean ICU-collated MDBASE_PROJECTION_DATABASE_URL PostgreSQL database"]
async fn candidate_b_scalar_cursor_uses_canonical_collation_in_an_icu_database() {
    let database_url = std::env::var("MDBASE_PROJECTION_DATABASE_URL")
        .expect("MDBASE_PROJECTION_DATABASE_URL is required");
    let fixture = FileLifecycleFixture::new(&database_url).await;
    let is_icu: bool = sqlx::query_scalar(
        "SELECT datlocprovider = 'i' \
         FROM pg_database WHERE datname = current_database()",
    )
    .fetch_one(&fixture.pool)
    .await
    .unwrap();
    assert!(
        is_icu,
        "this regression must run under a non-C ICU collation"
    );
    let primary = sqlx::query(
        "SELECT id, scope_epoch FROM hosted_provider_replicas WHERE collection_id = $1",
    )
    .bind(fixture.collection_id)
    .fetch_one(&fixture.pool)
    .await
    .unwrap();
    let replica_id = primary.get("id");
    let scope_epoch = u64::try_from(primary.get::<i64, _>("scope_epoch")).unwrap();
    for (path, title) in [
        ("notes/a.md", "a"),
        ("notes/z.md", "z"),
        ("notes/umlaut.md", "ä"),
    ] {
        put(
            &fixture,
            replica_id,
            scope_epoch,
            Uuid::now_v7(),
            None,
            path,
            &format!("---\ntitle: {title}\n---\nCanonical collation.\n"),
        )
        .await;
    }
    complete_generation(&fixture).await;
    let (_, application_token) = register_query_application(&fixture, Vec::new()).await;
    let mut cursor = None;
    let mut paths = Vec::new();
    for _ in 0..3 {
        let mut input = json!({
            "pagination": "cursor",
            "limit": 1,
            "order_by": [{"field": "record.title", "direction": "asc"}],
        });
        if let Some(cursor) = cursor.take() {
            input["cursor"] = Value::String(cursor);
        }
        let page = fixture
            .provider
            .operation(
                fixture.collection_id,
                &application_token,
                "query",
                Uuid::new_v4(),
                input,
                None,
            )
            .await
            .unwrap();
        paths.push(
            page["result"]["results"][0]["path"]
                .as_str()
                .unwrap()
                .to_string(),
        );
        cursor = page["result"]["meta"]["cursor"]
            .as_str()
            .map(ToString::to_string);
    }
    assert_eq!(paths, ["notes/a.md", "notes/z.md", "notes/umlaut.md"]);
    assert!(cursor.is_none());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires MDBASE_PROJECTION_DATABASE_URL; run against a disposable PostgreSQL database"]
async fn candidate_b_query_cursor_rechecks_projection_integrity_after_epoch_change() {
    let database_url = std::env::var("MDBASE_PROJECTION_DATABASE_URL")
        .expect("MDBASE_PROJECTION_DATABASE_URL is required");
    let fixture = FileLifecycleFixture::new(&database_url).await;
    let mirror = sqlx::query(
        "SELECT id, scope_epoch FROM hosted_provider_replicas WHERE collection_id = $1",
    )
    .bind(fixture.collection_id)
    .fetch_one(&fixture.pool)
    .await
    .unwrap();
    let mirror_id: Uuid = mirror.get("id");
    let scope_epoch = u64::try_from(mirror.get::<i64, _>("scope_epoch")).unwrap();
    for (path, title) in [("epoch/a.md", "Epoch A"), ("epoch/b.md", "Epoch B")] {
        put(
            &fixture,
            mirror_id,
            scope_epoch,
            Uuid::now_v7(),
            None,
            path,
            &format!("---\ntitle: {title}\n---\nEncrypted authority.\n"),
        )
        .await;
    }
    let generation_id = complete_generation(&fixture).await;
    let (_, application_token) = register_query_application(&fixture, Vec::new()).await;
    let first = fixture
        .provider
        .operation(
            fixture.collection_id,
            &application_token,
            "query",
            Uuid::new_v4(),
            json!({
                "pagination": "cursor",
                "limit": 1,
                "order_by": [{"field": "file.path", "direction": "asc"}],
            }),
            None,
        )
        .await
        .unwrap();
    let cursor = first["result"]["meta"]["cursor"].as_str().unwrap();
    sqlx::query(
        r#"UPDATE hosted_provider_record_projections
           SET semantic_projection = jsonb_set(
                 semantic_projection, '{path}', '"tampered.md"'::jsonb
               )
           WHERE collection_id = $1 AND generation_id = $2
             AND canonical_path = 'epoch/b.md' AND valid_to_sequence IS NULL"#,
    )
    .bind(fixture.collection_id)
    .bind(generation_id)
    .execute(&fixture.pool)
    .await
    .unwrap();
    let error = fixture
        .provider
        .operation(
            fixture.collection_id,
            &application_token,
            "query",
            Uuid::new_v4(),
            json!({
                "cursor": cursor,
                "limit": 1,
                "order_by": [{"field": "file.path", "direction": "asc"}],
            }),
            None,
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, "query_projection_changed");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires MDBASE_PROJECTION_DATABASE_URL; run against a disposable PostgreSQL database"]
async fn candidate_b_exact_plaintext_budget_preflights_before_any_ciphertext_decryption() {
    let database_url = std::env::var("MDBASE_PROJECTION_DATABASE_URL")
        .expect("MDBASE_PROJECTION_DATABASE_URL is required");
    let fixture = FileLifecycleFixture::new(&database_url).await;
    let mirror = sqlx::query(
        "SELECT id, scope_epoch FROM hosted_provider_replicas WHERE collection_id = $1",
    )
    .bind(fixture.collection_id)
    .fetch_one(&fixture.pool)
    .await
    .unwrap();
    let mirror_id: Uuid = mirror.get("id");
    let scope_epoch = u64::try_from(mirror.get::<i64, _>("scope_epoch")).unwrap();
    for ordinal in 1..=40_u128 {
        put(
            &fixture,
            mirror_id,
            scope_epoch,
            Uuid::from_u128(ordinal),
            None,
            &format!("budget/{ordinal}.md"),
            "Small canonical record used to isolate the exact ciphertext preflight.\n",
        )
        .await;
    }
    complete_generation(&fixture).await;
    // Inflate the encrypted authority rows after projection. The appended
    // bytes make every ciphertext invalid, so any attempted decryption would
    // fail with a crypto error. The metadata preflight must instead reject the
    // selected 66+ MiB set with the typed exact-byte outcome.
    sqlx::query(
        r#"UPDATE hosted_provider_record_versions
           SET payload_ciphertext = payload_ciphertext
             || decode(repeat('00', 1750000), 'hex')
           WHERE collection_id = $1 AND deleted = false"#,
    )
    .bind(fixture.collection_id)
    .execute(&fixture.pool)
    .await
    .unwrap();
    let (_, token) = register_query_application(&fixture, Vec::new()).await;

    let error = fixture
        .provider
        .operation(
            fixture.collection_id,
            &token,
            "query",
            Uuid::new_v4(),
            json!({
                "limit": 50,
                "include_body": true,
                "order_by": [{"field": "file.path"}],
            }),
            None,
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, "hosted_exact_byte_budget_exceeded");
    assert_eq!(error.details.as_ref().unwrap()["budget"], "exact_bytes");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires MDBASE_PROJECTION_DATABASE_URL; run against a disposable PostgreSQL database"]
async fn candidate_b_query_rejects_an_unentitled_collection_scan_before_execution() {
    let database_url = std::env::var("MDBASE_PROJECTION_DATABASE_URL")
        .expect("MDBASE_PROJECTION_DATABASE_URL is required");
    let fixture = FileLifecycleFixture::new(&database_url).await;
    let mirror = sqlx::query(
        "SELECT id, scope_epoch FROM hosted_provider_replicas WHERE collection_id = $1",
    )
    .bind(fixture.collection_id)
    .fetch_one(&fixture.pool)
    .await
    .unwrap();
    put(
        &fixture,
        mirror.get("id"),
        u64::try_from(mirror.get::<i64, _>("scope_epoch")).unwrap(),
        Uuid::now_v7(),
        None,
        "budget/one.md",
        "---\ntitle: One\n---\nBudget fixture.\n",
    )
    .await;
    complete_generation(&fixture).await;
    let (_, application_token) = register_query_application(&fixture, Vec::new()).await;
    sqlx::query("UPDATE hosted_provider_collections SET record_count = 100001 WHERE id = $1")
        .bind(fixture.collection_id)
        .execute(&fixture.pool)
        .await
        .unwrap();
    let error = fixture
        .provider
        .operation(
            fixture.collection_id,
            &application_token,
            "query",
            Uuid::new_v4(),
            json!({"limit": 1}),
            None,
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, "hosted_scan_budget_exceeded");
    let details = error.details.unwrap();
    assert_eq!(details["budget"], "scanned_records");
    assert_eq!(details["limit"], 100_000);
    assert_eq!(details["observed"], 100_001);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires MDBASE_PROJECTION_DATABASE_URL; run against a disposable PostgreSQL database"]
async fn candidate_b_projection_digest_binds_and_refreshes_the_temporal_end() {
    let database_url = std::env::var("MDBASE_PROJECTION_DATABASE_URL")
        .expect("MDBASE_PROJECTION_DATABASE_URL is required");
    let fixture = FileLifecycleFixture::new(&database_url).await;
    let mirror = sqlx::query(
        "SELECT id, scope_epoch FROM hosted_provider_replicas WHERE collection_id = $1",
    )
    .bind(fixture.collection_id)
    .fetch_one(&fixture.pool)
    .await
    .unwrap();
    let replica_id: Uuid = mirror.get("id");
    let scope_epoch = u64::try_from(mirror.get::<i64, _>("scope_epoch")).unwrap();
    let record_id = Uuid::now_v7();
    let first = put(
        &fixture,
        replica_id,
        scope_epoch,
        record_id,
        None,
        "temporal.md",
        "---\ntitle: Before\n---\nFirst.\n",
    )
    .await;
    let generation_id = complete_generation(&fixture).await;
    put(
        &fixture,
        replica_id,
        scope_epoch,
        record_id,
        Some(first.revision),
        "temporal.md",
        "---\ntitle: After\n---\nSecond.\n",
    )
    .await;

    let old = sqlx::query(
        r#"SELECT valid_from_sequence, valid_to_sequence,
                  hosted_provider_projection_digest_valid(
                    projection_digest, projection_observed_digest
                  ) AS digest_valid
           FROM hosted_provider_record_projections
           WHERE collection_id = $1 AND generation_id = $2 AND record_id = $3
             AND valid_to_sequence IS NOT NULL"#,
    )
    .bind(fixture.collection_id)
    .bind(generation_id)
    .bind(record_id)
    .fetch_one(&fixture.pool)
    .await
    .unwrap();
    assert!(old.get::<bool, _>("digest_valid"));
    let valid_to: i64 = old.get("valid_to_sequence");
    sqlx::query(
        r#"UPDATE hosted_provider_record_projections
           SET valid_to_sequence = $4
           WHERE collection_id = $1 AND generation_id = $2 AND record_id = $3
             AND valid_to_sequence = $5"#,
    )
    .bind(fixture.collection_id)
    .bind(generation_id)
    .bind(record_id)
    .bind(valid_to + 1)
    .bind(valid_to)
    .execute(&fixture.pool)
    .await
    .unwrap();
    let digest_valid: bool = sqlx::query_scalar(
        r#"SELECT hosted_provider_projection_digest_valid(
                    projection_digest, projection_observed_digest
                  )
           FROM hosted_provider_record_projections
           WHERE collection_id = $1 AND generation_id = $2 AND record_id = $3
             AND valid_from_sequence = $4"#,
    )
    .bind(fixture.collection_id)
    .bind(generation_id)
    .bind(record_id)
    .bind(old.get::<i64, _>("valid_from_sequence"))
    .fetch_one(&fixture.pool)
    .await
    .unwrap();
    assert!(
        !digest_valid,
        "a temporal-boundary substitution is detected"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires MDBASE_PROJECTION_DATABASE_URL; run against a disposable PostgreSQL database"]
async fn candidate_b_rollback_fence_drains_inflight_queries_and_allows_cursor_release() {
    let database_url = std::env::var("MDBASE_PROJECTION_DATABASE_URL")
        .expect("MDBASE_PROJECTION_DATABASE_URL is required");
    let fixture = FileLifecycleFixture::new(&database_url).await;
    let mirror = sqlx::query(
        "SELECT id, scope_epoch FROM hosted_provider_replicas WHERE collection_id = $1",
    )
    .bind(fixture.collection_id)
    .fetch_one(&fixture.pool)
    .await
    .unwrap();
    let replica_id: Uuid = mirror.get("id");
    let scope_epoch = u64::try_from(mirror.get::<i64, _>("scope_epoch")).unwrap();
    for path in ["fence/a.md", "fence/b.md"] {
        put(
            &fixture,
            replica_id,
            scope_epoch,
            Uuid::now_v7(),
            None,
            path,
            "---\ntitle: Fence\n---\nBounded.\n",
        )
        .await;
    }
    complete_generation(&fixture).await;
    let (_, application_token) = register_query_application(&fixture, Vec::new()).await;
    let first = fixture
        .provider
        .operation(
            fixture.collection_id,
            &application_token,
            "query",
            Uuid::new_v4(),
            json!({"limit": 1, "order_by": [{"field": "file.path"}]}),
            None,
        )
        .await
        .unwrap();
    let cursor = first["result"]["meta"]["cursor"]
        .as_str()
        .unwrap()
        .to_string();

    let mut in_flight = fixture.pool.begin().await.unwrap();
    sqlx::query(
        "SELECT pg_advisory_xact_lock_shared(hashtextextended('mdbase-hosted-query-admission-v1', 0))",
    )
    .execute(&mut *in_flight)
    .await
    .unwrap();
    let fence_pool = fixture.pool.clone();
    let suspend = tokio::spawn(async move {
        let mut transaction = fence_pool.begin().await.unwrap();
        sqlx::query(
            "SELECT pg_advisory_xact_lock(hashtextextended('mdbase-hosted-query-admission-v1', 0))",
        )
        .execute(&mut *transaction)
        .await
        .unwrap();
        sqlx::query(
            r#"UPDATE hosted_provider_runtime_control
               SET query_admission_suspended = true,
                   suspension_reason = 'integration_test', updated_at = now()
               WHERE singleton = true"#,
        )
        .execute(&mut *transaction)
        .await
        .unwrap();
        transaction.commit().await.unwrap();
    });
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(
        !suspend.is_finished(),
        "exclusive rollback fence waits for queries"
    );
    in_flight.commit().await.unwrap();
    suspend.await.unwrap();

    let blocked = fixture
        .provider
        .operation(
            fixture.collection_id,
            &application_token,
            "query",
            Uuid::new_v4(),
            json!({"limit": 1}),
            None,
        )
        .await
        .unwrap_err();
    assert_eq!(blocked.code, "hosted_query_admission_suspended");
    let released = fixture
        .provider
        .operation(
            fixture.collection_id,
            &application_token,
            "query",
            Uuid::new_v4(),
            json!({"release_cursor": cursor}),
            None,
        )
        .await
        .unwrap();
    assert_eq!(released["valid"], true);

    let mut transaction = fixture.pool.begin().await.unwrap();
    sqlx::query(
        "SELECT pg_advisory_xact_lock(hashtextextended('mdbase-hosted-query-admission-v1', 0))",
    )
    .execute(&mut *transaction)
    .await
    .unwrap();
    sqlx::query(
        r#"UPDATE hosted_provider_runtime_control
           SET query_admission_suspended = false, suspension_reason = NULL,
               updated_at = now()
           WHERE singleton = true"#,
    )
    .execute(&mut *transaction)
    .await
    .unwrap();
    transaction.commit().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires MDBASE_PROJECTION_DATABASE_URL; run against a disposable PostgreSQL database"]
async fn candidate_b_recovery_rebuilds_pre_digest_active_projection_rows() {
    let database_url = std::env::var("MDBASE_PROJECTION_DATABASE_URL")
        .expect("MDBASE_PROJECTION_DATABASE_URL is required");
    let fixture = FileLifecycleFixture::new(&database_url).await;
    let replica = sqlx::query(
        "SELECT id, scope_epoch FROM hosted_provider_replicas WHERE collection_id = $1",
    )
    .bind(fixture.collection_id)
    .fetch_one(&fixture.pool)
    .await
    .unwrap();
    put(
        &fixture,
        replica.get("id"),
        u64::try_from(replica.get::<i64, _>("scope_epoch")).unwrap(),
        Uuid::now_v7(),
        None,
        "recovered.md",
        "---\ntype: note\n---\n# Recovered\n",
    )
    .await;
    let legacy_generation = complete_generation(&fixture).await;

    // Simulate rows written by a pre-0044 binary. The production migration
    // deliberately leaves their new observed digest NULL so recovery must
    // rebuild from encrypted exact authority instead of serving them forever
    // through canonical fallback.
    sqlx::query(
        "ALTER TABLE hosted_provider_record_projections DISABLE TRIGGER \
         hosted_provider_record_projection_digest_observer",
    )
    .execute(&fixture.pool)
    .await
    .unwrap();
    sqlx::query(
        r#"UPDATE hosted_provider_record_projections
           SET projection_observed_digest = NULL
           WHERE collection_id = $1 AND generation_id = $2
             AND valid_to_sequence IS NULL"#,
    )
    .bind(fixture.collection_id)
    .bind(legacy_generation)
    .execute(&fixture.pool)
    .await
    .unwrap();
    sqlx::query(
        "ALTER TABLE hosted_provider_record_projections ENABLE TRIGGER \
         hosted_provider_record_projection_digest_observer",
    )
    .execute(&fixture.pool)
    .await
    .unwrap();

    let rebuilt_generation = loop {
        fixture
            .provider
            .recover_projection_generations(10)
            .await
            .unwrap();
        let active: Uuid = sqlx::query_scalar(
            "SELECT active_projection_generation_id FROM hosted_provider_collections WHERE id = $1",
        )
        .bind(fixture.collection_id)
        .fetch_one(&fixture.pool)
        .await
        .unwrap();
        if active != legacy_generation {
            break active;
        }
        tokio::task::yield_now().await;
    };
    let invalid_rows: i64 = sqlx::query_scalar(
        r#"SELECT count(*)
           FROM hosted_provider_record_projections
           WHERE collection_id = $1 AND generation_id = $2
             AND valid_to_sequence IS NULL
             AND NOT hosted_provider_projection_digest_valid(
               projection_digest, projection_observed_digest)"#,
    )
    .bind(fixture.collection_id)
    .bind(rebuilt_generation)
    .fetch_one(&fixture.pool)
    .await
    .unwrap();
    assert_eq!(invalid_rows, 0);

    let application_token = format!("digest-recovery-{}-{}", Uuid::new_v4(), Uuid::new_v4());
    fixture
        .provider
        .register_replica(
            fixture.collection_id,
            RegisterReplica {
                replica_id: Uuid::now_v7(),
                name: "Digest recovery reader".to_string(),
                purpose: ReplicaPurpose::Application,
                mode: SyncReplicaMode::ReadOnly,
                allowed_types: Vec::new(),
                contract_scope: Vec::new(),
                full_collection: true,
                allowed_operations: vec!["query".to_string()],
                operation_transport_protocol: Some(3),
                operation_transport_recovery_protocols: Vec::new(),
                file_capability: None,
                allowed_origin: None,
                proof_public_key: None,
                grant_id: Some(Uuid::now_v7()),
                application_declaration_id: None,
                application_declaration_digest: None,
                token: application_token.clone(),
                token_ttl_seconds: None,
            },
        )
        .await
        .unwrap();
    let query = fixture
        .provider
        .operation(
            fixture.collection_id,
            &application_token,
            "query",
            Uuid::new_v4(),
            json!({"select": ["path"], "limit": 10}),
            None,
        )
        .await
        .unwrap();
    assert_eq!(query["valid"], true);
    assert_eq!(query["result"]["results"][0]["path"], "recovered.md");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires MDBASE_PROJECTION_DATABASE_URL; run against a disposable PostgreSQL database"]
async fn candidate_b_query_receipt_maintenance_is_global_and_bounded() {
    let database_url = std::env::var("MDBASE_PROJECTION_DATABASE_URL")
        .expect("MDBASE_PROJECTION_DATABASE_URL is required");
    let fixture = FileLifecycleFixture::new(&database_url).await;
    let replica_id: Uuid =
        sqlx::query_scalar("SELECT id FROM hosted_provider_replicas WHERE collection_id = $1")
            .bind(fixture.collection_id)
            .fetch_one(&fixture.pool)
            .await
            .unwrap();
    let mut legacy_account = fixture.pool.begin().await.unwrap();
    sqlx::query("SET LOCAL mdbase.quota_reconciliation = 'on'")
        .execute(&mut *legacy_account)
        .await
        .unwrap();
    sqlx::query("UPDATE hosted_provider_collections SET account_id = NULL WHERE id = $1")
        .bind(fixture.collection_id)
        .execute(&mut *legacy_account)
        .await
        .unwrap();
    legacy_account.commit().await.unwrap();
    sqlx::query(
        r#"INSERT INTO hosted_provider_query_page_receipts
             (replica_id, request_id, collection_id, scope_epoch, request_kind,
              input_digest, response_ciphertext, expires_at)
           SELECT $1, md5('expired-query-receipt-' || g::text)::uuid, $2, 1,
                  'query', decode(repeat('11', 32), 'hex'), decode('00', 'hex'),
                  now() - interval '100 years'
           FROM generate_series(1, 1001) AS g"#,
    )
    .bind(replica_id)
    .bind(fixture.collection_id)
    .execute(&fixture.pool)
    .await
    .unwrap();
    sqlx::query(
        r#"INSERT INTO hosted_provider_query_page_receipts
             (replica_id, request_id, collection_id, scope_epoch, request_kind,
              input_digest, response_ciphertext, expires_at)
           VALUES ($1, md5('live-query-receipt')::uuid, $2, 1, 'query',
                   decode(repeat('22', 32), 'hex'), decode('00', 'hex'),
                   now() + interval '5 minutes')"#,
    )
    .bind(replica_id)
    .bind(fixture.collection_id)
    .execute(&fixture.pool)
    .await
    .unwrap();

    assert_eq!(
        fixture
            .provider
            .compact_expired_query_page_receipts(i64::MAX)
            .await
            .unwrap(),
        1_000
    );
    let remaining_expired: i64 = sqlx::query_scalar(
        r#"SELECT count(*) FROM hosted_provider_query_page_receipts
           WHERE collection_id = $1 AND expires_at <= now()"#,
    )
    .bind(fixture.collection_id)
    .fetch_one(&fixture.pool)
    .await
    .unwrap();
    assert_eq!(remaining_expired, 1);
    let second_window = fixture
        .provider
        .compact_expired_query_page_receipts(i64::MAX)
        .await
        .unwrap();
    assert!((1..=1_000).contains(&second_window));
    let final_expired: i64 = sqlx::query_scalar(
        r#"SELECT count(*) FROM hosted_provider_query_page_receipts
           WHERE collection_id = $1 AND expires_at <= now()"#,
    )
    .bind(fixture.collection_id)
    .fetch_one(&fixture.pool)
    .await
    .unwrap();
    assert_eq!(final_expired, 0);
    let remaining_live: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM hosted_provider_query_page_receipts WHERE collection_id = $1",
    )
    .bind(fixture.collection_id)
    .fetch_one(&fixture.pool)
    .await
    .unwrap();
    assert_eq!(remaining_live, 1);
    let (usage_count, usage_bytes): (i64, i64) = sqlx::query_as(
        r#"SELECT receipt_count, ciphertext_bytes
           FROM hosted_provider_query_receipt_usage
           WHERE scope_kind = 'collection' AND scope_id = $1"#,
    )
    .bind(fixture.collection_id)
    .fetch_one(&fixture.pool)
    .await
    .unwrap();
    assert_eq!((usage_count, usage_bytes), (1, 1));

    let account_id = Uuid::now_v7();
    sqlx::query(
        r#"INSERT INTO hosted_provider_accounts
             (id, entitlement_revision, max_live_storage_bytes,
              max_retained_file_bytes, max_document_bytes, max_single_file_bytes,
              max_mirror_replicas_per_collection,
              max_application_replicas_per_collection, max_collections,
              max_files_per_collection)
           VALUES ($1, 1, 1073741824, 2147483648,
                   16777216, 67108864, 5, 5, 10, 10000)"#,
    )
    .bind(account_id)
    .execute(&fixture.pool)
    .await
    .unwrap();
    fixture
        .provider
        .reconcile_collection_account(account_id, fixture.collection_id)
        .await
        .unwrap();
    let (bound_receipts, account_count, account_bytes): (i64, i64, i64) = sqlx::query_as(
        r#"SELECT count(receipt.request_id), usage.receipt_count,
                  usage.ciphertext_bytes
           FROM hosted_provider_query_page_receipts receipt
           JOIN hosted_provider_query_receipt_usage usage
             ON usage.scope_kind = 'account' AND usage.scope_id = receipt.account_id
           WHERE receipt.collection_id = $1 AND receipt.account_id = $2
           GROUP BY usage.receipt_count, usage.ciphertext_bytes"#,
    )
    .bind(fixture.collection_id)
    .bind(account_id)
    .fetch_one(&fixture.pool)
    .await
    .unwrap();
    assert_eq!((bound_receipts, account_count, account_bytes), (1, 1, 1));

    let payload_update = sqlx::query(
        r#"UPDATE hosted_provider_query_page_receipts
           SET response_ciphertext = decode('0000', 'hex')
           WHERE collection_id = $1"#,
    )
    .bind(fixture.collection_id)
    .execute(&fixture.pool)
    .await
    .unwrap_err();
    assert!(payload_update
        .as_database_error()
        .is_some_and(|error| error.message().contains("response ciphertext is immutable")));
    let replica_identity_update = sqlx::query(
        r#"UPDATE hosted_provider_query_page_receipts
           SET replica_id = gen_random_uuid()
           WHERE collection_id = $1"#,
    )
    .bind(fixture.collection_id)
    .execute(&fixture.pool)
    .await
    .unwrap_err();
    assert!(replica_identity_update
        .as_database_error()
        .is_some_and(|error| {
            error
                .message()
                .contains("replica and collection identities are immutable")
        }));
    let (usage_count_after, usage_bytes_after, receipt_bytes_after): (i64, i64, i64) =
        sqlx::query_as(
            r#"SELECT usage.receipt_count, usage.ciphertext_bytes,
                      receipt.response_ciphertext_bytes
               FROM hosted_provider_query_page_receipts receipt
               JOIN hosted_provider_query_receipt_usage usage
                 ON usage.scope_kind = 'account' AND usage.scope_id = receipt.account_id
               WHERE receipt.collection_id = $1"#,
        )
        .bind(fixture.collection_id)
        .fetch_one(&fixture.pool)
        .await
        .unwrap();
    assert_eq!(
        (usage_count_after, usage_bytes_after, receipt_bytes_after),
        (1, 1, 1)
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires MDBASE_PROJECTION_DATABASE_URL; run against a disposable PostgreSQL database"]
async fn candidate_b_query_receipts_evict_the_oldest_per_replica_window_entry() {
    let database_url = std::env::var("MDBASE_PROJECTION_DATABASE_URL")
        .expect("MDBASE_PROJECTION_DATABASE_URL is required");
    let fixture = FileLifecycleFixture::new(&database_url).await;
    let mirror = sqlx::query(
        "SELECT id, scope_epoch FROM hosted_provider_replicas WHERE collection_id = $1",
    )
    .bind(fixture.collection_id)
    .fetch_one(&fixture.pool)
    .await
    .unwrap();
    put(
        &fixture,
        mirror.get("id"),
        u64::try_from(mirror.get::<i64, _>("scope_epoch")).unwrap(),
        Uuid::now_v7(),
        None,
        "receipt-budget.md",
        "Receipt budget fixture.\n",
    )
    .await;
    complete_generation(&fixture).await;
    let replica_id = Uuid::now_v7();
    let token = format!("candidate-b-receipt-budget-{}", Uuid::new_v4());
    fixture
        .provider
        .register_replica(
            fixture.collection_id,
            RegisterReplica {
                replica_id,
                name: "Candidate B receipt budget reader".to_string(),
                purpose: ReplicaPurpose::Application,
                mode: SyncReplicaMode::ReadOnly,
                allowed_types: Vec::new(),
                contract_scope: Vec::new(),
                full_collection: true,
                allowed_operations: vec!["query".to_string()],
                operation_transport_protocol: Some(3),
                operation_transport_recovery_protocols: Vec::new(),
                file_capability: None,
                allowed_origin: None,
                proof_public_key: None,
                grant_id: Some(Uuid::now_v7()),
                application_declaration_id: None,
                application_declaration_digest: None,
                token: token.clone(),
                token_ttl_seconds: None,
            },
        )
        .await
        .unwrap();
    sqlx::query(
        r#"INSERT INTO hosted_provider_query_page_receipts
             (replica_id, request_id, collection_id, scope_epoch, request_kind,
              input_digest, response_ciphertext, expires_at, created_at)
           SELECT $1, md5('live-query-budget-' || g::text)::uuid, $2, 1,
                  'query', decode(repeat('33', 32), 'hex'), decode('00', 'hex'),
                  now() + interval '5 minutes',
                  now() - make_interval(secs => 65 - g)
           FROM generate_series(1, 64) AS g"#,
    )
    .bind(replica_id)
    .bind(fixture.collection_id)
    .execute(&fixture.pool)
    .await
    .unwrap();
    let result = fixture
        .provider
        .operation(
            fixture.collection_id,
            &token,
            "query",
            Uuid::new_v4(),
            json!({"limit": 1, "order_by": [{"field": "file.path"}]}),
            None,
        )
        .await
        .unwrap();
    assert_eq!(result["valid"], true);
    let (receipt_count, oldest_exists): (i64, bool) = sqlx::query_as(
        r#"SELECT count(*), bool_or(request_id = md5('live-query-budget-1')::uuid)
           FROM hosted_provider_query_page_receipts
           WHERE replica_id = $1"#,
    )
    .bind(replica_id)
    .fetch_one(&fixture.pool)
    .await
    .unwrap();
    assert_eq!(receipt_count, 64);
    assert!(!oldest_exists);
    let (usage_count, usage_bytes, direct_bytes): (i64, i64, i64) = sqlx::query_as(
        r#"SELECT usage.receipt_count, usage.ciphertext_bytes,
                  sum(receipt.response_ciphertext_bytes)::bigint
           FROM hosted_provider_query_receipt_usage usage
           JOIN hosted_provider_query_page_receipts receipt
             ON receipt.replica_id = usage.scope_id
           WHERE usage.scope_kind = 'replica' AND usage.scope_id = $1
           GROUP BY usage.receipt_count, usage.ciphertext_bytes"#,
    )
    .bind(replica_id)
    .fetch_one(&fixture.pool)
    .await
    .unwrap();
    assert_eq!(usage_count, 64);
    assert_eq!(usage_bytes, direct_bytes);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires MDBASE_PROJECTION_DATABASE_URL; run against a disposable PostgreSQL database"]
async fn candidate_b_corrupt_projection_envelopes_fall_back_for_scoped_authorization() {
    let database_url = std::env::var("MDBASE_PROJECTION_DATABASE_URL")
        .expect("MDBASE_PROJECTION_DATABASE_URL is required");
    let fixture = FileLifecycleFixture::new(&database_url).await;
    let writer_token = format!("candidate-b-integrity-writer-{}", Uuid::new_v4());
    fixture
        .provider
        .register_replica(
            fixture.collection_id,
            RegisterReplica {
                replica_id: Uuid::now_v7(),
                name: "Candidate B integrity writer".to_string(),
                purpose: ReplicaPurpose::Application,
                mode: SyncReplicaMode::ReadWrite,
                allowed_types: Vec::new(),
                contract_scope: Vec::new(),
                full_collection: true,
                allowed_operations: vec![
                    "assess_type_pack".to_string(),
                    "apply_type_pack".to_string(),
                    "create_type".to_string(),
                ],
                operation_transport_protocol: Some(3),
                operation_transport_recovery_protocols: Vec::new(),
                file_capability: None,
                allowed_origin: None,
                proof_public_key: None,
                grant_id: Some(Uuid::now_v7()),
                application_declaration_id: None,
                application_declaration_digest: None,
                token: writer_token.clone(),
                token_ttl_seconds: None,
            },
        )
        .await
        .unwrap();
    let contract_document = r#"---
kind: mdbase.contract
contract_type: record
id: test.public-note
version: 1.0.0
record_schema:
  dialect: json-schema-2020-12
  value:
    type: object
    properties:
      title: {type: string}
---
"#;
    let public_type_document = r#"---
kind: mdbase.type
name: public_note
version: 1
match:
  path_glob: 'public/*.md'
schema:
  dialect: json-schema-2020-12
  value:
    type: object
    properties:
      title: {type: string}
implements:
  - contract: test.public-note
    version: 1.0.0
    fields:
      title: title
---
"#;
    let pack = json!({
        "provision": {
            "manifest": {
                "kind": "mdbase.type-pack",
                "id": "test.candidate-b-integrity",
                "version": "1.0.0",
                "resources": [
                    {
                        "kind": "contract",
                        "mode": "managed",
                        "source": "contracts/public-note.md",
                        "target": "_contracts/public-note.md",
                        "digest": format!("sha256:{:x}", Sha256::digest(contract_document.as_bytes()))
                    },
                    {
                        "kind": "type",
                        "mode": "managed",
                        "source": "types/public-note.md",
                        "target": "_types/public_note.md",
                        "digest": format!("sha256:{:x}", Sha256::digest(public_type_document.as_bytes()))
                    }
                ]
            },
            "resources": [
                {"source": "contracts/public-note.md", "document": contract_document},
                {"source": "types/public-note.md", "document": public_type_document}
            ],
            "provides": [{
                "id": "test.public-note",
                "version": "1.0.0",
                "digest": format!("sha256:{:x}", Sha256::digest(contract_document.as_bytes()))
            }]
        },
        "installed_by": "test.candidate-b-integrity",
        "adopt_resources": {},
        "preserve_seed_targets": [],
        "target_overrides": {},
        "contract_setups": []
    });
    let assessment = fixture
        .provider
        .operation(
            fixture.collection_id,
            &writer_token,
            "assess_type_pack",
            Uuid::new_v4(),
            pack.clone(),
            None,
        )
        .await
        .unwrap();
    assert_eq!(assessment["valid"], true);
    let mut apply = pack;
    apply["expected_assessment_digest"] = assessment["result"]["assessment_digest"].clone();
    apply["allow_downgrade"] = json!(false);
    fixture
        .provider
        .operation(
            fixture.collection_id,
            &writer_token,
            "apply_type_pack",
            Uuid::new_v4(),
            apply,
            None,
        )
        .await
        .unwrap();
    let secret_type_document = r#"---
kind: mdbase.type
name: secret_note
version: 1
match:
  path_glob: 'secret/*.md'
schema:
  dialect: json-schema-2020-12
  value:
    type: object
    properties:
      title: {type: string}
---
"#;
    fixture
        .provider
        .operation(
            fixture.collection_id,
            &writer_token,
            "create_type",
            Uuid::new_v4(),
            json!({"document": secret_type_document}),
            None,
        )
        .await
        .unwrap();
    let mirror = sqlx::query(
        "SELECT id, scope_epoch FROM hosted_provider_replicas WHERE collection_id = $1 AND purpose = 'mirror'",
    )
    .bind(fixture.collection_id)
    .fetch_one(&fixture.pool)
    .await
    .unwrap();
    let public_id = Uuid::now_v7();
    let secret_id = Uuid::now_v7();
    put(
        &fixture,
        mirror.get("id"),
        u64::try_from(mirror.get::<i64, _>("scope_epoch")).unwrap(),
        public_id,
        None,
        "public/note.md",
        "---\ntitle: Public exact\n---\nPublic prose.\n",
    )
    .await;
    put(
        &fixture,
        mirror.get("id"),
        u64::try_from(mirror.get::<i64, _>("scope_epoch")).unwrap(),
        secret_id,
        None,
        "secret/note.md",
        "---\ntitle: Secret exact\n---\nSecret prose.\n",
    )
    .await;
    let generation_id = complete_generation(&fixture).await;
    let unguarded_digest_marker = sqlx::query(
        r#"UPDATE hosted_provider_record_projections
           SET projection_digest = decode(repeat('00', 32), 'hex')
           WHERE collection_id = $1 AND generation_id = $2
             AND valid_to_sequence IS NULL"#,
    )
    .bind(fixture.collection_id)
    .bind(generation_id)
    .execute(&fixture.pool)
    .await
    .unwrap_err();
    assert!(unguarded_digest_marker
        .as_database_error()
        .is_some_and(|error| error.message().contains("trusted projection write path")));
    let resources_row = sqlx::query(
        "SELECT wrapped_data_key, resources_ciphertext FROM hosted_provider_collections WHERE id = $1",
    )
    .bind(fixture.collection_id)
    .fetch_one(&fixture.pool)
    .await
    .unwrap();
    let data_key = fixture
        .crypto
        .unwrap_data_key(resources_row.get("wrapped_data_key"), fixture.collection_id)
        .await
        .unwrap();
    let resources: mdbase_connect_protocol::SyncCollectionResources = fixture
        .crypto
        .decrypt_json(
            &data_key,
            resources_row.get("resources_ciphertext"),
            &serde_json::to_vec(&("resources", fixture.collection_id)).unwrap(),
        )
        .unwrap();
    assert_eq!(resources.contracts.len(), 1);
    let reader_token = format!("candidate-b-integrity-reader-{}", Uuid::new_v4());
    fixture
        .provider
        .register_replica(
            fixture.collection_id,
            RegisterReplica {
                replica_id: Uuid::now_v7(),
                name: "Candidate B integrity scoped reader".to_string(),
                purpose: ReplicaPurpose::Application,
                mode: SyncReplicaMode::ReadOnly,
                allowed_types: vec!["public_note".to_string()],
                contract_scope: resources.contracts,
                full_collection: false,
                allowed_operations: vec!["query".to_string()],
                operation_transport_protocol: Some(3),
                operation_transport_recovery_protocols: Vec::new(),
                file_capability: None,
                allowed_origin: None,
                proof_public_key: None,
                grant_id: Some(Uuid::now_v7()),
                application_declaration_id: None,
                application_declaration_digest: None,
                token: reader_token.clone(),
                token_ttl_seconds: None,
            },
        )
        .await
        .unwrap();

    assert_scoped_public_query(&fixture, &reader_token).await;
    sqlx::query(
        r#"WITH originals AS MATERIALIZED (
             SELECT record_id, semantic_projection
             FROM hosted_provider_record_projections
             WHERE collection_id = $1 AND generation_id = $2
               AND record_id = ANY($3::uuid[]) AND valid_to_sequence IS NULL
           )
           UPDATE hosted_provider_record_projections projection
           SET canonical_path = CASE WHEN projection.record_id = $4
                                     THEN 'secret/substituted-public.md'
                                     ELSE 'public/substituted-secret.md' END,
               matched_types = CASE WHEN projection.record_id = $4
                                    THEN ARRAY['secret_note']::text[]
                                    ELSE ARRAY['public_note']::text[] END,
               semantic_projection = (
                 SELECT semantic_projection FROM originals
                 WHERE record_id <> projection.record_id
                 ORDER BY record_id LIMIT 1
               )
           WHERE projection.collection_id = $1 AND projection.generation_id = $2
             AND projection.record_id = ANY($3::uuid[])
             AND projection.valid_to_sequence IS NULL"#,
    )
    .bind(fixture.collection_id)
    .bind(generation_id)
    .bind(vec![public_id, secret_id])
    .bind(public_id)
    .execute(&fixture.pool)
    .await
    .unwrap();
    let invalid_rows: i64 = sqlx::query_scalar(
        r#"SELECT count(*) FROM hosted_provider_record_projections projection
           WHERE collection_id = $1 AND generation_id = $2
             AND record_id = ANY($3::uuid[]) AND valid_to_sequence IS NULL
             AND NOT hosted_provider_projection_digest_valid(
               projection.projection_digest,
               projection.projection_observed_digest)"#,
    )
    .bind(fixture.collection_id)
    .bind(generation_id)
    .bind(vec![public_id, secret_id])
    .fetch_one(&fixture.pool)
    .await
    .unwrap();
    assert_eq!(invalid_rows, 2);

    // Both widening (secret labelled public) and narrowing (public labelled
    // secret), plus path/frontmatter cross-record substitution, resolve from
    // exact authority. The scoped caller sees only the canonical public record.
    assert_scoped_public_query(&fixture, &reader_token).await;

    let head: i64 =
        sqlx::query_scalar("SELECT head FROM hosted_provider_collections WHERE id = $1")
            .bind(fixture.collection_id)
            .fetch_one(&fixture.pool)
            .await
            .unwrap();
    sqlx::query(
        r#"INSERT INTO hosted_provider_record_versions
             (collection_id, record_id, sequence, revision, types,
              payload_ciphertext, deleted)
           SELECT $1, md5('scoped-integrity-budget-' || g::text)::uuid, $2,
                  'scoped-integrity-budget:' || g::text,
                  ARRAY['secret_note']::text[], NULL, false
           FROM generate_series(1, 10001) AS g"#,
    )
    .bind(fixture.collection_id)
    .bind(head)
    .execute(&fixture.pool)
    .await
    .unwrap();
    let budget = fixture
        .provider
        .operation(
            fixture.collection_id,
            &reader_token,
            "query",
            Uuid::new_v4(),
            json!({"limit": 10}),
            None,
        )
        .await
        .unwrap_err();
    assert_eq!(budget.code, "hosted_scan_budget_exceeded");
    let details = budget.details.unwrap();
    assert_eq!(details["budget"], "candidate_rows");
    assert_eq!(details["limit"], 10_000);
    assert_eq!(details["observed"], 10_001);
}

async fn assert_scoped_public_query(fixture: &FileLifecycleFixture, token: &str) {
    let result = fixture
        .provider
        .operation(
            fixture.collection_id,
            token,
            "query",
            Uuid::new_v4(),
            json!({"limit": 10}),
            None,
        )
        .await
        .unwrap();
    assert_eq!(result["valid"], true);
    assert_eq!(result["result"]["meta"]["total_count"], 1);
    assert_eq!(result["result"]["results"][0]["path"], "public/note.md");
    assert_eq!(
        result["result"]["results"][0]["effective_frontmatter"]["title"],
        "Public exact"
    );
}

#[test]
#[ignore = "requires MDBASE_PROJECTION_DATABASE_URL; run against a disposable PostgreSQL database"]
fn candidate_b_projection_lifecycle_is_snapshot_safe_and_write_through() {
    // This intentionally comprehensive scenario combines many independently
    // tested lifecycle slices in one debug-build future. Give its test-only
    // runtime an explicit stack so runner platform defaults cannot turn the
    // aggregate harness itself into a flaky stack overflow.
    std::thread::Builder::new()
        .name("candidate-b-lifecycle-test".to_string())
        .stack_size(16 * 1024 * 1024)
        .spawn(|| {
            tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap()
                .block_on(async { Box::pin(exercise_candidate_b_projection_lifecycle()).await });
        })
        .unwrap()
        .join()
        .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires MDBASE_PROJECTION_DATABASE_URL; run against a disposable PostgreSQL database"]
async fn candidate_b_recovery_does_not_supersede_a_concurrent_explicit_generation_start() {
    let database_url = std::env::var("MDBASE_PROJECTION_DATABASE_URL")
        .expect("MDBASE_PROJECTION_DATABASE_URL is required");
    let fixture = FileLifecycleFixture::new(&database_url).await;
    sqlx::query(
        "UPDATE hosted_provider_collections SET hosted_execution_model = 'candidate_b' WHERE id = $1",
    )
    .bind(fixture.collection_id)
    .execute(&fixture.pool)
    .await
    .unwrap();

    let mut collection_lock = fixture.pool.begin().await.unwrap();
    sqlx::query("SELECT id FROM hosted_provider_collections WHERE id = $1 FOR UPDATE")
        .bind(fixture.collection_id)
        .fetch_one(&mut *collection_lock)
        .await
        .unwrap();

    let explicit_provider = fixture.provider.clone();
    let collection_id = fixture.collection_id;
    let explicit_start = tokio::spawn(async move {
        explicit_provider
            .start_projection_generation(collection_id)
            .await
    });
    wait_for_query_blocked(&fixture.pool, "SELECT head, resource_revision").await;

    let recovery_provider = fixture.provider.clone();
    let recovery =
        tokio::spawn(async move { recovery_provider.recover_projection_generations(1).await });
    wait_for_database_condition(&fixture.pool, || {
        let pool = fixture.pool.clone();
        async move {
            let blocked: i64 = sqlx::query_scalar(
                r#"SELECT count(*) FROM pg_stat_activity
                   WHERE datname = current_database()
                     AND pid <> pg_backend_pid()
                     AND wait_event_type = 'Lock'
                     AND query LIKE '%SELECT head, resource_revision%'"#,
            )
            .fetch_one(&pool)
            .await
            .unwrap();
            blocked >= 2
        }
    })
    .await;
    collection_lock.rollback().await.unwrap();

    let explicit_generation = explicit_start.await.unwrap().unwrap();
    recovery.await.unwrap().unwrap();
    let generations: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM hosted_provider_projection_generations WHERE collection_id = $1",
    )
    .bind(fixture.collection_id)
    .fetch_one(&fixture.pool)
    .await
    .unwrap();
    assert_eq!(generations, 1);
    let explicit_status: String = sqlx::query_scalar(
        "SELECT status FROM hosted_provider_projection_generations WHERE collection_id = $1 AND generation_id = $2",
    )
    .bind(fixture.collection_id)
    .bind(explicit_generation.generation_id)
    .fetch_one(&fixture.pool)
    .await
    .unwrap();
    assert_ne!(explicit_status, "abandoned");
}

async fn exercise_candidate_b_projection_lifecycle() {
    let database_url = std::env::var("MDBASE_PROJECTION_DATABASE_URL")
        .expect("MDBASE_PROJECTION_DATABASE_URL is required");
    let fixture = FileLifecycleFixture::new(&database_url).await;
    fixture
        .enable_obsidian_base_pattern("views/**/*.base")
        .await;
    let replica = sqlx::query(
        "SELECT id, scope_epoch FROM hosted_provider_replicas WHERE collection_id = $1",
    )
    .bind(fixture.collection_id)
    .fetch_one(&fixture.pool)
    .await
    .expect("fixture replica exists");
    let replica_id: Uuid = replica.get("id");
    let scope_epoch = u64::try_from(replica.get::<i64, _>("scope_epoch")).unwrap();
    let target_id = Uuid::now_v7();
    let source_id = Uuid::now_v7();

    let target = put(
        &fixture,
        replica_id,
        scope_epoch,
        target_id,
        None,
        "notes/target.md",
        "---\ntitle: Target\n---\nTarget prose\n",
    )
    .await;
    let source = put(
        &fixture,
        replica_id,
        scope_epoch,
        source_id,
        None,
        "notes/source.md",
        "---\ntitle: Source\n---\nSee [[target]].\n",
    )
    .await;

    let initial_execution_model: String = sqlx::query_scalar(
        "SELECT hosted_execution_model FROM hosted_provider_collections WHERE id = $1",
    )
    .bind(fixture.collection_id)
    .fetch_one(&fixture.pool)
    .await
    .unwrap();
    assert_eq!(initial_execution_model, "legacy");

    let first_generation = complete_generation(&fixture).await;
    let projected_file_fact = sqlx::query(
        r#"SELECT p.file_modified_at,
                  p.semantic_projection #>> '{file,mtime}' AS projection_mtime,
                  v.created_at AS version_created_at
           FROM hosted_provider_record_projections p
           JOIN hosted_provider_record_versions v
             ON v.collection_id = p.collection_id
            AND v.record_id = p.record_id
            AND v.sequence = p.record_sequence
           WHERE p.collection_id = $1 AND p.generation_id = $2
             AND p.record_id = $3 AND p.valid_to_sequence IS NULL"#,
    )
    .bind(fixture.collection_id)
    .bind(first_generation)
    .bind(source_id)
    .fetch_one(&fixture.pool)
    .await
    .expect("projection is revision-bound to the authoritative file time");
    let file_modified_at: DateTime<Utc> = projected_file_fact.get("file_modified_at");
    let version_created_at: DateTime<Utc> = projected_file_fact.get("version_created_at");
    assert_eq!(file_modified_at, version_created_at);
    assert_eq!(
        projected_file_fact.get::<String, _>("projection_mtime"),
        version_created_at.to_rfc3339_opts(SecondsFormat::Micros, true)
    );
    let relationship_before = sqlx::query(
        r#"SELECT valid_from_sequence, target_record_id, resolution_state
           FROM hosted_provider_record_relationships
           WHERE collection_id = $1 AND generation_id = $2
             AND source_record_id = $3 AND valid_to_sequence IS NULL"#,
    )
    .bind(fixture.collection_id)
    .bind(first_generation)
    .bind(source_id)
    .fetch_one(&fixture.pool)
    .await
    .expect("resolved source relationship exists");
    let relationship_valid_from: i64 = relationship_before.get("valid_from_sequence");
    assert_eq!(
        relationship_before.get::<Uuid, _>("target_record_id"),
        target_id
    );
    assert_eq!(
        relationship_before.get::<String, _>("resolution_state"),
        "resolved"
    );

    let source = put(
        &fixture,
        replica_id,
        scope_epoch,
        source_id,
        Some(source.revision),
        "notes/source.md",
        "---\ntitle: Source\n---\nChanged prose; see [[target]].\n",
    )
    .await;
    let relationship_after_prose = sqlx::query(
        r#"SELECT valid_from_sequence, target_record_id, resolution_state
           FROM hosted_provider_record_relationships
           WHERE collection_id = $1 AND generation_id = $2
             AND source_record_id = $3 AND valid_to_sequence IS NULL"#,
    )
    .bind(fixture.collection_id)
    .bind(first_generation)
    .bind(source_id)
    .fetch_one(&fixture.pool)
    .await
    .expect("unchanged structural relationship remains current");
    assert_eq!(
        relationship_after_prose.get::<i64, _>("valid_from_sequence"),
        relationship_valid_from
    );

    let delete_head = delete(
        &fixture,
        replica_id,
        scope_epoch,
        target_id,
        target.revision,
    )
    .await;
    let current_relationship = sqlx::query(
        r#"SELECT valid_from_sequence, source_record_sequence, target_record_id,
                  resolution_state
           FROM hosted_provider_record_relationships
           WHERE collection_id = $1 AND generation_id = $2
             AND source_record_id = $3 AND valid_to_sequence IS NULL"#,
    )
    .bind(fixture.collection_id)
    .bind(first_generation)
    .bind(source_id)
    .fetch_one(&fixture.pool)
    .await
    .expect("incoming relationship is revalidated after target deletion");
    assert_eq!(
        current_relationship.get::<i64, _>("valid_from_sequence"),
        delete_head
    );
    assert!(current_relationship
        .get::<Option<Uuid>, _>("target_record_id")
        .is_none());
    assert_eq!(
        current_relationship.get::<String, _>("resolution_state"),
        "missing"
    );
    assert!(current_relationship.get::<i64, _>("source_record_sequence") < delete_head);
    let target_current: bool = sqlx::query_scalar(
        r#"SELECT EXISTS (
             SELECT 1 FROM hosted_provider_record_projections
             WHERE collection_id = $1 AND generation_id = $2 AND record_id = $3
               AND valid_to_sequence IS NULL
           )"#,
    )
    .bind(fixture.collection_id)
    .bind(first_generation)
    .bind(target_id)
    .fetch_one(&fixture.pool)
    .await
    .unwrap();
    assert!(!target_current);

    let second_generation = complete_generation(&fixture).await;
    assert_ne!(first_generation, second_generation);
    let retained_old_rows: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM hosted_provider_record_projections WHERE collection_id = $1 AND generation_id = $2",
    )
    .bind(fixture.collection_id)
    .bind(first_generation)
    .fetch_one(&fixture.pool)
    .await
    .unwrap();
    assert!(
        retained_old_rows > 0,
        "old generation remains cursor-addressable"
    );

    let stale_generation = fixture
        .provider
        .start_projection_generation(fixture.collection_id)
        .await
        .unwrap();
    let pruned_first_generation: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM hosted_provider_record_projections
         WHERE collection_id = $1 AND generation_id = $2",
    )
    .bind(fixture.collection_id)
    .bind(first_generation)
    .fetch_one(&fixture.pool)
    .await
    .unwrap();
    assert_eq!(pruned_first_generation, 0);
    let _new_record = put(
        &fixture,
        replica_id,
        scope_epoch,
        Uuid::now_v7(),
        None,
        "notes/new.md",
        "New after the rebuild source head.\n",
    )
    .await;
    loop {
        let batch = fixture
            .provider
            .project_generation_batch(fixture.collection_id, stale_generation.generation_id, 200)
            .await
            .unwrap();
        if batch.generation.phase == "resolution" {
            break;
        }
    }
    let error = loop {
        match fixture
            .provider
            .resolve_generation_batch(fixture.collection_id, stale_generation.generation_id, 200)
            .await
        {
            Ok(batch) if batch.generation.status == "complete" => {
                panic!("stale source-head generation activated")
            }
            Ok(_) => continue,
            Err(error) => break error,
        }
    };
    assert_eq!(error.code, "projection_source_head_changed");
    let active_generation: Uuid = sqlx::query_scalar(
        "SELECT active_projection_generation_id FROM hosted_provider_collections WHERE id = $1",
    )
    .bind(fixture.collection_id)
    .fetch_one(&fixture.pool)
    .await
    .unwrap();
    assert_eq!(active_generation, second_generation);

    let application_token = format!("candidate-b-query-{}-{}", Uuid::new_v4(), Uuid::new_v4());
    fixture
        .provider
        .register_replica(
            fixture.collection_id,
            RegisterReplica {
                replica_id: Uuid::now_v7(),
                name: "Candidate B query reader".to_string(),
                purpose: ReplicaPurpose::Application,
                mode: SyncReplicaMode::ReadOnly,
                allowed_types: Vec::new(),
                contract_scope: Vec::new(),
                full_collection: true,
                allowed_operations: vec![
                    "read".to_string(),
                    "query".to_string(),
                    "validate".to_string(),
                    "read_type".to_string(),
                    "list_views".to_string(),
                    "execute_view".to_string(),
                    "read_view_source".to_string(),
                ],
                operation_transport_protocol: Some(3),
                operation_transport_recovery_protocols: Vec::new(),
                file_capability: None,
                allowed_origin: None,
                proof_public_key: None,
                grant_id: Some(Uuid::now_v7()),
                application_declaration_id: None,
                application_declaration_digest: None,
                token: application_token.clone(),
                token_ttl_seconds: None,
            },
        )
        .await
        .unwrap();
    let views = fixture
        .provider
        .operation(
            fixture.collection_id,
            &application_token,
            "list_views",
            Uuid::new_v4(),
            json!({}),
            None,
        )
        .await
        .unwrap();
    assert_eq!(views["valid"], true);
    assert!(views["result"]["views"].as_array().unwrap().is_empty());
    let missing_type = fixture
        .provider
        .operation(
            fixture.collection_id,
            &application_token,
            "read_type",
            Uuid::new_v4(),
            json!({"name": "absent"}),
            None,
        )
        .await
        .unwrap();
    assert_eq!(missing_type["valid"], false);
    assert_eq!(missing_type["diagnostics"][0]["code"], "unknown_type");
    sqlx::query(
        r#"WITH template AS (
             SELECT * FROM hosted_provider_record_projections
             WHERE collection_id = $1 AND generation_id = $2
             ORDER BY record_id LIMIT 1
           )
           INSERT INTO hosted_provider_record_projections
             (collection_id, record_id, record_sequence, valid_from_sequence,
              record_revision, catalog_revision, projection_format_version,
              semantic_engine_version, generation_id, canonical_path, matched_types,
              file_size_bytes, semantic_complete, resolution_complete,
              semantic_projection, projection_digest, structural_digest,
              projection_bytes)
           SELECT collection_id, md5('generic-query-orphan')::uuid,
                  record_sequence, valid_from_sequence, 'orphan:generic',
                  catalog_revision, projection_format_version,
                  semantic_engine_version, generation_id, 'notes/orphan.md',
                  matched_types, 0, true, true, semantic_projection,
                  decode(repeat('04', 32), 'hex'),
                  decode(repeat('05', 32), 'hex'), 0
           FROM template"#,
    )
    .bind(fixture.collection_id)
    .bind(second_generation)
    .execute(&fixture.pool)
    .await
    .unwrap();
    let projected_only = fixture
        .provider
        .operation(
            fixture.collection_id,
            &application_token,
            "query",
            Uuid::new_v4(),
            json!({
                "limit": 1,
                "order_by": [{"field": "file.path", "direction": "asc"}]
            }),
            None,
        )
        .await
        .unwrap();
    assert_eq!(projected_only["valid"], true);
    assert_eq!(projected_only["result"]["meta"]["total_count"], 2);
    let projected_selective_filter = fixture
        .provider
        .operation(
            fixture.collection_id,
            &application_token,
            "query",
            Uuid::new_v4(),
            json!({
                "where": "record.title == 'Source'",
                "limit": 10,
                "order_by": [{"field": "file.path"}],
            }),
            None,
        )
        .await
        .unwrap();
    assert_eq!(projected_selective_filter["valid"], true);
    assert_eq!(
        projected_selective_filter["result"]["meta"]["total_count"],
        1
    );
    assert_eq!(
        projected_selective_filter["result"]["results"][0]["path"],
        "notes/source.md"
    );
    let query = json!({
        "pagination": "cursor",
        "limit": 1,
        "include_body": true,
        "order_by": [{"field": "file.path", "direction": "asc"}],
    });
    let first = fixture
        .provider
        .operation(
            fixture.collection_id,
            &application_token,
            "query",
            Uuid::new_v4(),
            query,
            None,
        )
        .await
        .unwrap();
    assert_eq!(first["result"]["meta"]["total_count"], 2);
    assert_eq!(first["result"]["meta"]["has_more"], true);
    assert!(first["result"]["results"][0]["body"].is_string());
    let first_path = first["result"]["results"][0]["path"]
        .as_str()
        .unwrap()
        .to_string();
    let cursor = first["result"]["meta"]["cursor"]
        .as_str()
        .unwrap()
        .to_string();

    let post_snapshot_id = Uuid::now_v7();
    put(
        &fixture,
        replica_id,
        scope_epoch,
        post_snapshot_id,
        None,
        "notes/post-snapshot.md",
        "---\ntitle: Post snapshot\ntags: [hosted]\ndue: 2026-05-01\n---\nThis record must not enter the pinned query.\n",
    )
    .await;
    let second = fixture
        .provider
        .operation(
            fixture.collection_id,
            &application_token,
            "query",
            Uuid::new_v4(),
            json!({
                "cursor": cursor,
                "limit": 1,
                "include_body": true,
                "order_by": [{"field": "file.path", "direction": "asc"}],
            }),
            None,
        )
        .await
        .unwrap();
    assert_eq!(second["result"]["meta"]["total_count"], 2);
    assert_eq!(second["result"]["meta"]["has_more"], false);
    assert!(second["result"]["meta"]["cursor"].is_null());
    let second_path = second["result"]["results"][0]["path"]
        .as_str()
        .unwrap()
        .to_string();
    assert_eq!(
        [first_path, second_path],
        ["notes/new.md", "notes/source.md"]
    );

    let current_head: i64 =
        sqlx::query_scalar("SELECT head FROM hosted_provider_collections WHERE id = $1")
            .bind(fixture.collection_id)
            .fetch_one(&fixture.pool)
            .await
            .unwrap();
    assert!(current_head > delete_head);

    let projected_filter = fixture
        .provider
        .operation(
            fixture.collection_id,
            &application_token,
            "query",
            Uuid::new_v4(),
            json!({
                "where": "record.title == 'Source'",
                "limit": 10,
                "order_by": [{"field": "file.path"}],
            }),
            None,
        )
        .await
        .unwrap();
    assert_eq!(projected_filter["result"]["meta"]["total_count"], 1);
    assert_eq!(
        projected_filter["result"]["results"][0]["path"],
        "notes/source.md"
    );

    let body_filter = fixture
        .provider
        .operation(
            fixture.collection_id,
            &application_token,
            "query",
            Uuid::new_v4(),
            json!({
                "where": "file.body.contains('Changed prose')",
                "limit": 10,
                "order_by": [{"field": "file.path"}],
            }),
            None,
        )
        .await
        .unwrap();
    assert_eq!(body_filter["result"]["meta"]["total_count"], 1);
    assert_eq!(
        body_filter["result"]["results"][0]["path"],
        "notes/source.md"
    );
    assert!(body_filter["result"]["results"][0].get("body").is_none());

    let date_filter = fixture
        .provider
        .operation(
            fixture.collection_id,
            &application_token,
            "query",
            Uuid::new_v4(),
            json!({
                "where": "record.tags.contains('hosted') && record.due < '2026-06-01'",
                "limit": 10,
                "order_by": [{"field": "file.path"}],
            }),
            None,
        )
        .await
        .unwrap();
    assert_eq!(date_filter["result"]["meta"]["total_count"], 1);
    assert_eq!(
        date_filter["result"]["results"][0]["path"],
        "notes/post-snapshot.md"
    );

    let ordered = fixture
        .provider
        .operation(
            fixture.collection_id,
            &application_token,
            "query",
            Uuid::new_v4(),
            json!({
                "pagination": "cursor",
                "limit": 1,
                "order_by": [{"field": "record.title", "direction": "desc"}],
            }),
            None,
        )
        .await
        .unwrap();
    assert_eq!(ordered["result"]["results"][0]["path"], "notes/new.md");
    let ordered_cursor = ordered["result"]["meta"]["cursor"]
        .as_str()
        .unwrap()
        .to_string();
    let ordered_next = fixture
        .provider
        .operation(
            fixture.collection_id,
            &application_token,
            "query",
            Uuid::new_v4(),
            json!({
                "cursor": ordered_cursor,
                "limit": 1,
                "order_by": [{"field": "record.title", "direction": "desc"}],
            }),
            None,
        )
        .await
        .unwrap();
    assert_eq!(
        ordered_next["result"]["results"][0]["path"],
        "notes/source.md"
    );

    let grouped = fixture
        .provider
        .operation(
            fixture.collection_id,
            &application_token,
            "query",
            Uuid::new_v4(),
            json!({
                "limit": 10,
                "group_by": [{"field": "record.title"}],
                "summaries": [
                    {"field": "record.title", "function": "count", "name": "records"}
                ],
                "order_by": [{"field": "file.path"}],
            }),
            None,
        )
        .await
        .unwrap();
    let groups = grouped["result"]["meta"]["groups"].as_array().unwrap();
    assert_eq!(groups.len(), 3);
    assert!(groups
        .iter()
        .all(|group| group["count"] == 1 && group["summaries"]["records"] == 1));

    let mut lock_owner = fixture.pool.begin().await.unwrap();
    sqlx::query("LOCK TABLE hosted_provider_record_versions IN ACCESS EXCLUSIVE MODE")
        .execute(&mut *lock_owner)
        .await
        .unwrap();
    let blocked_provider = fixture.provider.clone();
    let blocked_token = application_token.clone();
    let blocked_collection = fixture.collection_id;
    let blocked_query = tokio::spawn(async move {
        blocked_provider
            .operation(
                blocked_collection,
                &blocked_token,
                "query",
                Uuid::new_v4(),
                json!({
                    "where": "file.body.contains('Changed prose')",
                    "limit": 10,
                    "order_by": [{"field": "file.path"}],
                }),
                None,
            )
            .await
    });
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            let activity = fixture.provider.hosted_query_activity();
            let blocked_sessions: i64 = sqlx::query_scalar(
                r#"SELECT count(*) FROM pg_stat_activity
                   WHERE datname = current_database() AND wait_event_type = 'Lock'
                     AND query LIKE 'WITH live AS (%'"#,
            )
            .fetch_one(&fixture.pool)
            .await
            .unwrap();
            if activity.active_queries == 1
                && activity.plaintext_scopes == 1
                && activity.active_scan_permits == 1
                && blocked_sessions == 1
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("the query reaches its cancellable PostgreSQL wait");
    blocked_query.abort();
    assert!(blocked_query.await.unwrap_err().is_cancelled());
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            let activity = fixture.provider.hosted_query_activity();
            let blocked_sessions: i64 = sqlx::query_scalar(
                r#"SELECT count(*) FROM pg_stat_activity
                   WHERE datname = current_database()
                     AND (wait_event_type = 'Lock' OR state = 'idle in transaction')
                     AND query LIKE 'WITH live AS (%'"#,
            )
            .fetch_one(&fixture.pool)
            .await
            .unwrap();
            if activity.active_queries == 0
                && activity.plaintext_scopes == 0
                && activity.active_scan_permits == 0
                && blocked_sessions == 0
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("cancellation releases query, transaction, session, and plaintext state");
    lock_owner.rollback().await.unwrap();
    let after_cancel = fixture
        .provider
        .operation(
            fixture.collection_id,
            &application_token,
            "query",
            Uuid::new_v4(),
            json!({"limit": 1, "order_by": [{"field": "file.path"}]}),
            None,
        )
        .await
        .unwrap();
    assert_eq!(
        after_cancel["result"]["results"].as_array().unwrap().len(),
        1
    );

    Box::pin(assert_projected_group_cancellation(
        &fixture,
        &application_token,
    ))
    .await;

    let mut validation_lock = fixture.pool.begin().await.unwrap();
    sqlx::query("LOCK TABLE hosted_provider_record_projections IN ACCESS EXCLUSIVE MODE")
        .execute(&mut *validation_lock)
        .await
        .unwrap();
    let validation_provider = fixture.provider.clone();
    let validation_token = application_token.clone();
    let validation_collection = fixture.collection_id;
    let blocked_validation = tokio::spawn(async move {
        validation_provider
            .operation(
                validation_collection,
                &validation_token,
                "validate",
                Uuid::new_v4(),
                json!({"path": "notes/source.md"}),
                None,
            )
            .await
    });
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            let activity = fixture.provider.hosted_query_activity();
            let blocked_sessions: i64 = sqlx::query_scalar(
                r#"SELECT count(*) FROM pg_stat_activity
                   WHERE datname = current_database() AND wait_event_type = 'Lock'
                     AND query LIKE '%LEFT JOIN hosted_provider_record_projections p%'"#,
            )
            .fetch_one(&fixture.pool)
            .await
            .unwrap();
            if activity.active_queries == 1
                && activity.plaintext_scopes == 1
                && activity.active_scan_permits == 0
                && blocked_sessions == 1
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("validation reaches its cancellable PostgreSQL wait");
    blocked_validation.abort();
    assert!(blocked_validation.await.unwrap_err().is_cancelled());
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            let activity = fixture.provider.hosted_query_activity();
            let blocked_sessions: i64 = sqlx::query_scalar(
                r#"SELECT count(*) FROM pg_stat_activity
                   WHERE datname = current_database()
                     AND (wait_event_type = 'Lock' OR state = 'idle in transaction')
                     AND query LIKE '%LEFT JOIN hosted_provider_record_projections p%'"#,
            )
            .fetch_one(&fixture.pool)
            .await
            .unwrap();
            if activity.active_queries == 0
                && activity.plaintext_scopes == 0
                && activity.active_scan_permits == 0
                && blocked_sessions == 0
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("validation cancellation releases transaction, session, and plaintext state");
    validation_lock.rollback().await.unwrap();

    sqlx::query(
        r#"UPDATE hosted_provider_record_projections
           SET semantic_complete = false
           WHERE collection_id = $1 AND generation_id = $2 AND record_id = $3
             AND valid_to_sequence IS NULL"#,
    )
    .bind(fixture.collection_id)
    .bind(second_generation)
    .bind(source_id)
    .execute(&fixture.pool)
    .await
    .unwrap();
    let stale_fallback = fixture
        .provider
        .operation(
            fixture.collection_id,
            &application_token,
            "query",
            Uuid::new_v4(),
            json!({"limit": 10, "order_by": [{"field": "file.path"}]}),
            None,
        )
        .await
        .unwrap();
    assert_eq!(stale_fallback["result"]["meta"]["total_count"], 3);
    assert_eq!(
        stale_fallback["result"]["results"]
            .as_array()
            .unwrap()
            .len(),
        3
    );
    assert!(stale_fallback["result"]["results"]
        .as_array()
        .unwrap()
        .iter()
        .any(|result| result["path"] == "notes/source.md"));
    let validated = fixture
        .provider
        .operation(
            fixture.collection_id,
            &application_token,
            "validate",
            Uuid::new_v4(),
            json!({"path": "notes/source.md"}),
            None,
        )
        .await
        .unwrap();
    assert_eq!(validated["valid"], true);
    assert_eq!(validated["result"]["path"], "notes/source.md");
    let missing_validation = fixture
        .provider
        .operation(
            fixture.collection_id,
            &application_token,
            "validate",
            Uuid::new_v4(),
            json!({"path": "notes/absent.md"}),
            None,
        )
        .await
        .unwrap();
    assert_eq!(missing_validation["valid"], false);
    assert_eq!(
        missing_validation["diagnostics"][0]["code"],
        "file_not_found"
    );

    let writer_token = format!("candidate-b-writer-{}-{}", Uuid::new_v4(), Uuid::new_v4());
    fixture
        .provider
        .register_replica(
            fixture.collection_id,
            RegisterReplica {
                replica_id: Uuid::now_v7(),
                name: "Candidate B mutation writer".to_string(),
                purpose: ReplicaPurpose::Application,
                mode: SyncReplicaMode::ReadWrite,
                allowed_types: Vec::new(),
                contract_scope: Vec::new(),
                full_collection: true,
                allowed_operations: vec![
                    "read".to_string(),
                    "validate".to_string(),
                    "create".to_string(),
                    "update".to_string(),
                    "delete".to_string(),
                    "rename".to_string(),
                    "create_type".to_string(),
                    "read_type".to_string(),
                    "assess_type_pack".to_string(),
                    "apply_type_pack".to_string(),
                    "create_view_source".to_string(),
                    "update_view_source".to_string(),
                    "read_view_source".to_string(),
                    "list_views".to_string(),
                ],
                operation_transport_protocol: Some(3),
                operation_transport_recovery_protocols: Vec::new(),
                file_capability: None,
                allowed_origin: None,
                proof_public_key: None,
                grant_id: Some(Uuid::now_v7()),
                application_declaration_id: None,
                application_declaration_digest: None,
                token: writer_token.clone(),
                token_ttl_seconds: None,
            },
        )
        .await
        .unwrap();
    let records_before_preflight: i64 =
        sqlx::query_scalar("SELECT count(*) FROM hosted_provider_records WHERE collection_id = $1")
            .bind(fixture.collection_id)
            .fetch_one(&fixture.pool)
            .await
            .unwrap();
    let dry_run = fixture
        .provider
        .operation(
            fixture.collection_id,
            &writer_token,
            "create",
            Uuid::new_v4(),
            json!({
                "path": "notes/preflight-only.md",
                "frontmatter": {"title": "Preflight only"},
                "body": "No durable write.\n",
                "dry_run": true,
            }),
            None,
        )
        .await
        .unwrap();
    assert_eq!(dry_run["valid"], true);
    let records_after_preflight: i64 =
        sqlx::query_scalar("SELECT count(*) FROM hosted_provider_records WHERE collection_id = $1")
            .bind(fixture.collection_id)
            .fetch_one(&fixture.pool)
            .await
            .unwrap();
    assert_eq!(records_after_preflight, records_before_preflight);

    let target_created = fixture
        .provider
        .operation(
            fixture.collection_id,
            &writer_token,
            "create",
            Uuid::new_v4(),
            json!({
                "path": "notes/app-target.md",
                "frontmatter": {"title": "Application target"},
                "body": "Target body.\n",
            }),
            None,
        )
        .await
        .unwrap();
    assert_eq!(target_created["valid"], true);
    let target_revision = target_created["result"]["revision"]
        .as_str()
        .unwrap()
        .to_string();
    let reference_created = fixture
        .provider
        .operation(
            fixture.collection_id,
            &writer_token,
            "create",
            Uuid::new_v4(),
            json!({
                "path": "notes/app-reference.md",
                "frontmatter": {"title": "Application reference"},
                "body": "See [[app-target]].\n",
            }),
            None,
        )
        .await
        .unwrap();
    assert_eq!(reference_created["valid"], true);

    let rename_request_id = Uuid::new_v4();
    let rename_input = json!({
        "from": "notes/app-target.md",
        "to": "notes/app-renamed.md",
        "if_revision": target_revision,
        "update_refs": true,
    });
    let renamed = fixture
        .provider
        .operation(
            fixture.collection_id,
            &writer_token,
            "rename",
            rename_request_id,
            rename_input.clone(),
            None,
        )
        .await
        .unwrap();
    assert_eq!(renamed["valid"], true);
    assert_eq!(renamed["result"]["to"], "notes/app-renamed.md");
    assert_eq!(
        renamed["result"]["references_updated"][0]["path"],
        "notes/app-reference.md"
    );
    let renamed_replay = fixture
        .provider
        .operation(
            fixture.collection_id,
            &writer_token,
            "rename",
            rename_request_id,
            rename_input,
            None,
        )
        .await
        .unwrap();
    assert_eq!(renamed_replay, renamed);
    let renamed_revision = renamed["result"]["revision"].as_str().unwrap().to_string();
    let exact_reference = fixture
        .provider
        .operation(
            fixture.collection_id,
            &writer_token,
            "read",
            Uuid::new_v4(),
            json!({"path": "notes/app-reference.md", "include_document": true}),
            None,
        )
        .await
        .unwrap();
    assert!(exact_reference["result"]["document"]
        .as_str()
        .unwrap()
        .contains("app-renamed"));
    DateTime::parse_from_rfc3339(
        exact_reference["result"]["file"]["mtime"]
            .as_str()
            .expect("exact hosted reads expose revision-scoped file mtime"),
    )
    .expect("hosted file mtime is RFC 3339");

    let deleted = fixture
        .provider
        .operation(
            fixture.collection_id,
            &writer_token,
            "delete",
            Uuid::new_v4(),
            json!({
                "path": "notes/app-renamed.md",
                "if_revision": renamed_revision,
                "check_backlinks": true,
            }),
            None,
        )
        .await
        .unwrap();
    assert_eq!(deleted["valid"], true);
    assert_eq!(deleted["result"]["deleted"], true);
    assert_eq!(
        deleted["result"]["broken_links"][0]["path"],
        "notes/app-reference.md"
    );

    for (path, priority) in [("tasks/high.md", "high"), ("tasks/low.md", "low")] {
        let created = fixture
            .provider
            .operation(
                fixture.collection_id,
                &writer_token,
                "create",
                Uuid::new_v4(),
                json!({
                    "path": path,
                    "frontmatter": {
                        "status": "todo",
                        "priority": priority,
                        "tags": ["task"],
                    },
                    "body": format!("{priority} task prose\n"),
                }),
                None,
            )
            .await
            .unwrap();
        assert_eq!(created["valid"], true);
    }
    let tasknotes_base = r#"filters:
  and:
    - 'file.hasTag("task")'
formulas:
  urgency: 'if(priority == "high", 2, 1)'
views:
  - type: tasknotesTaskList
    name: Open tasks
    filters:
      and:
        - 'status != "done"'
    order: [status, formula.urgency, file.name]
    sort:
      - property: formula.urgency
        direction: DESC
"#;
    let created_base = fixture
        .provider
        .operation(
            fixture.collection_id,
            &writer_token,
            "create_view_source",
            Uuid::new_v4(),
            json!({"path": "views/tasks.base", "document": tasknotes_base}),
            None,
        )
        .await
        .unwrap();
    assert_eq!(created_base["valid"], true);
    let first_base_page = fixture
        .provider
        .operation(
            fixture.collection_id,
            &application_token,
            "execute_view",
            Uuid::new_v4(),
            json!({"path": "views/tasks.base", "view": "open-tasks", "limit": 1}),
            None,
        )
        .await
        .unwrap();
    assert_eq!(first_base_page["valid"], true);
    assert_eq!(first_base_page["result"]["meta"]["total_count"], 2);
    assert_eq!(
        first_base_page["result"]["results"][0]["path"],
        "tasks/high.md"
    );
    assert_eq!(
        first_base_page["result"]["results"][0]["values"]["formula.urgency"],
        2
    );
    let base_cursor = first_base_page["result"]["meta"]["cursor"]
        .as_str()
        .expect("TaskNotes Base has another page");
    let base_cursor_state = sqlx::query(
        "SELECT base_plan, base_context, base_operation_clock, base_invocation_id,
                exact_context_ciphertext FROM hosted_provider_query_cursors
         WHERE collection_id = $1 AND request_kind = 'obsidian_base'
         ORDER BY created_at DESC LIMIT 1",
    )
    .bind(fixture.collection_id)
    .fetch_one(&fixture.pool)
    .await
    .unwrap();
    assert!(base_cursor_state
        .get::<Option<serde_json::Value>, _>("base_plan")
        .is_none());
    assert!(base_cursor_state
        .get::<Option<serde_json::Value>, _>("base_context")
        .is_none());
    assert!(base_cursor_state
        .get::<Option<String>, _>("base_operation_clock")
        .is_none());
    let base_invocation_id: Uuid = base_cursor_state.get("base_invocation_id");
    let invocation_plan: serde_json::Value = sqlx::query_scalar(
        "SELECT base_plan FROM hosted_provider_base_query_invocations
         WHERE invocation_id = $1 AND collection_id = $2",
    )
    .bind(base_invocation_id)
    .bind(fixture.collection_id)
    .fetch_one(&fixture.pool)
    .await
    .unwrap();
    assert!(invocation_plan.is_object());
    assert!(base_cursor_state
        .get::<Option<Vec<u8>>, _>("exact_context_ciphertext")
        .is_none());
    Box::pin(assert_pre_0040_rollback_preflight(&fixture, true)).await;
    let changed_base = tasknotes_base.replace(
        "if(priority == \"high\", 2, 1)",
        "if(priority == \"high\", 0, 3)",
    );
    let updated_base = fixture
        .provider
        .operation(
            fixture.collection_id,
            &writer_token,
            "update_view_source",
            Uuid::new_v4(),
            json!({
                "path": "views/tasks.base",
                "if_revision": created_base["result"]["revision"],
                "document": changed_base,
            }),
            None,
        )
        .await
        .unwrap();
    assert_eq!(updated_base["valid"], true);
    let second_base_page = fixture
        .provider
        .operation(
            fixture.collection_id,
            &application_token,
            "execute_view",
            Uuid::new_v4(),
            json!({
                "path": "views/tasks.base",
                "view": "open-tasks",
                "cursor": base_cursor,
                "limit": 1,
            }),
            None,
        )
        .await
        .unwrap();
    assert_eq!(second_base_page["valid"], true);
    assert_eq!(
        second_base_page["result"]["results"][0]["path"],
        "tasks/low.md"
    );
    assert_eq!(second_base_page["result"]["meta"]["has_more"], false);
    let remaining_invocations: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM hosted_provider_base_query_invocations
         WHERE invocation_id = $1",
    )
    .bind(base_invocation_id)
    .fetch_one(&fixture.pool)
    .await
    .unwrap();
    assert_eq!(remaining_invocations, 0);
    Box::pin(assert_pre_0040_rollback_preflight(&fixture, false)).await;

    let stable_view_document = "---\ntype: view\nid: stable.views\nversion: 1\nname: Stable\nquery:\n  where: this.id == 'stable.views'\nviews:\n  - id: all\n    name: All\n---\n";
    let stable_view = fixture
        .provider
        .operation(
            fixture.collection_id,
            &writer_token,
            "create_view_source",
            Uuid::new_v4(),
            json!({"path": "views/stable.md", "document": stable_view_document}),
            None,
        )
        .await
        .unwrap();
    assert_eq!(stable_view["valid"], true);
    let first_view_page = fixture
        .provider
        .operation(
            fixture.collection_id,
            &application_token,
            "execute_view",
            Uuid::new_v4(),
            json!({"path": "views/stable.md", "view": "all", "limit": 1}),
            None,
        )
        .await
        .unwrap();
    assert_eq!(first_view_page["valid"], true);
    assert_eq!(first_view_page["result"]["meta"]["view"]["id"], "all");
    assert_eq!(
        first_view_page["result"]["results"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    let cursor = first_view_page["result"]["meta"]["cursor"]
        .as_str()
        .expect("saved view has a second page");
    let cursor_context: Vec<u8> = sqlx::query_scalar(
        "SELECT exact_context_ciphertext FROM hosted_provider_query_cursors
         WHERE collection_id = $1 AND request_kind = 'canonical_view'
         ORDER BY created_at DESC LIMIT 1",
    )
    .bind(fixture.collection_id)
    .fetch_one(&fixture.pool)
    .await
    .unwrap();
    assert!(!cursor_context.is_empty());
    assert!(!cursor_context
        .windows(b"stable.views".len())
        .any(|window| window == b"stable.views"));
    let wrong_surface = fixture
        .provider
        .operation(
            fixture.collection_id,
            &application_token,
            "query",
            Uuid::new_v4(),
            json!({"cursor": cursor, "limit": 2}),
            None,
        )
        .await
        .unwrap_err();
    assert_eq!(wrong_surface.code, "query_cursor_mismatch");
    let changed_view_document = "---\ntype: view\nid: changed.views\nversion: 1\nname: Changed\nquery:\n  where: this.id == 'stable.views'\nviews:\n  - id: all\n    name: All\n---\n";
    let changed_view = fixture
        .provider
        .operation(
            fixture.collection_id,
            &writer_token,
            "update_view_source",
            Uuid::new_v4(),
            json!({
                "path": "views/stable.md",
                "if_revision": stable_view["result"]["revision"],
                "document": changed_view_document,
            }),
            None,
        )
        .await
        .unwrap();
    assert_eq!(changed_view["valid"], true);
    let second_view_page = fixture
        .provider
        .operation(
            fixture.collection_id,
            &application_token,
            "execute_view",
            Uuid::new_v4(),
            json!({
                "path": "views/stable.md",
                "view": "all",
                "cursor": cursor,
                "limit": 2,
            }),
            None,
        )
        .await
        .unwrap();
    assert_eq!(second_view_page["valid"], true);
    assert_eq!(second_view_page["result"]["meta"]["view"]["id"], "all");
    let active_after_view: Option<Uuid> = sqlx::query_scalar(
        "SELECT active_projection_generation_id FROM hosted_provider_collections WHERE id = $1",
    )
    .bind(fixture.collection_id)
    .fetch_one(&fixture.pool)
    .await
    .unwrap();
    assert_eq!(active_after_view, Some(second_generation));
    let query_after_view = fixture
        .provider
        .operation(
            fixture.collection_id,
            &application_token,
            "query",
            Uuid::new_v4(),
            json!({"limit": 1, "order_by": [{"field": "file.path"}]}),
            None,
        )
        .await
        .unwrap();
    assert_eq!(query_after_view["valid"], true);

    let type_document = "---\nkind: mdbase.type\nname: note\nversion: 1\nmatch:\n  path_glob: 'notes/*.md'\nschema:\n  dialect: json-schema-2020-12\n  value:\n    type: object\n    properties:\n      title: {type: string}\n---\n";
    let created_type = fixture
        .provider
        .operation(
            fixture.collection_id,
            &writer_token,
            "create_type",
            Uuid::new_v4(),
            json!({"document": type_document}),
            None,
        )
        .await
        .unwrap();
    assert_eq!(created_type["valid"], true);
    assert_eq!(created_type["result"]["name"], "note");
    let mut rebuilt_generation = None;
    for _ in 0..100 {
        fixture
            .provider
            .recover_projection_generations(10)
            .await
            .unwrap();
        let active: Option<Uuid> = sqlx::query_scalar(
            "SELECT active_projection_generation_id FROM hosted_provider_collections WHERE id = $1",
        )
        .bind(fixture.collection_id)
        .fetch_one(&fixture.pool)
        .await
        .unwrap();
        if let Some(active) = active {
            rebuilt_generation = Some(active);
            break;
        }
        tokio::task::yield_now().await;
    }
    let rebuilt_generation = rebuilt_generation.expect("semantic generation rebuilt");
    assert_ne!(rebuilt_generation, second_generation);
    let execution_model: String = sqlx::query_scalar(
        "SELECT hosted_execution_model FROM hosted_provider_collections WHERE id = $1",
    )
    .bind(fixture.collection_id)
    .fetch_one(&fixture.pool)
    .await
    .unwrap();
    assert_eq!(execution_model, "candidate_b");
    let query_after_rebuild = fixture
        .provider
        .operation(
            fixture.collection_id,
            &application_token,
            "query",
            Uuid::new_v4(),
            json!({"limit": 1, "order_by": [{"field": "file.path"}]}),
            None,
        )
        .await
        .unwrap();
    assert_eq!(query_after_rebuild["valid"], true);
    let read_type = fixture
        .provider
        .operation(
            fixture.collection_id,
            &writer_token,
            "read_type",
            Uuid::new_v4(),
            json!({"name": "note"}),
            None,
        )
        .await
        .unwrap();
    assert_eq!(read_type["result"]["document"], type_document);

    let view_document = "---\ntype: view\nid: hosted.views\nversion: 1\nname: Hosted\nquery: {}\nviews:\n  - id: all\n    name: All\n---\n";
    let created_view = fixture
        .provider
        .operation(
            fixture.collection_id,
            &writer_token,
            "create_view_source",
            Uuid::new_v4(),
            json!({"path": "views/hosted.md", "document": view_document}),
            None,
        )
        .await
        .unwrap();
    assert_eq!(created_view["valid"], true);
    let active_after_second_view: Option<Uuid> = sqlx::query_scalar(
        "SELECT active_projection_generation_id FROM hosted_provider_collections WHERE id = $1",
    )
    .bind(fixture.collection_id)
    .fetch_one(&fixture.pool)
    .await
    .unwrap();
    assert_eq!(active_after_second_view, Some(rebuilt_generation));
    let read_view = fixture
        .provider
        .operation(
            fixture.collection_id,
            &writer_token,
            "read_view_source",
            Uuid::new_v4(),
            json!({"path": "views/hosted.md"}),
            None,
        )
        .await
        .unwrap();
    assert_eq!(read_view["result"]["document"], view_document);

    Box::pin(
        exercise_candidate_b_definition_operations_without_record_decryption(
            &fixture,
            &writer_token,
            source_id,
            rebuilt_generation,
        ),
    )
    .await;

    // Keep the compiler honest that the updated source remains a real exact
    // authority record throughout relationship-only revalidation.
    assert!(!source.revision.is_empty());
}

async fn exercise_candidate_b_definition_operations_without_record_decryption(
    fixture: &FileLifecycleFixture,
    writer_token: &str,
    source_id: Uuid,
    previous_generation: Uuid,
) {
    let project_type = "---\nkind: mdbase.type\nname: project\nversion: 1\nschema:\n  dialect: json-schema-2020-12\n  value: {type: object}\n---\n";
    let pack = json!({
        "provision": {
            "manifest": {
                "kind": "mdbase.type-pack",
                "id": "dev.mdbase.candidate-b-project",
                "version": "1.0.0",
                "resources": [{
                    "kind": "type",
                    "mode": "managed",
                    "source": "types/project.md",
                    "target": "_types/project.md",
                    "digest": format!("sha256:{:x}", Sha256::digest(project_type.as_bytes()))
                }]
            },
            "resources": [{"source": "types/project.md", "document": project_type}],
            "provides": []
        },
        "installed_by": "dev.mdbase.candidate-b-project",
        "adopt_resources": {},
        "preserve_seed_targets": [],
        "target_overrides": {},
        "contract_setups": []
    });
    let original_ciphertext: Vec<u8> = sqlx::query_scalar(
        "SELECT payload_ciphertext FROM hosted_provider_records WHERE collection_id = $1 AND record_id = $2",
    )
    .bind(fixture.collection_id)
    .bind(source_id)
    .fetch_one(&fixture.pool)
    .await
    .unwrap();
    sqlx::query(
        "UPDATE hosted_provider_records SET payload_ciphertext = '\\x00' WHERE collection_id = $1 AND record_id = $2",
    )
    .bind(fixture.collection_id)
    .bind(source_id)
    .execute(&fixture.pool)
    .await
    .unwrap();
    let assessment = fixture
        .provider
        .operation(
            fixture.collection_id,
            writer_token,
            "assess_type_pack",
            Uuid::new_v4(),
            pack.clone(),
            None,
        )
        .await
        .expect("Candidate B definition assessment never decrypts record Markdown");
    assert_eq!(assessment["valid"], true);
    let mut apply = pack;
    apply["expected_assessment_digest"] = assessment["result"]["assessment_digest"].clone();
    apply["allow_downgrade"] = json!(false);
    let applied = fixture
        .provider
        .operation(
            fixture.collection_id,
            writer_token,
            "apply_type_pack",
            Uuid::new_v4(),
            apply,
            None,
        )
        .await
        .expect("Candidate B definition apply never decrypts record Markdown");
    assert_eq!(applied["valid"], true);
    let malformed_validation = fixture
        .provider
        .operation(
            fixture.collection_id,
            writer_token,
            "validate",
            Uuid::new_v4(),
            json!({}),
            None,
        )
        .await
        .expect_err("Candidate B malformed validation fails before WorkingSet decryption");
    assert_eq!(malformed_validation.code, "invalid_request");
    sqlx::query(
        "UPDATE hosted_provider_records SET payload_ciphertext = $3 WHERE collection_id = $1 AND record_id = $2",
    )
    .bind(fixture.collection_id)
    .bind(source_id)
    .bind(original_ciphertext)
    .execute(&fixture.pool)
    .await
    .unwrap();
    let project = fixture
        .provider
        .operation(
            fixture.collection_id,
            writer_token,
            "read_type",
            Uuid::new_v4(),
            json!({"name": "project"}),
            None,
        )
        .await
        .unwrap();
    assert_eq!(project["result"]["document"], project_type);
    assert!(complete_generation(fixture).await != previous_generation);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires MDBASE_PROJECTION_DATABASE_URL; run against a disposable PostgreSQL database"]
async fn candidate_b_projection_bytes_are_preflighted_before_json_transfer() {
    let database_url = std::env::var("MDBASE_PROJECTION_DATABASE_URL")
        .expect("MDBASE_PROJECTION_DATABASE_URL is required");
    let fixture = FileLifecycleFixture::new(&database_url).await;
    let replica = sqlx::query(
        "SELECT id, scope_epoch FROM hosted_provider_replicas WHERE collection_id = $1",
    )
    .bind(fixture.collection_id)
    .fetch_one(&fixture.pool)
    .await
    .unwrap();
    let replica_id: Uuid = replica.get("id");
    let scope_epoch = u64::try_from(replica.get::<i64, _>("scope_epoch")).unwrap();
    let mut oversized_projection_ids = Vec::new();
    for index in 0..65_u64 {
        let record_id = Uuid::now_v7();
        put(
            &fixture,
            replica_id,
            scope_epoch,
            record_id,
            None,
            &format!("budget/record-{index:03}.md"),
            &format!("---\ntitle: Budget {index}\n---\nBounded projection preflight.\n"),
        )
        .await;
        oversized_projection_ids.push(record_id);
    }
    let generation_id = complete_generation(&fixture).await;
    sqlx::query(
        r#"UPDATE hosted_provider_record_projections
           SET semantic_projection = '{}'::jsonb, projection_bytes = 262144
           WHERE collection_id = $1 AND generation_id = $2
             AND record_id = ANY($3::uuid[]) AND valid_to_sequence IS NULL"#,
    )
    .bind(fixture.collection_id)
    .bind(generation_id)
    .bind(&oversized_projection_ids)
    .execute(&fixture.pool)
    .await
    .unwrap();
    sqlx::query(
        r#"UPDATE hosted_provider_record_projections
           SET projection_digest = projection_observed_digest
           WHERE collection_id = $1 AND generation_id = $2
             AND record_id = ANY($3::uuid[]) AND valid_to_sequence IS NULL"#,
    )
    .bind(fixture.collection_id)
    .bind(generation_id)
    .bind(&oversized_projection_ids)
    .execute(&fixture.pool)
    .await
    .unwrap();

    let token = format!("candidate-b-budget-reader-{}", Uuid::new_v4());
    fixture
        .provider
        .register_replica(
            fixture.collection_id,
            RegisterReplica {
                replica_id: Uuid::now_v7(),
                name: "Candidate B budget reader".to_string(),
                purpose: ReplicaPurpose::Application,
                mode: SyncReplicaMode::ReadOnly,
                allowed_types: Vec::new(),
                contract_scope: Vec::new(),
                full_collection: true,
                allowed_operations: vec!["query".to_string()],
                operation_transport_protocol: Some(3),
                operation_transport_recovery_protocols: Vec::new(),
                file_capability: None,
                allowed_origin: None,
                proof_public_key: None,
                grant_id: Some(Uuid::now_v7()),
                application_declaration_id: None,
                application_declaration_digest: None,
                token: token.clone(),
                token_ttl_seconds: None,
            },
        )
        .await
        .unwrap();
    let error = fixture
        .provider
        .operation(
            fixture.collection_id,
            &token,
            "query",
            Uuid::new_v4(),
            json!({"limit": 100, "order_by": [{"field": "file.path"}]}),
            None,
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, "hosted_byte_budget_exceeded");
    assert_eq!(error.details.as_ref().unwrap()["budget"], "candidate_bytes");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires MDBASE_PROJECTION_DATABASE_URL; run against a disposable PostgreSQL database"]
async fn candidate_b_grouping_preflights_large_keys_before_database_aggregation() {
    let database_url = std::env::var("MDBASE_PROJECTION_DATABASE_URL")
        .expect("MDBASE_PROJECTION_DATABASE_URL is required");
    let fixture = FileLifecycleFixture::new(&database_url).await;
    let replica = sqlx::query(
        "SELECT id, scope_epoch FROM hosted_provider_replicas WHERE collection_id = $1",
    )
    .bind(fixture.collection_id)
    .fetch_one(&fixture.pool)
    .await
    .unwrap();
    let replica_id = replica.get("id");
    let scope_epoch = u64::try_from(replica.get::<i64, _>("scope_epoch")).unwrap();
    let token = format!("candidate-b-large-groups-{}", Uuid::new_v4());
    fixture
        .provider
        .register_replica(
            fixture.collection_id,
            RegisterReplica {
                replica_id: Uuid::now_v7(),
                name: "Candidate B large-group budget reader".to_string(),
                purpose: ReplicaPurpose::Application,
                mode: SyncReplicaMode::ReadWrite,
                allowed_types: Vec::new(),
                contract_scope: Vec::new(),
                full_collection: true,
                allowed_operations: vec!["create_type".to_string(), "query".to_string()],
                operation_transport_protocol: Some(3),
                operation_transport_recovery_protocols: Vec::new(),
                file_capability: None,
                allowed_origin: None,
                proof_public_key: None,
                grant_id: Some(Uuid::now_v7()),
                application_declaration_id: None,
                application_declaration_digest: None,
                token: token.clone(),
                token_ttl_seconds: None,
            },
        )
        .await
        .unwrap();
    fixture
        .provider
        .operation(
            fixture.collection_id,
            &token,
            "create_type",
            Uuid::new_v4(),
            json!({"document": r#"---
kind: mdbase.type
name: large_group
version: 1
match:
  path_glob: 'groups/*.md'
schema:
  dialect: json-schema-2020-12
  value:
    type: object
    required: [title]
    properties:
      title: {type: string}
---
"#}),
            None,
        )
        .await
        .unwrap();
    for index in 0..128_u64 {
        // Title is represented in persisted and effective frontmatter; keep
        // each complete projection below 256 KiB while the distinct retained
        // grouping keys collectively exceed the 8 MiB reducer budget.
        let title = format!("group-{index:03}-{}", "x".repeat(67_000));
        put(
            &fixture,
            replica_id,
            scope_epoch,
            Uuid::now_v7(),
            None,
            &format!("groups/large-{index:03}.md"),
            &format!("---\ntitle: {title}\n---\nLarge grouping key.\n"),
        )
        .await;
    }
    complete_generation(&fixture).await;
    let temp_bytes_before: i64 = sqlx::query_scalar(
        "SELECT temp_bytes FROM pg_stat_database WHERE datname = current_database()",
    )
    .fetch_one(&fixture.pool)
    .await
    .unwrap();
    let error = fixture
        .provider
        .operation(
            fixture.collection_id,
            &token,
            "query",
            Uuid::new_v4(),
            json!({
                "types": ["large_group"],
                "limit": 1,
                "group_by": [{"field": "record.title"}],
                "summaries": [
                    {"field": "record.title", "function": "count", "name": "records"}
                ],
                "order_by": [{"field": "file.path"}]
            }),
            None,
        )
        .await
        .unwrap_err();
    assert_eq!(
        error.code, "hosted_aggregation_state_budget_exceeded",
        "unexpected grouping failure: {error:?}"
    );
    assert_eq!(
        error.details.as_ref().unwrap()["budget"],
        "aggregation_state_bytes"
    );
    let temp_bytes_after: i64 = sqlx::query_scalar(
        "SELECT temp_bytes FROM pg_stat_database WHERE datname = current_database()",
    )
    .fetch_one(&fixture.pool)
    .await
    .unwrap();
    assert_eq!(
        temp_bytes_after, temp_bytes_before,
        "oversized grouping keys must be rejected before PostgreSQL spills aggregate state"
    );
}

async fn assert_projected_group_cancellation(fixture: &FileLifecycleFixture, token: &str) {
    let mut projected_group_lock = fixture.pool.begin().await.unwrap();
    sqlx::query("LOCK TABLE hosted_provider_record_projections IN ACCESS EXCLUSIVE MODE")
        .execute(&mut *projected_group_lock)
        .await
        .unwrap();
    let mut blocked = Vec::new();
    for _ in 0..2 {
        let provider = fixture.provider.clone();
        let blocked_token = token.to_string();
        let collection_id = fixture.collection_id;
        blocked.push(tokio::spawn(async move {
            provider
                .operation(
                    collection_id,
                    &blocked_token,
                    "query",
                    Uuid::new_v4(),
                    json!({
                        "where": "record.title == 'Source'",
                        "limit": 10,
                        "group_by": [{"field": "record.title"}],
                        "summaries": [
                            {"field": "record.title", "function": "count", "name": "records"}
                        ],
                        "order_by": [{"field": "file.path"}],
                    }),
                    None,
                )
                .await
        }));
    }
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            let activity = fixture.provider.hosted_query_activity();
            let blocked_sessions: i64 = sqlx::query_scalar(
                r#"SELECT count(*) FROM pg_stat_activity
                   WHERE datname = current_database() AND wait_event_type = 'Lock'
                     AND application_name LIKE 'mdbase-hosted-query/%'"#,
            )
            .fetch_one(&fixture.pool)
            .await
            .unwrap();
            if activity.active_queries == 2
                && activity.plaintext_scopes == 2
                && activity.active_scan_permits == 2
                && blocked_sessions == 2
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("the projected grouping query reaches its cancellable PostgreSQL wait");
    let point_started = Instant::now();
    let point = fixture
        .provider
        .operation(
            fixture.collection_id,
            token,
            "read",
            Uuid::new_v4(),
            json!({"path": "notes/source.md"}),
            None,
        )
        .await
        .expect("the reserved point-read pool remains available during two scans");
    assert_eq!(point["result"]["path"], "notes/source.md");
    assert!(
        point_started.elapsed() <= Duration::from_millis(250),
        "point-read p95 gate must remain possible while every scan lane is occupied"
    );
    for task in blocked {
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
    }
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            let activity = fixture.provider.hosted_query_activity();
            let retained_sessions: i64 = sqlx::query_scalar(
                r#"SELECT count(*) FROM pg_stat_activity
                   WHERE datname = current_database()
                     AND application_name LIKE 'mdbase-hosted-query/%'
                     AND (wait_event_type = 'Lock' OR state = 'idle in transaction')"#,
            )
            .fetch_one(&fixture.pool)
            .await
            .unwrap();
            if activity.active_queries == 0
                && activity.plaintext_scopes == 0
                && activity.active_scan_permits == 0
                && retained_sessions == 0
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("projected grouping cancellation releases transaction, session, permit, and plaintext");
    projected_group_lock.rollback().await.unwrap();

    let grouped_after_cancel = fixture
        .provider
        .operation(
            fixture.collection_id,
            token,
            "query",
            Uuid::new_v4(),
            json!({
                "where": "record.title == 'Source'",
                "limit": 10,
                "group_by": [{"field": "record.title"}],
                "summaries": [
                    {"field": "record.title", "function": "count", "name": "records"}
                ],
                "order_by": [{"field": "file.path"}],
            }),
            None,
        )
        .await
        .unwrap();
    assert_eq!(grouped_after_cancel["result"]["meta"]["total_count"], 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires MDBASE_PROJECTION_DATABASE_URL; run against a disposable PostgreSQL database"]
async fn candidate_b_obsidian_base_uses_persisted_backlink_graph() {
    let database_url = std::env::var("MDBASE_PROJECTION_DATABASE_URL")
        .expect("MDBASE_PROJECTION_DATABASE_URL is required");
    let fixture = FileLifecycleFixture::new(&database_url).await;
    fixture
        .enable_obsidian_base_pattern("views/**/*.base")
        .await;
    let replica = sqlx::query(
        "SELECT id, scope_epoch FROM hosted_provider_replicas WHERE collection_id = $1",
    )
    .bind(fixture.collection_id)
    .fetch_one(&fixture.pool)
    .await
    .unwrap();
    let replica_id: Uuid = replica.get("id");
    let scope_epoch = u64::try_from(replica.get::<i64, _>("scope_epoch")).unwrap();
    put(
        &fixture,
        replica_id,
        scope_epoch,
        Uuid::now_v7(),
        None,
        "projects/mobile.md",
        "---\ntitle: Mobile roadmap\n---\nProject notes\n",
    )
    .await;
    let mobile_task_id = Uuid::now_v7();
    let mobile_task = put(
        &fixture,
        replica_id,
        scope_epoch,
        mobile_task_id,
        None,
        "tasks/project-task.md",
        "---\nstatus: todo\ntags: [task]\nprojects: ['[[projects/mobile]]']\n---\nShip mobile\n",
    )
    .await;
    put(
        &fixture,
        replica_id,
        scope_epoch,
        Uuid::now_v7(),
        None,
        "projects/web.md",
        "---\ntitle: Web roadmap\n---\nProject notes\n",
    )
    .await;
    put(
        &fixture,
        replica_id,
        scope_epoch,
        Uuid::now_v7(),
        None,
        "tasks/web-task.md",
        "---\nstatus: todo\ntags: [task]\nprojects: ['[[projects/web]]']\n---\nShip web\n",
    )
    .await;
    let generation_id = complete_generation(&fixture).await;
    let relationship_before = sqlx::query(
        r#"SELECT valid_from_sequence, source_record_sequence
           FROM hosted_provider_record_relationships
           WHERE collection_id = $1 AND generation_id = $2
             AND source_record_id = $3 AND valid_to_sequence IS NULL"#,
    )
    .bind(fixture.collection_id)
    .bind(generation_id)
    .bind(mobile_task_id)
    .fetch_one(&fixture.pool)
    .await
    .unwrap();
    put(
        &fixture,
        replica_id,
        scope_epoch,
        mobile_task_id,
        Some(mobile_task.revision),
        "tasks/project-task.md",
        "---\nstatus: in-progress\ntags: [task]\nprojects: ['[[projects/mobile]]']\n---\nShip mobile with updated metadata\n",
    )
    .await;
    let relationship_after = sqlx::query(
        r#"SELECT valid_from_sequence, source_record_sequence
           FROM hosted_provider_record_relationships
           WHERE collection_id = $1 AND generation_id = $2
             AND source_record_id = $3 AND valid_to_sequence IS NULL"#,
    )
    .bind(fixture.collection_id)
    .bind(generation_id)
    .bind(mobile_task_id)
    .fetch_one(&fixture.pool)
    .await
    .unwrap();
    assert_eq!(
        relationship_after.get::<i64, _>("valid_from_sequence"),
        relationship_before.get::<i64, _>("valid_from_sequence")
    );
    assert_eq!(
        relationship_after.get::<i64, _>("source_record_sequence"),
        relationship_before.get::<i64, _>("source_record_sequence"),
        "unchanged structural edges are not rewritten"
    );

    let token = format!("candidate-b-base-{}-{}", Uuid::new_v4(), Uuid::new_v4());
    fixture
        .provider
        .register_replica(
            fixture.collection_id,
            RegisterReplica {
                replica_id: Uuid::now_v7(),
                name: "Candidate B TaskNotes Base mission".to_string(),
                purpose: ReplicaPurpose::Application,
                mode: SyncReplicaMode::ReadWrite,
                allowed_types: Vec::new(),
                contract_scope: Vec::new(),
                full_collection: true,
                allowed_operations: vec![
                    "create_view_source".to_string(),
                    "execute_view".to_string(),
                    "list_views".to_string(),
                    "query".to_string(),
                ],
                operation_transport_protocol: Some(3),
                operation_transport_recovery_protocols: Vec::new(),
                file_capability: None,
                allowed_origin: None,
                proof_public_key: None,
                grant_id: Some(Uuid::now_v7()),
                application_declaration_id: None,
                application_declaration_digest: None,
                token: token.clone(),
                token_ttl_seconds: None,
            },
        )
        .await
        .unwrap();
    let projects_base = r##"views:
  - type: tasknotesProjects
    name: Projects
    filters:
      and:
        - 'file.backlinks.filter((value.asFile().properties["status"].isEmpty() == false) && (value.asFile().properties["status"] != "done") && (list(value.asFile().properties["projects"]).map(file(value.replace(/^\[[^\]]+\]\((.*)\)$/, "$1").replace("[[", "").replace("]]", "").split("|")[0].split("#")[0].replace(/%20/g, " ")).asLink()).contains(file.asLink()))).length > 0'
    order: [file.name, file.folder]
    groupBy:
      property: file.folder
      direction: ASC
"##;
    let created = fixture
        .provider
        .operation(
            fixture.collection_id,
            &token,
            "create_view_source",
            Uuid::new_v4(),
            json!({"path": "views/projects.base", "document": projects_base}),
            None,
        )
        .await
        .unwrap();
    assert_eq!(created["valid"], true);
    let projects = fixture
        .provider
        .operation(
            fixture.collection_id,
            &token,
            "execute_view",
            Uuid::new_v4(),
            json!({
                "path": "views/projects.base",
                "view": "projects",
                "context": {"path": "projects/mobile.md"}
            }),
            None,
        )
        .await
        .unwrap();
    assert_eq!(projects["valid"], true);
    assert_eq!(projects["result"]["meta"]["total_count"], 2);
    assert_eq!(
        projects["result"]["results"][0]["path"],
        "projects/mobile.md"
    );

    sqlx::query(
        r#"UPDATE hosted_provider_record_projections
           SET semantic_complete = false
           WHERE collection_id = $1 AND valid_to_sequence IS NULL
             AND canonical_path = 'projects/mobile.md'"#,
    )
    .bind(fixture.collection_id)
    .execute(&fixture.pool)
    .await
    .unwrap();
    let stale_context_fallback = fixture
        .provider
        .operation(
            fixture.collection_id,
            &token,
            "execute_view",
            Uuid::new_v4(),
            json!({
                "path": "views/projects.base",
                "view": "projects",
                "context": {"path": "projects/mobile.md"}
            }),
            None,
        )
        .await
        .unwrap();
    assert_eq!(stale_context_fallback["valid"], true);
    assert_eq!(
        stale_context_fallback["result"]["results"][0]["path"],
        "projects/mobile.md"
    );
    sqlx::query(
        r#"UPDATE hosted_provider_record_projections
           SET semantic_complete = true
           WHERE collection_id = $1 AND valid_to_sequence IS NULL
             AND canonical_path = 'projects/mobile.md'"#,
    )
    .bind(fixture.collection_id)
    .execute(&fixture.pool)
    .await
    .unwrap();

    let relationship_fault_head: i64 =
        sqlx::query_scalar("SELECT head FROM hosted_provider_collections WHERE id = $1")
            .bind(fixture.collection_id)
            .fetch_one(&fixture.pool)
            .await
            .unwrap();
    let relationship_fault_sequence = relationship_fault_head + 1;
    sqlx::query(
        r#"INSERT INTO hosted_provider_record_versions
             (collection_id, record_id, sequence, revision, types,
              payload_ciphertext, deleted)
           VALUES ($1, $2, $3, 'fault:deleted-related', '{}', NULL, true)"#,
    )
    .bind(fixture.collection_id)
    .bind(mobile_task_id)
    .bind(relationship_fault_sequence)
    .execute(&fixture.pool)
    .await
    .unwrap();
    sqlx::query("UPDATE hosted_provider_collections SET head = $2 WHERE id = $1")
        .bind(fixture.collection_id)
        .bind(relationship_fault_sequence)
        .execute(&fixture.pool)
        .await
        .unwrap();
    let deleted_related = fixture
        .provider
        .operation(
            fixture.collection_id,
            &token,
            "execute_view",
            Uuid::new_v4(),
            json!({"path": "views/projects.base", "view": "projects"}),
            None,
        )
        .await
        .unwrap();
    assert_eq!(deleted_related["valid"], true);
    assert_eq!(deleted_related["result"]["meta"]["total_count"], 1);
    assert_eq!(
        deleted_related["result"]["results"][0]["path"],
        "projects/web.md"
    );
    sqlx::query(
        "DELETE FROM hosted_provider_record_versions
         WHERE collection_id = $1 AND record_id = $2 AND sequence = $3",
    )
    .bind(fixture.collection_id)
    .bind(mobile_task_id)
    .bind(relationship_fault_sequence)
    .execute(&fixture.pool)
    .await
    .unwrap();
    sqlx::query("UPDATE hosted_provider_collections SET head = $2 WHERE id = $1")
        .bind(fixture.collection_id)
        .bind(relationship_fault_head)
        .execute(&fixture.pool)
        .await
        .unwrap();

    sqlx::query(
        r#"UPDATE hosted_provider_record_projections
           SET semantic_complete = false
           WHERE collection_id = $1 AND valid_to_sequence IS NULL"#,
    )
    .bind(fixture.collection_id)
    .execute(&fixture.pool)
    .await
    .unwrap();
    let exact_fallback = fixture
        .provider
        .operation(
            fixture.collection_id,
            &token,
            "execute_view",
            Uuid::new_v4(),
            json!({"path": "views/projects.base", "view": "projects"}),
            None,
        )
        .await
        .unwrap();
    assert_eq!(exact_fallback["valid"], true);
    assert_eq!(exact_fallback["result"]["meta"]["total_count"], 2);
    assert_eq!(
        exact_fallback["result"]["results"][0]["path"],
        "projects/mobile.md"
    );

    sqlx::query(
        r#"UPDATE hosted_provider_collections
           SET active_projection_generation_id = NULL,
               active_catalog_revision = NULL,
               active_projection_format_version = NULL,
               active_semantic_engine_version = NULL
           WHERE id = $1"#,
    )
    .bind(fixture.collection_id)
    .execute(&fixture.pool)
    .await
    .unwrap();
    let absent_binding_fallback = fixture
        .provider
        .operation(
            fixture.collection_id,
            &token,
            "execute_view",
            Uuid::new_v4(),
            json!({
                "path": "views/projects.base",
                "view": "projects",
                "context": {"path": "projects/mobile.md"},
                "limit": 1
            }),
            None,
        )
        .await
        .unwrap();
    assert_eq!(absent_binding_fallback["valid"], true);
    assert_eq!(absent_binding_fallback["result"]["meta"]["has_more"], true);
    assert_eq!(
        absent_binding_fallback["result"]["meta"]["groups"][0]["count"],
        2
    );
    assert_eq!(
        absent_binding_fallback["result"]["results"][0]["path"],
        "projects/mobile.md"
    );
    let cursor = absent_binding_fallback["result"]["meta"]["cursor"]
        .as_str()
        .unwrap();
    let absent_binding_page_two = fixture
        .provider
        .operation(
            fixture.collection_id,
            &token,
            "execute_view",
            Uuid::new_v4(),
            json!({
                "path": "views/projects.base",
                "view": "projects",
                "context": {"path": "projects/mobile.md"},
                "limit": 1,
                "cursor": cursor
            }),
            None,
        )
        .await
        .unwrap();
    assert_eq!(absent_binding_page_two["valid"], true);
    assert_eq!(
        absent_binding_page_two["result"]["meta"]["groups"][0]["count"],
        2
    );
    assert_eq!(
        absent_binding_page_two["result"]["results"][0]["path"],
        "projects/web.md"
    );

    let exact_page_one_request_id = Uuid::new_v4();
    let exact_page_one_input = json!({
        "where": "file.folder == 'projects'",
        "include_body": true,
        "limit": 1,
        "order_by": [{"field": "file.path", "direction": "asc"}]
    });
    let exact_query_page_one = fixture
        .provider
        .operation(
            fixture.collection_id,
            &token,
            "query",
            exact_page_one_request_id,
            exact_page_one_input.clone(),
            None,
        )
        .await
        .unwrap();
    assert_eq!(exact_query_page_one["valid"], true);
    assert_eq!(exact_query_page_one["result"]["meta"]["total_count"], 2);
    assert_eq!(exact_query_page_one["result"]["meta"]["has_more"], true);
    assert!(exact_query_page_one["result"]["results"][0]["body"].is_string());
    let replayed_page_one = fixture
        .provider
        .operation(
            fixture.collection_id,
            &token,
            "query",
            exact_page_one_request_id,
            exact_page_one_input,
            None,
        )
        .await
        .unwrap();
    assert_eq!(replayed_page_one, exact_query_page_one);
    let conflicting_page_one = fixture
        .provider
        .operation(
            fixture.collection_id,
            &token,
            "query",
            exact_page_one_request_id,
            json!({
                "where": "file.folder == 'projects'",
                "include_body": true,
                "limit": 2,
                "order_by": [{"field": "file.path", "direction": "asc"}]
            }),
            None,
        )
        .await
        .unwrap_err();
    assert_eq!(conflicting_page_one.code, "query_request_id_conflict");
    let exact_query_cursor = exact_query_page_one["result"]["meta"]["cursor"]
        .as_str()
        .unwrap();
    let exact_query_generation: Option<Uuid> = sqlx::query_scalar(
        "SELECT generation_id FROM hosted_provider_query_cursors
         WHERE collection_id = $1 AND request_kind = 'query'",
    )
    .bind(fixture.collection_id)
    .fetch_one(&fixture.pool)
    .await
    .unwrap();
    assert!(exact_query_generation.is_none());
    let exact_page_two_request_id = Uuid::new_v4();
    let exact_page_two_input = json!({
        "where": "file.folder == 'projects'",
        "include_body": true,
        "limit": 1,
        "order_by": [{"field": "file.path", "direction": "asc"}],
        "cursor": exact_query_cursor
    });
    let exact_query_page_two = fixture
        .provider
        .operation(
            fixture.collection_id,
            &token,
            "query",
            exact_page_two_request_id,
            exact_page_two_input.clone(),
            None,
        )
        .await
        .unwrap();
    assert_eq!(exact_query_page_two["valid"], true);
    assert_eq!(exact_query_page_two["result"]["meta"]["has_more"], false);
    assert!(exact_query_page_two["result"]["meta"]["cursor"].is_null());
    let replayed_page_two = fixture
        .provider
        .operation(
            fixture.collection_id,
            &token,
            "query",
            exact_page_two_request_id,
            exact_page_two_input,
            None,
        )
        .await
        .unwrap();
    assert_eq!(replayed_page_two, exact_query_page_two);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires MDBASE_PROJECTION_DATABASE_URL; run against a disposable PostgreSQL database"]
async fn candidate_b_base_candidate_prunes_over_scan_budget() {
    let database_url = std::env::var("MDBASE_PROJECTION_DATABASE_URL")
        .expect("MDBASE_PROJECTION_DATABASE_URL is required");
    candidate_b_base_candidate_prunes_fixture(&database_url, 10_001, false).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires MDBASE_PROJECTION_DATABASE_URL; run against a disposable PostgreSQL database"]
async fn candidate_b_base_paginates_10k_projected_rows() {
    let database_url = std::env::var("MDBASE_PROJECTION_DATABASE_URL")
        .expect("MDBASE_PROJECTION_DATABASE_URL is required");
    candidate_b_base_candidate_prunes_fixture(&database_url, 9_999, false).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires MDBASE_PROJECTION_DATABASE_URL; run against a disposable PostgreSQL database"]
async fn candidate_b_base_candidate_prunes_100k_live_rows() {
    let database_url = std::env::var("MDBASE_PROJECTION_DATABASE_URL")
        .expect("MDBASE_PROJECTION_DATABASE_URL is required");
    candidate_b_base_candidate_prunes_fixture(&database_url, 99_999, false).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires MDBASE_PROJECTION_DATABASE_URL; run against a disposable PostgreSQL database"]
async fn candidate_b_base_preflights_1000_large_projections_before_payload_transfer() {
    let database_url = std::env::var("MDBASE_PROJECTION_DATABASE_URL")
        .expect("MDBASE_PROJECTION_DATABASE_URL is required");
    candidate_b_base_candidate_prunes_fixture(&database_url, 1_000, true).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires MDBASE_PROJECTION_DATABASE_URL; run against a disposable PostgreSQL database"]
async fn candidate_b_exact_projected_filter_pages_over_10k() {
    let database_url = std::env::var("MDBASE_PROJECTION_DATABASE_URL")
        .expect("MDBASE_PROJECTION_DATABASE_URL is required");
    candidate_b_exact_projected_filter_fixture(&database_url, 10_001, 1_000).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires MDBASE_PROJECTION_DATABASE_URL; run against a disposable PostgreSQL database"]
async fn candidate_b_exact_projected_filter_and_group_100k() {
    let database_url = std::env::var("MDBASE_PROJECTION_DATABASE_URL")
        .expect("MDBASE_PROJECTION_DATABASE_URL is required");
    candidate_b_exact_projected_filter_fixture(&database_url, 99_997, 200).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires MDBASE_PROJECTION_DATABASE_URL; run against a disposable PostgreSQL database"]
async fn candidate_b_exact_projected_filter_and_group_230k() {
    let database_url = std::env::var("MDBASE_PROJECTION_DATABASE_URL")
        .expect("MDBASE_PROJECTION_DATABASE_URL is required");
    candidate_b_exact_projected_filter_fixture(&database_url, 230_128, 200).await;
}

async fn candidate_b_exact_projected_filter_fixture(
    database_url: &str,
    decoy_count: i64,
    page_size: u64,
) {
    if decoy_count > 100_000 {
        assert_eq!(
            std::env::var("MDBASE_HOSTED_EXECUTION_TEST_ENTITLEMENT").as_deref(),
            Ok("large_fixture_v1"),
            "fixtures above the default scan budget require the explicit test entitlement"
        );
    }
    let fixture = FileLifecycleFixture::new(database_url).await;
    let token = format!("candidate-b-filter-{}-{}", Uuid::new_v4(), Uuid::new_v4());
    fixture
        .provider
        .register_replica(
            fixture.collection_id,
            RegisterReplica {
                replica_id: Uuid::now_v7(),
                name: "Candidate B exact projected filter mission".to_string(),
                purpose: ReplicaPurpose::Application,
                mode: SyncReplicaMode::ReadWrite,
                allowed_types: Vec::new(),
                contract_scope: Vec::new(),
                full_collection: true,
                allowed_operations: vec![
                    "create_type".to_string(),
                    "query".to_string(),
                    "read".to_string(),
                ],
                operation_transport_protocol: Some(3),
                operation_transport_recovery_protocols: Vec::new(),
                file_capability: None,
                allowed_origin: None,
                proof_public_key: None,
                grant_id: Some(Uuid::now_v7()),
                application_declaration_id: None,
                application_declaration_digest: None,
                token: token.clone(),
                token_ttl_seconds: None,
            },
        )
        .await
        .unwrap();
    let type_document = "---\nkind: mdbase.type\nname: task\nversion: 1\nmatch:\n  path_glob: 'tasks/*.md'\nschema:\n  dialect: json-schema-2020-12\n  value:\n    type: object\n    required: [status, archived]\n    properties:\n      status: {type: string}\n      archived: {type: boolean}\n---\n";
    fixture
        .provider
        .operation(
            fixture.collection_id,
            &token,
            "create_type",
            Uuid::new_v4(),
            json!({"document": type_document}),
            None,
        )
        .await
        .unwrap();
    let replica = sqlx::query(
        "SELECT id, scope_epoch FROM hosted_provider_replicas WHERE collection_id = $1 AND purpose = 'mirror'",
    )
    .bind(fixture.collection_id)
    .fetch_one(&fixture.pool)
    .await
    .unwrap();
    let replica_id: Uuid = replica.get("id");
    let scope_epoch = u64::try_from(replica.get::<i64, _>("scope_epoch")).unwrap();
    for (path, status, archived) in [
        ("tasks/open-a.md", "open", false),
        ("tasks/open-b.md", "open", false),
        ("tasks/closed.md", "closed", false),
    ] {
        put(
            &fixture,
            replica_id,
            scope_epoch,
            Uuid::now_v7(),
            None,
            path,
            &format!("---\nstatus: {status}\narchived: {archived}\n---\nBody for {path}\n"),
        )
        .await;
    }
    let generation_id = complete_generation(&fixture).await;
    let exact_page = fixture
        .provider
        .operation(
            fixture.collection_id,
            &token,
            "query",
            Uuid::new_v4(),
            json!({
                "types": ["task"],
                "where": "record.status == 'open' && record.archived == false",
                "include_body": true,
                "order_by": [{"field": "file.path"}],
                "limit": 1,
                "pagination": "cursor"
            }),
            None,
        )
        .await
        .unwrap();
    assert_eq!(exact_page["result"]["meta"]["total_count"], 2);
    assert!(exact_page["result"]["results"][0]["body"].is_string());
    assert!(exact_page["result"]["meta"]["cursor"].is_string());
    let released = fixture
        .provider
        .operation(
            fixture.collection_id,
            &token,
            "query",
            Uuid::new_v4(),
            json!({
                "release_cursor": exact_page["result"]["meta"]["cursor"]
                    .as_str()
                    .unwrap()
            }),
            None,
        )
        .await
        .unwrap();
    assert_eq!(released["valid"], true);

    let original_projection: serde_json::Value = sqlx::query_scalar(
        r#"SELECT semantic_projection FROM hosted_provider_record_projections
           WHERE collection_id = $1 AND generation_id = $2
             AND canonical_path = 'tasks/open-a.md' AND valid_to_sequence IS NULL"#,
    )
    .bind(fixture.collection_id)
    .bind(generation_id)
    .fetch_one(&fixture.pool)
    .await
    .unwrap();
    sqlx::query(
        r#"UPDATE hosted_provider_record_projections
           SET semantic_projection = jsonb_set(
             semantic_projection, '{effective_frontmatter,archived}', '"invalid"'::jsonb, true)
           WHERE collection_id = $1 AND generation_id = $2
             AND canonical_path = 'tasks/open-a.md' AND valid_to_sequence IS NULL"#,
    )
    .bind(fixture.collection_id)
    .bind(generation_id)
    .execute(&fixture.pool)
    .await
    .unwrap();
    let fail_closed = fixture
        .provider
        .operation(
            fixture.collection_id,
            &token,
            "query",
            Uuid::new_v4(),
            json!({
                "types": ["task"],
                "where": "record.status == 'open' && record.archived == false",
                "order_by": [{"field": "file.path"}],
                "limit": 10
            }),
            None,
        )
        .await
        .unwrap();
    assert_eq!(fail_closed["result"]["meta"]["total_count"], 2);
    sqlx::query(
        r#"UPDATE hosted_provider_record_projections SET semantic_projection = $3
           WHERE collection_id = $1 AND generation_id = $2
             AND canonical_path = 'tasks/open-a.md' AND valid_to_sequence IS NULL"#,
    )
    .bind(fixture.collection_id)
    .bind(generation_id)
    .bind(original_projection)
    .execute(&fixture.pool)
    .await
    .unwrap();

    let inserted = sqlx::query(
        r#"WITH trusted_projection_write AS MATERIALIZED (
             SELECT set_config('mdbase.projection_digest_write', 'on', true)
           ), template AS (
             SELECT projection.* FROM hosted_provider_record_projections AS projection
             CROSS JOIN trusted_projection_write
             WHERE collection_id = $1 AND generation_id = $2
               AND canonical_path = 'tasks/open-a.md'
           ), decoys AS (
             SELECT g, format('tasks/scale-%s.md', g) AS path,
                    timestamptz '2025-01-01 00:00:00+00'
                      + ((g % 86400) * interval '1 second') AS synthetic_mtime,
                    t.*
             FROM template t CROSS JOIN generate_series(1, $3::bigint) AS g
           )
           INSERT INTO hosted_provider_record_projections
             (collection_id, record_id, record_sequence, valid_from_sequence,
              record_revision, catalog_revision, projection_format_version,
              semantic_engine_version, generation_id, canonical_path, matched_types,
              file_size_bytes, file_modified_at, semantic_complete, resolution_complete,
              semantic_projection, projection_digest, structural_digest, projection_bytes)
           SELECT collection_id, md5('exact-filter-decoy-' || g::text)::uuid,
                  record_sequence, valid_from_sequence, 'filter-decoy:' || g::text,
                  catalog_revision, projection_format_version, semantic_engine_version,
                  generation_id, path, matched_types, file_size_bytes, synthetic_mtime,
                  true, true,
                  jsonb_set(
                    semantic_projection,
                    '{file,mtime}',
                    to_jsonb(to_char(
                      synthetic_mtime AT TIME ZONE 'UTC',
                      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')),
                    true),
                  decode(repeat('00', 32), 'hex'),
                  decode(repeat('07', 32), 'hex'), projection_bytes
           FROM decoys"#,
    )
    .bind(fixture.collection_id)
    .bind(generation_id)
    .bind(decoy_count)
    .execute(&fixture.pool)
    .await
    .unwrap()
    .rows_affected();
    assert_eq!(inserted, u64::try_from(decoy_count).unwrap());
    sqlx::query(
        r#"UPDATE hosted_provider_collections
           SET record_count = record_count + $2
           WHERE id = $1"#,
    )
    .bind(fixture.collection_id)
    .bind(decoy_count)
    .execute(&fixture.pool)
    .await
    .unwrap();
    sqlx::query(
        r#"INSERT INTO hosted_provider_record_versions
             (collection_id, record_id, sequence, revision, types, payload_ciphertext,
              deleted, created_at)
           SELECT collection_id, record_id, record_sequence, record_revision,
                  matched_types, NULL, false, file_modified_at
           FROM hosted_provider_record_projections
           WHERE collection_id = $1 AND generation_id = $2
             AND canonical_path LIKE 'tasks/scale-%'"#,
    )
    .bind(fixture.collection_id)
    .bind(generation_id)
    .execute(&fixture.pool)
    .await
    .unwrap();
    sqlx::query("ANALYZE hosted_provider_record_versions, hosted_provider_record_projections")
        .execute(&fixture.pool)
        .await
        .unwrap();
    // The synthetic bulk loader above stands in for one transactional import.
    // Production rebuild completion and ordinary writes advance this proof in
    // their own transaction; keep the timing sample focused on query work.
    sqlx::query(
        r#"UPDATE hosted_provider_projection_generations
           SET integrity_verified_epoch = integrity_epoch
           WHERE collection_id = $1 AND generation_id = $2"#,
    )
    .bind(fixture.collection_id)
    .bind(generation_id)
    .execute(&fixture.pool)
    .await
    .unwrap();
    if decoy_count > 100_000 && !cfg!(debug_assertions) {
        let scan_budget = fixture
            .provider
            .operation(
                fixture.collection_id,
                &token,
                "query",
                Uuid::new_v4(),
                json!({
                    "types": ["task"],
                    "group_by": [{"field": "record.status"}],
                    "summaries": [
                        {"field": "record.status", "function": "count", "name": "records"}
                    ],
                    "limit": 1000
                }),
                None,
            )
            .await
            .expect_err("production builds retain the default 100k scan ceiling");
        assert_eq!(scan_budget.code, "hosted_scan_budget_exceeded");
        assert_eq!(
            scan_budget.details.as_ref().unwrap()["budget"],
            "scanned_records"
        );
        assert_eq!(scan_budget.details.as_ref().unwrap()["limit"], 100_000);
        assert_eq!(
            scan_budget.details.as_ref().unwrap()["observed"],
            decoy_count + 3
        );
        eprintln!(
            "candidate_b_typed_budget_outcome decoys={decoy_count} code={} budget={} limit={} observed={}",
            scan_budget.code,
            scan_budget.details.as_ref().unwrap()["budget"],
            scan_budget.details.as_ref().unwrap()["limit"],
            scan_budget.details.as_ref().unwrap()["observed"]
        );
        return;
    }
    if decoy_count >= 99_997 {
        assert_high_cardinality_query_cancellation(&fixture, &token).await;
    }
    let default_repetitions = if decoy_count > 100_000 { 5 } else { 7 };
    let repetitions = std::env::var("MDBASE_PERF_REPETITIONS")
        .ok()
        .and_then(|value| value.parse::<u32>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(default_repetitions);
    let ordering_budget = fixture
        .provider
        .operation(
            fixture.collection_id,
            &token,
            "query",
            Uuid::new_v4(),
            json!({
                "types": ["task"],
                "order_by": [{"field": "record.status", "direction": "asc"}],
                "limit": page_size,
                "pagination": "cursor"
            }),
            None,
        )
        .await
        .unwrap_err();
    assert_eq!(ordering_budget.code, "hosted_ordering_budget_exceeded");
    assert_eq!(
        ordering_budget.details.as_ref().unwrap()["budget"],
        "top_k_entries"
    );
    let mut path_page_one_ms = Vec::with_capacity(repetitions as usize);
    let mut path_page_two_ms = Vec::with_capacity(repetitions as usize);
    let mut path_page_ten_ms = Vec::with_capacity(repetitions as usize);
    let mut mtime_page_one_ms = Vec::with_capacity(repetitions as usize);
    let mut mtime_page_two_ms = Vec::with_capacity(repetitions as usize);
    let mut group_ms = Vec::with_capacity(repetitions as usize);
    for repetition in 1..=repetitions {
        let projected_started = Instant::now();
        let projected_page = fixture
            .provider
            .operation(
                fixture.collection_id,
                &token,
                "query",
                Uuid::new_v4(),
                json!({
                    "types": ["task"],
                    "where": "record.status == 'open' && record.archived == false",
                    "limit": page_size,
                    "pagination": "cursor"
                }),
                None,
            )
            .await
            .unwrap();
        let projected_elapsed = projected_started.elapsed();
        path_page_one_ms.push(duration_ms(projected_elapsed));
        eprintln!(
            "candidate_b_exact_filter_page decoys={decoy_count} page=1 repetition={repetition} elapsed_ms={}",
            projected_elapsed.as_millis()
        );
        assert!(projected_elapsed < Duration::from_secs(15));
        if decoy_count + 3 > 10_000 {
            assert!(projected_page["result"]["meta"]["total_count"].is_null());
            assert_eq!(
                projected_page["result"]["meta"]["total_count_outcome"]["status"],
                "deferred"
            );
        } else {
            assert_eq!(
                projected_page["result"]["meta"]["total_count"],
                decoy_count + 2
            );
        }
        assert_eq!(
            projected_page["result"]["results"]
                .as_array()
                .unwrap()
                .len(),
            usize::try_from(page_size).unwrap()
        );
        assert!(projected_page["result"]["meta"]["cursor"].is_string());
        let mut projected_cursor = projected_page["result"]["meta"]["cursor"]
            .as_str()
            .unwrap()
            .to_string();
        for page_number in 2..=10 {
            let page_started = Instant::now();
            let page = fixture
                .provider
                .operation(
                    fixture.collection_id,
                    &token,
                    "query",
                    Uuid::new_v4(),
                    json!({
                        "types": ["task"],
                        "where": "record.status == 'open' && record.archived == false",
                        "limit": page_size,
                        "pagination": "cursor",
                        "cursor": projected_cursor
                    }),
                    None,
                )
                .await
                .unwrap();
            let page_elapsed = page_started.elapsed();
            if page_number == 2 {
                path_page_two_ms.push(duration_ms(page_elapsed));
            } else if page_number == 10 {
                path_page_ten_ms.push(duration_ms(page_elapsed));
            }
            if matches!(page_number, 2 | 10) {
                eprintln!(
                    "candidate_b_exact_filter_page decoys={decoy_count} page={page_number} repetition={repetition} elapsed_ms={}",
                    page_elapsed.as_millis()
                );
            }
            assert_eq!(
                page["result"]["results"].as_array().unwrap().len(),
                usize::try_from(page_size).unwrap()
            );
            projected_cursor = page["result"]["meta"]["cursor"]
                .as_str()
                .unwrap()
                .to_string();
        }
        let released = fixture
            .provider
            .operation(
                fixture.collection_id,
                &token,
                "query",
                Uuid::new_v4(),
                json!({"release_cursor": projected_cursor}),
                None,
            )
            .await
            .unwrap();
        assert_eq!(released["valid"], true);

        let mtime_started = Instant::now();
        let mtime_page = fixture
            .provider
            .operation(
                fixture.collection_id,
                &token,
                "query",
                Uuid::new_v4(),
                json!({
                    "types": ["task"],
                    "order_by": [{"field": "file.mtime", "direction": "desc"}],
                    "limit": page_size,
                    "pagination": "cursor"
                }),
                None,
            )
            .await
            .unwrap();
        let mtime_elapsed = mtime_started.elapsed();
        mtime_page_one_ms.push(duration_ms(mtime_elapsed));
        eprintln!(
            "candidate_b_mtime_page decoys={decoy_count} repetition={repetition} elapsed_ms={}",
            mtime_elapsed.as_millis()
        );
        assert_eq!(
            mtime_page["result"]["results"].as_array().unwrap().len(),
            usize::try_from(page_size).unwrap()
        );
        let mtime_cursor = mtime_page["result"]["meta"]["cursor"]
            .as_str()
            .expect("the broad mtime page has a continuation cursor")
            .to_string();
        let mtime_page_two_started = Instant::now();
        let mtime_page_two = fixture
            .provider
            .operation(
                fixture.collection_id,
                &token,
                "query",
                Uuid::new_v4(),
                json!({
                    "types": ["task"],
                    "order_by": [{"field": "file.mtime", "direction": "desc"}],
                    "limit": page_size,
                    "pagination": "cursor",
                    "cursor": mtime_cursor
                }),
                None,
            )
            .await
            .unwrap();
        let mtime_page_two_elapsed = mtime_page_two_started.elapsed();
        mtime_page_two_ms.push(duration_ms(mtime_page_two_elapsed));
        eprintln!(
            "candidate_b_mtime_page decoys={decoy_count} page=2 repetition={repetition} elapsed_ms={}",
            mtime_page_two_elapsed.as_millis()
        );
        assert_eq!(
            mtime_page_two["result"]["results"]
                .as_array()
                .unwrap()
                .len(),
            usize::try_from(page_size).unwrap()
        );
        let mtime_cursor = mtime_page_two["result"]["meta"]["cursor"]
            .as_str()
            .expect("the second broad mtime page has a continuation cursor");
        let released = fixture
            .provider
            .operation(
                fixture.collection_id,
                &token,
                "query",
                Uuid::new_v4(),
                json!({"release_cursor": mtime_cursor}),
                None,
            )
            .await
            .unwrap();
        assert_eq!(released["valid"], true);
    }
    let retained_cursors: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM hosted_provider_query_cursors WHERE collection_id = $1",
    )
    .bind(fixture.collection_id)
    .fetch_one(&fixture.pool)
    .await
    .unwrap();
    assert_eq!(
        retained_cursors, 0,
        "the sustained page mission releases every abandoned cursor"
    );
    if decoy_count > 100_000 {
        let group_budget = fixture
            .provider
            .operation(
                fixture.collection_id,
                &token,
                "query",
                Uuid::new_v4(),
                json!({
                    "types": ["task"],
                    "group_by": [{"field": "record.status"}],
                    "summaries": [
                        {"field": "record.status", "function": "count", "name": "records"}
                    ],
                    "limit": 1000
                }),
                None,
            )
            .await
            .expect_err("the entitled 230k grouping retains its database work-state fence");
        assert_eq!(
            group_budget.code,
            "hosted_aggregation_state_budget_exceeded"
        );
        assert_eq!(
            group_budget.details.as_ref().unwrap()["budget"],
            "aggregation_state_bytes"
        );
        eprintln!(
            "candidate_b_typed_group_budget_outcome decoys={decoy_count} code={} budget={}",
            group_budget.code,
            group_budget.details.as_ref().unwrap()["budget"]
        );
        let p95_gate_ms = 300;
        for (name, samples) in [
            ("path_page_1", path_page_one_ms),
            ("path_page_2", path_page_two_ms),
            ("path_page_10", path_page_ten_ms),
            ("mtime_page_1", mtime_page_one_ms),
            ("mtime_page_2", mtime_page_two_ms),
        ] {
            report_latency_distribution(name, decoy_count, &samples, p95_gate_ms);
        }
        return;
    }
    for repetition in 1..=repetitions {
        let grouped_started = Instant::now();
        let grouped = fixture
            .provider
            .operation(
                fixture.collection_id,
                &token,
                "query",
                Uuid::new_v4(),
                json!({
                    "types": ["task"],
                    "group_by": [{"field": "record.status"}],
                    "summaries": [
                        {"field": "record.status", "function": "count", "name": "records"}
                    ],
                    "limit": 1000
                }),
                None,
            )
            .await
            .unwrap();
        let grouped_elapsed = grouped_started.elapsed();
        group_ms.push(duration_ms(grouped_elapsed));
        eprintln!(
            "candidate_b_group_count decoys={decoy_count} repetition={repetition} elapsed_ms={}",
            grouped_elapsed.as_millis()
        );
        assert!(grouped_elapsed < Duration::from_secs(15));
        assert_eq!(grouped["result"]["meta"]["total_count"], decoy_count + 3);
        let groups = grouped["result"]["meta"]["groups"].as_array().unwrap();
        assert_eq!(groups.len(), 2);
        assert!(groups.iter().any(|group| {
            group["values"]["record.status"] == "open"
                && group["count"] == decoy_count + 2
                && group["summaries"]["records"] == decoy_count + 2
        }));
        assert!(groups.iter().any(|group| {
            group["values"]["record.status"] == "closed"
                && group["count"] == 1
                && group["summaries"]["records"] == 1
        }));
        if let Some(cursor) = grouped["result"]["meta"]["cursor"].as_str() {
            let released = fixture
                .provider
                .operation(
                    fixture.collection_id,
                    &token,
                    "query",
                    Uuid::new_v4(),
                    json!({"release_cursor": cursor}),
                    None,
                )
                .await
                .unwrap();
            assert_eq!(released["valid"], true);
        }
        if repetition == repetitions {
            eprintln!(
                "candidate_b_exact_filter_samples_complete decoys={decoy_count} repetitions={repetitions}"
            );
        }
    }
    let retained_cursors: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM hosted_provider_query_cursors WHERE collection_id = $1",
    )
    .bind(fixture.collection_id)
    .fetch_one(&fixture.pool)
    .await
    .unwrap();
    assert_eq!(
        retained_cursors, 0,
        "the sustained grouping mission releases every abandoned cursor"
    );
    let p95_gate_ms = 300;
    for (name, samples) in [
        ("path_page_1", path_page_one_ms),
        ("path_page_2", path_page_two_ms),
        ("path_page_10", path_page_ten_ms),
        ("mtime_page_1", mtime_page_one_ms),
        ("mtime_page_2", mtime_page_two_ms),
        ("group", group_ms),
    ] {
        report_latency_distribution(name, decoy_count, &samples, p95_gate_ms);
        if repetitions >= 20 {
            assert!(
                percentile(&samples, 95) <= p95_gate_ms,
                "{name} p95 exceeded the published page latency gate"
            );
        }
    }
    if decoy_count == 99_997 {
        assert_short_key_group_cardinality_budget(&fixture, &token, generation_id).await;
    }
}

async fn assert_short_key_group_cardinality_budget(
    fixture: &FileLifecycleFixture,
    token: &str,
    generation_id: Uuid,
) {
    let temp_bytes_before: i64 = sqlx::query_scalar(
        "SELECT temp_bytes FROM pg_stat_database WHERE datname = current_database()",
    )
    .fetch_one(&fixture.pool)
    .await
    .unwrap();
    let updated = sqlx::query(
        r#"WITH selected AS (
             SELECT ctid
             FROM hosted_provider_record_projections
             WHERE collection_id = $1 AND generation_id = $2
               AND canonical_path LIKE 'tasks/scale-%'
             ORDER BY record_id
             LIMIT 2500
           ), rewritten AS (
             SELECT p.ctid,
                    jsonb_set(
                      p.semantic_projection,
                      '{effective_frontmatter,status}',
                      to_jsonb(p.canonical_path), true
                    ) AS semantic_projection
             FROM hosted_provider_record_projections p
             JOIN selected ON selected.ctid = p.ctid
           )
           UPDATE hosted_provider_record_projections p
           SET semantic_projection = rewritten.semantic_projection,
               projection_bytes = octet_length(rewritten.semantic_projection::text)
           FROM rewritten
           WHERE p.ctid = rewritten.ctid"#,
    )
    .bind(fixture.collection_id)
    .bind(generation_id)
    .execute(&fixture.pool)
    .await
    .unwrap()
    .rows_affected();
    assert_eq!(updated, 2500);
    sqlx::query(
        r#"UPDATE hosted_provider_record_projections
           SET projection_digest = projection_observed_digest
           WHERE collection_id = $1 AND generation_id = $2
             AND semantic_projection #>> '{effective_frontmatter,status}'
                   LIKE 'tasks/scale-%'
           "#,
    )
    .bind(fixture.collection_id)
    .bind(generation_id)
    .execute(&fixture.pool)
    .await
    .unwrap();
    sqlx::query(
        r#"UPDATE hosted_provider_projection_generations
           SET integrity_verified_epoch = integrity_epoch
           WHERE collection_id = $1 AND generation_id = $2"#,
    )
    .bind(fixture.collection_id)
    .bind(generation_id)
    .execute(&fixture.pool)
    .await
    .unwrap();
    let error = fixture
        .provider
        .operation(
            fixture.collection_id,
            token,
            "query",
            Uuid::new_v4(),
            json!({
                "types": ["task"],
                "group_by": [{"field": "record.status"}],
                "summaries": [
                    {"field": "record.status", "function": "count", "name": "records"}
                ],
                "limit": 1000
            }),
            None,
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, "hosted_group_budget_exceeded");
    assert_eq!(error.details.as_ref().unwrap()["budget"], "groups");
    assert_eq!(error.details.as_ref().unwrap()["limit"], 2_000);
    assert_eq!(error.details.as_ref().unwrap()["observed"], 2_001);
    let temp_bytes_after: i64 = sqlx::query_scalar(
        "SELECT temp_bytes FROM pg_stat_database WHERE datname = current_database()",
    )
    .fetch_one(&fixture.pool)
    .await
    .unwrap();
    let temp_bytes_delta = temp_bytes_after.saturating_sub(temp_bytes_before);
    assert!(
        temp_bytes_delta <= 3 * 32 * 1024 * 1024,
        "three bounded PostgreSQL executor lanes must not spill above their configured limits"
    );
    eprintln!(
        "candidate_b_group_cardinality_budget at_least_distinct_groups=2501 outcome={} observed=2001 postgres_temp_bytes_delta={temp_bytes_delta}",
        error.code
    );
}

fn duration_ms(duration: Duration) -> u64 {
    u64::try_from(duration.as_millis()).unwrap_or(u64::MAX)
}

fn percentile(samples: &[u64], percentile: usize) -> u64 {
    assert!(!samples.is_empty());
    assert!((1..=100).contains(&percentile));
    let mut sorted = samples.to_vec();
    sorted.sort_unstable();
    let rank = sorted.len().saturating_mul(percentile).div_ceil(100);
    sorted[rank.saturating_sub(1)]
}

fn report_latency_distribution(name: &str, decoys: i64, samples: &[u64], gate_ms: u64) {
    let total = samples.iter().copied().sum::<u64>();
    eprintln!(
        "candidate_b_latency_distribution decoys={decoys} workload={name} samples={} min_ms={} p50_ms={} p95_ms={} p99_ms={} max_ms={} mean_ms={} gate_p95_ms={gate_ms} raw_ms={samples:?}",
        samples.len(),
        percentile(samples, 1),
        percentile(samples, 50),
        percentile(samples, 95),
        percentile(samples, 99),
        percentile(samples, 100),
        total / u64::try_from(samples.len()).unwrap()
    );
}

async fn assert_high_cardinality_query_cancellation(fixture: &FileLifecycleFixture, token: &str) {
    let initial = fixture.provider.hosted_query_activity();
    assert_eq!(initial.active_queries, 0);
    assert_eq!(initial.plaintext_scopes, 0);
    assert_eq!(initial.active_scan_permits, 0);
    assert_eq!(initial.accounted_execution_bytes, 0);

    let provider = fixture.provider.clone();
    let collection_id = fixture.collection_id;
    let query_token = token.to_string();
    let mut query = tokio::spawn(async move {
        provider
            .operation(
                collection_id,
                &query_token,
                "query",
                Uuid::new_v4(),
                json!({
                    "types": ["task"],
                    "group_by": [{"field": "record.status"}],
                    "summaries": [
                        {"field": "record.status", "function": "count", "name": "records"}
                    ],
                    "limit": 1000
                }),
                None,
            )
            .await
    });
    let observation = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let activity = fixture.provider.hosted_query_activity();
            let backend_pid: Option<i32> = sqlx::query_scalar(
                r#"SELECT pid
                   FROM pg_stat_activity
                   WHERE datname = current_database()
                     AND application_name LIKE 'mdbase-hosted-query/%'
                     AND state = 'active'
                     AND query LIKE '%hosted_provider_record_projections%'
                   ORDER BY query_start
                   LIMIT 1"#,
            )
            .fetch_optional(&fixture.pool)
            .await
            .unwrap();
            if let Some(backend_pid) = backend_pid.filter(|_| {
                activity.active_queries == 1
                    && activity.plaintext_scopes == 1
                    && activity.active_scan_permits == 1
                    && activity.accounted_execution_bytes > 0
                    && activity.query_pool_connections > activity.query_pool_idle_connections
            }) {
                break backend_pid;
            }
            tokio::task::yield_now().await;
        }
    });
    let backend_pid = tokio::select! {
        observed = observation => observed
            .expect("the high-cardinality query reaches an active PostgreSQL scan"),
        completed = &mut query => panic!(
            "the high-cardinality query completed before cancellation observation: {completed:?}"
        ),
    };

    query.abort();
    assert!(query.await.unwrap_err().is_cancelled());
    let cleanup_started = Instant::now();
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let activity = fixture.provider.hosted_query_activity();
            let unsafe_session_count: i64 = sqlx::query_scalar(
                r#"SELECT count(*)
                   FROM pg_stat_activity
                   WHERE pid = $1
                     AND (state <> 'idle' OR xact_start IS NOT NULL)"#,
            )
            .bind(backend_pid)
            .fetch_one(&fixture.pool)
            .await
            .unwrap();
            if activity.active_queries == 0
                && activity.plaintext_scopes == 0
                && activity.active_scan_permits == 0
                && activity.accounted_execution_bytes == 0
                && activity.query_pool_connections == activity.query_pool_idle_connections
                && unsafe_session_count == 0
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect(
        "high-cardinality cancellation releases transaction, session, pool, permit, and plaintext",
    );
    assert!(cleanup_started.elapsed() <= Duration::from_secs(5));

    let point = fixture
        .provider
        .operation(
            fixture.collection_id,
            token,
            "read",
            Uuid::new_v4(),
            json!({"path": "tasks/open-a.md"}),
            None,
        )
        .await
        .expect("the exact point-read lane remains usable after scan cancellation");
    assert_eq!(point["result"]["path"], "tasks/open-a.md");
    let grouped = fixture
        .provider
        .operation(
            fixture.collection_id,
            token,
            "query",
            Uuid::new_v4(),
            json!({
                "types": ["task"],
                "where": "record.status == 'closed'",
                "group_by": [{"field": "record.status"}],
                "summaries": [
                    {"field": "record.status", "function": "count", "name": "records"}
                ],
                "limit": 10
            }),
            None,
        )
        .await
        .expect("the query lane is reusable after cancellation");
    assert_eq!(grouped["result"]["meta"]["total_count"], 1);
    if let Some(cursor) = grouped["result"]["meta"]["cursor"].as_str() {
        fixture
            .provider
            .operation(
                fixture.collection_id,
                token,
                "query",
                Uuid::new_v4(),
                json!({"release_cursor": cursor}),
                None,
            )
            .await
            .unwrap();
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires MDBASE_PROJECTION_DATABASE_URL; run against a disposable PostgreSQL database"]
async fn candidate_b_rebuild_batch_bounds_a_100k_version_ledger() {
    let database_url = std::env::var("MDBASE_PROJECTION_DATABASE_URL")
        .expect("MDBASE_PROJECTION_DATABASE_URL is required");
    let fixture = FileLifecycleFixture::new(&database_url).await;
    let head: i64 =
        sqlx::query_scalar("SELECT head FROM hosted_provider_collections WHERE id = $1")
            .bind(fixture.collection_id)
            .fetch_one(&fixture.pool)
            .await
            .unwrap();
    let ledger_sequence = head + 1;
    let inserted = sqlx::query(
        r#"INSERT INTO hosted_provider_record_versions
             (collection_id, record_id, sequence, revision, types,
              payload_ciphertext, deleted)
           SELECT $1, md5('rebuild-ledger-' || g::text)::uuid, $2,
                  'deleted:' || g::text, '{}'::text[], NULL, true
           FROM generate_series(1, 100001::bigint) AS g"#,
    )
    .bind(fixture.collection_id)
    .bind(ledger_sequence)
    .execute(&fixture.pool)
    .await
    .unwrap()
    .rows_affected();
    assert_eq!(inserted, 100_001);
    sqlx::query("UPDATE hosted_provider_collections SET head = $2 WHERE id = $1")
        .bind(fixture.collection_id)
        .bind(ledger_sequence)
        .execute(&fixture.pool)
        .await
        .unwrap();

    let generation = fixture
        .provider
        .start_projection_generation(fixture.collection_id)
        .await
        .unwrap();
    let started = std::time::Instant::now();
    let batch = fixture
        .provider
        .project_generation_batch(fixture.collection_id, generation.generation_id, 200)
        .await
        .unwrap();
    assert!(started.elapsed() < Duration::from_secs(15));
    assert!(batch.records_projected <= 200);
    assert_eq!(batch.generation.phase, "projection");
    let checkpoint: Option<Uuid> = sqlx::query_scalar(
        r#"SELECT checkpoint_record_id
           FROM hosted_provider_projection_generations
           WHERE collection_id = $1 AND generation_id = $2"#,
    )
    .bind(fixture.collection_id)
    .bind(generation.generation_id)
    .fetch_one(&fixture.pool)
    .await
    .unwrap();
    assert!(checkpoint.is_some());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires MDBASE_PROJECTION_DATABASE_URL; run against a disposable PostgreSQL database"]
async fn candidate_b_relationship_revalidation_preflights_plaintext_bytes() {
    let database_url = std::env::var("MDBASE_PROJECTION_DATABASE_URL")
        .expect("MDBASE_PROJECTION_DATABASE_URL is required");
    let fixture = FileLifecycleFixture::new(&database_url).await;
    let replica = sqlx::query(
        "SELECT id, scope_epoch FROM hosted_provider_replicas WHERE collection_id = $1",
    )
    .bind(fixture.collection_id)
    .fetch_one(&fixture.pool)
    .await
    .unwrap();
    let replica_id: Uuid = replica.get("id");
    let scope_epoch = u64::try_from(replica.get::<i64, _>("scope_epoch")).unwrap();
    let target_id = Uuid::now_v7();
    let source_id = Uuid::now_v7();
    let target = put(
        &fixture,
        replica_id,
        scope_epoch,
        target_id,
        None,
        "notes/target.md",
        "---\ntitle: Target\n---\nTarget prose\n",
    )
    .await;
    put(
        &fixture,
        replica_id,
        scope_epoch,
        source_id,
        None,
        "notes/source.md",
        "---\ntitle: Source\n---\nSee [[target]].\n",
    )
    .await;
    complete_generation(&fixture).await;

    // Corrupting the large value as well as its metadata makes the ordering
    // observable: a correct metadata preflight returns the typed byte budget
    // without fetching or attempting to decrypt the TOAST payload.
    sqlx::query(
        r#"UPDATE hosted_provider_records
           SET content_bytes = $3, payload_ciphertext = '\x00'
           WHERE collection_id = $1 AND record_id = $2"#,
    )
    .bind(fixture.collection_id)
    .bind(source_id)
    .bind(33_i64 * 1024 * 1024)
    .execute(&fixture.pool)
    .await
    .unwrap();
    let error = fixture
        .provider
        .mutate(
            fixture.collection_id,
            &fixture.token,
            SyncMutation {
                mutation_id: Uuid::new_v4(),
                replica_id,
                scope_epoch,
                operation: SyncMutationOperation::Move,
                record_id: target_id,
                base_revision: Some(target.revision),
                path: Some("notes/renamed.md".to_string()),
                document: None,
                created_at: chrono::Utc::now().to_rfc3339(),
                causal_predecessor: None,
            },
            None,
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, "hosted_execution_budget_exceeded");
    assert_eq!(
        error.details.as_ref().unwrap()["budget_kind"],
        "relationship_revalidation_bytes"
    );
    let target_path: String = sqlx::query_scalar(
        r#"SELECT canonical_path FROM hosted_provider_record_projections
           WHERE collection_id = $1 AND record_id = $2 AND valid_to_sequence IS NULL"#,
    )
    .bind(fixture.collection_id)
    .bind(target_id)
    .fetch_one(&fixture.pool)
    .await
    .unwrap();
    assert_eq!(target_path, "notes/target.md");
}

async fn candidate_b_base_candidate_prunes_fixture(
    database_url: &str,
    decoy_count: i64,
    large_projection_pressure: bool,
) {
    if decoy_count > 100_000 {
        assert_eq!(
            std::env::var("MDBASE_HOSTED_EXECUTION_TEST_ENTITLEMENT").as_deref(),
            Ok("large_fixture_v1"),
            "fixtures above the default scan budget require the explicit test entitlement"
        );
    }
    let fixture = FileLifecycleFixture::new(database_url).await;
    fixture
        .enable_obsidian_base_pattern("views/**/*.base")
        .await;
    let replica = sqlx::query(
        "SELECT id, scope_epoch FROM hosted_provider_replicas WHERE collection_id = $1",
    )
    .bind(fixture.collection_id)
    .fetch_one(&fixture.pool)
    .await
    .unwrap();
    let selected_id = Uuid::now_v7();
    put(
        &fixture,
        replica.get("id"),
        u64::try_from(replica.get::<i64, _>("scope_epoch")).unwrap(),
        selected_id,
        None,
        "tasks/selected.md",
        "---\nstatus: todo\ntags: [task/subtag]\n---\nSelected task\n",
    )
    .await;
    let generation_id = complete_generation(&fixture).await;

    // These rows form a synthetic live version ledger plus matching complete
    // projections, without allocating 10,001 encrypted payloads. They prove
    // the SQL candidate plan prunes before the 10,000-row transfer ceiling.
    let inserted = sqlx::query(
        r#"WITH trusted_projection_write AS MATERIALIZED (
             SELECT set_config('mdbase.projection_digest_write', 'on', true)
           ), template AS (
             SELECT projection.* FROM hosted_provider_record_projections AS projection
             CROSS JOIN trusted_projection_write
             WHERE collection_id = $1 AND generation_id = $2
             ORDER BY record_id LIMIT 1
           ), decoys AS (
             SELECT g,
                    format('decoys/%s.md', g) AS path,
                    jsonb_set(
                      jsonb_set(t.semantic_projection,
                        '{effective_frontmatter,tags}', '[]'::jsonb, true),
                      '{structure,body_tags}', '[]'::jsonb, true
                    ) AS projection,
                    t.*
             FROM template t CROSS JOIN generate_series(1, $3::bigint) AS g
           )
           INSERT INTO hosted_provider_record_projections
             (collection_id, record_id, record_sequence, valid_from_sequence,
              record_revision, catalog_revision, projection_format_version,
              semantic_engine_version, generation_id, canonical_path, matched_types,
              file_size_bytes, semantic_complete, resolution_complete,
              semantic_projection, projection_digest, structural_digest,
              projection_bytes)
           SELECT collection_id, md5('candidate-decoy-' || g::text)::uuid,
                  record_sequence, valid_from_sequence,
                  'decoy:' || g::text, catalog_revision, projection_format_version,
                  semantic_engine_version, generation_id, path, '{}'::text[], 0,
                  true, true, projection, decode(repeat('00', 32), 'hex'),
                  decode(repeat('01', 32), 'hex'), 0
           FROM decoys"#,
    )
    .bind(fixture.collection_id)
    .bind(generation_id)
    .bind(decoy_count)
    .execute(&fixture.pool)
    .await
    .unwrap()
    .rows_affected();
    assert_eq!(inserted, u64::try_from(decoy_count).unwrap());
    sqlx::query(
        r#"UPDATE hosted_provider_record_projections
           SET semantic_projection = jsonb_set(
                 jsonb_set(
                   jsonb_set(
                     jsonb_set(
                       jsonb_set(
                         jsonb_set(semantic_projection,
                           '{path}', to_jsonb(canonical_path), true),
                         '{file,path}', to_jsonb(canonical_path), true),
                       '{file,name}',
                       to_jsonb(regexp_replace(canonical_path, '^.*/', '')), true),
                     '{file,basename}',
                     to_jsonb(regexp_replace(
                       regexp_replace(canonical_path, '^.*/', ''), '\.md$', '')), true),
                   '{resolution_keys}', jsonb_build_array(
                     jsonb_build_object('kind', 'path', 'value', canonical_path),
                     jsonb_build_object(
                       'kind', 'basename',
                       'value', regexp_replace(
                         regexp_replace(canonical_path, '^.*/', ''), '\.md$', '')
                     )
                   ), true),
                 '{structure}', jsonb_build_object(
                   'schema_version', 'mdbase-record-structure-v3',
                   'path', canonical_path,
                   'structural_digest', 'sha256:' || encode(sha256(convert_to(
                     '{"body_embeds":[],"body_links":[],"body_tags":[],"occurrences":[],"path":"'
                       || canonical_path ||
                     '","schema_version":"mdbase-record-structure-v3","structural_digest":""}',
                     'UTF8')), 'hex'),
                   'occurrences', '[]'::jsonb,
                   'body_tags', '[]'::jsonb,
                   'body_links', '[]'::jsonb,
                   'body_embeds', '[]'::jsonb
                 ), true)
           WHERE collection_id = $1 AND generation_id = $2
             AND canonical_path LIKE 'decoys/%'"#,
    )
    .bind(fixture.collection_id)
    .bind(generation_id)
    .execute(&fixture.pool)
    .await
    .unwrap();
    sqlx::query(
        r#"UPDATE hosted_provider_record_projections
           SET projection_digest = projection_observed_digest
           WHERE collection_id = $1 AND generation_id = $2
             AND canonical_path LIKE 'decoys/%'"#,
    )
    .bind(fixture.collection_id)
    .bind(generation_id)
    .execute(&fixture.pool)
    .await
    .unwrap();
    let inserted_versions = sqlx::query(
        r#"INSERT INTO hosted_provider_record_versions
             (collection_id, record_id, sequence, revision, types,
              payload_ciphertext, deleted)
           SELECT collection_id, record_id, record_sequence, record_revision,
                  matched_types, NULL, false
           FROM hosted_provider_record_projections
           WHERE collection_id = $1 AND generation_id = $2
             AND canonical_path LIKE 'decoys/%'"#,
    )
    .bind(fixture.collection_id)
    .bind(generation_id)
    .execute(&fixture.pool)
    .await
    .unwrap()
    .rows_affected();
    assert_eq!(inserted_versions, u64::try_from(decoy_count).unwrap());
    sqlx::query(
        r#"UPDATE hosted_provider_collections
           SET record_count = record_count + $2
           WHERE id = $1"#,
    )
    .bind(fixture.collection_id)
    .bind(decoy_count)
    .execute(&fixture.pool)
    .await
    .unwrap();

    // A candidate-matching projection with no live authority version must not
    // leak into results even when its semantic JSON is otherwise complete.
    let orphan_inserted = sqlx::query(
        r#"WITH template AS (
             SELECT * FROM hosted_provider_record_projections
             WHERE collection_id = $1 AND generation_id = $2
             ORDER BY record_id LIMIT 1
           )
           INSERT INTO hosted_provider_record_projections
             (collection_id, record_id, record_sequence, valid_from_sequence,
              record_revision, catalog_revision, projection_format_version,
              semantic_engine_version, generation_id, canonical_path, matched_types,
              file_size_bytes, semantic_complete, resolution_complete,
              semantic_projection, projection_digest, structural_digest,
              projection_bytes)
           SELECT collection_id, md5('candidate-orphan')::uuid,
                  record_sequence, valid_from_sequence, 'orphan:1',
                  catalog_revision, projection_format_version,
                  semantic_engine_version, generation_id, 'tasks/orphan.md',
                  matched_types, 0, true, true,
                  jsonb_set(semantic_projection,
                    '{effective_frontmatter,tags}', '["task/subtag"]'::jsonb, true),
                  decode(repeat('02', 32), 'hex'),
                  decode(repeat('03', 32), 'hex'), 0
           FROM template"#,
    )
    .bind(fixture.collection_id)
    .bind(generation_id)
    .execute(&fixture.pool)
    .await
    .unwrap()
    .rows_affected();
    assert_eq!(orphan_inserted, 1);
    sqlx::query(
        r#"UPDATE hosted_provider_record_projections
           SET projection_digest = projection_observed_digest
           WHERE collection_id = $1 AND generation_id = $2
             AND canonical_path = 'tasks/orphan.md'"#,
    )
    .bind(fixture.collection_id)
    .bind(generation_id)
    .execute(&fixture.pool)
    .await
    .unwrap();
    sqlx::query("ANALYZE hosted_provider_record_versions, hosted_provider_record_projections")
        .execute(&fixture.pool)
        .await
        .unwrap();

    let token = format!("candidate-b-scale-{}-{}", Uuid::new_v4(), Uuid::new_v4());
    fixture
        .provider
        .register_replica(
            fixture.collection_id,
            RegisterReplica {
                replica_id: Uuid::now_v7(),
                name: "Candidate B Base candidate scale mission".to_string(),
                purpose: ReplicaPurpose::Application,
                mode: SyncReplicaMode::ReadWrite,
                allowed_types: Vec::new(),
                contract_scope: Vec::new(),
                full_collection: true,
                allowed_operations: vec![
                    "query".to_string(),
                    "create_view_source".to_string(),
                    "execute_view".to_string(),
                ],
                operation_transport_protocol: Some(3),
                operation_transport_recovery_protocols: Vec::new(),
                file_capability: None,
                allowed_origin: None,
                proof_public_key: None,
                grant_id: Some(Uuid::now_v7()),
                application_declaration_id: None,
                application_declaration_digest: None,
                token: token.clone(),
                token_ttl_seconds: None,
            },
        )
        .await
        .unwrap();
    let source = r##"views:
  - type: table
    name: Tasks
    filters:
      and:
        - 'file.hasTag("#task")'
    order: [file.name]
  - type: table
    name: All
    order: [file.name]
  - type: table
    name: Created
    sort:
      - property: file.ctime
        direction: ASC
"##;
    fixture
        .provider
        .operation(
            fixture.collection_id,
            &token,
            "create_view_source",
            Uuid::new_v4(),
            json!({"path": "views/tasks.base", "document": source}),
            None,
        )
        .await
        .unwrap();
    for view in ["tasks", "all"] {
        let oversized_offset = fixture
            .provider
            .operation(
                fixture.collection_id,
                &token,
                "execute_view",
                Uuid::new_v4(),
                json!({
                    "path": "views/tasks.base",
                    "view": view,
                    "offset": 10_001,
                }),
                None,
            )
            .await
            .unwrap();
        assert_eq!(oversized_offset["valid"], false);
        assert_eq!(
            oversized_offset["diagnostics"][0]["code"],
            "hosted_offset_budget_exceeded"
        );
    }
    let ctime = fixture
        .provider
        .operation(
            fixture.collection_id,
            &token,
            "execute_view",
            Uuid::new_v4(),
            json!({"path": "views/tasks.base", "view": "created"}),
            None,
        )
        .await
        .unwrap();
    assert_eq!(ctime["valid"], false);
    assert_eq!(
        ctime["diagnostics"][0]["code"],
        "hosted_base_file_ctime_unavailable"
    );
    let invalid_cursor_count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM hosted_provider_query_cursors WHERE collection_id = $1",
    )
    .bind(fixture.collection_id)
    .fetch_one(&fixture.pool)
    .await
    .unwrap();
    assert_eq!(invalid_cursor_count, 0);
    let result = fixture
        .provider
        .operation(
            fixture.collection_id,
            &token,
            "execute_view",
            Uuid::new_v4(),
            json!({"path": "views/tasks.base", "view": "tasks"}),
            None,
        )
        .await
        .unwrap();
    assert_eq!(result["valid"], true);
    assert_eq!(result["result"]["meta"]["total_count"], 1);
    assert_eq!(result["result"]["results"][0]["path"], "tasks/selected.md");

    if large_projection_pressure {
        sqlx::query(
            r#"UPDATE hosted_provider_record_projections
               SET semantic_projection = jsonb_set(
                     semantic_projection,
                     '{effective_frontmatter,provider_budget_padding}',
                     to_jsonb(repeat('x', 245000)), true),
                   projection_bytes = 250000
               WHERE collection_id = $1 AND generation_id = $2
                 AND canonical_path LIKE 'decoys/%'"#,
        )
        .bind(fixture.collection_id)
        .bind(generation_id)
        .execute(&fixture.pool)
        .await
        .unwrap();
        sqlx::query(
            r#"UPDATE hosted_provider_record_projections
               SET projection_digest = projection_observed_digest
               WHERE collection_id = $1 AND generation_id = $2
                 AND canonical_path LIKE 'decoys/%'"#,
        )
        .bind(fixture.collection_id)
        .bind(generation_id)
        .execute(&fixture.pool)
        .await
        .unwrap();
        let error = fixture
            .provider
            .operation(
                fixture.collection_id,
                &token,
                "execute_view",
                Uuid::new_v4(),
                json!({"path": "views/tasks.base", "view": "all", "limit": 1000}),
                None,
            )
            .await
            .unwrap_err();
        assert_eq!(error.code, "hosted_byte_budget_exceeded");
        assert_eq!(error.details.as_ref().unwrap()["budget"], "candidate_bytes");
        return;
    }

    let broad_base = fixture
        .provider
        .operation(
            fixture.collection_id,
            &token,
            "execute_view",
            Uuid::new_v4(),
            json!({"path": "views/tasks.base", "view": "all", "limit": 200}),
            None,
        )
        .await;
    {
        let first = broad_base.unwrap();
        assert_eq!(first["result"]["meta"]["total_count"], decoy_count + 1);
        assert_eq!(first["result"]["results"].as_array().unwrap().len(), 200);
        let verify_complete_traversal = decoy_count == 9_999;
        let mut observed_paths = first["result"]["results"]
            .as_array()
            .unwrap()
            .iter()
            .map(|row| row["path"].as_str().unwrap().to_string())
            .collect::<Vec<_>>();
        let mut cursor = first["result"]["meta"]["cursor"]
            .as_str()
            .unwrap()
            .to_string();
        let mut page_number = 2;
        loop {
            let started = Instant::now();
            let page = fixture
                .provider
                .operation(
                    fixture.collection_id,
                    &token,
                    "execute_view",
                    Uuid::new_v4(),
                    json!({
                        "path": "views/tasks.base",
                        "view": "all",
                        "limit": 200,
                        "cursor": cursor
                    }),
                    None,
                )
                .await
                .unwrap();
            if matches!(page_number, 2 | 10) {
                eprintln!(
                    "candidate_b_base_broad_page decoys={decoy_count} page={page_number} elapsed_ms={}",
                    started.elapsed().as_millis()
                );
            }
            assert_eq!(page["result"]["results"].as_array().unwrap().len(), 200);
            observed_paths.extend(
                page["result"]["results"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|row| row["path"].as_str().unwrap().to_string()),
            );
            let Some(next_cursor) = page["result"]["meta"]["cursor"].as_str() else {
                break;
            };
            cursor = next_cursor.to_string();
            if !verify_complete_traversal && page_number == 10 {
                break;
            }
            page_number += 1;
        }
        if verify_complete_traversal {
            let mut expected_paths = (1..=decoy_count)
                .map(|index| format!("decoys/{index}.md"))
                .chain(std::iter::once("tasks/selected.md".to_string()))
                .collect::<Vec<_>>();
            expected_paths.sort();
            assert_eq!(observed_paths, expected_paths);
        }
    }

    sqlx::query(
        r#"UPDATE hosted_provider_record_projections
           SET semantic_complete = false
           WHERE collection_id = $1 AND generation_id = $2
             AND record_id = $3
             AND valid_to_sequence IS NULL"#,
    )
    .bind(fixture.collection_id)
    .bind(generation_id)
    .bind(selected_id)
    .execute(&fixture.pool)
    .await
    .unwrap();
    let stale_union = fixture
        .provider
        .operation(
            fixture.collection_id,
            &token,
            "execute_view",
            Uuid::new_v4(),
            json!({"path": "views/tasks.base", "view": "tasks"}),
            None,
        )
        .await
        .unwrap();
    assert_eq!(stale_union["valid"], true);
    assert_eq!(stale_union["result"]["meta"]["total_count"], 1);
    assert_eq!(
        stale_union["result"]["results"][0]["path"],
        "tasks/selected.md"
    );

    let deleted_sequence: i64 = sqlx::query_scalar::<_, i64>(
        "SELECT head + 1 FROM hosted_provider_collections WHERE id = $1",
    )
    .bind(fixture.collection_id)
    .fetch_one(&fixture.pool)
    .await
    .unwrap();
    sqlx::query(
        r#"INSERT INTO hosted_provider_record_versions
             (collection_id, record_id, sequence, revision, types,
              payload_ciphertext, deleted)
           VALUES ($1, $2, $3, 'fault:deleted-context', '{}', NULL, true)"#,
    )
    .bind(fixture.collection_id)
    .bind(selected_id)
    .bind(deleted_sequence)
    .execute(&fixture.pool)
    .await
    .unwrap();
    sqlx::query("UPDATE hosted_provider_collections SET head = $2 WHERE id = $1")
        .bind(fixture.collection_id)
        .bind(deleted_sequence)
        .execute(&fixture.pool)
        .await
        .unwrap();
    let deleted_context = fixture
        .provider
        .operation(
            fixture.collection_id,
            &token,
            "execute_view",
            Uuid::new_v4(),
            json!({
                "path": "views/tasks.base",
                "view": "tasks",
                "context": {"path": "tasks/selected.md"}
            }),
            None,
        )
        .await
        .unwrap_err();
    assert_eq!(deleted_context.code, "hosted_base_context_unavailable");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires MDBASE_PROJECTION_DATABASE_URL; run against a disposable PostgreSQL database"]
async fn candidate_b_persisted_body_relationships_exclude_label_prose() {
    let database_url = std::env::var("MDBASE_PROJECTION_DATABASE_URL")
        .expect("MDBASE_PROJECTION_DATABASE_URL is required");
    let fixture = FileLifecycleFixture::new(&database_url).await;
    let replica = sqlx::query(
        "SELECT id, scope_epoch FROM hosted_provider_replicas WHERE collection_id = $1",
    )
    .bind(fixture.collection_id)
    .fetch_one(&fixture.pool)
    .await
    .unwrap();
    let record_id = Uuid::now_v7();
    put(
        &fixture,
        replica.get("id"),
        u64::try_from(replica.get::<i64, _>("scope_epoch")).unwrap(),
        record_id,
        None,
        "notes/private.md",
        "---\ntitle: Safe frontmatter\n---\n[[targets/one|wikilink-label-secret]] [markdown-label-secret](targets/two.md \"destination-title-secret\")\n",
    )
    .await;
    complete_generation(&fixture).await;

    let row = sqlx::query(
        r#"SELECT projection_format_version, semantic_projection::text AS projection
           FROM hosted_provider_record_projections
           WHERE collection_id = $1 AND record_id = $2
             AND valid_to_sequence IS NULL"#,
    )
    .bind(fixture.collection_id)
    .bind(record_id)
    .fetch_one(&fixture.pool)
    .await
    .unwrap();
    assert_eq!(row.get::<i32, _>("projection_format_version"), 5);
    let projection = row.get::<String, _>("projection");
    for secret in [
        "wikilink-label-secret",
        "markdown-label-secret",
        "destination-title-secret",
    ] {
        assert!(!projection.contains(secret), "projection leaked {secret}");
    }

    let relationships = sqlx::query(
        r#"SELECT raw_target, normalized_target, alias
           FROM hosted_provider_record_relationships
           WHERE collection_id = $1 AND source_record_id = $2
             AND valid_to_sequence IS NULL
           ORDER BY raw_target COLLATE "C""#,
    )
    .bind(fixture.collection_id)
    .bind(record_id)
    .fetch_all(&fixture.pool)
    .await
    .unwrap();
    assert_eq!(relationships.len(), 2);
    assert!(relationships
        .iter()
        .all(|row| row.get::<Option<String>, _>("alias").is_none()));
    assert_eq!(
        relationships
            .iter()
            .map(|row| row.get::<String, _>("normalized_target"))
            .collect::<Vec<_>>(),
        ["targets/one", "targets/two.md"]
    );
}

async fn register_query_application(
    fixture: &FileLifecycleFixture,
    allowed_types: Vec<String>,
) -> (Uuid, String) {
    let replica_id = Uuid::now_v7();
    let token = format!("candidate-b-query-application-{}", Uuid::new_v4());
    let full_collection = allowed_types.is_empty();
    fixture
        .provider
        .register_replica(
            fixture.collection_id,
            RegisterReplica {
                replica_id,
                name: "Candidate B query application".to_string(),
                purpose: ReplicaPurpose::Application,
                mode: SyncReplicaMode::ReadOnly,
                allowed_types,
                contract_scope: Vec::new(),
                full_collection,
                allowed_operations: vec!["query".to_string()],
                operation_transport_protocol: Some(3),
                operation_transport_recovery_protocols: Vec::new(),
                file_capability: None,
                allowed_origin: None,
                proof_public_key: None,
                grant_id: Some(Uuid::now_v7()),
                application_declaration_id: None,
                application_declaration_digest: None,
                token: token.clone(),
                token_ttl_seconds: None,
            },
        )
        .await
        .unwrap();
    (replica_id, token)
}

async fn complete_generation(fixture: &FileLifecycleFixture) -> Uuid {
    let generation = fixture
        .provider
        .start_projection_generation(fixture.collection_id)
        .await
        .unwrap();
    loop {
        let batch = fixture
            .provider
            .project_generation_batch(fixture.collection_id, generation.generation_id, 200)
            .await
            .unwrap();
        if batch.generation.phase == "resolution" {
            break;
        }
    }
    loop {
        let batch = fixture
            .provider
            .resolve_generation_batch(fixture.collection_id, generation.generation_id, 200)
            .await
            .unwrap();
        if batch.generation.status == "complete" {
            return generation.generation_id;
        }
    }
}

async fn assert_pre_0040_rollback_preflight(
    fixture: &FileLifecycleFixture,
    expected_blocked: bool,
) {
    let blocked: bool = sqlx::query_scalar(
        r#"SELECT EXISTS (
             SELECT 1
             FROM hosted_provider_query_cursors
             WHERE request_kind = 'obsidian_base'
               AND base_invocation_id IS NOT NULL
               AND expires_at > now()
               AND hard_expires_at > now()
           )"#,
    )
    .fetch_one(&fixture.pool)
    .await
    .unwrap();
    assert_eq!(blocked, expected_blocked);
}

async fn put(
    fixture: &FileLifecycleFixture,
    replica_id: Uuid,
    scope_epoch: u64,
    record_id: Uuid,
    base_revision: Option<String>,
    path: &str,
    document: &str,
) -> mdbase_connect_protocol::SyncRecord {
    let receipt = fixture
        .provider
        .mutate(
            fixture.collection_id,
            &fixture.token,
            SyncMutation {
                mutation_id: Uuid::new_v4(),
                replica_id,
                scope_epoch,
                operation: SyncMutationOperation::Put,
                record_id,
                base_revision,
                path: Some(path.to_string()),
                document: Some(document.to_string()),
                created_at: chrono::Utc::now().to_rfc3339(),
                causal_predecessor: None,
            },
            None,
        )
        .await
        .unwrap();
    match receipt {
        SyncMutationReceipt::Applied {
            record: Some(record),
            ..
        } => record,
        other => panic!("put was not applied: {other:?}"),
    }
}

async fn delete(
    fixture: &FileLifecycleFixture,
    replica_id: Uuid,
    scope_epoch: u64,
    record_id: Uuid,
    revision: String,
) -> i64 {
    let receipt = fixture
        .provider
        .mutate(
            fixture.collection_id,
            &fixture.token,
            SyncMutation {
                mutation_id: Uuid::new_v4(),
                replica_id,
                scope_epoch,
                operation: SyncMutationOperation::Delete,
                record_id,
                base_revision: Some(revision),
                path: None,
                document: None,
                created_at: chrono::Utc::now().to_rfc3339(),
                causal_predecessor: None,
            },
            None,
        )
        .await
        .unwrap();
    match receipt {
        SyncMutationReceipt::Applied { sequence, .. } => i64::try_from(sequence).unwrap(),
        other => panic!("delete was not applied: {other:?}"),
    }
}
