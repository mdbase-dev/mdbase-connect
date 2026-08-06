use super::*;

impl DirectoryMirror {
    pub(super) fn revalidate(
        &self,
        plan: &MirrorSyncPlan,
        state: Option<&DurableMirrorState>,
    ) -> Result<(), MirrorError> {
        if state.map(|value| value.generation).unwrap_or(0) != plan.checkpoint_generation
            || state.map(|value| value.cursor) != plan.base_cursor
        {
            return Err(MirrorError::new(
                "sync_plan_stale",
                "Durable checkpoint changed after inspection.",
            ));
        }
        for action in &plan.actions {
            if !action.depends_on().is_empty() {
                continue;
            }
            match action {
                SyncAction::WriteLocal {
                    target,
                    expected_local,
                    expected_path_owner,
                    ..
                }
                | SyncAction::DeleteLocal {
                    target,
                    expected_local,
                    expected_path_owner,
                    ..
                } => {
                    self.revalidate_expected(expected_local)?;
                    self.revalidate_at(&target.path, expected_path_owner)?;
                }
                SyncAction::MoveLocal {
                    source,
                    target_path,
                    expected_source_owner,
                    expected_target_owner,
                    ..
                } => {
                    self.revalidate_at(&source.path, expected_source_owner)?;
                    self.revalidate_at(target_path, expected_target_owner)?;
                }
                SyncAction::PutRemote { expected_local, .. }
                | SyncAction::MoveRemote { expected_local, .. }
                | SyncAction::RecordConflict {
                    local: expected_local,
                    ..
                } => self.revalidate_expected(expected_local)?,
                SyncAction::DeleteRemote {
                    target,
                    expected_local,
                    ..
                } => self.revalidate_at(&target.path, expected_local)?,
                SyncAction::AdvanceCheckpoint { .. } => {}
            }
        }
        Ok(())
    }

    pub(super) fn revalidate_at(
        &self,
        path: &str,
        expected: &ExpectedObjectState,
    ) -> Result<(), MirrorError> {
        match expected {
            ExpectedObjectState::Absent => {
                if self.read_file(path)?.is_some() || self.file_digest(path)?.is_some() {
                    return Err(MirrorError::new(
                        "sync_plan_stale",
                        format!("{path} is no longer vacant."),
                    ));
                }
            }
            ExpectedObjectState::Exact { object } if object.path == path => {
                self.revalidate_expected(expected)?
            }
            _ => {
                return Err(MirrorError::new(
                    "sync_plan_stale",
                    format!("{path} has a different owner."),
                ))
            }
        }
        Ok(())
    }

    pub(super) fn revalidate_expected(
        &self,
        expected: &ExpectedObjectState,
    ) -> Result<(), MirrorError> {
        let ExpectedObjectState::Exact { object } = expected else {
            return Ok(());
        };
        let matches = match object.entity {
            SyncObjectKind::File => {
                self.file_digest(&object.path)?.as_deref() == Some(&object.payload_revision)
            }
            _ => self.read_file(&object.path)?.is_some_and(|value| {
                format!("sha256:{}", digest(&value)) == object.payload_revision
            }),
        };
        if !matches {
            return Err(MirrorError::new(
                "sync_plan_stale",
                format!("{} no longer matches inspected bytes.", object.path),
            ));
        }
        Ok(())
    }

    pub(super) fn matches_ref(&self, object: &SyncObjectRef) -> Result<bool, MirrorError> {
        match object.entity {
            SyncObjectKind::File => Ok(self.file_digest(&object.path)?.as_deref()
                == Some(object.payload_revision.as_str())),
            _ => Ok(self.read_file(&object.path)?.is_some_and(|value| {
                format!("sha256:{}", digest(&value)) == object.payload_revision
            })),
        }
    }
}
