use super::*;

impl DirectoryMirror {
    pub(super) fn put_record(
        &self,
        state: &mut DurableMirrorState,
        record: SyncRecord,
        accepted_hash: Option<&str>,
    ) -> Result<(), MirrorError> {
        // Path policy and exact-document integrity are inspection concerns. The
        // executor consumes the sealed payload and performs only safety and
        // ownership checks; it must not reopen the live collection to re-plan.
        safe_path(&self.root, &record.path)?;
        if !is_remote_mirror_record_path(&record.path) {
            return Err(MirrorError::new(
                "invalid_sync_plan",
                "Prepared record target is not canonical Markdown.",
            ));
        }
        self.validate_record_physical_path(state, &record.record_id.to_string(), &record.path)?;
        let document = record_markdown_document(&record)?;
        let existing = self.read_file(&record.path)?;
        let prior = state.records.get(&record.record_id).cloned();
        if let Some(existing) = &existing {
            if existing != &document {
                let existing_hash = digest(existing);
                let managed = prior
                    .as_ref()
                    .is_some_and(|entry| entry.path == record.path && existing_hash == entry.hash);
                if !managed && accepted_hash.is_none_or(|hash| hash != existing_hash) {
                    return Err(MirrorError::new(
                        "mirror_diverged",
                        format!("Local edits at {} need a decision.", record.path),
                    ));
                }
            }
        }
        if let Some(prior) = &prior {
            if prior.path != record.path {
                self.remove_record(state, record.record_id, &prior.path, false)?;
            }
        }
        self.write_file(&record.path, document.as_bytes())?;
        state.records.insert(
            record.record_id,
            MirrorEntry {
                path: record.path.clone(),
                revision: record.revision.clone(),
                hash: digest(&document),
                record: (self.mode == SyncReplicaMode::ReadWrite).then_some(record),
            },
        );
        Ok(())
    }

    pub(super) fn remove_record(
        &self,
        state: &mut DurableMirrorState,
        record_id: Uuid,
        path: &str,
        force: bool,
    ) -> Result<(), MirrorError> {
        let entry = state.records.get(&record_id).cloned();
        let path = entry
            .as_ref()
            .map(|entry| entry.path.as_str())
            .unwrap_or(path);
        if let Some(existing) = self.read_file(path)? {
            if !force
                && entry
                    .as_ref()
                    .is_some_and(|entry| digest(&existing) != entry.hash)
            {
                return Err(MirrorError::new(
                    "mirror_diverged",
                    format!("Local edits at {path} need a decision."),
                ));
            }
            self.remove_file(path)?;
        }
        state.records.remove(&record_id);
        Ok(())
    }

    pub(super) fn put_resource(
        &self,
        state: &mut DurableMirrorState,
        resource: &SyncResourceDocument,
    ) -> Result<(), MirrorError> {
        self.write_file(&resource.path, resource.document.as_bytes())?;
        state.resources.insert(
            resource.path.clone(),
            MirrorEntry {
                path: resource.path.clone(),
                revision: resource.revision.clone(),
                hash: digest(&resource.document),
                record: None,
            },
        );
        Ok(())
    }

    pub(super) fn put_collection_file(
        &self,
        state: &mut DurableMirrorState,
        file: &CollectionFileDescriptor,
        accepted_digest: Option<&str>,
    ) -> Result<(), MirrorError> {
        if let Some(local) = self.file_digest(&file.path)? {
            let managed = state.files.get(&file.file_id).is_some_and(|entry| {
                entry.file.path == file.path && entry.file.content_digest == local
            });
            if local != file.content_digest && !managed && accepted_digest != Some(local.as_str()) {
                return Err(MirrorError::new(
                    "mirror_diverged",
                    format!("Local edits at {} need a decision.", file.path),
                ));
            }
        }
        self.install_file_blob(file)?;
        if let Some(prior) = state.files.get(&file.file_id) {
            if prior.file.path != file.path {
                self.remove_file(&prior.file.path)?;
            }
        }
        state
            .files
            .insert(file.file_id, MirrorFileEntry { file: file.clone() });
        Ok(())
    }

    pub(super) fn remove_collection_file(
        &self,
        state: &mut DurableMirrorState,
        file_id: Uuid,
        force: bool,
    ) -> Result<(), MirrorError> {
        if let Some(entry) = state.files.get(&file_id).cloned() {
            if !force
                && self
                    .file_digest(&entry.file.path)?
                    .is_some_and(|digest| digest != entry.file.content_digest)
            {
                return Err(MirrorError::new(
                    "mirror_diverged",
                    format!("Local edits at {} need a decision.", entry.file.path),
                ));
            }
            self.remove_file(&entry.file.path)?;
            state.files.remove(&file_id);
        }
        Ok(())
    }
}
