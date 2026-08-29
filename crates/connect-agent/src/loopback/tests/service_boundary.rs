use super::*;
use futures_util::FutureExt;
use std::error::Error;
use std::panic::AssertUnwindSafe;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

type TestResult<T> = Result<T, Box<dyn Error + Send + Sync>>;

fn successor_snapshot(fixture: &Fixture) -> TestResult<crate::server::policy::PolicySnapshot> {
    let now = SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis() as i64;
    let connector_id = fixture.encryption.connector_id;
    let sequence = 2;
    let expires = now + 60_000;
    let grants = Vec::<GrantPolicy>::new();
    let body = json!({
        "connector_id": connector_id,
        "sequence": sequence,
        "lease_issued_at_ms": now,
        "lease_expires_at_ms": expires,
        "grants": &grants,
    });
    use sha2::Digest;
    let revision = format!(
        "sha256:{:x}",
        sha2::Sha256::digest(serde_jcs::to_vec(&body)?)
    );
    Ok(crate::server::policy::PolicySnapshot {
        request_id: Uuid::new_v4(),
        revision,
        connector_id,
        sequence,
        lease_issued_at_ms: now,
        lease_expires_at_ms: expires,
        grants,
    })
}

fn failure(message: impl Into<String>) -> Box<dyn Error + Send + Sync> {
    Box::new(io::Error::other(message.into()))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn committed_successor_closes_real_http_connection_before_status_or_headers() {
    let fixture = fixture();
    let root = fixture.root.clone();
    let hook = match PublicationPauseGuard::install(&fixture.agent) {
        Ok(hook) => hook,
        Err(error) => {
            drop(fixture);
            remove_fixture_after_watchers_close(&root);
            panic!("failed to install publication pause: {error}");
        }
    };
    let server = match start(0, fixture.agent.clone()).await {
        Ok(server) => server,
        Err(error) => {
            drop(hook);
            drop(fixture);
            remove_fixture_after_watchers_close(&root);
            panic!("failed to start loopback server: {error}");
        }
    };

    let outcome = AssertUnwindSafe(async {
        let message = fixture.encrypted_request("query", json!({}), 1);
        let body = serde_json::to_vec(&message)?;
        let request = format!(
            "POST /v1/operations HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nOrigin: {}\r\nContent-Type: application/mdbase-connect+json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            server.port(),
            fixture.origin,
            body.len()
        );
        let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", server.port())).await?;
        stream.write_all(request.as_bytes()).await?;
        stream.write_all(&body).await?;

        let hook_deadline = tokio::time::Instant::now() + Duration::from_secs(2);
        loop {
            match hook.reached() {
                Ok(()) => break,
                Err(std::sync::mpsc::TryRecvError::Empty)
                    if tokio::time::Instant::now() < hook_deadline =>
                {
                    tokio::time::sleep(Duration::from_millis(1)).await;
                }
                Err(std::sync::mpsc::TryRecvError::Empty) => {
                    return Err(failure(
                        "encrypted operation did not reach the pre-publication boundary",
                    ));
                }
                Err(std::sync::mpsc::TryRecvError::Disconnected) => {
                    return Err(failure("publication pause hook disconnected"));
                }
            }
        }

        let snapshot = successor_snapshot(&fixture)?;
        let successor_revision = snapshot.revision.clone();
        let applied = crate::server::policy::apply_policy_snapshot(
            &fixture.agent,
            mdbase_connect_protocol::CONTROL_PROTOCOL_VERSION,
            snapshot,
        );
        if !matches!(applied, RelayMessage::PolicyApplied { ok: true, .. }) {
            return Err(failure(format!(
                "successor policy was not applied: {applied:?}"
            )));
        }
        let committed_revision = fixture.registry.remote_policy_revision_if_fresh()?;
        if committed_revision.as_deref() != Some(&successor_revision) {
            return Err(failure(format!(
                "successor policy was not committed: expected {successor_revision}, got {committed_revision:?}"
            )));
        }

        hook.release();
        let mut received = Vec::new();
        let termination = tokio::time::timeout(
            Duration::from_secs(2),
            stream.read_to_end(&mut received),
        )
        .await
        .map_err(|_| failure("stale HTTP connection was not terminated"))?;
        if !received.is_empty() {
            return Err(failure(format!(
                "stale response published HTTP bytes: {}",
                String::from_utf8_lossy(&received)
            )));
        }
        if received.starts_with(b"HTTP/") {
            return Err(failure("stale response published an HTTP status"));
        }
        if received.windows(4).any(|part| part == b"\r\n\r\n") {
            return Err(failure("stale response published HTTP headers"));
        }
        if received.windows(b"500".len()).any(|part| part == b"500") {
            return Err(failure("stale response published an HTTP 500"));
        }
        if !matches!(termination, Ok(0) | Err(_)) {
            return Err(failure(format!(
                "stale connection returned an unexpected read result: {termination:?}"
            )));
        }
        Ok::<(), Box<dyn Error + Send + Sync>>(())
    })
    .catch_unwind()
    .await;

    hook.release();
    server.stop().await;
    drop(hook);
    drop(fixture);
    remove_fixture_after_watchers_close(&root);

    match outcome {
        Ok(Ok(())) => {}
        Ok(Err(error)) => panic!("committed-successor regression failed: {error}"),
        Err(payload) => std::panic::resume_unwind(payload),
    }
}
