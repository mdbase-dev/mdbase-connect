use crate::server::AgentState;
use axum::body::Body;
use axum::extract::{DefaultBodyLimit, State};
use axum::http::{header, HeaderMap, HeaderValue, Method, Request, Response, StatusCode};
use axum::response::IntoResponse;
use axum::{Json, Router};
use futures_util::StreamExt;
use serde_json::json;
use std::collections::HashMap;
use std::future::Future;
use std::io;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
#[cfg(test)]
use std::sync::{Condvar, LazyLock, Weak};
use std::task::{Context, Poll};
use std::time::{Duration, Instant};
use tokio::net::TcpListener;
use tokio::task::{JoinHandle, JoinSet};
use tower::Service;
#[cfg(test)]
use uuid::Uuid;

const MAX_REQUEST_BYTES: usize = 3 * 1024 * 1024;
const MAX_REQUESTS_PER_MINUTE_PER_ORIGIN: u32 = 600;

mod control;
mod files;

#[derive(Clone)]
struct LoopbackState {
    agent: Arc<AgentState>,
    port: u16,
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
    let mut connections = JoinSet::new();
    loop {
        tokio::select! {
            accepted = listener.accept() => {
                let (stream, peer) = accepted?;
                let service = AbortStaleService { inner: app.clone() };
                connections.spawn(async move {
                    let io = hyper_util::rt::TokioIo::new(stream);
                    let service = hyper_util::service::TowerToHyperService::new(service);
                    if let Err(error) = hyper::server::conn::http1::Builder::new()
                        .serve_connection(io, service)
                        .await
                    {
                        tracing::debug!(%error, %peer, "loopback connection closed");
                    }
                });
            }
            Some(_) = connections.join_next(), if !connections.is_empty() => {}
        }
    }
}

#[derive(Clone)]
struct AbortStaleService {
    inner: Router,
}

#[derive(Clone, Debug)]
struct AbortTransport;

impl Service<Request<hyper::body::Incoming>> for AbortStaleService {
    type Response = Response<Body>;
    type Error = io::Error;
    type Future = Pin<Box<dyn Future<Output = Result<Self::Response, Self::Error>> + Send>>;

    fn poll_ready(&mut self, context: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        <Router as Service<Request<Body>>>::poll_ready(&mut self.inner, context)
            .map_err(|never| match never {})
    }

    fn call(&mut self, request: Request<hyper::body::Incoming>) -> Self::Future {
        let request = request.map(Body::new);
        let future = <Router as Service<Request<Body>>>::call(&mut self.inner, request);
        Box::pin(async move {
            let response = match future.await {
                Ok(response) => response,
                Err(never) => match never {},
            };
            finish_response(response)
        })
    }
}

fn finish_response(mut response: Response<Body>) -> io::Result<Response<Body>> {
    if response
        .extensions_mut()
        .remove::<AbortTransport>()
        .is_some()
    {
        return Err(io::Error::new(
            io::ErrorKind::ConnectionAborted,
            "stale loopback operation publication aborted",
        ));
    }
    Ok(response)
}

fn abort_transport() -> Response<Body> {
    let mut response = Response::new(Body::empty());
    response.extensions_mut().insert(AbortTransport);
    response
}

fn fenced_response(
    response: Response<Body>,
    agent: Arc<AgentState>,
    policy: crate::server::policy::PolicyRevisionPermit,
    deadline: tokio::time::Instant,
    admission: Option<crate::admission::AdmissionPermit>,
) -> Response<Body> {
    #[cfg(test)]
    pause_before_publication(&agent);
    let Ok(publication) = agent.acquire_publication_permit(&policy, deadline) else {
        return abort_transport();
    };
    let (mut parts, body) = response.into_parts();
    parts.headers.remove(header::CONTENT_LENGTH);
    let stream = body.into_data_stream();
    let stream = futures_util::stream::unfold(
        (stream, publication, admission, agent),
        move |(mut stream, publication, admission, agent)| async move {
            if !agent.publication_is_current(&publication) {
                return None;
            }
            let item = stream.next().await?;
            if !agent.publication_is_current(&publication) {
                return None;
            }
            Some((item, (stream, publication, admission, agent)))
        },
    );
    Response::from_parts(parts, Body::from_stream(stream))
}

#[cfg(test)]
struct PublicationPauseHook {
    id: Uuid,
    agent: Weak<AgentState>,
    reached: std::sync::mpsc::SyncSender<()>,
    release: Arc<(Mutex<bool>, Condvar)>,
    claimed: bool,
}

#[cfg(test)]
static PUBLICATION_PAUSE_HOOK: LazyLock<Mutex<Option<PublicationPauseHook>>> =
    LazyLock::new(|| Mutex::new(None));

#[cfg(test)]
struct PublicationPauseGuard {
    id: Uuid,
    reached: std::sync::mpsc::Receiver<()>,
    release: Arc<(Mutex<bool>, Condvar)>,
}

#[cfg(test)]
impl PublicationPauseGuard {
    fn install(agent: &Arc<AgentState>) -> io::Result<Self> {
        let id = Uuid::new_v4();
        let (reached_tx, reached) = std::sync::mpsc::sync_channel(1);
        let release = Arc::new((Mutex::new(false), Condvar::new()));
        let mut hook = PUBLICATION_PAUSE_HOOK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if hook.is_some() {
            return Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                "a publication pause hook is already installed",
            ));
        }
        *hook = Some(PublicationPauseHook {
            id,
            agent: Arc::downgrade(agent),
            reached: reached_tx,
            release: release.clone(),
            claimed: false,
        });
        Ok(Self {
            id,
            reached,
            release,
        })
    }

    fn reached(&self) -> Result<(), std::sync::mpsc::TryRecvError> {
        self.reached.try_recv()
    }

    fn release(&self) {
        let (released, changed) = &*self.release;
        let mut released = released
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *released = true;
        changed.notify_all();
    }
}

#[cfg(test)]
impl Drop for PublicationPauseGuard {
    fn drop(&mut self) {
        self.release();
        let mut hook = PUBLICATION_PAUSE_HOOK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if hook.as_ref().is_some_and(|hook| hook.id == self.id) {
            *hook = None;
        }
    }
}

#[cfg(test)]
fn pause_before_publication(agent: &Arc<AgentState>) {
    let pause = {
        let mut hook = PUBLICATION_PAUSE_HOOK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let Some(hook) = hook.as_mut() else {
            return;
        };
        if hook.claimed
            || !hook
                .agent
                .upgrade()
                .is_some_and(|target| Arc::ptr_eq(&target, agent))
        {
            return;
        }
        hook.claimed = true;
        let _ = hook.reached.send(());
        hook.release.clone()
    };

    let (released, changed) = &*pause;
    let mut released = released
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    while !*released {
        released = changed
            .wait(released)
            .unwrap_or_else(|poisoned| poisoned.into_inner());
    }
}

fn router(agent: Arc<AgentState>, port: u16) -> Router {
    let state = LoopbackState {
        agent,
        port,
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
