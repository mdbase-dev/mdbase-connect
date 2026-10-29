//! Actual signatures, HPKE wraps and commitments for switch-set acceptance.
use super::*;
use crate::crypto::{hpke::KemKeyPair, sign::DeviceSigner};
use crate::seal::KeyringSealer;
use crate::store::Store;
use crate::testkit::{TEST_OWNER, TestControlPlane};
use mdbn_wire::envelope::{ItemKind, RekeyReason};
use mdbn_wire::policy::{CState, CollectionState, DeviceEnrol, DeviceKind, DeviceRevoke, PolicyOp};
use mdbn_wire::schema::Wire;
const SIGN: [u8; 32] = [0x31; 32];
const KEM: [u8; 32] = [0x32; 32];
fn real_world() -> (FakeLogService, TestControlPlane, Node, Node) {
    real_world_member(false)
}
fn real_world_member(viewer: bool) -> (FakeLogService, TestControlPlane, Node, Node) {
    real_world_store(viewer, false)
}
fn real_world_store(
    viewer: bool,
    persistent: bool,
) -> (FakeLogService, TestControlPlane, Node, Node) {
    let svc = FakeLogService::new();
    let mut cp = TestControlPlane::signed(COL);
    cp.genesis_with_keys(&svc, CState::CloudCopy, B16([101; 16]), &SIGN, &KEM);
    if viewer {
        cp.append(
            &svc,
            vec![PolicyOp::MemberSet(mdbn_wire::policy::MemberSet {
                account: OTHER,
                role: mdbn_wire::policy::Role::Viewer,
            })],
        );
    }
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
                    if viewer { OTHER } else { TEST_OWNER }
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
            if persistent {
                MemStore::new()
            } else {
                MemStore::new().with_keyring_rebuild()
            },
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
    let original_private_generation = a.r.mode_generation().unwrap();
    assert!(a.r.cloud_copy_candidate().is_some());
    assert!(
        a.r.cloud_copy_source_epoch().is_none(),
        "read-only preflight is not source consent"
    );
    a.r.choose_cloud_copy(a.s).unwrap();
    assert!(
        a.r.accepted_private_switch().is_none(),
        "superseded private acceptance cannot re-project the old choice"
    );
    assert_eq!(a.r.cloud_copy_source_epoch(), Some(2));
    // An editor grant is ordinary validity, not owner authorization to select
    // reading on B. A later promotion must not retroactively authorize it.
    let mut ops = vec![
        PolicyOp::MemberSet(mdbn_wire::policy::MemberSet {
            account: OTHER,
            role: mdbn_wire::policy::Role::Owner,
        }),
        PolicyOp::MemberSet(mdbn_wire::policy::MemberSet {
            account: TEST_OWNER,
            role: mdbn_wire::policy::Role::Editor,
        }),
    ];
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
    cp.append(
        &svc,
        vec![PolicyOp::MemberSet(mdbn_wire::policy::MemberSet {
            account: TEST_OWNER,
            role: mdbn_wire::policy::Role::Owner,
        })],
    );
    settle(&mut [&mut a, &mut b, &mut newcomer]);
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
    assert!(
        a.r.choose_cloud_copy_at(a.s, original_private_generation)
            .is_err(),
        "old source recovery cannot declassify a later Private generation"
    );
    assert!(a.r.cloud_copy_source_epoch().is_none());
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

#[test]
fn revoking_a_later_private_rekey_author_does_not_strand_the_surviving_switch_member() {
    let (svc, mut cp, mut a, mut b) = real_world();
    a.r.request_private_switch(a.s).unwrap();
    switch(&mut cp, &svc);
    settle(&mut [&mut a, &mut b]);
    let recipients =
        b.r.policy
            .rekey_recipients()
            .into_iter()
            .map(|device| crate::crypto::keys::Recipient {
                device,
                kem_pk: b.r.policy.devices[&device].kem_pk.0,
            })
            .collect::<Vec<_>>();
    let later =
        b.r.sealer
            .build_rekey(
                2,
                &recipients,
                RekeyReason::Scheduled,
                &mut crate::crypto::TestEntropy::new(67),
            )
            .unwrap();
    assert!(b.r.append_control(ItemKind::Rekey, later.to_bytes().unwrap()));
    settle(&mut [&mut a, &mut b]);
    assert_eq!(a.r.policy.epoch, 3);
    assert!(!a.r.key_untrusted);
    cp.append(
        &svc,
        vec![PolicyOp::DeviceRevoke(DeviceRevoke {
            device: B16([104; 16]),
        })],
    );
    settle(&mut [&mut a, &mut b]);
    assert_eq!(
        a.r.policy.epoch, 4,
        "survivor can author the excluding rekey under the already trusted epoch"
    );
    assert!(!a.r.key_untrusted);
    assert!(!a.r.cfg.trusted_signers.contains(&B16([104; 16])));
    let recipients =
        a.r.policy
            .rekey_recipients()
            .into_iter()
            .map(|device| crate::crypto::keys::Recipient {
                device,
                kem_pk: a.r.policy.devices[&device].kem_pk.0,
            })
            .collect::<Vec<_>>();
    let forged =
        a.r.sealer
            .build_rekey(
                4,
                &recipients,
                RekeyReason::Scheduled,
                &mut crate::crypto::TestEntropy::new(68),
            )
            .unwrap();
    assert!(b.r.append_control(ItemKind::Rekey, forged.to_bytes().unwrap()));
    settle(&mut [&mut a, &mut b]);
    assert_eq!(
        a.r.policy.epoch, 4,
        "a real signature from the revoked member is refused"
    );
}

#[test]
fn receiver_cloud_read_is_automatic_but_never_owner_source_consent() {
    let (svc, mut cp, mut a, mut b) = real_world_member(true);
    a.r.request_private_switch(a.s).unwrap();
    switch(&mut cp, &svc);
    settle(&mut [&mut a, &mut b]);
    let data = b.r.store().data();
    a.r.choose_cloud_copy(a.s).unwrap();
    receiver_cloud_policy(&mut cp, &svc);
    settle(&mut [&mut a, &mut b]);
    assert_eq!(b.r.cloud_read_owner(), Some(B16([101; 16])));
    assert_eq!(b.r.cfg.chosen_state, Some(CState::CloudCopy));
    assert!(!b.r.key_untrusted);
    assert!(b.r.cloud_copy_source_epoch().is_none());
    cp.append(
        &svc,
        vec![PolicyOp::MemberSet(mdbn_wire::policy::MemberSet {
            account: OTHER,
            role: mdbn_wire::policy::Role::Owner,
        })],
    );
    settle(&mut [&mut a, &mut b]);
    assert!(
        b.r.cloud_copy_source_epoch().is_none(),
        "promotion never manufactures source consent"
    );
    drop(b);
    let mut b = node_with(
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
    settle(&mut [&mut b]);
    assert_eq!(b.r.cloud_read_owner(), Some(B16([101; 16])));
    assert_eq!(b.r.cfg.chosen_state, Some(CState::CloudCopy));
    assert!(b.r.cloud_copy_source_epoch().is_none());
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
    settle(&mut [&mut a, &mut b, &mut hosted]);
    let recipients = hosted
        .r
        .policy
        .rekey_recipients()
        .into_iter()
        .map(|device| crate::crypto::keys::Recipient {
            device,
            kem_pk: hosted.r.policy.devices[&device].kem_pk.0,
        })
        .collect::<Vec<_>>();
    let next = hosted
        .r
        .sealer
        .build_rekey(
            2,
            &recipients,
            RekeyReason::Scheduled,
            &mut crate::crypto::TestEntropy::new(105),
        )
        .unwrap();
    assert!(
        hosted
            .r
            .append_control(ItemKind::Rekey, next.to_bytes().unwrap())
    );
    settle(&mut [&mut a, &mut b, &mut hosted]);
    assert_eq!(b.r.policy.epoch, 3);
    assert!(
        !b.r.key_untrusted,
        "receiver uses ordinary Cloud service trust after selection"
    );
    assert!(
        b.r.cloud_copy_source_epoch().is_none(),
        "a service rekey cannot create source consent"
    );
    assert!(
        b.r.cloud_copy_candidate().is_some(),
        "read-only eligibility is not consent"
    );
    b.r.choose_cloud_copy(b.s).unwrap();
    assert_eq!(
        b.r.cloud_copy_source_epoch(),
        Some(3),
        "this owner's own explicit choice is required"
    );
}

#[test]
fn born_cloud_receiver_cold_replay_after_private_return_has_no_fatal_incident() {
    for viewer in [false, true] {
        let (svc, mut cp, mut a, mut b) = real_world_member(viewer);
        a.r.request_private_switch(a.s).unwrap();
        switch(&mut cp, &svc);
        settle(&mut [&mut a, &mut b]);
        a.create(91, "lab-private-a.md", "private epoch two");
        settle(&mut [&mut a, &mut b]);
        assert_eq!(b.r.policy.epoch, 2);
        b.r.acknowledge_private_switch(b.s).unwrap();
        let data = b.r.store().data();
        drop(b); // LAB B was offline during A's explicit reverse handover.
        a.r.choose_cloud_copy(a.s).unwrap();
        receiver_cloud_policy(&mut cp, &svc);
        settle(&mut [&mut a]);
        let mut b = node_with(
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
        settle(&mut [&mut b]);
        assert_eq!(b.r.cloud_read_owner(), Some(B16([101; 16])));
        assert!(b.r.cloud_copy_source_epoch().is_none());
        assert_eq!(b.doc(91).as_deref(), Some("private epoch two"));
        assert!(
            !b.r.sync_status().incidents.iter().any(|i| matches!(
                i.kind,
                mdbn_wire::client::IncidentKind::Integrity
                    | mdbn_wire::client::IncidentKind::KeyInconsistent
            )),
            "cold returned-to-Cloud receiver must be usable, not merely selected: {:?}",
            b.r.sync_status().incidents,
        );
    }
}

#[test]
fn receiver_read_selection_never_clears_unrelated_integrity() {
    let (svc, mut cp, mut a, mut b) = real_world();
    a.r.request_private_switch(a.s).unwrap();
    switch(&mut cp, &svc);
    settle(&mut [&mut a, &mut b]);
    let unrelated = mdbn_wire::common::Value::Text("fixture unrelated integrity".into());
    b.r.incident(
        mdbn_wire::client::IncidentKind::Integrity,
        Some(unrelated.clone()),
    );
    receiver_cloud_policy(&mut cp, &svc);
    settle(&mut [&mut a, &mut b]);
    assert!(
        b.r.sync_status().incidents.iter().any(|i| i.details
            == Some(mdbn_wire::common::Value::Text(
                "collection_state_changed: CloudCopy".into()
            ))),
        "mode alert must remain visible alongside an unrelated Integrity incident"
    );
    a.r.choose_cloud_copy(a.s).unwrap();
    settle(&mut [&mut a, &mut b]);
    assert_eq!(b.r.cloud_read_owner(), Some(B16([101; 16])));
    assert!(!b.r.sync_status().incidents.iter().any(|i| i.details
        == Some(mdbn_wire::common::Value::Text(
            "collection_state_changed: CloudCopy".into()
        ))));
    assert!(
        b.r.sync_status()
            .incidents
            .iter()
            .any(|i| i.kind == mdbn_wire::client::IncidentKind::Integrity
                && i.details == Some(unrelated.clone()))
    );
    assert!(b.r.cloud_copy_source_epoch().is_none());
}

#[test]
fn optional_persistent_history_repair_failure_preserves_keys_and_progress() {
    use crate::log::{LogClient, LogRequest};
    use mdbn_wire::cbor::{self, Cbor};
    for failure in ["offline", "genesis", "below_head", "mismatch"] {
        let (svc, mut cp, mut a, mut b) = real_world_store(false, true);
        a.r.request_private_switch(a.s).unwrap();
        switch(&mut cp, &svc);
        settle(&mut [&mut a, &mut b]);
        cp.append(
            &svc,
            vec![PolicyOp::DeviceRevoke(DeviceRevoke {
                device: B16([104; 16]),
            })],
        );
        settle(&mut [&mut a]);
        assert_eq!(a.r.policy.epoch, 3);
        a.create(90, "retained.md", "still readable");
        settle(&mut [&mut a]);
        assert_eq!(
            a.r.sync_status().pending,
            0,
            "baseline {:?}",
            a.r.sync_status()
        );
        // A valid legacy partial keyring: current key, epoch-1 idempotency key
        // and all commitments, but no middle history key. No store mutation.
        let full = a.r.sealer.export().unwrap();
        let n = u64::from_be_bytes(full[..8].try_into().unwrap()) as usize;
        let Cbor::Array(mut keys) = cbor::decode(&full[8..8 + n]).unwrap() else {
            panic!("keyring")
        };
        keys.retain(|key| matches!(key, Cbor::Array(pair) if pair.first() != Some(&Cbor::Uint(2))));
        let keys = cbor::encode(&Cbor::Array(keys)).unwrap();
        let mut partial = (keys.len() as u64).to_be_bytes().to_vec();
        partial.extend_from_slice(&keys);
        partial.extend_from_slice(&full[8 + n..]);
        a.r.sealer.import(&partial).unwrap();
        a.create(89, "before-repair.md", "working before repair");
        settle(&mut [&mut a]);
        assert_eq!(
            a.r.sync_status().pending,
            0,
            "{failure}: originally live {:?}",
            a.r.sync_status()
        );
        let before = a.r.testing_epoch_keys();
        assert_eq!(before.len(), 2);
        a.r.refresh_mode_history();
        assert!(a.r.keyring_rebuilding());
        let call =
            a.r.take_log_calls()
                .into_iter()
                .find(|c| {
                    matches!(c.request,
            LogRequest::Read(ref p) if p.kinds == Some(mdbn_wire::log_service::ReadKinds::Control))
                })
                .unwrap();
        let reply = if failure == "offline" {
            Err(crate::log::LogError::Offline)
        } else {
            let Ok(crate::log::LogResponse::Read(mut result)) = a.log.call(call.request) else {
                panic!("control replay")
            };
            match failure {
                "genesis" => result.items[0].item.0[0] ^= 1,
                "below_head" => result.head = 0,
                "mismatch" => {
                    result.items.truncate(1);
                    result.more = false;
                }
                _ => unreachable!(),
            }
            Ok(crate::log::LogResponse::Read(result))
        };
        a.r.on_log_reply(call.id, reply);
        assert!(
            !a.r.keyring_rebuilding() && !a.r.keyring_rebuild_failed(),
            "{failure}"
        );
        assert_eq!(
            a.r.testing_epoch_keys(),
            before,
            "{failure}: keys must roll back"
        );
        assert_eq!(a.doc(90).as_deref(), Some("still readable"));
        a.r.refresh_mode_history();
        assert!(
            !a.r.keyring_rebuilding(),
            "same failed optional repair is not repeated"
        );
        a.create(91, "continues.md", "no restart needed");
        settle(&mut [&mut a]);
        assert_eq!(
            a.r.sync_status().pending,
            0,
            "{failure}: appends remain live {:?}",
            a.r.sync_status()
        );
        assert_eq!(a.doc(91).as_deref(), Some("no restart needed"));
    }
}

#[test]
fn ineligible_receiver_loses_cloud_read_on_applied_private_policy() {
    let (svc, mut cp, mut a, mut b) = real_world();
    a.r.request_private_switch(a.s).unwrap();
    switch(&mut cp, &svc);
    settle(&mut [&mut a, &mut b]);
    a.r.choose_cloud_copy(a.s).unwrap();
    receiver_cloud_policy(&mut cp, &svc);
    settle(&mut [&mut a, &mut b]);
    assert!(b.r.cloud_read_owner().is_some());
    b.r.cfg.user_enabled_cloud_copy = false; // Not eligible for another local switch.
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
    settle(&mut [&mut b]);
    assert!(b.r.cloud_read_owner().is_none());
    let meta =
        b.r.store()
            .meta("replica.private-switch.v1")
            .unwrap()
            .unwrap();
    let mdbn_wire::cbor::Cbor::Array(fields) = mdbn_wire::cbor::decode(&meta).unwrap() else {
        panic!("mode metadata")
    };
    assert_eq!(
        fields.len(),
        3,
        "no persisted receiver witness after Private, even when ineligible"
    );
    assert!(b.r.cloud_copy_source_epoch().is_none());
}

#[test]
fn receiver_policy_without_owner_service_grant_retains_integrity_alert() {
    let (svc, mut cp, mut a, mut b) = real_world();
    a.r.request_private_switch(a.s).unwrap();
    switch(&mut cp, &svc);
    settle(&mut [&mut a, &mut b]);
    receiver_cloud_policy(&mut cp, &svc); // A did NOT choose Cloud/source handover.
    settle(&mut [&mut a, &mut b]);
    assert!(b.r.cloud_read_owner().is_none());
    assert!(
        b.r.sync_status()
            .incidents
            .iter()
            .any(|i| i.kind == mdbn_wire::client::IncidentKind::Integrity)
    );
    assert!(b.r.cloud_copy_source_epoch().is_none());
}

fn receiver_cloud_policy(cp: &mut TestControlPlane, svc: &FakeLogService) {
    let mut ops = Vec::new();
    for (id, kind) in [(105, DeviceKind::Hosted), (106, DeviceKind::Escrow)] {
        ops.push(PolicyOp::DeviceEnrol(DeviceEnrol {
            device: B16([id; 16]),
            account: crate::policy::SERVICE_ACCOUNT,
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
    cp.append(svc, ops);
}

#[test]
fn receiver_refuses_revoked_or_locally_untrusted_owner_grants() {
    for revoked in [false, true] {
        let (svc, mut cp, mut a, mut b) = real_world_member(true);
        a.r.request_private_switch(a.s).unwrap();
        switch(&mut cp, &svc);
        settle(&mut [&mut a, &mut b]);
        receiver_cloud_policy(&mut cp, &svc);
        settle(&mut [&mut a, &mut b]);
        assert!(
            b.r.cloud_read_owner().is_none(),
            "flags alone are not selection"
        );
        let payload =
            a.r.sealer
                .build_key_grant(
                    2,
                    &crate::crypto::keys::Recipient {
                        device: B16([105; 16]),
                        kem_pk: KemKeyPair::from_secret(&[105; 32]).pk,
                    },
                    &mut crate::crypto::TestEntropy::new(105),
                )
                .unwrap();
        if revoked {
            cp.append(
                &svc,
                vec![PolicyOp::DeviceRevoke(DeviceRevoke {
                    device: B16([101; 16]),
                })],
            );
            settle(&mut [&mut b]);
        } else {
            // A receiver with a self-trusted key but no local anchor for the
            // other owner must not trust that owner merely for self-delivery.
            let data = b.r.store().data();
            drop(b);
            let mut store = MemStore::shared(data);
            store
                .commit(crate::store::Tx {
                    meta: vec![("replica.private-switch.v1".into(), None)],
                    ..Default::default()
                })
                .unwrap();
            b = node_with(
                &svc,
                4,
                store,
                vec![],
                Some(Box::new(KeyringSealer::new(
                    COL,
                    B16([104; 16]),
                    &[104; 32],
                    &[104; 32],
                ))),
            );
            b.r.cfg.chosen_state = Some(CState::E2e);
            b.r.cfg.e2e = true;
            b.r.cfg.trusted_signers.clear();
            b.r.policy
                .devices
                .get_mut(&B16([104; 16]))
                .unwrap()
                .delivered_by = Some(B16([104; 16]));
            b.r.policy
                .devices
                .get_mut(&B16([101; 16]))
                .unwrap()
                .delivered_by = Some(B16([101; 16]));
        }
        assert!(a.r.append_control(ItemKind::KeyGrant, payload.to_bytes().unwrap()));
        settle(&mut [&mut a, &mut b]);
        assert!(b.r.cloud_read_owner().is_none());
        assert_eq!(b.r.cfg.chosen_state, Some(CState::E2e));
        assert!(b.r.cloud_copy_source_epoch().is_none());
    }
}

#[test]
fn raw_legacy_rekey_is_not_a_qualifying_private_cutover() {
    // This raw fixture bypasses token admission. The CP regression now refuses
    // unadvertised B and drains pre-floor tokens BEFORE publishing the switch.
    // Keep the local trust rule strict even for an injected legacy item.
    let (svc, mut cp, mut a, mut b) = real_world();
    let recipients =
        b.r.policy
            .rekey_recipients()
            .into_iter()
            .map(|device| crate::crypto::keys::Recipient {
                device,
                kem_pk: b.r.policy.devices[&device].kem_pk.0,
            })
            .collect::<Vec<_>>();
    let current =
        b.r.sealer
            .build_rekey(
                1,
                &recipients,
                RekeyReason::Scheduled,
                &mut crate::crypto::TestEntropy::new(71),
            )
            .unwrap();
    assert!(b.r.append_control(ItemKind::Rekey, current.to_bytes().unwrap()));
    settle(&mut [&mut a, &mut b]);
    a.r.request_private_switch(a.s).unwrap();
    switch(&mut cp, &svc);
    settle(&mut [&mut b]); // The older peer observes the policy before A.
    // The old writer guard had no local switch-set intent rule. A current
    // self-delivered key remained trusted even after services were revoked.
    assert_eq!(
        b.r.policy
            .key_trust(&B16([104; 16]), &std::collections::BTreeSet::new(), true),
        crate::policy::KeyTrust::Trusted
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
    let legacy =
        b.r.sealer
            .build_rekey(
                2,
                &recipients,
                RekeyReason::DeviceRevoked,
                &mut crate::crypto::TestEntropy::new(72),
            )
            .unwrap();
    assert!(b.r.append_control(ItemKind::Rekey, legacy.to_bytes().unwrap()));
    settle(&mut [&mut b]);
    settle(&mut [&mut a, &mut b]);
    assert_eq!(a.r.policy.epoch, 3);
    assert!(
        a.r.key_untrusted,
        "the approved rule must not accept the older writer's wrong-reason rekey"
    );
    assert!(a.r.accepted_private_switch().is_none());
}
