use super::*;
use crate::crypto::{
    TestEntropy,
    seal::seal_with_salt,
    sign::{DeviceSigner, verify_item},
};
use mdbn_wire::{
    cbor::{self, Cbor},
    common::{B16, B32, B64, Bytes},
    envelope::ItemKind,
};

fn item(body: usize) -> Item {
    Item {
        kind: ItemKind::Entry,
        collection: B16([7; 16]),
        seq: Some(5),
        prev: Some(B32([1; 32])),
        epoch: Some(1),
        signer: Some(B16([2; 16])),
        salt: Some(B16([3; 16])),
        idem: Some(B16([4; 16])),
        refs: None,
        stream: None,
        body: Bytes(vec![7; body]),
        sig: Some(B64([8; 64])),
    }
}
fn decode(raw: &[u8]) -> Result<BorrowedEnvelope<'_>, CryptoError> {
    let plan = envelope_workspace_plan(raw)?;
    let mut workspace = vec![0; plan.metadata_bytes()];
    decode_envelope_borrowed(raw, &mut workspace, usize::MAX)
}
fn parity(raw: &[u8]) {
    let old = Item::from_bytes(raw).map_err(|_| CryptoError::Open);
    let new = decode(raw);
    match (old, new) {
        (Ok(mut old), Ok(view)) => {
            assert_eq!(view.received(), raw);
            assert_eq!(view.body(), old.body.0.as_slice());
            assert_eq!(
                view.typed_signed_digest().unwrap(),
                old.signed_digest().unwrap().0
            );
            let shape = old.check_shape();
            old.body.0.clear();
            assert_eq!(view.metadata, old);
            assert_eq!(view.check_shape(), shape);
            assert_eq!(view.epoch(), old.epoch);
            let start = raw.as_ptr() as usize;
            let body = view.body().as_ptr() as usize;
            assert!(body >= start && body + view.body().len() <= start + raw.len());
        }
        (Err(old), Err(new)) => assert_eq!(old, new),
        _ => panic!("owned/borrowed codec admission differs"),
    }
}
#[test]
fn borrowed_metadata_matches_owned_wire_for_known_unknown_and_all_shapes() {
    for kind in [
        ItemKind::Entry,
        ItemKind::Policy,
        ItemKind::Rekey,
        ItemKind::KeyGrant,
        ItemKind::Base,
        ItemKind::GrantApproval,
        ItemKind::Manifest,
        ItemKind::Chunk,
        ItemKind::BlobPart,
        ItemKind::RefIndex,
        ItemKind::Ephemeral,
    ] {
        let mut sample = item(17);
        sample.kind = kind;
        parity(&sample.to_bytes().unwrap());
    }
    for refs in [0, 1, 1000] {
        let mut sample = item(17);
        if refs != 0 {
            sample.refs = Some(vec![B32([5; 32]); refs]);
        }
        let Cbor::Map(mut fields) = sample.to_cbor() else {
            panic!("map")
        };
        fields.push((
            Cbor::Uint(13),
            Cbor::Array(vec![
                Cbor::Map(vec![(
                    Cbor::Text("future".into()),
                    Cbor::Bytes(vec![1; 1000]),
                )]),
                Cbor::Float(0.125),
            ]),
        ));
        parity(&cbor::encode(&Cbor::Map(fields)).unwrap());
    }
}
#[test]
fn malformed_truncated_noncanonical_wrong_types_unknown_format_and_byte_changes_match_crypto_decode_errors()
 {
    let good = item(17).to_bytes().unwrap();
    for end in 0..good.len() {
        parity(&good[..end]);
    }
    for at in 0..good.len() {
        for byte in [0, 0xff] {
            let mut changed = good.clone();
            changed[at] = byte;
            parity(&changed);
        }
    }
    let mut trailing = good.clone();
    trailing.push(0);
    parity(&trailing);
    for key in [0, 1, 2, 5, 7, 9, 11, 12] {
        for replacement in [
            Cbor::Null,
            Cbor::Uint(99),
            Cbor::Text("wrong".into()),
            Cbor::Array(vec![]),
            Cbor::Bytes(vec![1; 3]),
        ] {
            let Cbor::Map(mut fields) = item(17).to_cbor() else {
                panic!("map")
            };
            if let Some((_, value)) = fields.iter_mut().find(|(k, _)| *k == Cbor::Uint(key)) {
                *value = replacement;
            } else {
                fields.push((Cbor::Uint(key), replacement));
                fields.sort_by_key(|(k, _)| {
                    let Cbor::Uint(k) = k else { panic!("key") };
                    *k
                });
            }
            parity(&cbor::encode(&Cbor::Map(fields)).unwrap());
        }
    }
    for bad in [
        vec![],
        vec![0x9f],
        vec![0xa1, 0x0b, 0x58, 0x00],
        vec![
            0xa1, 0x0b, 0x5b, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
        ],
        vec![0xa2, 0x0b, 0x40, 0x0b, 0x40],
    ] {
        parity(&bad);
    }
    let mut deep = vec![0xa2, 0x0b, 0x40, 0x0d];
    deep.extend_from_slice(&[0x81; 130]);
    deep.push(0);
    parity(&deep);
}
#[cfg(not(target_arch = "wasm32"))]
#[test]
fn four_mib_body_is_borrowed_not_allocated_and_metadata_peak_bounds_measured_decoder_allocations() {
    for (body, refs, extras) in [(4 * 1024 * 1024, 0, 0), (17, 1000, 25)] {
        let mut sample = item(body);
        if refs != 0 {
            sample.refs = Some(vec![B32([5; 32]); refs]);
        }
        let Cbor::Map(mut fields) = sample.to_cbor() else {
            panic!("map")
        };
        for key in 100..100 + extras {
            fields.push((
                Cbor::Uint(key),
                Cbor::Map(vec![(
                    Cbor::Text("future".into()),
                    Cbor::Text("value".repeat(100)),
                )]),
            ));
        }
        let raw = cbor::encode(&Cbor::Map(fields)).unwrap();
        let mut plan = None;
        let planning = allocation_counter::measure(|| {
            plan = Some(envelope_workspace_plan(&raw).unwrap());
        });
        assert_eq!(planning.count_total, 0);
        let plan = plan.unwrap();
        let mut workspace = vec![0; plan.metadata_bytes()];
        let mut decoded = None;
        let measured = allocation_counter::measure(|| {
            decoded = Some(
                decode_envelope_borrowed(&raw, &mut workspace, plan.decoder_peak_bytes()).unwrap(),
            );
        });
        assert!(measured.bytes_max as usize + workspace.capacity() <= plan.decoder_peak_bytes());
        if body == 4 * 1024 * 1024 {
            assert!(
                measured.bytes_max < 64 * 1024,
                "metadata decoder must not copy ciphertext"
            );
        }
        let view = decoded.unwrap();
        assert_eq!(view.body().len(), body);
        let expected = sample.signed_digest().unwrap().0;
        let mut actual = None;
        let hashing = allocation_counter::measure(|| {
            actual = Some(view.typed_signed_digest().unwrap());
        });
        assert_eq!(actual, Some(expected));
        assert_eq!(hashing.count_total, 0);
        assert_eq!(hashing.bytes_max, 0);
    }
}
#[cfg(not(target_arch = "wasm32"))]
#[test]
fn reservation_and_workspace_refuse_before_allocating_or_mutating_and_strict_decode_failure_wipes()
{
    let raw = item(17).to_bytes().unwrap();
    let plan = envelope_workspace_plan(&raw).unwrap();
    let mut workspace = vec![0xa5; plan.metadata_bytes()];
    let mut refused = false;
    let measured = allocation_counter::measure(|| {
        refused = matches!(
            decode_envelope_borrowed(&raw, &mut workspace, plan.decoder_peak_bytes() - 1),
            Err(CryptoError::TooLarge)
        );
    });
    assert!(refused);
    assert_eq!(measured.count_total, 0);
    assert!(workspace.iter().all(|b| *b == 0xa5));
    assert!(matches!(
        decode_envelope_borrowed(
            &raw,
            &mut workspace[..plan.metadata_bytes() - 1],
            plan.decoder_peak_bytes()
        ),
        Err(CryptoError::Open)
    ));
    assert!(workspace.iter().all(|b| *b == 0xa5));
    let Cbor::Map(mut fields) = item(17).to_cbor() else {
        panic!("map")
    };
    fields
        .iter_mut()
        .find(|(k, _)| *k == Cbor::Uint(0))
        .unwrap()
        .1 = Cbor::Uint(2);
    let raw = cbor::encode(&Cbor::Map(fields)).unwrap();
    let plan = envelope_workspace_plan(&raw).unwrap();
    let mut workspace = vec![0xa5; plan.metadata_bytes()];
    assert!(matches!(
        decode_envelope_borrowed(&raw, &mut workspace, plan.decoder_peak_bytes()),
        Err(CryptoError::Open)
    ));
    assert!(workspace.iter().all(|b| *b == 0));
}
fn open_from_view(key: &[u8; 32], raw: &[u8]) -> Result<Vec<u8>, CryptoError> {
    let view = decode(raw)?;
    let salt = view.metadata.salt.ok_or(CryptoError::Open)?;
    let aad = aad_from_bytes(view.received())?;
    open_with_salt(key, &salt.0, &aad, view.body())
}
#[test]
fn existing_aead_construction_acceptance_errors_remain_identical_with_borrowed_ciphertext() {
    let key = [42; 32];
    let salt = [3; 16];
    let plain = b"genuine authenticated payload".repeat(100);
    for unknown in [false, true] {
        for compress in [false, true] {
            let mut header = item(0);
            header.sig = None;
            let Cbor::Map(mut fields) = header.to_cbor() else {
                panic!("map")
            };
            if unknown {
                fields.push((Cbor::Uint(13), Cbor::Text("future".into())));
            }
            let raw = cbor::encode(&Cbor::Map(fields.clone())).unwrap();
            let ciphertext = seal_with_salt(
                &key,
                &salt,
                &aad_from_bytes(&raw).unwrap(),
                &plain,
                compress,
            )
            .unwrap();
            fields
                .iter_mut()
                .find(|(k, _)| *k == Cbor::Uint(11))
                .unwrap()
                .1 = Cbor::Bytes(ciphertext);
            let raw = cbor::encode(&Cbor::Map(fields)).unwrap();
            assert_eq!(open_from_view(&key, &raw), Ok(plain.clone()));
            assert_eq!(
                open_from_view(&[0; 32], &raw),
                open_item_bytes(&[0; 32], &raw)
            );
            let view = decode(&raw).unwrap();
            let at = view.body().as_ptr() as usize - raw.as_ptr() as usize;
            let mut changed = raw.clone();
            changed[at + view.body().len() - 1] ^= 1;
            assert_eq!(open_from_view(&key, &changed), Err(CryptoError::Open));
            assert_eq!(
                open_from_view(&key, &changed),
                open_item_bytes(&key, &changed)
            );
            for end in [0, 1, raw.len() / 2, raw.len() - 1] {
                assert_eq!(
                    open_from_view(&key, &raw[..end]),
                    open_item_bytes(&key, &raw[..end])
                );
            }
            // The bounded construction and caller scratch/output accounting remain
            // a later native API step; this test is not native authority or budget.
        }
    }
}

#[test]
fn typed_signature_projection_keeps_old_policy_semantics_for_unknown_fields_wrong_keys_and_tamper()
{
    let mut entropy = TestEntropy::new(9);
    let signer = DeviceSigner::generate(&mut entropy);
    for unknown in [false, true] {
        for received_signature in [false, true] {
            let mut header = item(17);
            header.sig = None;
            let Cbor::Map(mut fields) = header.to_cbor() else {
                panic!("map")
            };
            if unknown {
                fields.push((Cbor::Uint(13), Cbor::Text("future".into())));
            }
            let unsigned = cbor::encode(&Cbor::Map(fields.clone())).unwrap();
            let digest = if received_signature {
                signed_digest_from_bytes(&unsigned).unwrap()
            } else {
                header.signed_digest().unwrap().0
            };
            let sig = signer.sign_digest(&digest);
            fields.push((Cbor::Uint(12), Cbor::Bytes(sig.to_vec())));
            fields.sort_by_key(|(key, _)| {
                let Cbor::Uint(key) = key else { panic!("key") };
                *key
            });
            let raw = cbor::encode(&Cbor::Map(fields)).unwrap();
            let owned = Item::from_bytes(&raw).unwrap();
            let view = decode(&raw).unwrap();
            let typed = view.typed_signed_digest().unwrap();
            assert_eq!(typed, owned.signed_digest().unwrap().0);
            assert_eq!(
                verify_item(&signer.public(), &owned),
                verify_digest(&signer.public(), &typed, &sig)
            );
            assert_eq!(
                verify_item(&[0; 32], &owned),
                verify_digest(&[0; 32], &typed, &sig)
            );
            assert_eq!(
                verify_digest(&signer.public(), &typed, &sig),
                !(unknown && received_signature)
            );
            let at = view.body().as_ptr() as usize - raw.as_ptr() as usize;
            let mut changed = raw.clone();
            changed[at] ^= 1;
            let owned = Item::from_bytes(&changed).unwrap();
            let view = decode(&changed).unwrap();
            assert!(!verify_item(&signer.public(), &owned));
            assert_eq!(
                verify_item(&signer.public(), &owned),
                verify_digest(&signer.public(), &view.typed_signed_digest().unwrap(), &sig)
            );
        }
    }
}
