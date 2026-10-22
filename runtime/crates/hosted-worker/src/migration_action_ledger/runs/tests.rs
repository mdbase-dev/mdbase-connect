//! Real SQLite + actual portable Driver rollback; no physical-commit claims.
use super::*;
use crate::migration_action_ledger::tests::{Sqlite, TestEntropy, backup, binding, open};

fn rolled_back() -> JournalDriver<Sqlite> {
    let mut a = open();
    let (t, _) = a.prepare(&mut TestEntropy(30)).unwrap();
    a.settle_provider(&t, &backup(5)).unwrap();
    a.driver
        .rollback(&mut a.spill, "test operator abort")
        .unwrap();
    assert_eq!(
        a.driver.poll(&mut a.spill).unwrap(),
        Action::Done(Step::RolledBack)
    );
    a
}

#[test]
fn rollback_new_run_preserves_identity_checkpoint_and_actions() {
    let mut a = rolled_back();
    let old = a.read_run(1).unwrap().unwrap();
    let saved = a
        .spill
        .index_mut()
        .db
        .query_row(
            "SELECT before_cp,after_cp,result FROM mig_native_action WHERE seq=1",
            [],
            |r| {
                Ok((
                    r.get::<_, Vec<u8>>(0)?,
                    r.get::<_, Vec<u8>>(1)?,
                    r.get::<_, Vec<u8>>(2)?,
                ))
            },
        )
        .unwrap();
    a.spill
        .index_mut()
        .db
        .execute("INSERT INTO mig_claim(g,h) VALUES(0,?1)", [vec![4; 32]])
        .unwrap();
    a.restart(1, &binding(), &mut TestEntropy(70)).unwrap();
    assert_eq!(a.run_sequence(), 2);
    assert_ne!(a.driver_id(), old.driver);
    assert_eq!(a.driver.checkpoint().step, Step::Start);
    assert_eq!(a.read_run(1).unwrap().unwrap().checkpoint, old.checkpoint);
    assert_eq!(a.read_run(1).unwrap().unwrap().binding, old.binding);
    assert_eq!(a.read_run(1).unwrap().unwrap().sequence, 1);
    assert_eq!(a.read_run(2).unwrap().unwrap().driver, a.driver_id());
    assert!(a.read_run(3).unwrap().is_none());
    assert_eq!(
        a.spill
            .index_mut()
            .db
            .query_row("SELECT count(*) FROM mig_claim", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert_eq!(
        a.spill
            .index_mut()
            .db
            .query_row(
                "SELECT before_cp,after_cp,result FROM mig_native_action WHERE seq=1",
                [],
                |r| Ok((
                    r.get::<_, Vec<u8>>(0)?,
                    r.get::<_, Vec<u8>>(1)?,
                    r.get::<_, Vec<u8>>(2)?
                ))
            )
            .unwrap(),
        saved
    );
    assert_eq!(
        a.restart(1, &binding(), &mut TestEntropy(80)),
        Err(LedgerError::Conflict)
    );
    let (t, action) = a.prepare(&mut TestEntropy(90)).unwrap();
    assert_eq!(action, Action::EnsureBackup);
    assert_eq!(t.data().sequence, 2);
    assert_eq!(t.data().driver, a.driver_id());
    assert_eq!(a.settlement_current_for_history(1), 1);
    let index = a.spill.into_inner();
    let mut reopened = JournalDriver::resume(index, binding(), &mut TestEntropy(100)).unwrap();
    assert_eq!(reopened.run_sequence(), 2);
    assert_eq!(
        reopened.read_run(1).unwrap().unwrap().checkpoint,
        old.checkpoint
    );
    assert_eq!(
        reopened.saved_pending().unwrap().unwrap().driver,
        t.data().driver
    );
    assert!(matches!(
        reopened.prepare(&mut TestEntropy(110)),
        Err(LedgerError::OutstandingUnknown)
    ));
}

impl JournalDriver<Sqlite> {
    fn settlement_current_for_history(&mut self, seq: u64) -> i64 {
        self.spill
            .index_mut()
            .db
            .query_row(
                "SELECT settled FROM mig_native_action WHERE seq=?1",
                [seq],
                |r| r.get(0),
            )
            .unwrap()
    }
}

#[test]
fn retry_refuses_unsettled_held_fence_revocations_cutover_and_binding_drift() {
    let mut pending = rolled_back();
    pending
        .spill
        .index_mut()
        .db
        .execute_batch("DROP TRIGGER mig_native_action_insert")
        .unwrap();
    let pending_id = pending.id.0.to_vec();
    let pending_cp = pending.driver.checkpoint().to_bytes().unwrap();
    pending.spill.index_mut().db.execute("INSERT INTO mig_native_action(seq,driver,action,kind,fingerprint,before_cp) VALUES(2,?1,?2,0,?3,?4)",rusqlite::params![pending_id,vec![9u8;16],vec![9u8;32],pending_cp]).unwrap();
    assert_eq!(
        pending.restart(1, &binding(), &mut TestEntropy(70)),
        Err(LedgerError::OutstandingUnknown)
    );
    for step in [
        Step::Start,
        Step::RollingBack,
        Step::CutoverIntent,
        Step::Routed,
        Step::Failed,
        Step::Gone,
    ] {
        let mut a = rolled_back();
        let mut cp = a.driver.checkpoint().clone();
        cp.step = step;
        if step == Step::RollingBack {
            cp.fenced = true;
        }
        a.spill.save(&cp.to_bytes().unwrap()).unwrap();
        let mut a =
            JournalDriver::resume(a.spill.into_inner(), binding(), &mut TestEntropy(70)).unwrap();
        assert_eq!(
            a.restart(1, &binding(), &mut TestEntropy(80)),
            Err(LedgerError::Refused),
            "{step:?}"
        );
        assert_eq!(a.run_sequence(), 1);
        assert_eq!(a.spill.load().unwrap().unwrap(), cp.to_bytes().unwrap());
    }
    for variant in 0..4 {
        let mut a = rolled_back();
        let mut cp = a.driver.checkpoint().clone();
        match variant {
            0 => cp.revoked.push(B16([9; 16]).to_uuid_string()),
            1 => cp.cutover_seq = Some(9),
            2 => cp.intent_mutation = Some(B16([9; 16])),
            _ => cp.barrier_f = Some(10),
        }
        a.spill.save(&cp.to_bytes().unwrap()).unwrap();
        let mut a =
            JournalDriver::resume(a.spill.into_inner(), binding(), &mut TestEntropy(70)).unwrap();
        assert_eq!(
            a.restart(1, &binding(), &mut TestEntropy(80)),
            Err(LedgerError::Refused)
        );
    }
    let mut a = rolled_back();
    let mut foreign = binding();
    foreign.target = B32([9; 32]);
    assert_eq!(
        a.restart(1, &foreign, &mut TestEntropy(80)),
        Err(LedgerError::Conflict)
    );
    assert_eq!(a.run_sequence(), 1);
}

#[test]
fn checked_reset_drift_is_atomic_and_poisoned_instead_of_silent_recovery() {
    let mut a = rolled_back();
    a.spill
        .index_mut()
        .db
        .execute("UPDATE mig_checkpoint SET v=?1 WHERE k=0", [vec![0u8]])
        .unwrap();
    assert_eq!(
        a.restart(1, &binding(), &mut TestEntropy(80)),
        Err(LedgerError::StorageUnknown)
    );
    assert_eq!(
        a.restart(1, &binding(), &mut TestEntropy(90)),
        Err(LedgerError::StorageUnknown)
    );
    assert_eq!(
        a.spill
            .index_mut()
            .db
            .query_row("SELECT count(*) FROM mig_native_run", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        1
    );
    assert_eq!(
        a.spill
            .index_mut()
            .db
            .query_row("SELECT count(*) FROM mig_native_run_end", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
}

#[test]
fn rolling_back_without_remaining_effects_can_start_again_and_archive_terminal() {
    let mut a = open();
    a.driver
        .rollback(&mut a.spill, "no effects issued")
        .unwrap();
    assert_eq!(a.driver.checkpoint().step, Step::RollingBack);
    a.restart(1, &binding(), &mut TestEntropy(80)).unwrap();
    assert_eq!(
        a.read_run(1).unwrap().unwrap().checkpoint.step,
        Step::RolledBack
    );
}

#[test]
fn singleton_upgrade_preserves_pending_and_is_idempotent() {
    let mut a = open();
    let (ticket, _) = a.prepare(&mut TestEntropy(30)).unwrap();
    let index = a.spill.index_mut();
    index.db.execute_batch("DROP TRIGGER mig_native_run_no_update; DROP TRIGGER mig_native_run_no_delete; DROP TRIGGER mig_native_action_insert; DROP TRIGGER mig_native_action_settle; CREATE TABLE old(k INTEGER PRIMARY KEY CHECK(k=0),driver BLOB,collection BLOB,owner BLOB,started TEXT,target BLOB); INSERT INTO old SELECT 0,driver,collection,owner,started,target FROM mig_native_run; DROP TABLE mig_native_run; ALTER TABLE old RENAME TO mig_native_run;").unwrap();
    let mut reopened =
        JournalDriver::resume(a.spill.into_inner(), binding(), &mut TestEntropy(80)).unwrap();
    assert_eq!(reopened.run_sequence(), 1);
    assert_eq!(reopened.driver_id(), ticket.data().driver);
    assert_eq!(reopened.saved_pending().unwrap().unwrap(), *ticket.data());
    assert!(
        reopened
            .spill
            .index_mut()
            .db
            .execute("DELETE FROM mig_native_run", [])
            .is_err()
    );
    let mut reopened =
        JournalDriver::resume(reopened.spill.into_inner(), binding(), &mut TestEntropy(90))
            .unwrap();
    assert_eq!(reopened.saved_pending().unwrap().unwrap(), *ticket.data());
}

#[test]
fn lost_restart_ack_retains_exact_history_and_never_creates_a_third_run() {
    let mut a = rolled_back();
    let old = a.read_run(1).unwrap().unwrap();
    a.spill.index_mut().lose_restart = true;
    assert_eq!(
        a.restart(1, &binding(), &mut TestEntropy(70)),
        Err(LedgerError::StorageUnknown)
    );
    assert_eq!(
        a.restart(1, &binding(), &mut TestEntropy(80)),
        Err(LedgerError::StorageUnknown)
    );
    assert_eq!(
        a.read_run(0).unwrap().unwrap().sequence,
        2,
        "read-only status reports the landed run even after lost acknowledgement"
    );
    let mut a =
        JournalDriver::resume(a.spill.into_inner(), binding(), &mut TestEntropy(90)).unwrap();
    assert_eq!(a.run_sequence(), 2);
    assert_eq!(a.read_run(1).unwrap().unwrap().checkpoint, old.checkpoint);
    assert_eq!(
        a.restart(1, &binding(), &mut TestEntropy(100)),
        Err(LedgerError::Conflict)
    );
    assert_eq!(
        a.restart(2, &binding(), &mut TestEntropy(100)),
        Err(LedgerError::Refused)
    );
    assert_eq!(
        a.spill
            .index_mut()
            .db
            .query_row("SELECT count(*) FROM mig_native_run", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        2
    );
    for sql in [
        "DELETE FROM mig_native_run_end",
        "UPDATE mig_native_run_end SET checkpoint=x'00'",
    ] {
        assert!(a.spill.index_mut().db.execute(sql, []).is_err());
    }
}

#[test]
fn cutover_action_evidence_refuses_even_with_a_rolled_back_checkpoint() {
    let mut a = rolled_back();
    let id = a.id.0.to_vec();
    let cp = a.driver.checkpoint().to_bytes().unwrap();
    a.spill
        .index_mut()
        .db
        .execute_batch("DROP TRIGGER mig_native_action_insert")
        .unwrap();
    a.spill.index_mut().db.execute("INSERT INTO mig_native_action(seq,driver,action,kind,fingerprint,before_cp,settled,after_cp,result) VALUES(2,?1,?2,15,?3,?4,1,?4,?3)",rusqlite::params![id,vec![9u8;16],vec![9u8;32],cp]).unwrap();
    assert_eq!(
        a.restart(1, &binding(), &mut TestEntropy(70)),
        Err(LedgerError::Refused)
    );
}

#[test]
fn failed_reload_after_committed_reset_poisoned_until_reopen() {
    let mut a = rolled_back();
    a.spill.index_mut().fail_load = true;
    assert_eq!(
        a.restart(1, &binding(), &mut TestEntropy(70)),
        Err(LedgerError::StorageUnknown)
    );
    assert_eq!(
        a.restart(1, &binding(), &mut TestEntropy(80)),
        Err(LedgerError::StorageUnknown)
    );
    let mut a =
        JournalDriver::resume(a.spill.into_inner(), binding(), &mut TestEntropy(90)).unwrap();
    assert_eq!(a.run_sequence(), 2);
    assert_eq!(
        a.read_run(1).unwrap().unwrap().checkpoint.step,
        Step::RolledBack
    );
    assert_eq!(a.driver.checkpoint().step, Step::Start);
}

#[test]
fn history_lookup_distinguishes_fresh_missing_checkpoint_from_oversized_corruption() {
    let mut a = open();
    assert_eq!(a.read_run(1).unwrap().unwrap().checkpoint.step, Step::Start);
    a.spill
        .index_mut()
        .db
        .execute(
            "INSERT INTO mig_checkpoint(k,v) VALUES(0,?1)",
            [vec![0u8; MAX_CHECKPOINT + 1]],
        )
        .unwrap();
    assert!(matches!(a.read_run(1), Err(LedgerError::Corrupt)));
    assert!(matches!(a.read_run(MAX_SEQ + 1), Err(LedgerError::Invalid)));
}

#[test]
fn unknown_schema_and_sequence_exhaustion_fail_closed() {
    let index = Sqlite::new();
    index
        .db
        .execute_batch("CREATE TABLE mig_native_run(unexpected INTEGER)")
        .unwrap();
    assert!(matches!(
        JournalDriver::resume(index, binding(), &mut TestEntropy(70)),
        Err(LedgerError::Corrupt)
    ));
    let mut a = rolled_back();
    a.spill
        .index_mut()
        .db
        .execute_batch(
            "DROP TRIGGER mig_native_run_no_update; UPDATE mig_native_run SET seq=9007199254740991",
        )
        .unwrap();
    let mut a =
        JournalDriver::resume(a.spill.into_inner(), binding(), &mut TestEntropy(70)).unwrap();
    assert_eq!(
        a.restart(MAX_SEQ, &binding(), &mut TestEntropy(80)),
        Err(LedgerError::Conflict)
    );
    assert_eq!(a.run_sequence(), MAX_SEQ);
}
