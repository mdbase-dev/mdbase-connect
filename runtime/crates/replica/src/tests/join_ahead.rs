//! Join-ahead (`replica/join_ahead.rs`): a device keyed after content was written
//! reads control items ahead while waiting for a key, with the production sealer
//! (real Ed25519 control items and entries, HPKE wraps, key commitments).
//!
//! Join-ahead sequence: A writes a sealed entry, B is
//! enrolled after it and its `key_grant` is appended later still. Without
//! read-ahead B applied up to the entry's predecessor and waited forever.

use super::engine::{COL, Node, node_with, settle};
use crate::KeyWaitReason;
use crate::crypto::hpke::KemKeyPair;
use crate::crypto::keys::Recipient;
use crate::crypto::sign::DeviceSigner;
use crate::fake::FakeLogService;
use crate::mem::MemStore;
use crate::seal::KeyringSealer;
use crate::testkit::{TEST_OWNER, TestControlPlane};
use mdbn_wire::client::IncidentKind;
use mdbn_wire::common::{B16, B32, Value};
use mdbn_wire::envelope::ItemKind;
use mdbn_wire::log_service::ReadKinds;
use mdbn_wire::policy::{CState, DeviceEnrol, DeviceKind, PolicyOp};
use mdbn_wire::schema::Wire;

const A: B16 = B16([101; 16]);
const B: B16 = B16([102; 16]);
const ESCROW: B16 = B16([103; 16]);
const C: B16 = B16([104; 16]);
const A_KEYS: ([u8; 32], [u8; 32]) = ([0x31; 32], [0x32; 32]);
const B_KEYS: ([u8; 32], [u8; 32]) = ([0x41; 32], [0x42; 32]);
const ESCROW_KEYS: ([u8; 32], [u8; 32]) = ([0x51; 32], [0x52; 32]);
const C_KEYS: ([u8; 32], [u8; 32]) = ([0x61; 32], [0x62; 32]);

fn enrol(device: B16, account: B16, kind: DeviceKind, keys: ([u8; 32], [u8; 32])) -> PolicyOp {
    PolicyOp::DeviceEnrol(DeviceEnrol {
        device,
        account,
        kind,
        sign_pk: B32(DeviceSigner::from_seed(&keys.0).public()),
        kem_pk: B32(KemKeyPair::from_secret(&keys.1).pk),
        noise_pk: B32([device.0[0]; 32]),
        sas_commit: None,
        local_root: None,
    })
}

/// Node `n` (device `n + 100`) with the production sealer. It trusts A's keys
/// (the device its user compared codes with).
fn open(svc: &FakeLogService, n: u8, keys: ([u8; 32], [u8; 32])) -> Node {
    let dev = B16([n + 100; 16]);
    node_with(
        svc,
        n,
        MemStore::new(),
        vec![A],
        Some(Box::new(KeyringSealer::new(COL, dev, &keys.0, &keys.1))),
    )
}

/// Append a control item signed (Ed25519) by `signer`, bypassing its replica.
fn append_signed(
    svc: &FakeLogService,
    signer: B16,
    keys: ([u8; 32], [u8; 32]),
    kind: ItemKind,
    body: Vec<u8>,
) -> u64 {
    use crate::log::{LogClient, LogRequest, LogResponse};
    use crate::seal::Sealer;
    let (head, prev) = svc.head(&COL);
    let mut item = mdbn_wire::envelope::Item {
        kind,
        collection: COL,
        seq: Some(head + 1),
        prev: Some(prev),
        epoch: None,
        signer: Some(signer),
        salt: None,
        idem: None,
        refs: None,
        stream: None,
        body: mdbn_wire::common::Bytes(body),
        sig: None,
    };
    KeyringSealer::new(COL, signer, &keys.0, &keys.1)
        .sign(&mut item)
        .unwrap();
    let reply = svc
        .client(signer)
        .call(LogRequest::Append(mdbn_wire::log_service::AppendParams {
            collection: COL,
            expect_seq: head + 1,
            expect_prev: prev,
            items: vec![mdbn_wire::common::Bytes(item.to_bytes().unwrap())],
        }));
    assert!(matches!(reply, Ok(LogResponse::Append(_))), "{reply:?}");
    head + 1
}

/// A collection where A did the initial rekey and wrote one sealed entry (doc 1).
/// Cloud copy also enrols an escrow (keyed by A's initial rekey).
fn world(state: CState) -> (FakeLogService, TestControlPlane, Node) {
    let svc = FakeLogService::new();
    let mut cp = TestControlPlane::signed(COL);
    cp.genesis_with_keys(&svc, state, A, &A_KEYS.0, &A_KEYS.1);
    if state == CState::CloudCopy {
        cp.append(
            &svc,
            vec![enrol(
                ESCROW,
                crate::policy::SERVICE_ACCOUNT,
                DeviceKind::Escrow,
                ESCROW_KEYS,
            )],
        );
    }
    let mut a = open(&svc, 1, A_KEYS);
    settle(&mut [&mut a]);
    assert_eq!(a.r.policy.epoch, 1, "A did the initial rekey");
    a.create(1, "secret.md", "written before B joined");
    settle(&mut [&mut a]);
    assert_eq!(a.r.sync_status().pending, 0);
    (svc, cp, a)
}

fn enrol_b(svc: &FakeLogService, cp: &mut TestControlPlane) -> u64 {
    cp.append(svc, vec![enrol(B, TEST_OWNER, DeviceKind::Desktop, B_KEYS)])
}

/// A keyed member device's `key_grant` to `to` (private mode: the device on which
/// the user compared codes appends it; validity is the policy's, as in apply).
fn member_grant(a: &mut Node, to: B16, kem: [u8; 32]) -> u64 {
    settle(&mut [&mut *a]);
    let before = a.r.head().seq;
    let payload =
        a.r.sealer
            .build_key_grant(
                a.r.policy.epoch,
                &Recipient {
                    device: to,
                    kem_pk: KemKeyPair::from_secret(&kem).pk,
                },
                &mut crate::crypto::TestEntropy::new(17),
            )
            .unwrap();
    assert!(
        a.r.append_control(ItemKind::KeyGrant, payload.to_bytes().unwrap()),
        "sent"
    );
    settle(&mut [&mut *a]);
    assert_eq!(a.r.head().seq, before + 1, "the grant was logged");
    a.r.head().seq
}

fn waiting_at(n: &Node) -> Option<u64> {
    match n.r.stalled {
        Some((IncidentKind::WaitingForKey, p)) => Some(p),
        _ => None,
    }
}

/// Past the key-wait probe's backoff deadline.
fn probe(n: &mut Node) {
    n.clock.set(n.clock.get() + 60_000);
    settle(&mut [n]);
}

fn incident_reason(n: &Node) -> Option<String> {
    let i = n.r.incidents.get(&IncidentKind::WaitingForKey.value())?;
    let Some(Value::Map(m)) = &i.details else {
        return None;
    };
    m.iter().find_map(|(k, v)| match (k.as_str(), v) {
        ("reason", Value::Text(t)) => Some(t.clone()),
        _ => None,
    })
}

#[test]
fn private_member_grant_after_join_decrypts_earlier_content() {
    let (svc, mut cp, mut a) = world(CState::E2e);
    let entry = a.r.head().seq;
    enrol_b(&svc, &mut cp);
    let grant = member_grant(&mut a, B, B_KEYS.1);
    assert!(grant > entry + 1, "the grant is after B's enrolment");
    // Join-ahead order: B joins with the grant already logged, past its stall position.
    let mut b = open(&svc, 2, B_KEYS);
    settle(&mut [&mut b]);
    assert_eq!(b.doc(1).as_deref(), Some("written before B joined"));
    assert_eq!(b.r.head().seq, grant, "ordered apply reached the head");
    assert!(b.r.stalled.is_none());
    assert!(b.r.policy.devices[&B].keyed, "keyed by the grant in order");
    assert_eq!(b.r.policy.devices[&B].delivered_by, Some(A));
    assert_eq!(b.r.stats.voided, 0);
    // B writes, and A reads it: B seals with the key it was granted.
    b.create(2, "from-b.md", "B is keyed");
    settle(&mut [&mut a, &mut b]);
    assert_eq!(a.doc(2).as_deref(), Some("B is keyed"));
}

#[test]
fn private_grant_appended_while_waiting_is_found_by_the_next_probe() {
    let (svc, mut cp, mut a) = world(CState::E2e);
    let entry = a.r.head().seq;
    enrol_b(&svc, &mut cp);
    let mut b = open(&svc, 2, B_KEYS);
    settle(&mut [&mut b]);
    assert_eq!(waiting_at(&b), Some(entry));
    assert_eq!(
        b.r.key_wait_reason(),
        Some(KeyWaitReason::NoGrant { through: entry + 1 })
    );
    assert_eq!(incident_reason(&b).as_deref(), Some("no_grant"));
    assert_eq!(b.doc(1), None);
    member_grant(&mut a, B, B_KEYS.1);
    // A head push alone does not start reads; the bounded probe does.
    settle(&mut [&mut b]);
    assert_eq!(waiting_at(&b), Some(entry));
    probe(&mut b);
    assert_eq!(b.doc(1).as_deref(), Some("written before B joined"));
    assert!(b.r.stalled.is_none());
    assert!(
        !b.r.incidents
            .contains_key(&IncidentKind::WaitingForKey.value())
    );
}

#[test]
fn cloud_copy_escrow_grant_after_join_decrypts_earlier_content() {
    let (svc, mut cp, mut a) = world(CState::CloudCopy);
    let entry = a.r.head().seq;
    enrol_b(&svc, &mut cp);
    // The escrow (no hosted enrolled) keys the approved account device.
    let mut escrow = open(&svc, 3, ESCROW_KEYS);
    settle(&mut [&mut escrow]);
    let grant = escrow.r.head().seq;
    assert!(grant > entry + 1);
    let mut b = open(&svc, 2, B_KEYS);
    settle(&mut [&mut b]);
    assert_eq!(b.doc(1).as_deref(), Some("written before B joined"));
    assert_eq!(b.r.policy.devices[&B].delivered_by, Some(ESCROW));
    assert_eq!(b.r.stats.voided, 0);
    settle(&mut [&mut a, &mut b]);
    assert_eq!(b.r.head(), a.r.head());
}

/// The normal join-ahead order: genesis, initial rekey, B's
/// enrolment, then A's sealed entry, then the escrow's asynchronous grant to B.
#[test]
fn cloud_copy_enrolment_then_entry_then_escrow_grant() {
    let svc = FakeLogService::new();
    let mut cp = TestControlPlane::signed(COL);
    cp.genesis_with_keys(&svc, CState::CloudCopy, A, &A_KEYS.0, &A_KEYS.1);
    cp.append(
        &svc,
        vec![enrol(
            ESCROW,
            crate::policy::SERVICE_ACCOUNT,
            DeviceKind::Escrow,
            ESCROW_KEYS,
        )],
    );
    let mut a = open(&svc, 1, A_KEYS);
    settle(&mut [&mut a]);
    assert_eq!(a.r.policy.epoch, 1);
    let enrolled = enrol_b(&svc, &mut cp);
    settle(&mut [&mut a]);
    a.create(1, "secret.md", "written after B's enrolment");
    settle(&mut [&mut a]);
    let entry = a.r.head().seq;
    assert_eq!(entry, enrolled + 1, "the entry lands before any grant");
    let mut escrow = open(&svc, 3, ESCROW_KEYS);
    settle(&mut [&mut escrow]);
    let grant = escrow.r.head().seq;
    assert_eq!(grant, entry + 1, "the escrow's grant follows the entry");
    // B, applied through its enrolment, must read ahead past the entry.
    let mut b = open(&svc, 2, B_KEYS);
    settle(&mut [&mut b]);
    assert_eq!(b.doc(1).as_deref(), Some("written after B's enrolment"));
    assert_eq!(b.r.head().seq, grant);
    assert_eq!(b.r.policy.devices[&B].delivered_by, Some(ESCROW));
    assert!(b.r.stalled.is_none());
    assert_eq!(b.r.stats.voided, 0);
}

#[test]
fn a_grant_void_at_its_position_leaves_a_typed_wait_and_no_key() {
    let (svc, mut cp, mut a) = world(CState::E2e);
    let entry = a.r.head().seq;
    enrol_b(&svc, &mut cp);
    cp.revoke(&svc, B);
    settle(&mut [&mut a]);
    // A grant to B after its revocation: void in order (recipient not active).
    let grant = member_grant(&mut a, B, B_KEYS.1);
    let mut b = open(&svc, 2, B_KEYS);
    settle(&mut [&mut b]);
    probe(&mut b);
    assert_eq!(waiting_at(&b), Some(entry));
    assert_eq!(
        b.r.key_wait_reason(),
        Some(KeyWaitReason::GrantVoid { seq: grant })
    );
    assert_eq!(incident_reason(&b).as_deref(), Some("grant_void"));
    assert!(b.r.testing_epoch_keys().is_empty(), "nothing installed");
    assert_eq!(b.doc(1), None);
    assert_eq!(b.r.head().seq, entry - 1, "nothing applied out of order");
}

#[test]
fn a_grant_signed_by_a_revoked_device_is_void_ahead() {
    let (svc, mut cp, a) = world(CState::E2e);
    let entry = a.r.head().seq;
    enrol_b(&svc, &mut cp);
    // A's grant is appended, but A was revoked just before it.
    let payload =
        a.r.sealer
            .build_key_grant(
                1,
                &Recipient {
                    device: B,
                    kem_pk: KemKeyPair::from_secret(&B_KEYS.1).pk,
                },
                &mut crate::crypto::TestEntropy::new(3),
            )
            .unwrap();
    cp.revoke(&svc, A);
    let grant = append_signed(
        &svc,
        A,
        A_KEYS,
        ItemKind::KeyGrant,
        payload.to_bytes().unwrap(),
    );
    let mut b = open(&svc, 2, B_KEYS);
    settle(&mut [&mut b]);
    assert_eq!(waiting_at(&b), Some(entry));
    assert!(matches!(
        b.r.key_wait_reason(),
        Some(KeyWaitReason::GrantVoid { seq }) if seq == grant
    ));
    assert!(b.r.testing_epoch_keys().is_empty());
}

#[test]
fn an_ungranted_device_waits_with_bounded_reads() {
    let (svc, mut cp, _a) = world(CState::E2e);
    let entry = svc.head(&COL).0;
    enrol_b(&svc, &mut cp);
    let mut b = open(&svc, 2, B_KEYS);
    settle(&mut [&mut b]);
    assert_eq!(waiting_at(&b), Some(entry));
    assert!(matches!(
        b.r.key_wait_reason(),
        Some(KeyWaitReason::NoGrant { .. })
    ));
    // No reads at all until the probe's deadline, however often it is driven.
    for _ in 0..100 {
        b.r.pump();
        b.r.tick();
    }
    assert!(b.r.calls.is_empty(), "no unbounded reads while waiting");
    let deadline = b.r.next_wakeup().expect("a bounded probe is scheduled");
    b.clock.set(u64::try_from(deadline).unwrap());
    b.r.tick();
    let calls = std::mem::take(&mut b.r.calls);
    assert_eq!(calls.len(), 1, "one ordinary probe read");
    let crate::log::LogRequest::Read(read) = &calls[0].request else {
        panic!("a read");
    };
    assert_eq!(read.kinds, None);
    // Nothing new in the log: the probe re-stalls but reads no control items again.
    let reply = crate::log::LogClient::call(&mut b.log, calls[0].request.clone());
    crate::log::LogPort::on_log_reply(&mut b.r, calls[0].id, reply);
    assert!(
        !b.r.calls.iter().any(|c| matches!(
            &c.request,
            crate::log::LogRequest::Read(r) if r.kinds == Some(ReadKinds::Control)
        )),
        "the read-ahead extends only when the head grew"
    );
    assert_eq!(waiting_at(&b), Some(entry));
}

#[test]
fn a_grant_of_a_later_epoch_opens_older_keys_through_the_rekey_history() {
    let (svc, mut cp, mut a) = world(CState::E2e);
    let entry = a.r.head().seq;
    // Another device is enrolled and revoked: A rekeys to epoch 2.
    cp.append(
        &svc,
        vec![enrol(C, TEST_OWNER, DeviceKind::Desktop, C_KEYS)],
    );
    cp.revoke(&svc, C);
    settle(&mut [&mut a]);
    assert_eq!(a.r.policy.epoch, 2);
    a.create(2, "later.md", "epoch two content");
    settle(&mut [&mut a]);
    enrol_b(&svc, &mut cp);
    member_grant(&mut a, B, B_KEYS.1);
    let mut b = open(&svc, 2, B_KEYS);
    settle(&mut [&mut b]);
    assert_eq!(
        b.doc(1).as_deref(),
        Some("written before B joined"),
        "epoch 1 from the history box, checked against the applied commitment"
    );
    assert_eq!(b.doc(2).as_deref(), Some("epoch two content"));
    assert!(b.r.stalled.is_none());
    assert_eq!(b.r.head(), a.r.head());
    assert_eq!(b.r.stats.voided, 0);
    assert!(entry < b.r.head().seq);
}

#[test]
fn the_sealer_installs_only_keys_with_an_applied_commitment() {
    use crate::seal::{KeyEvent, Sealer};
    use mdbn_wire::envelope::RekeyReason;
    let mut e = crate::crypto::TestEntropy::new(29);
    let recipient = |dev: B16, kem: [u8; 32]| Recipient {
        device: dev,
        kem_pk: KemKeyPair::from_secret(&kem).pk,
    };
    let mut a = KeyringSealer::new(COL, A, &A_KEYS.0, &A_KEYS.1);
    let rk1 = a
        .build_rekey(0, &[recipient(A, A_KEYS.1)], RekeyReason::Initial, &mut e)
        .unwrap();
    assert!(matches!(a.accept_rekey(&rk1), KeyEvent::Keyed { epoch: 1 }));
    let rk2 = a
        .build_rekey(
            1,
            &[recipient(A, A_KEYS.1)],
            RekeyReason::DeviceRevoked,
            &mut e,
        )
        .unwrap();
    assert!(matches!(a.accept_rekey(&rk2), KeyEvent::Keyed { epoch: 2 }));
    let grant = a
        .build_key_grant(2, &recipient(B, B_KEYS.1), &mut e)
        .unwrap();
    // B applied rk1 in order (its commitment only: not a recipient).
    let mut b = KeyringSealer::new(COL, B, &B_KEYS.0, &B_KEYS.1);
    assert_eq!(b.accept_rekey(&rk1), KeyEvent::None);
    assert_eq!(
        b.accept_key_grant_ahead(&grant, &rk2, 1),
        KeyEvent::Keyed { epoch: 1 }
    );
    let held: Vec<u64> = b.testing_epoch_keys().iter().map(|(e, _)| *e).collect();
    assert_eq!(
        held,
        vec![1],
        "the read-ahead epoch's own key is never installed"
    );
    // No applied commitment for the wanted epoch: nothing.
    let mut fresh = KeyringSealer::new(COL, B, &B_KEYS.0, &B_KEYS.1);
    assert_eq!(
        fresh.accept_key_grant_ahead(&grant, &rk2, 1),
        KeyEvent::None
    );
    assert!(fresh.testing_epoch_keys().is_empty());
    // A history key that fails its applied commitment: nothing installed.
    let mut forged = KeyringSealer::new(COL, B, &B_KEYS.0, &B_KEYS.1);
    let mut other = rk1.clone();
    other.commit = B32([7; 32]);
    forged.accept_rekey(&other);
    assert_eq!(
        forged.accept_key_grant_ahead(&grant, &rk2, 1),
        KeyEvent::Inconsistent
    );
    assert!(forged.testing_epoch_keys().is_empty());
    // A grant epoch key that fails the rekey's commitment: nothing.
    let mut bad = rk2.clone();
    bad.commit = B32([9; 32]);
    let mut c = KeyringSealer::new(COL, B, &B_KEYS.0, &B_KEYS.1);
    c.accept_rekey(&rk1);
    assert_eq!(
        c.accept_key_grant_ahead(&grant, &bad, 1),
        KeyEvent::Inconsistent
    );
    assert!(c.testing_epoch_keys().is_empty());
}
