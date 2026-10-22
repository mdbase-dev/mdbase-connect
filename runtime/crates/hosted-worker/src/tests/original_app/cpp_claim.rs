//! Actual already-keyed native context; fake log, no CPP/physical/permit bridge.
use super::*;
use crate::runtime::{ConfiguredCppAudience, CppClaimSignRefused};
use mdbn_replica::crypto::sign::verify_digest;
use mdbn_wire::{common::B64, hash::h};
const ORIGIN: &str = "https://connect-lab.mdbase.dev";
const DOMAIN: &str = "mdbase/v1/cp-hosted-migration-claim-read";

fn cpp_open(svc: &FakeLogService) -> AppHosted {
    cpp_open_store(svc, MemStore::new(), 2)
}
fn cpp_open_store(svc: &FakeLogService, store: MemStore, seed: u8) -> AppHosted {
    let clock = Rc::new(Cell::new(1_700_000_000_000));
    let host = Host {
        clock: Box::new(TestClock(clock.clone())),
        entropy: Box::new(mdbn_replica::crypto::TestEntropy::new(seed)),
        zones: Box::new(UtcOnly),
    };
    let mut e = Engine::open_for_cpp_claim(
        config(svc),
        store,
        host,
        HostedProfile::default(),
        ConfiguredCppAudience::from_owned_origin(ORIGIN).unwrap(),
    )
    .unwrap();
    assert!(e.bind_log(COL));
    AppHosted {
        e,
        log: svc.client(HOSTED_DEV),
        clock,
    }
}
fn independent_message(n: &mdbn_replica::VerifiedHostedAdmission, c: B32) -> Vec<Cbor> {
    vec![
        Cbor::Uint(1),
        Cbor::Text(ORIGIN.into()),
        Cbor::Text("POST".into()),
        Cbor::Text(format!(
            "/internal/v1/next/migration/collections/{}/claim/read",
            n.collection().to_uuid_string()
        )),
        n.collection().to_cbor(),
        n.device().to_cbor(),
        n.root_id().to_cbor(),
        n.identity().sign_pk.to_cbor(),
        n.identity().kem_pk.to_cbor(),
        n.noise_pk().to_cbor(),
        c.to_cbor(),
    ]
}
fn verify(n: &mdbn_replica::VerifiedHostedAdmission, fields: Vec<Cbor>, sig: B64) -> bool {
    let digest = h(DOMAIN, &cbor::encode(&Cbor::Array(fields)).unwrap());
    verify_digest(&n.identity().sign_pk.0, &digest.0, &sig.0)
}
#[test]
fn bridge_ticket_keeps_native_point_and_allows_one_attempt_only() {
    use crate::cpp_claim_ticket::CppClaimTicketSlot;
    let (svc, mut cp, _, _) = fixture();
    let mut default = open(&svc);
    default.pump(false);
    assert!(CppClaimTicketSlot::begin(&mut default.e, 1).is_err());
    let mut x = cpp_open(&svc);
    assert!(CppClaimTicketSlot::begin(&mut x.e, 1).is_err());
    x.pump(false);
    let mut slot = CppClaimTicketSlot::begin(&mut x.e, 1).unwrap();
    assert_eq!(slot.subject(), (1, COL, HOSTED_DEV));
    assert!(slot.matches(1));
    assert!(!slot.matches(2));
    assert!(slot.assert_current(&mut x.e, 2).is_err());
    assert!(slot.sign(&mut x.e, 2, B32([0x55; 32])).is_err());
    assert!(slot.assert_current(&mut x.e, 1).is_ok());
    let sig = slot.sign(&mut x.e, 1, B32([0x55; 32])).unwrap();
    let native = x.e.observe_native_target().unwrap();
    assert!(verify(
        native.admission(),
        independent_message(native.admission(), B32([0x55; 32])),
        sig
    ));
    assert!(slot.sign(&mut x.e, 1, B32([0x56; 32])).is_err());
    assert!(slot.assert_current(&mut x.e, 1).is_ok());
    let mut foreign = cpp_open(&svc);
    foreign.pump(false);
    assert!(slot.assert_current(&mut foreign.e, 1).is_err());
    cp.append(
        &svc,
        vec![PolicyOp::MemberSet(MemberSet {
            account: TEST_OWNER,
            role: Role::Owner,
        })],
    );
    x.pump(false);
    assert!(slot.assert_current(&mut x.e, 1).is_err());
    let fresh = CppClaimTicketSlot::begin(&mut x.e, 2).unwrap();
    assert!(fresh.assert_current(&mut x.e, 2).is_ok());
    x.e.retire_log();
    assert!(fresh.assert_current(&mut x.e, 2).is_err());
    assert!(CppClaimTicketSlot::begin(&mut x.e, 0).is_err());
    assert!(CppClaimTicketSlot::begin(&mut x.e, 1_u64 << 53).is_err());
}
#[test]
fn abi_ticket_numbers_never_truncate_or_alias() {
    use crate::cpp_claim_ticket::handle;
    for f in [
        f64::NAN,
        f64::INFINITY,
        f64::NEG_INFINITY,
        -1.0,
        0.0,
        1.5,
        (1_u64 << 53) as f64,
    ] {
        assert_eq!(handle(f), None);
    }
    assert_eq!(handle(1.0), Some(1));
    assert_eq!(handle(((1_u64 << 53) - 1) as f64), Some((1_u64 << 53) - 1));
}
#[test]
fn fixed_signer_verifies_only_exact_native_template_and_writes_no_store() {
    let (svc, _, _, _) = fixture();
    let mut x = cpp_open(&svc);
    assert!(x.e.observe_native_target().is_err());
    x.pump(false);
    let point = x.e.observe_native_target().unwrap();
    let challenge = B32([0x55; 32]);
    let head = x.e.replica().store().head().unwrap();
    let policy = x.e.replica().store().meta("policy").unwrap();
    let hints =
        x.e.replica()
            .store()
            .meta("replica.original_history_hints.v1")
            .unwrap();
    let tail = x.e.replica().store().tail(0, 10).unwrap();
    let sig = x.e.sign_cpp_claim_challenge(&point, challenge).unwrap();
    let fields = independent_message(point.admission(), challenge);
    assert!(verify(point.admission(), fields.clone(), sig));
    for index in 0..11 {
        let mut changed = fields.clone();
        changed[index] = match index {
            0 => Cbor::Uint(2),
            1 => Cbor::Text("https://foreign.test".into()),
            2 => Cbor::Text("GET".into()),
            3 => Cbor::Text("/wrong".into()),
            4..=6 => B16([0x99; 16]).to_cbor(),
            _ => B32([0x99; 32]).to_cbor(),
        };
        assert!(
            !verify(point.admission(), changed, sig),
            "signed-field {index}"
        );
    }
    let bytes = cbor::encode(&Cbor::Array(fields)).unwrap();
    assert!(!verify_digest(
        &point.admission().identity().sign_pk.0,
        &h("mdbase/v1/wrong", &bytes).0,
        &sig.0
    ));
    // Local signatures do NOT consume/mint CP nonce authority. Only CP can do so.
    assert_eq!(
        x.e.sign_cpp_claim_challenge(&point, challenge).unwrap(),
        sig
    );
    assert_eq!(x.e.replica().store().head().unwrap(), head);
    assert_eq!(x.e.replica().store().meta("policy").unwrap(), policy);
    assert_eq!(
        x.e.replica()
            .store()
            .meta("replica.original_history_hints.v1")
            .unwrap(),
        hints
    );
    assert_eq!(x.e.replica().store().tail(0, 10).unwrap(), tail);
}
#[test]
fn healthy_head_drift_and_warm_cached_hints_do_not_reuse_a_signing_point() {
    let (svc, mut cp, _, _) = fixture();
    let mut x = cpp_open(&svc);
    x.pump(false);
    let old = x.e.observe_native_target().unwrap();
    cp.append(
        &svc,
        vec![PolicyOp::MemberSet(MemberSet {
            account: TEST_OWNER,
            role: Role::Owner,
        })],
    );
    x.pump(false);
    let current = x.e.observe_native_target().unwrap();
    assert_ne!(
        old.admission().applied_head(),
        current.admission().applied_head()
    );
    assert_eq!(old.originals(), current.originals());
    assert_eq!(
        x.e.sign_cpp_claim_challenge(&old, B32([0x55; 32])).err(),
        Some(CppClaimSignRefused)
    );
    assert!(
        x.e.sign_cpp_claim_challenge(&current, B32([0x55; 32]))
            .is_ok()
    );
    let store = x.e.replica().store().inner().clone();
    let mut warm = cpp_open_store(&svc, store, 3);
    assert!(warm.e.observe_native_target().is_err());
    assert_eq!(
        warm.e
            .sign_cpp_claim_challenge(&current, B32([0x55; 32]))
            .err(),
        Some(CppClaimSignRefused)
    );
    warm.pump(false);
    let fresh = warm.e.observe_native_target().unwrap();
    assert_eq!(fresh.originals(), current.originals());
    assert_ne!(
        fresh.admission().wake_instance(),
        current.admission().wake_instance()
    );
    assert_eq!(
        warm.e
            .sign_cpp_claim_challenge(&current, B32([0x55; 32]))
            .err(),
        Some(CppClaimSignRefused)
    );
    assert!(
        warm.e
            .sign_cpp_claim_challenge(&fresh, B32([0x55; 32]))
            .is_ok()
    );
}
#[test]
fn default_open_foreign_equal_engine_pruned_original_and_retired_transport_refuse() {
    let (svc, _, _, _) = fixture();
    let mut default = open(&svc);
    default.pump(false);
    let default_point = default.e.observe_native_target().unwrap();
    assert_eq!(
        default
            .e
            .sign_cpp_claim_challenge(&default_point, B32([0x55; 32]))
            .err(),
        Some(CppClaimSignRefused)
    );
    let mut x = cpp_open(&svc);
    let mut y = cpp_open(&svc);
    x.pump(false);
    y.pump(false);
    let point = x.e.observe_native_target().unwrap();
    let other = y.e.observe_native_target().unwrap();
    assert_eq!(point.admission(), other.admission());
    assert_eq!(
        y.e.sign_cpp_claim_challenge(&point, B32([0x55; 32])).err(),
        Some(CppClaimSignRefused)
    );
    assert!(
        y.e.sign_cpp_claim_challenge(&other, B32([0x55; 32]))
            .is_ok()
    );
    x.e.replica_mut()
        .store_mut()
        .commit(Tx {
            tail_drop_below: Some(2),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(
        x.e.sign_cpp_claim_challenge(&point, B32([0x55; 32])).err(),
        Some(CppClaimSignRefused)
    );
    y.e.retire_log();
    assert_eq!(
        y.e.sign_cpp_claim_challenge(&other, B32([0x55; 32])).err(),
        Some(CppClaimSignRefused)
    );
}
