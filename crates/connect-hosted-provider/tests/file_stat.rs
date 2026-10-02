// Shared lifecycle fixtures also expose race helpers unused by point stat.
#[allow(dead_code, unused_imports)]
mod support;
#[path = "support/test_postgres.rs"]
mod test_postgres;

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use mdbase_connect_hosted_provider::{app, AppState, RegisterReplica, ReplicaPurpose};
use mdbase_connect_protocol::*;
use p256::ecdsa::{signature::Signer, Signature, SigningKey};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use support::FileLifecycleFixture;
use test_postgres::DisposablePostgres;
use uuid::Uuid;

fn request(target: Value) -> StatFileRequest {
    let mut body = json!({"protocol_version":1,"type":"stat_file"});
    body.as_object_mut()
        .unwrap()
        .extend(target.as_object().unwrap().clone());
    serde_json::from_value(body).unwrap()
}

fn proof_headers(
    key: &SigningKey,
    token: &str,
    target: &str,
    body: &[u8],
) -> reqwest::header::HeaderMap {
    let timestamp = chrono::Utc::now().timestamp().to_string();
    let nonce = Uuid::new_v4().to_string();
    let message = [
        AUTHORITY_PROOF_DOMAIN.to_owned(),
        AUTHORITY_PROOF_VERSION.to_string(),
        "POST".into(),
        target.into(),
        URL_SAFE_NO_PAD.encode(Sha256::digest(body)),
        URL_SAFE_NO_PAD.encode(Sha256::digest(token.as_bytes())),
        timestamp.clone(),
        nonce.clone(),
    ]
    .join("\n");
    let signature: Signature = key.sign(message.as_bytes());
    let mut headers = reqwest::header::HeaderMap::new();
    for (name, value) in [
        ("authorization", format!("Bearer {token}")),
        ("origin", "https://files.example".into()),
        (
            AUTHORITY_PROOF_VERSION_HEADER,
            AUTHORITY_PROOF_VERSION.to_string(),
        ),
        (AUTHORITY_PROOF_TIMESTAMP_HEADER, timestamp),
        (AUTHORITY_PROOF_NONCE_HEADER, nonce),
        (
            AUTHORITY_PROOF_SIGNATURE_HEADER,
            URL_SAFE_NO_PAD.encode(signature.to_bytes()),
        ),
    ] {
        headers.insert(
            reqwest::header::HeaderName::from_bytes(name.as_bytes()).unwrap(),
            value.parse().unwrap(),
        );
    }
    headers
}

#[tokio::test]
#[ignore = "requires repository-approved disposable loopback PostgreSQL target"]
async fn exact_file_stat_local_indexes_hosted_policy_and_signed_http() {
    let database = DisposablePostgres::from_projection_env().await;
    let fixture = FileLifecycleFixture::new(database.url()).await;
    let transfer = fixture.stage_upload("Allowed/photo.PNG", b"pixels").await;
    let original = fixture
        .provider
        .commit_file_upload(
            fixture.collection_id,
            &fixture.token,
            FileLifecycleFixture::commit_request(transfer),
            None,
        )
        .await
        .unwrap()
        .file;
    let transfer = fixture.stage_upload("Outside/secret.bin", b"private").await;
    let invisible = fixture
        .provider
        .commit_file_upload(
            fixture.collection_id,
            &fixture.token,
            FileLifecycleFixture::commit_request(transfer),
            None,
        )
        .await
        .unwrap()
        .file;

    let saved_ciphertext: Vec<u8> = sqlx::query_scalar("SELECT payload_ciphertext FROM hosted_provider_files WHERE collection_id=$1 AND file_id=$2").bind(fixture.collection_id).bind(invisible.file_id).fetch_one(&fixture.pool).await.unwrap();
    // Corrupt an unrelated descriptor: a normal point lookup must not decrypt it.
    sqlx::query("UPDATE hosted_provider_files SET payload_ciphertext = decode('00','hex') WHERE collection_id=$1 AND file_id=$2")
        .bind(fixture.collection_id).bind(invisible.file_id).execute(&fixture.pool).await.unwrap();
    let path_result = fixture
        .provider
        .stat_file(
            fixture.collection_id,
            &fixture.token,
            request(json!({"path":"allowed/PHOTO.png"})),
            None,
        )
        .await
        .unwrap();
    assert_eq!(path_result.file, Some(original.clone()));
    assert_eq!(
        fixture
            .provider
            .stat_file(
                fixture.collection_id,
                &fixture.token,
                request(json!({"file_id":original.file_id})),
                None
            )
            .await
            .unwrap()
            .file,
        Some(original.clone())
    );
    sqlx::query("UPDATE hosted_provider_files SET payload_ciphertext=$3 WHERE collection_id=$1 AND file_id=$2").bind(fixture.collection_id).bind(invisible.file_id).bind(saved_ciphertext).execute(&fixture.pool).await.unwrap();

    let application_token = format!("application-{}-{}", Uuid::new_v4(), Uuid::new_v4());
    let replica_id = Uuid::now_v7();
    let signing_key = SigningKey::random(&mut rand_core::OsRng);
    fixture
        .provider
        .register_replica(
            fixture.collection_id,
            RegisterReplica {
                application_setup_evidence: None,
                replica_id,
                name: "Stat only".into(),
                purpose: ReplicaPurpose::Application,
                mode: SyncReplicaMode::ReadOnly,
                allowed_types: vec![],
                contract_scope: vec![],
                full_collection: true,
                allowed_operations: vec![],
                operation_transport_protocol: Some(3),
                operation_transport_recovery_protocols: vec![2],
                file_capability: Some(FileCapability {
                    kind: FileCapabilityKind::Files,
                    protocol_version: 1,
                    actions: vec![FileAction::List],
                    scope: FileScope::SelectedFolders {
                        folders: vec!["Allowed".into()],
                    },
                }),
                allowed_origin: Some("https://files.example".into()),
                proof_public_key: Some(
                    URL_SAFE_NO_PAD.encode(
                        signing_key
                            .verifying_key()
                            .to_encoded_point(false)
                            .as_bytes(),
                    ),
                ),
                grant_id: Some(Uuid::now_v7()),
                application_declaration_id: None,
                application_declaration_digest: None,
                token: application_token.clone(),
                token_ttl_seconds: Some(3600),
            },
        )
        .await
        .unwrap();
    let stat = |target| {
        fixture.provider.stat_file(
            fixture.collection_id,
            &application_token,
            request(target),
            Some("https://files.example"),
        )
    };
    assert_eq!(
        stat(json!({"path":"Allowed/photo.PNG"}))
            .await
            .unwrap()
            .file,
        Some(original.clone())
    );
    assert!(stat(json!({"path":"Allowed/missing.bin"}))
        .await
        .unwrap()
        .file
        .is_none());
    assert!(stat(json!({"file_id":invisible.file_id}))
        .await
        .unwrap()
        .file
        .is_none());
    assert!(stat(json!({"file_id":Uuid::new_v4()}))
        .await
        .unwrap()
        .file
        .is_none());
    assert_eq!(
        stat(json!({"path":"Outside/missing.bin"}))
            .await
            .unwrap_err()
            .code,
        "scope_denied"
    );
    assert_eq!(
        fixture
            .provider
            .stat_file(
                fixture.collection_id,
                &application_token,
                request(json!({"file_id":original.file_id})),
                Some("https://wrong.example")
            )
            .await
            .unwrap_err()
            .code,
        "origin_denied"
    );

    let moved = fixture
        .provider
        .move_file(
            fixture.collection_id,
            &fixture.token,
            MoveFileRequest {
                protocol_version: 1,
                message_type: MoveFileRequestKind::MoveFile,
                mutation_id: Uuid::now_v7(),
                file_id: original.file_id,
                if_revision: original.revision.clone(),
                from_path: original.path.clone(),
                path: "Allowed/renamed.png".into(),
                update_references: false,
            },
            None,
        )
        .await
        .unwrap()
        .file;
    assert_eq!(
        stat(json!({"file_id":original.file_id}))
            .await
            .unwrap()
            .file,
        Some(moved.clone())
    );
    assert!(stat(json!({"path":original.path}))
        .await
        .unwrap()
        .file
        .is_none());
    let moved_out = fixture
        .provider
        .move_file(
            fixture.collection_id,
            &fixture.token,
            MoveFileRequest {
                protocol_version: 1,
                message_type: MoveFileRequestKind::MoveFile,
                mutation_id: Uuid::now_v7(),
                file_id: moved.file_id,
                if_revision: moved.revision.clone(),
                from_path: moved.path.clone(),
                path: "Outside/renamed.png".into(),
                update_references: false,
            },
            None,
        )
        .await
        .unwrap()
        .file;
    assert!(stat(json!({"file_id":original.file_id}))
        .await
        .unwrap()
        .file
        .is_none());
    fixture
        .provider
        .delete_file(
            fixture.collection_id,
            &fixture.token,
            DeleteFileRequest {
                protocol_version: 1,
                message_type: DeleteFileRequestKind::DeleteFile,
                mutation_id: Uuid::now_v7(),
                file_id: moved_out.file_id,
                if_revision: moved_out.revision,
                path: moved_out.path,
            },
            None,
        )
        .await
        .unwrap();
    assert!(stat(json!({"file_id":original.file_id}))
        .await
        .unwrap()
        .file
        .is_none());

    let other = FileLifecycleFixture::new(database.url()).await;
    assert!(other
        .provider
        .stat_file(
            other.collection_id,
            &other.token,
            request(json!({"file_id":invisible.file_id})),
            None
        )
        .await
        .unwrap()
        .file
        .is_none());
    // Authenticated ciphertext must agree with its keyed path index.
    let saved_token: Vec<u8> = sqlx::query_scalar(
        "SELECT path_token FROM hosted_provider_files WHERE collection_id=$1 AND file_id=$2",
    )
    .bind(fixture.collection_id)
    .bind(invisible.file_id)
    .fetch_one(&fixture.pool)
    .await
    .unwrap();
    sqlx::query("UPDATE hosted_provider_files SET path_token=decode('00','hex') WHERE collection_id=$1 AND file_id=$2").bind(fixture.collection_id).bind(invisible.file_id).execute(&fixture.pool).await.unwrap();
    assert_eq!(
        fixture
            .provider
            .stat_file(
                fixture.collection_id,
                &fixture.token,
                request(json!({"file_id":invisible.file_id})),
                None
            )
            .await
            .unwrap_err()
            .code,
        "provider_internal_error"
    );
    sqlx::query(
        "UPDATE hosted_provider_files SET path_token=$3 WHERE collection_id=$1 AND file_id=$2",
    )
    .bind(fixture.collection_id)
    .bind(invisible.file_id)
    .bind(saved_token)
    .execute(&fixture.pool)
    .await
    .unwrap();

    // Body-bound proof is checked on the stat HTTP route, not just provider calls.
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let state = AppState::new(fixture.provider.clone(), &"internal-test-token-".repeat(2)).unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, app(state)).await.unwrap() });
    let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
    let client = reqwest::Client::new();
    let target = format!("/v1/authorities/{}/files/stat", fixture.collection_id);
    let body = serde_json::to_vec(&request(json!({"path":"Allowed/missing.bin"}))).unwrap();
    let headers = proof_headers(&signing_key, &application_token, &target, &body);
    let send = |headers, body| {
        client
            .post(format!("http://{address}{target}"))
            .headers(headers)
            .body(body)
            .send()
    };
    let response = send(headers.clone(), body.clone()).await.unwrap();
    assert_eq!(response.status(), reqwest::StatusCode::OK);
    assert_eq!(response.json::<Value>().await.unwrap()["file"], Value::Null);
    assert_eq!(
        send(headers, body.clone()).await.unwrap().status(),
        reqwest::StatusCode::UNAUTHORIZED
    );
    let tampered = serde_json::to_vec(&request(json!({"path":"Allowed/other.bin"}))).unwrap();
    assert_eq!(
        send(
            proof_headers(&signing_key, &application_token, &target, &body),
            tampered
        )
        .await
        .unwrap()
        .status(),
        reqwest::StatusCode::UNAUTHORIZED
    );
    for invalid_target in [
        json!({}),
        json!({"path":"Allowed/missing.bin","file_id":Uuid::now_v7()}),
        json!({"path":"../escape.bin"}),
        json!({"path":"Allowed/missing.bin","extra":true}),
        json!({"path":null,"file_id":Uuid::now_v7()}),
        json!({"file_id":null,"path":"Allowed/missing.bin"}),
    ] {
        let mut value = json!({"protocol_version":1,"type":"stat_file"});
        value
            .as_object_mut()
            .unwrap()
            .extend(invalid_target.as_object().unwrap().clone());
        let invalid = serde_json::to_vec(&value).unwrap();
        assert_eq!(
            send(
                proof_headers(&signing_key, &application_token, &target, &invalid),
                invalid
            )
            .await
            .unwrap()
            .status(),
            reqwest::StatusCode::BAD_REQUEST
        );
    }
    sqlx::query("UPDATE hosted_provider_replicas SET file_capability=jsonb_set(file_capability,'{actions}','[\"read\"]') WHERE id=$1").bind(replica_id).execute(&fixture.pool).await.unwrap();
    assert_eq!(
        stat(json!({"path":"Allowed/missing.bin"}))
            .await
            .unwrap_err()
            .code,
        "insufficient_access"
    );
    fixture.provider.revoke_replica(replica_id).await.unwrap();
    assert!(stat(json!({"path":"Allowed/missing.bin"})).await.is_err());
    server.abort();
}
