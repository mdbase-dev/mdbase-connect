//! Real held-key opening and Ed25519 policy parity on charged borrowed data.
use super::*;
#[cfg(not(target_arch = "wasm32"))]
use crate::mirror_install_budget::Work;
use crate::{
    crypto::raw,
    mirror_install_budget::{self as budget, Buffer, WorkingSet},
    mirror_install_data::{Envelope, Error},
    policy::{DeviceState, Env, PolicyState},
};
use mdbn_wire::{
    cbor::{self, Cbor},
    common::Bytes,
    envelope::ItemKind,
    policy::{CState, DeviceKind, Role},
    schema::Wire,
    snapshot::BaseSource,
};

const COL: B16 = B16([7; 16]);
const DEV: B16 = B16([2; 16]);
const ACCOUNT: B16 = B16([8; 16]);
const KEY: [u8; 32] = [42; 32];
const SEED: [u8; 32] = [9; 32];
fn native(key: Option<[u8; 32]>) -> KeyringSealer {
    let mut native = KeyringSealer::new(COL, DEV, &SEED, &[11; 32]);
    if let Some(key) = key {
        native.keys.insert(1, Secret32(key));
    }
    native
}
fn item() -> Item {
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
        body: Bytes(vec![]),
        sig: None,
    }
}
fn sealed(
    size: usize,
    compress: bool,
    unknown: bool,
    received_signature: bool,
) -> (Vec<u8>, Vec<u8>) {
    let Cbor::Map(mut fields) = item().to_cbor() else {
        panic!("map")
    };
    if unknown {
        fields.push((Cbor::Uint(13), Cbor::Text("future".into())));
    }
    let before = cbor::encode(&Cbor::Map(fields.clone())).unwrap();
    let plain = vec![7; size];
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
    let unsigned = cbor::encode(&Cbor::Map(fields.clone())).unwrap();
    let digest = if received_signature {
        raw::signed_digest_from_bytes(&unsigned).unwrap()
    } else {
        Item::from_bytes(&unsigned)
            .unwrap()
            .signed_digest()
            .unwrap()
            .0
    };
    fields.push((
        Cbor::Uint(12),
        Cbor::Bytes(DeviceSigner::from_seed(&SEED).sign_digest(&digest).to_vec()),
    ));
    fields.sort_by_key(|(key, _)| {
        let Cbor::Uint(key) = key else { panic!("key") };
        *key
    });
    (cbor::encode(&Cbor::Map(fields)).unwrap(), plain)
}
fn buffer(ledger: &WorkingSet, bytes: &[u8]) -> Buffer {
    let mut input = ledger.buffer(bytes.len()).unwrap();
    input.as_mut_slice().copy_from_slice(bytes);
    input
}
fn rejection(result: Result<(), Error>) -> Result<(), crate::policy::Rejected> {
    match result {
        Ok(()) => Ok(()),
        Err(Error::Policy(error)) => Err(error.rejection().clone()),
        Err(error) => panic!("unexpected resource/codec failure: {error:?}"),
    }
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

#[test]
fn charged_native_parity_for_held_missing_wrong_keys_compression_segments_unknowns_and_tamper() {
    for size in [0, 17, 70_000] {
        for compress in [false, true] {
            for unknown in [false, true] {
                let (bytes, plain) = sealed(size, compress, unknown, false);
                let old = Item::from_bytes(&bytes).unwrap();
                let ledger = WorkingSet::default();
                let input = buffer(&ledger, &bytes);
                let data = Envelope::decode(&ledger, &input).unwrap();
                for key in [Some(KEY), Some([0; 32]), None] {
                    let s = native(key);
                    let charged = s.open_charged_borrowed(&data, size);
                    let ordinary = s.open(&old, &bytes);
                    match (charged, ordinary) {
                        (Ok(output), Ok(expected)) => {
                            assert_eq!(output.as_slice(), expected);
                            assert_eq!(output.as_slice(), plain);
                        }
                        (Err(Error::Open(new)), Err(old)) => assert_eq!(new, old),
                        mismatch => panic!("opening parity mismatch: {mismatch:?}"),
                    }
                }
                let at =
                    data.borrowed().body().as_ptr() as usize - input.as_slice().as_ptr() as usize;
                let last = at + data.borrowed().body().len() - 1;
                let mut changed = bytes.clone();
                changed[last] ^= 1;
                let bad_input = buffer(&ledger, &changed);
                let bad_data = Envelope::decode(&ledger, &bad_input).unwrap();
                assert_eq!(
                    native(Some(KEY))
                        .open_charged_borrowed(&bad_data, size)
                        .unwrap_err(),
                    Error::Open(OpenError::Aead)
                );
                assert_eq!(input.as_slice(), bytes);
                assert_eq!(bad_input.as_slice(), changed);
            }
        }
    }
}

#[test]
fn charged_open_keeps_native_epoch_key_order_before_salt_or_size_planning() {
    for epoch in [None, Some(1), Some(2)] {
        let mut malformed = item();
        malformed.epoch = epoch;
        malformed.salt = None;
        let ledger = WorkingSet::default();
        let input = buffer(&ledger, &malformed.to_bytes().unwrap());
        let data = Envelope::decode(&ledger, &input).unwrap();
        for key in [None, Some(KEY)] {
            let before = ledger.work_used().unwrap();
            let result = native(key).open_charged_borrowed(&data, usize::MAX);
            if epoch.is_none() {
                assert_eq!(result.unwrap_err(), Error::Open(OpenError::Aead));
            } else if key.is_none() || epoch == Some(2) {
                assert_eq!(result.unwrap_err(), Error::Open(OpenError::NoKey));
            } else {
                // Explicit resource refusal is distinct from crypto error parity.
                let expected = if usize::BITS == 64 {
                    budget::Error::AccountingOverflow
                } else {
                    budget::Error::PassBytes
                };
                assert_eq!(result.unwrap_err(), Error::Budget(expected));
                break;
            }
            assert_eq!(
                ledger.work_used().unwrap().pass_bytes,
                before.pass_bytes + 4096
            );
        }
    }
}

#[test]
fn overlapping_outputs_keep_input_metadata_crypto_leases_until_output_drop() {
    let (bytes, _) = sealed(70_000, false, true, false);
    let ledger = WorkingSet::default();
    let input = buffer(&ledger, &bytes);
    let receipt = Envelope::decode(&ledger, &input).unwrap();
    let base = ledger.used().unwrap();
    let plan = raw::open_workspace_plan(receipt.borrowed(), 70_000).unwrap();
    let s = native(Some(KEY));
    let first = s.open_charged_borrowed(&receipt, 70_000).unwrap();
    assert_eq!(ledger.used().unwrap(), base + plan.peak_bytes() as u64);
    let second = s.open_charged_borrowed(&receipt, 70_000).unwrap();
    assert_eq!(ledger.used().unwrap(), base + 2 * plan.peak_bytes() as u64);
    assert_eq!(first.as_slice(), second.as_slice());
    assert_eq!(
        format!("{first:?}"),
        "ChargedPlaintext { bytes: 70000, .. }"
    );
    let work = ledger.work_used().unwrap();
    drop(first);
    assert_eq!(ledger.used().unwrap(), base + plan.peak_bytes() as u64);
    drop(second);
    assert_eq!(ledger.used().unwrap(), base);
    drop(receipt);
    assert_eq!(ledger.used().unwrap(), input.capacity() as u64);
    assert_eq!(ledger.work_used().unwrap(), work);
    drop(input);
    assert_eq!(ledger.used().unwrap(), 0);
    assert_eq!(ledger.work_used().unwrap(), work);
}

#[test]
fn genuine_ed25519_base_policy_parity_and_repeated_verification_costs() {
    let env = Env {
        verifier: &Ed25519Verifier,
        trusted_roots: &[],
        policy_pins: None,
    };
    for unknown in [false, true] {
        for received in [false, true] {
            let (bytes, _) = sealed(17, false, unknown, received);
            let owned = Item::from_bytes(&bytes).unwrap();
            let ledger = WorkingSet::default();
            let input = buffer(&ledger, &bytes);
            let data = Envelope::decode(&ledger, &input).unwrap();
            let mut p = policy();
            for mutation in 0..6 {
                match mutation {
                    1 => p.frozen = true,
                    2 => {
                        p.frozen = false;
                        p.epoch = 2;
                    }
                    3 => {
                        p.epoch = 1;
                        p.content_seen = true;
                    }
                    4 => {
                        p.content_seen = false;
                        p.devices.get_mut(&DEV).unwrap().keyed = false;
                    }
                    5 => p.devices.get_mut(&DEV).unwrap().active = false,
                    _ => {}
                }
                let before = ledger.work_used().unwrap();
                assert_eq!(
                    rejection(data.check_base_header(&p)),
                    p.check_base_header(&owned, &env)
                );
                assert_eq!(
                    ledger.work_used().unwrap().verifications,
                    before.verifications + 2
                );
                for source in [BaseSource::Folder, BaseSource::HostedImport] {
                    assert_eq!(
                        rejection(data.check_base_source(&p, source)),
                        p.check_base_source(&owned, source)
                    );
                }
                for manifest in [B32([5; 32]), B32([6; 32])] {
                    assert_eq!(
                        rejection(data.check_base_payload(&p, &manifest)),
                        p.check_base_payload(&owned, &manifest)
                    );
                }
                assert_eq!(
                    ledger.work_used().unwrap().verifications,
                    before.verifications + 6
                );
            }
            assert_eq!(
                data.received_digest().unwrap(),
                raw::signed_digest_from_bytes(&bytes).unwrap()
            );
        }
    }
}

#[cfg(not(target_arch = "wasm32"))]
#[test]
fn charged_crypto_and_policy_resource_refusal_allocate_zero_and_preserve_all_live_charges() {
    let (bytes, _) = sealed(17, false, false, false);
    let ledger = WorkingSet::default();
    let input = buffer(&ledger, &bytes);
    let data = Envelope::decode(&ledger, &input).unwrap();
    let s = native(Some(KEY));
    let remaining = ledger
        .reserve(budget::MAX_WORKING_BYTES - ledger.used().unwrap())
        .unwrap();
    let measured = allocation_counter::measure(|| {
        assert_eq!(
            s.open_charged_borrowed(&data, 17).unwrap_err(),
            Error::Budget(budget::Error::WorkingSet)
        );
    });
    assert_eq!(measured.count_total, 0);
    assert_eq!(ledger.used().unwrap(), budget::MAX_WORKING_BYTES);
    drop(remaining);
    let live = ledger.used().unwrap();
    ledger
        .precharge(Work {
            verifications: budget::MAX_VERIFICATIONS,
            ..Work::default()
        })
        .unwrap();
    let before = ledger.work_used().unwrap();
    let p = policy();
    let measured = allocation_counter::measure(|| {
        assert_eq!(
            data.check_base_header(&p),
            Err(Error::Budget(budget::Error::Verifications))
        );
        assert_eq!(
            s.open_charged_borrowed(&data, 17).unwrap_err(),
            Error::Budget(budget::Error::WorkExhausted)
        );
    });
    assert_eq!(measured.count_total, 0);
    assert_eq!(ledger.used().unwrap(), live);
    assert_eq!(ledger.work_used().unwrap(), before);
    assert_eq!(input.as_slice(), bytes);
}

#[test]
fn retained_policy_errors_keep_their_diagnostic_allocation_charged_after_input_drop() {
    let (bytes, _) = sealed(17, false, false, false);
    let ledger = WorkingSet::default();
    let input = buffer(&ledger, &bytes);
    let receipt = Envelope::decode(&ledger, &input).unwrap();
    let base = ledger.used().unwrap();
    let mut p = policy();
    p.frozen = true;
    let first = receipt.check_base_header(&p).unwrap_err();
    let second = receipt.check_base_header(&p).unwrap_err();
    assert_eq!(ledger.used().unwrap(), base + 512);
    for error in [&first, &second] {
        let Error::Policy(error) = error else {
            panic!("policy rejection")
        };
        assert_eq!(error.rejection().rule(), "frozen");
        let crate::policy::Rejected::Void(rejected) = error.rejection() else {
            panic!("void")
        };
        assert_eq!(rejected.detail, "collection is frozen");
        assert!(rejected.detail.capacity() <= 256);
    }
    let work = ledger.work_used().unwrap();
    drop(receipt);
    drop(input);
    assert_eq!(ledger.used().unwrap(), 512);
    drop(first);
    assert_eq!(ledger.used().unwrap(), 256);
    drop(second);
    assert_eq!(ledger.used().unwrap(), 0);
    assert_eq!(ledger.work_used().unwrap(), work);
}

#[cfg(not(target_arch = "wasm32"))]
#[test]
fn large_real_open_respects_one_shared_peak_and_refuses_uncompressed_max_before_allocation() {
    for (size, compress, succeeds) in [
        (4 << 20, false, true),
        (16 << 20, true, true),
        (16 << 20, false, false),
    ] {
        let (bytes, plain) = sealed(size, compress, true, false);
        let ledger = WorkingSet::default();
        let input = buffer(&ledger, &bytes);
        let receipt = Envelope::decode(&ledger, &input).unwrap();
        let base = ledger.used().unwrap();
        let peak = raw::open_workspace_plan(receipt.borrowed(), size)
            .unwrap()
            .peak_bytes() as u64;
        let s = native(Some(KEY));
        let mut opened = None;
        let measured = allocation_counter::measure(|| {
            opened = Some(s.open_charged_borrowed(&receipt, size));
        });
        if succeeds {
            let output = opened.unwrap().unwrap();
            assert_eq!(output.as_slice(), plain);
            assert_eq!(ledger.used().unwrap(), base + peak);
            assert!(measured.bytes_max as u64 <= peak);
            assert!(base + peak <= budget::MAX_WORKING_BYTES);
            drop(output);
        } else {
            assert!(base + peak > budget::MAX_WORKING_BYTES);
            assert_eq!(
                opened.unwrap().unwrap_err(),
                Error::Budget(budget::Error::WorkingSet)
            );
            assert_eq!(measured.count_total, 0);
        }
        assert_eq!(ledger.used().unwrap(), base);
        assert_eq!(input.as_slice(), bytes);
        assert!(ledger.work_used().unwrap().pass_bytes > 0);
    }
}

#[cfg(not(target_arch = "wasm32"))]
#[test]
fn repeated_cbor_walks_precharge_inclusive_node_ceiling_and_refuse_one_over_before_allocation() {
    for operation in 0..3 {
        for one_over in [false, true] {
            let (bytes, _) = sealed(17, false, true, false);
            let ledger = WorkingSet::default();
            let input = buffer(&ledger, &bytes);
            let receipt = Envelope::decode(&ledger, &input).unwrap();
            let s = native(Some(KEY));
            let p = policy();
            let n = input.capacity() as u64;
            let needed = if operation == 2 { 5 * n } else { 2 * n };
            let initial = ledger.work_used().unwrap();
            ledger
                .precharge(Work {
                    decoded_nodes: budget::MAX_DECODED_NODES - initial.decoded_nodes - needed
                        + u64::from(one_over),
                    ..Work::default()
                })
                .unwrap();
            let before = ledger.work_used().unwrap();
            let memory = ledger.used().unwrap();
            let execute = || match operation {
                0 => receipt.received_digest().map(|_| ()),
                1 => receipt.check_base_header(&p),
                _ => s.open_charged_borrowed(&receipt, 17).map(|_| ()),
            };
            let mut result = None;
            let measured = allocation_counter::measure(|| {
                result = Some(execute());
            });
            if one_over {
                assert_eq!(
                    result.unwrap(),
                    Err(Error::Budget(budget::Error::DecodedNodes))
                );
                assert_eq!(measured.count_total, 0);
                let mut expected = before;
                // This separately precharged lookup executed BEFORE open's node
                // refusal. It is never refunded and performs no CBOR decoding.
                if operation == 2 {
                    expected.pass_bytes += 4096;
                }
                assert_eq!(ledger.work_used().unwrap(), expected);
            } else {
                assert_eq!(result.unwrap(), Ok(()));
                assert_eq!(
                    ledger.work_used().unwrap().decoded_nodes,
                    budget::MAX_DECODED_NODES
                );
                assert_eq!(
                    ledger.work_used().unwrap().decoded_nodes - before.decoded_nodes,
                    needed
                );
                let mut failure = None;
                let measured = allocation_counter::measure(|| {
                    failure = Some(execute());
                });
                assert_eq!(
                    failure.unwrap(),
                    Err(Error::Budget(budget::Error::DecodedNodes))
                );
                assert_eq!(measured.count_total, 0);
                assert_eq!(
                    ledger.work_used().unwrap().decoded_nodes,
                    budget::MAX_DECODED_NODES
                );
            }
            assert_eq!(ledger.used().unwrap(), memory);
            assert_eq!(input.as_slice(), bytes);
            assert_eq!(ledger.reserve(0).unwrap_err(), budget::Error::WorkExhausted);
            assert_eq!(execute(), Err(Error::Budget(budget::Error::WorkExhausted)));
        }
    }
}
