//! The account link: pairing as a connector, device registration, inventory,
//! grant revocation and the synced-collection bootstrap calls (cloud copy and
//! private create/join, role-0 log tokens) over Connect's HTTP API. Every
//! device-signed proof digest is the shared [`mdbn_replica::crypto::proof`] one
//! (control interface note `2026-10-04-control-daemon-grant-feed-and-relay.md` §1;
//! Connect #595, #616, #621, #624).
//!
//! **State.** `<state>/cloud.json` holds the non-secret part
//! ([`CloudConfig`]: server URL, connector ID and registration flag). The durable
//! policy cursor is committed with the access cache in `access.json`. The connector token lives in the OS keychain
//! (`<namespace>:connector-token`) and never appears in files, logs, status or
//! process arguments.
//!
//! **TLS** uses rustls with the OS trust store (`rustls-native-certs`). Plain
//! `http` is accepted only for loopback hosts (tests and LAB tunnels).

use std::path::Path;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use zeroize::Zeroizing;

use mdbn_replica::crypto::proof;
use mdbn_wire::common::B16;

use crate::fsutil;
use crate::secrets::{self, DeviceIdentity, SecretStore};

#[path = "cloud_approval_peer.rs"]
mod approval_peer;
pub use approval_peer::{ApprovalPeerCandidate, ApprovalPeerQueued};

/// Keychain entry of the connector token.
pub const CONNECTOR_TOKEN: &str = "connector-token";

/// Non-secret account state (`<state>/cloud.json`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct CloudConfig {
    /// Schema version.
    pub schema_version: u32,
    /// Account epoch; must match the durable signed-in fence before reconnect.
    #[serde(default)]
    pub account_epoch: u64,
    /// Canonical server origin.
    pub server_url: String,
    /// This connector's ID, pinned at pairing (or from the first snapshot).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connector_id: Option<String>,
    /// Whether this device is registered to the connector.
    #[serde(default)]
    pub device_registered: bool,
    /// In-memory relay replay guard. At relay startup, the authoritative cursor
    /// is loaded from access.json; feed commits do not write cloud.json.
    #[serde(default)]
    pub policy_sequence: u64,
    /// Revision of `policy_sequence`.
    #[serde(default)]
    pub policy_revision: String,
}

impl CloudConfig {
    /// Load, or `None` when not signed in.
    pub fn load(path: &Path) -> Result<Option<CloudConfig>, CloudError> {
        match fsutil::read_optional(path).map_err(|e| CloudError::Local(e.to_string()))? {
            None => Ok(None),
            Some(b) => serde_json::from_slice(&b)
                .map(Some)
                .map_err(|e| CloudError::Local(format!("cloud.json: {e}"))),
        }
    }

    /// Save durably.
    pub fn save(&self, path: &Path) -> Result<(), CloudError> {
        let mut b =
            serde_json::to_vec_pretty(self).map_err(|e| CloudError::Local(e.to_string()))?;
        b.push(b'\n');
        fsutil::write_atomic(path, &b).map_err(|e| CloudError::Local(e.to_string()))
    }
}

/// Durable account publication fence. Missing/invalid state never reconnects.
/// Written signed-out before cleanup, and signed-in only after token/config save.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct AccountRecord {
    /// Current schema (1); default/missing file is signed-out schema 1.
    pub schema_version: u32,
    /// Monotonically increasing login/logout generation.
    pub epoch: u64,
    /// Whether this epoch completed credential/config publication.
    pub signed_in: bool,
    /// Pinned connector, required when signed in.
    pub connector_id: Option<String>,
    /// Authenticated Connect pairing account; missing legacy fences never serve.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
}

impl AccountRecord {
    /// Load a fence. An absent file is signed out; malformed/newer data fails.
    pub fn load(path: &Path) -> Result<Self, CloudError> {
        let Some(bytes) =
            fsutil::read_optional(path).map_err(|e| CloudError::Local(e.to_string()))?
        else {
            return Ok(Self {
                schema_version: 1,
                ..Self::default()
            });
        };
        fsutil::verify_owner_only(path).map_err(|e| CloudError::Local(e.to_string()))?;
        let record: Self = serde_json::from_slice(&bytes)
            .map_err(|_| CloudError::Local("invalid account fence".into()))?;
        if record.schema_version != 1 || (record.signed_in && record.connector_id.is_none()) {
            return Err(CloudError::Local("unsupported account fence".into()));
        }
        Ok(record)
    }

    /// Save the authoritative publication fence atomically and durably.
    pub fn save(&self, path: &Path) -> Result<(), CloudError> {
        let bytes = serde_json::to_vec(self)
            .map_err(|_| CloudError::Local("account fence encoding".into()))?;
        fsutil::write_atomic(path, &bytes).map_err(|e| CloudError::Local(e.to_string()))
    }

    /// The paired account, never inferred from connector/device/grant metadata.
    pub fn active_account(&self) -> Option<mdbn_wire::common::B16> {
        if self.schema_version != 1 || !self.signed_in {
            return None;
        }
        crate::authority::account_id(self.account_id.as_deref()?)
    }

    /// Stale/partial cloud metadata cannot reactivate this account.
    pub fn permits(&self, config: &CloudConfig) -> bool {
        self.schema_version == 1
            && self.active_account().is_some()
            && self.epoch == config.account_epoch
            && self.connector_id.is_some()
            && self.connector_id == config.connector_id
    }
}

/// Account-link failures. Messages never carry credentials.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CloudError {
    /// Local state.
    Local(String),
    /// Network or TLS.
    Network(String),
    /// The server refused: HTTP status and its error code.
    Server(u16, String),
    /// The credential was rejected (401/403): sign in again.
    Unauthenticated,
}

impl std::fmt::Display for CloudError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CloudError::Local(m) => write!(f, "account state: {m}"),
            CloudError::Network(m) => write!(f, "network: {m}"),
            CloudError::Server(s, c) => write!(f, "server refused ({s} {c})"),
            CloudError::Unauthenticated => f.write_str("the account credential was rejected"),
        }
    }
}

impl std::error::Error for CloudError {}

/// Canonicalise a server URL: `https` (or `http` on loopback), no userinfo, no
/// path, query or fragment, no trailing slash.
pub fn canonical_server_url(s: &str) -> Result<String, CloudError> {
    let bad = |m: &str| CloudError::Local(format!("server URL: {m}"));
    let (scheme, rest) = s.split_once("://").ok_or_else(|| bad("missing scheme"))?;
    let host = rest.split(['/', '?', '#']).next().unwrap_or_default();
    if host.is_empty() || host.contains('@') {
        return Err(bad("bad host"));
    }
    let hostname = host.rsplit_once(':').map(|(h, _)| h).unwrap_or(host);
    let loopback = matches!(hostname, "localhost" | "127.0.0.1" | "[::1]");
    match scheme {
        "https" => {}
        "http" if loopback => {}
        _ => return Err(bad("https is required")),
    }
    Ok(format!("{scheme}://{}", host.to_ascii_lowercase()))
}

/// The rustls client config: the OS trust store (`rustls-native-certs`: system
/// bundle on Linux, Keychain on macOS, the certificate store on Windows), ring
/// provider.
pub fn tls_config() -> Result<Arc<rustls::ClientConfig>, CloudError> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let mut roots = rustls::RootCertStore::empty();
    let found = rustls_native_certs::load_native_certs();
    for c in found.certs {
        let _ = roots.add(c);
    }
    if roots.is_empty() {
        return Err(CloudError::Network(
            "no trusted root certificates on this system".into(),
        ));
    }
    let cfg = rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|e| CloudError::Network(e.to_string()))?
        .with_root_certificates(roots)
        .with_no_client_auth();
    Ok(Arc::new(cfg))
}

fn http(tls: &Arc<rustls::ClientConfig>) -> Result<reqwest::Client, CloudError> {
    reqwest::Client::builder()
        .use_preconfigured_tls((**tls).clone())
        .timeout(std::time::Duration::from_secs(30))
        .user_agent(concat!("mdbase-daemon/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| CloudError::Network(e.to_string()))
}

async fn json_response(r: reqwest::Response) -> Result<(u16, Value), CloudError> {
    let status = r.status().as_u16();
    let v: Value = r.json().await.unwrap_or(Value::Null);
    if status == 401 || status == 403 {
        return Err(CloudError::Unauthenticated);
    }
    if status >= 400 {
        let code = v
            .pointer("/error/code")
            .and_then(Value::as_str)
            .unwrap_or("error")
            .to_string();
        return Err(CloudError::Server(status, code));
    }
    Ok((status, v))
}

/// A started pairing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Pairing {
    /// Pairing ID.
    pub pairing_id: String,
    /// Where the user approves it.
    pub verification_uri: String,
    /// Seconds until it expires.
    pub expires_in: u64,
    /// The pairing secret (kept in memory by the daemon only).
    #[serde(skip)]
    pub secret: String,
}

/// Start pairing (`POST /v1/pairing-requests`, unauthenticated).
pub async fn pairing_start(
    tls: &Arc<rustls::ClientConfig>,
    server: &str,
    name: &str,
) -> Result<Pairing, CloudError> {
    let r = http(tls)?
        .post(format!("{server}/v1/pairing-requests"))
        .json(&json!({ "connector_name": name }))
        .send()
        .await
        .map_err(|e| CloudError::Network(e.to_string()))?;
    let (_, v) = json_response(r).await?;
    let get = |k: &str| v.get(k).and_then(Value::as_str).map(str::to_string);
    let uri = get("verification_uri").ok_or_else(|| CloudError::Server(200, "malformed".into()))?;
    // The approval page must be on the same origin as the server.
    if canonical_server_url(&uri).ok().as_deref() != Some(server) {
        return Err(CloudError::Server(200, "verification_uri_origin".into()));
    }
    Ok(Pairing {
        pairing_id: get("pairing_id").ok_or_else(|| CloudError::Server(200, "malformed".into()))?,
        verification_uri: uri,
        expires_in: v.get("expires_in").and_then(Value::as_u64).unwrap_or(600),
        secret: get("pairing_secret").ok_or_else(|| CloudError::Server(200, "malformed".into()))?,
    })
}

/// An authenticated successful pairing. No Debug implementation exposes the token.
pub struct Paired {
    /// Connector identity (not the account).
    pub connector_id: String,
    /// Canonical account UUID from the authenticated exchange response.
    pub account_id: String,
    /// Connector credential, retained only in memory/keychain.
    pub token: Zeroizing<String>,
}

fn paired_response(status: u16, v: &Value) -> Result<Paired, CloudError> {
    let malformed = || CloudError::Server(status, "invalid_pairing_identity".into());
    let account = v
        .get("account_id")
        .and_then(Value::as_str)
        .ok_or_else(malformed)?;
    crate::authority::account_id(account).ok_or_else(malformed)?;
    let connector = v
        .pointer("/connector/id")
        .and_then(Value::as_str)
        .ok_or_else(malformed)?;
    let token = v
        .get("token")
        .and_then(Value::as_str)
        .filter(|t| t.starts_with("con_") && t.len() >= 24 && !t.contains(char::is_whitespace))
        .ok_or_else(malformed)?;
    Ok(Paired {
        connector_id: connector.into(),
        account_id: account.into(),
        token: Zeroizing::new(token.into()),
    })
}

/// Poll a pairing once: an authenticated account/connector/credential once approved.
pub async fn pairing_exchange(
    tls: &Arc<rustls::ClientConfig>,
    server: &str,
    p: &Pairing,
) -> Result<Option<Paired>, CloudError> {
    let r = http(tls)?
        .post(format!(
            "{server}/v1/pairing-requests/{}/exchange",
            p.pairing_id
        ))
        .bearer_auth(&p.secret)
        .send()
        .await
        .map_err(|e| CloudError::Network(e.to_string()))?;
    let (status, v) = json_response(r).await?;
    if status == 202 {
        return Ok(None);
    }
    Ok(Some(paired_response(status, &v)?))
}

/// An authenticated connector client.
pub struct Cloud {
    http: reqwest::Client,
    /// Server origin.
    pub server: String,
    token: Zeroizing<String>,
}

impl std::fmt::Debug for Cloud {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Cloud")
            .field("server", &self.server)
            .finish_non_exhaustive()
    }
}

impl Cloud {
    /// Build from the keychain token.
    pub fn new(
        tls: &Arc<rustls::ClientConfig>,
        server: &str,
        store: &dyn SecretStore,
    ) -> Result<Cloud, CloudError> {
        let token = store
            .get(CONNECTOR_TOKEN)
            .map_err(|e| CloudError::Local(e.to_string()))?
            .ok_or(CloudError::Unauthenticated)?;
        let token = String::from_utf8(token.to_vec()).map_err(|_| CloudError::Unauthenticated)?;
        Ok(Cloud {
            http: http(tls)?,
            server: server.to_string(),
            token: Zeroizing::new(token),
        })
    }

    /// Automatic local takeover permission (Connect #603). Only an explicit
    /// boolean from the authenticated, uncached rollout endpoint permits it.
    pub async fn local_takeover_allowed(
        &self,
        tls: &Arc<rustls::ClientConfig>,
        current: &(dyn Fn() -> Result<(), String> + Send + Sync),
    ) -> Result<bool, CloudError> {
        // Do not accept a permission from a redirected origin.
        let client = reqwest::Client::builder()
            .use_preconfigured_tls((**tls).clone())
            .redirect(reqwest::redirect::Policy::none())
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .map_err(|e| CloudError::Network(e.to_string()))?;
        let request = client
            .get(format!("{}/v1/next/rollout", self.server))
            .bearer_auth(self.token.as_str())
            .header(reqwest::header::CACHE_CONTROL, "no-cache");
        let v = self
            .send_current_status(request, current, Some(200))
            .await?;
        parse_local_takeover(v)
    }

    /// Retire ONLY the exact full old connector (clients migration contract).
    /// A missing endpoint, rejected/unknown response or stale source is not success.
    pub async fn retire_legacy_connector(
        &self,
        tls: &Arc<rustls::ClientConfig>,
        plan: &crate::takeover::retirement::Plan,
        current: &(dyn Fn() -> Result<(), String> + Send + Sync),
    ) -> Result<(), CloudError> {
        let client = reqwest::Client::builder()
            .use_preconfigured_tls((**tls).clone())
            .redirect(reqwest::redirect::Policy::none())
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .map_err(|e| CloudError::Network(e.to_string()))?;
        let request = client
            .post(format!("{}/v1/next/migration/local-takeover", self.server))
            .bearer_auth(self.token.as_str())
            .json(&plan.body());
        let value = self
            .send_current_status(request, current, Some(200))
            .await?;
        parse_legacy_retirement(value, &plan.legacy_connector_id)
    }

    /// The bearer token, for the relay upgrade request.
    pub fn bearer(&self) -> String {
        format!("Bearer {}", self.token.as_str())
    }

    /// The canonical server URL this client talks to.
    pub fn server(&self) -> &str {
        &self.server
    }

    async fn post(&self, path: &str, body: &Value) -> Result<Value, CloudError> {
        let r = self
            .http
            .post(format!("{}{path}", self.server))
            .bearer_auth(self.token.as_str())
            .json(body)
            .send()
            .await
            .map_err(|e| CloudError::Network(e.to_string()))?;
        Ok(json_response(r).await?.1)
    }

    /// Register this device to the connector (idempotent for the same keys).
    pub async fn register_device(
        &self,
        connector_id: &str,
        identity: &DeviceIdentity,
    ) -> Result<(), CloudError> {
        let c = self.post("/v1/next/devices/challenge", &json!({})).await?;
        let challenge = c
            .get("challenge")
            .and_then(Value::as_str)
            .and_then(|h| secrets::hex_decode(h).ok())
            .filter(|b| b.len() == 32)
            .ok_or_else(|| CloudError::Server(200, "malformed".into()))?;
        let p = identity.public();
        let challenge: [u8; 32] = challenge
            .try_into()
            .map_err(|_| CloudError::Server(200, "malformed".into()))?;
        let connector = crate::attest::uuid_bytes(connector_id)
            .ok_or_else(|| CloudError::Local("uuid".into()))?;
        let pk = |h: &str| -> Result<[u8; 32], CloudError> {
            secrets::hex_decode(h)
                .ok()
                .and_then(|b| b.try_into().ok())
                .ok_or_else(|| CloudError::Local("key".into()))
        };
        let digest = mdbn_replica::crypto::proof::cp_enrol_digest(
            &challenge,
            &mdbn_wire::common::B16(connector),
            &mdbn_wire::common::B16(identity.device_id),
            &pk(&p.sign_pk)?,
            &pk(&p.kem_pk)?,
            &pk(&p.noise_pk)?,
        );
        let sig = identity.sign_digest(&digest.0);
        self.post(
            "/v1/next/devices",
            &json!({
                "device_id": p.device,
                "kind": "desktop",
                "sign_pk": p.sign_pk,
                "kem_pk": p.kem_pk,
                "noise_pk": p.noise_pk,
                "challenge": secrets::hex(&challenge),
                "sig": secrets::hex(&sig),
            }),
        )
        .await?;
        Ok(())
    }

    /// Renew this device's role-0 log token for a synced collection (Connect
    /// `POST /v1/next/collections/:id/log-token`). The proof is
    /// `H("mdbase/v1/collection-log-token", cbor[challenge, connector, device,
    /// collection])` over a fresh challenge. Returns the token and its expiry (ms).
    pub async fn collection_log_token(
        &self,
        connector_id: &str,
        collection: &[u8; 16],
        identity: &DeviceIdentity,
        current: &(dyn Fn() -> Result<(), String> + Send + Sync),
    ) -> Result<(Zeroizing<String>, i64), CloudError> {
        let challenge = self.challenge(current).await?;
        current().map_err(CloudError::Local)?;
        let connector = crate::attest::uuid_bytes(connector_id)
            .ok_or_else(|| CloudError::Local("uuid".into()))?;
        let digest = proof::collection_log_token_digest(
            &challenge,
            &B16(connector),
            &B16(identity.device_id),
            &B16(*collection),
        );
        let sig = identity.sign_digest(&digest.0);
        let collection_id = mdbn_wire::common::B16(*collection).to_uuid_string();
        let r = self
            .post_current(
                &format!("/v1/next/collections/{collection_id}/log-token"),
                &json!({
                    "device_id": identity.public().device,
                    "challenge": secrets::hex(&challenge),
                    "sig": secrets::hex(&sig),
                }),
                current,
            )
            .await?;
        current().map_err(CloudError::Local)?;
        let token = r
            .get("token")
            .and_then(Value::as_str)
            .filter(|t| !t.is_empty() && t.len() <= 16 * 1024)
            .ok_or_else(|| CloudError::Server(200, "malformed".into()))?;
        let expires_at = r
            .get("expires_at")
            .and_then(Value::as_i64)
            .ok_or_else(|| CloudError::Server(200, "malformed".into()))?;
        Ok((Zeroizing::new(token.to_string()), expires_at))
    }

    /// Bootstrap transport: bound the response and recheck the captured source
    /// after headers AND each body await, before accepting any result.
    async fn post_current(
        &self,
        path: &str,
        body: &Value,
        current: &(dyn Fn() -> Result<(), String> + Send + Sync),
    ) -> Result<Value, CloudError> {
        let request = self
            .http
            .post(format!("{}{path}", self.server))
            .bearer_auth(self.token.as_str())
            .json(body);
        self.send_current(request, current).await
    }

    /// [`Self::post_current`] for any prepared request (AK1 uses GET and PUT).
    async fn send_current(
        &self,
        request: reqwest::RequestBuilder,
        current: &(dyn Fn() -> Result<(), String> + Send + Sync),
    ) -> Result<Value, CloudError> {
        self.send_current_status(request, current, None).await
    }

    async fn send_current_status(
        &self,
        request: reqwest::RequestBuilder,
        current: &(dyn Fn() -> Result<(), String> + Send + Sync),
        expected_status: Option<u16>,
    ) -> Result<Value, CloudError> {
        let (status, bytes) = self
            .send_current_raw_status(request, current, expected_status)
            .await?;
        let value: Value = serde_json::from_slice(&bytes)
            .map_err(|_| CloudError::Server(status, "malformed".into()))?;
        if status >= 400 {
            let code = value
                .pointer("/error/code")
                .and_then(Value::as_str)
                .filter(|s| {
                    s.len() <= 64
                        && s.bytes()
                            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
                })
                .unwrap_or("error");
            return Err(CloudError::Server(status, code.into()));
        }
        Ok(value)
    }

    // Keep raw bytes available to strict typed decoders: decoding to Value first
    // would discard duplicate JSON keys. Same bounded/current transport for all.
    async fn send_current_raw_status(
        &self,
        request: reqwest::RequestBuilder,
        current: &(dyn Fn() -> Result<(), String> + Send + Sync),
        expected_status: Option<u16>,
    ) -> Result<(u16, Zeroizing<Vec<u8>>), CloudError> {
        current().map_err(CloudError::Local)?;
        let response = request.send().await;
        current().map_err(CloudError::Local)?;
        let mut response = response.map_err(|e| CloudError::Network(e.to_string()))?;
        let status = response.status().as_u16();
        if expected_status.is_some_and(|expected| status != expected) {
            return Err(CloudError::Server(status, "unexpected_status".into()));
        }
        let mut bytes = Zeroizing::new(Vec::new());
        loop {
            let chunk = response.chunk().await;
            current().map_err(CloudError::Local)?;
            let Some(chunk) = chunk.map_err(|e| CloudError::Network(e.to_string()))? else {
                break;
            };
            if bytes
                .len()
                .checked_add(chunk.len())
                .is_none_or(|n| n > 256 * 1024)
            {
                return Err(CloudError::Server(status, "response_too_large".into()));
            }
            bytes.extend_from_slice(&chunk);
        }
        if status == 401 || status == 403 {
            return Err(CloudError::Unauthenticated);
        }
        Ok((status, bytes))
    }

    /// A fresh 32-byte device challenge.
    async fn challenge(
        &self,
        current: &(dyn Fn() -> Result<(), String> + Send + Sync),
    ) -> Result<[u8; 32], CloudError> {
        let c = self
            .post_current("/v1/next/devices/challenge", &json!({}), current)
            .await?;
        c.get("challenge")
            .and_then(Value::as_str)
            .filter(|h| h.len() == 64)
            .and_then(|h| secrets::hex_decode(h).ok())
            .and_then(|b| <[u8; 32]>::try_from(b).ok())
            .ok_or_else(|| CloudError::Server(200, "malformed".into()))
    }

    /// One proof-of-possession next-bootstrap request: a fresh challenge, the
    /// caller's authority rechecked after it, then the device signs the shared
    /// [`proof::collection_proof_digest`] of `kind`.
    #[allow(clippy::too_many_arguments)]
    async fn proven_post(
        &self,
        path: &str,
        kind: proof::CollectionProof,
        connector_id: &str,
        collection: &[u8; 16],
        sas_commit: Option<&[u8; 32]>,
        mut body: serde_json::Map<String, Value>,
        identity: &DeviceIdentity,
        current: &(dyn Fn() -> Result<(), String> + Send + Sync),
    ) -> Result<Value, CloudError> {
        current().map_err(CloudError::Local)?;
        let challenge = self.challenge(current).await?;
        current().map_err(CloudError::Local)?;
        let connector = crate::attest::uuid_bytes(connector_id)
            .ok_or_else(|| CloudError::Local("uuid".into()))?;
        let digest = proof::collection_proof_digest(
            kind,
            &challenge,
            &B16(connector),
            &B16(identity.device_id),
            &B16(*collection),
            sas_commit,
        )
        .ok_or_else(|| CloudError::Local("proof shape".into()))?;
        let sig = identity.sign_digest(&digest.0);
        body.insert("device_id".into(), json!(identity.public().device));
        body.insert("challenge".into(), json!(secrets::hex(&challenge)));
        body.insert("sig".into(), json!(secrets::hex(&sig)));
        if let Some(c) = sas_commit {
            body.insert("sas_commit".into(), json!(secrets::hex(c)));
        }
        current().map_err(CloudError::Local)?;
        let answer = self.post_current(path, &Value::Object(body), current).await;
        // A stale result is never publication authority, including a refusal.
        // This does not claim the old request was not sent or not committed.
        current().map_err(CloudError::Local)?;
        answer
    }

    /// Create a **cloud copy** owned by this account, from this registered device
    /// (Connect #616, `POST /v1/next/collections/cloud-copy`).
    pub async fn create_cloud_copy(
        &self,
        connector_id: &str,
        collection: &[u8; 16],
        identity: &DeviceIdentity,
        current: &(dyn Fn() -> Result<(), String> + Send + Sync),
    ) -> Result<Created, CloudError> {
        let mut body = serde_json::Map::new();
        body.insert(
            "collection_id".into(),
            json!(mdbn_wire::common::B16(*collection).to_uuid_string()),
        );
        let v = self
            .proven_post(
                "/v1/next/collections/cloud-copy",
                proof::CollectionProof::CloudCopyCreate,
                connector_id,
                collection,
                None,
                body,
                identity,
                current,
            )
            .await?;
        Created::parse(&v, "cloud-copy")
    }

    /// Create a **private** (end-to-end) collection from this registered device
    /// (Connect #621, `POST /v1/next/collections/private`).
    pub async fn create_private(
        &self,
        connector_id: &str,
        collection: &[u8; 16],
        identity: &DeviceIdentity,
        current: &(dyn Fn() -> Result<(), String> + Send + Sync),
    ) -> Result<Created, CloudError> {
        let mut body = serde_json::Map::new();
        body.insert(
            "collection_id".into(),
            json!(mdbn_wire::common::B16(*collection).to_uuid_string()),
        );
        let v = self
            .proven_post(
                "/v1/next/collections/private",
                proof::CollectionProof::PrivateCreate,
                connector_id,
                collection,
                None,
                body,
                identity,
                current,
            )
            .await?;
        Created::parse(&v, "private")
    }

    /// Join this account's cloud copy from this registered device (Connect #616,
    /// `POST /v1/next/collections/:id/devices`). Hosted (or escrow) then wraps the
    /// current epoch key to it.
    pub async fn join_cloud_copy(
        &self,
        connector_id: &str,
        collection: &[u8; 16],
        identity: &DeviceIdentity,
        current: &(dyn Fn() -> Result<(), String> + Send + Sync),
    ) -> Result<Joined, CloudError> {
        let id = mdbn_wire::common::B16(*collection).to_uuid_string();
        let v = self
            .proven_post(
                &format!("/v1/next/collections/{id}/devices"),
                proof::CollectionProof::CloudCopyJoin,
                connector_id,
                collection,
                None,
                serde_json::Map::new(),
                identity,
                current,
            )
            .await?;
        Joined::parse(&v)
    }

    /// Enrol this device in a private collection with its SAS commitment (Connect
    /// #621, `POST /v1/next/collections/:id/private/devices`). An owner device then
    /// approves it by the six-digit code.
    pub async fn enrol_private(
        &self,
        connector_id: &str,
        collection: &[u8; 16],
        sas_commit: &[u8; 32],
        identity: &DeviceIdentity,
        current: &(dyn Fn() -> Result<(), String> + Send + Sync),
    ) -> Result<Joined, CloudError> {
        let id = mdbn_wire::common::B16(*collection).to_uuid_string();
        let v = self
            .proven_post(
                &format!("/v1/next/collections/{id}/private/devices"),
                proof::CollectionProof::PrivateDeviceEnrol,
                connector_id,
                collection,
                Some(sas_commit),
                serde_json::Map::new(),
                identity,
                current,
            )
            .await?;
        Joined::parse(&v)
    }

    /// Log a fresh SAS commitment for an enrolled private device (Connect #624,
    /// `POST /v1/next/collections/:id/private/devices/approval-request`).
    pub async fn request_private_approval(
        &self,
        connector_id: &str,
        collection: &[u8; 16],
        sas_commit: &[u8; 32],
        identity: &DeviceIdentity,
        current: &(dyn Fn() -> Result<(), String> + Send + Sync),
    ) -> Result<u64, CloudError> {
        let id = mdbn_wire::common::B16(*collection).to_uuid_string();
        let v = self
            .proven_post(
                &format!("/v1/next/collections/{id}/private/devices/approval-request"),
                proof::CollectionProof::PrivateApprovalRequest,
                connector_id,
                collection,
                Some(sas_commit),
                serde_json::Map::new(),
                identity,
                current,
            )
            .await?;
        v.get("requested_at")
            .and_then(Value::as_u64)
            .ok_or_else(|| CloudError::Server(200, "malformed".into()))
    }

    /// A signed account-key request proof (Connect #635): a fresh challenge, then the
    /// device signs the shared [`proof::account_proof_digest`] of `kind`.
    async fn account_proof(
        &self,
        kind: proof::AccountProof,
        connector_id: &str,
        account: &[u8; 16],
        extra: Vec<mdbn_wire::cbor::Cbor>,
        identity: &DeviceIdentity,
        current: &(dyn Fn() -> Result<(), String> + Send + Sync),
    ) -> Result<([u8; 32], [u8; 64]), CloudError> {
        let challenge = self.challenge(current).await?;
        current().map_err(CloudError::Local)?;
        let connector = crate::attest::uuid_bytes(connector_id)
            .ok_or_else(|| CloudError::Local("uuid".into()))?;
        let digest = proof::account_proof_digest(
            kind,
            &challenge,
            &B16(connector),
            &B16(identity.device_id),
            &B16(*account),
            extra,
        );
        let sig = identity.sign_digest(&digest.0);
        Ok((challenge, sig))
    }

    /// AK1: this account's account-key record (`GET /v1/next/account-key`, proof in
    /// headers). Rate-limited per account by the control plane.
    pub async fn account_key_fetch(
        &self,
        connector_id: &str,
        account: &[u8; 16],
        identity: &DeviceIdentity,
        current: &(dyn Fn() -> Result<(), String> + Send + Sync),
    ) -> Result<AccountKeyRecord, CloudError> {
        let (challenge, sig) = self
            .account_proof(
                proof::AccountProof::Fetch,
                connector_id,
                account,
                vec![],
                identity,
                current,
            )
            .await?;
        let request = self
            .http
            .get(format!("{}/v1/next/account-key", self.server))
            .bearer_auth(self.token.as_str())
            .header("x-mdbase-device-id", identity.public().device.clone())
            .header("x-mdbase-challenge", secrets::hex(&challenge))
            .header("x-mdbase-signature", secrets::hex(&sig));
        let v = self.send_current(request, current).await?;
        AccountKeyRecord::parse(&v)
    }

    /// AK1: this account's account-key metadata (`GET /v1/next/account-key/status`):
    /// mode, version and key id, no bundle. Not on the per-account fetch budget.
    pub async fn account_key_status(
        &self,
        current: &(dyn Fn() -> Result<(), String> + Send + Sync),
    ) -> Result<AccountKeyRecord, CloudError> {
        let request = self
            .http
            .get(format!("{}/v1/next/account-key/status", self.server))
            .bearer_auth(self.token.as_str());
        let v = self.send_current(request, current).await?;
        AccountKeyRecord::parse_status(&v)
    }

    /// AK1: store a sealed bundle (create, re-wrap or rotate) with compare-and-set on
    /// `expected_version`. Returns the new version.
    ///
    /// Every write registers R's proof key (`proof_pk`); replacing an existing
    /// password-mode bundle also signs the rewrap digest with it (`proof_sig`), so a
    /// signed-in device without R cannot overwrite the bundle.
    #[allow(clippy::too_many_arguments)]
    pub async fn account_key_put(
        &self,
        connector_id: &str,
        account: &[u8; 16],
        expected_version: u64,
        key_id: &[u8; 32],
        bundle: &[u8],
        proof: &mdbn_replica::crypto::sign::DeviceSigner,
        replacing: bool,
        identity: &DeviceIdentity,
        current: &(dyn Fn() -> Result<(), String> + Send + Sync),
    ) -> Result<u64, CloudError> {
        use mdbn_wire::cbor::Cbor;
        let extra = vec![
            Cbor::Uint(expected_version),
            Cbor::Bytes(key_id.to_vec()),
            Cbor::Bytes(bundle.to_vec()),
        ];
        let (challenge, sig) = self
            .account_proof(
                proof::AccountProof::Put,
                connector_id,
                account,
                extra,
                identity,
                current,
            )
            .await?;
        let mut body = json!({
            "device_id": identity.public().device,
            "challenge": secrets::hex(&challenge),
            "sig": secrets::hex(&sig),
            "expected_version": expected_version,
            "key_id": secrets::hex(key_id),
            "bundle": secrets::hex(bundle),
            "proof_pk": secrets::hex(&proof.public()),
        });
        if replacing {
            let digest = mdbn_replica::crypto::account_key::rewrap_digest(
                &mdbn_wire::common::B16(*account),
                bundle,
                expected_version,
            );
            body["proof_sig"] = json!(secrets::hex(&proof.sign_digest(&digest)));
        }
        let request = self
            .http
            .put(format!("{}/v1/next/account-key", self.server))
            .bearer_auth(self.token.as_str())
            .json(&body);
        let v = self.send_current(request, current).await?;
        v.get("version")
            .and_then(Value::as_u64)
            .ok_or_else(|| CloudError::Server(200, "malformed".into()))
    }

    /// AK1: strict mode: the control plane drops the bundle and revokes the account's
    /// recovery devices. Returns the new version and the authoritative, complete set
    /// of the account's recovery devices (`recovery_devices`: every one ever enrolled
    /// in a current private collection), or `None` when the control plane did not
    /// send it (an older server: completion is then unknown, never assumed).
    pub async fn account_key_strict(
        &self,
        connector_id: &str,
        account: &[u8; 16],
        expected_version: u64,
        identity: &DeviceIdentity,
        current: &(dyn Fn() -> Result<(), String> + Send + Sync),
    ) -> Result<(u64, Option<RecoveryDevices>), CloudError> {
        use mdbn_wire::cbor::Cbor;
        let (challenge, sig) = self
            .account_proof(
                proof::AccountProof::Strict,
                connector_id,
                account,
                vec![Cbor::Uint(expected_version)],
                identity,
                current,
            )
            .await?;
        let body = json!({
            "device_id": identity.public().device,
            "challenge": secrets::hex(&challenge),
            "sig": secrets::hex(&sig),
            "expected_version": expected_version,
        });
        let v = self
            .post_current("/v1/next/account-key/strict", &body, current)
            .await?;
        let version = v
            .get("version")
            .and_then(Value::as_u64)
            .ok_or_else(|| CloudError::Server(200, "malformed".into()))?;
        Ok((version, parse_recovery_devices(&v)?))
    }

    /// Query replica-witness targets, or submit one immutable applied attestation.
    /// A normal device proof binds the entire optional witness to this request.
    pub async fn strict_witness_request(
        &self,
        connector_id: &str,
        collection: &[u8; 16],
        witness: Option<&mdbn_replica::replica::StrictWitness>,
        identity: &DeviceIdentity,
        current: &(dyn Fn() -> Result<(), String> + Send + Sync),
    ) -> Result<Value, CloudError> {
        use mdbn_wire::cbor::Cbor;
        let fields = if let Some(w) = witness {
            if w.collection.0 != *collection || w.reporter.0 != identity.device_id {
                return Err(CloudError::Local("witness_identity_mismatch".into()));
            }
            let Cbor::Array(mut fields) = w.fields() else {
                unreachable!()
            };
            fields.push(Cbor::Bytes(w.signature.0.to_vec()));
            Cbor::Array(fields)
        } else {
            Cbor::Array(Vec::new())
        };
        let (challenge, sig) = self
            .account_proof(
                proof::AccountProof::StrictReport,
                connector_id,
                collection,
                vec![fields],
                identity,
                current,
            )
            .await?;
        let mut body = json!({
            "device_id": identity.public().device,
            "challenge": secrets::hex(&challenge), "sig": secrets::hex(&sig),
        });
        if let Some(w) = witness {
            body["witness"] = json!({
                "account_id": secrets::uuid_string(&w.account.0), "collection_id": secrets::uuid_string(collection),
                "recovery_device": secrets::uuid_string(&w.recovery_device.0), "strict_version": w.version,
                "revoked_at": w.revoked_at, "applied_at": w.applied_at, "epoch": w.epoch,
                "reporter": secrets::uuid_string(&w.reporter.0), "signature": secrets::hex(&w.signature.0),
            });
        }
        self.post_current(
            &format!(
                "/v1/next/collections/{}/private/strict-witness",
                secrets::uuid_string(collection)
            ),
            &body,
            current,
        )
        .await
    }

    /// AK1: enrol this account's recovery device of `collection`, with a proof of
    /// possession by the recovery key over the complete public tuple.
    pub async fn account_key_device_enrol(
        &self,
        connector_id: &str,
        account: &[u8; 16],
        collection: &[u8; 16],
        recovery: &mdbn_replica::crypto::recovery::RecoveryKeys,
        identity: &DeviceIdentity,
        current: &(dyn Fn() -> Result<(), String> + Send + Sync),
    ) -> Result<u64, CloudError> {
        current().map_err(CloudError::Local)?;
        let challenge = self.challenge(current).await?;
        current().map_err(CloudError::Local)?;
        let connector = crate::attest::uuid_bytes(connector_id)
            .ok_or_else(|| CloudError::Local("uuid".into()))?;
        let sign_pk = recovery.signer.public();
        let kem_pk = recovery.kem.pk;
        let rdev = recovery.device.0;
        let (caller, tuple) = proof::account_key_device_digests(
            &challenge,
            &B16(connector),
            &B16(identity.device_id),
            &B16(*collection),
            &B16(*account),
            &B16(rdev),
            &sign_pk,
            &kem_pk,
        );
        let sig = identity.sign_digest(&caller.0);
        let pop = recovery.signer.sign_digest(&tuple.0);
        let id = mdbn_wire::common::B16(*collection).to_uuid_string();
        let body = json!({
            "device_id": identity.public().device,
            "challenge": secrets::hex(&challenge),
            "sig": secrets::hex(&sig),
            "recovery_device": recovery.device.to_uuid_string(),
            "sign_pk": secrets::hex(&sign_pk),
            "kem_pk": secrets::hex(&kem_pk),
            "pop": secrets::hex(&pop),
        });
        let v = self
            .post_current(
                &format!("/v1/next/collections/{id}/private/account-key-device"),
                &body,
                current,
            )
            .await?;
        v.get("enrolled_at")
            .and_then(Value::as_u64)
            .ok_or_else(|| CloudError::Server(200, "malformed".into()))
    }

    /// Publish the collection inventory (`POST /v1/connectors/sync`).
    pub async fn inventory(
        &self,
        revision: u64,
        collections: Vec<Value>,
    ) -> Result<(), CloudError> {
        self.post(
            "/v1/connectors/sync",
            &json!({ "inventory_revision": revision, "collections": collections }),
        )
        .await?;
        Ok(())
    }

    /// Revoke a grant the user revoked on this device
    /// (`DELETE /v1/connectors/grants/:id`). The relay must keep acking
    /// snapshots while this is in flight.
    pub async fn revoke_grant(&self, grant: &str) -> Result<(), CloudError> {
        let r = self
            .http
            .delete(format!("{}/v1/connectors/grants/{grant}", self.server))
            .bearer_auth(self.token.as_str())
            .send()
            .await
            .map_err(|e| CloudError::Network(e.to_string()))?;
        json_response(r).await?;
        Ok(())
    }
}

fn parse_legacy_retirement(value: Value, expected: &str) -> Result<(), CloudError> {
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Retired {
        retired: bool,
        legacy_connector_id: String,
    }
    let r: Retired =
        serde_json::from_value(value).map_err(|_| CloudError::Server(200, "malformed".into()))?;
    if !r.retired || r.legacy_connector_id != expected {
        return Err(CloudError::Server(200, "retirement_not_confirmed".into()));
    }
    Ok(())
}

/// A released cohort alone is not permission.
/// Apps must already be routed to next before folders are claimed.
fn parse_local_takeover(v: Value) -> Result<bool, CloudError> {
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Rollout {
        local_takeover: bool,
        account_backend: Option<Backend>,
    }
    #[derive(Deserialize, PartialEq)]
    #[serde(rename_all = "snake_case")]
    enum Backend {
        Legacy,
        Next,
    }
    let r: Rollout =
        serde_json::from_value(v).map_err(|_| CloudError::Server(200, "malformed".into()))?;
    Ok(r.local_takeover && r.account_backend == Some(Backend::Next))
}

/// Bound on the strict response's recovery-device set: larger is refused as
/// malformed, never truncated (a truncated set would claim completion early).
const MAX_RECOVERY_DEVICES: usize = 65_536;

/// An account's recovery devices: (collection ID, device ID).
pub type RecoveryDevices = Vec<(String, [u8; 16])>;

/// The strict response's authoritative `recovery_devices`: `None` when absent, an
/// error when malformed or over the bound.
fn parse_recovery_devices(v: &Value) -> Result<Option<RecoveryDevices>, CloudError> {
    let bad = || CloudError::Server(200, "malformed".into());
    let Some(list) = v.get("recovery_devices") else {
        return Ok(None);
    };
    let list = list.as_array().ok_or_else(bad)?;
    if list.len() > MAX_RECOVERY_DEVICES {
        return Err(bad());
    }
    let mut out = Vec::with_capacity(list.len());
    for r in list {
        let c = r
            .get("collection_id")
            .and_then(Value::as_str)
            .filter(|c| crate::attest::uuid_bytes(c).is_some());
        let d = r
            .get("device_id")
            .and_then(Value::as_str)
            .and_then(crate::attest::uuid_bytes);
        match (c, d) {
            (Some(c), Some(d)) => out.push((c.to_ascii_lowercase(), d)),
            _ => return Err(bad()),
        }
    }
    Ok(Some(out))
}

fn parse_strict_completion(v: &Value) -> Result<(Option<bool>, Vec<Value>), CloudError> {
    let bad = || CloudError::Server(200, "malformed".into());
    let Some(complete) = v.get("complete") else {
        return Ok((None, Vec::new()));
    };
    let complete = complete.as_bool().ok_or_else(bad)?;
    let pending = v.get("pending").and_then(Value::as_array).ok_or_else(bad)?;
    if pending.len() > 1024 || complete != pending.is_empty() {
        return Err(bad());
    }
    let mut seen = std::collections::BTreeSet::new();
    for p in pending {
        let uuid = |name| {
            p.get(name)
                .and_then(Value::as_str)
                .and_then(crate::attest::uuid_bytes)
                .filter(|u| *u != [0; 16])
        };
        let pair = (
            uuid("collection_id").ok_or_else(bad)?,
            uuid("device_id").ok_or_else(bad)?,
        );
        if !seen.insert(pair)
            || !matches!(p.get("revoked_at"), Some(Value::Null))
                && p.get("revoked_at")
                    .and_then(Value::as_u64)
                    .filter(|s| *s > 0)
                    .is_none()
        {
            return Err(bad());
        }
    }
    Ok((Some(complete), pending.clone()))
}

/// AK1: this account's account-key record at the control plane.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AccountKeyRecord {
    /// `none`, `password` or `strict`.
    pub mode: String,
    /// Compare-and-set version (0 when none).
    pub version: u64,
    /// The sealed bundle and its key id, in password mode (fetch only).
    pub bundle: Option<(Vec<u8>, [u8; 32])>,
    /// The key id, in password mode (fetch and status).
    pub key_id: Option<[u8; 32]>,
    /// CP aggregation of replica-applied witnesses; None on older servers.
    pub complete: Option<bool>,
    /// The CP's full missing-target list (never silently truncated).
    pub pending: Vec<Value>,
}

impl AccountKeyRecord {
    /// The status route's metadata: no bundle, the key id in password mode.
    fn parse_status(v: &Value) -> Result<AccountKeyRecord, CloudError> {
        let bad = || CloudError::Server(200, "malformed".into());
        let mode = v.get("mode").and_then(Value::as_str).ok_or_else(bad)?;
        if !matches!(mode, "none" | "password" | "strict") {
            return Err(bad());
        }
        let version = v.get("version").and_then(Value::as_u64).ok_or_else(bad)?;
        let key_id = if mode == "password" {
            Some(
                v.get("key_id")
                    .and_then(Value::as_str)
                    .and_then(|h| secrets::hex_decode(h).ok())
                    .and_then(|k| <[u8; 32]>::try_from(k.as_slice()).ok())
                    .ok_or_else(bad)?,
            )
        } else {
            None
        };
        let (complete, pending) = if mode == "strict" {
            parse_strict_completion(v)?
        } else {
            (None, Vec::new())
        };
        Ok(AccountKeyRecord {
            mode: mode.to_string(),
            version,
            bundle: None,
            key_id,
            complete,
            pending,
        })
    }

    fn parse(v: &Value) -> Result<AccountKeyRecord, CloudError> {
        let bad = || CloudError::Server(200, "malformed".into());
        let mode = v.get("mode").and_then(Value::as_str).ok_or_else(bad)?;
        if !matches!(mode, "none" | "password" | "strict") {
            return Err(bad());
        }
        let version = v.get("version").and_then(Value::as_u64).ok_or_else(bad)?;
        let bundle = if mode == "password" {
            let b = v
                .get("bundle")
                .and_then(Value::as_str)
                .filter(|h| h.len() <= 1024)
                .and_then(|h| secrets::hex_decode(h).ok())
                .ok_or_else(bad)?;
            let k = v
                .get("key_id")
                .and_then(Value::as_str)
                .and_then(|h| secrets::hex_decode(h).ok())
                .and_then(|k| <[u8; 32]>::try_from(k.as_slice()).ok())
                .ok_or_else(bad)?;
            Some((b.to_vec(), k))
        } else {
            None
        };
        Ok(AccountKeyRecord {
            mode: mode.to_string(),
            version,
            key_id: bundle.as_ref().map(|(_, k)| *k),
            bundle,
            complete: None,
            pending: Vec::new(),
        })
    }
}

/// A created next collection (cloud copy or private): where its log is and the
/// genesis the control plane appended, plus this device's role-0 log token.
/// The genesis bytes are checked against the trusted pins before any use.
pub struct Created {
    /// Collection.
    pub collection_id: String,
    /// `cloud-copy` or `private`.
    pub state: String,
    /// The log origin the control plane named (must equal the trusted origin).
    pub log_url: String,
    /// The appended genesis item (position 1).
    pub genesis_item: Vec<u8>,
    /// This device's log token.
    pub token: Zeroizing<String>,
    /// Its expiry (ms).
    pub expires_at: i64,
}

impl std::fmt::Debug for Created {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Created")
            .field("state", &self.state)
            .finish_non_exhaustive()
    }
}

impl Created {
    fn parse(v: &Value, state: &str) -> Result<Created, CloudError> {
        let bad = || CloudError::Server(200, "malformed".into());
        let s = |k: &str| v.get(k).and_then(Value::as_str).ok_or_else(bad);
        if s("state")? != state {
            return Err(bad());
        }
        let genesis = v.get("genesis").ok_or_else(bad)?;
        if genesis.get("seq").and_then(Value::as_u64) != Some(1) {
            return Err(bad());
        }
        let item = genesis
            .get("item")
            .and_then(Value::as_str)
            .filter(|h| h.len() <= 128 * 1024)
            .and_then(|h| secrets::hex_decode(h).ok())
            .filter(|b| !b.is_empty() && b.len() <= 64 * 1024)
            .ok_or_else(bad)?;
        let joined = Joined::parse(v)?;
        Ok(Created {
            collection_id: s("collection_id")?.to_string(),
            state: state.to_string(),
            log_url: s("log_url")?.to_string(),
            genesis_item: item.to_vec(),
            token: joined.token,
            expires_at: joined.expires_at,
        })
    }
}

/// An enrolment's answer: this device's role-0 log token, and (Connect with
/// mdbase-connect#630) the collection's log URL and candidate genesis bytes.
pub struct Joined {
    /// Token.
    pub token: Zeroizing<String>,
    /// Expiry (ms).
    pub expires_at: i64,
    /// The log origin the control plane named.
    pub log_url: Option<String>,
    /// Candidate genesis bytes (seq 1), verified by the caller before use.
    pub genesis_item: Option<Vec<u8>>,
}

impl std::fmt::Debug for Joined {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Joined").finish_non_exhaustive()
    }
}

impl Joined {
    /// Parse a JOIN / PRIVATE ENROL answer (Connect `cloud-copy-bootstrap`,
    /// `private-bootstrap`): `device.token`/`expires_at`, optional `log_url` and
    /// `genesis {seq: 1, item: hex}`; the caller verifies the genesis bytes.
    pub(crate) fn parse(v: &Value) -> Result<Joined, CloudError> {
        let bad = || CloudError::Server(200, "malformed".into());
        let genesis_item = match v.get("genesis") {
            None => None,
            Some(g) => {
                if g.get("seq").and_then(Value::as_u64) != Some(1) {
                    return Err(bad());
                }
                Some(
                    g.get("item")
                        .and_then(Value::as_str)
                        .filter(|h| h.len() <= 128 * 1024)
                        .and_then(|h| secrets::hex_decode(h).ok())
                        .filter(|b| !b.is_empty() && b.len() <= 64 * 1024)
                        .ok_or_else(bad)?
                        .to_vec(),
                )
            }
        };
        let log_url = v.get("log_url").and_then(Value::as_str).map(str::to_string);
        let d = v.get("device").ok_or_else(bad)?;
        let token = d
            .get("token")
            .and_then(Value::as_str)
            .filter(|t| !t.is_empty() && t.len() <= 16 * 1024)
            .ok_or_else(bad)?;
        let expires_at = d
            .get("expires_at")
            .and_then(Value::as_i64)
            .ok_or_else(bad)?;
        Ok(Joined {
            token: Zeroizing::new(token.to_string()),
            expires_at,
            log_url,
            genesis_item,
        })
    }
}

/// The relay device-bind signature:
/// `Ed25519(H("mdbase/v1/relay-device", connector_id ‖ utf8(session_id) ‖ nonce))`.
pub fn device_bind_sig(
    identity: &DeviceIdentity,
    connector_id: &[u8; 16],
    session_id: &str,
    nonce: &[u8; 32],
) -> [u8; 64] {
    let d = mdbn_replica::crypto::proof::relay_device_digest(
        &mdbn_wire::common::B16(*connector_id),
        session_id,
        nonce,
    );
    identity.sign_digest(&d.0)
}

#[path = "cloud_migration_record.rs"]
pub mod migration_record;

#[cfg(test)]
#[path = "cloud_rollout_tests.rs"]
mod rollout_tests;

#[cfg(test)]
#[path = "cloud_retirement_tests.rs"]
mod retirement_tests;

#[cfg(test)]
mod tests {

    #[test]
    fn bootstrap_debug_never_exposes_tokens_or_genesis() {
        let joined = Joined {
            token: Zeroizing::new("synthetic-token-sentinel".into()),
            expires_at: 0,
            log_url: Some("synthetic-origin-sentinel".into()),
            genesis_item: Some(b"synthetic-genesis-sentinel".to_vec()),
        };
        let created = Created {
            collection_id: "synthetic-id-sentinel".into(),
            state: "cloud-copy".into(),
            log_url: "synthetic-origin-sentinel".into(),
            genesis_item: b"synthetic-genesis-sentinel".to_vec(),
            token: Zeroizing::new("synthetic-token-sentinel".into()),
            expires_at: 0,
        };
        let text = format!("{joined:?} {created:?}");
        for secret in [
            "synthetic-token-sentinel",
            "synthetic-genesis-sentinel",
            "synthetic-origin-sentinel",
            "synthetic-id-sentinel",
        ] {
            assert!(!text.contains(secret));
        }
    }

    #[tokio::test]
    async fn bootstrap_stale_source_denies_before_challenge_io() {
        let cloud = Cloud {
            http: reqwest::Client::new(),
            server: "http://127.0.0.1:1".into(),
            token: Zeroizing::new("synthetic-token".into()),
        };
        let id = DeviceIdentity::generate().unwrap();
        let error = cloud
            .create_cloud_copy(
                "11111111-1111-4111-8111-111111111111",
                &[1; 16],
                &id,
                &|| Err("account_changed".into()),
            )
            .await
            .unwrap_err();
        assert!(matches!(error, CloudError::Local(ref reason) if reason == "account_changed"));
    }

    #[tokio::test]
    async fn bootstrap_account_change_after_challenge_denies_proof_post() {
        use std::sync::atomic::{AtomicBool, Ordering};
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let active = Arc::new(AtomicBool::new(true));
        let changed = active.clone();
        let mock = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut buffer = [0; 4096];
            let _ = socket.read(&mut buffer).await.unwrap();
            let body = serde_json::to_string(&json!({"challenge": secrets::hex(&[1;32])})).unwrap();
            changed.store(false, Ordering::SeqCst);
            socket
                .write_all(
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        body.len(),
                        body
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();
            assert!(
                tokio::time::timeout(std::time::Duration::from_millis(100), listener.accept())
                    .await
                    .is_err()
            );
        });
        let cloud = Cloud {
            http: reqwest::Client::new(),
            server: format!("http://{address}"),
            token: Zeroizing::new("synthetic-token".into()),
        };
        let id = DeviceIdentity::generate().unwrap();
        let current = || {
            if active.load(Ordering::SeqCst) {
                Ok(())
            } else {
                Err("account_changed".into())
            }
        };
        let error = cloud
            .create_cloud_copy(
                "11111111-1111-4111-8111-111111111111",
                &[1; 16],
                &id,
                &current,
            )
            .await
            .unwrap_err();
        assert!(matches!(error, CloudError::Local(ref reason) if reason == "account_changed"));
        mock.await.unwrap();
    }

    #[tokio::test]
    async fn bootstrap_changed_account_cannot_accept_a_sent_result() {
        use std::sync::atomic::{AtomicBool, Ordering};
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let active = Arc::new(AtomicBool::new(true));
        let changed = active.clone();
        let mock = tokio::spawn(async move {
            for attempt in 0..2 {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut buffer = [0; 4096];
                let _ = socket.read(&mut buffer).await.unwrap();
                let body = if attempt == 0 {
                    serde_json::to_string(&json!({"challenge": secrets::hex(&[1;32])})).unwrap()
                } else {
                    changed.store(false, Ordering::SeqCst);
                    "{}".into()
                };
                socket
                    .write_all(
                        format!(
                            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                            body.len(),
                            body
                        )
                        .as_bytes(),
                    )
                    .await
                    .unwrap();
            }
        });
        let cloud = Cloud {
            http: reqwest::Client::new(),
            server: format!("http://{address}"),
            token: Zeroizing::new("synthetic-token".into()),
        };
        let id = DeviceIdentity::generate().unwrap();
        let current = || {
            if active.load(Ordering::SeqCst) {
                Ok(())
            } else {
                Err("account_changed".into())
            }
        };
        let error = cloud
            .create_cloud_copy(
                "11111111-1111-4111-8111-111111111111",
                &[1; 16],
                &id,
                &current,
            )
            .await
            .unwrap_err();
        assert!(matches!(error, CloudError::Local(ref reason) if reason == "account_changed"));
        // Both requests reached the mock: denial is NOT not-sent evidence.
        mock.await.unwrap();
    }

    /// A loopback control plane: serves one challenge, then captures the proven
    /// request's request line and JSON body (answering 409).
    async fn capture_proven(
        call: impl for<'a> FnOnce(
            &'a Cloud,
            &'a DeviceIdentity,
        ) -> std::pin::Pin<
            Box<dyn std::future::Future<Output = Result<(), CloudError>> + 'a>,
        >,
        id: &DeviceIdentity,
    ) -> (String, Value) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let mock = tokio::spawn(async move {
            let mut captured = None;
            for reply in [
                json!({"challenge": secrets::hex(&[7; 32])}),
                json!({"error": {"code": "conflict"}}),
            ] {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = Vec::new();
                let mut buffer = [0; 8192];
                loop {
                    let n = socket.read(&mut buffer).await.unwrap();
                    request.extend_from_slice(&buffer[..n]);
                    let text = String::from_utf8_lossy(&request).to_string();
                    if let Some(end) = text.find("\r\n\r\n") {
                        let length = text[..end]
                            .lines()
                            .find_map(|l| {
                                l.to_ascii_lowercase()
                                    .strip_prefix("content-length: ")
                                    .map(|v| v.trim().parse::<usize>().unwrap())
                            })
                            .unwrap_or(0);
                        if request.len() >= end + 4 + length {
                            let line = text.lines().next().unwrap().to_string();
                            let body = text[end + 4..end + 4 + length].to_string();
                            captured = Some((line, body));
                            break;
                        }
                    }
                }
                let body = reply.to_string();
                let status = if reply.get("error").is_some() {
                    "409 Conflict"
                } else {
                    "200 OK"
                };
                socket
                    .write_all(
                        format!(
                            "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                            body.len(),
                            body
                        )
                        .as_bytes(),
                    )
                    .await
                    .unwrap();
            }
            captured.unwrap()
        });
        let cloud = Cloud {
            http: reqwest::Client::new(),
            server: format!("http://{address}"),
            token: Zeroizing::new("synthetic-token".into()),
        };
        let result = call(&cloud, id).await;
        assert!(
            matches!(result, Err(CloudError::Server(409, _))),
            "{result:?}"
        );
        let (line, body) = mock.await.unwrap();
        (line, serde_json::from_str(&body).unwrap())
    }

    /// Every bootstrap call signs the shared proof digest of its own kind over the
    /// served challenge, this connector, device and collection (and the SAS
    /// commitment where the kind carries one), and sends exactly that.
    #[tokio::test]
    async fn bootstrap_calls_sign_the_shared_proof_digests() {
        use ed25519_dalek::Verifier;
        use proof::CollectionProof as K;
        const CONNECTOR: &str = "11111111-1111-4111-8111-111111111111";
        let collection = [9u8; 16];
        let sas = [5u8; 32];
        let id = DeviceIdentity::generate().unwrap();
        let ok = || Ok(());
        let collection_id = B16(collection).to_uuid_string();
        let cases: Vec<(K, String, Option<[u8; 32]>)> = vec![
            (
                K::CloudCopyCreate,
                "POST /v1/next/collections/cloud-copy ".into(),
                None,
            ),
            (
                K::PrivateCreate,
                "POST /v1/next/collections/private ".into(),
                None,
            ),
            (
                K::CloudCopyJoin,
                format!("POST /v1/next/collections/{collection_id}/devices "),
                None,
            ),
            (
                K::PrivateDeviceEnrol,
                format!("POST /v1/next/collections/{collection_id}/private/devices "),
                Some(sas),
            ),
            (
                K::PrivateApprovalRequest,
                format!(
                    "POST /v1/next/collections/{collection_id}/private/devices/approval-request "
                ),
                Some(sas),
            ),
        ];
        for (kind, path, commit) in cases {
            let (line, body) = capture_proven(
                |cloud, id| {
                    Box::pin(async move {
                        let c = &collection;
                        match kind {
                            K::CloudCopyCreate => cloud
                                .create_cloud_copy(CONNECTOR, c, id, &ok)
                                .await
                                .map(drop),
                            K::PrivateCreate => {
                                cloud.create_private(CONNECTOR, c, id, &ok).await.map(drop)
                            }
                            K::CloudCopyJoin => {
                                cloud.join_cloud_copy(CONNECTOR, c, id, &ok).await.map(drop)
                            }
                            K::PrivateDeviceEnrol => cloud
                                .enrol_private(CONNECTOR, c, &sas, id, &ok)
                                .await
                                .map(drop),
                            K::PrivateApprovalRequest => cloud
                                .request_private_approval(CONNECTOR, c, &sas, id, &ok)
                                .await
                                .map(drop),
                        }
                    })
                },
                &id,
            )
            .await;
            assert!(line.starts_with(&path), "{kind:?}: {line}");
            assert_eq!(body["challenge"], secrets::hex(&[7; 32]));
            assert_eq!(body["device_id"], id.public().device);
            assert_eq!(
                body.get("sas_commit").and_then(Value::as_str),
                commit.map(|c| secrets::hex(&c)).as_deref()
            );
            let digest = proof::collection_proof_digest(
                kind,
                &[7; 32],
                &B16(crate::attest::uuid_bytes(CONNECTOR).unwrap()),
                &B16(id.device_id),
                &B16(collection),
                commit.as_ref(),
            )
            .unwrap();
            let sig: [u8; 64] = secrets::hex_decode(body["sig"].as_str().unwrap())
                .unwrap()
                .try_into()
                .unwrap();
            let sign_pk: [u8; 32] = secrets::hex_decode(&id.public().sign_pk)
                .unwrap()
                .try_into()
                .unwrap();
            let pk = ed25519_dalek::VerifyingKey::from_bytes(&sign_pk).unwrap();
            assert!(
                pk.verify(&digest.0, &ed25519_dalek::Signature::from_bytes(&sig))
                    .is_ok(),
                "{kind:?}"
            );
        }
        // The role-0 log token renewal signs the shared log-token digest.
        let (line, body) = capture_proven(
            |cloud, id| {
                Box::pin(async move {
                    cloud
                        .collection_log_token(CONNECTOR, &collection, id, &ok)
                        .await
                        .map(drop)
                })
            },
            &id,
        )
        .await;
        assert!(line.starts_with(&format!(
            "POST /v1/next/collections/{collection_id}/log-token "
        )));
        let digest = proof::collection_log_token_digest(
            &[7; 32],
            &B16(crate::attest::uuid_bytes(CONNECTOR).unwrap()),
            &B16(id.device_id),
            &B16(collection),
        );
        let sig: [u8; 64] = secrets::hex_decode(body["sig"].as_str().unwrap())
            .unwrap()
            .try_into()
            .unwrap();
        assert_eq!(sig, id.sign_digest(&digest.0), "deterministic Ed25519");
    }

    /// AK1 requests sign the shared account-proof digests over the served
    /// challenge (strict with its expected version; the recovery-device enrolment
    /// with the caller proof and the recovery key's possession proof).
    #[tokio::test]
    async fn account_key_calls_sign_the_shared_proof_digests() {
        use mdbn_wire::cbor::Cbor;
        const CONNECTOR: &str = "11111111-1111-4111-8111-111111111111";
        let account = [3u8; 16];
        let collection = [4u8; 16];
        let id = DeviceIdentity::generate().unwrap();
        let ok = || Ok(());
        let connector = B16(crate::attest::uuid_bytes(CONNECTOR).unwrap());
        let sig_of = |body: &Value, key: &str| -> [u8; 64] {
            secrets::hex_decode(body[key].as_str().unwrap())
                .unwrap()
                .try_into()
                .unwrap()
        };
        let (line, body) = capture_proven(
            |cloud, id| {
                Box::pin(async move {
                    cloud
                        .account_key_strict(CONNECTOR, &account, 5, id, &ok)
                        .await
                        .map(drop)
                })
            },
            &id,
        )
        .await;
        assert!(line.starts_with("POST /v1/next/account-key/strict "));
        assert_eq!(body["expected_version"], 5);
        let digest = proof::account_proof_digest(
            proof::AccountProof::Strict,
            &[7; 32],
            &connector,
            &B16(id.device_id),
            &B16(account),
            vec![Cbor::Uint(5)],
        );
        assert_eq!(sig_of(&body, "sig"), id.sign_digest(&digest.0));

        let recovery = Arc::new(
            mdbn_replica::crypto::recovery::RecoveryKey::generate(&mut mdbn_local_host::OsEntropy)
                .derive(&B16(collection)),
        );
        let held = recovery.clone();
        let (line, body) = capture_proven(
            move |cloud, id| {
                Box::pin(async move {
                    cloud
                        .account_key_device_enrol(CONNECTOR, &account, &collection, &held, id, &ok)
                        .await
                        .map(drop)
                })
            },
            &id,
        )
        .await;
        assert!(line.contains("/private/account-key-device "), "{line}");
        let (caller, possession) = proof::account_key_device_digests(
            &[7; 32],
            &connector,
            &B16(id.device_id),
            &B16(collection),
            &B16(account),
            &recovery.device,
            &recovery.signer.public(),
            &recovery.kem.pk,
        );
        assert_eq!(sig_of(&body, "sig"), id.sign_digest(&caller.0));
        assert_eq!(
            sig_of(&body, "pop"),
            recovery.signer.sign_digest(&possession.0)
        );
    }

    use super::*;

    #[test]
    fn pairing_identity_is_explicit_and_never_inferred_from_connector_or_token() {
        let mut response = json!({"connector":{"id":"22222222-2222-4222-8222-222222222222"},"token":"con_test_pairing_fixture_12345"});
        for value in [
            Value::Null,
            json!(""),
            json!("SERVICE_ACCOUNT"),
            json!("00000000-0000-0000-0000-000000000000"),
            json!("AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA"),
        ] {
            response["account_id"] = value;
            assert!(paired_response(200, &response).is_err());
        }
        response.as_object_mut().unwrap().remove("account_id");
        assert!(paired_response(200, &response).is_err());
        response["account_id"] = json!("11111111-1111-4111-8111-111111111111");
        let paired = paired_response(200, &response).unwrap();
        assert_ne!(paired.account_id, paired.connector_id);
        assert_eq!(paired.account_id, "11111111-1111-4111-8111-111111111111");
    }

    #[test]
    fn legacy_account_fence_is_readable_for_normal_repair_but_never_authority() {
        let dir = crate::testutil::TestDir::new("old-account");
        let path = dir.path().join("account.json");
        crate::fsutil::write_atomic(
            &path,
            br#"{"schema_version":1,"epoch":7,"signed_in":true,"connector_id":"connector"}"#,
        )
        .unwrap();
        let record = AccountRecord::load(&path).unwrap();
        let config = CloudConfig {
            account_epoch: 7,
            connector_id: Some("connector".into()),
            ..Default::default()
        };
        assert_eq!(record.active_account(), None);
        assert!(!record.permits(&config));
    }

    #[test]
    fn server_urls_are_canonical() {
        assert_eq!(
            canonical_server_url("https://Connect.mdbase.dev/x?y#z").unwrap(),
            "https://connect.mdbase.dev"
        );
        assert_eq!(
            canonical_server_url("http://127.0.0.1:8080").unwrap(),
            "http://127.0.0.1:8080"
        );
        assert!(canonical_server_url("http://connect.mdbase.dev").is_err());
        assert!(canonical_server_url("https://user@connect.mdbase.dev").is_err());
        assert!(canonical_server_url("connect.mdbase.dev").is_err());
    }

    #[test]
    fn domain_hash_prefixes_the_tag_length() {
        use sha2::{Digest, Sha256};
        let mut d = Sha256::new();
        d.update([22u8]);
        d.update(b"mdbase/v1/relay-device");
        d.update(b"x");
        let want: [u8; 32] = d.finalize().into();
        assert_eq!(
            secrets::domain_hash("mdbase/v1/relay-device", &[b"x"]),
            want
        );
    }
}

#[cfg(test)]
mod account_key_tests {
    use super::*;

    /// Strict completion is computed over `recovery_devices` only: absent is
    /// unknown (None), malformed or oversized is an error, never a truncation.
    #[test]
    fn strict_completion_requires_explicit_cp_witness_aggregation() {
        assert_eq!(parse_strict_completion(&json!({})).unwrap(), (None, vec![]));
        assert_eq!(
            parse_strict_completion(&json!({"complete": true, "pending": []})).unwrap(),
            (Some(true), vec![])
        );
        let target = json!({"collection_id":"11111111-1111-1111-1111-111111111111",
            "device_id":"22222222-2222-2222-2222-222222222222", "revoked_at":3});
        assert_eq!(
            parse_strict_completion(&json!({"complete":false,"pending":[target.clone()]}))
                .unwrap()
                .0,
            Some(false)
        );
        for bad in [
            json!({"complete":true}),
            json!({"complete":"true","pending":[]}),
            json!({"complete":true,"pending":[target.clone()]}),
            json!({"complete":false,"pending":[]}),
            json!({"complete":false,"pending":[target.clone(),target.clone()]}),
            json!({"complete":false,"pending":[{"collection_id":"wrong","device_id":"wrong","revoked_at":3}]}),
            json!({"complete":false,"pending":vec![target; 1025]}),
        ] {
            assert!(parse_strict_completion(&bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn strict_witness_and_report_digests_match_connect() {
        use mdbn_replica::replica::StrictWitness;
        use mdbn_wire::cbor::Cbor;
        use mdbn_wire::common::B64;
        let w = StrictWitness {
            account: B16([1; 16]),
            collection: B16([2; 16]),
            recovery_device: B16([3; 16]),
            version: 7,
            revoked_at: 11,
            applied_at: 12,
            epoch: 3,
            reporter: B16([4; 16]),
            signature: B64([0; 64]),
        };
        assert_eq!(
            secrets::hex(&w.digest().0),
            "ae322af8d0e5001a0bc752bedcfd9d721dd3355b379a6fb8b06da4b777713953"
        );
        let Cbor::Array(mut fields) = w.fields() else {
            unreachable!()
        };
        fields.push(Cbor::Bytes(w.signature.0.to_vec()));
        for (value, expected) in [
            (
                Cbor::Array(vec![]),
                "ca6ac42770c1a008b97e9e5279f0d969668d5e74abdb0e7f11944f8e847afa0b",
            ),
            (
                Cbor::Array(fields),
                "48169641c7f004ee96994c9e1d446cb27dcb5c118bfb980bff789750e8b356d4",
            ),
        ] {
            let d = proof::account_proof_digest(
                proof::AccountProof::StrictReport,
                &[5; 32],
                &B16([6; 16]),
                &B16([4; 16]),
                &B16([2; 16]),
                vec![value],
            );
            assert_eq!(secrets::hex(&d.0), expected);
        }
    }

    #[test]
    fn strict_recovery_set_is_authoritative_or_absent() {
        let c = "44444444-4444-4444-8444-444444444444";
        let d = "55555555-5555-4555-8555-555555555555";
        // The incremental `revocations` alone is not the set.
        let only_revocations = json!({ "version": 2, "revocations": [] });
        assert_eq!(parse_recovery_devices(&only_revocations).unwrap(), None);
        let ok =
            json!({ "recovery_devices": [{ "collection_id": c.to_uppercase(), "device_id": d }] });
        let set = parse_recovery_devices(&ok).unwrap().unwrap();
        assert_eq!(
            set,
            vec![(c.to_string(), crate::attest::uuid_bytes(d).unwrap())]
        );
        for bad in [
            json!({ "recovery_devices": {} }),
            json!({ "recovery_devices": [{ "collection_id": c }] }),
            json!({ "recovery_devices": [{ "collection_id": "x", "device_id": d }] }),
        ] {
            assert!(parse_recovery_devices(&bad).is_err(), "{bad}");
        }
        let many: Vec<Value> = (0..=MAX_RECOVERY_DEVICES)
            .map(|_| json!({ "collection_id": c, "device_id": d }))
            .collect();
        assert!(parse_recovery_devices(&json!({ "recovery_devices": many })).is_err());
    }
}
