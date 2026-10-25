//! Native rollback intent and full ORIGINAL-receipt qualification.
//! Source/receipt bytes are DATA; only exact saved native context settles them.
use super::*;
use crate::migration_rollback_receipt::{
    OriginalRollbackReceiptData, ReceiptDataError, ReceiptDataKey, RollbackReceiptDataStore,
};
use mdbn_wire::cbor::{self, Cbor};

pub(super) const MAX_INPUT: usize = 40 * 1024;
const CONTEXT: &str = "CREATE TABLE IF NOT EXISTS mig_native_rollback_context(driver BLOB PRIMARY KEY CHECK(length(driver)=16), provider BLOB NOT NULL CHECK(length(provider)=16), started TEXT NOT NULL CHECK(length(started) BETWEEN 1 AND 64), head INTEGER NOT NULL CHECK(head BETWEEN 0 AND 9007199254740991)) WITHOUT ROWID";

pub(super) fn schema<I: IndexStorage>(index: &mut I) -> Result<()> {
    run(
        index,
        vec![
            Stmt::new(CONTEXT, vec![]),
            Stmt::new(
                "CREATE TRIGGER IF NOT EXISTS mig_native_rollback_no_update BEFORE UPDATE ON mig_native_rollback_context BEGIN SELECT RAISE(ABORT,'immutable rollback context'); END",
                vec![],
            ),
            Stmt::new(
                "CREATE TRIGGER IF NOT EXISTS mig_native_rollback_no_delete BEFORE DELETE ON mig_native_rollback_context BEGIN SELECT RAISE(ABORT,'immutable rollback context'); END",
                vec![],
            ),
        ],
        BatchMode::Transaction,
    )?;
    RollbackReceiptDataStore::open(index).map_err(receipt_error)?;
    Ok(())
}
fn receipt_error(e: ReceiptDataError) -> LedgerError {
    match e {
        ReceiptDataError::Invalid => LedgerError::Invalid,
        ReceiptDataError::Conflict => LedgerError::Conflict,
        ReceiptDataError::StorageUnknown => LedgerError::StorageUnknown,
        ReceiptDataError::Corrupt => LedgerError::Corrupt,
    }
}
struct Context {
    run: provider::Run,
    head: u64,
}

/// A request/lookup correlation, never permission to dispatch an effect.
/// Epoch is absent on a fresh request: Connect derives/checks its actual provider
/// epoch. An original known receipt supplies its exact epoch for read-only lookup.
pub(crate) struct RollbackScope {
    pub(crate) provider: Uuid,
    pub(crate) head: u64,
    pub(crate) driver: Uuid,
    pub(crate) action: Uuid,
    pub(crate) ids: Vec<String>,
    pub(crate) epoch: Option<u64>,
    pub(crate) original: bool,
}
impl RollbackScope {
    pub(crate) fn to_bytes(&self) -> Result<Vec<u8>> {
        cbor::encode(&Cbor::Array(vec![
            Cbor::Bytes(self.provider.0.to_vec()),
            Cbor::Uint(self.head),
            Cbor::Bytes(self.driver.0.to_vec()),
            Cbor::Bytes(self.action.0.to_vec()),
            Cbor::Array(self.ids.iter().map(|id| Cbor::Text(id.clone())).collect()),
            self.epoch.map(Cbor::Uint).unwrap_or(Cbor::Null),
            Cbor::Bool(self.original),
        ]))
        .map_err(|_| LedgerError::Invalid)
    }
}

fn decode(input: &[u8]) -> Result<OriginalRollbackReceiptData> {
    if input.is_empty() || input.len() > MAX_INPUT {
        return Err(LedgerError::Invalid);
    }
    let value = cbor::decode(input).map_err(|_| LedgerError::Invalid)?;
    let Cbor::Array(v) = &value else {
        return Err(LedgerError::Invalid);
    };
    let [
        collection,
        owner,
        provider,
        epoch,
        head,
        driver,
        action,
        ids,
        restored,
        Cbor::Text(recorded),
    ] = v.as_slice()
    else {
        return Err(LedgerError::Invalid);
    };
    let data = OriginalRollbackReceiptData {
        key: ReceiptDataKey {
            collection_id: provider::uuid(collection)?,
            provider_migration_id: provider::uuid(provider)?,
            driver_id: provider::uuid(driver)?,
        },
        owner_account_id: provider::uuid(owner)?,
        authority_epoch: provider::count(epoch)?,
        fixed_head: provider::count(head)?,
        action_id: provider::uuid(action)?,
        replica_ids: provider::ids(ids)?,
        restored_ids: provider::ids(restored)?,
        recorded_at: recorded.clone(),
    };
    if !data.valid() {
        return Err(LedgerError::Invalid);
    }
    Ok(data)
}
fn provenance(data: &OriginalRollbackReceiptData) -> Vec<Cbor> {
    vec![
        Cbor::Bytes(data.key.collection_id.0.to_vec()),
        Cbor::Bytes(data.owner_account_id.0.to_vec()),
        Cbor::Bytes(data.key.provider_migration_id.0.to_vec()),
        Cbor::Uint(data.authority_epoch),
        Cbor::Uint(data.fixed_head),
        Cbor::Bytes(data.key.driver_id.0.to_vec()),
        Cbor::Bytes(data.action_id.0.to_vec()),
        Cbor::Array(
            data.replica_ids
                .iter()
                .map(|id| Cbor::Bytes(id.0.to_vec()))
                .collect(),
        ),
        Cbor::Array(
            data.restored_ids
                .iter()
                .map(|id| Cbor::Bytes(id.0.to_vec()))
                .collect(),
        ),
        Cbor::Text(data.recorded_at.clone()),
    ]
}
fn digest(action: &Action, data: &OriginalRollbackReceiptData) -> Result<B32> {
    let tag = match action {
        Action::Unrevoke { .. } => 20,
        Action::Unfence => 21,
        _ => return Err(LedgerError::Unsupported),
    };
    let mut fields = vec![Cbor::Uint(tag)];
    fields.extend(provenance(data));
    codec::digest("mdbase/v1/native-rollback-outcome", fields)
}

impl<I: IndexStorage> JournalDriver<I> {
    fn rollback_context(&mut self) -> Result<Context> {
        let rows = run(
            self.spill.index_mut(),
            vec![Stmt::new(
                "SELECT provider,started,head FROM mig_native_rollback_context WHERE driver=?1 LIMIT 1",
                vec![blob(&self.id.0)],
            )],
            BatchMode::Autocommit,
        )?;
        let Some([p, SqlValue::Text(started), head]) =
            rows.first().ok_or(LedgerError::Corrupt)?.rows().next()
        else {
            return Err(LedgerError::Corrupt);
        };
        let context = Context {
            run: provider::Run {
                collection: self.binding.collection,
                migration: B16(bytes(p)?),
                started_at: provider::stamp(&Cbor::Text(started.clone()))?,
            },
            head: integer(head)?,
        };
        if context.head > MAX_SEQ || context.run.migration.0 == [0; 16] {
            return Err(LedgerError::Corrupt);
        }
        let fence = self.latest_settled(FENCE)?.ok_or(LedgerError::Corrupt)?;
        if !provider::fence_matches(&fence, &context.run)? {
            return Err(LedgerError::Corrupt);
        }
        Ok(context)
    }

    /// Operator intent only. Atomic context/checkpoint transition; the caller
    /// must confirm storage.sync and the owned CPP/native context before resuming.
    pub(crate) fn request_rollback<S: mdbn_replica::Store>(
        &mut self,
        expected: u64,
        binding: &RunBinding,
        source: &[u8],
        engine: &mut crate::runtime::Engine<S>,
        target: &crate::runtime::ObservedNativeTarget,
    ) -> Result<()> {
        self.pre_cutover_target(engine, target)?;
        if expected != self.sequence || binding != &self.binding {
            return Err(LedgerError::Conflict);
        }
        if self.poisoned {
            return Err(LedgerError::Refused);
        }
        let pending = self.saved_pending()?;
        let cp = self.driver.checkpoint();
        // Gen0 has only unrooted uploads, never a legacy/log effect. Cancel it
        // with rollback, not a fabricated Gen0Progress/Gen0Built result. Step
        // remains Created even after a fence-first run fences the source;
        // the existing source/fence binding checks below still apply.
        if pending
            .as_ref()
            .is_some_and(|p| !matches!(p.kind, 4 | 5) || cp.step != Step::Created)
            || (self.pending.is_some() && pending.is_none())
        {
            return Err(LedgerError::OutstandingUnknown);
        }
        if let Some(p) = &pending
            && (p.driver != self.id
                || p.before != cp.to_bytes().map_err(|_| LedgerError::Corrupt)?)
        {
            return Err(LedgerError::Conflict);
        }
        if cp.step == Step::RollingBack {
            if cp.fenced || !cp.revoked.is_empty() {
                self.rollback_context()?;
            }
            return Ok(());
        }
        if !cp.step.can_roll_back()
            || cp.step.is_terminal()
            || cp.cutover_seq.is_some()
            || cp.barrier_f.is_some()
            || cp.intent_mutation.is_some()
            || (!cp.fenced && !cp.revoked.is_empty())
        {
            return Err(LedgerError::Refused);
        }
        let before = cp.to_bytes().map_err(|_| LedgerError::Corrupt)?;
        let context = if cp.fenced {
            let provider::ProviderResult::Drain {
                collection,
                state: provider::State::Migrating,
                run: Some(run),
                head,
                retained: false,
                in_flight: 0,
                ..
            } = provider::decode(source)?
            else {
                return Err(LedgerError::Refused);
            };
            if collection != self.binding.collection || cp.s_final.is_some_and(|h| h != head) {
                return Err(LedgerError::Conflict);
            }
            let fence = self.latest_settled(FENCE)?.ok_or(LedgerError::Refused)?;
            if !provider::fence_matches(&fence, &run)? {
                return Err(LedgerError::Conflict);
            }
            Some(Context { run, head })
        } else {
            if !source.is_empty() {
                return Err(LedgerError::Invalid);
            }
            None
        };
        let mut captured = capture::CheckpointCapture::new(&mut self.spill)
            .map_err(|_| LedgerError::StorageUnknown)?;
        if self
            .driver
            .rollback(&mut captured, "operator_rollback")
            .is_err()
        {
            self.poisoned = true;
            return Err(LedgerError::Refused);
        }
        let (after, captured) = match captured.finish() {
            Ok(v) => v,
            Err(_) => {
                self.poisoned = true;
                return Err(LedgerError::StorageUnknown);
            }
        };
        let after = match after {
            Some(v) => v,
            None => {
                self.poisoned = true;
                return Err(LedgerError::Corrupt);
            }
        };
        let mut statements = vec![Stmt::new(
            "INSERT INTO mig_checkpoint(k,v) VALUES(0,?1) ON CONFLICT(k) DO NOTHING",
            vec![blob(&before)],
        )];
        if let Some(p) = &pending {
            let result = codec::digest(
                "mdbase/v1/native-gen0-rollback",
                vec![Cbor::Bytes(p.action.0.to_vec()), Cbor::Bytes(after.clone())],
            )?;
            // The existing settlement trigger binds the original row/checkpoint
            // and advances it to RollingBack in this SAME transaction.
            statements.push(Stmt::new(
                "UPDATE mig_native_action SET settled=1,after_cp=?1,result=?2 WHERE seq=?3 AND driver=?4 AND action=?5 AND fingerprint=?6 AND before_cp=?7 AND settled=0",
                vec![blob(&after), blob(&result.0), SqlValue::Integer(p.sequence as i64), blob(&self.id.0), blob(&p.action.0), blob(&p.fingerprint.0), blob(&before)],
            ));
        }
        statements.push(
            // Fail the entire transaction, not just a zero-row CAS, on drift.
            Stmt::new(
                "UPDATE mig_checkpoint SET v=CASE WHEN v=?1 AND EXISTS(SELECT 1 FROM mig_native_run WHERE seq=?2 AND driver=?3 AND seq=(SELECT MAX(seq) FROM mig_native_run)) AND NOT EXISTS(SELECT 1 FROM mig_native_action WHERE driver=?3 AND settled=0) THEN v ELSE NULL END WHERE k=0",
                vec![
                    blob(if pending.is_some() { &after } else { &before }),
                    SqlValue::Integer(expected as i64),
                    blob(&self.id.0),
                ],
            ),
        );
        if let Some(context) = context {
            statements.push(Stmt::new("INSERT INTO mig_native_rollback_context(driver,provider,started,head) VALUES(?1,?2,?3,?4)", vec![blob(&self.id.0), blob(&context.run.migration.0), SqlValue::Text(context.run.started_at), SqlValue::Integer(context.head as i64)]));
        }
        statements.extend(captured);
        statements.push(Stmt::new(
            "UPDATE mig_checkpoint SET v=?1 WHERE k=0",
            vec![blob(&after)],
        ));
        statements.push(Stmt::new("SELECT v FROM mig_checkpoint WHERE k=0", vec![]));
        let result = run(self.spill.index_mut(), statements, BatchMode::Transaction);
        match result {
            Ok(mut rows) => {
                if rows.pop().and_then(|r| r.values.into_iter().next()) != Some(blob(&after)) {
                    self.poisoned = true;
                    return Err(LedgerError::Corrupt);
                }
                if pending.is_some() {
                    self.pending = None;
                    self.gen0_staged = None;
                    if let Some(custody) = self.gen0_custody.take() {
                        let _ = engine
                            .migration_gen0_replica(target)
                            .map(|r| r.hosted_gen0_abort(target.admission(), &custody.handle));
                    }
                }
                self.idle = Idle::Refused;
                Ok(())
            }
            Err(e) => {
                self.poisoned = true;
                Err(e)
            }
        }
    }

    fn original_receipt(
        &mut self,
        context: &Context,
    ) -> Result<Option<OriginalRollbackReceiptData>> {
        RollbackReceiptDataStore::open(self.spill.index_mut())
            .map_err(receipt_error)?
            .load_original_data(ReceiptDataKey {
                collection_id: self.binding.collection,
                provider_migration_id: context.run.migration,
                driver_id: self.id,
            })
            .map_err(receipt_error)
    }
    fn proven_unrevoke(&mut self, data: &OriginalRollbackReceiptData) -> Result<()> {
        let rows = run(
            self.spill.index_mut(),
            vec![Stmt::new(
                "SELECT action,result FROM mig_native_action WHERE driver=?1 AND kind=20 AND settled=1 ORDER BY seq DESC LIMIT 1",
                vec![blob(&self.id.0)],
            )],
            BatchMode::Autocommit,
        )?;
        let Some([action, result]) = rows.first().ok_or(LedgerError::Corrupt)?.rows().next() else {
            return Err(LedgerError::Refused);
        };
        let expected = digest(
            &Action::Unrevoke {
                ids: data.replica_ids.iter().map(Uuid::to_uuid_string).collect(),
            },
            data,
        )?;
        if bytes::<16>(action)? != data.action_id.0 || bytes::<32>(result)? != expected.0 {
            return Err(LedgerError::Conflict);
        }
        Ok(())
    }
    pub(crate) fn rollback_scope(&mut self, ticket: &PreparedAction) -> Result<RollbackScope> {
        self.assert_prepared(ticket)?;
        let action = self.prepared_action(ticket)?.clone();
        self.rollback_scope_for(&ticket.data, &action)
    }
    fn rollback_scope_for(
        &mut self,
        pending: &PendingData,
        action: &Action,
    ) -> Result<RollbackScope> {
        let context = self.rollback_context()?;
        let (original, action_id, ids, epoch) = match action {
            Action::Unrevoke { ids } => (false, pending.action, ids.clone(), None),
            Action::Unfence => match self.original_receipt(&context)? {
                Some(data) => {
                    self.proven_unrevoke(&data)?;
                    (
                        true,
                        data.action_id,
                        data.replica_ids.iter().map(Uuid::to_uuid_string).collect(),
                        Some(data.authority_epoch),
                    )
                }
                None => (false, pending.action, vec![], None),
            },
            _ => return Err(LedgerError::Unsupported),
        };
        Ok(RollbackScope {
            provider: context.run.migration,
            head: context.head,
            driver: self.id,
            action: action_id,
            ids,
            epoch,
            original,
        })
    }
    fn qualify_receipt(
        &mut self,
        pending: &PendingData,
        action: &Action,
        data: &OriginalRollbackReceiptData,
    ) -> Result<Vec<Stmt>> {
        let scope = self.rollback_scope_for(pending, action)?;
        if data.key.collection_id != self.binding.collection
            || data.owner_account_id != self.binding.owner
            || data.key.provider_migration_id != scope.provider
            || data.key.driver_id != scope.driver
            || data.fixed_head != scope.head
            || data.action_id != scope.action
            || data
                .replica_ids
                .iter()
                .map(Uuid::to_uuid_string)
                .collect::<Vec<_>>()
                != scope.ids
            || scope.epoch.is_some_and(|e| e != data.authority_epoch)
        {
            return Err(LedgerError::Conflict);
        }
        let context = self.rollback_context()?;
        match self.original_receipt(&context)? {
            Some(original) if original == *data => Ok(vec![]),
            Some(_) => Err(LedgerError::Conflict),
            None if !scope.original => Ok(vec![data.insert_plan().map_err(receipt_error)?]),
            None => Err(LedgerError::Corrupt),
        }
    }
    fn recovered_rollback_action(&self, pending: &PendingData) -> Result<Action> {
        let cp = self.driver.checkpoint();
        if cp.step != Step::RollingBack || !cp.fenced {
            return Err(LedgerError::Refused);
        }
        let action = match pending.kind {
            20 if !cp.revoked.is_empty() => Action::Unrevoke {
                ids: cp.revoked.clone(),
            },
            21 if cp.revoked.is_empty() => Action::Unfence,
            _ => return Err(LedgerError::Unsupported),
        };
        let (kind, fingerprint) = codec::action(&action)?;
        if kind != pending.kind || fingerprint != pending.fingerprint {
            return Err(LedgerError::Conflict);
        }
        Ok(action)
    }

    /// Read-only receipt lookup scope for an evicted outstanding rollback.
    /// DATA only; no pending/effect ticket is minted.
    pub(crate) fn unknown_rollback_scope(&mut self, expected: u64) -> Result<RollbackScope> {
        let pending = self.settlement_pending(expected)?;
        let action = self.recovered_rollback_action(&pending)?;
        self.rollback_scope_for(&pending, &action)
    }

    pub(crate) fn resolve_rollback<S: mdbn_replica::Store>(
        &mut self,
        expected: u64,
        input: &[u8],
        engine: &mut crate::runtime::Engine<S>,
        target: &crate::runtime::ObservedNativeTarget,
    ) -> Result<(PreparedAction, B32)> {
        self.pre_cutover_target(engine, target)?;
        let pending = self.settlement_pending(expected)?;
        let action = self.recovered_rollback_action(&pending)?;
        let data = decode(input)?;
        let statements = self.qualify_receipt(&pending, &action, &data)?;
        let result = digest(&action, &data)?;
        self.recover_settlement(pending, action, Outcome::Ok, result, statements)
    }

    pub(crate) fn settle_rollback(&mut self, ticket: &PreparedAction, input: &[u8]) -> Result<B32> {
        self.assert_prepared(ticket)?;
        let action = self.prepared_action(ticket)?.clone();
        let data = decode(input)?;
        let statements = self.qualify_receipt(&ticket.data, &action, &data)?;
        let result = digest(&action, &data)?;
        self.settle_checked_extra(ticket, Outcome::Ok, result, statements)
    }
}
