//! Real SQLite journal/Driver tests; in-memory SQL is NOT physical durability.
use super::*;
use mdbn_store_file::index::{IndexDurability, IndexError, IndexErrorKind, IndexInfo, OpenState};
struct Sqlite {
    db: rusqlite::Connection,
    lose_prepare: bool,
    lose_settlement: bool,
}
impl Sqlite {
    fn new() -> Self {
        Self {
            db: rusqlite::Connection::open_in_memory().unwrap(),
            lose_prepare: false,
            lose_settlement: false,
        }
    }
}
fn to_sql(v: &SqlValue) -> rusqlite::types::Value {
    use rusqlite::types::Value;
    match v {
        SqlValue::Null => Value::Null,
        SqlValue::Integer(n) => Value::Integer(*n),
        SqlValue::Real(n) => Value::Real(*n),
        SqlValue::Text(s) => Value::Text(s.clone()),
        SqlValue::Blob(b) => Value::Blob(b.clone()),
    }
}
fn from_sql(v: rusqlite::types::ValueRef<'_>) -> SqlValue {
    use rusqlite::types::ValueRef;
    match v {
        ValueRef::Null => SqlValue::Null,
        ValueRef::Integer(n) => SqlValue::Integer(n),
        ValueRef::Real(n) => SqlValue::Real(n),
        ValueRef::Text(s) => SqlValue::Text(std::str::from_utf8(s).unwrap().into()),
        ValueRef::Blob(b) => SqlValue::Blob(b.to_vec()),
    }
}
impl IndexStorage for Sqlite {
    fn info(&self) -> IndexInfo {
        IndexInfo {
            durability: IndexDurability::Disposable,
            opened: OpenState::Existing,
            sqlite_version: 0,
        }
    }
    fn run(&mut self, b: &Batch) -> std::result::Result<Vec<StmtResult>, IndexError> {
        let err = |e: rusqlite::Error| IndexError::new(IndexErrorKind::Sql, e.to_string());
        let tx = b.mode == BatchMode::Transaction;
        if tx {
            self.db.execute_batch("BEGIN IMMEDIATE").map_err(err)?;
        }
        let result = (|| {
            let mut out = vec![];
            for s in &b.stmts {
                let mut p = self.db.prepare(&s.sql).map_err(err)?;
                let columns = p.column_count() as u32;
                let mut rows = p
                    .query(rusqlite::params_from_iter(s.params.iter().map(to_sql)))
                    .map_err(err)?;
                let mut values = vec![];
                while let Some(row) = rows.next().map_err(err)? {
                    for c in 0..columns {
                        values.push(from_sql(row.get_ref(c as usize).map_err(err)?));
                    }
                }
                out.push(StmtResult {
                    columns,
                    values,
                    changes: self.db.changes(),
                    last_insert_rowid: self.db.last_insert_rowid(),
                });
            }
            Ok(out)
        })();
        if tx {
            self.db
                .execute_batch(if result.is_ok() { "COMMIT" } else { "ROLLBACK" })
                .map_err(err)?;
        }
        let prep = self.lose_prepare
            && b.stmts
                .iter()
                .any(|s| s.sql.starts_with("INSERT INTO mig_native_action("));
        let done = self.lose_settlement
            && b.stmts
                .iter()
                .any(|s| s.sql.starts_with("UPDATE mig_native_action SET settled=1"));
        if result.is_ok() && (prep || done) {
            self.lose_prepare = false;
            self.lose_settlement = false;
            return Err(IndexError::new(
                IndexErrorKind::Other,
                "synthetic lost ACK after real commit",
            ));
        }
        result
    }
    fn reset(&mut self) -> std::result::Result<(), IndexError> {
        self.db
            .execute_batch("DROP TABLE IF EXISTS st_synthetic")
            .map_err(|_| IndexError::new(IndexErrorKind::Other, "reset"))
    }
}
struct TestEntropy(u8);
impl Entropy for TestEntropy {
    fn fill(&mut self, b: &mut [u8]) {
        self.0 += 1;
        b.fill(self.0);
    }
}
fn binding() -> RunBinding {
    RunBinding {
        collection: B16([1; 16]),
        owner: B16([2; 16]),
        started_us: "10413792000000001".into(),
        target: B32([3; 32]),
    }
}
fn open() -> JournalDriver<Sqlite> {
    JournalDriver::resume(Sqlite::new(), binding(), &mut TestEntropy(10)).unwrap()
}
#[test]
fn actual_driver_action_saved_before_effect_and_same_instance_only() {
    let mut a = open();
    assert_eq!(a.collection(), binding().collection);
    assert_ne!(a.driver_id().0, [0; 16]);
    let (t, action) = a.prepare(&mut TestEntropy(20)).unwrap();
    assert_eq!(action, Action::EnsureBackup);
    let retained = std::ptr::from_ref(&a.pending.as_ref().unwrap().1);
    let before = a.driver.checkpoint().to_bytes().unwrap();
    assert_eq!(std::ptr::from_ref(a.prepared_action(&t).unwrap()), retained);
    assert_eq!(a.prepared_action(&t).unwrap(), &Action::EnsureBackup);
    assert_eq!(a.driver.checkpoint().to_bytes().unwrap(), before);
    assert_eq!(a.saved_pending().unwrap().as_ref(), Some(t.data()));
    a.assert_prepared(&t).unwrap();
    assert!(matches!(
        a.prepare(&mut TestEntropy(21)),
        Err(LedgerError::OutstandingUnknown)
    ));
    let mut other = open();
    let (other_ticket, _) = other.prepare(&mut TestEntropy(20)).unwrap();
    assert_eq!(other_ticket.data(), t.data());
    assert_eq!(other.assert_prepared(&t), Err(LedgerError::Refused));
    assert_eq!(other.prepared_action(&t), Err(LedgerError::Refused));
    assert_eq!(a.prepared_action(&other_ticket), Err(LedgerError::Refused));
    assert_eq!(
        a.settle(&t, Outcome::Unknown),
        Err(LedgerError::OutstandingUnknown)
    );
    a.assert_prepared(&t).unwrap();
    assert_eq!(a.prepared_action(&t).unwrap(), &Action::EnsureBackup);
    let result = a
        .settle(
            &t,
            Outcome::Backup {
                hold: "actual-native-test-hold".into(),
            },
        )
        .unwrap();
    a.assert_settled(&t, result).unwrap();
    assert_eq!(
        a.assert_settled(&t, B32([77; 32])),
        Err(LedgerError::Conflict)
    );
    assert_eq!(a.driver.checkpoint().step, Step::BackupHeld);
    assert!(a.saved_pending().unwrap().is_none());
    assert_eq!(a.assert_prepared(&t), Err(LedgerError::Refused));
    assert_eq!(a.prepared_action(&t), Err(LedgerError::Refused));
    let (h1, action) = a.prepare(&mut TestEntropy(30)).unwrap();
    assert_eq!(action, Action::CreateCollection);
    assert_eq!(a.prepared_action(&h1).unwrap(), &Action::CreateCollection);
    assert_eq!(a.prepared_action(&t), Err(LedgerError::Refused));
    assert_eq!(h1.data().sequence, 2);
    assert_ne!(h1.data().action, t.data().action);
    assert_eq!(
        a.settle(&h1, Outcome::Created { verified: true }),
        Err(LedgerError::OutstandingUnknown)
    );
    assert_eq!(a.driver.checkpoint().step, Step::BackupHeld);
    a.assert_prepared(&h1).unwrap();
    assert_eq!(a.prepared_action(&h1).unwrap(), &Action::CreateCollection);
}
#[test]
fn prepared_action_refuses_changed_ticket_without_repolling() {
    let mut a = open();
    let (ticket, _) = a.prepare(&mut TestEntropy(20)).unwrap();
    for field in 0..6 {
        let mut data = ticket.data().clone();
        match field {
            0 => data.sequence += 1,
            1 => data.driver = B16([4; 16]),
            2 => data.action = B16([4; 16]),
            3 => data.kind += 1,
            4 => data.fingerprint = B32([4; 32]),
            _ => data.before.push(0),
        }
        let changed = PreparedAction {
            instance: ticket.instance.clone(),
            data,
        };
        assert_eq!(a.prepared_action(&changed), Err(LedgerError::Refused));
    }
    assert_eq!(a.prepared_action(&ticket).unwrap(), &Action::EnsureBackup);
    assert_eq!(a.saved_pending().unwrap().as_ref(), Some(ticket.data()));
    assert!(matches!(
        a.prepare(&mut TestEntropy(21)),
        Err(LedgerError::OutstandingUnknown)
    ));
}
#[test]
fn lost_prepare_commit_ack_reopens_original_unknown_no_second_id() {
    let mut a = open();
    a.spill.index_mut().lose_prepare = true;
    assert!(matches!(
        a.prepare(&mut TestEntropy(20)),
        Err(LedgerError::StorageUnknown)
    ));
    let original = a.saved_pending().unwrap().unwrap();
    let index = a.into_index();
    let mut b = JournalDriver::resume(index, binding(), &mut TestEntropy(50)).unwrap();
    assert_eq!(b.saved_pending().unwrap().as_ref(), Some(&original));
    // Even a ticket assembled inside this private fixture from saved DATA and
    // the current instance has no retained actual Action after reopening.
    let reconstructed = PreparedAction {
        instance: b.instance.clone(),
        data: original,
    };
    assert_eq!(b.prepared_action(&reconstructed), Err(LedgerError::Refused));
    assert!(matches!(
        b.prepare(&mut TestEntropy(60)),
        Err(LedgerError::OutstandingUnknown)
    ));
}
#[test]
fn foreign_owner_started_target_and_preexisting_unbound_checkpoint_refuse() {
    for change in 0..3 {
        let a = open();
        let mut different = binding();
        match change {
            0 => different.owner = B16([4; 16]),
            1 => different.started_us = "10413792000000002".into(),
            _ => different.target = B32([4; 32]),
        }
        assert!(matches!(
            JournalDriver::resume(a.into_index(), different, &mut TestEntropy(20)),
            Err(LedgerError::Conflict)
        ));
    }
    let mut spill = SqlSpill::open(Sqlite::new()).unwrap();
    let mut cp = mdbn_migrate_portable::hosted_import::Checkpoint::new(
        &binding().collection.to_uuid_string(),
    );
    cp.step = Step::BackupHeld;
    cp.backup_hold = Some("old-run".into());
    cp.fence_first = true;
    let old = cp.to_bytes().unwrap();
    spill.save(&old).unwrap();
    assert!(matches!(
        JournalDriver::resume(spill.into_inner(), binding(), &mut TestEntropy(20)),
        Err(LedgerError::Conflict)
    ));
}
#[test]
fn settlement_and_checkpoint_are_atomic_and_lost_ack_stays_unknown_in_ram() {
    let mut a = open();
    let (t, _) = a.prepare(&mut TestEntropy(20)).unwrap();
    a.spill.index_mut().lose_settlement = true;
    assert_eq!(
        a.settle(
            &t,
            Outcome::Backup {
                hold: "original-hold".into()
            }
        ),
        Err(LedgerError::StorageUnknown)
    );
    assert_eq!(a.assert_prepared(&t), Err(LedgerError::Refused));
    assert_eq!(a.prepared_action(&t), Err(LedgerError::Refused));
    let index = a.into_index();
    let saved: Vec<u8> = index
        .db
        .query_row("SELECT v FROM mig_checkpoint WHERE k=0", [], |r| r.get(0))
        .unwrap();
    assert_eq!(
        mdbn_migrate_portable::hosted_import::Checkpoint::from_bytes(&saved)
            .unwrap()
            .step,
        Step::BackupHeld
    );
    let (settled, after): (i64, Vec<u8>) = index
        .db
        .query_row(
            "SELECT settled,after_cp FROM mig_native_action WHERE seq=1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(settled, 1);
    assert_eq!(after, saved);
    // This is exact readback DATA, not a physical commit/output acknowledgment.
}
#[test]
fn checkpoint_drift_or_settlement_failure_never_clears_pending() {
    let mut a = open();
    let (t, _) = a.prepare(&mut TestEntropy(20)).unwrap();
    a.spill
        .index_mut()
        .db
        .execute("UPDATE mig_checkpoint SET v=?1 WHERE k=0", [vec![0u8]])
        .unwrap();
    assert_eq!(a.assert_prepared(&t), Err(LedgerError::Conflict));
    assert_eq!(a.prepared_action(&t), Err(LedgerError::Conflict));
    assert_eq!(
        a.spill
            .index_mut()
            .db
            .query_row("SELECT settled FROM mig_native_action", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
    let mut a = open();
    let (t, _) = a.prepare(&mut TestEntropy(20)).unwrap();
    let before = t.data().before.clone();
    a.spill.index_mut().db.execute_batch("CREATE TRIGGER synthetic_fail AFTER UPDATE ON mig_checkpoint BEGIN SELECT RAISE(ABORT,'synthetic storage failure'); END").unwrap();
    assert_eq!(
        a.settle(
            &t,
            Outcome::Backup {
                hold: "hold".into()
            }
        ),
        Err(LedgerError::StorageUnknown)
    );
    assert_eq!(a.saved_pending().unwrap().unwrap().before, before);
    assert_eq!(a.spill.load().unwrap(), Some(before));
}
#[test]
fn immutable_original_identity_raw_mutations_and_cache_reset() {
    let mut a = open();
    let (t, _) = a.prepare(&mut TestEntropy(20)).unwrap();
    let index = a.spill.index_mut();
    for sql in [
        "DELETE FROM mig_native_run",
        "UPDATE mig_native_run SET started='4'",
        "DELETE FROM mig_native_action",
        "UPDATE mig_native_action SET kind=7",
    ] {
        assert!(index.db.execute_batch(sql).is_err(), "{sql}");
    }
    index
        .db
        .execute_batch("CREATE TABLE st_synthetic(v TEXT)")
        .unwrap();
    index.reset().unwrap();
    assert_eq!(a.saved_pending().unwrap().as_ref(), Some(t.data()));
    a.assert_prepared(&t).unwrap();
}
#[test]
fn invalid_bounds_and_wrong_outcome_refuse_without_checkpoint_completion() {
    for started in [
        "",
        "0",
        "01",
        "+1",
        "1.0",
        "1e4",
        "100000000000000000000000000000000",
    ] {
        let mut b = binding();
        b.started_us = started.into();
        assert!(matches!(
            JournalDriver::resume(Sqlite::new(), b, &mut TestEntropy(20)),
            Err(LedgerError::Invalid)
        ));
    }
    let mut a = open();
    let (t, _) = a.prepare(&mut TestEntropy(20)).unwrap();
    assert_eq!(
        a.settle(&t, Outcome::Created { verified: false }),
        Err(LedgerError::Unsupported)
    );
    a.assert_prepared(&t).unwrap();
    assert_eq!(a.driver.checkpoint().step, Step::Start);
    assert!(
        codec::action(&Action::ImportGen0 {
            bits: 1,
            bucket: Some(0),
            after: Some(mdbn_migrate_portable::hosted_import::Key {
                kind: mdbn_migrate_portable::preflight::EntityKind::Record,
                id: "old".into()
            })
        })
        .is_err()
    );
}
