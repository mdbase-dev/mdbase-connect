use super::*;
use axum::body::Bytes;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

fn publication_state() -> (tempfile::TempDir, Arc<AgentState>) {
    let directory = tempfile::tempdir().unwrap();
    let registry = CollectionRegistry::open(directory.path()).unwrap();
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;
    registry
        .replace_grants_at_revision("old", 1, now, now + 60_000, &[])
        .unwrap();
    let watcher = crate::watcher::CollectionWatchService::start(registry.clone());
    (
        directory,
        Arc::new(AgentState::new(registry, watcher, None)),
    )
}

fn publication_state_with_clock() -> (
    tempfile::TempDir,
    Arc<AgentState>,
    crate::server::policy::ManualPublicationClock,
    Instant,
) {
    let (directory, agent) = publication_state();
    let now = Instant::now();
    let clock = agent.manual_publication_clock(now);
    (directory, agent, clock, now)
}

fn policy_snapshot(sequence: u64) -> crate::server::policy::PolicySnapshot {
    let connector_id = Uuid::nil();
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;
    let expires = now + 60_000;
    let body = json!({
        "connector_id": connector_id,
        "sequence": sequence,
        "lease_issued_at_ms": now,
        "lease_expires_at_ms": expires,
        "grants": Vec::<GrantPolicy>::new(),
    });
    use sha2::Digest;
    let revision = format!(
        "sha256:{:x}",
        sha2::Sha256::digest(serde_jcs::to_vec(&body).unwrap())
    );
    crate::server::policy::PolicySnapshot {
        request_id: Uuid::new_v4(),
        revision,
        connector_id,
        sequence,
        lease_issued_at_ms: now,
        lease_expires_at_ms: expires,
        grants: Vec::new(),
    }
}

fn start_successor(
    agent: Arc<AgentState>,
    sequence: u64,
) -> (
    std::thread::JoinHandle<()>,
    std::sync::mpsc::Receiver<RelayMessage>,
) {
    let (done_tx, done_rx) = std::sync::mpsc::channel();
    let task = std::thread::spawn(move || {
        let result = crate::server::policy::apply_policy_snapshot(
            &agent,
            mdbase_connect_protocol::CONTROL_PROTOCOL_VERSION,
            policy_snapshot(sequence),
        );
        done_tx.send(result).unwrap();
    });
    (task, done_rx)
}

fn assert_applied(message: RelayMessage) {
    assert!(matches!(
        message,
        RelayMessage::PolicyApplied { ok: true, .. }
    ));
}

#[tokio::test]
async fn no_content_never_polled_holds_publication_until_response_drop() {
    let (_directory, agent, clock, now) = publication_state_with_clock();
    let policy = agent.capture_policy_revision().unwrap();
    let response = fenced_response(
        StatusCode::NO_CONTENT.into_response(),
        agent.clone(),
        policy,
        tokio::time::Instant::from_std(now + Duration::from_secs(1)),
        None,
    );
    assert_eq!(response.status(), StatusCode::NO_CONTENT);

    let (successor, done) = start_successor(agent, 2);
    clock.wait_until_snapshot_pending();
    assert!(matches!(
        done.try_recv(),
        Err(std::sync::mpsc::TryRecvError::Empty)
    ));
    drop(response);
    assert_applied(done.recv_timeout(Duration::from_millis(200)).unwrap());
    successor.join().unwrap();
}

#[test]
fn stale_error_response_uses_connection_abort_instead_of_http_status() {
    let (_directory, agent, clock, now) = publication_state_with_clock();
    let policy = agent.capture_policy_revision().unwrap();
    let blocker = agent
        .acquire_publication_permit(
            &policy,
            tokio::time::Instant::from_std(now + Duration::from_secs(1)),
        )
        .unwrap();
    let (successor, done) = start_successor(agent.clone(), 2);
    clock.wait_until_snapshot_pending();

    let stale = fenced_response(
        StatusCode::INTERNAL_SERVER_ERROR.into_response(),
        agent,
        policy,
        tokio::time::Instant::from_std(now + Duration::from_secs(1)),
        None,
    );
    let error = finish_response(stale).unwrap_err();
    assert_eq!(error.kind(), io::ErrorKind::ConnectionAborted);

    drop(blocker);
    assert_applied(done.recv_timeout(Duration::from_millis(200)).unwrap());
    successor.join().unwrap();
}

#[tokio::test]
async fn pending_second_chunk_is_suppressed_when_deadline_expires() {
    let (_directory, agent, clock, now) = publication_state_with_clock();
    let policy = agent.capture_policy_revision().unwrap();
    let deadline = now + Duration::from_millis(50);
    let (release_tx, release_rx) = tokio::sync::oneshot::channel::<()>();
    let first =
        futures_util::stream::iter(vec![Ok::<Bytes, io::Error>(Bytes::from_static(b"one"))]);
    let second = futures_util::stream::once(async move {
        release_rx.await.unwrap();
        Ok::<Bytes, io::Error>(Bytes::from_static(b"two"))
    });
    let response = fenced_response(
        Response::new(Body::from_stream(first.chain(second))),
        agent,
        policy,
        tokio::time::Instant::from_std(deadline),
        None,
    );
    let mut body = response.into_body().into_data_stream();
    assert_eq!(
        body.next().await.unwrap().unwrap(),
        Bytes::from_static(b"one")
    );
    let pending = body.next();
    tokio::pin!(pending);
    assert!(futures_util::poll!(&mut pending).is_pending());
    clock.advance_to(deadline);
    release_tx.send(()).unwrap();
    assert!(pending.await.is_none());
}

#[test]
fn dropping_nonempty_body_releases_publication_permit() {
    let (_directory, agent, clock, now) = publication_state_with_clock();
    let policy = agent.capture_policy_revision().unwrap();
    let response = fenced_response(
        Response::new(Body::from("held body")),
        agent.clone(),
        policy,
        tokio::time::Instant::from_std(now + Duration::from_secs(1)),
        None,
    );
    let (successor, done) = start_successor(agent, 2);
    clock.wait_until_snapshot_pending();
    assert!(matches!(
        done.try_recv(),
        Err(std::sync::mpsc::TryRecvError::Empty)
    ));
    drop(response);
    assert_applied(done.recv_timeout(Duration::from_millis(200)).unwrap());
    successor.join().unwrap();
}

#[test]
fn published_status_and_headers_delay_successor_only_to_absolute_deadline() {
    let (_directory, agent, clock, now) = publication_state_with_clock();
    let policy = agent.capture_policy_revision().unwrap();
    let deadline = now + Duration::from_millis(60);
    let mut source = Response::new(Body::from("late"));
    *source.status_mut() = StatusCode::ACCEPTED;
    source
        .headers_mut()
        .insert("x-publication", HeaderValue::from_static("old"));
    let response = fenced_response(
        source,
        agent.clone(),
        policy,
        tokio::time::Instant::from_std(deadline),
        None,
    );
    assert_eq!(response.status(), StatusCode::ACCEPTED);
    assert_eq!(response.headers()["x-publication"], "old");

    let (successor, done) = start_successor(agent, 2);
    clock.wait_until_snapshot_pending();
    assert!(matches!(
        done.try_recv(),
        Err(std::sync::mpsc::TryRecvError::Empty)
    ));
    clock.advance_to(deadline - Duration::from_nanos(1));
    assert!(matches!(
        done.try_recv(),
        Err(std::sync::mpsc::TryRecvError::Empty)
    ));
    clock.advance_to(deadline);
    assert_applied(done.recv_timeout(Duration::from_millis(200)).unwrap());
    drop(response);
    successor.join().unwrap();
}
