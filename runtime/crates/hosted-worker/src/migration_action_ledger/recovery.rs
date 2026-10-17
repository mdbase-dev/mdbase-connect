//! Settlement-only recovery of retained UNKNOWN actions; never replay permission.
use super::*;

impl<I: IndexStorage> JournalDriver<I> {
    pub(super) fn settlement_pending(&mut self, expected: u64) -> Result<PendingData> {
        if self.poisoned || self.pending.is_some() {
            return Err(LedgerError::Refused);
        }
        let data = self.saved_pending()?.ok_or(LedgerError::Refused)?;
        if expected != data.sequence || data.driver != self.id {
            return Err(LedgerError::Conflict);
        }
        if self.spill.load().map_err(|_| LedgerError::StorageUnknown)? != Some(data.before.clone())
            || self
                .driver
                .checkpoint()
                .to_bytes()
                .map_err(|_| LedgerError::Corrupt)?
                != data.before
        {
            return Err(LedgerError::Conflict);
        }
        Ok(data)
    }

    /// The caller has independently proven a positive result. The temporary
    /// pending is private to this synchronous native call. The ticket escapes
    /// only AFTER settlement, when all pending/effect guards reject it.
    pub(super) fn recover_settlement(
        &mut self,
        data: PendingData,
        action: Action,
        outcome: Outcome,
        result: B32,
        statements: Vec<Stmt>,
    ) -> Result<(PreparedAction, B32)> {
        let (kind, fingerprint) = codec::action(&action)?;
        if kind != data.kind || fingerprint != data.fingerprint {
            return Err(LedgerError::Conflict);
        }
        let ticket = PreparedAction {
            instance: self.instance.clone(),
            data,
        };
        self.pending = Some((ticket.data.clone(), action));
        let result = self.settle_checked_extra(&ticket, outcome, result, statements)?;
        Ok((ticket, result))
    }

    pub(crate) fn resolve_base<S: mdbn_replica::Store>(
        &mut self,
        expected: u64,
        engine: &mut crate::runtime::Engine<S>,
        target: &crate::runtime::ObservedNativeTarget,
    ) -> Result<(PreparedAction, B32)> {
        self.pre_cutover_target(engine, target)?;
        let data = self.settlement_pending(expected)?;
        let cp = self.driver.checkpoint();
        if data.kind != 6 || cp.step != Step::BaseIntent {
            return Err(LedgerError::Unsupported);
        }
        let action = Action::AppendBase {
            manifest: cp.manifest.ok_or(LedgerError::Corrupt)?,
            state_digest: cp.state_digest.ok_or(LedgerError::Corrupt)?,
        };
        let admission = target.admission();
        let replica = engine
            .migration_gen0_replica(target)
            .map_err(|_| LedgerError::Refused)?;
        replica
            .hosted_migration_head(admission)
            .map_err(|_| LedgerError::Refused)?;
        let base = replica
            .hosted_migration_installed_base(admission)
            .map_err(|_| LedgerError::Refused)?
            .ok_or(LedgerError::OutstandingUnknown)?;
        if !self.base_is_ours(&base, admission.device()) {
            return Err(LedgerError::Conflict);
        }
        let outcome = Outcome::Appended { seq: base.seq };
        let result = codec::log_outcome(
            &action,
            &outcome,
            vec![mdbn_wire::cbor::Cbor::Bytes(base.item.0.to_vec())],
        )?;
        self.recover_settlement(data, action, outcome, result, vec![])
    }
}
