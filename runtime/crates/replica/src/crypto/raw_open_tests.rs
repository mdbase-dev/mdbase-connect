use super::super::seal::{MAX_PLAIN, seal_with_salt};
use super::*;
use mdbn_wire::{
    cbor::{self, Cbor},
    common::{B16, B32, Bytes},
    envelope::ItemKind,
};

const KEY: [u8; 32] = [42; 32];
fn fixture(plain: &[u8], compress: bool, unknown: bool) -> Vec<u8> {
    let item = Item {
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
        body: Bytes::default(),
        sig: None,
    };
    let Cbor::Map(mut fields) = item.to_cbor() else {
        panic!("map")
    };
    if unknown {
        fields.push((
            Cbor::Uint(13),
            Cbor::Array(vec![Cbor::Text("future".into()), Cbor::Uint(1)]),
        ));
    }
    let unsigned = cbor::encode(&Cbor::Map(fields.clone())).unwrap();
    let body = seal_with_salt(
        &KEY,
        &[3; 16],
        &aad_from_bytes(&unsigned).unwrap(),
        plain,
        compress,
    )
    .unwrap();
    fields
        .iter_mut()
        .find(|(key, _)| *key == Cbor::Uint(11))
        .unwrap()
        .1 = Cbor::Bytes(body);
    cbor::encode(&Cbor::Map(fields)).unwrap()
}
fn prepare(raw: &[u8]) -> Result<BorrowedEnvelope<'_>, CryptoError> {
    let plan = envelope_workspace_plan(raw)?;
    let mut metadata = vec![0; plan.metadata_bytes()];
    decode_envelope_borrowed(raw, &mut metadata, plan.decoder_peak_bytes())
}
fn new_open(key: &[u8; 32], raw: &[u8], max: usize) -> Result<Vec<u8>, CryptoError> {
    let view = prepare(raw)?;
    let plan = open_workspace_plan(&view, max)?;
    let mut aad = vec![0; plan.aad_bytes()];
    open_envelope_borrowed_bounded(key, &view, &mut aad, max, plan.peak_bytes())
}
#[test]
fn bounded_open_is_identical_for_segments_compression_unknowns_wrong_keys_limits_and_tamper() {
    for size in [0, 70, 65_536, 70_000] {
        let plain = vec![7; size];
        for compress in [false, true] {
            for unknown in [false, true] {
                let raw = fixture(&plain, compress, unknown);
                assert_eq!(new_open(&KEY, &raw, MAX_PLAIN), Ok(plain.clone()));
                for max in [0, size.saturating_sub(1), size, MAX_PLAIN, MAX_PLAIN + 1] {
                    for key in [&KEY, &[0; 32]] {
                        assert_eq!(
                            new_open(key, &raw, max),
                            open_item_bytes_bounded(key, &raw, max)
                        );
                    }
                }
                let view = prepare(&raw).unwrap();
                let at = view.body().as_ptr() as usize - raw.as_ptr() as usize;
                let mut changed = raw.clone();
                changed[at + view.body().len() - 1] ^= 1;
                assert_eq!(
                    new_open(&KEY, &changed, MAX_PLAIN),
                    open_item_bytes_bounded(&KEY, &changed, MAX_PLAIN)
                );
                assert!(new_open(&KEY, &changed, MAX_PLAIN).is_err());
                for end in [0, 1, raw.len() / 2, raw.len() - 1] {
                    assert_eq!(
                        new_open(&KEY, &raw[..end], MAX_PLAIN),
                        open_item_bytes_bounded(&KEY, &raw[..end], MAX_PLAIN)
                    );
                }
            }
        }
    }
}
#[cfg(not(target_arch = "wasm32"))]
#[test]
fn conservative_shared_peak_keeps_input_metadata_aad_and_output_live_together() {
    for size in [0, 1, 7, 8, 70, 4 * 1024 * 1024, MAX_PLAIN] {
        for compress in [false, true] {
            let plain = vec![7; size];
            let source = fixture(&plain, compress, true);
            let mut charge = 0;
            let mut opened = None;
            let measured = allocation_counter::measure(|| {
                // Model ONE caller account with the received source retained;
                // never reset the measurement between decode and crypto work.
                let input = source.clone();
                let metadata_plan = envelope_workspace_plan(&input).unwrap();
                let mut metadata = vec![0; metadata_plan.metadata_bytes()];
                let data = decode_envelope_borrowed(
                    &input,
                    &mut metadata,
                    metadata_plan.decoder_peak_bytes(),
                )
                .unwrap();
                let crypto_plan = open_workspace_plan(&data, size).unwrap();
                charge = input.capacity()
                    + metadata_plan.decoder_peak_bytes()
                    + crypto_plan.peak_bytes();
                let mut aad = vec![0; crypto_plan.aad_bytes()];
                opened = Some(
                    open_envelope_borrowed_bounded(
                        &KEY,
                        &data,
                        &mut aad,
                        size,
                        crypto_plan.peak_bytes(),
                    )
                    .unwrap(),
                );
                assert_eq!(data.received(), input.as_slice());
                assert_eq!(metadata.len(), metadata_plan.metadata_bytes());
                assert_eq!(aad.len(), crypto_plan.aad_bytes());
            });
            assert_eq!(opened.as_ref().unwrap(), &plain);
            assert!(
                measured.bytes_max as usize <= charge,
                "shared logical peak: size={size} compressed={compress} measured={} charge={charge}",
                measured.bytes_max
            );
        }
    }
}

#[cfg(not(target_arch = "wasm32"))]
#[test]
fn refusal_precedes_crypto_allocation_and_mutation_and_crypto_failure_wipes_workspace() {
    let raw = fixture(&[7; 70], false, true);
    let view = prepare(&raw).unwrap();
    let plan = open_workspace_plan(&view, MAX_PLAIN).unwrap();
    let mut aad = vec![0xa5; plan.aad_bytes()];
    let mut refused = false;
    let measured = allocation_counter::measure(|| {
        refused = matches!(
            open_envelope_borrowed_bounded(&KEY, &view, &mut aad, MAX_PLAIN, plan.peak_bytes() - 1),
            Err(CryptoError::TooLarge)
        );
    });
    assert!(refused);
    assert_eq!(measured.count_total, 0);
    assert!(aad.iter().all(|b| *b == 0xa5));
    assert!(matches!(
        open_envelope_borrowed_bounded(
            &KEY,
            &view,
            &mut aad[..plan.aad_bytes() - 1],
            MAX_PLAIN,
            plan.peak_bytes()
        ),
        Err(CryptoError::Open)
    ));
    assert!(aad.iter().all(|b| *b == 0xa5));
    assert_eq!(
        open_envelope_borrowed_bounded(&[0; 32], &view, &mut aad, MAX_PLAIN, plan.peak_bytes()),
        Err(CryptoError::Open)
    );
    assert!(aad.iter().all(|b| *b == 0));
}
#[cfg(not(target_arch = "wasm32"))]
#[test]
fn admitted_open_peak_bounds_measured_existing_crypto_for_large_and_compressed_plaintext() {
    for (size, compress) in [
        (4 * 1024 * 1024, false),
        (4 * 1024 * 1024, true),
        (MAX_PLAIN, true),
    ] {
        let plain = vec![7; size];
        let raw = fixture(&plain, compress, true);
        let view = prepare(&raw).unwrap();
        let mut plan = None;
        let planning = allocation_counter::measure(|| {
            plan = Some(open_workspace_plan(&view, size).unwrap());
        });
        assert_eq!(planning.count_total, 0);
        let plan = plan.unwrap();
        let mut aad = vec![0; plan.aad_bytes()];
        let mut opened = None;
        let measured = allocation_counter::measure(|| {
            opened = Some(
                open_envelope_borrowed_bounded(&KEY, &view, &mut aad, size, plan.peak_bytes())
                    .unwrap(),
            );
        });
        assert_eq!(opened.as_ref().unwrap(), &plain);
        assert!(
            measured.bytes_max as usize + aad.capacity() <= plan.peak_bytes(),
            "logical plan must include concurrent crypto Vec/control peak: size={size} compressed={compress} measured={} aad={} planned={}",
            measured.bytes_max,
            aad.capacity(),
            plan.peak_bytes()
        );
        assert!(opened.as_ref().unwrap().capacity() <= 2 * size);
    }
}
