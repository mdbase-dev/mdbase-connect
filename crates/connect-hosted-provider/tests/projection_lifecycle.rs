#![allow(dead_code, unused_imports)]

mod support;

use chrono::{DateTime, SecondsFormat, Utc};
use mdbase_connect_hosted_provider::{RegisterReplica, ReplicaPurpose};
use mdbase_connect_protocol::{
    SyncMutation, SyncMutationOperation, SyncMutationReceipt, SyncReplicaMode,
};
use serde_json::json;
use sha2::{Digest, Sha256};
use sqlx::Row;
use std::time::{Duration, Instant};
use support::FileLifecycleFixture;
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

    sqlx::migrate!("./migrations").run(&pool).await.unwrap();
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
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires MDBASE_PROJECTION_DATABASE_URL; run against a disposable PostgreSQL database"]
async fn candidate_b_projection_lifecycle_is_snapshot_safe_and_write_through() {
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
    put(
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
    complete_generation(&fixture).await;

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
    candidate_b_base_candidate_prunes_fixture(&database_url, 10_001).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires MDBASE_PROJECTION_DATABASE_URL; run against a disposable PostgreSQL database"]
async fn candidate_b_base_candidate_prunes_100k_live_rows() {
    let database_url = std::env::var("MDBASE_PROJECTION_DATABASE_URL")
        .expect("MDBASE_PROJECTION_DATABASE_URL is required");
    candidate_b_base_candidate_prunes_fixture(&database_url, 100_001).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires MDBASE_PROJECTION_DATABASE_URL; run against a disposable PostgreSQL database"]
async fn candidate_b_exact_projected_filter_pages_over_10k() {
    let database_url = std::env::var("MDBASE_PROJECTION_DATABASE_URL")
        .expect("MDBASE_PROJECTION_DATABASE_URL is required");
    candidate_b_exact_projected_filter_fixture(&database_url, 10_001).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires MDBASE_PROJECTION_DATABASE_URL; run against a disposable PostgreSQL database"]
async fn candidate_b_exact_projected_filter_and_group_100k() {
    let database_url = std::env::var("MDBASE_PROJECTION_DATABASE_URL")
        .expect("MDBASE_PROJECTION_DATABASE_URL is required");
    candidate_b_exact_projected_filter_fixture(&database_url, 100_001).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires MDBASE_PROJECTION_DATABASE_URL; run against a disposable PostgreSQL database"]
async fn candidate_b_exact_projected_filter_and_group_230k() {
    let database_url = std::env::var("MDBASE_PROJECTION_DATABASE_URL")
        .expect("MDBASE_PROJECTION_DATABASE_URL is required");
    candidate_b_exact_projected_filter_fixture(&database_url, 230_128).await;
}

async fn candidate_b_exact_projected_filter_fixture(database_url: &str, decoy_count: i64) {
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
        r#"WITH template AS (
             SELECT * FROM hosted_provider_record_projections
             WHERE collection_id = $1 AND generation_id = $2
               AND canonical_path = 'tasks/open-a.md'
           ), decoys AS (
             SELECT g, format('tasks/scale-%s.md', g) AS path, t.*
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
                  generation_id, path, matched_types, file_size_bytes, file_modified_at,
                  true, true, semantic_projection, decode(repeat('06', 32), 'hex'),
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
        r#"INSERT INTO hosted_provider_record_versions
             (collection_id, record_id, sequence, revision, types, payload_ciphertext, deleted)
           SELECT collection_id, record_id, record_sequence, record_revision,
                  matched_types, NULL, false
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
                "limit": 1000,
                "pagination": "cursor"
            }),
            None,
        )
        .await
        .unwrap();
    let projected_elapsed = projected_started.elapsed();
    eprintln!(
        "candidate_b_exact_filter_page decoys={decoy_count} elapsed_ms={}",
        projected_elapsed.as_millis()
    );
    assert!(projected_elapsed < Duration::from_secs(15));
    assert_eq!(
        projected_page["result"]["meta"]["total_count"],
        decoy_count + 2
    );
    assert_eq!(
        projected_page["result"]["results"]
            .as_array()
            .unwrap()
            .len(),
        1000
    );
    assert!(projected_page["result"]["meta"]["cursor"].is_string());
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
    eprintln!(
        "candidate_b_group_count decoys={decoy_count} elapsed_ms={}",
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

async fn candidate_b_base_candidate_prunes_fixture(database_url: &str, decoy_count: i64) {
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
        r#"WITH template AS (
             SELECT * FROM hosted_provider_record_projections
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
    let first_ordered_page = fixture
        .provider
        .operation(
            fixture.collection_id,
            &token,
            "query",
            Uuid::new_v4(),
            json!({
                "pagination": "cursor",
                "limit": 1000,
                "order_by": [{"field": "file.mtime", "direction": "desc"}]
            }),
            None,
        )
        .await
        .unwrap();
    assert_eq!(
        first_ordered_page["result"]["meta"]["total_count"],
        decoy_count + 1
    );
    assert_eq!(
        first_ordered_page["result"]["results"]
            .as_array()
            .unwrap()
            .len(),
        1000
    );
    let first_ordered_cursor = first_ordered_page["result"]["meta"]["cursor"]
        .as_str()
        .unwrap();
    let second_ordered_page = fixture
        .provider
        .operation(
            fixture.collection_id,
            &token,
            "query",
            Uuid::new_v4(),
            json!({
                "cursor": first_ordered_cursor,
                "limit": 1000,
                "order_by": [{"field": "file.mtime", "direction": "desc"}]
            }),
            None,
        )
        .await
        .unwrap();
    assert_eq!(
        second_ordered_page["result"]["results"]
            .as_array()
            .unwrap()
            .len(),
        1000
    );
    let source = r##"filters:
  and:
    - 'file.hasTag("#task")'
views:
  - type: table
    name: Tasks
    order: [file.name]
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

    sqlx::query(
        r#"UPDATE hosted_provider_record_projections
           SET semantic_complete = false
           WHERE collection_id = $1 AND generation_id = $2
             AND canonical_path = 'tasks/selected.md'
             AND valid_to_sequence IS NULL"#,
    )
    .bind(fixture.collection_id)
    .bind(generation_id)
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
