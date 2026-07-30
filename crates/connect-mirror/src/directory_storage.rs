use super::*;

impl DirectoryMirror {
    pub(super) fn validate_record_path(&self, relative: &str) -> Result<(), MirrorError> {
        safe_path(&self.root, relative)?;
        let collection = mdbase::Collection::open(&self.root).map_err(|error| {
            MirrorError::new(
                "invalid_record_path",
                format!("Mirror collection could not be opened safely: {error}"),
            )
        })?;
        self.validate_record_path_with(&collection, relative)
    }

    pub(super) fn validate_record_path_with(
        &self,
        collection: &mdbase::Collection,
        relative: &str,
    ) -> Result<(), MirrorError> {
        let path = collection.validate_record_path(relative).map_err(|error| {
            MirrorError::new(
                "invalid_record_path",
                format!("Mirror record path '{relative}' is not allowed: {error}"),
            )
        })?;
        if path.as_str() != relative {
            return Err(MirrorError::new(
                "invalid_record_path",
                format!("Mirror record path '{relative}' is not canonical."),
            ));
        }
        if !is_remote_mirror_record_path(relative) {
            return Err(MirrorError::new(
                "invalid_record_path",
                format!(
                    "Mirror record path '{relative}' is not safe for remote materialization; mirrors accept only .md records."
                ),
            ));
        }
        Ok(())
    }

    pub(super) fn validate_record_physical_path(
        &self,
        state: &DurableMirrorState,
        record_id: Uuid,
        relative: &str,
    ) -> Result<(), MirrorError> {
        let physical_path = portable_mirror_path_key(relative).map_err(|error| {
            MirrorError::new(
                "invalid_record_path",
                format!("Mirror record path '{relative}' is unsafe: {error}"),
            )
        })?;
        for entry in state.resources.values() {
            if portable_mirror_path_key(&entry.path)
                .map_err(|error| MirrorError::new("invalid_mirror_state", error))?
                == physical_path
            {
                return Err(MirrorError::new(
                    "invalid_record_path",
                    format!(
                        "Mirror record path {relative} aliases authority resource {} on a supported filesystem.",
                        entry.path
                    ),
                ));
            }
        }
        for (existing_id, entry) in &state.records {
            if (*existing_id != record_id || entry.path != relative)
                && portable_mirror_path_key(&entry.path)
                    .map_err(|error| MirrorError::new("invalid_mirror_state", error))?
                    == physical_path
            {
                return Err(MirrorError::new(
                    "invalid_record_path",
                    format!(
                        "Mirror record paths {} and {relative} alias on a supported filesystem.",
                        entry.path
                    ),
                ));
            }
        }
        Ok(())
    }

    pub(super) fn preflight_change_physical_paths(
        &self,
        state: &DurableMirrorState,
        events: &[SyncChange],
    ) -> Result<(), MirrorError> {
        let mut deferred_record_ids = state.conflicts.keys().copied().collect::<HashSet<_>>();
        if !state.local_issues.is_empty() {
            for (record_id, entry) in &state.records {
                if state.local_issues.contains_key(&entry.path) {
                    deferred_record_ids.insert(*record_id);
                }
            }
        }
        for event in events {
            if let SyncChange::Put { record, .. } = event {
                self.validate_record_path(&record.path)?;
            }
        }
        let mut physical_paths = HashMap::<String, (String, Option<Uuid>)>::new();
        let mut record_paths = HashMap::<Uuid, String>::new();
        for path in state.resources.keys() {
            physical_paths.insert(
                portable_mirror_path_key(path)
                    .map_err(|error| MirrorError::new("invalid_mirror_state", error))?,
                (path.clone(), None),
            );
        }
        for (record_id, entry) in &state.records {
            physical_paths.insert(
                portable_mirror_path_key(&entry.path)
                    .map_err(|error| MirrorError::new("invalid_mirror_state", error))?,
                (entry.path.clone(), Some(*record_id)),
            );
            record_paths.insert(*record_id, entry.path.clone());
        }
        for event in events {
            let record_id = match event {
                SyncChange::Put { record, .. } => record.record_id,
                SyncChange::Remove { record_id, .. } => *record_id,
            };
            if deferred_record_ids.contains(&record_id) {
                continue;
            }
            match event {
                SyncChange::Remove { record_id, .. } => {
                    if let Some(prior) = record_paths.remove(record_id) {
                        let physical_path = portable_mirror_path_key(&prior)
                            .map_err(|error| MirrorError::new("invalid_mirror_state", error))?;
                        physical_paths.remove(&physical_path);
                    }
                }
                SyncChange::Put { record, .. } => {
                    let physical_path =
                        portable_mirror_path_key(&record.path).map_err(|error| {
                            MirrorError::new(
                                "invalid_record_path",
                                format!("Mirror record path '{}' is unsafe: {error}", record.path),
                            )
                        })?;
                    if let Some((occupied_path, occupied_id)) = physical_paths.get(&physical_path) {
                        if *occupied_id != Some(record.record_id) || occupied_path != &record.path {
                            return Err(MirrorError::new(
                                "invalid_record_path",
                                format!(
                                    "Mirror paths {occupied_path} and {} alias on a supported filesystem.",
                                    record.path
                                ),
                            ));
                        }
                    }
                    if let Some(prior) = record_paths.get(&record.record_id) {
                        let prior_physical = portable_mirror_path_key(prior)
                            .map_err(|error| MirrorError::new("invalid_mirror_state", error))?;
                        physical_paths.remove(&prior_physical);
                    }
                    physical_paths
                        .insert(physical_path, (record.path.clone(), Some(record.record_id)));
                    record_paths.insert(record.record_id, record.path.clone());
                }
            }
        }
        Ok(())
    }

    pub(super) fn read_state(&self) -> Result<Option<DurableMirrorState>, MirrorError> {
        let value = match fs::read(&self.state_file) {
            Ok(value) => value,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(MirrorError::io("Could not read", &self.state_file, error)),
        };
        let state = serde_json::from_slice::<DurableMirrorState>(&value).map_err(|error| {
            MirrorError::new(
                "invalid_mirror_state",
                format!("Mirror state is corrupt: {error}"),
            )
        })?;
        if state.protocol_version != SYNC_PROTOCOL_VERSION
            || state.replica_id != self.replica_id
            || state.mode != self.mode
        {
            return Err(MirrorError::new(
                "invalid_mirror_state",
                "Mirror state belongs to another protocol, replica, or mode.",
            ));
        }
        self.validate_state_shape(&state)?;
        Ok(Some(state))
    }

    pub(super) fn read_rebuild_plan(&self) -> Result<Option<DurableRebuildPlan>, MirrorError> {
        let path = self.rebuild_plan_file();
        let value = match fs::read(&path) {
            Ok(value) => value,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(MirrorError::io("Could not read", &path, error)),
        };
        let plan = serde_json::from_slice::<DurableRebuildPlan>(&value).map_err(|error| {
            MirrorError::new(
                "invalid_mirror_state",
                format!("Mirror rebuild plan is corrupt: {error}"),
            )
        })?;
        self.validate_rebuild_plan(&plan)?;
        Ok(Some(plan))
    }

    pub(super) fn validate_rebuild_plan(
        &self,
        plan: &DurableRebuildPlan,
    ) -> Result<(), MirrorError> {
        if plan.protocol_version != SYNC_PROTOCOL_VERSION
            || plan.replica_id != self.replica_id
            || plan.mode != self.mode
            || plan.session.protocol_version != SYNC_PROTOCOL_VERSION
            || plan.session.replica_id != self.replica_id
            || plan.session.mode != self.mode
        {
            return Err(MirrorError::new(
                "invalid_mirror_state",
                "Mirror rebuild plan belongs to another protocol, replica, or mode.",
            ));
        }
        if let Some(prior) = &plan.prior {
            if prior.protocol_version != SYNC_PROTOCOL_VERSION
                || prior.replica_id != self.replica_id
                || prior.mode != self.mode
            {
                return Err(MirrorError::new(
                    "invalid_mirror_state",
                    "Mirror rebuild plan contains state for another replica or mode.",
                ));
            }
            self.validate_state_shape(prior)?;
        }
        Ok(())
    }

    pub(super) fn write_rebuild_plan(&self, plan: &DurableRebuildPlan) -> Result<(), MirrorError> {
        let path = self.rebuild_plan_file();
        atomic_write(
            &path,
            &serde_json::to_vec_pretty(plan).map_err(MirrorError::from)?,
        )
    }

    pub(super) fn clear_rebuild_plan(&self) -> Result<(), MirrorError> {
        let path = self.rebuild_plan_file();
        match fs::remove_file(&path) {
            Ok(()) => {
                if let Some(parent) = path.parent() {
                    if let Ok(directory) = File::open(parent) {
                        let _ = directory.sync_all();
                    }
                }
                Ok(())
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(MirrorError::io("Could not clear", &path, error)),
        }
    }

    pub(super) fn rebuild_plan_file(&self) -> PathBuf {
        self.state_file.with_extension("rebuild.json")
    }

    pub(super) fn write_state(&self, state: &DurableMirrorState) -> Result<(), MirrorError> {
        let parent = self.state_file.parent().ok_or_else(|| {
            MirrorError::new("invalid_mirror_state_path", "Mirror state path is invalid.")
        })?;
        fs::create_dir_all(parent)
            .map_err(|error| MirrorError::io("Could not create", parent, error))?;
        atomic_write(
            &self.state_file,
            &serde_json::to_vec_pretty(state).map_err(MirrorError::from)?,
        )
    }

    pub(super) fn read_file(&self, relative: &str) -> Result<Option<String>, MirrorError> {
        let path = safe_path(&self.root, relative)?;
        match fs::read_to_string(&path) {
            Ok(value) => Ok(Some(value)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(MirrorError::io("Could not read", &path, error)),
        }
    }

    pub(super) fn write_file(&self, relative: &str, value: &[u8]) -> Result<(), MirrorError> {
        let path = safe_path(&self.root, relative)?;
        atomic_write(&path, value)
    }

    pub(super) fn remove_file(&self, relative: &str) -> Result<(), MirrorError> {
        let path = safe_path(&self.root, relative)?;
        match fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(MirrorError::io("Could not remove", &path, error)),
        }
    }

    pub(super) fn list_markdown(
        &self,
        excluded: &HashSet<String>,
    ) -> Result<Vec<String>, MirrorError> {
        let collection = mdbase::Collection::open(&self.root).map_err(|error| {
            MirrorError::new(
                "invalid_mirror_collection",
                format!("Mirror collection could not be opened safely: {error}"),
            )
        })?;
        let mut paths = Vec::new();
        for entry in WalkDir::new(&self.root)
            .follow_links(false)
            .into_iter()
            .filter_entry(|entry| {
                if entry.depth() == 0 {
                    return true;
                }
                if entry.file_type().is_symlink() {
                    return false;
                }
                !matches!(
                    entry.file_name().to_string_lossy().as_ref(),
                    ".git" | ".mdbase" | "node_modules"
                )
            })
        {
            let entry = entry.map_err(|error| {
                MirrorError::new(
                    "mirror_io_failed",
                    format!("Could not scan mirror: {error}"),
                )
            })?;
            if !entry.file_type().is_file() {
                continue;
            }
            let relative = entry
                .path()
                .strip_prefix(&self.root)
                .map_err(|_| {
                    MirrorError::new(
                        "mirror_path_escape",
                        "Mirror scan escaped its configured directory.",
                    )
                })?
                .to_string_lossy()
                .replace('\\', "/");
            if !excluded.contains(&relative)
                && self
                    .validate_record_path_with(&collection, &relative)
                    .is_ok()
            {
                paths.push(relative);
            }
        }
        paths.sort();
        Ok(paths)
    }
}
