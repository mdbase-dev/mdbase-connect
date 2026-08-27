#![allow(dead_code, unused_imports)]

mod support;
#[path = "support/test_postgres.rs"]
mod test_postgres;

use mdbase_connect_hosted_provider::{RegisterReplica, ReplicaPurpose};
use mdbase_connect_protocol::SyncReplicaMode;
use serde_json::json;
use sqlx::Row;
use support::FileLifecycleFixture;
use test_postgres::DisposablePostgres;
use uuid::Uuid;

#[tokio::test]
#[ignore = "requires the repository-approved disposable loopback PostgreSQL test target"]
async fn assess_collection_setup_dispatch_rejects_mismatched_declaration() {
    let database = DisposablePostgres::from_projection_env().await;
    let database_url = database.url().to_string();
    let fixture = FileLifecycleFixture::new(&database_url).await;
    let replica_id = Uuid::now_v7();
    let token = format!("setup-assessment-{}-{}", Uuid::new_v4(), Uuid::new_v4());
    let declaration_id = "dev.mdbase.tasks";
    let declaration_digest = format!("sha256:{}", "a".repeat(64));
    fixture
        .provider
        .register_replica(
            fixture.collection_id,
            RegisterReplica {
                replica_id,
                name: "Tasks application".to_string(),
                purpose: ReplicaPurpose::Application,
                mode: SyncReplicaMode::ReadWrite,
                allowed_types: Vec::new(),
                contract_scope: Vec::new(),
                full_collection: true,
                allowed_operations: vec!["assess_collection_setup".to_string()],
                operation_transport_protocol: Some(3),
                operation_transport_recovery_protocols: vec![2],
                file_capability: None,
                allowed_origin: Some("https://tasks.example".to_string()),
                proof_public_key: None,
                grant_id: Some(Uuid::new_v4()),
                application_declaration_id: Some(declaration_id.to_string()),
                application_declaration_digest: Some(declaration_digest.clone()),
                token: token.clone(),
                token_ttl_seconds: Some(3600),
            },
        )
        .await
        .expect("application replica is registered");

    let mismatched_digest = format!("sha256:{}", "b".repeat(64));
    for (application_id, digest) in [
        ("dev.mdbase.other", declaration_digest.as_str()),
        (declaration_id, mismatched_digest.as_str()),
    ] {
        let error = fixture
            .provider
            .operation(
                fixture.collection_id,
                &token,
                "assess_collection_setup",
                Uuid::now_v7(),
                json!({
                    "application_id": application_id,
                    "declaration_digest": digest,
                    "requirements": { "configuration": [] },
                    "provisions": { "configuration": [], "type_packs": [] }
                }),
                Some("https://tasks.example"),
            )
            .await
            .expect_err("mismatched declaration is rejected before assessment");
        assert_eq!(error.code, "application_declaration_mismatch");
    }
}

#[tokio::test]
#[ignore = "requires the repository-approved disposable loopback PostgreSQL test target"]
async fn hosted_request_path_rejects_protocol_discriminators_before_authorization_or_state() {
    let database = DisposablePostgres::from_projection_env().await;
    let database_url = database.url().to_string();
    let fixture = FileLifecycleFixture::new(&database_url).await;
    let token = format!("request-validation-{}-{}", Uuid::new_v4(), Uuid::new_v4());
    fixture
        .provider
        .register_replica(
            fixture.collection_id,
            RegisterReplica {
                replica_id: Uuid::now_v7(),
                name: "Request validation application".to_string(),
                purpose: ReplicaPurpose::Application,
                mode: SyncReplicaMode::ReadWrite,
                allowed_types: Vec::new(),
                contract_scope: Vec::new(),
                full_collection: true,
                // Deliberately do not grant unknown_operation, sync, or
                // file_control: protocol syntax is validated before grant lookup.
                allowed_operations: vec!["create".to_string()],
                operation_transport_protocol: Some(3),
                operation_transport_recovery_protocols: vec![2],
                file_capability: None,
                allowed_origin: None,
                proof_public_key: None,
                grant_id: Some(Uuid::new_v4()),
                application_declaration_id: None,
                application_declaration_digest: None,
                token: token.clone(),
                token_ttl_seconds: Some(3600),
            },
        )
        .await
        .expect("application replica is registered");

    let before = sqlx::query(
        r#"SELECT collection.head,
                  (SELECT count(*) FROM hosted_provider_mutation_journal) AS journals,
                  (SELECT count(*) FROM hosted_provider_mutation_tombstones) AS tombstones,
                  (SELECT count(*) FROM hosted_provider_record_versions
                     WHERE collection_id = collection.id) AS records,
                  (SELECT count(*) FROM hosted_provider_files
                     WHERE collection_id = collection.id) AS files,
                  (SELECT count(*) FROM hosted_provider_resources
                     WHERE collection_id = collection.id) AS resources
           FROM hosted_provider_collections collection WHERE collection.id = $1"#,
    )
    .bind(fixture.collection_id)
    .fetch_one(&fixture.pool)
    .await
    .unwrap();
    let baseline = (
        before.get::<i64, _>("head"),
        before.get::<i64, _>("journals"),
        before.get::<i64, _>("tombstones"),
        before.get::<i64, _>("records"),
        before.get::<i64, _>("files"),
        before.get::<i64, _>("resources"),
    );

    let cases = [
        ("unknown_operation", json!({})),
        (
            "create",
            json!({"path": "rejected.md", "operation": "delete"}),
        ),
        ("create", json!({"path": "rejected.md", "action": "mutate"})),
        ("sync", json!({"action": "unknown"})),
        (
            "sync",
            json!({"action": "mutate", "type": "commit_file_upload"}),
        ),
        (
            "file_control",
            json!({"protocol_version": 1, "type": "unknown_file_control"}),
        ),
        (
            "file_control",
            json!({"protocol_version": 1, "type": "commit_file_upload", "action": "mutate"}),
        ),
        (
            "file_control",
            json!({"protocol_version": 1, "type": "list_files", "operation": "read"}),
        ),
    ];
    for (operation, input) in cases {
        let error = fixture
            .provider
            .operation(
                fixture.collection_id,
                &token,
                operation,
                Uuid::now_v7(),
                input,
                None,
            )
            .await
            .expect_err("malformed protocol discriminator is rejected");
        assert_eq!(error.code, "invalid_request", "{operation}: {error:?}");
    }

    let after = sqlx::query(
        r#"SELECT collection.head,
                  (SELECT count(*) FROM hosted_provider_mutation_journal) AS journals,
                  (SELECT count(*) FROM hosted_provider_mutation_tombstones) AS tombstones,
                  (SELECT count(*) FROM hosted_provider_record_versions
                     WHERE collection_id = collection.id) AS records,
                  (SELECT count(*) FROM hosted_provider_files
                     WHERE collection_id = collection.id) AS files,
                  (SELECT count(*) FROM hosted_provider_resources
                     WHERE collection_id = collection.id) AS resources
           FROM hosted_provider_collections collection WHERE collection.id = $1"#,
    )
    .bind(fixture.collection_id)
    .fetch_one(&fixture.pool)
    .await
    .unwrap();
    assert_eq!(
        (
            after.get::<i64, _>("head"),
            after.get::<i64, _>("journals"),
            after.get::<i64, _>("tombstones"),
            after.get::<i64, _>("records"),
            after.get::<i64, _>("files"),
            after.get::<i64, _>("resources"),
        ),
        baseline,
    );
}

#[tokio::test]
#[ignore = "requires the repository-approved disposable loopback PostgreSQL test target"]
async fn hosted_operation_mutations_replay_exactly_after_provider_recreation() {
    let database = DisposablePostgres::from_projection_env().await;
    let database_url = database.url().to_string();
    let fixture = FileLifecycleFixture::new(&database_url).await;
    let replica_id = Uuid::now_v7();
    let token = format!("recovery-matrix-{}-{}", Uuid::new_v4(), Uuid::new_v4());
    fixture
        .provider
        .register_replica(
            fixture.collection_id,
            RegisterReplica {
                replica_id,
                name: "Mutation recovery matrix application".to_string(),
                purpose: ReplicaPurpose::Application,
                mode: SyncReplicaMode::ReadWrite,
                allowed_types: Vec::new(),
                contract_scope: Vec::new(),
                full_collection: true,
                allowed_operations: [
                    "read",
                    "create",
                    "delete",
                    "rename",
                    "create_type",
                    "create_view_source",
                ]
                .into_iter()
                .map(str::to_string)
                .collect(),
                operation_transport_protocol: Some(3),
                operation_transport_recovery_protocols: vec![2],
                file_capability: None,
                allowed_origin: None,
                proof_public_key: None,
                grant_id: Some(Uuid::new_v4()),
                application_declaration_id: None,
                application_declaration_digest: None,
                token: token.clone(),
                token_ttl_seconds: Some(3600),
            },
        )
        .await
        .unwrap();

    let operations = [
        (
            "create",
            json!({
                "path": "recovery/preflight.md",
                "frontmatter": {"title": "Preflight"},
                "body": "Not persisted.\n",
                "dry_run": true,
            }),
            "record",
        ),
        (
            "create_type",
            json!({
                "document": "---\nkind: mdbase.type\nname: recovery_note\nversion: 1\nmatch:\n  path_glob: 'recovery/*.md'\nschema:\n  dialect: json-schema-2020-12\n  value:\n    type: object\n---\n",
                "dry_run": true,
            }),
            "type",
        ),
        (
            "create_view_source",
            json!({
                "path": "views/recovery.base",
                "document": "views:\n  - type: table\n    name: Recovery\n    order: [file.name]\n",
                "dry_run": true,
            }),
            "view",
        ),
    ];

    for (operation, input, effect) in operations {
        let request_id = Uuid::now_v7();
        let first = fixture
            .provider
            .operation(
                fixture.collection_id,
                &token,
                operation,
                request_id,
                input.clone(),
                None,
            )
            .await
            .unwrap();
        assert_eq!(first["valid"], true, "{operation}: {first}");
        let row = sqlx::query(
            "SELECT operation_kind, state FROM hosted_provider_mutation_journal \
             WHERE replica_id = $1 AND request_id = $2",
        )
        .bind(replica_id)
        .bind(request_id)
        .fetch_one(&fixture.pool)
        .await
        .unwrap();
        assert_eq!(row.get::<String, _>("operation_kind"), operation);
        assert_eq!(row.get::<String, _>("state"), "completed");

        // Simulate the response being lost and the provider process reopening.
        let reopened = fixture.another_provider(&database_url).await;
        let replay = reopened
            .operation(
                fixture.collection_id,
                &token,
                operation,
                request_id,
                input,
                None,
            )
            .await
            .unwrap();
        assert_eq!(
            serde_json::to_vec(&replay).unwrap(),
            serde_json::to_vec(&first).unwrap(),
            "{operation} terminal replay is byte-exact",
        );
        let effect_count: i64 = match effect {
            "record" => sqlx::query_scalar(
                "SELECT count(*) FROM hosted_provider_records WHERE collection_id = $1",
            )
            .bind(fixture.collection_id)
            .fetch_one(&fixture.pool)
            .await
            .unwrap(),
            "type" => sqlx::query_scalar(
                "SELECT count(*) FROM hosted_provider_resources \
                 WHERE collection_id = $1 AND path = '_types/recovery_note.md'",
            )
            .bind(fixture.collection_id)
            .fetch_one(&fixture.pool)
            .await
            .unwrap(),
            "view" => sqlx::query_scalar(
                "SELECT count(*) FROM hosted_provider_resources \
                 WHERE collection_id = $1 AND path = 'views/recovery.base'",
            )
            .bind(fixture.collection_id)
            .fetch_one(&fixture.pool)
            .await
            .unwrap(),
            _ => unreachable!(),
        };
        assert_eq!(effect_count, i64::from(effect != "record"), "{operation}");
    }

    for path in ["controls/rename.md", "controls/delete.md"] {
        fixture
            .provider
            .operation(
                fixture.collection_id,
                &token,
                "create",
                Uuid::now_v7(),
                json!({"path": path, "frontmatter": {"title": path}}),
                None,
            )
            .await
            .unwrap();
    }
    let journals_before_controls: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM hosted_provider_mutation_journal WHERE replica_id = $1",
    )
    .bind(replica_id)
    .fetch_one(&fixture.pool)
    .await
    .unwrap();
    let rename = fixture
        .provider
        .operation(
            fixture.collection_id,
            &token,
            "rename",
            Uuid::now_v7(),
            json!({
                "from": "controls/rename.md",
                "to": "controls/renamed.md",
                "update_refs": false,
                "dry_run": true
            }),
            None,
        )
        .await
        .unwrap();
    let delete = fixture
        .provider
        .operation(
            fixture.collection_id,
            &token,
            "delete",
            Uuid::now_v7(),
            json!({"path": "controls/delete.md", "check_backlinks": false, "dry_run": true}),
            None,
        )
        .await
        .unwrap();
    assert_eq!(rename["valid"], true);
    assert_eq!(delete["valid"], true);
    let journals_after_controls: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM hosted_provider_mutation_journal WHERE replica_id = $1",
    )
    .bind(replica_id)
    .fetch_one(&fixture.pool)
    .await
    .unwrap();
    assert_eq!(journals_after_controls, journals_before_controls);
    for path in ["controls/rename.md", "controls/delete.md"] {
        let read = fixture
            .provider
            .operation(
                fixture.collection_id,
                &token,
                "read",
                Uuid::now_v7(),
                json!({"path": path}),
                None,
            )
            .await
            .unwrap();
        assert_eq!(read["valid"], true, "{path} remains after dry-run");
        assert_eq!(read["result"]["path"], path);
    }
    let renamed = fixture
        .provider
        .operation(
            fixture.collection_id,
            &token,
            "read",
            Uuid::now_v7(),
            json!({"path": "controls/renamed.md"}),
            None,
        )
        .await
        .unwrap();
    assert_eq!(renamed["valid"], false, "rename dry-run creates no target");
}
