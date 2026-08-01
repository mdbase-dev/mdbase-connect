use super::*;
use std::io::Read;

const RESERVED_FILE_DIRECTORIES: &[&str] = &[
    ".mdbase",
    ".git",
    "node_modules",
    "_contracts",
    "_schemas",
    "_types",
    "_views",
];

pub fn validate_selective_sync_policy(policy: &SelectiveSyncPolicy) -> Result<(), MirrorError> {
    let mut classes = HashSet::new();
    if policy
        .file_classes
        .iter()
        .any(|class| !classes.insert(*class))
    {
        return Err(MirrorError::new(
            "invalid_file_materialization",
            "File media classes must not be repeated.",
        ));
    }
    let mut folders = HashSet::new();
    let mut physical = HashSet::new();
    for folder in &policy.excluded_folders {
        validate_visible_file_path(folder, true)?;
        let key = portable_mirror_path_key(folder)
            .map_err(|error| MirrorError::new("invalid_file_materialization", error))?;
        if !folders.insert(folder.as_str()) || !physical.insert(key) {
            return Err(MirrorError::new(
                "invalid_file_materialization",
                "Excluded file folders must be unique on portable filesystems.",
            ));
        }
    }
    Ok(())
}

impl DirectoryMirror {
    pub(super) fn path_selected(&self, path: &str) -> bool {
        let Ok(path_key) = portable_mirror_path_key(path) else {
            return false;
        };
        !self.sync_policy.excluded_folders.iter().any(|folder| {
            let Ok(folder_key) = portable_mirror_path_key(folder) else {
                return true;
            };
            path_key == folder_key
                || path_key
                    .strip_prefix(&folder_key)
                    .is_some_and(|suffix| suffix.starts_with('/'))
        })
    }

    pub(super) fn file_selected(&self, file: &CollectionFileDescriptor) -> bool {
        self.sync_policy.includes(file.media_class) && self.path_selected(&file.path)
    }

    pub(super) fn validate_file_descriptor(
        &self,
        file: &CollectionFileDescriptor,
    ) -> Result<(), MirrorError> {
        safe_path(&self.root, &file.path)?;
        validate_visible_file_path(&file.path, false)?;
        let digest = file.content_digest.strip_prefix("sha256:").ok_or_else(|| {
            MirrorError::new(
                "invalid_snapshot",
                format!("Collection file {} has an invalid digest.", file.path),
            )
        })?;
        if digest.len() != 64
            || !digest
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            || file.revision.is_empty()
        {
            return Err(MirrorError::new(
                "invalid_snapshot",
                format!("Collection file {} has invalid metadata.", file.path),
            ));
        }
        chrono::DateTime::parse_from_rfc3339(&file.modified_at).map_err(|_| {
            MirrorError::new(
                "invalid_snapshot",
                format!("Collection file {} has an invalid timestamp.", file.path),
            )
        })?;
        Ok(())
    }

    pub(super) async fn ensure_file_blob(
        &self,
        file: &CollectionFileDescriptor,
    ) -> Result<PathBuf, MirrorError> {
        self.validate_file_descriptor(file)?;
        let cache = self.file_cache_path(file)?;
        if cache.exists() {
            if verify_file(&cache, file)? {
                return Ok(cache);
            }
            fs::remove_file(&cache).map_err(|error| {
                MirrorError::io("Could not clear corrupt cache file", &cache, error)
            })?;
        }
        let parent = cache.parent().ok_or_else(|| {
            MirrorError::new(
                "invalid_mirror_state_path",
                "Mirror file cache path is invalid.",
            )
        })?;
        fs::create_dir_all(parent)
            .map_err(|error| MirrorError::io("Could not create", parent, error))?;
        let temporary = NamedTempFile::new_in(parent)
            .map_err(|error| MirrorError::io("Could not stage file in", parent, error))?;
        self.transport.download_file(file, temporary.path()).await?;
        if !verify_file(temporary.path(), file)? {
            return Err(MirrorError::new(
                "file_integrity_failed",
                format!("Downloaded bytes for {} failed verification.", file.path),
            ));
        }
        match temporary.persist_noclobber(&cache) {
            Ok(_) => {}
            Err(error) if error.error.kind() == std::io::ErrorKind::AlreadyExists => {
                if !verify_file(&cache, file)? {
                    return Err(MirrorError::new(
                        "file_integrity_failed",
                        "A concurrent mirror download produced a different cached blob.",
                    ));
                }
            }
            Err(error) => {
                return Err(MirrorError::io(
                    "Could not persist mirror file cache",
                    &cache,
                    error.error,
                ))
            }
        }
        Ok(cache)
    }

    pub(super) fn install_file_blob(
        &self,
        file: &CollectionFileDescriptor,
    ) -> Result<(), MirrorError> {
        let source = self.file_cache_path(file)?;
        if !verify_file(&source, file)? {
            return Err(MirrorError::new(
                "file_integrity_failed",
                format!(
                    "The staged bytes for {} are unavailable or corrupt.",
                    file.path
                ),
            ));
        }
        let target = safe_path(&self.root, &file.path)?;
        atomic_copy(&source, &target)
    }

    pub(super) fn file_digest(&self, relative: &str) -> Result<Option<String>, MirrorError> {
        let path = safe_path(&self.root, relative)?;
        match sha256_file(&path) {
            Ok((_, digest)) => Ok(Some(format!("sha256:{digest}"))),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(MirrorError::io("Could not read", &path, error)),
        }
    }

    pub(super) async fn stage_file_changes(
        &self,
        events: &[SyncChange],
    ) -> Result<(), MirrorError> {
        for event in events {
            if let SyncChange::FilePut { file, .. } = event {
                if self.file_selected(file) {
                    self.ensure_file_blob(file).await?;
                }
            }
        }
        Ok(())
    }

    pub(super) fn apply_file_change(
        &self,
        state: &mut DurableMirrorState,
        event: SyncChange,
    ) -> Result<(), MirrorError> {
        match event {
            SyncChange::FilePut { file, .. } if self.file_selected(&file) => {
                self.put_materialized_file(state, file)
            }
            SyncChange::FilePut { file, .. } => self.remove_materialized_file(state, file.file_id),
            SyncChange::FileRemove { file_id, .. } => self.remove_materialized_file(state, file_id),
            _ => Err(MirrorError::new(
                "invalid_sync_response",
                "A record change was sent to the file materializer.",
            )),
        }
    }

    pub(super) fn assert_files_undiverged(
        &self,
        state: &DurableMirrorState,
    ) -> Result<(), MirrorError> {
        for entry in state.files.values() {
            if self.file_digest(&entry.file.path)?.as_deref()
                != Some(entry.file.content_digest.as_str())
            {
                return Err(MirrorError::new(
                    "mirror_diverged",
                    format!(
                        "Local edits at {} must be resolved before the mirror can continue.",
                        entry.file.path
                    ),
                ));
            }
        }
        Ok(())
    }

    fn put_materialized_file(
        &self,
        state: &mut DurableMirrorState,
        file: CollectionFileDescriptor,
    ) -> Result<(), MirrorError> {
        self.validate_file_descriptor(&file)?;
        let prior = state.files.get(&file.file_id).cloned();
        let target_digest = self.file_digest(&file.path)?;
        let target_is_prior = prior
            .as_ref()
            .is_some_and(|entry| entry.file.path == file.path);
        let prior_digest = prior
            .as_ref()
            .map(|entry| entry.file.content_digest.as_str());
        if target_digest.as_deref().is_some_and(|digest| {
            digest != file.content_digest && !(target_is_prior && Some(digest) == prior_digest)
        }) {
            return Err(MirrorError::new(
                "mirror_diverged",
                format!(
                    "Local file {} differs from the authority and was not overwritten.",
                    file.path
                ),
            ));
        }
        if let Some(prior) = &prior {
            if prior.file.path != file.path {
                let prior_local = self.file_digest(&prior.file.path)?;
                if prior_local
                    .as_deref()
                    .is_some_and(|digest| digest != prior.file.content_digest)
                {
                    return Err(MirrorError::new(
                        "mirror_diverged",
                        format!(
                            "Local file {} changed while the authority moved it.",
                            prior.file.path
                        ),
                    ));
                }
            }
        }
        if target_digest.as_deref() != Some(file.content_digest.as_str()) {
            self.install_file_blob(&file)?;
        }
        if let Some(prior) = &prior {
            if prior.file.path != file.path {
                self.remove_file(&prior.file.path)?;
            }
        }
        state.files.insert(file.file_id, MirrorFileEntry { file });
        Ok(())
    }

    fn remove_materialized_file(
        &self,
        state: &mut DurableMirrorState,
        file_id: Uuid,
    ) -> Result<(), MirrorError> {
        let Some(entry) = state.files.get(&file_id).cloned() else {
            return Ok(());
        };
        if self
            .file_digest(&entry.file.path)?
            .as_deref()
            .is_some_and(|digest| digest != entry.file.content_digest)
        {
            return Err(MirrorError::new(
                "mirror_diverged",
                format!(
                    "Local file {} changed while the authority removed it.",
                    entry.file.path
                ),
            ));
        }
        self.remove_file(&entry.file.path)?;
        state.files.remove(&file_id);
        Ok(())
    }

    fn file_cache_path(&self, file: &CollectionFileDescriptor) -> Result<PathBuf, MirrorError> {
        let digest = file.content_digest.strip_prefix("sha256:").ok_or_else(|| {
            MirrorError::new("invalid_snapshot", "Collection file digest is invalid.")
        })?;
        let parent = self.state_file.parent().ok_or_else(|| {
            MirrorError::new("invalid_mirror_state_path", "Mirror state path is invalid.")
        })?;
        Ok(parent.join("file-blobs").join(digest))
    }

    pub(super) fn prune_file_cache(&self) -> Result<(), MirrorError> {
        let mut retained = BTreeSet::new();
        if let Some(state) = self.read_state()? {
            retained.extend(state.files.values().filter_map(|entry| {
                entry
                    .file
                    .content_digest
                    .strip_prefix("sha256:")
                    .map(str::to_string)
            }));
        }
        if let Some(plan) = self.read_rebuild_plan()? {
            retained.extend(plan.files.iter().filter_map(|file| {
                file.content_digest
                    .strip_prefix("sha256:")
                    .map(str::to_string)
            }));
            if let Some(prior) = plan.prior {
                retained.extend(prior.files.values().filter_map(|entry| {
                    entry
                        .file
                        .content_digest
                        .strip_prefix("sha256:")
                        .map(str::to_string)
                }));
            }
        }
        let parent = self.state_file.parent().ok_or_else(|| {
            MirrorError::new("invalid_mirror_state_path", "Mirror state path is invalid.")
        })?;
        let cache = parent.join("file-blobs");
        let entries = match fs::read_dir(&cache) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(MirrorError::io("Could not inspect", &cache, error)),
        };
        for entry in entries {
            let entry =
                entry.map_err(|error| MirrorError::io("Could not inspect", &cache, error))?;
            let name = entry.file_name();
            let Some(name) = name.to_str() else {
                continue;
            };
            if name.len() != 64
                || !name
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
                || retained.contains(name)
            {
                continue;
            }
            let file_type = entry
                .file_type()
                .map_err(|error| MirrorError::io("Could not inspect", &entry.path(), error))?;
            if !file_type.is_file() || file_type.is_symlink() {
                continue;
            }
            fs::remove_file(entry.path()).map_err(|error| {
                MirrorError::io("Could not prune mirror file cache", &entry.path(), error)
            })?;
        }
        Ok(())
    }
}

pub(super) fn validate_visible_file_path(relative: &str, folder: bool) -> Result<(), MirrorError> {
    validate_portable_mirror_path(relative)
        .map_err(|error| MirrorError::new("invalid_file_path", error))?;
    let components = relative.split('/').collect::<Vec<_>>();
    if components.iter().any(|component| {
        component.starts_with('.')
            || component.ends_with([' ', '.'])
            || component.contains(['<', '>', ':', '"', '|', '?', '*'])
            || windows_reserved_name(component)
            || RESERVED_FILE_DIRECTORIES
                .iter()
                .any(|reserved| component.eq_ignore_ascii_case(reserved))
    }) || (!folder
        && relative
            .rsplit_once('.')
            .is_some_and(|(_, extension)| extension.eq_ignore_ascii_case("md")))
    {
        return Err(MirrorError::new(
            "invalid_file_path",
            format!("Collection file path {relative} is hidden, reserved, or non-portable."),
        ));
    }
    Ok(())
}

fn windows_reserved_name(component: &str) -> bool {
    let stem = component.split('.').next().unwrap_or_default();
    let upper = stem.to_ascii_uppercase();
    matches!(upper.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || upper
            .strip_prefix("COM")
            .or_else(|| upper.strip_prefix("LPT"))
            .is_some_and(|number| {
                matches!(number, "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9")
            })
}

fn verify_file(path: &Path, file: &CollectionFileDescriptor) -> Result<bool, MirrorError> {
    match sha256_file(path) {
        Ok((size, digest)) => {
            Ok(size == file.size && format!("sha256:{digest}") == file.content_digest)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(MirrorError::io("Could not verify", path, error)),
    }
}

fn sha256_file(path: &Path) -> Result<(u64, String), std::io::Error> {
    let mut input = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut size = 0_u64;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = input.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        size = size.saturating_add(read as u64);
        hasher.update(&buffer[..read]);
    }
    Ok((size, format!("{:x}", hasher.finalize())))
}

fn atomic_copy(source: &Path, target: &Path) -> Result<(), MirrorError> {
    let parent = target
        .parent()
        .ok_or_else(|| MirrorError::new("invalid_mirror_path", "Mirror path is invalid."))?;
    fs::create_dir_all(parent)
        .map_err(|error| MirrorError::io("Could not create", parent, error))?;
    if fs::symlink_metadata(target).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
        return Err(MirrorError::new(
            "mirror_symlink_refused",
            format!("Mirror output is a symbolic link: {}", target.display()),
        ));
    }
    let mut temporary = NamedTempFile::new_in(parent)
        .map_err(|error| MirrorError::io("Could not create a temporary file in", parent, error))?;
    let mut input = File::open(source)
        .map_err(|error| MirrorError::io("Could not open staged file", source, error))?;
    std::io::copy(&mut input, &mut temporary)
        .and_then(|_| temporary.as_file().sync_all())
        .map_err(|error| MirrorError::io("Could not write", temporary.path(), error))?;
    temporary
        .persist(target)
        .map_err(|error| MirrorError::io("Could not replace", target, error.error))?;
    if let Ok(directory) = File::open(parent) {
        let _ = directory.sync_all();
    }
    Ok(())
}
