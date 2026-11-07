use super::*;
use crate::sync_codec::fingerprint;

pub(super) struct ExecutionResult {
    pub status: String,
    pub completed: usize,
    pub failure: Option<MirrorFailure>,
}

impl DirectoryMirror {
    pub(super) async fn execute_prepared(
        &self,
        state: &mut DurableMirrorState,
    ) -> Result<ExecutionResult, MirrorError> {
        self.journal_phase(state, BatchPhase::Applying, None)?;
        loop {
            let (index, action, receipts) = {
                let batch = state.batch.as_ref().ok_or_else(|| {
                    MirrorError::new("invalid_mirror_state", "No prepared batch.")
                })?;
                (
                    batch.next_action,
                    batch.plan.actions.get(batch.next_action).cloned(),
                    batch.receipts.clone(),
                )
            };
            let Some(action) = action else {
                return Err(MirrorError::new(
                    "invalid_mirror_state",
                    "Prepared plan has no checkpoint.",
                ));
            };
            if matches!(action, SyncAction::AdvanceCheckpoint { .. }) {
                state.stuck = None;
                self.journal_phase(state, BatchPhase::EffectsComplete, None)?;
                return Ok(ExecutionResult {
                    status: "effects_complete".into(),
                    completed: index,
                    failure: None,
                });
            }
            if let Some(missing) = action.depends_on().iter().find(|dependency| {
                !receipts
                    .iter()
                    .any(|receipt| &receipt.action_id == *dependency)
            }) {
                let failure = MirrorFailure {
                    code: "invalid_mirror_state".into(),
                    message: format!(
                        "Action {} is missing dependency {missing}.",
                        action.action_id()
                    ),
                    action_id: Some(action.action_id().into()),
                };
                self.journal_phase(state, BatchPhase::Blocked, Some(failure.clone()))?;
                return Ok(ExecutionResult {
                    status: "blocked".into(),
                    completed: index,
                    failure: Some(failure),
                });
            }
            match self.dispatch_action(state, &action).await {
                Ok(receipt) => {
                    if let Some((target, _, _)) = remote_file_action(&action) {
                        clear_stuck(state, &target.identity);
                    }
                    self.journal_receipt(state, receipt)?
                }
                Err(error) => {
                    let error = self.classify_refusal(state, &action, error)?;
                    let failure = MirrorFailure {
                        code: error.code,
                        message: error.message,
                        action_id: Some(action.action_id().into()),
                    };
                    self.journal_phase(state, BatchPhase::Blocked, Some(failure.clone()))?;
                    return Ok(ExecutionResult {
                        status: if failure.code == "sync_plan_stale" {
                            "stale".into()
                        } else {
                            "blocked".into()
                        },
                        completed: index,
                        failure: Some(failure),
                    });
                }
            }
        }
    }

    async fn dispatch_action(
        &self,
        state: &mut DurableMirrorState,
        action: &SyncAction,
    ) -> Result<DurableReceipt, MirrorError> {
        match action {
            SyncAction::WriteLocal {
                action_id,
                target,
                expected_local,
                expected_path_owner,
                invalid_local_revision,
                ..
            } => {
                let target_matches = if invalid_local_revision.is_some() {
                    self.matches_ref(target).unwrap_or(false)
                } else {
                    self.matches_ref(target)?
                };
                let replacing_invalid = invalid_local_revision.is_some() && !target_matches;
                if !target_matches {
                    if let Some(revision) = invalid_local_revision {
                        self.revalidate_raw_revision(&target.path, revision)?;
                        self.revalidate_path_owner_without_bytes(
                            Some(state),
                            &target.path,
                            expected_path_owner,
                        )?;
                    } else {
                        self.revalidate_expected(expected_local)?;
                        self.revalidate_at(&target.path, expected_path_owner)?;
                    }
                }
                match target.entity {
                    SyncObjectKind::Record => {
                        let record = state
                            .batch
                            .as_ref()
                            .and_then(|batch| batch.payloads.records.get(action_id))
                            .cloned()
                            .ok_or_else(|| missing_payload(action_id))?;
                        self.put_record(state, record.clone(), None, replacing_invalid)?;
                        Ok(completed_record(action_id, Some(record)))
                    }
                    SyncObjectKind::Resource => {
                        let resource = state
                            .batch
                            .as_ref()
                            .and_then(|batch| batch.payloads.resources.get(action_id))
                            .cloned()
                            .ok_or_else(|| missing_payload(action_id))?;
                        self.put_resource(state, &resource)?;
                        Ok(completed_record(action_id, None))
                    }
                    SyncObjectKind::File => {
                        let file = state
                            .batch
                            .as_ref()
                            .and_then(|batch| batch.payloads.files.get(action_id))
                            .cloned()
                            .ok_or_else(|| missing_payload(action_id))?;
                        self.put_collection_file(state, &file, None)?;
                        Ok(DurableReceipt {
                            action_id: action_id.clone(),
                            status: "completed".into(),
                            record: None,
                            file: Some(file),
                        })
                    }
                }
            }
            SyncAction::MoveLocal {
                action_id,
                source,
                target_path,
                expected_source_owner,
                expected_target_owner,
                ..
            } => {
                let target = SyncObjectRef {
                    path: target_path.clone(),
                    ..source.clone()
                };
                if !self.matches_ref(&target)? {
                    self.revalidate_expected(expected_source_owner)?;
                    self.revalidate_at(target_path, expected_target_owner)?;
                    self.move_file(&source.path, target_path)?;
                }
                match source.entity {
                    SyncObjectKind::Record => {
                        if let Ok(identity) = Uuid::parse_str(&source.identity) {
                            if let Some(entry) = state.records.get_mut(&identity) {
                                entry.path = target_path.clone();
                            }
                        }
                    }
                    SyncObjectKind::Resource => {
                        if let Some(mut entry) = state.resources.remove(&source.identity) {
                            entry.path = target_path.clone();
                            state.resources.insert(target_path.clone(), entry);
                        }
                    }
                    SyncObjectKind::File => {
                        if let Ok(identity) = Uuid::parse_str(&source.identity) {
                            if let Some(entry) = state.files.get_mut(&identity) {
                                entry.file.path = target_path.clone();
                            }
                        }
                    }
                }
                Ok(completed_record(action_id, None))
            }
            SyncAction::DeleteLocal {
                action_id,
                target,
                expected_local,
                expected_path_owner,
                ..
            } => {
                if self.matches_ref(target)? {
                    self.revalidate_expected(expected_local)?;
                    self.revalidate_at(&target.path, expected_path_owner)?;
                } else {
                    // A replay may already have deleted the target. Different
                    // bytes are not evidence of completion: preserve new edits.
                    self.revalidate_at(&target.path, &ExpectedObjectState::Absent)?;
                }
                match target.entity {
                    SyncObjectKind::Record => self.remove_record(
                        state,
                        parse_identity(&target.identity)?,
                        &target.path,
                        false,
                    )?,
                    SyncObjectKind::Resource => {
                        self.remove_file(&target.path)?;
                        state.resources.remove(&target.identity);
                    }
                    SyncObjectKind::File => self.remove_collection_file(
                        state,
                        parse_identity(&target.identity)?,
                        false,
                    )?,
                }
                Ok(completed_record(action_id, None))
            }
            SyncAction::PutRemote {
                action_id, target, ..
            }
            | SyncAction::DeleteRemote {
                action_id, target, ..
            } if target.entity == SyncObjectKind::Record => {
                let mutation = state
                    .batch
                    .as_ref()
                    .and_then(|batch| batch.payloads.mutations.get(action_id))
                    .cloned()
                    .ok_or_else(|| missing_payload(action_id))?;
                let accepted = state
                    .batch
                    .as_ref()
                    .and_then(|batch| batch.payloads.documents.get(action_id))
                    .cloned();
                let receipt = self.transport.mutate(&mutation).await?;
                self.accept_record_receipt(state, action, &receipt, accepted.as_deref())?;
                Ok(protocol_receipt(action_id, &receipt))
            }
            SyncAction::MoveRemote {
                action_id, source, ..
            } if source.entity == SyncObjectKind::Record => {
                let mutation = state
                    .batch
                    .as_ref()
                    .and_then(|batch| batch.payloads.mutations.get(action_id))
                    .cloned()
                    .ok_or_else(|| missing_payload(action_id))?;
                let receipt = self.transport.mutate(&mutation).await?;
                self.accept_record_receipt(state, action, &receipt, None)?;
                Ok(protocol_receipt(action_id, &receipt))
            }
            SyncAction::PutRemote {
                action_id,
                target,
                expected_remote,
                ..
            } if target.entity == SyncObjectKind::File => {
                let local = state
                    .batch
                    .as_ref()
                    .and_then(|batch| batch.payloads.local_files.get(action_id))
                    .cloned()
                    .ok_or_else(|| missing_payload(action_id))?;
                let request = OpenFileUploadRequest {
                    protocol_version: FILE_PROTOCOL_VERSION,
                    message_type: OpenFileUploadRequestKind::OpenFileUpload,
                    transfer_id: file_control_id(action_id, state.retry_epoch)?,
                    path: target.path.clone(),
                    size: local.size,
                    content_digest: local.content_digest.clone(),
                    media_type: local.media_type.clone(),
                    if_revision: expected_remote
                        .exact()
                        .map(|object| object.revision.clone()),
                };
                let receipt = self
                    .transport
                    .upload_file(&request, &self.blob_path(&local.content_digest)?)
                    .await?;
                self.validate_file_descriptor(&receipt.file)?;
                if receipt.transfer_id != request.transfer_id
                    || receipt.file.path != target.path
                    || receipt.file.content_digest != local.content_digest
                    || receipt.file.size != local.size
                {
                    return Err(invalid_file_receipt(action_id));
                }
                state.files.insert(
                    receipt.file.file_id,
                    MirrorFileEntry {
                        file: receipt.file.clone(),
                    },
                );
                state.local_bindings.remove(&target.identity);
                Ok(DurableReceipt {
                    action_id: action_id.clone(),
                    status: "completed".into(),
                    record: None,
                    file: Some(receipt.file),
                })
            }
            SyncAction::MoveRemote {
                action_id,
                source,
                target_path,
                expected_source_owner,
                revision_from_dependency,
                ..
            } if source.entity == SyncObjectKind::File => {
                let dependency_revision = revision_from_dependency
                    .as_ref()
                    .and_then(|dependency| {
                        state.batch.as_ref()?.receipts.iter().find_map(|receipt| {
                            (receipt.action_id == *dependency)
                                .then_some(receipt.file.as_ref())
                                .flatten()
                        })
                    })
                    .map(|file| file.revision.clone());
                if revision_from_dependency.is_some() && dependency_revision.is_none() {
                    return Err(MirrorError::new(
                        "invalid_mirror_state",
                        "File move is missing its dependency receipt.",
                    ));
                }
                let request = MoveFileRequest {
                    protocol_version: FILE_PROTOCOL_VERSION,
                    message_type: MoveFileRequestKind::MoveFile,
                    mutation_id: file_control_id(action_id, state.retry_epoch)?,
                    file_id: parse_identity(&source.identity)?,
                    if_revision: dependency_revision
                        .or_else(|| {
                            expected_source_owner
                                .exact()
                                .map(|value| value.revision.clone())
                        })
                        .unwrap_or_else(|| source.revision.clone()),
                    from_path: source.path.clone(),
                    path: target_path.clone(),
                    update_references: false,
                };
                let receipt = self.transport.move_file(&request).await?;
                self.validate_file_descriptor(&receipt.file)?;
                if receipt.mutation_id != request.mutation_id
                    || receipt.file.file_id != request.file_id
                    || receipt.file.path != request.path
                {
                    return Err(invalid_file_receipt(action_id));
                }
                state.files.insert(
                    receipt.file.file_id,
                    MirrorFileEntry {
                        file: receipt.file.clone(),
                    },
                );
                state.local_bindings.remove(&source.identity);
                Ok(DurableReceipt {
                    action_id: action_id.clone(),
                    status: "completed".into(),
                    record: None,
                    file: Some(receipt.file),
                })
            }
            SyncAction::DeleteRemote {
                action_id,
                target,
                expected_remote,
                ..
            } if target.entity == SyncObjectKind::File => {
                let request = DeleteFileRequest {
                    protocol_version: FILE_PROTOCOL_VERSION,
                    message_type: DeleteFileRequestKind::DeleteFile,
                    mutation_id: file_control_id(action_id, state.retry_epoch)?,
                    file_id: parse_identity(&target.identity)?,
                    if_revision: expected_remote
                        .exact()
                        .map(|value| value.revision.clone())
                        .unwrap_or_else(|| target.revision.clone()),
                    path: target.path.clone(),
                };
                let receipt = self.transport.delete_file(&request).await?;
                if receipt.mutation_id != request.mutation_id
                    || receipt.file_id != request.file_id
                    || receipt.previous_path != request.path
                {
                    return Err(invalid_file_receipt(action_id));
                }
                state.files.remove(&request.file_id);
                state.local_bindings.remove(&target.identity);
                Ok(completed_record(action_id, None))
            }
            SyncAction::PutRemote { .. }
            | SyncAction::MoveRemote { .. }
            | SyncAction::DeleteRemote { .. } => Err(MirrorError::new(
                "invalid_sync_plan",
                "Authority resources are not writable sync objects.",
            )),
            SyncAction::RecordConflict {
                action_id,
                identity,
                entity,
                local,
                remote,
                conflict_kind,
                ..
            } => {
                state.planned_conflicts.insert(
                    identity.clone(),
                    DurableConflict {
                        decision_id: conflict_decision_id(
                            entity,
                            identity,
                            local,
                            remote,
                            *conflict_kind,
                        )?,
                        entity: entity.clone(),
                        local: local.clone(),
                        remote: remote.clone(),
                        conflict_kind: *conflict_kind,
                    },
                );
                if let Some(object) = local.exact() {
                    state.local_bindings.insert(
                        identity.clone(),
                        LocalBinding {
                            entity: entity.clone(),
                            path: object.path.clone(),
                        },
                    );
                }
                self.rebase_conflict(state, action)?;
                Ok(DurableReceipt {
                    action_id: action_id.clone(),
                    status: "conflicted".into(),
                    record: None,
                    file: None,
                })
            }
            SyncAction::ClearConflict {
                action_id,
                identity,
                ..
            } => {
                state.planned_conflicts.remove(identity);
                state.local_bindings.remove(identity);
                Ok(DurableReceipt {
                    action_id: action_id.clone(),
                    status: "completed".into(),
                    record: None,
                    file: None,
                })
            }
            SyncAction::AdvanceCheckpoint { .. } => Err(MirrorError::new(
                "invalid_mirror_state",
                "Executor cannot dispatch checkpoints.",
            )),
        }
    }

    /// Decide what an authority's refusal of a remote file action means. Only
    /// a definite refusal can drop the batch: any failure whose outcome a retry
    /// must learn keeps it, so the retry reuses the same mutation or transfer
    /// ID and can never apply twice. A dropped batch is re-planned from current
    /// local and authority state, with fresh IDs only for work that did not apply.
    fn classify_refusal(
        &self,
        state: &mut DurableMirrorState,
        action: &SyncAction,
        error: MirrorError,
    ) -> Result<MirrorError, MirrorError> {
        let Some((target, local, remote)) = remote_file_action(action) else {
            return Ok(error);
        };
        if !definite_refusal(&error) {
            // A locally stale action is dropped: what the authority said about
            // the file before no longer describes this change.
            if error.code == "sync_plan_stale" {
                clear_stuck(state, &target.identity);
            }
            return Ok(error);
        }
        let code = error.code.as_str();
        // A file over the per-file limit fails identically on every plan.
        let trip = code == "file_too_large"
            || ((REPLAN_REFUSALS.contains(&code) || OBJECT_REFUSALS.contains(&code))
                && self.count_refusal(state, &target.identity, code));
        if trip {
            // Set the file aside as a rejected conflict. Its local bytes are
            // never touched; the user decides, and every other object syncs.
            state.planned_conflicts.insert(
                target.identity.clone(),
                DurableConflict {
                    decision_id: conflict_decision_id(
                        &target.entity,
                        &target.identity,
                        local,
                        remote,
                        ConflictKind::Rejected,
                    )?,
                    entity: target.entity.clone(),
                    local: local.clone(),
                    remote: remote.clone(),
                    conflict_kind: ConflictKind::Rejected,
                },
            );
            if let Some(object) = local.exact() {
                state.local_bindings.insert(
                    target.identity.clone(),
                    LocalBinding {
                        entity: target.entity.clone(),
                        path: object.path.clone(),
                    },
                );
            }
            return Ok(MirrorError::new(
                "sync_plan_stale",
                format!(
                    "{} was set aside after the authority refused it ({code}): {}",
                    target.path, error.message
                ),
            ));
        }
        // The plan no longer matches the authority, or the upload's transfer
        // can no longer commit. The authority would answer the same ID the same
        // way, so plan again, with a fresh ID for this work.
        if code == "file_transfer_expired" || REPLAN_REFUSALS.contains(&code) {
            return Ok(MirrorError::new(
                "sync_plan_stale",
                format!(
                    "The authority refused {} ({code}); planning again.",
                    target.path
                ),
            ));
        }
        Ok(error)
    }

    /// Count one definite refusal of `identity` and report whether it should
    /// now be set aside: the same refusal at least `STUCK_ATTEMPTS` times over
    /// at least `STUCK_AFTER`. Other failures never reach this, so they leave
    /// the count as it was.
    fn count_refusal(&self, state: &mut DurableMirrorState, identity: &str, code: &str) -> bool {
        let now = (self.clock)();
        let stuck = match state.stuck.take() {
            Some(mut stuck) if stuck.identity == identity && stuck.code == code => {
                stuck.attempts += 1;
                stuck
            }
            _ => StuckAction {
                identity: identity.to_string(),
                code: code.to_string(),
                attempts: 1,
                since: now.to_rfc3339(),
            },
        };
        let stuck_for = chrono::DateTime::parse_from_rfc3339(&stuck.since)
            .map(|since| now.signed_duration_since(since))
            .unwrap_or_default();
        let trip = stuck.attempts >= STUCK_ATTEMPTS && stuck_for >= STUCK_AFTER;
        if !trip {
            state.stuck = Some(stuck);
        }
        trip
    }

    fn rebase_conflict(
        &self,
        state: &mut DurableMirrorState,
        action: &SyncAction,
    ) -> Result<(), MirrorError> {
        let SyncAction::RecordConflict {
            action_id,
            identity,
            entity,
            local,
            remote,
            ..
        } = action
        else {
            return Ok(());
        };
        match entity {
            SyncObjectKind::Record => match remote {
                ExpectedObjectState::Absent => {
                    if let Ok(id) = Uuid::parse_str(identity) {
                        state.records.remove(&id);
                    }
                }
                ExpectedObjectState::Exact { .. } => {
                    let record = state
                        .batch
                        .as_ref()
                        .and_then(|batch| batch.payloads.records.get(action_id))
                        .cloned()
                        .ok_or_else(|| missing_payload(action_id))?;
                    state.records.insert(
                        record.record_id,
                        MirrorEntry {
                            path: record.path.clone(),
                            revision: record.revision.clone(),
                            hash: local
                                .exact()
                                .map(|value| {
                                    value
                                        .payload_revision
                                        .trim_start_matches("sha256:")
                                        .to_string()
                                })
                                .unwrap_or_else(|| digest(&record.document)),
                            record: (self.mode == SyncReplicaMode::ReadWrite).then_some(record),
                        },
                    );
                }
            },
            SyncObjectKind::File => match remote {
                ExpectedObjectState::Absent => {
                    if let Ok(id) = Uuid::parse_str(identity) {
                        state.files.remove(&id);
                    }
                }
                ExpectedObjectState::Exact { .. } => {
                    let file = state
                        .batch
                        .as_ref()
                        .and_then(|batch| batch.payloads.files.get(action_id))
                        .cloned()
                        .ok_or_else(|| missing_payload(action_id))?;
                    state.files.insert(file.file_id, MirrorFileEntry { file });
                }
            },
            SyncObjectKind::Resource => {}
        }
        Ok(())
    }

    fn accept_record_receipt(
        &self,
        state: &mut DurableMirrorState,
        action: &SyncAction,
        receipt: &SyncMutationReceipt,
        accepted_document: Option<&str>,
    ) -> Result<(), MirrorError> {
        let (identity, local, expected_remote) = match action {
            SyncAction::PutRemote {
                target,
                expected_local,
                expected_remote,
                ..
            }
            | SyncAction::DeleteRemote {
                target,
                expected_local,
                expected_remote,
                ..
            } => (&target.identity, expected_local, expected_remote),
            SyncAction::MoveRemote {
                source,
                expected_local,
                expected_source_owner,
                ..
            } => (&source.identity, expected_local, expected_source_owner),
            _ => {
                return Err(MirrorError::new(
                    "invalid_sync_plan",
                    "Receipt does not belong to a remote record command.",
                ))
            }
        };
        let id = parse_identity(identity)?;
        match receipt {
            SyncMutationReceipt::Applied { record, .. }
            | SyncMutationReceipt::PreviouslyApplied { record, .. } => {
                if let Some(record) = record {
                    let hash = accepted_document
                        .map(digest)
                        .or_else(|| state.records.get(&id).map(|entry| entry.hash.clone()))
                        .unwrap_or_else(|| digest(&record.document));
                    state.records.insert(
                        id,
                        MirrorEntry {
                            path: record.path.clone(),
                            revision: record.revision.clone(),
                            hash,
                            record: (self.mode == SyncReplicaMode::ReadWrite)
                                .then_some(record.clone()),
                        },
                    );
                } else {
                    state.records.remove(&id);
                }
                state.local_bindings.remove(identity);
            }
            SyncMutationReceipt::Conflicted { conflict, .. } => {
                let remote = conflict
                    .current
                    .as_ref()
                    .map(|record| ExpectedObjectState::Exact {
                        object: SyncObjectRef {
                            entity: SyncObjectKind::Record,
                            identity: identity.clone(),
                            path: record.path.clone(),
                            revision: record.revision.clone(),
                            payload_revision: record.revision.clone(),
                            size: None,
                        },
                    })
                    .unwrap_or(ExpectedObjectState::Absent);
                state.planned_conflicts.insert(
                    identity.clone(),
                    DurableConflict {
                        decision_id: conflict_decision_id(
                            &SyncObjectKind::Record,
                            identity,
                            local,
                            &remote,
                            ConflictKind::BothChanged,
                        )?,
                        entity: SyncObjectKind::Record,
                        local: local.clone(),
                        remote: remote.clone(),
                        conflict_kind: ConflictKind::BothChanged,
                    },
                );
                if let Some(object) = local.exact() {
                    state.local_bindings.insert(
                        identity.clone(),
                        LocalBinding {
                            entity: SyncObjectKind::Record,
                            path: object.path.clone(),
                        },
                    );
                }
                if let Some(record) = &conflict.current {
                    state.records.insert(
                        id,
                        MirrorEntry {
                            path: record.path.clone(),
                            revision: record.revision.clone(),
                            hash: local
                                .exact()
                                .map(|value| {
                                    value
                                        .payload_revision
                                        .trim_start_matches("sha256:")
                                        .to_string()
                                })
                                .unwrap_or_else(|| digest(&record.document)),
                            record: (self.mode == SyncReplicaMode::ReadWrite)
                                .then_some(record.clone()),
                        },
                    );
                }
            }
            SyncMutationReceipt::Rejected { .. } => {
                state.planned_conflicts.insert(
                    identity.clone(),
                    DurableConflict {
                        decision_id: conflict_decision_id(
                            &SyncObjectKind::Record,
                            identity,
                            local,
                            expected_remote,
                            ConflictKind::Rejected,
                        )?,
                        entity: SyncObjectKind::Record,
                        local: local.clone(),
                        remote: expected_remote.clone(),
                        conflict_kind: ConflictKind::Rejected,
                    },
                );
                if let Some(object) = local.exact() {
                    state.local_bindings.insert(
                        identity.clone(),
                        LocalBinding {
                            entity: SyncObjectKind::Record,
                            path: object.path.clone(),
                        },
                    );
                }
            }
        }
        Ok(())
    }
}

fn conflict_decision_id(
    entity: &SyncObjectKind,
    identity: &str,
    local: &ExpectedObjectState,
    remote: &ExpectedObjectState,
    conflict_kind: ConflictKind,
) -> Result<String, MirrorError> {
    fingerprint(&(entity, identity, local, remote, conflict_kind))
}

fn parse_identity(value: &str) -> Result<Uuid, MirrorError> {
    Uuid::parse_str(value)
        .map_err(|_| MirrorError::new("invalid_sync_plan", "Record/file identity is not a UUID."))
}
fn missing_payload(action: &str) -> MirrorError {
    MirrorError::new(
        "sync_payload_incomplete",
        format!("Action {action} has no exact payload."),
    )
}
fn invalid_file_receipt(action: &str) -> MirrorError {
    MirrorError::new(
        "invalid_sync_response",
        format!("Authority file receipt does not match action {action}."),
    )
}
/// The file a remote action changes, with the states it expects locally and
/// on the authority. Record actions are not classified.
fn remote_file_action(
    action: &SyncAction,
) -> Option<(&SyncObjectRef, &ExpectedObjectState, &ExpectedObjectState)> {
    let (target, local, remote) = match action {
        SyncAction::PutRemote {
            target,
            expected_local,
            expected_remote,
            ..
        }
        | SyncAction::DeleteRemote {
            target,
            expected_local,
            expected_remote,
            ..
        } => (target, expected_local, expected_remote),
        SyncAction::MoveRemote {
            source,
            expected_local,
            expected_source_owner,
            ..
        } => (source, expected_local, expected_source_owner),
        _ => return None,
    };
    (target.entity == SyncObjectKind::File).then_some((target, local, remote))
}
fn clear_stuck(state: &mut DurableMirrorState, identity: &str) {
    if state
        .stuck
        .as_ref()
        .is_some_and(|stuck| stuck.identity == identity)
    {
        state.stuck = None;
    }
}
/// File controls are journaled by the authority under this ID, errors included.
/// A batch always runs under the epoch it was prepared in, so retries reuse
/// the ID; after an abandoned batch, re-planned work gets a new one.
fn file_control_id(action: &str, retry_epoch: u64) -> Result<Uuid, MirrorError> {
    if retry_epoch == 0 {
        return uuid_from_action_id(action);
    }
    uuid_from_action_id(&format!(
        "sha256:{}",
        digest(&format!("{action}\0{retry_epoch}"))
    ))
}
fn uuid_from_action_id(action: &str) -> Result<Uuid, MirrorError> {
    let hex = action
        .strip_prefix("sha256:")
        .ok_or_else(|| missing_payload(action))?;
    Uuid::parse_str(&format!(
        "{}-{}-4{}-8{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[13..16],
        &hex[17..20],
        &hex[20..32]
    ))
    .map_err(|_| missing_payload(action))
}
fn completed_record(action: &str, record: Option<SyncRecord>) -> DurableReceipt {
    DurableReceipt {
        action_id: action.into(),
        status: "completed".into(),
        record,
        file: None,
    }
}
fn protocol_receipt(action: &str, receipt: &SyncMutationReceipt) -> DurableReceipt {
    match receipt {
        SyncMutationReceipt::Applied { record, .. }
        | SyncMutationReceipt::PreviouslyApplied { record, .. } => DurableReceipt {
            action_id: action.into(),
            status: "completed".into(),
            record: record.clone(),
            file: None,
        },
        SyncMutationReceipt::Conflicted { .. } => DurableReceipt {
            action_id: action.into(),
            status: "conflicted".into(),
            record: None,
            file: None,
        },
        SyncMutationReceipt::Rejected { .. } => DurableReceipt {
            action_id: action.into(),
            status: "rejected".into(),
            record: None,
            file: None,
        },
    }
}
