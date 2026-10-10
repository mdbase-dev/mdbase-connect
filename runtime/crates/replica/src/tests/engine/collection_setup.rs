use super::*;
mod capture;
mod session;
use crate::seal::KeyringSealer;
use mdbn_wire::common::B32;
use mdbn_wire::policy::{CState, DeviceKind, Role};
use std::sync::Arc;

pub(super) fn keyed_node() -> (FakeLogService, Node) {
    let svc = FakeLogService::new();
    let dev = B16([101; 16]);
    let (sign, kem) = ([0x31; 32], [0x32; 32]);
    crate::testkit::TestControlPlane::signed(COL).genesis_with_keys(
        &svc,
        CState::E2e,
        dev,
        &sign,
        &kem,
    );
    let mut a = node_with(
        &svc,
        1,
        MemStore::new(),
        vec![],
        Some(Box::new(KeyringSealer::new(COL, dev, &sign, &kem))),
    );
    settle(&mut [&mut a]);
    (svc, a)
}
#[test]
fn setup_fence_accepts_actual_keyed_device_and_rejects_delegation() {
    let (_, a) = keyed_node();
    let f = a.r.collection_setup_capture_fence(None).unwrap();
    a.r.recheck_collection_setup_capture(&f).unwrap();
    assert_eq!(
        f.collection_revision(),
        a.r.collection_setup_capture_fence(None)
            .unwrap()
            .collection_revision()
    );
    let e =
        a.r.collection_setup_capture_fence(Some(B16([8; 16])))
            .err()
            .unwrap();
    assert_eq!(e.code(), Some(ErrorCode::Forbidden));
}
#[test]
fn setup_fence_does_not_accept_test_only_or_mismatched_custody() {
    let (_, mut a) = keyed_node();
    a.r.sealer = Box::new(crate::seal::PlainSealer::for_device(B16([101; 16])));
    assert_eq!(
        a.r.collection_setup_capture_fence(None)
            .err()
            .unwrap()
            .code(),
        Some(ErrorCode::Forbidden)
    );
    let (_, mut a) = keyed_node();
    a.r.policy
        .devices
        .get_mut(&a.r.cfg.device_id)
        .unwrap()
        .kem_pk = B32([4; 32]);
    assert_eq!(
        a.r.collection_setup_capture_fence(None)
            .err()
            .unwrap()
            .code(),
        Some(ErrorCode::Forbidden)
    );
}
#[test]
fn setup_fence_refuses_readers_revoked_unkeyed_and_hosted_devices() {
    type Change = fn(&mut Replica<MemStore>);
    let cases: [Change; 4] = [
        |r| {
            let account = r.policy.devices[&r.cfg.device_id].account;
            r.policy.members.insert(account, Role::Viewer);
        },
        |r| r.policy.devices.get_mut(&r.cfg.device_id).unwrap().active = false,
        |r| r.policy.devices.get_mut(&r.cfg.device_id).unwrap().keyed = false,
        |r| {
            r.policy.cstate = Some(CState::CloudCopy);
            r.policy.devices.get_mut(&r.cfg.device_id).unwrap().kind = DeviceKind::Hosted;
        },
    ];
    for change in cases {
        let (_, mut a) = keyed_node();
        change(&mut a.r);
        assert_eq!(
            a.r.collection_setup_capture_fence(None)
                .err()
                .unwrap()
                .code(),
            Some(ErrorCode::Forbidden)
        );
    }
}
#[test]
fn setup_fence_refuses_unhealthy_or_optimistic_state() {
    type Change = fn(&mut Replica<MemStore>);
    let cases: [Change; 7] = [
        |r| r.caught_up = false,
        |r| r.key_untrusted = true,
        |r| r.policy.frozen = true,
        |r| r.policy.rekey_required = true,
        |r| r.regressed_at = Some(0),
        |r| r.apply_fault = true,
        |r| r.sealer.set_epoch(99),
    ];
    for change in cases {
        let (_, mut a) = keyed_node();
        change(&mut a.r);
        assert_eq!(
            a.r.collection_setup_capture_fence(None)
                .err()
                .unwrap()
                .code(),
            Some(ErrorCode::Unavailable)
        );
    }
    let (_, mut a) = keyed_node();
    a.create(1, "pending.md", "body");
    assert_eq!(
        a.r.collection_setup_capture_fence(None)
            .err()
            .unwrap()
            .code(),
        Some(ErrorCode::Unavailable)
    );
}
#[test]
fn setup_fence_rechecks_every_lifetime_and_still_allowed_authority_change() {
    type Change = fn(&mut Replica<MemStore>);
    let cases: [Change; 5] = [
        |r| r.store_generation += 1,
        |r| r.repair_generation += 1,
        |r| r.policy.ctl_chain = B32([9; 32]),
        |r| r.catalog = Arc::new((*r.catalog).clone()),
        |r| {
            let account = r.policy.devices[&r.cfg.device_id].account;
            r.policy.members.insert(account, Role::Editor);
        },
    ];
    for change in cases {
        let (_, mut a) = keyed_node();
        let f = a.r.collection_setup_capture_fence(None).unwrap();
        change(&mut a.r);
        assert_eq!(
            a.r.recheck_collection_setup_capture(&f).unwrap_err().code(),
            Some(ErrorCode::Conflict)
        );
    }
}
#[test]
fn setup_fence_does_not_cross_reopen_even_with_identical_trusted_revision() {
    let (svc, a) = keyed_node();
    let f = a.r.collection_setup_capture_fence(None).unwrap();
    let mut reopened = node_with(
        &svc,
        1,
        MemStore::new(),
        vec![],
        Some(Box::new(KeyringSealer::new(
            COL,
            B16([101; 16]),
            &[0x31; 32],
            &[0x32; 32],
        ))),
    );
    settle(&mut [&mut reopened]);
    let fresh = reopened.r.collection_setup_capture_fence(None).unwrap();
    assert_eq!(f.collection_revision(), fresh.collection_revision());
    assert_eq!(
        reopened
            .r
            .recheck_collection_setup_capture(&f)
            .unwrap_err()
            .code(),
        Some(ErrorCode::Conflict)
    );
    reopened.r.recheck_collection_setup_capture(&fresh).unwrap();
}
#[test]
fn setup_fence_binds_sequence_chain_and_actual_store_head() {
    let (_, mut a) = keyed_node();
    let f = a.r.collection_setup_capture_fence(None).unwrap();
    a.create(1, "next.md", "exact");
    settle(&mut [&mut a]);
    assert_ne!(
        f.collection_revision(),
        a.r.collection_setup_capture_fence(None)
            .unwrap()
            .collection_revision()
    );
    assert_eq!(
        a.r.recheck_collection_setup_capture(&f).unwrap_err().code(),
        Some(ErrorCode::Conflict)
    );
    a.r.head.chain = B32([8; 32]);
    assert_eq!(
        a.r.collection_setup_capture_fence(None)
            .err()
            .unwrap()
            .code(),
        Some(ErrorCode::Conflict)
    );
}
