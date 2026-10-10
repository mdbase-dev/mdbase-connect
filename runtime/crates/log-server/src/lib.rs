//! # mdbn-log-server: native host for the log service
//!
//! **Responsibility.** Runs [`mdbn_log_service`] as a network service: the
//! WebSocket and plain-HTTPS transport (`log-service-api.md` §2), the direct-transfer
//! object endpoint, and the push fan-out. Backends:
//! - [`pg::PgBackend`]: D2 candidate A, Postgres with per-collection row locks;
//! - the in-memory reference backend, for tests.
//!
//! **Topology.** One process is one gateway. Pushes come from Postgres `LISTEN`, so
//! several gateways behind a collection-hashing load balancer see every commit
//! (§13). Ephemeral streams live in the gateway that owns the collection.
//!
//! **Allowed dependencies.** Internal: `mdbn-wire`, `mdbn-log-service`. It is as
//! blind as the service it hosts.
#![allow(clippy::disallowed_methods, clippy::disallowed_types)]

pub mod fs;
pub mod metrics;
pub mod pg;
pub mod pool;

#[cfg(all(
    feature = "test-support",
    any(not(debug_assertions), target_arch = "wasm32")
))]
compile_error!("test-support deletion floors cannot be enabled in release or WASM builds");

#[cfg(feature = "test-support")]
pub mod test_support;

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use axum::Router;
use axum::body::Bytes as Body;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{DefaultBodyLimit, Path, RawQuery, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post, put};
use futures_util::{SinkExt, StreamExt};
use mdbn_log_service::auth::{
    NonceCache, collection_from_params, http_nonce, verify_http_claims, verify_token_with_budget,
};
use mdbn_log_service::backend::{Backend, Mode, Txn};
use mdbn_log_service::decode::Budget;
use mdbn_log_service::direct::{DownloadSpan, RangeRejection};
use mdbn_log_service::hub::{Hub, Push};
use mdbn_log_service::mem::{MemBackend, MemObjects};
use mdbn_log_service::model::{CommitNotice, object_key, parse_uuid};
use mdbn_log_service::outbox::Outbox;
use mdbn_log_service::service::{base64, staging_key, verify_direct};
use mdbn_log_service::session::{self, HubHost, Session};
use mdbn_log_service::{Code, ObjectStore, Service, ServiceError};
use mdbn_wire::common::Uuid;
use mdbn_wire::hash::sha256;
use mdbn_wire::log_service::{LsFrame, LsRequest, LsResponse};
use mdbn_wire::render::hex;
use mdbn_wire::schema::Wire;

use crate::fs::FsObjects;
use crate::pg::PgBackend;

/// Wall-clock milliseconds.
pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}

/// 32 random bytes.
pub fn random32() -> [u8; 32] {
    let mut b = [0u8; 32];
    getrandom::fill(&mut b).expect("entropy");
    b
}

/// The service over one of the native backends. An enum rather than a generic so
/// that every future is concretely typed (and so provably `Send` for tokio).
pub enum AnyService {
    /// In-memory reference backend.
    Mem(Service<MemBackend, MemObjects>),
    /// Postgres + local object files.
    Pg(Service<PgBackend, FsObjects>),
}

macro_rules! with_svc {
    ($s:expr, $v:ident => $body:expr) => {
        match $s {
            AnyService::Mem($v) => $body,
            AnyService::Pg($v) => $body,
        }
    };
}

struct ConnOut {
    outbox: Mutex<Outbox>,
    wake: tokio::sync::Notify,
    closed: AtomicBool,
}

/// A gateway: the service plus connection state.
pub struct Gateway {
    /// The service.
    pub svc: AnyService,
    hubs: Mutex<BTreeMap<Uuid, Hub>>,
    conns: Mutex<BTreeMap<u64, Arc<ConnOut>>>,
    next: AtomicU64,
    /// Expose `/debug/*` failure-injection hooks (tests and measurements only).
    pub debug_hooks: bool,
    /// Metrics.
    pub metrics: metrics::Metrics,
    http_nonces: NonceCache,
    #[cfg(feature = "test-support")]
    test_deletion_floors: Option<Arc<test_support::TestDeletionFloors>>,
}

impl HubHost for Gateway {
    fn with_hub<R>(&self, c: &Uuid, f: impl FnOnce(&mut Hub) -> R) -> R {
        let mut hubs = self.hubs.lock().unwrap();
        f(hubs.entry(*c).or_insert_with(|| Hub::new(*c)))
    }
    fn deliver(&self, pushes: Vec<Push>) {
        if pushes.is_empty() {
            return;
        }
        let conns = self.conns.lock().unwrap();
        for p in pushes {
            if let Some(c) = conns.get(&p.to) {
                self.metrics.pushes.fetch_add(1, Ordering::Relaxed);
                c.outbox.lock().unwrap().push(&p);
                c.wake.notify_one();
            }
        }
    }
    fn repair_append(&self, r: &mdbn_log_service::service::RepairAppend) {
        self.metrics.repairs.fetch_add(1, Ordering::Relaxed);
        self.metrics
            .repaired_items
            .fetch_add(r.foreign_items, Ordering::Relaxed);
        // Structured, for ops: a lost tail is an I1 violation even when repaired.
        eprintln!(
            "{{\"event\":\"service_lost_tail\",\"outcome\":\"repaired\",\"from\":{},\"to\":{},\"items\":{}}}",
            r.first, r.last, r.foreign_items
        );
    }
    fn credentials_revoked(&self, device: &Uuid) {
        let pushes: Vec<Push> = self
            .hubs
            .lock()
            .unwrap()
            .values_mut()
            .flat_map(|h| h.close_devices(&[*device], "forbidden"))
            .collect();
        self.deliver(pushes);
    }
    fn committed(&self, n: &CommitNotice, items: &[(u64, Vec<u8>)]) {
        self.metrics.commits.fetch_add(1, Ordering::Relaxed);
        // The committing gateway owns the collection's connections and pushes
        // (pg.rs, "Push"). Only in the global-lock measurement mode does LISTEN.
        let listen = matches!(&self.svc, AnyService::Pg(s) if s.backend.notify == pg::NotifyMode::InTransaction);
        if !listen {
            let pushes = self.with_hub(&n.collection, |h| h.on_commit(n, items));
            self.deliver(pushes);
        }
    }
}

impl Gateway {
    /// A gateway over a service.
    pub fn new(svc: AnyService, debug_hooks: bool) -> Arc<Self> {
        Arc::new(Gateway {
            svc,
            hubs: Mutex::new(BTreeMap::new()),
            conns: Mutex::new(BTreeMap::new()),
            next: AtomicU64::new(1),
            debug_hooks,
            metrics: metrics::Metrics::default(),
            http_nonces: NonceCache::default(),
            #[cfg(feature = "test-support")]
            test_deletion_floors: None,
        })
    }

    /// Explicit native conformance fixture; never enabled by the server factory.
    #[cfg(feature = "test-support")]
    pub fn new_with_test_deletion_floors(
        svc: AnyService,
        floors: Arc<test_support::TestDeletionFloors>,
    ) -> Arc<Self> {
        let mut gateway = Self::new(svc, true);
        Arc::get_mut(&mut gateway).unwrap().test_deletion_floors = Some(floors);
        gateway
    }

    async fn handle(&self, sess: &mut Session, frame: &[u8]) -> Option<Vec<u8>> {
        let budget = Budget::default();
        let request = budget.wire::<LsFrame>(frame);
        let method = match &request {
            Ok(LsFrame::Request(r)) => r.method.as_str(),
            _ => "malformed",
        };
        let start = std::time::Instant::now();
        let r = match request.as_ref() {
            Ok(LsFrame::Request(req)) => {
                with_svc!(&self.svc, s => session::handle_request(s, self, sess, req, now_ms(), random32(), &budget).await)
            }
            _ => Some(
                LsFrame::Response(LsResponse {
                    id: 0,
                    result: None,
                    error: Some(
                        request
                            .as_ref()
                            .err()
                            .cloned()
                            .unwrap_or_else(|| ServiceError::invalid("shape"))
                            .to_wire(),
                    ),
                })
                .to_bytes()
                .unwrap(),
            ),
        };
        let outcome = match r.as_deref().map(LsFrame::from_bytes) {
            Some(Ok(LsFrame::Response(LsResponse { error: Some(e), .. }))) => e.code,
            _ => "ok".to_string(),
        };
        self.metrics
            .observe(method, &outcome, start.elapsed().as_secs_f64() * 1000.0);
        r
    }

    /// Readiness: the backend answers.
    pub async fn ready(&self) -> Result<(), String> {
        match &self.svc {
            AnyService::Mem(_) => Ok(()),
            AnyService::Pg(s) => {
                let c = s.backend.pool().get().await?;
                c.simple_query("SELECT 1")
                    .await
                    .map_err(|e| e.to_string())?;
                Ok(())
            }
        }
    }

    /// Apply a notification (from `LISTEN`).
    pub async fn on_notice(&self, n: CommitNotice) {
        let (has, inline) = {
            let hubs = self.hubs.lock().unwrap();
            match hubs.get(&n.collection) {
                Some(h) => (true, h.subscriber_count() > 0),
                None => (false, false),
            }
        };
        if !has {
            return;
        }
        let mut items = Vec::new();
        if inline
            && n.first > 0
            && n.head >= n.first
            && n.head - n.first < 64
            && let AnyService::Pg(s) = &self.svc
        {
            items = s
                .backend
                .items_after(&n.collection, n.first - 1, n.head - n.first + 1)
                .await
                .unwrap_or_default();
        }
        let pushes = self.with_hub(&n.collection, |h| h.on_commit(&n, &items));
        self.deliver(pushes);
    }

    fn expire_streams(&self) {
        let now = now_ms();
        let pushes: Vec<Push> = self
            .hubs
            .lock()
            .unwrap()
            .values_mut()
            .flat_map(|h| h.expire(now))
            .collect();
        self.deliver(pushes);
    }
}

async fn ws_upgrade(State(gw): State<Arc<Gateway>>, ws: WebSocketUpgrade) -> Response {
    let nonce = random32();
    let mut resp = ws
        .max_message_size(8 << 20)
        .on_upgrade(move |socket| conn_loop(gw, socket, nonce));
    resp.headers_mut().insert(
        "x-mdbase-nonce",
        HeaderValue::from_str(&hex(&nonce)).unwrap(),
    );
    resp
}

async fn conn_loop(gw: Arc<Gateway>, socket: WebSocket, nonce: [u8; 32]) {
    let id = gw.next.fetch_add(1, Ordering::Relaxed);
    let out = Arc::new(ConnOut {
        outbox: Mutex::new(Outbox::default()),
        wake: tokio::sync::Notify::new(),
        closed: AtomicBool::new(false),
    });
    gw.conns.lock().unwrap().insert(id, out.clone());
    gw.metrics.connections.fetch_add(1, Ordering::Relaxed);
    let (mut sink, mut stream) = socket.split();
    let w = out.clone();
    let writer = tokio::spawn(async move {
        loop {
            let next = w.outbox.lock().unwrap().pop();
            match next {
                Some(f) => {
                    if sink.send(Message::Binary(f.into())).await.is_err() {
                        break;
                    }
                }
                None if w.closed.load(Ordering::Acquire) => break,
                None => w.wake.notified().await,
            }
        }
        let _ = sink.close().await;
    });
    let mut sess = Session::new(id, nonce);
    while let Some(Ok(msg)) = stream.next().await {
        match msg {
            Message::Binary(b) => {
                if let Some(r) = gw.handle(&mut sess, &b).await {
                    out.outbox.lock().unwrap().response(r);
                    out.wake.notify_one();
                }
            }
            Message::Close(_) => break,
            _ => {}
        }
    }
    session::close(&*gw, &sess);
    gw.conns.lock().unwrap().remove(&id);
    gw.metrics.connections.fetch_sub(1, Ordering::Relaxed);
    gw.metrics
        .pushes_dropped
        .fetch_add(out.outbox.lock().unwrap().dropped, Ordering::Relaxed);
    out.closed.store(true, Ordering::Release);
    out.wake.notify_one();
    let _ = writer.await;
}

fn header<'a>(h: &'a HeaderMap, k: &str) -> &'a str {
    h.get(k).and_then(|v| v.to_str().ok()).unwrap_or("")
}

async fn ready(State(gw): State<Arc<Gateway>>) -> Response {
    match gw.ready().await {
        Ok(()) => (StatusCode::OK, "ready").into_response(),
        Err(e) => (StatusCode::SERVICE_UNAVAILABLE, e).into_response(),
    }
}

async fn metrics_text(State(gw): State<Arc<Gateway>>) -> Response {
    (
        [("content-type", "text/plain; version=0.0.4")],
        gw.metrics.render(),
    )
        .into_response()
}

async fn nonce(State(gw): State<Arc<Gateway>>) -> String {
    let secret = with_svc!(&gw.svc, s => s.config.url_secret.clone());
    let r = random32();
    hex(&http_nonce(&secret, now_ms(), r[..8].try_into().unwrap()))
}

/// Plain HTTPS unary requests (§2, §3): the body is an `ls-request` frame.
async fn rpc(State(gw): State<Arc<Gateway>>, headers: HeaderMap, body: Body) -> Response {
    let budget = Budget::default();
    let decoded = budget.wire::<LsFrame>(&body);
    let (id, resp) = match decoded {
        Ok(LsFrame::Request(req)) => (req.id, rpc_inner(&gw, &headers, &body, &req, &budget).await),
        Err(e) => (0, Err(e)),
        _ => (0, Err(ServiceError::invalid("shape"))),
    };
    let frame = match resp {
        Ok(v) => LsResponse {
            id,
            result: Some(v),
            error: None,
        },
        Err(e) => LsResponse {
            id,
            result: None,
            error: Some(e.to_wire()),
        },
    };
    (
        [("content-type", "application/vnd.mdbase.v1+cbor")],
        LsFrame::Response(frame).to_bytes().unwrap(),
    )
        .into_response()
}

async fn rpc_inner(
    gw: &Gateway,
    h: &HeaderMap,
    body: &[u8],
    req: &LsRequest,
    budget: &Budget,
) -> Result<mdbn_wire::cbor::Cbor, ServiceError> {
    let token = header(h, "authorization").trim_start_matches("Bearer ");
    with_svc!(&gw.svc, s => {
        let claims = verify_token_with_budget(token, &s.config.token_issuers, now_ms(), budget)?;
        let p = verify_http_claims(
            token,
            header(h, "x-mdbase-nonce"),
            header(h, "x-mdbase-sig"),
            "/v1/rpc",
            &req.method,
            body,
            &collection_from_params(&req.params),
            &claims,
            &s.config.url_secret,
            &gw.http_nonces,
            now_ms(),
        )?;
        // Test-only independent registry setup still requires actual CP token,
        // possession and nonce validation above. No production dispatch exists.
        #[cfg(feature = "test-support")]
        if let Some(floors) = &gw.test_deletion_floors
            && let Some(result) = floors.call(&gw.svc, &p, &req.method, &req.params)
        {
            return result;
        }
        let out = s.call_with_budget(&p, &req.method, &req.params, now_ms(), budget).await?;
        if let Some(n) = &out.notice {
            gw.committed(n, &out.items);
        }
        if let Some(r) = &out.repair {
            gw.repair_append(r);
        }
        Ok(out.result)
    })
}

fn err_status(e: &ServiceError) -> StatusCode {
    match e.code {
        Code::Forbidden | Code::Unauthenticated => StatusCode::FORBIDDEN,
        Code::NotFound => StatusCode::NOT_FOUND,
        Code::Invalid => StatusCode::BAD_REQUEST,
        Code::TooLarge => StatusCode::PAYLOAD_TOO_LARGE,
        _ => StatusCode::SERVICE_UNAVAILABLE,
    }
}

/// Direct upload: the pre-signed PUT of §6 (verifies size and the SHA-256 header,
/// as R2/S3 do with `x-amz-checksum-sha256`).
async fn object_put(
    State(gw): State<Arc<Gateway>>,
    Path((c, a)): Path<(String, String)>,
    RawQuery(q): RawQuery,
    headers: HeaderMap,
    body: Body,
) -> Response {
    let r: Result<(), ServiceError> = async {
        let secret = with_svc!(&gw.svc, s => s.config.url_secret.clone());
        let op = verify_direct(&secret, &c, &a, q.as_deref().unwrap_or(""), now_ms())?;
        let (size, ck) = op
            .expect
            .ok_or_else(|| ServiceError::reason(Code::Forbidden, "op"))?;
        if body.len() as u64 != size || sha256(&body) != ck {
            return Err(ServiceError::invalid("checksum"));
        }
        let want = mdbn_log_service::service::base64(&ck.0);
        if header(&headers, "x-amz-checksum-sha256") != want {
            return Err(ServiceError::invalid("checksum_header"));
        }
        // Into the device's staging key; commit_object verifies and copies it
        // write-once to the final key.
        let dev = op
            .device
            .ok_or_else(|| ServiceError::reason(Code::Forbidden, "op"))?;
        let key = staging_key(&op.collection, &op.address, &dev);
        with_svc!(&gw.svc, s => s.objects.put(&key, body.to_vec()).await)
    }
    .await;
    match r {
        Ok(()) => StatusCode::OK.into_response(),
        Err(e) => (err_status(&e), e.to_string()).into_response(),
    }
}

/// Direct download, with HTTP Range.
async fn object_get(
    State(gw): State<Arc<Gateway>>,
    Path((c, a)): Path<(String, String)>,
    RawQuery(q): RawQuery,
    headers: HeaderMap,
    method: axum::http::Method,
) -> Response {
    if method != axum::http::Method::GET {
        return StatusCode::METHOD_NOT_ALLOWED.into_response();
    }
    let mut range_total = None;
    let r: Result<(Vec<u8>, DownloadSpan, String), ServiceError> = async {
        let budget = Budget::default();
        let secret = with_svc!(&gw.svc, s => s.config.url_secret.clone());
        let query = q.as_deref().unwrap_or("");
        let op = verify_direct(&secret, &c, &a, query, now_ms())?;
        if op.put {
            return Err(ServiceError::reason(Code::Forbidden, "op"));
        }
        let meta = with_svc!(&gw.svc, s => async {
            let mut tx = s.backend.begin_with_budget(&op.collection, Mode::Read, &budget).await?;
            let meta = tx.objects(&[op.address]).await?.pop().flatten()
                .filter(|m| m.committed).ok_or_else(|| ServiceError::new(Code::NotFound))?;
            tx.commit().await?;
            Ok::<_, ServiceError>(meta)
        }.await)?;
        if !matches!(meta.kind, 16..=18)
            || meta.size != op.sealed_size
            || meta.checksum != op.sealed_checksum
        {
            return Err(ServiceError::reason(Code::Unavailable, "object_metadata"));
        }
        range_total = Some(meta.size);
        // A repeated Range field is one combined multi-range value to a web
        // `Headers.get`, which the strict single-span contract rejects; decline
        // it here too rather than serving whichever field arrived first.
        let mut range_fields = headers.get_all("range").iter();
        let range_header = range_fields
            .next()
            .map(|v| v.to_str())
            .transpose()
            .map_err(|_| ServiceError::invalid("range"))?;
        if range_fields.next().is_some() {
            return Err(ServiceError::invalid("range"));
        }
        let span = DownloadSpan::resolve(range_header, meta.size).map_err(|e| match e {
            RangeRejection::ObjectSize => {
                ServiceError::reason(Code::Unavailable, "object_metadata")
            }
            _ => ServiceError::invalid("range"),
        })?;
        let key = object_key(&op.collection, &op.address);
        let range = span.partial().then_some((span.offset(), span.length()));
        let bytes = with_svc!(&gw.svc, s => s.objects.get(&key, range).await)?
            .ok_or_else(|| ServiceError::new(Code::NotFound))?;
        if bytes.len() as u64 != span.length()
            || (!span.partial() && sha256(&bytes) != meta.checksum)
        {
            return Err(ServiceError::reason(Code::Unavailable, "object_span"));
        }
        verify_direct(&secret, &c, &a, query, now_ms())?;
        Ok((bytes, span, base64(&meta.checksum.0)))
    }
    .await;
    match r {
        Ok((b, span, checksum)) => {
            let st = if span.partial() {
                StatusCode::PARTIAL_CONTENT
            } else {
                StatusCode::OK
            };
            let mut response = (st, b).into_response();
            let headers = response.headers_mut();
            headers.insert(
                "content-type",
                HeaderValue::from_static("application/octet-stream"),
            );
            headers.insert(
                "content-length",
                HeaderValue::from_str(&span.length().to_string()).expect("bounded ASCII"),
            );
            headers.insert("accept-ranges", HeaderValue::from_static("bytes"));
            headers.insert(
                "x-amz-checksum-sha256",
                HeaderValue::from_str(&checksum).expect("base64 ASCII"),
            );
            if let Some(content_range) = span.content_range() {
                headers.insert(
                    "content-range",
                    HeaderValue::from_str(&content_range).expect("bounded ASCII"),
                );
            }
            response
        }
        Err(e) if e.code == Code::Invalid && e.reason.as_deref() == Some("range") => {
            let mut response = (StatusCode::RANGE_NOT_SATISFIABLE, "range").into_response();
            if let Some(total) = range_total {
                response.headers_mut().insert(
                    "content-range",
                    HeaderValue::from_str(&format!("bytes */{total}")).expect("bounded ASCII"),
                );
            }
            response
        }
        Err(e) => (err_status(&e), e.to_string()).into_response(),
    }
}

/// `/debug/lose_tail/{collection}/{n}`: simulate a failover that lost the last `n`
/// acknowledged items (an asynchronous standby promoted). Only with `debug_hooks`.
async fn debug_lose_tail(
    State(gw): State<Arc<Gateway>>,
    Path((c, n)): Path<(String, u64)>,
) -> Response {
    if !gw.debug_hooks {
        return StatusCode::NOT_FOUND.into_response();
    }
    let Some(c) = parse_uuid(&c) else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    match &gw.svc {
        AnyService::Mem(s) => s.backend.lose_tail(&c, n, &s.config.roots).await,
        AnyService::Pg(s) => {
            if let Err(e) = s.backend.lose_tail(&c, n, &s.config.roots).await {
                return (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response();
            }
        }
    }
    StatusCode::OK.into_response()
}

/// The router.
pub fn router(gw: Arc<Gateway>) -> Router {
    Router::new()
        .route("/v1/ws", get(ws_upgrade))
        .route("/v1/rpc", post(rpc))
        .route("/v1/nonce", get(nonce))
        .route("/v1/o/{c}/{a}", put(object_put).get(object_get))
        .route("/debug/lose_tail/{c}/{n}", post(debug_lose_tail))
        .route("/health", get(|| async { "ok" }))
        .route("/ready", get(ready))
        .route("/metrics", get(metrics_text))
        .layer(DefaultBodyLimit::max(10 << 20))
        .with_state(gw)
}

async fn forward_notifications<S, T>(
    mut conn: tokio_postgres::Connection<S, T>,
    tx: tokio::sync::mpsc::UnboundedSender<String>,
) where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
    T: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    let mut s = futures_util::stream::poll_fn(move |cx| conn.poll_message(cx));
    while let Some(Ok(m)) = s.next().await {
        if let tokio_postgres::AsyncMessage::Notification(n) = m {
            let _ = tx.send(n.payload().to_string());
        }
    }
}

/// Listen on Postgres notifications and push.
pub async fn pg_listener(gw: Arc<Gateway>, url: String) -> Result<(), String> {
    let cfg: tokio_postgres::Config = url.parse().map_err(|e| format!("{e}"))?;
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    // TLS exactly as the pool: required off loopback.
    let client = if pg::tls_required(&cfg).map_err(|e| e.to_string())? {
        let (client, conn) = cfg
            .connect(pg::tls_connector().map_err(|e| e.to_string())?)
            .await
            .map_err(|e| e.to_string())?;
        tokio::spawn(forward_notifications(conn, tx));
        client
    } else {
        let (client, conn) = cfg
            .connect(tokio_postgres::NoTls)
            .await
            .map_err(|e| e.to_string())?;
        tokio::spawn(forward_notifications(conn, tx));
        client
    };
    client
        .batch_execute(&format!("LISTEN {}", pg::CHANNEL))
        .await
        .map_err(|e| e.to_string())?;
    while let Some(p) = rx.recv().await {
        if let Some(n) = CommitNotice::from_text(&p) {
            gw.on_notice(n).await;
        }
    }
    drop(client);
    Err("listener connection closed".into())
}

/// Service configuration for local runs: the testkit control plane named `label`
/// (its root and token issuer are pinned), and `public_base` for transfer URLs.
pub fn testkit_config(label: &str, public_base: &str) -> mdbn_log_service::Config {
    let cp = mdbn_log_service::testkit::ControlPlane::new(label);
    mdbn_log_service::Config {
        roots: vec![cp.root_pk()],
        token_issuers: vec![cp.issuer_pk()],
        url_secret: sha256(format!("{label}/url-secret").as_bytes()).0.to_vec(),
        public_base: public_base.to_string(),
    }
}

/// Serve until the listener fails. Also runs the stream idle sweep.
pub async fn serve(gw: Arc<Gateway>, listener: tokio::net::TcpListener) -> std::io::Result<()> {
    let g = gw.clone();
    tokio::spawn(async move {
        let mut t = tokio::time::interval(Duration::from_secs(5));
        loop {
            t.tick().await;
            g.expire_streams();
        }
    });
    axum::serve(listener, router(gw)).await
}
