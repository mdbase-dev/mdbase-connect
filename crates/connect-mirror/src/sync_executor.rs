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
                Ok(receipt) => self.journal_receipt(state, receipt)?,
                Err(error) => {
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
                ..
            } => {
                if !self.matches_ref(target)? {
                    self.revalidate_expected(expected_local)?;
                    self.revalidate_at(&target.path, expected_path_owner)?;
                }
                match target.entity {
                    SyncObjectKind::Record => {
                        let record = state
                            .batch
                            .as_ref()
                            .and_then(|batch| batch.payloads.records.get(action_id))
                            .cloned()
                            .ok_or_else(|| missing_payload(action_id))?;
                        self.put_record(state, record.clone(), None)?;
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
                    transfer_id: uuid_from_action_id(action_id)?,
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
                    mutation_id: uuid_from_action_id(action_id)?,
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
                    mutation_id: uuid_from_action_id(action_id)?,
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
