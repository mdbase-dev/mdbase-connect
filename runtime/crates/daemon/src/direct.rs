//! Direct object transfers: the pre-signed PUT and GET of `log-service-api.md` §6.
//!
//! Sealed objects over the 1 MiB inline limit (at most 9 MiB) never travel inside a
//! log-service frame. `put_object` answers `upload` with a [`DirectTransfer`]: the
//! writer PUTs the exact sealed bytes there, then calls `commit_object`, and only
//! the commit makes the object visible. `get_object` answers a large object with a
//! direct GET for the whole encoded object, which this module streams into one
//! bounded buffer, resuming an interrupted body with one closed `Range`.
//!
//! This module only moves bytes. The log transport owns the `commit_object` call
//! and maps each outcome to the replica's reply; the replica owns retries of
//! `put_object` / `get_object` (a new call mints a fresh URL).
//!
//! **Secrets.** A direct URL is a bearer capability. It is never logged, never put
//! in an error, and no type here implements `Debug` over it. `reqwest` errors carry
//! the URL, so they are classified and dropped, never displayed.
//!
//! **Integrity.** Uploads send exactly `size` bytes, with the integrity header the
//! service named, which must equal the base64 SHA-256 of the body. Downloads require
//! exact `Content-Length`, an exact `Content-Range` on a resumed span, a matching
//! `x-amz-checksum-sha256` when present, and the whole reconstructed object's
//! SHA-256 before anything is returned. Redirects are never followed.

use std::sync::Arc;
use std::time::Duration;

use base64::Engine as _;
use mdbn_wire::common::B32;
use mdbn_wire::log_service::DirectTransfer;
use sha2::Digest as _;

/// Largest sealed object (log-service-api §6, I13).
pub const MAX_DIRECT_OBJECT: u64 = mdbn_replica::log_codec::MAX_SEALED_OBJECT as u64;
/// The integrity header R2/S3 verify on PUT and return on GET.
pub const CHECKSUM_HEADER: &str = "x-amz-checksum-sha256";
/// PUT attempts against one URL before the outcome is reported unknown.
const PUT_ATTEMPTS: u32 = 3;
/// Consecutive failed GET requests for one object.
const GET_ATTEMPTS: u32 = 5;
/// GET requests (first plus resumes) for one object, however much each delivers.
const GET_REQUESTS: u32 = 32;
/// A URL this close to expiry is not started.
const EXPIRY_MARGIN_MS: i64 = 5_000;
/// Fixed part of a request's timeout; the rest scales with the body.
const BASE_TIMEOUT: Duration = Duration::from_secs(30);
/// Slowest link a transfer is given time for, bytes per second.
const MIN_RATE: u64 = 128 * 1024;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);

/// An HTTP client for direct transfers: the daemon's TLS roots, no redirects
/// (a signed URL must not be forwarded), no overall timeout (set per request).
pub fn client(tls: Option<Arc<rustls::ClientConfig>>) -> Result<reqwest::Client, String> {
    let mut b = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(CONNECT_TIMEOUT)
        .user_agent(concat!("mdbase-daemon/", env!("CARGO_PKG_VERSION")));
    if let Some(tls) = tls {
        b = b.use_preconfigured_tls((*tls).clone());
    }
    b.build().map_err(|_| "direct transfer client".to_string())
}

/// Where direct transfers may go: the log service's own origin (origin pinning).
/// A log service is untrusted under E2E; without this pin it
/// could point the daemon at any host, including loopback and LAN services
/// (blind SSRF). The deployed log services serve `/v1/o/…` on their own origin.
#[derive(Clone, PartialEq, Eq)]
pub struct DirectPin {
    scheme: &'static str,
    host: String,
    port: u16,
    local: bool,
}

fn ip_of(host: &str) -> Option<std::net::IpAddr> {
    host.trim_start_matches('[')
        .trim_end_matches(']')
        .parse::<std::net::IpAddr>()
        .ok()
}

fn is_loopback_host(host: &str) -> bool {
    host == "localhost" || ip_of(host).is_some_and(|ip| ip.is_loopback())
}

/// Loopback, private (RFC 1918, ULA), link-local, CGNAT, unspecified,
/// multicast, broadcast or documentation: never a public object store.
fn is_non_global_ip(ip: std::net::IpAddr) -> bool {
    use std::net::IpAddr;
    match ip {
        IpAddr::V4(v4) => {
            let o = v4.octets();
            v4.is_loopback()
                || v4.is_private()
                || v4.is_link_local()
                || v4.is_unspecified()
                || v4.is_multicast()
                || v4.is_broadcast()
                || v4.is_documentation()
                || (o[0] == 100 && (o[1] & 0xc0) == 64)
                || o[0] == 0
        }
        IpAddr::V6(v6) => {
            let s = v6.segments();
            v6.is_loopback()
                || v6.is_unspecified()
                || v6.is_multicast()
                || (s[0] & 0xfe00) == 0xfc00
                || (s[0] & 0xffc0) == 0xfe80
                || v6
                    .to_ipv4_mapped()
                    .is_some_and(|v4| is_non_global_ip(IpAddr::V4(v4)))
        }
    }
}

impl DirectPin {
    /// The pin for the log at `log_url` (`wss://` → `https://`, `ws://` → `http://`,
    /// same host and port).
    pub fn from_log_url(log_url: &str) -> Result<DirectPin, &'static str> {
        let u = reqwest::Url::parse(log_url).map_err(|_| "log url: unparsable")?;
        let scheme = match u.scheme() {
            "wss" | "https" => "https",
            "ws" | "http" => "http",
            _ => return Err("log url: scheme"),
        };
        let host = u.host_str().ok_or("log url: no host")?.to_ascii_lowercase();
        let port = u.port_or_known_default().ok_or("log url: no port")?;
        let local = is_loopback_host(&host);
        if scheme == "http" && !local {
            return Err("log url: http only to loopback");
        }
        Ok(DirectPin {
            scheme,
            host,
            port,
            local,
        })
    }
}

/// Check a direct URL against the pin. Never echoes the URL.
/// - No credentials in the authority.
/// - A public log: exactly its origin (scheme, host, port), `https`, and never an
///   IP literal outside the global ranges.
/// - A loopback log (tests, a local log server): loopback only, any port.
pub fn check_url(url: &str, pin: &DirectPin) -> Result<reqwest::Url, &'static str> {
    let u = reqwest::Url::parse(url).map_err(|_| "direct url: unparsable")?;
    if !u.username().is_empty() || u.password().is_some() {
        return Err("direct url: credentials in authority");
    }
    let host = u
        .host_str()
        .ok_or("direct url: no host")?
        .to_ascii_lowercase();
    if pin.local {
        return match u.scheme() {
            "https" | "http" if is_loopback_host(&host) => Ok(u),
            _ => Err("direct url: not the local log origin"),
        };
    }
    if u.scheme() != "https" {
        return Err("direct url: https is required");
    }
    if ip_of(&host).is_some_and(is_non_global_ip) || host == "localhost" {
        return Err("direct url: not a public address");
    }
    if u.scheme() != pin.scheme || host != pin.host || u.port_or_known_default() != Some(pin.port) {
        return Err("direct url: not the log service origin");
    }
    Ok(u)
}

/// Headers a service may not dictate: the transport sets framing itself.
fn forbidden_header(name: &str) -> bool {
    matches!(
        name,
        "host"
            | "content-length"
            | "transfer-encoding"
            | "connection"
            | "keep-alive"
            | "upgrade"
            | "te"
            | "trailer"
            | "expect"
            | "range"
            | "cookie"
            | "authorization"
            | "proxy-authorization"
    ) || name.starts_with("proxy-")
}

fn header_map(
    dt: &DirectTransfer,
    checksum: Option<&B32>,
) -> Result<reqwest::header::HeaderMap, &'static str> {
    use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
    let mut out = HeaderMap::new();
    for (k, v) in dt.headers.0.iter() {
        let name = HeaderName::from_bytes(k.to_ascii_lowercase().as_bytes())
            .map_err(|_| "direct header: bad name")?;
        if forbidden_header(name.as_str()) {
            return Err("direct header: not allowed");
        }
        if name.as_str() == CHECKSUM_HEADER && checksum.is_none_or(|c| *v != b64(c)) {
            return Err("direct header: checksum differs from the object");
        }
        let value = HeaderValue::from_str(v).map_err(|_| "direct header: bad value")?;
        if out.insert(name, value).is_some() {
            return Err("direct header: repeated");
        }
    }
    Ok(out)
}

fn b64(c: &B32) -> String {
    base64::engine::general_purpose::STANDARD.encode(c.0)
}

fn sha256(b: &[u8]) -> B32 {
    B32(sha2::Sha256::digest(b).into())
}

/// Request timeout for `bytes`, capped by what is left of the URL's lifetime.
fn timeout_for(bytes: u64, dt: &DirectTransfer, now_ms: i64) -> Option<Duration> {
    let left = dt.expires_at.saturating_sub(now_ms);
    if left <= EXPIRY_MARGIN_MS {
        return None;
    }
    let want = BASE_TIMEOUT + Duration::from_secs(bytes / MIN_RATE);
    Some(want.min(Duration::from_millis(left as u64)))
}

/// What happened to a direct PUT.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UploadOutcome {
    /// The store accepted the bytes: `commit_object` next.
    Uploaded,
    /// The URL expired or was refused (401/403): ask `put_object` again.
    Expired,
    /// The request itself is wrong (bad URL or headers, 4xx): a writer bug.
    Refused,
    /// Every attempt failed in transit (network, timeout, 5xx). A PUT may still
    /// have landed: `commit_object` decides, and it is idempotent.
    Unknown,
}

/// PUT the exact sealed `body` to `dt`. Retries transient failures against the
/// same URL (a PUT to the staging key is idempotent) while it is valid. `body` is
/// shared, not copied, across attempts.
pub async fn upload(
    http: &reqwest::Client,
    dt: &DirectTransfer,
    pin: &DirectPin,
    body: bytes::Bytes,
    now_ms: impl Fn() -> i64,
) -> UploadOutcome {
    if body.len() as u64 > MAX_DIRECT_OBJECT {
        return UploadOutcome::Refused;
    }
    let Ok(url) = check_url(&dt.url, pin) else {
        return UploadOutcome::Refused;
    };
    let checksum = sha256(&body);
    let Ok(headers) = header_map(dt, Some(&checksum)) else {
        return UploadOutcome::Refused;
    };
    let mut tried = false;
    for attempt in 0..PUT_ATTEMPTS {
        if attempt > 0 {
            tokio::time::sleep(Duration::from_millis(500 * 4u64.pow(attempt - 1))).await;
        }
        let Some(timeout) = timeout_for(body.len() as u64, dt, now_ms()) else {
            break;
        };
        tried = true;
        let sent = http
            .put(url.clone())
            .headers(headers.clone())
            .header(reqwest::header::CONTENT_TYPE, "application/octet-stream")
            .timeout(timeout)
            .body(body.clone())
            .send()
            .await;
        let status = match sent {
            Ok(r) => r.status(),
            Err(e) => {
                tracing::debug!(
                    attempt,
                    timeout = e.is_timeout(),
                    connect = e.is_connect(),
                    "direct put failed in transit"
                );
                continue;
            }
        };
        match status.as_u16() {
            200..=299 => return UploadOutcome::Uploaded,
            401 | 403 => return UploadOutcome::Expired,
            408 | 425 | 429 | 500..=599 => {
                tracing::debug!(attempt, status = status.as_u16(), "direct put: retrying");
            }
            s => {
                tracing::warn!(status = s, "direct put refused");
                return UploadOutcome::Refused;
            }
        }
    }
    if tried {
        UploadOutcome::Unknown
    } else {
        UploadOutcome::Expired
    }
}

/// Why a direct GET produced no object.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DownloadError {
    /// The URL expired or was refused: ask `get_object` again.
    Expired,
    /// The store has no such object (an integrity incident upstream).
    NotFound,
    /// Lengths, ranges or checksums disagree: never emitted.
    Integrity,
    /// Bad URL/headers or another 4xx.
    Refused,
    /// Transit kept failing; ask again later.
    Unavailable,
}

/// GET the whole encoded object of `size` bytes and SHA-256 `checksum` from `dt`
/// into one buffer of exactly `size`. An interrupted body resumes with a single
/// closed `Range: bytes=got-(size-1)`; the reply must be 206 with exactly that
/// `Content-Range`. Nothing is returned unless the whole object verifies.
pub async fn download(
    http: &reqwest::Client,
    dt: &DirectTransfer,
    pin: &DirectPin,
    size: u64,
    checksum: &B32,
    now_ms: impl Fn() -> i64,
) -> Result<Vec<u8>, DownloadError> {
    if size == 0 || size > MAX_DIRECT_OBJECT {
        return Err(DownloadError::Integrity);
    }
    let url = check_url(&dt.url, pin).map_err(|_| DownloadError::Refused)?;
    let headers = header_map(dt, Some(checksum)).map_err(|_| DownloadError::Refused)?;
    let want_ck = b64(checksum);
    let mut buf: Vec<u8> = Vec::with_capacity(size as usize);
    let mut failures = 0u32;
    let mut requests = 0u32;
    loop {
        requests += 1;
        if failures >= GET_ATTEMPTS || requests > GET_REQUESTS {
            return Err(DownloadError::Unavailable);
        }
        if failures > 0 {
            tokio::time::sleep(Duration::from_millis(250 * 2u64.pow(failures - 1))).await;
        }
        let start = buf.len() as u64;
        let span = size - start;
        let Some(timeout) = timeout_for(span, dt, now_ms()) else {
            return Err(DownloadError::Expired);
        };
        let mut req = http
            .get(url.clone())
            .headers(headers.clone())
            .timeout(timeout);
        if start > 0 {
            req = req.header(
                reqwest::header::RANGE,
                format!("bytes={start}-{}", size - 1),
            );
        }
        let mut resp = match req.send().await {
            Ok(r) => r,
            Err(e) => {
                tracing::debug!(timeout = e.is_timeout(), "direct get failed in transit");
                failures += 1;
                continue;
            }
        };
        let status = resp.status().as_u16();
        match (status, start) {
            (200, 0) | (206, 1..) => {}
            (401 | 403, _) => return Err(DownloadError::Expired),
            (404, _) => return Err(DownloadError::NotFound),
            (408 | 425 | 429 | 500..=599, _) => {
                failures += 1;
                continue;
            }
            // A full body for a range, a range for a full request, 416, or
            // anything else: no silent fallback.
            (200 | 206 | 416, _) => return Err(DownloadError::Integrity),
            _ => return Err(DownloadError::Refused),
        }
        let h = resp.headers();
        let text = |name: &str| h.get(name).and_then(|v| v.to_str().ok()).map(str::to_owned);
        if text("content-length").and_then(|v| v.parse::<u64>().ok()) != Some(span) {
            return Err(DownloadError::Integrity);
        }
        if start > 0 && text("content-range") != Some(format!("bytes {start}-{}/{size}", size - 1))
        {
            return Err(DownloadError::Integrity);
        }
        if h.get_all(CHECKSUM_HEADER).iter().count() > 1
            || text(CHECKSUM_HEADER).is_some_and(|v| v != want_ck)
        {
            return Err(DownloadError::Integrity);
        }
        let mut progressed = false;
        loop {
            match resp.chunk().await {
                Ok(Some(chunk)) => {
                    if buf.len() as u64 + chunk.len() as u64 > size {
                        return Err(DownloadError::Integrity);
                    }
                    progressed |= !chunk.is_empty();
                    buf.extend_from_slice(&chunk);
                }
                Ok(None) => break,
                Err(e) => {
                    tracing::debug!(timeout = e.is_timeout(), "direct get body interrupted");
                    break;
                }
            }
        }
        if buf.len() as u64 == size {
            break;
        }
        // Short or interrupted body: resume from what arrived. Progress resets
        // the failure budget, a stalled source spends it.
        if progressed {
            failures = 0;
        } else {
            failures += 1;
        }
    }
    if sha256(&buf) != *checksum {
        return Err(DownloadError::Integrity);
    }
    Ok(buf)
}

#[cfg(test)]
#[path = "direct_tests.rs"]
mod tests;
