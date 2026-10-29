//! The adopt scenario (test tooling, never shipped): a folder that already holds
//! files is adopted into a new log as generation 0 with the record IDs it already
//! had, through a real log service pinned to the deterministic
//! `conformance` test control plane (loopback only).
//!
//! Shared by the CI test `tests/adopt.rs` (in-process log service) and the
//! `adopt_rehearsal` example (external log service, kill -9 between restarts).
//!
//! Private (end-to-end): the adopting desktop keys itself. The genesis enrols only
//! that device; the second replica is the same device in a fresh folder and state
//! directory (a rejoin), so the epoch key comes from the device's credential store.
//! Cloud copy: hosted and escrow are enrolled, a hosted-kind runtime runs, and a
//! second desktop joins.
#![allow(dead_code)]

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use mdbn_daemon::logwire::{Token, TokenSource};
use mdbn_daemon::runtime::{Runtime, RuntimeConfig, Synced};
use mdbn_log_service::testkit::{ControlPlane, Device, sign_digest};
use mdbn_replica::api::SessionAuth;
use mdbn_replica::crypto::hpke::KemKeyPair;
use mdbn_replica::policy::{EffectiveGrant, GrantSource, SERVICE_ACCOUNT};
use mdbn_replica::{AdoptRecords, AdoptStatus, DeviceSecrets};
use mdbn_wire::cbor::Cbor;
use mdbn_wire::client::{ClientFrame, ClientRequest, FileState, FileView, HelloParams};
use mdbn_wire::common::{B16, B32, Uuid, Version};
use mdbn_wire::log_service::{LsFrame, LsRequest};
use mdbn_wire::policy::{CState, DeviceEnrol, DeviceKind, Genesis, MemberSet, PolicyOp, Role};
use mdbn_wire::schema::Wire;
use serde::{Deserialize, Serialize};
use tokio_tungstenite::tungstenite::Message;

const CP_LABEL: &str = "conformance";
const PRIVATE_DIR: &str = ".mdbase";

/// Everything a process needs to reopen the scenario (persisted by the rehearsal).
#[derive(Clone, Serialize, Deserialize)]
pub struct Plan {
    pub log: String,
    pub collection: [u8; 16],
    pub owner: [u8; 16],
    pub private: bool,
    /// Pinned genesis chain hash.
    pub pin: [u8; 32],
    /// KEM secrets by device label.
    pub kem: BTreeMap<String, [u8; 32]>,
    /// `(record ID, path)` the folder's Markdown files already had.
    pub records: Vec<([u8; 16], String)>,
}

impl Plan {
    pub fn adopt(&self) -> AdoptRecords {
        AdoptRecords {
            records: self
                .records
                .iter()
                .map(|(id, p)| (B16(*id), p.clone()))
                .collect(),
            resources: vec![],
            settings: None,
        }
    }
    fn state(&self) -> CState {
        if self.private {
            CState::E2e
        } else {
            CState::CloudCopy
        }
    }
    fn kind(label: &str) -> DeviceKind {
        match label {
            "hosted" => DeviceKind::Hosted,
            "escrow" => DeviceKind::Escrow,
            _ => DeviceKind::Desktop,
        }
    }
    fn account(&self, label: &str) -> Uuid {
        match label {
            "hosted" | "escrow" => SERVICE_ACCOUNT,
            _ => B16(self.owner),
        }
    }
    fn device(&self, label: &str) -> Device {
        Device::new(label, self.account(label))
    }
    /// The device labels the genesis enrols.
    pub fn labels(&self) -> Vec<&'static str> {
        if self.private {
            vec!["desktop-a"]
        } else {
            vec!["hosted", "escrow", "desktop-a", "desktop-b"]
        }
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}

pub fn random<const N: usize>() -> [u8; N] {
    let mut b = [0u8; N];
    getrandom::fill(&mut b).unwrap();
    b
}

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

struct Tokens {
    cp: Arc<ControlPlane>,
    device: Device,
    collection: Uuid,
}

impl TokenSource for Tokens {
    fn token(
        &self,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<Token, String>> + Send + '_>> {
        let exp = now_ms() + 15 * 60_000;
        let token = self
            .cp
            .device_token_for(&self.device, exp, Some(self.collection));
        Box::pin(async move {
            Ok(Token {
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

/// Write `docs` Markdown files and one attachment into `folder`; the plan's
/// records name the Markdown files with random (pre-existing) IDs.
pub fn fill_folder(folder: &Path, docs: usize) -> Vec<([u8; 16], String)> {
    std::fs::create_dir_all(folder.join("notes")).unwrap();
    std::fs::create_dir_all(folder.join("assets")).unwrap();
    let mut records = Vec::new();
    for i in 0..docs {
        let path = format!("notes/n{i:05}.md");
        let body = format!(
            "---\ntitle: Note {i}\ntags: [adopt, n{}]\n---\n\n# Note {i}\n\n{}\n",
            i % 7,
            "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(1 + i % 40)
        );
        std::fs::write(folder.join(&path), body).unwrap();
        records.push((random(), path));
    }
    let bin: Vec<u8> = (0..50_000u32)
        .map(|i| (i.wrapping_mul(2_654_435_761) >> 13) as u8)
        .collect();
    std::fs::write(folder.join("assets/figure.bin"), bin).unwrap();
    records
}

/// Path → bytes of every user file (the private directory excluded).
pub fn snapshot(folder: &Path) -> BTreeMap<String, Vec<u8>> {
    fn walk(root: &Path, dir: &Path, out: &mut BTreeMap<String, Vec<u8>>) {
        let Ok(rd) = std::fs::read_dir(dir) else {
            return;
        };
        for e in rd.flatten() {
            let p = e.path();
            let rel = p
                .strip_prefix(root)
                .unwrap()
                .to_string_lossy()
                .replace('\\', "/");
            if rel == PRIVATE_DIR || rel.starts_with(&format!("{PRIVATE_DIR}/")) {
                continue;
            }
            let t = e.file_type().unwrap();
            if t.is_dir() {
                walk(root, &p, out);
            } else if t.is_file() {
                out.insert(rel, std::fs::read(&p).unwrap());
            }
        }
    }
    let mut out = BTreeMap::new();
    walk(folder, folder, &mut out);
    out
}

/// Create the collection's log with a genesis for the plan's mode.
pub async fn create(log: &str, docs_records: Vec<([u8; 16], String)>, private: bool) -> Plan {
    let cp = Arc::new(ControlPlane::new(CP_LABEL));
    let mut plan = Plan {
        log: log.into(),
        collection: random(),
        owner: random(),
        private,
        pin: [0; 32],
        kem: BTreeMap::new(),
        records: docs_records,
    };
    let c = B16(plan.collection);
    let mut ops = vec![
        PolicyOp::Genesis(Genesis {
            owner: B16(plan.owner),
            root: mdbn_log_service::policy::key_id(&cp.root_pk()),
            state: plan.state(),
        }),
        PolicyOp::MemberSet(MemberSet {
            account: B16(plan.owner),
            role: Role::Owner,
        }),
    ];
    for label in plan.labels() {
        let kem: [u8; 32] = random();
        plan.kem.insert(label.into(), kem);
        ops.push(PolicyOp::DeviceEnrol(DeviceEnrol {
            device: plan.device(label).id,
            account: plan.account(label),
            kind: Plan::kind(label),
            sign_pk: plan.device(label).pk(),
            kem_pk: B32(KemKeyPair::from_secret(&kem).pk),
            noise_pk: B32(KemKeyPair::from_secret(&random()).pk),
            sas_commit: None,
            local_root: None,
        }));
    }
    let genesis = cp.policy_item(c, 1, B32([0; 32]), ops, 1);
    plan.pin = mdbn_wire::hash::chain_hash(&genesis).0;
    create_log(log, cp, c, genesis).await;
    plan
}

/// `create_log` with the control plane's own credential, on its own loopback
/// connection (the same synthetic admin helper as the sync_pair scenario).
async fn create_log(log: &str, cp: Arc<ControlPlane>, c: Uuid, genesis: Vec<u8>) {
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
                "admin hello refused"
            );
            break;
        }
    }
    let params = Cbor::Map(vec![
        (Cbor::Uint(0), c.to_cbor()),
        (Cbor::Uint(1), Cbor::Bytes(genesis)),
    ]);
    let frame = LsFrame::Request(LsRequest {
        id: 1,
        method: "create_log".into(),
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
            assert!(r.error.is_none(), "create_log: {:?}", r.error);
            break;
        }
    }
}

/// Open `label`'s runtime over `folder` (state in `state`), adopting when `adopt`.
pub fn open(
    plan: &Plan,
    label: &str,
    folder: &Path,
    state: &Path,
    secrets: Arc<dyn mdbn_daemon::secrets::SecretStore>,
    adopt: bool,
) -> Runtime {
    std::fs::create_dir_all(folder).unwrap();
    // One replica ID per state directory, across restarts.
    let id_file = state.with_extension("replica-id");
    let replica_id: [u8; 16] = match std::fs::read(&id_file) {
        Ok(b) => b.try_into().unwrap(),
        Err(_) => {
            let id = random();
            std::fs::write(&id_file, id).unwrap();
            id
        }
    };
    let cp = Arc::new(ControlPlane::new(CP_LABEL));
    let device = plan.device(label);
    let cfg = RuntimeConfig {
        collection: plan.collection,
        replica_id,
        device_id: device.id.0,
        root: folder.to_path_buf(),
        private_dir: state.to_path_buf(),
        adopt: adopt.then(|| plan.adopt()),
        id_hints: vec![],
        computer_name: None,
        sync: Some(Synced {
            log_url: plan.log.clone(),
            chosen_state: plan.state(),
            trusted_roots: vec![cp.root_pk().0],
            trusted_signers: if plan.private {
                vec![device.id.0]
            } else {
                vec![]
            },
            user_enabled_cloud_copy: !plan.private,
            tokens: Arc::new(Tokens {
                cp: cp.clone(),
                device: plan.device(label),
                collection: B16(plan.collection),
            }),
            secrets,
            expected_genesis: plan.pin,
            policy_pins: pins(
                cp.root_pk().0,
                cp.transport_key().verifying_key().to_bytes(),
            ),
        }),
    };
    let secrets = DeviceSecrets {
        sign_sk: mdbn_wire::hash::sha256(format!("device/{label}").as_bytes()).0,
        kem_sk: plan.kem[label],
    };
    Runtime::open(cfg, secrets, Box::new(NoGrants), Default::default())
        .unwrap_or_else(|e| panic!("open {label}: {}", e.0))
}

/// Wait until the runtime's adopt is no longer pending; panics on failure.
pub async fn adopted(rt: &Runtime, within: Duration) -> Duration {
    let t0 = Instant::now();
    loop {
        let (_, _, adopt, _) = rt.readiness().await.expect("runtime stopped");
        match adopt {
            Some(AdoptStatus::Pending) => {}
            Some(AdoptStatus::Failed(why)) => panic!("adopt failed: {why}"),
            _ => return t0.elapsed(),
        }
        assert!(t0.elapsed() < within, "adopt never completed");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

/// Wait until the runtime's confirmed records equal `want` (ID order).
pub async fn records(rt: &Runtime, want: &[([u8; 16], String)], within: Duration) {
    let mut want = want.to_vec();
    want.sort();
    let t0 = Instant::now();
    loop {
        let (mut got, _) = rt.inventory().await.unwrap_or_default();
        got.sort();
        if got == want {
            return;
        }
        assert!(
            t0.elapsed() < within,
            "records never matched: {} of {} (first missing {:?})",
            got.len(),
            want.len(),
            want.iter().find(|w| !got.contains(w)).map(|w| &w.1)
        );
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

/// Wait until `folder`'s user files equal `want`.
pub async fn files(folder: &Path, want: &BTreeMap<String, Vec<u8>>, within: Duration) {
    let t0 = Instant::now();
    loop {
        let got = snapshot(folder);
        if &got == want {
            return;
        }
        assert!(
            t0.elapsed() < within,
            "{} never matched: {} of {} files (first differing {:?}, expected/actual bytes {:?})",
            folder.display(),
            got.len(),
            want.len(),
            want.keys().find(|k| got.get(*k) != want.get(*k)),
            want.iter()
                .find(|(k, v)| got.get(*k) != Some(*v))
                .map(|(k, v)| (v.len(), got.get(k).map(Vec::len)))
        );
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}

/// Gen0 excludes attachments. Do not stop its only uploader merely because
/// the adopted records are confirmed: require the binary's own log position.
async fn attachment_confirmed(rt: &Runtime, path: &str, size: u64, within: Duration) {
    let request = |id, method: &str, params| {
        ClientFrame::Request(ClientRequest {
            id,
            method: method.into(),
            params,
        })
        .to_bytes()
        .unwrap()
    };
    let hello = HelloParams {
        versions: vec![Version { major: 1, minor: 0 }],
        client_name: "adopt fixture".into(),
        client_version: "0".into(),
        features: None,
        timezone: None,
    };
    let (session, response, mut out) = rt
        .hello(SessionAuth::Host, request(0, "hello", hello.to_cbor()))
        .await
        .unwrap();
    let session = session.unwrap_or_else(|| {
        panic!(
            "fixture hello refused: {:?}",
            ClientFrame::from_bytes(&response)
        )
    });
    let started = Instant::now();
    let mut id = 0;
    loop {
        // Drive a full scan even if the filesystem watcher has not delivered
        // the post-base external create yet.
        rt.inventory().await.expect("runtime available");
        id += 1;
        assert!(rt.frame(
            session,
            request(
                id,
                "get_file",
                Cbor::Map(vec![(Cbor::Uint(0), Cbor::Text(path.into()))])
            )
        ));
        let response = loop {
            let frame = tokio::time::timeout(within.saturating_sub(started.elapsed()), out.recv())
                .await
                .expect("attachment reply timed out")
                .expect("fixture session alive");
            if let ClientFrame::Response(response) = ClientFrame::from_bytes(&frame).unwrap()
                && response.id == id
            {
                break response;
            }
        };
        let file = response
            .result
            .as_ref()
            .map(|value| FileView::from_cbor(value).unwrap());
        if let Some(file) = &file
            && file.confirmed_seq > 0
            && file.state == FileState::Materialized
            && file.size == size
        {
            rt.close(session);
            println!(
                "PASS: attachment published (bytes {}, seq {})",
                file.size, file.confirmed_seq
            );
            return;
        }
        assert!(
            started.elapsed() < within,
            "attachment never published: bytes/seq/state {:?}, code {:?}, pending {:?}",
            file.as_ref().map(|f| (f.size, f.confirmed_seq, f.state)),
            response.problem.as_ref().map(|p| &p.code),
            rt.status().await.map(|s| s.pending)
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

/// The whole scenario in one process: adopt, folder untouched, IDs kept, then a
/// second replica sees the same records and bytes.
pub async fn run(log: &str, dir: &Path, docs: usize, private: bool) {
    let mem = || -> Arc<dyn mdbn_daemon::secrets::SecretStore> {
        Arc::new(mdbn_daemon::secrets::MemoryStore::default())
    };
    let folder_a = dir.join("a");
    let ids = fill_folder(&folder_a, docs);
    let before = snapshot(&folder_a);
    let plan = create(log, ids, private).await;
    let a_secrets = mem();
    let hosted = (!private).then(|| {
        open(
            &plan,
            "hosted",
            &dir.join("hosted"),
            &dir.join("hosted-state"),
            mem(),
            false,
        )
    });
    let a = open(
        &plan,
        "desktop-a",
        &folder_a,
        &dir.join("a-state"),
        a_secrets.clone(),
        true,
    );
    let t = adopted(&a, Duration::from_secs(120)).await;
    println!("PASS: adopted {docs} records in {t:?} (private: {private})");
    records(&a, &plan.records, Duration::from_secs(30)).await;
    assert_eq!(snapshot(&folder_a), before, "adopt changed the folder");
    attachment_confirmed(
        &a,
        "assets/figure.bin",
        before["assets/figure.bin"].len() as u64,
        Duration::from_secs(120),
    )
    .await;
    let st = a.status().await.unwrap();
    assert_eq!((st.holds, st.unresolved), (0, 0), "adopt held files");
    println!("PASS: folder bytes and record IDs unchanged, nothing held");
    let (label, b_secrets, second) = if private {
        a.stop().await;
        ("desktop-a", a_secrets, dir.join("a2"))
    } else {
        ("desktop-b", mem(), dir.join("b"))
    };
    let b = open(
        &plan,
        label,
        &second,
        &dir.join("second-state"),
        b_secrets,
        false,
    );
    records(&b, &plan.records, Duration::from_secs(120)).await;
    files(&second, &before, Duration::from_secs(120)).await;
    println!("PASS: a second replica holds the same records, IDs and bytes");
    b.stop().await;
    if !private {
        a.stop().await;
    }
    if let Some(h) = hosted {
        h.stop().await;
    }
}

/// Scratch path helper for callers.
pub fn under(dir: &Path, name: &str) -> PathBuf {
    dir.join(name)
}
