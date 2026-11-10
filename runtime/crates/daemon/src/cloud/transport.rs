//! HTTP transport: server URLs, TLS, response bounds and the source-checked request path.

use super::*;

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

pub(super) fn http(tls: &Arc<rustls::ClientConfig>) -> Result<reqwest::Client, CloudError> {
    reqwest::Client::builder()
        .use_preconfigured_tls((**tls).clone())
        .timeout(std::time::Duration::from_secs(30))
        .user_agent(concat!("mdbase-daemon/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| CloudError::Network(e.to_string()))
}

pub(super) async fn json_response(mut r: reqwest::Response) -> Result<(u16, Value), CloudError> {
    check_rate_limit(&mut r).await?;
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

async fn check_rate_limit(response: &mut reqwest::Response) -> Result<(), CloudError> {
    if response.status() == reqwest::StatusCode::TOO_MANY_REQUESTS {
        let retry_after = response
            .headers()
            .get(reqwest::header::RETRY_AFTER)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse().ok());
        let mut bytes = Vec::new();
        while let Ok(Some(chunk)) = response.chunk().await {
            if bytes.len().saturating_add(chunk.len()) > 256 * 1024 {
                return Err(CloudError::RateLimited(retry_after));
            }
            bytes.extend_from_slice(&chunk);
        }
        let value: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        if value.pointer("/error/code").and_then(Value::as_str)
            == Some("account_collection_quota_exceeded")
        {
            return Err(CloudError::Server(
                429,
                "account_collection_quota_exceeded".into(),
            ));
        }
        return Err(CloudError::RateLimited(retry_after));
    }
    Ok(())
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
            clock_skew: std::sync::atomic::AtomicBool::new(false),
            token: Zeroizing::new(token),
        })
    }

    /// Diagnostic only; never adjusts clocks, token expiry or authorization.
    pub fn clock_skew(&self) -> bool {
        self.clock_skew.load(std::sync::atomic::Ordering::Relaxed)
    }

    fn observe_server_date(&self, date: Option<&str>, local_ms: u64) {
        if let Some(server) = date.and_then(|v| {
            time::OffsetDateTime::parse(v, &time::format_description::well_known::Rfc2822).ok()
        }) {
            let server_ms = server.unix_timestamp_nanos() / 1_000_000;
            self.clock_skew.store(
                (server_ms - i128::from(local_ms)).abs() > 5 * 60 * 1000,
                std::sync::atomic::Ordering::Relaxed,
            );
        }
    }

    /// The bearer token, for the relay upgrade request.
    pub fn bearer(&self) -> String {
        format!("Bearer {}", self.token.as_str())
    }

    /// The canonical server URL this client talks to.
    pub fn server(&self) -> &str {
        &self.server
    }

    pub(super) async fn post(&self, path: &str, body: &Value) -> Result<Value, CloudError> {
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

    /// Bootstrap transport: bound the response and recheck the captured source
    /// after headers AND each body await, before accepting any result.
    pub(super) async fn post_current(
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
    pub(super) async fn send_current(
        &self,
        request: reqwest::RequestBuilder,
        current: &(dyn Fn() -> Result<(), String> + Send + Sync),
    ) -> Result<Value, CloudError> {
        self.send_current_status(request, current, None).await
    }

    pub(super) async fn send_current_status(
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
    pub(super) async fn send_current_raw_status(
        &self,
        request: reqwest::RequestBuilder,
        current: &(dyn Fn() -> Result<(), String> + Send + Sync),
        expected_status: Option<u16>,
    ) -> Result<(u16, Zeroizing<Vec<u8>>), CloudError> {
        current().map_err(CloudError::Local)?;
        let response = request.send().await;
        current().map_err(CloudError::Local)?;
        let mut response = response.map_err(|e| CloudError::Network(e.to_string()))?;
        self.observe_server_date(
            response
                .headers()
                .get(reqwest::header::DATE)
                .and_then(|v| v.to_str().ok()),
            fsutil::now_ms() as u64,
        );
        let rate_limit = check_rate_limit(&mut response).await;
        current().map_err(CloudError::Local)?;
        rate_limit?;
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
    pub(super) async fn challenge(
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
}

#[cfg(test)]
pub(super) async fn capture_proven(
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
        clock_skew: std::sync::atomic::AtomicBool::new(false),
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

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn rate_limits_preserve_retry_after_without_requiring_a_problem_body() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        for (retry_after, body, expected) in [
            (
                "Retry-After: 17\r\n",
                r#"{"error":{"code":"rate_limited"}}"#,
                CloudError::RateLimited(Some(17)),
            ),
            (
                "Retry-After: 0\r\n",
                r#"{"error":{"code":"invalid_request"}}"#,
                CloudError::RateLimited(Some(0)),
            ),
            ("", "not json", CloudError::RateLimited(None)),
            (
                "Retry-After: invalid\r\n",
                "",
                CloudError::RateLimited(None),
            ),
            (
                "Retry-After: 17\r\n",
                r#"{"error":{"code":"account_collection_quota_exceeded"}}"#,
                CloudError::Server(429, "account_collection_quota_exceeded".into()),
            ),
        ] {
            for guarded in [false, true] {
                let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
                let address = listener.local_addr().unwrap();
                let mock = tokio::spawn(async move {
                    let (mut socket, _) = listener.accept().await.unwrap();
                    let mut buffer = [0; 4096];
                    let received = socket.read(&mut buffer).await.unwrap();
                    assert!(received > 0);
                    let reply = format!(
                        "HTTP/1.1 429 Too Many Requests\r\nDate: Thu, 01 Jan 1970 00:00:00 GMT\r\n{retry_after}Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    socket.write_all(reply.as_bytes()).await.unwrap();
                });
                let cloud = Cloud {
                    http: reqwest::Client::new(),
                    server: format!("http://{address}"),
                    clock_skew: std::sync::atomic::AtomicBool::new(false),
                    token: Zeroizing::new("synthetic-token".into()),
                };
                let request = cloud.http.get(&cloud.server);
                let error = if guarded {
                    cloud
                        .send_current_status(request, &|| Ok(()), Some(200))
                        .await
                        .unwrap_err()
                } else {
                    json_response(request.send().await.unwrap())
                        .await
                        .unwrap_err()
                };
                assert_eq!(error, expected);
                if guarded {
                    assert!(
                        cloud.clock_skew(),
                        "observe server time before refusing HTTP 429"
                    );
                }
                mock.await.unwrap();
            }
        }
    }

    #[test]
    fn server_date_reports_large_clock_skew_and_clears_after_correction() {
        let cloud = Cloud {
            http: reqwest::Client::new(),
            server: "http://127.0.0.1:1".into(),
            clock_skew: std::sync::atomic::AtomicBool::new(false),
            token: Zeroizing::new("synthetic".into()),
        };
        let date = "Thu, 29 Oct 2026 07:56:00 GMT";
        let now = 1_793_260_560_000;
        for offset in [86_400_000_i64, -86_400_000] {
            cloud.observe_server_date(Some(date), (now + offset) as u64);
            assert!(cloud.clock_skew());
            cloud.observe_server_date(None, now as u64);
            cloud.observe_server_date(Some("invalid"), now as u64);
            assert!(
                cloud.clock_skew(),
                "missing evidence does not clear the diagnosis"
            );
            cloud.observe_server_date(Some(date), now as u64);
            assert!(!cloud.clock_skew());
        }
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
}
