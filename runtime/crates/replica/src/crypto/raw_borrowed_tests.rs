//! Received transcript variants only: no envelope/policy/install authority.
use super::*;
use crate::crypto::{TestEntropy, sign::DeviceSigner};
use mdbn_wire::{
    cbor::{self, Cbor},
    common::{B16, B32, Bytes},
    envelope::ItemKind,
};

fn transcript(body: usize, extras: u64) -> Vec<u8> {
    let mut entries = vec![
        (Cbor::Uint(0), Cbor::Uint(1)),
        (Cbor::Uint(11), Cbor::Bytes(vec![7; body])),
        (Cbor::Uint(12), Cbor::Bytes(vec![8; 64])),
    ];
    for key in 100..100 + extras {
        entries.push((
            Cbor::Uint(key),
            Cbor::Array(vec![
                Cbor::Text("unknown-preserved".into()),
                Cbor::Uint(key),
            ]),
        ));
    }
    cbor::encode(&Cbor::Map(entries)).unwrap()
}
fn parity(raw: &[u8]) {
    assert_eq!(
        signed_digest_from_bytes_borrowed(raw),
        signed_digest_from_bytes(raw)
    );
    match aad_from_bytes(raw) {
        Ok(expected) => {
            assert_eq!(aad_workspace_len(raw), Ok(expected.len()));
            let mut actual = vec![0xa5; expected.len()];
            assert_eq!(aad_from_bytes_into(raw, &mut actual), Ok(()));
            assert_eq!(actual, expected);
            for size in [expected.len().saturating_sub(1), expected.len() + 1] {
                let mut wrong = vec![0xa5; size];
                let before = wrong.clone();
                assert_eq!(aad_from_bytes_into(raw, &mut wrong), Err(CryptoError::Open));
                assert_eq!(wrong, before, "refuse before output mutation");
            }
        }
        Err(error) => {
            assert_eq!(aad_workspace_len(raw), Err(error));
            let mut out = [0xa5; 7];
            assert_eq!(aad_from_bytes_into(raw, &mut out), Err(error));
            assert_eq!(out, [0xa5; 7]);
        }
    }
}
#[test]
fn exact_received_transcript_equivalence_including_unknowns_and_map_header_widths() {
    for extras in [0, 21, 22, 23, 253, 254, 65535] {
        parity(&transcript(123, extras));
    }
    for raw in [
        vec![0xa0],
        vec![0xa1, 0x0c, 0x00],
        vec![0xa2, 0x0b, 0x40, 0x0c, 0x40],
    ] {
        parity(&raw);
    }
}
#[test]
fn exact_error_equivalence_for_malformed_truncated_nested_overflow_and_byte_changes() {
    for raw in [
        vec![],
        vec![0x9f],
        vec![0xa1, 0x01],
        vec![0xa1, 0x20, 0x00],
        vec![0xbb, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff],
        vec![
            0xa1, 0x01, 0x5b, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
        ],
        vec![0xa1, 0x01, 0x5f],
        vec![0xa1, 0x01, 0xc0, 0x00],
    ] {
        parity(&raw);
    }
    let good = transcript(17, 2);
    for end in 0..good.len() {
        parity(&good[..end]);
    }
    let mut trailing = good.clone();
    trailing.push(0);
    parity(&trailing);
    let mut nested = vec![0xa1, 0x01];
    nested.extend_from_slice(&[0x81; 130]);
    nested.push(0);
    parity(&nested);
    for at in 0..good.len() {
        for byte in [0, 0xff] {
            let mut changed = good.clone();
            changed[at] = byte;
            parity(&changed);
        }
    }
}
const KEY: [u8; 32] = [42; 32];
const SALT: [u8; 16] = [3; 16];
fn genuine(unknown: bool, compress: bool) -> (Vec<u8>, DeviceSigner, Vec<u8>) {
    let mut entropy = TestEntropy::new(9);
    let signer = DeviceSigner::generate(&mut entropy);
    let item = Item {
        kind: ItemKind::Entry,
        collection: B16([7; 16]),
        seq: Some(5),
        prev: Some(B32([1; 32])),
        epoch: Some(1),
        signer: Some(B16([2; 16])),
        salt: Some(B16(SALT)),
        idem: Some(B16([4; 16])),
        refs: None,
        stream: None,
        body: Bytes::default(),
        sig: None,
    };
    let Cbor::Map(mut fields) = item.to_cbor() else {
        panic!("map")
    };
    if unknown {
        fields.push((
            Cbor::Uint(13),
            Cbor::Array(vec![Cbor::Text("future".into()), Cbor::Bool(true)]),
        ));
    }
    let raw = cbor::encode(&Cbor::Map(fields.clone())).unwrap();
    let plain = b"same authenticated plaintext\n".repeat(200);
    let ciphertext = super::super::seal::seal_with_salt(
        &KEY,
        &SALT,
        &aad_from_bytes(&raw).unwrap(),
        &plain,
        compress,
    )
    .unwrap();
    fields
        .iter_mut()
        .find(|(key, _)| *key == Cbor::Uint(11))
        .unwrap()
        .1 = Cbor::Bytes(ciphertext);
    let unsigned = cbor::encode(&Cbor::Map(fields.clone())).unwrap();
    let signature = signer.sign_digest(&signed_digest_from_bytes(&unsigned).unwrap());
    fields.push((Cbor::Uint(12), Cbor::Bytes(signature.to_vec())));
    fields.sort_by_key(|(key, _)| {
        let Cbor::Uint(key) = key else { panic!("key") };
        *key
    });
    (cbor::encode(&Cbor::Map(fields)).unwrap(), signer, plain)
}
fn open_with_new_aad(key: &[u8; 32], raw: &[u8]) -> Result<Vec<u8>, CryptoError> {
    // Existing strict owned envelope decoder and crypto construction stay
    // unchanged. This fixture qualifies AAD/transcript equivalence, NOT a new
    // borrowed envelope decoder/native open (those remain a separate step).
    let item = Item::from_bytes(raw).map_err(|_| CryptoError::Open)?;
    let salt = item.salt.ok_or(CryptoError::Open)?;
    let mut aad = vec![0; aad_workspace_len(raw)?];
    aad_from_bytes_into(raw, &mut aad)?;
    open_with_salt(key, &salt.0, &aad, &item.body.0)
}
#[test]
fn genuine_signature_and_aead_equivalence_for_unknown_fields_wrong_keys_and_tampering() {
    for unknown in [false, true] {
        for compress in [false, true] {
            let (raw, signer, plain) = genuine(unknown, compress);
            assert_eq!(open_item_bytes(&KEY, &raw), Ok(plain.clone()));
            assert_eq!(open_with_new_aad(&KEY, &raw), Ok(plain));
            parity(&raw);
            let item = Item::from_bytes(&raw).unwrap();
            let sig = item.sig.unwrap();
            let digest = signed_digest_from_bytes_borrowed(&raw).unwrap();
            assert_eq!(
                verify_item_bytes(&signer.public(), &raw),
                verify_digest(&signer.public(), &digest, &sig.0)
            );
            assert_eq!(
                verify_item_bytes(&[0; 32], &raw),
                verify_digest(&[0; 32], &digest, &sig.0)
            );
            assert_eq!(
                open_item_bytes(&[0; 32], &raw),
                open_with_new_aad(&[0; 32], &raw)
            );
            let at = raw
                .windows(item.body.0.len())
                .position(|part| part == item.body.0.as_slice())
                .unwrap();
            let mut changed = raw.clone();
            changed[at + item.body.0.len() - 1] ^= 1;
            assert_eq!(open_item_bytes(&KEY, &changed), Err(CryptoError::Open));
            assert_eq!(open_with_new_aad(&KEY, &changed), Err(CryptoError::Open));
            parity(&changed);
            let digest = signed_digest_from_bytes_borrowed(&changed).unwrap();
            assert_eq!(
                verify_item_bytes(&signer.public(), &changed),
                verify_digest(&signer.public(), &digest, &sig.0)
            );
        }
    }
}
#[cfg(not(target_arch = "wasm32"))]
#[test]
fn borrowed_hash_and_caller_workspace_fill_allocate_zero_for_four_mib_or_refusal() {
    let raw = transcript(4 * 1024 * 1024, 7);
    let expected = signed_digest_from_bytes(&raw).unwrap();
    let old_aad = aad_from_bytes(&raw).unwrap();
    let mut aad = vec![0; old_aad.len()];
    let mut digest = None;
    let measured = allocation_counter::measure(|| {
        digest = Some(signed_digest_from_bytes_borrowed(&raw).unwrap());
        assert_eq!(aad_workspace_len(&raw).unwrap(), aad.len());
        aad_from_bytes_into(&raw, &mut aad).unwrap();
    });
    assert_eq!(digest, Some(expected));
    assert_eq!(aad, old_aad);
    assert_eq!(measured.count_total, 0);
    assert_eq!(measured.bytes_max, 0);
    let bad = [0xbb, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff];
    let mut failed = false;
    let measured = allocation_counter::measure(|| {
        failed = signed_digest_from_bytes_borrowed(&bad).is_err()
            && aad_workspace_len(&bad).is_err()
            && aad_from_bytes_into(&bad, &mut aad).is_err();
    });
    assert!(failed);
    assert_eq!(measured.count_total, 0);
    assert_eq!(measured.bytes_max, 0);
}
