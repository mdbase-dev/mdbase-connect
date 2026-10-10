//! Consumer signatures use ONLY verified policy enrolment and retained history.
use super::handover::{hello_params, ready};
use crate::api::{ClientApi, ErrorCode, SessionAuth, SessionId};
use crate::crypto::sign::DeviceSigner;
use crate::store::{Store, Tx};
use mdbn_wire::cbor::{self, Cbor};
use mdbn_wire::common::{B16, B32};
use mdbn_wire::policy::{MemberSet, PolicyOp, Role};
use mdbn_wire::schema::Wire;
fn sign(mut value: Cbor, seed: &[u8; 32]) -> Vec<u8> {
    let Cbor::Map(fields) = &mut value else {
        panic!()
    };
    fields.retain(|(key, _)| *key != Cbor::Uint(7));
    let digest = mdbn_wire::hash::h("mdbase/v1/head-witness", &cbor::encode(&value).unwrap());
    let Cbor::Map(fields) = &mut value else {
        panic!()
    };
    fields.push((
        Cbor::Uint(7),
        Cbor::Bytes(
            DeviceSigner::from_seed(seed)
                .sign_digest(&digest.0)
                .to_vec(),
        ),
    ));
    fields.sort_by_key(|(key, _)| {
        if let Cbor::Uint(n) = key {
            *n
        } else {
            u64::MAX
        }
    });
    cbor::encode(&value).unwrap()
}
#[test]
fn consumer_verifies_captured_prefix_when_ahead_without_current_generation_equality() {
    let (svc, mut cp, mut n) = ready();
    let head = n.r.sync_status().confirmed_head.unwrap();
    let source = n.r.cfg.device_id;
    let witness = n.r.signed_handover_head(&head).unwrap();
    assert_eq!(
        n.r.verify_handover_witness(n.s, source, &witness).unwrap(),
        Some(head.clone())
    );
    cp.append(
        &svc,
        vec![PolicyOp::MemberSet(MemberSet {
            account: crate::testkit::TEST_OWNER,
            role: Role::Editor,
        })],
    );
    n.r.tick();
    n.pump();
    assert_ne!(
        n.r.sync_status().confirmed_head.unwrap().policy_generation,
        head.policy_generation
    );
    assert_eq!(
        n.r.verify_handover_witness(n.s, source, &witness).unwrap(),
        Some(head.clone())
    );
    n.r.store
        .commit(Tx {
            tail_drop_below: Some(n.r.head.seq),
            ..Tx::default()
        })
        .unwrap();
    assert!(
        n.r.verify_handover_witness(n.s, source, &witness)
            .unwrap()
            .is_none()
    );
}
#[test]
fn exact_signed_extensions_are_verified_not_dropped_or_reencoded_through_schema() {
    let (_, _, n) = ready();
    let head = n.r.sync_status().confirmed_head.unwrap();
    let source = n.r.cfg.device_id;
    let raw = n.r.signed_handover_head(&head).unwrap();
    let mut value = cbor::decode(&raw).unwrap();
    let Cbor::Map(fields) = &mut value else {
        panic!()
    };
    fields.push((
        Cbor::Uint(17),
        Cbor::Array(vec![
            Cbor::Text("signed extension".into()),
            Cbor::Bytes(vec![9; 32]),
        ]),
    ));
    let exact = sign(value.clone(), &[1; 32]);
    assert_eq!(
        n.r.verify_handover_witness(n.s, source, &exact).unwrap(),
        Some(head)
    );
    let Cbor::Map(fields) = &mut value else {
        panic!()
    };
    fields.push((Cbor::Uint(18), Cbor::Uint(1)));
    let mut altered = cbor::decode(&exact).unwrap();
    let Cbor::Map(fields) = &mut altered else {
        panic!()
    };
    fields.retain(|(key, _)| *key != Cbor::Uint(17));
    assert!(
        n.r.verify_handover_witness(n.s, source, &cbor::encode(&altered).unwrap())
            .unwrap()
            .is_none()
    );
    // Mathematically valid signature under an untrusted/self-claimed key is NOT authority.
    assert!(
        n.r.verify_handover_witness(n.s, source, &sign(value, &[77; 32]))
            .unwrap()
            .is_none()
    );
}
#[test]
fn signature_scope_shape_zero_missing_legacy_and_revocation_refuse() {
    let (_, _, mut n) = ready();
    let head = n.r.sync_status().confirmed_head.unwrap();
    let source = n.r.cfg.device_id;
    let bytes = n.r.signed_handover_head(&head).unwrap();
    assert!(
        n.r.verify_handover_witness(n.s, B16([99; 16]), &bytes)
            .unwrap()
            .is_none()
    );
    for key in [1, 2, 3, 4, 8, 9] {
        let mut value = cbor::decode(&bytes).unwrap();
        let Cbor::Map(fields) = &mut value else {
            panic!()
        };
        let field = fields
            .iter_mut()
            .find(|(k, _)| *k == Cbor::Uint(key))
            .unwrap();
        field.1 = match key {
            1 => B16([44; 16]).to_cbor(),
            2 => B16([99; 16]).to_cbor(),
            3 => Cbor::Uint(0),
            _ => B32([0; 32]).to_cbor(),
        };
        assert!(
            n.r.verify_handover_witness(n.s, source, &sign(value, &[1; 32]))
                .unwrap()
                .is_none(),
            "key{key}"
        );
    }
    let mut legacy = cbor::decode(&bytes).unwrap();
    let Cbor::Map(fields) = &mut legacy else {
        panic!()
    };
    fields.retain(|(k, _)| !matches!(k, Cbor::Uint(8 | 9)));
    assert!(
        n.r.verify_handover_witness(n.s, source, &sign(legacy, &[1; 32]))
            .unwrap()
            .is_none()
    );
    for end in 0..bytes.len() {
        assert!(
            n.r.verify_handover_witness(n.s, source, &bytes[..end])
                .unwrap()
                .is_none()
        );
    }
    let mut trailing = bytes.clone();
    trailing.push(0);
    assert!(
        n.r.verify_handover_witness(n.s, source, &trailing)
            .unwrap()
            .is_none()
    );
    assert!(
        n.r.verify_handover_witness(n.s, source, &vec![0; 65_537])
            .unwrap()
            .is_none()
    );
    n.r.policy.devices.get_mut(&source).unwrap().active = false;
    assert!(
        n.r.verify_handover_witness(n.s, source, &bytes)
            .unwrap()
            .is_none()
    );
}
#[test]
fn every_serving_verification_rebuild_repair_revocation_gate_refuses_consumer() {
    use mdbn_wire::client::{Incident, IncidentKind, SyncMode};
    for case in 0..16 {
        let (_, _, mut n) = ready();
        let source = n.r.cfg.device_id;
        let head = n.r.sync_status().confirmed_head.unwrap();
        let bytes = n.r.signed_handover_head(&head).unwrap();
        match case {
            0 => n.r.key_untrusted = true,
            1 => n.r.apply_blocked = Some(n.r.head.seq + 1),
            2 => n.r.genesis = None,
            3 => n.r.secrets.sign_sk = [77; 32],
            4 => n.r.policy.devices.get_mut(&source).unwrap().active = false,
            5 => n.r.cfg.chosen_state = Some(mdbn_wire::policy::CState::E2e),
            6 => {
                n.r.incidents.insert(
                    IncidentKind::Integrity as u64,
                    Incident {
                        kind: IncidentKind::Integrity,
                        details: None,
                    },
                );
            }
            7 => n.r.stalled = Some((IncidentKind::WaitingForKey, n.r.head.seq + 1)),
            8 => n.r.cfg.verify = false,
            9 => n.r.device_keys_failed = true,
            10 => {
                n.r.store = crate::mem::MemStore::shared(n.r.store.data()).with_keyring_rebuild();
                assert!(n.r.start_device_key_rebuild());
                assert!(n.r.keyring_rebuilding());
            }
            11 => n.r.apply_fault = true,
            12 => n.r.cfg.mode = SyncMode::LocalOnly,
            13 => n.r.policy.seq += 1,
            14 => n.r.install = Some(crate::replica::TestInstall::Control),
            15 => n.r.head.seq = 0,
            _ => unreachable!(),
        }
        assert!(
            n.r.verify_handover_witness(n.s, source, &bytes)
                .ok()
                .flatten()
                .is_none(),
            "gate{case}"
        );
    }
}

#[test]
fn handover_production_fixture_for_app_smoke() {
    use super::engine::{COL, node_with, settle};
    use crate::crypto::hpke::KemKeyPair;
    use crate::fake::FakeLogService;
    use crate::seal::KeyringSealer;
    use crate::testkit::TestControlPlane;
    use mdbn_wire::common::{B16, Bytes};
    use mdbn_wire::policy::{CState, DeviceEnrol, DeviceKind};
    let svc = FakeLogService::new();
    let mut cp = TestControlPlane::signed(COL);
    cp.genesis_with_keys(&svc, CState::CloudCopy, B16([101; 16]), &[1; 32], &[1; 32]);
    cp.append(
        &svc,
        vec![PolicyOp::DeviceEnrol(DeviceEnrol {
            device: B16([103; 16]),
            account: crate::policy::SERVICE_ACCOUNT,
            kind: DeviceKind::Escrow,
            sign_pk: B32(DeviceSigner::from_seed(&[3; 32]).public()),
            kem_pk: B32(KemKeyPair::from_secret(&[3; 32]).pk),
            noise_pk: B32([9; 32]),
            sas_commit: None,
            local_root: None,
        })],
    );
    let mut n = node_with(
        &svc,
        1,
        crate::mem::MemStore::new().with_keyring_rebuild(),
        vec![],
        Some(Box::new(KeyringSealer::new(
            COL,
            B16([101; 16]),
            &[1; 32],
            &[1; 32],
        ))),
    );
    n.r.cfg.chosen_state = Some(CState::CloudCopy);
    n.r.cfg.user_enabled_cloud_copy = true;
    settle(&mut [&mut n]);
    assert!(
        n.r.policy.epoch > 0,
        "production initial rekey and key rebuild complete"
    );
    let head =
        n.r.sync_status()
            .confirmed_head
            .expect("actual production verified policy/keys");
    let bytes = n.r.signed_handover_head(&head).unwrap();
    assert_eq!(
        n.r.verify_handover_witness(n.s, B16([101; 16]), &bytes)
            .unwrap(),
        Some(head.clone())
    );
    let items = svc.items(&COL);
    let fixture = Cbor::Map(vec![
        (Cbor::Uint(0), COL.to_cbor()),
        (Cbor::Uint(1), B16([101; 16]).to_cbor()),
        (Cbor::Uint(2), B32(crate::testkit::signed_root()).to_cbor()),
        (
            Cbor::Uint(3),
            mdbn_wire::hash::chain_hash(&items[0]).to_cbor(),
        ),
        (
            Cbor::Uint(4),
            Cbor::Array(
                items
                    .into_iter()
                    .enumerate()
                    .map(|(i, raw)| {
                        mdbn_wire::log_service::SeqItem {
                            seq: i as u64 + 1,
                            item: Bytes(raw),
                        }
                        .to_cbor()
                    })
                    .collect(),
            ),
        ),
        (Cbor::Uint(5), head.to_cbor()),
        (Cbor::Uint(6), Cbor::Bytes(bytes)),
    ]);
    // Public structured fixture data only; portable Replica tests never perform
    // filesystem I/O. The smoke harness can capture this --nocapture line.
    let encoded = cbor::encode(&fixture).unwrap();
    println!(
        "APP_HANDOVER_FIXTURE_HEX={}",
        encoded
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>()
    );
}

#[test]
fn consumer_requires_current_read_authority_and_serving_integrity() {
    let (svc, mut cp, mut n) = ready();
    let head = n.r.sync_status().confirmed_head.unwrap();
    let source = n.r.cfg.device_id;
    let bytes = n.r.signed_handover_head(&head).unwrap();
    assert_eq!(
        n.r.verify_handover_witness(SessionId(999), source, &bytes)
            .unwrap_err()
            .code(),
        Some(ErrorCode::Unauthenticated)
    );
    let grant = B16([33; 16]);
    cp.approved_grant(&svc, grant, [33; 32], &["records.create"], None, source);
    n.r.tick();
    n.pump();
    let (session, _) =
        n.r.hello(
            SessionAuth::Grant {
                grant,
                client_pk: [33; 32],
            },
            hello_params(),
        )
        .unwrap();
    assert_eq!(
        n.r.verify_handover_witness(session, source, &bytes)
            .unwrap_err()
            .code(),
        Some(ErrorCode::Forbidden)
    );
    n.r.close(session);
    assert_eq!(
        n.r.verify_handover_witness(session, source, &bytes)
            .unwrap_err()
            .code(),
        Some(ErrorCode::Unauthenticated)
    );
    n.r.key_untrusted = true;
    assert!(
        n.r.verify_handover_witness(n.s, source, &bytes)
            .unwrap()
            .is_none()
    );
    n.r.key_untrusted = false;
    n.r.install = Some(crate::replica::TestInstall::Control);
    assert!(
        n.r.verify_handover_witness(n.s, source, &bytes)
            .unwrap()
            .is_none()
    );
}
