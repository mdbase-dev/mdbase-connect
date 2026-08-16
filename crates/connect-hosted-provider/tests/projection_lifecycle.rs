#![allow(dead_code, unused_imports)]

mod support;

use mdbase_connect_hosted_provider::{RegisterReplica, ReplicaPurpose};
use mdbase_connect_protocol::{
    SyncMutation, SyncMutationOperation, SyncMutationReceipt, SyncReplicaMode,
};
use serde_json::json;
use sqlx::Row;
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
