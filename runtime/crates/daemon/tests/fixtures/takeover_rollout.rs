//! Hermetic pairing plus the authenticated rollout contract.
use mdbn_daemon::{client::ControlClient, control::Method, paths::Profile, secrets::MemoryStore};
use serde_json::json;
use std::sync::{
    Arc,
    atomic::{AtomicU8, AtomicUsize, Ordering},
};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// 0 = legacy/unreleased, 1 = flipped next, 2 = unavailable, 3 = released cohort
/// still on legacy, 4 = connection closes without an answer, 5 = explicit operator
/// retirement is available (automatic rollout still closed).
/// Nothing here is a deployed control plane.
pub async fn pair(
    profile: &Profile,
    keys: &Arc<MemoryStore>,
    mode: Arc<AtomicU8>,
    calls: Arc<AtomicUsize>,
) -> tokio::task::JoinHandle<()> {
    mdbn_daemon::trust::allow_loopback_control_plane_for_tests();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let server = format!("http://{}", listener.local_addr().unwrap());
    let server2 = server.clone();
    let fixture = tokio::spawn(async move {
        loop {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            loop {
                let mut buffer = [0; 4096];
                let n = socket.read(&mut buffer).await.unwrap();
                assert!(n > 0);
                request.extend_from_slice(&buffer[..n]);
                assert!(request.len() < 16_384);
                if let Some(end) = request.windows(4).position(|w| w == b"\r\n\r\n") {
                    let headers = std::str::from_utf8(&request[..end])
                        .unwrap()
                        .to_ascii_lowercase();
                    let length: usize = headers
                        .lines()
                        .find_map(|l| l.strip_prefix("content-length:"))
                        .unwrap_or("0")
                        .trim()
                        .parse()
                        .unwrap();
                    if request.len() >= end + 4 + length {
                        break;
                    }
                }
            }
            let text = std::str::from_utf8(&request).unwrap();
            let (status, body) = if text.starts_with("POST /v1/pairing-requests/fixture/exchange ")
            {
                assert!(
                    text.to_ascii_lowercase()
                        .contains("authorization: bearer fixture-secret\r\n")
                );
                (
                    200,
                    json!({"status":"paired","account_id":"11111111-1111-4111-8111-111111111111",
                    "connector":{"id":"22222222-2222-4222-8222-222222222222"},"token":"con_hermetic_pairing_fixture_12345"}),
                )
            } else if text.starts_with("POST /v1/pairing-requests ") {
                (
                    200,
                    json!({"pairing_id":"fixture","verification_uri":format!("{server2}/approve"),"expires_in":60,"pairing_secret":"fixture-secret"}),
                )
            } else if text.starts_with("GET /v1/next/rollout ") {
                assert!(
                    text.to_ascii_lowercase()
                        .contains("authorization: bearer con_hermetic_pairing_fixture_12345\r\n")
                );
                calls.fetch_add(1, Ordering::SeqCst);
                if mode.load(Ordering::SeqCst) == 4 {
                    drop(socket);
                    continue;
                }
                match mode.load(Ordering::SeqCst) {
                    1 => (200, json!({"local_takeover":true,"account_backend":"next"})),
                    2 => (503, json!({"local_takeover":true,"account_backend":"next"})),
                    3 => (
                        200,
                        json!({"local_takeover":true,"account_backend":"legacy"}),
                    ),
                    _ => (
                        200,
                        json!({"local_takeover":false,"account_backend":"legacy"}),
                    ),
                }
            } else if text.starts_with("POST /v1/next/migration/local-takeover ") {
                assert!(
                    text.to_ascii_lowercase()
                        .contains("authorization: bearer con_hermetic_pairing_fixture_12345\r\n")
                );
                let body: serde_json::Value =
                    serde_json::from_str(text.split_once("\r\n\r\n").unwrap().1).unwrap();
                assert_eq!(
                    body["legacy_connector_id"],
                    "44444444-4444-4444-8444-444444444444"
                );
                assert_eq!(
                    body["legacy_collection_ids"],
                    json!(["4c18af2e-b04a-4b77-b83e-493c3695962e"])
                );
                assert_eq!(body.as_object().unwrap().len(), 3);
                if mode.load(Ordering::SeqCst) == 5 {
                    (
                        200,
                        json!({"retired":true,"legacy_connector_id":"44444444-4444-4444-8444-444444444444"}),
                    )
                } else {
                    (404, json!({"error":{"code":"not_found"}}))
                }
            } else {
                // Device/relay registration is not under test.
                (503, json!({"error":{"code":"unavailable"}}))
            };
            let body = body.to_string();
            let response = format!(
                "HTTP/1.1 {status} Fixture\r\nContent-Type: application/json\r\nCache-Control: no-store\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            socket.write_all(response.as_bytes()).await.unwrap();
        }
    });
    let mut client = ControlClient::connect(&profile.control).await.unwrap();
    client.authenticate(keys.as_ref()).await.unwrap();
    client
        .call(Method::ACCOUNT_SIGN_IN, json!({"server_url":server}))
        .await
        .unwrap();
    for _ in 0..200 {
        let status = client.call(Method::STATUS, json!({})).await.unwrap();
        if status["account"]["signed_in"] == true {
            return fixture;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    fixture.abort();
    panic!("pairing did not publish an account fence");
}
