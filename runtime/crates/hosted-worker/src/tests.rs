//! The engine end to end over the in-memory store and the fake log service: the
//! frame-level submit barrier and the rebuild gate. (The SQL path runs in workerd.)

mod attachment_streams;
mod attachments;
mod signed_control_plain;
use signed_control_plain::SignedControlPlain;

use std::cell::Cell;
use std::rc::Rc;

use mdbn_replica::fake::{FakeLog, FakeLogService};
use mdbn_replica::log::{LogClient, LogError, LogRequest};
use mdbn_replica::mem::MemStore;
use mdbn_replica::policy::key_id;
use mdbn_replica::seal::PlainSealer;
use mdbn_replica::testkit::{TEST_OWNER, TestControlPlane, TestDevice, signed_root};
use mdbn_replica::{Host, HostedProfile, UtcOnly};
use mdbn_wire::cbor::{self, Cbor};
use mdbn_wire::client::{
    ClientFrame, ClientRequest, HelloParams, Receipt, ReceiptState, SubmitParams,
};
use mdbn_wire::common::{B16, B32, Bytes, Text, Version};
use mdbn_wire::envelope::{ItemKind, KeyWrap, RekeyPayload, RekeyReason, SealedBox};
use mdbn_wire::intent::{Create, Op};
use mdbn_wire::policy::{CState, DeviceKind};
use mdbn_wire::schema::Wire;

use crate::runtime::{Engine, OpenConfig, Out};

const COL: B16 = B16([0x0d; 16]);
const OWNER_DEV: B16 = B16([101; 16]);
const HOSTED_DEV: B16 = B16([102; 16]);
const ESCROW_DEV: B16 = B16([103; 16]);
const GRANT: B16 = B16([0x51; 16]);
const CLIENT_PK: [u8; 32] = [0x51; 32];

#[derive(Clone)]
struct TestClock(Rc<Cell<u64>>);
impl mdbn_core::host::Clock for TestClock {
    fn now_ms(&self) -> u64 {
        self.0.get()
    }
}

fn world() -> FakeLogService {
    world_with_cp().0
}

fn world_with_cp() -> (FakeLogService, TestControlPlane) {
    let svc = FakeLogService::new();
    let mut cp = TestControlPlane::signed(COL);
    let dev = |device, account, kind| TestDevice {
        device,
        account,
        kind,
    };
    cp.genesis(
        &svc,
        CState::CloudCopy,
        &[
            dev(OWNER_DEV, TEST_OWNER, DeviceKind::Desktop),
            dev(
                HOSTED_DEV,
                mdbn_replica::policy::SERVICE_ACCOUNT,
                DeviceKind::Hosted,
            ),
            dev(
                ESCROW_DEV,
                mdbn_replica::policy::SERVICE_ACCOUNT,
                DeviceKind::Escrow,
            ),
        ],
    );
    let rekey = RekeyPayload {
        epoch: 1,
        from: 0,
        commit: B32([0; 32]),
        wraps: [OWNER_DEV, HOSTED_DEV, ESCROW_DEV]
            .into_iter()
            .map(|device| KeyWrap {
                device,
                enc: B32([0; 32]),
                ct: Bytes(vec![0; 48]),
            })
            .collect(),
        history: SealedBox {
            salt: B16([0; 16]),
            ct: Bytes(Vec::new()),
        },
        reason: RekeyReason::Initial,
    };
    cp.append_item(&svc, ItemKind::Rekey, OWNER_DEV, rekey.to_bytes().unwrap());
    cp.approved_grant(
        &svc,
        GRANT,
        CLIENT_PK,
        &["collection.read", "records.create"],
        None,
        OWNER_DEV,
    );
    (svc, cp)
}

fn config_value(svc: &FakeLogService) -> Cbor {
    use mdbn_wire::envelope::Item;
    use mdbn_wire::policy::PolicyPayload;
    let original = svc.items(&COL).remove(0);
    let p = PolicyPayload::from_bytes(&Item::from_bytes(&original).unwrap().body.0).unwrap();
    let pins = Cbor::Array(vec![
        Cbor::Array(vec![Cbor::Array(vec![
            key_id(&signed_root()).to_cbor(),
            B32(signed_root()).to_cbor(),
        ])]),
        Cbor::Array(vec![Cbor::Array(vec![
            p.cert.key_id().to_cbor(),
            p.cert.policy_pk.to_cbor(),
            p.cert.root.to_cbor(),
        ])]),
    ]);
    Cbor::Map(vec![
        (Cbor::Uint(0), COL.to_cbor()),
        (Cbor::Uint(1), B16([2; 16]).to_cbor()),
        (Cbor::Uint(2), HOSTED_DEV.to_cbor()),
        (
            Cbor::Uint(3),
            Cbor::Array(vec![Cbor::Bytes(signed_root().to_vec())]),
        ),
        (
            Cbor::Uint(4),
            Cbor::Array(vec![
                OWNER_DEV.to_cbor(),
                HOSTED_DEV.to_cbor(),
                ESCROW_DEV.to_cbor(),
            ]),
        ),
        (Cbor::Uint(5), Cbor::Bytes(vec![7; 32])),
        (Cbor::Uint(6), Cbor::Bytes(vec![8; 32])),
        (Cbor::Uint(8), Cbor::Bytes(cbor::encode(&pins).unwrap())),
        (Cbor::Uint(9), Cbor::Bytes(original.clone())),
        (Cbor::Uint(10), mdbn_wire::hash::sha256(&original).to_cbor()),
    ])
}

fn config(svc: &FakeLogService) -> OpenConfig {
    OpenConfig::decode(&cbor::encode(&config_value(svc)).unwrap()).unwrap()
}

struct Hosted {
    e: Engine<MemStore>,
    log: FakeLog,
    clock: Rc<Cell<u64>>,
}

fn open(svc: &FakeLogService) -> Hosted {
    open_with_entropy(svc, 2)
}

fn open_with_entropy(svc: &FakeLogService, seed: u8) -> Hosted {
    let clock = Rc::new(Cell::new(1_700_000_000_000));
    let host = Host {
        clock: Box::new(TestClock(clock.clone())),
        entropy: Box::new(mdbn_replica::crypto::TestEntropy::new(seed)),
        zones: Box::new(UtcOnly),
    };
    let mut e = Engine::open_with(
        config(svc),
        MemStore::new(),
        Box::new(SignedControlPlain::for_device(HOSTED_DEV)),
        host,
        HostedProfile::default(),
    )
    .unwrap();
    // The host binds the log session once its transport authenticated.
    assert!(e.bind_log(COL));
    Hosted {
        e,
        log: svc.client(HOSTED_DEV),
        clock,
    }
}

impl Hosted {
    /// Move log calls and pushes until quiet; `lose_appends` loses append requests
    /// on the way (the outcome is unknown to the replica).
    fn pump(&mut self, lose_appends: bool) {
        for _ in 0..50 {
            let mut moved = false;
            for p in self.log.poll_pushes() {
                moved = true;
                let _ = self.e.on_log_push(p);
            }
            for c in self.e.take_log_calls() {
                moved = true;
                let append = matches!(c.request, LogRequest::Append(_));
                let reply = if lose_appends && append {
                    Err(LogError::NoResponse)
                } else {
                    self.log.call(c.request)
                };
                let _ = self.e.on_log_reply(c.id, reply);
            }
            if !moved {
                break;
            }
        }
    }
}

fn request(id: u64, method: &str, params: Cbor) -> Vec<u8> {
    ClientFrame::Request(ClientRequest {
        id,
        method: method.into(),
        params,
    })
    .to_bytes()
    .unwrap()
}

fn hello() -> Vec<u8> {
    request(
        0,
        "hello",
        HelloParams {
            versions: vec![Version { major: 1, minor: 0 }],
            client_name: "app".into(),
            client_version: "0".into(),
            features: None,
            timezone: None,
        }
        .to_cbor(),
    )
}

fn submit(id: u64, path: &str) -> Vec<u8> {
    submit_doc(id, path, "hello")
}

fn submit_doc(id: u64, path: &str, doc: &str) -> Vec<u8> {
    let p = SubmitParams {
        ops: vec![Op::Create(Create {
            id: B16([id as u8; 16]),
            path: Some(path.into()),
            type_name: None,
            frontmatter: None,
            body: None,
            document: Some(Text::Inline(doc.into())),
        })],
        mutation_id: Some(B16([0xa0 + id as u8; 16])),
        conflict_mode: None,
        timezone: None,
        allow_partial: None,
        mutation_ids: None,
        dry_run: None,
        include: None,
        wait: None,
    };
    request(id, "submit", p.to_cbor())
}

/// Response frames for `session` with request `id`: the decoded receipts or problem code.
fn responses(out: &[Out], session: u64, id: u64) -> Vec<Result<Vec<Receipt>, String>> {
    out.iter()
        .filter_map(|o| match o {
            Out::Frame(s, b) if *s == session => {
                match ClientFrame::from_cbor(&cbor::decode(b).ok()?).ok()? {
                    ClientFrame::Response(r) if r.id == id => Some(match (r.result, r.problem) {
                        (Some(c), _) => Ok(Vec::<Receipt>::from_cbor(&c).unwrap()),
                        (_, Some(p)) => Err(p.code),
                        _ => Err("empty".into()),
                    }),
                    _ => None,
                }
            }
            _ => None,
        })
        .collect()
}

#[test]
fn hello_waits_for_the_rebuild() {
    let svc = world();
    let mut h = open(&svc);
    let (s, _) = h.e.hello(Some((GRANT, CLIENT_PK)), &hello());
    assert_eq!(s, 0, "not serving before the rebuild");
    h.pump(false);
    assert!(h.e.serving());
    let (s, _) = h.e.hello(Some((GRANT, CLIENT_PK)), &hello());
    assert_ne!(s, 0);
}

#[test]
fn submit_response_only_after_the_log_append() {
    let svc = world();
    let mut h = open(&svc);
    h.pump(false);
    let (s, _) = h.e.hello(Some((GRANT, CLIENT_PK)), &hello());
    let head = svc.head(&COL).0;
    h.e.frame(s, &submit(1, "a.md"));
    assert!(
        responses(&h.e.poll(), s, 1).is_empty(),
        "no answer before the append"
    );
    h.pump(false);
    let r = responses(&h.e.poll(), s, 1);
    assert_eq!(r.len(), 1);
    let receipts = r[0].as_ref().unwrap();
    assert_eq!(receipts[0].state, ReceiptState::Confirmed);
    assert_eq!(receipts[0].seq, Some(head + 1));
}

#[test]
fn unknown_append_keeps_the_request_open() {
    let svc = world();
    let mut h = open(&svc);
    h.pump(false);
    let (s, _) = h.e.hello(Some((GRANT, CLIENT_PK)), &hello());
    h.e.frame(s, &submit(1, "a.md"));
    h.pump(true);
    assert!(
        responses(&h.e.poll(), s, 1).is_empty(),
        "unknown is not an answer"
    );
    // The retry (identical bytes) lands; the confirmed answer follows.
    h.clock.set(h.clock.get() + 10_000);
    h.e.tick(h.clock.get() as i64);
    h.pump(false);
    let r = responses(&h.e.poll(), s, 1);
    assert_eq!(r[0].as_ref().unwrap()[0].state, ReceiptState::Confirmed);
}

#[test]
fn pre_log_refusal_answers_at_once() {
    let svc = world();
    let mut h = open(&svc);
    h.pump(false);
    let (s, _) = h.e.hello(Some((GRANT, CLIENT_PK)), &hello());
    h.log.faults.offline = true;
    // A bad request (no ops) is refused before anything is captured.
    let p = SubmitParams {
        ops: Vec::new(),
        mutation_id: None,
        conflict_mode: None,
        timezone: None,
        allow_partial: Some(true),
        mutation_ids: Some(vec![B16([1; 16])]),
        dry_run: None,
        include: None,
        wait: None,
    };
    h.e.frame(s, &request(9, "submit", p.to_cbor()));
    let r = responses(&h.e.poll(), s, 9);
    assert_eq!(r, vec![Err("invalid_request".to_string())]);
}

#[test]
fn config_requires_roots_and_32_byte_keys() {
    let bad = |c: Cbor| OpenConfig::decode(&cbor::encode(&c).unwrap()).is_err();
    assert!(bad(Cbor::Map(vec![(Cbor::Uint(0), COL.to_cbor())])));
    let Cbor::Map(ok) = config_value(&world()) else {
        unreachable!()
    };
    assert!(!bad(Cbor::Map(ok.clone())));
    let mut missing_roots = ok.clone();
    missing_roots
        .iter_mut()
        .find(|(k, _)| *k == Cbor::Uint(3))
        .unwrap()
        .1 = Cbor::Array(vec![]);
    assert!(bad(Cbor::Map(missing_roots)), "no roots");
    let mut short_key = ok;
    short_key
        .iter_mut()
        .find(|(k, _)| *k == Cbor::Uint(6))
        .unwrap()
        .1 = Cbor::Bytes(vec![8; 31]);
    assert!(bad(Cbor::Map(short_key)), "31-byte kem key");
}

#[test]
fn open_config_requires_verified_original_and_pins_before_parsing_secret_keys() {
    let Cbor::Map(valid) = config_value(&world()) else {
        unreachable!()
    };
    for key in [8, 9, 10] {
        let mut m = valid.clone();
        m.retain(|(k, _)| *k != Cbor::Uint(key));
        assert!(OpenConfig::decode(&cbor::encode(&Cbor::Map(m)).unwrap()).is_err());
    }
    let mut m = valid.clone();
    m.iter_mut().find(|(k, _)| *k == Cbor::Uint(10)).unwrap().1 = B32([0; 32]).to_cbor();
    m.iter_mut().find(|(k, _)| *k == Cbor::Uint(5)).unwrap().1 = Cbor::Bytes(vec![0; 31]);
    let error = OpenConfig::decode(&cbor::encode(&Cbor::Map(m)).unwrap()).unwrap_err();
    assert_eq!(error.0, "hosted public trust refused");
    let mut m = valid;
    m.iter_mut().find(|(k, _)| *k == Cbor::Uint(3)).unwrap().1 =
        Cbor::Array(vec![B32([0; 32]).to_cbor()]);
    let error = OpenConfig::decode(&cbor::encode(&Cbor::Map(m)).unwrap()).unwrap_err();
    assert_eq!(error.0, "hosted public trust mismatch");
}

#[test]
fn private_verification_cannot_be_stripped_or_mutated_before_engine_key_use() {
    struct NoClock;
    impl mdbn_core::host::Clock for NoClock {
        fn now_ms(&self) -> u64 {
            panic!("refused public trust must not touch host/store/keys")
        }
    }
    let svc = world();
    for mutation in 0..5 {
        let mut c = config(&svc);
        match mutation {
            0 => c.cfg.expected_genesis = None,
            1 => c.cfg.policy_pins = None,
            2 => c.cfg.trusted_roots.push([0; 32]),
            3 => c.cfg.collection = B16([0x94; 16]),
            4 => c.cfg.mode = mdbn_wire::client::SyncMode::LocalOnly,
            _ => unreachable!(),
        }
        let host = Host {
            clock: Box::new(NoClock),
            entropy: Box::new(mdbn_replica::crypto::TestEntropy::new(1)),
            zones: Box::new(UtcOnly),
        };
        assert!(Engine::open(c, MemStore::new(), host, HostedProfile::default()).is_err());
    }
}

/// Responses are bounded at 1 MiB: a larger result is a `too_large` problem for the
/// same request, never a truncated or partial answer.
#[test]
fn oversized_responses_become_too_large() {
    let svc = world();
    let mut h = open(&svc);
    h.pump(false);
    let (s, _) = h.e.hello(Some((GRANT, CLIENT_PK)), &hello());
    let body = "x".repeat(400 << 10);
    for i in 1..=3u64 {
        h.e.frame(
            s,
            &submit_doc(i, &format!("n{i}.md"), &format!("---\nn: {i}\n---\n{body}")),
        );
        h.pump(false);
        let _ = h.e.poll();
    }
    let q = Cbor::Map(vec![
        (Cbor::Uint(0), Cbor::Map(vec![])),
        (
            Cbor::Uint(1),
            Cbor::Map(vec![(Cbor::Uint(1), Cbor::Bool(true))]),
        ),
    ]);
    h.e.frame(s, &request(20, "query", q));
    let r = responses(&h.e.poll(), s, 20);
    assert_eq!(r, vec![Err("too_large".to_string())]);
}

/// Service-created cloud copy: genesis enrols only hosted and
/// escrow. The engine, as first member, appends the initial rekey for hosted and
/// escrow and starts serving; when the account's desktop is enrolled it appends a
/// key_grant to it.
#[test]
fn engine_keys_a_service_created_cloud_copy_and_grants_a_joining_device() {
    use mdbn_replica::log::LogResponse;
    use mdbn_wire::envelope::{Item, KeyGrantPayload};
    use mdbn_wire::log_service::ReadParams;
    let svc = FakeLogService::new();
    let mut cp = TestControlPlane::signed(COL);
    let service = |device, kind| TestDevice {
        device,
        account: mdbn_replica::policy::SERVICE_ACCOUNT,
        kind,
    };
    cp.genesis(
        &svc,
        CState::CloudCopy,
        &[
            service(HOSTED_DEV, DeviceKind::Hosted),
            service(ESCROW_DEV, DeviceKind::Escrow),
        ],
    );
    let items = |svc: &FakeLogService| -> Vec<Item> {
        let r = svc
            .client(B16([0xee; 16]))
            .call(LogRequest::Read(ReadParams {
                collection: COL,
                after: 0,
                limit: 100,
                kinds: None,
                max_bytes: None,
            }));
        let Ok(LogResponse::Read(r)) = r else {
            panic!("{r:?}")
        };
        r.items
            .iter()
            .map(|it| Item::from_bytes(&it.item.0).unwrap())
            .collect()
    };
    let mut h = open(&svc);
    h.pump(false);
    let log = items(&svc);
    let rekey = log
        .iter()
        .find(|i| i.kind == ItemKind::Rekey)
        .expect("initial rekey");
    assert_eq!(rekey.signer, Some(HOSTED_DEV));
    let p = RekeyPayload::from_bytes(&rekey.body.0).unwrap();
    let mut to: Vec<_> = p.wraps.iter().map(|w| w.device).collect();
    to.sort();
    assert_eq!(to, vec![HOSTED_DEV, ESCROW_DEV]);
    assert!(h.e.serving(), "keyed and serving with no user device");
    cp.enrol(
        &svc,
        TestDevice {
            device: OWNER_DEV,
            account: TEST_OWNER,
            kind: DeviceKind::Desktop,
        },
    );
    assert!(h.e.bind_log(COL), "re-bind re-subscribes");
    h.pump(false);
    let grant = items(&svc)
        .into_iter()
        .find(|i| i.kind == ItemKind::KeyGrant)
        .expect("key_grant to the joining desktop");
    assert_eq!(grant.signer, Some(HOSTED_DEV));
    let g = KeyGrantPayload::from_bytes(&grant.body.0).unwrap();
    assert_eq!((g.recipient, g.epoch), (OWNER_DEV, 1));
}

/// The escrow Worker opens its engine with the grant-only emission profile (config
/// key 7); hosted never does.
#[test]
fn open_config_carries_the_escrow_grant_only_profile() {
    use mdbn_wire::cbor::{self, Cbor};
    let cfg = |extra: Option<Cbor>| {
        let Cbor::Map(mut m) = config_value(&world()) else {
            unreachable!()
        };
        if let Some(v) = extra {
            m.insert(7, (Cbor::Uint(7), v));
        }
        crate::runtime::OpenConfig::decode(&cbor::encode(&Cbor::Map(m)).unwrap()).unwrap()
    };
    assert!(!cfg(None).cfg.key_grants_only);
    assert!(cfg(Some(Cbor::Bool(true))).cfg.key_grants_only);
    assert!(!cfg(Some(Cbor::Bool(false))).cfg.key_grants_only);
}

/// Replies are accepted only through the scope of the session that sent
/// the call. After the session is retired (reset, pause), a late reply is refused
/// before decoding, and a fresh session re-sends the outstanding bytes.
#[test]
fn log_replies_are_scoped_to_the_session_that_sent_them() {
    let svc = world();
    let mut h = open(&svc);
    h.pump(false);
    let (s, _) = h.e.hello(Some((GRANT, CLIENT_PK)), &hello());
    h.e.frame(s, &submit(1, "a.md"));
    let calls = h.e.take_log_calls();
    assert!(!calls.is_empty());
    let replies: Vec<_> = calls
        .iter()
        .map(|c| (c.id, h.log.call(c.request.clone())))
        .collect();
    h.e.retire_log();
    for (id, reply) in replies {
        let mut decoded = false;
        let accepted = h.e.on_log_reply_with(id, |_, _| {
            decoded = true;
            reply
        });
        assert!(!accepted, "stale session refused");
        assert!(!decoded, "never decoded");
    }
    assert!(
        h.e.take_log_calls().is_empty(),
        "nothing leaves without a session"
    );
    assert!(h.e.bind_log(COL));
    h.pump(false);
    let r = responses(&h.e.poll(), s, 1);
    assert_eq!(r.len(), 1, "the submit completes on the fresh session");
}
