//! The relay device socket (`GET /v1/relay`): the grant feed and Noise pipes
//! (Connect #595/#596).
//!
//! One task per daemon keeps the socket up:
//! 1. `POST /v1/connectors/sync` (inventory), then upgrade with the connector
//!    token;
//! 2. `relay_hello` with `next_device_v1` and `noise_pipe_v1`; `relay_welcome`
//!    carries `device_nonce` when the server supports devices;
//! 3. `device_bind`, signed by the device key over the session and nonce;
//! 4. then it serves `policy_snapshot` (the grant feed, `lease_v1`) and
//!    `pipe_open` / `MDBN` frames / `pipe_close`.
//!
//! **Grant feed.** Each snapshot is checked before it is applied: the lease
//! fields, the revision (RFC 8785 hash of the received body), the pinned
//! connector ID and a monotonic sequence (persisted, so an old snapshot can't
//! resurrect a revoked grant). Every grant's app key is verified ([`crate::attest`],
//! before it reaches the access list; a grant whose binding fails is
//! dropped, which revokes it. Applied per registered collection with the
//! snapshot's lease, so nothing is served once the lease lapses, including after
//! a restart.
//!
//! **Pipes**: never Host; the prologue is built from `pipe_open`'s
//! collection and grant; the session's key must match the access list. Open
//! pipes are closed as soon as their grant is no longer live (revoked, or the
//! lease expired).

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;

use crate::access::CachedGrant;
use crate::attest::{self, AttestError, Proof};
use crate::cloud::{Cloud, CloudConfig, CloudError};
use crate::pipes::{self, PipeCarrier, PipeOut};
use crate::secrets::{self, DeviceIdentity};

/// The lease the server issues (55 s); used only for sanity bounds.
pub const MAX_LEASE_MS: u64 = 60_000;
/// How long the server gives us for the first pipe frame.
pub const PIPE_HANDSHAKE: Duration = Duration::from_secs(30);

/// Capabilities offered in `relay_hello`.
pub const CAPABILITIES: &[&str] = &[
    "application-authorization-v4",
    "application-authorization-v5",
    "authorization-activation",
    "encrypted-relay",
    "policy-ack",
    "policy-freshness-lease-v1",
    "application-declaration-evidence-v1",
    "next_device_v1",
    "next_account_v1",
    "noise_pipe_v1",
];

/// The `relay_hello` message. `old_connector_running`: an old mdbase Connect daemon
/// runs on this device, so Connect reports its collections as unavailable for that
/// reason (sent only when true).
pub fn hello(old_connector_running: bool) -> Value {
    let mut hello = json!({
        "type": "relay_hello",
        "protocol_version": 1,
        "connector_version": crate::BINARY_VERSION,
        "capabilities": CAPABILITIES,
        "contract_support": {
            "operation_transport": [3, 2],
            "authorization_binding": [5, 4],
            "semantic_capabilities": [2, 1],
            "durable_mutation": [1]
        }
    });
    if old_connector_running {
        hello["old_connector_running"] = Value::Bool(true);
    }
    hello
}

/// A checked policy snapshot.
#[derive(Debug, Clone, PartialEq)]
pub struct Snapshot {
    /// Request ID to echo.
    pub request_id: String,
    /// Revision to echo.
    pub revision: String,
    /// Connector ID.
    pub connector_id: String,
    /// Sequence.
    pub sequence: u64,
    /// Trusted local pairing epoch of this relay, never taken from server JSON.
    pub account_epoch: u64,
    /// Local receive time plus the validated lease duration (never server expiry).
    pub lease_expires_ms: u64,
    /// In-process monotonic deadline; never persisted across restart.
    pub lease_deadline: std::time::Instant,
    /// Grants as received.
    pub grants: Vec<Value>,
}

/// Why a snapshot was refused (`policy_applied {ok: false, error}`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Refused {
    /// Code.
    pub code: &'static str,
    /// Message.
    pub message: String,
}

fn refused(code: &'static str, message: impl Into<String>) -> Refused {
    Refused {
        code,
        message: message.into(),
    }
}

/// The lease-mode revision: `"sha256:" + hex(SHA-256(JCS({connector_id,
/// sequence, lease_issued_at_ms, lease_expires_at_ms, grants})))`.
pub fn revision(
    connector_id: &str,
    sequence: u64,
    issued: u64,
    expires: u64,
    grants: &[Value],
) -> String {
    use sha2::{Digest, Sha256};
    let body = json!({
        "connector_id": connector_id,
        "sequence": sequence,
        "lease_issued_at_ms": issued,
        "lease_expires_at_ms": expires,
        "grants": grants,
    });
    let canon = serde_jcs::to_vec(&body).unwrap_or_default();
    format!("sha256:{}", secrets::hex(&Sha256::digest(&canon)))
}

/// Check a `policy_snapshot` against the pinned connector, the last applied
/// sequence and the clock.
pub fn check_snapshot(v: &Value, cfg: &CloudConfig, now_ms: u64) -> Result<Snapshot, Refused> {
    let s = |k: &str| v.get(k).and_then(Value::as_str).map(str::to_string);
    let n = |k: &str| v.get(k).and_then(Value::as_u64);
    let request_id =
        s("request_id").ok_or_else(|| refused("invalid_policy_snapshot", "request_id"))?;
    let revision_got =
        s("revision").ok_or_else(|| refused("invalid_policy_snapshot", "revision"))?;
    let connector_id =
        s("connector_id").ok_or_else(|| refused("invalid_policy_snapshot", "connector_id"))?;
    let (Some(sequence), Some(issued), Some(expires)) = (
        n("sequence"),
        n("lease_issued_at_ms"),
        n("lease_expires_at_ms"),
    ) else {
        return Err(refused("invalid_policy_snapshot", "lease fields"));
    };
    let grants = v
        .get("grants")
        .and_then(Value::as_array)
        .cloned()
        .ok_or_else(|| refused("invalid_policy_snapshot", "grants"))?;
    if let Some(pinned) = &cfg.connector_id
        && *pinned != connector_id
    {
        return Err(refused("policy_authority_mismatch", "connector id changed"));
    }
    if revision(&connector_id, sequence, issued, expires, &grants) != revision_got {
        return Err(refused(
            "invalid_policy_revision",
            "revision does not match the body",
        ));
    }
    if grants.iter().any(|grant| {
        grant
            .get("account_id")
            .and_then(Value::as_str)
            .and_then(crate::authority::account_id)
            .is_none()
    }) {
        return Err(refused(
            "invalid_policy_account",
            "account-bound grants require explicit canonical account identities",
        ));
    }
    if issued > now_ms.saturating_add(5_000)
        || issued >= expires
        || expires - issued > MAX_LEASE_MS
        || expires > now_ms.saturating_add(MAX_LEASE_MS)
        || expires <= now_ms
    {
        return Err(refused("invalid_policy_lease", "lease out of bounds"));
    }
    if sequence < cfg.policy_sequence
        || (sequence == cfg.policy_sequence
            && cfg.policy_sequence != 0
            && revision_got != cfg.policy_revision)
    {
        return Err(refused("stale_policy", "older than the applied policy"));
    }
    let duration = expires - issued;
    let lease_expires_ms = now_ms
        .checked_add(duration)
        .ok_or_else(|| refused("invalid_policy_lease", "local expiry overflow"))?;
    let lease_deadline = std::time::Instant::now()
        .checked_add(std::time::Duration::from_millis(duration))
        .ok_or_else(|| refused("invalid_policy_lease", "monotonic expiry overflow"))?;
    Ok(Snapshot {
        request_id,
        revision: revision_got,
        connector_id,
        sequence,
        account_epoch: cfg.account_epoch,
        lease_expires_ms,
        lease_deadline,
        grants,
    })
}

/// Map one feed grant to the access list's form, verifying the app's key.
/// `Err` drops the grant (fail closed).
pub fn to_cached(g: &Value) -> Result<CachedGrant, AttestError> {
    let s = |k: &str| g.get(k).and_then(Value::as_str).map(str::to_string);
    let account = s("account_id").ok_or(AttestError::Binding("account_id"))?;
    crate::authority::account_id(&account).ok_or(AttestError::Binding("account_id"))?;
    let proof: Proof = g
        .get("application_authorization")
        .cloned()
        .and_then(|v| serde_json::from_value(v).ok())
        .ok_or(AttestError::Binding("application_authorization"))?;
    let (client_pk, legacy_only) = match attest::verify_client_key(
        &proof,
        s("client_pk").as_deref(),
        s("client_key_signature").as_deref(),
    ) {
        Ok(pk) => (secrets::hex(&pk), false),
        Err(AttestError::Unattested) => (String::new(), true),
        Err(e) => return Err(e),
    };
    let grant = s("id").ok_or(AttestError::Binding("id"))?;
    let app_id = s("application_id").ok_or(AttestError::Binding("application_id"))?;
    if attest::uuid_bytes(&proof.binding.application_id) != attest::uuid_bytes(&app_id) {
        return Err(AttestError::Binding("application_id mismatch"));
    }
    let folders = g
        .pointer("/file_capability/scope")
        .filter(|sc| sc.get("kind").and_then(Value::as_str) == Some("selected_folders"))
        .and_then(|sc| sc.get("folders"))
        .and_then(|f| serde_json::from_value::<Vec<String>>(f.clone()).ok());
    Ok(CachedGrant {
        grant: grant.to_ascii_lowercase(),
        account_id: Some(account),
        collection: s("collection_id")
            .ok_or(AttestError::Binding("collection_id"))?
            .to_ascii_lowercase(),
        app_id,
        app_name: s("application_name").unwrap_or_else(|| "an app".into()),
        client_pk,
        capabilities: g
            .get("capabilities")
            .and_then(|c| serde_json::from_value(c.clone()).ok())
            .unwrap_or_default(),
        folders,
        legacy_only,
        declared_setup: crate::declared_setup::from_feed(g, &proof)?,
    })
}

/// What the relay needs from the daemon.
pub trait RelayHost: crate::session::Handler {
    /// Registered collection IDs and their inventory entries.
    fn inventory(&self) -> crate::session::BoxFuture<'_, Vec<(String, Value)>>;
    /// Current cursor from the same durable document as the access cache.
    fn policy_cursor(&self) -> crate::session::BoxFuture<'_, Option<crate::access::FeedCursor>>;
    /// Atomically persist all collections' grants and their replay cursor before
    /// publishing any authorization. Persistence errors invalidate live leases.
    fn commit_feed<'a>(
        &'a self,
        snapshot: &'a Snapshot,
        grants: &'a BTreeMap<String, Vec<CachedGrant>>,
    ) -> crate::session::BoxFuture<'a, Result<(), String>>;
    /// Whether a pipe's grant is still live.
    fn grant_live<'a>(
        &'a self,
        collection: &'a str,
        grant: &'a str,
    ) -> crate::session::BoxFuture<'a, bool>;
    /// Capture a positive pending grant once, before spawning the original pipe.
    /// Default hosts preserve immediate refusal, never infer readiness.
    fn grant_activation<'a>(
        self: &'a Arc<Self>,
        _collection: &'a str,
        _grant: &'a str,
    ) -> crate::session::BoxFuture<'a, Option<GrantActivation>> {
        Box::pin(async { None })
    }
    /// Report connection state for status.
    fn set_online(&self, online: bool);
    /// Whether an old mdbase Connect daemon runs on this device (reported in
    /// `relay_hello`; a change reconnects so Connect sees it).
    fn old_connector_running(&self) -> bool {
        false
    }
}

/// Original captured consent/epoch/runtime/lease fence, never authority itself.
pub type GrantActivationGuard =
    Arc<dyn Fn() -> crate::session::BoxFuture<'static, bool> + Send + Sync>;

/// A captured, cancellable pending activation. Only its authoritative wait may
/// resolve true; the cheap guard sweeps without recapturing grant identity.
pub struct GrantActivation {
    /// Original-context recheck.
    pub current: GrantActivationGuard,
    /// Subscribe-before-query wait on the original replica's Effective result.
    pub wait: crate::session::BoxFuture<'static, bool>,
}

/// Why a relay session ended.
#[derive(Debug)]
pub enum Ended {
    /// Retry with back-off.
    Retry(String),
    /// Stop until the user acts (credentials rejected, incompatible, authority
    /// mismatch).
    Terminal(String),
}

struct Pipe {
    tx: mpsc::Sender<Vec<u8>>,
    collection: String,
    grant: String,
    waiting_for_grant: Arc<std::sync::atomic::AtomicBool>,
    activation_guard: Option<GrantActivationGuard>,
    task: tokio::task::JoinHandle<()>,
}

/// Run the relay until `stop` fires, reconnecting with equal-jitter back-off.
pub async fn run<H: RelayHost>(
    host: Arc<H>,
    cloud: Arc<Cloud>,
    mut cfg: CloudConfig,
    identity: Arc<DeviceIdentity>,
    mut stop: tokio::sync::watch::Receiver<bool>,
) -> Ended {
    if let Some(cursor) = host.policy_cursor().await {
        if cfg
            .connector_id
            .as_ref()
            .is_some_and(|id| *id != cursor.connector)
        {
            return Ended::Terminal("policy_authority_mismatch".into());
        }
        cfg.connector_id = Some(cursor.connector);
        cfg.policy_sequence = cursor.sequence;
        cfg.policy_revision = cursor.revision;
    }
    let mut failures = 0u32;
    loop {
        let started = tokio::time::Instant::now();
        let ended = tokio::select! {
            e = session(&host, &cloud, &mut cfg, &identity) => e,
            _ = async { let _ = stop.wait_for(|s| *s).await; } => return Ended::Retry("stopping".into()),
        };
        host.set_online(false);
        match ended {
            Ended::Terminal(why) => {
                tracing::error!(reason = %why, "relay stopped; sign in again or update");
                return Ended::Terminal(why);
            }
            Ended::Retry(why) => {
                if started.elapsed() > Duration::from_secs(30) {
                    failures = 0;
                }
                failures = failures.saturating_add(1);
                let cap = (1000u64 << failures.min(5)).min(30_000);
                let mut r = [0u8; 8];
                let _ = getrandom::fill(&mut r);
                let delay = cap / 2 + u64::from_le_bytes(r) % (cap / 2 + 1);
                tracing::info!(reason = %why, retry_ms = delay, "relay disconnected");
                tokio::select! {
                    _ = tokio::time::sleep(Duration::from_millis(delay)) => {}
                    _ = async { let _ = stop.wait_for(|s| *s).await; } => return Ended::Retry("stopping".into()),
                }
            }
        }
    }
}

fn ws_url(server: &str) -> String {
    let base = server
        .strip_prefix("https://")
        .map(|h| format!("wss://{h}"))
        .or_else(|| server.strip_prefix("http://").map(|h| format!("ws://{h}")))
        .unwrap_or_else(|| server.to_string());
    format!("{base}/v1/relay")
}

async fn session<H: RelayHost>(
    host: &Arc<H>,
    cloud: &Arc<Cloud>,
    cfg: &mut CloudConfig,
    identity: &Arc<DeviceIdentity>,
) -> Ended {
    // Inventory first: grants and pipes join on the collections it declares.
    let inv = host.inventory().await;
    let revision = (crate::fsutil::now_ms() as u64).max(1);
    match cloud
        .inventory(revision, inv.into_iter().map(|(_, v)| v).collect())
        .await
    {
        Ok(()) => {}
        Err(CloudError::Unauthenticated) => {
            return Ended::Terminal("authentication_required".into());
        }
        Err(e) => return Ended::Retry(e.to_string()),
    }

    let tls = match crate::cloud::tls_config() {
        Ok(t) => t,
        Err(e) => return Ended::Retry(e.to_string()),
    };
    let mut req = match ws_url(&cloud.server).into_client_request() {
        Ok(r) => r,
        Err(e) => return Ended::Terminal(format!("relay url: {e}")),
    };
    let Ok(auth) = cloud.bearer().parse() else {
        return Ended::Terminal("token".into());
    };
    req.headers_mut().insert("authorization", auth);
    let connect = tokio_tungstenite::connect_async_tls_with_config(
        req,
        None,
        false,
        Some(tokio_tungstenite::Connector::Rustls(tls)),
    );
    let (ws, _) = match tokio::time::timeout(Duration::from_secs(15), connect).await {
        Ok(Ok(x)) => x,
        Ok(Err(e)) => return Ended::Retry(format!("connect: {e}")),
        Err(_) => return Ended::Retry("connect timed out".into()),
    };
    let (mut tx, mut rx) = ws.split();
    let old_connector_running = host.old_connector_running();
    if tx
        .send(Message::text(hello(old_connector_running).to_string()))
        .await
        .is_err()
    {
        return Ended::Retry("send hello".into());
    }
    let welcome = match tokio::time::timeout(Duration::from_secs(5), next_text(&mut rx)).await {
        Ok(Ok(v)) => v,
        Ok(Err(e)) => return e,
        Err(_) => return Ended::Retry("no welcome".into()),
    };
    match welcome.get("type").and_then(Value::as_str) {
        Some("relay_welcome") => {}
        Some("relay_incompatible") => {
            return Ended::Terminal(format!(
                "incompatible_version: {}",
                welcome.get("message").and_then(Value::as_str).unwrap_or("")
            ));
        }
        _ => return Ended::Retry("unexpected first message".into()),
    }
    let session_id = welcome
        .get("session_id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();

    // Bind the device (only when the server offers it).
    let mut pipes_enabled = false;
    if let Some(nonce) = welcome
        .get("device_nonce")
        .and_then(Value::as_str)
        .and_then(|h| secrets::hex_decode(h).ok())
        .and_then(|b| <[u8; 32]>::try_from(b).ok())
    {
        let Some(cid) = cfg.connector_id.as_deref().and_then(attest::uuid_bytes) else {
            return Ended::Terminal("connector id unknown; sign in again".into());
        };
        let sig = crate::cloud::device_bind_sig(identity, &cid, &session_id, &nonce);
        let bind = json!({
            "type": "device_bind",
            "device_id": identity.public().device,
            "sig": secrets::hex(&sig),
        });
        if tx.send(Message::text(bind.to_string())).await.is_err() {
            return Ended::Retry("send bind".into());
        }
    }

    host.set_online(true);
    tracing::info!(session = %session_id, "relay connected");
    let (out_tx, mut out_rx) = mpsc::channel::<PipeOut>(256);
    let mut open: BTreeMap<[u8; 16], Pipe> = BTreeMap::new();
    let mut sweep = tokio::time::interval(Duration::from_secs(1));
    let ended = loop {
        tokio::select! {
            msg = rx.next() => {
                let msg = match msg {
                    Some(Ok(m)) => m,
                    Some(Err(e)) => break Ended::Retry(format!("socket: {e}")),
                    None => break Ended::Retry("closed".into()),
                };
                match msg {
                    Message::Text(t) => {
                        let Ok(v) = serde_json::from_str::<Value>(&t) else { continue };
                        match v.get("type").and_then(Value::as_str) {
                            Some("policy_snapshot") => {
                                let reply = apply_snapshot(host, cfg, &v).await;
                                if tx.send(Message::text(reply.to_string())).await.is_err() {
                                    break Ended::Retry("send ack".into());
                                }
                                if reply.get("error").and_then(|e| e.get("code")).and_then(Value::as_str)
                                    == Some("policy_authority_mismatch")
                                {
                                    break Ended::Terminal("policy_authority_mismatch".into());
                                }
                                close_dead(host, &mut open, &out_tx).await;
                            }
                            Some("device_bound") => {
                                pipes_enabled = v.get("noise_pipes").and_then(Value::as_bool).unwrap_or(false);
                                tracing::info!(noise_pipes = pipes_enabled, "device bound");
                            }
                            Some("device_bind_failed") => {
                                tracing::warn!(reason = ?v.get("reason"), "device bind failed; pipes unavailable");
                            }
                            Some("pipe_open") if pipes_enabled => {
                                open_pipe(host, identity, &v, &mut open, &out_tx).await;
                            }
                            Some("pipe_close") => {
                                if let Some(id) = v.get("pipe_id").and_then(Value::as_str).and_then(attest::uuid_bytes)
                                    && let Some(p) = open.remove(&id)
                                {
                                    p.task.abort();
                                }
                            }
                            Some("relay_incompatible") => break Ended::Terminal("incompatible_version".into()),
                            _ => {}
                        }
                    }
                    Message::Binary(b) => {
                        if let Some((id, payload)) = pipes::parse_frame(&b)
                            && let Some(p) = open.get(&id)
                            && p.tx.try_send(payload.to_vec()).is_err()
                        {
                            // Slow or dead pipe: close it rather than buffer without bound.
                            if let Some(p) = open.remove(&id) {
                                p.task.abort();
                                let _ = tx.send(Message::text(close_msg(&id, "backpressure"))).await;
                            }
                        }
                    }
                    Message::Close(c) => {
                        let code = c.as_ref().map(|c| u16::from(c.code)).unwrap_or(0);
                        break match code {
                            4003 => Ended::Terminal("authentication_required".into()),
                            4406 => Ended::Terminal("incompatible_version".into()),
                            _ => Ended::Retry(format!("closed {code}")),
                        };
                    }
                    _ => {}
                }
            }
            out = out_rx.recv() => {
                let Some(out) = out else { continue };
                let sent = match out {
                    PipeOut::Frame(f) => tx.send(Message::binary(f)).await,
                    PipeOut::Close(id, why) => {
                        open.remove(&id);
                        tx.send(Message::text(close_msg(&id, &why))).await
                    }
                };
                if sent.is_err() {
                    break Ended::Retry("send".into());
                }
            }
            _ = sweep.tick() => {
                if host.old_connector_running() != old_connector_running {
                    break Ended::Retry("old connector state changed".into());
                }
                close_dead(host, &mut open, &out_tx).await;
                open.retain(|_, p| !p.task.is_finished());
            }
        }
    };
    for (_, p) in open {
        p.task.abort();
    }
    ended
}

fn close_msg(id: &[u8; 16], reason: &str) -> String {
    json!({ "type": "pipe_close", "pipe_id": secrets::uuid_string(id), "reason": reason })
        .to_string()
}

async fn next_text<S>(rx: &mut S) -> Result<Value, Ended>
where
    S: StreamExt<Item = Result<Message, tokio_tungstenite::tungstenite::Error>> + Unpin,
{
    loop {
        match rx.next().await {
            Some(Ok(Message::Text(t))) => {
                return serde_json::from_str(&t).map_err(|_| Ended::Retry("bad json".into()));
            }
            Some(Ok(Message::Close(c))) => {
                let code = c.as_ref().map(|c| u16::from(c.code)).unwrap_or(0);
                return Err(if code == 4003 {
                    Ended::Terminal("authentication_required".into())
                } else {
                    Ended::Retry(format!("closed {code}"))
                });
            }
            Some(Ok(_)) => continue,
            Some(Err(e)) => return Err(Ended::Retry(e.to_string())),
            None => return Err(Ended::Retry("closed".into())),
        }
    }
}

async fn apply_snapshot<H: RelayHost>(host: &Arc<H>, cfg: &mut CloudConfig, v: &Value) -> Value {
    let now = crate::fsutil::now_ms() as u64;
    let request_id = v.get("request_id").cloned().unwrap_or(Value::Null);
    let revision = v.get("revision").cloned().unwrap_or(Value::Null);
    let fail = |r: Refused| {
        json!({
            "type": "policy_applied", "protocol_version": 1, "request_id": request_id,
            "revision": revision, "ok": false,
            "error": { "code": r.code, "message": r.message }
        })
    };
    let snap = match check_snapshot(v, cfg, now) {
        Ok(s) => s,
        Err(r) => {
            tracing::warn!(code = r.code, "policy snapshot refused");
            return fail(r);
        }
    };
    let mut by_collection: BTreeMap<String, Vec<CachedGrant>> = BTreeMap::new();
    for g in &snap.grants {
        match to_cached(g) {
            Ok(c) => by_collection
                .entry(c.collection.clone())
                .or_default()
                .push(c),
            Err(e) => {
                tracing::warn!(grant = ?g.get("id"), reason = e.reason(), "grant dropped: key not verified");
            }
        }
    }
    let mut next = cfg.clone();
    next.connector_id = Some(snap.connector_id.clone());
    next.policy_sequence = snap.sequence;
    next.policy_revision = snap.revision.clone();
    // The host persists this cursor with the access cache in one document. No
    // separate cloud.json cursor write can fail after authorization publication.
    // Also retain the attempted high-water in memory on persistence failure.
    *cfg = next;
    if let Err(e) = host.commit_feed(&snap, &by_collection).await {
        return fail(refused("policy_apply_failed", e));
    }
    json!({
        "type": "policy_applied", "protocol_version": 1,
        "request_id": snap.request_id, "revision": snap.revision, "ok": true
    })
}

async fn close_dead<H: RelayHost>(
    host: &Arc<H>,
    open: &mut BTreeMap<[u8; 16], Pipe>,
    out: &mpsc::Sender<PipeOut>,
) {
    let mut dead = Vec::new();
    for (id, p) in open.iter() {
        let allowed = if p
            .waiting_for_grant
            .load(std::sync::atomic::Ordering::SeqCst)
        {
            match &p.activation_guard {
                Some(current) => current().await,
                None => false,
            }
        } else {
            host.grant_live(&p.collection, &p.grant).await
        };
        if !allowed {
            dead.push(*id);
        }
    }
    for id in dead {
        if let Some(p) = open.remove(&id) {
            p.task.abort();
            let _ = out.try_send(PipeOut::Close(id, "grant_inactive".into()));
        }
    }
}

async fn open_pipe<H: RelayHost>(
    host: &Arc<H>,
    identity: &Arc<DeviceIdentity>,
    v: &Value,
    open: &mut BTreeMap<[u8; 16], Pipe>,
    out: &mpsc::Sender<PipeOut>,
) {
    let get = |k: &str| {
        v.get(k)
            .and_then(Value::as_str)
            .and_then(attest::uuid_bytes)
    };
    let (Some(pipe), Some(collection), Some(grant)) =
        (get("pipe_id"), get("collection_id"), get("grant_id"))
    else {
        crate::session_diagnostics::pre_live("invalid_open_ids");
        return;
    };
    let close = |why: &str| {
        let _ = out.try_send(PipeOut::Close(pipe, why.into()));
    };
    if grant == [0u8; 16] {
        crate::session_diagnostics::pre_live("nil_grant");
        return close("unauthenticated"); // never Host
    }
    if open.contains_key(&pipe) {
        return;
    }
    let (col_s, grant_s) = (
        secrets::uuid_string(&collection),
        secrets::uuid_string(&grant),
    );
    let live = host.grant_live(&col_s, &grant_s).await;
    let activation = if live {
        None
    } else {
        host.grant_activation(&col_s, &grant_s).await
    };
    if !live && activation.is_none() {
        crate::session_diagnostics::pre_live("grant_not_live");
        return close("grant_inactive");
    }
    let activation_guard = activation.as_ref().map(|a| a.current.clone());
    let waiting_for_grant = Arc::new(std::sync::atomic::AtomicBool::new(!live));
    let (in_tx, in_rx) = mpsc::channel(64);
    let mut carrier = PipeCarrier::new(pipe, in_rx, out.clone());
    let prologue = pipes::prologue(&collection, &grant, &identity.device_id);
    let (h, id, out2) = (host.clone(), identity.clone(), out.clone());
    let waiting = waiting_for_grant.clone();
    let task = tokio::spawn(async move {
        // The registered bounded FIFO keeps the relay read/feed loop live while
        // this original pipe waits. No Noise work or session admission yet.
        if let Some(activation) = activation {
            let activated = tokio::time::timeout(Duration::from_secs(20), async {
                activation.wait.await && (activation.current)().await
            })
            .await
                == Ok(true);
            if !activated {
                crate::session_diagnostics::pre_live("grant_not_live");
                let _ = out2
                    .send(PipeOut::Close(pipe, "grant_inactive".into()))
                    .await;
                return;
            }
        }
        waiting.store(false, std::sync::atomic::Ordering::SeqCst);
        let r = crate::session::serve_session(
            &mut carrier,
            &prologue,
            crate::session::Origin::RelayPipe,
            id.noise_secret(),
            id.device_id,
            h.as_ref(),
        )
        .await;
        if let Err(e) = r {
            tracing::debug!(error = %e, "pipe session ended");
            let _ = out2
                .send(PipeOut::Close(pipe, "unauthenticated".into()))
                .await;
        }
    });
    open.insert(
        pipe,
        Pipe {
            tx: in_tx,
            collection: col_s,
            grant: grant_s,
            waiting_for_grant,
            activation_guard,
            task,
        },
    );
}

#[cfg(test)]
#[path = "relay_grant_activation_tests.rs"]
mod activation_tests;

#[cfg(test)]
mod tests {
    use super::*;

    fn snap(seq: u64, issued: u64, expires: u64, grants: Vec<Value>) -> Value {
        let cid = "01900000-0000-7000-8000-000000000001";
        json!({
            "type": "policy_snapshot", "protocol_version": 1, "request_id": "r",
            "revision": revision(cid, seq, issued, expires, &grants),
            "connector_id": cid, "sequence": seq,
            "lease_issued_at_ms": issued, "lease_expires_at_ms": expires, "grants": grants
        })
    }

    #[test]
    fn hello_reports_a_running_old_connector_only_when_true() {
        assert_eq!(hello(true)["old_connector_running"], Value::Bool(true));
        assert!(hello(false).get("old_connector_running").is_none());
    }

    #[test]
    fn snapshots_are_checked() {
        let cfg = CloudConfig::default();
        let now = 1_000_000;
        let ok = snap(
            5,
            now,
            now + 55_000,
            vec![
                json!({"id": "b", "account_id":"11111111-1111-4111-8111-111111111111", "x": [2, 1]}),
            ],
        );
        let s = check_snapshot(&ok, &cfg, now).unwrap();
        assert_eq!((s.sequence, s.lease_expires_ms), (5, now + 55_000));

        let mut tampered = ok.clone();
        tampered["grants"][0]["x"] = json!([1]);
        assert_eq!(
            check_snapshot(&tampered, &cfg, now).unwrap_err().code,
            "invalid_policy_revision"
        );

        let expired = snap(5, now - 60_000, now - 5_000, vec![]);
        assert_eq!(
            check_snapshot(&expired, &cfg, now).unwrap_err().code,
            "invalid_policy_lease"
        );
        let too_long = snap(5, now, now + 120_000, vec![]);
        assert_eq!(
            check_snapshot(&too_long, &cfg, now).unwrap_err().code,
            "invalid_policy_lease"
        );

        let applied = CloudConfig {
            policy_sequence: 7,
            policy_revision: "sha256:x".into(),
            connector_id: Some("01900000-0000-7000-8000-000000000001".into()),
            ..Default::default()
        };
        assert_eq!(
            check_snapshot(&ok, &applied, now).unwrap_err().code,
            "stale_policy"
        );
        let other = CloudConfig {
            connector_id: Some("someone-else".into()),
            ..Default::default()
        };
        assert_eq!(
            check_snapshot(&ok, &other, now).unwrap_err().code,
            "policy_authority_mismatch"
        );
    }

    #[test]
    fn lease_uses_local_duration_despite_server_skew_and_checks_overflow() {
        let cfg = CloudConfig::default();
        let now = 1_000_000u64;
        for issued in [now - 5_000, now, now + 5_000] {
            let v = snap(1, issued, issued + 55_000, vec![]);
            let s = check_snapshot(&v, &cfg, now).unwrap();
            assert_eq!(s.lease_expires_ms, now + 55_000);
            assert!(
                s.lease_deadline.duration_since(std::time::Instant::now())
                    <= std::time::Duration::from_millis(55_000)
            );
        }
        let v = snap(1, u64::MAX - 1000, u64::MAX, vec![]);
        assert_eq!(
            check_snapshot(&v, &cfg, u64::MAX - 500).unwrap_err().code,
            "invalid_policy_lease"
        );
    }

    #[test]
    fn revision_is_key_order_independent() {
        let a = json!({"b": 1, "a": "x"});
        let b: Value = serde_json::from_str(r#"{"a":"x","b":1}"#).unwrap();
        assert_eq!(revision("c", 1, 2, 3, &[a]), revision("c", 1, 2, 3, &[b]));
    }

    #[test]
    fn account_identity_is_mandatory_and_account_only_changes_raw_revision() {
        let alice = json!({"account_id":"11111111-1111-4111-8111-111111111111"});
        let bob = json!({"account_id":"22222222-2222-4222-8222-222222222222"});
        assert_ne!(
            revision("c", 1, 2, 3, &[alice]),
            revision("c", 1, 2, 3, &[bob])
        );
        for account in [
            Value::Null,
            json!("00000000-0000-0000-0000-000000000000"),
            json!("SERVICE_ACCOUNT"),
        ] {
            let snapshot = snap(1, 1_000_000, 1_055_000, vec![json!({"account_id":account})]);
            assert_eq!(
                check_snapshot(&snapshot, &CloudConfig::default(), 1_000_000)
                    .unwrap_err()
                    .code,
                "invalid_policy_account"
            );
        }
        let snapshot = snap(1, 1_000_000, 1_055_000, vec![json!({"id":"missing"})]);
        assert_eq!(
            check_snapshot(&snapshot, &CloudConfig::default(), 1_000_000)
                .unwrap_err()
                .code,
            "invalid_policy_account"
        );
        assert!(CAPABILITIES.contains(&"next_account_v1"));
        assert!(CAPABILITIES.contains(&"next_device_v1"));
        assert!(CAPABILITIES.contains(&"policy-freshness-lease-v1"));
        assert!(!CAPABILITIES.contains(&"lease_v1"));
    }

    fn declared_setup_grant() -> Value {
        use crate::attest::{Binding, Proof, attestation_message, test_signer::Signer};
        use sha2::{Digest, Sha256};
        let fixture: Value = serde_json::from_str(include_str!(
            "../tests/fixtures/application-authorization-v4.json"
        ))
        .unwrap();
        let mut declaration: Value = serde_json::from_str(include_str!(
            "../../../packages/sdk/test/fixtures/journal-private-setup.json"
        ))
        .unwrap();
        declaration["requirements"]["configuration"] = json!([]);
        declaration["provisions"]["configuration"] = json!([]);
        let mut binding: Binding = serde_json::from_value(fixture["binding"].clone()).unwrap();
        let installation = Signer::from_scalar(
            fixture["installation_signing_private_key"]
                .as_str()
                .unwrap(),
            &binding.installation_signing_public_key,
        );
        let signing = Signer::random();
        binding.grant_signing_public_key = signing.public_b64();
        binding.application_declaration_id = declaration["id"].as_str().unwrap().into();
        binding.application_manifest_digest = format!(
            "{:x}",
            Sha256::digest(serde_jcs::to_vec(&declaration).unwrap())
        );
        binding.protocol_version = 5;
        binding.contracts.authorization_binding = 5;
        binding.contracts.operation_transport = 3;
        binding.contracts.semantic_capabilities = 2;
        binding.contracts.durable_mutation = Some(1);
        binding.requested_operations = [
            "describe",
            "changes",
            "read",
            "query",
            "list_views",
            "execute_view",
            "read_view_source",
            "validate",
            "read_type",
            "create",
            "update",
            "rename",
            "assess_collection_setup",
            "apply_collection_setup",
        ]
        .into_iter()
        .map(str::to_owned)
        .collect();
        binding.requested_files = Some(
            serde_json::from_value(json!({
                "actions": ["list", "read", "add", "replace", "move"],
                "scope": {"kind": "collection"}
            }))
            .unwrap(),
        );
        binding.redirect_uri = Some(declaration["redirect_uris"][0].as_str().unwrap().into());
        let proof = Proof {
            signature: installation.sign(&binding.signing_message().unwrap()),
            binding,
        };
        let client_pk = crate::noise::public_key(&[9u8; 32]);
        let authorization = attest::uuid_bytes(&proof.binding.authorization_id).unwrap();
        json!({
            "id": "11111111-1111-4111-8111-111111111111",
            "account_id": "22222222-2222-4222-8222-222222222222",
            "application_id": proof.binding.application_id,
            "collection_id": "33333333-3333-4333-8333-333333333333",
            "application_name": "Journal",
            "capabilities": ["collection.read", "records.create", "records.edit"],
            "operations": proof.binding.requested_operations,
            "client_pk": secrets::hex(&client_pk),
            "client_key_signature": signing.sign(&attestation_message(&authorization, &client_pk)),
            "application_authorization": proof,
            "application_declaration": declaration
        })
    }

    #[test]
    fn declared_setup_is_retained_without_definition_management() {
        let feed = declared_setup_grant();
        let cached = to_cached(&feed).unwrap();
        assert!(
            !cached
                .capabilities
                .iter()
                .any(|c| c == "definitions.manage")
        );
        let persisted = serde_json::to_value(cached).unwrap();
        assert_eq!(
            persisted["declared_setup"]["declaration"],
            feed["application_declaration"]
        );
    }

    #[test]
    fn declared_setup_core_bridge_uses_only_signed_journal_packs() {
        let cached = to_cached(&declared_setup_grant()).unwrap();
        let evidence = cached.declared_setup.as_ref().unwrap();
        let setup = evidence.core_setup().unwrap();
        assert_eq!(setup.application_id, evidence.application_id());
        assert_eq!(setup.declaration_digest.to_string(), evidence.digest());
        assert_eq!(setup.type_packs.len(), 1);
        assert!(
            setup
                .type_packs
                .iter()
                .all(|p| p.options.installed_by == setup.application_id)
        );
    }

    #[test]
    fn declared_setup_native_source_requires_synced_account_custody_consent_and_lease() {
        use crate::{
            access::AccessList,
            authority::Authority,
            cloud::AccountRecord,
            registry::{Entry, Origin, Registry, SyncMode},
        };
        let cached = to_cached(&declared_setup_grant()).unwrap();
        let authority = Authority::default();
        let identity = crate::secrets::DeviceIdentity::generate().unwrap();
        let record = AccountRecord {
            schema_version: 1,
            epoch: 1,
            signed_in: true,
            connector_id: Some("test".into()),
            account_id: cached.account_id.clone(),
        };
        let config = CloudConfig {
            account_epoch: 1,
            connector_id: Some("test".into()),
            ..Default::default()
        };
        authority
            .publish_account_identity(&record, &config, &identity)
            .unwrap();
        let mut registration = Entry {
            id: cached.collection.clone(),
            name: "test".into(),
            root: "/not-opened".into(),
            replica_id: cached.grant.clone(),
            mode: SyncMode::SyncedE2e,
            origin: Origin::Created,
            description: None,
            added_at_ms: 0,
            paused: false,
            ever_e2e: true,
            owner_account: None,
            device: Some(secrets::uuid_string(&identity.device_id)),
        };
        let publish_registry = |entry: &Entry| {
            authority.publish_registry(&Registry {
                collections: vec![entry.clone()],
                ..Default::default()
            })
        };
        publish_registry(&registration);
        let mut access = AccessList::default();
        let now = crate::fsutil::now_ms() as u64;
        access.sync_from_control_plane(
            &cached.collection,
            std::slice::from_ref(&cached),
            now,
            now + 50_000,
            false,
        );
        authority.publish_access(&access);
        let grant = mdbn_wire::common::B16(attest::uuid_bytes(&cached.grant).unwrap());
        let source = authority
            .source(mdbn_wire::common::B16(
                attest::uuid_bytes(&cached.collection).unwrap(),
            ))
            .unwrap();
        let current = source.declared_setup(&grant).unwrap();
        assert_eq!(current.generation, access.entries[0].generation);
        assert_eq!(current.client_pk.0, crate::noise::public_key(&[9; 32]));
        assert!(
            source.grant(&grant).is_none(),
            "setup must not infer local owner permissions for synced grants"
        );
        // Uninterrupted renewal preserves a review; an expiry gap followed by
        // renewal changes its incarnation, even with identical grant terms.
        access.sync_from_control_plane(
            &cached.collection,
            std::slice::from_ref(&cached),
            now,
            now + 50_000,
            false,
        );
        authority.publish_access(&access);
        assert_eq!(
            source.declared_setup(&grant).unwrap().lease_generation,
            current.lease_generation
        );
        access
            .monotonic_leases
            .insert(cached.collection.clone(), std::time::Instant::now());
        authority.publish_access(&access);
        assert!(source.declared_setup(&grant).is_none());
        access.sync_from_control_plane(
            &cached.collection,
            std::slice::from_ref(&cached),
            now,
            now + 50_000,
            false,
        );
        authority.publish_access(&access);
        assert!(source.declared_setup(&grant).unwrap().lease_generation > current.lease_generation);
        registration.paused = true;
        publish_registry(&registration);
        assert!(source.declared_setup(&grant).is_none());
        registration.paused = false;
        publish_registry(&registration);
        access.revoke(&cached.grant).unwrap();
        authority.publish_access(&access);
        assert!(source.declared_setup(&grant).is_none());
        // Source replacement is permanently account-epoch fenced.
        authority.invalidate(2);
        assert!(source.declared_setup(&grant).is_none());
    }

    #[test]
    fn declared_setup_substitution_is_refused() {
        let mut feed = declared_setup_grant();
        feed["application_declaration"]["provisions"]["type_packs"] = json!([]);
        assert!(to_cached(&feed).is_err());
    }

    #[test]
    fn declared_setup_missing_evidence_partial_pair_and_unsigned_operation_are_refused() {
        let original = declared_setup_grant();
        let mut missing = original.clone();
        missing
            .as_object_mut()
            .unwrap()
            .remove("application_declaration");
        assert!(to_cached(&missing).is_err());
        let mut partial = original.clone();
        partial["operations"]
            .as_array_mut()
            .unwrap()
            .retain(|op| op != "apply_collection_setup");
        assert!(to_cached(&partial).is_err());
        let mut unsigned = original;
        unsigned["operations"]
            .as_array_mut()
            .unwrap()
            .push(json!("create_type"));
        assert!(to_cached(&unsigned).is_err());
    }

    #[test]
    fn grants_without_a_valid_binding_are_dropped() {
        let g = json!({ "id": "x", "application_id": "y", "collection_id": "z" });
        assert!(to_cached(&g).is_err());
    }

    #[test]
    fn ws_urls() {
        assert_eq!(
            ws_url("https://connect.mdbase.dev"),
            "wss://connect.mdbase.dev/v1/relay"
        );
        assert_eq!(ws_url("http://127.0.0.1:9"), "ws://127.0.0.1:9/v1/relay");
    }
}
