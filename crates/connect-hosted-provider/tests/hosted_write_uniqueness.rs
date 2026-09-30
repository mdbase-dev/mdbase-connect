#![allow(dead_code, unused_imports)]

mod support;
#[path = "support/test_postgres.rs"]
mod test_postgres;

use mdbase_connect_hosted_provider::{RegisterReplica, ReplicaPurpose};
use mdbase_connect_protocol::SyncReplicaMode;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::Row;
use support::FileLifecycleFixture;
use test_postgres::DisposablePostgres;
use uuid::Uuid;

const NOTE_TYPE: &str = r#"---
kind: mdbase.type
name: note
version: 1
match:
  path_glob: 'notes/*.md'
schema:
  dialect: json-schema-2020-12
  value:
    type: object
    properties:
      slug: {type: string}
collection:
  unique:
    - field: slug
---
"#;

async fn install_note_type(fixture: &FileLifecycleFixture) -> String {
    let token = format!("uniqueness-writer-{}", Uuid::new_v4());
    fixture
        .provider
        .register_replica(
            fixture.collection_id,
            RegisterReplica {
                replica_id: Uuid::now_v7(),
                name: "Uniqueness writer".to_string(),
                application_setup_evidence: None,
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
                token: token.clone(),
                token_ttl_seconds: Some(3600),
            },
        )
        .await
        .unwrap();
    let digest = format!("sha256:{:x}", Sha256::digest(NOTE_TYPE.as_bytes()));
    let pack = json!({
        "provision": {
            "manifest": {
                "kind": "mdbase.type-pack",
                "id": "test.hosted-write-uniqueness",
                "version": "1.0.0",
                "resources": [{
                    "kind": "type",
                    "mode": "managed",
                    "source": "types/note.md",
                    "target": "_types/note.md",
                    "digest": digest
                }]
            },
            "resources": [{"source": "types/note.md", "document": NOTE_TYPE}],
            "provides": []
        },
        "installed_by": "test.hosted-write-uniqueness",
        "adopt_resources": {},
        "preserve_seed_targets": [],
        "target_overrides": {},
        "contract_setups": []
    });
    let assessment = operation(fixture, &token, "assess_type_pack", pack.clone()).await;
    assert_eq!(assessment["valid"], true, "{assessment}");
    let mut apply = pack;
    apply["expected_assessment_digest"] = assessment["result"]["assessment_digest"].clone();
    apply["allow_downgrade"] = json!(false);
    let applied = operation(fixture, &token, "apply_type_pack", apply).await;
    assert_eq!(applied["valid"], true, "{applied}");
    token
}

async fn operation(
    fixture: &FileLifecycleFixture,
    token: &str,
    operation: &str,
    input: Value,
) -> Value {
    fixture
        .provider
        .operation(
            fixture.collection_id,
            token,
            operation,
            Uuid::now_v7(),
            input,
            None,
        )
        .await
        .unwrap_or_else(|error| panic!("{operation} failed: {error:?}"))
}

async fn create_note(fixture: &FileLifecycleFixture, token: &str, path: &str, slug: &str) -> Value {
    operation(
        fixture,
        token,
        "create",
        json!({"path": path, "type": "note", "frontmatter": {"slug": slug}}),
    )
    .await
}

async fn set_slug(fixture: &FileLifecycleFixture, token: &str, path: &str, slug: &str) -> Value {
    operation(
        fixture,
        token,
        "update",
        json!({"path": path, "patch": {"slug": slug}}),
    )
    .await
}

fn assert_duplicate(result: &Value, other_path: &str) {
    assert_eq!(result["valid"], false, "{result}");
    let diagnostics = result["diagnostics"].as_array().unwrap();
    assert!(
        diagnostics.iter().any(|diagnostic| {
            diagnostic["code"] == "duplicate_value"
                && diagnostic["message"]
                    .as_str()
                    .is_some_and(|message| message.contains(other_path))
        }),
        "{result}"
    );
}

async fn projection_is_current(fixture: &FileLifecycleFixture) -> bool {
    sqlx::query(
        "SELECT active_projection_generation_id IS NOT NULL AND active_projection_head = head
         FROM hosted_provider_collections WHERE id = $1",
    )
    .bind(fixture.collection_id)
    .fetch_one(&fixture.pool)
    .await
    .unwrap()
    .get::<Option<bool>, _>(0)
    .unwrap_or(false)
}

async fn complete_projection(fixture: &FileLifecycleFixture) {
    let generation = fixture
        .provider
        .start_projection_generation(fixture.collection_id)
        .await
        .unwrap();
    for _ in 0..16 {
        let batch = fixture
            .provider
            .advance_projection_generation(fixture.collection_id, generation.generation_id)
            .await
            .unwrap();
        if batch.generation.status == "complete" {
            return;
        }
    }
    panic!("the projection generation did not complete");
}

async fn record_count(fixture: &FileLifecycleFixture) -> i64 {
    sqlx::query_scalar("SELECT record_count FROM hosted_provider_collections WHERE id = $1")
        .bind(fixture.collection_id)
        .fetch_one(&fixture.pool)
        .await
        .unwrap()
}

#[tokio::test]
#[ignore = "requires the repository-approved disposable loopback PostgreSQL test target"]
async fn writes_without_a_current_projection_reject_duplicate_unique_values() {
    let database = DisposablePostgres::from_projection_env().await;
    let fixture = FileLifecycleFixture::new(database.url()).await;
    let token = install_note_type(&fixture).await;
    assert!(!projection_is_current(&fixture).await);

    let first = create_note(&fixture, &token, "notes/a.md", "same").await;
    assert_eq!(first["valid"], true, "{first}");
    assert_duplicate(
        &create_note(&fixture, &token, "notes/b.md", "same").await,
        "notes/a.md",
    );

    let other = create_note(&fixture, &token, "notes/c.md", "other").await;
    assert_eq!(other["valid"], true, "{other}");
    assert_duplicate(
        &set_slug(&fixture, &token, "notes/c.md", "same").await,
        "notes/a.md",
    );

    // A record's own value is not a conflict.
    let own_value = operation(
        &fixture,
        &token,
        "update",
        json!({"path": "notes/a.md", "patch": {"slug": "same", "title": "A"}}),
    )
    .await;
    assert_eq!(own_value["valid"], true, "{own_value}");
    assert_eq!(record_count(&fixture).await, 2);
}

#[tokio::test]
#[ignore = "requires the repository-approved disposable loopback PostgreSQL test target"]
async fn writes_with_a_current_projection_reject_duplicate_unique_values() {
    let database = DisposablePostgres::from_projection_env().await;
    let fixture = FileLifecycleFixture::new(database.url()).await;
    let token = install_note_type(&fixture).await;
    let first = create_note(&fixture, &token, "notes/a.md", "same").await;
    assert_eq!(first["valid"], true, "{first}");
    complete_projection(&fixture).await;
    assert!(projection_is_current(&fixture).await);

    assert_duplicate(
        &create_note(&fixture, &token, "notes/b.md", "same").await,
        "notes/a.md",
    );

    // Records written after indexing are found through their live projection.
    let later = create_note(&fixture, &token, "notes/c.md", "later").await;
    assert_eq!(later["valid"], true, "{later}");
    assert!(projection_is_current(&fixture).await);
    assert_duplicate(
        &create_note(&fixture, &token, "notes/d.md", "later").await,
        "notes/c.md",
    );
    assert_duplicate(
        &set_slug(&fixture, &token, "notes/a.md", "later").await,
        "notes/c.md",
    );

    // A value released by an update can be taken by another record.
    let released = set_slug(&fixture, &token, "notes/c.md", "moved").await;
    assert_eq!(released["valid"], true, "{released}");
    let reused = create_note(&fixture, &token, "notes/e.md", "later").await;
    assert_eq!(reused["valid"], true, "{reused}");
    assert_eq!(record_count(&fixture).await, 3);
}
