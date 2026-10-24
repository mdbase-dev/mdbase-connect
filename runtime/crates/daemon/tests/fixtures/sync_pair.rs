//! The sync_pair scenario (test tooling, never shipped): shared by the
//! `sync_pair` example (against an external log service) and the CI integration
//! test `tests/sync_pair.rs` (against an in-process in-memory log service).
//!
//! Two daemon runtimes and a hosted-kind runtime converging on one cloud-copy
//! collection through a real log service (test tooling, never shipped).
//!
//! ```text
//! logsvc --listen 127.0.0.1:7700 --testkit-cp conformance --insecure-test-keys &
//! sync_pair --log http://127.0.0.1:7700 --dir <scratch>
//! ```
//!
//! The log service pins the deterministic `conformance` test control plane, so the
//! genesis and the device tokens here are test-only; loopback only. Hosted is played
//! by a third runtime whose policy kind is `hosted`: the same replica code as the
//! hosted Worker's engine. As the first keyed replica, it wraps the epoch to the
//! two desktops.
//!
//! Checks: both desktops keyed by hosted; a write on A appears on B and back;
//! edits made while B is stopped converge after it restarts; concurrent edits of one
//! file converge to the same confirmed records on every replica (compared by digest),
//! with the conflict recorded; a binary attachment dropped on A is uploaded,
//! fetched and placed byte-identical on B, then renamed and deleted there. On disk, the losing device's edit is held, not
//! overwritten, so the two folders differ there by design.
#![allow(dead_code)]

use std::path::Path;
use std::pin::Pin;
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use mdbn_daemon::logwire::{Token, TokenSource};
use mdbn_daemon::runtime::{Runtime, RuntimeConfig, Synced};
use mdbn_log_service::testkit::{ControlPlane, Device, sign_digest};
use mdbn_replica::DeviceSecrets;
use mdbn_replica::crypto::hpke::KemKeyPair;
use mdbn_replica::policy::{EffectiveGrant, GrantSource, SERVICE_ACCOUNT};
use mdbn_wire::cbor::Cbor;
use mdbn_wire::common::{B16, B32, Uuid};
use mdbn_wire::log_service::{LsFrame, LsRequest};
use mdbn_wire::policy::{CState, DeviceEnrol, DeviceKind, Genesis, MemberSet, PolicyOp, Role};
use mdbn_wire::schema::Wire;
use tokio_tungstenite::tungstenite::Message;

const CP_LABEL: &str = "conformance";

/// Published-key pins for one root and one policy key (test tooling).
fn pins(root: [u8; 32], policy: [u8; 32]) -> mdbn_replica::policy::PolicyPins {
    use mdbn_replica::policy::{PolicyKeyPin, PolicyPins, RootPin, key_id};
    PolicyPins {
        roots: vec![RootPin {
            root_id: key_id(&root),
            root_pk: B32(root),
        }],
        policy_keys: vec![PolicyKeyPin {
            key_id: key_id(&policy),
            policy_pk: B32(policy),
            root_id: key_id(&root),
        }],
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}

fn random<const N: usize>() -> [u8; N] {
    let mut b = [0u8; N];
    getrandom::fill(&mut b).unwrap();
    b
}

/// One test device: the testkit's deterministic signing key, a random KEM key.
struct Dev {
    label: &'static str,
    kind: DeviceKind,
    account: Uuid,
    tk: Device,
    kem_sk: [u8; 32],
    noise_pk: B32,
    /// This device's credential store (its epoch keyring lives here, across restarts).
    secrets: Arc<dyn mdbn_daemon::secrets::SecretStore>,
}

impl Dev {
    fn new(label: &'static str, kind: DeviceKind, account: Uuid) -> Dev {
        Dev {
            label,
            kind,
            account,
            tk: Device::new(label, account),
            kem_sk: random(),
            noise_pk: B32(KemKeyPair::from_secret(&random()).pk),
            secrets: Arc::new(mdbn_daemon::secrets::MemoryStore::default()),
        }
    }
    fn secrets(&self) -> DeviceSecrets {
        DeviceSecrets {
            sign_sk: mdbn_wire::hash::sha256(format!("device/{}", self.label).as_bytes()).0,
            kem_sk: self.kem_sk,
        }
    }
    fn enrol(&self) -> PolicyOp {
        self.enrol_with(None)
    }
    fn enrol_with(&self, sas_commit: Option<B32>) -> PolicyOp {
        PolicyOp::DeviceEnrol(DeviceEnrol {
            device: self.tk.id,
            account: self.account,
            kind: self.kind,
            sign_pk: self.tk.pk(),
            kem_pk: B32(KemKeyPair::from_secret(&self.kem_sk).pk),
            noise_pk: self.noise_pk,
            sas_commit,
            local_root: None,
        })
    }
    fn keys(&self) -> mdbn_replica::crypto::keys::EnrolledKeys {
        mdbn_replica::crypto::keys::EnrolledKeys {
            device: self.tk.id,
            sign_pk: self.tk.pk().0,
            kem_pk: KemKeyPair::from_secret(&self.kem_sk).pk,
            noise_pk: self.noise_pk.0,
        }
    }
}

/// Tokens minted by the test control plane: a device's (one collection) or its own.
struct Tokens {
    cp: Arc<ControlPlane>,
    device: Option<Device>,
    collection: Uuid,
}

impl TokenSource for Tokens {
    fn token(
        &self,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<Token, String>> + Send + '_>> {
        let exp = now_ms() + 15 * 60_000;
        let token = match &self.device {
            Some(d) => self.cp.device_token_for(d, exp, Some(self.collection)),
            None => self.cp.cp_token(exp),
        };
        Box::pin(async move {
            Ok(Token {
                token: token.into(),
                expires_at_ms: exp,
            })
        })
    }
    fn current(&self) -> Result<(), String> {
        Ok(())
    } // explicit loopback synthetic source
}

/// Host-only runtimes: no app grants.
struct NoGrants;
impl GrantSource for NoGrants {
    fn grant(&self, _: &Uuid) -> Option<EffectiveGrant> {
        None
    }
}

/// `create_log` with the control plane's own credential, over the transport.
async fn create_log(log: &str, cp: Arc<ControlPlane>, c: Uuid, genesis: Vec<u8>) {
    cp_rpc(
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
async fn cp_rpc(log: &str, cp: Arc<ControlPlane>, c: Uuid, method: &str, params: Cbor) -> Cbor {
    // Administrative test-control credential is NOT a Replica log-session port.
    // Keep it on its own raw LOOPBACK connection; no forged reply/prefix scope.
    let url = mdbn_daemon::logwire::ws_url(log, &c).unwrap();
    assert!(
        url.starts_with("ws://127.0.0.1:") || url.starts_with("ws://localhost:"),
        "synthetic admin helper is loopback-only"
    );
    let (mut ws, response) = tokio_tungstenite::connect_async(&url).await.unwrap();
    let nonce: [u8; 32] = mdbn_daemon::secrets::hex_decode(
        response
            .headers()
            .get("x-mdbase-nonce")
            .unwrap()
            .to_str()
            .unwrap(),
    )
    .unwrap()
    .try_into()
    .unwrap();
    let token = cp.cp_token(now_ms() + 15 * 60_000);
    let digest = mdbn_log_service::auth::hello_digest(&nonce, &token);
    let hello_id = 1 << 62;
    let hello = LsFrame::Request(LsRequest {
        id: hello_id,
        method: "hello".into(),
        params: mdbn_wire::log_service::LsHelloParams {
            version: mdbn_wire::common::Version { major: 1, minor: 0 },
            token,
            device: None,
            sig: sign_digest(cp.transport_key(), &digest),
        }
        .to_cbor(),
    });
    ws.send(Message::Binary(hello.to_bytes().unwrap().into()))
        .await
        .unwrap();
    loop {
        if let Some(Ok(Message::Binary(bytes))) = ws.next().await
            && let Ok(LsFrame::Response(r)) = LsFrame::from_bytes(&bytes)
            && r.id == hello_id
        {
            assert!(
                r.error.is_none() && r.result.is_some(),
                "synthetic admin hello refused"
            );
            break;
        }
    }
    let frame = LsFrame::Request(LsRequest {
        id: 1,
        method: method.into(),
        params,
    })
    .to_bytes()
    .unwrap();
    ws.send(Message::Binary(frame.into())).await.unwrap();
    loop {
        if let Some(Ok(Message::Binary(bytes))) = ws.next().await {
            let Ok(LsFrame::Response(r)) = LsFrame::from_bytes(&bytes) else {
                panic!("create_log reply")
            };
            assert!(r.error.is_none(), "{method}: {:?}", r.error);
            return r.result.expect("successful admin result");
        }
    }
}

/// A paired desktop's host authority: its account, incarnation and Noise key.
struct Paired {
    account: Uuid,
    noise_pk: B32,
}
impl GrantSource for Paired {
    fn grant(&self, _: &Uuid) -> Option<EffectiveGrant> {
        None
    }
    fn active_account(&self) -> Option<Uuid> {
        Some(self.account)
    }
    fn authority_epoch(&self) -> Option<u64> {
        Some(1)
    }
    fn device_noise_pk(&self) -> Option<B32> {
        Some(self.noise_pk)
    }
}

fn open(
    dir: &Path,
    log: &str,
    cp: &Arc<ControlPlane>,
    c: Uuid,
    d: &Dev,
    replica: [u8; 16],
    genesis: [u8; 32],
) -> Runtime {
    open_with(dir, log, cp, c, d, replica, genesis, CState::CloudCopy)
}

#[allow(clippy::too_many_arguments)]
fn open_with(
    dir: &Path,
    log: &str,
    cp: &Arc<ControlPlane>,
    c: Uuid,
    d: &Dev,
    replica: [u8; 16],
    genesis: [u8; 32],
    state: CState,
) -> Runtime {
    let private = state == CState::E2e;
    let folder = dir.join(d.label);
    std::fs::create_dir_all(&folder).unwrap();
    let cfg = RuntimeConfig {
        collection: c.0,
        replica_id: replica,
        device_id: d.tk.id.0,
        root: folder,
        private_dir: dir.join(format!("{}-state", d.label)),
        adopt: None,
        id_hints: vec![],
        computer_name: None,
        sync: Some(Synced {
            log_url: log.into(),
            chosen_state: state,
            trusted_roots: vec![cp.root_pk().0],
            trusted_signers: if private { vec![d.tk.id.0] } else { vec![] },
            user_enabled_cloud_copy: !private,
            tokens: Arc::new(Tokens {
                cp: cp.clone(),
                device: Some(Device::new(d.label, d.account)),
                collection: c,
            }),
            secrets: d.secrets.clone(),
            expected_genesis: genesis,
            policy_pins: pins(
                cp.root_pk().0,
                cp.transport_key().verifying_key().to_bytes(),
            ),
        }),
    };
    let grants: Box<dyn GrantSource + Send> = if private {
        Box::new(Paired {
            account: d.account,
            noise_pk: d.noise_pk,
        })
    } else {
        Box::new(NoGrants)
    };
    Runtime::open(cfg, d.secrets(), grants, Default::default())
        .unwrap_or_else(|e| panic!("open {}: {}", d.label, e.0))
}

/// A host session on `rt` (the daemon is the host).
async fn host(rt: &Runtime) -> mdbn_replica::api::SessionId {
    use mdbn_wire::client::{ClientFrame, ClientRequest, HelloParams};
    let hello = ClientFrame::Request(ClientRequest {
        id: 0,
        method: "hello".into(),
        params: HelloParams {
            versions: vec![mdbn_wire::common::Version { major: 1, minor: 0 }],
            client_name: "sync-pair".into(),
            client_version: "0".into(),
            features: None,
            timezone: None,
        }
        .to_cbor(),
    })
    .to_bytes()
    .unwrap();
    let (session, response, out) = rt
        .hello(mdbn_replica::api::SessionAuth::Host, hello)
        .await
        .unwrap();
    std::mem::forget(out); // keep the session's transport open
    session.unwrap_or_else(|| {
        panic!(
            "host hello refused: {:?}",
            ClientFrame::from_bytes(&response)
        )
    })
}

/// The requester's secret state, shared across runtime calls (the daemon keeps
/// it in the OS keychain).
#[derive(Clone, Default)]
struct Journal(Arc<std::sync::Mutex<Option<Vec<u8>>>>);
impl mdbn_replica::replica::ApprovalSecretJournal for Journal {
    fn load(
        &mut self,
    ) -> Result<Option<zeroize::Zeroizing<Vec<u8>>>, mdbn_replica::replica::ApprovalPersistenceError>
    {
        Ok(self.0.lock().unwrap().clone().map(zeroize::Zeroizing::new))
    }
    fn save(
        &mut self,
        state: &[u8],
    ) -> Result<(), mdbn_replica::replica::ApprovalPersistenceError> {
        *self.0.lock().unwrap() = Some(state.to_vec());
        Ok(())
    }
}

async fn approval(
    rt: &Runtime,
    op: mdbn_daemon::runtime::DeviceApprovalOp,
) -> Result<mdbn_daemon::runtime::DeviceApprovalReply, Box<mdbn_wire::client::Problem>> {
    rt.device_approval(op).await.expect("runtime running")
}

/// Second-computer approval on a private collection, through the real log
/// service: A creates it and keys itself; B is enrolled with its commitment and
/// waits; A allows it (no code), B answers, A's key grant keys B, and a note
/// written on A opens on B. The peer inbox between them is the control plane's
/// (tested on its own); here the signed messages are handed across directly.
pub async fn run_private_approval(log: &str, dir: &Path) {
    use mdbn_daemon::runtime::{DeviceApprovalOp as Op, DeviceApprovalReply as Reply};
    use mdbn_replica::replica::{ApprovalDisposition, ApprovalPeerMessage};
    std::fs::create_dir_all(dir).unwrap();
    let cp = Arc::new(ControlPlane::new(CP_LABEL));
    let c = B16(random());
    let owner = B16(random());
    let a = Dev::new("private-a", DeviceKind::Desktop, owner);
    let b = Dev::new("private-b", DeviceKind::Desktop, owner);
    let requester =
        mdbn_replica::approval::NewDevice::new(c, b.keys(), &mut mdbn_local_host::OsEntropy);
    let journal = Journal::default();
    *journal.0.lock().unwrap() = Some(requester.state().to_vec());
    let genesis = cp.policy_item(
        c,
        1,
        B32([0; 32]),
        vec![
            PolicyOp::Genesis(Genesis {
                owner,
                root: mdbn_log_service::policy::key_id(&cp.root_pk()),
                state: CState::E2e,
            }),
            PolicyOp::MemberSet(MemberSet {
                account: owner,
                role: Role::Owner,
            }),
            a.enrol(),
            b.enrol_with(Some(B32(requester.commitment()))),
        ],
        1,
    );
    let pin = mdbn_wire::hash::chain_hash(&genesis).0;
    create_log(log, cp.clone(), c, genesis).await;
    let ra = open_with(dir, log, &cp, c, &a, random(), pin, CState::E2e);
    let rb = open_with(dir, log, &cp, c, &b, random(), pin, CState::E2e);
    let (sa, sb) = (host(&ra).await, host(&rb).await);

    // A keys itself (the initial rekey); B then sees B waiting, A sees it pending.
    let t0 = Instant::now();
    loop {
        let waiting = matches!(
            approval(&rb, Op::Waiting(sb, Box::new(journal.clone()), false)).await,
            Ok(Reply::Waiting {
                waiting: true,
                to_log: None
            })
        );
        let pending = matches!(
            approval(&ra, Op::Pending(sa)).await,
            Ok(Reply::Pending(list)) if list.iter().any(|d| d.device == b.tk.id)
        );
        if waiting && pending {
            break;
        }
        assert!(
            t0.elapsed() < Duration::from_secs(60),
            "B never became a pending requester"
        );
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    println!(
        "PASS: B waits for approval and A lists it ({:?})",
        t0.elapsed()
    );

    // Listing prepares the exchange before the user's one final Allow.
    assert!(
        approval(&ra, Op::Allow(sa, b.tk.id, "000000".into()))
            .await
            .is_err()
    );
    let Ok(Reply::Envelope(challenge)) = approval(&ra, Op::Start(sa, b.tk.id)).await else {
        panic!("A did not start the exchange")
    };
    assert!(matches!(
        challenge.message,
        ApprovalPeerMessage::Challenge(_)
    ));
    let Ok(Reply::Envelope(reveal)) = approval(
        &rb,
        Op::Challenge(sb, challenge.clone(), Box::new(journal.clone())),
    )
    .await
    else {
        panic!("B did not answer the challenge")
    };
    // The same challenge is answered once only.
    assert!(
        approval(&rb, Op::Challenge(sb, challenge, Box::new(journal.clone())))
            .await
            .is_err()
    );
    assert!(matches!(
        approval(&ra, Op::Reveal(sa, reveal)).await,
        Ok(Reply::Done)
    ));
    let Ok(Reply::Code(Some(requester_code))) = approval(&rb, Op::Code(sb)).await else {
        panic!("B did not show the verification code")
    };
    let Ok(Reply::Pending(list)) = approval(&ra, Op::Pending(sa)).await else {
        panic!("A could not list the verification code")
    };
    let approver_code = list
        .iter()
        .find(|d| d.device == b.tk.id)
        .unwrap()
        .sas
        .as_ref()
        .unwrap();
    assert_eq!(
        approver_code, &requester_code,
        "both computers must show the same code"
    );
    assert_eq!(requester_code.len(), 6);
    let Ok(Reply::Allowed(intent, mut state)) =
        approval(&ra, Op::Allow(sa, b.tk.id, requester_code)).await
    else {
        panic!("A could not allow B")
    };
    let t1 = Instant::now();
    while !matches!(state, ApprovalDisposition::Applied { .. }) {
        assert!(
            !matches!(state, ApprovalDisposition::Refused(_)),
            "approval refused: {state:?}"
        );
        assert!(
            t1.elapsed() < Duration::from_secs(60),
            "key grant never applied: {state:?}"
        );
        tokio::time::sleep(Duration::from_millis(200)).await;
        state = match approval(&ra, Op::Disposition(sa, intent)).await {
            Ok(Reply::Disposition(d)) => d,
            _ => panic!("disposition"),
        };
    }
    println!("PASS: A's key grant applied ({:?})", t1.elapsed());

    // B is keyed: no longer waiting, and A's notes open there.
    std::fs::write(dir.join(a.label).join("from-a.md"), "private on A\n").unwrap();
    converge(
        &dir.join(b.label).join("from-a.md"),
        "private on A\n",
        Duration::from_secs(60),
    )
    .await;
    assert!(matches!(
        approval(&rb, Op::Waiting(sb, Box::new(journal.clone()), false)).await,
        Ok(Reply::Waiting { waiting: false, .. })
    ));
    assert!(
        matches!(approval(&ra, Op::Pending(sa)).await, Ok(Reply::Pending(list)) if list.is_empty())
    );
    std::fs::write(dir.join(b.label).join("from-b.md"), "private on B\n").unwrap();
    converge(
        &dir.join(a.label).join("from-b.md"),
        "private on B\n",
        Duration::from_secs(60),
    )
    .await;
    println!("PASS: B keyed by A; notes open both ways");
    ra.stop().await;
    rb.stop().await;
}

/// Wait until `path` holds exactly `want`.
async fn converge(path: &Path, want: &str, within: Duration) -> Duration {
    let t0 = Instant::now();
    loop {
        if std::fs::read_to_string(path).ok().as_deref() == Some(want) {
            return t0.elapsed();
        }
        if t0.elapsed() > within {
            panic!(
                "{} never became {want:?} (now {:?})",
                path.display(),
                std::fs::read_to_string(path).ok()
            );
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

/// Wait until `path` holds exactly `want` (binary).
async fn converge_bytes(path: &Path, want: &[u8], within: Duration) {
    let t0 = Instant::now();
    loop {
        if std::fs::metadata(path).is_ok_and(|m| m.len() == want.len() as u64)
            && std::fs::read(path).ok().as_deref() == Some(want)
        {
            return;
        }
        if t0.elapsed() > within {
            panic!(
                "{} never held the expected {} bytes (now {:?} bytes)",
                path.display(),
                want.len(),
                std::fs::metadata(path).ok().map(|m| m.len())
            );
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}

/// Wait until `path` no longer exists.
async fn converge_gone(path: &Path, within: Duration) {
    let t0 = Instant::now();
    while path.exists() {
        if t0.elapsed() > within {
            panic!("{} was never removed", path.display());
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}

/// Run the whole scenario against the log service at `log` (loopback, pinned to
/// the `conformance` test control plane), with scratch folders under `dir`.
pub async fn run(log: &str, dir: &Path, attach_bytes: usize) {
    std::fs::create_dir_all(dir).unwrap();
    let cp = Arc::new(ControlPlane::new(CP_LABEL));
    let c = B16(random());
    let owner = B16(random());
    let hosted = Dev::new("hosted", DeviceKind::Hosted, SERVICE_ACCOUNT);
    let escrow = Dev::new("escrow", DeviceKind::Escrow, SERVICE_ACCOUNT);
    let a = Dev::new("desktop-a", DeviceKind::Desktop, owner);
    let b = Dev::new("desktop-b", DeviceKind::Desktop, owner);
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
            hosted.enrol(),
            escrow.enrol(),
            a.enrol(),
            b.enrol(),
        ],
        1,
    );
    let pin = mdbn_wire::hash::chain_hash(&genesis).0;
    create_log(log, cp.clone(), c, genesis).await;
    println!("PASS: created cloud-copy log {}", c.to_uuid_string());

    let t0 = Instant::now();
    let rh = open(dir, log, &cp, c, &hosted, random(), pin);
    let ra = open(dir, log, &cp, c, &a, random(), pin);
    let rb_id: [u8; 16] = random();
    let rb = open(dir, log, &cp, c, &b, rb_id, pin);
    let (pa, pb) = (dir.join(a.label), dir.join(b.label));

    std::fs::write(pa.join("from-a.md"), "written on A\n").unwrap();
    let t = converge(
        &pb.join("from-a.md"),
        "written on A\n",
        Duration::from_secs(60),
    )
    .await;
    println!(
        "PASS: A -> B in {t:?} ({:?} after open; hosted keyed both desktops)",
        t0.elapsed()
    );
    std::fs::write(pb.join("from-b.md"), "written on B\n").unwrap();
    let t = converge(
        &pa.join("from-b.md"),
        "written on B\n",
        Duration::from_secs(30),
    )
    .await;
    println!("PASS: B -> A in {t:?}");

    std::fs::create_dir_all(pa.join("bulk")).unwrap();
    for i in 0..4000 {
        std::fs::write(pa.join(format!("bulk/{i}.md")), "[test] bulk sync\n").unwrap();
    }
    let deadline = Instant::now() + Duration::from_secs(120);
    let mut progress_seen = false;
    loop {
        let (status, _) = tokio::time::timeout(Duration::from_secs(5), ra.telemetry())
            .await
            .expect("synced status blocked behind bulk ingest")
            .unwrap();
        progress_seen |= status.pending > 0;
        tokio::time::timeout(Duration::from_secs(5), ra.grants_barrier())
            .await
            .expect("synced control blocked behind bulk ingest");
        let (peer, _) = tokio::time::timeout(Duration::from_secs(5), rb.telemetry())
            .await
            .expect("peer status blocked behind bulk ingest")
            .unwrap();
        if [&status, &peer].into_iter().all(|s| {
            s.pending == 0
                && s.confirmed_record_digest
                    .as_ref()
                    .is_some_and(|d| d.records == 4002)
        }) {
            break;
        }
        assert!(Instant::now() < deadline, "bulk sync did not converge");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(progress_seen, "bulk sync work was never visible");
    println!("PASS: 4,000-file synced ingest kept status/control responsive and converged");

    // Attachments (attachment-v1): a binary file dropped into A's folder is
    // uploaded as sealed chunk objects, then fetched, authenticated and placed on
    // B; a rename moves it on B without a refetch; a delete removes it on B.
    // Over 1 MiB, sealed chunks use the staged direct transfer
    // (log-service-api §6): `--attach-bytes 52428800` exercises it.
    let size = attach_bytes;
    std::fs::create_dir_all(pa.join("assets")).unwrap();
    let mut bin = vec![0u8; size];
    let mut seed = u64::from_le_bytes(random());
    for b in bin.iter_mut() {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        *b = seed as u8;
    }
    let t = Instant::now();
    std::fs::write(pa.join("assets/drop.bin"), &bin).unwrap();
    converge_bytes(&pb.join("assets/drop.bin"), &bin, Duration::from_secs(300)).await;
    let (status, _) = ra.telemetry().await.unwrap();
    assert_ne!(
        status.last_error.as_deref(),
        Some("integrity"),
        "confirming the uploader's own attachment must tolerate retired touch-index entries"
    );
    println!(
        "PASS: attachment {} bytes A -> B in {:?} (byte-identical on B)",
        bin.len(),
        t.elapsed()
    );
    let t = Instant::now();
    std::fs::rename(pa.join("assets/drop.bin"), pa.join("assets/moved.bin")).unwrap();
    converge_bytes(&pb.join("assets/moved.bin"), &bin, Duration::from_secs(120)).await;
    converge_gone(&pb.join("assets/drop.bin"), Duration::from_secs(60)).await;
    println!(
        "PASS: attachment rename on A reached B in {:?}",
        t.elapsed()
    );
    let t = Instant::now();
    std::fs::remove_file(pa.join("assets/moved.bin")).unwrap();
    converge_gone(&pb.join("assets/moved.bin"), Duration::from_secs(120)).await;
    println!(
        "PASS: attachment delete on A reached B in {:?}",
        t.elapsed()
    );
    let small: Vec<u8> = (0..200_000u32).map(|i| (i * 31 % 251) as u8).collect();
    std::fs::write(pb.join("from-b.png"), &small).unwrap();
    converge_bytes(&pa.join("from-b.png"), &small, Duration::from_secs(120)).await;
    println!("PASS: small attachment B -> A");

    // Where the time goes (both runtimes up): A ingests the file (no watcher: the
    // periodic rescan plus the store's quiescence window), appends; the log pushes the
    // new head; B reads, applies and materializes.
    for i in 0..5 {
        let before = ra.status().await.unwrap().confirmed_through;
        let path = format!("latency-{i}.md");
        let t = Instant::now();
        std::fs::write(pa.join(&path), format!("latency probe {i}\n")).unwrap();
        let (mut a_conf, mut b_conf, mut b_disk) = (None, None, None);
        while b_disk.is_none() || b_conf.is_none() || a_conf.is_none() {
            let sa = ra.status().await.unwrap();
            if a_conf.is_none() && sa.confirmed_through > before && sa.pending == 0 {
                a_conf = Some((t.elapsed(), sa.confirmed_through));
            }
            if let (None, Some((_, seq))) = (b_conf, a_conf)
                && rb.status().await.unwrap().confirmed_through >= seq
            {
                b_conf = Some(t.elapsed());
            }
            if b_disk.is_none() && pb.join(&path).exists() {
                b_disk = Some(t.elapsed());
            }
            if t.elapsed() > Duration::from_secs(30) {
                panic!("latency probe {i} stuck");
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let (ac, _) = a_conf.unwrap();
        println!(
            "latency {i}: A ingested+confirmed {:?}, B confirmed +{:?}, B file +{:?} (total {:?})",
            ac,
            b_conf.unwrap().saturating_sub(ac),
            b_disk.unwrap().saturating_sub(b_conf.unwrap()),
            b_disk.unwrap()
        );
    }

    // Offline edits: B stops, both sides edit, B comes back.
    rb.stop().await;
    drop(rb);
    std::fs::write(pa.join("while-b-off.md"), "A wrote while B was off\n").unwrap();
    std::fs::write(pb.join("b-offline.md"), "B wrote offline\n").unwrap();
    tokio::time::sleep(Duration::from_secs(3)).await;
    let rb = open(dir, log, &cp, c, &b, rb_id, pin);
    let t = converge(
        &pb.join("while-b-off.md"),
        "A wrote while B was off\n",
        Duration::from_secs(60),
    )
    .await;
    println!("PASS: B caught up with A's offline-period write in {t:?} after restart");
    let t = converge(
        &pa.join("b-offline.md"),
        "B wrote offline\n",
        Duration::from_secs(60),
    )
    .await;
    println!("PASS: B's offline write reached A in {t:?}");

    // Conflict: the same file edited on both sides while B is stopped. The log
    // orders them; the replicas converge on one confirmed state with the conflict
    // recorded, and the losing device's disk edit is held, never overwritten.
    rb.stop().await;
    drop(rb);
    std::fs::write(pa.join("from-a.md"), "A's edit\n").unwrap();
    std::fs::write(pb.join("from-a.md"), "B's edit\n").unwrap();
    tokio::time::sleep(Duration::from_secs(3)).await;
    let rb = open(dir, log, &cp, c, &b, rb_id, pin);
    let t1 = Instant::now();
    loop {
        let (sa, sb, sh) = (
            ra.status().await.unwrap(),
            rb.status().await.unwrap(),
            rh.status().await.unwrap(),
        );
        let same = sa.confirmed_through == sb.confirmed_through
            && sb.confirmed_through == sh.confirmed_through
            && sa.pending == 0
            && sb.pending == 0;
        let (da, db, dh) = (
            ra.confirmed_digest().await,
            rb.confirmed_digest().await,
            rh.confirmed_digest().await,
        );
        if let Some((n, d)) = da
            && same
            && da == db
            && db == dh
            && sa.unresolved >= 1
            && sb.unresolved >= 1
            && sa.holds + sb.holds >= 1
        {
            println!(
                "PASS: concurrent edits converged in {:?}: confirmed through {}, the same {n} confirmed records on A, B and hosted (digest {}), conflict recorded (A unresolved {} holds {}, B unresolved {} holds {})",
                t1.elapsed(),
                sa.confirmed_through,
                mdbn_wire::render::hex(&d[..8]),
                sa.unresolved,
                sa.holds,
                sb.unresolved,
                sb.holds
            );
            break;
        }
        if t1.elapsed() > Duration::from_secs(60) {
            panic!("conflict never converged: A {sa:?} B {sb:?} H {sh:?}");
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    println!(
        "disk (B's local edit is held, not overwritten): A {:?} / B {:?}",
        std::fs::read_to_string(pa.join("from-a.md")).ok(),
        std::fs::read_to_string(pb.join("from-a.md")).ok()
    );
    let listing = |p: &Path| {
        let mut v: Vec<String> = std::fs::read_dir(p)
            .unwrap()
            .filter_map(|e| e.ok().map(|e| e.file_name().to_string_lossy().into_owned()))
            .collect();
        v.sort();
        v
    };
    println!("A files: {:?}", listing(&pa));
    println!("B files: {:?}", listing(&pb));
    ra.stop().await;
}

/// Both conversions over real LS sockets and real daemon actor/SQLite stores.
/// CP intent/floor/cancel and host-file projection are separate HTTP/PG tests.
pub async fn run_modes(log: &str, dir: &Path) {
    run_modes_sdk(log, dir, None).await;
}
pub async fn run_modes_sdk(log: &str, dir: &Path, sdk: Option<(&str, &str)>) {
    use mdbn_daemon::runtime::PrivateSwitchOp as P;
    use mdbn_wire::policy::{CollectionState, DeviceRevoke};
    let cp = Arc::new(ControlPlane::new(CP_LABEL));
    let c = B16(random());
    let owner = B16(random());
    let hosted = Dev::new("mode-hosted", DeviceKind::Hosted, SERVICE_ACCOUNT);
    let escrow = Dev::new("mode-escrow", DeviceKind::Escrow, SERVICE_ACCOUNT);
    let sdk_device = Dev::new("mode-sdk", DeviceKind::AppRuntime, owner);
    let a = Dev::new("mode-a", DeviceKind::Desktop, owner);
    let b = Dev::new("mode-b", DeviceKind::Desktop, owner);
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
            hosted.enrol(),
            escrow.enrol(),
            a.enrol(),
            b.enrol(),
            sdk_device.enrol(),
        ],
        1,
    );
    let original = genesis.clone();
    let pin = mdbn_wire::hash::chain_hash(&genesis).0;
    create_log(log, cp.clone(), c, genesis).await;
    let rh = open(dir, log, &cp, c, &hosted, random(), pin);
    let ra = open(dir, log, &cp, c, &a, random(), pin);
    let bid = random();
    let rb = open(dir, log, &cp, c, &b, bid, pin);
    let pa = dir.join(a.label);
    let pb = dir.join(b.label);
    std::fs::write(pa.join("cloud.md"), "initial cloud copy\n").unwrap();
    converge(
        &pb.join("cloud.md"),
        "initial cloud copy\n",
        Duration::from_secs(60),
    )
    .await;
    let mut sdk_child = if let Some((node, wasm)) = sdk {
        let pins = mdbn_wire::cbor::encode(&Cbor::Array(vec![
            Cbor::Array(vec![Cbor::Array(vec![
                mdbn_replica::policy::key_id(&cp.root_pk().0).to_cbor(),
                cp.root_pk().to_cbor(),
            ])]),
            Cbor::Array(vec![Cbor::Array(vec![
                mdbn_replica::policy::key_id(&cp.transport_key().verifying_key().to_bytes())
                    .to_cbor(),
                B32(cp.transport_key().verifying_key().to_bytes()).to_cbor(),
                mdbn_replica::policy::key_id(&cp.root_pk().0).to_cbor(),
            ])]),
        ]))
        .unwrap();
        let fixture = serde_json::json!({"publicConformanceFixture":true,"collection":c.to_uuid_string(),"device":sdk_device.tk.id.to_uuid_string(),"sign":mdbn_daemon::secrets::hex(&sdk_device.secrets().sign_sk),"kem":mdbn_daemon::secrets::hex(&sdk_device.kem_sk),"signPublic":mdbn_daemon::secrets::hex(&sdk_device.tk.pk().0),"token":cp.device_token_for(&sdk_device.tk,now_ms()+15*60_000,Some(c)),"log":log,"genesis":pin,"root":mdbn_daemon::secrets::hex(&cp.root_pk().0),"pins":mdbn_daemon::secrets::hex(&pins),"stage":dir.join("sdk-stage"),"command":dir.join("sdk-command"),"original":mdbn_daemon::secrets::hex(&original)});
        let path = dir.join("sdk-fixture.json");
        std::fs::write(&path, serde_json::to_vec(&fixture).unwrap()).unwrap();
        let executable = std::env::current_exe().unwrap();
        let script = executable
            .ancestors()
            .nth(4)
            .unwrap()
            .join("packages/sdk/scripts/app-mode-native-pair.mjs");
        Some(
            tokio::process::Command::new(node)
                .arg(script)
                .arg(path)
                .arg(wasm)
                .kill_on_drop(true)
                .spawn()
                .unwrap(),
        )
    } else {
        None
    };
    if sdk_child.is_some() {
        converge(&dir.join("sdk-stage"), "cloud", Duration::from_secs(60)).await;
        converge(
            &pa.join("sdk-cloud.md"),
            "written by SDK in cloud\n",
            Duration::from_secs(30),
        )
        .await;
    }
    assert!(matches!(
        ra.private_switch(P::Request, Arc::new(|| true)).await,
        Some(Ok(_))
    ));
    // Keep B online across the conditional CP policy and owner's rekey.
    // Read-only acceptance/status checks must not be replaced by a restart.
    rh.stop().await;
    drop(rh);
    append_policy(
        log,
        &cp,
        c,
        vec![
            PolicyOp::DeviceRevoke(DeviceRevoke {
                device: hosted.tk.id,
            }),
            PolicyOp::DeviceRevoke(DeviceRevoke {
                device: escrow.tk.id,
            }),
            PolicyOp::CollectionState(CollectionState {
                state: CState::E2e,
                compress: None,
                min_sem_major: None,
            }),
        ],
    )
    .await;
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        if matches!(
            ra.private_switch(P::Accepted, Arc::new(|| true)).await,
            Some(Ok(Some(_)))
        ) {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "native Private acceptance timed out"
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        if matches!(
            rb.private_switch(P::Accepted, Arc::new(|| true)).await,
            Some(Ok(Some(_)))
        ) {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "online B did not observe Private cutover without restart"
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    std::fs::write(
        pa.join("private-online.md"),
        "private while B stayed online\n",
    )
    .unwrap();
    converge(
        &pb.join("private-online.md"),
        "private while B stayed online\n",
        Duration::from_secs(30),
    )
    .await;
    println!("PASS: online B accepted Private cutover and new content without restart");
    rb.stop().await;
    drop(rb);
    let rb = open(dir, log, &cp, c, &b, bid, pin);
    std::fs::write(pa.join("private.md"), "private after restart\n").unwrap();
    converge(
        &pb.join("private.md"),
        "private after restart\n",
        Duration::from_secs(60),
    )
    .await;
    assert!(matches!(
        rb.private_switch(P::Accepted, Arc::new(|| true)).await,
        Some(Ok(Some(_)))
    ));
    if sdk_child.is_some() {
        std::fs::write(dir.join("sdk-command"), "private").unwrap();
        converge(&dir.join("sdk-stage"), "private", Duration::from_secs(60)).await;
        converge(
            &pa.join("sdk-private.md"),
            "written by SDK in private\n",
            Duration::from_secs(30),
        )
        .await;
    }
    let h2 = Dev::new("mode-hosted-new", DeviceKind::Hosted, SERVICE_ACCOUNT);
    let e2 = Dev::new("mode-escrow-new", DeviceKind::Escrow, SERVICE_ACCOUNT);
    assert!(matches!(
        ra.private_switch(P::ChooseCloud, Arc::new(|| true)).await,
        Some(Ok(_))
    ));
    append_policy(
        log,
        &cp,
        c,
        vec![
            h2.enrol(),
            e2.enrol(),
            PolicyOp::CollectionState(CollectionState {
                state: CState::CloudCopy,
                compress: None,
                min_sem_major: None,
            }),
        ],
    )
    .await;
    let rh = open(dir, log, &cp, c, &h2, random(), pin);
    std::fs::write(pa.join("cloud-again.md"), "cloud after private history\n").unwrap();
    converge(
        &dir.join(h2.label).join("cloud-again.md"),
        "cloud after private history\n",
        Duration::from_secs(60),
    )
    .await;
    converge(
        &dir.join(h2.label).join("private.md"),
        "private after restart\n",
        Duration::from_secs(60),
    )
    .await;
    converge(
        &pb.join("cloud-again.md"),
        "cloud after private history\n",
        Duration::from_secs(60),
    )
    .await;
    assert!(matches!(
        rb.private_switch(P::CloudRead, Arc::new(|| true)).await,
        Some(Ok(Some(_)))
    ));
    if sdk_child.is_some() {
        std::fs::write(dir.join("sdk-command"), "cloud-again").unwrap();
        converge(
            &dir.join("sdk-stage"),
            "cloud-again",
            Duration::from_secs(60),
        )
        .await;
        converge(
            &pa.join("sdk-cloud-again.md"),
            "written by SDK in cloud-again\n",
            Duration::from_secs(30),
        )
        .await;
    }
    if let Some(child) = &mut sdk_child {
        assert!(
            tokio::time::timeout(Duration::from_secs(10), child.wait())
                .await
                .unwrap()
                .unwrap()
                .success()
        );
    }
    use mdbn_wire::{
        envelope::{Item, ItemKind, RekeyPayload},
        log_service::{ReadParams, ReadResult},
    };
    let log_items = ReadResult::from_cbor(
        &cp_rpc(
            log,
            cp.clone(),
            c,
            "read",
            ReadParams {
                collection: c,
                after: 0,
                limit: 1024,
                kinds: None,
                max_bytes: None,
            }
            .to_cbor(),
        )
        .await,
    )
    .unwrap();
    let epochs = log_items
        .items
        .iter()
        .map(|row| Item::from_bytes(&row.item.0).unwrap())
        .filter(|item| item.kind == ItemKind::Rekey)
        .map(|item| RekeyPayload::from_bytes(&item.body.0).unwrap().epoch)
        .collect::<Vec<_>>();
    assert_eq!(
        epochs,
        vec![1, 2],
        "Cloud handover must not create a replacement epoch"
    );
    ra.stop().await;
    rb.stop().await;
    rh.stop().await;
    println!(
        "PASS: native Cloud -> Private -> Cloud, offline receiver replay, same epoch/history handover, receiver-only read choice"
    );
}
async fn append_policy(log: &str, cp: &Arc<ControlPlane>, collection: Uuid, ops: Vec<PolicyOp>) {
    use mdbn_wire::log_service::{AppendParams, HeadParams, HeadResult};
    let head = HeadResult::from_cbor(
        &cp_rpc(
            log,
            cp.clone(),
            collection,
            "head",
            HeadParams { collection }.to_cbor(),
        )
        .await,
    )
    .unwrap();
    let item = cp.policy_item(collection, head.head + 1, head.head_chain, ops, now_ms());
    cp_rpc(
        log,
        cp.clone(),
        collection,
        "append",
        AppendParams {
            collection,
            expect_seq: head.head + 1,
            expect_prev: head.head_chain,
            items: vec![mdbn_wire::common::Bytes(item)],
        }
        .to_cbor(),
    )
    .await;
}
