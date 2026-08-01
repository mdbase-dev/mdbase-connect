use super::*;
use unicode_normalization::UnicodeNormalization;

const REMOTE_MIRROR_RECORD_EXTENSION: &str = "md";

pub(super) struct MirrorLease {
    file: File,
}

impl MirrorLease {
    pub(super) fn acquire(path: &Path) -> Result<Self, MirrorError> {
        let parent = path.parent().ok_or_else(|| {
            MirrorError::new("invalid_mirror_lock_path", "Mirror lock path is invalid.")
        })?;
        fs::create_dir_all(parent)
            .map_err(|error| MirrorError::io("Could not create", parent, error))?;
        let file = OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .truncate(false)
            .open(path)
            .map_err(|error| MirrorError::io("Could not open", path, error))?;
        file.try_lock_exclusive().map_err(|_| {
            MirrorError::new(
                "mirror_folder_in_use",
                "Another mdbase mirror process is already using this folder.",
            )
        })?;
        Ok(Self { file })
    }
}

impl Drop for MirrorLease {
    fn drop(&mut self) {
        let _ = self.file.unlock();
    }
}

pub fn mirror_lock_path(lock_root: &Path, canonical_root: &Path) -> PathBuf {
    lock_root.join(format!(
        "{}.lock",
        digest(canonical_root.to_string_lossy().as_ref())
    ))
}

pub fn mark_mirror(root: &Path, collection_id: Uuid) -> Result<(), MirrorError> {
    fs::create_dir_all(root).map_err(|error| MirrorError::io("Could not create", root, error))?;
    if fs::symlink_metadata(root).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
        return Err(MirrorError::new(
            "mirror_symlink_refused",
            "Mirror root must not be a symbolic link.",
        ));
    }
    let root = fs::canonicalize(root)
        .map_err(|error| MirrorError::io("Could not resolve", root, error))?;
    let marker = safe_path(&root, ".mdbase/connect-role.json")?;
    if let Ok(existing) = fs::read(&marker) {
        let value = serde_json::from_slice::<Value>(&existing).map_err(|_| {
            MirrorError::new("invalid_mirror_marker", "Mirror role marker is corrupt.")
        })?;
        if value["version"] == 1
            && value["role"] == "mirror"
            && value["collection_id"] == collection_id.to_string()
        {
            return Ok(());
        }
        return Err(MirrorError::new(
            "mirror_identity_conflict",
            "This folder is already assigned to a different storage role.",
        ));
    }
    let configuration = root.join("mdbase.yaml");
    if let Ok(source) = fs::read_to_string(&configuration) {
        if let Ok(value) = serde_yaml::from_str::<Value>(&source) {
            if value
                .pointer("/x-mdbase-connect/collection_id")
                .and_then(Value::as_str)
                .is_some()
            {
                return Err(MirrorError::new(
                    "local_authority_requires_transfer",
                    "This folder is a computer-owned authority; transfer it explicitly before mirroring.",
                ));
            }
        }
    }
    atomic_write(
        &marker,
        &serde_json::to_vec_pretty(&serde_json::json!({
            "version": 1,
            "role": "mirror",
            "collection_id": collection_id
        }))
        .map_err(MirrorError::from)?,
    )
}

pub fn clear_mirror_marker(root: &Path, collection_id: Uuid) -> Result<(), MirrorError> {
    match fs::symlink_metadata(root) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            return Err(MirrorError::new(
                "mirror_symlink_refused",
                "Mirror root was replaced by a symbolic link.",
            ));
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(MirrorError::io("Could not inspect", root, error)),
    }
    let root = fs::canonicalize(root)
        .map_err(|error| MirrorError::io("Could not resolve", root, error))?;
    let marker = safe_path(&root, ".mdbase/connect-role.json")?;
    let value = match fs::read(&marker) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(MirrorError::io("Could not read", &marker, error)),
    };
    let value = serde_json::from_slice::<Value>(&value)
        .map_err(|_| MirrorError::new("invalid_mirror_marker", "Mirror role marker is corrupt."))?;
    if value["collection_id"] != collection_id.to_string() {
        return Err(MirrorError::new(
            "mirror_identity_conflict",
            "Mirror role marker belongs to a different collection.",
        ));
    }
    fs::remove_file(&marker).map_err(|error| MirrorError::io("Could not remove", &marker, error))
}

pub(super) fn safe_path(root: &Path, relative: &str) -> Result<PathBuf, MirrorError> {
    let relative_path = Path::new(relative);
    if relative.is_empty()
        || relative_path.is_absolute()
        || relative_path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(MirrorError::new(
            "mirror_path_escape",
            format!("Hosted path is not a safe relative path: {relative}"),
        ));
    }
    let mut current = root.to_path_buf();
    for component in relative_path.components() {
        let Component::Normal(component) = component else {
            unreachable!()
        };
        current.push(component);
        match fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(MirrorError::new(
                    "mirror_symlink_refused",
                    format!("Mirror path crosses a symbolic link: {relative}"),
                ))
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(MirrorError::io("Could not inspect", &current, error));
            }
        }
    }
    Ok(current)
}

pub(super) fn validate_portable_mirror_path(relative: &str) -> Result<(), String> {
    let path = mdbase::api::CollectionPath::new(relative).map_err(|error| error.to_string())?;
    if path.as_str() != relative {
        return Err("path is not in canonical forward-slash form".to_string());
    }
    Ok(())
}

pub(super) fn portable_mirror_path_key(relative: &str) -> Result<String, String> {
    validate_portable_mirror_path(relative)?;
    let normalized = relative.nfc().collect::<String>();
    Ok(normalized
        .chars()
        .flat_map(char::to_lowercase)
        .collect::<String>()
        .nfc()
        .collect())
}

pub(super) fn is_remote_mirror_record_path(relative: &str) -> bool {
    relative
        .rsplit_once('.')
        .is_some_and(|(_, extension)| extension == REMOTE_MIRROR_RECORD_EXTENSION)
}

pub(super) fn atomic_write(path: &Path, value: &[u8]) -> Result<(), MirrorError> {
    let parent = path
        .parent()
        .ok_or_else(|| MirrorError::new("invalid_mirror_path", "Mirror path is invalid."))?;
    fs::create_dir_all(parent)
        .map_err(|error| MirrorError::io("Could not create", parent, error))?;
    // Re-check after directory creation so a pre-existing symlink cannot be
    // followed by the final replacement.
    if fs::symlink_metadata(path).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
        return Err(MirrorError::new(
            "mirror_symlink_refused",
            format!("Mirror output is a symbolic link: {}", path.display()),
        ));
    }
    let mut temporary = NamedTempFile::new_in(parent)
        .map_err(|error| MirrorError::io("Could not create a temporary file in", parent, error))?;
    temporary
        .write_all(value)
        .and_then(|_| temporary.as_file().sync_all())
        .map_err(|error| MirrorError::io("Could not write", temporary.path(), error))?;
    temporary
        .persist(path)
        .map_err(|error| MirrorError::io("Could not replace", path, error.error))?;
    if let Ok(directory) = File::open(parent) {
        let _ = directory.sync_all();
    }
    Ok(())
}

pub(super) fn record_markdown_document(record: &SyncRecord) -> Result<String, MirrorError> {
    if record.frontmatter.is_empty() {
        return Ok(record.body.clone());
    }
    let mapping = json_to_yaml_mapping(&Value::Object(record.frontmatter.clone()));
    let yaml = serde_yaml::to_string(&mapping)
        .map_err(|error| MirrorError::new("frontmatter_render_failed", error.to_string()))?;
    let yaml = yaml.trim_end();
    let body = if record.body.is_empty() {
        String::new()
    } else {
        format!("\n{}", record.body.trim_start_matches('\n'))
    };
    Ok(format!("---\n{yaml}\n---\n{body}"))
}

pub(super) fn parse_markdown(
    document: &str,
    _path: &str,
) -> Result<(Map<String, Value>, String), MirrorError> {
    let parsed = parse_document(document);
    let frontmatter = match parsed.frontmatter {
        None => Map::new(),
        Some(value) if is_parse_error(&value) => return Ok((Map::new(), document.to_string())),
        Some(serde_yaml::Value::Mapping(mapping)) => yaml_mapping_to_json(&mapping)
            .as_object()
            .cloned()
            .unwrap_or_default(),
        Some(_) => return Ok((Map::new(), document.to_string())),
    };
    Ok((frontmatter, parsed.body))
}

pub(super) fn frontmatter_patch(
    before: &Map<String, Value>,
    after: &Map<String, Value>,
) -> Map<String, Value> {
    let mut patch = after.clone();
    for field in before.keys() {
        if !after.contains_key(field) {
            patch.insert(field.clone(), Value::Null);
        }
    }
    patch
}

#[allow(clippy::too_many_arguments)]
pub(super) fn queue_mutation(
    queue: &mut Vec<PendingMirrorMutation>,
    predecessors: &mut HashMap<Uuid, Uuid>,
    replica_id: Uuid,
    scope_epoch: u64,
    operation: SyncMutationOperation,
    record_id: Uuid,
    base_revision: Option<String>,
    input: Map<String, Value>,
    local_path: String,
    local_hash: Option<String>,
) {
    let mutation_id = Uuid::new_v4();
    let causal_predecessor = predecessors.get(&record_id).copied();
    queue.push(PendingMirrorMutation {
        mutation: SyncMutation {
            mutation_id,
            replica_id,
            scope_epoch,
            operation,
            record_id,
            base_revision,
            input,
            created_at: now(),
            causal_predecessor,
        },
        local_path,
        local_hash,
    });
    predecessors.insert(record_id, mutation_id);
}

pub(super) fn refresh_conflict(state: &mut DurableMirrorState, event: &SyncChange) {
    let record_id = match event {
        SyncChange::Put { record, .. } => record.record_id,
        SyncChange::Remove { record_id, .. } => *record_id,
        SyncChange::FilePut { .. } | SyncChange::FileRemove { .. } => return,
    };
    let Some(SyncMutationReceipt::Conflicted { conflict, .. }) =
        state.conflicts.get_mut(&record_id)
    else {
        return;
    };
    match event {
        SyncChange::Put { record, .. } => {
            conflict.current = Some(record.clone());
            conflict.current_revision = Some(record.revision.clone());
        }
        SyncChange::Remove { revision, .. } => {
            conflict.current = None;
            conflict.current_revision = Some(revision.clone());
        }
        SyncChange::FilePut { .. } | SyncChange::FileRemove { .. } => {}
    }
}

pub(super) fn object<const N: usize>(entries: [(&str, Value); N]) -> Map<String, Value> {
    entries
        .into_iter()
        .map(|(key, value)| (key.to_string(), value))
        .collect()
}

pub(super) fn digest(value: &str) -> String {
    Sha256::digest(value.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

pub(super) fn now() -> String {
    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
