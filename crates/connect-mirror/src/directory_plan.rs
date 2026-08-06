use super::*;
use crate::directory_files::verify_file;

impl DirectoryMirror {
    pub async fn inspect(&self) -> Result<MirrorSyncPlan, MirrorError> {
        let _lease = MirrorLease::acquire(&self.lock_file)?;
        self.inspect_unlocked().await
    }

    pub async fn apply(&self, plan: &MirrorSyncPlan) -> Result<MirrorApplyResult, MirrorError> {
        self.apply_fingerprint(&plan.fingerprint).await
    }

    pub async fn apply_fingerprint(
        &self,
        fingerprint: &str,
    ) -> Result<MirrorApplyResult, MirrorError> {
        let _lease = MirrorLease::acquire(&self.lock_file)?;
        let current = self.inspect_unlocked().await?;
        if current.fingerprint != fingerprint {
            return Err(MirrorError::new(
                "sync_plan_stale",
                "The local folder or authority changed. Inspect the sync plan again.",
            ));
        }
        if current.issues.iter().any(|issue| issue.blocking) {
            return self.plan_result("attention", &current, 0);
        }
        self.apply_current_unlocked(&current).await
    }

    pub(super) async fn apply_current_unlocked(
        &self,
        current: &MirrorSyncPlan,
    ) -> Result<MirrorApplyResult, MirrorError> {
        self.sync_unlocked().await?;
        self.prune_file_cache()?;
        let status = self.status()?;
        let attention = !status.conflicts.is_empty() || !status.local_issues.is_empty();
        self.plan_result(
            if attention { "attention" } else { "applied" },
            current,
            current.actions.len().saturating_sub(status.pending),
        )
    }

    pub(super) async fn inspect_unlocked(&self) -> Result<MirrorSyncPlan, MirrorError> {
        let state = self.read_state()?;
        match state {
            None => self.inspect_snapshot("initial", None).await,
            Some(state) if state.sync_policy != self.sync_policy => {
                self.inspect_snapshot("rebuild", Some(&state)).await
            }
            Some(state) => self.inspect_incremental(&state).await,
        }
    }

    async fn inspect_snapshot(
        &self,
        kind: &str,
        prior: Option<&DurableMirrorState>,
    ) -> Result<MirrorSyncPlan, MirrorError> {
        let session = self.transport.open_session().await?;
        self.validate_plan_session(&session)?;
        let mut records = Vec::new();
        let mut page = None;
        let mut seen = HashSet::new();
        loop {
            let snapshot = self
                .transport
                .snapshot(session.snapshot_id, page.as_deref())
                .await?;
            if snapshot.snapshot_id != session.snapshot_id
                || snapshot.scope_epoch != session.scope_epoch
                || snapshot.cursor != session.head
            {
                return Err(MirrorError::new(
                    "invalid_snapshot",
                    "Hosted snapshot boundary changed during inspection.",
                ));
            }
            records.extend(
                snapshot
                    .records
                    .into_iter()
                    .filter(|record| self.path_selected(&record.record.path)),
            );
            page = snapshot.next_page;
            if page
                .as_ref()
                .is_some_and(|value| !seen.insert(value.clone()))
            {
                return Err(MirrorError::new(
                    "invalid_snapshot",
                    "Hosted snapshot repeated a page.",
                ));
            }
            if page.is_none() {
                break;
            }
        }
        let mut files = Vec::new();
        let mut page = None;
        let mut seen = HashSet::new();
        loop {
            let snapshot = self
                .transport
                .file_snapshot(session.snapshot_id, page.as_deref())
                .await?;
            if snapshot.snapshot_id != session.snapshot_id
                || snapshot.scope_epoch != session.scope_epoch
                || snapshot.cursor != session.head
            {
                return Err(MirrorError::new(
                    "invalid_snapshot",
                    "Hosted file snapshot boundary changed during inspection.",
                ));
            }
            files.extend(
                snapshot
                    .files
                    .into_iter()
                    .filter(|file| self.file_selected(file)),
            );
            page = snapshot.next_page;
            if page
                .as_ref()
                .is_some_and(|value| !seen.insert(value.clone()))
            {
                return Err(MirrorError::new(
                    "invalid_snapshot",
                    "Hosted file snapshot repeated a page.",
                ));
            }
            if page.is_none() {
                break;
            }
        }
        self.validate_snapshot_shape(&session.resources, &records, &files)?;
        self.validate_snapshot_documents(&session.resources, &records)?;
        let mut actions = Vec::new();
        let mut issues = Vec::new();
        let reason = kind.to_string();
        let mut remote_paths = HashSet::new();
        let mut remote_record_ids = HashSet::new();
        let mut remote_file_ids = HashSet::new();
        for resource in &session.resources.documents {
            remote_paths.insert(resource.path.clone());
            self.inspect_text_target(
                "resource",
                &resource.path,
                &resource.document,
                Some(resource.path.clone()),
                Some(resource.revision.clone()),
                prior.and_then(|state| state.resources.get(&resource.path)),
                &reason,
                &mut actions,
                &mut issues,
            )?;
        }
        for snapshot in &records {
            let record = &snapshot.record;
            remote_paths.insert(record.path.clone());
            remote_record_ids.insert(record.record_id);
            self.inspect_text_target(
                "record",
                &record.path,
                &record.document,
                Some(record.record_id.to_string()),
                Some(record.revision.clone()),
                prior.and_then(|state| state.records.get(&record.record_id)),
                &reason,
                &mut actions,
                &mut issues,
            )?;
        }
        for file in &files {
            remote_paths.insert(file.path.clone());
            remote_file_ids.insert(file.file_id);
            let path = safe_path(&self.root, &file.path)?;
            if path.exists() && verify_file(&path, file)? {
                continue;
            }
            let prior_file = prior.and_then(|state| state.files.get(&file.file_id));
            let matches_prior = match prior_file {
                Some(entry) => verify_file(&path, &entry.file)?,
                None => false,
            };
            if path.exists() && !matches_prior {
                issues.push(MirrorPlanIssue {
                    code: "local_collision".to_string(),
                    message: format!("{} differs from the exact authority file.", file.path),
                    path: Some(file.path.clone()),
                    blocking: true,
                });
                continue;
            }
            if let Some(prior_file) = prior_file.filter(|entry| entry.file.path != file.path) {
                actions.push(file_action(
                    "authority_to_local",
                    "move",
                    file,
                    &reason,
                    Some(prior_file.file.path.clone()),
                    "ready",
                ));
            }
            actions.push(file_action(
                "authority_to_local",
                "put",
                file,
                &reason,
                None,
                "ready",
            ));
        }
        if let Some(prior) = prior {
            for (record_id, entry) in &prior.records {
                if !remote_record_ids.contains(record_id) {
                    actions.push(plan_action(
                        "record",
                        "authority_to_local",
                        "delete",
                        &entry.path,
                        None,
                        Some(record_id.to_string()),
                        Some(entry.revision.clone()),
                        None,
                        &reason,
                        "ready",
                    ));
                }
            }
            for (file_id, entry) in &prior.files {
                if !remote_file_ids.contains(file_id) {
                    actions.push(file_action(
                        "authority_to_local",
                        "delete",
                        &entry.file,
                        &reason,
                        None,
                        "ready",
                    ));
                }
            }
        }
        if self.mode == SyncReplicaMode::ReadWrite {
            let local_markdown = if prior.is_some() {
                self.list_markdown(&remote_paths)?
            } else {
                self.list_markdown_for_resources(&remote_paths, &session.resources)?
            };
            for path in local_markdown {
                if remote_paths.contains(&path) || !self.path_selected(&path) {
                    continue;
                }
                let Some(document) = self.read_file(&path)? else {
                    continue;
                };
                if let Err(error) = parse_markdown(&document, &path) {
                    issues.push(issue(error, Some(path), false));
                    continue;
                }
                actions.push(plan_action(
                    "record",
                    "local_to_authority",
                    "put",
                    &path,
                    None,
                    None,
                    Some(format!("sha256:{}", digest(&document))),
                    None,
                    &reason,
                    "ready",
                ));
            }
        }
        finalize_plan(
            self,
            kind,
            prior.map(|state| state.cursor),
            session.head,
            session.scope_epoch,
            actions,
            issues,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn inspect_text_target(
        &self,
        entity: &str,
        path: &str,
        document: &str,
        identity: Option<String>,
        revision: Option<String>,
        prior: Option<&MirrorEntry>,
        reason: &str,
        actions: &mut Vec<MirrorPlanAction>,
        issues: &mut Vec<MirrorPlanIssue>,
    ) -> Result<(), MirrorError> {
        let local = self.read_file(path)?;
        if local.as_deref() == Some(document) {
            return Ok(());
        }
        if let Some(local) = local {
            if prior.is_none_or(|entry| digest(&local) != entry.hash) {
                issues.push(MirrorPlanIssue {
                    code: "local_collision".to_string(),
                    message: format!("{path} differs from the exact authority document."),
                    path: Some(path.to_string()),
                    blocking: true,
                });
                return Ok(());
            }
        }
        if let Some(prior) = prior.filter(|entry| entry.path != path) {
            actions.push(plan_action(
                entity,
                "authority_to_local",
                "move",
                path,
                Some(prior.path.clone()),
                identity.clone(),
                revision.clone(),
                None,
                reason,
                "ready",
            ));
        }
        actions.push(plan_action(
            entity,
            "authority_to_local",
            "put",
            path,
            None,
            identity,
            revision,
            None,
            reason,
            "ready",
        ));
        Ok(())
    }

    async fn inspect_incremental(
        &self,
        state: &DurableMirrorState,
    ) -> Result<MirrorSyncPlan, MirrorError> {
        let mut working = state.clone();
        let mut actions = Vec::new();
        let mut issues = Vec::new();
        if self.mode == SyncReplicaMode::ReadWrite {
            // Durable pending work is one reviewable batch. New edits wait for
            // the next inspection so apply never performs unplanned writes.
            if working.pending.is_empty() {
                if let Err(error) = self.capture_local_changes(&mut working) {
                    issues.push(issue(error, None, true));
                }
            }
            for pending in &working.pending {
                let mutation = &pending.mutation;
                actions.push(plan_action(
                    "record",
                    "local_to_authority",
                    match mutation.operation {
                        SyncMutationOperation::Put => "put",
                        SyncMutationOperation::Move => "move",
                        SyncMutationOperation::Delete => "delete",
                    },
                    mutation.path.as_deref().unwrap_or(&pending.local_path),
                    (mutation.operation == SyncMutationOperation::Move)
                        .then(|| {
                            state
                                .records
                                .get(&mutation.record_id)
                                .map(|entry| entry.path.clone())
                        })
                        .flatten(),
                    (!(mutation.operation == SyncMutationOperation::Put
                        && mutation.base_revision.is_none()))
                    .then(|| mutation.record_id.to_string()),
                    mutation
                        .document
                        .as_ref()
                        .map(|document| format!("sha256:{}", digest(document)))
                        .or_else(|| mutation.base_revision.clone()),
                    None,
                    if state
                        .pending
                        .iter()
                        .any(|item| item.mutation.mutation_id == mutation.mutation_id)
                    {
                        "pending"
                    } else {
                        "local_change"
                    },
                    "ready",
                ));
            }
        } else if let Err(error) = self.assert_undiverged(state) {
            issues.push(issue(error, None, true));
        }
        let local_ids = actions
            .iter()
            .filter(|action| action.direction == "local_to_authority")
            .filter_map(|action| action.identity.clone())
            .collect::<HashSet<_>>();
        let mut cursor = state.cursor;
        loop {
            let page = self.transport.changes(cursor, 200).await?;
            if page.scope_epoch != state.scope_epoch || page.reset_required {
                return self.inspect_snapshot("rebuild", Some(state)).await;
            }
            if let Err(error) = self.preflight_change_physical_paths(state, &page.events) {
                issues.push(issue(error, None, true));
            }
            for event in page.events {
                match event {
                    SyncChange::Put { record, .. } if self.path_selected(&record.path) => {
                        let prior = state.records.get(&record.record_id);
                        let outcome = if local_ids.contains(&record.record_id.to_string()) {
                            "conflict"
                        } else {
                            "ready"
                        };
                        if prior.is_some_and(|entry| entry.path != record.path) {
                            actions.push(plan_action(
                                "record",
                                "authority_to_local",
                                "move",
                                &record.path,
                                prior.map(|entry| entry.path.clone()),
                                Some(record.record_id.to_string()),
                                Some(record.revision.clone()),
                                None,
                                "remote_change",
                                outcome,
                            ));
                        }
                        if prior.is_none_or(|entry| entry.revision != record.revision) {
                            actions.push(plan_action(
                                "record",
                                "authority_to_local",
                                "put",
                                &record.path,
                                None,
                                Some(record.record_id.to_string()),
                                Some(record.revision),
                                None,
                                "remote_change",
                                outcome,
                            ));
                        }
                    }
                    SyncChange::Remove {
                        record_id,
                        previous_path,
                        revision,
                        ..
                    } => {
                        if state.records.contains_key(&record_id) {
                            actions.push(plan_action(
                                "record",
                                "authority_to_local",
                                "delete",
                                &previous_path,
                                None,
                                Some(record_id.to_string()),
                                Some(revision),
                                None,
                                "remote_change",
                                if local_ids.contains(&record_id.to_string()) {
                                    "conflict"
                                } else {
                                    "ready"
                                },
                            ));
                        }
                    }
                    SyncChange::FilePut { file, .. } if self.file_selected(&file) => {
                        actions.push(file_action(
                            "authority_to_local",
                            "put",
                            &file,
                            "remote_change",
                            state.files.get(&file.file_id).and_then(|entry| {
                                (entry.file.path != file.path).then(|| entry.file.path.clone())
                            }),
                            "ready",
                        ));
                    }
                    SyncChange::FileRemove {
                        file_id,
                        previous_path,
                        revision,
                        ..
                    } => {
                        actions.push(plan_action(
                            "file",
                            "authority_to_local",
                            "delete",
                            &previous_path,
                            None,
                            Some(file_id.to_string()),
                            Some(revision),
                            None,
                            "remote_change",
                            "ready",
                        ));
                    }
                    SyncChange::Put { .. } | SyncChange::FilePut { .. } => {}
                }
            }
            cursor = page.cursor;
            if !page.has_more {
                break;
            }
        }
        for (record_id, receipt) in &state.conflicts {
            let (code, message) = match receipt {
                SyncMutationReceipt::Rejected { error, .. } => {
                    (error.code.clone(), error.message.clone())
                }
                _ => (
                    "record_conflict".to_string(),
                    "Local and authority changes need a decision.".to_string(),
                ),
            };
            issues.push(MirrorPlanIssue {
                code,
                message,
                path: state.records.get(record_id).map(|entry| entry.path.clone()),
                blocking: false,
            });
        }
        issues.extend(state.local_issues.values().map(|value| MirrorPlanIssue {
            code: value.code.clone(),
            message: value.message.clone(),
            path: Some(value.path.clone()),
            blocking: false,
        }));
        finalize_plan(
            self,
            "incremental",
            Some(state.cursor),
            cursor,
            state.scope_epoch,
            actions,
            issues,
        )
    }

    fn validate_plan_session(&self, session: &SyncSession) -> Result<(), MirrorError> {
        if session.protocol_version != SYNC_PROTOCOL_VERSION
            || session.protocol_profile != mdbase_connect_protocol::SYNC_PROTOCOL_PROFILE
            || session.replica_id != self.replica_id
            || session.mode != self.mode
        {
            return Err(MirrorError::new(
                "sync_protocol_incompatible",
                "Authority does not provide exact-document v1 for this replica.",
            ));
        }
        Ok(())
    }

    fn plan_result(
        &self,
        status_value: &str,
        plan: &MirrorSyncPlan,
        applied: usize,
    ) -> Result<MirrorApplyResult, MirrorError> {
        let status = self.status()?;
        Ok(MirrorApplyResult {
            status: status_value.to_string(),
            plan_fingerprint: plan.fingerprint.clone(),
            applied,
            pending: status.pending,
            checkpoint_cursor: status.cursor,
            conflicts: status.conflicts.len(),
            issues: plan.issues.clone(),
        })
    }
}

#[allow(clippy::too_many_arguments)]
fn plan_action(
    entity: &str,
    direction: &str,
    operation: &str,
    path: &str,
    previous_path: Option<String>,
    identity: Option<String>,
    revision: Option<String>,
    size: Option<u64>,
    reason: &str,
    outcome: &str,
) -> MirrorPlanAction {
    MirrorPlanAction {
        entity: entity.to_string(),
        direction: direction.to_string(),
        operation: operation.to_string(),
        path: path.to_string(),
        previous_path,
        identity,
        revision,
        size,
        reason: reason.to_string(),
        outcome: outcome.to_string(),
    }
}

fn file_action(
    direction: &str,
    operation: &str,
    file: &CollectionFileDescriptor,
    reason: &str,
    previous_path: Option<String>,
    outcome: &str,
) -> MirrorPlanAction {
    plan_action(
        "file",
        direction,
        operation,
        &file.path,
        previous_path,
        Some(file.file_id.to_string()),
        Some(file.revision.clone()),
        Some(file.size),
        reason,
        outcome,
    )
}

fn issue(error: MirrorError, path: Option<String>, blocking: bool) -> MirrorPlanIssue {
    MirrorPlanIssue {
        code: error.code,
        message: error.message,
        path,
        blocking,
    }
}

fn finalize_plan(
    mirror: &DirectoryMirror,
    kind: &str,
    base_cursor: Option<u64>,
    authority_cursor: u64,
    scope_epoch: u64,
    mut actions: Vec<MirrorPlanAction>,
    mut issues: Vec<MirrorPlanIssue>,
) -> Result<MirrorSyncPlan, MirrorError> {
    actions.sort_by(|left, right| {
        (
            &left.entity,
            &left.path,
            &left.direction,
            &left.operation,
            &left.identity,
        )
            .cmp(&(
                &right.entity,
                &right.path,
                &right.direction,
                &right.operation,
                &right.identity,
            ))
    });
    issues.sort_by(|left, right| {
        (&left.path, &left.code, &left.message).cmp(&(&right.path, &right.code, &right.message))
    });
    let summary = MirrorPlanSummary {
        uploads: actions
            .iter()
            .filter(|action| action.direction == "local_to_authority")
            .count(),
        downloads: actions
            .iter()
            .filter(|action| action.direction == "authority_to_local")
            .count(),
        conflicts: actions
            .iter()
            .filter(|action| action.outcome == "conflict")
            .count(),
        blocking_issues: issues.iter().filter(|issue| issue.blocking).count(),
    };
    let stable = serde_json::json!({
        "plan_version": 1,
        "replica_id": mirror.replica_id,
        "mode": mirror.mode,
        "kind": kind,
        "base_cursor": base_cursor,
        "authority_cursor": authority_cursor,
        "scope_epoch": scope_epoch,
        "actions": actions,
        "issues": issues,
        "summary": summary,
    });
    let bytes = serde_json::to_vec(&stable)
        .map_err(|error| MirrorError::new("sync_plan_failed", error.to_string()))?;
    Ok(MirrorSyncPlan {
        plan_version: 1,
        fingerprint: format!("sha256:{:x}", Sha256::digest(&bytes)),
        replica_id: mirror.replica_id,
        mode: mirror.mode,
        kind: kind.to_string(),
        base_cursor,
        authority_cursor,
        scope_epoch,
        actions,
        issues,
        summary,
    })
}
