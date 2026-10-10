//! Hermetic authenticated pairing source; never LAB or a deployed endpoint.
use mdbn_daemon::client::ControlClient;
use mdbn_daemon::control::Method;
use mdbn_daemon::paths::Profile;
use mdbn_daemon::secrets::MemoryStore;
use serde_json::json;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

pub const ACCOUNT: &str = "11111111-1111-4111-8111-111111111111";

pub async fn pair(profile: &Profile, keys: &Arc<MemoryStore>) {
    // The fixture control plane is loopback, not the build environment's.
    mdbn_daemon::trust::allow_loopback_control_plane_for_tests();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let server = format!("http://{}", listener.local_addr().unwrap());
    let server2 = server.clone();
    let fixture = tokio::spawn(async move {
        for exchange in [false, true] {
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
                        .find_map(|line| line.strip_prefix("content-length:"))
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
            assert!(text.starts_with(if exchange {
                "POST /v1/pairing-requests/fixture/exchange "
            } else {
                "POST /v1/pairing-requests "
            }));
            let body = if exchange {
                assert!(text.to_ascii_lowercase().contains("authorization: bearer fixture-secret\r\n"));
                json!({"status":"paired", "account_id": ACCOUNT,"connector":{"id":"22222222-2222-4222-8222-222222222222"},"token":"con_hermetic_pairing_fixture_12345"})
            } else {
                json!({"pairing_id":"fixture", "verification_uri":format!("{server2}/approve"),"expires_in":60,"pairing_secret":"fixture-secret"})
            }.to_string();
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            socket.write_all(response.as_bytes()).await.unwrap();
        }
    });
    // Authenticate this separate control connection; the ordinary lifecycle client
    // must remain unprivileged so its existing authentication-denial assertions hold.
    let mut client = ControlClient::connect(&profile.control).await.unwrap();
    client.authenticate(keys.as_ref()).await.unwrap();
    client
        .call(Method::ACCOUNT_SIGN_IN, json!({"server_url":server}))
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(10), fixture)
        .await
        .unwrap()
        .unwrap();
    for _ in 0..200 {
        let status = client.call(Method::STATUS, json!({})).await.unwrap();
        if status["account"]["signed_in"] == true {
            // status --json names the account (not a secret) and the server.
            assert_eq!(status["account"]["account_id"], ACCOUNT);
            assert_eq!(status["account"]["server"], server);
            let record = mdbn_daemon::cloud::AccountRecord::load(&profile.account_file()).unwrap();
            assert_eq!(record.account_id.as_deref(), Some(ACCOUNT));
            assert!(record.active_account().is_some());
            return;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("hermetic pairing did not publish an account fence");
}
