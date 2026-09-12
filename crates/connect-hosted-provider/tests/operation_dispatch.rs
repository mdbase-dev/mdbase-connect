#![allow(dead_code, unused_imports)]

mod support;
#[path = "support/test_postgres.rs"]
mod test_postgres;

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use chrono::Utc;
use mdbase_connect_hosted_provider::{app, AppState, RegisterReplica, ReplicaPurpose};
use mdbase_connect_protocol::{
    ListFilesRequest, ListFilesRequestKind, SyncMutation, SyncMutationOperation,
    SyncMutationReceipt, SyncReplicaMode, AUTHORITY_PROOF_DOMAIN, AUTHORITY_PROOF_NONCE_HEADER,
    AUTHORITY_PROOF_SIGNATURE_HEADER, AUTHORITY_PROOF_TIMESTAMP_HEADER, AUTHORITY_PROOF_VERSION,
    AUTHORITY_PROOF_VERSION_HEADER, FILE_PROTOCOL_VERSION,
};
use p256::ecdsa::{signature::Signer, Signature, SigningKey};
use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION, ORIGIN};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::Row;
use support::FileLifecycleFixture;
use test_postgres::DisposablePostgres;
use uuid::Uuid;

fn signed_application_headers(
    signing_key: &SigningKey,
    token: &str,
    method: &str,
    target: &str,
    body: &[u8],
) -> HeaderMap {
    let timestamp = Utc::now().timestamp();
    let nonce = Uuid::new_v4();
    let message = [
        AUTHORITY_PROOF_DOMAIN.to_string(),
        AUTHORITY_PROOF_VERSION.to_string(),
        method.to_uppercase(),
        target.to_string(),
        URL_SAFE_NO_PAD.encode(Sha256::digest(body)),
        URL_SAFE_NO_PAD.encode(Sha256::digest(token.as_bytes())),
        timestamp.to_string(),
        nonce.to_string(),
    ]
    .join("\n");
    let signature: Signature = signing_key.sign(message.as_bytes());
    let mut headers = HeaderMap::new();
    headers.insert(
        AUTHORIZATION,
        HeaderValue::from_str(&format!("Bearer {token}")).unwrap(),
    );
    headers.insert(ORIGIN, HeaderValue::from_static("https://tasks.example"));
    headers.insert(
        AUTHORITY_PROOF_VERSION_HEADER,
        HeaderValue::from_str(&AUTHORITY_PROOF_VERSION.to_string()).unwrap(),
    );
    headers.insert(
        AUTHORITY_PROOF_TIMESTAMP_HEADER,
        HeaderValue::from_str(&timestamp.to_string()).unwrap(),
    );
    headers.insert(
        AUTHORITY_PROOF_NONCE_HEADER,
        HeaderValue::from_str(&nonce.to_string()).unwrap(),
    );
    headers.insert(
        AUTHORITY_PROOF_SIGNATURE_HEADER,
        HeaderValue::from_str(&URL_SAFE_NO_PAD.encode(signature.to_bytes())).unwrap(),
    );
    headers
}

async fn replace_completed_effect_with_legacy_semantic_none(
    fixture: &FileLifecycleFixture,
    replica_id: Uuid,
    request_id: Uuid,
) {
    let row = sqlx::query(
        r#"SELECT journal.evidence_ciphertext, collection.wrapped_data_key
           FROM hosted_provider_mutation_journal journal
           JOIN hosted_provider_replicas replica ON replica.id = journal.replica_id
           JOIN hosted_provider_collections collection ON collection.id = replica.collection_id
           WHERE journal.replica_id = $1 AND journal.request_id = $2"#,
    )
    .bind(replica_id)
    .bind(request_id)
    .fetch_one(&fixture.pool)
    .await
    .unwrap();
    let data_key = fixture
        .crypto
        .unwrap_data_key(row.get("wrapped_data_key"), fixture.collection_id)
        .await
        .unwrap();
    let aad = format!("hosted-provider/sync-effect/v1/{replica_id}/{request_id}").into_bytes();
    let mut effect: Value = fixture
        .crypto
        .decrypt_json(
            &data_key,
            &row.get::<Vec<u8>, _>("evidence_ciphertext"),
            &aad,
        )
        .unwrap();
    assert!(effect.get("semantic_result").is_some());
    effect["semantic_result"] = Value::Null;
    let ciphertext = fixture
        .crypto
        .encrypt_json(&data_key, &effect, &aad)
        .unwrap();
    sqlx::query(
        r#"UPDATE hosted_provider_mutation_journal
           SET state = 'applied', evidence_ciphertext = $3, evidence_kind = 'sync_effect',
               final_receipt_ciphertext = NULL, receipt_digest = NULL, completed_at = NULL,
               lease_expires_at = now() - interval '1 second'
           WHERE replica_id = $1 AND request_id = $2"#,
    )
    .bind(replica_id)
    .bind(request_id)
    .bind(ciphertext)
    .execute(&fixture.pool)
    .await
    .unwrap();
}

#[tokio::test]
#[ignore = "requires the repository-approved disposable loopback PostgreSQL test target"]
async fn retired_application_credentials_replay_only_exact_terminal_mutations() {
    let database = DisposablePostgres::from_projection_env().await;
    let database_url = database.url().to_string();
    let fixture = FileLifecycleFixture::new(&database_url).await;
    let replica_id = Uuid::now_v7();
    let token = format!("retired-application-{}-{}", Uuid::new_v4(), Uuid::new_v4());
    let signing_key = SigningKey::random(&mut rand_core::OsRng);
    let public_key = URL_SAFE_NO_PAD.encode(
        signing_key
            .verifying_key()
            .to_encoded_point(false)
            .as_bytes(),
    );
    fixture
        .provider
        .register_replica(
            fixture.collection_id,
            RegisterReplica {
                replica_id,
                name: "Retired application replay".to_string(),
                application_setup_evidence: None,
                purpose: ReplicaPurpose::Application,
                mode: SyncReplicaMode::ReadWrite,
                allowed_types: Vec::new(),
                contract_scope: Vec::new(),
                full_collection: true,
                allowed_operations: vec![
                    "changes".to_string(),
                    "create".to_string(),
                    "query".to_string(),
                ],
                operation_transport_protocol: Some(3),
                operation_transport_recovery_protocols: vec![2],
                file_capability: None,
                allowed_origin: Some("https://tasks.example".to_string()),
                proof_public_key: Some(public_key),
                grant_id: Some(Uuid::new_v4()),
                application_declaration_id: None,
                application_declaration_digest: None,
                token: token.clone(),
                token_ttl_seconds: Some(3600),
            },
        )
        .await
        .expect("canonical application replica is registered");

    sqlx::query(
        r#"UPDATE hosted_provider_runtime_control
           SET query_admission_suspended = true,
               admission_fence_token = $1,
               admission_fence_kind = 'rollback',
               admission_lease_expires_at = NULL,
               admission_owner_expires_at = NULL"#,
    )
    .bind(Uuid::new_v4())
    .execute(&fixture.pool)
    .await
    .unwrap();
    let unrelated_invocation_id = Uuid::new_v4();
    sqlx::query(
        r#"INSERT INTO hosted_provider_base_query_invocations (
             invocation_id, collection_id, replica_id, scope_epoch, base_plan,
             base_context, base_operation_clock, hard_expires_at
           )
           SELECT $1, collection_id, id, scope_epoch, '{}'::jsonb,
                  NULL, 'test', now() - interval '1 minute'
           FROM hosted_provider_replicas
           WHERE id = $2"#,
    )
    .bind(unrelated_invocation_id)
    .bind(replica_id)
    .execute(&fixture.pool)
    .await
    .unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let state = AppState::new(fixture.provider.clone(), &"internal-test-token-".repeat(2)).unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, app(state)).await.unwrap() });
    let query_target = format!("/v1/authorities/{}/operations/query", fixture.collection_id);
    let cursor_body = serde_json::to_vec(&json!({
        "protocol_version": 3,
        "request_id": Uuid::now_v7(),
        "input": {"release_cursor": format!("hq1.{}", URL_SAFE_NO_PAD.encode(Uuid::new_v4().as_bytes()))}
    }))
    .unwrap();
    let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
    let cursor_release = reqwest::Client::new()
        .post(format!("http://{address}{query_target}"))
        .headers(signed_application_headers(
            &signing_key,
            &token,
            "POST",
            &query_target,
            &cursor_body,
        ))
        .header("content-type", "application/json")
        .body(cursor_body)
        .send()
        .await
        .unwrap();
    assert_eq!(cursor_release.status(), reqwest::StatusCode::OK);
    let unrelated_invocation_remains: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM hosted_provider_base_query_invocations WHERE invocation_id = $1)",
    )
    .bind(unrelated_invocation_id)
    .fetch_one(&fixture.pool)
    .await
    .unwrap();
    assert!(
        unrelated_invocation_remains,
        "cursor cleanup does not perform opportunistic maintenance"
    );
    let conflicting_body = serde_json::to_vec(&json!({
        "protocol_version": 3,
        "request_id": Uuid::now_v7(),
        "input": {
            "release_cursor": format!("hq1.{}", URL_SAFE_NO_PAD.encode(Uuid::new_v4().as_bytes())),
            "cursor": "conflicting"
        }
    }))
    .unwrap();
    let conflicting_release = reqwest::Client::new()
        .post(format!("http://{address}{query_target}"))
        .headers(signed_application_headers(
            &signing_key,
            &token,
            "POST",
            &query_target,
            &conflicting_body,
        ))
        .header("content-type", "application/json")
        .body(conflicting_body)
        .send()
        .await
        .unwrap();
    assert_eq!(
        conflicting_release.status(),
        reqwest::StatusCode::SERVICE_UNAVAILABLE,
        "conflicting cursor inputs cannot bypass suspended admission"
    );
    let cursor_nonce_count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM hosted_provider_request_proofs WHERE replica_id = $1",
    )
    .bind(replica_id)
    .fetch_one(&fixture.pool)
    .await
    .unwrap();
    assert_eq!(
        cursor_nonce_count, 0,
        "cursor cleanup consumes no proof nonce"
    );
    server.abort();
    sqlx::query(
        r#"UPDATE hosted_provider_runtime_control
           SET query_admission_suspended = false,
               admission_fence_token = NULL,
               admission_fence_kind = NULL,
               admission_lease_expires_at = NULL,
               admission_owner_expires_at = NULL"#,
    )
    .execute(&fixture.pool)
    .await
    .unwrap();

    let request_id = Uuid::now_v7();
    let input = json!({"path": "retired/exact.md", "frontmatter": {"title": "Exact"}});
    let receipt = fixture
        .provider
        .operation(
            fixture.collection_id,
            &token,
            "create",
            request_id,
            input.clone(),
            Some("https://tasks.example"),
        )
        .await
        .expect("terminal mutation is recorded before retirement");

    let expired_replica_id = Uuid::now_v7();
    let expired_token = format!("expired-application-{}-{}", Uuid::new_v4(), Uuid::new_v4());
    fixture
        .provider
        .register_replica(
            fixture.collection_id,
            RegisterReplica {
                replica_id: expired_replica_id,
                name: "Expired application replay".to_string(),
                application_setup_evidence: None,
                purpose: ReplicaPurpose::Application,
                mode: SyncReplicaMode::ReadWrite,
                allowed_types: Vec::new(),
                contract_scope: Vec::new(),
                full_collection: true,
                allowed_operations: vec!["create".to_string()],
                operation_transport_protocol: Some(3),
                operation_transport_recovery_protocols: vec![2],
                file_capability: None,
                allowed_origin: Some("https://tasks.example".to_string()),
                proof_public_key: Some(
                    URL_SAFE_NO_PAD.encode(
                        signing_key
                            .verifying_key()
                            .to_encoded_point(false)
                            .as_bytes(),
                    ),
                ),
                grant_id: Some(Uuid::new_v4()),
                application_declaration_id: None,
                application_declaration_digest: None,
                token: expired_token.clone(),
                token_ttl_seconds: Some(3600),
            },
        )
        .await
        .expect("soon-expired application replica is registered");
    let expired_request_id = Uuid::now_v7();
    let expired_input = json!({
        "path": "retired/expired.md",
        "frontmatter": {"title": "Expired"}
    });
    fixture
        .provider
        .operation(
            fixture.collection_id,
            &expired_token,
            "create",
            expired_request_id,
            expired_input.clone(),
            Some("https://tasks.example"),
        )
        .await
        .expect("terminal mutation is recorded before the scoped token expires");

    sqlx::query(
        r#"UPDATE hosted_provider_replicas
           SET full_collection = false, allowed_types = ARRAY['task']::text[]
           WHERE id = $1"#,
    )
    .bind(replica_id)
    .execute(&fixture.pool)
    .await
    .unwrap();
    sqlx::query(
        r#"UPDATE hosted_provider_replicas
           SET full_collection = false, token_expires_at = now() - interval '1 second'
           WHERE id = $1"#,
    )
    .bind(expired_replica_id)
    .execute(&fixture.pool)
    .await
    .unwrap();
    sqlx::raw_sql(include_str!(
        "../migrations/0038_collection_level_application_authorization.sql"
    ))
    .execute(&fixture.pool)
    .await
    .expect("migration 38 retires scoped credentials");
    let expired_archives: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM hosted_provider_retired_replay_credentials WHERE replica_id = $1",
    )
    .bind(expired_replica_id)
    .fetch_one(&fixture.pool)
    .await
    .unwrap();
    assert_eq!(expired_archives, 0, "expired scoped token is not archived");

    let live_authorization = fixture
        .provider
        .authorize_request(
            fixture.collection_id,
            &token,
            Some("https://tasks.example"),
            None,
        )
        .await
        .expect_err("retired credentials cannot authorize live requests");
    assert_eq!(live_authorization.code, "invalid_replica_token");

    for error in [
        fixture
            .provider
            .open_session(fixture.collection_id, &token, Some("https://tasks.example"))
            .await
            .unwrap_err(),
        fixture
            .provider
            .snapshot(
                fixture.collection_id,
                &token,
                Uuid::new_v4(),
                None,
                Some("https://tasks.example"),
            )
            .await
            .unwrap_err(),
        fixture
            .provider
            .changes(
                fixture.collection_id,
                &token,
                0,
                1,
                Some("https://tasks.example"),
            )
            .await
            .unwrap_err(),
        fixture
            .provider
            .list_files(
                fixture.collection_id,
                &token,
                ListFilesRequest {
                    protocol_version: FILE_PROTOCOL_VERSION,
                    message_type: ListFilesRequestKind::ListFiles,
                    folder: None,
                    after: None,
                    limit: Some(1),
                },
                Some("https://tasks.example"),
            )
            .await
            .unwrap_err(),
    ] {
        assert_eq!(error.code, "invalid_replica_token", "{error:?}");
    }

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let state = AppState::new(fixture.provider.clone(), &"internal-test-token-".repeat(2)).unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, app(state)).await.unwrap() });
    let target = format!(
        "/v1/authorities/{}/operations/create",
        fixture.collection_id
    );
    let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
    let client = reqwest::Client::new();

    let denied_body = serde_json::to_vec(&json!({
        "protocol_version": 3,
        "request_id": Uuid::now_v7(),
        "input": {"path": "retired/new.md", "frontmatter": {"title": "Denied"}}
    }))
    .unwrap();
    let denied = client
        .post(format!("http://{address}{target}"))
        .headers(signed_application_headers(
            &signing_key,
            &token,
            "POST",
            &target,
            &denied_body,
        ))
        .header("content-type", "application/json")
        .body(denied_body)
        .send()
        .await
        .unwrap();
    assert_eq!(denied.status(), reqwest::StatusCode::UNAUTHORIZED);
    let denied_problem: Value = denied.json().await.unwrap();
    assert_eq!(denied_problem["error"]["code"], "invalid_replica_token");
    let usage_after_denial: i64 =
        sqlx::query_scalar("SELECT count(*) FROM hosted_provider_protocol_usage")
            .fetch_one(&fixture.pool)
            .await
            .unwrap();
    assert_eq!(
        usage_after_denial, 0,
        "rejected retired replay creates no protocol usage state"
    );

    let expired_replay_body = serde_json::to_vec(&json!({
        "protocol_version": 3,
        "request_id": expired_request_id,
        "input": expired_input
    }))
    .unwrap();
    let expired_replay = client
        .post(format!("http://{address}{target}"))
        .bearer_auth(&expired_token)
        .header("content-type", "application/json")
        .body(expired_replay_body)
        .send()
        .await
        .unwrap();
    assert_eq!(expired_replay.status(), reqwest::StatusCode::UNAUTHORIZED);
    let expired_problem: Value = expired_replay.json().await.unwrap();
    assert_eq!(expired_problem["error"]["code"], "invalid_replica_token");

    let conflict_body = serde_json::to_vec(&json!({
        "protocol_version": 3,
        "request_id": request_id,
        "input": {"path": "retired/different.md", "frontmatter": {"title": "Different"}}
    }))
    .unwrap();
    let conflict = client
        .post(format!("http://{address}{target}"))
        .bearer_auth(&token)
        .header("content-type", "application/json")
        .body(conflict_body)
        .send()
        .await
        .unwrap();
    assert_eq!(conflict.status(), reqwest::StatusCode::CONFLICT);
    let conflict_problem: Value = conflict.json().await.unwrap();
    assert_eq!(
        conflict_problem["error"]["code"],
        "mutation_request_conflict"
    );

    let replay_body = serde_json::to_vec(&json!({
        "protocol_version": 3,
        "request_id": request_id,
        "input": input
    }))
    .unwrap();
    let replay = client
        .post(format!("http://{address}{target}"))
        .bearer_auth(&token)
        .header("content-type", "application/json")
        .body(replay_body)
        .send()
        .await
        .unwrap();
    assert_eq!(replay.status(), reqwest::StatusCode::OK);
    let replay: Value = replay.json().await.unwrap();
    assert_eq!(replay["result"], receipt);
    let usage_after_replay: i64 = sqlx::query_scalar(
        "SELECT COALESCE(sum(sample_count), 0)::bigint FROM hosted_provider_protocol_usage",
    )
    .fetch_one(&fixture.pool)
    .await
    .unwrap();
    assert_eq!(usage_after_replay, 1, "only exact replay records usage");
    server.abort();

    let proof_nonce_count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM hosted_provider_request_proofs WHERE replica_id = $1",
    )
    .bind(replica_id)
    .fetch_one(&fixture.pool)
    .await
    .unwrap();
    assert_eq!(
        proof_nonce_count, 0,
        "retired authorization persists no nonce"
    );
    let journal_count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM hosted_provider_mutation_journal WHERE replica_id = $1",
    )
    .bind(replica_id)
    .fetch_one(&fixture.pool)
    .await
    .unwrap();
    assert_eq!(
        journal_count, 1,
        "rejected live work creates no journal state"
    );
}

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
                application_setup_evidence: None,
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
                application_setup_evidence: None,
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

    let scoped_token = format!("malformed-link-collection-{}", Uuid::new_v4());
    fixture
        .provider
        .register_replica(
            fixture.collection_id,
            RegisterReplica {
                replica_id: Uuid::now_v7(),
                name: "Malformed link collection application".to_string(),
                application_setup_evidence: None,
                purpose: ReplicaPurpose::Application,
                mode: SyncReplicaMode::ReadWrite,
                allowed_types: Vec::new(),
                contract_scope: Vec::new(),
                full_collection: true,
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

        let repaired = fixture
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
        .unwrap();
    assert_eq!(denied["valid"], false, "{denied}");
    assert!(denied["diagnostics"].as_array().is_some_and(|items| {
        items
            .iter()
            .any(|item| item["code"] == "invalid_frontmatter")
    }));
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
                application_setup_evidence: None,
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

#[tokio::test]
#[ignore = "requires the repository-approved disposable loopback PostgreSQL test target"]
async fn legacy_record_effect_replay_is_exact_or_fails_closed_without_ambient_hydration() {
    let database = DisposablePostgres::from_projection_env().await;
    let database_url = database.url().to_string();
    let fixture = FileLifecycleFixture::new(&database_url).await;
    let replica_id = Uuid::now_v7();
    let token = format!("legacy-effect-{}-{}", Uuid::new_v4(), Uuid::new_v4());
    fixture
        .provider
        .register_replica(
            fixture.collection_id,
            RegisterReplica {
                replica_id,
                name: "Legacy effect replay application".to_string(),
                application_setup_evidence: None,
                purpose: ReplicaPurpose::Application,
                mode: SyncReplicaMode::ReadWrite,
                allowed_types: Vec::new(),
                contract_scope: Vec::new(),
                full_collection: true,
                allowed_operations: ["create", "update", "delete", "read"]
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

    // Exact legacy case: the durable input proves backlink diagnostics were
    // disabled, so their canonical omission is reconstructible byte-for-byte.
    fixture
        .provider
        .operation(
            fixture.collection_id,
            &token,
            "create",
            Uuid::now_v7(),
            json!({"path": "legacy/exact-delete.md", "frontmatter": {"title": "Exact"}}),
            None,
        )
        .await
        .unwrap();
    let exact_request = Uuid::now_v7();
    let exact_input = json!({"path": "legacy/exact-delete.md", "check_backlinks": false});
    let exact_first = fixture
        .provider
        .operation(
            fixture.collection_id,
            &token,
            "delete",
            exact_request,
            exact_input.clone(),
            None,
        )
        .await
        .unwrap();
    assert!(exact_first["result"].get("broken_links").is_none());
    replace_completed_effect_with_legacy_semantic_none(&fixture, replica_id, exact_request).await;
    let exact_replay = fixture
        .provider
        .operation(
            fixture.collection_id,
            &token,
            "delete",
            exact_request,
            exact_input,
            None,
        )
        .await
        .unwrap();
    assert_eq!(exact_replay, exact_first);

    // Backlink-aware delete receipts do not durably contain the exact
    // broken_links response and must not replay a fabricated success.
    for (path, body) in [
        ("legacy/backlink-target.md", "Target.\n"),
        ("legacy/backlink-source.md", "See [[backlink-target]].\n"),
    ] {
        fixture
            .provider
            .operation(
                fixture.collection_id,
                &token,
                "create",
                Uuid::now_v7(),
                json!({"path": path, "frontmatter": {"title": path}, "body": body}),
                None,
            )
            .await
            .unwrap();
    }
    let backlink_request = Uuid::now_v7();
    let backlink_input = json!({"path": "legacy/backlink-target.md", "check_backlinks": true});
    let backlink_first = fixture
        .provider
        .operation(
            fixture.collection_id,
            &token,
            "delete",
            backlink_request,
            backlink_input.clone(),
            None,
        )
        .await
        .unwrap();
    assert_ne!(backlink_first["result"]["broken_links"], json!([]));
    replace_completed_effect_with_legacy_semantic_none(&fixture, replica_id, backlink_request)
        .await;
    let backlink_error = fixture
        .provider
        .operation(
            fixture.collection_id,
            &token,
            "delete",
            backlink_request,
            backlink_input.clone(),
            None,
        )
        .await
        .unwrap_err();
    assert_eq!(backlink_error.code, "legacy_replay_evidence_missing");
    let deterministic = fixture
        .provider
        .operation(
            fixture.collection_id,
            &token,
            "delete",
            backlink_request,
            backlink_input,
            None,
        )
        .await
        .unwrap_err();
    assert_eq!(deterministic.code, "legacy_replay_evidence_missing");

    // A catalog/default change cannot legitimize reconstructing a create from
    // an unchanged current row.
    let create_request = Uuid::now_v7();
    let create_input = json!({
        "path": "legacy/catalog-stable.md",
        "frontmatter": {"title": "Catalog stable"},
        "include_document": true
    });
    fixture
        .provider
        .operation(
            fixture.collection_id,
            &token,
            "create",
            create_request,
            create_input.clone(),
            None,
        )
        .await
        .unwrap();
    replace_completed_effect_with_legacy_semantic_none(&fixture, replica_id, create_request).await;
    fixture
        .enable_obsidian_base_pattern("changed-defaults/**/*.base")
        .await;
    let create_error = fixture
        .provider
        .operation(
            fixture.collection_id,
            &token,
            "create",
            create_request,
            create_input,
            None,
        )
        .await
        .unwrap_err();
    assert_eq!(create_error.code, "legacy_replay_evidence_missing");

    // Replacing the committed row after an update also cannot supply missing
    // mutation-time fields, metadata, diagnostics, or catalog revision.
    let update_request = Uuid::now_v7();
    let update_input = json!({
        "path": "legacy/catalog-stable.md",
        "patch": {"title": "Original update"},
        "include_document": true
    });
    fixture
        .provider
        .operation(
            fixture.collection_id,
            &token,
            "update",
            update_request,
            update_input.clone(),
            None,
        )
        .await
        .unwrap();
    replace_completed_effect_with_legacy_semantic_none(&fixture, replica_id, update_request).await;
    fixture
        .provider
        .operation(
            fixture.collection_id,
            &token,
            "update",
            Uuid::now_v7(),
            json!({"path": "legacy/catalog-stable.md", "patch": {"title": "Replacement"}}),
            None,
        )
        .await
        .unwrap();
    let replacement_error = fixture
        .provider
        .operation(
            fixture.collection_id,
            &token,
            "update",
            update_request,
            update_input,
            None,
        )
        .await
        .unwrap_err();
    assert_eq!(replacement_error.code, "legacy_replay_evidence_missing");
}
