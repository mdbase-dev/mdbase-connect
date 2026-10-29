//! Account publication/cleanup regressions.

#[tokio::test]
async fn real_pairing_exchange_is_cancelled_by_logout() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let dir = crate::testutil::TestDir::new("http-pairing-logout");
    let d = daemon(&dir);
    // A local artifact deliberately ignores broad test-loopback hooks. Serve
    // this real HTTP fixture at its exact authenticated compile-time origin on
    // the isolated test VM instead of weakening the artifact's sign-in guard.
    #[cfg(feature = "local-rehearsal")]
    let address = crate::trust::Environment::embedded()
        .control_plane()
        .strip_prefix("http://")
        .unwrap();
    #[cfg(not(feature = "local-rehearsal"))]
    let address = "127.0.0.1:0";
    let listener = tokio::net::TcpListener::bind(address).await.unwrap();
    let server = format!("http://{}", listener.local_addr().unwrap());
    #[cfg(feature = "local-rehearsal")]
    assert_eq!(
        server,
        crate::trust::Environment::embedded().control_plane()
    );
    let reached = Arc::new(tokio::sync::Notify::new());
    let release = Arc::new(tokio::sync::Notify::new());
    let r1 = reached.clone();
    let r2 = release.clone();
    let server2 = server.clone();
    let fixture = tokio::spawn(async move {
        for exchange in [false, true] {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut buf = [0; 4096];
            let mut request = Vec::new();
            loop {
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
                        .unwrap_or("0")
                        .trim()
                        .parse()
                        .unwrap();
                    if request.len() >= end + 4 + length {
                        break;
                    }
                }
            }
            assert!(
                std::str::from_utf8(&request)
                    .unwrap()
                    .starts_with(if exchange {
                        "POST /v1/pairing-requests/p/exchange "
                    } else {
                        "POST /v1/pairing-requests "
                    })
            );
            let body = if exchange {
                r1.notify_one();
                r2.notified().await;
                json!({"account_id": ALICE,"connector":{"id":"old"},"token":"con_hermetic_pairing_fixture_12345"})
            } else {
                json!({"pairing_id":"p","verification_uri":format!("{server2}/approve"),"expires_in":60,"pairing_secret":"fixture"})
            }.to_string();
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            let _ = socket.write_all(response.as_bytes()).await;
        }
    });
    let req = Request {
        v: PROTOCOL,
        id: 1,
        method: Method::ACCOUNT_SIGN_IN.into(),
        params: json!({"server_url":server}),
    };
    d.sign_in(&req).await.unwrap();
    tokio::time::timeout(Duration::from_secs(10), reached.notified())
        .await
        .unwrap();
    d.sign_out().await.unwrap();
    release.notify_one();
    fixture.await.unwrap();
    tokio::task::yield_now().await;
    assert!(
        !crate::cloud::AccountRecord::load(&d.profile.account_file())
            .unwrap()
            .signed_in
    );
    assert!(
        crate::cloud::CloudConfig::load(&d.profile.cloud_file())
            .unwrap()
            .is_none()
    );
    assert!(
        d.secrets
            .get(crate::cloud::CONNECTOR_TOKEN)
            .unwrap()
            .is_none()
    );
    assert!(d.account.lock().unwrap().pairing_task.is_none());
}

use super::tests::daemon;
use super::*;
use std::sync::Arc;

const ALICE: &str = "11111111-1111-4111-8111-111111111111";
const BOB: &str = "22222222-2222-4222-8222-222222222222";

#[tokio::test]
async fn collection_delete_uses_owner_credential_and_keeps_local_state() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    const COLLECTION: &str = "44444444-4444-4444-8444-444444444444";
    let dir = crate::testutil::TestDir::new("collection-delete");
    let mut d = daemon(&dir);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let config = crate::cloud::CloudConfig {
        schema_version: 1,
        account_epoch: 1,
        connector_id: Some("connector".into()),
        server_url: format!("http://{}", listener.local_addr().unwrap()),
        ..Default::default()
    };
    let mut trust = crate::trust::fixture_trust();
    trust.cp_origin = config.server_url.clone();
    Arc::get_mut(&mut d).unwrap().trust = Some(Arc::new(trust));
    config.save(&d.profile.cloud_file()).unwrap();
    d.secrets
        .set(crate::cloud::CONNECTOR_TOKEN, b"con_delete_fixture")
        .unwrap();
    d.authority
        .publish_account(
            &crate::cloud::AccountRecord {
                schema_version: 1,
                epoch: 1,
                signed_in: true,
                connector_id: config.connector_id.clone(),
                account_id: Some(ALICE.into()),
            },
            &config,
            crate::authority::account_id(BOB).unwrap(),
        )
        .unwrap();
    let before = serde_json::to_value(&d.inner.lock().await.registry).unwrap();
    let fixture = tokio::spawn(async move {
        for (confirm, status, body) in [
            (
                "Wrong name",
                409,
                json!({"error":{"code":"collection_name_mismatch"}}),
            ),
            (
                "Shared name",
                409,
                json!({"error":{"code":"device_not_enrolled"}}),
            ),
            (
                "Shared name",
                200,
                json!({"collection_id":COLLECTION,"deleted":true}),
            ),
        ] {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            let mut buffer = [0; 4096];
            loop {
                let n = socket.read(&mut buffer).await.unwrap();
                assert!(n > 0);
                request.extend_from_slice(&buffer[..n]);
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
                    if request.len() < end + 4 + length {
                        continue;
                    }
                    assert!(
                        headers.starts_with(&format!("delete /v1/next/collections/{COLLECTION} "))
                    );
                    assert!(headers.contains("authorization: bearer con_delete_fixture"));
                    assert_eq!(
                        serde_json::from_slice::<Value>(&request[end + 4..]).unwrap(),
                        json!({"confirm_name":confirm})
                    );
                    break;
                }
            }
            let body = body.to_string();
            socket.write_all(format!("HTTP/1.1 {status} Fixture\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
        }
    });
    for (confirm, reason) in [
        ("Wrong name", Some("collection_name_mismatch")),
        ("Shared name", Some("device_not_enrolled")),
        ("Shared name", None),
    ] {
        let result = d
            .handle(
                &Request {
                    v: PROTOCOL,
                    id: 1,
                    method: Method::COLLECTION_DELETE.into(),
                    params: json!({"collection":COLLECTION,"confirm_name":confirm}),
                },
                &mut ConnAuth::default(),
            )
            .await;
        match reason {
            Some(reason) => {
                let error = result.unwrap_err();
                assert_eq!(error.reason.as_deref(), Some(reason));
                if reason == "device_not_enrolled" {
                    assert_eq!(
                        error.message,
                        "Join this collection on this computer first, then try again."
                    );
                }
            }
            None => assert_eq!(
                result.unwrap(),
                json!({"collection_id":COLLECTION,"deleted":true})
            ),
        }
        assert_eq!(
            serde_json::to_value(&d.inner.lock().await.registry).unwrap(),
            before
        );
    }
    fixture.await.unwrap();
}

fn account_config(epoch: u64, connector: &str) -> crate::cloud::CloudConfig {
    crate::cloud::CloudConfig {
        schema_version: 1,
        account_epoch: epoch,
        connector_id: Some(connector.into()),
        server_url: "http://127.0.0.1:9".into(),
        ..Default::default()
    }
}

#[tokio::test]
async fn suspended_pairing_cannot_survive_logout_or_replace_new_login() {
    for new_login in [false, true] {
        let dir = crate::testutil::TestDir::new("pairing-epoch");
        let d = daemon(&dir);
        let epoch = d.begin_pairing().await.unwrap();
        let ready = Arc::new(tokio::sync::Notify::new());
        let released = ready.clone();
        let d2 = d.clone();
        // Model a successful exchange already in flight. Do not rely on abort:
        // the final publication's epoch check must reject an obsolete result.
        let delayed = tokio::spawn(async move {
            released.notified().await;
            d2.publish_pairing(
                epoch,
                account_config(epoch, "old"),
                ALICE,
                b"con_old_fixture",
            )
            .await
        });
        d.sign_out().await.unwrap();
        if new_login {
            let fresh = d.begin_pairing().await.unwrap();
            d.publish_pairing(fresh, account_config(fresh, "new"), BOB, b"con_new_fixture")
                .await
                .unwrap();
        }
        ready.notify_one();
        let error = delayed.await.unwrap().unwrap_err();
        assert_eq!(error.reason.as_deref(), Some("sign_in_cancelled"));
        let record = crate::cloud::AccountRecord::load(&d.profile.account_file()).unwrap();
        assert!(record.epoch > epoch);
        assert_eq!(record.signed_in, new_login);
        if new_login {
            assert_eq!(record.connector_id.as_deref(), Some("new"));
            assert_eq!(record.account_id.as_deref(), Some(BOB));
            assert_eq!(
                d.authority.active_account(),
                crate::authority::account_id(BOB)
            );
            let cfg = crate::cloud::CloudConfig::load(&d.profile.cloud_file())
                .unwrap()
                .unwrap();
            assert!(record.permits(&cfg));
            assert_eq!(
                d.secrets
                    .get(crate::cloud::CONNECTOR_TOKEN)
                    .unwrap()
                    .unwrap()
                    .as_slice(),
                b"con_new_fixture"
            );
            // A delayed registration result cannot overwrite the fresh account.
            assert!(
                d.save_registered(epoch, &account_config(epoch, "old"))
                    .await
                    .is_err()
            );
            assert_eq!(
                crate::cloud::CloudConfig::load(&d.profile.cloud_file())
                    .unwrap()
                    .unwrap(),
                cfg
            );
        } else {
            assert!(
                d.secrets
                    .get(crate::cloud::CONNECTOR_TOKEN)
                    .unwrap()
                    .is_none()
            );
            assert!(
                crate::cloud::CloudConfig::load(&d.profile.cloud_file())
                    .unwrap()
                    .is_none()
            );
            resume_relay(&d).await;
            assert!(!d.account.lock().unwrap().signed_in);
            assert!(d.account.lock().unwrap().relay.is_none());
        }
    }
}

#[tokio::test]
async fn invalid_account_never_partially_publishes_credentials_or_authority() {
    for account in [
        "",
        "SERVICE_ACCOUNT",
        "00000000-0000-0000-0000-000000000000",
    ] {
        let dir = crate::testutil::TestDir::new("invalid-pair-account");
        let d = daemon(&dir);
        let epoch = d.begin_pairing().await.unwrap();
        assert!(
            d.publish_pairing(
                epoch,
                account_config(epoch, "connector"),
                account,
                b"con_fixture"
            )
            .await
            .is_err()
        );
        assert_eq!(d.authority.active_account(), None);
        assert!(
            d.secrets
                .get(crate::cloud::CONNECTOR_TOKEN)
                .unwrap()
                .is_none()
        );
        let record = crate::cloud::AccountRecord::load(&d.profile.account_file()).unwrap();
        assert!(!record.signed_in);
        assert_eq!(record.account_id, None);
    }
}

#[tokio::test]
async fn relay_feed_is_bound_to_account_epoch_even_after_same_account_repair() {
    let dir = crate::testutil::TestDir::new("late-account-feed");
    let d = daemon(&dir);
    let old_epoch = d.begin_pairing().await.unwrap();
    d.publish_pairing(
        old_epoch,
        account_config(old_epoch, "connector"),
        ALICE,
        b"con_fixture",
    )
    .await
    .unwrap();
    let mut snapshot = crate::relay::Snapshot {
        request_id: "test".into(),
        revision: "test-revision".into(),
        connector_id: "connector".into(),
        sequence: 1,
        account_epoch: old_epoch,
        lease_expires_ms: fsutil::now_ms() as u64 + 55_000,
        lease_deadline: std::time::Instant::now() + Duration::from_secs(55),
        grants: vec![],
    };
    d.sign_out().await.unwrap();
    let new_epoch = d.begin_pairing().await.unwrap();
    d.publish_pairing(
        new_epoch,
        account_config(new_epoch, "connector"),
        ALICE,
        b"con_fixture_new",
    )
    .await
    .unwrap();
    let error = d
        .commit_control_plane_feed(&snapshot, &Default::default())
        .await
        .unwrap_err();
    assert_eq!(error.reason.as_deref(), Some("policy_authority_mismatch"));
    assert!(d.inner.lock().await.access.feed_cursor.is_none());
    snapshot.account_epoch = new_epoch;
    d.commit_control_plane_feed(&snapshot, &Default::default())
        .await
        .unwrap();
    assert_eq!(
        d.inner
            .lock()
            .await
            .access
            .feed_cursor
            .as_ref()
            .unwrap()
            .sequence,
        1
    );
}

struct DeleteFailure {
    inner: Arc<crate::secrets::MemoryStore>,
    fail: Arc<std::sync::atomic::AtomicBool>,
}
impl SecretStore for DeleteFailure {
    fn get(
        &self,
        key: &str,
    ) -> Result<Option<zeroize::Zeroizing<Vec<u8>>>, crate::secrets::SecretError> {
        self.inner.get(key)
    }
    fn set(&self, key: &str, value: &[u8]) -> Result<(), crate::secrets::SecretError> {
        self.inner.set(key, value)
    }
    fn delete(&self, key: &str) -> Result<(), crate::secrets::SecretError> {
        if self.fail.load(std::sync::atomic::Ordering::SeqCst) {
            Err(crate::secrets::SecretError::Unavailable(
                "injected keychain deletion failure".into(),
            ))
        } else {
            self.inner.delete(key)
        }
    }
    fn backend(&self) -> &'static str {
        "memory"
    }
}

#[tokio::test]
async fn durable_logout_fence_survives_both_cleanup_failures_and_reopen() {
    let dir = crate::testutil::TestDir::new("logout-fence");
    let mut d = daemon(&dir);
    let secrets = Arc::new(crate::secrets::MemoryStore::default());
    let fail = Arc::new(std::sync::atomic::AtomicBool::new(false));
    Arc::get_mut(&mut d).unwrap().secrets = Arc::new(DeleteFailure {
        inner: secrets.clone(),
        fail: fail.clone(),
    });
    let epoch = d.begin_pairing().await.unwrap();
    let cfg = account_config(epoch, "old");
    d.publish_pairing(epoch, cfg.clone(), ALICE, b"con_old_fixture")
        .await
        .unwrap();
    fail.store(true, std::sync::atomic::Ordering::SeqCst);
    assert!(
        d.sign_out_with_remove(|_| Err(std::io::Error::other("injected config removal failure")))
            .await
            .is_err(),
        "cleanup failures are reported"
    );
    assert!(
        secrets
            .get(crate::cloud::CONNECTOR_TOKEN)
            .unwrap()
            .is_some(),
        "credential deliberately remains"
    );
    assert_eq!(
        crate::cloud::CloudConfig::load(&d.profile.cloud_file())
            .unwrap()
            .unwrap(),
        cfg,
        "old config deliberately remains"
    );
    let record = crate::cloud::AccountRecord::load(&d.profile.account_file()).unwrap();
    assert!(!record.signed_in);
    assert_eq!(record.account_id, None);
    assert_eq!(d.authority.active_account(), None);
    assert!(!record.permits(&cfg));
    let fresh = daemon(&dir);
    resume_relay(&fresh).await;
    assert!(!fresh.account.lock().unwrap().signed_in);
    assert!(fresh.account.lock().unwrap().relay.is_none());
    assert_eq!(fresh.account.lock().unwrap().epoch, record.epoch);
}

#[tokio::test]
async fn partial_pairing_publication_never_reconnects() {
    for fail_fence in [false, true] {
        let dir = crate::testutil::TestDir::new("partial-login");
        let d = daemon(&dir);
        let epoch = d.begin_pairing().await.unwrap();
        let cfg = account_config(epoch, "new");
        let file = if fail_fence {
            "account.json"
        } else {
            "cloud.json"
        };
        let blocked = dir
            .path()
            .join(format!(".{file}.tmp-{}", std::process::id()));
        std::fs::create_dir(&blocked).unwrap();
        assert!(
            d.publish_pairing(epoch, cfg.clone(), ALICE, b"con_fixture")
                .await
                .is_err()
        );
        assert!(
            d.secrets
                .get(crate::cloud::CONNECTOR_TOKEN)
                .unwrap()
                .is_some(),
            "token may already have been written"
        );
        assert!(
            !crate::cloud::AccountRecord::load(&d.profile.account_file())
                .unwrap()
                .permits(&cfg)
        );
        assert!(!d.account.lock().unwrap().signed_in);
        resume_relay(&d).await;
        assert!(d.account.lock().unwrap().relay.is_none());
        std::fs::remove_dir(blocked).unwrap();
    }
}

#[tokio::test]
async fn logout_aborts_tracked_pairing_and_never_restores_an_older_epoch() {
    let dir = crate::testutil::TestDir::new("pairing-abort");
    let d = daemon(&dir);
    let epoch = d.begin_pairing().await.unwrap();
    let task = tokio::spawn(std::future::pending::<()>());
    let abort = task.abort_handle();
    d.account.lock().unwrap().pairing_task = Some(task);
    d.sign_out().await.unwrap();
    tokio::task::yield_now().await;
    assert!(abort.is_finished());
    assert!(d.account.lock().unwrap().epoch > epoch);
    assert!(d.account.lock().unwrap().pairing_task.is_none());
    assert!(
        !crate::cloud::AccountRecord::load(&d.profile.account_file())
            .unwrap()
            .signed_in
    );
    // Missing fences never authorize stale cloud metadata either.
    std::fs::remove_file(d.profile.account_file()).unwrap();
    assert!(
        !crate::cloud::AccountRecord::load(&d.profile.account_file())
            .unwrap()
            .permits(&account_config(epoch, "old"))
    );
}

const CONNECTOR: &str = "33333333-3333-4333-8333-333333333333";

type Respond = Arc<dyn Fn(&str, usize) -> (u16, Value) + Send + Sync>;

/// A control plane for device registration only: `respond(device_id, attempt)`
/// answers `POST /v1/next/devices`; everything else but challenges is 404.
async fn registration_fixture(respond: Respond) -> String {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let server = format!("http://{}", listener.local_addr().unwrap());
    let attempts = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    tokio::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            let (respond, attempts) = (respond.clone(), attempts.clone());
            tokio::spawn(async move {
                let mut request = Vec::new();
                let mut buf = [0; 4096];
                let body_at = loop {
                    let Ok(n) = socket.read(&mut buf).await else {
                        return;
                    };
                    if n == 0 {
                        return;
                    }
                    request.extend_from_slice(&buf[..n]);
                    let Some(end) = request.windows(4).position(|w| w == b"\r\n\r\n") else {
                        continue;
                    };
                    let headers = String::from_utf8_lossy(&request[..end]).to_ascii_lowercase();
                    let length: usize = headers
                        .lines()
                        .find_map(|l| l.strip_prefix("content-length:"))
                        .map_or(0, |v| v.trim().parse().unwrap());
                    if request.len() >= end + 4 + length {
                        break end + 4;
                    }
                };
                let text = String::from_utf8_lossy(&request).to_string();
                let (status, body) = if text.starts_with("POST /v1/next/devices/challenge ") {
                    (200, json!({"challenge": crate::secrets::hex(&[7; 32])}))
                } else if text.starts_with("POST /v1/next/devices ") {
                    let body: Value = serde_json::from_slice(&request[body_at..]).unwrap();
                    let device = body["device_id"].as_str().unwrap().to_string();
                    let attempt = attempts.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    respond(&device, attempt)
                } else {
                    (404, json!({"error": {"code": "not_found"}}))
                };
                let body = body.to_string();
                let response = format!(
                    "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = socket.write_all(response.as_bytes()).await;
            });
        }
    });
    server
}

async fn sign_in_at(d: &Arc<Daemon>, account: &str, server: &str) -> u64 {
    sign_in_with(d, account, server, CONNECTOR).await
}

async fn sign_in_with(d: &Arc<Daemon>, account: &str, server: &str, connector: &str) -> u64 {
    let epoch = d.begin_pairing().await.unwrap();
    let mut cfg = account_config(epoch, connector);
    cfg.server_url = server.into();
    d.publish_pairing(epoch, cfg, account, b"con_fixture")
        .await
        .unwrap();
    epoch
}

fn device_of(d: &Daemon) -> [u8; 16] {
    d.identity.get().unwrap().device_id
}

async fn until(what: &str, mut done: impl FnMut() -> bool) {
    for _ in 0..1000 {
        if done() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("timed out waiting for {what}");
}

#[tokio::test]
async fn each_account_signs_in_with_its_own_device() {
    let dir = crate::testutil::TestDir::new("device-per-account");
    let d = daemon(&dir);
    let unreachable = "http://127.0.0.1:9";
    let alice = device_of(&d);
    sign_in_at(&d, ALICE, unreachable).await;
    assert_eq!(device_of(&d), alice);
    d.sign_out().await.unwrap();

    sign_in_at(&d, BOB, unreachable).await;
    let bob = device_of(&d);
    assert_ne!(
        bob, alice,
        "a second account never uses the first account's device"
    );
    assert_eq!(d.authority.incarnation().unwrap().device.0, bob);
    assert_eq!(
        d.status().await.device.unwrap().device_id,
        crate::secrets::uuid_string(&bob)
    );
    assert_eq!(
        serde_json::from_slice::<crate::secrets::DevicePublic>(
            &std::fs::read(d.profile.identity_file()).unwrap()
        )
        .unwrap()
        .device,
        crate::secrets::uuid_string(&bob),
        "local clients pin the new device's key"
    );
    d.sign_out().await.unwrap();

    sign_in_at(&d, ALICE, unreachable).await;
    assert_eq!(
        device_of(&d),
        alice,
        "the first account gets its own device back"
    );
    d.sign_out().await.unwrap();
    sign_in_at(&d, BOB, unreachable).await;
    assert_eq!(device_of(&d), bob);
}

#[tokio::test]
async fn an_older_unclaimed_device_stays_with_the_account_whose_collections_use_it() {
    let dir = crate::testutil::TestDir::new("device-unclaimed");
    let d = daemon(&dir);
    let old = device_of(&d);
    {
        let mut inner = d.inner.lock().await;
        let entry = &mut inner.registry.collections[0];
        entry.owner_account = Some(ALICE.into());
        entry.device = Some(crate::secrets::uuid_string(&old));
    }
    sign_in_at(&d, BOB, "http://127.0.0.1:9").await;
    assert_ne!(device_of(&d), old, "Alice's device is never used for Bob");
    d.sign_out().await.unwrap();
    sign_in_at(&d, ALICE, "http://127.0.0.1:9").await;
    assert_eq!(device_of(&d), old);
}

#[tokio::test]
async fn a_failed_registration_is_reported_and_retried_while_running() {
    let dir = crate::testutil::TestDir::new("device-retry");
    let d = daemon(&dir);
    let server = registration_fixture(Arc::new(|device, attempt| {
        if attempt == 0 {
            (503, json!({"error": {"code": "busy"}}))
        } else {
            (200, json!({"device_id": device}))
        }
    }))
    .await;
    sign_in_at(&d, ALICE, &server).await;
    let account = || {
        let d = d.clone();
        async move { d.status().await.account }
    };
    for _ in 0..500 {
        if account().await.last_error.is_some() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let status = account().await;
    assert!(status.signed_in);
    assert_eq!(
        status.last_error.as_deref(),
        Some("device_registration_failed")
    );
    // The relay coming online does not hide it.
    crate::relay::RelayHost::set_online(d.as_ref(), true);
    assert_eq!(
        account().await.last_error.as_deref(),
        Some("device_registration_failed")
    );
    assert!(d.account.lock().unwrap().registration.is_some());
    // Retried without a restart.
    let cloud = d.profile.cloud_file();
    until("the retried registration", || {
        crate::cloud::CloudConfig::load(&cloud)
            .ok()
            .flatten()
            .is_some_and(|c| c.device_registered)
    })
    .await;
    assert_eq!(account().await.last_error, None);
}

#[tokio::test]
async fn a_removed_computer_registers_a_new_device_and_keeps_its_local_collections() {
    let dir = crate::testutil::TestDir::new("device-removed");
    let d = daemon(&dir);
    let old = device_of(&d);
    let old_id = crate::secrets::uuid_string(&old);
    {
        let mut inner = d.inner.lock().await;
        let entry = &mut inner.registry.collections[0];
        entry.owner_account = Some(ALICE.into());
        entry.device = Some(old_id.clone());
    }
    let registered = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
    let seen = registered.clone();
    let refused = old_id.clone();
    let server = registration_fixture(Arc::new(move |device, _| {
        if device == refused {
            (409, json!({"error": {"code": "device_removed"}}))
        } else {
            seen.lock().unwrap().push(device.to_string());
            (200, json!({"device_id": device}))
        }
    }))
    .await;
    let epoch = sign_in_at(&d, ALICE, &server).await;
    let cloud = d.profile.cloud_file();
    until("the new device's registration", || {
        crate::cloud::CloudConfig::load(&cloud)
            .ok()
            .flatten()
            .is_some_and(|c| c.device_registered)
    })
    .await;
    let fresh = device_of(&d);
    assert_ne!(fresh, old, "the removed device stays removed");
    assert_eq!(
        *registered.lock().unwrap(),
        vec![crate::secrets::uuid_string(&fresh)]
    );
    assert_eq!(
        crate::secrets::identity_account(&d.profile.identity_file())
            .unwrap()
            .as_deref(),
        Some(ALICE)
    );
    // Signed in again under a new epoch with the new device.
    let record = crate::cloud::AccountRecord::load(&d.profile.account_file()).unwrap();
    let cfg = crate::cloud::CloudConfig::load(&cloud).unwrap().unwrap();
    assert_eq!(record.epoch, epoch + 1);
    assert!(record.permits(&cfg));
    assert_eq!(d.authority.incarnation().unwrap().device.0, fresh);
    // The account's local collection here moved to the new device.
    assert_eq!(
        d.inner.lock().await.registry.collections[0]
            .device
            .as_deref(),
        Some(crate::secrets::uuid_string(&fresh).as_str())
    );
    // The old identity is gone from this computer.
    assert_eq!(
        crate::secrets::DeviceIdentity::load_or_create(
            d.secrets.as_ref(),
            &d.profile.identity_file()
        )
        .unwrap()
        .device_id,
        fresh
    );
    assert_eq!(d.status().await.account.last_error, None);
}

fn registered(d: &Daemon) -> bool {
    crate::cloud::CloudConfig::load(&d.profile.cloud_file())
        .ok()
        .flatten()
        .is_some_and(|c| c.device_registered)
}

/// The relay stops at once on a policy cursor from another connector.
async fn assert_relay_keeps_running(d: &Arc<Daemon>) {
    until("device registration", || registered(d)).await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(
        !d.account
            .lock()
            .unwrap()
            .relay
            .as_ref()
            .expect("relay started")
            .is_finished(),
        "relay stopped: {:?}",
        d.status().await.account.last_error
    );
    assert_eq!(d.status().await.account.last_error, None);
}

#[tokio::test]
async fn signing_out_and_in_again_starts_the_relay_on_the_new_connector() {
    const NEXT: &str = "44444444-4444-4444-8444-444444444444";
    let dir = crate::testutil::TestDir::new("relay-after-sign-in");
    let d = daemon(&dir);
    let server =
        registration_fixture(Arc::new(|device, _| (200, json!({"device_id": device})))).await;
    let epoch = sign_in_at(&d, ALICE, &server).await;
    until("device registration", || registered(&d)).await;
    let snapshot = crate::relay::Snapshot {
        request_id: "test".into(),
        revision: "test-revision".into(),
        connector_id: CONNECTOR.into(),
        sequence: 3,
        account_epoch: epoch,
        lease_expires_ms: fsutil::now_ms() as u64 + 55_000,
        lease_deadline: std::time::Instant::now() + Duration::from_secs(55),
        grants: vec![],
    };
    d.commit_control_plane_feed(&snapshot, &Default::default())
        .await
        .unwrap();
    d.sign_out().await.unwrap();
    sign_in_with(&d, ALICE, &server, NEXT).await;
    assert_relay_keeps_running(&d).await;
    assert!(d.inner.lock().await.access.feed_cursor.is_none());
}

#[tokio::test]
async fn a_saved_policy_cursor_from_an_old_connector_does_not_stop_the_relay() {
    let dir = crate::testutil::TestDir::new("relay-old-cursor");
    let d = daemon(&dir);
    let server =
        registration_fixture(Arc::new(|device, _| (200, json!({"device_id": device})))).await;
    sign_in_at(&d, ALICE, &server).await;
    until("device registration", || registered(&d)).await;
    // As a restart finds it after a cleanup that did not finish.
    if let Some(relay) = d.account.lock().unwrap().relay.take() {
        relay.abort();
    }
    {
        let mut inner = d.inner.lock().await;
        inner.access.feed_cursor = Some(crate::access::FeedCursor {
            connector: "old-connector".into(),
            sequence: 9,
            revision: "old".into(),
        });
        inner.access.leases.insert("c".into(), u64::MAX);
        inner.access.save(&d.profile.access_file()).unwrap();
    }
    resume_relay(&d).await;
    assert_relay_keeps_running(&d).await;
    let saved = AccessList::load(&d.profile.access_file()).unwrap();
    assert!(saved.feed_cursor.is_none());
    assert!(saved.leases.is_empty(), "old grants are not served");
}
