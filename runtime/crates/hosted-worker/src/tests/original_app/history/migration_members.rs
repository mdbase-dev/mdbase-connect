//! Actual accepted member policy/FULL point equality, not CP ceiling or invite
//! acceptance qualification. No role-only comparison grants permissions.
use super::*;
use std::collections::BTreeMap;
const EDITOR: B16 = B16([41; 16]);

#[test]
fn migration_members_compare_complete_actual_set_and_exact_roles() {
    let (svc, mut cp, _, _) = fixture();
    let mut h = open(&svc);
    h.pump(false);
    cp.append(
        &svc,
        vec![PolicyOp::MemberSet(MemberSet {
            account: EDITOR,
            role: Role::Editor,
        })],
    );
    h.pump(false);
    let target = h.e.observe_native_target().unwrap();
    let expected = BTreeMap::from([(TEST_OWNER, Role::Owner), (EDITOR, Role::Editor)]);
    h.e.verify_migration_members(&target, &expected).unwrap();
    assert!(
        h.e.verify_migration_members(&target, &BTreeMap::from([(TEST_OWNER, Role::Owner)]))
            .is_err()
    );
    for role in [Role::Viewer, Role::Owner] {
        let mut wrong = expected.clone();
        wrong.insert(EDITOR, role);
        assert!(h.e.verify_migration_members(&target, &wrong).is_err());
    }
    let mut extra = expected.clone();
    extra.insert(B16([42; 16]), Role::Viewer);
    assert!(h.e.verify_migration_members(&target, &extra).is_err());
    assert!(
        h.e.verify_migration_members(&target, &BTreeMap::new())
            .is_err()
    );
    h.e.verify_migration_members(&target, &expected).unwrap();
}

#[test]
fn migration_members_refuse_foreign_equal_target_and_retired_transport() {
    let (svc, _, _, _) = fixture();
    let mut a = open(&svc);
    a.pump(false);
    let mut b = open(&svc);
    b.pump(false);
    let target = a.e.observe_native_target().unwrap();
    let other = b.e.observe_native_target().unwrap();
    assert_eq!(target.admission(), other.admission());
    let expected = BTreeMap::from([(TEST_OWNER, Role::Owner)]);
    a.e.verify_migration_members(&target, &expected).unwrap();
    assert!(b.e.verify_migration_members(&target, &expected).is_err());
    b.e.verify_migration_members(&other, &expected).unwrap();
    a.e.retire_log();
    assert!(a.e.verify_migration_members(&target, &expected).is_err());
}

#[test]
fn migration_members_refuse_head_drift_and_oversized_or_nil_expectations() {
    let (svc, mut cp, _, _) = fixture();
    let mut h = open(&svc);
    h.pump(false);
    let before = h.e.observe_native_target().unwrap();
    let mut expected = BTreeMap::from([(TEST_OWNER, Role::Owner)]);
    cp.append(
        &svc,
        vec![PolicyOp::MemberSet(MemberSet {
            account: EDITOR,
            role: Role::Editor,
        })],
    );
    h.pump(false);
    expected.insert(EDITOR, Role::Editor);
    assert!(h.e.verify_migration_members(&before, &expected).is_err());
    let target = h.e.observe_native_target().unwrap();
    h.e.verify_migration_members(&target, &expected).unwrap();
    let mut nil = expected.clone();
    nil.insert(B16([0; 16]), Role::Viewer);
    assert!(h.e.verify_migration_members(&target, &nil).is_err());
    let mut large = expected;
    for n in 1u64..=1001 {
        let mut id = [43; 16];
        id[..8].copy_from_slice(&n.to_be_bytes());
        large.insert(B16(id), Role::Viewer);
    }
    assert!(h.e.verify_migration_members(&target, &large).is_err());
}
