use super::*;
use crate::testkit::{ControlPlane, Device, id16, object};
use mdbn_wire::hash::sha256;
use mdbn_wire::policy::{DeviceKind, DeviceRevoke};

fn fixture() -> (ControlPlane, Uuid, Device, Vec<Vec<u8>>) {
    let cp = ControlPlane::new("offline/test-only/replay");
    let c = id16("offline/test-only/collection");
    let owner = id16("offline/test-only/owner");
    let device = Device::new("offline/test-only/author", owner);
    let genesis = cp.genesis(c, owner);
    let enrol = cp.policy_item(
        c,
        2,
        chain_hash(&genesis),
        vec![device.enrol(DeviceKind::Desktop)],
        2,
    );
    let rekey = device.rekey(c, 3, chain_hash(&enrol), 0, &[device.id]);
    let entry = device.entry(
        c,
        4,
        chain_hash(&rekey),
        1,
        id16("offline/test-only/idem"),
        None,
        vec![7; 32],
    );
    (cp, c, device, vec![genesis, enrol, rekey, entry])
}

#[test]
fn original_policy_rekey_and_entry_use_existing_signed_verifiers() {
    let (cp, c, device, items) = fixture();
    let work = OfflineDecodeBudget::new();
    let mut replay = OfflineReplayVerifier::new(c, 1, &[cp.root_pk()], &work).unwrap();
    for (seq, bytes) in items.iter().enumerate() {
        replay.push(seq as u64 + 1, bytes).unwrap();
    }
    let manifest = device.manifest(c, 1, vec![B32([0x51; 32])], vec![9; 32]);
    replay.verify_manifest(&manifest, &device.id).unwrap();
    replay.finish(4, &chain_hash(&items[3])).unwrap();
}

#[test]
fn compacted_gap_only_below_retained_boundary_still_requires_original_genesis() {
    let (cp, c, device, items) = fixture();
    let last = device.entry(
        c,
        9,
        B32([0x21; 32]),
        1,
        id16("offline/test-only/compacted"),
        None,
        vec![7; 32],
    );
    let work = OfflineDecodeBudget::new();
    let mut replay = OfflineReplayVerifier::new(c, 9, &[cp.root_pk()], &work).unwrap();
    for (seq, bytes) in items[..3].iter().enumerate() {
        replay.push(seq as u64 + 1, bytes).unwrap();
    }
    replay.push(9, &last).unwrap();
    replay.finish(9, &chain_hash(&last)).unwrap();
    let work = OfflineDecodeBudget::new();
    let mut bad = OfflineReplayVerifier::new(c, 8, &[cp.root_pk()], &work).unwrap();
    for (seq, bytes) in items[..3].iter().enumerate() {
        bad.push(seq as u64 + 1, bytes).unwrap();
    }
    assert!(bad.push(9, &last).is_err());
    assert!(bad.finish(9, &chain_hash(&last)).is_err());
    let work = OfflineDecodeBudget::new();
    let mut no_genesis = OfflineReplayVerifier::new(c, 9, &[cp.root_pk()], &work).unwrap();
    assert!(no_genesis.push(9, &last).is_err());
}

#[test]
fn historical_revoked_manifest_key_is_authenticity_not_current_permission() {
    let (cp, c, device, items) = fixture();
    let work = OfflineDecodeBudget::new();
    let mut replay = OfflineReplayVerifier::new(c, 1, &[cp.root_pk()], &work).unwrap();
    for (seq, bytes) in items.iter().enumerate() {
        replay.push(seq as u64 + 1, bytes).unwrap();
    }
    let revoked = cp.policy_item(
        c,
        5,
        chain_hash(&items[3]),
        vec![PolicyOp::DeviceRevoke(DeviceRevoke { device: device.id })],
        5,
    );
    replay.push(5, &revoked).unwrap();
    replay
        .verify_manifest(
            &device.manifest(c, 1, vec![B32([0x51; 32])], vec![9; 32]),
            &device.id,
        )
        .unwrap();
    replay.finish(5, &chain_hash(&revoked)).unwrap();
}

#[test]
fn manifest_self_error_and_static_object_error_poison_shared_lifetime() {
    let (cp, c, device, items) = fixture();
    let work = OfflineDecodeBudget::new();
    let mut replay = OfflineReplayVerifier::new(c, 1, &[cp.root_pk()], &work).unwrap();
    for (seq, bytes) in items.iter().enumerate() {
        replay.push(seq as u64 + 1, bytes).unwrap();
    }
    assert!(
        replay
            .verify_manifest(
                &device.manifest(c, 1, vec![B32([0x51; 32])], vec![9; 32]),
                &id16("different-author")
            )
            .is_err()
    );
    assert!(work.clone().request().raw(&[0xf6]).is_err());
    assert!(replay.finish(4, &chain_hash(&items[3])).is_err());

    let work = OfflineDecodeBudget::new();
    let bytes = object(c, ItemKind::BlobPart, 1, vec![8; 32]);
    let checksum = sha256(&bytes);
    assert!(
        OfflineReplayVerifier::validate_object_with_budget(
            &c,
            &checksum,
            18,
            bytes.len() as u64,
            &checksum,
            &bytes,
            &Budget::default()
        )
        .is_err()
    );
    OfflineReplayVerifier::validate_object_with_budget(
        &c,
        &checksum,
        18,
        bytes.len() as u64,
        &checksum,
        &bytes,
        &work.request(),
    )
    .unwrap();
    assert!(
        OfflineReplayVerifier::validate_object_with_budget(
            &c,
            &checksum,
            18,
            bytes.len() as u64 + 1,
            &checksum,
            &bytes,
            &work.request()
        )
        .is_err()
    );
    assert!(work.request().raw(&[0xf6]).is_err());
}

#[test]
fn any_push_or_constructor_error_poison_other_instances_and_finish() {
    let (cp, c, _, items) = fixture();
    let work = OfflineDecodeBudget::new();
    let mut replay = OfflineReplayVerifier::new(c, 1, &[cp.root_pk()], &work).unwrap();
    let mut other = OfflineReplayVerifier::new(c, 1, &[cp.root_pk()], &work).unwrap();
    assert!(replay.push(2, &items[1]).is_err());
    assert!(other.push(1, &items[0]).is_err());
    assert!(other.finish(1, &chain_hash(&items[0])).is_err());
    let work = OfflineDecodeBudget::new();
    let mut replay = OfflineReplayVerifier::new(c, 1, &[cp.root_pk()], &work).unwrap();
    assert!(OfflineReplayVerifier::new(B16([0; 16]), 1, &[cp.root_pk()], &work).is_err());
    assert!(replay.push(1, &items[0]).is_err());
}

#[test]
fn state_cap_is_checked_before_new_policy_key_insertion() {
    let mut set = BTreeSet::new();
    for index in 0..STATE_CAP {
        let mut bytes = [0; 16];
        bytes[..8].copy_from_slice(&(index as u64).to_be_bytes());
        insert(&mut set, B16(bytes)).unwrap();
    }
    insert(&mut set, B16([0; 16])).unwrap();
    let before = set.len();
    assert!(insert(&mut set, B16([0xff; 16])).is_err());
    assert_eq!(set.len(), before);
}
