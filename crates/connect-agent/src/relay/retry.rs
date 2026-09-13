use std::time::Duration;

#[derive(Debug)]
pub(super) struct TerminalRelayFailure(pub &'static str);
impl std::fmt::Display for TerminalRelayFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.0)
    }
}
impl std::error::Error for TerminalRelayFailure {}

pub(super) fn terminal_http_status(status: u16) -> Option<&'static str> {
    match status {
        401 | 403 => Some("authentication_required"),
        400 | 404 | 405 | 426 => Some("incompatible_version"),
        _ => None,
    }
}

pub(super) fn terminal_reason(
    error: &(dyn std::error::Error + Send + Sync + 'static),
) -> Option<&'static str> {
    if let Some(error) = error.downcast_ref::<TerminalRelayFailure>() {
        return Some(error.0);
    }
    if let Some(tokio_tungstenite::tungstenite::Error::Http(response)) =
        error.downcast_ref::<tokio_tungstenite::tungstenite::Error>()
    {
        return terminal_http_status(response.status().as_u16());
    }
    None
}

#[derive(Debug)]
pub(super) struct RelayPacing(pub Duration);
impl std::fmt::Display for RelayPacing {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("relay server requested pacing")
    }
}
impl std::error::Error for RelayPacing {}

pub(super) fn retry_after(value: &str, now: chrono::DateTime<chrono::Utc>) -> Option<Duration> {
    let seconds = value.parse::<u64>().ok().or_else(|| {
        chrono::DateTime::parse_from_rfc2822(value)
            .ok()
            .map(|date| date.signed_duration_since(now).num_seconds().max(0) as u64)
    })?;
    Some(Duration::from_secs(seconds.clamp(1, 300)))
}

pub(super) fn pacing_delay(
    error: &(dyn std::error::Error + Send + Sync + 'static),
) -> Option<Duration> {
    if let Some(pacing) = error.downcast_ref::<RelayPacing>() {
        return Some(pacing.0);
    }
    if let Some(tokio_tungstenite::tungstenite::Error::Http(response)) =
        error.downcast_ref::<tokio_tungstenite::tungstenite::Error>()
    {
        if matches!(response.status().as_u16(), 429 | 503) {
            return response
                .headers()
                .get("retry-after")
                .and_then(|value| value.to_str().ok())
                .and_then(|value| retry_after(value, chrono::Utc::now()));
        }
    }
    None
}

/// Equal jitter avoids zero-delay spin while preserving a hard 30-second cap.
/// Reset only after policy-authorized healthy uptime, not a successful handshake.
pub(super) fn retry_delay(failures: &mut u32, healthy_uptime: Duration, random: u32) -> Duration {
    if healthy_uptime >= Duration::from_secs(30) {
        *failures = 0;
    }
    let cap_ms = (1_000u64 << (*failures).min(5)).min(30_000);
    *failures = failures.saturating_add(1);
    Duration::from_millis(cap_ms / 2 + u64::from(random) % (cap_ms / 2 + 1))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn terminal_http_rejection_stops_the_real_relay_owner() {
        use std::sync::{
            atomic::{AtomicUsize, Ordering},
            Arc,
        };
        let requests = Arc::new(AtomicUsize::new(0));
        let observed = requests.clone();
        let app = axum::Router::new().route(
            "/v1/connectors/sync",
            axum::routing::post(move |headers: axum::http::HeaderMap| {
                assert_eq!(
                    headers.get("authorization").unwrap(),
                    "Bearer unchanged-test-identity"
                );
                observed.fetch_add(1, Ordering::SeqCst);
                async { axum::http::StatusCode::UNAUTHORIZED }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let root = tempfile::tempdir().unwrap();
        let registry = mdbase_connect_core::CollectionRegistry::open(root.path()).unwrap();
        let watcher = crate::watcher::CollectionWatchService::start(registry.clone());
        let state = Arc::new(crate::server::AgentState::new(registry, watcher, None));
        let relay = tokio::spawn(super::super::run(
            format!("http://{address}"),
            "unchanged-test-identity".to_string(),
            state,
        ));
        tokio::time::timeout(Duration::from_secs(2), async {
            while requests.load(Ordering::SeqCst) == 0 {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        tokio::time::sleep(Duration::from_millis(1200)).await;
        assert_eq!(requests.load(Ordering::SeqCst), 1);
        assert!(
            !relay.is_finished(),
            "terminal route remains explicitly blocked until controlled restart"
        );
        relay.abort();
        let _ = relay.await;
        server.abort();
        let _ = server.await;
    }

    #[test]
    fn retry_is_bounded_jittered_and_resets_only_after_healthy_uptime() {
        let mut failures = 0;
        assert_eq!(
            retry_delay(&mut failures, Duration::ZERO, 0),
            Duration::from_millis(500)
        );
        assert_eq!(
            retry_delay(&mut failures, Duration::ZERO, 500),
            Duration::from_millis(1500)
        );
        for _ in 0..100 {
            let delay = retry_delay(&mut failures, Duration::from_secs(29), u32::MAX);
            assert!(delay <= Duration::from_secs(30));
            assert!(delay >= Duration::from_secs(2));
        }
        assert_eq!(
            retry_delay(&mut failures, Duration::from_secs(30), 0),
            Duration::from_millis(500)
        );
    }
    #[test]
    fn server_pacing_accepts_seconds_and_dates_with_a_hard_bound() {
        let now = chrono::DateTime::parse_from_rfc2822("Sun, 13 Sep 2026 00:00:00 +0000")
            .unwrap()
            .with_timezone(&chrono::Utc);
        assert_eq!(retry_after("45", now), Some(Duration::from_secs(45)));
        assert_eq!(retry_after("999999", now), Some(Duration::from_secs(300)));
        assert_eq!(
            retry_after("Sun, 13 Sep 2026 00:02:00 +0000", now),
            Some(Duration::from_secs(120))
        );
        assert_eq!(retry_after("invalid", now), None);
    }

    #[test]
    fn only_terminal_auth_or_protocol_outcomes_stop_reconnect() {
        assert_eq!(terminal_http_status(401), Some("authentication_required"));
        assert_eq!(terminal_http_status(403), Some("authentication_required"));
        assert_eq!(terminal_http_status(426), Some("incompatible_version"));
        for status in [408, 429, 500, 502, 503, 504] {
            assert_eq!(terminal_http_status(status), None);
        }
        assert_eq!(
            terminal_reason(&TerminalRelayFailure("incompatible_version")),
            Some("incompatible_version")
        );
        assert_eq!(
            terminal_reason(&std::io::Error::from(std::io::ErrorKind::ConnectionReset)),
            None
        );
    }
}
