use super::*;
use mdbn_wire::{
    common::{B16, B32, Bytes},
    envelope::{Item, ItemKind},
    schema::Wire,
};

fn sample() -> Vec<u8> {
    Item {
        kind: ItemKind::Base,
        collection: B16([7; 16]),
        seq: Some(1),
        prev: Some(B32([0; 32])),
        epoch: Some(1),
        signer: Some(B16([2; 16])),
        salt: Some(B16([3; 16])),
        idem: None,
        refs: Some(vec![B32([5; 32])]),
        stream: None,
        body: Bytes(vec![7; 17]),
        sig: None,
    }
    .to_bytes()
    .unwrap()
}
fn buffer(budget: &WorkingSet, bytes: &[u8]) -> Buffer {
    let mut input = budget.buffer(bytes.len()).unwrap();
    input.as_mut_slice().copy_from_slice(bytes);
    input
}

#[test]
fn one_account_preserves_input_metadata_and_work_across_receipt_drops() {
    let budget = WorkingSet::default();
    let bytes = sample();
    let plan = raw::envelope_workspace_plan(&bytes).unwrap();
    let input = buffer(&budget, &bytes);
    let data = Envelope::decode(&budget.clone(), &input).unwrap();
    assert_eq!(
        budget.used().unwrap(),
        input.capacity() as u64 + plan.decoder_peak_bytes() as u64
    );
    assert_eq!(budget.work_used().unwrap(), decode_work(input.capacity()));
    assert_eq!(
        data.received_digest().unwrap(),
        raw::signed_digest_from_bytes(&bytes).unwrap()
    );
    assert_eq!(
        budget.work_used().unwrap().pass_bytes,
        decode_work(input.capacity()).pass_bytes + bytes.len() as u64 * 4 + 4096
    );
    assert_eq!(
        format!("{data:?}"),
        format!(
            "ChargedEnvelope {{ source_capacity: {}, .. }}",
            input.capacity()
        )
    );
    assert_eq!(
        budget.work_used().unwrap().decoded_nodes,
        decode_work(input.capacity()).decoded_nodes + 2 * input.capacity() as u64
    );
    let work = budget.work_used().unwrap();
    drop(data);
    assert_eq!(budget.used().unwrap(), input.capacity() as u64);
    assert_eq!(budget.work_used().unwrap(), work);
    drop(input);
    assert_eq!(budget.used().unwrap(), 0);
    assert_eq!(budget.work_used().unwrap(), work);
}

#[cfg(not(target_arch = "wasm32"))]
#[test]
fn foreign_account_refuses_before_scanning_allocation_or_work_charge() {
    let source = WorkingSet::default();
    let other = WorkingSet::default();
    let input = buffer(&source, &sample());
    let measured = allocation_counter::measure(|| {
        assert_eq!(
            Envelope::decode(&other, &input).unwrap_err(),
            Error::ForeignAccount
        );
    });
    assert_eq!(measured.count_total, 0);
    assert_eq!(other.work_used().unwrap(), Work::default());
    assert_eq!(other.used().unwrap(), 0);
    assert_eq!(source.used().unwrap(), input.capacity() as u64);
}

#[cfg(not(target_arch = "wasm32"))]
#[test]
fn decoder_memory_and_work_refusal_are_zero_allocation_and_do_not_reset_evidence() {
    let budget = WorkingSet::default();
    let input = buffer(&budget, &sample());
    let retained = budget
        .reserve(budget::MAX_WORKING_BYTES - input.capacity() as u64)
        .unwrap();
    let measured = allocation_counter::measure(|| {
        assert_eq!(
            Envelope::decode(&budget, &input).unwrap_err(),
            Error::Budget(budget::Error::WorkingSet)
        );
    });
    assert_eq!(measured.count_total, 0);
    assert_eq!(budget.used().unwrap(), budget::MAX_WORKING_BYTES);
    assert_eq!(budget.work_used().unwrap(), decode_work(input.capacity()));
    drop(retained);
    budget
        .precharge(Work {
            decoded_nodes: budget::MAX_DECODED_NODES - budget.work_used().unwrap().decoded_nodes,
            ..Work::default()
        })
        .unwrap();
    let before = budget.work_used().unwrap();
    let measured = allocation_counter::measure(|| {
        assert_eq!(
            Envelope::decode(&budget, &input).unwrap_err(),
            Error::Budget(budget::Error::DecodedNodes)
        );
    });
    assert_eq!(measured.count_total, 0);
    assert_eq!(budget.work_used().unwrap(), before);
    assert_eq!(budget.reserve(0).unwrap_err(), budget::Error::WorkExhausted);
    assert_eq!(input.as_slice(), sample());
}

#[test]
fn malformed_decode_charges_each_retry_without_modifying_source() {
    let budget = WorkingSet::default();
    let input = buffer(&budget, &[0xa0]);
    for attempts in 1..=3 {
        assert_eq!(
            Envelope::decode(&budget, &input).unwrap_err(),
            Error::Decode(CryptoError::Open)
        );
        assert_eq!(input.as_slice(), &[0xa0]);
        assert_eq!(budget.used().unwrap(), 1);
        assert_eq!(
            budget.work_used().unwrap().pass_bytes,
            attempts * decode_work(1).pass_bytes
        );
        assert_eq!(budget.work_used().unwrap().decoded_nodes, attempts * 4);
    }
}

#[test]
fn prospective_open_cost_counts_each_segment_aad_and_saturating_refusal_is_sticky() {
    let n = 80_000;
    let limit = 70_000;
    let one = open_work(n, SEGMENT_CT, limit);
    let two = open_work(n, SEGMENT_CT + 1, limit);
    assert_eq!(
        two.pass_bytes - one.pass_bytes,
        2 * (n as u64 + 16) + 16 * SEGMENT as u64
    );
    assert_eq!(one.decoded_nodes, 5 * n as u64);
    assert_eq!(two.decoded_nodes, 5 * n as u64);
    assert_eq!(two.verifications, 0);
    assert_eq!(two.proof_entries, 0);
    let budget = WorkingSet::default();
    let huge = open_work(n, SEGMENT_CT, usize::MAX);
    assert!(huge.pass_bytes > budget::MAX_PASS_BYTES);
    assert_eq!(budget.precharge(huge), Err(budget::Error::PassBytes));
    assert_eq!(budget.work_used().unwrap(), Work::default());
    assert_eq!(
        budget.precharge(Work::default()),
        Err(budget::Error::WorkExhausted)
    );
}
