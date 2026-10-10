//! Rollout permission parsing and transport fail-closed regressions.
use super::*;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

#[test]
fn rollout_requires_explicit_permission_and_next_backend() {
    assert!(parse_local_takeover(json!({"local_takeover":true,"account_backend":"next"})).unwrap());
    for v in [
        json!({"local_takeover":false,"account_backend":"next"}),
        json!({"local_takeover":true,"account_backend":"legacy"}),
        json!({"local_takeover":true,"account_backend":null}),
        json!({"local_takeover":true}),
        json!({"local_takeover":false}), // local takeover remains disabled
    ] {
        assert!(!parse_local_takeover(v).unwrap());
    }
    for v in [
        json!({}),
        json!({"local_takeover":"true","account_backend":"next"}),
        json!({"local_takeover":true,"account_backend":"future"}),
        json!({"local_takeover":true,"account_backend":"next","cohort":true}),
    ] {
        assert!(parse_local_takeover(v).is_err());
    }
}

async fn response(status: u16, body: &str, extra: &str) -> (Cloud, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let server = format!("http://{}", listener.local_addr().unwrap());
    let body = body.to_owned();
    let extra = extra.to_owned();
    let task = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut request = Vec::new();
        while !request.windows(4).any(|w| w == b"\r\n\r\n") {
            let mut buf = [0; 1024];
            let n = socket.read(&mut buf).await.unwrap();
            assert!(n > 0);
            request.extend_from_slice(&buf[..n]);
        }
        let request = std::str::from_utf8(&request).unwrap().to_ascii_lowercase();
        assert!(request.starts_with("get /v1/next/rollout "));
        assert!(request.contains("authorization: bearer fixture-token\r\n"));
        let reply = format!(
            "HTTP/1.1 {status} Fixture\r\nContent-Length: {}\r\nConnection: close\r\n{extra}\r\n{body}",
            body.len()
        );
        // Oversize refusal may close the socket before the full body is written.
        let _ = socket.write_all(reply.as_bytes()).await;
    });
    let keys = secrets::MemoryStore::default();
    keys.set(CONNECTOR_TOKEN, b"fixture-token").unwrap();
    let cloud = Cloud::new(&tls_config().unwrap(), &server, &keys).unwrap();
    (cloud, task)
}

#[tokio::test]
async fn rollout_transport_requires_200_and_bounded_valid_current_response() {
    let body = json!({"local_takeover":true,"account_backend":"next"}).to_string();
    for status in [200, 201, 302, 401, 403, 503] {
        let (cloud, task) = response(status, &body, "").await;
        let result = cloud
            .local_takeover_allowed(&tls_config().unwrap(), &|| Ok(()))
            .await;
        if status == 200 {
            assert!(result.unwrap());
        } else {
            assert!(result.is_err());
        }
        task.await.unwrap();
    }
    for body in ["not-json".to_owned(), " ".repeat(256 * 1024 + 1)] {
        let (cloud, task) = response(200, &body, "").await;
        assert!(
            cloud
                .local_takeover_allowed(&tls_config().unwrap(), &|| Ok(()))
                .await
                .is_err()
        );
        task.await.unwrap();
    }
    let (cloud, task) = response(200, &body, "").await;
    let checks = std::sync::atomic::AtomicUsize::new(0);
    let current = || {
        if checks.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 0 {
            Ok(())
        } else {
            Err("account_changed".into())
        }
    };
    assert!(
        cloud
            .local_takeover_allowed(&tls_config().unwrap(), &current)
            .await
            .is_err()
    );
    task.await.unwrap();
}

#[tokio::test]
async fn rollout_does_not_follow_redirects() {
    let target = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let location = format!(
        "Location: http://{}/permission\r\n",
        target.local_addr().unwrap()
    );
    let (cloud, task) = response(302, "", &location).await;
    assert!(
        cloud
            .local_takeover_allowed(&tls_config().unwrap(), &|| Ok(()))
            .await
            .is_err()
    );
    task.await.unwrap();
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(100), target.accept())
            .await
            .is_err()
    );
}
