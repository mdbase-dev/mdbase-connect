use super::*;

impl DirectoryMirror {
    pub async fn sync(&self) -> Result<(), MirrorError> {
        let _lease = MirrorLease::acquire(&self.lock_file)?;
        if let Some(mut state) = self.read_state()? {
            if state.batch.is_some() {
                let result = self.apply_prepared(&mut state).await?;
                return finish_sync(result);
            }
        }
        let result = self.apply_inspection(self.inspect_plan().await?).await?;
        finish_sync(result)
    }

    pub fn status(&self) -> Result<MirrorStatus, MirrorError> {
        Ok(self.status_from_state(self.read_state()?))
    }

    pub(super) fn status_from_state(&self, state: Option<DurableMirrorState>) -> MirrorStatus {
        let Some(state) = state else {
            return MirrorStatus {
                state: MirrorStatusState::NotInitialized,
                mode: self.mode,
                pending: 0,
                conflicts: Vec::new(),
                local_issues: Vec::new(),
                cursor: None,
                last_synced_at: None,
            };
        };
        let conflicts = state
            .planned_conflicts
            .iter()
            .filter_map(|(identity, conflict)| {
                let record_id = Uuid::parse_str(identity).ok()?;
                Some(MirrorConflictSummary {
                    record_id,
                    path: conflict
                        .local
                        .exact()
                        .or(conflict.remote.exact())
                        .map(|value| value.path.clone()),
                    kind: if conflict.conflict_kind == ConflictKind::Rejected {
                        "rejected".into()
                    } else {
                        "conflicted".into()
                    },
                    message: if conflict.conflict_kind == ConflictKind::Rejected {
                        "The authority rejected this local change.".into()
                    } else {
                        "Local and authority changes need a decision.".into()
                    },
                })
            })
            .collect::<Vec<_>>();
        let pending = state
            .batch
            .as_ref()
            .map(|batch| {
                batch.plan.actions[batch.next_action..]
                    .iter()
                    .filter(|action| !matches!(action, SyncAction::AdvanceCheckpoint { .. }))
                    .count()
            })
            .unwrap_or(0);
        MirrorStatus {
            state: if !conflicts.is_empty() {
                MirrorStatusState::Attention
            } else if pending > 0 {
                MirrorStatusState::ChangesWaiting
            } else {
                MirrorStatusState::UpToDate
            },
            mode: self.mode,
            pending,
            conflicts,
            local_issues: Vec::new(),
            cursor: Some(state.cursor),
            last_synced_at: state.last_synced_at,
        }
    }

    pub fn authority_promotion_manifest(&self) -> Result<AuthorityPromotionManifest, MirrorError> {
        let _lease = MirrorLease::acquire(&self.lock_file)?;
        if self.mode != SyncReplicaMode::ReadWrite {
            return Err(MirrorError::new(
                "promotion_requires_writable_mirror",
                "Only a writable full mirror can become authority.",
            ));
        }
        let state = self.read_state()?.ok_or_else(|| {
            MirrorError::new(
                "promotion_not_initialized",
                "Synchronize this folder first.",
            )
        })?;
        let required = HashSet::from([
            FileMediaClass::Image,
            FileMediaClass::Audio,
            FileMediaClass::Video,
            FileMediaClass::Pdf,
            FileMediaClass::Other,
        ]);
        if !state.sync_policy.excluded_folders.is_empty()
            || state
                .sync_policy
                .file_classes
                .iter()
                .copied()
                .collect::<HashSet<_>>()
                != required
        {
            return Err(MirrorError::new(
                "promotion_incomplete_file_projection",
                "Promotion requires all file classes and no exclusions.",
            ));
        }
        if state.batch.is_some() || !state.planned_conflicts.is_empty() {
            return Err(MirrorError::new(
                "promotion_not_converged",
                "Finish sync and resolve conflicts before promotion.",
            ));
        }
        let resources = state.resources.keys().cloned().collect::<HashSet<_>>();
        let managed = state
            .records
            .values()
            .map(|entry| entry.path.clone())
            .collect::<HashSet<_>>();
        let unmanaged = self
            .list_markdown(&resources)?
            .into_iter()
            .filter(|path| !managed.contains(path))
            .collect::<Vec<_>>();
        if !unmanaged.is_empty() {
            return Err(MirrorError::new(
                "promotion_unmanaged_files",
                format!("Synchronize unmanaged Markdown: {}.", unmanaged.join(", ")),
            ));
        }
        let resource_documents = state
            .resources
            .values()
            .map(|entry| {
                Ok(SyncResourceDocument {
                    path: entry.path.clone(),
                    kind: "resource".into(),
                    revision: entry.revision.clone(),
                    document: self.read_file(&entry.path)?.ok_or_else(|| {
                        MirrorError::new("mirror_diverged", format!("{} is missing.", entry.path))
                    })?,
                })
            })
            .collect::<Result<Vec<_>, MirrorError>>()?;
        let records = state
            .records
            .values()
            .filter_map(|entry| entry.record.clone().map(|record| (entry, record)))
            .map(|(entry, mut record)| {
                record.document = self.read_file(&entry.path)?.ok_or_else(|| {
                    MirrorError::new("mirror_diverged", format!("{} is missing.", entry.path))
                })?;
                Ok(record)
            })
            .collect::<Result<Vec<_>, MirrorError>>()?;
        Ok(AuthorityPromotionManifest {
            cursor: state.cursor,
            digest: authority_manifest_digest(
                &resource_documents,
                &records,
                &state
                    .files
                    .values()
                    .map(|entry| entry.file.clone())
                    .collect::<Vec<_>>(),
            ),
        })
    }

    pub async fn resolve_conflict(
        &self,
        record_id: Uuid,
        resolution: MirrorResolution,
    ) -> Result<(), MirrorError> {
        let _lease = MirrorLease::acquire(&self.lock_file)?;
        if self.mode != SyncReplicaMode::ReadWrite {
            return Err(MirrorError::new(
                "mirror_read_only",
                "Receive-only mirrors have no writable conflicts.",
            ));
        }
        let mut state = self
            .read_state()?
            .ok_or_else(|| MirrorError::new("mirror_not_initialized", "Synchronize first."))?;
        if state.batch.is_some() {
            return Err(MirrorError::new(
                "mirror_recovery_required",
                "Recover prepared sync before resolving.",
            ));
        }
        let identity = record_id.to_string();
        let conflict = state
            .planned_conflicts
            .get(&identity)
            .cloned()
            .ok_or_else(|| {
                MirrorError::new("mirror_conflict_not_found", "Conflict was not found.")
            })?;
        if resolution == MirrorResolution::Remote {
            let session = self.transport.open_session().await?;
            let mut page = None::<String>;
            let mut current = None;
            loop {
                let value = self
                    .transport
                    .snapshot(session.snapshot_id, page.as_deref())
                    .await?;
                current = value
                    .records
                    .into_iter()
                    .find(|value| value.record.record_id == record_id)
                    .map(|value| value.record)
                    .or(current);
                page = value.next_page;
                if page.is_none() {
                    break;
                }
            }
            if let Some(record) = current {
                let accepted = conflict
                    .local
                    .exact()
                    .map(|value| value.payload_revision.trim_start_matches("sha256:"));
                self.put_record(&mut state, record, accepted)?;
            } else {
                let path = conflict
                    .local
                    .exact()
                    .map(|value| value.path.clone())
                    .or_else(|| {
                        state
                            .records
                            .get(&record_id)
                            .map(|entry| entry.path.clone())
                    })
                    .unwrap_or_default();
                if !path.is_empty() {
                    self.remove_record(&mut state, record_id, &path, true)?;
                }
            }
            state.local_bindings.remove(&identity);
        }
        state.planned_conflicts.remove(&identity);
        self.write_state(&state)
    }
}

fn finish_sync(result: MirrorApplyResult) -> Result<(), MirrorError> {
    match result.status.as_str() {
        "applied" => Ok(()),
        "attention" => {
            if let Some(issue) = result.issues.into_iter().find(|issue| issue.blocking) {
                Err(MirrorError::new(issue.code, issue.message))
            } else {
                Ok(())
            }
        }
        _ => {
            let failure = result.failure.unwrap_or(MirrorFailure {
                code: result.status,
                message: "Synchronization did not complete.".into(),
                action_id: None,
            });
            Err(MirrorError::new(failure.code, failure.message))
        }
    }
}
