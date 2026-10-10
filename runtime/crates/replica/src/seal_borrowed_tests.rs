//! Genuine keyring/Ed25519 parity; no fake native authority or verifier adapter.
use super::*;
use crate::{
    crypto::{
        raw::{self, BorrowedEnvelope},
        sign::DeviceSigner,
    },
    policy::{DeviceState, Env, PolicyState},
};
use mdbn_wire::{
    cbor::{self, Cbor},
    common::{B16, B32, B64, Bytes},
    envelope::{Item, ItemKind},
    policy::{CState, DeviceKind, Role},
    schema::Wire,
    snapshot::BaseSource,
};
const COL: B16 = B16([7; 16]);
const DEV: B16 = B16([2; 16]);
const ACCOUNT: B16 = B16([8; 16]);
const KEY: [u8; 32] = [42; 32];
const SEED: [u8; 32] = [9; 32];
fn item(size: usize) -> Item {
    Item {
        kind: ItemKind::Base,
        collection: COL,
        seq: Some(1),
        prev: Some(B32([0; 32])),
        epoch: Some(1),
        signer: Some(DEV),
        salt: Some(B16([3; 16])),
        idem: None,
        refs: Some(vec![B32([5; 32])]),
        stream: None,
        body: Bytes(vec![7; size]),
        sig: None,
    }
}
fn signed(mut sample: Item, unknown: bool, received: bool) -> Vec<u8> {
    let signer = DeviceSigner::from_seed(&SEED);
    sample.sig = None;
    let Cbor::Map(mut fields) = sample.to_cbor() else {
        panic!("map")
    };
    if unknown {
        fields.push((Cbor::Uint(13), Cbor::Text("future".into())));
    }
    let unsigned = cbor::encode(&Cbor::Map(fields.clone())).unwrap();
    let digest = if received {
        raw::signed_digest_from_bytes(&unsigned).unwrap()
    } else {
        sample.signed_digest().unwrap().0
    };
    fields.push((
        Cbor::Uint(12),
        Cbor::Bytes(signer.sign_digest(&digest).to_vec()),
    ));
    fields.sort_by_key(|(key, _)| {
        let Cbor::Uint(key) = key else { panic!("key") };
        *key
    });
    cbor::encode(&Cbor::Map(fields)).unwrap()
}
fn view(raw: &[u8]) -> BorrowedEnvelope<'_> {
    let plan = raw::envelope_workspace_plan(raw).unwrap();
    let mut space = vec![0; plan.metadata_bytes()];
    raw::decode_envelope_borrowed(raw, &mut space, plan.decoder_peak_bytes()).unwrap()
}
fn policy() -> PolicyState {
    let mut p = PolicyState::new();
    p.epoch = 1;
    p.cstate = Some(CState::CloudCopy);
    p.members.insert(ACCOUNT, Role::Owner);
    p.devices.insert(
        DEV,
        DeviceState {
            account: ACCOUNT,
            kind: DeviceKind::Desktop,
            sign_pk: B32(DeviceSigner::from_seed(&SEED).public()),
            kem_pk: B32([11; 32]),
            noise_pk: B32([12; 32]),
            active: true,
            keyed: true,
            introduced_by: None,
            delivered_by: None,
            local_root: None,
            sas_commit: None,
        },
    );
    p
}
fn env() -> Env<'static> {
    Env {
        verifier: &Ed25519Verifier,
        trusted_roots: &[],
        policy_pins: None,
    }
}
fn policy_parity(p: &PolicyState, raw: &[u8]) {
    let owned = Item::from_bytes(raw).unwrap();
    let data = view(raw);
    let env = env();
    assert_eq!(
        p.check_device_signature(&owned, &env),
        p.check_device_signature_borrowed(&data, &env)
    );
    assert_eq!(
        p.check_base_header(&owned, &env),
        p.check_base_header_borrowed(&data, &env)
    );
    for source in [BaseSource::Folder, BaseSource::HostedImport] {
        assert_eq!(
            p.check_base_source(&owned, source),
            p.check_base_source_borrowed(&data, source)
        );
    }
    for manifest in [B32([5; 32]), B32([6; 32])] {
        assert_eq!(
            p.check_base_payload(&owned, &manifest),
            p.check_base_payload_borrowed(&data, &manifest)
        );
    }
}
#[test]
fn device_and_base_policy_equivalence_including_unknown_received_vs_typed_signatures_and_exact_errors()
 {
    for unknown in [false, true] {
        for received in [false, true] {
            let raw = signed(item(17), unknown, received);
            let p = policy();
            policy_parity(&p, &raw);
            for change in 0..13 {
                let mut bad = p.clone();
                match change {
                    0 => bad.devices.clear(),
                    1 => bad.devices.get_mut(&DEV).unwrap().active = false,
                    2 => bad.devices.get_mut(&DEV).unwrap().keyed = false,
                    3 => {
                        bad.members.insert(ACCOUNT, Role::Viewer);
                    }
                    4 => bad.content_seen = true,
                    5 => bad.frozen = true,
                    6 => bad.rekey_required = true,
                    7 => bad.epoch = 0,
                    8 => bad.epoch = 2,
                    9 => bad.devices.get_mut(&DEV).unwrap().kind = DeviceKind::Hosted,
                    10 => {
                        bad.devices.get_mut(&DEV).unwrap().kind = DeviceKind::Hosted;
                        bad.cstate = Some(CState::E2e);
                    }
                    11 => bad.devices.get_mut(&DEV).unwrap().kind = DeviceKind::Recovery,
                    _ => bad.devices.get_mut(&DEV).unwrap().sign_pk = B32([0; 32]),
                };
                policy_parity(&bad, &raw);
            }
            for change in 0..6 {
                let mut bad = item(17);
                match change {
                    0 => bad.kind = ItemKind::Entry,
                    1 => bad.signer = None,
                    2 => bad.signer = Some(B16([99; 16])),
                    3 => bad.epoch = None,
                    4 => bad.epoch = Some(2),
                    _ => bad.refs = None,
                };
                policy_parity(&p, &signed(bad, unknown, received));
            }
            let data = view(&raw);
            let at = data.body().as_ptr() as usize - raw.as_ptr() as usize;
            let mut changed = raw.clone();
            changed[at] ^= 1;
            policy_parity(&p, &changed);
            let mut missing = Item::from_bytes(&raw).unwrap();
            missing.sig = None;
            policy_parity(&p, &missing.to_bytes().unwrap());
            missing.sig = Some(B64([0; 64]));
            policy_parity(&p, &missing.to_bytes().unwrap());
        }
    }
}
fn native(key: Option<[u8; 32]>) -> KeyringSealer {
    let mut s = KeyringSealer::new(COL, DEV, &SEED, &[11; 32]);
    if let Some(key) = key {
        s.keys.insert(1, Secret32(key));
    }
    s
}
fn sealed(unknown: bool, compress: bool) -> (Vec<u8>, Vec<u8>) {
    let mut sample = item(0);
    sample.sig = None;
    let Cbor::Map(mut fields) = sample.to_cbor() else {
        panic!("map")
    };
    if unknown {
        fields.push((Cbor::Uint(13), Cbor::Text("future".into())));
    }
    let before = cbor::encode(&Cbor::Map(fields.clone())).unwrap();
    let plain = b"genuine native plaintext".repeat(100);
    let body = crate::crypto::seal::seal_with_salt(
        &KEY,
        &[3; 16],
        &raw::aad_from_bytes(&before).unwrap(),
        &plain,
        compress,
    )
    .unwrap();
    fields
        .iter_mut()
        .find(|(key, _)| *key == Cbor::Uint(11))
        .unwrap()
        .1 = Cbor::Bytes(body);
    (cbor::encode(&Cbor::Map(fields)).unwrap(), plain)
}
fn native_new(s: &dyn Sealer, bytes: &[u8]) -> Result<Vec<u8>, OpenError> {
    let data = view(bytes);
    let plan = raw::open_workspace_plan(&data, crate::crypto::seal::MAX_PLAIN).unwrap();
    let mut aad = vec![0; plan.aad_bytes()];
    s.open_bounded_borrowed(
        &data,
        &mut aad,
        crate::crypto::seal::MAX_PLAIN,
        plan.peak_bytes(),
    )
}
#[test]
fn genuine_native_keyring_open_equivalence_for_held_missing_wrong_keys_unknowns_and_tamper() {
    for unknown in [false, true] {
        for compress in [false, true] {
            let (bytes, plain) = sealed(unknown, compress);
            let owned = Item::from_bytes(&bytes).unwrap();
            for key in [Some(KEY), Some([0; 32]), None] {
                let s = native(key);
                assert_eq!(s.open(&owned, &bytes), native_new(&s, &bytes));
                if key == Some(KEY) {
                    assert_eq!(native_new(&s, &bytes), Ok(plain.clone()));
                }
            }
            let data = view(&bytes);
            let at = data.body().as_ptr() as usize - bytes.as_ptr() as usize;
            let mut bad = bytes.clone();
            bad[at + data.body().len() - 1] ^= 1;
            let owned = Item::from_bytes(&bad).unwrap();
            let s = native(Some(KEY));
            assert_eq!(s.open(&owned, &bad), native_new(&s, &bad));
            assert_eq!(native_new(&s, &bad), Err(OpenError::Aead));
        }
    }
    let mut missing = item(17);
    missing.epoch = None;
    let bytes = missing.to_bytes().unwrap();
    let data = view(&bytes);
    let s = native(Some(KEY));
    let mut aad = [];
    assert_eq!(
        s.open(&missing, &bytes),
        s.open_bounded_borrowed(&data, &mut aad, 0, 0)
    );
}
#[cfg(not(target_arch = "wasm32"))]
#[test]
fn large_body_borrowed_policy_checks_allocate_zero_without_state_clone_or_verifier_substitution() {
    let bytes = signed(item(4 * 1024 * 1024), true, false);
    let data = view(&bytes);
    let p = policy();
    let env = env();
    let measured = allocation_counter::measure(|| {
        assert_eq!(p.check_device_signature_borrowed(&data, &env), Ok(DEV));
        assert!(p.check_base_header_borrowed(&data, &env).is_ok());
        assert!(
            p.check_base_source_borrowed(&data, BaseSource::Folder)
                .is_ok()
        );
        assert!(p.check_base_payload_borrowed(&data, &B32([5; 32])).is_ok());
    });
    assert_eq!(measured.count_total, 0);
    assert_eq!(measured.bytes_max, 0);
}
#[test]
fn unsupported_sealer_refuses_and_wipes_without_owned_fallback() {
    // Negative-only existing test sealer; never substituted for native custody.
    let (bytes, _) = sealed(false, false);
    let data = view(&bytes);
    let mut aad = [0xa5; 9];
    let s = PlainSealer::for_device(DEV);
    assert_eq!(
        s.open_bounded_borrowed(&data, &mut aad, 0, 0),
        Err(OpenError::Aead)
    );
    assert_eq!(aad, [0; 9]);
}
