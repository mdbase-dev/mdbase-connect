use super::device::DeviceIdentity;
use mdbn_core::host::Entropy;
use mdbn_replica::crypto::{
    CsprngEntropy,
    sign::{DeviceSigner, verify_digest},
};
use mdbn_wire::{
    cbor::{self, Cbor},
    common::B16,
    schema::Wire,
};
struct Rng(u8);
impl Entropy for Rng {
    fn fill(&mut self, bytes: &mut [u8]) {
        bytes.fill(self.0);
        self.0 += 1;
    }
}
impl CsprngEntropy for Rng {}
fn encode(value: Cbor) -> Vec<u8> {
    cbor::encode(&value).unwrap()
}
fn pin(purpose: u64) -> Vec<u8> {
    encode(Cbor::Map(vec![
        (Cbor::Uint(0), B16([0x22; 16]).to_cbor()),
        (Cbor::Uint(1), Cbor::Uint(purpose)),
    ]))
}
fn owner(register: bool) -> (DeviceIdentity, Cbor) {
    let mut input = encode(Cbor::Map(vec![
        (Cbor::Uint(0), Cbor::Uint(1)),
        (Cbor::Uint(1), B16([0x66; 16]).to_cbor()),
        (Cbor::Uint(2), B16([0x44; 16]).to_cbor()),
        (Cbor::Uint(3), B16([0x88; 16]).to_cbor()),
        (Cbor::Uint(4), Cbor::Uint(0)),
        (Cbor::Uint(5), Cbor::Bytes(vec![1; 32])),
        (Cbor::Uint(6), Cbor::Bytes(vec![2; 32])),
        (Cbor::Uint(7), Cbor::Bytes(vec![])),
    ]));
    let (mut owner, public) = DeviceIdentity::open_consuming(&mut input, &mut Rng(10)).unwrap();
    assert!(input.iter().all(|b| *b == 0));
    let Cbor::Map(fields) = cbor::decode(&public).unwrap() else {
        panic!()
    };
    if register {
        assert!(!owner.sign_cp_enrol_consuming(&mut [7; 32]).is_empty());
        let mut receipt = encode(Cbor::Map(vec![
            (Cbor::Uint(0), B16([0x66; 16]).to_cbor()),
            (Cbor::Uint(1), B16([0x44; 16]).to_cbor()),
            (Cbor::Uint(2), B16([0x88; 16]).to_cbor()),
            (Cbor::Uint(3), fields[0].1.clone()),
            (Cbor::Uint(4), fields[1].1.clone()),
            (Cbor::Uint(5), fields[2].1.clone()),
        ]));
        assert!(owner.acknowledge_registration_consuming(&mut receipt));
        assert!(receipt.iter().all(|b| *b == 0));
    }
    (owner, Cbor::Map(fields))
}
#[test]
fn fixed_create_signs_receiver_cbor_only_once_and_never_enrol_or_cp_domain() {
    let (mut owner, _) = owner(true);
    let mut input = pin(0);
    assert!(owner.pin_private_collection_consuming(&mut input, &mut Rng(50)));
    assert!(input.iter().all(|b| *b == 0));
    assert!(owner.private_enrol_commitment().is_empty());
    let mut nonce = [0x11; 32];
    let signature = owner.sign_private_create_consuming(&mut nonce);
    assert_eq!(signature.len(), 64);
    assert_eq!(nonce, [0; 32]);
    let transcript = encode(Cbor::Array(vec![
        Cbor::Bytes(vec![0x11; 32]),
        B16([0x66; 16]).to_cbor(),
        B16([0x44; 16]).to_cbor(),
        B16([0x22; 16]).to_cbor(),
    ]));
    let sig = signature.as_slice().try_into().unwrap();
    let pk = DeviceSigner::from_seed(&[1; 32]).public();
    assert!(verify_digest(
        &pk,
        &mdbn_wire::hash::h("mdbase/v1/private-create", &transcript).0,
        &sig
    ));
    for other in [
        "mdbase/v1/private-device-enrol",
        "mdbase/v1/cp-enrol",
        "mdbase/v1/private-approval-request",
    ] {
        assert!(!verify_digest(
            &pk,
            &mdbn_wire::hash::h(other, &transcript).0,
            &sig
        ));
    }
    assert!(
        owner
            .sign_private_create_consuming(&mut [0x12; 32])
            .is_empty()
    );
    assert!(owner.sign_cp_enrol_consuming(&mut [0x13; 32]).is_empty());
}
#[test]
fn native_sas_commitment_binds_collection_original_public_tuple_and_r_without_export() {
    let (mut owner, public) = owner(true);
    let mut input = pin(1);
    assert!(owner.pin_private_collection_consuming(&mut input, &mut Rng(50)));
    let commit = owner.private_enrol_commitment();
    assert_eq!(commit.len(), 32);
    let Cbor::Map(fields) = public else { panic!() };
    let mut tuple = vec![0x22; 16];
    tuple.extend_from_slice(&[0x44; 16]);
    for (_, pk) in fields.iter().take(3) {
        let Cbor::Bytes(pk) = pk else { panic!() };
        tuple.extend_from_slice(pk);
    }
    tuple.extend_from_slice(&[50; 32]);
    assert_eq!(commit, mdbn_wire::hash::h("mdbase/v1/sas-commit", &tuple).0);
    let signature = owner.sign_private_device_enrol_consuming(&mut [0x11; 32]);
    assert_eq!(signature.len(), 64);
    let transcript = encode(Cbor::Array(vec![
        Cbor::Bytes(vec![0x11; 32]),
        B16([0x66; 16]).to_cbor(),
        B16([0x44; 16]).to_cbor(),
        B16([0x22; 16]).to_cbor(),
        Cbor::Bytes(commit.clone()),
    ]));
    assert!(verify_digest(
        &DeviceSigner::from_seed(&[1; 32]).public(),
        &mdbn_wire::hash::h("mdbase/v1/private-device-enrol", &transcript).0,
        &signature.as_slice().try_into().unwrap()
    ));
    assert!(
        owner
            .sign_private_device_enrol_consuming(&mut [0x12; 32])
            .is_empty()
    );
    assert!(owner.private_enrol_commitment().is_empty());
}
#[test]
fn protected_public_commit_restore_reuses_exact_enrol_identity_without_r_or_entropy() {
    let (mut first, public) = owner(true);
    assert!(first.pin_private_collection_consuming(&mut pin(1), &mut Rng(50)));
    let commit = first.private_enrol_commitment();
    assert_eq!(
        first
            .sign_private_device_enrol_consuming(&mut [1; 32])
            .len(),
        64
    );
    first.retire();
    let Cbor::Map(fields) = public else { panic!() };
    let mut input = encode(Cbor::Map(vec![
        (Cbor::Uint(0), Cbor::Uint(1)),
        (Cbor::Uint(1), B16([0x66; 16]).to_cbor()),
        (Cbor::Uint(2), B16([0x44; 16]).to_cbor()),
        (Cbor::Uint(3), B16([0x88; 16]).to_cbor()),
        (Cbor::Uint(4), Cbor::Uint(1)),
        (Cbor::Uint(5), Cbor::Bytes(vec![1; 32])),
        (Cbor::Uint(6), Cbor::Bytes(vec![2; 32])),
        (Cbor::Uint(7), fields[3].1.clone()),
    ]));
    let mut entropy = Rng(100);
    let (mut restored, reopened) =
        DeviceIdentity::open_consuming(&mut input, &mut entropy).unwrap();
    assert_eq!(entropy.0, 100);
    assert_eq!(cbor::decode(&reopened).unwrap(), Cbor::Map(fields.clone()));
    let mut receipt = encode(Cbor::Map(vec![
        (Cbor::Uint(0), B16([0x66; 16]).to_cbor()),
        (Cbor::Uint(1), B16([0x44; 16]).to_cbor()),
        (Cbor::Uint(2), B16([0x88; 16]).to_cbor()),
        (Cbor::Uint(3), fields[0].1.clone()),
        (Cbor::Uint(4), fields[1].1.clone()),
        (Cbor::Uint(5), fields[2].1.clone()),
    ]));
    assert!(restored.acknowledge_registration_consuming(&mut receipt));
    let mut marker = encode(Cbor::Map(vec![
        (Cbor::Uint(0), Cbor::Uint(1)),
        (Cbor::Uint(1), B16([0x22; 16]).to_cbor()),
        (Cbor::Uint(2), B16([0x66; 16]).to_cbor()),
        (Cbor::Uint(3), B16([0x44; 16]).to_cbor()),
        (Cbor::Uint(4), B16([0x88; 16]).to_cbor()),
        (Cbor::Uint(5), fields[0].1.clone()),
        (Cbor::Uint(6), fields[1].1.clone()),
        (Cbor::Uint(7), fields[2].1.clone()),
        (Cbor::Uint(8), Cbor::Bytes(commit.clone())),
        (Cbor::Uint(9), Cbor::Bool(false)),
    ]));
    assert!(restored.restore_private_enrol_consuming(&mut marker));
    assert!(marker.iter().all(|v| *v == 0));
    assert_eq!(restored.private_enrol_commitment(), commit);
    let sig = restored.sign_private_device_enrol_consuming(&mut [2; 32]);
    assert_eq!(sig.len(), 64);
    let transcript = encode(Cbor::Array(vec![
        Cbor::Bytes(vec![2; 32]),
        B16([0x66; 16]).to_cbor(),
        B16([0x44; 16]).to_cbor(),
        B16([0x22; 16]).to_cbor(),
        Cbor::Bytes(commit),
    ]));
    assert!(verify_digest(
        &DeviceSigner::from_seed(&[1; 32]).public(),
        &mdbn_wire::hash::h("mdbase/v1/private-device-enrol", &transcript).0,
        &sig.as_slice().try_into().unwrap()
    ));
}
#[test]
fn restored_acknowledged_enrol_cannot_repeat_proof_or_create() {
    let mut scope =
        super::private_proof::PrivateProofScope::restore_enrol(B16([0x22; 16]), [11; 32], true);
    let signer = DeviceSigner::from_seed(&[1; 32]);
    assert_eq!(scope.enrol_commitment(), Some([11; 32]));
    assert!(
        scope
            .sign_enrol(&signer, B16([0x66; 16]), B16([0x44; 16]), &[1; 32])
            .is_none()
    );
    assert!(
        scope
            .sign_create(&signer, B16([0x66; 16]), B16([0x44; 16]), &[1; 32])
            .is_none()
    );
}
#[test]
fn malformed_or_foreign_protected_public_marker_retires_without_fresh_fallback() {
    for changed in 0..12 {
        let (mut owner, public) = owner(true);
        let Cbor::Map(public) = public else { panic!() };
        let mut fields = vec![
            (Cbor::Uint(0), Cbor::Uint(1)),
            (Cbor::Uint(1), B16([0x22; 16]).to_cbor()),
            (Cbor::Uint(2), B16([0x66; 16]).to_cbor()),
            (Cbor::Uint(3), B16([0x44; 16]).to_cbor()),
            (Cbor::Uint(4), B16([0x88; 16]).to_cbor()),
            (Cbor::Uint(5), public[0].1.clone()),
            (Cbor::Uint(6), public[1].1.clone()),
            (Cbor::Uint(7), public[2].1.clone()),
            (Cbor::Uint(8), Cbor::Bytes(vec![11; 32])),
            (Cbor::Uint(9), Cbor::Bool(false)),
        ];
        if changed < 10 {
            fields[changed].1 = match changed {
                0 => Cbor::Uint(2),
                1 => B16([0; 16]).to_cbor(),
                2..=4 => B16([0x99; 16]).to_cbor(),
                5..=8 => Cbor::Bytes(vec![0; 32]),
                _ => Cbor::Uint(1),
            };
        }
        if changed == 10 {
            fields.push((Cbor::Uint(10), Cbor::Uint(0)));
        }
        let mut bytes = encode(Cbor::Map(fields));
        if changed == 11 {
            bytes.push(0);
        }
        assert!(!owner.restore_private_enrol_consuming(&mut bytes));
        assert!(bytes.iter().all(|v| *v == 0));
        assert!(owner.private_enrol_commitment().is_empty());
        assert!(owner.sign_cp_enrol_consuming(&mut [1; 32]).is_empty());
        assert!(!owner.pin_private_collection_consuming(&mut pin(1), &mut Rng(50)));
    }
}
#[test]
fn registration_once_scope_strict_purpose_malformed_nonce_and_retirement_fail_closed() {
    let (mut unregistered, _) = owner(false);
    let mut p = pin(0);
    assert!(!unregistered.pin_private_collection_consuming(&mut p, &mut Rng(50)));
    assert!(p.iter().all(|b| *b == 0));
    for purpose in [2, 3, u64::MAX] {
        let (mut owner, _) = owner(true);
        let mut p = pin(purpose);
        assert!(!owner.pin_private_collection_consuming(&mut p, &mut Rng(50)));
        assert!(p.iter().all(|b| *b == 0));
    }
    let (mut owner, _) = owner(true);
    assert!(owner.pin_private_collection_consuming(&mut pin(1), &mut Rng(50)));
    assert!(!owner.pin_private_collection_consuming(&mut pin(0), &mut Rng(60)));
    assert!(owner.private_enrol_commitment().is_empty());
    for len in [0, 31, 33, 1024] {
        let (mut owner, _) = self::owner(true);
        assert!(owner.pin_private_collection_consuming(&mut pin(1), &mut Rng(50)));
        let mut challenge = vec![9; len];
        assert!(
            owner
                .sign_private_device_enrol_consuming(&mut challenge)
                .is_empty()
        );
        assert!(challenge.iter().all(|b| *b == 0));
        assert!(owner.private_enrol_commitment().is_empty());
    }
    let (mut owner, _) = self::owner(true);
    assert!(owner.pin_private_collection_consuming(&mut pin(1), &mut Rng(50)));
    owner.retire();
    assert!(owner.private_enrol_commitment().is_empty());
    assert!(
        owner
            .sign_private_device_enrol_consuming(&mut [9; 32])
            .is_empty()
    );
}

#[test]
fn cloud_copy_fixed_domains_original_tuple_once_and_cross_purpose_refusal() {
    for create in [true, false] {
        let (mut device, _) = owner(true);
        let mut target = pin(if create { 0 } else { 1 });
        assert!(device.pin_cloud_copy_consuming(&mut target));
        assert!(target.iter().all(|b| *b == 0));
        let mut challenge = [0x11; 32];
        let signature = if create {
            device.sign_cloud_copy_create_consuming(&mut challenge)
        } else {
            device.sign_cloud_copy_join_consuming(&mut challenge)
        };
        assert_eq!(challenge, [0; 32]);
        let signature = signature.as_slice().try_into().unwrap();
        let transcript = encode(Cbor::Array(vec![
            Cbor::Bytes(vec![0x11; 32]),
            B16([0x66; 16]).to_cbor(),
            B16([0x44; 16]).to_cbor(),
            B16([0x22; 16]).to_cbor(),
        ]));
        let pk = DeviceSigner::from_seed(&[1; 32]).public();
        for domain in [
            "mdbase/v1/cloud-copy-create",
            "mdbase/v1/cloud-copy-join",
            "mdbase/v1/private-create",
            "mdbase/v1/cp-enrol",
        ] {
            assert_eq!(
                verify_digest(&pk, &mdbn_wire::hash::h(domain, &transcript).0, &signature),
                domain
                    == if create {
                        "mdbase/v1/cloud-copy-create"
                    } else {
                        "mdbase/v1/cloud-copy-join"
                    }
            );
        }
        assert!(
            device
                .sign_cloud_copy_create_consuming(&mut [0x12; 32])
                .is_empty()
        );
        assert!(device.sign_cp_enrol_consuming(&mut [0x13; 32]).is_empty());
    }
}
#[test]
fn cloud_copy_requires_registration_valid_exact_pin_and_excludes_private_scopes() {
    let (mut unregistered, _) = owner(false);
    assert!(!unregistered.pin_cloud_copy_consuming(&mut pin(0)));
    for mut bad in [pin(2), vec![0], {
        let mut v = pin(0);
        v.push(0);
        v
    }] {
        let (mut device, _) = owner(true);
        assert!(!device.pin_cloud_copy_consuming(&mut bad));
        assert!(bad.iter().all(|b| *b == 0));
        assert!(device.sign_cp_enrol_consuming(&mut [0x11; 32]).is_empty());
    }
    let (mut device, _) = owner(true);
    assert!(device.pin_cloud_copy_consuming(&mut pin(0)));
    assert!(!device.pin_private_collection_consuming(&mut pin(0), &mut Rng(10)));
    let (mut device, _) = owner(true);
    assert!(device.pin_private_collection_consuming(&mut pin(0), &mut Rng(10)));
    assert!(!device.pin_cloud_copy_consuming(&mut pin(0)));
}
#[test]
fn cloud_copy_wrong_purpose_and_malformed_challenge_terminally_retire() {
    for create in [true, false] {
        let (mut device, _) = owner(true);
        assert!(device.pin_cloud_copy_consuming(&mut pin(if create { 0 } else { 1 })));
        let wrong = if create {
            device.sign_cloud_copy_join_consuming(&mut [0x11; 32])
        } else {
            device.sign_cloud_copy_create_consuming(&mut [0x11; 32])
        };
        assert!(wrong.is_empty());
        assert!(device.sign_cp_enrol_consuming(&mut [0x12; 32]).is_empty());
    }
    let (mut device, _) = owner(true);
    assert!(device.pin_cloud_copy_consuming(&mut pin(0)));
    let mut bad = [0x11; 31];
    assert!(device.sign_cloud_copy_create_consuming(&mut bad).is_empty());
    assert_eq!(bad, [0; 31]);
    assert!(device.sign_cp_enrol_consuming(&mut [0x12; 32]).is_empty());
}
