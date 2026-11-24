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

#[test]
fn terminal_pre_publication_refusals_are_explicitly_enumerated() {
    let terminal = [
        CloudError::Server(400, "invalid_request".into()),
        CloudError::Server(404, "not_found".into()),
        CloudError::Server(409, "mode_cancelled".into()),
        CloudError::Server(409, "mode_changed".into()),
        CloudError::Server(409, "not_current".into()),
        CloudError::Server(409, "not_member".into()),
        CloudError::Server(409, "device_revoked".into()),
    ];
    for err in &terminal {
        assert!(
            is_terminal_pre_publication_refusal(false, err),
            "expected terminal before publication: {err:?}"
        );
        assert!(
            !is_terminal_pre_publication_refusal(true, err),
            "must never auto-cancel during /finish: {err:?}"
        );
    }

    let non_terminal = [
        CloudError::RateLimited(Some(10)),
        CloudError::RateLimited(None),
        CloudError::Server(409, "mode_source_changed".into()),
        CloudError::Server(409, "mode_abandoned".into()),
        CloudError::Server(409, "keyed_owner_required".into()),
        CloudError::Server(409, "mode_devices_need_update".into()),
        CloudError::Server(409, "mode_already_published".into()),
        CloudError::Server(409, "unknown_future_code".into()),
        CloudError::Server(403, "identity_not_current".into()),
        CloudError::Server(429, "rate_limited".into()),
        CloudError::Server(503, "not_ready".into()),
        CloudError::Unauthenticated,
        CloudError::Network("connection reset".into()),
        CloudError::Local("account_changed".into()),
    ];
    for err in &non_terminal {
        assert!(
            !is_terminal_pre_publication_refusal(false, err),
            "must not auto-cancel on {err:?}"
        );
        assert!(
            !is_terminal_pre_publication_refusal(true, err),
            "must not auto-cancel during finish on {err:?}"
        );
    }
}

#[test]
fn wait_phrase_and_backoff_helpers_format_and_bound() {
    // 2026-01-01T00:00:00Z
    let now_ms: u64 = 1_767_225_600_000;
    assert_eq!(parse_rfc3339_ms("2026-01-01T00:00:00Z"), Some(now_ms));
    assert_eq!(parse_rfc3339_ms("not-a-timestamp"), None);
    assert_eq!(
        format_wait_phrase("2026-01-01T00:12:00Z", now_ms).as_deref(),
        Some("about 12 min")
    );
    assert_eq!(
        format_wait_phrase("2026-01-01T00:01:00Z", now_ms).as_deref(),
        Some("about 1 min")
    );
    assert_eq!(
        format_wait_phrase("2026-01-01T00:00:20Z", now_ms).as_deref(),
        Some("about 20 s")
    );
    assert_eq!(format_wait_phrase("2026-01-01T00:00:00Z", now_ms), None);
    assert_eq!(format_wait_phrase("2025-12-31T23:59:00Z", now_ms), None);

    assert_eq!(backoff_delay(1), INITIAL_BACKOFF);
    assert!(backoff_delay(3) >= backoff_delay(2));
    assert_eq!(backoff_delay(100), MAX_BACKOFF);
    assert_eq!(rate_limit_delay(Some(12), 1), Duration::from_secs(12));
    assert_eq!(rate_limit_delay(Some(9999), 1), MAX_RATE_LIMIT_WAIT);
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
        fn ask<'a>(
            &'a self,
            _: &'a crate::confirm::Prompt,
        ) -> crate::session::BoxFuture<'a, Answer> {
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
        fn change(&self, target_mode: Option<&str>, cancel: bool) -> ChangeMode {
            ChangeMode {
                collection: self.id.clone(),
                target_mode: target_mode.map(str::to_owned),
                cancel,
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
    async fn switches_that_cannot_run_refuse_before_consent_and_cancel_accepts_omitted_target() {
        let f = live("mode-switch-refusals").await;
        // The server cannot execute a switch: refused before the dialog.
        f.serve("private", false);
        let error = f
            .daemon
            .change_collection_mode(f.change(Some("cloud_copy"), false))
            .await
            .unwrap_err();
        assert_eq!(error.reason.as_deref(), Some("mode_switch_unavailable"));
        assert_eq!(f.asked.0.load(Ordering::SeqCst), 0);
        f.untouched();

        // Different target while another switch is active on the server: refused before consent.
        *f.status.lock().unwrap() = json!({
            "collection_id": f.id,
            "current_mode": "cloud_copy",
            "execution_available": true,
            "change": {
                "request_id": "44444444-4444-4444-8444-444444444444",
                "source_mode": "cloud_copy",
                "target_mode": "private",
                "phase": "waiting_for_token_expiry",
            },
        });
        let error = f
            .daemon
            .change_collection_mode(f.change(Some("cloud_copy"), false))
            .await
            .unwrap_err();
        assert_eq!(error.reason.as_deref(), Some("mode_change_in_progress"));
        assert_eq!(f.asked.0.load(Ordering::SeqCst), 0);
        f.untouched();

        // Cancel without target_mode when idle returns cancelled without confirmation.
        f.serve("private", true);
        let cancelled = f
            .daemon
            .change_collection_mode(f.change(None, true))
            .await
            .unwrap();
        assert_eq!(cancelled["phase"], "cancelled");
        assert_eq!(f.asked.0.load(Ordering::SeqCst), 0);
        f.untouched();

        // Missing target_mode without cancel is rejected.
        let error = f
            .daemon
            .change_collection_mode(f.change(None, false))
            .await
            .unwrap_err();
        assert_eq!(error.reason.as_deref(), Some("target_mode"));
        assert_eq!(f.asked.0.load(Ordering::SeqCst), 0);

        // With the executor present the switch reaches the dialog.
        let error = f
            .daemon
            .change_collection_mode(f.change(Some("cloud_copy"), false))
            .await
            .unwrap_err();
        assert_eq!(error.reason.as_deref(), Some("not_confirmed"));
        assert_eq!(f.asked.0.load(Ordering::SeqCst), 1);
        f.untouched();
        f.close().await;
    }
}

/// Real-replica + in-memory log server + loopback control-plane tests for the
/// daemon-owned background mode driver and retry/cancellation boundaries.
#[cfg(unix)]
mod driver {
    use super::*;
    use crate::collections::CollectionHost;
    use crate::confirm::{Answer, Confirmer};
    use crate::registry::{Entry, Origin, SyncMode};
    use crate::secrets::{MemoryStore, SecretError, SecretStore};
    use crate::server::tests::mirror_join_tests::{
        CP_LABEL, admin_log_rpc, create_log, device_token,
    };
    use crate::sync::SyncConfig;
    use crate::testutil::TestDir;
    use mdbn_log_server::{AnyService, Gateway};
    use mdbn_log_service::Service;
    use mdbn_log_service::mem::{MemBackend, MemObjects};
    use mdbn_log_service::testkit::{ControlPlane, Device};
    use mdbn_replica::policy::SERVICE_ACCOUNT;
    use mdbn_wire::common::{B16, B32, Bytes};
    use mdbn_wire::log_service::{AppendParams, HeadParams, HeadResult};
    use mdbn_wire::policy::{
        CState, CollectionState as WireCollectionState, DeviceEnrol, DeviceKind, DeviceRevoke,
        Genesis, MemberSet, PolicyOp, Role,
    };
    use mdbn_wire::schema::Wire;
    use std::collections::VecDeque;
    use std::sync::Mutex as Shared;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    #[derive(Default)]
    struct TestKeychain(MemoryStore);
    impl SecretStore for TestKeychain {
        fn get(&self, key: &str) -> Result<Option<zeroize::Zeroizing<Vec<u8>>>, SecretError> {
            self.0.get(key)
        }
        fn set(&self, key: &str, value: &[u8]) -> Result<(), SecretError> {
            self.0.set(key, value)
        }
        fn delete(&self, key: &str) -> Result<(), SecretError> {
            self.0.delete(key)
        }
        fn backend(&self) -> &'static str {
            "keychain"
        }
    }

    #[derive(Default)]
    struct Accepts(AtomicU64);
    impl Confirmer for Accepts {
        fn ask<'a>(
            &'a self,
            _: &'a crate::confirm::Prompt,
        ) -> crate::session::BoxFuture<'a, Answer> {
            self.0.fetch_add(1, Ordering::SeqCst);
            Box::pin(async { Answer::Yes })
        }
    }

    enum PrepareAction {
        PublishAndFinish,
        WaitForTokenExpiry(u64),
        Raw {
            status: u16,
            retry_after: Option<u64>,
            body: Value,
        },
    }

    enum FinishAction {
        Complete,
        NotReady,
        Raw {
            status: u16,
            retry_after: Option<u64>,
            body: Value,
        },
    }

    struct MockCpState {
        current_mode: String,
        active_request: Option<String>,
        source_mode: Option<String>,
        target_mode: Option<String>,
        phase: String,
        retry_at: Option<String>,
        published: bool,
        prepare_queue: VecDeque<PrepareAction>,
        finish_queue: VecDeque<FinishAction>,
        device_names: BTreeMap<String, String>,
        intent_calls: usize,
        request_status_calls: usize,
        prepare_calls: usize,
        prepare_times_ms: Vec<u64>,
        finish_calls: usize,
        delete_calls: usize,
    }

    impl MockCpState {
        fn new(initial_mode: &str) -> Self {
            Self {
                current_mode: initial_mode.into(),
                active_request: None,
                source_mode: None,
                target_mode: None,
                phase: String::new(),
                retry_at: None,
                published: false,
                prepare_queue: VecDeque::new(),
                finish_queue: VecDeque::new(),
                device_names: BTreeMap::new(),
                intent_calls: 0,
                request_status_calls: 0,
                prepare_calls: 0,
                prepare_times_ms: Vec::new(),
                finish_calls: 0,
                delete_calls: 0,
            }
        }
    }

    struct DriverFixture {
        profile: TestDir,
        secrets: Arc<dyn SecretStore>,
        trust: Arc<crate::trust::Trust>,
        collection: B16,
        state: Arc<Shared<MockCpState>>,
        daemon: Arc<Daemon>,
        asked: Arc<Accepts>,
        driver_task: tokio::task::JoinHandle<()>,
        cp_task: tokio::task::JoinHandle<()>,
        log_task: tokio::task::JoinHandle<std::io::Result<()>>,
    }

    fn new_uuid_v7() -> [u8; 16] {
        let s = crate::secrets::new_uuid().unwrap();
        crate::attest::uuid_bytes(&s).unwrap()
    }

    fn format_rfc3339_ms(ms: u64) -> String {
        let nanos = i128::from(ms) * 1_000_000;
        time::OffsetDateTime::from_unix_timestamp_nanos(nanos)
            .unwrap()
            .format(&time::format_description::well_known::Rfc3339)
            .unwrap()
    }

    async fn read_http(socket: &mut tokio::net::TcpStream) -> Option<(String, String, Value)> {
        let mut raw = Vec::new();
        let header_end;
        loop {
            let mut buf = [0u8; 4096];
            let n = socket.read(&mut buf).await.ok()?;
            if n == 0 {
                return None;
            }
            raw.extend_from_slice(&buf[..n]);
            if let Some(pos) = raw.windows(4).position(|w| w == b"\r\n\r\n") {
                header_end = pos + 4;
                break;
            }
        }
        let head = String::from_utf8_lossy(&raw[..header_end]).into_owned();
        let content_len: usize = head
            .lines()
            .find_map(|line| {
                let (k, v) = line.split_once(':')?;
                k.eq_ignore_ascii_case("content-length")
                    .then(|| v.trim().parse().ok())
                    .flatten()
            })
            .unwrap_or(0);
        while raw.len() < header_end + content_len {
            let mut buf = [0u8; 4096];
            let n = socket.read(&mut buf).await.ok()?;
            if n == 0 {
                break;
            }
            raw.extend_from_slice(&buf[..n]);
        }
        let first = head.lines().next().unwrap_or_default();
        let mut parts = first.split_whitespace();
        let method = parts.next().unwrap_or_default().to_string();
        let path = parts.next().unwrap_or_default().to_string();
        let body = serde_json::from_slice(&raw[header_end..]).unwrap_or(Value::Null);
        Some((method, path, body))
    }

    async fn write_http(
        socket: &mut tokio::net::TcpStream,
        status: u16,
        retry_after: Option<u64>,
        body: &Value,
    ) {
        let text = body.to_string();
        let extra = retry_after
            .map(|secs| format!("Retry-After: {secs}\r\n"))
            .unwrap_or_default();
        let reply = format!(
            "HTTP/1.1 {status} Fixture\r\n{extra}Content-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{text}",
            text.len()
        );
        let _ = socket.write_all(reply.as_bytes()).await;
    }

    async fn append_policy(log_url: &str, cp: &ControlPlane, collection: B16, ops: Vec<PolicyOp>) {
        let head = HeadResult::from_cbor(
            &admin_log_rpc(
                log_url,
                cp,
                collection,
                "head",
                HeadParams { collection }.to_cbor(),
            )
            .await,
        )
        .unwrap();
        let item = cp.policy_item(
            collection,
            head.head + 1,
            head.head_chain,
            ops,
            mdbn_log_server::now_ms(),
        );
        admin_log_rpc(
            log_url,
            cp,
            collection,
            "append",
            AppendParams {
                collection,
                expect_seq: head.head + 1,
                expect_prev: head.head_chain,
                items: vec![Bytes(item)],
            }
            .to_cbor(),
        )
        .await;
    }

    #[allow(clippy::too_many_arguments)]
    async fn serve_mock_cp(
        listener: TcpListener,
        cp: Arc<ControlPlane>,
        log_url: String,
        collection: B16,
        owner_device: [u8; 16],
        owner_sign_pk: [u8; 32],
        hosted: Arc<Device>,
        escrow: Arc<Device>,
        state: Arc<Shared<MockCpState>>,
    ) {
        let col_str = collection.to_uuid_string();
        let mode_path = format!("/v1/next/collections/{col_str}/mode");
        let token_path = format!("/v1/next/collections/{col_str}/log-token");
        while let Ok((mut socket, _)) = listener.accept().await {
            let cp = cp.clone();
            let log_url = log_url.clone();
            let hosted = hosted.clone();
            let escrow = escrow.clone();
            let state = state.clone();
            let col_str = col_str.clone();
            let mode_path = mode_path.clone();
            let token_path = token_path.clone();
            tokio::spawn(async move {
                let Some((method, path, body)) = read_http(&mut socket).await else {
                    return;
                };
                if method == "POST" && path == "/v1/next/devices/challenge" {
                    write_http(
                        &mut socket,
                        200,
                        None,
                        &json!({"challenge": "ab".repeat(32)}),
                    )
                    .await;
                    return;
                }
                if method == "POST" && path == token_path {
                    let exp = crate::fsutil::now_ms() as i64 + 900_000;
                    let tok = device_token(owner_device, owner_sign_pk, collection.0, exp);
                    write_http(
                        &mut socket,
                        200,
                        None,
                        &json!({"token": tok, "expires_at": exp}),
                    )
                    .await;
                    return;
                }
                if method == "GET"
                    && path.starts_with("/v1/next/devices/")
                    && path.ends_with("/name")
                {
                    let dev = path
                        .trim_start_matches("/v1/next/devices/")
                        .trim_end_matches("/name");
                    let name = state.lock().unwrap().device_names.get(dev).cloned();
                    match name {
                        Some(name) => {
                            write_http(&mut socket, 200, None, &json!({"name": name})).await
                        }
                        None => {
                            write_http(
                                &mut socket,
                                404,
                                None,
                                &json!({"error":{"code":"not_found"}}),
                            )
                            .await
                        }
                    }
                    return;
                }
                if method == "GET" && path == mode_path {
                    let reply = {
                        let s = state.lock().unwrap();
                        let change = s.active_request.as_ref().and_then(|req| {
                            if matches!(s.phase.as_str(), "complete" | "cancelled") {
                                return None;
                            }
                            let mut obj = json!({
                                "collection_id": col_str,
                                "request_id": req,
                                "current_mode": s.current_mode,
                                "source_mode": s.source_mode,
                                "target_mode": s.target_mode,
                                "phase": s.phase,
                            });
                            if let Some(retry_at) = &s.retry_at {
                                obj["retry_at"] = json!(retry_at);
                            }
                            Some(obj)
                        });
                        json!({
                            "collection_id": col_str,
                            "current_mode": s.current_mode,
                            "execution_available": true,
                            "change": change,
                        })
                    };
                    write_http(&mut socket, 200, None, &reply).await;
                    return;
                }
                if method == "POST" && path == mode_path {
                    let req = body["request_id"].as_str().unwrap().to_string();
                    let target = body["target_mode"].as_str().unwrap().to_string();
                    let reply = {
                        let mut s = state.lock().unwrap();
                        s.intent_calls += 1;
                        if s.active_request.as_deref() != Some(req.as_str()) {
                            s.active_request = Some(req.clone());
                            s.source_mode = Some(s.current_mode.clone());
                            s.target_mode = Some(target.clone());
                            s.phase = "waiting_for_device".into();
                            s.retry_at = None;
                            s.published = false;
                        }
                        let mut obj = json!({
                            "collection_id": col_str,
                            "request_id": req,
                            "current_mode": s.current_mode,
                            "source_mode": s.source_mode,
                            "target_mode": s.target_mode,
                            "phase": s.phase,
                        });
                        if let Some(retry_at) = &s.retry_at {
                            obj["retry_at"] = json!(retry_at);
                        }
                        obj
                    };
                    write_http(&mut socket, 202, None, &reply).await;
                    return;
                }
                if method == "GET" && path.starts_with(&format!("{mode_path}/")) {
                    let req = path.trim_start_matches(&format!("{mode_path}/"));
                    let reply = {
                        let mut s = state.lock().unwrap();
                        s.request_status_calls += 1;
                        if s.active_request.as_deref() != Some(req) {
                            None
                        } else {
                            let mut obj = json!({
                                "collection_id": col_str,
                                "request_id": req,
                                "current_mode": s.current_mode,
                                "source_mode": s.source_mode,
                                "target_mode": s.target_mode,
                                "phase": s.phase,
                            });
                            if let Some(retry_at) = &s.retry_at {
                                obj["retry_at"] = json!(retry_at);
                            }
                            Some(obj)
                        }
                    };
                    match reply {
                        Some(obj) => write_http(&mut socket, 200, None, &obj).await,
                        None => {
                            write_http(
                                &mut socket,
                                404,
                                None,
                                &json!({"error":{"code":"not_found"}}),
                            )
                            .await
                        }
                    }
                    return;
                }
                if method == "DELETE" && path.starts_with(&format!("{mode_path}/")) {
                    let req = path.trim_start_matches(&format!("{mode_path}/"));
                    let resp = {
                        let mut s = state.lock().unwrap();
                        s.delete_calls += 1;
                        if s.active_request.as_deref() != Some(req) {
                            (404, json!({"error":{"code":"not_found"}}))
                        } else if s.published {
                            (409, json!({"error":{"code":"mode_already_published"}}))
                        } else {
                            s.phase = "cancelled".into();
                            s.retry_at = None;
                            (
                                200,
                                json!({
                                    "collection_id": col_str,
                                    "request_id": req,
                                    "phase": "cancelled",
                                    "target_mode": s.target_mode,
                                }),
                            )
                        }
                    };
                    write_http(&mut socket, resp.0, None, &resp.1).await;
                    return;
                }
                if method == "POST" && path.ends_with("/prepare") {
                    let req = path
                        .trim_start_matches(&format!("{mode_path}/"))
                        .trim_end_matches("/prepare")
                        .to_string();
                    let (action, target) = {
                        let mut s = state.lock().unwrap();
                        s.prepare_calls += 1;
                        s.prepare_times_ms.push(crate::fsutil::now_ms() as u64);
                        let action = s
                            .prepare_queue
                            .pop_front()
                            .unwrap_or(PrepareAction::PublishAndFinish);
                        (action, s.target_mode.clone().unwrap_or_default())
                    };
                    match action {
                        PrepareAction::PublishAndFinish => {
                            let ops = if target == "private" {
                                vec![
                                    PolicyOp::DeviceRevoke(DeviceRevoke { device: hosted.id }),
                                    PolicyOp::DeviceRevoke(DeviceRevoke { device: escrow.id }),
                                    PolicyOp::CollectionState(WireCollectionState {
                                        state: CState::E2e,
                                        compress: None,
                                        min_sem_major: None,
                                    }),
                                ]
                            } else {
                                vec![
                                    hosted.enrol(DeviceKind::Hosted),
                                    escrow.enrol(DeviceKind::Escrow),
                                    PolicyOp::CollectionState(WireCollectionState {
                                        state: CState::CloudCopy,
                                        compress: None,
                                        min_sem_major: None,
                                    }),
                                ]
                            };
                            append_policy(&log_url, &cp, collection, ops).await;
                            {
                                let mut s = state.lock().unwrap();
                                s.published = true;
                                s.phase = "finishing".into();
                                s.retry_at = None;
                                if target == "cloud_copy" {
                                    s.current_mode = "cloud_copy".into();
                                }
                            }
                            write_http(
                                &mut socket,
                                202,
                                None,
                                &json!({"request_id": req, "phase": "finishing"}),
                            )
                            .await;
                        }
                        PrepareAction::WaitForTokenExpiry(delay_ms) => {
                            let retry_at =
                                format_rfc3339_ms(crate::fsutil::now_ms() as u64 + delay_ms);
                            {
                                let mut s = state.lock().unwrap();
                                s.phase = "waiting_for_token_expiry".into();
                                s.retry_at = Some(retry_at.clone());
                            }
                            write_http(
                                &mut socket,
                                202,
                                None,
                                &json!({
                                    "request_id": req,
                                    "phase": "waiting_for_token_expiry",
                                    "retry_at": retry_at,
                                }),
                            )
                            .await;
                        }
                        PrepareAction::Raw {
                            status,
                            retry_after,
                            body,
                        } => {
                            write_http(&mut socket, status, retry_after, &body).await;
                        }
                    }
                    return;
                }
                if method == "POST" && path.ends_with("/finish") {
                    let req = path
                        .trim_start_matches(&format!("{mode_path}/"))
                        .trim_end_matches("/finish")
                        .to_string();
                    let action = {
                        let mut s = state.lock().unwrap();
                        s.finish_calls += 1;
                        s.finish_queue.pop_front().unwrap_or(FinishAction::Complete)
                    };
                    match action {
                        FinishAction::Complete => {
                            {
                                let mut s = state.lock().unwrap();
                                s.phase = "complete".into();
                                if let Some(target) = s.target_mode.clone() {
                                    s.current_mode = target;
                                }
                            }
                            write_http(
                                &mut socket,
                                200,
                                None,
                                &json!({"request_id": req, "phase": "complete"}),
                            )
                            .await;
                        }
                        FinishAction::NotReady => {
                            write_http(
                                &mut socket,
                                503,
                                None,
                                &json!({"error": {"code": "not_ready"}}),
                            )
                            .await;
                        }
                        FinishAction::Raw {
                            status,
                            retry_after,
                            body,
                        } => {
                            write_http(&mut socket, status, retry_after, &body).await;
                        }
                    }
                    return;
                }
                write_http(
                    &mut socket,
                    404,
                    None,
                    &json!({"error": {"code": "not_found"}}),
                )
                .await;
            });
        }
    }

    impl DriverFixture {
        async fn start(tag: &str, initial_private: bool) -> Self {
            let cp = Arc::new(ControlPlane::new(CP_LABEL));
            let log_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let log_url = format!("http://{}", log_listener.local_addr().unwrap());
            let log_task = tokio::spawn(mdbn_log_server::serve(
                Gateway::new(
                    AnyService::Mem(Service::new(
                        MemBackend::default(),
                        MemObjects::default(),
                        mdbn_log_server::testkit_config(CP_LABEL, &log_url),
                    )),
                    false,
                ),
                log_listener,
            ));
            let cp_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let trust = Arc::new(crate::trust::Trust {
                environment: crate::trust::Environment::Lab.name().into(),
                cp_origin: format!("http://{}", cp_listener.local_addr().unwrap()),
                log_origin: log_url.clone(),
                roots: vec![cp.root_pk().0],
                policy_pins: crate::trust::pins_for(
                    cp.root_pk().0,
                    cp.transport_key().verifying_key().to_bytes(),
                ),
            });
            let profile = TestDir::new(tag);
            let secrets: Arc<dyn SecretStore> = Arc::new(TestKeychain::default());
            let collection = B16(new_uuid_v7());
            let owner = B16(new_uuid_v7());
            let hosted = Arc::new(Device::new("hosted-mode", SERVICE_ACCOUNT));
            let escrow = Arc::new(Device::new("escrow-mode", SERVICE_ACCOUNT));
            let state = Arc::new(Shared::new(MockCpState::new(if initial_private {
                "private"
            } else {
                "cloud_copy"
            })));

            let mut daemon = crate::server::tests::daemon(&profile);
            {
                let owned = Arc::get_mut(&mut daemon).unwrap();
                owned.secrets = secrets.clone();
                owned.trust = Some(trust.clone());
            }
            assert!(daemon.self_weak.set(Arc::downgrade(&daemon)).is_ok());
            let asked = Arc::new(Accepts::default());
            daemon.set_confirmer(asked.clone());
            let epoch = daemon.begin_pairing().await.unwrap();
            daemon
                .publish_pairing(
                    epoch,
                    crate::cloud::CloudConfig {
                        schema_version: 1,
                        account_epoch: epoch,
                        connector_id: Some(B16(new_uuid_v7()).to_uuid_string()),
                        server_url: trust.cp_origin.clone(),
                        ..Default::default()
                    },
                    &owner.to_uuid_string(),
                    b"con_hermetic_fixture",
                )
                .await
                .unwrap();

            let identity = daemon.identity.get().unwrap();
            let public = identity.public();
            let decode = |hex: &str| crate::secrets::hex_decode(hex).unwrap().try_into().unwrap();
            let owner_device = identity.device_id;
            let owner_sign_pk: [u8; 32] = decode(&public.sign_pk);
            let owner_kem_pk: [u8; 32] = decode(&public.kem_pk);
            let owner_noise_pk: [u8; 32] = decode(&public.noise_pk);

            let mut genesis_ops = vec![
                PolicyOp::Genesis(Genesis {
                    owner,
                    root: mdbn_log_service::policy::key_id(&cp.root_pk()),
                    state: if initial_private {
                        CState::E2e
                    } else {
                        CState::CloudCopy
                    },
                }),
                PolicyOp::MemberSet(MemberSet {
                    account: owner,
                    role: Role::Owner,
                }),
                PolicyOp::DeviceEnrol(DeviceEnrol {
                    device: B16(owner_device),
                    account: owner,
                    kind: DeviceKind::Desktop,
                    sign_pk: B32(owner_sign_pk),
                    kem_pk: B32(owner_kem_pk),
                    noise_pk: B32(owner_noise_pk),
                    sas_commit: None,
                    local_root: None,
                }),
            ];
            if !initial_private {
                genesis_ops.push(hosted.enrol(DeviceKind::Hosted));
                genesis_ops.push(escrow.enrol(DeviceKind::Escrow));
            }
            let genesis = cp.policy_item(collection, 1, B32([0; 32]), genesis_ops, 1);
            let pin = mdbn_wire::hash::chain_hash(&genesis);
            create_log(&log_url, &cp, collection, genesis).await;

            let cp_task = tokio::spawn(serve_mock_cp(
                cp_listener,
                cp.clone(),
                log_url.clone(),
                collection,
                owner_device,
                owner_sign_pk,
                hosted.clone(),
                escrow.clone(),
                state.clone(),
            ));

            let id = collection.to_uuid_string();
            let root = daemon.profile.state_dir.join("notes");
            std::fs::create_dir_all(&root).unwrap();
            std::fs::write(
                root.join("mdbase.yaml"),
                b"spec_version: 0.3.0\nsettings:\n  timezone: UTC\n",
            )
            .unwrap();
            let ctx = daemon.host_ctx().unwrap();
            let link = SyncConfig::path(&ctx.collections_dir, &id);
            std::fs::create_dir_all(link.parent().unwrap()).unwrap();
            SyncConfig {
                schema_version: 2,
                environment: trust.environment.clone(),
                collection_id: id.clone(),
                log_url: trust.log_origin.clone(),
                genesis_hash: crate::secrets::hex(&pin.0),
                chosen_state: if initial_private {
                    "private"
                } else {
                    "cloud_copy"
                }
                .into(),
                trusted_signers: if initial_private {
                    vec![B16(owner_device).to_uuid_string()]
                } else {
                    vec![]
                },
                user_enabled_cloud_copy: !initial_private,
            }
            .save(&link, &collection.0, &trust)
            .unwrap();
            let entry = Entry {
                id: id.clone(),
                name: "Notes".into(),
                root,
                replica_id: B16(new_uuid_v7()).to_uuid_string(),
                mode: if initial_private {
                    SyncMode::SyncedE2e
                } else {
                    SyncMode::Synced
                },
                origin: Origin::Created,
                description: None,
                added_at_ms: 0,
                paused: false,
                ever_e2e: initial_private,
                owner_account: Some(owner.to_uuid_string()),
                device: Some(B16(owner_device).to_uuid_string()),
            };
            {
                let mut inner = daemon.inner.lock().await;
                inner.registry.collections = vec![entry.clone()];
                inner
                    .registry
                    .save(&daemon.profile.registry_file())
                    .unwrap();
                daemon.authority.publish_registry(&inner.registry);
                inner.hosts.push(CollectionHost::open(entry, Some(ctx)));
            }
            daemon.readiness.send_modify(|r| {
                r.ready = true;
                r.safe_reason = None;
            });
            let driver_task = tokio::spawn(daemon.clone().collection_mode_drive());

            let fixture = Self {
                profile,
                secrets,
                trust,
                collection,
                state,
                daemon,
                asked,
                driver_task,
                cp_task,
                log_task,
            };
            fixture.wait_ready().await;
            fixture
        }

        fn id(&self) -> String {
            self.collection.to_uuid_string()
        }

        async fn wait_ready(&self) {
            let id = self.id();
            tokio::time::timeout(Duration::from_secs(15), async {
                loop {
                    let statuses = self.daemon.collection_statuses().await;
                    if statuses
                        .iter()
                        .any(|s| s.id == id && s.state == CollectionState::Ready)
                    {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(50)).await;
                }
            })
            .await
            .expect("collection never became ready");
        }

        async fn wait_request_cleared(&self) {
            let path = self.daemon.profile.collection_dir(&self.id()).join(FILE);
            tokio::time::timeout(Duration::from_secs(15), async {
                while path.exists() {
                    tokio::time::sleep(Duration::from_millis(30)).await;
                }
            })
            .await
            .expect("mode-request.json was never cleared by the driver");
        }

        async fn restart(&mut self) {
            self.daemon.shutdown.send_replace(true);
            let _ = (&mut self.driver_task).await;
            {
                let mut inner = self.daemon.inner.lock().await;
                for host in &mut inner.hosts {
                    host.close().await;
                }
            }
            let mut next = crate::server::tests::daemon(&self.profile);
            {
                let owned = Arc::get_mut(&mut next).unwrap();
                owned.secrets = self.secrets.clone();
                owned.trust = Some(self.trust.clone());
                owned.identity = Default::default();
            }
            assert!(next.self_weak.set(Arc::downgrade(&next)).is_ok());
            let asked = Arc::new(Accepts::default());
            next.set_confirmer(asked.clone());
            crate::server::initialize(next.clone()).await;
            self.driver_task = tokio::spawn(next.clone().collection_mode_drive());
            self.daemon = next;
            self.asked = asked;
            self.wait_ready().await;
        }

        async fn close(mut self) {
            self.daemon.shutdown.send_replace(true);
            let _ = (&mut self.driver_task).await;
            {
                let mut inner = self.daemon.inner.lock().await;
                for host in &mut inner.hosts {
                    host.close().await;
                }
            }
            self.cp_task.abort();
            self.log_task.abort();
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn private_to_cloud_copy_advances_through_not_ready_to_complete_automatically() {
        let f = DriverFixture::start("driver-p2c", true).await;
        {
            let mut s = f.state.lock().unwrap();
            s.prepare_queue.push_back(PrepareAction::PublishAndFinish);
            s.finish_queue.push_back(FinishAction::NotReady);
            s.finish_queue.push_back(FinishAction::NotReady);
            s.finish_queue.push_back(FinishAction::Complete);
        }
        let first = f
            .daemon
            .change_collection_mode(ChangeMode {
                collection: f.id(),
                target_mode: Some("cloud_copy".into()),
                cancel: false,
            })
            .await
            .unwrap();
        assert_eq!(first["phase"], "finishing");
        assert_eq!(f.asked.0.load(Ordering::SeqCst), 1);

        // Calling sync mode with the same target while in flight reports progress with no new dialog.
        let second = f
            .daemon
            .change_collection_mode(ChangeMode {
                collection: f.id(),
                target_mode: Some("cloud_copy".into()),
                cancel: false,
            })
            .await
            .unwrap();
        assert!(matches!(
            second["phase"].as_str(),
            Some("finishing" | "complete")
        ));
        assert_eq!(f.asked.0.load(Ordering::SeqCst), 1);

        // Wait for the background driver to finish through both 503 not_ready retries.
        f.wait_request_cleared().await;
        {
            let s = f.state.lock().unwrap();
            assert_eq!(s.phase, "complete");
            assert_eq!(s.current_mode, "cloud_copy");
            assert!(
                s.finish_calls >= 3,
                "expected retries through 503 not_ready"
            );
            assert_eq!(s.delete_calls, 0);
        }

        let statuses = f.daemon.collection_statuses().await;
        assert_eq!(statuses[0].mode, SyncMode::Synced);
        assert!(
            !statuses[0]
                .notices
                .iter()
                .any(|n| n.code.starts_with("mode_switch_"))
        );
        f.close().await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn cloud_copy_to_private_honours_retry_at_and_finishes_automatically() {
        let f = DriverFixture::start("driver-c2p-retry-at", false).await;
        let delay_ms = 450;
        {
            let mut s = f.state.lock().unwrap();
            s.prepare_queue
                .push_back(PrepareAction::WaitForTokenExpiry(delay_ms));
            s.prepare_queue.push_back(PrepareAction::PublishAndFinish);
            s.finish_queue.push_back(FinishAction::Complete);
        }
        let started_ms = crate::fsutil::now_ms() as u64;
        let first = f
            .daemon
            .change_collection_mode(ChangeMode {
                collection: f.id(),
                target_mode: Some("private".into()),
                cancel: false,
            })
            .await
            .unwrap();
        assert_eq!(first["phase"], "waiting_for_token_expiry");
        assert_eq!(f.asked.0.load(Ordering::SeqCst), 1);

        // A different target while the retained request is in flight is refused clearly.
        let wrong_target = f
            .daemon
            .change_collection_mode(ChangeMode {
                collection: f.id(),
                target_mode: Some("cloud_copy".into()),
                cancel: false,
            })
            .await
            .unwrap_err();
        assert_eq!(
            wrong_target.reason.as_deref(),
            Some("mode_change_in_progress")
        );
        assert_eq!(f.asked.0.load(Ordering::SeqCst), 1);

        // Notice reflects token-expiry wait before retry_at elapses.
        let statuses = f.daemon.collection_statuses().await;
        assert!(statuses[0].notices.iter().any(|n| {
            n.code == "mode_switch_in_progress"
                && n.message.contains("older app connections to expire")
        }));

        f.wait_request_cleared().await;
        {
            let s = f.state.lock().unwrap();
            assert_eq!(s.phase, "complete");
            assert_eq!(s.current_mode, "private");
            assert_eq!(s.prepare_calls, 2);
            assert!(
                s.prepare_times_ms[1] >= started_ms + delay_ms,
                "second /prepare ran before retry_at: {:?}",
                s.prepare_times_ms
            );
            assert_eq!(s.finish_calls, 1);
            assert_eq!(s.delete_calls, 0);
        }

        let statuses = f.daemon.collection_statuses().await;
        assert_eq!(statuses[0].mode, SyncMode::SyncedE2e);
        f.close().await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn driver_resumes_retained_request_after_daemon_restart_without_reconfirming() {
        let mut f = DriverFixture::start("driver-restart", true).await;
        {
            let mut s = f.state.lock().unwrap();
            s.prepare_queue.push_back(PrepareAction::PublishAndFinish);
            for _ in 0..20 {
                s.finish_queue.push_back(FinishAction::NotReady);
            }
        }
        let first = f
            .daemon
            .change_collection_mode(ChangeMode {
                collection: f.id(),
                target_mode: Some("cloud_copy".into()),
                cancel: false,
            })
            .await
            .unwrap();
        assert_eq!(first["phase"], "finishing");
        assert!(f.daemon.profile.collection_dir(&f.id()).join(FILE).exists());

        // Restart the daemon while mode-request.json is retained, then let /finish succeed.
        f.restart().await;
        assert_eq!(f.asked.0.load(Ordering::SeqCst), 0);
        {
            let mut s = f.state.lock().unwrap();
            s.finish_queue.clear();
            s.finish_queue.push_back(FinishAction::Complete);
        }
        f.wait_request_cleared().await;
        assert_eq!(f.asked.0.load(Ordering::SeqCst), 0);
        assert_eq!(f.state.lock().unwrap().phase, "complete");
        assert_eq!(f.state.lock().unwrap().delete_calls, 0);
        f.close().await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn retryable_409_mode_source_changed_and_429_retry_without_cancelling() {
        let f = DriverFixture::start("driver-retryable-b2", false).await;
        {
            let mut s = f.state.lock().unwrap();
            s.prepare_queue.push_back(PrepareAction::Raw {
                status: 409,
                retry_after: None,
                body: json!({"error": {"code": "mode_source_changed"}}),
            });
            s.prepare_queue.push_back(PrepareAction::Raw {
                status: 429,
                retry_after: Some(0),
                body: json!({"error": {"code": "rate_limited"}}),
            });
            s.prepare_queue.push_back(PrepareAction::PublishAndFinish);
            s.finish_queue.push_back(FinishAction::Complete);
        }
        let first = f
            .daemon
            .change_collection_mode(ChangeMode {
                collection: f.id(),
                target_mode: Some("private".into()),
                cancel: false,
            })
            .await
            .unwrap();
        assert_eq!(first["phase"], "publishing_policy");
        f.wait_request_cleared().await;
        {
            let s = f.state.lock().unwrap();
            assert_eq!(s.phase, "complete");
            assert_eq!(s.prepare_calls, 3);
            assert_eq!(s.finish_calls, 1);
            assert_eq!(s.delete_calls, 0, "retryable errors must never cancel");
        }
        let statuses = f.daemon.collection_statuses().await;
        assert_eq!(statuses[0].mode, SyncMode::SyncedE2e);
        f.close().await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn terminal_pre_publication_refusal_cancels_and_cleans_up() {
        let f = DriverFixture::start("driver-terminal-cancel", true).await;
        {
            let mut s = f.state.lock().unwrap();
            s.prepare_queue.push_back(PrepareAction::Raw {
                status: 409,
                retry_after: None,
                body: json!({"error": {"code": "mode_changed"}}),
            });
        }
        let err = f
            .daemon
            .change_collection_mode(ChangeMode {
                collection: f.id(),
                target_mode: Some("cloud_copy".into()),
                cancel: false,
            })
            .await
            .unwrap_err();
        assert_eq!(err.reason.as_deref(), Some("sync_refused"));
        assert!(err.message.contains("mode_changed"), "{err:?}");
        assert!(!f.daemon.profile.collection_dir(&f.id()).join(FILE).exists());
        assert_eq!(f.state.lock().unwrap().delete_calls, 1);
        let statuses = f.daemon.collection_statuses().await;
        assert_eq!(statuses[0].mode, SyncMode::SyncedE2e);
        f.close().await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn stops_on_waiting_for_devices_and_clears_abandoned_without_cancelling() {
        // Part A: waiting_for_devices stops the driver, resolves computer name, surfaces notice.
        let f = DriverFixture::start("driver-person-needed", false).await;
        let owner_device = f.daemon.identity.get().unwrap().public().device;
        {
            let mut s = f.state.lock().unwrap();
            s.device_names
                .insert(owner_device.clone(), "Old ThinkPad".into());
            s.prepare_queue.push_back(PrepareAction::Raw {
                status: 409,
                retry_after: None,
                body: json!({
                    "error": {"code": "mode_devices_need_update"},
                    "devices": [owner_device],
                }),
            });
        }
        let reply = f
            .daemon
            .change_collection_mode(ChangeMode {
                collection: f.id(),
                target_mode: Some("private".into()),
                cancel: false,
            })
            .await
            .unwrap();
        assert_eq!(reply["phase"], "waiting_for_devices");
        assert_eq!(reply["device_names"][&owner_device], "Old ThinkPad");
        // Confirm the driver stopped instead of spinning.
        tokio::time::sleep(Duration::from_millis(180)).await;
        assert_eq!(f.state.lock().unwrap().prepare_calls, 1);
        assert_eq!(f.state.lock().unwrap().delete_calls, 0);
        assert!(f.daemon.profile.collection_dir(&f.id()).join(FILE).exists());
        let statuses = f.daemon.collection_statuses().await;
        let notice = statuses[0]
            .notices
            .iter()
            .find(|n| n.code == "mode_switch_devices_need_update")
            .expect("expected mode_switch_devices_need_update notice");
        assert!(notice.message.contains("Old ThinkPad"));
        f.close().await;

        // Part B: 409 mode_abandoned clears the local journal WITHOUT calling DELETE.
        let f = DriverFixture::start("driver-abandoned", true).await;
        {
            let mut s = f.state.lock().unwrap();
            s.prepare_queue.push_back(PrepareAction::PublishAndFinish);
            s.finish_queue.push_back(FinishAction::Raw {
                status: 409,
                retry_after: None,
                body: json!({"error": {"code": "mode_abandoned"}}),
            });
        }
        let first = f
            .daemon
            .change_collection_mode(ChangeMode {
                collection: f.id(),
                target_mode: Some("cloud_copy".into()),
                cancel: false,
            })
            .await
            .unwrap();
        assert_eq!(first["phase"], "finishing");
        f.wait_request_cleared().await;
        {
            let s = f.state.lock().unwrap();
            assert_eq!(s.finish_calls, 1);
            assert_eq!(s.delete_calls, 0, "abandoned switch must never call DELETE");
        }
        f.close().await;
    }
}
