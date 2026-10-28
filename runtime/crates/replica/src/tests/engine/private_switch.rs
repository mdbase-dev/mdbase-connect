//! Switch-set acceptance and durable restart boundaries; the ordinary policy
//! remains unchanged and independently refuses malformed or non-keyed signers.
use super::*;
use crate::testkit::TEST_OWNER;
use mdbn_wire::envelope::{Item, ItemKind, RekeyPayload, RekeyReason};
use mdbn_wire::policy::{CState, CollectionState, DeviceKind, DeviceRevoke, PolicyOp};
use mdbn_wire::schema::Wire;

fn world() -> (FakeLogService, crate::testkit::TestControlPlane) {
    let svc = FakeLogService::new();
    let cp = cloud_copy_genesis(
        &svc,
        &[
            (101, TEST_OWNER, DeviceKind::Desktop),
            (104, OTHER, DeviceKind::Desktop),
        ],
    );
    initial_rekey_by(&svc, 2);
    (svc, cp)
}
fn device(svc: &FakeLogService, n: u8, store: MemStore) -> Node {
    let mut node = node_with(svc, n, store, vec![], None);
    if node.r.accepted_private_switch().is_none() {
        node.r.cfg.chosen_state = Some(CState::CloudCopy);
        node.r.cfg.user_enabled_cloud_copy = true;
        node.r.check_key_trust();
    }
    node
}
fn switch(cp: &mut crate::testkit::TestControlPlane, svc: &FakeLogService) -> u64 {
    cp.append(
        svc,
        vec![
            PolicyOp::DeviceRevoke(DeviceRevoke {
                device: B16([102; 16]),
            }),
            PolicyOp::DeviceRevoke(DeviceRevoke {
                device: B16([103; 16]),
            }),
            PolicyOp::CollectionState(CollectionState {
                state: CState::E2e,
                compress: None,
                min_sem_major: None,
            }),
        ],
    )
}
fn direct_rekey(node: &mut Node, reason: RekeyReason) {
    let rs = node
        .r
        .policy
        .rekey_recipients()
        .into_iter()
        .map(|device| crate::crypto::keys::Recipient {
            device,
            kem_pk: node.r.policy.devices[&device].kem_pk.0,
        })
        .collect::<Vec<_>>();
    let payload = node
        .r
        .sealer
        .build_rekey(
            node.r.policy.epoch,
            &rs,
            reason,
            &mut crate::crypto::TestEntropy::new(9),
        )
        .unwrap();
    assert!(
        node.r
            .append_control(ItemKind::Rekey, payload.to_bytes().unwrap())
    );
}

#[test]
fn hosted_keyed_devices_switch_only_after_the_owner_rekey_and_restore_each_boundary() {
    let (svc, mut cp) = world();
    let owner_store = MemStore::new();
    let owner_data = owner_store.data();
    let other_store = MemStore::new();
    let other_data = other_store.data();
    let mut a = device(&svc, 1, owner_store);
    let mut b = device(&svc, 4, other_store);
    settle(&mut [&mut a, &mut b]);
    assert!(!a.r.key_untrusted && !b.r.key_untrusted);
    // An observer gets the flag but no owner has persisted intent yet.
    let ps = switch(&mut cp, &svc);
    settle(&mut [&mut a, &mut b]);
    assert_eq!(a.r.head().seq, ps);
    assert_eq!(a.r.policy.epoch, 1);
    for node in [&a, &b] {
        assert!(node.r.private_switch_waiting());
        assert!(node.r.key_untrusted);
        assert_eq!(node.r.cfg.chosen_state, Some(CState::CloudCopy));
        assert!(node.r.accepted_private_switch().is_none());
        assert!(node.r.serves_apps().is_err());
    }
    drop(a);
    drop(b);
    let mut a = device(&svc, 1, MemStore::shared(owner_data.clone()));
    let mut b = device(&svc, 4, MemStore::shared(other_data.clone()));
    assert!(a.r.private_switch_waiting() && b.r.private_switch_waiting());
    a.r.request_private_switch(a.s).unwrap(); // Finish on an owner from the frozen set.
    drop(a); // crash AFTER the local intent commit but BEFORE the append
    let mut a = device(&svc, 1, MemStore::shared(owner_data.clone()));
    a.log.faults.lose_replies = 1;
    settle(&mut [&mut a, &mut b]);
    a.clock.set(a.clock.get() + 5_000);
    settle(&mut [&mut a, &mut b]);
    assert_eq!(a.r.policy.epoch, 2);
    assert_eq!(b.r.policy.epoch, 2);
    let items = svc.items(&COL);
    let item = Item::from_bytes(items.last().unwrap()).unwrap();
    assert_eq!(item.seq, Some(ps + 1));
    assert_eq!(item.signer, Some(B16([101; 16])));
    assert_eq!(
        RekeyPayload::from_bytes(&item.body.0).unwrap().reason,
        RekeyReason::CloudCopyOff
    );
    for node in [&a, &b] {
        assert_eq!(node.r.accepted_private_switch(), Some(B16([101; 16])));
        assert_eq!(node.r.cfg.chosen_state, Some(CState::E2e));
        assert!(!node.r.cfg.user_enabled_cloud_copy);
        assert!(!node.r.key_untrusted);
        assert!(node.r.serves_apps().is_ok());
    }
    drop(a);
    drop(b);
    let mut a = device(&svc, 1, MemStore::shared(owner_data));
    let mut b = device(&svc, 4, MemStore::shared(other_data));
    settle(&mut [&mut a, &mut b]);
    assert_eq!(
        svc.head(&COL).0,
        ps + 1,
        "no second rekey after restart or lost response"
    );
    for node in [&a, &b] {
        assert_eq!(node.r.cfg.chosen_state, Some(CState::E2e));
        assert!(!node.r.key_untrusted);
    }
}

#[test]
fn intent_is_durable_before_the_switch_and_an_editor_cannot_request_authoring() {
    let (svc, mut cp) = world();
    let store = MemStore::new();
    let data = store.data();
    let mut a = device(&svc, 1, store);
    let mut b = device(&svc, 4, MemStore::new());
    settle(&mut [&mut a, &mut b]);
    assert!(b.r.request_private_switch(b.s).is_err());
    a.r.request_private_switch(a.s).unwrap();
    drop(a);
    let mut a = device(&svc, 1, MemStore::shared(data));
    let ps = switch(&mut cp, &svc);
    settle(&mut [&mut a, &mut b]);
    assert_eq!(svc.head(&COL).0, ps + 1);
    assert!(b.r.accepted_private_switch().is_some());
}

#[test]
fn the_first_valid_non_owner_rekey_does_not_carry_over_trust() {
    let (svc, mut cp) = world();
    let mut a = device(&svc, 1, MemStore::new());
    let mut b = device(&svc, 4, MemStore::new());
    settle(&mut [&mut a, &mut b]);
    switch(&mut cp, &svc);
    settle(&mut [&mut a, &mut b]);
    direct_rekey(&mut b, RekeyReason::CloudCopyOff);
    settle(&mut [&mut a, &mut b]);
    assert_eq!(
        a.r.policy.epoch, 2,
        "ordinary replay still accepts an editor's valid rekey"
    );
    assert!(a.r.key_untrusted && b.r.key_untrusted);
    assert!(a.r.accepted_private_switch().is_none());
    assert_eq!(a.r.cfg.chosen_state, Some(CState::CloudCopy));
}

#[test]
fn an_intervening_item_or_wrong_reason_permanently_consumes_the_exception() {
    for intervening in [false, true] {
        let (svc, mut cp) = world();
        let store = MemStore::new();
        let data = store.data();
        let mut a = device(&svc, 1, store);
        let mut b = device(&svc, 4, MemStore::new());
        settle(&mut [&mut a, &mut b]);
        switch(&mut cp, &svc);
        settle(&mut [&mut a, &mut b]);
        if intervening {
            cp.append(
                &svc,
                vec![PolicyOp::CollectionState(CollectionState {
                    state: CState::E2e,
                    compress: Some(false),
                    min_sem_major: None,
                })],
            );
            settle(&mut [&mut a, &mut b]);
        }
        direct_rekey(
            &mut a,
            if intervening {
                RekeyReason::CloudCopyOff
            } else {
                RekeyReason::DeviceRevoked
            },
        );
        settle(&mut [&mut a, &mut b]);
        assert!(b.r.key_untrusted);
        assert!(b.r.accepted_private_switch().is_none());
        drop(a);
        let mut a = device(&svc, 1, MemStore::shared(data));
        settle(&mut [&mut a]);
        assert!(a.r.key_untrusted);
        assert!(a.r.request_private_switch(a.s).is_err());
    }
}

#[test]
fn an_unkeyed_non_set_signer_cannot_manufacture_the_switch_key() {
    let (svc, mut cp) = world();
    let mut a = device(&svc, 1, MemStore::new());
    settle(&mut [&mut a]);
    let ps = switch(&mut cp, &svc);
    settle(&mut [&mut a]);
    let mut outsider = node(&svc, 5, MemStore::new());
    settle(&mut [&mut outsider]);
    direct_rekey(&mut outsider, RekeyReason::CloudCopyOff);
    settle(&mut [&mut a, &mut outsider]);
    assert_eq!(a.r.policy.epoch, 1);
    assert!(a.r.head().seq > ps);
    assert!(a.r.key_untrusted);
    assert!(a.r.accepted_private_switch().is_none());
}

#[test]
fn failed_or_unknown_prefix_commits_never_publish_tentative_private_trust() {
    for boundary in [0, 1] {
        for fault in 0..3 {
            let (svc, mut cp) = world();
            let store = MemStore::new();
            let data = store.data();
            let mut a = device(&svc, 1, MemStore::new());
            let mut b = device(&svc, 4, store);
            settle(&mut [&mut a, &mut b]);
            let ps = switch(&mut cp, &svc);
            if boundary == 1 {
                settle(&mut [&mut a, &mut b]);
                a.r.request_private_switch(a.s).unwrap();
                settle(&mut [&mut a]);
            }
            let position = ps + boundary;
            let item = mdbn_wire::log_service::SeqItem {
                seq: position,
                item: mdbn_wire::common::Bytes(svc.items(&COL)[position as usize - 1].clone()),
            };
            match fault {
                0 => b.r.store().fail_commits(1),
                1 => b.r.store().fail_unknown_commits(1),
                _ => b.r.store().fail_after_commit(1),
            }
            b.r.apply_items(vec![item]);
            assert!(
                b.r.accepted_private_switch().is_none(),
                "no tentative acceptance escapes"
            );
            assert_eq!(b.r.cfg.chosen_state, Some(CState::CloudCopy));
            drop(b);
            let mut b = device(&svc, 4, MemStore::shared(data));
            settle(&mut [&mut b]);
            if boundary == 0 {
                assert!(b.r.private_switch_waiting());
                a.r.request_private_switch(a.s).unwrap();
                settle(&mut [&mut a, &mut b]);
            }
            assert_eq!(b.r.cfg.chosen_state, Some(CState::E2e));
            assert!(!b.r.key_untrusted);
        }
    }
}
