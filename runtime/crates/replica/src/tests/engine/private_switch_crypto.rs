//! Actual signatures, HPKE wraps and commitments for switch-set acceptance.
use super::*;
use crate::crypto::{hpke::KemKeyPair, sign::DeviceSigner};
use crate::seal::KeyringSealer;
use crate::testkit::{TEST_OWNER, TestControlPlane};
use mdbn_wire::envelope::{ItemKind, RekeyReason};
use mdbn_wire::policy::{CState, CollectionState, DeviceEnrol, DeviceKind, DeviceRevoke, PolicyOp};
use mdbn_wire::schema::Wire;
const SIGN: [u8; 32] = [0x31; 32];
const KEM: [u8; 32] = [0x32; 32];
fn real_world() -> (FakeLogService, TestControlPlane, Node, Node) {
    let svc = FakeLogService::new();
    let mut cp = TestControlPlane::signed(COL);
    cp.genesis_with_keys(&svc, CState::CloudCopy, B16([101; 16]), &SIGN, &KEM);
    cp.append(
        &svc,
        [
            (102, DeviceKind::Hosted),
            (103, DeviceKind::Escrow),
            (104, DeviceKind::Mobile),
        ]
        .into_iter()
        .map(|(id, kind)| {
            PolicyOp::DeviceEnrol(DeviceEnrol {
                device: B16([id; 16]),
                account: if id == 104 {
                    TEST_OWNER
                } else {
                    crate::policy::SERVICE_ACCOUNT
                },
                kind,
                sign_pk: B32(DeviceSigner::from_seed(&[id; 32]).public()),
                kem_pk: B32(KemKeyPair::from_secret(&[id; 32]).pk),
                noise_pk: B32([id; 32]),
                sas_commit: None,
                local_root: None,
            })
        })
        .collect(),
    );
    let open = |n, sign: &[u8; 32], kem: &[u8; 32]| {
        let mut node = node_with(
            &svc,
            n,
            MemStore::new().with_keyring_rebuild(),
            vec![],
            Some(Box::new(KeyringSealer::new(
                COL,
                B16([100 + n; 16]),
                sign,
                kem,
            ))),
        );
        node.r.cfg.chosen_state = Some(CState::CloudCopy);
        node.r.cfg.user_enabled_cloud_copy = true;
        node.r.check_key_trust();
        node
    };
    let mut hosted = open(2, &[102; 32], &[102; 32]);
    settle(&mut [&mut hosted]);
    let mut a = open(1, &SIGN, &KEM);
    let mut b = open(4, &[104; 32], &[104; 32]);
    settle(&mut [&mut a, &mut b]);
    assert_eq!(a.r.policy.epoch, 1);
    assert!(!a.r.key_untrusted && !b.r.key_untrusted);
    (svc, cp, a, b)
}
fn switch(cp: &mut TestControlPlane, svc: &FakeLogService) {
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
    );
}
#[test]
fn real_hosted_introduced_observer_accepts_only_the_owner_signed_private_epoch() {
    let (svc, mut cp, mut a, mut b) = real_world();
    a.r.request_private_switch(a.s).unwrap();
    switch(&mut cp, &svc);
    settle(&mut [&mut a, &mut b]);
    assert_eq!(b.r.accepted_private_switch(), Some(B16([101; 16])));
    assert!(!b.r.key_untrusted);
    assert_eq!(a.r.testing_epoch_keys(), b.r.testing_epoch_keys());
    a.create(1, "private.md", "after the service lost its keys");
    settle(&mut [&mut a, &mut b]);
    assert_eq!(b.doc(1).as_deref(), Some("after the service lost its keys"));
    let data = b.r.store().data();
    b.r.acknowledge_private_switch(b.s).unwrap();
    assert!(b.r.accepted_private_switch().is_none());
    drop(b);
    let mut reopened = node_with(
        &svc,
        4,
        MemStore::shared(data),
        vec![],
        Some(Box::new(KeyringSealer::new(
            COL,
            B16([104; 16]),
            &[104; 32],
            &[104; 32],
        ))),
    );
    settle(&mut [&mut reopened]);
    assert_eq!(reopened.r.cfg.chosen_state, Some(CState::E2e));
    assert!(!reopened.r.key_untrusted);
    assert_eq!(reopened.r.testing_epoch_keys(), a.r.testing_epoch_keys());
    assert!(
        !reopened
            .r
            .sync_status()
            .incidents
            .iter()
            .any(|i| i.kind == mdbn_wire::client::IncidentKind::Integrity),
        "historical cloud-copy genesis is covered by the accepted prefix witness"
    );
}
#[test]
fn a_signed_rekey_with_a_bad_commitment_never_installs_private_choice() {
    let (svc, mut cp, mut a, mut b) = real_world();
    switch(&mut cp, &svc);
    settle(&mut [&mut a, &mut b]);
    let rs =
        a.r.policy
            .rekey_recipients()
            .into_iter()
            .map(|device| crate::crypto::keys::Recipient {
                device,
                kem_pk: a.r.policy.devices[&device].kem_pk.0,
            })
            .collect::<Vec<_>>();
    let mut payload =
        a.r.sealer
            .build_rekey(
                1,
                &rs,
                RekeyReason::CloudCopyOff,
                &mut crate::crypto::TestEntropy::new(43),
            )
            .unwrap();
    payload.commit = B32([0; 32]);
    assert!(a.r.append_control(ItemKind::Rekey, payload.to_bytes().unwrap()));
    settle(&mut [&mut a, &mut b]);
    assert_eq!(b.r.policy.epoch, 2);
    assert!(b.r.accepted_private_switch().is_none());
    assert!(b.r.key_untrusted);
    assert_eq!(b.r.cfg.chosen_state, Some(CState::CloudCopy));
}

#[test]
fn another_owner_from_the_switch_set_can_finish_when_the_original_device_is_gone() {
    let (svc, mut cp, mut a, mut b) = real_world();
    switch(&mut cp, &svc);
    settle(&mut [&mut a, &mut b]);
    let data = a.r.store().data();
    drop(a);
    b.r.request_private_switch(b.s).unwrap();
    settle(&mut [&mut b]);
    assert_eq!(b.r.accepted_private_switch(), Some(B16([104; 16])));
    let mut reopened = node_with(
        &svc,
        1,
        MemStore::shared(data),
        vec![],
        Some(Box::new(KeyringSealer::new(
            COL,
            B16([101; 16]),
            &SIGN,
            &KEM,
        ))),
    );
    reopened.r.cfg.chosen_state = Some(CState::CloudCopy);
    reopened.r.cfg.user_enabled_cloud_copy = true;
    settle(&mut [&mut reopened]);
    assert_eq!(reopened.r.accepted_private_switch(), Some(B16([104; 16])));
    assert_eq!(reopened.r.cfg.chosen_state, Some(CState::E2e));
    assert!(!reopened.r.key_untrusted);
}

/// The accepted switch set is local Private trust. Replay history remains
/// untouched, but a set member can author later ordinary Private key delivery.
#[test]
fn later_private_rekey_from_another_switch_set_device_is_trusted_locally() {
    let (svc, mut cp, mut a, mut b) = real_world();
    a.r.request_private_switch(a.s).unwrap();
    switch(&mut cp, &svc);
    settle(&mut [&mut a, &mut b]);
    assert!(!a.r.key_untrusted && !b.r.key_untrusted);
    assert_eq!(
        b.r.policy.devices[&B16([104; 16])].introduced_by,
        Some(B16([102; 16]))
    );
    let recipients =
        b.r.policy
            .rekey_recipients()
            .into_iter()
            .map(|device| crate::crypto::keys::Recipient {
                device,
                kem_pk: b.r.policy.devices[&device].kem_pk.0,
            })
            .collect::<Vec<_>>();
    let rekey =
        b.r.sealer
            .build_rekey(
                2,
                &recipients,
                RekeyReason::Scheduled,
                &mut crate::crypto::TestEntropy::new(47),
            )
            .unwrap();
    assert!(b.r.append_control(ItemKind::Rekey, rekey.to_bytes().unwrap()));
    settle(&mut [&mut a, &mut b]);
    assert_eq!(a.r.policy.epoch, 3);
    assert_eq!(
        a.r.testing_epoch_keys(),
        b.r.testing_epoch_keys(),
        "unwrap succeeded; this is a trust-chain issue, not missing keys"
    );
    assert!(!b.r.key_untrusted, "the author trusts its own key");
    assert!(
        !a.r.key_untrusted,
        "the accepted switch set is trusted for future key delivery"
    );
}

#[test]
fn a_post_switch_hosted_introduction_is_not_added_by_a_later_server_mode_cycle() {
    let (svc, mut cp, mut a, mut b) = real_world();
    a.r.request_private_switch(a.s).unwrap();
    switch(&mut cp, &svc);
    settle(&mut [&mut a, &mut b]);
    a.r.choose_cloud_copy(a.s).unwrap();
    assert_eq!(a.r.cloud_copy_source_epoch(), Some(2));
    let mut ops = Vec::new();
    for (id, kind) in [
        (105, DeviceKind::Hosted),
        (106, DeviceKind::Escrow),
        (107, DeviceKind::Mobile),
    ] {
        ops.push(PolicyOp::DeviceEnrol(DeviceEnrol {
            device: B16([id; 16]),
            account: if id == 107 {
                TEST_OWNER
            } else {
                crate::policy::SERVICE_ACCOUNT
            },
            kind,
            sign_pk: B32(DeviceSigner::from_seed(&[id; 32]).public()),
            kem_pk: B32(KemKeyPair::from_secret(&[id; 32]).pk),
            noise_pk: B32([id; 32]),
            sas_commit: None,
            local_root: None,
        }));
    }
    ops.push(PolicyOp::CollectionState(CollectionState {
        state: CState::CloudCopy,
        compress: None,
        min_sem_major: None,
    }));
    cp.append(&svc, ops);
    settle(&mut [&mut a, &mut b]);
    assert!(b.r.key_untrusted, "B did not opt back into Cloud copy");
    for id in [105, 106] {
        let payload =
            a.r.sealer
                .build_key_grant(
                    2,
                    &crate::crypto::keys::Recipient {
                        device: B16([id; 16]),
                        kem_pk: KemKeyPair::from_secret(&[id; 32]).pk,
                    },
                    &mut crate::crypto::TestEntropy::new(id),
                )
                .unwrap();
        assert!(a.r.append_control(ItemKind::KeyGrant, payload.to_bytes().unwrap()));
        settle(&mut [&mut a, &mut b]);
    }
    let mut hosted = node_with(
        &svc,
        5,
        MemStore::new(),
        vec![],
        Some(Box::new(KeyringSealer::new(
            COL,
            B16([105; 16]),
            &[105; 32],
            &[105; 32],
        ))),
    );
    hosted.r.cfg.chosen_state = Some(CState::CloudCopy);
    hosted.r.cfg.user_enabled_cloud_copy = true;
    let mut newcomer = node_with(
        &svc,
        7,
        MemStore::new(),
        vec![],
        Some(Box::new(KeyringSealer::new(
            COL,
            B16([107; 16]),
            &[107; 32],
            &[107; 32],
        ))),
    );
    newcomer.r.cfg.chosen_state = Some(CState::CloudCopy);
    newcomer.r.cfg.user_enabled_cloud_copy = true;
    settle(&mut [&mut a, &mut b, &mut hosted, &mut newcomer]);
    assert_eq!(
        newcomer.r.policy.devices[&B16([107; 16])].introduced_by,
        Some(B16([105; 16]))
    );
    assert_eq!(
        newcomer.r.testing_epoch_keys().last(),
        a.r.testing_epoch_keys().last()
    );
    a.r.request_private_switch(a.s).unwrap();
    cp.append(
        &svc,
        vec![
            PolicyOp::DeviceRevoke(DeviceRevoke {
                device: B16([105; 16]),
            }),
            PolicyOp::DeviceRevoke(DeviceRevoke {
                device: B16([106; 16]),
            }),
            PolicyOp::CollectionState(CollectionState {
                state: CState::E2e,
                compress: None,
                min_sem_major: None,
            }),
        ],
    );
    settle(&mut [&mut a, &mut b, &mut newcomer]);
    assert_eq!(b.r.policy.epoch, 3);
    assert!(!b.r.key_untrusted);
    assert!(
        !b.r.cfg.trusted_signers.contains(&B16([107; 16])),
        "B's original S was not widened"
    );
    let recipients = newcomer
        .r
        .policy
        .rekey_recipients()
        .into_iter()
        .map(|device| crate::crypto::keys::Recipient {
            device,
            kem_pk: newcomer.r.policy.devices[&device].kem_pk.0,
        })
        .collect::<Vec<_>>();
    let payload = newcomer
        .r
        .sealer
        .build_rekey(
            3,
            &recipients,
            RekeyReason::Scheduled,
            &mut crate::crypto::TestEntropy::new(53),
        )
        .unwrap();
    assert!(
        newcomer
            .r
            .append_control(ItemKind::Rekey, payload.to_bytes().unwrap())
    );
    settle(&mut [&mut a, &mut b, &mut newcomer]);
    assert_eq!(b.r.policy.epoch, 4);
    assert_eq!(
        b.r.testing_epoch_keys().last(),
        newcomer.r.testing_epoch_keys().last(),
        "unwrap succeeds; local trust is the refusal"
    );
    assert!(
        b.r.key_untrusted,
        "a post-switch hosted introduction needs normal Private trust on B"
    );
    assert!(!a.r.key_untrusted && !newcomer.r.key_untrusted);
}
