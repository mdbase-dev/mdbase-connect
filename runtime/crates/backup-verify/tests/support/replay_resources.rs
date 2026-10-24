//! Simultaneous full-capacity private replay maps and incoming policy scratch.
use mdbn_log_service::{
    OfflineDecodeBudget, OfflineReplayVerifier,
    testkit::{ControlPlane, id16, key, sign_digest},
};
use mdbn_wire::{
    common::{B32, B64},
    hash::chain_hash,
    policy::{CpKeyRevoke, DeviceEnrol, DeviceKind, MemberSet, PolicyOp, Role},
};
use std::sync::atomic::Ordering;

pub(crate) fn measure() {
    // Keep the payload/node-slack proof tied to the actual compiled layouts.
    assert!(std::mem::size_of::<mdbn_wire::cbor::Cbor>() <= 32);
    assert!(std::mem::size_of::<mdbn_log_service::model::AclEntry>() <= 80);
    assert!(std::mem::size_of::<PolicyOp>() <= 256);
    let label = "offline/test-only/max-replay-state";
    let cp = ControlPlane::new(label);
    let collection = id16("offline/test-only/max-replay-state/collection");
    let owner = id16("offline/test-only/max-replay-state/owner");
    let root = key(format!("{label}/root").as_bytes());
    let genesis = cp.genesis(collection, owner);
    let baseline = super::allocator::LIVE.load(Ordering::SeqCst);
    super::allocator::PEAK.store(baseline, Ordering::SeqCst);
    let work = OfflineDecodeBudget::new();
    let mut verifier = OfflineReplayVerifier::new(collection, 1, &[cp.root_pk()], &work).unwrap();
    verifier.push(1, &genesis).unwrap();
    let mut previous = chain_hash(&genesis);
    let mut seq = 1;
    for start in (0..4096).step_by(32) {
        let mut ops = Vec::new();
        for number in start..start + 32 {
            if number != 0 {
                // Genesis already inserted one of the4096members.
                ops.push(PolicyOp::MemberSet(MemberSet {
                    account: id16(&format!("test-only/member/{number}")),
                    role: Role::Editor,
                }));
            }
            ops.push(PolicyOp::DeviceEnrol(DeviceEnrol {
                device: id16(&format!("test-only/device/{number}")),
                account: owner,
                kind: DeviceKind::Desktop,
                sign_pk: B32([11; 32]),
                kem_pk: B32([12; 32]),
                noise_pk: B32([13; 32]),
                sas_commit: None,
                local_root: None,
            }));
            let mut revoke = CpKeyRevoke {
                key_id: id16(&format!("test-only/revoked-key/{number}")),
                revoked_from: 0,
                root_sig: B64([0; 64]),
            };
            revoke.root_sig = sign_digest(&root, &revoke.signed_digest().unwrap());
            ops.push(PolicyOp::CpKeyRevoke(revoke));
        }
        seq += 1;
        let raw = cp.policy_item(collection, seq, previous, ops, seq as i64);
        verifier.push(seq, &raw).unwrap();
        previous = chain_hash(&raw);
    }
    let peak = super::allocator::PEAK
        .load(Ordering::SeqCst)
        .saturating_sub(baseline);
    assert!(peak <= 96 * 1024 * 1024);
    // Admission checks incoming operations before mutating the existing maps.
    seq += 1;
    let raw = cp.policy_item(
        collection,
        seq,
        previous,
        vec![PolicyOp::MemberSet(MemberSet {
            account: id16("test-only/member/overflow"),
            role: Role::Editor,
        })],
        seq as i64,
    );
    assert!(verifier.push(seq, &raw).is_err());
    assert!(work.reserve_owned(0).is_err());
    assert!(verifier.finish(seq - 1, &previous).is_err());
    println!(
        "RESOURCE case=replay4096_each_map acl=4096 members=4096 revoked_keys=4096 incremental_peak_bytes={peak} incoming4097_refusal=pass poison=true"
    );
}
