#![allow(dead_code, unused_imports)]
#[path = "support/setup_evidence.rs"]
mod fixture;
mod support;
#[path = "support/test_postgres.rs"]
mod test_postgres;
use mdbase_connect_hosted_provider::{RegisterReplica, ReplicaPurpose};
use mdbase_connect_protocol::SyncReplicaMode;
use serde_json::{json, Value};
use support::FileLifecycleFixture;
use test_postgres::DisposablePostgres;
use uuid::Uuid;

#[tokio::test]
#[ignore = "requires the repository-approved disposable loopback PostgreSQL test target"]
async fn setup_evidence_denials_precede_journal_and_collection_effects() {
    let database = DisposablePostgres::from_projection_env().await;
    let fixture = FileLifecycleFixture::new(database.url()).await;
    let (evidence, evidence_b, exact, key) =
        fixture::setup_evidence_revisions(fixture.collection_id);
    let replica_id = Uuid::new_v4();
    let token = format!("setup-evidence-{}", Uuid::new_v4());
    let policy = RegisterReplica {
        replica_id,
        name: "setup evidence".into(),
        purpose: ReplicaPurpose::Application,
        mode: SyncReplicaMode::ReadWrite,
        allowed_types: vec![],
        contract_scope: vec![],
        full_collection: true,
        allowed_operations: vec![
            "assess_collection_setup".into(),
            "apply_collection_setup".into(),
        ],
        operation_transport_protocol: Some(3),
        operation_transport_recovery_protocols: vec![2],
        file_capability: None,
        allowed_origin: Some("null".into()),
        proof_public_key: Some(key),
        grant_id: Some(Uuid::new_v4()),
        application_declaration_id: Some("dev.mdbase.fixture".into()),
        application_declaration_digest: Some(exact["declaration_digest"].as_str().unwrap().into()),
        application_setup_evidence: Some(evidence.clone()),
        token: token.clone(),
        token_ttl_seconds: None,
    };
    let denied = fixture
        .provider
        .register_application_replica_v2(fixture.collection_id, policy.clone())
        .await
        .unwrap_err();
    assert_eq!(denied.code, "application_authorization_issuance_disabled");
    let absent: i64 =
        sqlx::query_scalar("SELECT count(*) FROM hosted_provider_replicas WHERE id=$1")
            .bind(replica_id)
            .fetch_one(&fixture.pool)
            .await
            .unwrap();
    assert_eq!(absent, 0);
    fixture::seed_committed_v2(&fixture.pool, fixture.collection_id, &policy).await;
    fixture
        .provider
        .register_application_replica_v2(fixture.collection_id, policy.clone())
        .await
        .unwrap(); // idempotency
    let update = json!({
        "grant_id": policy.grant_id, "mode":"read_write", "full_collection":true,
        "allowed_operations":policy.allowed_operations, "operation_transport_protocol":3,
        "operation_transport_recovery_protocols":[2], "allowed_origin":"null", "proof_public_key":policy.proof_public_key,
        "application_declaration_id":policy.application_declaration_id,
        "application_declaration_digest":policy.application_declaration_digest,
        "application_setup_evidence":evidence
    });
    fixture
        .provider
        .update_application_replica_v2(replica_id, serde_json::from_value(update.clone()).unwrap())
        .await
        .unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let internal_token = "internal-setup-test-token-".repeat(2);
    let state =
        mdbase_connect_hosted_provider::AppState::new(fixture.provider.clone(), &internal_token)
            .unwrap();
    let server = tokio::spawn(async move {
        axum::serve(listener, mdbase_connect_hosted_provider::app(state))
            .await
            .unwrap()
    });
    let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
    let client = reqwest::Client::new();
    let url = format!("http://{address}/internal/v2/replicas/{replica_id}/policy");
    let mut missing = update.clone();
    missing
        .as_object_mut()
        .unwrap()
        .remove("application_setup_evidence");
    let denied = client
        .patch(&url)
        .bearer_auth(&internal_token)
        .json(&missing)
        .send()
        .await
        .unwrap();
    assert_eq!(denied.status(), reqwest::StatusCode::FORBIDDEN);
    let accepted = client
        .patch(&url)
        .bearer_auth(&internal_token)
        .json(&update)
        .send()
        .await
        .unwrap();
    assert_eq!(accepted.status(), reqwest::StatusCode::NO_CONTENT);
    let mut registration = update.clone();
    registration["replica_id"] = json!(replica_id);
    registration["name"] = json!("setup evidence");
    registration["purpose"] = json!("application");
    registration["token"] = json!(token);
    let accepted = client
        .post(format!(
            "http://{address}/internal/v2/collections/{}/replicas",
            fixture.collection_id
        ))
        .bearer_auth(&internal_token)
        .json(&registration)
        .send()
        .await
        .unwrap();
    assert_eq!(accepted.status(), reqwest::StatusCode::CREATED);
    let mut fresh = registration.clone();
    fresh["replica_id"] = json!(Uuid::new_v4());
    let before_denials: Value = sqlx::query_scalar(
        "SELECT jsonb_build_array(head, encode(resources_ciphertext,'hex'), (SELECT count(*) FROM hosted_provider_mutation_journal), (SELECT count(*) FROM hosted_provider_replicas), (SELECT count(*) FROM hosted_provider_retired_replay_credentials)) FROM hosted_provider_collections WHERE id=$1"
    ).bind(fixture.collection_id).fetch_one(&fixture.pool).await.unwrap();
    let denied = client
        .post(format!(
            "http://{address}/internal/v2/collections/{}/replicas",
            fixture.collection_id
        ))
        .bearer_auth(&internal_token)
        .json(&fresh)
        .send()
        .await
        .unwrap();
    assert_eq!(denied.status(), reqwest::StatusCode::FORBIDDEN);
    for (field, value) in [
        ("grant_id", json!(Uuid::new_v4())),
        ("allowed_origin", json!("https://changed.example")),
        (
            "allowed_operations",
            json!(["assess_collection_setup", "apply_collection_setup", "read"]),
        ),
    ] {
        let mut expanded = update.clone();
        expanded[field] = value;
        let denied = fixture
            .provider
            .update_application_replica_v2(replica_id, serde_json::from_value(expanded).unwrap())
            .await
            .unwrap_err();
        assert_eq!(denied.code, "application_authorization_issuance_disabled");
    }
    let after_denials: Value = sqlx::query_scalar(
        "SELECT jsonb_build_array(head, encode(resources_ciphertext,'hex'), (SELECT count(*) FROM hosted_provider_mutation_journal), (SELECT count(*) FROM hosted_provider_replicas), (SELECT count(*) FROM hosted_provider_retired_replay_credentials)) FROM hosted_provider_collections WHERE id=$1"
    ).bind(fixture.collection_id).fetch_one(&fixture.pool).await.unwrap();
    assert_eq!(
        before_denials, after_denials,
        "issuance denial has no durable effects"
    );
    // Revocation of an otherwise byte-exact retained identity must not resurrect it.
    let mut revoked_policy = policy.clone();
    revoked_policy.replica_id = Uuid::new_v4();
    revoked_policy.grant_id = Some(Uuid::new_v4());
    revoked_policy.token = format!("revoked-fixture-{}", Uuid::new_v4());
    fixture::seed_committed_v2(&fixture.pool, fixture.collection_id, &revoked_policy).await;
    fixture
        .provider
        .revoke_replica(revoked_policy.replica_id)
        .await
        .unwrap();
    assert!(fixture
        .provider
        .register_application_replica_v2(fixture.collection_id, revoked_policy)
        .await
        .is_err());
    let before_policy: Value =
        sqlx::query_scalar("SELECT to_jsonb(r) FROM hosted_provider_replicas r WHERE id=$1")
            .bind(replica_id)
            .fetch_one(&fixture.pool)
            .await
            .unwrap();
    for body in [&missing, &update] {
        let denied = client
            .patch(format!(
                "http://{address}/internal/v1/replicas/{replica_id}/policy"
            ))
            .bearer_auth(&internal_token)
            .json(body)
            .send()
            .await
            .unwrap();
        assert_eq!(denied.status(), reqwest::StatusCode::FORBIDDEN);
    }
    registration
        .as_object_mut()
        .unwrap()
        .remove("application_setup_evidence");
    let denied = client
        .post(format!(
            "http://{address}/internal/v1/collections/{}/replicas",
            fixture.collection_id
        ))
        .bearer_auth(&internal_token)
        .json(&registration)
        .send()
        .await
        .unwrap();
    assert_eq!(denied.status(), reqwest::StatusCode::FORBIDDEN);
    let after_policy: Value =
        sqlx::query_scalar("SELECT to_jsonb(r) FROM hosted_provider_replicas r WHERE id=$1")
            .bind(replica_id)
            .fetch_one(&fixture.pool)
            .await
            .unwrap();
    assert_eq!(
        before_policy, after_policy,
        "v1 cannot mutate v2 policy or epoch"
    );

    // The old endpoint installs an explicit historical version using exactly
    // its original policy fields, without v2 evidence or a caller discriminator.
    let legacy_id = Uuid::new_v4();
    let legacy_token = format!("legacy-setup-{}", Uuid::new_v4());
    registration["grant_id"] = json!(Uuid::new_v4());
    registration["name"] = json!("legacy setup evidence");
    registration["replica_id"] = json!(legacy_id);
    registration["token"] = json!(legacy_token);
    for _ in 0..2 {
        let accepted = client
            .post(format!(
                "http://{address}/internal/v1/collections/{}/replicas",
                fixture.collection_id
            ))
            .bearer_auth(&internal_token)
            .json(&registration)
            .send()
            .await
            .unwrap();
        assert_eq!(accepted.status(), reqwest::StatusCode::CREATED);
    }
    let version: i32 = sqlx::query_scalar(
        "SELECT application_semantic_version FROM hosted_provider_replicas WHERE id=$1",
    )
    .bind(legacy_id)
    .fetch_one(&fixture.pool)
    .await
    .unwrap();
    assert_eq!(version, 1);
    let mut promotion = update.clone();
    promotion["grant_id"] = registration["grant_id"].clone();
    let denied = fixture
        .provider
        .update_application_replica_v2(legacy_id, serde_json::from_value(promotion).unwrap())
        .await
        .unwrap_err();
    assert_eq!(denied.code, "application_authorization_issuance_disabled");
    let mut legacy_input = exact.clone();
    legacy_input["requirements"]["configuration"][0]["value"] = json!("legacy-original-semantics");
    legacy_input["provisions"]["configuration"][0]["value"] = json!("legacy-original-semantics");
    let legacy_assessment = fixture
        .provider
        .operation(
            fixture.collection_id,
            &legacy_token,
            "assess_collection_setup",
            Uuid::new_v4(),
            legacy_input.clone(),
            Some("null"),
        )
        .await
        .unwrap();
    assert_eq!(legacy_assessment["valid"], true);
    for (key, result) in [
        ("expected_assessment_digest", "assessment_digest"),
        ("expected_collection_revision", "collection_revision"),
        ("expected_provision_digest", "provision_digest"),
    ] {
        legacy_input[key] = legacy_assessment["result"][result].clone();
    }
    let legacy_request = Uuid::new_v4();
    let applied = fixture
        .provider
        .operation(
            fixture.collection_id,
            &legacy_token,
            "apply_collection_setup",
            legacy_request,
            legacy_input.clone(),
            Some("null"),
        )
        .await
        .unwrap();
    assert_eq!(applied["valid"], true);
    let replay = fixture
        .provider
        .operation(
            fixture.collection_id,
            &legacy_token,
            "apply_collection_setup",
            legacy_request,
            legacy_input,
            Some("null"),
        )
        .await
        .unwrap();
    assert_eq!(replay, applied);
    server.abort();
    let mut tampered_update = update.clone();
    tampered_update["application_setup_evidence"]["application_authorization"]["signature"] =
        json!("bad");
    assert!(fixture
        .provider
        .update_application_replica_v2(replica_id, serde_json::from_value(tampered_update).unwrap())
        .await
        .is_err());
    let before: (i64, Vec<u8>) = sqlx::query_as(
        "SELECT head, resources_ciphertext FROM hosted_provider_collections WHERE id=$1",
    )
    .bind(fixture.collection_id)
    .fetch_one(&fixture.pool)
    .await
    .unwrap();
    let mut changed = exact.clone();
    changed["provisions"]["configuration"][0]["value"] = json!("escalated");
    let mut unknown = exact.clone();
    unknown["caller_proof"] = evidence.clone();
    let mut nested = exact.clone();
    nested["setup"] = exact.clone();
    let mut choice = exact.clone();
    choice["allow_type_pack_downgrades"] = json!(["undeclared"]);
    let mut discriminator = exact.clone();
    discriminator["application_semantic_version"] = json!(1);
    for input in [changed, unknown, nested, choice, discriminator] {
        for op in ["assess_collection_setup", "apply_collection_setup"] {
            assert!(fixture
                .provider
                .operation(
                    fixture.collection_id,
                    &token,
                    op,
                    Uuid::new_v4(),
                    input.clone(),
                    Some("null")
                )
                .await
                .is_err());
        }
    }
    for installed in [
        None,
        Some(Value::Null),
        Some({
            let mut e = evidence.clone();
            e["application_authorization"]["signature"] = json!("bad");
            e
        }),
    ] {
        sqlx::query(
            "UPDATE hosted_provider_replicas SET application_setup_evidence=$2 WHERE id=$1",
        )
        .bind(replica_id)
        .bind(installed)
        .execute(&fixture.pool)
        .await
        .unwrap();
        for op in ["assess_collection_setup", "apply_collection_setup"] {
            assert!(fixture
                .provider
                .operation(
                    fixture.collection_id,
                    &token,
                    op,
                    Uuid::new_v4(),
                    exact.clone(),
                    Some("null")
                )
                .await
                .is_err());
        }
    }
    sqlx::query("UPDATE hosted_provider_replicas SET application_setup_evidence=$2, proof_public_key=NULL WHERE id=$1")
        .bind(replica_id).bind(evidence.clone()).execute(&fixture.pool).await.unwrap();
    for op in ["assess_collection_setup", "apply_collection_setup"] {
        assert!(fixture
            .provider
            .operation(
                fixture.collection_id,
                &token,
                op,
                Uuid::new_v4(),
                exact.clone(),
                Some("null")
            )
            .await
            .is_err());
    }
    sqlx::query("UPDATE hosted_provider_replicas SET proof_public_key=$2 WHERE id=$1")
        .bind(replica_id)
        .bind(policy.proof_public_key.clone())
        .execute(&fixture.pool)
        .await
        .unwrap();
    let after: (i64, Vec<u8>) = sqlx::query_as(
        "SELECT head, resources_ciphertext FROM hosted_provider_collections WHERE id=$1",
    )
    .bind(fixture.collection_id)
    .fetch_one(&fixture.pool)
    .await
    .unwrap();
    assert_eq!(before, after);
    let journal: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM hosted_provider_mutation_journal WHERE replica_id=$1",
    )
    .bind(replica_id)
    .fetch_one(&fixture.pool)
    .await
    .unwrap();
    assert_eq!(journal, 0);
    sqlx::query("UPDATE hosted_provider_replicas SET application_setup_evidence=$2 WHERE id=$1")
        .bind(replica_id)
        .bind(evidence)
        .execute(&fixture.pool)
        .await
        .unwrap();
    let assessment = fixture
        .provider
        .operation(
            fixture.collection_id,
            &token,
            "assess_collection_setup",
            Uuid::new_v4(),
            exact.clone(),
            Some("null"),
        )
        .await
        .unwrap();
    assert_eq!(assessment["valid"], true, "{assessment}");
    let mut apply = exact;
    for (input_key, result_key) in [
        ("expected_assessment_digest", "assessment_digest"),
        ("expected_collection_revision", "collection_revision"),
        ("expected_provision_digest", "provision_digest"),
    ] {
        apply[input_key] = assessment["result"][result_key].clone();
    }
    let request_r = Uuid::new_v4();
    let applied = fixture
        .provider
        .operation(
            fixture.collection_id,
            &token,
            "apply_collection_setup",
            request_r,
            apply.clone(),
            Some("null"),
        )
        .await
        .unwrap();
    assert_eq!(applied["valid"], true, "{applied}");

    // A terminal receipt belongs to the exact request, not to today's declaration.
    // Valid B is fresh issuance and must be denied by the real policy API.
    // A test-only precommitted B fixture retains historical receipt coverage.
    let mut update_b = update.clone();
    update_b["application_declaration_digest"] = json!(format!(
        "sha256:{}",
        evidence_b["application_authorization"]["binding"]["application_manifest_digest"]
            .as_str()
            .unwrap()
    ));
    update_b["application_setup_evidence"] = evidence_b;
    fixture
        .provider
        .update_application_replica_v2(
            replica_id,
            serde_json::from_value(update_b.clone()).unwrap(),
        )
        .await
        .unwrap_err();
    fixture::seed_committed_v2_declaration(&fixture.pool, replica_id, &update_b).await;
    let committed: (i64, Vec<u8>) = sqlx::query_as(
        "SELECT head, resources_ciphertext FROM hosted_provider_collections WHERE id=$1",
    )
    .bind(fixture.collection_id)
    .fetch_one(&fixture.pool)
    .await
    .unwrap();
    assert!(
        committed.0 > before.0,
        "A actually committed a collection effect"
    );
    let replay = fixture
        .provider
        .operation(
            fixture.collection_id,
            &token,
            "apply_collection_setup",
            request_r,
            apply.clone(),
            Some("null"),
        )
        .await
        .unwrap();
    assert_eq!(
        replay, applied,
        "B must not prevent recovery of A's exact receipt"
    );
    let denied = fixture
        .provider
        .operation(
            fixture.collection_id,
            &token,
            "apply_collection_setup",
            Uuid::new_v4(),
            apply.clone(),
            Some("null"),
        )
        .await
        .unwrap_err();
    assert_eq!(denied.code, "application_declaration_mismatch");
    let mut conflicting = apply.clone();
    conflicting["provisions"]["configuration"][0]["value"] = json!("conflicting-body");
    let denied = fixture
        .provider
        .operation(
            fixture.collection_id,
            &token,
            "apply_collection_setup",
            request_r,
            conflicting.clone(),
            Some("null"),
        )
        .await
        .unwrap_err();
    assert_eq!(denied.code, "mutation_request_conflict");
    let journal: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM hosted_provider_mutation_journal WHERE replica_id=$1",
    )
    .bind(replica_id)
    .fetch_one(&fixture.pool)
    .await
    .unwrap();
    assert_eq!(journal, 1, "denied fresh A creates no journal entry");

    // Exercise production compaction instead of manufacturing a tombstone row.
    sqlx::query("UPDATE hosted_provider_mutation_journal SET completed_at=now()-interval '181 days' WHERE replica_id=$1 AND request_id=$2")
        .bind(replica_id).bind(request_r).execute(&fixture.pool).await.unwrap();
    assert_eq!(
        fixture
            .provider
            .compact_operation_mutations()
            .await
            .unwrap(),
        1
    );
    for (body, expected) in [
        (apply, "mutation_recovery_expired"),
        (conflicting, "mutation_request_conflict"),
    ] {
        let denied = fixture
            .provider
            .operation(
                fixture.collection_id,
                &token,
                "apply_collection_setup",
                request_r,
                body,
                Some("null"),
            )
            .await
            .unwrap_err();
        assert_eq!(denied.code, expected);
    }
    let after_recovery: (i64, Vec<u8>) = sqlx::query_as(
        "SELECT head, resources_ciphertext FROM hosted_provider_collections WHERE id=$1",
    )
    .bind(fixture.collection_id)
    .fetch_one(&fixture.pool)
    .await
    .unwrap();
    assert_eq!(
        after_recovery, committed,
        "recovery and denials create no new collection effects"
    );
    let journal: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM hosted_provider_mutation_journal WHERE replica_id=$1",
    )
    .bind(replica_id)
    .fetch_one(&fixture.pool)
    .await
    .unwrap();
    assert_eq!(
        journal, 0,
        "tombstone responses must not re-journal the request"
    );

    // Retained authority can genuinely narrow, but cannot re-expand or resurrect.
    let mut narrowing = update_b;
    narrowing["allowed_operations"] = json!(["assess_collection_setup"]);
    narrowing["mode"] = json!("read_only");
    fixture
        .provider
        .update_application_replica_v2(
            replica_id,
            serde_json::from_value(narrowing.clone()).unwrap(),
        )
        .await
        .unwrap();
    narrowing["allowed_operations"] = json!(["assess_collection_setup", "apply_collection_setup"]);
    narrowing["mode"] = json!("read_write");
    let denied = fixture
        .provider
        .update_application_replica_v2(replica_id, serde_json::from_value(narrowing).unwrap())
        .await
        .unwrap_err();
    assert_eq!(denied.code, "application_authorization_issuance_disabled");
    fixture.provider.revoke_replica(replica_id).await.unwrap();
    assert!(fixture
        .provider
        .register_application_replica_v2(fixture.collection_id, policy.clone())
        .await
        .is_err());

    // Rehearse the additive migration against a historical schema; it explicitly
    // establishes v1, while preserving every predecessor policy field.
    let mut migration = fixture.pool.begin().await.unwrap();
    sqlx::query("ALTER TABLE hosted_provider_replicas DROP COLUMN application_semantic_version")
        .execute(&mut *migration)
        .await
        .unwrap();
    let historical: Value =
        sqlx::query_scalar("SELECT to_jsonb(r) FROM hosted_provider_replicas r WHERE id=$1")
            .bind(legacy_id)
            .fetch_one(&mut *migration)
            .await
            .unwrap();
    sqlx::raw_sql(include_str!(
        "../migrations/0040_application_semantic_version.sql"
    ))
    .execute(&mut *migration)
    .await
    .unwrap();
    let migrated: Value = sqlx::query_scalar("SELECT to_jsonb(r) - 'application_semantic_version' FROM hosted_provider_replicas r WHERE id=$1 AND application_semantic_version=1")
        .bind(legacy_id).fetch_one(&mut *migration).await.unwrap();
    assert_eq!(historical, migrated);
    let bad_mirrors: i64 = sqlx::query_scalar("SELECT count(*) FROM hosted_provider_replicas WHERE purpose='mirror' AND application_semantic_version IS NOT NULL")
        .fetch_one(&mut *migration).await.unwrap();
    assert_eq!(bad_mirrors, 0);
    migration.rollback().await.unwrap();

    // Restore active historical state solely for decoder fault injection below.
    sqlx::query("UPDATE hosted_provider_replicas SET revoked_at=NULL, mode='read_write', allowed_operations=$2 WHERE id=$1").bind(replica_id).bind(&policy.allowed_operations).execute(&fixture.pool).await.unwrap();
    // Fault injection: even if database validation is bypassed, missing/unknown
    // persisted semantics cannot become an unsigned setup fallback.
    sqlx::query(
        "ALTER TABLE hosted_provider_replicas DROP CONSTRAINT application_semantic_version_valid",
    )
    .execute(&fixture.pool)
    .await
    .unwrap();
    for version in [None, Some(0), Some(3)] {
        sqlx::query(
            "UPDATE hosted_provider_replicas SET application_semantic_version=$2 WHERE id=$1",
        )
        .bind(replica_id)
        .bind(version)
        .execute(&fixture.pool)
        .await
        .unwrap();
        for operation in ["assess_collection_setup", "apply_collection_setup"] {
            let denied = fixture
                .provider
                .operation(
                    fixture.collection_id,
                    &token,
                    operation,
                    Uuid::new_v4(),
                    json!({"application_semantic_version":1}),
                    Some("null"),
                )
                .await
                .unwrap_err();
            assert_eq!(denied.code, "application_declaration_mismatch");
        }
    }
}
