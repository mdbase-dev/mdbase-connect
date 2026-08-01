use super::*;

impl DirectoryMirror {
    pub(super) fn put(
        &self,
        state: &mut DurableMirrorState,
        record: SyncRecord,
        options: PutOptions<'_>,
    ) -> Result<(), MirrorError> {
        self.validate_record_path(&record.path)?;
        if !options.physical_path_preflighted {
            self.validate_record_physical_path(state, record.record_id, &record.path)?;
        }
        let document = record_markdown_document(&record)?;
        let existing = self.read_file(&record.path)?;
        let prior = state.records.get(&record.record_id).cloned();
        if let Some(existing) = &existing {
            if existing != &document {
                let existing_hash = digest(existing);
                let destination_belongs_to_record = prior
                    .as_ref()
                    .is_some_and(|entry| entry.path == record.path && existing_hash == entry.hash);
                let unmanaged = !destination_belongs_to_record;
                let not_accepted = options
                    .accepted_hash
                    .is_none_or(|hash| existing_hash != hash);
                if unmanaged && not_accepted {
                    return Err(MirrorError::new(
                        "mirror_diverged",
                        format!(
                            "Local edits at {} must be resolved before the mirror can continue.",
                            record.path
                        ),
                    ));
                }
            }
        }
        if let Some(prior) = &prior {
            if prior.path != record.path {
                self.remove(state, record.record_id, &prior.path)?;
            }
        }
        let accepted_local_hash = if options.preserve_accepted_document {
            existing.as_ref().and_then(|existing| {
                let existing_hash = digest(existing);
                options
                    .accepted_hash
                    .filter(|accepted| existing_hash == *accepted)
                    .map(|_| existing_hash)
            })
        } else {
            None
        };
        if accepted_local_hash.is_none() {
            self.write_file(&record.path, document.as_bytes())?;
        }
        state.records.insert(
            record.record_id,
            MirrorEntry {
                path: record.path.clone(),
                revision: record.revision.clone(),
                hash: accepted_local_hash.unwrap_or_else(|| digest(&document)),
                record: (self.mode == SyncReplicaMode::ReadWrite).then_some(record),
            },
        );
        Ok(())
    }

    pub(super) fn remove(
        &self,
        state: &mut DurableMirrorState,
        record_id: Uuid,
        previous_path: &str,
    ) -> Result<(), MirrorError> {
        let entry = state.records.get(&record_id).cloned();
        let path = entry
            .as_ref()
            .map(|entry| entry.path.as_str())
            .unwrap_or(previous_path);
        self.validate_record_path(path)?;
        if let Some(existing) = self.read_file(path)? {
            if entry
                .as_ref()
                .is_some_and(|entry| digest(&existing) != entry.hash)
            {
                return Err(MirrorError::new(
                    "mirror_diverged",
                    format!("Local edits at {path} must be resolved before deletion."),
                ));
            }
            self.remove_file(path)?;
        }
        state.records.remove(&record_id);
        Ok(())
    }

    pub(super) fn capture_local_changes(
        &self,
        state: &mut DurableMirrorState,
    ) -> Result<(), MirrorError> {
        self.assert_files_undiverged(state)?;
        let resource_paths = state.resources.keys().cloned().collect::<HashSet<_>>();
        for (path, entry) in &state.resources {
            let value = self.read_file(path)?;
            if value.is_none_or(|value| digest(&value) != entry.hash) {
                return Err(MirrorError::new(
                    "mirror_diverged",
                    format!("Authority-owned resource {path} was changed locally."),
                ));
            }
        }
        let files = self.list_markdown(&resource_paths)?;
        let mut physical_paths = HashMap::<String, String>::new();
        for path in resource_paths.iter().chain(files.iter()) {
            let physical_path = portable_mirror_path_key(path).map_err(|error| {
                MirrorError::new(
                    "invalid_record_path",
                    format!("Mirror path '{path}' is unsafe: {error}"),
                )
            })?;
            if let Some(existing) = physical_paths.insert(physical_path, path.clone()) {
                if existing != path.as_str() {
                    return Err(MirrorError::new(
                        "invalid_record_path",
                        format!(
                            "Mirror paths {existing} and {path} alias on a supported filesystem."
                        ),
                    ));
                }
            }
        }
        let managed_paths = state
            .records
            .iter()
            .map(|(record_id, entry)| (entry.path.clone(), *record_id))
            .collect::<HashMap<_, _>>();
        let mut local = BTreeMap::<String, (Option<String>, String)>::new();
        for path in files {
            let Some(document) = self.read_file(&path)? else {
                continue;
            };
            let hash = digest(&document);
            let unchanged = managed_paths
                .get(&path)
                .and_then(|record_id| state.records.get(record_id))
                .is_some_and(|entry| entry.hash == hash);
            local.insert(path, ((!unchanged).then_some(document), hash));
        }
        let mut untracked = local
            .keys()
            .filter(|path| !managed_paths.contains_key(*path))
            .cloned()
            .collect::<BTreeSet<_>>();
        let mut missing = state
            .records
            .iter()
            .filter(|(_, entry)| !local.contains_key(&entry.path))
            .map(|(record_id, _)| *record_id)
            .collect::<BTreeSet<_>>();
        let mut queued = Vec::new();
        let mut predecessors = HashMap::<Uuid, Uuid>::new();

        for record_id in missing.clone() {
            if state.conflicts.contains_key(&record_id) {
                missing.remove(&record_id);
                continue;
            }
            let entry = &state.records[&record_id];
            let candidates = untracked
                .iter()
                .filter(|path| {
                    local
                        .get(*path)
                        .is_some_and(|(_, hash)| hash == &entry.hash)
                })
                .cloned()
                .collect::<Vec<_>>();
            if candidates.len() != 1 {
                continue;
            }
            let target = &candidates[0];
            queue_mutation(
                &mut queued,
                &mut predecessors,
                self.replica_id,
                state.scope_epoch,
                SyncMutationOperation::Rename,
                record_id,
                Some(entry.revision.clone()),
                object([("path", Value::String(target.clone()))]),
                target.clone(),
                Some(local[target].1.clone()),
            );
            missing.remove(&record_id);
            untracked.remove(target);
        }

        let mut local_issues = BTreeMap::new();
        for (record_id, entry) in &state.records {
            if state.conflicts.contains_key(record_id) || missing.contains(record_id) {
                continue;
            }
            let Some((document, hash)) = local.get(&entry.path) else {
                continue;
            };
            if hash == &entry.hash {
                continue;
            }
            let Some(record) = &entry.record else {
                return Err(MirrorError::new(
                    "mirror_state_upgrade_required",
                    "Run a receive sync before editing this older writable mirror.",
                ));
            };
            let document = document.as_deref().unwrap_or_default();
            match parse_markdown(document, &entry.path) {
                Ok((frontmatter, body)) => queue_mutation(
                    &mut queued,
                    &mut predecessors,
                    self.replica_id,
                    state.scope_epoch,
                    SyncMutationOperation::Update,
                    *record_id,
                    Some(entry.revision.clone()),
                    object([
                        (
                            "patch",
                            Value::Object(frontmatter_patch(&record.frontmatter, &frontmatter)),
                        ),
                        ("body", Value::String(body)),
                    ]),
                    entry.path.clone(),
                    Some(hash.clone()),
                ),
                Err(error) if error.code == "invalid_frontmatter" => {
                    local_issues.insert(
                        entry.path.clone(),
                        StoredLocalIssue {
                            path: entry.path.clone(),
                            code: error.code,
                            message: error.message,
                            hash: hash.clone(),
                        },
                    );
                }
                Err(error) => return Err(error),
            }
        }

        for record_id in missing {
            if state.conflicts.contains_key(&record_id) {
                continue;
            }
            let entry = &state.records[&record_id];
            queue_mutation(
                &mut queued,
                &mut predecessors,
                self.replica_id,
                state.scope_epoch,
                SyncMutationOperation::Delete,
                record_id,
                Some(entry.revision.clone()),
                Map::new(),
                entry.path.clone(),
                None,
            );
        }

        for path in untracked {
            let (document, hash) = &local[&path];
            let document = document.as_deref().unwrap_or_default();
            match parse_markdown(document, &path) {
                Ok((frontmatter, body)) => queue_mutation(
                    &mut queued,
                    &mut predecessors,
                    self.replica_id,
                    state.scope_epoch,
                    SyncMutationOperation::Create,
                    Uuid::new_v4(),
                    None,
                    object([
                        ("path", Value::String(path.clone())),
                        ("frontmatter", Value::Object(frontmatter)),
                        ("body", Value::String(body)),
                    ]),
                    path,
                    Some(hash.clone()),
                ),
                Err(error) if error.code == "invalid_frontmatter" => {
                    local_issues.insert(
                        path.clone(),
                        StoredLocalIssue {
                            path,
                            code: error.code,
                            message: error.message,
                            hash: hash.clone(),
                        },
                    );
                }
                Err(error) => return Err(error),
            }
        }
        state.local_issues = local_issues;
        if !queued.is_empty() {
            state.pending.extend(queued);
            self.write_state(state)?;
        }
        Ok(())
    }

    pub(super) async fn flush_pending(
        &self,
        state: &mut DurableMirrorState,
    ) -> Result<(), MirrorError> {
        let mut index = 0;
        let mut mutations_since_checkpoint = 0;
        while index < state.pending.len() {
            let pending = state.pending[index].clone();
            if state.conflicts.contains_key(&pending.mutation.record_id) {
                index += 1;
                continue;
            }
            let local = self.read_file(&pending.local_path)?;
            let local_hash = local.as_deref().map(digest);
            if local_hash != pending.local_hash {
                return Err(MirrorError::new(
                    "pending_local_changed",
                    format!(
                        "Local edits at {} changed while an earlier upload was pending.",
                        pending.local_path
                    ),
                ));
            }
            let receipt = self.transport.mutate(&pending.mutation).await?;
            match &receipt {
                SyncMutationReceipt::Applied { record, .. }
                | SyncMutationReceipt::PreviouslyApplied { record, .. } => {
                    if let Some(record) = record.clone() {
                        self.put(
                            state,
                            record.clone(),
                            PutOptions {
                                accepted_hash: pending.local_hash.as_deref(),
                                preserve_accepted_document: true,
                                ..PutOptions::default()
                            },
                        )?;
                        for later in &mut state.pending {
                            if later.mutation.record_id == pending.mutation.record_id
                                && later.mutation.causal_predecessor
                                    == Some(pending.mutation.mutation_id)
                            {
                                later.mutation.base_revision = Some(record.revision.clone());
                                later.mutation.causal_predecessor = None;
                            }
                        }
                    } else {
                        state.records.remove(&pending.mutation.record_id);
                    }
                    state.pending.remove(index);
                }
                SyncMutationReceipt::Conflicted { .. } | SyncMutationReceipt::Rejected { .. } => {
                    state.conflicts.insert(pending.mutation.record_id, receipt);
                    index += 1;
                }
            }
            mutations_since_checkpoint += 1;
            if mutations_since_checkpoint >= 64 {
                self.write_state(state)?;
                mutations_since_checkpoint = 0;
            }
        }
        if mutations_since_checkpoint > 0 {
            self.write_state(state)?;
        }
        Ok(())
    }

    pub(super) fn install_remote_resolution(
        &self,
        state: &mut DurableMirrorState,
        record_id: Uuid,
        current: Option<SyncRecord>,
        pending: &[PendingMirrorMutation],
    ) -> Result<(), MirrorError> {
        let mut paths = pending
            .iter()
            .map(|pending| pending.local_path.clone())
            .collect::<BTreeSet<_>>();
        if let Some(current) = current {
            for path in &paths {
                if path != &current.path && self.read_file(path)?.is_some() {
                    self.remove_file(path)?;
                }
            }
            let accepted = self.read_file(&current.path)?.as_deref().map(digest);
            self.put(
                state,
                current,
                PutOptions {
                    accepted_hash: accepted.as_deref(),
                    ..PutOptions::default()
                },
            )
        } else {
            if let Some(entry) = state.records.get(&record_id) {
                paths.insert(entry.path.clone());
            }
            for path in paths {
                if self.read_file(&path)?.is_some() {
                    self.remove_file(&path)?;
                }
            }
            state.records.remove(&record_id);
            Ok(())
        }
    }

    pub(super) fn local_resolution_mutations(
        &self,
        state: &DurableMirrorState,
        record_id: Uuid,
        local_path: &str,
        local_document: Option<&str>,
        current: Option<&SyncRecord>,
    ) -> Result<Vec<PendingMirrorMutation>, MirrorError> {
        let mut queued = Vec::new();
        let mut predecessors = HashMap::new();
        let Some(document) = local_document else {
            if let Some(current) = current {
                queue_mutation(
                    &mut queued,
                    &mut predecessors,
                    self.replica_id,
                    state.scope_epoch,
                    SyncMutationOperation::Delete,
                    record_id,
                    Some(current.revision.clone()),
                    Map::new(),
                    local_path.to_string(),
                    None,
                );
            }
            return Ok(queued);
        };
        let (frontmatter, body) = parse_markdown(document, local_path)?;
        let local_hash = Some(digest(document));
        let Some(current) = current else {
            queue_mutation(
                &mut queued,
                &mut predecessors,
                self.replica_id,
                state.scope_epoch,
                SyncMutationOperation::Create,
                record_id,
                None,
                object([
                    ("path", Value::String(local_path.to_string())),
                    ("frontmatter", Value::Object(frontmatter)),
                    ("body", Value::String(body)),
                ]),
                local_path.to_string(),
                local_hash,
            );
            return Ok(queued);
        };
        if document != record_markdown_document(current)? {
            queue_mutation(
                &mut queued,
                &mut predecessors,
                self.replica_id,
                state.scope_epoch,
                SyncMutationOperation::Update,
                record_id,
                Some(current.revision.clone()),
                object([
                    (
                        "patch",
                        Value::Object(frontmatter_patch(&current.frontmatter, &frontmatter)),
                    ),
                    ("body", Value::String(body)),
                ]),
                local_path.to_string(),
                local_hash.clone(),
            );
        }
        if local_path != current.path {
            queue_mutation(
                &mut queued,
                &mut predecessors,
                self.replica_id,
                state.scope_epoch,
                SyncMutationOperation::Rename,
                record_id,
                Some(current.revision.clone()),
                object([("path", Value::String(local_path.to_string()))]),
                local_path.to_string(),
                local_hash,
            );
        }
        Ok(queued)
    }

    pub(super) fn assert_undiverged(&self, state: &DurableMirrorState) -> Result<(), MirrorError> {
        for entry in state.records.values().chain(state.resources.values()) {
            let value = self.read_file(&entry.path)?;
            if value.is_none_or(|value| digest(&value) != entry.hash) {
                return Err(MirrorError::new(
                    "mirror_diverged",
                    format!(
                        "Local edits at {} must be resolved before the mirror can continue.",
                        entry.path
                    ),
                ));
            }
        }
        self.assert_files_undiverged(state)
    }
}
