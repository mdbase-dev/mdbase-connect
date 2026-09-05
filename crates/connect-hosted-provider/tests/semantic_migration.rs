#![allow(dead_code, unused_imports)]
#[path = "support/setup_evidence.rs"]
mod fixture;
mod support;
#[path = "support/test_postgres.rs"]
mod test_postgres;
use mdbase_connect_hosted_provider::RegisterReplica;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use support::FileLifecycleFixture;
use test_postgres::DisposablePostgres;
use uuid::Uuid;

// Exact INSERT text from beta94, 8d1b5fb1647edcadd716d4ee671f0ba04d34fa5e,
// crates/connect-hosted-provider/src/provider/replicas.rs. This is SQL-shape
// compatibility evidence, NOT execution/qualification of a signed old binary.
const BETA94_INSERT: &str = r#"INSERT INTO hosted_provider_replicas
                 (id, collection_id, name, purpose, mode, allowed_types, contract_scope,
                  full_collection,
                  allowed_operations, operation_transport_protocol,
                  operation_transport_recovery_protocols,
                  file_capability, allowed_origin, proof_public_key, grant_id,
                  application_declaration_id, application_declaration_digest, token_hash,
                  token_expires_at)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
                       $13, $14, $15, $16, $17, $18,
                       now() + ($19 * interval '1 second'))"#;

fn legacy_policy(exact: &Value, key: &str, purpose: &str) -> Value {
    if purpose == "mirror" {
        return json!({
            "replica_id":Uuid::new_v4(), "name":"beta94 mirror SQL shape",
            "purpose":"mirror", "mode":"read_write",
            "token":format!("beta94-mirror-{}", Uuid::new_v4())
        });
    }
    json!({
        "replica_id":Uuid::new_v4(), "name":"beta94 SQL shape", "purpose":purpose,
        "mode":"read_write", "full_collection":true,
        "allowed_operations":["apply_collection_setup", "assess_collection_setup"],
        "operation_transport_protocol":3, "operation_transport_recovery_protocols":[2],
        "allowed_origin":"null", "proof_public_key":key, "grant_id":Uuid::new_v4(),
        "application_declaration_id":"dev.mdbase.fixture",
        "application_declaration_digest":exact["declaration_digest"],
        "token":format!("beta94-shape-{}", Uuid::new_v4())
    })
}

async fn predecessor_insert(
    pool: &sqlx::PgPool,
    collection: Uuid,
    body: &Value,
) -> Result<(), sqlx::Error> {
    let p: RegisterReplica = serde_json::from_value(body.clone()).unwrap();
    sqlx::query(BETA94_INSERT)
        .bind(p.replica_id)
        .bind(collection)
        .bind(p.name)
        .bind(body["purpose"].as_str().unwrap())
        .bind("read_write")
        .bind(p.allowed_types)
        .bind(serde_json::to_value(p.contract_scope).unwrap())
        .bind(p.full_collection)
        .bind(p.allowed_operations)
        .bind(p.operation_transport_protocol.map(|v| v as i32))
        .bind(
            p.operation_transport_recovery_protocols
                .into_iter()
                .map(|v| v as i32)
                .collect::<Vec<_>>(),
        )
        .bind(p.file_capability.map(|v| serde_json::to_value(v).unwrap()))
        .bind(p.allowed_origin)
        .bind(p.proof_public_key)
        .bind(p.grant_id)
        .bind(p.application_declaration_id)
        .bind(p.application_declaration_digest)
        .bind(Sha256::digest(p.token.as_bytes()).to_vec())
        .bind(3600_i64)
        .execute(pool)
        .await
        .map(|_| ())
}

async fn semantic_state(pool: &sqlx::PgPool, id: Uuid) -> (Option<i32>, i64) {
    sqlx::query_as("SELECT application_semantic_version, scope_epoch FROM hosted_provider_replicas WHERE id=$1")
        .bind(id).fetch_one(pool).await.unwrap()
}

async fn migrate_through(pool: &sqlx::PgPool, version: i64) {
    let mut migrator = sqlx::migrate!("./migrations");
    migrator.migrations = std::borrow::Cow::Owned(
        migrator
            .iter()
            .filter(|m| m.version <= version)
            .cloned()
            .collect(),
    );
    migrator.run(pool).await.unwrap();
}

#[tokio::test]
#[ignore = "requires the repository-approved disposable loopback PostgreSQL test target"]
async fn actual_migration_prefix_exposes_0040_interruption_and_0041_repairs_old_insert() {
    let database = DisposablePostgres::from_projection_env().await;
    let pool = sqlx::PgPool::connect(database.url()).await.unwrap();
    migrate_through(&pool, 1).await;
    let collection = Uuid::new_v4();
    sqlx::query("INSERT INTO hosted_provider_collections (id, template, spec_version, max_records, max_content_bytes, max_document_bytes, max_replicas, resource_revision, wrapped_data_key, resources_ciphertext) VALUES ($1,'mdbase','0.3.0',100,100000,10000,50,'fixture',''::bytea,''::bytea)")
        .bind(collection).execute(&pool).await.unwrap();
    migrate_through(&pool, 39).await;
    let (valid, exact, key) = fixture::setup_evidence(collection);
    let historical = legacy_policy(&exact, &key, "application");
    predecessor_insert(&pool, collection, &historical)
        .await
        .unwrap();
    // Retained v2 state is seeded with private SQL, not fresh public v2
    // authorization (which is intentionally gated). Include SQL NULL evidence.
    let mut retained = Vec::new();
    for evidence in [
        None,
        Some(Value::Null),
        Some(json!({"malformed":true})),
        Some(valid),
    ] {
        let body = legacy_policy(&exact, &key, "application");
        predecessor_insert(&pool, collection, &body).await.unwrap();
        retained.push((
            serde_json::from_value::<Uuid>(body["replica_id"].clone()).unwrap(),
            evidence,
        ));
    }
    migrate_through(&pool, 40).await;
    for (id, evidence) in retained {
        sqlx::query("UPDATE hosted_provider_replicas SET application_semantic_version=2, application_setup_evidence=$2 WHERE id=$1")
            .bind(id).bind(evidence).execute(&pool).await.unwrap();
    }
    assert_eq!(
        semantic_state(
            &pool,
            serde_json::from_value(historical["replica_id"].clone()).unwrap()
        )
        .await
        .0,
        Some(1)
    );
    let interrupted = legacy_policy(&exact, &key, "application");
    let error = predecessor_insert(&pool, collection, &interrupted)
        .await
        .unwrap_err();
    assert_eq!(
        error.as_database_error().unwrap().code().as_deref(),
        Some("23514")
    );
    let mirror = legacy_policy(&exact, &key, "mirror");
    predecessor_insert(&pool, collection, &mirror)
        .await
        .unwrap();
    let before: Vec<Value> =
        sqlx::query_scalar("SELECT to_jsonb(r) FROM hosted_provider_replicas r ORDER BY id")
            .fetch_all(&pool)
            .await
            .unwrap();
    migrate_through(&pool, 41).await;
    let after: Vec<Value> =
        sqlx::query_scalar("SELECT to_jsonb(r) FROM hosted_provider_replicas r ORDER BY id")
            .fetch_all(&pool)
            .await
            .unwrap();
    assert_eq!(before, after, "0041 does not rewrite retained authority");
    predecessor_insert(&pool, collection, &interrupted)
        .await
        .unwrap();
    assert_eq!(
        semantic_state(
            &pool,
            serde_json::from_value(interrupted["replica_id"].clone()).unwrap()
        )
        .await
        .0,
        None
    );
    assert_eq!(
        semantic_state(
            &pool,
            serde_json::from_value(mirror["replica_id"].clone()).unwrap()
        )
        .await
        .0,
        None
    );
    let versions: Vec<i64> =
        sqlx::query_scalar("SELECT version FROM _sqlx_migrations WHERE success ORDER BY version")
            .fetch_all(&pool)
            .await
            .unwrap();
    assert_eq!(
        versions,
        (1..=41).collect::<Vec<_>>(),
        "real prefix ledger, never deleted or fabricated"
    );
}

#[tokio::test]
#[ignore = "requires the repository-approved disposable loopback PostgreSQL test target"]
async fn predecessor_legacy_retry_update_and_setup_use_normalized_authority() {
    let database = DisposablePostgres::from_projection_env().await;
    let f = FileLifecycleFixture::new(database.url()).await;
    let (_, exact, key) = fixture::setup_evidence(f.collection_id);
    let body = legacy_policy(&exact, &key, "application");
    let p: RegisterReplica = serde_json::from_value(body.clone()).unwrap();
    predecessor_insert(&f.pool, f.collection_id, &body)
        .await
        .unwrap();
    assert_eq!(semantic_state(&f.pool, p.replica_id).await, (None, 1));
    f.provider
        .register_replica(f.collection_id, p.clone())
        .await
        .unwrap();
    assert_eq!(semantic_state(&f.pool, p.replica_id).await.1, 1);
    let result = f
        .provider
        .operation(
            f.collection_id,
            &p.token,
            "assess_collection_setup",
            Uuid::new_v4(),
            exact.clone(),
            Some("null"),
        )
        .await
        .unwrap();
    assert_eq!(result["valid"], true);
    let mut bad = exact.clone();
    bad["application_id"] = json!("dev.other.application");
    let denied = f
        .provider
        .operation(
            f.collection_id,
            &p.token,
            "assess_collection_setup",
            Uuid::new_v4(),
            bad,
            Some("null"),
        )
        .await
        .unwrap_err();
    assert_eq!(denied.code, "application_declaration_mismatch");
    f.provider
        .update_application_replica(p.replica_id, serde_json::from_value(body.clone()).unwrap())
        .await
        .unwrap();
    assert_eq!(semantic_state(&f.pool, p.replica_id).await, (Some(1), 1));
    let mut changed = body.clone();
    changed["grant_id"] = json!(Uuid::new_v4());
    f.provider
        .update_application_replica(
            p.replica_id,
            serde_json::from_value(changed.clone()).unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(semantic_state(&f.pool, p.replica_id).await, (Some(1), 2));
    f.provider
        .update_application_replica(p.replica_id, serde_json::from_value(changed).unwrap())
        .await
        .unwrap();
    assert_eq!(semantic_state(&f.pool, p.replica_id).await, (Some(1), 2));
    let fresh: RegisterReplica =
        serde_json::from_value(legacy_policy(&exact, &key, "application")).unwrap();
    f.provider
        .register_replica(f.collection_id, fresh.clone())
        .await
        .unwrap();
    assert_eq!(
        semantic_state(&f.pool, fresh.replica_id).await,
        (Some(1), 1)
    );
    let mirror = legacy_policy(&exact, &key, "mirror");
    predecessor_insert(&f.pool, f.collection_id, &mirror)
        .await
        .unwrap();
    f.provider
        .register_replica(
            f.collection_id,
            serde_json::from_value(mirror.clone()).unwrap(),
        )
        .await
        .unwrap();
    // Mirrors retain NULL semantics regardless of their unrelated metadata.
    assert_eq!(
        semantic_state(
            &f.pool,
            serde_json::from_value(mirror["replica_id"].clone()).unwrap()
        )
        .await,
        (None, 1)
    );
}

#[tokio::test]
#[ignore = "requires the repository-approved disposable loopback PostgreSQL test target"]
async fn migration_0041_check_truth_table_preserves_v2_and_denies_ambiguous_legacy() {
    let database = DisposablePostgres::from_projection_env().await;
    let f = FileLifecycleFixture::new(database.url()).await;
    let (valid, exact, key) = fixture::setup_evidence(f.collection_id);
    for purpose in ["application", "mirror"] {
        let body = legacy_policy(&exact, &key, purpose);
        predecessor_insert(&f.pool, f.collection_id, &body)
            .await
            .unwrap();
        let p: RegisterReplica = serde_json::from_value(body).unwrap();
        for version in [None, Some(1_i32), Some(2), Some(0), Some(3), Some(-1)] {
            for evidence in [
                None,
                Some(Value::Null),
                Some(json!({"malformed":true})),
                Some(valid.clone()),
            ] {
                let expected = if purpose == "mirror" {
                    version.is_none()
                } else {
                    (version.is_none() || version == Some(1)) && evidence.is_none()
                        || version == Some(2)
                };
                let before: Value = sqlx::query_scalar(
                    "SELECT to_jsonb(r) FROM hosted_provider_replicas r WHERE id=$1",
                )
                .bind(p.replica_id)
                .fetch_one(&f.pool)
                .await
                .unwrap();
                let result = sqlx::query("UPDATE hosted_provider_replicas SET application_semantic_version=$2, application_setup_evidence=$3 WHERE id=$1")
                    .bind(p.replica_id).bind(version).bind(evidence.clone()).execute(&f.pool).await;
                assert_eq!(
                    result.is_ok(),
                    expected,
                    "purpose={purpose} version={version:?} evidence={evidence:?}"
                );
                if let Err(error) = result {
                    assert_eq!(
                        error.as_database_error().unwrap().code().as_deref(),
                        Some("23514")
                    );
                    let after: Value = sqlx::query_scalar(
                        "SELECT to_jsonb(r) FROM hosted_provider_replicas r WHERE id=$1",
                    )
                    .bind(p.replica_id)
                    .fetch_one(&f.pool)
                    .await
                    .unwrap();
                    assert_eq!(
                        before, after,
                        "rejected contradiction cannot lose or downgrade stored authority"
                    );
                } else {
                    let stored: (Option<i32>, Option<Value>) = sqlx::query_as("SELECT application_semantic_version, application_setup_evidence FROM hosted_provider_replicas WHERE id=$1").bind(p.replica_id).fetch_one(&f.pool).await.unwrap();
                    assert_eq!(stored, (version, evidence.clone()));
                    if purpose == "application"
                        && version == Some(2)
                        && evidence.as_ref() == Some(&valid)
                    {
                        let assessed = f
                            .provider
                            .operation(
                                f.collection_id,
                                &p.token,
                                "assess_collection_setup",
                                Uuid::new_v4(),
                                exact.clone(),
                                Some("null"),
                            )
                            .await
                            .unwrap();
                        assert_eq!(assessed["valid"], true);
                    }
                    if purpose == "application"
                        && version == Some(2)
                        && evidence.as_ref() != Some(&valid)
                    {
                        for op in ["assess_collection_setup", "apply_collection_setup"] {
                            let error = f
                                .provider
                                .operation(
                                    f.collection_id,
                                    &p.token,
                                    op,
                                    Uuid::new_v4(),
                                    exact.clone(),
                                    Some("null"),
                                )
                                .await
                                .unwrap_err();
                            assert_eq!(error.code, "application_declaration_mismatch");
                        }
                        assert_eq!(semantic_state(&f.pool, p.replica_id).await.0, Some(2));
                    }
                }
            }
        }
    }
    let admitted: i64 = sqlx::query_scalar("SELECT count(*) FROM hosted_provider_mutation_journal")
        .fetch_one(&f.pool)
        .await
        .unwrap();
    assert_eq!(admitted, 0);
}

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
