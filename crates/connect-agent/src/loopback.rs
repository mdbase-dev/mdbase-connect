use crate::server::AgentState;
use axum::body::Body;
use axum::extract::{DefaultBodyLimit, State};
use axum::http::{header, HeaderMap, HeaderValue, Method, Request, Response, StatusCode};
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router};
use mdbase_connect_protocol::{
    RelayMessage, ENCRYPTED_RELAY_PROTOCOL_VERSION, LOOPBACK_PROTOCOL_VERSION,
};
use serde_json::json;
use std::collections::HashMap;
use std::io;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::net::TcpListener;
use tokio::sync::Semaphore;
use tokio::task::JoinHandle;

const MAX_REQUEST_BYTES: usize = 3 * 1024 * 1024;
const MAX_CONCURRENT_OPERATIONS: usize = 32;
const MAX_REQUESTS_PER_MINUTE_PER_ORIGIN: u32 = 600;

#[derive(Clone)]
struct LoopbackState {
    agent: Arc<AgentState>,
    port: u16,
    operations: Arc<Semaphore>,
    rates: Arc<Mutex<HashMap<String, (Instant, u32)>>>,
}

pub struct LoopbackServer {
    port: u16,
    tasks: Vec<JoinHandle<io::Result<()>>>,
}

impl LoopbackServer {
    pub fn port(&self) -> u16 {
        self.port
    }

    pub fn stop(self) {
        for task in self.tasks {
            task.abort();
        }
    }
}

pub async fn start(port: u16, agent: Arc<AgentState>) -> io::Result<LoopbackServer> {
    let ipv4 = TcpListener::bind(("127.0.0.1", port)).await?;
    let actual_port = ipv4.local_addr()?.port();
    let app = router(agent, actual_port);
    let mut tasks = vec![tokio::spawn(serve(ipv4, app.clone()))];

    match TcpListener::bind(("::1", actual_port)).await {
        Ok(ipv6) => tasks.push(tokio::spawn(serve(ipv6, app))),
        Err(error) => {
            tracing::debug!(%error, "IPv6 loopback is unavailable; continuing on IPv4 loopback")
        }
    }
    tracing::info!(
        port = actual_port,
        "direct collection access listening on loopback"
    );
    Ok(LoopbackServer {
        port: actual_port,
        tasks,
    })
}

async fn serve(listener: TcpListener, app: Router) -> io::Result<()> {
    axum::serve(listener, app).await.map_err(io::Error::other)
}

fn router(agent: Arc<AgentState>, port: u16) -> Router {
    let state = LoopbackState {
        agent,
        port,
        operations: Arc::new(Semaphore::new(MAX_CONCURRENT_OPERATIONS)),
        rates: Arc::new(Mutex::new(HashMap::new())),
    };
    Router::new()
        .route("/v1/ready", get(ready).options(preflight))
        .route("/v1/operations", post(operation).options(preflight))
        .fallback(not_found)
        .layer(DefaultBodyLimit::max(MAX_REQUEST_BYTES))
        .with_state(state)
}

async fn ready(State(state): State<LoopbackState>, request: Request<Body>) -> Response<Body> {
    let Ok(origin) = authorize_browser_request(&state, &request, false) else {
        return denied();
    };
    cors_response(
        Json(json!({
            "service": "mdbase-connect",
            "loopback_protocol_version": LOOPBACK_PROTOCOL_VERSION,
            "encrypted_protocol_version": ENCRYPTED_RELAY_PROTOCOL_VERSION,
        }))
        .into_response(),
        &origin,
    )
}

async fn preflight(State(state): State<LoopbackState>, request: Request<Body>) -> Response<Body> {
    let Ok(origin) = authorize_browser_request(&state, &request, true) else {
        return denied();
    };
    let requested_method = request
        .headers()
        .get(header::ACCESS_CONTROL_REQUEST_METHOD)
        .and_then(|value| value.to_str().ok());
    if !matches!(requested_method, Some("GET" | "POST")) {
        return denied();
    }
    let requested_headers = request
        .headers()
        .get(header::ACCESS_CONTROL_REQUEST_HEADERS)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    if requested_headers
        .split(',')
        .map(|value| value.trim().to_ascii_lowercase())
        .any(|value| !value.is_empty() && value != "content-type")
    {
        return denied();
    }
    let mut response = cors_response(StatusCode::NO_CONTENT.into_response(), &origin);
    response.headers_mut().insert(
        header::ACCESS_CONTROL_ALLOW_METHODS,
        HeaderValue::from_static("GET, POST, OPTIONS"),
    );
    response.headers_mut().insert(
        header::ACCESS_CONTROL_ALLOW_HEADERS,
        HeaderValue::from_static("Content-Type"),
    );
    response.headers_mut().insert(
        header::ACCESS_CONTROL_MAX_AGE,
        HeaderValue::from_static("600"),
    );
    if request
        .headers()
        .get("access-control-request-private-network")
        .is_some_and(|value| value == "true")
    {
        response.headers_mut().insert(
            "access-control-allow-private-network",
            HeaderValue::from_static("true"),
        );
    }
    response
}

async fn operation(
    State(state): State<LoopbackState>,
    headers: HeaderMap,
    Json(body): Json<serde_json::Value>,
) -> Response<Body> {
    let request = Request::builder()
        .method(Method::POST)
        .uri("/v1/operations")
        .body(Body::empty())
        .expect("static direct request");
    let (mut parts, _) = request.into_parts();
    parts.headers = headers;
    let request = Request::from_parts(parts, Body::empty());
    let Ok(origin) = authorize_browser_request(&state, &request, false) else {
        return denied();
    };
    if request
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        != Some("application/mdbase-connect+json")
    {
        return cors_error(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "unsupported_media_type",
            "Direct operations require application/mdbase-connect+json.",
            &origin,
        );
    }
    let Ok(RelayMessage::EncryptedOperationRequest { envelope }) =
        serde_json::from_value::<RelayMessage>(body)
    else {
        return cors_error(
            StatusCode::UPGRADE_REQUIRED,
            "encryption_required",
            "Direct operations require encrypted protocol 1.",
            &origin,
        );
    };
    let permit = match tokio::time::timeout(
        Duration::from_secs(5),
        state.operations.clone().acquire_owned(),
    )
    .await
    {
        Ok(Ok(permit)) => permit,
        _ => {
            return cors_error(
                StatusCode::SERVICE_UNAVAILABLE,
                "connector_busy",
                "The local connector is busy.",
                &origin,
            )
        }
    };
    let agent = state.agent.clone();
    let operation_origin = origin.clone();
    let execution = tokio::task::spawn_blocking(move || {
        // Keep the concurrency slot until the filesystem operation and its durable receipt
        // have both completed, even when the HTTP request times out and disconnects.
        let _permit = permit;
        agent.handle_direct_encrypted_operation(&operation_origin, envelope)
    });
    let response = tokio::time::timeout(Duration::from_secs(30), execution).await;
    match response {
        Ok(Ok(RelayMessage::EncryptedOperationResponse { envelope })) => cors_response(
            Json(json!({
                "ok": true,
                "envelope": RelayMessage::EncryptedOperationResponse { envelope }
            }))
            .into_response(),
            &origin,
        ),
        Ok(Ok(_)) => cors_error(
            StatusCode::FORBIDDEN,
            "direct_operation_rejected",
            "The local connector rejected this operation.",
            &origin,
        ),
        Ok(Err(_)) => cors_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "connector_failed",
            "The local connector could not complete this operation.",
            &origin,
        ),
        Err(_) => cors_error(
            StatusCode::GATEWAY_TIMEOUT,
            "connector_timeout",
            "The local connector did not complete this operation in time.",
            &origin,
        ),
    }
}

async fn not_found() -> Response<Body> {
    StatusCode::NOT_FOUND.into_response()
}

fn authorize_browser_request(
    state: &LoopbackState,
    request: &Request<Body>,
    preflight: bool,
) -> Result<String, ()> {
    let expected_host_v4 = format!("127.0.0.1:{}", state.port);
    let expected_host_v6 = format!("[::1]:{}", state.port);
    let host = request
        .headers()
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
        .ok_or(())?;
    if host != expected_host_v4 && host != expected_host_v6 {
        return Err(());
    }
    if preflight && request.method() != Method::OPTIONS {
        return Err(());
    }
    let origin = request
        .headers()
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok())
        .ok_or(())?;
    let parsed = url::Url::parse(origin).map_err(|_| ())?;
    if parsed.origin().ascii_serialization() != origin
        || !matches!(parsed.scheme(), "http" | "https")
    {
        return Err(());
    }
    if !state.agent.origin_allowed(origin) || !within_rate_limit(state, origin) {
        return Err(());
    }
    Ok(origin.to_string())
}

fn within_rate_limit(state: &LoopbackState, origin: &str) -> bool {
    let now = Instant::now();
    let mut rates = state.rates.lock().expect("loopback rate lock poisoned");
    rates.retain(|_, (window, _)| now.duration_since(*window) < Duration::from_secs(120));
    let entry = rates.entry(origin.to_string()).or_insert((now, 0));
    if now.duration_since(entry.0) >= Duration::from_secs(60) {
        *entry = (now, 0);
    }
    if entry.1 >= MAX_REQUESTS_PER_MINUTE_PER_ORIGIN {
        return false;
    }
    entry.1 += 1;
    true
}

fn denied() -> Response<Body> {
    StatusCode::FORBIDDEN.into_response()
}

fn cors_error(status: StatusCode, code: &str, message: &str, origin: &str) -> Response<Body> {
    cors_response(
        (
            status,
            Json(json!({ "error": { "code": code, "message": message } })),
        )
            .into_response(),
        origin,
    )
}

fn cors_response(mut response: Response<Body>, origin: &str) -> Response<Body> {
    if let Ok(value) = HeaderValue::from_str(origin) {
        response
            .headers_mut()
            .insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, value);
    }
    response.headers_mut().insert(
        header::VARY,
        HeaderValue::from_static(
            "Origin, Access-Control-Request-Method, Access-Control-Request-Headers, Access-Control-Request-Private-Network",
        ),
    );
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response.headers_mut().insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    response
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::to_bytes;
    use axum::http::header::{ACCESS_CONTROL_ALLOW_ORIGIN, CONTENT_TYPE, HOST, ORIGIN};
    use mdbase_connect_core::CollectionRegistry;
    use mdbase_connect_protocol::crypto::{
        RelayBinding, RelayDirection, RelayIdentity, RelayMetadata,
    };
    use mdbase_connect_protocol::{
        EncryptedRelayEnvelope, GrantEncryption, GrantPolicy, GrantScope, RELAY_ENCRYPTION_SUITE,
    };
    use std::fs;
    use tower::ServiceExt;
    use uuid::Uuid;

    #[tokio::test]
    async fn exact_origin_host_and_protocol_one_are_enforced() {
        let fixture = fixture();
        let app = router(fixture.agent.clone(), 28_485);

        let hostile = app
            .clone()
            .oneshot(request(
                Method::GET,
                "/v1/ready",
                "https://evil.example",
                None,
            ))
            .await
            .unwrap();
        assert_eq!(hostile.status(), StatusCode::FORBIDDEN);
        assert!(hostile.headers().get(ACCESS_CONTROL_ALLOW_ORIGIN).is_none());

        let rebound = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::GET)
                    .uri("/v1/ready")
                    .header(HOST, "connector.evil.example:28485")
                    .header(ORIGIN, &fixture.origin)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(rebound.status(), StatusCode::FORBIDDEN);

        let ready = app
            .clone()
            .oneshot(request(Method::GET, "/v1/ready", &fixture.origin, None))
            .await
            .unwrap();
        assert_eq!(ready.status(), StatusCode::OK);
        assert_eq!(
            ready.headers().get(ACCESS_CONTROL_ALLOW_ORIGIN).unwrap(),
            fixture.origin.as_str()
        );

        let plaintext = app
            .oneshot(request(
                Method::POST,
                "/v1/operations",
                &fixture.origin,
                Some(r#"{"type":"operation_request"}"#),
            ))
            .await
            .unwrap();
        assert_eq!(plaintext.status(), StatusCode::UPGRADE_REQUIRED);

        fs::remove_dir_all(fixture.root).unwrap();
    }

    #[tokio::test]
    async fn every_grantable_operation_runs_directly_and_duplicate_writes_cross_transports_once() {
        let fixture = fixture();
        let app = router(fixture.agent.clone(), 28_485);

        let described = fixture.direct(&app, "describe", json!({}), 1).await;
        assert_eq!(described["ok"], true);
        assert_eq!(described["result"]["display_name"], "Direct notes");
        let cursor = described["result"]["change_cursor"].as_u64().unwrap();

        let created = fixture
            .direct(
                &app,
                "create",
                json!({
                    "path": "notes/one.md",
                    "frontmatter": { "title": "One" },
                    "body": "Direct body"
                }),
                2,
            )
            .await;
        assert_eq!(created["result"]["valid"], true);
        let revision = created["result"]["result"]["revision"]
            .as_str()
            .unwrap()
            .to_string();

        let read = fixture
            .direct(&app, "read", json!({ "path": "notes/one.md" }), 3)
            .await;
        assert_eq!(read["result"]["result"]["body"], "Direct body\n");

        let updated = fixture
            .direct(
                &app,
                "update",
                json!({
                    "path": "notes/one.md",
                    "patch": { "title": "Updated" },
                    "if_revision": revision
                }),
                4,
            )
            .await;
        assert_eq!(updated["result"]["valid"], true);

        let renamed = fixture
            .direct(
                &app,
                "rename",
                json!({ "from": "notes/one.md", "to": "notes/renamed.md" }),
                5,
            )
            .await;
        assert_eq!(renamed["result"]["valid"], true);

        let queried = fixture
            .direct(&app, "query", json!({ "include_body": true }), 6)
            .await;
        assert_eq!(
            queried["result"]["result"]["results"][0]["path"],
            "notes/renamed.md"
        );

        let validated = fixture.direct(&app, "validate", json!({}), 7).await;
        assert_eq!(validated["result"]["valid"], true);

        let type_document = "---\nkind: mdbase.type\nname: browsernote\nversion: 1\ndescription: Browser note\nschema:\n  dialect: json-schema-2020-12\n  value:\n    type: object\n    properties:\n      title: { type: string }\n---\n";
        let created_type = fixture
            .direct(&app, "create_type", json!({ "document": type_document }), 8)
            .await;
        assert_eq!(created_type["result"]["valid"], true);
        assert_eq!(
            created_type["result"]["result"]["path"],
            "_types/browsernote.md"
        );

        let read_type = fixture
            .direct(&app, "read_type", json!({ "name": "browsernote" }), 9)
            .await;
        assert_eq!(read_type["result"]["valid"], true);
        let type_revision = read_type["result"]["result"]["revision"]
            .as_str()
            .unwrap()
            .to_string();

        let updated_type = fixture
            .direct(
                &app,
                "update_type",
                json!({
                    "name": "browsernote",
                    "document": type_document.replace("Browser note", "Updated browser note"),
                    "if_revision": type_revision
                }),
                10,
            )
            .await;
        assert_eq!(updated_type["result"]["valid"], true);

        let changes = fixture
            .direct(&app, "changes", json!({ "after": cursor }), 11)
            .await;
        assert!(!changes["result"]["events"].as_array().unwrap().is_empty());

        let deleted = fixture
            .direct(&app, "delete", json!({ "path": "notes/renamed.md" }), 12)
            .await;
        assert_eq!(deleted["result"]["valid"], true);

        let duplicate = fixture.encrypted_request(
            "create",
            json!({ "path": "only-once.md", "frontmatter": { "title": "Once" } }),
            13,
        );
        let direct_response = fixture.send(&app, duplicate.clone()).await;
        let relay_response = fixture
            .agent
            .handle_relay_message(duplicate)
            .expect("relay response");
        let RelayMessage::EncryptedOperationResponse {
            envelope: relay_envelope,
        } = relay_response
        else {
            panic!("expected encrypted relay receipt")
        };
        assert_eq!(direct_response, relay_envelope);

        let final_query = fixture.direct(&app, "query", json!({}), 14).await;
        let only_once = final_query["result"]["result"]["results"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|record| record["path"] == "only-once.md")
            .count();
        assert_eq!(only_once, 1);

        fs::remove_dir_all(fixture.root).unwrap();
    }

    #[tokio::test]
    async fn preflight_pause_tampering_and_revocation_fail_closed() {
        let fixture = fixture();
        let app = router(fixture.agent.clone(), 28_485);
        let preflight = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::OPTIONS)
                    .uri("/v1/operations")
                    .header(HOST, "127.0.0.1:28485")
                    .header(ORIGIN, &fixture.origin)
                    .header(header::ACCESS_CONTROL_REQUEST_METHOD, "POST")
                    .header(header::ACCESS_CONTROL_REQUEST_HEADERS, "content-type")
                    .header("access-control-request-private-network", "true")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(preflight.status(), StatusCode::NO_CONTENT);
        assert_eq!(
            preflight
                .headers()
                .get("access-control-allow-private-network")
                .unwrap(),
            "true"
        );

        fixture.registry.set_paused(true).unwrap();
        let paused = fixture.direct(&app, "query", json!({}), 1).await;
        assert_eq!(paused["ok"], false);
        assert_eq!(paused["error"]["code"], "access_paused");
        fixture.registry.set_paused(false).unwrap();

        let mut tampered = fixture.encrypted_request("query", json!({}), 2);
        let RelayMessage::EncryptedOperationRequest { envelope } = &mut tampered else {
            unreachable!()
        };
        envelope.ciphertext.replace_range(
            ..1,
            if envelope.ciphertext.starts_with('A') {
                "B"
            } else {
                "A"
            },
        );
        let tampered_response = app
            .clone()
            .oneshot(request(
                Method::POST,
                "/v1/operations",
                &fixture.origin,
                Some(&serde_json::to_string(&tampered).unwrap()),
            ))
            .await
            .unwrap();
        assert_eq!(tampered_response.status(), StatusCode::FORBIDDEN);

        fixture.registry.replace_grants(&[]).unwrap();
        let revoked = app
            .oneshot(request(
                Method::POST,
                "/v1/operations",
                &fixture.origin,
                Some(
                    &serde_json::to_string(&fixture.encrypted_request("query", json!({}), 3))
                        .unwrap(),
                ),
            ))
            .await
            .unwrap();
        assert_eq!(revoked.status(), StatusCode::FORBIDDEN);
        assert!(revoked.headers().get(ACCESS_CONTROL_ALLOW_ORIGIN).is_none());

        fs::remove_dir_all(fixture.root).unwrap();
    }

    #[tokio::test]
    async fn concurrent_direct_requests_allow_authenticated_counter_reordering() {
        let fixture = fixture();
        let app = router(fixture.agent.clone(), 28_485);
        let created = fixture
            .direct(
                &app,
                "create",
                json!({ "path": "load.md", "frontmatter": { "title": "Load" } }),
                1,
            )
            .await;
        assert_eq!(created["result"]["valid"], true);

        // Exercise the full operation concurrency budget without turning this replay-window
        // assertion into a SQLite connection-saturation test on slower CI runners.
        let request_count = MAX_CONCURRENT_OPERATIONS as u64;
        let mut requests = (2..(2 + request_count))
            .map(|counter| fixture.encrypted_request("query", json!({}), counter))
            .collect::<Vec<_>>();
        requests.reverse();
        let responses = futures_util::future::join_all(
            requests
                .into_iter()
                .map(|request| fixture.send(&app, request)),
        )
        .await;
        assert_eq!(responses.len(), MAX_CONCURRENT_OPERATIONS);
        assert!(responses
            .iter()
            .all(|response| response.operation == "query" && !response.ciphertext.is_empty()));

        fs::remove_dir_all(fixture.root).unwrap();
    }

    struct Fixture {
        root: std::path::PathBuf,
        registry: CollectionRegistry,
        agent: Arc<AgentState>,
        origin: String,
        application: RelayIdentity,
        application_id: Uuid,
        grant_id: Uuid,
        encryption: GrantEncryption,
    }

    impl Fixture {
        fn encrypted_request(
            &self,
            operation: &str,
            input: serde_json::Value,
            counter: u64,
        ) -> RelayMessage {
            let binding =
                RelayBinding::from_grant(self.grant_id, self.application_id, &self.encryption);
            let keys = self
                .application
                .derive(&self.encryption.connector_public_key, &binding)
                .unwrap();
            let counter = counter.to_string();
            let metadata = RelayMetadata {
                binding: &binding,
                request_id: Uuid::new_v4(),
                operation,
                counter: &counter,
            };
            RelayMessage::EncryptedOperationRequest {
                envelope: metadata.envelope(
                    keys.encrypt_json(RelayDirection::Request, metadata, &input)
                        .unwrap(),
                ),
            }
        }

        async fn send(&self, app: &Router, message: RelayMessage) -> EncryptedRelayEnvelope {
            let response = app
                .clone()
                .oneshot(request(
                    Method::POST,
                    "/v1/operations",
                    &self.origin,
                    Some(&serde_json::to_string(&message).unwrap()),
                ))
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            let bytes = to_bytes(response.into_body(), MAX_REQUEST_BYTES)
                .await
                .unwrap();
            serde_json::from_value::<EncryptedRelayEnvelope>(
                serde_json::from_slice::<serde_json::Value>(&bytes).unwrap()["envelope"].clone(),
            )
            .unwrap()
        }

        async fn direct(
            &self,
            app: &Router,
            operation: &str,
            input: serde_json::Value,
            counter: u64,
        ) -> serde_json::Value {
            let request = self.encrypted_request(operation, input, counter);
            let RelayMessage::EncryptedOperationRequest {
                envelope: request_envelope,
            } = request.clone()
            else {
                unreachable!()
            };
            let response = self.send(app, request).await;
            let binding =
                RelayBinding::from_grant(self.grant_id, self.application_id, &self.encryption);
            let keys = self
                .application
                .derive(&self.encryption.connector_public_key, &binding)
                .unwrap();
            let metadata = RelayMetadata {
                binding: &binding,
                request_id: request_envelope.request_id,
                operation,
                counter: &request_envelope.counter,
            };
            keys.decrypt_json(RelayDirection::Response, metadata, &response.ciphertext)
                .unwrap()
        }
    }

    fn fixture() -> Fixture {
        let root = std::env::temp_dir().join(format!("mdbase-loopback-{}", Uuid::new_v4()));
        let registry = CollectionRegistry::open(root.join("state")).unwrap();
        let collection = registry
            .create(root.join("collection"), Some("Direct notes"))
            .unwrap();
        let connector = RelayIdentity::generate();
        let application = RelayIdentity::generate();
        let application_id = Uuid::new_v4();
        let grant_id = Uuid::new_v4();
        let origin = "https://tasks.example".to_string();
        let encryption = GrantEncryption {
            protocol_version: ENCRYPTED_RELAY_PROTOCOL_VERSION,
            suite: RELAY_ENCRYPTION_SUITE.to_string(),
            key_id: "direct-key".to_string(),
            scope_epoch: 1,
            connector_id: Uuid::new_v4(),
            collection_id: collection.id,
            application_public_key: application.public_key(),
            connector_public_key: connector.public_key(),
        };
        registry
            .replace_grants(&[GrantPolicy {
                id: grant_id,
                application_id,
                collection_id: collection.id,
                operations: [
                    "describe",
                    "changes",
                    "read",
                    "query",
                    "validate",
                    "create",
                    "update",
                    "delete",
                    "rename",
                    "read_type",
                    "create_type",
                    "update_type",
                ]
                .map(str::to_string)
                .to_vec(),
                scope: GrantScope::default(),
                application_name: "Tasks".to_string(),
                application_homepage: origin.clone(),
                application_origin: origin.clone(),
                application_icon: None,
                collection_name: "Direct notes".to_string(),
                notification_criteria: Vec::new(),
                created_at: "2026-07-22T00:00:00Z".to_string(),
                encryption: Some(encryption.clone()),
            }])
            .unwrap();
        let watcher = crate::watcher::CollectionWatchService::start(registry.clone());
        watcher.refresh(&registry.list().unwrap());
        Fixture {
            root,
            registry: registry.clone(),
            agent: Arc::new(AgentState::with_identity(
                registry, watcher, None, connector,
            )),
            origin,
            application,
            application_id,
            grant_id,
            encryption,
        }
    }

    fn request(method: Method, path: &str, origin: &str, body: Option<&str>) -> Request<Body> {
        let mut builder = Request::builder()
            .method(method)
            .uri(path)
            .header(HOST, "127.0.0.1:28485")
            .header(ORIGIN, origin);
        if body.is_some() {
            builder = builder.header(CONTENT_TYPE, "application/mdbase-connect+json");
        }
        builder
            .body(Body::from(body.unwrap_or_default().to_string()))
            .unwrap()
    }
}
