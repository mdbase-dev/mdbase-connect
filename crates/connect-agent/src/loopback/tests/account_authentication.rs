use super::*;
use crate::cloud::CloudControlClient;
use mdbase_connect_protocol::{ControlCommand, ControlRequest, ControlResponse};
use std::sync::atomic::{AtomicUsize, Ordering};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

#[tokio::test]
async fn invalid_account_credential_does_not_invalidate_existing_direct_grant() {
    // Reproduce #428's two observations on the SAME AgentState: account
    // management rejects its connector credential, while an already authorized
    // app can still use its exact cached encrypted grant on this computer.
    // This does not claim that remote relay access survives credential revocation.
    let attempts = Arc::new(AtomicUsize::new(0));
    let observed = attempts.clone();
    let cloud_app = Router::new().route(
        "/v1/connectors/control",
        axum::routing::get(move || {
            observed.fetch_add(1, Ordering::SeqCst);
            async {
                (
                    StatusCode::UNAUTHORIZED,
                    axum::Json(json!({"error": {
                        "code": "invalid_connector",
                        "message": "Connector credential is invalid."
                    }})),
                )
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, cloud_app).await.unwrap() });
    let mut fixture = fixture();
    fixture.agent = Arc::new(AgentState::with_identity(
        fixture.registry.clone(),
        fixture.watcher.clone(),
        Some(CloudControlClient::new(
            format!("http://{address}"),
            "synthetic-invalid-connector-credential".to_string(),
        )),
        fixture.connector.clone(),
    ));
    fixture
        .registry
        .operation(
            fixture.encryption.collection_id,
            "create",
            &json!({"path": "test-428.md", "frontmatter": {"title": "Synthetic fixture"}}),
        )
        .unwrap();
    let direct = router(fixture.agent.clone(), 28_485);
    let socket_root = tempfile::tempdir().unwrap();
    let endpoint = socket_root.path().join("control.sock");
    let endpoint_string = endpoint.to_str().unwrap().to_string();
    let state = fixture.agent.clone();
    let (listening, ready) = tokio::sync::oneshot::channel();
    let control = tokio::spawn(async move {
        crate::server::serve(&endpoint_string, state, || {
            let _ = listening.send(());
        })
        .await
        .unwrap();
    });
    ready.await.unwrap();
    for counter in 1..=2 {
        let mut stream = tokio::net::UnixStream::connect(&endpoint).await.unwrap();
        let mut request =
            serde_json::to_vec(&ControlRequest::new(ControlCommand::AccessSnapshot)).unwrap();
        request.push(b'\n');
        stream.write_all(&request).await.unwrap();
        let mut line = String::new();
        BufReader::new(stream).read_line(&mut line).await.unwrap();
        let snapshot: ControlResponse = serde_json::from_str(&line).unwrap();
        assert!(!snapshot.ok);
        let error = snapshot.error.unwrap();
        assert_eq!(error.code, "invalid_connector");
        assert_eq!(error.message, "Connector credential is invalid.");
        let record = fixture
            .direct(&direct, "read", json!({"path": "test-428.md"}), counter)
            .await;
        assert_eq!(record["ok"], true, "{record}");
        assert_eq!(record["result"]["valid"], true, "{record}");
        assert_eq!(
            record["result"]["result"]["frontmatter"]["title"],
            "Synthetic fixture"
        );
        assert_eq!(fixture.registry.list_grants().unwrap().len(), 1);
    }
    assert_eq!(attempts.load(Ordering::SeqCst), 2);
    server.abort();
    control.abort();
    let _ = control.await;
    drop(direct);
    let root = fixture.root.clone();
    drop(fixture);
    remove_fixture_after_watchers_close(&root);
}
