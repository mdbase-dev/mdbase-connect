//! The log-service transport of one synced collection: a WebSocket to
//! `{log}/v1/ws?c=<collection>` (log-service-api §3), owned by its own thread.
//!
//! The replica stays on the collection's runtime thread and keeps every log
//! semantic. This transport only moves canonical frames, encoded and decoded by
//! [`mdbn_replica::log_codec`] on the runtime side.
//!
//! - **Hello.** The server's nonce comes in the upgrade response. The token comes
//!   from a [`TokenSource`]. The possession proof is signed by the replica
//!   ([`Event::Proof`] → `Replica::log_hello_proof`), so the transport never holds a
//!   device key.
//! - **Calls** keep the replica's call IDs; the hello uses an ID outside its range.
//!   While down, a call is answered [`Event::Offline`]. A call in flight when the
//!   connection drops is answered [`Event::Lost`] (outcome unknown).
//! - **Reconnect** backs off from 1 s to 30 s. The session is renewed a minute
//!   before the token expires.
//! - **TLS** uses the daemon's rustls config with the OS roots. Plain `ws` is
//!   accepted only on loopback (tests, local log server).
//! - **Large objects** (log-service-api §6). A sealed object over the 1 MiB inline
//!   limit rides with its call as [`Outbound::object`]. When `put_object` answers
//!   `upload`, the transport PUTs those bytes to the signed target
//!   ([`crate::direct::upload`]), then sends `commit_object` on this socket, and the
//!   replica's call is answered only by the commit: `stored` on `true`. When
//!   `get_object` answers with a direct GET, the transport downloads and verifies the
//!   whole object ([`crate::direct::download`]) and answers with it inline. The
//!   replica sees the same canonical frames as for a small object. Expired URLs and
//!   transit failures answer `unavailable`, so the replica retries the call and gets
//!   a fresh URL; `put_object` (`exists`) and `commit_object` are idempotent. Signed
//!   URLs are never logged.

use std::collections::BTreeMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use crate::log_generation::RetireOnDrop;
pub use crate::log_generation::{Generation, Session};
use futures_util::{SinkExt, StreamExt};
use mdbn_replica::replica::LogReplyScope;
use mdbn_wire::cbor::Cbor;
use mdbn_wire::common::{B16, B32, B64, Bytes, Version};
use mdbn_wire::log_service::{
    CommitObjectParams, GetObjectResult, LsError, LsFrame, LsHelloParams, LsRequest, LsResponse,
    PutObjectResult, PutStatus,
};
use mdbn_wire::schema::Wire;
use tokio::sync::{mpsc, oneshot};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use zeroize::Zeroizing;

/// The hello's request ID: replica call IDs count up from 1 and never reach it.
const HELLO_ID: u64 = 1 << 62;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const HELLO_TIMEOUT: Duration = Duration::from_secs(15);
const RENEW_BEFORE_MS: i64 = 60_000;
const TOKEN_TIMEOUT: Duration = Duration::from_secs(15);
const PROOF_TIMEOUT: Duration = Duration::from_secs(10);
/// Calls queued for the transport at once; beyond, a call is answered offline.
pub const MAX_QUEUED_CALLS: usize = 256;
/// Inbound frames handed to the runtime and not yet processed, in bytes (each frame
/// also counts [`FRAME_UNIT`]). At the budget the transport stops reading the socket
/// until the runtime catches up: back-pressure, not a growing queue.
pub const INBOUND_BUDGET: usize = 32 * 1024 * 1024;
const FRAME_UNIT: usize = 4096;
/// Bytes of calls queued or in flight (unanswered), with [`FRAME_UNIT`] per call.
/// Beyond it a call is answered offline at once.
pub const OUTBOUND_BUDGET: usize = 32 * 1024 * 1024;
/// A call unanswered this long ends the session: every call then in flight is lost
/// (outcome unknown) and the transport reconnects.
pub const CALL_TIMEOUT: Duration = Duration::from_secs(120);
const MAX_FRAME: usize = mdbn_replica::log_codec::MAX_LOG_FRAME;
/// Direct transfers running at once on one connection (each buffers at most one
/// sealed object, ≤ 9 MiB).
pub const MAX_DIRECT_TRANSFERS: usize = 4;
/// How long a call may wait on its direct transfer: the signed URL's lifetime
/// (15 minutes) plus slack. The transfer itself stops at the URL's expiry.
const DIRECT_DEADLINE: Duration = Duration::from_secs(16 * 60);

/// A log access token and when it expires (ms since the epoch).
#[derive(Clone)]
pub struct Token {
    /// The bearer token (never logged).
    pub token: Zeroizing<String>,
    /// Expiry.
    pub expires_at_ms: i64,
}

impl std::fmt::Debug for Token {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Token(expires_at_ms={})", self.expires_at_ms)
    }
}

/// Where tokens come from: the control plane (a device's role-0, one-collection
/// token), or a LAB/test issuer.
pub trait TokenSource: Send + Sync {
    /// A token valid for at least a little while.
    fn token(&self) -> Pin<Box<dyn Future<Output = Result<Token, String>> + Send + '_>>;
    /// The last token was refused: drop any cached one.
    fn refused(&self) {}
    /// Actual captured account/registration incarnation, re-read on every use.
    /// Missing custody/currentness is DENY, never a caller-provided wire flag.
    fn current(&self) -> Result<(), String> {
        Err("log source lacks a current-authority fence".into())
    }
}

/// Where to connect.
#[derive(Debug, Clone)]
pub struct LinkConfig {
    /// `wss://…` (or `ws://` on loopback): the log service origin.
    pub log_url: String,
    /// Collection.
    pub collection: B16,
    /// This device; `None` only for the control plane's own credential (tooling).
    pub device: Option<B16>,
    /// Inbound byte budget ([`INBOUND_BUDGET`] unless testing back-pressure).
    pub inbound_budget: usize,
    /// Outbound byte budget ([`OUTBOUND_BUDGET`] unless testing).
    pub outbound_budget: usize,
    /// How long a call may stay unanswered ([`CALL_TIMEOUT`] unless testing).
    pub call_timeout: Duration,
}

impl LinkConfig {
    /// The default budgets and timeout.
    pub fn new(log_url: String, collection: B16, device: Option<B16>) -> LinkConfig {
        LinkConfig {
            log_url,
            collection,
            device,
            inbound_budget: INBOUND_BUDGET,
            outbound_budget: OUTBOUND_BUDGET,
            call_timeout: CALL_TIMEOUT,
        }
    }
}

/// What the transport tells the runtime thread. Reply and push frames hold part of
/// the inbound budget until dropped (after the runtime has handled them).
pub enum Event {
    /// Connected and authenticated (`LogPush::Reconnected`).
    Up {
        /// Original producer captured before all handshake awaits.
        generation: Generation,
        /// Exact Replica binding, or denial; rechecked after this await.
        reply: oneshot::Sender<Option<Session>>,
    },
    /// Exact authenticated session retired; an old Down cannot close new Up.
    Down(Session),
    /// A response frame for call `id` (decode with `log_codec::reply`).
    Reply {
        /// Call ID.
        id: u64,
        /// The call's method.
        method: String,
        /// The canonical frame.
        bytes: Vec<u8>,
        /// Its share of the inbound budget.
        budget: Budget,
        /// Captured before queue/send, never reconstructed from response labels.
        scope: LogReplyScope,
        /// Original authenticated runtime handback.
        session: Session,
    },
    /// Down retires original calls as unknown before these diagnostics arrive.
    Lost {
        /// Original wire call ID (diagnostic only).
        id: u64,
        /// Original captured scope.
        scope: LogReplyScope,
        /// Exact session to retire.
        session: Session,
    },
    /// Call was never sent on this transport (not rollback evidence).
    Offline {
        /// Original wire call ID (diagnostic only).
        id: u64,
        /// Original captured scope.
        scope: LogReplyScope,
        /// Exact authenticated binding.
        session: Session,
    },
    /// Current producer must be checked BEFORE decoding a push.
    Push(Vec<u8>, Budget, Session),
    /// Sign the hello: `H("mdbase/v1/ls-hello", nonce ‖ token)` with the device key.
    Proof {
        /// Server nonce.
        nonce: [u8; 32],
        /// The token being presented.
        token: Zeroizing<String>,
        /// Captured producer, checked before and after signing.
        generation: Generation,
        /// The signature, or `None` if the replica refuses.
        reply: oneshot::Sender<Option<[u8; 64]>>,
    },
}

/// A frame's share of the inbound budget, released when dropped.
pub struct Budget(#[allow(dead_code)] Option<tokio::sync::OwnedSemaphorePermit>);

impl Budget {
    /// No budget (frames built outside a transport, e.g. in tests).
    pub fn none() -> Budget {
        Budget(None)
    }
}

impl std::fmt::Debug for Event {
    // Never the token, never frame bytes.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Event::Up { .. } => f.write_str("Up"),
            Event::Down(_) => f.write_str("Down"),
            Event::Reply {
                id, method, bytes, ..
            } => {
                write!(
                    f,
                    "Reply {{ id: {id}, method: {method:?}, bytes: {} }}",
                    bytes.len()
                )
            }
            Event::Lost { id, .. } => write!(f, "Lost({id})"),
            Event::Offline { id, .. } => write!(f, "Offline({id})"),
            Event::Push(b, _, _) => write!(f, "Push({} bytes)", b.len()),
            Event::Proof { .. } => f.write_str("Proof { nonce, token: <redacted> }"),
        }
    }
}

/// One call to send.
#[derive(Debug)]
pub struct Outbound {
    /// The replica's call ID (also inside the frame).
    pub id: u64,
    /// Method (to decode the reply).
    pub method: String,
    /// The canonical request frame.
    pub frame: Vec<u8>,
    /// A `put_object`'s sealed object when it is over the inline limit and so
    /// not in `frame`: uploaded directly if the service asks for it.
    pub object: Option<SealedObject>,
    /// Original Replica scope, captured before calling send.
    pub scope: LogReplyScope,
    /// The runtime's opaque authenticated handback.
    pub session: Session,
}

/// A sealed object travelling beside its `put_object` frame.
pub struct SealedObject {
    /// Collection (for `commit_object`).
    pub collection: mdbn_wire::common::Uuid,
    /// Address (for `commit_object`).
    pub address: B32,
    /// The exact sealed bytes.
    pub bytes: bytes::Bytes,
}

impl std::fmt::Debug for SealedObject {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "SealedObject({} bytes)", self.bytes.len())
    }
}

/// A queued call and its share of the outbound budget (held until answered).
struct Queued {
    call: Outbound,
    _budget: tokio::sync::OwnedSemaphorePermit,
}

fn units(bytes: usize, budget: usize) -> u32 {
    (1 + bytes / FRAME_UNIT).min((budget / FRAME_UNIT).max(1)) as u32
}

/// A running transport. Dropping the handle stops it.
pub struct Link {
    tx: mpsc::Sender<Queued>,
    out_budget: Arc<tokio::sync::Semaphore>,
    out_total: usize,
    stop: Option<oneshot::Sender<()>>,
    thread: Option<std::thread::JoinHandle<()>>,
    current: Arc<std::sync::Mutex<Option<Generation>>>,
}

impl Link {
    /// Start the transport on its own thread. `events` is called from that thread.
    pub fn spawn(
        cfg: LinkConfig,
        tokens: Arc<dyn TokenSource>,
        events: Box<dyn Fn(Event) + Send>,
    ) -> std::io::Result<Link> {
        let (tx, rx) = mpsc::channel(MAX_QUEUED_CALLS);
        let (stop_tx, stop_rx) = oneshot::channel();
        let out_total = cfg.outbound_budget;
        let out_budget = Arc::new(tokio::sync::Semaphore::new((out_total / FRAME_UNIT).max(1)));
        let current = Arc::new(std::sync::Mutex::new(None));
        let producer = current.clone();
        let name = format!("log-{}", crate::secrets::hex(&cfg.collection.0[..4]));
        let thread = std::thread::Builder::new().name(name).spawn(move || {
            let rt = match tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
            {
                Ok(rt) => rt,
                Err(e) => {
                    tracing::error!(error = %e, "log transport runtime");
                    return;
                }
            };
            rt.block_on(async move {
                tokio::select! {
                    _ = run(cfg, tokens, rx, events, producer) => {}
                    _ = stop_rx => {}
                }
            });
        })?;
        Ok(Link {
            tx,
            out_budget,
            out_total,
            stop: Some(stop_tx),
            thread: Some(thread),
            current,
        })
    }

    /// Queue a call. `false` if the transport has stopped, [`MAX_QUEUED_CALLS`] are
    /// queued, or the outbound byte budget is spent by queued and unanswered calls:
    /// the caller answers it offline.
    pub fn send(&self, call: Outbound) -> bool {
        // Queue acceptance is not send/authority. The socket actor checks exact
        // current session before sending; stale queued scopes are answered offline.
        let size = call.frame.len() + call.object.as_ref().map_or(0, |o| o.bytes.len());
        let n = units(size, self.out_total);
        let Ok(permit) = self.out_budget.clone().try_acquire_many_owned(n) else {
            return false;
        };
        self.tx
            .try_send(Queued {
                call,
                _budget: permit,
            })
            .is_ok()
    }
}

impl Drop for Link {
    fn drop(&mut self) {
        if let Ok(current) = self.current.lock()
            && let Some(g) = &*current
        {
            g.retire();
        }
        if let Some(s) = self.stop.take() {
            let _ = s.send(());
        }
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

/// The WebSocket URL for `collection` under `log_url`, refusing anything but `wss`
/// (or `ws` on loopback).
pub fn ws_url(log_url: &str, collection: &B16) -> Result<String, String> {
    let (scheme, rest) = log_url.split_once("://").ok_or("log URL: missing scheme")?;
    let host = rest.split(['/', '?', '#']).next().unwrap_or_default();
    if host.is_empty() || host.contains('@') {
        return Err("log URL: bad host".into());
    }
    let hostname = host.rsplit_once(':').map(|(h, _)| h).unwrap_or(host);
    let loopback = matches!(hostname, "localhost" | "127.0.0.1" | "[::1]");
    let ws = match scheme {
        "https" | "wss" => "wss",
        "http" | "ws" if loopback => "ws",
        _ => return Err("log URL: https is required".into()),
    };
    Ok(format!(
        "{ws}://{host}/v1/ws?c={}",
        collection.to_uuid_string()
    ))
}

enum Ended {
    /// Reconnect after a backoff.
    Retry(String),
    /// The token was refused: reconnect with a fresh one.
    Refused,
}

async fn run(
    cfg: LinkConfig,
    tokens: Arc<dyn TokenSource>,
    mut calls: mpsc::Receiver<Queued>,
    events: Box<dyn Fn(Event) + Send>,
    current: Arc<std::sync::Mutex<Option<Generation>>>,
) {
    let mut backoff = Duration::from_secs(1);
    let total = (cfg.inbound_budget / FRAME_UNIT).max(1);
    let budget = Arc::new(tokio::sync::Semaphore::new(total));
    loop {
        // Capture a fresh process-local producer BEFORE token/connect awaits.
        let generation = Generation::begin(tokens.clone());
        if let Ok(mut slot) = current.lock() {
            if let Some(old) = slot.replace(generation.clone()) {
                old.retire();
            }
        } else {
            return;
        }
        let retirement = RetireOnDrop(generation.clone());
        let (ended, was_up) = session(&cfg, &generation, &mut calls, &budget, &events).await;
        drop(retirement);
        if was_up {
            backoff = Duration::from_secs(1);
        }
        match ended {
            Ended::Refused => {
                tokens.refused();
                tracing::warn!("log service refused the token; renewing");
            }
            Ended::Retry(why) => tracing::info!(reason = %why, "log transport reconnecting"),
        }
        // Down: answer calls at once until the next attempt.
        let wake = tokio::time::sleep(backoff);
        tokio::pin!(wake);
        loop {
            tokio::select! {
                _ = &mut wake => break,
                c = calls.recv() => match c {
                    Some(q) => events(Event::Offline { id: q.call.id, scope: q.call.scope, session: q.call.session }),
                    None => return,
                },
            }
        }
        backoff = (backoff * 2).min(Duration::from_secs(30));
    }
}

fn now_ms() -> i64 {
    i64::try_from(crate::fsutil::now_ms()).unwrap_or(i64::MAX)
}

async fn session(
    cfg: &LinkConfig,
    generation: &Generation,
    calls: &mut mpsc::Receiver<Queued>,
    budget: &Arc<tokio::sync::Semaphore>,
    events: &(dyn Fn(Event) + Send),
) -> (Ended, bool) {
    let url = match ws_url(&cfg.log_url, &cfg.collection) {
        Ok(u) => u,
        Err(e) => return (Ended::Retry(e), false),
    };
    if generation.check().is_err() {
        return (Ended::Retry("stale producer".into()), false);
    }
    let token_result = tokio::time::timeout(TOKEN_TIMEOUT, generation.token()).await;
    if generation.check().is_err() {
        return (Ended::Retry("stale token completion".into()), false);
    }
    let token = match token_result {
        Ok(Ok(t)) => t,
        Ok(Err(e)) => return (Ended::Retry(format!("token: {e}")), false),
        Err(_) => return (Ended::Retry("token timed out".into()), false),
    };
    generation.token_expiry(token.expires_at_ms);
    if generation.check().is_err() {
        return (Ended::Retry("expired token".into()), false);
    }
    let req = match url.as_str().into_client_request() {
        Ok(r) => r,
        Err(e) => return (Ended::Retry(format!("url: {e}")), false),
    };
    let tls = if url.starts_with("wss://") {
        match crate::cloud::tls_config() {
            Ok(t) => Some(t),
            Err(e) => return (Ended::Retry(e.to_string()), false),
        }
    } else {
        None
    };
    let http = match crate::direct::client(tls.clone()) {
        Ok(c) => c,
        Err(e) => return (Ended::Retry(e), false),
    };
    // Direct object URLs must be on this log's own origin.
    let pin = match crate::direct::DirectPin::from_log_url(&url) {
        Ok(p) => p,
        Err(e) => return (Ended::Retry(e.into()), false),
    };
    let connector = Some(match tls {
        Some(t) => tokio_tungstenite::Connector::Rustls(t),
        None => tokio_tungstenite::Connector::Plain,
    });
    let ws_config = tokio_tungstenite::tungstenite::protocol::WebSocketConfig::default()
        .max_message_size(Some(MAX_FRAME))
        .max_frame_size(Some(MAX_FRAME));
    let connect =
        tokio_tungstenite::connect_async_tls_with_config(req, Some(ws_config), false, connector);
    let connected = tokio::time::timeout(CONNECT_TIMEOUT, connect).await;
    if generation.check().is_err() {
        return (Ended::Retry("stale upgrade completion".into()), false);
    }
    let (ws, resp) = match connected {
        Ok(Ok(x)) => x,
        Ok(Err(e)) => return (Ended::Retry(format!("connect: {e}")), false),
        Err(_) => return (Ended::Retry("connect timed out".into()), false),
    };
    let nonce: Option<[u8; 32]> = resp
        .headers()
        .get("x-mdbase-nonce")
        .and_then(|v| v.to_str().ok())
        .and_then(unhex32);
    let Some(nonce) = nonce else {
        return (
            Ended::Retry("no nonce in the upgrade response".into()),
            false,
        );
    };
    let (proof_tx, proof_rx) = oneshot::channel();
    events(Event::Proof {
        nonce,
        token: token.token.clone(),
        generation: generation.clone(),
        reply: proof_tx,
    });
    let signed = tokio::time::timeout(PROOF_TIMEOUT, proof_rx).await;
    if generation.check().is_err() {
        return (Ended::Retry("stale proof completion".into()), false);
    }
    let Ok(Ok(Some(sig))) = signed else {
        return (
            Ended::Retry("the replica refused the hello proof".into()),
            false,
        );
    };
    let (mut sink, mut stream) = ws.split();
    let hello = LsFrame::Request(LsRequest {
        id: HELLO_ID,
        method: "hello".into(),
        params: LsHelloParams {
            version: Version { major: 1, minor: 0 },
            token: token.token.to_string(),
            device: cfg.device,
            sig: B64(sig),
        }
        .to_cbor(),
    });
    let Ok(hello) = hello.to_bytes() else {
        return (Ended::Retry("hello encoding".into()), false);
    };
    let sent = sink.send(Message::Binary(hello.into())).await;
    if generation.check().is_err() {
        return (Ended::Retry("stale hello send".into()), false);
    }
    if sent.is_err() {
        return (Ended::Retry("send hello".into()), false);
    }
    let answer = tokio::time::timeout(HELLO_TIMEOUT, hello_answer(&mut stream, generation)).await;
    if generation.check().is_err() {
        return (Ended::Retry("stale hello answer".into()), false);
    }
    match answer {
        Ok(Ok(())) => {}
        Ok(Err(e)) => return (e, false),
        Err(_) => return (Ended::Retry("no hello answer".into()), false),
    }
    // Authenticated hello completed. The runtime binds its exact Replica and
    // hands back the opaque session; waiting does not confer authority itself.
    let (up_tx, up_rx) = oneshot::channel();
    events(Event::Up {
        generation: generation.clone(),
        reply: up_tx,
    });
    let handback = tokio::time::timeout(PROOF_TIMEOUT, up_rx).await;
    let Ok(Ok(Some(session))) = handback else {
        return (Ended::Retry("runtime refused session".into()), false);
    };
    // A mismatched handback must not retire another producer's valid binding.
    if !session.for_generation(generation) {
        return (Ended::Retry("wrong session handback".into()), false);
    }
    if generation.check().is_err() || session.check().is_err() {
        generation.retire();
        events(Event::Down(session));
        return (Ended::Retry("stale session handback".into()), false);
    }
    let renew = tokio::time::sleep(Duration::from_millis(
        (token.expires_at_ms - RENEW_BEFORE_MS - now_ms()).max(1_000) as u64,
    ));
    tokio::pin!(renew);
    let mut pending: BTreeMap<u64, (String, Queued, tokio::time::Instant)> = BTreeMap::new();
    // Direct transfers of this connection (aborted with it), and the raw
    // `commit_object` calls in flight: raw call ID → the replica's call ID.
    let mut transfers: tokio::task::JoinSet<(u64, Done)> = tokio::task::JoinSet::new();
    let slots = Arc::new(tokio::sync::Semaphore::new(MAX_DIRECT_TRANSFERS));
    let mut commits: BTreeMap<u64, u64> = BTreeMap::new();
    let mut next_raw = HELLO_ID;
    let ended = loop {
        tokio::select! {
            _ = &mut renew => break Ended::Retry("token renewal".into()),
            q = calls.recv() => {
                if generation.check().is_err() { break Ended::Retry("stale queue wake".into()); }
                let Some(mut q) = q else { break Ended::Retry("stopped".into()) };
                if !q.call.session.same(&session) || q.call.session.check().is_err() {
                    events(Event::Offline { id: q.call.id, scope: q.call.scope, session: q.call.session });
                    continue;
                }
                let frame = std::mem::take(&mut q.call.frame);
                let (id, method) = (q.call.id, q.call.method.clone());
                pending.insert(id, (method, q, tokio::time::Instant::now() + cfg.call_timeout));
                let sent = sink.send(Message::Binary(frame.into())).await;
                if generation.check().is_err() { break Ended::Retry("stale send completion".into()); }
                if sent.is_err() { break Ended::Retry("send".into()); }
            }
            Some(joined) = transfers.join_next(), if !transfers.is_empty() => {
                if generation.check().is_err() { break Ended::Retry("stale transfer completion".into()); }
                // A transfer task cannot panic by design; if one did, its call
                // stays pending and the call deadline ends the session.
                let Ok((id, done)) = joined else { continue };
                let Some((_, q, deadline)) = pending.get_mut(&id) else { continue };
                let answer = match done {
                    Done::Put(crate::direct::UploadOutcome::Uploaded | crate::direct::UploadOutcome::Unknown) => {
                        let Some((collection, address)) = q.call.object.as_ref().map(|o| (o.collection, o.address)) else {
                            continue;
                        };
                        next_raw += 1;
                        let raw = next_raw;
                        let frame = LsFrame::Request(LsRequest {
                            id: raw,
                            method: "commit_object".into(),
                            params: CommitObjectParams { collection, address }.to_cbor(),
                        });
                        match frame.to_bytes() {
                            Ok(bytes) => {
                                *deadline = tokio::time::Instant::now() + cfg.call_timeout;
                                commits.insert(raw, id);
                                let sent = sink.send(Message::Binary(bytes.into())).await;
                                if generation.check().is_err() { break Ended::Retry("stale send completion".into()); }
                                if sent.is_err() { break Ended::Retry("send".into()); }
                                None
                            }
                            Err(_) => Some(error_frame(id, "invalid", "direct_commit")),
                        }
                    }
                    Done::Put(crate::direct::UploadOutcome::Expired) => {
                        Some(error_frame(id, "unavailable", "direct_expired"))
                    }
                    Done::Put(crate::direct::UploadOutcome::Refused) => {
                        tracing::warn!(id, "direct upload refused");
                        Some(error_frame(id, "invalid", "direct_refused"))
                    }
                    Done::Get(Ok((bytes, size, checksum))) => Some(
                        LsFrame::Response(LsResponse {
                            id,
                            result: Some(GetObjectResult {
                                bytes: Some(Bytes(bytes)),
                                direct: None,
                                size,
                                checksum,
                            }.to_cbor()),
                            error: None,
                        }).to_bytes().unwrap_or_else(|_| error_frame(id, "unavailable", "direct_encode")),
                    ),
                    Done::Get(Err(e)) => {
                        use crate::direct::DownloadError as D;
                        let (code, reason) = match e {
                            D::Expired => ("unavailable", "direct_expired"),
                            D::Unavailable => ("unavailable", "direct"),
                            D::NotFound => ("not_found", "direct"),
                            D::Integrity => {
                                tracing::warn!(id, "direct download failed verification");
                                ("unavailable", "direct_integrity")
                            }
                            D::Refused => ("invalid", "direct_refused"),
                        };
                        Some(error_frame(id, code, reason))
                    }
                };
                if let Some(frame) = answer
                    && let Err(ended) = deliver(id, frame, &mut pending, generation, budget, cfg, events).await
                {
                    break ended;
                }
            }
            _ = tokio::time::sleep_until(
                pending.values().map(|p| p.2).min().unwrap_or_else(|| tokio::time::Instant::now() + cfg.call_timeout)
            ), if !pending.is_empty() => {
                break Ended::Retry("a call went unanswered".into());
            }
            m = stream.next() => {
                if generation.check().is_err() { break Ended::Retry("stale receive completion".into()); }
                let b = match m {
                    Some(Ok(Message::Binary(b))) => b,
                    Some(Ok(Message::Close(_))) | None => break Ended::Retry("closed".into()),
                    Some(Ok(_)) => continue,
                    Some(Err(e)) => break Ended::Retry(format!("read: {e}")),
                };
                // Wait for room in the inbound budget before handing the frame
                // over; the socket is not read meanwhile.
                let units = (1 + b.len() / FRAME_UNIT).min((cfg.inbound_budget / FRAME_UNIT).max(1)) as u32;
                let share = match inbound_share(generation, budget, units).await {
                    Ok(share) => share,
                    Err(ended) => break ended,
                };
                if generation.check().is_err() { break Ended::Retry("stale budget delivery".into()); }
                match LsFrame::from_bytes(&b) {
                    Ok(LsFrame::Response(r)) => {
                        if let Some(id) = commits.remove(&r.id) {
                            // Only `true` completes the replica's put_object.
                            drop(share);
                            let frame = commit_answer(id, r);
                            if let Err(ended) = deliver(id, frame, &mut pending, generation, budget, cfg, events).await {
                                break ended;
                            }
                            continue;
                        }
                        let step = match pending.get(&r.id) {
                            Some((method, q, _)) => direct_step(method, &r, q.call.object.as_ref()),
                            None => continue,
                        };
                        match step {
                            Step::Forward => {
                                if let Some((method, q, _)) = pending.remove(&r.id) {
                                    events(Event::Reply { id: r.id, method, bytes: b.to_vec(), budget: share, scope: q.call.scope, session: q.call.session });
                                }
                            }
                            Step::Put(dt, body) => {
                                if let Some(p) = pending.get_mut(&r.id) {
                                    p.2 = tokio::time::Instant::now() + DIRECT_DEADLINE;
                                }
                                let (http, slots, id, pin) = (http.clone(), slots.clone(), r.id, pin.clone());
                                transfers.spawn(async move {
                                    let _slot = slots.acquire_owned().await;
                                    (id, Done::Put(crate::direct::upload(&http, &dt, &pin, body, now_ms).await))
                                });
                            }
                            Step::Get(dt, size, checksum) => {
                                if let Some(p) = pending.get_mut(&r.id) {
                                    p.2 = tokio::time::Instant::now() + DIRECT_DEADLINE;
                                }
                                let (http, slots, id, pin) = (http.clone(), slots.clone(), r.id, pin.clone());
                                transfers.spawn(async move {
                                    let _slot = slots.acquire_owned().await;
                                    let got = crate::direct::download(&http, &dt, &pin, size, &checksum, now_ms).await;
                                    (id, Done::Get(got.map(|b| (b, size, checksum))))
                                });
                            }
                        }
                    }
                    Ok(LsFrame::Push(_)) => events(Event::Push(b.to_vec(), share, session.clone())),
                    _ => tracing::warn!("unexpected log frame"),
                }
            }
        }
    };
    // Abort transfers: their calls are lost with the session (outcome unknown).
    transfers.abort_all();
    // Invalidate BEFORE close can await. Retirement is delivered before lost
    // diagnostics, and before any replacement Up; Replica preserves Sent bytes.
    generation.retire();
    events(Event::Down(session));
    for (id, (_, q, _)) in pending {
        events(Event::Lost {
            id,
            scope: q.call.scope,
            session: q.call.session,
        });
    }
    let _ = tokio::time::timeout(CONNECT_TIMEOUT, sink.close()).await;
    (ended, true)
}

/// A finished direct transfer.
enum Done {
    Put(crate::direct::UploadOutcome),
    Get(Result<(Vec<u8>, u64, B32), crate::direct::DownloadError>),
}

/// What a response to a pending call asks of the transport.
enum Step {
    /// Hand the frame to the runtime as it is.
    Forward,
    /// Upload these bytes to the signed target, then commit.
    Put(mdbn_wire::log_service::DirectTransfer, bytes::Bytes),
    /// Download the whole object (size, checksum) from the signed target.
    Get(mdbn_wire::log_service::DirectTransfer, u64, B32),
}

/// Does this response need a direct transfer? Anything anomalous is forwarded:
/// the runtime's codec refuses an unfinished direct transfer fail-closed.
fn direct_step(method: &str, r: &LsResponse, object: Option<&SealedObject>) -> Step {
    let (Some(result), None) = (&r.result, &r.error) else {
        return Step::Forward;
    };
    match method {
        "put_object" => match (PutObjectResult::from_cbor(result), object) {
            (
                Ok(PutObjectResult {
                    status: PutStatus::Upload,
                    direct: Some(dt),
                }),
                Some(body),
            ) => Step::Put(dt, body.bytes.clone()),
            _ => Step::Forward,
        },
        "get_object" => match GetObjectResult::from_cbor(result) {
            Ok(GetObjectResult {
                bytes: None,
                direct: Some(dt),
                size,
                checksum,
            }) if size <= crate::direct::MAX_DIRECT_OBJECT => Step::Get(dt, size, checksum),
            _ => Step::Forward,
        },
        _ => Step::Forward,
    }
}

/// A service error frame for the replica's call `id`.
fn error_frame(id: u64, code: &str, reason: &str) -> Vec<u8> {
    LsFrame::Response(LsResponse {
        id,
        result: None,
        error: Some(LsError {
            code: code.into(),
            reason: Some(reason.into()),
            message: None,
            retry_after_ms: None,
            details: None,
        }),
    })
    .to_bytes()
    .unwrap_or_default()
}

/// The replica's `put_object` answer from the `commit_object` response: `stored`
/// only on `{0: true}`; `false` (nothing staged) asks the replica to put again; a
/// service error passes through under the replica's call ID.
fn commit_answer(id: u64, r: LsResponse) -> Vec<u8> {
    match (r.result, r.error) {
        (Some(Cbor::Map(f)), None)
            if f.iter()
                .any(|(k, v)| *k == Cbor::Uint(0) && *v == Cbor::Bool(true)) =>
        {
            LsFrame::Response(LsResponse {
                id,
                result: Some(
                    PutObjectResult {
                        status: PutStatus::Stored,
                        direct: None,
                    }
                    .to_cbor(),
                ),
                error: None,
            })
            .to_bytes()
            .unwrap_or_else(|_| error_frame(id, "unavailable", "direct_commit"))
        }
        (None, Some(error)) => LsFrame::Response(LsResponse {
            id,
            result: None,
            error: Some(error),
        })
        .to_bytes()
        .unwrap_or_else(|_| error_frame(id, "unavailable", "direct_commit")),
        _ => error_frame(id, "unavailable", "direct_commit"),
    }
}

/// Answer pending call `id` with a transport-built frame, under the inbound budget.
async fn deliver(
    id: u64,
    frame: Vec<u8>,
    pending: &mut BTreeMap<u64, (String, Queued, tokio::time::Instant)>,
    generation: &Generation,
    budget: &Arc<tokio::sync::Semaphore>,
    cfg: &LinkConfig,
    events: &(dyn Fn(Event) + Send),
) -> Result<(), Ended> {
    let Some((method, q, _)) = pending.remove(&id) else {
        return Ok(());
    };
    let units = (1 + frame.len() / FRAME_UNIT).min((cfg.inbound_budget / FRAME_UNIT).max(1)) as u32;
    let share = inbound_share(generation, budget, units).await?;
    events(Event::Reply {
        id,
        method,
        bytes: frame,
        budget: share,
        scope: q.call.scope,
        session: q.call.session,
    });
    Ok(())
}

async fn inbound_share(
    generation: &Generation,
    budget: &Arc<tokio::sync::Semaphore>,
    units: u32,
) -> Result<Budget, Ended> {
    if generation.check().is_err() {
        return Err(Ended::Retry("stale budget admission".into()));
    }
    let acquired = budget.clone().acquire_many_owned(units).await;
    if generation.check().is_err() {
        return Err(Ended::Retry("stale budget completion".into()));
    }
    acquired
        .map(|permit| Budget(Some(permit)))
        .map_err(|_| Ended::Retry("budget closed".into()))
}

async fn hello_answer<S>(stream: &mut S, generation: &Generation) -> Result<(), Ended>
where
    S: futures_util::Stream<Item = Result<Message, tokio_tungstenite::tungstenite::Error>> + Unpin,
{
    loop {
        let received = stream.next().await;
        if generation.check().is_err() {
            return Err(Ended::Retry("stale hello receive".into()));
        }
        let b = match received {
            Some(Ok(Message::Binary(b))) => b,
            Some(Ok(Message::Close(_))) | None => {
                return Err(Ended::Retry("closed at hello".into()));
            }
            Some(Ok(_)) => continue,
            Some(Err(e)) => return Err(Ended::Retry(format!("hello: {e}"))),
        };
        if let Ok(LsFrame::Response(r)) = LsFrame::from_bytes(&b)
            && r.id == HELLO_ID
        {
            return match (r.result, r.error) {
                (Some(_), None) => Ok(()),
                (_, Some(e)) if is_auth(&e) => {
                    tracing::warn!(code = %e.code, reason = ?e.reason, "hello refused");
                    Err(Ended::Refused)
                }
                (_, e) => Err(Ended::Retry(format!(
                    "hello refused: {:?}",
                    e.map(|e| (e.code, e.reason))
                ))),
            };
        }
    }
}

fn is_auth(e: &mdbn_wire::log_service::LsError) -> bool {
    matches!(e.code.as_str(), "unauthenticated" | "forbidden")
}

fn unhex32(s: &str) -> Option<[u8; 32]> {
    if s.len() != 64 {
        return None;
    }
    let mut out = [0u8; 32];
    for (i, b) in out.iter_mut().enumerate() {
        *b = u8::from_str_radix(s.get(i * 2..i * 2 + 2)?, 16).ok()?;
    }
    Some(out)
}

#[cfg(test)]
#[path = "logwire_tests.rs"]
pub(crate) mod tests;
