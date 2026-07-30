use super::*;

impl DirectoryMirror {
    pub async fn sync(&self) -> Result<(), MirrorError> {
        let _lease = MirrorLease::acquire(&self.lock_file)?;
        self.sync_unlocked().await
    }

    pub(super) async fn sync_unlocked(&self) -> Result<(), MirrorError> {
        if let Some(plan) = self.read_rebuild_plan()? {
            self.apply_rebuild(plan)?;
        }
        let Some(mut state) = self.read_state()? else {
            self.rebuild(None).await?;
            if self.mode == SyncReplicaMode::ReadWrite {
                return Box::pin(self.sync_unlocked()).await;
            }
            return Ok(());
        };
        if self.mode == SyncReplicaMode::ReadWrite {
            self.flush_pending(&mut state).await?;
            self.capture_local_changes(&mut state)?;
            self.flush_pending(&mut state).await?;
        } else {
            self.assert_undiverged(&state)?;
        }
        loop {
            let page = self.transport.changes(state.cursor, 200).await?;
            if page.scope_epoch != state.scope_epoch || page.reset_required {
                return self.rebuild(Some(state)).await;
            }
            self.preflight_change_physical_paths(&state, &page.events)?;
            for event in page.events {
                let record_id = match &event {
                    SyncChange::Put { record, .. } => record.record_id,
                    SyncChange::Remove { record_id, .. } => *record_id,
                };
                let local_entry = state.records.get(&record_id).cloned();
                let already_applied = self.mode == SyncReplicaMode::ReadWrite
                    && matches!(
                        (&event, &local_entry),
                        (
                            SyncChange::Put { record, .. },
                            Some(entry)
                        ) if entry.record.is_some()
                            && entry.path == record.path
                            && entry.revision == record.revision
                    );
                let local_issue = local_entry
                    .as_ref()
                    .is_some_and(|entry| state.local_issues.contains_key(&entry.path));
                if already_applied || local_issue {
                    // Preserve the exact accepted local bytes or an invalid local
                    // document until the user makes an explicit correction.
                } else if state.conflicts.contains_key(&record_id) {
                    refresh_conflict(&mut state, &event);
                } else {
                    match event {
                        SyncChange::Put { record, .. } => {
                            self.put(
                                &mut state,
                                record,
                                PutOptions {
                                    physical_path_preflighted: true,
                                    ..PutOptions::default()
                                },
                            )?;
                        }
                        SyncChange::Remove {
                            record_id,
                            previous_path,
                            ..
                        } => self.remove(&mut state, record_id, &previous_path)?,
                    }
                }
            }
            state.cursor = page.cursor;
            if !page.has_more {
                state.last_synced_at = Some(now());
                self.write_state(&state)?;
                return Ok(());
            }
            self.write_state(&state)?;
        }
    }

    pub fn status(&self) -> Result<MirrorStatus, MirrorError> {
        let Some(state) = self.read_state()? else {
            return Ok(MirrorStatus {
                state: MirrorStatusState::NotInitialized,
                mode: self.mode,
                pending: 0,
                conflicts: Vec::new(),
                local_issues: Vec::new(),
                cursor: None,
                last_synced_at: None,
            });
        };
        let conflicts = state
            .conflicts
            .iter()
            .map(|(record_id, receipt)| {
                let pending_path = state
                    .pending
                    .iter()
                    .find(|pending| pending.mutation.record_id == *record_id)
                    .map(|pending| pending.local_path.clone());
                let entry_path = state.records.get(record_id).map(|entry| entry.path.clone());
                match receipt {
                    SyncMutationReceipt::Conflicted { conflict, .. } => MirrorConflictSummary {
                        record_id: *record_id,
                        path: pending_path.or(entry_path).or_else(|| {
                            conflict.current.as_ref().map(|record| record.path.clone())
                        }),
                        kind: "conflicted".to_string(),
                        message: "Local and hosted changes need a decision.".to_string(),
                    },
                    SyncMutationReceipt::Rejected { error, .. } => MirrorConflictSummary {
                        record_id: *record_id,
                        path: pending_path.or(entry_path),
                        kind: "rejected".to_string(),
                        message: error.message.clone(),
                    },
                    _ => MirrorConflictSummary {
                        record_id: *record_id,
                        path: pending_path.or(entry_path),
                        kind: "invalid".to_string(),
                        message: "Mirror conflict metadata is invalid.".to_string(),
                    },
                }
            })
            .collect::<Vec<_>>();
        let local_issues = state
            .local_issues
            .values()
            .map(|issue| MirrorLocalIssue {
                path: issue.path.clone(),
                code: issue.code.clone(),
                message: issue.message.clone(),
            })
            .collect::<Vec<_>>();
        let state_value = if !conflicts.is_empty() || !local_issues.is_empty() {
            MirrorStatusState::Attention
        } else if state.pending.is_empty() {
            MirrorStatusState::UpToDate
        } else {
            MirrorStatusState::ChangesWaiting
        };
        Ok(MirrorStatus {
            state: state_value,
            mode: self.mode,
            pending: state.pending.len(),
            conflicts,
            local_issues,
            cursor: Some(state.cursor),
            last_synced_at: state.last_synced_at,
        })
    }

    /// Prove that the folder exactly matches its last applied authority cursor.
    ///
    /// The returned digest contains neither paths nor document contents and is
    /// comparable with the fenced authority's canonical transfer manifest.
    pub fn authority_promotion_manifest(&self) -> Result<AuthorityPromotionManifest, MirrorError> {
        let _lease = MirrorLease::acquire(&self.lock_file)?;
        if self.mode != SyncReplicaMode::ReadWrite {
            return Err(MirrorError::new(
                "promotion_requires_writable_mirror",
                "Only a two-way full collection mirror can become the local authority.",
            ));
        }
        let state = self.read_state()?.ok_or_else(|| {
            MirrorError::new(
                "promotion_not_initialized",
                "Synchronize this folder before moving authority.",
            )
        })?;
        if !state.pending.is_empty()
            || !state.conflicts.is_empty()
            || !state.local_issues.is_empty()
        {
            return Err(MirrorError::new(
                "promotion_not_converged",
                "Upload or resolve every local change before moving authority.",
            ));
        }
        self.assert_undiverged(&state)?;
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
                format!(
                    "Synchronize unmanaged Markdown before moving authority: {}.",
                    unmanaged.join(", ")
                ),
            ));
        }
        let resource_documents = state
            .resources
            .values()
            .map(|entry| {
                Ok(SyncResourceDocument {
                    path: entry.path.clone(),
                    kind: "resource".to_string(),
                    revision: entry.revision.clone(),
                    document: self.read_file(&entry.path)?.ok_or_else(|| {
                        MirrorError::new(
                            "mirror_diverged",
                            format!("Authority resource {} is missing.", entry.path),
                        )
                    })?,
                })
            })
            .collect::<Result<Vec<_>, MirrorError>>()?;
        let records = state
            .records
            .values()
            .filter_map(|entry| entry.record.clone().map(|record| (entry, record)))
            .map(|(entry, record)| {
                Ok(AuthoritySnapshotRecord {
                    record,
                    document: self.read_file(&entry.path)?.ok_or_else(|| {
                        MirrorError::new(
                            "mirror_diverged",
                            format!("Authority record {} is missing.", entry.path),
                        )
                    })?,
                })
            })
            .collect::<Result<Vec<_>, MirrorError>>()?;
        Ok(AuthorityPromotionManifest {
            cursor: state.cursor,
            digest: authority_manifest_digest(&resource_documents, &records),
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
                "Receive-only mirrors do not contain writable conflicts.",
            ));
        }
        let mut state = self.read_state()?.ok_or_else(|| {
            MirrorError::new(
                "mirror_not_initialized",
                "Synchronize this mirror before resolving conflicts.",
            )
        })?;
        let receipt = state.conflicts.get(&record_id).cloned().ok_or_else(|| {
            MirrorError::new(
                "mirror_conflict_not_found",
                "Writable mirror conflict was not found.",
            )
        })?;
        let pending = state
            .pending
            .iter()
            .filter(|pending| pending.mutation.record_id == record_id)
            .cloned()
            .collect::<Vec<_>>();
        match resolution {
            MirrorResolution::Remote => {
                let current = match &receipt {
                    SyncMutationReceipt::Conflicted { conflict, .. } => conflict.current.clone(),
                    _ => state
                        .records
                        .get(&record_id)
                        .and_then(|entry| entry.record.clone()),
                };
                self.install_remote_resolution(&mut state, record_id, current, &pending)?;
                state
                    .pending
                    .retain(|pending| pending.mutation.record_id != record_id);
            }
            MirrorResolution::Local => match receipt {
                SyncMutationReceipt::Rejected { .. } => {
                    state
                        .pending
                        .retain(|pending| pending.mutation.record_id != record_id);
                }
                SyncMutationReceipt::Conflicted { conflict, .. } => {
                    let source = pending.last().ok_or_else(|| {
                        MirrorError::new(
                            "conflict_mutation_missing",
                            "The local change for this sync issue is unavailable.",
                        )
                    })?;
                    let local_document = self.read_file(&source.local_path)?;
                    let replacements = self.local_resolution_mutations(
                        &state,
                        record_id,
                        &source.local_path,
                        local_document.as_deref(),
                        conflict.current.as_ref(),
                    )?;
                    let first = state
                        .pending
                        .iter()
                        .position(|pending| pending.mutation.record_id == record_id)
                        .unwrap_or(state.pending.len());
                    state
                        .pending
                        .retain(|pending| pending.mutation.record_id != record_id);
                    state.pending.splice(first..first, replacements);
                    if let Some(current) = conflict.current {
                        state.records.insert(
                            record_id,
                            MirrorEntry {
                                path: current.path.clone(),
                                revision: current.revision.clone(),
                                hash: digest(&record_markdown_document(&current)?),
                                record: Some(current),
                            },
                        );
                    } else {
                        state.records.remove(&record_id);
                    }
                }
                _ => {
                    return Err(MirrorError::new(
                        "invalid_mirror_state",
                        "Mirror conflict metadata is invalid.",
                    ))
                }
            },
        }
        state.conflicts.remove(&record_id);
        self.write_state(&state)
    }
}
