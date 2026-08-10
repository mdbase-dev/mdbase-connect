use crate::server::AgentState;
use axum::body::Body;
use axum::extract::{DefaultBodyLimit, State};
use axum::http::{header, HeaderMap, HeaderValue, Method, Request, Response, StatusCode};
use axum::response::IntoResponse;
use axum::{Json, Router};
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

mod control;
mod files;

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

    pub async fn stop(self) {
        for task in self.tasks {
            task.abort();
            let _ = task.await;
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
        .merge(control::routes())
        .merge(files::routes())
        .fallback(not_found)
        .layer(DefaultBodyLimit::max(files::MAX_FILE_REQUEST_BYTES))
        .with_state(state)
}

fn request_for_authorization(
    method: Method,
    uri: &'static str,
    headers: HeaderMap,
) -> Request<Body> {
    let request = Request::builder()
        .method(method)
        .uri(uri)
        .body(Body::empty())
        .expect("static direct file request");
    let (mut parts, _) = request.into_parts();
    parts.headers = headers;
    Request::from_parts(parts, Body::empty())
}

async fn operation_permit(state: &LoopbackState) -> Option<tokio::sync::OwnedSemaphorePermit> {
    tokio::time::timeout(
        Duration::from_secs(5),
        state.operations.clone().acquire_owned(),
    )
    .await
    .ok()?
    .ok()
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
    if origin == "null" {
        if !state.agent.origin_allowed(origin) || !within_rate_limit(state, origin) {
            return Err(());
        }
        return Ok(origin.to_string());
    }
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

fn cors_busy(message: &str, origin: &str) -> Response<Body> {
    let mut response = cors_error(
        StatusCode::SERVICE_UNAVAILABLE,
        "connector_busy",
        message,
        origin,
    );
    response
        .headers_mut()
        .insert(header::RETRY_AFTER, HeaderValue::from_static("1"));
    response
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
mod tests;
