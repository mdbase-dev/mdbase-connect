//! Synthetic signed originals, not ACL reconstruction or serving admission.
use mdbn_log_service::auth::{self, VerifiedCaller};
use mdbn_log_service::backend::{Backend, Mode, Txn, Write};
use mdbn_log_service::decode::Budget;
use mdbn_log_service::mem::{MemBackend, MemObjects};
use mdbn_log_service::policy::{self, OriginalPins, OriginalSubject};
use mdbn_log_service::testkit::{ControlPlane, Device, id16, sign_digest};
use mdbn_log_service::{Config, Service};
use mdbn_wire::cbor::Cbor;
use mdbn_wire::common::{B32, Bytes, Version};
use mdbn_wire::envelope::Item;
use mdbn_wire::hash::{CHAIN_ZERO, chain_hash, sha256};
use mdbn_wire::log_service::AppendParams;
use mdbn_wire::log_service::LsHelloParams;
use mdbn_wire::policy::{CState, DeviceKind, Genesis, PolicyOp, PolicyPayload};
use mdbn_wire::schema::Wire;
use std::future::Future;
use std::sync::Arc;
use std::task::{Context, Poll, Wake, Waker};
const NOW: i64 = 1000;
struct Fixture {
    cp: ControlPlane,
    device: Device,
    genesis: Vec<u8>,
    enrollment: Vec<u8>,
    pins: OriginalPins,
    caller: VerifiedCaller,
}
impl Fixture {
    fn new(kind: DeviceKind) -> Self {
        let cp = ControlPlane::new("original/cp");
        let owner = id16("original/owner");
        let c = id16("original/A");
        let account = if matches!(kind, DeviceKind::Hosted | DeviceKind::Escrow) {
            id16("original/zero")
        } else {
            owner
        };
        let mut device = Device::new("original/device", account);
        if matches!(kind, DeviceKind::Hosted | DeviceKind::Escrow) {
            device.account.0 = [0; 16];
        }
        let genesis = cp.policy_item(
            c,
            1,
            CHAIN_ZERO,
            vec![PolicyOp::Genesis(Genesis {
                owner,
                root: policy::key_id(&cp.root_pk()),
                state: CState::CloudCopy,
            })],
            1,
        );
        let enrollment = cp.policy_item(c, 2, chain_hash(&genesis), vec![device.enrol(kind)], 2);
        let token = cp.device_token_for(&device, NOW + 10000, Some(c));
        let nonce = [9; 32];
        let p = LsHelloParams {
            version: Version { major: 1, minor: 0 },
            device: Some(device.id),
            sig: device.hello_sig(&nonce, &token),
            token,
        };
        let caller = auth::verify_hello_caller_with_budget(
            &p,
            &nonce,
            &[cp.issuer_pk()],
            NOW,
            &Budget::default(),
        )
        .unwrap();
        let pins = OriginalPins {
            collection: c,
            owner,
            root_pk: cp.root_pk(),
            issuer_pk: cp.issuer_pk(),
            transport_pk: device.pk(),
            genesis_sha256: sha256(&genesis),
            enrollment_sha256: Some(sha256(&enrollment)),
            enrollment_seq: Some(2),
        };
        Self {
            cp,
            device,
            genesis,
            enrollment,
            pins,
            caller,
        }
    }
    fn bind(&self, pins: &OriginalPins, g: &[u8], e: Option<&[u8]>) -> bool {
        policy::bind_original_caller(&self.caller, pins, g, e, NOW, &Budget::default()).is_ok()
    }
}
#[test]
fn actual_signed_kinds_and_tuple_are_preserved_including_app_runtime_without_grant_coercion() {
    for kind in [
        DeviceKind::Desktop,
        DeviceKind::Mobile,
        DeviceKind::AppRuntime,
        DeviceKind::Cli,
        DeviceKind::Hosted,
        DeviceKind::Escrow,
        DeviceKind::Recovery,
    ] {
        let f = Fixture::new(kind);
        let b = policy::bind_original_caller(
            &f.caller,
            &f.pins,
            &f.genesis,
            Some(&f.enrollment),
            NOW,
            &Budget::default(),
        )
        .unwrap();
        assert_eq!(
            b.subject(),
            OriginalSubject::Device {
                id: f.device.id,
                account: f.device.account,
                kind,
                sign_pk: f.device.pk()
            }
        );
        assert_eq!(b.collection(), f.pins.collection);
        assert_eq!(b.owner(), f.pins.owner);
        assert_eq!(b.root(), policy::key_id(&f.pins.root_pk));
        assert_eq!(b.genesis_sha256(), f.pins.genesis_sha256);
        assert_eq!(b.caller().issuer_key(), f.pins.issuer_pk);
        assert_eq!(format!("{b:?}"), "OriginalCaller { .. }");
    }
}
#[test]
fn cp_transport_is_bound_to_actual_original_certified_signer_not_device_or_issuer() {
    let f = Fixture::new(DeviceKind::Desktop);
    let token = f.cp.cp_token(NOW + 10000);
    let nonce = [8; 32];
    let p = LsHelloParams {
        version: Version { major: 1, minor: 0 },
        device: None,
        sig: sign_digest(f.cp.transport_key(), &auth::hello_digest(&nonce, &token)),
        token,
    };
    let caller = auth::verify_hello_caller_with_budget(
        &p,
        &nonce,
        &[f.cp.issuer_pk()],
        NOW,
        &Budget::default(),
    )
    .unwrap();
    let mut pins = f.pins.clone();
    pins.transport_pk = caller.transport_key();
    pins.enrollment_sha256 = None;
    pins.enrollment_seq = None;
    let b = policy::bind_original_caller(&caller, &pins, &f.genesis, None, NOW, &Budget::default())
        .unwrap();
    assert_eq!(b.subject(), OriginalSubject::ControlPlane);
    assert!(
        policy::bind_original_caller(
            &caller,
            &pins,
            &f.genesis,
            Some(&f.enrollment),
            NOW,
            &Budget::default()
        )
        .is_err()
    );
    pins.transport_pk = f.cp.issuer_pk();
    assert!(
        policy::bind_original_caller(&caller, &pins, &f.genesis, None, NOW, &Budget::default())
            .is_err()
    );
}
#[test]
fn each_admitted_pin_and_token_expiry_refuses_mismatch_or_missing_anchor() {
    let f = Fixture::new(DeviceKind::Desktop);
    let mut cases = Vec::new();
    let base = &f.pins;
    let mut p = base.clone();
    p.collection = id16("original/D");
    cases.push(p);
    let mut p = base.clone();
    p.owner = id16("original/other");
    cases.push(p);
    let mut p = base.clone();
    p.root_pk = ControlPlane::new("original/foreign").root_pk();
    cases.push(p);
    let mut p = base.clone();
    p.issuer_pk = ControlPlane::new("original/foreign").issuer_pk();
    cases.push(p);
    let mut p = base.clone();
    p.transport_pk = B32([7; 32]);
    cases.push(p);
    let mut p = base.clone();
    p.genesis_sha256 = B32([7; 32]);
    cases.push(p);
    let mut p = base.clone();
    p.enrollment_sha256 = None;
    cases.push(p);
    let mut p = base.clone();
    p.enrollment_sha256 = Some(B32([0; 32]));
    cases.push(p);
    for p in cases {
        assert!(!f.bind(&p, &f.genesis, Some(&f.enrollment)));
    }
    assert!(!f.bind(base, &f.genesis, None));
    assert!(
        policy::bind_original_caller(
            &f.caller,
            base,
            &f.genesis,
            Some(&f.enrollment),
            NOW + 10000,
            &Budget::default()
        )
        .is_err()
    );
}
#[test]
fn hash_updates_do_not_bypass_item_or_root_certificate_crypto() {
    let f = Fixture::new(DeviceKind::Desktop);
    let mut item = Item::from_bytes(&f.genesis).unwrap();
    item.sig.as_mut().unwrap().0[0] ^= 1;
    let raw = item.to_bytes().unwrap();
    let mut p = f.pins.clone();
    p.genesis_sha256 = sha256(&raw);
    assert!(!f.bind(&p, &raw, Some(&f.enrollment)));
    let mut item = Item::from_bytes(&f.enrollment).unwrap();
    let mut payload = PolicyPayload::from_bytes(&item.body.0).unwrap();
    payload.cert.sig.0[0] ^= 1;
    item.body = Bytes(payload.to_bytes().unwrap());
    item.sig = Some(sign_digest(
        f.cp.transport_key(),
        &item.signed_digest().unwrap(),
    ));
    let raw = item.to_bytes().unwrap();
    let mut p = f.pins.clone();
    p.enrollment_sha256 = Some(sha256(&raw));
    assert!(!f.bind(&p, &f.genesis, Some(&raw)));
    let foreign = ControlPlane::new("original/foreign");
    let raw = foreign.policy_item(
        f.pins.collection,
        2,
        chain_hash(&f.genesis),
        vec![f.device.enrol(DeviceKind::Desktop)],
        2,
    );
    let mut p = f.pins.clone();
    p.enrollment_sha256 = Some(sha256(&raw));
    assert!(!f.bind(&p, &f.genesis, Some(&raw)));
}
#[test]
fn signed_other_uuid_key_account_duplicate_or_grant_only_record_cannot_substitute() {
    let f = Fixture::new(DeviceKind::AppRuntime);
    let impostor = Device::with_id("original/impostor", f.device.id, f.device.account);
    let other = Device::new("original/other", f.device.account);
    let mut bad_account = f.device.enrol(DeviceKind::AppRuntime);
    if let PolicyOp::DeviceEnrol(d) = &mut bad_account {
        d.account = id16("original/other-owner");
    }
    let mut records = vec![
        vec![impostor.enrol(DeviceKind::AppRuntime)],
        vec![other.enrol(DeviceKind::AppRuntime)],
        vec![bad_account],
        vec![
            f.device.enrol(DeviceKind::AppRuntime),
            f.device.enrol(DeviceKind::AppRuntime),
        ],
        vec![],
    ];
    records.push(vec![PolicyOp::Grant(mdbn_wire::policy::Grant {
        grant: f.device.id,
        installation: id16("original/installation"),
        app_id: "[test]".into(),
        account: f.device.account,
        capabilities: vec!["read".into()],
        client_pk: f.device.pk(),
        file_folders: None,
        folder_scoped: None,
    })]);
    for ops in records {
        let raw =
            f.cp.policy_item(f.pins.collection, 2, chain_hash(&f.genesis), ops, 2);
        let mut p = f.pins.clone();
        p.enrollment_sha256 = Some(sha256(&raw));
        assert!(!f.bind(&p, &f.genesis, Some(&raw)));
    }
}
#[test]
fn initial_enrollment_in_same_signed_genesis_is_supported_but_unrelated_seq_one_is_not() {
    let f = Fixture::new(DeviceKind::Desktop);
    let ops = vec![
        PolicyOp::Genesis(Genesis {
            owner: f.pins.owner,
            root: policy::key_id(&f.pins.root_pk),
            state: CState::CloudCopy,
        }),
        f.device.enrol(DeviceKind::Desktop),
    ];
    let raw =
        f.cp.policy_item(f.pins.collection, 1, CHAIN_ZERO, ops.clone(), 1);
    let mut p = f.pins.clone();
    p.genesis_sha256 = sha256(&raw);
    p.enrollment_sha256 = Some(sha256(&raw));
    p.enrollment_seq = Some(1);
    assert!(f.bind(&p, &raw, Some(&raw)));
    let wrong = f.cp.policy_item(f.pins.collection, 1, CHAIN_ZERO, ops, 2);
    p.enrollment_sha256 = Some(sha256(&wrong));
    assert!(!f.bind(&p, &raw, Some(&wrong)));
}
#[test]
fn collection_mode_position_prev_time_and_certificate_window_are_checked() {
    let f = Fixture::new(DeviceKind::Desktop);
    let make = |c, seq, prev, state| {
        f.cp.policy_item(
            c,
            seq,
            prev,
            vec![PolicyOp::Genesis(Genesis {
                owner: f.pins.owner,
                root: policy::key_id(&f.pins.root_pk),
                state,
            })],
            1,
        )
    };
    for raw in [
        make(id16("original/D"), 1, CHAIN_ZERO, CState::CloudCopy),
        make(f.pins.collection, 2, CHAIN_ZERO, CState::CloudCopy),
        make(f.pins.collection, 1, B32([1; 32]), CState::CloudCopy),
        make(f.pins.collection, 1, CHAIN_ZERO, CState::E2e),
    ] {
        let mut p = f.pins.clone();
        p.genesis_sha256 = sha256(&raw);
        assert!(!f.bind(&p, &raw, Some(&f.enrollment)));
    }
    let raw = f.cp.policy_item(
        f.pins.collection,
        2,
        chain_hash(&f.genesis),
        vec![f.device.enrol(DeviceKind::Desktop)],
        0,
    );
    let mut p = f.pins.clone();
    p.enrollment_sha256 = Some(sha256(&raw));
    assert!(!f.bind(&p, &f.genesis, Some(&raw)));
    let mut item = Item::from_bytes(&f.enrollment).unwrap();
    let mut payload = PolicyPayload::from_bytes(&item.body.0).unwrap();
    payload.issued_at = -1;
    item.body = Bytes(payload.to_bytes().unwrap());
    item.sig = Some(sign_digest(
        f.cp.transport_key(),
        &item.signed_digest().unwrap(),
    ));
    let raw = item.to_bytes().unwrap();
    p.enrollment_sha256 = Some(sha256(&raw));
    assert!(!f.bind(&p, &f.genesis, Some(&raw)));
}
#[test]
fn bounded_source_bytes_and_shared_budget_never_reset_on_refusal() {
    let f = Fixture::new(DeviceKind::Desktop);
    let budget = Budget::default();
    let before = budget.usage();
    assert!(
        policy::bind_original_caller(
            &f.caller,
            &f.pins,
            &vec![0; 128 * 1024 + 1],
            None,
            NOW,
            &budget
        )
        .is_err()
    );
    assert_eq!(budget.usage(), before);
    policy::bind_original_caller(
        &f.caller,
        &f.pins,
        &f.genesis,
        Some(&f.enrollment),
        NOW,
        &budget,
    )
    .unwrap();
    let used = budget.usage();
    assert!(used.nodes > 0);
    policy::bind_original_caller(
        &f.caller,
        &f.pins,
        &f.genesis,
        Some(&f.enrollment),
        NOW,
        &budget,
    )
    .unwrap();
    assert!(budget.usage().nodes > used.nodes);
}
struct NoWake;
impl Wake for NoWake {
    fn wake(self: Arc<Self>) {}
}
fn ready<F: Future>(f: F) -> F::Output {
    let w = Waker::from(Arc::new(NoWake));
    let mut cx = Context::from_waker(&w);
    let mut f = std::pin::pin!(f);
    match f.as_mut().poll(&mut cx) {
        Poll::Ready(v) => v,
        Poll::Pending => panic!("memory fixture unexpectedly waited"),
    }
}
fn stored(f: &Fixture) -> Service<MemBackend, MemObjects> {
    let svc = Service::new(
        MemBackend::default(),
        MemObjects::default(),
        Config {
            roots: vec![f.pins.root_pk],
            token_issuers: vec![f.pins.issuer_pk],
            url_secret: vec![7; 32],
            public_base: "http://127.0.0.1".into(),
        },
    );
    ready(svc.call(
        &auth::Principal::ControlPlane,
        "create_log",
        &Cbor::Map(vec![
            (Cbor::Uint(0), f.pins.collection.to_cbor()),
            (Cbor::Uint(1), Cbor::Bytes(f.genesis.clone())),
        ]),
        NOW,
    ))
    .unwrap();
    ready(svc.append(
        &auth::Principal::ControlPlane,
        AppendParams {
            collection: f.pins.collection,
            expect_seq: 2,
            expect_prev: chain_hash(&f.genesis),
            items: vec![Bytes(f.enrollment.clone())],
        },
        NOW,
    ))
    .unwrap();
    svc
}
#[test]
fn actual_readonly_service_uses_retained_signed_bytes_not_mutated_acl_owner_or_cached_identity() {
    let f = Fixture::new(DeviceKind::AppRuntime);
    let svc = stored(&f);
    let initial =
        ready(svc.original_caller(&f.caller, &f.pins, || NOW, &Budget::default())).unwrap();
    let mut tx = ready(svc.backend.begin(&f.pins.collection, Mode::Write)).unwrap();
    let st = ready(tx.load()).unwrap().unwrap();
    let mut acl = st.acl.get(&f.device.id).unwrap().clone();
    acl.kind = DeviceKind::Cli.value();
    acl.sign_pk = B32([8; 32]);
    acl.active = false;
    let mut meta = st.meta.clone();
    meta.owner = id16("original/fabricated-owner");
    tx.write(Write::UpsertAcl(acl));
    tx.write(Write::PutMeta(meta.clone()));
    ready(tx.commit()).unwrap();
    let original =
        ready(svc.original_caller(&f.caller, &f.pins, || NOW, &Budget::default())).unwrap();
    assert_eq!(original.subject(), initial.subject());
    assert_eq!(original.owner(), f.pins.owner);
    let mut tx = ready(svc.backend.begin(&f.pins.collection, Mode::Read)).unwrap();
    let after = ready(tx.load()).unwrap().unwrap();
    assert_eq!(after.meta, meta);
    assert_eq!(
        after.acl.get(&f.device.id).unwrap().kind,
        DeviceKind::Cli.value()
    );
    drop(tx);
    ready(
        svc.backend
            .lose_tail(&f.pins.collection, 1, &svc.config.roots),
    );
    assert!(
        ready(svc.original_caller(&f.caller, &f.pins, || NOW, &Budget::default())).is_err(),
        "no fallback to persisted ACL/cached witness when original record is missing"
    );
}
#[test]
fn service_declared_exact_position_and_configured_trust_and_post_await_clock_are_required() {
    let f = Fixture::new(DeviceKind::Desktop);
    let mut svc = stored(&f);
    let mut p = f.pins.clone();
    p.enrollment_seq = Some(3);
    assert!(ready(svc.original_caller(&f.caller, &p, || NOW, &Budget::default())).is_err());
    assert!(
        ready(svc.original_caller(&f.caller, &f.pins, || NOW + 10000, &Budget::default())).is_err()
    );
    svc.config.token_issuers.clear();
    assert!(ready(svc.original_caller(&f.caller, &f.pins, || NOW, &Budget::default())).is_err());
    svc.config.token_issuers = vec![f.pins.issuer_pk];
    svc.config.roots.clear();
    assert!(ready(svc.original_caller(&f.caller, &f.pins, || NOW, &Budget::default())).is_err());
}
