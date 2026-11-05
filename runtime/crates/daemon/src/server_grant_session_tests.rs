use super::*;
use crate::runtime::{GrantApprovalOp, GrantApprovalReply, Runtime, RuntimeConfig, Synced};
use crate::session::{Auth, Origin as SessionOrigin, SessionChannels};
use futures_util::{SinkExt, StreamExt};
use mdbn_log_service::testkit::{ControlPlane, Device, sign_digest};
use mdbn_replica::policy::GrantSource;
use mdbn_wire::Wire;
use mdbn_wire::cbor::Cbor;
use mdbn_wire::client::{ClientFrame, ClientRequest, HelloParams, Recovery};
use mdbn_wire::common::{B16, B32, Bytes, Version};
use mdbn_wire::log_service::{
    AppendParams, HeadParams, HeadResult, LsFrame, LsHelloParams, LsRequest,
};
use mdbn_wire::policy::{
    CState, DeviceEnrol, DeviceKind, Genesis, Grant, MemberSet, PolicyOp, Role,
};
use tokio_tungstenite::tungstenite::Message;

const COLLECTION: B16 = B16([7; 16]);
const GRANT: B16 = B16([8; 16]);
const CLIENT_KEY: [u8; 32] = [9; 32];

fn auth(origin: SessionOrigin) -> Auth {
    Auth::Grant {
        grant: GRANT.0,
        client_pk: CLIENT_KEY,
        origin,
    }
}

fn hello() -> ClientRequest {
    ClientRequest {
        id: 0,
        method: "hello".into(),
        params: HelloParams {
            versions: vec![Version { major: 1, minor: 0 }],
            client_name: "grant-gate".into(),
            client_version: "0".into(),
            features: None,
            timezone: None,
        }
        .to_cbor(),
    }
}

fn cached() -> CachedGrant {
    let mut entry = grant(9);
    entry.grant = GRANT.to_uuid_string();
    entry.collection = COLLECTION.to_uuid_string();
    entry.folders = None;
    entry
}

async fn feed(daemon: &Daemon, sequence: u64, listed: bool) {
    daemon
        .commit_control_plane_feed(
            &snapshot(sequence),
            &BTreeMap::from([(
                COLLECTION.to_uuid_string(),
                if listed { vec![cached()] } else { vec![] },
            )]),
        )
        .await
        .unwrap();
}

async fn private_daemon(dir: &crate::testutil::TestDir) -> Arc<Daemon> {
    let daemon = paired_daemon(dir).await;
    {
        let mut inner = daemon.inner.lock().await;
        let entry = &mut inner.registry.collections[0];
        entry.id = COLLECTION.to_uuid_string();
        entry.mode = SyncMode::SyncedE2e;
        entry.ever_e2e = true;
        daemon.authority.publish_registry(&inner.registry);
    }
    daemon
}

#[tokio::test]
async fn private_cache_gate_is_exact_deny_only_and_origin_scoped() {
    let dir = crate::testutil::TestDir::new("private-gate");
    let daemon = private_daemon(&dir).await;
    let collection = COLLECTION.to_uuid_string();
    let relay = auth(SessionOrigin::RelayPipe);
    let ipc = auth(SessionOrigin::LocalIpc);
    assert!(daemon.authority.authorize_session(&collection, ipc).is_ok());
    let missing = daemon
        .authority
        .authorize_session(&collection, relay)
        .unwrap_err();
    assert_eq!(missing, crate::access::Refusal::LeaseExpired);
    feed(&daemon, 1, true).await;
    assert!(
        daemon
            .authority
            .authorize_session(&collection, relay)
            .is_ok()
    );
    for wrong in [
        Auth::Grant {
            grant: GRANT.0,
            client_pk: [10; 32],
            origin: SessionOrigin::RelayPipe,
        },
        Auth::Grant {
            grant: [10; 16],
            client_pk: CLIENT_KEY,
            origin: SessionOrigin::RelayPipe,
        },
    ] {
        assert!(
            daemon
                .authority
                .authorize_session(&collection, wrong)
                .is_err()
        );
    }
    {
        let mut inner = daemon.inner.lock().await;
        inner.access.entries[0].grant.collection = B16([10; 16]).to_uuid_string();
        daemon.authority.publish_access(&inner.access);
        assert!(
            daemon
                .authority
                .authorize_session(&collection, relay)
                .is_err()
        );
        inner.access.entries[0].grant.collection = collection.clone();
        inner.access.monotonic_leases.clear();
        daemon.authority.publish_access(&inner.access);
        assert!(
            daemon
                .authority
                .authorize_session(&collection, relay)
                .is_err()
        );
        assert!(daemon.authority.authorize_session(&collection, ipc).is_ok());
    }
    for state in [AccessState::Denied, AccessState::RevokedLocally] {
        let mut inner = daemon.inner.lock().await;
        inner.access.entries[0].state = state;
        inner.access.entries[0].delisted = true;
        daemon.authority.publish_access(&inner.access);
        for origin in [
            relay,
            ipc,
            Auth::Link {
                client_pk: CLIENT_KEY,
            },
        ] {
            let error = daemon
                .authority
                .authorize_session(&collection, origin)
                .unwrap_err();
            assert_eq!(error, crate::access::Refusal::RevokedLocally);
        }
        assert!(
            daemon
                .authority
                .authorize_session(
                    &collection,
                    Auth::Link {
                        client_pk: [10; 32]
                    }
                )
                .is_ok()
        );
        inner.registry.collections[0].mode = SyncMode::Synced;
        daemon.authority.publish_registry(&inner.registry);
        assert!(
            daemon
                .authority
                .authorize_session(&collection, relay)
                .is_ok()
        );
        inner.registry.collections[0].mode = SyncMode::SyncedE2e;
        daemon.authority.publish_registry(&inner.registry);
    }
}

#[tokio::test]
async fn relay_refusals_follow_the_shared_server_close_contract() {
    use crate::relay::RelayHost;
    let cases: Vec<Value> = serde_json::from_str(include_str!(
        "../../../conformance/relay-grant-refusals.json"
    ))
    .unwrap();
    for case in cases {
        let dir = crate::testutil::TestDir::new("relay-refusal");
        let daemon = private_daemon(&dir).await;
        feed(&daemon, 1, true).await;
        {
            let mut inner = daemon.inner.lock().await;
            inner.registry.collections[0].mode =
                serde_json::from_value(case["mode"].clone()).unwrap();
            if case["state"].is_null() {
                inner.access.entries.clear();
            } else {
                inner.access.entries[0].state =
                    serde_json::from_value(case["state"].clone()).unwrap();
            }
            if case["live_lease"] == false {
                inner.access.monotonic_leases.clear();
            }
            daemon.authority.publish_registry(&inner.registry);
            daemon.authority.publish_access(&inner.access);
        }
        assert_eq!(
            daemon
                .grant_refusal(&COLLECTION.to_uuid_string(), &GRANT.to_uuid_string())
                .await
                .as_deref(),
            case["reason"].as_str(),
            "{}",
            case["name"],
        );
        let refusal = daemon
            .authority
            .authorize_session(&COLLECTION.to_uuid_string(), auth(SessionOrigin::RelayPipe));
        if case["mode"] == "synced" {
            assert!(refusal.is_ok());
        } else {
            let problem = refusal.unwrap_err().problem();
            assert_eq!(problem.reason.as_deref(), case["reason"].as_str());
            if case["close_code"] == 4000 {
                assert_eq!(problem.code, "unavailable");
                assert_eq!(problem.retry_after_ms, Some(1000));
            } else {
                assert_eq!(problem.code, "forbidden");
            }
        }
    }
}

#[tokio::test]
async fn reapproved_link_key_does_not_reactivate_the_refused_grant() {
    let dir = crate::testutil::TestDir::new("reapproved-link");
    let daemon = private_daemon(&dir).await;
    feed(&daemon, 1, true).await;
    daemon
        .access_change(|access| access.revoke(&GRANT.to_uuid_string()).cloned())
        .await
        .unwrap();
    let mut replacement = cached();
    replacement.grant = B16([10; 16]).to_uuid_string();
    daemon
        .commit_control_plane_feed(
            &snapshot(2),
            &BTreeMap::from([(COLLECTION.to_uuid_string(), vec![replacement])]),
        )
        .await
        .unwrap();
    assert!(
        daemon
            .authority
            .authorize_session(
                &COLLECTION.to_uuid_string(),
                Auth::Link {
                    client_pk: CLIENT_KEY
                },
            )
            .is_ok()
    );
    assert_eq!(
        daemon
            .authority
            .authorize_session(&COLLECTION.to_uuid_string(), auth(SessionOrigin::LocalIpc),),
        Err(crate::access::Refusal::RevokedLocally)
    );
}

struct AccountSource(B16);

impl GrantSource for AccountSource {
    fn grant(&self, _: &B16) -> mdbn_replica::api::ApiResult<mdbn_replica::policy::EffectiveGrant> {
        Err(crate::access::Refusal::UnknownGrant.problem().into())
    }
    fn active_account(&self) -> Option<B16> {
        Some(self.0)
    }
    fn authority_epoch(&self) -> Option<u64> {
        Some(1)
    }
    fn device_noise_pk(&self) -> Option<B32> {
        Some(B32(crate::noise::public_key(&[34; 32])))
    }
}

struct Tokens(crate::logwire::Token);

impl crate::logwire::TokenSource for Tokens {
    fn token(&self) -> crate::session::BoxFuture<'_, Result<crate::logwire::Token, String>> {
        Box::pin(async { Ok(self.0.clone()) })
    }
    fn current(&self) -> Result<(), String> {
        Ok(())
    }
}

struct SignedRuntime {
    runtime: Arc<Runtime>,
    log: String,
    cp: ControlPlane,
    server: tokio::task::JoinHandle<std::io::Result<()>>,
    log_server: tokio::task::JoinHandle<std::io::Result<()>>,
}

impl SignedRuntime {
    async fn new(dir: &crate::testutil::TestDir) -> Self {
        use mdbn_log_server::{AnyService, Gateway};
        use mdbn_log_service::{
            Service,
            mem::{MemBackend, MemObjects},
        };
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let upstream = listener.local_addr().unwrap();
        let front = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let log = format!("http://{}", front.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let mut connections = tokio::task::JoinSet::new();
            loop {
                let (mut client, _) = front.accept().await?;
                let mut backend = tokio::net::TcpStream::connect(upstream).await?;
                connections.spawn(async move {
                    let _ = tokio::io::copy_bidirectional(&mut client, &mut backend).await;
                });
            }
        });
        let log_server = tokio::spawn(mdbn_log_server::serve(
            Gateway::new(
                AnyService::Mem(Service::new(
                    MemBackend::default(),
                    MemObjects::default(),
                    mdbn_log_server::testkit_config("conformance", &log),
                )),
                false,
            ),
            listener,
        ));
        let cp = ControlPlane::new("conformance");
        let account = crate::attest::uuid_bytes("11111111-1111-4111-8111-111111111111")
            .map(B16)
            .unwrap();
        let device = Device::new("grant-gate", account);
        let genesis = cp.policy_item(
            COLLECTION,
            1,
            B32([0; 32]),
            vec![
                PolicyOp::Genesis(Genesis {
                    owner: account,
                    root: mdbn_log_service::policy::key_id(&cp.root_pk()),
                    state: CState::E2e,
                }),
                PolicyOp::MemberSet(MemberSet {
                    account,
                    role: Role::Owner,
                }),
                PolicyOp::DeviceEnrol(DeviceEnrol {
                    device: device.id,
                    account,
                    kind: DeviceKind::Desktop,
                    sign_pk: device.pk(),
                    kem_pk: B32(mdbn_replica::crypto::hpke::KemKeyPair::from_secret(&[33; 32]).pk),
                    noise_pk: B32(crate::noise::public_key(&[34; 32])),
                    sas_commit: None,
                    local_root: None,
                }),
            ],
            fsutil::now_ms() as i64,
        );
        let pin = mdbn_wire::hash::chain_hash(&genesis).0;
        rpc(
            &log,
            &cp,
            "create_log",
            Cbor::Map(vec![
                (Cbor::Uint(0), COLLECTION.to_cbor()),
                (Cbor::Uint(1), Cbor::Bytes(genesis)),
            ]),
        )
        .await;
        let expires = fsutil::now_ms() as i64 + 900_000;
        std::fs::create_dir_all(dir.path().join("notes")).unwrap();
        let runtime = Runtime::open(
            RuntimeConfig {
                collection: COLLECTION.0,
                replica_id: [35; 16],
                device_id: device.id.0,
                root: dir.path().join("notes"),
                private_dir: dir.path().join("private-runtime"),
                adopt: None,
                id_hints: vec![],
                computer_name: None,
                sync: Some(Synced {
                    log_url: log.clone(),
                    chosen_state: CState::E2e,
                    trusted_roots: vec![cp.root_pk().0],
                    trusted_signers: vec![device.id.0],
                    user_enabled_cloud_copy: false,
                    tokens: Arc::new(Tokens(crate::logwire::Token {
                        token: cp
                            .device_token_for(&device, expires, Some(COLLECTION))
                            .into(),
                        expires_at_ms: expires,
                    })),
                    secrets: Arc::new(crate::secrets::MemoryStore::default()),
                    expected_genesis: pin,
                    policy_pins: crate::trust::pins_for(
                        cp.root_pk().0,
                        cp.transport_key().verifying_key().to_bytes(),
                    ),
                }),
            },
            mdbn_replica::DeviceSecrets {
                sign_sk: device.signing_key().to_bytes(),
                kem_sk: [33; 32],
            },
            Box::new(AccountSource(account)),
            Default::default(),
        )
        .unwrap();
        let mut changes = runtime.grant_policy_changes();
        tokio::time::timeout(Duration::from_secs(20), async {
            while !matches!(
                runtime
                    .account_key(crate::runtime::AccountKeyOp::Unlocked)
                    .await,
                Some(Ok(true))
            ) {
                changes.changed().await.unwrap();
            }
        })
        .await
        .unwrap();
        Self {
            runtime: Arc::new(runtime),
            log,
            cp,
            server,
            log_server,
        }
    }

    async fn publish(&self) {
        let head = HeadResult::from_cbor(
            &rpc(
                &self.log,
                &self.cp,
                "head",
                HeadParams {
                    collection: COLLECTION,
                }
                .to_cbor(),
            )
            .await,
        )
        .unwrap();
        let item = self.cp.policy_item(
            COLLECTION,
            head.head + 1,
            head.head_chain,
            vec![PolicyOp::Grant(Grant {
                grant: GRANT,
                installation: B16([36; 16]),
                app_id: "app".into(),
                account: B16(
                    crate::attest::uuid_bytes("11111111-1111-4111-8111-111111111111").unwrap(),
                ),
                capabilities: vec!["collection.read".into()],
                client_pk: B32(CLIENT_KEY),
                file_folders: None,
                folder_scoped: Some(false),
            })],
            fsutil::now_ms() as i64,
        );
        rpc(
            &self.log,
            &self.cp,
            "append",
            AppendParams {
                collection: COLLECTION,
                expect_seq: head.head + 1,
                expect_prev: head.head_chain,
                items: vec![Bytes(item)],
            }
            .to_cbor(),
        )
        .await;
        let mut changes = self.runtime.grant_policy_changes();
        tokio::time::timeout(Duration::from_secs(20), async {
            loop {
                if matches!(
                    self.runtime
                        .grant_approval(GrantApprovalOp::State(GRANT))
                        .await,
                    Some(GrantApprovalReply::State(Some(_)))
                ) {
                    break;
                }
                changes.changed().await.unwrap();
            }
            assert!(matches!(
                self.runtime
                    .grant_approval(GrantApprovalOp::Approve {
                        grant: GRANT,
                        capabilities: vec!["collection.read".into()],
                        folders: None
                    })
                    .await,
                Some(GrantApprovalReply::Approve(Ok(())))
            ));
            loop {
                if matches!(
                    self.runtime
                        .grant_approval(GrantApprovalOp::Effective(GRANT))
                        .await,
                    Some(GrantApprovalReply::Effective(true))
                ) {
                    break;
                }
                changes.changed().await.unwrap();
            }
        })
        .await
        .unwrap();
    }

    async fn open(&self, daemon: &Arc<Daemon>, auth: Auth) -> crate::session::Opened {
        open_on_runtime(
            daemon.clone(),
            COLLECTION.to_uuid_string(),
            self.runtime.clone(),
            auth,
            hello(),
            matches!(auth, Auth::Link { .. }),
        )
        .await
    }

    async fn stop(self) {
        self.runtime.stop().await;
        self.server.abort();
        self.log_server.abort();
    }
}

async fn rpc(log: &str, cp: &ControlPlane, method: &str, params: Cbor) -> Cbor {
    let (mut socket, response) =
        tokio_tungstenite::connect_async(crate::logwire::ws_url(log, &COLLECTION).unwrap())
            .await
            .unwrap();
    let nonce = secrets::hex_decode(response.headers()["x-mdbase-nonce"].to_str().unwrap())
        .unwrap()
        .try_into()
        .unwrap();
    let token = cp.cp_token(fsutil::now_ms() as i64 + 900_000);
    let hello = LsHelloParams {
        version: Version { major: 1, minor: 0 },
        sig: sign_digest(
            cp.transport_key(),
            &mdbn_log_service::auth::hello_digest(&nonce, &token),
        ),
        token,
        device: None,
    };
    for (id, method, params) in [(1, "hello", hello.to_cbor()), (2, method, params)] {
        socket
            .send(Message::Binary(
                LsFrame::Request(LsRequest {
                    id,
                    method: method.into(),
                    params,
                })
                .to_bytes()
                .unwrap()
                .into(),
            ))
            .await
            .unwrap();
        loop {
            if let Some(Ok(Message::Binary(bytes))) = socket.next().await
                && let LsFrame::Response(response) = LsFrame::from_bytes(&bytes).unwrap()
                && response.id == id
            {
                assert!(response.error.is_none(), "{method}: {:?}", response.error);
                if id == 2 {
                    return response.result.unwrap();
                }
                break;
            }
        }
    }
    unreachable!()
}

async fn closed(session: &mut SessionChannels) -> mdbn_wire::client::Problem {
    tokio::time::timeout(Duration::from_secs(5), async {
        let mut problem = None;
        while let Some(frame) = session.outbound.recv().await {
            if let ClientFrame::Push(push) = frame
                && push.kind == "closed"
            {
                problem = Some(mdbn_wire::client::Problem::from_cbor(&push.payload).unwrap());
            }
        }
        problem.expect("refused session lost its Closed problem")
    })
    .await
    .expect("refused session remained open")
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn session_frames_do_not_wait_for_the_daemon_inner_lock() {
    let dir = crate::testutil::TestDir::new("session-lock");
    let daemon = private_daemon(&dir).await;
    let signed = SignedRuntime::new(&dir).await;
    signed.publish().await;
    feed(&daemon, 1, true).await;
    let guard = daemon.inner.lock().await;
    let mut session = tokio::time::timeout(
        Duration::from_secs(2),
        signed.open(&daemon, auth(SessionOrigin::RelayPipe)),
    )
    .await
    .expect("opening waited for unrelated daemon work")
    .session
    .unwrap();
    session
        .inbound
        .send(ClientFrame::Request(ClientRequest {
            id: 10,
            method: "get_status".into(),
            params: Cbor::Map(vec![]),
        }))
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            if let Some(ClientFrame::Response(response)) = session.outbound.recv().await
                && response.id == 10
            {
                assert!(response.problem.is_none(), "{:?}", response.problem);
                break;
            }
        }
    })
    .await
    .expect("frames waited for unrelated daemon work");
    drop(guard);
    drop(session);
    signed.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn inbound_refusal_answers_the_request_and_preserves_the_lease_hint() {
    let dir = crate::testutil::TestDir::new("inbound-refusal");
    let daemon = private_daemon(&dir).await;
    let signed = SignedRuntime::new(&dir).await;
    signed.publish().await;
    feed(&daemon, 1, true).await;
    let mut session = signed
        .open(&daemon, auth(SessionOrigin::RelayPipe))
        .await
        .session
        .unwrap();
    {
        let mut inner = daemon.inner.lock().await;
        inner.registry.collections[0].mode = SyncMode::Local;
        inner.access.monotonic_leases.clear();
        daemon.authority.publish_registry(&inner.registry);
        daemon.authority.publish_access(&inner.access);
    }
    session
        .inbound
        .send(ClientFrame::Request(ClientRequest {
            id: 11,
            method: "get_status".into(),
            params: Cbor::Map(vec![]),
        }))
        .await
        .unwrap();
    let response = tokio::time::timeout(Duration::from_secs(2), session.outbound.recv())
        .await
        .unwrap()
        .unwrap();
    let ClientFrame::Response(response) = response else {
        panic!("refused request lost its response")
    };
    assert_eq!(response.id, 11);
    let problem = response.problem.unwrap();
    assert_eq!(problem.reason.as_deref(), Some("grant_lease_expired"));
    assert_eq!(problem.retry_after_ms, Some(1000));
    assert_eq!(closed(&mut session).await, problem);
    signed.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn replica_terminal_push_is_not_filtered_by_a_lapsed_local_lease() {
    let dir = crate::testutil::TestDir::new("terminal-push");
    let daemon = private_daemon(&dir).await;
    let signed = SignedRuntime::new(&dir).await;
    signed.publish().await;
    feed(&daemon, 1, true).await;
    let mut session = signed
        .open(&daemon, auth(SessionOrigin::RelayPipe))
        .await
        .session
        .unwrap();
    {
        let mut inner = daemon.inner.lock().await;
        inner.registry.collections[0].mode = SyncMode::Local;
        inner.access.monotonic_leases.clear();
        daemon.authority.publish_registry(&inner.registry);
        daemon.authority.publish_access(&inner.access);
    }
    signed.runtime.stop_deleted().await;
    let problem = closed(&mut session).await;
    assert_eq!(problem.reason.as_deref(), Some("collection_deleted"));
    assert_eq!(problem.recovery, Recovery::None);
    signed.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn private_session_waits_for_both_delivery_orders_and_new_restart_sequence() {
    for log_first in [false, true] {
        let dir = crate::testutil::TestDir::new("private-order");
        let daemon = private_daemon(&dir).await;
        let signed = SignedRuntime::new(&dir).await;
        let relay = auth(SessionOrigin::RelayPipe);
        if log_first {
            signed.publish().await;
        } else {
            feed(&daemon, 1, true).await;
        }
        let waiting = signed.open(&daemon, relay).await;
        assert!(waiting.session.is_none());
        if log_first {
            assert_eq!(waiting.response.problem.unwrap().recovery, Recovery::Retry);
            feed(&daemon, 1, true).await;
        } else {
            signed.publish().await;
        }
        let opened = signed.open(&daemon, relay).await;
        assert!(
            opened.response.problem.is_none(),
            "{:?}",
            opened.response.problem
        );
        assert!(opened.session.is_some());
        drop(opened);
        let loaded = AccessList::load(&daemon.profile.access_file()).unwrap();
        daemon.authority.publish_access(&loaded);
        daemon.inner.lock().await.access = loaded;
        feed(&daemon, 1, true).await;
        assert_eq!(
            signed
                .open(&daemon, relay)
                .await
                .response
                .problem
                .unwrap()
                .recovery,
            Recovery::Retry
        );
        feed(&daemon, 2, true).await;
        assert!(signed.open(&daemon, relay).await.session.is_some());
        signed.stop().await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn failed_feed_save_expires_private_authority_without_revoking_offline_use() {
    use crate::relay::RelayHost;
    let dir = crate::testutil::TestDir::new("private-save");
    let daemon = private_daemon(&dir).await;
    let signed = SignedRuntime::new(&dir).await;
    signed.publish().await;
    feed(&daemon, 1, true).await;
    let path = daemon.profile.access_file();
    std::fs::remove_file(&path).unwrap();
    std::fs::create_dir(&path).unwrap();
    assert!(
        daemon
            .commit_control_plane_feed(
                &snapshot(2),
                &BTreeMap::from([(COLLECTION.to_uuid_string(), vec![cached()]),])
            )
            .await
            .is_err()
    );
    assert_eq!(
        daemon
            .grant_refusal(&COLLECTION.to_uuid_string(), &GRANT.to_uuid_string())
            .await
            .as_deref(),
        Some("grant_lease_expired")
    );
    let problem = signed
        .open(&daemon, auth(SessionOrigin::RelayPipe))
        .await
        .response
        .problem
        .unwrap();
    assert_eq!(problem.reason.as_deref(), Some("grant_lease_expired"));
    assert_eq!(problem.retry_after_ms, Some(1000));
    assert!(
        signed
            .open(&daemon, auth(SessionOrigin::LocalIpc))
            .await
            .session
            .is_some()
    );
    assert_eq!(
        daemon
            .inner
            .lock()
            .await
            .access
            .feed_cursor
            .as_ref()
            .unwrap()
            .sequence,
        1
    );
    std::fs::remove_dir(&path).unwrap();
    feed(&daemon, 2, true).await;
    assert!(
        signed
            .open(&daemon, auth(SessionOrigin::RelayPipe))
            .await
            .session
            .is_some()
    );
    signed.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn private_delisting_and_local_refusal_close_sessions_without_log_revocation() {
    for log_unreachable in [false, true] {
        let dir = crate::testutil::TestDir::new("private-revocation");
        let daemon = private_daemon(&dir).await;
        let mut signed = SignedRuntime::new(&dir).await;
        signed.publish().await;
        feed(&daemon, 1, true).await;
        let mut relay = signed
            .open(&daemon, auth(SessionOrigin::RelayPipe))
            .await
            .session
            .unwrap();
        let mut ipc = signed
            .open(&daemon, auth(SessionOrigin::LocalIpc))
            .await
            .session
            .unwrap();
        let mut link = signed
            .open(
                &daemon,
                Auth::Link {
                    client_pk: CLIENT_KEY,
                },
            )
            .await
            .session
            .unwrap();
        if log_unreachable {
            signed.server.abort();
            let _ = (&mut signed.server).await;
            assert!(
                tokio::net::TcpStream::connect(signed.log.trim_start_matches("http://"))
                    .await
                    .is_err()
            );
        }
        feed(&daemon, 2, false).await;
        assert_eq!(
            closed(&mut relay).await.reason.as_deref(),
            Some("authorization_unavailable")
        );
        assert!(
            !crate::relay::RelayHost::grant_live(
                daemon.as_ref(),
                &COLLECTION.to_uuid_string(),
                &GRANT.to_uuid_string()
            )
            .await
        );
        assert!(
            signed
                .open(&daemon, auth(SessionOrigin::RelayPipe))
                .await
                .session
                .is_none()
        );
        assert!(
            signed
                .open(&daemon, auth(SessionOrigin::LocalIpc))
                .await
                .session
                .is_some()
        );
        feed(&daemon, 3, true).await;
        let mut relay = signed
            .open(&daemon, auth(SessionOrigin::RelayPipe))
            .await
            .session
            .unwrap();
        {
            let mut inner = daemon.inner.lock().await;
            inner.access.monotonic_leases.clear();
            daemon.authority.publish_access(&inner.access);
        }
        daemon.bump();
        let problem = closed(&mut relay).await;
        assert_eq!(problem.reason.as_deref(), Some("grant_lease_expired"));
        assert_eq!(problem.retry_after_ms, Some(1000));
        for session in [&mut ipc, &mut link] {
            session
                .inbound
                .send(ClientFrame::Request(ClientRequest {
                    id: 1,
                    method: "get_status".into(),
                    params: Cbor::Map(vec![]),
                }))
                .await
                .unwrap();
            let response = tokio::time::timeout(Duration::from_secs(5), async {
                loop {
                    match session.outbound.recv().await {
                        Some(ClientFrame::Response(response)) if response.id == 1 => {
                            break response;
                        }
                        Some(_) => {}
                        None => panic!("offline local session closed"),
                    }
                }
            })
            .await
            .unwrap();
            assert!(response.problem.is_none(), "{:?}", response.problem);
        }
        daemon
            .access_change(|access| access.revoke(&GRANT.to_uuid_string()).cloned())
            .await
            .unwrap();
        closed(&mut ipc).await;
        closed(&mut link).await;
        for origin in [
            auth(SessionOrigin::LocalIpc),
            auth(SessionOrigin::RelayPipe),
            Auth::Link {
                client_pk: CLIENT_KEY,
            },
        ] {
            let refused = signed.open(&daemon, origin).await;
            assert_eq!(
                refused.response.problem.unwrap().reason.as_deref(),
                Some("grant_revoked_on_device")
            );
        }
        assert!(matches!(
            signed
                .runtime
                .grant_approval(GrantApprovalOp::Effective(GRANT))
                .await,
            Some(GrantApprovalReply::Effective(true))
        ));
        signed.stop().await;
    }
}
