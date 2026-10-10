//! Hermetic retirement response/transport checks; no deployed endpoint.
use super::*;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
const OLD: &str = "11111111-1111-4111-8111-111111111111";

#[test]
fn only_exact_positive_retirement_is_confirmed() {
    assert!(
        parse_legacy_retirement(json!({"retired":true,"legacy_connector_id":OLD}), OLD).is_ok()
    );
    for value in [
        json!({}),
        json!({"retired":false,"legacy_connector_id":OLD}),
        json!({"retired":true,"legacy_connector_id":"22222222-2222-4222-8222-222222222222"}),
        json!({"retired":true,"legacy_connector_id":OLD,"future":true}),
        json!({"retired":"true","legacy_connector_id":OLD}),
    ] {
        assert!(parse_legacy_retirement(value, OLD).is_err());
    }
}

async fn fixture(
    status: u16,
) -> (
    Cloud,
    crate::takeover::retirement::Plan,
    tokio::task::JoinHandle<()>,
) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let server = format!("http://{}", listener.local_addr().unwrap());
    let task = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut request = Vec::new();
        loop {
            let mut buf = [0; 4096];
            let n = socket.read(&mut buf).await.unwrap();
            assert!(n > 0);
            request.extend_from_slice(&buf[..n]);
            if let Some(end) = request.windows(4).position(|w| w == b"\r\n\r\n") {
                let headers = std::str::from_utf8(&request[..end])
                    .unwrap()
                    .to_ascii_lowercase();
                let length: usize = headers
                    .lines()
                    .find_map(|l| l.strip_prefix("content-length:"))
                    .unwrap()
                    .trim()
                    .parse()
                    .unwrap();
                if request.len() >= end + 4 + length {
                    assert!(headers.starts_with("post /v1/next/migration/local-takeover "));
                    assert!(headers.contains("authorization: bearer fixture-token\r\n"));
                    let body: Value =
                        serde_json::from_slice(&request[end + 4..end + 4 + length]).unwrap();
                    assert_eq!(
                        body,
                        json!({"legacy_connector_id":OLD,
                        "legacy_collection_ids":["33333333-3333-4333-8333-333333333333"],
                        "taken_over_at":"2026-10-08T12:00:00Z"})
                    );
                    break;
                }
            }
        }
        let body = json!({"retired":true,"legacy_connector_id":OLD}).to_string();
        let response = format!(
            "HTTP/1.1 {status} Fixture\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        let _ = socket.write_all(response.as_bytes()).await;
    });
    let keys = secrets::MemoryStore::default();
    keys.set(CONNECTOR_TOKEN, b"fixture-token").unwrap();
    let cloud = Cloud::new(&tls_config().unwrap(), &server, &keys).unwrap();
    let plan = crate::takeover::retirement::Plan {
        legacy_connector_id: OLD.into(),
        legacy_collection_ids: vec!["33333333-3333-4333-8333-333333333333".into()],
        taken_over_at: "2026-10-08T12:00:00Z".into(),
        old_state_dir: "/not-transmitted".into(),
        roots: vec!["/not-transmitted-folder".into()],
    };
    (cloud, plan, task)
}

#[tokio::test]
async fn unavailable_non200_and_changed_source_never_claim_retirement() {
    for status in [200, 204, 302, 404, 409, 503] {
        let (cloud, plan, task) = fixture(status).await;
        let result = cloud
            .retire_legacy_connector(&tls_config().unwrap(), &plan, &|| Ok(()))
            .await;
        assert_eq!(result.is_ok(), status == 200);
        task.await.unwrap();
    }
    let (cloud, plan, task) = fixture(200).await;
    let calls = std::sync::atomic::AtomicUsize::new(0);
    let current = || {
        if calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 0 {
            Ok(())
        } else {
            Err("source_changed".into())
        }
    };
    assert!(
        cloud
            .retire_legacy_connector(&tls_config().unwrap(), &plan, &current)
            .await
            .is_err()
    );
    task.await.unwrap();
}
