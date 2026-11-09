use super::*;
use std::sync::atomic::{AtomicU64, Ordering};
static NEXT: AtomicU64 = AtomicU64::new(0);
struct Disk(std::path::PathBuf);
impl Disk {
    fn new() -> Self {
        let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../target")
            .join(format!(
                "mode-request-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
        std::fs::create_dir_all(&path).unwrap();
        Self(path)
    }
}
impl Drop for Disk {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
fn request() -> Request {
    Request {
        collection: "11111111-1111-4111-8111-111111111111".into(),
        account: "22222222-2222-4222-8222-222222222222".into(),
        device: "33333333-3333-4333-8333-333333333333".into(),
        genesis: "ab".repeat(32),
        generation: "cd".repeat(32),
        request: "44444444-4444-4444-8444-444444444444".into(),
        target: "cloud_copy".into(),
        cancel_requested: false,
        native_started: false,
    }
}
#[test]
fn unknown_http_outcome_keeps_exact_request_and_generation_after_reopen() {
    let disk = Disk::new();
    let original = request();
    original.save(&disk.0).unwrap();
    let reopened = Request::load(&disk.0).unwrap().unwrap();
    assert_eq!(
        serde_json::to_value(&original).unwrap(),
        serde_json::to_value(reopened).unwrap()
    );
}
#[test]
fn cancellation_is_durable_before_http_and_clear_is_idempotent() {
    let disk = Disk::new();
    let mut op = request();
    op.save(&disk.0).unwrap();
    op.cancel_requested = true;
    op.save(&disk.0).unwrap();
    assert!(Request::load(&disk.0).unwrap().unwrap().cancel_requested);
    Request::clear(&disk.0).unwrap();
    Request::clear(&disk.0).unwrap();
    assert!(Request::load(&disk.0).unwrap().is_none());
}
#[test]
fn corrupt_or_unbound_journals_fail_closed_and_are_retained() {
    let disk = Disk::new();
    for field in [
        "account",
        "device",
        "collection",
        "request",
        "genesis",
        "generation",
        "target",
    ] {
        let mut value = serde_json::to_value(request()).unwrap();
        value[field] = serde_json::Value::String("invalid".into());
        crate::fsutil::write_atomic(&disk.0.join(FILE), &serde_json::to_vec(&value).unwrap())
            .unwrap();
        assert!(Request::load(&disk.0).is_err(), "{field}");
        assert!(disk.0.join(FILE).exists());
    }
    crate::fsutil::write_atomic(&disk.0.join(FILE), b"{").unwrap();
    assert!(Request::load(&disk.0).is_err());
    assert!(disk.0.join(FILE).exists());
}

/// A live daemon with one synced collection whose control plane only answers
/// the owner mode status, and a confirmer that counts and declines.
mod live {
    use super::*;
    use crate::confirm::{Answer, Confirmer};
    use crate::testutil::TestDir;
    use std::sync::Mutex as Shared;
    use std::time::Duration;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[derive(Default)]
    struct Declines(AtomicU64);
    impl Confirmer for Declines {
        fn ask<'a>(&'a self, _: &'a str, _: &'a str) -> crate::session::BoxFuture<'a, Answer> {
            self.0.fetch_add(1, Ordering::SeqCst);
            Box::pin(async { Answer::No })
        }
    }

    struct Live {
        _profile: TestDir,
        _folder: TestDir,
        daemon: Arc<Daemon>,
        id: String,
        status: Arc<Shared<Value>>,
        seen: Arc<Shared<Vec<String>>>,
        asked: Arc<Declines>,
    }

    impl Live {
        fn serve(&self, current_mode: &str, execution_available: bool) {
            *self.status.lock().unwrap() = json!({
                "collection_id": self.id,
                "current_mode": current_mode,
                "execution_available": execution_available,
                "change": null,
            });
        }
        fn change(&self, target_mode: &str, resume: bool) -> ChangeMode {
            ChangeMode {
                collection: self.id.clone(),
                target_mode: target_mode.into(),
                resume,
                cancel: false,
            }
        }
        /// Nothing was reserved, journaled or confirmed.
        fn untouched(&self) {
            assert!(
                !self
                    .seen
                    .lock()
                    .unwrap()
                    .iter()
                    .any(|line| !line.starts_with("GET ") && line.contains("/mode")),
                "{:?}",
                self.seen.lock().unwrap()
            );
            assert!(
                !self
                    .daemon
                    .profile
                    .collection_dir(&self.id)
                    .join(FILE)
                    .exists()
            );
        }
        async fn close(&self) {
            let mut inner = self.daemon.inner.lock().await;
            for host in &mut inner.hosts {
                host.close().await;
            }
            drop(inner);
            self.daemon.shutdown.send_replace(true);
        }
    }

    async fn control_plane(
        listener: tokio::net::TcpListener,
        status: Arc<Shared<Value>>,
        seen: Arc<Shared<Vec<String>>>,
    ) {
        while let Ok((mut socket, _)) = listener.accept().await {
            let (status, seen) = (status.clone(), seen.clone());
            tokio::spawn(async move {
                let mut request = Vec::new();
                while !request.windows(4).any(|w| w == b"\r\n\r\n") {
                    let mut buf = [0; 1024];
                    match socket.read(&mut buf).await {
                        Ok(0) | Err(_) => return,
                        Ok(n) => request.extend_from_slice(&buf[..n]),
                    }
                }
                let line = String::from_utf8_lossy(&request)
                    .lines()
                    .next()
                    .unwrap_or_default()
                    .to_owned();
                let (code, body) = if line.starts_with("GET ") && line.ends_with("/mode HTTP/1.1") {
                    (200, status.lock().unwrap().to_string())
                } else {
                    (404, json!({"error":{"code":"not_found"}}).to_string())
                };
                seen.lock().unwrap().push(line);
                let reply = format!(
                    "HTTP/1.1 {code} Fixture\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = socket.write_all(reply.as_bytes()).await;
            });
        }
    }

    async fn live(tag: &str) -> Live {
        let profile = TestDir::new(tag);
        let folder = TestDir::new(&format!("{tag}-folder"));
        std::fs::write(
            folder.path().join("mdbase.yaml"),
            b"spec_version: 0.3.0\nsettings:\n  timezone: UTC\n",
        )
        .unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let status = Arc::new(Shared::new(Value::Null));
        let seen = Arc::new(Shared::new(Vec::new()));
        tokio::spawn(control_plane(listener, status.clone(), seen.clone()));
        let mut daemon = crate::server::tests::daemon(&profile);
        let mut trust = crate::trust::fixture_trust();
        trust.cp_origin = origin.clone();
        {
            let owned = Arc::get_mut(&mut daemon).unwrap();
            owned.trust = Some(Arc::new(trust.clone()));
            owned.identity = Default::default();
        }
        let asked = Arc::new(Declines::default());
        daemon.set_confirmer(asked.clone());
        crate::server::initialize(daemon.clone()).await;
        let epoch = daemon.begin_pairing().await.unwrap();
        daemon
            .publish_pairing(
                epoch,
                crate::cloud::CloudConfig {
                    schema_version: 1,
                    account_epoch: epoch,
                    connector_id: Some("connector".into()),
                    server_url: origin,
                    ..Default::default()
                },
                "11111111-1111-4111-8111-111111111111",
                b"con_hermetic_fixture",
            )
            .await
            .unwrap();
        let added = daemon
            .add(crate::control::AddCollection {
                path: folder.path().to_path_buf(),
                name: Some("[test] mode switch".into()),
                remove_legacy_identity: false,
            })
            .await
            .unwrap();
        let id = added["id"].as_str().unwrap().to_owned();
        let barrier = daemon
            .inner
            .lock()
            .await
            .hosts
            .iter()
            .find(|host| host.entry().id == id)
            .unwrap()
            .barrier()
            .expect("opener has a retained runtime slot");
        tokio::time::timeout(Duration::from_secs(20), barrier.wait())
            .await
            .expect("background opener barrier completes");
        daemon.serving(&id).await.unwrap();
        // Registered as a cloud copy on this computer.
        crate::sync::SyncConfig {
            schema_version: 2,
            environment: trust.environment.clone(),
            collection_id: id.clone(),
            log_url: trust.log_origin.clone(),
            genesis_hash: "cd".repeat(32),
            chosen_state: "cloud_copy".into(),
            trusted_signers: vec![],
            user_enabled_cloud_copy: true,
        }
        .save(
            &daemon.profile.collection_dir(&id).join(crate::sync::FILE),
            &crate::attest::uuid_bytes(&id).unwrap(),
            &trust,
        )
        .unwrap();
        {
            let mut inner = daemon.inner.lock().await;
            let entry = inner
                .registry
                .collections
                .iter_mut()
                .find(|entry| entry.id == id)
                .unwrap();
            entry.mode = crate::registry::SyncMode::Synced;
            daemon.authority.publish_registry(&inner.registry);
        }
        Live {
            _profile: profile,
            _folder: folder,
            daemon,
            id,
            status,
            seen,
            asked,
        }
    }

    #[tokio::test]
    async fn mode_status_reports_the_servers_mode_not_this_computers() {
        let f = live("mode-status-server").await;
        f.serve("private", false);
        let status = f.daemon.collection_mode_status(&f.id).await.unwrap();
        assert_eq!(status, *f.status.lock().unwrap());
        assert_eq!(status["current_mode"], "private");
        f.close().await;
    }

    #[tokio::test]
    async fn switches_that_cannot_run_or_resume_refuse_before_consent() {
        let f = live("mode-switch-refusals").await;
        // The server cannot execute a switch: refused before the dialog.
        f.serve("private", false);
        let error = f
            .daemon
            .change_collection_mode(f.change("cloud_copy", false))
            .await
            .unwrap_err();
        assert_eq!(error.reason.as_deref(), Some("mode_switch_unavailable"));
        assert_eq!(f.asked.0.load(Ordering::SeqCst), 0);
        f.untouched();
        // Nothing retained here: resuming is an error, not progress, and never
        // asks for consent.
        for execution_available in [false, true] {
            f.serve("private", execution_available);
            let error = f
                .daemon
                .change_collection_mode(f.change("cloud_copy", true))
                .await
                .unwrap_err();
            assert_eq!(error.reason.as_deref(), Some("mode_nothing_to_resume"));
        }
        assert_eq!(f.asked.0.load(Ordering::SeqCst), 0);
        f.untouched();
        // With the executor present the same switch reaches the dialog.
        f.serve("private", true);
        let error = f
            .daemon
            .change_collection_mode(f.change("cloud_copy", false))
            .await
            .unwrap_err();
        assert_eq!(error.reason.as_deref(), Some("not_confirmed"));
        assert_eq!(f.asked.0.load(Ordering::SeqCst), 1);
        f.untouched();
        f.close().await;
    }
}
