#![allow(dead_code, unused_imports)]

mod support;
#[path = "support/test_postgres.rs"]
mod test_postgres;

use mdbase_connect_hosted_provider::{RegisterReplica, ReplicaPurpose};
use mdbase_connect_protocol::{
    SyncCollectionResources, SyncMutation, SyncMutationOperation, SyncMutationReceipt,
    SyncReplicaMode,
};
use serde_json::json;
use sha2::{Digest, Sha256};
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

    let invalid_token = format!("invalid-request-validation-{}", Uuid::new_v4());
    for request_token in [&token, &invalid_token] {
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
                    request_token,
                    operation,
                    Uuid::now_v7(),
                    input,
                    None,
                )
                .await
                .expect_err("malformed protocol discriminator is rejected");
            assert_eq!(error.code, "invalid_request", "{operation}: {error:?}");
        }
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
async fn full_collection_updates_skip_unneeded_type_classification() {
    let database = DisposablePostgres::from_projection_env().await;
    let database_url = database.url().to_string();
    let fixture = FileLifecycleFixture::new(&database_url).await;
    let writer_token = format!("malformed-link-writer-{}", Uuid::new_v4());
    fixture
        .provider
        .register_replica(
            fixture.collection_id,
            RegisterReplica {
                replica_id: Uuid::now_v7(),
                name: "Malformed link fixture writer".to_string(),
                purpose: ReplicaPurpose::Application,
                mode: SyncReplicaMode::ReadWrite,
                allowed_types: Vec::new(),
                contract_scope: Vec::new(),
                full_collection: true,
                allowed_operations: ["assess_type_pack", "apply_type_pack", "create", "update"]
                    .into_iter()
                    .map(str::to_string)
                    .collect(),
                operation_transport_protocol: Some(3),
                operation_transport_recovery_protocols: Vec::new(),
                file_capability: None,
                allowed_origin: None,
                proof_public_key: None,
                grant_id: Some(Uuid::now_v7()),
                application_declaration_id: None,
                application_declaration_digest: None,
                token: writer_token.clone(),
                token_ttl_seconds: Some(3600),
            },
        )
        .await
        .unwrap();

    let contract_document = r#"---
kind: mdbase.contract
contract_type: record
id: test.malformed-link-task
version: 1.0.0
record_schema:
  dialect: json-schema-2020-12
  value:
    type: object
    properties:
      title: {type: string}
      status: {type: string, enum: [task]}
      project: {type: string}
---
"#;
    let type_document = r#"---
kind: mdbase.type
name: malformed_link_task
version: 1
match:
  path_glob: 'tasks/*.md'
  where:
    status: task
schema:
  dialect: json-schema-2020-12
  value:
    type: object
    properties:
      title: {type: string}
      status: {type: string, enum: [task]}
      project: {type: string}
implements:
  - contract: test.malformed-link-task
    version: 1.0.0
    fields:
      title: title
      status: status
      project: project
---
"#;
    let contract_digest = format!("sha256:{:x}", Sha256::digest(contract_document.as_bytes()));
    let type_digest = format!("sha256:{:x}", Sha256::digest(type_document.as_bytes()));
    let pack = json!({
        "provision": {
            "manifest": {
                "kind": "mdbase.type-pack",
                "id": "test.malformed-link-task",
                "version": "1.0.0",
                "resources": [
                    {
                        "kind": "contract",
                        "mode": "managed",
                        "source": "contracts/task.md",
                        "target": "_contracts/malformed-link-task.md",
                        "digest": contract_digest
                    },
                    {
                        "kind": "type",
                        "mode": "managed",
                        "source": "types/task.md",
                        "target": "_types/malformed_link_task.md",
                        "digest": type_digest
                    }
                ]
            },
            "resources": [
                {"source": "contracts/task.md", "document": contract_document},
                {"source": "types/task.md", "document": type_document}
            ],
            "provides": [{
                "id": "test.malformed-link-task",
                "version": "1.0.0",
                "digest": contract_digest
            }]
        },
        "installed_by": "test.malformed-link-task",
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
            Uuid::now_v7(),
            pack.clone(),
            None,
        )
        .await
        .unwrap();
    assert_eq!(assessment["valid"], true, "{assessment}");
    let mut apply = pack;
    apply["expected_assessment_digest"] = assessment["result"]["assessment_digest"].clone();
    apply["allow_downgrade"] = json!(false);
    let applied = fixture
        .provider
        .operation(
            fixture.collection_id,
            &writer_token,
            "apply_type_pack",
            Uuid::now_v7(),
            apply,
            None,
        )
        .await
        .unwrap();
    assert_eq!(applied["valid"], true, "{applied}");

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
    let resources: SyncCollectionResources = fixture
        .crypto
        .decrypt_json(
            &data_key,
            resources_row.get("resources_ciphertext"),
            &serde_json::to_vec(&("resources", fixture.collection_id)).unwrap(),
        )
        .unwrap();
    let contract = resources
        .contracts
        .into_iter()
        .find(|contract| contract.id == "test.malformed-link-task")
        .expect("installed contract is present in collection resources");
    let scoped_token = format!("malformed-link-scoped-{}", Uuid::new_v4());
    fixture
        .provider
        .register_replica(
            fixture.collection_id,
            RegisterReplica {
                replica_id: Uuid::now_v7(),
                name: "Malformed link scoped application".to_string(),
                purpose: ReplicaPurpose::Application,
                mode: SyncReplicaMode::ReadWrite,
                allowed_types: vec!["malformed_link_task".to_string()],
                contract_scope: vec![contract],
                full_collection: false,
                allowed_operations: vec!["create".to_string(), "update".to_string()],
                operation_transport_protocol: Some(3),
                operation_transport_recovery_protocols: Vec::new(),
                file_capability: None,
                allowed_origin: None,
                proof_public_key: None,
                grant_id: Some(Uuid::now_v7()),
                application_declaration_id: None,
                application_declaration_digest: None,
                token: scoped_token.clone(),
                token_ttl_seconds: Some(3600),
            },
        )
        .await
        .unwrap();

    for (index, malformed) in ["[[]]", "[[Plan"].into_iter().enumerate() {
        let path = format!("tasks/malformed-{index}.md");
        let created = fixture
            .provider
            .operation(
                fixture.collection_id,
                &writer_token,
                "create",
                Uuid::now_v7(),
                json!({
                    "path": path,
                    "type": "malformed_link_task",
                    "frontmatter": {"title": "Repairable", "status": "task", "project": "[[Plan]]"}
                }),
                None,
            )
            .await
            .unwrap();
        assert_eq!(created["valid"], true, "{created}");

        let malformed_update = fixture
            .provider
            .operation(
                fixture.collection_id,
                &writer_token,
                "update",
                Uuid::now_v7(),
                json!({"path": path, "patch": {"project": malformed}}),
                None,
            )
            .await
            .unwrap();
        assert_eq!(malformed_update["valid"], true, "{malformed_update}");

        let scoped_repair = fixture
            .provider
            .operation(
                fixture.collection_id,
                &scoped_token,
                "update",
                Uuid::now_v7(),
                json!({"path": path, "patch": {"project": "[[Plan]]"}}),
                None,
            )
            .await
            .expect_err("type-scoped repair remains fail-closed");
        assert_eq!(
            scoped_repair.code, "scope_classification_unavailable",
            "{scoped_repair:?}"
        );

        let repaired = fixture
            .provider
            .operation(
                fixture.collection_id,
                &writer_token,
                "update",
                Uuid::now_v7(),
                json!({"path": path, "patch": {"project": "[[Plan]]"}}),
                None,
            )
            .await
            .unwrap();
        assert_eq!(repaired["valid"], true, "{repaired}");
    }

    let atomic_path = "tasks/atomic.md";
    fixture
        .provider
        .operation(
            fixture.collection_id,
            &scoped_token,
            "create",
            Uuid::now_v7(),
            json!({
                "path": atomic_path,
                "type": "malformed_link_task",
                "frontmatter": {"title": "Atomic", "status": "task", "project": "[[Plan]]"}
            }),
            None,
        )
        .await
        .unwrap();
    let rejected = fixture
        .provider
        .operation(
            fixture.collection_id,
            &scoped_token,
            "update",
            Uuid::now_v7(),
            json!({"path": atomic_path, "patch": {"status": "outside-scope"}}),
            None,
        )
        .await
        .unwrap();
    assert_eq!(rejected["valid"], false, "{rejected}");
    assert!(
        rejected["diagnostics"]
            .as_array()
            .is_some_and(|items| !items.is_empty()),
        "{rejected}"
    );
    let writable_after_rejection = fixture
        .provider
        .operation(
            fixture.collection_id,
            &scoped_token,
            "update",
            Uuid::now_v7(),
            json!({"path": atomic_path, "patch": {"title": "Still writable"}}),
            None,
        )
        .await
        .unwrap();
    assert_eq!(
        writable_after_rejection["valid"], true,
        "{writable_after_rejection}"
    );

    let unavailable_path = "tasks/unavailable.md";
    let mirror = sqlx::query(
        "SELECT id, scope_epoch FROM hosted_provider_replicas WHERE collection_id = $1 AND purpose = 'mirror'",
    )
    .bind(fixture.collection_id)
    .fetch_one(&fixture.pool)
    .await
    .unwrap();
    let unavailable = fixture
        .provider
        .mutate(
            fixture.collection_id,
            &fixture.token,
            SyncMutation {
                mutation_id: Uuid::now_v7(),
                replica_id: mirror.get("id"),
                scope_epoch: u64::try_from(mirror.get::<i64, _>("scope_epoch")).unwrap(),
                operation: SyncMutationOperation::Put,
                record_id: Uuid::now_v7(),
                base_revision: None,
                path: Some(unavailable_path.to_string()),
                document: Some("---\ntitle: [\n---\nUnparseable frontmatter.\n".to_string()),
                created_at: chrono::Utc::now().to_rfc3339(),
                causal_predecessor: None,
            },
            None,
        )
        .await
        .unwrap();
    assert!(matches!(unavailable, SyncMutationReceipt::Applied { .. }));
    let denied = fixture
        .provider
        .operation(
            fixture.collection_id,
            &scoped_token,
            "update",
            Uuid::now_v7(),
            json!({"path": unavailable_path, "patch": {"title": "Denied"}}),
            None,
        )
        .await
        .expect_err("unavailable type evidence remains fail-closed");
    assert!(
        matches!(
            denied.code.as_str(),
            "scope_classification_unavailable" | "scope_denied"
        ),
        "{denied:?}"
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
