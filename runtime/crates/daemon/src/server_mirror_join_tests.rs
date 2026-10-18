//! End to end on one device: the takeover captures an old hosted mirror's unsent
//! edits, the daemon joins the migrated hosted collection through its ordinary
//! `collection.join` (paired account, Connect enrolment, pinned genesis), syncs it
//! from a real in-memory log service keyed by a hosted replica, confirms the
//! cutover, and imports the edits with no manual step. Connect is a loopback
//! fixture that loses the first enrolment reply (the join is retried) and first
//! answers `not_cut_over` (the import waits).

use std::sync::atomic::{AtomicUsize, Ordering};

use mdbn_log_service::testkit::{ControlPlane, Device};
use mdbn_replica::policy::{EffectiveGrant, GrantSource, SERVICE_ACCOUNT};
use mdbn_wire::common::{B16, B32, Text, Uuid};
use mdbn_wire::intent::{Create, Op};
use mdbn_wire::policy::{CState, DeviceEnrol, DeviceKind, Genesis, MemberSet, PolicyOp, Role};
use tokio::io::AsyncReadExt;

use super::*;
use crate::takeover::mirror_import::tests::hosted_mirror::{self, BINARY, HOSTED, RB};

use crate::takeover::tests::old_agent;

const CP_LABEL: &str = "conformance";
const ACCOUNT: &str = "11111111-1111-4111-8111-111111111111";
const CONNECTOR: &str = "22222222-2222-4222-8222-222222222222";

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
fn device_token(device: [u8; 16], sign_pk: [u8; 32], collection: [u8; 16], exp: i64) -> String {
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

/// Connect, as far as this device's join, log tokens and migration record go.
struct Connect {
    genesis: Vec<u8>,
    log: String,
    device: [u8; 16],
    sign_pk: [u8; 32],
    enrolments: AtomicUsize,
    records: AtomicUsize,
}

impl Connect {
    fn answer(&self, request: &str) -> Option<(u16, Value)> {
        let line = request.lines().next().unwrap_or_default();
        let devices = format!("POST /v1/next/collections/{HOSTED}/devices ");
        let log_token = format!("POST /v1/next/collections/{HOSTED}/log-token ");
        let record = format!("GET /v1/next/collections/{HOSTED}/migration-record ");
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
        } else if line.starts_with(&record) {
            if self.records.fetch_add(1, Ordering::SeqCst) == 0 {
                return Some((409, json!({"error": {"code": "not_cut_over"}})));
            }
            Some((
                200,
                json!({"collection_id": HOSTED, "legacy_collection_id": HOSTED,
                    "ids_preserved": true, "s_final": "42", "cutover_seq": "10",
                    "barrier_f": "12", "final_digest": "ab".repeat(32),
                    "cutover_at": "2026-10-18T09:00:00.000Z"}),
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
    fn grant(&self, _: &Uuid) -> Option<EffectiveGrant> {
        None
    }
}

/// Create the collection's log with the control plane's own credential.
async fn create_log(log: &str, cp: &ControlPlane, c: Uuid, genesis: Vec<u8>) {
    use futures_util::{SinkExt, StreamExt};
    use mdbn_wire::cbor::Cbor;
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
        method: "create_log".into(),
        params: Cbor::Map(vec![
            (Cbor::Uint(0), c.to_cbor()),
            (Cbor::Uint(1), Cbor::Bytes(genesis)),
        ]),
    });
    ws.send(Message::Binary(frame.to_bytes().unwrap().into()))
        .await
        .unwrap();
    loop {
        if let Some(Ok(Message::Binary(b))) = ws.next().await
            && let Ok(LsFrame::Response(r)) = LsFrame::from_bytes(&b)
        {
            assert!(r.error.is_none(), "create_log: {:?}", r.error);
            break;
        }
    }
}

async fn record_doc(rt: &Arc<crate::runtime::Runtime>, key: &str) -> Option<(String, String)> {
    use crate::takeover::mirror_import::Target;
    let mut t = HostTarget { rt: rt.clone() };
    t.get(key).await.unwrap().map(|c| (c.path, c.document))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn takeover_joins_the_migrated_collection_and_imports_with_no_manual_step() {
    use mdbn_log_server::{AnyService, Gateway};
    use mdbn_log_service::Service;
    use mdbn_log_service::mem::{MemBackend, MemObjects};

    let dir = crate::testutil::TestDir::new("mj-e2e");
    let elsewhere = crate::testutil::TestDir::new("mj-e2e-dev");
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
    let mut d = daemon(&dir);
    {
        let owned = Arc::get_mut(&mut d).unwrap();
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

    // The migrated collection: owned by the account, enrolling the hosted
    // replica and this device (Connect enrols it on join; the genesis carries it
    // here for brevity).
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

    // The hosted replica, holding the collection as it was at cutover (legacy
    // record IDs kept).
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
    // Keyed and online before it takes writes.
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
    for (rid, path, doc) in hosted_mirror::server_records() {
        let ops = vec![Op::Create(Create {
            id: B16(uuid(rid)),
            path: Some(path.into()),
            type_name: None,
            frontmatter: None,
            body: None,
            document: Some(Text::Inline(doc.into())),
        })];
        assert_eq!(
            submit_as(&hosted_rt, ops, new_uuid_v7()).await.unwrap(),
            crate::takeover::held::Outcome::Confirmed
        );
    }

    // Connect, then sign this device in.
    let connect = Arc::new(Connect {
        genesis,
        log: log.clone(),
        device: identity.device_id,
        sign_pk: hex32(&public.sign_pk),
        enrolments: AtomicUsize::new(0),
        records: AtomicUsize::new(0),
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

    // The old device: a local collection and the hosted mirror with its queue.
    let old = elsewhere.path().join("connect");
    old_agent::build(&old, &elsewhere.path().join("notes"));
    let mirror_folder = elsewhere.path().join("Hosted notes");
    hosted_mirror::build(&old, &mirror_folder);
    let mirror_before: Vec<_> = walk(&mirror_folder);

    // The takeover (the account has moved): captured, not refused.
    let paths = d.takeover_paths();
    let ran = crate::takeover::run(
        &paths,
        &old,
        &mut crate::takeover::IsolatedOldService,
        &crate::takeover::Options {
            stop_mirrors: false,
            account_moved: true,
            drain: Duration::ZERO,
            now: "2026-10-18T09:00:00Z".into(),
        },
    )
    .unwrap();
    assert_eq!(
        ran.record.unwrap().state,
        crate::takeover::record::State::Complete
    );

    // The daemon's own loop from here: join, sync, cutover, import.
    let joined = elsewhere.path().join("Hosted notes (synced)");
    let mut saw_lost_reply = false;
    let mut saw_cut_over_wait = false;
    let mut reasons: Vec<String> = Vec::new();
    let deadline = std::time::Instant::now() + Duration::from_secs(120);
    let st = loop {
        d.import_mirrors().await;
        let st = d.takeover_status().await.unwrap();
        let mi = &st["mirror_imports"][HOSTED];
        if mi["join"]["reason"] == "sync_unreachable" && mi["join"]["state"] == "waiting" {
            saw_lost_reply = true;
            assert_eq!(
                mi["waiting"], 6,
                "edits stay captured while not joined: {st}"
            );
        }
        // The strict record reader reports any non-200 as `unexpected_status`.
        if mi["join"]["state"] == "joined"
            && mi["join"]["cut_over"] == false
            && mi["join"]["reason"] == "unexpected_status"
        {
            saw_cut_over_wait = true;
            assert_eq!(
                mi["applied"], 0,
                "nothing is written before the cutover: {st}"
            );
        }
        let seen = mi["join"].to_string();
        if reasons.last() != Some(&seen) {
            reasons.push(seen);
        }
        if mi["complete"] == true {
            break st;
        }
        assert!(std::time::Instant::now() < deadline, "never imported: {st}");
        tokio::time::sleep(Duration::from_millis(250)).await;
    };
    assert!(
        saw_lost_reply,
        "the lost enrolment reply was retried: {reasons:#?}"
    );
    assert!(
        saw_cut_over_wait,
        "the import waited for the cutover: {reasons:#?}"
    );
    assert_eq!(connect.enrolments.load(Ordering::SeqCst), 2);
    let mi = &st["mirror_imports"][HOSTED];
    assert_eq!(mi["registered"], true, "{st}");
    assert_eq!(mi["name"], "Hosted notes");
    assert_eq!(mi["join"]["state"], "joined");
    assert_eq!(mi["join"]["cut_over"], true);
    assert_eq!(mi["join"]["folder"], json!(joined.canonicalize().unwrap()));
    assert_eq!(mi["applied"], 4, "{st}");
    assert_eq!(mi["held"], 1);
    assert_eq!(mi["recovered"][0]["path"], "d.md");
    assert_eq!(
        std::fs::read(elsewhere.path().join("Hosted notes (unsent edits)/d.md")).unwrap(),
        BINARY
    );

    // The edits reached the hosted replica through the log.
    let deadline = std::time::Instant::now() + Duration::from_secs(60);
    loop {
        let a = record_doc(&hosted_rt, "a.md").await;
        let b = record_doc(&hosted_rt, RB).await;
        let n = record_doc(&hosted_rt, "n.md").await;
        let gone = record_doc(&hosted_rt, "c.md").await.is_none();
        if a.as_ref().map(|x| x.1.as_str()) == Some("A edited")
            && b.as_ref().map(|x| x.0.as_str()) == Some("sub/b2.md")
            && n.as_ref().map(|x| x.1.as_str()) == Some("New")
            && gone
        {
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "hosted never saw the edits: {a:?} {b:?} {n:?} c gone {gone}"
        );
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    assert_eq!(
        record_doc(&hosted_rt, "e.md").await.map(|x| x.1).as_deref(),
        Some("E theirs"),
        "the conflicting edit is held, not written over"
    );
    // On this device, in the joined folder.
    assert_eq!(
        std::fs::read_to_string(joined.join("a.md")).unwrap(),
        "A edited"
    );
    // The held edit is in this collection's holds.
    let holds = d.holds(HOSTED).await.unwrap();
    assert!(
        holds
            .as_array()
            .unwrap()
            .iter()
            .any(|h| h["reason"] == "unsent_edit" && h["path"] == "e.md"),
        "{holds}"
    );
    // The old mirror folder is exactly as it was.
    assert_eq!(walk(&mirror_folder), mirror_before);

    // Idempotent: further passes neither join nor write again.
    d.import_mirrors().await;
    assert_eq!(connect.enrolments.load(Ordering::SeqCst), 2);
    assert_eq!(
        d.takeover_status().await.unwrap()["mirror_imports"][HOSTED]["applied"],
        4
    );

    let mut inner = d.inner.lock().await;
    for host in inner.hosts.iter_mut() {
        host.close().await;
    }
    drop(inner);
    hosted_rt.stop().await;
    cp_server.abort();
    log_server.abort();
}

fn walk(dir: &std::path::Path) -> Vec<(std::path::PathBuf, Vec<u8>)> {
    let mut out = Vec::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        for e in std::fs::read_dir(&d).unwrap().flatten() {
            if e.file_type().unwrap().is_dir() {
                stack.push(e.path());
            } else {
                out.push((e.path(), std::fs::read(e.path()).unwrap()));
            }
        }
    }
    out.sort();
    out
}
