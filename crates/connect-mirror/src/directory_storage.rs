use super::*;

impl DirectoryMirror {
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
            if !entry.file_type().is_file()
                || entry.path().extension().and_then(|value| value.to_str()) != Some("md")
            {
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
            if !excluded.contains(&relative) {
                paths.push(relative);
            }
        }
        paths.sort();
        Ok(paths)
    }
}
