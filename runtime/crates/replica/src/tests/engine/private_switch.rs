//! Switch-set acceptance and durable restart boundaries; the ordinary policy
//! remains unchanged and independently refuses malformed or non-keyed signers.
use super::*;
use crate::testkit::TEST_OWNER;
use mdbn_wire::envelope::{Item, ItemKind, RekeyPayload, RekeyReason};
use mdbn_wire::policy::{CState, CollectionState, DeviceKind, DeviceRevoke, PolicyOp};
use mdbn_wire::schema::Wire;
use std::collections::BTreeSet;

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
fn a_wrong_reason_first_rekey_permanently_consumes_the_exception() {
    for abandoned in [false, true] {
        let (svc, mut cp) = world();
        let store = MemStore::new();
        let data = store.data();
        let mut a = device(&svc, 1, store);
        let mut b = device(&svc, 4, MemStore::new());
        settle(&mut [&mut a, &mut b]);
        switch(&mut cp, &svc);
        settle(&mut [&mut a, &mut b]);
        if abandoned {
            // The editor's ordinary rekey wins the released slot before the owner.
            reassert_private(&mut cp, &svc);
            settle(&mut [&mut b]);
            direct_rekey(&mut b, RekeyReason::DeviceRevoked);
            settle(&mut [&mut b]);
        } else {
            direct_rekey(&mut a, RekeyReason::DeviceRevoked);
        }
        settle(&mut [&mut a, &mut b]);
        assert_eq!(
            b.r.policy.epoch, 2,
            "ordinary policy still accepts the rekey"
        );
        assert!(b.r.key_untrusted);
        assert!(b.r.accepted_private_switch().is_none());
        drop(a);
        let mut a = device(&svc, 1, MemStore::shared(data));
        settle(&mut [&mut a]);
        assert!(a.r.key_untrusted);
        assert!(a.r.request_private_switch(a.s).is_err());
    }
}

/// Owner 101 requests and is lost before its adjacent rekey; 105 is the other
/// owner desktop and 104 another member's editor desktop.
fn abandoned_world() -> (FakeLogService, crate::testkit::TestControlPlane) {
    let svc = FakeLogService::new();
    let cp = cloud_copy_genesis(
        &svc,
        &[
            (101, TEST_OWNER, DeviceKind::Desktop),
            (105, TEST_OWNER, DeviceKind::Desktop),
            (104, OTHER, DeviceKind::Desktop),
        ],
    );
    initial_rekey_by(&svc, 2);
    (svc, cp)
}
/// A control-plane item that occupies the released slot without a rekey.
fn reassert_private(cp: &mut crate::testkit::TestControlPlane, svc: &FakeLogService) -> u64 {
    cp.append(
        svc,
        vec![PolicyOp::CollectionState(CollectionState {
            state: CState::E2e,
            compress: None,
            min_sem_major: None,
        })],
    )
}
fn last_rekey(svc: &FakeLogService) -> (Item, RekeyPayload) {
    let item = Item::from_bytes(svc.items(&COL).last().unwrap()).unwrap();
    assert_eq!(item.kind, ItemKind::Rekey);
    let rekey = RekeyPayload::from_bytes(&item.body.0).unwrap();
    (item, rekey)
}

#[test]
fn a_surviving_owner_rekeys_automatically_after_an_abandoned_slot() {
    // 0: CP item; 1: the owner revokes the lost requester; 2: an existing key
    // holder grants the old epoch to a new device, which must not wedge rotation.
    for occupant in 0..3 {
        let revoke_lost = occupant == 1;
        let (svc, mut cp) = abandoned_world();
        let mut lost = device(&svc, 1, MemStore::new());
        let owner_store = MemStore::new();
        let owner_data = owner_store.data();
        let editor_store = MemStore::new();
        let editor_data = editor_store.data();
        let mut owner = device(&svc, 5, owner_store);
        let mut editor = device(&svc, 4, editor_store);
        settle(&mut [&mut lost, &mut owner, &mut editor]);
        lost.r.request_private_switch(lost.s).unwrap();
        drop(lost);
        let ps = switch(&mut cp, &svc);
        settle(&mut [&mut owner, &mut editor]);
        // The other owner never requested, so the held adjacent slot stays empty.
        assert_eq!(svc.head(&COL).0, ps);
        assert!(owner.r.private_switch_waiting() && owner.r.key_untrusted);
        // After abandon the next item takes the released slot: usually the
        // owner's revocation of the lost requester. Neither consumes the set.
        let released = match occupant {
            0 => reassert_private(&mut cp, &svc),
            1 => cp.revoke(&svc, B16([101; 16])),
            _ => {
                cp.enrol(
                    &svc,
                    crate::testkit::TestDevice {
                        device: B16([107; 16]),
                        account: TEST_OWNER,
                        kind: DeviceKind::Desktop,
                    },
                );
                let grant = editor
                    .r
                    .sealer
                    .build_key_grant(
                        1,
                        &crate::crypto::keys::Recipient {
                            device: B16([107; 16]),
                            kem_pk: [107; 32],
                        },
                        &mut crate::crypto::TestEntropy::new(51),
                    )
                    .unwrap();
                cp.append_item(
                    &svc,
                    ItemKind::KeyGrant,
                    B16([104; 16]),
                    grant.to_bytes().unwrap(),
                )
            }
        };
        settle(&mut [&mut owner, &mut editor]);
        assert_eq!(svc.head(&COL).0, released + 1);
        let (item, rekey) = last_rekey(&svc);
        assert_eq!(item.signer, Some(B16([105; 16])));
        assert_eq!(rekey.reason, RekeyReason::CloudCopyOff);
        assert_eq!(rekey.from, 1);
        let recipients = rekey
            .wraps
            .iter()
            .map(|w| w.device)
            .collect::<BTreeSet<_>>();
        assert_eq!(recipients.contains(&B16([101; 16])), !revoke_lost);
        assert_eq!(recipients.contains(&B16([107; 16])), occupant == 2);
        assert!(!recipients.iter().any(|id| [102, 103].contains(&id.0[0])));
        for node in [&owner, &editor] {
            assert_eq!(node.r.policy.epoch, 2);
            assert_eq!(node.r.accepted_private_switch(), Some(B16([105; 16])));
            assert_eq!(node.r.cfg.chosen_state, Some(CState::E2e));
            assert!(!node.r.key_untrusted);
            assert!(node.r.serves_apps().is_ok());
        }
        drop(owner);
        drop(editor);
        let mut owner = device(&svc, 5, MemStore::shared(owner_data));
        let mut editor = device(&svc, 4, MemStore::shared(editor_data));
        settle(&mut [&mut owner, &mut editor]);
        assert_eq!(
            svc.head(&COL).0,
            released + 1,
            "exactly one excluding rekey"
        );
        for node in [&owner, &editor] {
            assert_eq!(node.r.cfg.chosen_state, Some(CState::E2e));
            assert!(!node.r.key_untrusted);
        }
    }
}

#[test]
fn an_abandoned_slot_cannot_be_finished_by_a_non_owner() {
    let (svc, mut cp) = world();
    let owner_store = MemStore::new();
    let owner_data = owner_store.data();
    let mut owner = device(&svc, 1, owner_store);
    let mut editor = device(&svc, 4, MemStore::new());
    settle(&mut [&mut owner, &mut editor]);
    switch(&mut cp, &svc);
    settle(&mut [&mut owner, &mut editor]);
    drop(owner);
    reassert_private(&mut cp, &svc);
    settle(&mut [&mut editor]);
    assert!(
        editor.r.private_switch_waiting(),
        "a non-owner does not author"
    );
    direct_rekey(&mut editor, RekeyReason::CloudCopyOff);
    settle(&mut [&mut editor]);
    assert_eq!(editor.r.policy.epoch, 2);
    assert!(editor.r.key_untrusted);
    assert!(editor.r.accepted_private_switch().is_none());
    let mut owner = device(&svc, 1, MemStore::shared(owner_data));
    settle(&mut [&mut owner, &mut editor]);
    assert!(owner.r.key_untrusted);
    assert!(owner.r.accepted_private_switch().is_none());
    assert_eq!(
        svc.head(&COL).0,
        editor.r.head().seq,
        "no owner rekey follows"
    );
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
    settle(&mut [&mut outsider]);
    assert_eq!(outsider.r.policy.epoch, 1, "the outsider's rekey is void");
    // Its void item only occupies the slot; the frozen owner then rotates.
    settle(&mut [&mut a, &mut outsider]);
    assert_eq!(svc.head(&COL).0, ps + 2);
    assert_eq!(a.r.policy.epoch, 2);
    assert_eq!(a.r.accepted_private_switch(), Some(B16([101; 16])));
    assert!(
        a.r.policy
            .devices
            .get(&B16([105; 16]))
            .is_none_or(|d| !d.keyed)
    );
    assert!(!a.r.cfg.trusted_signers.contains(&B16([105; 16])));
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

#[test]
fn completed_private_choice_survives_later_cloud_flags_and_old_epoch_selection() {
    let (svc, mut cp) = world();
    let mut a = device(&svc, 1, MemStore::new());
    settle(&mut [&mut a]);
    a.r.request_private_switch(a.s).unwrap();
    switch(&mut cp, &svc);
    settle(&mut [&mut a]);
    a.r.acknowledge_private_switch(a.s).unwrap();
    // A stale host configuration is not a new explicit local Cloud-copy intent.
    a.r.cfg.chosen_state = Some(CState::CloudCopy);
    a.r.cfg.user_enabled_cloud_copy = true;
    let mut ops = [(105, DeviceKind::Hosted), (106, DeviceKind::Escrow)]
        .into_iter()
        .map(|(id, kind)| {
            PolicyOp::DeviceEnrol(mdbn_wire::policy::DeviceEnrol {
                device: B16([id; 16]),
                account: crate::policy::SERVICE_ACCOUNT,
                kind,
                sign_pk: B32([id; 32]),
                kem_pk: B32([id; 32]),
                noise_pk: B32([id; 32]),
                sas_commit: None,
                local_root: None,
            })
        })
        .collect::<Vec<_>>();
    ops.push(PolicyOp::CollectionState(CollectionState {
        state: CState::CloudCopy,
        compress: None,
        min_sem_major: None,
    }));
    cp.append(&svc, ops);
    settle(&mut [&mut a]);
    assert_eq!(a.r.policy.cstate, Some(CState::CloudCopy));
    assert_eq!(a.r.cfg.chosen_state, Some(CState::E2e));
    assert!(a.r.key_untrusted);
    assert!(
        a.r.policy
            .devices
            .get(&B16([105; 16]))
            .is_none_or(|d| !d.keyed)
    );
    // Even a replayed older Private policy must not make a service-held epoch
    // usable for new Private writes. This is a local acceptance-floor unit check.
    a.r.policy.cstate = Some(CState::E2e);
    a.r.policy.epoch = 1;
    a.r.sealer.set_epoch(1);
    a.r.check_key_trust();
    assert!(a.r.key_untrusted);
}

#[test]
fn revoked_switch_set_member_is_removed_and_cannot_rekey() {
    let (svc, mut cp) = world();
    let mut a = device(&svc, 1, MemStore::new());
    let mut b = device(&svc, 4, MemStore::new());
    settle(&mut [&mut a, &mut b]);
    a.r.request_private_switch(a.s).unwrap();
    switch(&mut cp, &svc);
    settle(&mut [&mut a, &mut b]);
    assert!(b.r.cfg.trusted_signers.contains(&B16([101; 16])));
    cp.revoke(&svc, B16([101; 16]));
    settle(&mut [&mut a, &mut b]);
    assert!(!b.r.cfg.trusted_signers.contains(&B16([101; 16])));
    let epoch = b.r.policy.epoch;
    direct_rekey(&mut a, RekeyReason::Scheduled);
    settle(&mut [&mut a, &mut b]);
    assert_eq!(
        b.r.policy.epoch, epoch,
        "revocation is still enforced by ordinary policy validity"
    );
    assert!(!b.r.key_untrusted);
}

#[test]
fn post_switch_hosted_introduction_and_its_rekey_are_refused() {
    let (svc, mut cp) = world();
    let mut a = device(&svc, 1, MemStore::new());
    let mut b = device(&svc, 4, MemStore::new());
    settle(&mut [&mut a, &mut b]);
    a.r.request_private_switch(a.s).unwrap();
    switch(&mut cp, &svc);
    settle(&mut [&mut a, &mut b]);
    cp.enrol(
        &svc,
        crate::testkit::TestDevice {
            device: B16([107; 16]),
            account: TEST_OWNER,
            kind: DeviceKind::Desktop,
        },
    );
    settle(&mut [&mut a, &mut b]);
    let payload =
        a.r.sealer
            .build_key_grant(
                2,
                &crate::crypto::keys::Recipient {
                    device: B16([107; 16]),
                    kem_pk: [107; 32],
                },
                &mut crate::crypto::TestEntropy::new(49),
            )
            .unwrap();
    // Even a well-shaped grant from the old service is not private approval.
    cp.append_item(
        &svc,
        ItemKind::KeyGrant,
        B16([102; 16]),
        payload.to_bytes().unwrap(),
    );
    settle(&mut [&mut a, &mut b]);
    assert!(!a.r.policy.devices[&B16([107; 16])].keyed);
    assert!(!a.r.cfg.trusted_signers.contains(&B16([107; 16])));
    let mut outsider = node(&svc, 7, MemStore::new());
    settle(&mut [&mut outsider]);
    direct_rekey(&mut outsider, RekeyReason::Scheduled);
    settle(&mut [&mut a, &mut b, &mut outsider]);
    assert_eq!(a.r.policy.epoch, 2);
    assert!(!a.r.key_untrusted && !b.r.key_untrusted);
}
