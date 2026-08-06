use super::*;
use crate::sync_inspector::Inspection;

impl DirectoryMirror {
    pub async fn inspect(&self) -> Result<MirrorSyncPlan, MirrorError> {
        let _lease = MirrorLease::acquire(&self.lock_file)?;
        if let Some(plan) = self
            .read_state()?
            .and_then(|state| state.batch.map(|batch| batch.plan))
        {
            return Ok(plan);
        }
        Ok(self.inspect_plan().await?.plan)
    }

    pub async fn apply(&self, reviewed: &MirrorSyncPlan) -> Result<MirrorApplyResult, MirrorError> {
        let _lease = MirrorLease::acquire(&self.lock_file)?;
        if let Some(mut state) = self.read_state()? {
            if let Some(batch) = &state.batch {
                if batch.plan.fingerprint != reviewed.fingerprint {
                    return Err(MirrorError::new(
                        "mirror_recovery_required",
                        "A different prepared plan must recover first.",
                    ));
                }
                return self.apply_prepared(&mut state).await;
            }
        }
        let inspection = self.inspect_plan().await?;
        if inspection.plan.fingerprint != reviewed.fingerprint {
            return Ok(result(
                "stale",
                reviewed,
                self.status_from_state(self.read_state()?),
                0,
                Some(MirrorFailure {
                    code: "sync_plan_stale".into(),
                    message: "Local or authority state changed after inspection.".into(),
                    action_id: None,
                }),
            ));
        }
        self.apply_inspection(inspection).await
    }

    pub async fn apply_fingerprint(
        &self,
        fingerprint: &str,
    ) -> Result<MirrorApplyResult, MirrorError> {
        let plan = self.inspect().await?;
        if plan.fingerprint != fingerprint {
            return Err(MirrorError::new(
                "sync_plan_stale",
                "Reviewed plan fingerprint is stale.",
            ));
        }
        self.apply(&plan).await
    }

    pub(super) async fn apply_inspection(
        &self,
        inspection: Inspection,
    ) -> Result<MirrorApplyResult, MirrorError> {
        let plan = inspection.plan.clone();
        if plan.issues.iter().any(|issue| issue.blocking) {
            return Ok(result(
                "attention",
                &plan,
                self.status_from_state(inspection.prior.clone()),
                0,
                None,
            ));
        }
        if let Err(error) = self.revalidate(&plan, inspection.prior.as_ref()) {
            let status = if error.code == "sync_plan_stale" {
                "stale"
            } else {
                "failed"
            };
            return Ok(result(
                status,
                &plan,
                self.status_from_state(inspection.prior),
                0,
                Some(MirrorFailure {
                    code: error.code,
                    message: error.message,
                    action_id: None,
                }),
            ));
        }
        let mut state = self.prepare_batch(inspection)?;
        self.apply_prepared(&mut state).await
    }

    pub(super) async fn apply_prepared(
        &self,
        state: &mut DurableMirrorState,
    ) -> Result<MirrorApplyResult, MirrorError> {
        let plan = state.batch.as_ref().expect("prepared").plan.clone();
        let execution = self.execute_prepared(state).await?;
        if execution.status != "effects_complete" {
            return Ok(result(
                if execution.status == "blocked" {
                    "failed"
                } else {
                    &execution.status
                },
                &plan,
                self.status_from_state(Some(state.clone())),
                execution.completed,
                execution.failure,
            ));
        }
        self.prune_file_cache()?;
        self.advance_checkpoint(state)?;
        let status = self.status_from_state(Some(state.clone()));
        let outcome = if status.state == MirrorStatusState::Attention {
            "attention"
        } else {
            "applied"
        };
        Ok(result(outcome, &plan, status, execution.completed, None))
    }
}

fn result(
    status: &str,
    plan: &MirrorSyncPlan,
    checkpoint: MirrorStatus,
    applied: usize,
    failure: Option<MirrorFailure>,
) -> MirrorApplyResult {
    MirrorApplyResult {
        status: status.into(),
        plan_fingerprint: plan.fingerprint.clone(),
        applied,
        pending: checkpoint.pending,
        checkpoint_cursor: checkpoint.cursor,
        conflicts: checkpoint.conflicts.len(),
        issues: plan.issues.clone(),
        failure,
    }
}
