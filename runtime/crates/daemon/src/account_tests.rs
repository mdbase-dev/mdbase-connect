//! Account publication/cleanup regressions.

#[tokio::test]
async fn real_pairing_exchange_is_cancelled_by_logout() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let dir = crate::testutil::TestDir::new("http-pairing-logout");
    let d = daemon(&dir);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let server = format!("http://{}", listener.local_addr().unwrap());
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
