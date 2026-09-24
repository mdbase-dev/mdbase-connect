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

/// Check local role metadata without writing a marker or changing configuration.
/// A matching mirror marker takes precedence over the portable collection identity.
pub fn validate_mirror_folder(root: &Path, collection_id: Uuid) -> Result<(), MirrorError> {
    pending_mirror_marker(root, collection_id).map(|_| ())
}

// None means this exact mirror already has its marker; Some is the checked
// destination for a new marker. Both callers use the same read-only role check.
fn pending_mirror_marker(root: &Path, collection_id: Uuid) -> Result<Option<PathBuf>, MirrorError> {
    if fs::symlink_metadata(root).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
        return Err(MirrorError::new(
            "mirror_symlink_refused",
            "Mirror root must not be a symbolic link.",
        ));
    }
    let root = fs::canonicalize(root)
        .map_err(|error| MirrorError::io("Could not resolve", root, error))?;
    let marker = safe_path(&root, ".mdbase/connect-role.json")?;
    let existing = match fs::read(&marker) {
        Ok(existing) => Some(existing),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(MirrorError::io("Could not read", &marker, error)),
    };
    if let Some(existing) = existing {
        let value = serde_json::from_slice::<Value>(&existing).map_err(|_| {
            MirrorError::new("invalid_mirror_marker", "Mirror role marker is corrupt.")
        })?;
        if value["version"] == 1
            && value["role"] == "mirror"
            && value["collection_id"] == collection_id.to_string()
        {
            return Ok(None);
        }
        return Err(MirrorError::new(
            "mirror_identity_conflict",
            "This folder is already assigned to a different storage role.",
        ));
    }
    let configuration = safe_path(&root, "mdbase.yaml")?;
    let source = match fs::read_to_string(&configuration) {
        Ok(source) => source,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Some(marker)),
        Err(error) => return Err(MirrorError::io("Could not read", &configuration, error)),
    };
    let invalid_configuration = || {
        MirrorError::new(
            "invalid_mirror_configuration",
            "Cannot verify this folder's Connect identity: mdbase.yaml must be a YAML mapping, \
             and x-mdbase-connect.collection_id, if present, must be a UUID string. \
             Preserve the file and correct its configuration before retrying.",
        )
    };
    let value: Value = serde_yaml::from_str(&source).map_err(|_| invalid_configuration())?;
    let mapping = value.as_object().ok_or_else(invalid_configuration)?;
    if let Some(extension) = mapping.get("x-mdbase-connect") {
        let extension = extension.as_object().ok_or_else(invalid_configuration)?;
        if let Some(identity) = extension.get("collection_id") {
            let identity = identity.as_str().ok_or_else(invalid_configuration)?;
            Uuid::parse_str(identity).map_err(|_| invalid_configuration())?;
            return Err(MirrorError::new(
                "local_authority_requires_transfer",
                "This folder contains a Connect identity in mdbase.yaml at x-mdbase-connect.collection_id. Removing its local registration does not remove that identity. If this computer still owns the collection, use the explicit authority transfer; if a transfer is interrupted, recover it first. If the registration was removed, verify ownership and transfer state before repairing the identity. Do not delete mdbase.yaml or remove the identity to bypass this check.",
            ));
        }
    }
    Ok(Some(marker))
}

pub fn mark_mirror(root: &Path, collection_id: Uuid) -> Result<(), MirrorError> {
    fs::create_dir_all(root).map_err(|error| MirrorError::io("Could not create", root, error))?;
    let Some(marker) = pending_mirror_marker(root, collection_id)? else {
        return Ok(());
    };
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
    Ok(record.document.clone())
}

#[cfg(test)]
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

pub(super) fn digest(value: &str) -> String {
    digest_bytes(value.as_bytes())
}

pub(super) fn digest_bytes(value: &[u8]) -> String {
    Sha256::digest(value)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

pub(super) fn now() -> String {
    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
