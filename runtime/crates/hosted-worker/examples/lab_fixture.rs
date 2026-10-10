//! LAB/local test tooling (not shipped): a deterministic cloud-copy collection for
//! the hosted Worker end-to-end harness (`deploy/hosted-worker/e2e`).
//!
//! It builds the control prefix in the in-memory fake log with REAL signatures and
//! HPKE wraps — genesis enrolling an owner desktop, the hosted service device and
//! the escrow; then the owner's initial rekey wrapping all three — and checks that
//! a hosted engine over that log becomes keyed and serving. It prints JSON: the
//! item bytes in log order (to replay into a real log Worker), the hosted device's
//! open config inputs, and the public keys a log Worker needs.
//!
//! Every secret here is a fixed, public test value. Never use it outside LAB.
//!
//! `lab_fixture [collection-byte]` (hex, default `0e`) picks the collection
//! `B16([byte; 16])`, so separate, never-touched collections (for example LAB
//! benchmarks) can share the same deterministic hosted device.
// Test tooling, not the portable library: it may read its arguments.
#![allow(clippy::disallowed_methods)]

use std::cell::Cell;
use std::rc::Rc;

use mdbn_replica::crypto::hpke::KemKeyPair;
use mdbn_replica::crypto::keys::Recipient;
use mdbn_replica::crypto::sign::DeviceSigner;
use mdbn_replica::fake::FakeLogService;
use mdbn_replica::log::{LogClient, LogRequest, LogResponse};
use mdbn_replica::mem::MemStore;
use mdbn_replica::seal::{KeyringSealer, Sealer};
use mdbn_replica::testkit::{SIGNED_CP_SEED, TEST_OWNER, TestControlPlane, signed_root};
use mdbn_replica::{Host, HostedProfile, UtcOnly};
use mdbn_wire::cbor::{self, Cbor};
use mdbn_wire::common::{B16, B32, Bytes};
use mdbn_wire::envelope::{Item, ItemKind, RekeyReason};
use mdbn_wire::log_service::AppendParams;
use mdbn_wire::policy::{CState, DeviceEnrol, DeviceKind, Genesis, MemberSet, PolicyOp, Role};
use mdbn_wire::schema::Wire;

use mdbn_hosted_worker::runtime::{Engine, OpenConfig};

const OWNER: B16 = B16([0x0a; 16]);
const HOSTED: B16 = B16([0x0b; 16]);
const ESCROW: B16 = B16([0x0c; 16]);
const REPLICA: B16 = B16([0x0d; 16]);
const ESCROW_REPLICA: B16 = B16([0x0f; 16]);

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn uuid_str(u: &B16) -> String {
    let h = hex(&u.0);
    format!(
        "{}-{}-{}-{}-{}",
        &h[0..8],
        &h[8..12],
        &h[12..16],
        &h[16..20],
        &h[20..32]
    )
}

struct Dev {
    id: B16,
    sign: [u8; 32],
    kem: [u8; 32],
    kind: DeviceKind,
    account: B16,
    /// A real Noise static secret (app mode, hosted only); else the placeholder key.
    noise: Option<[u8; 32]>,
}

/// App mode: the hosted device's Noise secret and the LAB app grant (public test
/// values; never use outside LAB).
const HOSTED_NOISE: [u8; 32] = [0x47; 32];
const APP_CLIENT: [u8; 32] = [0x48; 32];
const APP_GRANT: B16 = B16([0x49; 16]);
const APP_INSTALLATION: B16 = B16([0x4a; 16]);

impl Dev {
    fn enrol(&self) -> PolicyOp {
        PolicyOp::DeviceEnrol(DeviceEnrol {
            device: self.id,
            account: self.account,
            kind: self.kind,
            sign_pk: B32(DeviceSigner::from_seed(&self.sign).public()),
            kem_pk: B32(KemKeyPair::from_secret(&self.kem).pk),
            noise_pk: B32(self.noise.map_or([9; 32], |k| mdbn_noise::public_key(&k))),
            sas_commit: None,
            local_root: None,
        })
    }
}

#[derive(Clone)]
struct FixedClock(Rc<Cell<u64>>);
impl mdbn_core::host::Clock for FixedClock {
    fn now_ms(&self) -> u64 {
        self.0.get()
    }
}

fn main() {
    // Deterministic per collection byte.
    let byte = std::env::args()
        .nth(1)
        .map(|b| u8::from_str_radix(&b, 16).expect("collection byte (hex)"))
        .unwrap_or(0x0e);
    // `lab_fixture <byte> app`: the hosted device gets a real Noise key and the
    // owner grants a LAB app (for direct app sessions over Noise).
    let app = std::env::args().nth(2).as_deref() == Some("app");
    let collection = B16([byte; 16]);
    let devs = [
        Dev {
            id: OWNER,
            sign: [0x41; 32],
            kem: [0x42; 32],
            kind: DeviceKind::Desktop,
            account: TEST_OWNER,
            noise: None,
        },
        Dev {
            id: HOSTED,
            sign: [0x43; 32],
            kem: [0x44; 32],
            kind: DeviceKind::Hosted,
            account: mdbn_replica::policy::SERVICE_ACCOUNT,
            noise: app.then_some(HOSTED_NOISE),
        },
        Dev {
            id: ESCROW,
            sign: [0x45; 32],
            kem: [0x46; 32],
            kind: DeviceKind::Escrow,
            account: mdbn_replica::policy::SERVICE_ACCOUNT,
            noise: None,
        },
    ];
    let svc = FakeLogService::new();
    let mut cp = TestControlPlane::signed(collection);
    let mut ops = vec![
        PolicyOp::Genesis(Genesis {
            owner: TEST_OWNER,
            root: mdbn_replica::policy::key_id(&signed_root()),
            state: CState::CloudCopy,
        }),
        PolicyOp::MemberSet(MemberSet {
            account: TEST_OWNER,
            role: Role::Owner,
        }),
    ];
    ops.extend(devs.iter().map(Dev::enrol));
    if app {
        ops.push(PolicyOp::Grant(mdbn_wire::policy::Grant {
            grant: APP_GRANT,
            installation: APP_INSTALLATION,
            app_id: "lab-app".into(),
            account: TEST_OWNER,
            capabilities: vec![
                "collection.read".into(),
                "records.create".into(),
                "records.edit".into(),
            ],
            client_pk: B32(mdbn_noise::public_key(&APP_CLIENT)),
            file_folders: None,
            folder_scoped: None,
        }));
    }
    cp.append(&svc, ops);

    // The owner's initial rekey, wrapping all three devices (real HPKE).
    let mut owner = KeyringSealer::new(collection, OWNER, &devs[0].sign, &devs[0].kem);
    let mut entropy = mdbn_replica::crypto::TestEntropy::new(7);
    let recipients: Vec<Recipient> = devs
        .iter()
        .map(|d| Recipient {
            device: d.id,
            kem_pk: KemKeyPair::from_secret(&d.kem).pk,
        })
        .collect();
    let payload = owner
        .build_rekey(0, &recipients, RekeyReason::Initial, &mut entropy)
        .expect("rekey");
    let (head, prev) = svc.head(&collection);
    let mut item = Item {
        kind: ItemKind::Rekey,
        collection,
        seq: Some(head + 1),
        prev: Some(prev),
        epoch: None,
        signer: Some(OWNER),
        salt: None,
        idem: None,
        refs: None,
        stream: None,
        body: Bytes(payload.to_bytes().unwrap()),
        sig: None,
    };
    owner.sign(&mut item).expect("sign");
    let mut c = svc.client(OWNER);
    let r = c.call(LogRequest::Append(AppendParams {
        collection,
        expect_seq: head + 1,
        expect_prev: prev,
        items: vec![Bytes(item.to_bytes().unwrap())],
    }));
    assert!(matches!(r, Ok(LogResponse::Append(_))), "{r:?}");

    // Sanity: the hosted engine over this log becomes keyed and serving.
    let cfg = Cbor::Map(vec![
        (Cbor::Uint(0), collection.to_cbor()),
        (Cbor::Uint(1), REPLICA.to_cbor()),
        (Cbor::Uint(2), HOSTED.to_cbor()),
        (
            Cbor::Uint(3),
            Cbor::Array(vec![Cbor::Bytes(signed_root().to_vec())]),
        ),
        (
            Cbor::Uint(4),
            Cbor::Array(devs.iter().map(|d| d.id.to_cbor()).collect()),
        ),
        (Cbor::Uint(5), Cbor::Bytes(devs[1].sign.to_vec())),
        (Cbor::Uint(6), Cbor::Bytes(devs[1].kem.to_vec())),
    ]);
    let clock = Rc::new(Cell::new(1_791_200_000_000));
    let host = Host {
        clock: Box::new(FixedClock(clock)),
        entropy: Box::new(mdbn_replica::crypto::TestEntropy::new(9)),
        zones: Box::new(UtcOnly),
    };
    let mut e = Engine::open(
        OpenConfig::decode(&cbor::encode(&cfg).unwrap()).unwrap(),
        MemStore::new(),
        host,
        HostedProfile::default(),
    )
    .expect("open");
    let mut log = svc.client(HOSTED);
    for _ in 0..20 {
        for call in e.take_log_calls() {
            let reply = log.call(call.request);
            e.on_log_reply(call.id, reply);
        }
    }
    assert!(e.serving(), "hosted engine serves over the fixture");
    if app {
        // The live admission the Worker's bridge consumes: verified, with this key.
        match e.admission() {
            mdbn_replica::HostedAdmission::Verified(v) => {
                assert_eq!(v.noise_pk().0, mdbn_noise::public_key(&HOSTED_NOISE));
            }
            d => panic!("hosted admission over the app fixture: {d:?}"),
        }
        assert!(e.grant_authorized(&APP_GRANT, &mdbn_noise::public_key(&APP_CLIENT)));
    }

    let items: Vec<String> = svc
        .items(&collection)
        .iter()
        .map(|b| format!("\"{}\"", hex(b)))
        .collect();
    let cp_seed = SIGNED_CP_SEED;
    let signers = devs
        .iter()
        .map(|d| format!("\"{}\"", uuid_str(&d.id)))
        .collect::<Vec<_>>()
        .join(",");
    // A service device's LAB custody config (the hosted and the escrow Workers).
    let service = |d: &Dev, replica: &B16| {
        format!(
            "{{\"device\":\"{}\",\"replica\":\"{}\",\"sign_sk\":\"{}\",\"kem_sk\":\"{}\",\"sign_pk\":\"{}\",\
\"roots\":[\"{}\"],\"signers\":[{}],\"collections\":[\"{}\"]{}}}",
            uuid_str(&d.id),
            uuid_str(replica),
            hex(&d.sign),
            hex(&d.kem),
            hex(&DeviceSigner::from_seed(&d.sign).public()),
            hex(&signed_root()),
            signers,
            uuid_str(&collection),
            d.noise
                .map_or(String::new(), |k| format!(",\"noise_sk\":\"{}\"", hex(&k))),
        )
    };
    let app_json = if app {
        format!(
            ",\"app\":{{\"grant\":\"{}\",\"client_sk\":\"{}\",\"client_pk\":\"{}\",\"hosted_noise_pk\":\"{}\"}}",
            uuid_str(&APP_GRANT),
            hex(&APP_CLIENT),
            hex(&mdbn_noise::public_key(&APP_CLIENT)),
            hex(&mdbn_noise::public_key(&HOSTED_NOISE)),
        )
    } else {
        String::new()
    };
    println!(
        "{{\"collection\":\"{}\",\"items\":[{}],\"root_pk\":\"{}\",\"cp_seed\":\"{}\",\"cp_pk\":\"{}\",\
\"hosted\":{},\"escrow\":{},\"owner\":{{\"device\":\"{}\",\"sign_sk\":\"{}\",\"kem_sk\":\"{}\"}}{}}}",
        uuid_str(&collection),
        items.join(","),
        hex(&signed_root()),
        hex(&cp_seed),
        hex(&DeviceSigner::from_seed(&cp_seed).public()),
        service(&devs[1], &REPLICA),
        service(&devs[2], &ESCROW_REPLICA),
        uuid_str(&OWNER),
        hex(&devs[0].sign),
        hex(&devs[0].kem),
        app_json,
    );
}
