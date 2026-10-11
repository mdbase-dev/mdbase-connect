//! Native Driver action identity and settlement beside the SAME SqlSpill.
//!
//! SQL success is NOT physical commit. The private host bridge must confirm the
//! actual storage before acknowledging a prepared action or exposing settlement.
//! This journal does not issue H1/effect authority: FULL, CPP, physical placement,
//! source witness/hold and deletion currentness remain independent requirements.
//! Outstanding actions survive reopening as UNKNOWN, never as permission to retry.

mod capture;
mod codec;

use mdbn_core::host::Entropy;
use mdbn_migrate_portable::hosted_import::{Action, Driver, Outcome, Spill, SqlSpill, Step};
use mdbn_store_file::index::{Batch, BatchMode, IndexStorage, SqlValue, Stmt, StmtResult};
use mdbn_wire::common::{B16, B32, Uuid};
use std::rc::Rc;

const MAX_CHECKPOINT: usize = 60 * 1024;
const MAX_SEQ: u64 = 9_007_199_254_740_991;
const RUN: &str = "CREATE TABLE IF NOT EXISTS mig_native_run(k INTEGER PRIMARY KEY CHECK(k=0), driver BLOB NOT NULL CHECK(length(driver)=16), collection BLOB NOT NULL CHECK(length(collection)=16), owner BLOB NOT NULL CHECK(length(owner)=16), started TEXT NOT NULL CHECK(length(started) BETWEEN 1 AND 32), target BLOB NOT NULL CHECK(length(target)=32))";
const ACTIONS: &str = "CREATE TABLE IF NOT EXISTS mig_native_action(seq INTEGER PRIMARY KEY CHECK(seq BETWEEN 1 AND 9007199254740991), driver BLOB NOT NULL CHECK(length(driver)=16), action BLOB NOT NULL UNIQUE CHECK(length(action)=16), kind INTEGER NOT NULL, fingerprint BLOB NOT NULL CHECK(length(fingerprint)=32), before_cp BLOB NOT NULL CHECK(length(before_cp)<=61440), settled INTEGER NOT NULL DEFAULT 0 CHECK(settled IN(0,1)), after_cp BLOB CHECK(after_cp IS NULL OR length(after_cp)<=61440), result BLOB CHECK(result IS NULL OR length(result)=32), CHECK((settled=0 AND after_cp IS NULL AND result IS NULL) OR (settled=1 AND after_cp IS NOT NULL AND result IS NOT NULL)))";
const SELECT_PENDING: &str = "SELECT seq,driver,action,kind,fingerprint,CASE WHEN length(before_cp)<=61440 THEN before_cp ELSE NULL END FROM mig_native_action WHERE settled=0 ORDER BY seq LIMIT 1";
const GUARD: &str = "CREATE TRIGGER IF NOT EXISTS mig_native_action_insert BEFORE INSERT ON mig_native_action BEGIN SELECT CASE WHEN NEW.settled!=0 OR NOT EXISTS(SELECT 1 FROM mig_native_run WHERE driver=NEW.driver) OR NOT EXISTS(SELECT 1 FROM mig_checkpoint WHERE k=0 AND v=NEW.before_cp) THEN RAISE(ABORT,'migration pending binding') END; END";
// Settlement and checkpoint transition are ONE SQLite transaction/trigger. No
// checkpoint-before-receipt interval; validation failure rolls both back.
const SETTLE: &str = "CREATE TRIGGER IF NOT EXISTS mig_native_action_settle BEFORE UPDATE ON mig_native_action BEGIN SELECT CASE WHEN OLD.settled!=0 OR NEW.settled!=1 OR NEW.seq!=OLD.seq OR NEW.driver!=OLD.driver OR NEW.action!=OLD.action OR NEW.kind!=OLD.kind OR NEW.fingerprint!=OLD.fingerprint OR NEW.before_cp!=OLD.before_cp OR NOT EXISTS(SELECT 1 FROM mig_checkpoint WHERE k=0 AND v=OLD.before_cp) THEN RAISE(ABORT,'migration settlement binding') END; UPDATE mig_checkpoint SET v=NEW.after_cp WHERE k=0; END";

/// DATA from the authenticated source/native target producer, not a permit.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct RunBinding {
    pub(crate) collection: Uuid,
    pub(crate) owner: Uuid,
    pub(crate) started_us: String,
    pub(crate) target: B32,
}
impl RunBinding {
    fn valid(&self) -> bool {
        self.collection.0 != [0; 16]
            && self.owner.0 != [0; 16]
            && self.target.0 != [0; 32]
            && !self.started_us.is_empty()
            && self.started_us.len() <= 32
            && !self.started_us.starts_with('0')
            && self.started_us.bytes().all(|b| b.is_ascii_digit())
    }
    fn params(&self, driver: Uuid) -> Vec<SqlValue> {
        vec![
            blob(&driver.0),
            blob(&self.collection.0),
            blob(&self.owner.0),
            SqlValue::Text(self.started_us.clone()),
            blob(&self.target.0),
        ]
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum LedgerError {
    Invalid,
    Unsupported,
    Conflict,
    OutstandingUnknown,
    StorageUnknown,
    Corrupt,
    Refused,
}
type Result<T> = std::result::Result<T, LedgerError>;

/// Original saved identity; safe to inspect, never converts to a live ticket.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct PendingData {
    pub(crate) sequence: u64,
    pub(crate) driver: Uuid,
    pub(crate) action: Uuid,
    pub(crate) kind: u64,
    pub(crate) fingerprint: B32,
    before: Vec<u8>,
}
/// Opaque SAME-native-instance prepared ticket, not H1/effect permission.
pub(crate) struct PreparedAction {
    instance: Rc<()>,
    data: PendingData,
}
impl PreparedAction {
    pub(crate) fn data(&self) -> &PendingData {
        &self.data
    }
}

/// One actual Driver, one SqlSpill. No parallel state machine/dispatcher.
pub(crate) struct JournalDriver<I: IndexStorage> {
    spill: SqlSpill<I>,
    driver: Driver,
    binding: RunBinding,
    id: Uuid,
    instance: Rc<()>,
    pending: Option<(PendingData, Action)>,
    poisoned: bool,
}
fn blob(b: &[u8]) -> SqlValue {
    SqlValue::Blob(b.to_vec())
}
fn uuid(entropy: &mut dyn Entropy) -> Result<Uuid> {
    let mut b = [0; 16];
    entropy.fill(&mut b);
    // Refuse a broken entropy source; no fixed fallback/positive authority.
    if b == [0; 16] {
        return Err(LedgerError::Invalid);
    }
    b[6] = (b[6] & 15) | 0x40;
    b[8] = (b[8] & 63) | 0x80;
    Ok(B16(b))
}
fn run<I: IndexStorage>(
    index: &mut I,
    stmts: Vec<Stmt>,
    mode: BatchMode,
) -> Result<Vec<StmtResult>> {
    index
        .run(&Batch { mode, stmts })
        .map_err(|_| LedgerError::StorageUnknown)
}
fn bytes<const N: usize>(v: &SqlValue) -> Result<[u8; N]> {
    let SqlValue::Blob(b) = v else {
        return Err(LedgerError::Corrupt);
    };
    b.as_slice().try_into().map_err(|_| LedgerError::Corrupt)
}
fn integer(v: &SqlValue) -> Result<u64> {
    let SqlValue::Integer(n) = v else {
        return Err(LedgerError::Corrupt);
    };
    u64::try_from(*n).map_err(|_| LedgerError::Corrupt)
}
fn pending(row: &[SqlValue]) -> Result<PendingData> {
    let [s, d, a, k, f, SqlValue::Blob(before)] = row else {
        return Err(LedgerError::Corrupt);
    };
    let sequence = integer(s)?;
    let kind = integer(k)?;
    if sequence == 0 || sequence > MAX_SEQ || before.len() > MAX_CHECKPOINT || kind > 23 {
        return Err(LedgerError::Corrupt);
    }
    let data = PendingData {
        sequence,
        driver: B16(bytes(d)?),
        action: B16(bytes(a)?),
        kind,
        fingerprint: B32(bytes(f)?),
        before: before.clone(),
    };
    if data.driver.0 == [0; 16] || data.action.0 == [0; 16] {
        return Err(LedgerError::Corrupt);
    }
    Ok(data)
}
impl<I: IndexStorage> JournalDriver<I> {
    pub(crate) fn resume(index: I, binding: RunBinding, entropy: &mut dyn Entropy) -> Result<Self> {
        if !binding.valid() {
            return Err(LedgerError::Invalid);
        }
        let mut spill = SqlSpill::open(index).map_err(|_| LedgerError::StorageUnknown)?;
        let driver =
            crate::migration_checkpoint::resume_fence_first(&mut spill, binding.collection)
                .map_err(|_| LedgerError::Invalid)?;
        run(
            spill.index_mut(),
            vec![
                Stmt::new(RUN, vec![]),
                Stmt::new(ACTIONS, vec![]),
                Stmt::new(
                    "CREATE UNIQUE INDEX IF NOT EXISTS mig_native_outstanding ON mig_native_action(driver) WHERE settled=0",
                    vec![],
                ),
                Stmt::new(GUARD, vec![]),
                Stmt::new(SETTLE, vec![]),
                Stmt::new(
                    "CREATE TRIGGER IF NOT EXISTS mig_native_run_no_update BEFORE UPDATE ON mig_native_run BEGIN SELECT RAISE(ABORT,'immutable migration run'); END",
                    vec![],
                ),
                Stmt::new(
                    "CREATE TRIGGER IF NOT EXISTS mig_native_run_no_delete BEFORE DELETE ON mig_native_run BEGIN SELECT RAISE(ABORT,'immutable migration run'); END",
                    vec![],
                ),
                Stmt::new(
                    "CREATE TRIGGER IF NOT EXISTS mig_native_action_no_delete BEFORE DELETE ON mig_native_action BEGIN SELECT RAISE(ABORT,'immutable migration action'); END",
                    vec![],
                ),
            ],
            BatchMode::Transaction,
        )?;
        let mut rows = run(
            spill.index_mut(),
            vec![Stmt::new(
                "SELECT driver,collection,owner,started,target FROM mig_native_run WHERE k=0 LIMIT 1",
                vec![],
            )],
            BatchMode::Autocommit,
        )?;
        let row = rows.pop().ok_or(LedgerError::Corrupt)?;
        let id = match row.rows().next() {
            Some([d, c, o, SqlValue::Text(start), t]) => {
                let id = B16(bytes(d)?);
                if id.0 == [0; 16]
                    || binding.params(id)
                        != vec![
                            d.clone(),
                            c.clone(),
                            o.clone(),
                            SqlValue::Text(start.clone()),
                            t.clone(),
                        ]
                {
                    return Err(LedgerError::Conflict);
                }
                id
            }
            None if driver.checkpoint().step == Step::Start => {
                let id = uuid(entropy)?;
                run(
                    spill.index_mut(),
                    vec![Stmt::new(
                        "INSERT INTO mig_native_run(k,driver,collection,owner,started,target) VALUES(0,?1,?2,?3,?4,?5)",
                        binding.params(id),
                    )],
                    BatchMode::Transaction,
                )?;
                id
            }
            None => return Err(LedgerError::Conflict),
            _ => return Err(LedgerError::Corrupt),
        };
        Ok(Self {
            spill,
            driver,
            binding,
            id,
            instance: Rc::new(()),
            pending: None,
            poisoned: false,
        })
    }
    #[cfg(target_arch = "wasm32")]
    pub(crate) fn matches_binding(&self, binding: &RunBinding) -> bool {
        !self.poisoned && &self.binding == binding
    }
    pub(crate) fn collection(&self) -> Uuid {
        self.binding.collection
    }
    pub(crate) fn driver_id(&self) -> Uuid {
        self.id
    }
    pub(crate) fn saved_pending(&mut self) -> Result<Option<PendingData>> {
        // Detect a corrupt competing outstanding action without hydrating two
        // checkpoint blobs. Each read remains <=128 rows /64KiB.
        let count = run(
            self.spill.index_mut(),
            vec![Stmt::new(
                "SELECT seq FROM mig_native_action WHERE settled=0 ORDER BY seq LIMIT 2",
                vec![],
            )],
            BatchMode::Autocommit,
        )?;
        if count.len() != 1 || count[0].row_count() > 1 {
            return Err(LedgerError::Corrupt);
        }
        let mut rows = run(
            self.spill.index_mut(),
            vec![Stmt::new(SELECT_PENDING, vec![])],
            BatchMode::Autocommit,
        )?;
        let row = rows.pop().ok_or(LedgerError::Corrupt)?;
        if row.row_count() > 1 {
            return Err(LedgerError::Corrupt);
        }
        row.rows().next().map(pending).transpose()
    }
    /// Poll the actual Driver and save the exact issued action BEFORE effect IO.
    /// A reopened pending row cannot mint a replacement or live ticket.
    pub(crate) fn prepare(
        &mut self,
        entropy: &mut dyn Entropy,
    ) -> Result<(PreparedAction, Action)> {
        if self.poisoned {
            return Err(LedgerError::StorageUnknown);
        }
        if self.pending.is_some() || self.saved_pending()?.is_some() {
            return Err(LedgerError::OutstandingUnknown);
        }
        let action = self
            .driver
            .poll(&mut self.spill)
            .map_err(|_| LedgerError::Refused)?;
        let (kind, fingerprint) = codec::action(&action)?;
        let before = self
            .driver
            .checkpoint()
            .to_bytes()
            .map_err(|_| LedgerError::Invalid)?;
        if before.len() > MAX_CHECKPOINT {
            return Err(LedgerError::Invalid);
        }
        let mut rows = run(
            self.spill.index_mut(),
            vec![Stmt::new(
                "SELECT seq FROM mig_native_action ORDER BY seq DESC LIMIT 1",
                vec![],
            )],
            BatchMode::Autocommit,
        )?;
        let row = rows.pop().ok_or(LedgerError::Corrupt)?;
        let seq = match row.rows().next() {
            Some([v]) => integer(v)?.checked_add(1).ok_or(LedgerError::Invalid)?,
            None => 1,
            _ => return Err(LedgerError::Corrupt),
        };
        if seq > MAX_SEQ {
            return Err(LedgerError::Invalid);
        }
        let data = PendingData {
            sequence: seq,
            driver: self.id,
            action: uuid(entropy)?,
            kind,
            fingerprint,
            before,
        };
        // Save a fresh Start checkpoint, or compare a checkpoint already saved
        // by Driver.poll. Never overwrite a foreign/drifted checkpoint.
        let saved = self.spill.load().map_err(|_| LedgerError::StorageUnknown)?;
        if saved.as_ref().is_some_and(|b| *b != data.before) {
            return Err(LedgerError::Conflict);
        }
        let params = vec![
            SqlValue::Integer(seq as i64),
            blob(&self.id.0),
            blob(&data.action.0),
            SqlValue::Integer(kind as i64),
            blob(&fingerprint.0),
            blob(&data.before),
        ];
        let result = run(
            self.spill.index_mut(),
            vec![
                Stmt::new(
                    "INSERT INTO mig_checkpoint(k,v) VALUES(0,?1) ON CONFLICT(k) DO NOTHING",
                    vec![blob(&data.before)],
                ),
                Stmt::new(
                    "INSERT INTO mig_native_action(seq,driver,action,kind,fingerprint,before_cp) VALUES(?1,?2,?3,?4,?5,?6)",
                    params,
                ),
            ],
            BatchMode::Transaction,
        );
        if let Err(e) = result {
            self.poisoned = true;
            return Err(e);
        }
        let read = self.saved_pending();
        if read.as_ref().ok().and_then(|v| v.as_ref()) != Some(&data) {
            self.poisoned = true;
            return Err(read.err().unwrap_or(LedgerError::Corrupt));
        }
        self.pending = Some((data.clone(), action.clone()));
        Ok((
            PreparedAction {
                instance: self.instance.clone(),
                data,
            },
            action,
        ))
    }
    /// VOID native exactness recheck. Physical storage confirmation and effect
    /// authority are separate; this never declares IndexDurability::Durable.
    pub(crate) fn assert_prepared(&mut self, ticket: &PreparedAction) -> Result<()> {
        if self.poisoned
            || !Rc::ptr_eq(&self.instance, &ticket.instance)
            || self.pending.as_ref().map(|p| &p.0) != Some(&ticket.data)
        {
            return Err(LedgerError::Refused);
        }
        if self.saved_pending()?.as_ref() != Some(&ticket.data)
            || self
                .spill
                .load()
                .map_err(|_| LedgerError::StorageUnknown)?
                .as_ref()
                != Some(&ticket.data.before)
        {
            return Err(LedgerError::Conflict);
        }
        Ok(())
    }
    /// Borrow the actual retained action after exact ticket/currentness checks.
    /// Synchronous native-only access, not H1/effect or physical commit authority.
    pub(crate) fn prepared_action(&mut self, ticket: &PreparedAction) -> Result<&Action> {
        self.assert_prepared(ticket)?;
        Ok(&self
            .pending
            .as_ref()
            .expect("assert_prepared checked the retained action")
            .1)
    }
    /// Native producers only: no generic JS Outcome/Created.verified ingress.
    /// H1-positive and UNKNOWN cannot clear an outstanding effect. Source page
    /// mutation completion waits its bounded atomic source adapter integration.
    pub(crate) fn settle(&mut self, ticket: &PreparedAction, outcome: Outcome) -> Result<B32> {
        self.assert_prepared(ticket)?;
        if matches!(
            outcome,
            Outcome::Unknown | Outcome::Created { verified: true }
        ) {
            return Err(LedgerError::OutstandingUnknown);
        }
        let action = &self.pending.as_ref().ok_or(LedgerError::Refused)?.1;
        let result = codec::outcome(action, &outcome)?;
        let mut captured = capture::CheckpointCapture::new(&mut self.spill);
        if self.driver.complete(&mut captured, outcome).is_err() {
            self.poisoned = true;
            return Err(LedgerError::Refused);
        }
        let after = captured.saved.unwrap_or_else(|| ticket.data.before.clone());
        if after.len() > MAX_CHECKPOINT {
            self.poisoned = true;
            return Err(LedgerError::Invalid);
        }
        let mut rows = match run(
            self.spill.index_mut(),
            vec![
                Stmt::new(
                    "UPDATE mig_native_action SET settled=1,after_cp=?1,result=?2 WHERE seq=?3 AND driver=?4 AND action=?5 AND settled=0",
                    vec![
                        blob(&after),
                        blob(&result.0),
                        SqlValue::Integer(ticket.data.sequence as i64),
                        blob(&self.id.0),
                        blob(&ticket.data.action.0),
                    ],
                ),
                Stmt::new("SELECT v FROM mig_checkpoint WHERE k=0 LIMIT 1", vec![]),
            ],
            BatchMode::Transaction,
        ) {
            Ok(r) => r,
            Err(e) => {
                self.poisoned = true;
                return Err(e);
            }
        };
        if rows.len() != 2
            || rows[0].changes != 1
            || rows.pop().and_then(|r| r.values.into_iter().next()) != Some(blob(&after))
        {
            self.poisoned = true;
            return Err(LedgerError::Corrupt);
        }
        self.pending = None;
        Ok(result)
    }
    /// Exact original native settlement readback, still not physical ACK. No
    /// active-only/advanced-step inference and no adoption of a foreign result.
    pub(crate) fn assert_settled(&mut self, ticket: &PreparedAction, result: B32) -> Result<()> {
        if self.poisoned || !Rc::ptr_eq(&self.instance, &ticket.instance) || self.pending.is_some()
        {
            return Err(LedgerError::Refused);
        }
        let mut rows = run(
            self.spill.index_mut(),
            vec![Stmt::new(
                "SELECT CASE WHEN length(after_cp)<=61440 THEN after_cp ELSE NULL END,result,fingerprint FROM mig_native_action WHERE seq=?1 AND driver=?2 AND action=?3 AND before_cp=?4 AND settled=1 LIMIT 1",
                vec![
                    SqlValue::Integer(ticket.data.sequence as i64),
                    blob(&self.id.0),
                    blob(&ticket.data.action.0),
                    blob(&ticket.data.before),
                ],
            )],
            BatchMode::Autocommit,
        )?;
        let row = rows.pop().ok_or(LedgerError::Corrupt)?;
        let Some([SqlValue::Blob(after), r, f]) = row.rows().next() else {
            return Err(LedgerError::Conflict);
        };
        if bytes::<32>(r)? != result.0
            || bytes::<32>(f)? != ticket.data.fingerprint.0
            || self
                .spill
                .load()
                .map_err(|_| LedgerError::StorageUnknown)?
                .as_ref()
                != Some(after)
            || self
                .driver
                .checkpoint()
                .to_bytes()
                .map_err(|_| LedgerError::Corrupt)?
                != *after
        {
            return Err(LedgerError::Conflict);
        }
        Ok(())
    }
    #[cfg(test)]
    pub(crate) fn into_index(self) -> I {
        self.spill.into_inner()
    }
}

#[cfg(test)]
mod tests;
