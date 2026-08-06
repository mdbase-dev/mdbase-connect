use super::*;
use crate::sync_inspector::Inspection;

impl DirectoryMirror {
    pub(super) fn prepare_batch(
        &self,
        inspection: Inspection,
    ) -> Result<DurableMirrorState, MirrorError> {
        let plan = inspection.plan;
        let mut state = inspection.prior.unwrap_or_else(|| DurableMirrorState {
            protocol_version: SYNC_PROTOCOL_VERSION,
            engine_version: MIRROR_ENGINE_VERSION,
            generation: 0,
            replica_id: self.replica_id,
            scope_epoch: plan.scope_epoch,
            cursor: 0,
            records: BTreeMap::new(),
            resources: BTreeMap::new(),
            files: BTreeMap::new(),
            sync_policy: plan.selective_sync.clone(),
            mode: self.mode,
            planned_conflicts: BTreeMap::new(),
            local_bindings: BTreeMap::new(),
            batch: None,
            last_completed_plan: None,
            last_synced_at: None,
        });
        if state.batch.is_some() {
            return Err(MirrorError::new(
                "mirror_recovery_required",
                "A prepared batch already exists.",
            ));
        }
        state.scope_epoch = plan.scope_epoch;
        state.sync_policy = plan.selective_sync.clone();
        state.batch = Some(DurableBatch {
            phase: BatchPhase::Prepared,
            checkpoint_before: SyncCheckpoint {
                generation: plan.checkpoint_generation,
                cursor: plan.base_cursor,
            },
            checkpoint_after: SyncCheckpoint {
                generation: plan.checkpoint_generation + 1,
                cursor: Some(plan.authority_cursor),
            },
            plan,
            next_action: 0,
            receipts: Vec::new(),
            payloads: inspection.payloads,
            failure: None,
        });
        self.reset_journal()?;
        self.write_state(&state)?;
        Ok(state)
    }

    pub(super) fn journal_phase(
        &self,
        state: &mut DurableMirrorState,
        phase: BatchPhase,
        failure: Option<MirrorFailure>,
    ) -> Result<(), MirrorError> {
        let batch = state
            .batch
            .as_mut()
            .ok_or_else(|| MirrorError::new("invalid_mirror_state", "No prepared batch."))?;
        batch.phase = phase;
        batch.failure = failure.clone();
        self.append_journal(&DurableJournalEvent::Phase {
            plan_fingerprint: batch.plan.fingerprint.clone(),
            phase,
            failure,
        })
    }

    pub(super) fn journal_receipt(
        &self,
        state: &mut DurableMirrorState,
        receipt: DurableReceipt,
    ) -> Result<(), MirrorError> {
        let batch = state
            .batch
            .as_ref()
            .ok_or_else(|| MirrorError::new("invalid_mirror_state", "No prepared batch."))?;
        if batch
            .plan
            .actions
            .get(batch.next_action)
            .map(SyncAction::action_id)
            != Some(receipt.action_id.as_str())
        {
            return Err(MirrorError::new(
                "invalid_mirror_state",
                "Receipt does not match the next prepared action.",
            ));
        }
        let action = batch.plan.actions[batch.next_action].clone();
        self.append_journal(&DurableJournalEvent::Receipt {
            plan_fingerprint: batch.plan.fingerprint.clone(),
            delta: Box::new(state_delta(&action, &receipt, state)?),
            receipt: Box::new(receipt.clone()),
        })?;
        let batch = state.batch.as_mut().expect("checked");
        batch.receipts.push(receipt);
        batch.next_action += 1;
        Ok(())
    }
}

fn state_delta(
    action: &SyncAction,
    receipt: &DurableReceipt,
    state: &DurableMirrorState,
) -> Result<DurableStateDelta, MirrorError> {
    let (entity, identity) = action_object(action)?;
    let state_identity = receipt
        .file
        .as_ref()
        .map(|file| file.file_id.to_string())
        .unwrap_or_else(|| identity.to_string());
    let record = if entity == SyncObjectKind::Record {
        match Uuid::parse_str(&state_identity)
            .ok()
            .and_then(|id| state.records.get(&id))
            .cloned()
        {
            Some(value) => EntryDelta::Put { value },
            None => EntryDelta::Remove,
        }
    } else {
        EntryDelta::Unchanged
    };
    let resource = if entity == SyncObjectKind::Resource {
        match state.resources.get(identity).cloned() {
            Some(value) => EntryDelta::Put { value },
            None => EntryDelta::Remove,
        }
    } else {
        EntryDelta::Unchanged
    };
    let file = if entity == SyncObjectKind::File {
        match Uuid::parse_str(&state_identity)
            .ok()
            .and_then(|id| state.files.get(&id))
            .cloned()
        {
            Some(value) => EntryDelta::Put { value },
            None => EntryDelta::Remove,
        }
    } else {
        EntryDelta::Unchanged
    };
    Ok(DurableStateDelta {
        identity: identity.into(),
        state_identity,
        record,
        resource,
        file,
        conflict: match state.planned_conflicts.get(identity).cloned() {
            Some(value) => EntryDelta::Put { value },
            None => EntryDelta::Remove,
        },
        binding: match state.local_bindings.get(identity).cloned() {
            Some(value) => EntryDelta::Put { value },
            None => EntryDelta::Remove,
        },
    })
}

fn action_object(action: &SyncAction) -> Result<(SyncObjectKind, &str), MirrorError> {
    Ok(match action {
        SyncAction::WriteLocal { target, .. }
        | SyncAction::DeleteLocal { target, .. }
        | SyncAction::PutRemote { target, .. }
        | SyncAction::DeleteRemote { target, .. } => {
            (target.entity.clone(), target.identity.as_str())
        }
        SyncAction::MoveLocal { source, .. } | SyncAction::MoveRemote { source, .. } => {
            (source.entity.clone(), source.identity.as_str())
        }
        SyncAction::RecordConflict {
            entity, identity, ..
        } => (entity.clone(), identity.as_str()),
        SyncAction::AdvanceCheckpoint { .. } => {
            return Err(MirrorError::new(
                "invalid_mirror_state",
                "Checkpoint actions do not produce receipts.",
            ))
        }
    })
}
