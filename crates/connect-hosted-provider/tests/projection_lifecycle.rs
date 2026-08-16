#![allow(dead_code, unused_imports)]

mod support;

use mdbase_connect_hosted_provider::{RegisterReplica, ReplicaPurpose};
use mdbase_connect_protocol::{
    SyncMutation, SyncMutationOperation, SyncMutationReceipt, SyncReplicaMode,
};
use serde_json::json;
use sqlx::Row;
use std::time::Duration;
use support::FileLifecycleFixture;
use uuid::Uuid;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires MDBASE_PROJECTION_DATABASE_URL; run against a disposable PostgreSQL database"]
async fn candidate_b_projection_lifecycle_is_snapshot_safe_and_write_through() {
    let database_url = std::env::var("MDBASE_PROJECTION_DATABASE_URL")
        .expect("MDBASE_PROJECTION_DATABASE_URL is required");
    let fixture = FileLifecycleFixture::new(&database_url).await;
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

    let first_generation = complete_generation(&fixture).await;
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
                    "create_view_source".to_string(),
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

    let stable_view_document = "---\ntype: view\nid: stable.views\nversion: 1\nname: Stable\nquery: {}\nviews:\n  - id: all\n    name: All\n---\n";
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

    // Keep the compiler honest that the updated source remains a real exact
    // authority record throughout relationship-only revalidation.
    assert!(!source.revision.is_empty());
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
