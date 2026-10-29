//! Existing private epoch history is delivered by a consenting keyed owner,
//! never by a service-created bootstrap or a caller-selected replacement key.
use super::*;
use crate::crypto::{hpke::KemKeyPair, keys::Recipient, sign::DeviceSigner};
use crate::seal::KeyringSealer;
use crate::testkit::{TEST_OWNER, TestControlPlane};
use mdbn_wire::envelope::{Item, ItemKind, RekeyPayload, RekeyReason};
use mdbn_wire::policy::{CState, CollectionState, DeviceEnrol, MemberSet, PolicyOp, Role};
use mdbn_wire::schema::Wire;

const SIGN: [u8; 32] = [0x31; 32];
const KEM: [u8; 32] = [0x32; 32];
const OWNER: B16 = B16([101; 16]);

fn owner(svc: &FakeLogService, store: MemStore, cloud: bool) -> Node {
    let mut node = node_with(
        svc,
        1,
        store,
        vec![],
        Some(Box::new(KeyringSealer::new(COL, OWNER, &SIGN, &KEM))),
    );
    node.r.cfg.chosen_state = Some(if cloud {
        CState::CloudCopy
    } else {
        CState::E2e
    });
    node.r.cfg.user_enabled_cloud_copy = cloud;
    node.r.cfg.e2e = !cloud;
    node
}

fn convert(cp: &mut TestControlPlane, svc: &FakeLogService) {
    let mut ops = [
        (102, mdbn_wire::policy::DeviceKind::Hosted),
        (103, mdbn_wire::policy::DeviceKind::Escrow),
    ]
    .into_iter()
    .map(|(id, kind)| {
        PolicyOp::DeviceEnrol(DeviceEnrol {
            device: B16([id; 16]),
            account: crate::policy::SERVICE_ACCOUNT,
            kind,
            sign_pk: B32(DeviceSigner::from_seed(&[id; 32]).public()),
            kem_pk: B32(KemKeyPair::from_secret(&[id; 32]).pk),
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
    cp.append(svc, ops);
}

#[test]
fn private_history_handover_survives_lost_reply_and_both_device_restarts() {
    let svc = FakeLogService::new();
    let mut cp = TestControlPlane::signed(COL);
    cp.genesis_with_keys(&svc, CState::E2e, OWNER, &SIGN, &KEM);
    let store = MemStore::new();
    let data = store.data();
    let mut a = owner(&svc, store, false);
    settle(&mut [&mut a]);
    a.create(1, "epoch-one.md", "first private epoch");
    settle(&mut [&mut a]);
    let payload =
        a.r.sealer
            .build_rekey(
                1,
                &[Recipient {
                    device: OWNER,
                    kem_pk: KemKeyPair::from_secret(&KEM).pk,
                }],
                RekeyReason::Scheduled,
                &mut crate::crypto::TestEntropy::new(19),
            )
            .unwrap();
    assert!(a.r.append_control(ItemKind::Rekey, payload.to_bytes().unwrap()));
    settle(&mut [&mut a]);
    a.create(2, "epoch-two.md", "second private epoch");
    settle(&mut [&mut a]);
    assert_eq!(a.r.policy.epoch, 2);
    let old_keys = a.r.testing_epoch_keys();
    convert(&mut cp, &svc);
    settle(&mut [&mut a]);
    assert_eq!(
        a.r.policy.epoch, 2,
        "remote policy alone never hands over private history"
    );
    assert!(!a.r.policy.devices[&B16([102; 16])].keyed);
    drop(a);
    // Host choice is durable, not inferred from the newly applied remote policy.
    let mut a = owner(&svc, MemStore::shared(data.clone()), true);
    settle(&mut [&mut a]);
    assert!(
        !a.r.policy.devices[&B16([102; 16])].keyed,
        "stale host flags are not a new durable conversion intent"
    );
    a.r.choose_cloud_copy(a.s).unwrap();
    a.log.faults.lose_replies = 1;
    settle(&mut [&mut a]);
    a.clock.set(a.clock.get() + 5_000);
    settle(&mut [&mut a]);
    assert_eq!(
        a.r.policy.epoch, 2,
        "handover never replaces the existing epoch"
    );
    for id in [102, 103] {
        assert!(a.r.policy.devices[&B16([id; 16])].keyed);
        assert_eq!(a.r.policy.devices[&B16([id; 16])].delivered_by, Some(OWNER));
    }
    let rekeys = svc
        .items(&COL)
        .iter()
        .filter_map(|raw| {
            let item = Item::from_bytes(raw).unwrap();
            (item.kind == ItemKind::Rekey)
                .then(|| (item.signer, RekeyPayload::from_bytes(&item.body.0).unwrap()))
        })
        .collect::<Vec<_>>();
    assert_eq!(
        rekeys.len(),
        2,
        "handover never creates a replacement epoch"
    );
    let grants = grants_in(&svc);
    assert_eq!(
        grants,
        vec![(OWNER, B16([102; 16])), (OWNER, B16([103; 16]))]
    );
    let hosted_store = MemStore::new();
    let hosted_data = hosted_store.data();
    let mut hosted = node_with(
        &svc,
        2,
        hosted_store,
        vec![],
        Some(Box::new(KeyringSealer::new(
            COL,
            B16([102; 16]),
            &[102; 32],
            &[102; 32],
        ))),
    );
    hosted.r.cfg.user_enabled_cloud_copy = true;
    hosted.r.cfg.chosen_state = Some(CState::CloudCopy);
    settle(&mut [&mut hosted, &mut a]);
    assert_eq!(hosted.doc(1).as_deref(), Some("first private epoch"));
    assert_eq!(hosted.doc(2).as_deref(), Some("second private epoch"));
    let handed = hosted.r.testing_epoch_keys();
    for (epoch, key) in &old_keys {
        assert_eq!(
            handed.iter().find(|(e, _)| e == epoch).unwrap().1.as_ref(),
            key.as_ref()
        );
    }
    let head = svc.head(&COL);
    drop(a);
    let mut a = owner(&svc, MemStore::shared(data), true);
    settle(&mut [&mut a]);
    assert_eq!(
        svc.head(&COL),
        head,
        "restart never bootstraps another epoch"
    );
    a.create(3, "cloud.md", "after handover");
    settle(&mut [&mut a, &mut hosted]);
    assert_eq!(hosted.doc(3).as_deref(), Some("after handover"));
    drop(hosted);
    let mut hosted = node_with(
        &svc,
        2,
        MemStore::shared(hosted_data),
        vec![],
        Some(Box::new(KeyringSealer::new(
            COL,
            B16([102; 16]),
            &[102; 32],
            &[102; 32],
        ))),
    );
    hosted.r.cfg.user_enabled_cloud_copy = true;
    hosted.r.cfg.chosen_state = Some(CState::CloudCopy);
    hosted.r.check_key_trust();
    settle(&mut [&mut hosted]);
    assert_eq!(hosted.doc(1).as_deref(), Some("first private epoch"));
    assert_eq!(hosted.doc(2).as_deref(), Some("second private epoch"));
    assert_eq!(hosted.doc(3).as_deref(), Some("after handover"));
    assert_eq!(a.r.stats.voided, 0);
    assert_eq!(hosted.r.stats.voided, 0);
}

#[test]
fn cloud_source_cancellation_revokes_permission_before_publication_only() {
    let svc = FakeLogService::new();
    let mut cp = TestControlPlane::signed(COL);
    cp.genesis_with_keys(&svc, CState::E2e, OWNER, &SIGN, &KEM);
    let mut a = owner(&svc, MemStore::new(), false);
    settle(&mut [&mut a]);
    a.r.choose_cloud_copy(a.s).unwrap();
    assert_eq!(a.r.cloud_copy_source_epoch(), Some(1));
    a.r.cancel_cloud_copy(a.s).unwrap();
    assert!(a.r.cloud_copy_source_epoch().is_none());
    assert_eq!(a.r.cfg.chosen_state, Some(CState::E2e));
    convert(&mut cp, &svc);
    settle(&mut [&mut a]);
    assert!(
        !a.r.policy.devices[&B16([102; 16])].keyed,
        "cancelled consent cannot respond to a later flag"
    );
    a.r.cancel_cloud_copy(a.s).unwrap(); // No source intent: idempotent even after another operation.
    a.r.choose_cloud_copy(a.s).unwrap();
    settle(&mut [&mut a]);
    assert!(
        a.r.cancel_cloud_copy(a.s).is_err(),
        "published Cloud mode must not be silently rolled back"
    );
}

#[test]
fn mode_policy_and_a_consenting_editor_cannot_substitute_for_the_keyed_owner() {
    let svc = FakeLogService::new();
    let mut cp = TestControlPlane::signed(COL);
    cp.genesis_with_keys(&svc, CState::E2e, OWNER, &SIGN, &KEM);
    let mut a = owner(&svc, MemStore::new(), false);
    settle(&mut [&mut a]);
    convert(&mut cp, &svc);
    settle(&mut [&mut a]);
    a.r.cfg.user_enabled_cloud_copy = true;
    settle(&mut [&mut a]);
    assert_eq!(
        a.r.policy.epoch, 1,
        "consent without persisted chosen mode is insufficient"
    );
    a.r.choose_cloud_copy(a.s).unwrap();
    cp.append(
        &svc,
        vec![
            PolicyOp::MemberSet(MemberSet {
                account: OTHER,
                role: Role::Owner,
            }),
            PolicyOp::MemberSet(MemberSet {
                account: TEST_OWNER,
                role: Role::Editor,
            }),
        ],
    );
    settle(&mut [&mut a]);
    a.r.cfg.chosen_state = Some(CState::CloudCopy);
    settle(&mut [&mut a]);
    assert_eq!(
        a.r.policy.epoch, 1,
        "a keyed editor does not initiate owner handover"
    );
    assert!(!a.r.policy.devices[&B16([102; 16])].keyed);
}
