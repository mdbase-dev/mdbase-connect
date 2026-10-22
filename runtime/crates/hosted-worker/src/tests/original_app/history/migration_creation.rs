//! Actual native FULL/original replay plus SQLite creation settlement boundaries.
//! The service/CPP exchange and physical host confirmation are separate checks.
use super::*;
use crate::migration_action_ledger::{
    JournalDriver, LedgerError, PreparedAction, RunBinding, target_fingerprint, tests::Sqlite,
};
use crate::runtime::ObservedNativeTarget;
use mdbn_migrate_portable::hosted_import::{Action, Outcome, Step};

fn binding(target: &ObservedNativeTarget) -> RunBinding {
    RunBinding {
        collection: target.admission().collection(),
        owner: target.genesis_owner(),
        started_us: "10413792000000001".into(),
        target: target_fingerprint(target),
    }
}
fn prepared(binding: RunBinding) -> (JournalDriver<Sqlite>, PreparedAction) {
    let mut entropy = mdbn_replica::crypto::TestEntropy::new(81);
    let mut driver = JournalDriver::resume(Sqlite::new(), binding, &mut entropy).unwrap();
    let (backup, action) = driver.prepare(&mut entropy).unwrap();
    assert_eq!(action, Action::EnsureBackup);
    driver
        .settle_provider(
            &backup,
            &crate::migration_action_ledger::tests::backup(0x47),
        )
        .unwrap();
    let (creation, action) = driver.prepare(&mut entropy).unwrap();
    assert_eq!(action, Action::CreateCollection);
    (driver, creation)
}

#[test]
fn native_creation_settles_only_actual_current_full_target() {
    let (svc, _, _, _) = fixture();
    let mut h = open(&svc);
    h.pump(false);
    let target = h.e.observe_native_target().unwrap();
    let (mut driver, ticket) = prepared(binding(&target));
    assert_eq!(
        driver.settle(&ticket, Outcome::Created { verified: true }),
        Err(LedgerError::OutstandingUnknown)
    );
    let result = driver.settle_created(&ticket, &mut h.e, &target).unwrap();
    driver.assert_settled(&ticket, result).unwrap();
    assert!(driver.saved_pending().unwrap().is_none());
    assert_eq!(
        driver.settle_created(&ticket, &mut h.e, &target),
        Err(LedgerError::Refused)
    );
    let index = driver.into_index();
    let checkpoint: Vec<u8> = index
        .db
        .query_row("SELECT v FROM mig_checkpoint WHERE k=0", [], |r| r.get(0))
        .unwrap();
    let cp = mdbn_migrate_portable::hosted_import::Checkpoint::from_bytes(&checkpoint).unwrap();
    assert_eq!(cp.step, Step::Created);
}

#[test]
fn native_creation_refuses_foreign_engine_and_mismatched_run() {
    let (svc, _, _, _) = fixture();
    let mut a = open(&svc);
    a.pump(false);
    let mut b = open(&svc);
    b.pump(false);
    let target = a.e.observe_native_target().unwrap();
    let other = b.e.observe_native_target().unwrap();
    assert_eq!(target.admission(), other.admission());
    let (mut driver, ticket) = prepared(binding(&target));
    assert_eq!(
        driver.settle_created(&ticket, &mut b.e, &target),
        Err(LedgerError::Refused)
    );
    driver.assert_prepared(&ticket).unwrap();
    for field in 0..3 {
        let mut wrong = binding(&target);
        match field {
            0 => wrong.collection = B16([99; 16]),
            1 => wrong.owner = B16([99; 16]),
            _ => wrong.target = B32([99; 32]),
        }
        let (mut driver, ticket) = prepared(wrong);
        assert_eq!(
            driver.settle_created(&ticket, &mut a.e, &target),
            Err(LedgerError::Conflict)
        );
        driver.assert_prepared(&ticket).unwrap();
    }
}

#[test]
fn native_creation_refuses_fresh_head_drift_and_retired_target() {
    let (svc, mut cp, _, _) = fixture();
    let mut h = open(&svc);
    h.pump(false);
    let target = h.e.observe_native_target().unwrap();
    let (mut driver, ticket) = prepared(binding(&target));
    cp.append(
        &svc,
        vec![PolicyOp::MemberSet(MemberSet {
            account: TEST_OWNER,
            role: Role::Owner,
        })],
    );
    h.pump(false);
    assert!(h.e.observe_native_target().is_ok());
    assert_eq!(
        driver.settle_created(&ticket, &mut h.e, &target),
        Err(LedgerError::Refused)
    );
    driver.assert_prepared(&ticket).unwrap();
    let fresh = h.e.observe_native_target().unwrap();
    h.e.retire_log();
    assert_eq!(
        driver.settle_created(&ticket, &mut h.e, &fresh),
        Err(LedgerError::Refused)
    );
    driver.assert_prepared(&ticket).unwrap();
}

#[test]
fn native_creation_lost_sql_commit_ack_poison_stops_replay() {
    let (svc, _, _, _) = fixture();
    let mut h = open(&svc);
    h.pump(false);
    let target = h.e.observe_native_target().unwrap();
    let (mut driver, ticket) = prepared(binding(&target));
    // SAME SQLite transaction really lands; only its acknowledgment is lost.
    driver.test_lose_settlement();
    assert_eq!(
        driver.settle_created(&ticket, &mut h.e, &target),
        Err(LedgerError::StorageUnknown)
    );
    assert!(matches!(
        driver.prepare(&mut mdbn_replica::crypto::TestEntropy::new(82)),
        Err(LedgerError::StorageUnknown)
    ));
    assert_eq!(
        driver.settle_created(&ticket, &mut h.e, &target),
        Err(LedgerError::Refused)
    );
    let index = driver.into_index();
    let settled: u64 = index
        .db
        .query_row(
            "SELECT count(*) FROM mig_native_action WHERE settled=1",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(settled, 2);
}

#[test]
fn native_creation_refuses_non_creation_action_and_foreign_ticket() {
    let (svc, _, _, _) = fixture();
    let mut h = open(&svc);
    h.pump(false);
    let target = h.e.observe_native_target().unwrap();
    let mut entropy = mdbn_replica::crypto::TestEntropy::new(83);
    let mut driver = JournalDriver::resume(Sqlite::new(), binding(&target), &mut entropy).unwrap();
    let (backup, action) = driver.prepare(&mut entropy).unwrap();
    assert_eq!(action, Action::EnsureBackup);
    // A verified target cannot stand in for any other action's outcome.
    assert_eq!(
        driver.settle_created(&backup, &mut h.e, &target),
        Err(LedgerError::Conflict)
    );
    driver.assert_prepared(&backup).unwrap();
    // An equal-binding ticket minted by a different journal is not this pending.
    let (mut other, foreign) = prepared(binding(&target));
    assert!(driver.settle_created(&foreign, &mut h.e, &target).is_err());
    driver.assert_prepared(&backup).unwrap();
    other.assert_prepared(&foreign).unwrap();
}

#[test]
fn native_creation_cannot_upgrade_a_settled_negative_result() {
    let (svc, _, _, _) = fixture();
    let mut h = open(&svc);
    h.pump(false);
    let target = h.e.observe_native_target().unwrap();
    let (mut driver, ticket) = prepared(binding(&target));
    let negative = driver
        .settle(&ticket, Outcome::Created { verified: false })
        .unwrap();
    assert_eq!(
        driver.settle_created(&ticket, &mut h.e, &target),
        Err(LedgerError::Refused)
    );
    driver.assert_settled(&ticket, negative).unwrap();
    let index = driver.into_index();
    let checkpoint: Vec<u8> = index
        .db
        .query_row("SELECT v FROM mig_checkpoint WHERE k=0", [], |r| r.get(0))
        .unwrap();
    let cp = mdbn_migrate_portable::hosted_import::Checkpoint::from_bytes(&checkpoint).unwrap();
    assert_ne!(cp.step, Step::Created);
}
