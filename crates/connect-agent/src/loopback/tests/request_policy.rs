use super::*;

#[test]
fn busy_responses_are_explicitly_retryable() {
    let response = cors_busy("Busy.", "https://app.example");
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(response.headers().get(header::RETRY_AFTER).unwrap(), "1");
    assert_eq!(
        response.headers().get(ACCESS_CONTROL_ALLOW_ORIGIN).unwrap(),
        "https://app.example"
    );
}

#[tokio::test]
async fn preflight_pause_tampering_and_revocation_fail_closed() {
    let fixture = fixture();
    let app = router(fixture.agent.clone(), 28_485);
    let preflight = app
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::OPTIONS)
                .uri("/v1/operations")
                .header(HOST, "127.0.0.1:28485")
                .header(ORIGIN, &fixture.origin)
                .header(header::ACCESS_CONTROL_REQUEST_METHOD, "POST")
                .header(header::ACCESS_CONTROL_REQUEST_HEADERS, "content-type")
                .header("access-control-request-private-network", "true")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(preflight.status(), StatusCode::NO_CONTENT);
    assert_eq!(
        preflight
            .headers()
            .get("access-control-allow-private-network")
            .unwrap(),
        "true"
    );

    fixture.registry.set_paused(true).unwrap();
    let paused = fixture.direct(&app, "query", json!({}), 1).await;
    assert_eq!(paused["ok"], false);
    assert_eq!(paused["problem"]["code"], "access_paused");
    assert_eq!(paused["problem"]["category"], "availability");
    assert_eq!(paused["problem"]["recovery"], "resume_connector_access");
    let activity = fixture.registry.list_activity(20).unwrap();
    assert!(activity
        .iter()
        .any(|entry| entry.operation == "query" && entry.outcome == "denied"));
    fixture.registry.set_paused(false).unwrap();

    let mut tampered = fixture.encrypted_request("query", json!({}), 2);
    let RelayMessage::EncryptedOperationRequest { envelope } = &mut tampered else {
        unreachable!()
    };
    envelope.ciphertext.replace_range(
        ..1,
        if envelope.ciphertext.starts_with('A') {
            "B"
        } else {
            "A"
        },
    );
    let tampered_response = app
        .clone()
        .oneshot(request(
            Method::POST,
            "/v1/operations",
            &fixture.origin,
            Some(&serde_json::to_string(&tampered).unwrap()),
        ))
        .await
        .unwrap();
    assert_eq!(tampered_response.status(), StatusCode::FORBIDDEN);

    fixture.registry.replace_grants(&[]).unwrap();
    let revoked = fixture.direct(&app, "query", json!({}), 3).await;
    assert_eq!(revoked["ok"], false);
    assert_eq!(revoked["problem"]["code"], "access_denied");
    assert_eq!(revoked["problem"]["operation_outcome"], "not_sent");

    let root = fixture.root.clone();
    drop(app);
    drop(fixture);
    remove_fixture_after_watchers_close(&root);
}
