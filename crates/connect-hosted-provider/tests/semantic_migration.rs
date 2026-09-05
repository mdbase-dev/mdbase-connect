#![allow(dead_code, unused_imports)]
#[path = "support/setup_evidence.rs"]
mod fixture;
mod support;
#[path = "support/test_postgres.rs"]
mod test_postgres;
use mdbase_connect_hosted_provider::RegisterReplica;
use serde_json::{json, Value};
use support::FileLifecycleFixture;
use test_postgres::DisposablePostgres;
use uuid::Uuid;

#[test]
fn predecessor_flat_setup_parsing_does_not_select_nested_bindings() {
    use mdbase_connect_protocol::{ApplyCollectionSetupInput, AssessCollectionSetupInput};
    // Both structs are unchanged from c2596a6e. In particular, apply's `setup`
    // member is serde(flatten), not an accepted nested wire discriminator.
    let body = json!({
        "application_id":"top-level", "declaration_digest":"top-digest",
        "requirements":{}, "provisions":{},
        "expected_assessment_digest":"assessment", "expected_collection_revision":"revision",
        "expected_provision_digest":"provision",
        "setup":{"application_id":"nested", "declaration_digest":"nested-digest",
                 "requirements":{}, "provisions":{}}
    });
    let assessed: AssessCollectionSetupInput = serde_json::from_value(body.clone()).unwrap();
    let applied: ApplyCollectionSetupInput = serde_json::from_value(body.clone()).unwrap();
    assert_eq!(assessed.application_id, "top-level");
    assert_eq!(assessed.declaration_digest, "top-digest");
    assert_eq!(applied.setup, assessed);
    assert!(serde_json::to_value(applied)
        .unwrap()
        .get("setup")
        .is_none());
    let mut nested_only = body;
    nested_only
        .as_object_mut()
        .unwrap()
        .remove("application_id");
    assert!(serde_json::from_value::<AssessCollectionSetupInput>(nested_only.clone()).is_err());
    assert!(serde_json::from_value::<ApplyCollectionSetupInput>(nested_only).is_err());
}

#[tokio::test]
#[ignore = "requires the repository-approved disposable loopback PostgreSQL test target"]
async fn migration_preserves_evidence_bearing_authority_without_legacy_fallback() {
    let database = DisposablePostgres::from_projection_env().await;
    let fixture = FileLifecycleFixture::new(database.url()).await;
    let (evidence, exact, key) = fixture::setup_evidence(fixture.collection_id);
    let mut replicas = Vec::new();
    for name in ["legacy", "valid-v2", "malformed-v2", "json-null-v2"] {
        let id = Uuid::new_v4();
        let token = format!("migration-{name}-{}", Uuid::new_v4());
        let policy: RegisterReplica = serde_json::from_value(json!({
            "replica_id":id, "name":name, "purpose":"application", "mode":"read_write",
            "full_collection":true, "allowed_operations":["assess_collection_setup", "apply_collection_setup"],
            "operation_transport_protocol":3, "operation_transport_recovery_protocols":[2],
            "allowed_origin":"null", "proof_public_key":key, "grant_id":Uuid::new_v4(),
            "application_declaration_id":"dev.mdbase.fixture",
            "application_declaration_digest":exact["declaration_digest"], "token":token
        })).unwrap();
        fixture
            .provider
            .register_replica(fixture.collection_id, policy)
            .await
            .unwrap();
        replicas.push((id, token));
    }

    // Reconstruct the prior 0039 schema and its historical policies. Non-null
    // evidence is not a claim that verification will succeed, but must never
    // select weaker legacy semantics during this migration.
    let mut transaction = fixture.pool.begin().await.unwrap();
    sqlx::query("ALTER TABLE hosted_provider_replicas DROP COLUMN application_semantic_version")
        .execute(&mut *transaction)
        .await
        .unwrap();
    for (index, installed) in [
        (1, evidence.clone()),
        (
            2,
            json!({"application_authorization":{"signature":"invalid"}}),
        ),
        (3, Value::Null),
    ] {
        sqlx::query(
            "UPDATE hosted_provider_replicas SET application_setup_evidence=$2 WHERE id=$1",
        )
        .bind(replicas[index].0)
        .bind(installed)
        .execute(&mut *transaction)
        .await
        .unwrap();
    }
    let before: Vec<Value> =
        sqlx::query_scalar("SELECT to_jsonb(r) FROM hosted_provider_replicas r ORDER BY id")
            .fetch_all(&mut *transaction)
            .await
            .unwrap();
    sqlx::raw_sql(include_str!(
        "../migrations/0040_application_semantic_version.sql"
    ))
    .execute(&mut *transaction)
    .await
    .unwrap();
    let after: Vec<Value> = sqlx::query_scalar("SELECT to_jsonb(r) - 'application_semantic_version' FROM hosted_provider_replicas r ORDER BY id")
        .fetch_all(&mut *transaction).await.unwrap();
    assert_eq!(
        before, after,
        "migration preserves all historical policy fields"
    );
    for (index, expected) in [1, 2, 2, 2].into_iter().enumerate() {
        let actual: Option<i32> = sqlx::query_scalar(
            "SELECT application_semantic_version FROM hosted_provider_replicas WHERE id=$1",
        )
        .bind(replicas[index].0)
        .fetch_one(&mut *transaction)
        .await
        .unwrap();
        assert_eq!(actual, Some(expected));
    }
    let mirrors: Vec<Option<i32>> = sqlx::query_scalar(
        "SELECT application_semantic_version FROM hosted_provider_replicas WHERE purpose='mirror'",
    )
    .fetch_all(&mut *transaction)
    .await
    .unwrap();
    assert_eq!(
        mirrors,
        vec![None],
        "fixture has an actual mirror, not a vacuous assertion"
    );
    transaction.commit().await.unwrap();

    for index in [0, 1] {
        let result = fixture
            .provider
            .operation(
                fixture.collection_id,
                &replicas[index].1,
                "assess_collection_setup",
                Uuid::new_v4(),
                exact.clone(),
                Some("null"),
            )
            .await
            .unwrap();
        assert_eq!(result["valid"], true);
    }
    // A migrated valid-v2 row still requires its evidence; stripping it does not
    // retroactively change the version chosen by the migration.
    sqlx::query("UPDATE hosted_provider_replicas SET application_setup_evidence=NULL WHERE id=$1")
        .bind(replicas[1].0)
        .execute(&fixture.pool)
        .await
        .unwrap();
    for index in [1, 2, 3] {
        for operation in ["assess_collection_setup", "apply_collection_setup"] {
            let denied = fixture
                .provider
                .operation(
                    fixture.collection_id,
                    &replicas[index].1,
                    operation,
                    Uuid::new_v4(),
                    exact.clone(),
                    Some("null"),
                )
                .await
                .unwrap_err();
            assert_eq!(denied.code, "application_declaration_mismatch");
        }
    }
    let journal: i64 = sqlx::query_scalar("SELECT count(*) FROM hosted_provider_mutation_journal")
        .fetch_one(&fixture.pool)
        .await
        .unwrap();
    assert_eq!(journal, 0, "migration denials precede mutation admission");
}
