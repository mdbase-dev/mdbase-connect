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
        safe_path(&self.root, relative)?;
        let path = collection.validate_record_path(relative).map_err(|error| {
            MirrorError::new(
                "invalid_record_path",
                format!("Mirror record path '{relative}' is not allowed: {error}"),
            )
        })?;
        if path.as_str() != relative || !is_remote_mirror_record_path(relative) {
            return Err(MirrorError::new(
                "invalid_record_path",
                format!("Mirror record path '{relative}' is not canonical remote Markdown."),
            ));
        }
        Ok(())
    }

    pub(super) fn validate_record_physical_path(
        &self,
        state: &DurableMirrorState,
        identity: &str,
        relative: &str,
    ) -> Result<(), MirrorError> {
        let key = portable_mirror_path_key(relative)
            .map_err(|error| MirrorError::new("invalid_record_path", error))?;
        for entry in state.resources.values() {
            if portable_mirror_path_key(&entry.path)
                .map_err(|error| MirrorError::new("invalid_mirror_state", error))?
                == key
            {
                return Err(MirrorError::new(
                    "invalid_record_path",
                    format!("{relative} aliases authority resource {}.", entry.path),
                ));
            }
        }
        for (existing, entry) in &state.records {
            if (existing.to_string() != identity || entry.path != relative)
                && portable_mirror_path_key(&entry.path)
                    .map_err(|error| MirrorError::new("invalid_mirror_state", error))?
                    == key
            {
                return Err(MirrorError::new(
                    "invalid_record_path",
                    format!(
                        "{} and {relative} alias on a supported filesystem.",
                        entry.path
                    ),
                ));
            }
        }
        for entry in state.files.values() {
            if portable_mirror_path_key(&entry.file.path)
                .map_err(|error| MirrorError::new("invalid_mirror_state", error))?
                == key
            {
                return Err(MirrorError::new(
                    "invalid_record_path",
                    format!("{relative} aliases collection file {}.", entry.file.path),
                ));
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
        let envelope =
            serde_json::from_slice::<DurableMirrorStateEnvelope>(&value).map_err(|error| {
                MirrorError::new(
                    "invalid_mirror_state",
                    format!("Mirror state is corrupt: {error}"),
                )
            })?;
        if envelope.engine_version != MIRROR_ENGINE_VERSION {
            return Err(MirrorError::new(
                "mirror_state_upgrade_required",
                "Rebuild this prerelease mirror with the plan-only sync engine.",
            ));
        }
        let mut state = serde_json::from_slice::<DurableMirrorState>(&value).map_err(|error| {
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
        if state.batch.is_some() {
            self.replay_journal(&mut state)?;
        }
        self.validate_state(&state)?;
        Ok(Some(state))
    }

    fn journal_file(&self) -> PathBuf {
        self.state_file.with_extension("journal.ndjson")
    }

    pub(super) fn reset_journal(&self) -> Result<(), MirrorError> {
        let path = self.journal_file();
        let parent = path.parent().ok_or_else(|| {
            MirrorError::new(
                "invalid_mirror_state_path",
                "Mirror journal path is invalid.",
            )
        })?;
        fs::create_dir_all(parent)
            .map_err(|error| MirrorError::io("Could not create", parent, error))?;
        atomic_write(&path, b"")
    }

    pub(super) fn append_journal(&self, event: &DurableJournalEvent) -> Result<(), MirrorError> {
        let path = self.journal_file();
        let parent = path.parent().ok_or_else(|| {
            MirrorError::new(
                "invalid_mirror_state_path",
                "Mirror journal path is invalid.",
            )
        })?;
        fs::create_dir_all(parent)
            .map_err(|error| MirrorError::io("Could not create", parent, error))?;
        let mut bytes = serde_json::to_vec(event).map_err(MirrorError::from)?;
        bytes.push(b'\n');
        let mut file = OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .truncate(false)
            .open(&path)
            .map_err(|error| MirrorError::io("Could not open", &path, error))?;
        let length = file
            .metadata()
            .map_err(|error| MirrorError::io("Could not inspect", &path, error))?
            .len();
        if length > 0 {
            file.seek(SeekFrom::End(-1))
                .map_err(|error| MirrorError::io("Could not seek", &path, error))?;
            let mut tail = [0_u8; 1];
            file.read_exact(&mut tail)
                .map_err(|error| MirrorError::io("Could not read", &path, error))?;
            if tail[0] != b'\n' {
                let existing = fs::read(&path)
                    .map_err(|error| MirrorError::io("Could not read", &path, error))?;
                let complete = existing
                    .iter()
                    .rposition(|byte| *byte == b'\n')
                    .map(|index| index + 1)
                    .unwrap_or(0);
                file.set_len(complete as u64)
                    .map_err(|error| MirrorError::io("Could not repair", &path, error))?;
            }
        }
        file.seek(SeekFrom::End(0))
            .map_err(|error| MirrorError::io("Could not seek", &path, error))?;
        file.write_all(&bytes)
            .map_err(|error| MirrorError::io("Could not append", &path, error))?;
        file.sync_data()
            .map_err(|error| MirrorError::io("Could not sync", &path, error))
    }

    fn replay_journal(&self, state: &mut DurableMirrorState) -> Result<(), MirrorError> {
        let path = self.journal_file();
        let bytes = match fs::read(&path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(MirrorError::io("Could not read", &path, error)),
        };
        let lines = bytes.split(|byte| *byte == b'\n').collect::<Vec<_>>();
        // A complete file ends with an empty split item; an incomplete file
        // ends with a possibly torn event. Neither final item is replayable.
        let count = lines.len().saturating_sub(1);
        for line in lines.into_iter().take(count) {
            if line.is_empty() {
                continue;
            }
            let event = serde_json::from_slice::<DurableJournalEvent>(line).map_err(|error| {
                MirrorError::new(
                    "invalid_mirror_state",
                    format!("Mirror journal is corrupt: {error}"),
                )
            })?;
            apply_journal_event(state, event)?;
        }
        Ok(())
    }

    fn validate_state(&self, state: &DurableMirrorState) -> Result<(), MirrorError> {
        let mut paths = BTreeSet::new();
        for (identity, entry) in &state.records {
            safe_path(&self.root, &entry.path)?;
            if !is_remote_mirror_record_path(&entry.path) {
                return Err(MirrorError::new(
                    "invalid_mirror_state",
                    "Stored record path is not canonical Markdown.",
                ));
            }
            if entry
                .record
                .as_ref()
                .is_some_and(|record| record.record_id != *identity || record.path != entry.path)
            {
                return Err(MirrorError::new(
                    "invalid_mirror_state",
                    "Stored record identity/path is inconsistent.",
                ));
            }
            if !paths.insert(
                portable_mirror_path_key(&entry.path)
                    .map_err(|error| MirrorError::new("invalid_mirror_state", error))?,
            ) {
                return Err(MirrorError::new(
                    "invalid_mirror_state",
                    "Stored mirror paths alias.",
                ));
            }
        }
        for entry in state.resources.values() {
            validate_portable_mirror_path(&entry.path)
                .map_err(|error| MirrorError::new("invalid_mirror_state", error))?;
            if !paths.insert(
                portable_mirror_path_key(&entry.path)
                    .map_err(|error| MirrorError::new("invalid_mirror_state", error))?,
            ) {
                return Err(MirrorError::new(
                    "invalid_mirror_state",
                    "Stored mirror paths alias.",
                ));
            }
        }
        for entry in state.files.values() {
            self.validate_file_descriptor(&entry.file)?;
            if !paths.insert(
                portable_mirror_path_key(&entry.file.path)
                    .map_err(|error| MirrorError::new("invalid_mirror_state", error))?,
            ) {
                return Err(MirrorError::new(
                    "invalid_mirror_state",
                    "Stored mirror paths alias.",
                ));
            }
        }
        for (identity, conflict) in &state.planned_conflicts {
            Uuid::parse_str(identity).map_err(|_| {
                MirrorError::new(
                    "invalid_mirror_state",
                    "Stored conflict identity is not a UUID.",
                )
            })?;
            if conflict.entity == SyncObjectKind::Resource {
                return Err(MirrorError::new(
                    "invalid_mirror_state",
                    "Authority resources cannot have writable conflicts.",
                ));
            }
            for expected in [&conflict.local, &conflict.remote] {
                if let Some(object) = expected.exact() {
                    if object.identity != *identity || object.entity != conflict.entity {
                        return Err(MirrorError::new(
                            "invalid_mirror_state",
                            "Stored conflict identity or entity is inconsistent.",
                        ));
                    }
                }
            }
        }
        Ok(())
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
        atomic_write(&safe_path(&self.root, relative)?, value)
    }

    pub(super) fn remove_file(&self, relative: &str) -> Result<(), MirrorError> {
        let path = safe_path(&self.root, relative)?;
        match fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(MirrorError::io("Could not remove", &path, error)),
        }
    }

    pub(super) fn move_file(&self, source: &str, target: &str) -> Result<(), MirrorError> {
        let source = safe_path(&self.root, source)?;
        let target = safe_path(&self.root, target)?;
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| MirrorError::io("Could not create", parent, error))?;
        }
        fs::rename(&source, &target)
            .map_err(|error| MirrorError::io("Could not move", &source, error))
    }

    pub(super) fn list_markdown(
        &self,
        excluded: &HashSet<String>,
    ) -> Result<Vec<String>, MirrorError> {
        let collection = mdbase::Collection::open(&self.root).map_err(|error| {
            MirrorError::new(
                "invalid_record_path",
                format!("Mirror collection could not be opened safely: {error}"),
            )
        })?;
        self.list_markdown_with(excluded, &collection)
    }

    pub(super) fn list_markdown_with(
        &self,
        excluded: &HashSet<String>,
        collection: &mdbase::Collection,
    ) -> Result<Vec<String>, MirrorError> {
        let mut paths = Vec::new();
        for entry in WalkDir::new(&self.root)
            .follow_links(false)
            .into_iter()
            .filter_entry(|entry| {
                entry.depth() == 0
                    || (!entry.file_type().is_symlink()
                        && !matches!(
                            entry.file_name().to_string_lossy().as_ref(),
                            ".git" | ".mdbase" | "node_modules"
                        ))
            })
        {
            let entry = entry
                .map_err(|error| MirrorError::new("mirror_inspection_failed", error.to_string()))?;
            if !entry.file_type().is_file() {
                continue;
            }
            let relative = entry
                .path()
                .strip_prefix(&self.root)
                .map_err(|_| {
                    MirrorError::new("mirror_path_escape", "Mirror scan escaped its root.")
                })?
                .to_string_lossy()
                .replace('\\', "/");
            if !excluded.contains(&relative)
                && self
                    .validate_record_path_with(collection, &relative)
                    .is_ok()
            {
                paths.push(relative);
            }
        }
        paths.sort();
        Ok(paths)
    }

    pub(super) fn list_binary_files(&self) -> Result<Vec<String>, MirrorError> {
        let mut paths = Vec::new();
        for entry in WalkDir::new(&self.root).follow_links(false) {
            let entry = entry
                .map_err(|error| MirrorError::new("mirror_inspection_failed", error.to_string()))?;
            if !entry.file_type().is_file() {
                continue;
            }
            let relative = entry.path().strip_prefix(&self.root).map_err(|_| {
                MirrorError::new("invalid_mirror_path", "File escaped mirror root.")
            })?;
            let relative = relative.to_string_lossy().replace('\\', "/");
            if relative.ends_with(".md")
                || relative.split('/').any(|part| {
                    part.starts_with('.')
                        || matches!(
                            part,
                            "node_modules" | "_types" | "_schemas" | "_contracts" | "_views"
                        )
                })
            {
                continue;
            }
            if validate_visible_file_path(&relative, false).is_ok() {
                paths.push(relative);
            }
        }
        paths.sort();
        Ok(paths)
    }
}

fn apply_journal_event(
    state: &mut DurableMirrorState,
    event: DurableJournalEvent,
) -> Result<(), MirrorError> {
    let batch = state.batch.as_mut().ok_or_else(|| {
        MirrorError::new("invalid_mirror_state", "Journal has no prepared batch.")
    })?;
    match event {
        DurableJournalEvent::Phase {
            plan_fingerprint,
            phase,
            failure,
        } => {
            if plan_fingerprint != batch.plan.fingerprint {
                return Err(MirrorError::new(
                    "invalid_mirror_state",
                    "Journal belongs to another plan.",
                ));
            }
            batch.phase = phase;
            batch.failure = failure;
        }
        DurableJournalEvent::Receipt {
            plan_fingerprint,
            receipt,
            delta,
        } => {
            if plan_fingerprint != batch.plan.fingerprint
                || batch
                    .plan
                    .actions
                    .get(batch.next_action)
                    .map(SyncAction::action_id)
                    != Some(receipt.action_id.as_str())
            {
                return Err(MirrorError::new(
                    "invalid_mirror_state",
                    "Journal receipt is out of sequence.",
                ));
            }
            apply_state_delta(state, *delta)?;
            let batch = state.batch.as_mut().expect("checked");
            batch.receipts.push(*receipt);
            batch.next_action += 1;
        }
    }
    Ok(())
}

fn apply_state_delta(
    state: &mut DurableMirrorState,
    delta: DurableStateDelta,
) -> Result<(), MirrorError> {
    let state_uuid = || {
        Uuid::parse_str(&delta.state_identity)
            .map_err(|_| MirrorError::new("invalid_mirror_state", "Journal identity is invalid."))
    };
    match delta.record {
        EntryDelta::Unchanged => {}
        EntryDelta::Put { value } => {
            state.records.insert(state_uuid()?, value);
        }
        EntryDelta::Remove => {
            state.records.remove(&state_uuid()?);
        }
    }
    match delta.resource {
        EntryDelta::Unchanged => {}
        EntryDelta::Put { value } => {
            state.resources.insert(delta.identity.clone(), value);
        }
        EntryDelta::Remove => {
            state.resources.remove(&delta.identity);
        }
    }
    match delta.file {
        EntryDelta::Unchanged => {}
        EntryDelta::Put { value } => {
            state.files.insert(state_uuid()?, value);
        }
        EntryDelta::Remove => {
            state.files.remove(&state_uuid()?);
        }
    }
    apply_entry_delta(
        &mut state.planned_conflicts,
        &delta.identity,
        delta.conflict,
    );
    apply_entry_delta(&mut state.local_bindings, &delta.identity, delta.binding);
    Ok(())
}

fn apply_entry_delta<T>(target: &mut BTreeMap<String, T>, key: &str, delta: EntryDelta<T>) {
    match delta {
        EntryDelta::Unchanged => {}
        EntryDelta::Put { value } => {
            target.insert(key.into(), value);
        }
        EntryDelta::Remove => {
            target.remove(key);
        }
    }
}
