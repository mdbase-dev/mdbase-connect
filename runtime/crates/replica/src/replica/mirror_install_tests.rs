#[path = "mirror_install_retained_tests.rs"]
mod retained;

use super::*;
use crate::crypto::sign::{DeviceSigner, Ed25519Verifier};
use mdbn_wire::{
    cbor::{self, Cbor},
    common::{B16, B64, Bytes, Version},
    envelope::ItemKind,
    schema::Wire,
    snapshot::Horizon,
};

const SEED: [u8; 32] = [9; 32];
const DEV: B16 = B16([2; 16]);
fn manifest() -> ManifestPayload {
    mdbn_wire::snapshot::ManifestPayload {
        seq: 0,
        chain: B32([0; 32]),
        state_digest: B32([5; 32]),
        bucket_bits: 0,
        sections: vec![],
        horizon: Horizon {
            seq_floor: 0,
            time_floor: 0,
        },
        sem: Version { major: 1, minor: 0 },
        record_count: 0,
        file_count: 0,
        previous: None,
        control_chain: B32([0; 32]),
    }
    .into()
}
fn fixture(size: usize, unknown: bool, received_signature: bool) -> (Vec<u8>, Item, PolicyState) {
    let signer = DeviceSigner::from_seed(&SEED);
    let mut item = Item {
        kind: ItemKind::Manifest,
        collection: B16([1; 16]),
        seq: None,
        prev: None,
        epoch: Some(3),
        signer: Some(DEV),
        salt: Some(B16([3; 16])),
        idem: None,
        refs: None,
        stream: None,
        body: Bytes(vec![4; size]),
        sig: None,
    };
    let Cbor::Map(mut fields) = item.to_cbor() else {
        panic!("map")
    };
    if unknown {
        fields.push((Cbor::Uint(13), Cbor::Text("future".into())));
    }
    let unsigned = cbor::encode(&Cbor::Map(fields.clone())).unwrap();
    let digest = if received_signature {
        crate::crypto::raw::signed_digest_from_bytes(&unsigned).unwrap()
    } else {
        item.signed_digest().unwrap().0
    };
    item.sig = Some(B64(signer.sign_digest(&digest)));
    fields.push((Cbor::Uint(12), Cbor::Bytes(item.sig.unwrap().0.to_vec())));
    fields.sort_by_key(|(key, _)| {
        let Cbor::Uint(key) = key else { panic!("key") };
        *key
    });
    let raw = cbor::encode(&Cbor::Map(fields)).unwrap();
    let item = Item::from_bytes(&raw).unwrap();
    let mut policy = PolicyState::new();
    policy.devices.insert(
        DEV,
        crate::policy::DeviceState {
            account: B16([7; 16]),
            kind: mdbn_wire::policy::DeviceKind::Desktop,
            sign_pk: B32(signer.public()),
            kem_pk: B32([9; 32]),
            noise_pk: B32([10; 32]),
            active: true,
            keyed: true,
            introduced_by: None,
            delivered_by: None,
            local_root: None,
            sas_commit: None,
        },
    );
    (raw, item, policy)
}

// Exact original check/order/messages, with the old allocating digest. Kept as
// an independent test oracle; never substitutes for native custody or a caller.
fn original(
    raw: &[u8],
    item: &Item,
    m: &ManifestPayload,
    policy: &PolicyState,
) -> Result<(), &'static str> {
    if m.seq != 0 || m.chain != B32([0; 32]) || m.control_chain != B32([0; 32]) {
        return Err("base manifest is not a generation 0");
    }
    if m.state_digest != B32([5; 32]) {
        return Err("base manifest state digest differs from the base");
    }
    if item.epoch != Some(3) {
        return Err("base manifest is sealed under another epoch than the base");
    }
    let signer = item.signer.ok_or("manifest has no signer")?;
    let d = policy
        .devices
        .get(&signer)
        .filter(|d| d.active && d.keyed)
        .ok_or("base manifest signer is not an active, keyed device")?;
    let digest =
        crate::crypto::raw::signed_digest_from_bytes(raw).map_err(|_| "manifest digest")?;
    let sig = item.sig.ok_or("manifest is not signed")?;
    if !Ed25519Verifier.verify(&d.sign_pk.0, &digest, &sig.0) {
        return Err("manifest signature does not verify");
    }
    Ok(())
}
fn checked(
    raw: &[u8],
    item: &Item,
    m: &ManifestPayload,
    policy: &PolicyState,
) -> Result<(), &'static str> {
    check_gen0_manifest(raw, item, m, 3, B32([5; 32]), policy, &Ed25519Verifier)
        .map(|_| ())
        .map_err(Error::message)
}

#[test]
fn genuine_received_signature_and_unknown_fields_match_original_not_typed_digest() {
    for unknown in [false, true] {
        for received in [false, true] {
            let (raw, item, policy) = fixture(70, unknown, received);
            let m = manifest();
            let result = checked(&raw, &item, &m, &policy);
            assert_eq!(result, original(&raw, &item, &m, &policy));
            assert_eq!(result.is_ok(), !unknown || received);
        }
    }
}

#[test]
fn all_original_gen0_refusals_and_precedence_are_preserved() {
    let (raw, item, policy) = fixture(70, true, true);
    let m = manifest();
    for change in 0..12 {
        let mut bad_m = m.clone();
        let mut bad_item = item.clone();
        let mut bad_policy = policy.clone();
        let expected = match change {
            0 => {
                bad_m.seq = 1;
                Error::NotGen0
            }
            1 => {
                bad_m.chain = B32([1; 32]);
                Error::NotGen0
            }
            2 => {
                bad_m.control_chain = B32([1; 32]);
                Error::NotGen0
            }
            3 => {
                bad_m.state_digest = B32([4; 32]);
                Error::StateDigest
            }
            4 => {
                bad_item.epoch = Some(4);
                Error::Epoch
            }
            5 => {
                bad_item.epoch = None;
                Error::Epoch
            }
            6 => {
                bad_item.signer = None;
                Error::MissingSigner
            }
            7 => {
                bad_item.signer = Some(B16([99; 16]));
                Error::InactiveSigner
            }
            8 => {
                bad_policy.devices.get_mut(&DEV).unwrap().active = false;
                Error::InactiveSigner
            }
            9 => {
                bad_policy.devices.get_mut(&DEV).unwrap().keyed = false;
                Error::InactiveSigner
            }
            10 => {
                bad_item.sig = None;
                Error::MissingSignature
            }
            _ => {
                bad_item.sig = Some(B64([0; 64]));
                Error::BadSignature
            }
        };
        assert_eq!(
            checked(&raw, &bad_item, &bad_m, &bad_policy),
            Err(expected.message())
        );
        assert_eq!(
            checked(&raw, &bad_item, &bad_m, &bad_policy),
            original(&raw, &bad_item, &bad_m, &bad_policy)
        );
        // Earlier manifest/epoch/signer errors must win even over raw decode.
        if change < 10 {
            assert_eq!(
                checked(&[], &bad_item, &bad_m, &bad_policy),
                Err(expected.message())
            );
        }
    }
    assert_eq!(
        checked(&[], &item, &m, &policy),
        Err(Error::RawDigest.message())
    );
    let mut missing = item.clone();
    missing.sig = None;
    assert_eq!(
        checked(&[], &missing, &m, &policy),
        Err(Error::RawDigest.message())
    );
    let mut wrong_key = policy;
    wrong_key.devices.get_mut(&DEV).unwrap().sign_pk = B32([0; 32]);
    assert_eq!(
        checked(&raw, &item, &m, &wrong_key),
        Err(Error::BadSignature.message())
    );
}

#[cfg(not(target_arch = "wasm32"))]
#[test]
fn large_received_body_check_allocates_zero_with_real_ed25519() {
    let (raw, item, policy) = fixture(4 * 1024 * 1024, true, true);
    let m = manifest();
    assert_eq!(original(&raw, &item, &m, &policy), Ok(()));
    let mut outcome = None;
    let measured = allocation_counter::measure(|| {
        outcome = Some(checked(&raw, &item, &m, &policy));
    });
    assert_eq!(outcome, Some(Ok(())));
    assert_eq!(measured.count_total, 0);
    assert_eq!(measured.bytes_max, 0);
}
