use super::*;
use crate::testutil::TestDir;
use std::sync::atomic::{AtomicU64, Ordering};

fn request() -> Request {
    Request {
        collection: "11111111-1111-4111-8111-111111111111".into(),
        account: "22222222-2222-4222-8222-222222222222".into(),
        device: "33333333-3333-4333-8333-333333333333".into(),
        genesis: "ab".repeat(32),
        generation: Some("cd".repeat(32)),
        confirmed: true,
        request: "44444444-4444-4444-8444-444444444444".into(),
        target: "cloud_copy".into(),
        cancel_requested: false,
        native_started: false,
    }
}
#[test]
fn corrupt_or_unbound_journals_fail_closed_and_are_retained() {
    let disk = TestDir::new("mode-journal");
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
        crate::fsutil::write_atomic(
            &disk.path().join(FILE),
            &serde_json::to_vec(&value).unwrap(),
        )
        .unwrap();
        assert!(Request::load(disk.path()).is_err(), "{field}");
        assert!(disk.path().join(FILE).exists());
    }
    let mut missing_generation = request();
    missing_generation.generation = None;
    missing_generation.save(disk.path()).unwrap();
    assert_eq!(
        Request::load(disk.path()).err().unwrap().reason.as_deref(),
        Some("mode_journal_invalid")
    );
    assert!(disk.path().join(FILE).exists());

    crate::fsutil::write_atomic(&disk.path().join(FILE), b"{").unwrap();
    assert!(Request::load(disk.path()).is_err());
    assert!(disk.path().join(FILE).exists());
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
            is_terminal_pre_publication_refusal(err),
            "expected terminal before publication: {err:?}"
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
            !is_terminal_pre_publication_refusal(err),
            "must not auto-cancel on {err:?}"
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

    assert_eq!(backoff_delay(1), Duration::from_secs(2));
    assert_eq!(backoff_delay(100), Duration::from_secs(30));
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
    use tokio::sync::Notify;

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
        Defer(Arc<Barrier>),
        Drop(Arc<Barrier>),
        WaitForTokenExpiry(u64),
        Raw {
            status: u16,
            retry_after: Option<u64>,
            body: Value,
        },
    }

    enum FinishAction {
        Complete,
        Refuse(u16, &'static str),
    }

    #[derive(Default)]
    struct Barrier {
        reached: Notify,
        release: Notify,
    }

    impl Barrier {
        async fn wait(&self) {
            self.reached.notify_one();
            self.release.notified().await;
        }
    }

    enum Fault {
        RateLimit(u64),
        DropReply,
        DropBeforeCommit,
        Refuse(u16, &'static str),
        Abandon,
    }

    struct MockCpState {
        current_mode: String,
        execution_available: bool,
        active_request: Option<String>,
        source_mode: Option<String>,
        target_mode: Option<String>,
        phase: String,
        retry_at: Option<String>,
        published: bool,
        prepare_queue: VecDeque<PrepareAction>,
        finish_queue: VecDeque<FinishAction>,
        status_gate: Option<Arc<Barrier>>,
        reserve_gate: Option<Arc<Barrier>>,
        reserve_fault: Option<Fault>,
        delete_fault: Option<Fault>,
        intent_ids: Vec<String>,
        prepare_proofs: Vec<Value>,
        delete_ids: Vec<String>,
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
                execution_available: true,
                active_request: None,
                source_mode: None,
                target_mode: None,
                phase: String::new(),
                retry_at: None,
                published: false,
                prepare_queue: VecDeque::new(),
                finish_queue: VecDeque::new(),
                status_gate: None,
                reserve_gate: None,
                reserve_fault: None,
                delete_fault: None,
                intent_ids: Vec::new(),
                prepare_proofs: Vec::new(),
                delete_ids: Vec::new(),
                intent_calls: 0,
                request_status_calls: 0,
                prepare_calls: 0,
                prepare_times_ms: Vec::new(),
                finish_calls: 0,
                delete_calls: 0,
            }
        }
    }

    struct Plane {
        cp: ControlPlane,
        owner: B16,
        log_url: String,
        hosted: Device,
        escrow: Device,
        collections: Shared<BTreeMap<String, Arc<Shared<MockCpState>>>>,
    }

    struct DriverFixture {
        profile: TestDir,
        secrets: Arc<dyn SecretStore>,
        trust: Arc<crate::trust::Trust>,
        collection: B16,
        plane: Arc<Plane>,
        state: Arc<Shared<MockCpState>>,
        daemon: Arc<Daemon>,
        asked: Arc<Accepts>,
        driver_task: Option<tokio::task::JoinHandle<()>>,
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

    async fn serve_mock_cp(
        listener: TcpListener,
        plane: Arc<Plane>,
        owner_device: [u8; 16],
        owner_sign_pk: [u8; 32],
    ) {
        while let Ok((mut socket, _)) = listener.accept().await {
            let plane = plane.clone();
            tokio::spawn(async move {
                let Some((method, path, body)) = read_http(&mut socket).await else {
                    return;
                };
                let challenge = method == "POST" && path == "/v1/next/devices/challenge";
                let id = path
                    .strip_prefix("/v1/next/collections/")
                    .and_then(|path| path.split('/').next());
                let state = {
                    let collections = plane.collections.lock().unwrap();
                    if challenge {
                        collections.values().next().cloned()
                    } else {
                        id.and_then(|id| collections.get(id)).cloned()
                    }
                };
                let Some(state) = state else {
                    write_http(
                        &mut socket,
                        404,
                        None,
                        &json!({"error":{"code":"not_found"}}),
                    )
                    .await;
                    return;
                };
                if challenge {
                    write_http(
                        &mut socket,
                        200,
                        None,
                        &json!({"challenge": "ab".repeat(32)}),
                    )
                    .await;
                    return;
                }
                let col_str = id.expect("collection route");
                let collection = B16(crate::attest::uuid_bytes(col_str).unwrap());
                let mode_path = format!("/v1/next/collections/{col_str}/mode");
                let token_path = format!("/v1/next/collections/{col_str}/log-token");
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
                if method == "GET" && path == mode_path {
                    let (reply, gate) = {
                        let mut s = state.lock().unwrap();
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
                        (
                            json!({
                                "collection_id": col_str,
                                "current_mode": s.current_mode,
                                "execution_available": s.execution_available,
                                "change": change,
                            }),
                            s.status_gate.take(),
                        )
                    };
                    if let Some(gate) = gate {
                        gate.wait().await;
                    }
                    write_http(&mut socket, 200, None, &reply).await;
                    return;
                }
                if method == "POST" && path == mode_path {
                    let req = body["request_id"].as_str().unwrap().to_string();
                    let target = body["target_mode"].as_str().unwrap().to_string();
                    let (reply, gate, fault) = {
                        let mut s = state.lock().unwrap();
                        s.intent_calls += 1;
                        s.intent_ids.push(req.clone());
                        let fault = s.reserve_fault.take();
                        if !matches!(fault, Some(Fault::RateLimit(_) | Fault::Refuse(..)))
                            && s.active_request.as_deref() != Some(req.as_str())
                        {
                            s.active_request = Some(req.clone());
                            s.source_mode = Some(s.current_mode.clone());
                            s.target_mode = Some(target.clone());
                            s.phase = "waiting_for_device".into();
                            s.retry_at = None;
                            s.published = false;
                        }
                        let obj = json!({
                            "collection_id": col_str, "request_id": req, "current_mode": s.current_mode,
                            "source_mode": s.source_mode, "target_mode": s.target_mode, "phase": s.phase,
                            "retry_at": s.retry_at,
                        });
                        (obj, s.reserve_gate.take(), fault)
                    };
                    if let Some(gate) = gate {
                        gate.wait().await;
                    }
                    match fault {
                        Some(Fault::RateLimit(seconds)) => {
                            write_http(
                                &mut socket,
                                429,
                                Some(seconds),
                                &json!({"error":{"code":"rate_limited"}}),
                            )
                            .await
                        }
                        Some(Fault::Refuse(status, code)) => {
                            write_http(&mut socket, status, None, &json!({"error":{"code":code}}))
                                .await
                        }
                        Some(Fault::DropReply) => {}
                        _ => write_http(&mut socket, 202, None, &reply).await,
                    }
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
                    let (resp, fault) = {
                        let mut s = state.lock().unwrap();
                        s.delete_calls += 1;
                        s.delete_ids.push(req.into());
                        let fault = s.delete_fault.take();
                        let resp = if s.active_request.as_deref() != Some(req) {
                            (404, json!({"error":{"code":"not_found"}}))
                        } else if s.published {
                            (409, json!({"error":{"code":"mode_already_published"}}))
                        } else {
                            if !matches!(fault, Some(Fault::RateLimit(_) | Fault::DropBeforeCommit))
                            {
                                s.phase = if matches!(fault, Some(Fault::Abandon)) {
                                    "abandoned"
                                } else {
                                    "cancelled"
                                }
                                .into();
                                s.retry_at = None;
                            }
                            (
                                200,
                                json!({"collection_id": col_str, "request_id": req, "phase": s.phase, "target_mode": s.target_mode}),
                            )
                        };
                        (resp, fault)
                    };
                    match fault {
                        Some(Fault::RateLimit(seconds)) => {
                            write_http(
                                &mut socket,
                                429,
                                Some(seconds),
                                &json!({"error":{"code":"rate_limited"}}),
                            )
                            .await
                        }
                        Some(Fault::DropReply | Fault::DropBeforeCommit) => {}
                        _ => write_http(&mut socket, resp.0, None, &resp.1).await,
                    }
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
                        s.prepare_proofs.push(body);
                        s.prepare_times_ms.push(crate::fsutil::now_ms() as u64);
                        let action = s
                            .prepare_queue
                            .pop_front()
                            .unwrap_or(PrepareAction::PublishAndFinish);
                        (action, s.target_mode.clone().unwrap_or_default())
                    };
                    let publish = async {
                        let ops = if target == "private" {
                            vec![
                                PolicyOp::DeviceRevoke(DeviceRevoke {
                                    device: plane.hosted.id,
                                }),
                                PolicyOp::DeviceRevoke(DeviceRevoke {
                                    device: plane.escrow.id,
                                }),
                                PolicyOp::CollectionState(WireCollectionState {
                                    state: CState::E2e,
                                    compress: None,
                                    min_sem_major: None,
                                }),
                            ]
                        } else {
                            vec![
                                plane.hosted.enrol(DeviceKind::Hosted),
                                plane.escrow.enrol(DeviceKind::Escrow),
                                PolicyOp::CollectionState(WireCollectionState {
                                    state: CState::CloudCopy,
                                    compress: None,
                                    min_sem_major: None,
                                }),
                            ]
                        };
                        append_policy(&plane.log_url, &plane.cp, collection, ops).await;
                        {
                            let mut s = state.lock().unwrap();
                            s.published = true;
                            s.phase = "finishing".into();
                            s.retry_at = None;
                            if target == "cloud_copy" {
                                s.current_mode = "cloud_copy".into();
                            }
                        }
                    };
                    match action {
                        PrepareAction::PublishAndFinish => {
                            publish.await;
                            write_http(
                                &mut socket,
                                202,
                                None,
                                &json!({"request_id": req, "phase": "finishing"}),
                            )
                            .await;
                        }
                        PrepareAction::Defer(gate) => {
                            state.lock().unwrap().phase = "publishing_policy".into();
                            write_http(
                                &mut socket,
                                202,
                                None,
                                &json!({"request_id":req,"phase":"publishing_policy"}),
                            )
                            .await;
                            gate.wait().await;
                            publish.await;
                        }
                        PrepareAction::Drop(gate) => gate.wait().await,
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
                        FinishAction::Refuse(status, code) => {
                            if code == "mode_abandoned" {
                                state.lock().unwrap().phase = "abandoned".into();
                            }
                            write_http(
                                &mut socket,
                                status,
                                None,
                                &json!({"error": {"code": code}}),
                            )
                            .await;
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

    impl Plane {
        async fn add_collection(
            &self,
            daemon: &Daemon,
            trust: &crate::trust::Trust,
            initial_private: bool,
        ) -> (B16, Arc<Shared<MockCpState>>) {
            let collection = B16(new_uuid_v7());
            let owner = self.owner;
            let identity = daemon.identity.get().unwrap();
            let public = identity.public();
            let decode = |hex: &str| crate::secrets::hex_decode(hex).unwrap().try_into().unwrap();
            let owner_device = identity.device_id;
            let owner_sign_pk = decode(&public.sign_pk);
            let owner_kem_pk = decode(&public.kem_pk);
            let owner_noise_pk = decode(&public.noise_pk);
            let state = Arc::new(Shared::new(MockCpState::new(if initial_private {
                "private"
            } else {
                "cloud_copy"
            })));
            self.collections
                .lock()
                .unwrap()
                .insert(collection.to_uuid_string(), state.clone());
            let mut genesis_ops = vec![
                PolicyOp::Genesis(Genesis {
                    owner,
                    root: mdbn_log_service::policy::key_id(&self.cp.root_pk()),
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
                genesis_ops.push(self.hosted.enrol(DeviceKind::Hosted));
                genesis_ops.push(self.escrow.enrol(DeviceKind::Escrow));
            }
            let genesis = self
                .cp
                .policy_item(collection, 1, B32([0; 32]), genesis_ops, 1);
            let pin = mdbn_wire::hash::chain_hash(&genesis);
            create_log(&self.log_url, &self.cp, collection, genesis).await;

            let id = collection.to_uuid_string();
            let root = daemon.profile.state_dir.join(format!("notes-{id}"));
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
            .save(&link, &collection.0, trust)
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
                inner.registry.collections.push(entry.clone());
                inner
                    .registry
                    .save(&daemon.profile.registry_file())
                    .unwrap();
                daemon.authority.publish_registry(&inner.registry);
                inner.hosts.push(CollectionHost::open(entry, Some(ctx)));
            }
            (collection, state)
        }

        async fn move_source(&self, collection: B16) {
            append_policy(
                &self.log_url,
                &self.cp,
                collection,
                vec![PolicyOp::MemberSet(MemberSet {
                    account: B16(new_uuid_v7()),
                    role: Role::Viewer,
                })],
            )
            .await;
        }
    }

    async fn pair_account(daemon: &Arc<Daemon>, trust: &crate::trust::Trust, account: B16) {
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
                &account.to_uuid_string(),
                b"con_hermetic_fixture",
            )
            .await
            .unwrap();
    }

    impl DriverFixture {
        async fn start(tag: &str, initial_private: bool) -> Self {
            let cp = ControlPlane::new(CP_LABEL);
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
            let owner = B16(new_uuid_v7());
            let mut daemon = crate::server::tests::daemon(&profile);
            {
                let owned = Arc::get_mut(&mut daemon).unwrap();
                owned.secrets = secrets.clone();
                owned.trust = Some(trust.clone());
            }
            assert!(daemon.self_weak.set(Arc::downgrade(&daemon)).is_ok());
            let asked = Arc::new(Accepts::default());
            daemon.set_confirmer(asked.clone());
            pair_account(&daemon, &trust, owner).await;

            let identity = daemon.identity.get().unwrap();
            let public = identity.public();
            let decode = |hex: &str| crate::secrets::hex_decode(hex).unwrap().try_into().unwrap();
            let owner_device = identity.device_id;
            let owner_sign_pk: [u8; 32] = decode(&public.sign_pk);
            let plane = Arc::new(Plane {
                cp,
                owner,
                log_url,
                hosted: Device::new("hosted-mode", SERVICE_ACCOUNT),
                escrow: Device::new("escrow-mode", SERVICE_ACCOUNT),
                collections: Shared::default(),
            });
            let cp_task = tokio::spawn(serve_mock_cp(
                cp_listener,
                plane.clone(),
                owner_device,
                owner_sign_pk,
            ));
            let (collection, state) = plane.add_collection(&daemon, &trust, initial_private).await;
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
                plane,
                state,
                daemon,
                asked,
                driver_task: Some(driver_task),
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
            self.wait_collection_ready(&self.id()).await;
        }

        async fn wait_collection_ready(&self, id: &str) {
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

        /// Waits for the journal and the driver's slot: the driver clears the
        /// journal before it applies the terminal outcome.
        async fn wait_request_cleared(&self) {
            let id = self.id();
            let path = self.daemon.profile.collection_dir(&id).join(FILE);
            tokio::time::timeout(Duration::from_secs(45), async {
                while path.exists() || self.daemon.mode_driver.slot(&id).is_some() {
                    tokio::time::sleep(Duration::from_millis(30)).await;
                }
            })
            .await
            .expect("mode-request.json was never cleared by the driver");
        }

        async fn stop_driver(&mut self) {
            if let Some(task) = self.driver_task.take() {
                task.abort();
                let _ = task.await;
            }
        }

        fn dir(&self) -> std::path::PathBuf {
            self.daemon.profile.collection_dir(&self.id())
        }

        fn journal(&self) -> Request {
            Request::load(&self.dir()).unwrap().unwrap()
        }

        fn cloud_opted_in(&self) -> bool {
            SyncConfig::load(&self.dir().join(crate::sync::FILE))
                .unwrap()
                .unwrap()
                .user_enabled_cloud_copy
        }

        fn command(&self, target: &str, cancel: bool) -> ChangeMode {
            ChangeMode {
                collection: self.id(),
                target_mode: Some(target.into()),
                cancel,
                include_local: true,
            }
        }

        async fn change(&self, target: &str, cancel: bool) -> Result<Value, ControlError> {
            self.daemon
                .change_collection_mode(self.command(target, cancel))
                .await
        }

        async fn wait_for_cloud_receipt(&self) {
            let ctx = self.daemon.mode_context(&self.id()).await.unwrap();
            tokio::time::timeout(Duration::from_secs(10), async {
                while ctx
                    .runtime
                    .mode_source(false, true, ctx.guard.clone())
                    .await
                    .is_none()
                {
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
            })
            .await
            .expect("replica observed policy receipt");
        }

        async fn step(&self) {
            let request = self.journal().request;
            self.daemon.drive_mode_request(&self.id(), &request).await;
        }

        fn calls(&self) -> (usize, usize, usize, usize) {
            let s = self.state.lock().unwrap();
            (
                s.intent_calls,
                s.prepare_calls,
                s.finish_calls,
                s.delete_calls,
            )
        }

        async fn restart(&mut self) {
            self.daemon.shutdown.send_replace(true);
            self.stop_driver().await;
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
            self.driver_task = Some(tokio::spawn(next.clone().collection_mode_drive()));
            self.daemon = next;
            self.asked = asked;
            self.wait_ready().await;
        }

        async fn close(mut self) {
            self.daemon.shutdown.send_replace(true);
            self.stop_driver().await;
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
            s.finish_queue
                .push_back(FinishAction::Refuse(503, "not_ready"));
            s.finish_queue
                .push_back(FinishAction::Refuse(503, "not_ready"));
            s.finish_queue.push_back(FinishAction::Complete);
        }
        let first = f
            .daemon
            .change_collection_mode(ChangeMode {
                collection: f.id(),
                target_mode: Some("cloud_copy".into()),
                cancel: false,
                include_local: false,
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
                include_local: false,
            })
            .await
            .unwrap();
        assert_eq!(second["request_id"], first["request_id"]);
        assert_eq!(second["retry_scheduled"], true);
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
                include_local: false,
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
                include_local: false,
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
            n.code == "mode_switch_token_drain"
                && n.message.contains("older app connections expire")
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

    #[tokio::test]
    async fn restart_recovers_a_lost_reservation_reply_without_new_consent() {
        let mut f = DriverFixture::start("mode-reserve", true).await;
        f.state.lock().unwrap().reserve_fault = Some(Fault::DropReply);
        assert_eq!(
            f.change("cloud_copy", false)
                .await
                .unwrap_err()
                .reason
                .as_deref(),
            Some("sync_unreachable")
        );
        let original = f.journal();
        assert!(original.confirmed && !original.native_started);
        assert!(!f.cloud_opted_in());
        assert_eq!(f.calls(), (1, 0, 0, 0));
        assert_eq!(f.asked.0.load(Ordering::SeqCst), 1);

        f.restart().await;
        f.wait_request_cleared().await;
        assert_eq!(f.asked.0.load(Ordering::SeqCst), 0);
        {
            let s = f.state.lock().unwrap();
            assert_eq!(s.phase, "complete");
            assert_eq!(
                s.intent_ids,
                [original.request.clone(), original.request.clone()]
            );
            assert_eq!(s.delete_calls, 0);
        }
        f.close().await;
    }

    #[tokio::test]
    async fn mode_source_changed_recomputes_the_signed_head_for_a_queued_private_switch() {
        let mut f = DriverFixture::start("mode-source", false).await;
        f.stop_driver().await;
        f.state
            .lock()
            .unwrap()
            .prepare_queue
            .push_back(refusal(409, "mode_source_changed"));
        let first = f.change("private", false).await.unwrap();
        assert_eq!(first["phase"], "waiting_for_device");
        assert_eq!(first["local"]["code"], "mode_switch_refreshing");
        let op = f.journal();
        let before = f.state.lock().unwrap().prepare_proofs[0].clone();
        f.state.lock().unwrap().phase = "publishing_policy".into();
        f.plane.move_source(f.collection).await;
        let ctx = f.daemon.mode_context(&f.id()).await.unwrap();
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                if let Some((_, head, _)) = ctx
                    .runtime
                    .mode_source(true, false, ctx.guard.clone())
                    .await
                    && head.seq.to_string() != before["seq"].as_str().unwrap()
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("replica observed moved head");
        elapse(3).await;
        f.step().await;
        {
            let s = f.state.lock().unwrap();
            assert_eq!(s.prepare_calls, 2);
            assert_ne!(s.prepare_proofs[1]["seq"], before["seq"]);
            assert_ne!(s.prepare_proofs[1]["chain"], before["chain"]);
            assert_ne!(s.prepare_proofs[1]["sig"], before["sig"]);
            assert_eq!(s.intent_ids, [op.request]);
            assert_eq!(s.delete_calls, 0);
        }
        f.close().await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn stops_on_waiting_for_devices_and_uses_validated_server_names() {
        let f = DriverFixture::start("driver-person-needed", false).await;
        let owner_device = f.daemon.identity.get().unwrap().public().device;
        {
            let mut s = f.state.lock().unwrap();
            s.prepare_queue.push_back(PrepareAction::Raw {
                status: 409,
                retry_after: None,
                body: json!({
                    "error": {"code": "mode_devices_need_update"},
                    "devices": [owner_device],
                    "names": { owner_device.clone(): "Old ThinkPad" },
                }),
            });
        }
        let reply = f.change("private", false).await.unwrap();
        assert_eq!(reply["phase"], "waiting_for_devices");
        assert_eq!(reply["device_names"][&owner_device], "Old ThinkPad");
        assert!(matches!(
            f.daemon.mode_driver.slot(&f.id()).unwrap().schedule,
            Schedule::Parked(Blocker::Manual)
        ));
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
    }

    async fn elapse(seconds: u64) {
        tokio::time::pause();
        tokio::time::advance(Duration::from_secs(seconds)).await;
        tokio::time::resume();
    }

    fn refusal(status: u16, code: &str) -> PrepareAction {
        PrepareAction::Raw {
            status,
            retry_after: None,
            body: json!({"error":{"code":code}}),
        }
    }

    #[tokio::test]
    async fn foreground_and_queued_background_honor_rate_limits_on_every_mutation() {
        let mut f = DriverFixture::start("mode-429", true).await;
        f.stop_driver().await;
        {
            let mut s = f.state.lock().unwrap();
            s.reserve_fault = Some(Fault::RateLimit(12));
            s.prepare_queue.push_back(PrepareAction::Raw {
                status: 429,
                retry_after: Some(12),
                body: json!({"error":{"code":"rate_limited"}}),
            });
            s.delete_fault = Some(Fault::RateLimit(12));
        }
        assert_eq!(
            f.change("cloud_copy", false).await.unwrap_err().code,
            "rate_limited"
        );
        let original = f.journal();
        assert!(original.confirmed && !original.native_started);
        assert!(!f.cloud_opted_in());
        for (expected, cancel) in [
            ((1, 0, 0, 0), false),
            ((2, 1, 0, 0), true),
            ((2, 1, 0, 1), true),
        ] {
            elapse(6).await;
            let result = f.change("cloud_copy", cancel).await.unwrap();
            assert_eq!(result["request_id"], original.request);
            assert_eq!(result["retry_scheduled"], true);
            assert_eq!(result["cancel_requested"].as_bool(), cancel.then_some(true));
            f.step().await; // A previously selected background job must recheck under the gate.
            assert_eq!(f.calls(), expected);
            assert_eq!(f.journal().generation, original.generation);
            elapse(7).await;
            f.step().await;
        }
        assert_eq!(f.calls(), (2, 1, 0, 2));
        {
            let s = f.state.lock().unwrap();
            assert_eq!(
                s.intent_ids,
                [original.request.clone(), original.request.clone()]
            );
            assert_eq!(s.delete_ids, [original.request.clone(), original.request]);
            assert_eq!(s.phase, "cancelled");
        }
        assert!(!f.cloud_opted_in());
        assert!(Request::load(&f.dir()).unwrap().is_none());
        assert_eq!(f.asked.0.load(Ordering::SeqCst), 1);
        assert_eq!(
            f.daemon
                .activity
                .list(10)
                .iter()
                .filter(|entry| entry.kind == "collection_mode_cancelled")
                .count(),
            1
        );
        f.close().await;
    }

    #[tokio::test]
    async fn lost_delete_reply_retries_only_when_the_exact_row_is_still_active() {
        for (fault, committed) in [(Fault::DropReply, true), (Fault::DropBeforeCommit, false)] {
            let mut f = DriverFixture::start("mode-delete", true).await;
            f.stop_driver().await;
            {
                let mut s = f.state.lock().unwrap();
                s.prepare_queue.push_back(refusal(409, "mode_changed"));
                s.delete_fault = Some(fault);
            }
            assert_eq!(
                f.change("cloud_copy", false)
                    .await
                    .unwrap_err()
                    .reason
                    .as_deref(),
                Some("sync_unreachable")
            );
            let op = f.journal();
            assert!(op.confirmed && op.native_started && op.cancel_requested);
            assert!(f.cloud_opted_in());
            assert_eq!(
                f.state.lock().unwrap().delete_ids.as_slice(),
                std::slice::from_ref(&op.request)
            );
            assert_eq!(f.state.lock().unwrap().phase == "cancelled", committed);
            f.step().await;
            assert_eq!(f.calls(), (1, 1, 0, 1));
            elapse(3).await;
            f.step().await;
            let expected_deletes = if committed { 1 } else { 2 };
            assert_eq!(f.calls(), (1, 1, 0, expected_deletes));
            assert_eq!(
                f.state.lock().unwrap().delete_ids,
                vec![op.request; expected_deletes]
            );
            assert!(Request::load(&f.dir()).unwrap().is_none());
            assert!(!f.cloud_opted_in());
            f.close().await;
        }
    }

    #[tokio::test]
    async fn observational_status_does_not_touch_a_replacement_while_get_is_blocked() {
        let mut f = DriverFixture::start("mode-status-race", true).await;
        f.stop_driver().await;
        let gate = Arc::new(Barrier::default());
        f.state.lock().unwrap().prepare_queue.extend([
            refusal(409, "unknown_request"),
            refusal(403, "not_enrolled"),
        ]);
        assert_eq!(
            f.change("cloud_copy", false)
                .await
                .unwrap_err()
                .reason
                .as_deref(),
            Some("unknown_request")
        );
        let mut old = f.journal();
        old.cancel_requested = true;
        old.save(&f.dir()).unwrap();
        f.state.lock().unwrap().status_gate = Some(gate.clone());
        let daemon = f.daemon.clone();
        let id = f.id();
        let status = tokio::spawn(async move { daemon.collection_mode_status(&id, true).await });
        gate.reached.notified().await;

        assert_eq!(
            f.change("cloud_copy", true).await.unwrap()["phase"],
            "cancelled"
        );
        let denied = f.change("cloud_copy", false).await.unwrap_err();
        assert_eq!(denied.reason.as_deref(), Some("not_enrolled"));
        let replacement = f.journal();
        assert_ne!(replacement.request, old.request);
        assert!(!replacement.cancel_requested);
        let calls = f.calls();
        gate.release.notify_one();
        let reply = status.await.unwrap().unwrap();
        assert_eq!(reply["change"]["request_id"], old.request);
        assert!(reply.get("local").is_none());
        assert_eq!(f.calls(), calls);
        assert_eq!(f.journal().request, replacement.request);
        assert!(!f.journal().cancel_requested);
        f.close().await;
    }

    #[tokio::test]
    async fn cancellation_only_and_legacy_ambiguous_journals_cannot_opt_in() {
        let mut f = DriverFixture::start("mode-cancel-only", true).await;
        f.stop_driver().await;
        let external = request().request;
        {
            let mut s = f.state.lock().unwrap();
            s.active_request = Some(external.clone());
            s.target_mode = Some("cloud_copy".into());
            s.phase = "publishing_policy".into();
            s.published = true;
            s.delete_fault = Some(Fault::RateLimit(2));
        }
        assert_eq!(
            f.change("cloud_copy", true).await.unwrap_err().code,
            "rate_limited"
        );
        let op = f.journal();
        assert_eq!(op.request, external);
        assert!(op.cancel_requested && !op.confirmed && !op.native_started);
        assert_eq!(op.generation, None);
        elapse(3).await;
        f.step().await;
        assert!(Request::load(&f.dir()).unwrap().is_none());
        assert!(!f.cloud_opted_in());
        assert_eq!(f.calls(), (0, 0, 0, 2));

        let mut op = op;
        op.generation = Some("ab".repeat(32));
        op.native_started = true;
        op.cancel_requested = false;
        save_legacy(&f.dir(), op);
        {
            let mut s = f.state.lock().unwrap();
            s.phase = "waiting_for_device".into();
            s.published = false;
        }
        f.daemon.load_mode_requests().await;
        f.step().await;
        assert!(matches!(
            f.daemon.mode_driver.slot(&f.id()).unwrap().schedule,
            Schedule::Parked(Blocker::Manual)
        ));
        assert_eq!(
            f.daemon.mode_driver.notices(&f.id())[0].code,
            "mode_switch_confirmation_required"
        );
        assert!(!f.cloud_opted_in());
        assert_eq!(f.asked.0.load(Ordering::SeqCst), 0);
        assert_eq!(f.calls(), (0, 0, 0, 2));
        assert_eq!(
            f.change("cloud_copy", false).await.unwrap()["phase"],
            "finishing"
        );
        assert!(f.journal().confirmed);
        assert!(f.cloud_opted_in());
        assert_eq!(f.asked.0.load(Ordering::SeqCst), 1);
        f.close().await;
    }

    fn save_legacy(dir: &std::path::Path, op: Request) {
        let mut legacy = serde_json::to_value(op).unwrap();
        legacy.as_object_mut().unwrap().remove("confirmed");
        crate::fsutil::write_atomic(&dir.join(FILE), &serde_json::to_vec(&legacy).unwrap())
            .unwrap();
    }

    #[tokio::test]
    async fn cancelling_legacy_journals_revokes_native_intent_in_both_directions() {
        for target in ["cloud_copy", "private"] {
            let private = target == "private";
            let mut f = DriverFixture::start("mode-legacy-rollback", !private).await;
            f.stop_driver().await;
            f.state
                .lock()
                .unwrap()
                .prepare_queue
                .push_back(PrepareAction::WaitForTokenExpiry(60_000));
            assert_eq!(
                f.change(target, false).await.unwrap()["phase"],
                "waiting_for_token_expiry"
            );
            let op = f.journal();
            assert!(op.native_started);
            let ctx = f.daemon.mode_context(&f.id()).await.unwrap();
            assert!(
                ctx.runtime
                    .mode_source(private, false, ctx.guard.clone())
                    .await
                    .is_some()
            );
            if !private {
                assert!(f.cloud_opted_in());
            }

            save_legacy(&f.dir(), op);
            assert!(!f.journal().confirmed);
            assert_eq!(f.change(target, true).await.unwrap()["phase"], "cancelled");
            assert!(Request::load(&f.dir()).unwrap().is_none());
            assert_eq!(f.calls(), (1, 1, 0, 1));
            assert!(
                ctx.runtime
                    .mode_source(private, false, ctx.guard.clone())
                    .await
                    .is_none()
            );
            if !private {
                assert!(!f.cloud_opted_in());
            }
            assert_eq!(f.asked.0.load(Ordering::SeqCst), 1);
            f.close().await;
        }
    }

    #[tokio::test]
    async fn definite_reserve_refusals_and_missing_cancel_requests_clear_the_journal() {
        let mut f = DriverFixture::start("mode-missing", true).await;
        f.stop_driver().await;
        for (status, code) in [
            (400, "invalid_request"),
            (403, "not_enrolled"),
            (404, "not_found"),
        ] {
            f.state.lock().unwrap().reserve_fault = Some(Fault::Refuse(status, code));
            assert_eq!(
                f.change("cloud_copy", false)
                    .await
                    .unwrap_err()
                    .reason
                    .as_deref(),
                Some(code)
            );
            assert!(Request::load(&f.dir()).unwrap().is_none());
            assert!(f.daemon.mode_driver.slot(&f.id()).is_none());
        }
        let ctx = f.daemon.mode_context(&f.id()).await.unwrap();
        let mut op = request();
        op.collection = f.id();
        op.account = ctx.entry.owner_account.unwrap();
        op.device = ctx.entry.device.unwrap();
        op.genesis = ctx.genesis;
        op.confirmed = false;
        op.generation = None;
        op.cancel_requested = true;
        op.save(&f.dir()).unwrap();
        assert_eq!(
            f.change("cloud_copy", true).await.unwrap(),
            json!({"phase":"cancelled"})
        );
        assert!(Request::load(&f.dir()).unwrap().is_none());
        assert_eq!(f.calls(), (3, 0, 0, 0));
        assert!(!f.cloud_opted_in());

        f.state
            .lock()
            .unwrap()
            .prepare_queue
            .push_back(refusal(403, "not_enrolled"));
        f.change("cloud_copy", false).await.unwrap_err();
        assert!(f.journal().native_started && f.cloud_opted_in());
        f.state.lock().unwrap().active_request = None;
        assert_eq!(
            f.change("cloud_copy", true).await.unwrap()["phase"],
            "cancelled"
        );
        assert!(Request::load(&f.dir()).unwrap().is_none());
        assert!(!f.cloud_opted_in());
        assert_eq!(f.calls(), (4, 1, 0, 0));
        f.close().await;
    }

    #[tokio::test]
    async fn delete_returning_abandoned_preserves_native_state() {
        let mut f = DriverFixture::start("mode-abandoned", true).await;
        f.stop_driver().await;
        f.state
            .lock()
            .unwrap()
            .prepare_queue
            .push_back(refusal(409, "new_refusal"));
        f.change("cloud_copy", false).await.unwrap_err();
        assert!(f.cloud_opted_in());
        f.state.lock().unwrap().delete_fault = Some(Fault::Abandon);
        assert_eq!(
            f.change("cloud_copy", true).await.unwrap()["phase"],
            "abandoned"
        );
        assert!(f.cloud_opted_in());
        assert!(Request::load(&f.dir()).unwrap().is_none());
        assert!(
            f.daemon
                .activity
                .list(10)
                .iter()
                .all(|entry| !entry.kind.starts_with("collection_mode_"))
        );
        assert_eq!(f.calls(), (1, 1, 0, 1));
        f.close().await;
    }

    #[tokio::test]
    async fn durable_checkpoints_cover_native_consent_and_prepare_and_retry_write_failure() {
        let mut f = DriverFixture::start("mode-checkpoint", true).await;
        f.stop_driver().await;
        let reserve = Arc::new(Barrier::default());
        let prepare = Arc::new(Barrier::default());
        {
            let mut s = f.state.lock().unwrap();
            s.reserve_gate = Some(reserve.clone());
            s.prepare_queue
                .push_back(PrepareAction::Drop(prepare.clone()));
        }
        let change = |f: &DriverFixture| {
            let daemon = f.daemon.clone();
            let command = f.command("cloud_copy", false);
            tokio::spawn(async move { daemon.change_collection_mode(command).await })
        };
        let first = change(&f);
        reserve.reached.notified().await;
        let prior = f.journal();
        assert!(prior.confirmed && !prior.native_started);
        assert!(!f.cloud_opted_in());
        // Force the durable native-started checkpoint to fail after reserve.
        let path = f.dir().join(FILE);
        let retained = path.with_extension("saved");
        std::fs::rename(&path, &retained).unwrap();
        std::fs::create_dir(&path).unwrap();
        reserve.release.notify_one();
        assert_eq!(first.await.unwrap().unwrap_err().code, "internal");
        std::fs::remove_dir(&path).unwrap();
        std::fs::rename(&retained, &path).unwrap();
        let repeat = f.change("cloud_copy", false).await.unwrap();
        assert_eq!(repeat["retry_scheduled"], true);
        f.step().await;
        assert_eq!(f.calls(), (1, 0, 0, 0));

        elapse(3).await;
        let before_prepare = change(&f);
        prepare.reached.notified().await;
        let later = f.journal();
        assert!(later.native_started);
        assert_eq!(later.generation, prior.generation);
        assert_eq!(later.request, prior.request);
        assert!(f.cloud_opted_in());
        before_prepare.abort();
        let _ = before_prepare.await;
        prepare.release.notify_one();

        f.step().await;
        assert_eq!(
            f.state.lock().unwrap().intent_ids,
            [prior.request.clone(), prior.request]
        );
        assert_eq!(f.calls(), (2, 2, 0, 0));
        assert_eq!(f.asked.0.load(Ordering::SeqCst), 1);
        f.close().await;
    }

    #[tokio::test]
    async fn confirmed_switch_resumes_after_delete_refusal_and_finish_4xx_keeps_the_journal() {
        let mut f = DriverFixture::start("mode-published", true).await;
        f.stop_driver().await;
        assert_eq!(
            f.change("cloud_copy", false).await.unwrap()["phase"],
            "finishing"
        );
        f.wait_for_cloud_receipt().await;
        let op = f.journal();
        assert!(op.confirmed && op.native_started);
        {
            // An assigned outbox batch already rejects DELETE while status
            // can still report publishing_policy.
            let mut s = f.state.lock().unwrap();
            s.phase = "publishing_policy".into();
            s.finish_queue
                .push_back(FinishAction::Refuse(404, "not_found"));
        }
        let reads = f.state.lock().unwrap().request_status_calls;
        elapse(3).await;
        assert_eq!(
            f.change("cloud_copy", true)
                .await
                .unwrap_err()
                .reason
                .as_deref(),
            Some("mode_already_published")
        );
        assert_eq!(f.state.lock().unwrap().request_status_calls, reads + 2);
        assert_eq!(f.journal().request, op.request);
        assert!(!f.journal().cancel_requested);
        assert_eq!(f.calls(), (1, 1, 0, 1));

        f.state.lock().unwrap().phase = "finishing".into();
        elapse(5).await;
        assert_eq!(
            f.change("cloud_copy", false)
                .await
                .unwrap_err()
                .reason
                .as_deref(),
            Some("not_found")
        );
        assert_eq!(f.journal().request, op.request);
        assert!(!f.journal().cancel_requested);
        assert!(f.cloud_opted_in());
        assert_eq!(f.calls(), (1, 1, 1, 1));

        assert_eq!(
            f.change("cloud_copy", false).await.unwrap()["phase"],
            "complete"
        );
        assert!(Request::load(&f.dir()).unwrap().is_none());
        assert_eq!(f.calls(), (1, 1, 2, 1));
        assert_eq!(f.asked.0.load(Ordering::SeqCst), 1);
        f.close().await;
    }

    #[tokio::test]
    async fn finish_refused_as_abandoned_reads_and_clears_the_exact_row_immediately() {
        let mut f = DriverFixture::start("mode-finish-abandoned", true).await;
        f.stop_driver().await;
        let first = f.change("cloud_copy", false).await.unwrap();
        f.wait_for_cloud_receipt().await;
        f.state
            .lock()
            .unwrap()
            .finish_queue
            .push_back(FinishAction::Refuse(409, "mode_abandoned"));
        let reads = f.state.lock().unwrap().request_status_calls;
        elapse(3).await;
        let reply = f.change("cloud_copy", false).await.unwrap();
        assert_eq!(reply["phase"], "abandoned");
        assert_eq!(reply["request_id"], first["request_id"]);
        assert_eq!(f.state.lock().unwrap().request_status_calls, reads + 2);
        assert_eq!(f.calls(), (1, 1, 1, 0));
        assert!(f.cloud_opted_in());
        assert!(Request::load(&f.dir()).unwrap().is_none());
        f.close().await;
    }

    #[tokio::test]
    async fn a_switch_parked_for_the_wrong_account_wakes_when_the_owner_signs_in() {
        let mut f = DriverFixture::start("mode-account-mismatch", true).await;
        f.stop_driver().await;
        f.state.lock().unwrap().reserve_fault = Some(Fault::RateLimit(1));
        assert_eq!(
            f.change("cloud_copy", false).await.unwrap_err().code,
            "rate_limited"
        );
        let original = f.journal();
        pair_account(&f.daemon, &f.trust, B16(new_uuid_v7())).await;
        elapse(2).await;
        f.step().await;
        let slot = f.daemon.mode_driver.slot(&f.id()).unwrap();
        assert!(matches!(slot.schedule, Schedule::Parked(Blocker::SignIn)));
        assert_eq!(slot.notice.unwrap().code, "mode_switch_sign_in_required");
        assert_eq!(f.calls(), (1, 0, 0, 0));

        pair_account(&f.daemon, &f.trust, f.plane.owner).await;
        f.wait_ready().await;
        f.step().await;
        assert_eq!(
            f.state.lock().unwrap().intent_ids,
            [original.request.clone(), original.request]
        );
        assert_eq!(f.calls(), (2, 1, 0, 0));
        assert_eq!(f.asked.0.load(Ordering::SeqCst), 1);
        f.close().await;
    }

    #[tokio::test]
    async fn legacy_journal_observes_remote_completion_after_cancellation_is_refused() {
        let mut f = DriverFixture::start("mode-legacy-complete", true).await;
        f.stop_driver().await;
        assert_eq!(
            f.change("cloud_copy", false).await.unwrap()["phase"],
            "finishing"
        );
        save_legacy(&f.dir(), f.journal());
        elapse(3).await;
        assert_eq!(
            f.change("cloud_copy", true)
                .await
                .unwrap_err()
                .reason
                .as_deref(),
            Some("mode_already_published")
        );
        assert!(!f.journal().cancel_requested);
        elapse(5).await;
        f.step().await;
        assert!(matches!(
            f.daemon.mode_driver.slot(&f.id()).unwrap().schedule,
            Schedule::Due(_)
        ));
        f.state.lock().unwrap().phase = "complete".into();
        elapse(30).await;
        f.step().await;
        assert!(Request::load(&f.dir()).unwrap().is_none());
        assert!(f.cloud_opted_in());
        assert_eq!(f.calls(), (1, 1, 0, 0));
        assert!(
            f.daemon
                .activity
                .list(10)
                .iter()
                .any(|entry| entry.kind == "collection_mode_changed")
        );
        f.close().await;
    }

    #[tokio::test]
    async fn refresh_catch_up_has_budget_after_prior_rate_limits() {
        let mut f = DriverFixture::start("mode-refresh-budget", false).await;
        f.stop_driver().await;
        for _ in 0..5 {
            f.state.lock().unwrap().reserve_fault = Some(Fault::RateLimit(1));
            assert_eq!(
                f.change("private", false).await.unwrap_err().code,
                "rate_limited"
            );
            elapse(2).await;
        }
        assert_eq!(f.daemon.mode_driver.slot(&f.id()).unwrap().backoff, 5);
        f.state
            .lock()
            .unwrap()
            .prepare_queue
            .push_back(refusal(409, "mode_source_changed"));
        assert_eq!(
            f.change("private", false).await.unwrap()["local"]["code"],
            "mode_switch_refreshing"
        );

        // Make the replica's source temporarily unavailable during catch-up.
        let ctx = f.daemon.mode_context(&f.id()).await.unwrap();
        ctx.runtime
            .private_switch(PrivateSwitchOp::Cancel, ctx.guard.clone())
            .await
            .unwrap()
            .unwrap();
        assert!(
            ctx.runtime
                .mode_source(true, false, ctx.guard.clone())
                .await
                .is_none()
        );
        elapse(3).await;
        let retry = f.change("private", false).await.unwrap();
        assert_eq!(retry["phase"], "waiting_for_device");
        assert_eq!(retry["local"]["code"], "mode_switch_refreshing");
        assert_eq!(f.calls(), (6, 1, 0, 0));
        f.close().await;
    }

    #[tokio::test]
    async fn deferred_publication_and_missing_receipt_wait_while_another_collection_finishes() {
        let mut f = DriverFixture::start("mode-defer", true).await;
        f.stop_driver().await;
        let gate = Arc::new(Barrier::default());
        f.state
            .lock()
            .unwrap()
            .prepare_queue
            .push_back(PrepareAction::Defer(gate.clone()));
        f.state
            .lock()
            .unwrap()
            .finish_queue
            .push_back(FinishAction::Refuse(503, "not_ready"));
        let first = f.change("cloud_copy", false).await.unwrap();
        assert_eq!(first["phase"], "publishing_policy");
        gate.reached.notified().await;

        // The server may see the append before this actor can read its receipt.
        f.state.lock().unwrap().phase = "finishing".into();
        elapse(3).await;
        f.step().await;
        assert_eq!(f.calls(), (1, 1, 0, 0));
        assert!(matches!(
            f.daemon.mode_driver.slot(&f.id()).unwrap().schedule,
            Schedule::Due(_)
        ));
        assert_eq!(
            f.daemon
                .activity
                .list(10)
                .iter()
                .filter(|entry| entry.kind == "collection_mode_changed")
                .count(),
            0
        );

        let (second, state) = f.plane.add_collection(&f.daemon, &f.trust, true).await;
        let second = second.to_uuid_string();
        f.wait_collection_ready(&second).await;
        let second_reply = f
            .daemon
            .change_collection_mode(ChangeMode {
                collection: second.clone(),
                ..f.command("cloud_copy", false)
            })
            .await
            .unwrap();
        elapse(3).await;
        for (id, request) in f.daemon.mode_driver.due(Instant::now()) {
            f.daemon.drive_mode_request(&id, &request).await;
        }
        assert_eq!(state.lock().unwrap().phase, "complete");
        assert!(f.daemon.mode_driver.slot(&second).is_none());
        assert_eq!(f.journal().request, first["request_id"].as_str().unwrap());
        assert_ne!(first["request_id"], second_reply["request_id"]);
        assert_eq!(f.calls(), (1, 1, 0, 0));

        gate.release.notify_one();
        f.wait_for_cloud_receipt().await;
        elapse(30).await;
        f.step().await;
        assert_eq!(f.calls(), (1, 1, 1, 0));
        assert!(f.daemon.mode_driver.slot(&f.id()).is_some());
        f.step().await;
        assert_eq!(f.calls(), (1, 1, 1, 0));
        elapse(30).await;
        f.step().await;
        assert_eq!(f.calls(), (1, 1, 2, 0));
        assert!(f.daemon.mode_driver.slot(&f.id()).is_none());
        assert!(Request::load(&f.dir()).unwrap().is_none());
        let activity = f.daemon.activity.list(10);
        for id in [f.id(), second] {
            assert_eq!(
                activity
                    .iter()
                    .filter(|entry| entry.kind == "collection_mode_changed"
                        && entry.collection.as_deref() == Some(&id))
                    .count(),
                1
            );
        }
        f.close().await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn unavailable_mode_switch_includes_next_step_guidance_without_confirmation() {
        let f = DriverFixture::start("driver-unavailable-private", false).await;
        f.state.lock().unwrap().execution_available = false;
        let err = f.change("private", false).await.unwrap_err();
        assert_eq!(err.code, "unavailable");
        assert_eq!(err.reason.as_deref(), Some("mode_switch_unavailable"));
        assert!(
            err.message
                .starts_with("Switching this collection isn't available yet."),
            "{}",
            err.message
        );
        assert!(
            err.message.contains("mdbase collection add"),
            "{}",
            err.message
        );
        assert!(err.message.contains("--mode private"), "{}", err.message);
        assert!(
            err.message.contains("copy or move your notes"),
            "{}",
            err.message
        );
        assert_eq!(f.asked.0.load(Ordering::SeqCst), 0);
        f.close().await;

        let f = DriverFixture::start("driver-unavailable-cloud", true).await;
        f.state.lock().unwrap().execution_available = false;
        let err = f.change("cloud_copy", false).await.unwrap_err();
        assert_eq!(err.reason.as_deref(), Some("mode_switch_unavailable"));
        assert!(
            err.message
                .starts_with("Switching this collection isn't available yet."),
            "{}",
            err.message
        );
        assert!(err.message.contains("--mode cloud-copy"), "{}", err.message);
        assert_eq!(f.asked.0.load(Ordering::SeqCst), 0);
        f.close().await;
    }
}
