use super::*;

impl DirectoryMirror {
    pub(super) fn advance_checkpoint(
        &self,
        state: &mut DurableMirrorState,
    ) -> Result<String, MirrorError> {
        let batch = state
            .batch
            .as_ref()
            .ok_or_else(|| MirrorError::new("invalid_mirror_state", "No prepared batch."))?;
        if batch.phase != BatchPhase::EffectsComplete {
            return Err(MirrorError::new(
                "invalid_mirror_state",
                "Effects are not complete.",
            ));
        }
        let SyncAction::AdvanceCheckpoint { expected, next, .. } =
            batch.plan.actions.get(batch.next_action).ok_or_else(|| {
                MirrorError::new("invalid_mirror_state", "Checkpoint command is missing.")
            })?
        else {
            return Err(MirrorError::new(
                "invalid_mirror_state",
                "Checkpoint command is missing.",
            ));
        };
        if expected != &batch.checkpoint_before || next != &batch.checkpoint_after {
            return Err(MirrorError::new(
                "invalid_mirror_state",
                "Checkpoint boundary is inconsistent.",
            ));
        }
        let fingerprint = batch.plan.fingerprint.clone();
        state.generation = next.generation;
        state.cursor = next.cursor.unwrap_or(0);
        state.last_completed_plan = Some(fingerprint.clone());
        state.last_synced_at = Some(now());
        state.batch = None;
        self.write_state(state)?;
        self.reset_journal()?;
        Ok(fingerprint)
    }
}
