use super::*;

async fn rollout(cloud: Option<CloudControlClient>) -> serde_json::Value {
    let root = tempfile::tempdir().unwrap();
    let registry = CollectionRegistry::open(root.path()).unwrap();
    let watcher = CollectionWatchService::start(registry.clone());
    let state = Arc::new(AgentState::new(registry, watcher, cloud));
    let response = state
        .execute(ControlRequest::new(ControlCommand::NextRollout))
        .await;
    assert!(response.ok, "{:?}", response.error);
    response.result.unwrap()
}

#[tokio::test]
async fn next_rollout_is_closed_without_connector_credentials() {
    assert_eq!(
        rollout(None).await,
        serde_json::json!({"local_takeover": false})
    );
}

#[tokio::test]
async fn next_rollout_uses_connector_bearer_and_requires_explicit_permission() {
    for (status, body, allowed) in [
        (200, r#"{"local_takeover":true}"#, true),
        (200, r#"{"local_takeover":false}"#, false),
        (200, r#"{"local_takeover":"true"}"#, false),
        (200, "{}", false),
        (200, "not json", false),
        (401, r#"{"local_takeover":true}"#, false),
        (404, "{}", false),
        (500, r#"{"local_takeover":true}"#, false),
    ] {
        let app = axum::Router::new().route(
            "/v1/next/rollout",
            axum::routing::get(move |headers: axum::http::HeaderMap| async move {
                assert_eq!(
                    headers.get("authorization").unwrap(),
                    "Bearer test-connector-token"
                );
                (axum::http::StatusCode::from_u16(status).unwrap(), body)
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let result = rollout(Some(CloudControlClient::new(
            format!("http://{address}"),
            "test-connector-token".to_string(),
        )))
        .await;
        assert_eq!(result, serde_json::json!({"local_takeover": allowed}));
        server.abort();
    }
}

#[test]
fn next_rollout_command_is_additive_local_control() {
    let request = ControlRequest::new(ControlCommand::NextRollout);
    let value = serde_json::to_value(request).unwrap();
    assert_eq!(value["method"], "next.rollout");
    assert_eq!(value["protocol_version"], LOCAL_CONTROL_PROTOCOL_VERSION);
    assert!(matches!(
        serde_json::from_value::<ControlRequest>(value)
            .unwrap()
            .command,
        ControlCommand::NextRollout
    ));
}
