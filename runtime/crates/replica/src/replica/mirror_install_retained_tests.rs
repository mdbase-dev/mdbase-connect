use super::*;
use crate::crypto::raw::signed_digest_from_bytes_borrowed as streamed_signed_digest;
use mdbn_wire::{
    cbor::{self, Cbor},
    common::{B16, B64, Version},
    snapshot::Horizon,
};

fn raw(body: usize, extras: u64) -> Vec<u8> {
    let mut fields = vec![
        (0, Cbor::Uint(1)),
        (11, Cbor::Bytes(vec![7; body])),
        (12, Cbor::Bytes(vec![8; 64])),
    ];
    for key in 100..100 + extras {
        fields.push((
            key,
            Cbor::Array(vec![
                Cbor::Text("unknown-preserved".into()),
                Cbor::Uint(key),
            ]),
        ));
    }
    cbor::encode(&Cbor::Map(
        fields
            .into_iter()
            .map(|(k, v)| (Cbor::Uint(k), v))
            .collect(),
    ))
    .unwrap()
}

#[test]
fn streaming_digest_is_exact_received_byte_equivalence_including_unknown_fields_and_header_widths()
{
    for extras in [0, 21, 22, 23, 253, 254, 65535] {
        let bytes = raw(123, extras);
        assert_eq!(
            streamed_signed_digest(&bytes).unwrap(),
            crate::crypto::raw::signed_digest_from_bytes(&bytes).unwrap()
        );
    }
    let a = raw(123, 1);
    let mut b = a.clone();
    // Actual body byte changes must change the signature input; unknown fields
    // are included, unlike decoding/re-encoding through the old typed Item.
    let at = b.windows(4).position(|s| s == [7; 4]).unwrap();
    b[at] ^= 1;
    assert_ne!(
        streamed_signed_digest(&a).unwrap(),
        streamed_signed_digest(&b).unwrap()
    );
}

#[test]
fn streaming_digest_refuses_truncated_overflow_nested_and_trailing_inputs() {
    for bad in [
        vec![],
        vec![0x9f],
        vec![0xa1, 0x01],
        vec![0xa1, 0x20, 0x00],
        vec![0xbb, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff],
        vec![
            0xa1, 0x01, 0x5b, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
        ],
    ] {
        assert!(streamed_signed_digest(&bad).is_err());
    }
    let good = raw(50, 0);
    assert!(streamed_signed_digest(&good[..good.len() - 1]).is_err());
    let mut trailing = good;
    trailing.push(0);
    assert!(streamed_signed_digest(&trailing).is_err());
    let mut nested = vec![0xa1, 0x01];
    nested.extend_from_slice(&[0x81; 130]);
    nested.push(0);
    assert!(streamed_signed_digest(&nested).is_err());
}

#[cfg(not(target_arch = "wasm32"))]
#[test]
fn streamed_digest_allocates_zero_even_for_large_bodies_or_structural_refusal() {
    let bytes = raw(4 * 1024 * 1024, 7);
    let expected = crate::crypto::raw::signed_digest_from_bytes(&bytes).unwrap();
    let mut digest = None;
    let counted = allocation_counter::measure(|| {
        digest = Some(streamed_signed_digest(&bytes).unwrap());
    });
    assert_eq!(digest, Some(expected));
    assert_eq!(counted.count_total, 0);
    assert_eq!(counted.bytes_max, 0);
    let bad = [0xbb, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff];
    let mut refused = false;
    let counted = allocation_counter::measure(|| {
        refused = streamed_signed_digest(&bad).is_err();
    });
    assert!(refused);
    assert_eq!(counted.count_total, 0);
    assert_eq!(counted.bytes_max, 0);
}

#[test]
fn shared_public_buffer_preserves_retained_wip_borrow_lifecycle_assertions() {
    use crate::mirror_install_budget::{Error as BudgetError, MAX_WORKING_BYTES, WorkingSet};
    let budget = WorkingSet::default();
    let mut body = budget.buffer(37).unwrap();
    body.as_mut_slice().fill(9);
    assert_eq!(body.capacity(), 37);
    assert_eq!(budget.used().unwrap(), 37);
    assert!(budget.clone().owns_buffer(&body));
    assert!(!WorkingSet::default().owns_buffer(&body));
    // The byte borrow retains its charge without a Vec escape callback.
    {
        let bytes = &body;
        assert_eq!(budget.used().unwrap(), bytes.capacity() as u64);
        assert_eq!(bytes.as_slice(), &[9; 37]);
    }
    drop(body);
    assert_eq!(budget.used().unwrap(), 0);
    let charge = budget.reserve(MAX_WORKING_BYTES).unwrap();
    assert_eq!(budget.buffer(1).unwrap_err(), BudgetError::WorkingSet);
    assert_eq!(budget.used().unwrap(), MAX_WORKING_BYTES);
    drop(charge);
    assert_eq!(budget.used().unwrap(), 0);
}

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
#[test]
fn typed_partial_check_preserves_gen0_digest_epoch_signer_signature_refusals() {
    let m = manifest();
    // Genuine Ed25519 fixture preserves the existing refusal and error ordering.
    let (bytes, i, p) = super::fixture(32, false, true);
    let v = Ed25519Verifier;
    let check = |m: &ManifestPayload, i: &Item, p: &PolicyState| {
        check_gen0_manifest(&bytes, i, m, 3, B32([5; 32]), p, &v).err()
    };
    assert!(check(&m, &i, &p).is_none());
    for field in 0..3 {
        let mut bad = m.clone();
        match field {
            0 => bad.seq = 1,
            1 => bad.chain = B32([1; 32]),
            _ => bad.control_chain = B32([1; 32]),
        };
        assert_eq!(check(&bad, &i, &p), Some(Error::NotGen0));
    }
    let mut bad = m.clone();
    bad.state_digest = B32([4; 32]);
    assert_eq!(check(&bad, &i, &p), Some(Error::StateDigest));
    let mut bad = i.clone();
    bad.epoch = Some(4);
    assert_eq!(check(&m, &bad, &p), Some(Error::Epoch));
    bad = i.clone();
    bad.signer = None;
    assert_eq!(check(&m, &bad, &p), Some(Error::MissingSigner));
    bad = i.clone();
    bad.signer = Some(B16([99; 16]));
    assert_eq!(check(&m, &bad, &p), Some(Error::InactiveSigner));
    for keyed in [false, true] {
        let mut bad = p.clone();
        let d = bad.devices.get_mut(&B16([2; 16])).unwrap();
        if keyed {
            d.active = false
        } else {
            d.keyed = false
        };
        assert_eq!(check(&m, &i, &bad), Some(Error::InactiveSigner));
    }
    bad = i.clone();
    bad.sig = None;
    assert_eq!(check(&m, &bad, &p), Some(Error::MissingSignature));
    bad = i.clone();
    bad.sig = Some(B64([1; 64]));
    assert_eq!(check(&m, &bad, &p), Some(Error::BadSignature));
    assert!(matches!(
        check_gen0_manifest(&[], &i, &m, 3, B32([5; 32]), &p, &v),
        Err(Error::RawDigest)
    ));
}

#[cfg(not(target_arch = "wasm32"))]
#[test]
fn storage_refusals_do_not_retain_or_clone_diagnostic_allocations() {
    use crate::mirror_admission::candidate::{Error, StorageRefusal};
    use crate::store::StoreError;
    let cases = [
        (
            StoreError::Io("private diagnostic".repeat(128)),
            StorageRefusal::Io,
        ),
        (
            StoreError::CommitAborted("ordinary guarantee".repeat(128)),
            StorageRefusal::Io,
        ),
        (
            StoreError::Corrupt("private diagnostic".repeat(128)),
            StorageRefusal::Corrupt,
        ),
        (StoreError::Full, StorageRefusal::Full),
    ];
    for (source, expected) in cases {
        let mut error = None;
        let measured = allocation_counter::measure(|| {
            error = Some(Error::from(source));
        });
        assert_eq!(measured.count_total, 0);
        let error = error.unwrap();
        assert_eq!(error, Error::Storage(expected));
        let mut copy = None;
        let measured = allocation_counter::measure(|| {
            copy = Some(error.clone());
        });
        assert_eq!(measured.count_total, 0);
        assert_eq!(copy.unwrap(), error);
        assert_eq!(error.to_string(), "mirror_candidate_storage_reopen");
        assert!(!format!("{error:?}").contains("private diagnostic"));
        assert!(!format!("{error:?}").contains("ordinary guarantee"));
    }
    assert!(std::mem::size_of::<StorageRefusal>() <= 1);
    assert!(std::mem::size_of::<Error>() <= 16);
}
