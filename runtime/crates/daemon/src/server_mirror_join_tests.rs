//! Loopback cloud/log fixture shared by `server_rejoin_tests` and `server_private_approval_tests`.

use std::sync::atomic::{AtomicUsize, Ordering};

use mdbn_log_service::testkit::{ControlPlane, Device};
use mdbn_replica::policy::{EffectiveGrant, GrantSource, SERVICE_ACCOUNT};
use mdbn_wire::common::{B16, B32, Text, Uuid};
use mdbn_wire::intent::{Create, Op};
use mdbn_wire::policy::{CState, DeviceEnrol, DeviceKind, Genesis, MemberSet, PolicyOp, Role};
use tokio::io::AsyncReadExt;

use super::*;

pub(in crate::server) const CP_LABEL: &str = "conformance";
const ACCOUNT: &str = "11111111-1111-4111-8111-111111111111";
const CONNECTOR: &str = "22222222-2222-4222-8222-222222222222";
const HOSTED: &str = "44444444-4444-4444-8444-444444444444";

fn server_records() -> &'static [(&'static str, &'static str, &'static str)] {
    &[
        ("a0000000-0000-4000-8000-000000000001", "a.md", "A base"),
        ("a0000000-0000-4000-8000-000000000002", "b.md", "B base"),
        ("a0000000-0000-4000-8000-000000000003", "c.md", "C base"),
        ("a0000000-0000-4000-8000-000000000004", "d.md", "D base"),
        ("a0000000-0000-4000-8000-000000000005", "e.md", "E base"),
    ]
}

fn now_ms() -> i64 {
    fsutil::now_ms() as i64
}

fn uuid(s: &str) -> [u8; 16] {
    crate::attest::uuid_bytes(s).unwrap()
}

fn hex32(h: &str) -> [u8; 32] {
    secrets::hex_decode(h).unwrap().try_into().unwrap()
}

/// A device log token from the test control plane's issuer, bound to `sign_pk`.
pub(in crate::server) fn device_token(
    device: [u8; 16],
    sign_pk: [u8; 32],
    collection: [u8; 16],
    exp: i64,
) -> String {
    use ed25519_dalek::Signer;
    let claims = mdbn_log_service::auth::Claims {
        control_plane: false,
        device: Some(B16(device)),
        sign_pk: B32(sign_pk),
        expires_at: exp,
        collection: Some(B16(collection)),
    }
    .encode();
    let issuer = mdbn_log_service::testkit::key(format!("{CP_LABEL}/issuer").as_bytes());
    let sig = issuer.sign(&mdbn_log_service::auth::token_digest(&claims).0);
    format!(
        "{}.{}",
        mdbn_wire::render::hex(&claims),
        mdbn_wire::render::hex(&sig.to_bytes())
    )
}

/// Loopback Connect fixture for device join and log tokens.
struct Connect {
    genesis: Vec<u8>,
    log: String,
    device: [u8; 16],
    sign_pk: [u8; 32],
    enrolments: AtomicUsize,
}

impl Connect {
    fn answer(&self, request: &str) -> Option<(u16, Value)> {
        let line = request.lines().next().unwrap_or_default();
        let devices = format!("POST /v1/next/collections/{HOSTED}/devices ");
        let log_token = format!("POST /v1/next/collections/{HOSTED}/log-token ");
        let exp = now_ms() + 15 * 60_000;
        if line.starts_with("POST /v1/next/devices/challenge ") {
            let c: [u8; 32] = rand_bytes();
            Some((200, json!({"challenge": secrets::hex(&c)})))
        } else if line.starts_with(&devices) {
            // The first enrolment commits, then its reply is lost.
            if self.enrolments.fetch_add(1, Ordering::SeqCst) == 0 {
                return None;
            }
            Some((
                200,
                json!({"collection_id": HOSTED, "enrolled_at": "2", "log_url": self.log,
                    "genesis": {"seq": 1, "item": secrets::hex(&self.genesis)},
                    "device": {"token": device_token(self.device, self.sign_pk, uuid(HOSTED), exp),
                        "expires_at": exp}}),
            ))
        } else if line.starts_with(&log_token) {
            Some((
                200,
                json!({"token": device_token(self.device, self.sign_pk, uuid(HOSTED), exp),
                    "expires_at": exp}),
            ))
        } else {
            Some((503, json!({"error": {"code": "unavailable"}})))
        }
    }

    async fn serve(self: Arc<Self>, listener: tokio::net::TcpListener) {
        loop {
            let Ok((mut socket, _)) = listener.accept().await else {
                return;
            };
            let this = self.clone();
            tokio::spawn(async move {
                let mut request = Vec::new();
                loop {
                    let mut buf = [0; 4096];
                    let Ok(n) = socket.read(&mut buf).await else {
                        return;
                    };
                    if n == 0 {
                        return;
                    }
                    request.extend_from_slice(&buf[..n]);
                    if let Some(end) = request.windows(4).position(|w| w == b"\r\n\r\n") {
                        let head = String::from_utf8_lossy(&request[..end]).to_ascii_lowercase();
                        let length: usize = head
                            .lines()
                            .find_map(|l| l.strip_prefix("content-length:"))
                            .map(|v| v.trim().parse().unwrap())
                            .unwrap_or(0);
                        if request.len() >= end + 4 + length {
                            break;
                        }
                    }
                }
                let text = String::from_utf8_lossy(&request).into_owned();
                let Some((status, body)) = this.answer(&text) else {
                    return; // dropped: no reply
                };
                let body = body.to_string();
                let response = format!(
                    "HTTP/1.1 {status} Fixture\r\nContent-Type: application/json\r\nCache-Control: no-store\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = socket.write_all(response.as_bytes()).await;
            });
        }
    }
}

fn rand_bytes<const N: usize>() -> [u8; N] {
    let mut b = [0u8; N];
    getrandom::fill(&mut b).unwrap();
    b
}

/// The hosted replica's log tokens.
struct HostedTokens {
    cp: Arc<ControlPlane>,
    collection: Uuid,
}

impl crate::logwire::TokenSource for HostedTokens {
    fn token(
        &self,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<crate::logwire::Token, String>> + Send + '_>,
    > {
        let exp = now_ms() + 15 * 60_000;
        let token = self.cp.device_token_for(
            &Device::new("hosted", SERVICE_ACCOUNT),
            exp,
            Some(self.collection),
        );
        Box::pin(async move {
            Ok(crate::logwire::Token {
                token: token.into(),
                expires_at_ms: exp,
            })
        })
    }
    fn current(&self) -> Result<(), String> {
        Ok(())
    }
}

struct NoGrants;
impl GrantSource for NoGrants {
    fn grant(&self, _: &Uuid) -> mdbn_replica::api::ApiResult<EffectiveGrant> {
        Err(mdbn_replica::api::ErrorCode::Unauthenticated.err("the grant was revoked"))
    }
}

/// Create the collection's log with the control plane's own credential.
pub(in crate::server) async fn create_log(log: &str, cp: &ControlPlane, c: Uuid, genesis: Vec<u8>) {
    use mdbn_wire::cbor::Cbor;
    use mdbn_wire::schema::Wire;
    admin_log_rpc(
        log,
        cp,
        c,
        "create_log",
        Cbor::Map(vec![
            (Cbor::Uint(0), c.to_cbor()),
            (Cbor::Uint(1), Cbor::Bytes(genesis)),
        ]),
    )
    .await;
}

pub(in crate::server) async fn admin_log_rpc(
    log: &str,
    cp: &ControlPlane,
    c: Uuid,
    method: &str,
    params: mdbn_wire::cbor::Cbor,
) -> mdbn_wire::cbor::Cbor {
    use futures_util::{SinkExt, StreamExt};
    use mdbn_wire::log_service::{LsFrame, LsRequest};
    use mdbn_wire::schema::Wire;
    use tokio_tungstenite::tungstenite::Message;
    let url = crate::logwire::ws_url(log, &c).unwrap();
    assert!(url.starts_with("ws://127.0.0.1:"), "loopback only");
    let (mut ws, response) = tokio_tungstenite::connect_async(&url).await.unwrap();
    let nonce = hex32(
        response
            .headers()
            .get("x-mdbase-nonce")
            .unwrap()
            .to_str()
            .unwrap(),
    );
    let token = cp.cp_token(now_ms() + 15 * 60_000);
    let digest = mdbn_log_service::auth::hello_digest(&nonce, &token);
    let hello = LsFrame::Request(LsRequest {
        id: 1 << 62,
        method: "hello".into(),
        params: mdbn_wire::log_service::LsHelloParams {
            version: mdbn_wire::common::Version { major: 1, minor: 0 },
            token,
            device: None,
            sig: mdbn_log_service::testkit::sign_digest(cp.transport_key(), &digest),
        }
        .to_cbor(),
    });
    ws.send(Message::Binary(hello.to_bytes().unwrap().into()))
        .await
        .unwrap();
    loop {
        if let Some(Ok(Message::Binary(b))) = ws.next().await
            && let Ok(LsFrame::Response(r)) = LsFrame::from_bytes(&b)
            && r.id == 1 << 62
        {
            assert!(r.error.is_none(), "admin hello refused");
            break;
        }
    }
    let frame = LsFrame::Request(LsRequest {
        id: 1,
        method: method.into(),
        params,
    });
    ws.send(Message::Binary(frame.to_bytes().unwrap().into()))
        .await
        .unwrap();
    loop {
        if let Some(Ok(Message::Binary(b))) = ws.next().await
            && let Ok(LsFrame::Response(r)) = LsFrame::from_bytes(&b)
            && r.id == 1
        {
            assert!(r.error.is_none(), "{method}: {:?}", r.error);
            return r.result.unwrap();
        }
    }
}

pub(super) async fn record_doc(
    rt: &Arc<crate::runtime::Runtime>,
    key: &str,
) -> Option<(String, String)> {
    record_at(rt, key)
        .await
        .unwrap()
        .map(|r| (r.path, r.document.unwrap_or_default()))
}

struct CloudFixture {
    d: Arc<Daemon>,
    hosted_rt: Arc<crate::runtime::Runtime>,
    connect: Arc<Connect>,
    cp_server: tokio::task::JoinHandle<()>,
    log_server: tokio::task::JoinHandle<std::io::Result<()>>,
}

impl CloudFixture {
    async fn stop(self) {
        let mut inner = self.d.inner.lock().await;
        for host in &mut inner.hosts {
            host.close().await;
        }
        drop(inner);
        self.hosted_rt.stop().await;
        self.cp_server.abort();
        self.log_server.abort();
    }
}

async fn cloud_fixture(
    dir: &crate::testutil::TestDir,
    elsewhere: &crate::testutil::TestDir,
) -> CloudFixture {
    use mdbn_log_server::{AnyService, Gateway};
    use mdbn_log_service::Service;
    use mdbn_log_service::mem::{MemBackend, MemObjects};

    let cp = Arc::new(ControlPlane::new(CP_LABEL));

    // The log service (real, in memory) on loopback.
    let log_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let log = format!("http://{}", log_listener.local_addr().unwrap());
    let gateway = Gateway::new(
        AnyService::Mem(Service::new(
            MemBackend::default(),
            MemObjects::default(),
            mdbn_log_server::testkit_config(CP_LABEL, &log),
        )),
        false,
    );
    let log_server = tokio::spawn(mdbn_log_server::serve(gateway, log_listener));

    // This device: trust pinned to the test control plane and log.
    let cp_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let cp_origin = format!("http://{}", cp_listener.local_addr().unwrap());
    let mut d = daemon(dir);
    {
        let owned = Arc::get_mut(&mut d).unwrap();
        owned.identity = Default::default();
        owned.trust = Some(Arc::new(crate::trust::Trust {
            environment: crate::trust::Environment::Lab.name().into(),
            cp_origin: cp_origin.clone(),
            log_origin: log.clone(),
            roots: vec![cp.root_pk().0],
            policy_pins: crate::trust::pins_for(
                cp.root_pk().0,
                cp.transport_key().verifying_key().to_bytes(),
            ),
        }));
    }
    initialize(d.clone()).await;
    let identity = d.identity.get().unwrap().clone();
    let public = identity.public();

    let c = B16(uuid(HOSTED));
    let owner = B16(uuid(ACCOUNT));
    let hosted_kem: [u8; 32] = rand_bytes();
    let hosted = Device::new("hosted", SERVICE_ACCOUNT);
    let genesis = cp.policy_item(
        c,
        1,
        B32([0; 32]),
        vec![
            PolicyOp::Genesis(Genesis {
                owner,
                root: mdbn_log_service::policy::key_id(&cp.root_pk()),
                state: CState::CloudCopy,
            }),
            PolicyOp::MemberSet(MemberSet {
                account: owner,
                role: Role::Owner,
            }),
            PolicyOp::DeviceEnrol(DeviceEnrol {
                device: hosted.id,
                account: SERVICE_ACCOUNT,
                kind: DeviceKind::Hosted,
                sign_pk: hosted.pk(),
                kem_pk: B32(mdbn_replica::crypto::hpke::KemKeyPair::from_secret(&hosted_kem).pk),
                noise_pk: B32(
                    mdbn_replica::crypto::hpke::KemKeyPair::from_secret(&rand_bytes()).pk,
                ),
                sas_commit: None,
                local_root: None,
            }),
            Device::new("escrow", SERVICE_ACCOUNT).enrol(DeviceKind::Escrow),
            PolicyOp::DeviceEnrol(DeviceEnrol {
                device: B16(identity.device_id),
                account: owner,
                kind: DeviceKind::Desktop,
                sign_pk: B32(hex32(&public.sign_pk)),
                kem_pk: B32(hex32(&public.kem_pk)),
                noise_pk: B32(hex32(&public.noise_pk)),
                sas_commit: None,
                local_root: None,
            }),
        ],
        1,
    );
    let pin = mdbn_wire::hash::chain_hash(&genesis).0;
    create_log(&log, &cp, c, genesis.clone()).await;

    let hosted_secrets: Arc<dyn crate::secrets::SecretStore> =
        Arc::new(crate::secrets::MemoryStore::default());
    std::fs::create_dir_all(elsewhere.path().join("hosted")).unwrap();
    let hosted_rt = Arc::new(
        crate::runtime::Runtime::open(
            crate::runtime::RuntimeConfig {
                collection: c.0,
                replica_id: rand_bytes(),
                device_id: hosted.id.0,
                root: elsewhere.path().join("hosted"),
                private_dir: elsewhere.path().join("hosted-state"),
                adopt: None,
                id_hints: vec![],
                computer_name: None,
                sync: Some(crate::runtime::Synced {
                    log_url: log.clone(),
                    chosen_state: CState::CloudCopy,
                    trusted_roots: vec![cp.root_pk().0],
                    trusted_signers: vec![],
                    user_enabled_cloud_copy: true,
                    tokens: Arc::new(HostedTokens {
                        cp: cp.clone(),
                        collection: c,
                    }),
                    secrets: hosted_secrets,
                    expected_genesis: pin,
                    policy_pins: crate::trust::pins_for(
                        cp.root_pk().0,
                        cp.transport_key().verifying_key().to_bytes(),
                    ),
                }),
            },
            mdbn_replica::DeviceSecrets {
                sign_sk: mdbn_wire::hash::sha256(b"device/hosted").0,
                kem_sk: hosted_kem,
            },
            Box::new(NoGrants),
            Default::default(),
        )
        .unwrap_or_else(|e| panic!("open hosted: {}", e.0)),
    );
    for _ in 0..200 {
        if hosted_rt
            .status()
            .await
            .is_some_and(|s| s.confirmed_head.is_some() && s.incidents.is_empty())
        {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    for (rid, path, doc) in server_records() {
        let ops = vec![Op::Create(Create {
            id: B16(uuid(rid)),
            path: Some((*path).into()),
            type_name: None,
            frontmatter: None,
            body: None,
            document: Some(Text::Inline((*doc).into())),
        })];
        assert_eq!(
            submit_as(&hosted_rt, ops, new_uuid_v7()).await.unwrap(),
            mdbn_wire::client::ReceiptState::Confirmed
        );
    }

    let connect = Arc::new(Connect {
        genesis,
        log: log.clone(),
        device: identity.device_id,
        sign_pk: hex32(&public.sign_pk),
        enrolments: AtomicUsize::new(0),
    });
    let cp_server = tokio::spawn(connect.clone().serve(cp_listener));
    let epoch = d.begin_pairing().await.unwrap();
    d.publish_pairing(
        epoch,
        crate::cloud::CloudConfig {
            schema_version: 1,
            account_epoch: epoch,
            connector_id: Some(CONNECTOR.into()),
            server_url: cp_origin.clone(),
            ..Default::default()
        },
        ACCOUNT,
        b"con_hermetic_fixture",
    )
    .await
    .unwrap();

    CloudFixture {
        d,
        hosted_rt,
        connect,
        cp_server,
        log_server,
    }
}

#[path = "server_rejoin_tests.rs"]
mod rejoin_tests;
