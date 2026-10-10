use super::*;
use mdbn_replica::crypto::sign::DeviceSigner;
use mdbn_replica::fake::FakeLogService;
use mdbn_replica::policy::key_id;
use mdbn_replica::testkit::{SIGNED_CP_SEED, TestControlPlane, signed_root};
use mdbn_wire::common::{B64, Bytes};
use mdbn_wire::policy::{CState, PolicyPayload};

const COL: B16 = B16([0x91; 16]);

fn fixture(state: CState) -> (Vec<u8>, Vec<u8>) {
    let svc = FakeLogService::new();
    TestControlPlane::signed(COL).genesis(&svc, state, &[]);
    let original = svc.items(&COL).remove(0);
    let item = Item::from_bytes(&original).unwrap();
    let p = PolicyPayload::from_bytes(&item.body.0).unwrap();
    let pins = cbor::encode(&Cbor::Array(vec![
        Cbor::Array(vec![Cbor::Array(vec![
            key_id(&signed_root()).to_cbor(),
            B32(signed_root()).to_cbor(),
        ])]),
        Cbor::Array(vec![Cbor::Array(vec![
            p.cert.key_id().to_cbor(),
            p.cert.policy_pk.to_cbor(),
            p.cert.root.to_cbor(),
        ])]),
    ]))
    .unwrap();
    (pins, original)
}

fn accept(pins: &[u8], raw: &[u8]) -> Result<VerifiedHostedGenesis> {
    verify_hosted_genesis(COL, pins, raw, sha256(raw))
}

fn mutate_item(raw: &[u8], f: impl FnOnce(&mut Item)) -> Vec<u8> {
    let mut item = Item::from_bytes(raw).unwrap();
    f(&mut item);
    // A trusted fixture CP can sign malformed/foreign origin; shape and native
    // policy still MUST refuse it. No signer bypass in the production helper.
    DeviceSigner::from_seed(&SIGNED_CP_SEED)
        .sign_item(&mut item)
        .unwrap();
    item.to_bytes().unwrap()
}

#[test]
fn signed_original_cloudcopy_passes_public_only_and_returns_exact_hash() {
    let (pins, raw) = fixture(CState::CloudCopy);
    let proof = accept(&pins, &raw).unwrap();
    assert_eq!(proof.collection(), COL);
    assert_eq!(proof.item_sha256(), sha256(&raw));
    assert_eq!(proof.genesis_chain_hash(), item_chain_hash(&raw));
    assert_ne!(proof.genesis_chain_hash(), proof.item_sha256());
    assert_eq!(proof.roots(), vec![signed_root()]);
    assert_eq!(proof.policy_pins().roots[0].root_pk, B32(signed_root()));
}

#[test]
fn signed_original_e2e_is_origin_only_not_current_mode_permission() {
    let (pins, raw) = fixture(CState::E2e);
    assert!(accept(&pins, &raw).is_ok());
    // The public witness deliberately has no mode/device/grant/serving verdict.
}

#[test]
fn wrong_collection_and_advertised_hash_refuse() {
    let (pins, raw) = fixture(CState::CloudCopy);
    assert!(verify_hosted_genesis(B16([0x92; 16]), &pins, &raw, sha256(&raw)).is_err());
    assert!(verify_hosted_genesis(COL, &pins, &raw, B32([0x93; 32])).is_err());
}

#[test]
fn matching_advertised_hash_does_not_authorize_missing_or_bad_signature() {
    let (pins, raw) = fixture(CState::CloudCopy);
    for sig in [None, Some(B64([0; 64])), Some(B64([0xff; 64]))] {
        let mut item = Item::from_bytes(&raw).unwrap();
        item.sig = sig;
        let raw = item.to_bytes().unwrap();
        assert!(accept(&pins, &raw).is_err());
    }
}

#[test]
fn later_position_prev_or_nonpolicy_cannot_be_original_even_when_cp_signed() {
    let (pins, raw) = fixture(CState::CloudCopy);
    for altered in [
        mutate_item(&raw, |i| i.seq = Some(2)),
        mutate_item(&raw, |i| i.seq = None),
        mutate_item(&raw, |i| i.prev = Some(B32([9; 32]))),
        mutate_item(&raw, |i| i.prev = None),
        mutate_item(&raw, |i| i.kind = ItemKind::Entry),
        mutate_item(&raw, |i| i.epoch = Some(1)),
        mutate_item(&raw, |i| i.salt = Some(B16([9; 16]))),
        mutate_item(&raw, |i| i.idem = Some(B16([9; 16]))),
        mutate_item(&raw, |i| i.refs = Some(vec![])),
    ] {
        assert!(accept(&pins, &altered).is_err());
    }
}

#[test]
fn cp_signed_seq1_without_genesis_or_malformed_body_refuses() {
    let (pins, raw) = fixture(CState::CloudCopy);
    let empty_ops = mutate_item(&raw, |i| {
        let mut p = PolicyPayload::from_bytes(&i.body.0).unwrap();
        p.ops.clear();
        i.body = Bytes(p.to_bytes().unwrap());
    });
    assert!(accept(&pins, &empty_ops).is_err());
    let malformed = mutate_item(&raw, |i| i.body = Bytes(vec![0xff]));
    assert!(accept(&pins, &malformed).is_err());
}

#[test]
fn certificate_signature_and_validity_refuse_before_any_secret_capability() {
    let (pins, raw) = fixture(CState::CloudCopy);
    for altered in [
        mutate_item(&raw, |i| {
            let mut p = PolicyPayload::from_bytes(&i.body.0).unwrap();
            p.cert.sig = B64([0; 64]);
            i.body = Bytes(p.to_bytes().unwrap());
        }),
        mutate_item(&raw, |i| {
            let mut p = PolicyPayload::from_bytes(&i.body.0).unwrap();
            p.issued_at = -1;
            i.body = Bytes(p.to_bytes().unwrap());
        }),
    ] {
        assert!(accept(&pins, &altered).is_err());
    }
}

#[test]
fn correct_cp_certificate_without_its_policy_pin_refuses() {
    let (pins, raw) = fixture(CState::CloudCopy);
    let Cbor::Array(mut a) = cbor::decode(&pins).unwrap() else {
        panic!()
    };
    let pk = DeviceSigner::from_seed(&[0x77; 32]).public();
    a[1] = Cbor::Array(vec![Cbor::Array(vec![
        key_id(&pk).to_cbor(),
        B32(pk).to_cbor(),
        key_id(&signed_root()).to_cbor(),
    ])]);
    assert!(accept(&cbor::encode(&Cbor::Array(a)).unwrap(), &raw).is_err());
}

#[test]
fn missing_oversized_malformed_and_duplicate_pins_refuse() {
    let (pins, raw) = fixture(CState::CloudCopy);
    for p in [vec![], vec![0xff], vec![0; MAX_PUBLIC_BYTES + 1]] {
        assert!(accept(&p, &raw).is_err());
    }
    let Cbor::Array(mut a) = cbor::decode(&pins).unwrap() else {
        panic!()
    };
    let Cbor::Array(mut roots) = a[0].clone() else {
        panic!()
    };
    roots.push(roots[0].clone());
    a[0] = Cbor::Array(roots);
    assert!(accept(&cbor::encode(&Cbor::Array(a)).unwrap(), &raw).is_err());
    assert!(accept(&pins, &[]).is_err());
    assert!(accept(&pins, &[0xff]).is_err());
    assert!(accept(&pins, &vec![0; MAX_PUBLIC_BYTES + 1]).is_err());
    let mut trailing = raw;
    trailing.push(0);
    assert!(accept(&pins, &trailing).is_err());
}

#[test]
fn public_request_is_bounded_exact_and_uses_the_same_native_verifier() {
    let (pins, raw) = fixture(CState::CloudCopy);
    let mut a = vec![
        COL.to_cbor(),
        Cbor::Bytes(pins),
        Cbor::Bytes(raw.clone()),
        sha256(&raw).to_cbor(),
    ];
    let bytes = cbor::encode(&Cbor::Array(a.clone())).unwrap();
    assert_eq!(
        verify_public_request(&bytes).unwrap().item_sha256(),
        sha256(&raw)
    );
    a.push(Cbor::Null);
    assert!(verify_public_request(&cbor::encode(&Cbor::Array(a)).unwrap()).is_err());
    assert!(verify_public_request(&vec![0; 2 * MAX_PUBLIC_BYTES + 129]).is_err());
}
