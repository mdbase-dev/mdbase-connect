//! Native Driver action identity and settlement beside the SAME SqlSpill.
//!
//! SQL success is NOT physical commit. The private host bridge must confirm the
//! actual storage before acknowledging a prepared action or exposing settlement.
//! This journal does not issue H1/effect authority: FULL, CPP, physical placement,
//! source witness/hold and deletion currentness remain independent requirements.
//! Outstanding actions survive reopening as UNKNOWN, never as permission to retry.

mod capture;
mod codec;
mod gen0;
mod log;
#[cfg(test)]
pub(crate) use gen0::Gen0Output;
mod provider;
mod recovery;
mod rollback;
mod runs;
mod source;

use mdbn_core::host::Entropy;
use mdbn_migrate_portable::hosted_import::{Action, Driver, Outcome, Spill, SqlSpill, Step};
use mdbn_store_file::index::{Batch, BatchMode, IndexStorage, SqlValue, Stmt, StmtResult};
use mdbn_wire::common::{B16, B32, Uuid};
use std::rc::Rc;

const MAX_CHECKPOINT: usize = 60 * 1024;
const MAX_SEQ: u64 = 9_007_199_254_740_991;
/// `codec::action` kinds whose settled results later results bind to.
const BACKUP: u64 = 0;
const OPEN_SOURCE: u64 = 2;
const FENCE: u64 = 11;

const ACTIONS: &str = "CREATE TABLE IF NOT EXISTS mig_native_action(seq INTEGER PRIMARY KEY CHECK(seq BETWEEN 1 AND 9007199254740991), driver BLOB NOT NULL CHECK(length(driver)=16), action BLOB NOT NULL UNIQUE CHECK(length(action)=16), kind INTEGER NOT NULL, fingerprint BLOB NOT NULL CHECK(length(fingerprint)=32), before_cp BLOB NOT NULL CHECK(length(before_cp)<=61440), settled INTEGER NOT NULL DEFAULT 0 CHECK(settled IN(0,1)), after_cp BLOB CHECK(after_cp IS NULL OR length(after_cp)<=61440), result BLOB CHECK(result IS NULL OR length(result)=32), CHECK((settled=0 AND after_cp IS NULL AND result IS NULL) OR (settled=1 AND after_cp IS NOT NULL AND result IS NOT NULL)))";
const SELECT_PENDING: &str = "SELECT seq,driver,action,kind,fingerprint,CASE WHEN length(before_cp)<=61440 THEN before_cp ELSE NULL END FROM mig_native_action WHERE settled=0 ORDER BY seq LIMIT 1";
const GUARD: &str = "CREATE TRIGGER IF NOT EXISTS mig_native_action_insert BEFORE INSERT ON mig_native_action BEGIN SELECT CASE WHEN NEW.settled!=0 OR NOT EXISTS(SELECT 1 FROM mig_native_run WHERE driver=NEW.driver AND seq=(SELECT MAX(seq) FROM mig_native_run)) OR NOT EXISTS(SELECT 1 FROM mig_checkpoint WHERE k=0 AND v=NEW.before_cp) THEN RAISE(ABORT,'migration pending binding') END; END";
// Settlement and checkpoint transition are ONE SQLite transaction/trigger. No
// checkpoint-before-receipt interval; validation failure rolls both back.
const SETTLE: &str = "CREATE TRIGGER IF NOT EXISTS mig_native_action_settle BEFORE UPDATE ON mig_native_action BEGIN SELECT CASE WHEN OLD.settled!=0 OR NEW.settled!=1 OR NEW.seq!=OLD.seq OR NEW.driver!=OLD.driver OR NEW.action!=OLD.action OR NEW.kind!=OLD.kind OR NEW.fingerprint!=OLD.fingerprint OR NEW.before_cp!=OLD.before_cp OR NOT EXISTS(SELECT 1 FROM mig_native_run WHERE driver=NEW.driver AND seq=(SELECT MAX(seq) FROM mig_native_run)) OR NOT EXISTS(SELECT 1 FROM mig_checkpoint WHERE k=0 AND v=OLD.before_cp) THEN RAISE(ABORT,'migration settlement binding') END; UPDATE mig_checkpoint SET v=NEW.after_cp WHERE k=0; END";

/// DATA from the authenticated source/native target producer, not a permit.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct RunBinding {
    pub(crate) collection: Uuid,
    pub(crate) owner: Uuid,
    pub(crate) started_us: String,
    pub(crate) target: B32,
}
pub(crate) fn target_fingerprint(target: &crate::runtime::ObservedNativeTarget) -> B32 {
    let mut originals = Vec::with_capacity(96);
    for (_, raw) in target.originals() {
        originals.extend_from_slice(&mdbn_wire::hash::h("mdbase/v1/native-run-original", raw).0);
    }
    mdbn_wire::hash::h("mdbase/v1/native-run-target", &originals)
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
    /// The same collection, owner and target under a strictly newer CP start
    /// (decimal microseconds; `valid` rules out leading zeros).
    fn superseded_by(&self, newer: &RunBinding) -> bool {
        self.collection == newer.collection
            && self.owner == newer.owner
            && self.target == newer.target
            && (self.started_us.len(), self.started_us.as_bytes())
                < (newer.started_us.len(), newer.started_us.as_bytes())
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

/// Why the last [`JournalDriver::prepare_gated`] saved no action. DATA for the
/// host's loop (poll again, wait, stop), never permission to retry an effect.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Idle {
    /// The last prepare saved an action, or none was attempted.
    None = 0,
    /// The Driver did synchronous work; poll again.
    Continue = 1,
    /// The rollout is paused (fence permission not granted).
    WaitPaused = 2,
    /// Fenced; accepted legacy writes are still draining.
    WaitDraining = 3,
    /// The target exists but its service keying/admission is not verified.
    WaitKeying = 4,
    /// Terminal step.
    Done = 5,
    /// A `Rebuild` needs an Engine opened over an empty cache first.
    RebuildGated = 6,
    /// A saved action is outstanding: its outcome is UNKNOWN.
    Outstanding = 7,
    /// Anything else (poisoned, Driver error, an action the ledger refuses).
    Refused = 8,
}

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
    sequence: u64,
    instance: Rc<()>,
    pending: Option<(PendingData, Action)>,
    poisoned: bool,
    /// This read's generation-0 custody slot; RAM only, like the Driver's.
    gen0_custody: Option<gen0::Custody>,
    /// A sealed window/finish awaiting the host's upload verification.
    gen0_staged: Option<gen0::Staged>,
    /// The settled finish's manifest and base refs (RAM only, like the custody).
    base_refs: Option<(B32, Vec<B32>)>,
    /// The base sealed for the retained `AppendBase` (RAM only).
    log_base: Option<log::BaseAppend>,
    /// The head of the settled `Rebuild` that `ReadNew` pages are bound to.
    log_rebuilt: Option<u64>,
    /// Why the last prepare saved nothing (RAM only).
    idle: Idle,
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
        Self::open_run(index, binding, entropy, false)
    }

    /// Open the newest run under its own recorded binding, only so that
    /// [`Self::supersede_on_target`] can replace it: `newer` must be the same
    /// collection, owner and target under a strictly newer start.
    pub(crate) fn resume_superseded(
        index: I,
        newer: &RunBinding,
        entropy: &mut dyn Entropy,
    ) -> Result<Self> {
        Self::open_run(index, newer.clone(), entropy, true)
    }

    fn open_run(
        index: I,
        mut binding: RunBinding,
        entropy: &mut dyn Entropy,
        superseded: bool,
    ) -> Result<Self> {
        if !binding.valid() {
            return Err(LedgerError::Invalid);
        }
        let mut spill = SqlSpill::open(index).map_err(|_| LedgerError::StorageUnknown)?;
        let driver =
            crate::migration_checkpoint::resume_fence_first(&mut spill, binding.collection)
                .map_err(|_| LedgerError::Invalid)?;
        runs::schema(spill.index_mut())?;
        rollback::schema(spill.index_mut())?;
        let mut rows = run(
            spill.index_mut(),
            vec![Stmt::new(
                "SELECT seq,driver,collection,owner,started,target FROM mig_native_run ORDER BY seq DESC LIMIT 1",
                vec![],
            )],
            BatchMode::Autocommit,
        )?;
        let row = rows.pop().ok_or(LedgerError::Corrupt)?;
        let (sequence, id) = match row.rows().next() {
            Some([seq, d, c, o, SqlValue::Text(start), t]) if superseded => {
                let id = B16(bytes(d)?);
                let stored = RunBinding {
                    collection: B16(bytes(c)?),
                    owner: B16(bytes(o)?),
                    started_us: start.clone(),
                    target: B32(bytes(t)?),
                };
                if id.0 == [0; 16] || !stored.superseded_by(&binding) {
                    return Err(LedgerError::Conflict);
                }
                binding = stored;
                (integer(seq)?, id)
            }
            Some([seq, d, c, o, SqlValue::Text(start), t]) => {
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
                (integer(seq)?, id)
            }
            None if driver.checkpoint().step == Step::Start && !superseded => {
                let id = uuid(entropy)?;
                run(
                    spill.index_mut(),
                    vec![Stmt::new(
                        "INSERT INTO mig_native_run(seq,driver,collection,owner,started,target) VALUES(1,?1,?2,?3,?4,?5)",
                        binding.params(id),
                    )],
                    BatchMode::Transaction,
                )?;
                (1, id)
            }
            None => return Err(LedgerError::Conflict),
            _ => return Err(LedgerError::Corrupt),
        };
        Ok(Self {
            spill,
            driver,
            binding,
            id,
            sequence,
            instance: Rc::new(()),
            pending: None,
            poisoned: false,
            gen0_custody: None,
            gen0_staged: None,
            base_refs: None,
            log_base: None,
            log_rebuilt: None,
            idle: Idle::None,
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
    #[cfg(test)]
    pub(crate) fn prepare(
        &mut self,
        entropy: &mut dyn Entropy,
    ) -> Result<(PreparedAction, Action)> {
        self.prepare_gated(entropy, &|_| true)
    }
    /// [`Self::prepare`], refusing BEFORE anything is saved when `gate` refuses
    /// the polled action (a `Rebuild` the Engine cannot settle, see `log`).
    pub(crate) fn prepare_gated(
        &mut self,
        entropy: &mut dyn Entropy,
        gate: &dyn Fn(&Action) -> bool,
    ) -> Result<(PreparedAction, Action)> {
        self.idle = Idle::Refused;
        if self.poisoned {
            return Err(LedgerError::StorageUnknown);
        }
        if self.pending.is_some() || self.saved_pending()?.is_some() {
            self.idle = Idle::Outstanding;
            return Err(LedgerError::OutstandingUnknown);
        }
        let action = self
            .driver
            .poll(&mut self.spill)
            .map_err(|_| LedgerError::Refused)?;
        let (kind, fingerprint) = match codec::action(&action) {
            Ok(v) => v,
            Err(e) => {
                use mdbn_migrate_portable::hosted_import::Wait;
                self.idle = match action {
                    Action::Continue => Idle::Continue,
                    Action::Wait(Wait::Paused) => Idle::WaitPaused,
                    Action::Wait(Wait::Draining) => Idle::WaitDraining,
                    Action::Wait(Wait::Keying) => Idle::WaitKeying,
                    Action::Done(_) => Idle::Done,
                    _ => Idle::Refused,
                };
                return Err(e);
            }
        };
        if !gate(&action) {
            self.idle = if matches!(action, Action::Rebuild { .. }) {
                Idle::RebuildGated
            } else {
                Idle::Refused
            };
            return Err(LedgerError::Refused);
        }
        if matches!(action, Action::Rebuild { .. }) {
            // A new rebuild: earlier pages bind to nothing.
            self.log_rebuilt = None;
        }
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
        self.idle = Idle::None;
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
    /// Why the last prepare saved nothing.
    pub(crate) fn idle(&self) -> Idle {
        self.idle
    }
    /// `[kind, ...params]` of the retained action, exactly as fingerprinted:
    /// what the host executes (table/cursor, revoke IDs, route facts). DATA,
    /// not H1/effect permission; the same ticket checks as settlement.
    pub(crate) fn prepared_fields(&mut self, ticket: &PreparedAction) -> Result<Vec<u8>> {
        let fields = codec::action_fields(self.prepared_action(ticket)?)?;
        mdbn_wire::cbor::encode(&mdbn_wire::cbor::Cbor::Array(fields))
            .map_err(|_| LedgerError::Invalid)
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
    /// H1-positive and UNKNOWN cannot clear an outstanding effect.
    /// Connect/provider results (backup, fence gate, fence, drain, replicas,
    /// revoke, route) refuse here: only [`Self::settle_provider`] binds them.
    /// Source open/page results refuse here: only [`Self::settle_source`].
    /// Log results (base, cutover, head, rebuild, pages) refuse here: only
    /// [`Self::settle_log`] reads them from the Engine.
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
        self.settle_checked(ticket, outcome, result)
    }

    /// Settle the retained action from ONE Connect/provider result body (see
    /// [`provider`]). The body must name this run's collection/owner and, after
    /// a fence, the same provider migration run the settled fence recorded. Any
    /// refusal leaves the original pending outstanding and nothing is written.
    pub(crate) fn settle_provider(&mut self, ticket: &PreparedAction, input: &[u8]) -> Result<B32> {
        self.assert_prepared(ticket)?;
        let decoded = provider::decode(input)?;
        let prior = self.latest_settled(FENCE)?;
        let action = &self.pending.as_ref().ok_or(LedgerError::Refused)?.1;
        let bound = provider::Bound {
            collection: self.binding.collection,
            owner: self.binding.owner,
        };
        let (outcome, provenance) = provider::outcome(action, decoded, &bound, prior.as_ref())?;
        let result = codec::provider_outcome(action, &outcome, provenance)?;
        self.settle_checked(ticket, outcome, result)
    }

    /// Settle the retained `OpenSource`/`ReadPage` from ONE legacy source result
    /// (see [`source`]). An open must name this run's collection, the settled
    /// backup hold and the Driver's fenced head; a page must come from the
    /// current read's settled open (session and head) for the exact table and
    /// cursor asked. Page metadata, the action settlement and the checkpoint
    /// commit in one transaction. A refusal writes nothing and leaves the
    /// original pending outstanding.
    pub(crate) fn settle_source(&mut self, ticket: &PreparedAction, input: &[u8]) -> Result<B32> {
        self.assert_prepared(ticket)?;
        let decoded = source::decode(input)?;
        let backup = self.latest_settled(BACKUP)?;
        let open = self.latest_settled(OPEN_SOURCE)?;
        let action = &self.pending.as_ref().ok_or(LedgerError::Refused)?.1;
        let bound = source::Bound {
            collection: self.binding.collection,
            backup: backup.as_ref(),
            open: open.as_ref(),
        };
        let (outcome, provenance) = source::outcome(action, decoded, &bound)?;
        let result = codec::source_outcome(action, &outcome, provenance)?;
        self.settle_checked(ticket, outcome, result)
    }

    /// The latest settled result digest of one action kind for this run.
    fn latest_settled(&mut self, kind: u64) -> Result<Option<B32>> {
        let mut rows = run(
            self.spill.index_mut(),
            vec![Stmt::new(
                "SELECT result FROM mig_native_action WHERE driver=?1 AND kind=?2 AND settled=1 ORDER BY seq DESC LIMIT 1",
                vec![blob(&self.id.0), SqlValue::Integer(kind as i64)],
            )],
            BatchMode::Autocommit,
        )?;
        let row = rows.pop().ok_or(LedgerError::Corrupt)?;
        match row.rows().next() {
            None => Ok(None),
            Some([r]) => Ok(Some(B32(bytes(r)?))),
            _ => Err(LedgerError::Corrupt),
        }
    }

    /// Positive creation comes only from the actual Engine's complete accepted
    /// originals/FULL admission, bound to this run and current prepared action.
    /// The private owned-Control caller must also recheck its CPP exchange and
    /// the host must physically confirm settlement before returning success.
    pub(crate) fn settle_created<S: mdbn_replica::Store>(
        &mut self,
        ticket: &PreparedAction,
        engine: &mut crate::runtime::Engine<S>,
        target: &crate::runtime::ObservedNativeTarget,
    ) -> Result<B32> {
        self.assert_prepared(ticket)?;
        engine
            .recheck_native_target(target)
            .map_err(|_| LedgerError::Refused)?;
        if target.admission().collection() != self.binding.collection
            || target.genesis_owner() != self.binding.owner
            || target_fingerprint(target) != self.binding.target
            || !matches!(self.prepared_action(ticket)?, Action::CreateCollection)
        {
            return Err(LedgerError::Conflict);
        }
        let outcome = Outcome::Created { verified: true };
        let result = codec::outcome(&Action::CreateCollection, &outcome)?;
        self.settle_checked(ticket, outcome, result)
    }

    fn settle_checked(
        &mut self,
        ticket: &PreparedAction,
        outcome: Outcome,
        result: B32,
    ) -> Result<B32> {
        self.settle_checked_extra(ticket, outcome, result, vec![])
    }

    fn settle_checked_extra(
        &mut self,
        ticket: &PreparedAction,
        outcome: Outcome,
        result: B32,
        extra: Vec<Stmt>,
    ) -> Result<B32> {
        self.assert_prepared(ticket)?;
        let prior_failure = self.driver.checkpoint().failure.clone();
        let mut captured = match capture::CheckpointCapture::new(&mut self.spill) {
            Ok(captured) => captured,
            Err(_) => {
                self.poisoned = true;
                return Err(LedgerError::StorageUnknown);
            }
        };
        if self.driver.complete(&mut captured, outcome).is_err()
            || self.driver.checkpoint().failure != prior_failure
        {
            self.poisoned = true;
            return Err(LedgerError::Refused);
        }
        let (saved, mut statements) = match captured.finish() {
            Ok(result) => result,
            Err(_) => {
                self.poisoned = true;
                return Err(LedgerError::StorageUnknown);
            }
        };
        let after = saved.unwrap_or_else(|| ticket.data.before.clone());
        if after.len() > MAX_CHECKPOINT {
            self.poisoned = true;
            return Err(LedgerError::Invalid);
        }
        let mut composed = extra;
        composed.append(&mut statements);
        let mut statements = composed;
        let metadata_count = statements.len();
        statements.extend([
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
        ]);
        let mut rows = match run(self.spill.index_mut(), statements, BatchMode::Transaction) {
            Ok(r) => r,
            Err(e) => {
                self.poisoned = true;
                return Err(e);
            }
        };
        if rows.len() != metadata_count + 2
            || rows[metadata_count].changes != 1
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
mod capture_tests;
#[cfg(test)]
mod provider_tests;
#[cfg(test)]
mod source_tests;
#[cfg(test)]
pub(crate) mod tests;
