use super::*;
use axum::body::Bytes;
use axum::extract::{OriginalUri, Path as AxumPath, State};
use axum::http::HeaderMap;
use axum::routing::post;
use axum::{Json, Router};
use p256::ecdsa::signature::Verifier;
use p256::ecdsa::VerifyingKey;
use std::sync::Arc;

static TEST_ENV: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[derive(Clone)]
struct ProviderState {
    token: String,
    public_key: String,
}

#[tokio::test]
async fn hosted_query_uses_a_signed_direct_provider_request_without_a_mirror() {
    let _environment = TEST_ENV.lock().await;
    std::env::set_var("MDBASE_CONNECT_ENV", "test");
    std::env::set_var("MDBASE_CONNECT_SECRET_BACKEND", "insecure-test-file");
    let collection_id = Uuid::new_v4();
    let signing = SigningKey::random(&mut OsRng);
    let token = random_base64(32);
    let provider_state = ProviderState {
        token: token.clone(),
        public_key: public_key(&signing),
    };
    let app = Router::new()
        .route(
            "/v1/authorities/{collection_id}/operations/{operation}",
            post(test_operation),
        )
        .with_state(provider_state);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

    let directory = tempfile::tempdir().unwrap();
    let cloud = CloudControlClient::new(
        format!("http://{address}"),
        "con_123456789012345678901234".to_string(),
    );
    let manager = HostedConnectionManager::open(directory.path(), &cloud).unwrap();
    let now = Utc::now();
    let entry = HostedConnectionEntry {
        collection_id,
        collection_name: "F5".to_string(),
        application_id: Uuid::new_v4(),
        grant_id: Uuid::new_v4(),
        operations: vec!["query".to_string()],
        operations_url: format!("http://{address}/v1/authorities/{collection_id}/operations"),
        proof_public_key: public_key(&signing),
        access_expires_at: (now + ChronoDuration::hours(1)).to_rfc3339(),
        refresh_expires_at: (now + ChronoDuration::days(30)).to_rfc3339(),
    };
    manager.upsert(entry).unwrap();
    manager
        .secrets
        .set_hosted_connection_credentials(
            collection_id,
            &serde_json::to_string(&HostedConnectionCredentials {
                access_token: "mdb_test".to_string(),
                refresh_token: "ref_test".to_string(),
                authority_access_token: token,
                grant_signing_private_key: private_key(&signing),
            })
            .unwrap(),
        )
        .unwrap();

    let result = manager
        .operation(collection_id, "query", json!({"types": ["task"]}))
        .await
        .unwrap();
    assert_eq!(result["valid"], true);
    assert_eq!(
        result["result"]["records"][0]["frontmatter"]["title"],
        "Hosted task"
    );

    server.abort();
    std::env::remove_var("MDBASE_CONNECT_ENV");
    std::env::remove_var("MDBASE_CONNECT_SECRET_BACKEND");
}

#[tokio::test]
async fn hosted_mutation_retries_the_same_durable_request_id() {
    let collection_id = Uuid::new_v4();
    let signing = SigningKey::random(&mut OsRng);
    let token = random_base64(32);
    let request_ids = Arc::new(Mutex::new(Vec::new()));
    let state = RetryProviderState {
        token: token.clone(),
        public_key: public_key(&signing),
        request_ids: request_ids.clone(),
    };
    let app = Router::new()
        .route(
            "/v1/authorities/{collection_id}/operations/{operation}",
            post(test_retry_operation),
        )
        .with_state(state);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let directory = tempfile::tempdir().unwrap();
    let cloud = CloudControlClient::new(
        format!("http://{address}"),
        "con_123456789012345678901234".to_string(),
    );
    let manager = HostedConnectionManager::open(directory.path(), &cloud).unwrap();
    let now = Utc::now();
    let result = manager
        .send_operation(
            &HostedConnectionEntry {
                collection_id,
                collection_name: "F5".to_string(),
                application_id: Uuid::new_v4(),
                grant_id: Uuid::new_v4(),
                operations: vec!["update".to_string()],
                operations_url: format!(
                    "http://{address}/v1/authorities/{collection_id}/operations"
                ),
                proof_public_key: public_key(&signing),
                access_expires_at: (now + ChronoDuration::hours(1)).to_rfc3339(),
                refresh_expires_at: (now + ChronoDuration::days(30)).to_rfc3339(),
            },
            &HostedConnectionCredentials {
                access_token: "mdb_test".to_string(),
                refresh_token: "ref_test".to_string(),
                authority_access_token: token,
                grant_signing_private_key: private_key(&signing),
            },
            "update",
            json!({"id": Uuid::new_v4(), "patch": {"done": true}}),
        )
        .await
        .unwrap();
    assert_eq!(result["updated"], true);
    let ids = request_ids.lock().unwrap();
    assert_eq!(ids.len(), 2);
    assert_eq!(ids[0], ids[1]);
    server.abort();
}

#[tokio::test]
async fn hosted_authorization_registers_signs_polls_and_persists_the_cli_grant() {
    let _environment = TEST_ENV.lock().await;
    std::env::set_var("MDBASE_CONNECT_ENV", "test");
    std::env::set_var("MDBASE_CONNECT_SECRET_BACKEND", "insecure-test-file");
    let collection_id = Uuid::new_v4();
    let application_id = Uuid::new_v4();
    let grant_id = Uuid::new_v4();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let base_url = format!("http://{address}");
    let state = AuthorizationState {
        application_id,
        collection_id,
        grant_id,
        manifest_digest: "a".repeat(64),
        base_url: base_url.clone(),
        grant_signing_public_key: Arc::new(Mutex::new(None)),
    };
    let app = Router::new()
        .route("/v1/apps/register", post(test_register_application))
        .route(
            "/oauth/device_authorization",
            post(test_device_authorization),
        )
        .route("/oauth/token", post(test_device_token))
        .with_state(state);
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let directory = tempfile::tempdir().unwrap();
    let cloud = CloudControlClient::new(base_url, "con_123456789012345678901234".to_string());
    let manager = HostedConnectionManager::open(directory.path(), &cloud).unwrap();
    let authorization = manager
        .begin_authorization(HostedConnectionAuthorizeParams {
            collection_id,
            operations: vec!["query".to_string()],
        })
        .await
        .unwrap();
    let status = manager
        .poll_authorization(authorization.authorization_id)
        .await
        .unwrap();
    assert!(matches!(
        status,
        HostedConnectionAuthorizationStatus::Connected { .. }
    ));
    let connections = manager.list();
    assert_eq!(connections.len(), 1);
    assert_eq!(connections[0].collection_id, collection_id);
    assert_eq!(connections[0].operations, ["query"]);
    assert!(manager
        .secrets
        .hosted_connection_credentials(collection_id)
        .unwrap()
        .is_some());
    server.abort();
    std::env::remove_var("MDBASE_CONNECT_ENV");
    std::env::remove_var("MDBASE_CONNECT_SECRET_BACKEND");
}

#[tokio::test]
async fn expired_hosted_capability_is_refreshed_with_a_signed_rotating_request() {
    let _environment = TEST_ENV.lock().await;
    std::env::set_var("MDBASE_CONNECT_ENV", "test");
    std::env::set_var("MDBASE_CONNECT_SECRET_BACKEND", "insecure-test-file");
    let collection_id = Uuid::new_v4();
    let application_id = Uuid::new_v4();
    let grant_id = Uuid::new_v4();
    let signing = SigningKey::random(&mut OsRng);
    let refresh_token = "ref_original_refresh_token_value".to_string();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let state = RefreshState {
        collection_id,
        grant_id,
        public_key: public_key(&signing),
        refresh_token: refresh_token.clone(),
        operations_url: format!("http://{address}/v1/authorities/{collection_id}/operations"),
    };
    let app = Router::new()
        .route("/oauth/token", post(test_refresh))
        .with_state(state);
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let directory = tempfile::tempdir().unwrap();
    let cloud = CloudControlClient::new(
        format!("http://{address}"),
        "con_123456789012345678901234".to_string(),
    );
    let manager = HostedConnectionManager::open(directory.path(), &cloud).unwrap();
    let now = Utc::now();
    manager
        .upsert(HostedConnectionEntry {
            collection_id,
            collection_name: "F5".to_string(),
            application_id,
            grant_id,
            operations: vec!["query".to_string()],
            operations_url: format!("http://{address}/v1/authorities/{collection_id}/operations"),
            proof_public_key: public_key(&signing),
            access_expires_at: (now - ChronoDuration::minutes(1)).to_rfc3339(),
            refresh_expires_at: (now + ChronoDuration::days(30)).to_rfc3339(),
        })
        .unwrap();
    manager
        .secrets
        .set_hosted_connection_credentials(
            collection_id,
            &serde_json::to_string(&HostedConnectionCredentials {
                access_token: "mdb_old".to_string(),
                refresh_token,
                authority_access_token: "hsa_old".to_string(),
                grant_signing_private_key: private_key(&signing),
            })
            .unwrap(),
        )
        .unwrap();

    let (entry, credentials) = manager
        .fresh_connection(collection_id, false)
        .await
        .unwrap();
    assert_eq!(entry.collection_name, "F5 refreshed");
    assert_eq!(credentials.refresh_token, "ref_rotated");
    assert_eq!(credentials.authority_access_token, "hsa_rotated");

    server.abort();
    std::env::remove_var("MDBASE_CONNECT_ENV");
    std::env::remove_var("MDBASE_CONNECT_SECRET_BACKEND");
}

#[derive(Clone)]
struct RefreshState {
    collection_id: Uuid,
    grant_id: Uuid,
    public_key: String,
    refresh_token: String,
    operations_url: String,
}

#[derive(Clone)]
struct RetryProviderState {
    token: String,
    public_key: String,
    request_ids: Arc<Mutex<Vec<Uuid>>>,
}

#[derive(Clone)]
struct AuthorizationState {
    application_id: Uuid,
    collection_id: Uuid,
    grant_id: Uuid,
    manifest_digest: String,
    base_url: String,
    grant_signing_public_key: Arc<Mutex<Option<String>>>,
}

async fn test_register_application(
    State(state): State<AuthorizationState>,
    Json(body): Json<Value>,
) -> Json<Value> {
    assert_eq!(body["manifest"]["id"], CLI_APPLICATION_ID);
    assert_eq!(body["manifest"]["distribution"], "portable");
    Json(json!({
        "application": {
            "id": state.application_id,
            "manifest_digest": state.manifest_digest
        }
    }))
}

async fn test_device_authorization(
    State(state): State<AuthorizationState>,
    body: Bytes,
) -> Json<Value> {
    let form = url::form_urlencoded::parse(&body)
        .into_owned()
        .collect::<HashMap<_, _>>();
    let proof: ApplicationAuthorizationProof =
        serde_json::from_str(form.get("application_authorization").unwrap()).unwrap();
    proof.verify().unwrap();
    assert_eq!(proof.binding.application_id, state.application_id);
    assert_eq!(proof.binding.application_declaration_id, CLI_APPLICATION_ID);
    assert_eq!(proof.binding.collection_id, Some(state.collection_id));
    assert_eq!(proof.binding.requested_operations, ["query"]);
    assert_eq!(
        form.get("code_challenge"),
        Some(&proof.binding.code_challenge)
    );
    *state.grant_signing_public_key.lock().unwrap() = Some(proof.binding.grant_signing_public_key);
    Json(json!({
        "device_code": "device-code",
        "user_code": "ABCD-EFGH",
        "verification_uri": format!("{}/device", state.base_url),
        "verification_uri_complete": format!("{}/device?user_code=ABCD-EFGH", state.base_url),
        "expires_in": 600,
        "interval": 1
    }))
}

async fn test_device_token(State(state): State<AuthorizationState>, body: Bytes) -> Json<Value> {
    let form = url::form_urlencoded::parse(&body)
        .into_owned()
        .collect::<HashMap<_, _>>();
    assert_eq!(
        form.get("device_code").map(String::as_str),
        Some("device-code")
    );
    assert!(!form.get("code_verifier").unwrap().is_empty());
    let proof_public_key = state
        .grant_signing_public_key
        .lock()
        .unwrap()
        .clone()
        .unwrap();
    Json(json!({
        "access_token": "mdb_authorized",
        "refresh_token": "ref_authorized",
        "expires_in": 3600,
        "refresh_expires_in": 2592000,
        "collection_id": state.collection_id,
        "collection_name": "F5",
        "operations": ["query"],
        "grant_id": state.grant_id,
        "application_origin": "null",
        "encryption": null,
        "authority": {
            "operations_url": format!(
                "{}/v1/authorities/{}/operations",
                state.base_url, state.collection_id
            ),
            "access_token": "hsa_authorized",
            "proof_public_key": proof_public_key
        }
    }))
}

async fn test_retry_operation(
    State(state): State<RetryProviderState>,
    OriginalUri(uri): OriginalUri,
    headers: HeaderMap,
    body: Bytes,
) -> (StatusCode, Json<Value>) {
    verify_proof(&state.public_key, &state.token, uri.path(), &headers, &body);
    let request: OperationRequest = serde_json::from_slice(&body).unwrap();
    let mut request_ids = state.request_ids.lock().unwrap();
    request_ids.push(request.request_id);
    if request_ids.len() == 1 {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({"error": {"code": "temporarily_unavailable"}})),
        );
    }
    drop(request_ids);
    (
        StatusCode::OK,
        Json(
            serde_json::to_value(OperationResponse {
                protocol_version: request.protocol_version,
                request_id: request.request_id,
                ok: true,
                result: Some(json!({"updated": true})),
                problem: None,
            })
            .unwrap(),
        ),
    )
}

async fn test_refresh(
    State(state): State<RefreshState>,
    OriginalUri(uri): OriginalUri,
    headers: HeaderMap,
    body: Bytes,
) -> Json<Value> {
    verify_proof(
        &state.public_key,
        &state.refresh_token,
        uri.path(),
        &headers,
        &body,
    );
    let form = url::form_urlencoded::parse(&body)
        .into_owned()
        .collect::<HashMap<_, _>>();
    assert_eq!(
        form.get("grant_type").map(String::as_str),
        Some("refresh_token")
    );
    assert_eq!(
        form.get("refresh_token").map(String::as_str),
        Some(state.refresh_token.as_str())
    );
    Json(json!({
        "access_token": "mdb_rotated",
        "refresh_token": "ref_rotated",
        "expires_in": 3600,
        "refresh_expires_in": 2592000,
        "collection_id": state.collection_id,
        "collection_name": "F5 refreshed",
        "operations": ["query"],
        "grant_id": state.grant_id,
        "application_origin": "null",
        "encryption": null,
        "authority": {
            "operations_url": state.operations_url,
            "access_token": "hsa_rotated",
            "proof_public_key": state.public_key
        }
    }))
}

async fn test_operation(
    State(state): State<ProviderState>,
    OriginalUri(uri): OriginalUri,
    AxumPath((_collection_id, operation)): AxumPath<(Uuid, String)>,
    headers: HeaderMap,
    body: Bytes,
) -> Json<Value> {
    assert_eq!(operation, "query");
    assert_eq!(headers.get("origin").unwrap(), "null");
    assert_eq!(
        headers.get("authorization").unwrap(),
        format!("Bearer {}", state.token).as_str()
    );
    verify_proof(&state.public_key, &state.token, uri.path(), &headers, &body);
    let request: OperationRequest = serde_json::from_slice(&body).unwrap();
    Json(
        serde_json::to_value(OperationResponse {
            protocol_version: request.protocol_version,
            request_id: request.request_id,
            ok: true,
            result: Some(json!({
                "valid": true,
                "result": {"records": [{"frontmatter": {"title": "Hosted task"}}]},
                "diagnostics": []
            })),
            problem: None,
        })
        .unwrap(),
    )
}

fn verify_proof(
    public_key_value: &str,
    credential: &str,
    target: &str,
    headers: &HeaderMap,
    body: &[u8],
) {
    let timestamp = headers
        .get(AUTHORITY_PROOF_TIMESTAMP_HEADER)
        .unwrap()
        .to_str()
        .unwrap();
    let nonce = headers
        .get(AUTHORITY_PROOF_NONCE_HEADER)
        .unwrap()
        .to_str()
        .unwrap();
    let message = [
        AUTHORITY_PROOF_DOMAIN.to_string(),
        AUTHORITY_PROOF_VERSION.to_string(),
        "POST".to_string(),
        target.to_string(),
        URL_SAFE_NO_PAD.encode(Sha256::digest(body)),
        URL_SAFE_NO_PAD.encode(Sha256::digest(credential.as_bytes())),
        timestamp.to_string(),
        nonce.to_string(),
    ]
    .join("\n");
    let public = URL_SAFE_NO_PAD.decode(public_key_value).unwrap();
    let verifier = VerifyingKey::from_sec1_bytes(&public).unwrap();
    let signature = URL_SAFE_NO_PAD
        .decode(
            headers
                .get(AUTHORITY_PROOF_SIGNATURE_HEADER)
                .unwrap()
                .to_str()
                .unwrap(),
        )
        .unwrap();
    verifier
        .verify(
            &message.into_bytes(),
            &Signature::from_slice(&signature).unwrap(),
        )
        .unwrap();
}

#[test]
fn token_validation_rejects_cross_collection_and_insecure_authority_urls() {
    let collection_id = Uuid::new_v4();
    let other_id = Uuid::new_v4();
    let token = TokenResponse {
        access_token: "mdb_test".to_string(),
        refresh_token: "ref_test".to_string(),
        expires_in: 3600,
        refresh_expires_in: 86_400,
        collection_id,
        collection_name: Some("F5".to_string()),
        operations: vec!["query".to_string()],
        grant_id: Uuid::new_v4(),
        application_origin: "null".to_string(),
        encryption: None,
        authority: HostedAuthorityToken {
            operations_url: format!("https://sync.example/v1/authorities/{other_id}/operations"),
            access_token: "hsa_test".to_string(),
            proof_public_key: "key".to_string(),
        },
    };
    assert_eq!(
        validate_token_response(&token).unwrap_err().code(),
        "invalid_token_response"
    );
    let mut insecure = token;
    insecure.authority.operations_url =
        format!("http://sync.example/v1/authorities/{collection_id}/operations");
    assert_eq!(
        validate_token_response(&insecure).unwrap_err().code(),
        "invalid_token_response"
    );
}
