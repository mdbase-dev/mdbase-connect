//! Verified lost-tail recovery of native metadata moves. Historical fences bind
//! original input only; current holder, authority and complete refs are fresh.
use super::*;

impl<S: Store> Replica<S> {
    pub(super) fn native_move_recovery_check(
        &self,
        row: &PendingRow,
    ) -> Result<Option<MoveAdmission>, StoreError> {
        let [rt::Op::Legacy(Op::FileMove(op))] = row.mutation.ops.as_slice() else {
            return Ok(None);
        };
        let raw = self.store.meta(&key(&row.mutation.id))?;
        let current = self.store.file(&op.id)?;
        // Ordinary moves retain their existing Core recovery. A native fence
        // still identifies native ownership if the restored kind changed.
        if raw.is_none()
            && current
                .as_ref()
                .is_none_or(|f| f.kind != FileKindV1::UnindexedOversizedMarkdown)
        {
            if row.refs.is_empty() {
                return Ok(None);
            }
            return Ok(Some(MoveAdmission::Hold(changed())));
        }
        let hold = || Ok(Some(MoveAdmission::Hold(changed())));
        let Some(raw) = raw else {
            return hold();
        };
        let f = Fence::read(&raw)?;
        if row.grant.is_some()
            || row.mutation.on_behalf.is_some()
            || row.mutation.origin != self.cfg.replica_id
            || op.id != f.file
            || op.from != f.from
            || op.to != f.to
            || op.update_refs
            || op.if_revision != Some(f.prior.plain_hash())
            || self.policy.seq > self.head.seq
        {
            return hold();
        }
        let Some(current) = current else {
            return hold();
        };
        if current.kind != FileKindV1::UnindexedOversizedMarkdown
            || self
                .unindexed_resurrect_admission(&row.mutation.id, &current.path)
                .is_err()
            || self
                .unindexed_resurrect_admission(&row.mutation.id, &f.to)
                .is_err()
            || self
                .store
                .file_at(&mdbn_core::paths::path_key(&current.path))?
                != Some(f.file)
            || self.store.hold(&f.file)?.is_some()
        {
            return hold();
        }
        // Core's verified Resurrect stage ignores the OLD plaintext CAS and
        // follows the current identity/path, allocating collisions. We never
        // restore the old source or use the historical refs as authority.
        let Some(refs) = self.native_move_refs(&current.content)? else {
            return hold();
        };
        Ok(Some(MoveAdmission::Ready(refs)))
    }
}
