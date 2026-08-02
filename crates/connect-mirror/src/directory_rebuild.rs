use super::*;

impl DirectoryMirror {
    pub(super) async fn rebuild(
        &self,
        prior: Option<DurableMirrorState>,
    ) -> Result<(), MirrorError> {
        let session = self.transport.open_session().await?;
        if session.protocol_version != SYNC_PROTOCOL_VERSION
            || session.replica_id != self.replica_id
            || session.mode != self.mode
        {
            return Err(MirrorError::new(
                "invalid_mirror_session",
                "Hosted authority returned a session for a different replica or mode.",
            ));
        }
        let mut records = Vec::new();
        let mut page = None::<String>;
        let mut seen_pages = HashSet::<String>::new();
        loop {
            let snapshot = self
                .transport
                .snapshot(session.snapshot_id, page.as_deref())
                .await?;
            if snapshot.protocol_version != SYNC_PROTOCOL_VERSION
                || snapshot.scope_epoch != session.scope_epoch
                || snapshot.cursor != session.head
                || snapshot.snapshot_id != session.snapshot_id
            {
                return Err(MirrorError::new(
                    "invalid_snapshot",
                    "Hosted snapshot boundary changed during download.",
                ));
            }
            records.extend(
                snapshot
                    .records
                    .into_iter()
                    .filter(|snapshot| self.path_selected(&snapshot.record.path)),
            );
            page = snapshot.next_page;
            if page
                .as_ref()
                .is_some_and(|page| !seen_pages.insert(page.clone()))
            {
                return Err(MirrorError::new(
                    "invalid_snapshot",
                    "Hosted snapshot repeated a page cursor.",
                ));
            }
            if page.is_none() {
                break;
            }
        }
        let mut files = Vec::new();
        let mut file_page = None::<String>;
        let mut seen_file_pages = HashSet::<String>::new();
        loop {
            let snapshot = self
                .transport
                .file_snapshot(session.snapshot_id, file_page.as_deref())
                .await?;
            if snapshot.protocol_version != SYNC_PROTOCOL_VERSION
                || snapshot.message_type != SyncFileSnapshotPageKind::FileSnapshotPage
                || snapshot.scope_epoch != session.scope_epoch
                || snapshot.cursor != session.head
                || snapshot.snapshot_id != session.snapshot_id
            {
                return Err(MirrorError::new(
                    "invalid_snapshot",
                    "Hosted file snapshot boundary changed during download.",
                ));
            }
            files.extend(
                snapshot
                    .files
                    .into_iter()
                    .filter(|file| self.file_selected(file)),
            );
            file_page = snapshot.next_page;
            if file_page
                .as_ref()
                .is_some_and(|page| !seen_file_pages.insert(page.clone()))
            {
                return Err(MirrorError::new(
                    "invalid_snapshot",
                    "Hosted file snapshot repeated a page cursor.",
                ));
            }
            if file_page.is_none() {
                break;
            }
        }
        self.validate_snapshot_shape(&session.resources, &records, &files)?;
        self.preflight_rebuild(&session.resources, &records, &files, prior.as_ref())?;
        self.validate_snapshot_documents(&session.resources, &records)?;
        for file in &files {
            self.ensure_file_blob(file).await?;
        }
        let plan = DurableRebuildPlan {
            protocol_version: SYNC_PROTOCOL_VERSION,
            replica_id: self.replica_id,
            mode: self.mode,
            session,
            records,
            files,
            sync_policy: self.sync_policy.clone(),
            prior,
        };
        self.write_rebuild_plan(&plan)?;
        self.apply_rebuild(plan)
    }

    pub(super) fn apply_rebuild(&self, plan: DurableRebuildPlan) -> Result<(), MirrorError> {
        self.validate_rebuild_plan(&plan)?;
        self.validate_snapshot_shape(&plan.session.resources, &plan.records, &plan.files)?;
        self.validate_snapshot_documents(&plan.session.resources, &plan.records)?;
        self.preflight_rebuild(
            &plan.session.resources,
            &plan.records,
            &plan.files,
            plan.prior.as_ref(),
        )?;
        let target_paths = self.target_paths(&plan.session.resources, &plan.records, &plan.files);
        let mut state = DurableMirrorState {
            protocol_version: SYNC_PROTOCOL_VERSION,
            replica_id: self.replica_id,
            scope_epoch: plan.session.scope_epoch,
            cursor: plan.session.head,
            records: BTreeMap::new(),
            resources: BTreeMap::new(),
            files: BTreeMap::new(),
            sync_policy: self.sync_policy.clone(),
            mode: self.mode,
            pending: Vec::new(),
            conflicts: BTreeMap::new(),
            local_issues: BTreeMap::new(),
            last_synced_at: None,
        };
        for resource in &plan.session.resources.documents {
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
        }
        for snapshot in &plan.records {
            let record = &snapshot.record;
            self.write_file(&record.path, snapshot.document.as_bytes())?;
            state.records.insert(
                record.record_id,
                MirrorEntry {
                    path: record.path.clone(),
                    revision: record.revision.clone(),
                    hash: digest(&snapshot.document),
                    record: (self.mode == SyncReplicaMode::ReadWrite).then_some(record.clone()),
                },
            );
        }
        for file in &plan.files {
            self.install_file_blob(file)?;
            state
                .files
                .insert(file.file_id, MirrorFileEntry { file: file.clone() });
        }
        if let Some(prior) = plan.prior {
            let mut stale_paths = BTreeSet::new();
            for entry in prior.records.values().chain(prior.resources.values()) {
                if !target_paths.contains(&entry.path) {
                    stale_paths.insert(entry.path.clone());
                }
            }
            for entry in prior.files.values() {
                if !target_paths.contains(&entry.file.path) {
                    stale_paths.insert(entry.file.path.clone());
                }
            }
            for path in stale_paths {
                self.remove_file(&path)?;
            }
        }
        state.last_synced_at = Some(now());
        self.write_state(&state)?;
        self.clear_rebuild_plan()
    }

    pub(super) fn prior_managed_paths<'a>(
        &self,
        prior: Option<&'a DurableMirrorState>,
    ) -> Result<HashMap<String, &'a MirrorEntry>, MirrorError> {
        let mut paths = HashMap::new();
        for entry in prior
            .into_iter()
            .flat_map(|state| state.records.values().chain(state.resources.values()))
        {
            paths.insert(
                portable_mirror_path_key(&entry.path)
                    .map_err(|error| MirrorError::new("invalid_mirror_state", error))?,
                entry,
            );
        }
        Ok(paths)
    }

    pub(super) fn prior_managed_file_paths<'a>(
        &self,
        prior: Option<&'a DurableMirrorState>,
    ) -> Result<HashMap<String, &'a MirrorFileEntry>, MirrorError> {
        let mut paths = HashMap::new();
        for entry in prior.into_iter().flat_map(|state| state.files.values()) {
            paths.insert(
                portable_mirror_path_key(&entry.file.path)
                    .map_err(|error| MirrorError::new("invalid_mirror_state", error))?,
                entry,
            );
        }
        Ok(paths)
    }

    pub(super) fn target_paths(
        &self,
        resources: &SyncCollectionResources,
        records: &[SyncSnapshotRecord],
        files: &[CollectionFileDescriptor],
    ) -> HashSet<String> {
        resources
            .documents
            .iter()
            .map(|resource| resource.path.clone())
            .chain(records.iter().map(|snapshot| snapshot.record.path.clone()))
            .chain(files.iter().map(|file| file.path.clone()))
            .collect()
    }

    pub(super) fn validate_snapshot_shape(
        &self,
        resources: &SyncCollectionResources,
        records: &[SyncSnapshotRecord],
        files: &[CollectionFileDescriptor],
    ) -> Result<(), MirrorError> {
        let mut paths = HashSet::<String>::new();
        let mut physical_paths = HashMap::<String, String>::new();
        for resource in &resources.documents {
            safe_path(&self.root, &resource.path)?;
            validate_portable_mirror_path(&resource.path).map_err(|error| {
                MirrorError::new(
                    "invalid_snapshot",
                    format!("Hosted resource path {} is unsafe: {error}", resource.path),
                )
            })?;
            let physical_path = portable_mirror_path_key(&resource.path).map_err(|error| {
                MirrorError::new(
                    "invalid_snapshot",
                    format!("Hosted resource path {} is unsafe: {error}", resource.path),
                )
            })?;
            if let Some(existing) = physical_paths.insert(physical_path, resource.path.clone()) {
                return Err(MirrorError::new(
                    "invalid_snapshot",
                    format!(
                        "Hosted snapshot paths {existing} and {} alias on a supported filesystem.",
                        resource.path
                    ),
                ));
            }
            if !paths.insert(resource.path.clone()) {
                return Err(MirrorError::new(
                    "invalid_snapshot",
                    format!("Hosted snapshot repeats the path {}.", resource.path),
                ));
            }
        }
        let mut record_ids = HashSet::new();
        for snapshot in records {
            let record = &snapshot.record;
            safe_path(&self.root, &record.path)?;
            validate_portable_mirror_path(&record.path).map_err(|error| {
                MirrorError::new(
                    "invalid_snapshot",
                    format!("Hosted record path {} is unsafe: {error}", record.path),
                )
            })?;
            let physical_path = portable_mirror_path_key(&record.path).map_err(|error| {
                MirrorError::new(
                    "invalid_snapshot",
                    format!("Hosted record path {} is unsafe: {error}", record.path),
                )
            })?;
            if let Some(existing) = physical_paths.insert(physical_path, record.path.clone()) {
                return Err(MirrorError::new(
                    "invalid_snapshot",
                    format!(
                        "Hosted snapshot paths {existing} and {} alias on a supported filesystem.",
                        record.path
                    ),
                ));
            }
            if !record_ids.insert(record.record_id) || !paths.insert(record.path.clone()) {
                return Err(MirrorError::new(
                    "invalid_snapshot",
                    format!(
                        "Hosted snapshot repeats record identity or path {}.",
                        record.path
                    ),
                ));
            }
        }
        let mut file_ids = HashSet::new();
        for file in files {
            self.validate_file_descriptor(file)?;
            let physical_path = portable_mirror_path_key(&file.path).map_err(|error| {
                MirrorError::new(
                    "invalid_snapshot",
                    format!("Hosted file path {} is unsafe: {error}", file.path),
                )
            })?;
            if let Some(existing) = physical_paths.insert(physical_path, file.path.clone()) {
                return Err(MirrorError::new(
                    "invalid_snapshot",
                    format!(
                        "Hosted snapshot paths {existing} and {} alias on a supported filesystem.",
                        file.path
                    ),
                ));
            }
            if !file_ids.insert(file.file_id) || !paths.insert(file.path.clone()) {
                return Err(MirrorError::new(
                    "invalid_snapshot",
                    format!(
                        "Hosted snapshot repeats file identity or path {}.",
                        file.path
                    ),
                ));
            }
        }
        Ok(())
    }

    fn validate_snapshot_documents(
        &self,
        resources: &SyncCollectionResources,
        records: &[SyncSnapshotRecord],
    ) -> Result<(), MirrorError> {
        let staging = tempfile::tempdir().map_err(|error| {
            MirrorError::new(
                "invalid_snapshot",
                format!("Could not stage hosted collection resources: {error}"),
            )
        })?;
        for resource in &resources.documents {
            let path = safe_path(staging.path(), &resource.path)?;
            atomic_write(&path, resource.document.as_bytes())?;
        }
        let collection = mdbase::Collection::open(staging.path()).map_err(|error| {
            MirrorError::new(
                "invalid_snapshot",
                format!("Hosted resources do not form a valid collection: {error}"),
            )
        })?;
        let canonical = collection.snapshot().map_err(|error| {
            MirrorError::new(
                "invalid_snapshot",
                format!("Hosted resources could not be canonicalized: {error}"),
            )
        })?;
        if canonical.spec_version != resources.spec_version {
            return Err(MirrorError::new(
                "invalid_snapshot",
                "Hosted resources do not match their declared specification version.",
            ));
        }
        let declared = resources
            .documents
            .iter()
            .map(|resource| (resource.path.as_str(), resource))
            .collect::<BTreeMap<_, _>>();
        if declared.len() != canonical.resources.len() {
            return Err(MirrorError::new(
                "invalid_snapshot",
                format!(
                    "Hosted snapshot declares {} resources, but canonicalization found {}.",
                    declared.len(),
                    canonical.resources.len()
                ),
            ));
        }
        for resource in &canonical.resources {
            let Some(candidate) = declared.get(resource.path.as_str()) else {
                return Err(MirrorError::new(
                    "invalid_snapshot",
                    format!("Hosted resource {} is not canonical.", resource.path),
                ));
            };
            let mismatch = if candidate.kind != resource_kind(resource.kind) {
                "kind"
            } else if candidate.revision != resource.revision {
                "revision"
            } else if candidate.document != resource.document {
                "document"
            } else {
                continue;
            };
            return Err(MirrorError::new(
                "invalid_snapshot",
                format!(
                    "Hosted resource {} has a noncanonical {mismatch}.",
                    resource.path
                ),
            ));
        }

        for snapshot in records {
            let record = &snapshot.record;
            self.validate_record_path_with(&collection, &record.path)?;
            if format!("sha256:{}", digest(&snapshot.document)) != record.revision {
                return Err(MirrorError::new(
                    "invalid_snapshot",
                    format!(
                        "Hosted record {} does not match its declared revision.",
                        record.path
                    ),
                ));
            }
            let (frontmatter, body) = parse_markdown(&snapshot.document, &record.path)?;
            let body_matches = body == record.body
                || body.strip_prefix('\n') == Some(record.body.as_str())
                || record.body.strip_prefix('\n') == Some(body.as_str());
            if frontmatter != record.frontmatter || !body_matches {
                return Err(MirrorError::new(
                    "invalid_snapshot",
                    format!(
                        "Hosted record {} does not match its declared document.",
                        record.path
                    ),
                ));
            }
        }
        Ok(())
    }

    pub(super) fn preflight_rebuild(
        &self,
        resources: &SyncCollectionResources,
        records: &[SyncSnapshotRecord],
        files: &[CollectionFileDescriptor],
        prior: Option<&DurableMirrorState>,
    ) -> Result<(), MirrorError> {
        let prior_paths = self.prior_managed_paths(prior)?;
        let prior_file_paths = self.prior_managed_file_paths(prior)?;
        let target_paths = self.target_paths(resources, records, files);
        let mut collisions = BTreeSet::new();
        for resource in &resources.documents {
            let physical_path = portable_mirror_path_key(&resource.path)
                .map_err(|error| MirrorError::new("invalid_snapshot", error))?;
            let managed = prior_paths.get(&physical_path);
            let managed_file = prior_file_paths.get(&physical_path);
            let prior_path = managed
                .map(|entry| entry.path.as_str())
                .or_else(|| managed_file.map(|entry| entry.file.path.as_str()));
            if prior_path.is_some_and(|path| path != resource.path) {
                return Err(MirrorError::new(
                    "invalid_record_path",
                    format!(
                        "Mirror paths {} and {} alias on a supported filesystem.",
                        prior_path.unwrap(),
                        resource.path
                    ),
                ));
            }
            let expected = format!("sha256:{}", digest(&resource.document));
            let prior_digest = managed
                .map(|entry| format!("sha256:{}", entry.hash))
                .or_else(|| managed_file.map(|entry| entry.file.content_digest.clone()));
            if self
                .file_digest(&resource.path)?
                .as_deref()
                .is_some_and(|local| local != expected && prior_digest.as_deref() != Some(local))
            {
                collisions.insert(resource.path.clone());
            }
        }
        for snapshot in records {
            let record = &snapshot.record;
            let physical_path = portable_mirror_path_key(&record.path)
                .map_err(|error| MirrorError::new("invalid_snapshot", error))?;
            let managed = prior_paths.get(&physical_path);
            let managed_file = prior_file_paths.get(&physical_path);
            let prior_path = managed
                .map(|entry| entry.path.as_str())
                .or_else(|| managed_file.map(|entry| entry.file.path.as_str()));
            if prior_path.is_some_and(|path| path != record.path) {
                return Err(MirrorError::new(
                    "invalid_record_path",
                    format!(
                        "Mirror paths {} and {} alias on a supported filesystem.",
                        prior_path.unwrap(),
                        record.path
                    ),
                ));
            }
            let expected = format!("sha256:{}", digest(&snapshot.document));
            let prior_digest = managed
                .map(|entry| format!("sha256:{}", entry.hash))
                .or_else(|| managed_file.map(|entry| entry.file.content_digest.clone()));
            if self
                .file_digest(&record.path)?
                .as_deref()
                .is_some_and(|local| local != expected && prior_digest.as_deref() != Some(local))
            {
                collisions.insert(record.path.clone());
            }
        }
        for file in files {
            let physical_path = portable_mirror_path_key(&file.path)
                .map_err(|error| MirrorError::new("invalid_snapshot", error))?;
            let local = self.file_digest(&file.path)?;
            let managed = prior_file_paths.get(&physical_path);
            let managed_text = prior_paths.get(&physical_path);
            let prior_path = managed
                .map(|entry| entry.file.path.as_str())
                .or_else(|| managed_text.map(|entry| entry.path.as_str()));
            if prior_path.is_some_and(|path| path != file.path) {
                return Err(MirrorError::new(
                    "invalid_file_path",
                    format!(
                        "Mirror paths {} and {} alias on a supported filesystem.",
                        prior_path.unwrap(),
                        file.path
                    ),
                ));
            }
            let prior_digest = managed
                .map(|entry| entry.file.content_digest.clone())
                .or_else(|| managed_text.map(|entry| format!("sha256:{}", entry.hash)));
            if local.as_deref().is_some_and(|digest| {
                digest != file.content_digest && prior_digest.as_deref() != Some(digest)
            }) {
                collisions.insert(file.path.clone());
            }
        }
        if let Some(prior) = prior {
            for entry in prior.records.values().chain(prior.resources.values()) {
                if target_paths.contains(&entry.path) {
                    continue;
                }
                if self
                    .read_file(&entry.path)?
                    .is_some_and(|local| digest(&local) != entry.hash)
                {
                    collisions.insert(entry.path.clone());
                }
            }
            for entry in prior.files.values() {
                if target_paths.contains(&entry.file.path) {
                    continue;
                }
                if self
                    .file_digest(&entry.file.path)?
                    .is_some_and(|digest| digest != entry.file.content_digest)
                {
                    collisions.insert(entry.file.path.clone());
                }
            }
        }
        if collisions.is_empty() {
            Ok(())
        } else {
            Err(MirrorError::new(
                "mirror_initialization_conflict",
                format!(
                    "Existing files differ from the last synchronized projection: {}.",
                    collisions.into_iter().collect::<Vec<_>>().join(", ")
                ),
            ))
        }
    }

    pub(super) fn validate_state_shape(
        &self,
        state: &DurableMirrorState,
    ) -> Result<(), MirrorError> {
        validate_selective_sync_policy(&state.sync_policy)?;
        let mut paths = HashSet::new();
        let mut physical_paths = HashMap::<String, String>::new();
        for (record_id, entry) in &state.records {
            safe_path(&self.root, &entry.path)?;
            let physical_path = portable_mirror_path_key(&entry.path)
                .map_err(|error| MirrorError::new("invalid_mirror_state", error))?;
            if physical_paths
                .insert(physical_path, entry.path.clone())
                .is_some()
                || !paths.insert(entry.path.as_str())
                || entry.record.as_ref().is_some_and(|record| {
                    record.record_id != *record_id || record.path != entry.path
                })
            {
                return Err(MirrorError::new(
                    "invalid_mirror_state",
                    "Mirror state contains inconsistent record paths or identities.",
                ));
            }
        }
        for (path, entry) in &state.resources {
            safe_path(&self.root, &entry.path)?;
            let physical_path = portable_mirror_path_key(&entry.path)
                .map_err(|error| MirrorError::new("invalid_mirror_state", error))?;
            if path != &entry.path
                || physical_paths
                    .insert(physical_path, entry.path.clone())
                    .is_some()
                || !paths.insert(entry.path.as_str())
            {
                return Err(MirrorError::new(
                    "invalid_mirror_state",
                    "Mirror state contains inconsistent or overlapping resource paths.",
                ));
            }
        }
        for (file_id, entry) in &state.files {
            self.validate_file_descriptor(&entry.file)?;
            let physical_path = portable_mirror_path_key(&entry.file.path)
                .map_err(|error| MirrorError::new("invalid_mirror_state", error))?;
            if entry.file.file_id != *file_id
                || physical_paths
                    .insert(physical_path, entry.file.path.clone())
                    .is_some()
                || !paths.insert(entry.file.path.as_str())
            {
                return Err(MirrorError::new(
                    "invalid_mirror_state",
                    "Mirror state contains inconsistent or overlapping file paths.",
                ));
            }
        }
        for pending in &state.pending {
            safe_path(&self.root, &pending.local_path)?;
            if pending.mutation.replica_id != self.replica_id
                || pending.mutation.scope_epoch != state.scope_epoch
            {
                return Err(MirrorError::new(
                    "invalid_mirror_state",
                    "Mirror state contains a mutation for another replica or scope.",
                ));
            }
        }
        for (path, issue) in &state.local_issues {
            safe_path(&self.root, &issue.path)?;
            if path != &issue.path {
                return Err(MirrorError::new(
                    "invalid_mirror_state",
                    "Mirror state contains inconsistent local issue paths.",
                ));
            }
        }
        Ok(())
    }
}

fn resource_kind(kind: mdbase::runtime::CollectionSnapshotResourceKind) -> &'static str {
    match kind {
        mdbase::runtime::CollectionSnapshotResourceKind::Configuration => "configuration",
        mdbase::runtime::CollectionSnapshotResourceKind::Lock => "lock",
        mdbase::runtime::CollectionSnapshotResourceKind::Contract => "contract",
        mdbase::runtime::CollectionSnapshotResourceKind::Schema => "schema",
        mdbase::runtime::CollectionSnapshotResourceKind::Type => "type",
        mdbase::runtime::CollectionSnapshotResourceKind::View => "view",
    }
}
