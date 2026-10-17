//! Immutable run history and the singleton-to-sequence SQLite upgrade.
#[cfg(test)]
mod tests;
use super::*;
use mdbn_migrate_portable::hosted_import::Checkpoint;

const RUN: &str = "CREATE TABLE IF NOT EXISTS mig_native_run(seq INTEGER PRIMARY KEY CHECK(seq BETWEEN 1 AND 9007199254740991), driver BLOB NOT NULL UNIQUE CHECK(length(driver)=16), collection BLOB NOT NULL CHECK(length(collection)=16), owner BLOB NOT NULL CHECK(length(owner)=16), started TEXT NOT NULL CHECK(length(started) BETWEEN 1 AND 32), target BLOB NOT NULL CHECK(length(target)=32))";
// One transaction, including trigger replacement. Never rename the old table:
// SQLite would retarget the action guard to the temporary historical name.
const UPGRADE: &[&str] = &[
    "DROP TRIGGER IF EXISTS mig_native_action_insert",
    "DROP TRIGGER IF EXISTS mig_native_action_settle",
    "DROP TRIGGER IF EXISTS mig_native_run_no_update",
    "DROP TRIGGER IF EXISTS mig_native_run_no_delete",
    "CREATE TABLE mig_native_run_upgrade AS SELECT 1 AS seq,driver,collection,owner,started,target FROM mig_native_run WHERE k=0",
    "DROP TABLE mig_native_run",
    RUN,
    "INSERT INTO mig_native_run SELECT seq,driver,collection,owner,started,target FROM mig_native_run_upgrade",
    "DROP TABLE mig_native_run_upgrade",
];

pub(super) fn schema<I: IndexStorage>(index: &mut I) -> Result<()> {
    let info = run(
        index,
        vec![Stmt::new("PRAGMA table_info(mig_native_run)", vec![])],
        BatchMode::Autocommit,
    )?;
    let columns: Vec<&str> = info
        .first()
        .ok_or(LedgerError::Corrupt)?
        .rows()
        .map(|row| match row.get(1) {
            Some(SqlValue::Text(s)) => Ok(s.as_str()),
            _ => Err(LedgerError::Corrupt),
        })
        .collect::<Result<_>>()?;
    let mut stmts = match columns.as_slice() {
        [] | ["seq", "driver", "collection", "owner", "started", "target"] => {
            vec![Stmt::new(RUN, vec![])]
        }
        ["k", "driver", "collection", "owner", "started", "target"] => {
            UPGRADE.iter().map(|sql| Stmt::new(*sql, vec![])).collect()
        }
        _ => return Err(LedgerError::Corrupt),
    };
    stmts.extend([
        Stmt::new(ACTIONS, vec![]),
        Stmt::new("CREATE UNIQUE INDEX IF NOT EXISTS mig_native_outstanding ON mig_native_action(driver) WHERE settled=0", vec![]),
        Stmt::new("DROP TRIGGER IF EXISTS mig_native_action_insert", vec![]),
        Stmt::new(GUARD, vec![]),
        Stmt::new("DROP TRIGGER IF EXISTS mig_native_action_settle", vec![]),
        Stmt::new(SETTLE, vec![]),
        Stmt::new("CREATE TRIGGER IF NOT EXISTS mig_native_run_no_update BEFORE UPDATE ON mig_native_run BEGIN SELECT RAISE(ABORT,'immutable migration run'); END", vec![]),
        Stmt::new("CREATE TRIGGER IF NOT EXISTS mig_native_run_no_delete BEFORE DELETE ON mig_native_run BEGIN SELECT RAISE(ABORT,'immutable migration run'); END", vec![]),
        Stmt::new("CREATE TRIGGER IF NOT EXISTS mig_native_action_no_delete BEFORE DELETE ON mig_native_action BEGIN SELECT RAISE(ABORT,'immutable migration action'); END", vec![]),
        Stmt::new("CREATE TABLE IF NOT EXISTS mig_native_run_end(seq INTEGER PRIMARY KEY CHECK(seq BETWEEN 1 AND 9007199254740991), checkpoint BLOB NOT NULL CHECK(length(checkpoint)<=61440))", vec![]),
        Stmt::new("CREATE TRIGGER IF NOT EXISTS mig_native_run_end_no_update BEFORE UPDATE ON mig_native_run_end BEGIN SELECT RAISE(ABORT,'immutable migration end'); END", vec![]),
        Stmt::new("CREATE TRIGGER IF NOT EXISTS mig_native_run_end_no_delete BEFORE DELETE ON mig_native_run_end BEGIN SELECT RAISE(ABORT,'immutable migration end'); END", vec![]),
    ]);
    run(index, stmts, BatchMode::Transaction)?;
    Ok(())
}

/// Read-only identity and checkpoint for a specific run; no execution authority.
pub(crate) struct RunData {
    pub(crate) sequence: u64,
    pub(crate) driver: Uuid,
    pub(crate) binding: RunBinding,
    pub(crate) checkpoint: Checkpoint,
}
impl<I: IndexStorage> JournalDriver<I> {
    #[cfg(test)]
    pub(crate) fn run_sequence(&self) -> u64 {
        self.sequence
    }

    pub(crate) fn read_run(&mut self, sequence: u64) -> Result<Option<RunData>> {
        if sequence > MAX_SEQ {
            return Err(LedgerError::Invalid);
        }
        let rows = run(
            self.spill.index_mut(),
            vec![Stmt::new(
                "SELECT r.seq,r.driver,r.collection,r.owner,r.started,r.target,CASE WHEN r.seq=(SELECT MAX(seq) FROM mig_native_run) THEN (SELECT CASE WHEN length(v)<=61440 THEN v ELSE 0 END FROM mig_checkpoint WHERE k=0) ELSE e.checkpoint END FROM mig_native_run r LEFT JOIN mig_native_run_end e ON e.seq=r.seq WHERE r.seq=CASE WHEN ?1=0 THEN (SELECT MAX(seq) FROM mig_native_run) ELSE ?1 END",
                vec![SqlValue::Integer(sequence as i64)],
            )],
            BatchMode::Autocommit,
        )?;
        match rows.first().ok_or(LedgerError::Corrupt)?.rows().next() {
            None => Ok(None),
            Some([seq, d, c, o, SqlValue::Text(start), t, cp]) => {
                let sequence = integer(seq)?;
                let checkpoint = match cp {
                    SqlValue::Blob(b) if b.len() <= MAX_CHECKPOINT => {
                        Checkpoint::from_bytes(b).map_err(|_| LedgerError::Corrupt)?
                    }
                    SqlValue::Null
                        if sequence == self.sequence
                            && self.driver.checkpoint().step == Step::Start =>
                    {
                        self.driver.checkpoint().clone()
                    }
                    _ => return Err(LedgerError::Corrupt),
                };
                let binding = RunBinding {
                    collection: B16(bytes(c)?),
                    owner: B16(bytes(o)?),
                    started_us: start.clone(),
                    target: B32(bytes(t)?),
                };
                let driver = B16(bytes(d)?);
                if driver.0 == [0; 16]
                    || !binding.valid()
                    || checkpoint.collection != binding.collection.to_uuid_string()
                {
                    return Err(LedgerError::Corrupt);
                }
                Ok(Some(RunData {
                    sequence,
                    driver,
                    binding,
                    checkpoint,
                }))
            }
            _ => Err(LedgerError::Corrupt),
        }
    }

    /// Retry only while the actual accepted target log is still pre-cutover.
    /// A CP cutover can exist even without a local cutover action receipt.
    pub(crate) fn restart_on_target<S: mdbn_replica::Store>(
        &mut self,
        expected: u64,
        binding: &RunBinding,
        entropy: &mut dyn Entropy,
        engine: &mut crate::runtime::Engine<S>,
        target: &crate::runtime::ObservedNativeTarget,
    ) -> Result<()> {
        self.pre_cutover_target(engine, target)?;
        self.restart(expected, binding, entropy)
    }

    pub(super) fn pre_cutover_target<S: mdbn_replica::Store>(
        &self,
        engine: &mut crate::runtime::Engine<S>,
        target: &crate::runtime::ObservedNativeTarget,
    ) -> Result<()> {
        if target.admission().collection() != self.binding.collection
            || target.genesis_owner() != self.binding.owner
            || target_fingerprint(target) != self.binding.target
        {
            return Err(LedgerError::Conflict);
        }
        let replica = engine
            .migration_gen0_replica(target)
            .map_err(|_| LedgerError::Refused)?;
        if !matches!(
            replica.hosted_migration_cutover(target.admission()),
            Ok(None)
        ) {
            return Err(LedgerError::Refused);
        }
        Ok(())
    }

    /// Explicit compare-and-start, never an automatic resume fallback.
    fn restart(
        &mut self,
        expected: u64,
        binding: &RunBinding,
        entropy: &mut dyn Entropy,
    ) -> Result<()> {
        if self.poisoned {
            return Err(LedgerError::StorageUnknown);
        }
        if expected != self.sequence || binding != &self.binding || expected >= MAX_SEQ {
            return Err(LedgerError::Conflict);
        }
        if self.pending.is_some() || self.saved_pending()?.is_some() {
            return Err(LedgerError::OutstandingUnknown);
        }
        let mut cp = self.driver.checkpoint().clone();
        if !matches!(cp.step, Step::RolledBack | Step::RollingBack)
            || cp.fenced
            || !cp.revoked.is_empty()
            || cp.cutover_seq.is_some()
            || cp.barrier_f.is_some()
            || cp.intent_mutation.is_some()
            || cp.intent_last.is_some()
            || cp.replay_after.is_some()
            || cp.replay_pass != 0
        {
            return Err(LedgerError::Refused);
        }
        let evidence = run(
            self.spill.index_mut(),
            vec![Stmt::new(
                "SELECT seq FROM mig_native_action WHERE driver=?1 AND kind IN(15,16,17,18,19) LIMIT 1",
                vec![blob(&self.id.0)],
            )],
            BatchMode::Autocommit,
        )?;
        if evidence[0].row_count() != 0 {
            return Err(LedgerError::Refused);
        }
        // The portable Driver's only remaining transition is effect-free Done.
        cp.step = Step::RolledBack;
        let archived = cp.to_bytes().map_err(|_| LedgerError::Corrupt)?;
        let mut fresh = Checkpoint::new(&cp.collection);
        fresh.fence_first = true;
        let fresh = fresh.to_bytes().map_err(|_| LedgerError::Corrupt)?;
        let id = uuid(entropy)?;
        let mut params = binding.params(id);
        params.push(SqlValue::Integer((expected + 1) as i64));
        let saved = self
            .driver
            .checkpoint()
            .to_bytes()
            .map_err(|_| LedgerError::Corrupt)?;
        let result = run(
            self.spill.index_mut(),
            vec![
                Stmt::new(
                    "INSERT INTO mig_native_run_end(seq,checkpoint) SELECT ?1,?2 WHERE EXISTS(SELECT 1 FROM mig_native_run WHERE seq=?1 AND driver=?3 AND seq=(SELECT MAX(seq) FROM mig_native_run)) AND NOT EXISTS(SELECT 1 FROM mig_native_action WHERE settled=0 OR (driver=?3 AND kind IN(15,16,17,18,19))) AND EXISTS(SELECT 1 FROM mig_checkpoint WHERE k=0 AND v=?4)",
                    vec![
                        SqlValue::Integer(expected as i64),
                        blob(&archived),
                        blob(&self.id.0),
                        blob(&saved),
                    ],
                ),
                // The archive insertion must have happened in THIS transaction.
                Stmt::new(
                    "INSERT INTO mig_native_run(seq,driver,collection,owner,started,target) VALUES(CASE WHEN changes()=1 THEN ?6 ELSE 0 END,?1,?2,?3,?4,?5)",
                    params,
                ),
                Stmt::new(
                    "UPDATE mig_checkpoint SET v=?1 WHERE k=0",
                    vec![blob(&fresh)],
                ),
                Stmt::new("DELETE FROM mig_claim", vec![]),
                Stmt::new("DELETE FROM mig_place", vec![]),
                Stmt::new("DELETE FROM mig_deferred", vec![]),
            ],
            BatchMode::Transaction,
        );
        if let Err(e) = result {
            self.poisoned = true;
            return Err(e);
        }
        // A failed read after the committed reset also requires reopening; the
        // old in-memory Driver must never be treated as current again.
        self.poisoned = true;
        self.driver =
            crate::migration_checkpoint::resume_fence_first(&mut self.spill, binding.collection)
                .map_err(|_| LedgerError::StorageUnknown)?;
        self.poisoned = false;
        self.sequence += 1;
        self.id = id;
        self.instance = Rc::new(());
        self.gen0_custody = None;
        self.gen0_staged = None;
        self.base_refs = None;
        self.log_base = None;
        self.log_rebuilt = None;
        Ok(())
    }
}
