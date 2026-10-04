use super::*;
#[derive(Debug, serde::Deserialize)]
pub(super) struct CollectionMetadata {
    pub(super) spec_version: String,
    #[serde(default)]
    pub(super) name: Option<String>,
    #[serde(default)]
    pub(super) description: Option<String>,
}

pub(super) fn assert_local_authority_folder(root: &Path) -> Result<(), ConnectError> {
    if let Some(collection_id) = mirror_collection_id(root)? {
        return Err(ConnectError::MirrorCannotRegister { collection_id });
    }
    Ok(())
}

/// The hosted collection a folder mirrors, if any. A newer runtime's claim
/// and every unreadable marker fail closed. Messages name the marker relative
/// to the collection because they can reach applications through the relay.
pub fn mirror_collection_id(root: &Path) -> Result<Option<Uuid>, ConnectError> {
    let marker_directory = root.join(MIRROR_MARKER_DIRECTORY);
    let directory_metadata = match fs::symlink_metadata(&marker_directory) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    if directory_metadata.file_type().is_symlink() || !directory_metadata.is_dir() {
        return Err(ConnectError::InvalidMirrorMarker(format!(
            "{MIRROR_MARKER_DIRECTORY} must be an ordinary directory."
        )));
    }
    let marker_path = marker_directory.join(MIRROR_MARKER_FILE);
    let marker_metadata = match fs::symlink_metadata(&marker_path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    if marker_metadata.file_type().is_symlink() || !marker_metadata.is_file() {
        return Err(ConnectError::InvalidMirrorMarker(format!(
            "{ROLE_MARKER_PATH} must be an ordinary file."
        )));
    }
    match RoleMarker::classify(&fs::read(&marker_path)?) {
        RoleMarker::Mirror { collection_id } => Ok(Some(collection_id)),
        RoleMarker::ClaimedByNewerRuntime { .. } => Err(ConnectError::ClaimedByNewerRuntime),
        RoleMarker::Unrecognized => Err(ConnectError::InvalidMirrorMarker(format!(
            "{ROLE_MARKER_PATH} has an unsupported role or version."
        ))),
        RoleMarker::Malformed => Err(ConnectError::InvalidMirrorMarker(format!(
            "{ROLE_MARKER_PATH} could not be read."
        ))),
    }
}

/// Whether a registered folder has been claimed by a newer runtime.
pub(super) fn claimed_by_newer_runtime(root: &Path) -> bool {
    matches!(
        mirror_collection_id(root),
        Err(ConnectError::ClaimedByNewerRuntime)
    )
}

pub(super) fn write_mirror_marker(root: &Path, collection_id: Uuid) -> Result<(), ConnectError> {
    let marker_directory = root.join(MIRROR_MARKER_DIRECTORY);
    match fs::symlink_metadata(&marker_directory) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            return Err(ConnectError::InvalidMirrorMarker(format!(
                "{MIRROR_MARKER_DIRECTORY} must be an ordinary directory."
            )));
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir(&marker_directory)?;
        }
        Err(error) => return Err(error.into()),
    }
    let marker_path = marker_directory.join(MIRROR_MARKER_FILE);
    if let Some(existing) = mirror_collection_id(root)? {
        return if existing == collection_id {
            Ok(())
        } else {
            Err(ConnectError::InvalidMirrorMarker(format!(
                "{ROLE_MARKER_PATH} belongs to another collection."
            )))
        };
    }
    let mut temporary = NamedTempFile::new_in(&marker_directory)?;
    temporary.write_all(
        serde_json::to_string_pretty(&json!({
            "version": 1,
            "role": "mirror",
            "collection_id": collection_id,
        }))?
        .as_bytes(),
    )?;
    temporary.write_all(b"\n")?;
    temporary.as_file().sync_all()?;
    temporary
        .persist(&marker_path)
        .map_err(|error| ConnectError::Io(error.error))?;
    Ok(())
}

pub(super) fn remove_mirror_marker(root: &Path, collection_id: Uuid) -> Result<(), ConnectError> {
    if mirror_collection_id(root)? != Some(collection_id) {
        return Err(ConnectError::InvalidMirrorMarker(
            "Mirror role marker belongs to another collection.".to_string(),
        ));
    }
    fs::remove_file(root.join(MIRROR_MARKER_DIRECTORY).join(MIRROR_MARKER_FILE))?;
    Ok(())
}

pub(super) fn ensure_collection_id(root: &Path) -> Result<Uuid, ConnectError> {
    if let Some(id) = collection_identity(root)? {
        return Ok(id);
    }
    let id = Uuid::new_v4();
    write_collection_id(root, id)?;
    Ok(id)
}

pub(super) fn read_collection_id(root: &Path) -> Result<Option<Uuid>, ConnectError> {
    collection_identity(root)
}

pub fn collection_identity(root: &Path) -> Result<Option<Uuid>, ConnectError> {
    let config_path = root.join("mdbase.yaml");
    let source = fs::read_to_string(&config_path)?;
    let config: serde_yaml::Value = serde_yaml::from_str(&source)?;
    let mapping = config.as_mapping().ok_or_else(|| {
        ConnectError::CollectionOpen("mdbase.yaml must contain a YAML mapping.".to_string())
    })?;
    let extension_key = serde_yaml::Value::String(CONNECT_EXTENSION.to_string());
    let collection_id_key = serde_yaml::Value::String(CONNECT_COLLECTION_ID.to_string());

    if let Some(value) = mapping
        .get(&extension_key)
        .and_then(serde_yaml::Value::as_mapping)
        .and_then(|extension| extension.get(&collection_id_key))
    {
        let value = value.as_str().ok_or_else(|| {
            ConnectError::CollectionOpen(format!(
                "{CONNECT_EXTENSION}.{CONNECT_COLLECTION_ID} must be a UUID string."
            ))
        })?;
        return Uuid::parse_str(value).map(Some).map_err(|_| {
            ConnectError::CollectionOpen(format!(
                "{CONNECT_EXTENSION}.{CONNECT_COLLECTION_ID} must be a valid UUID."
            ))
        });
    }
    Ok(None)
}

pub(super) fn write_collection_id(root: &Path, id: Uuid) -> Result<(), ConnectError> {
    update_collection_identity(root, id, false)
}

pub(super) fn set_collection_identity(root: &Path, id: Uuid) -> Result<(), ConnectError> {
    update_collection_identity(root, id, true)
}

pub(super) fn update_collection_identity(
    root: &Path,
    id: Uuid,
    require_matching_existing: bool,
) -> Result<(), ConnectError> {
    let config_path = root.join("mdbase.yaml");
    let source = fs::read_to_string(&config_path)?;
    let mut config: serde_yaml::Value = serde_yaml::from_str(&source)?;
    let mapping = config.as_mapping_mut().ok_or_else(|| {
        ConnectError::CollectionOpen("mdbase.yaml must contain a YAML mapping.".to_string())
    })?;
    let extension_key = serde_yaml::Value::String(CONNECT_EXTENSION.to_string());
    let collection_id_key = serde_yaml::Value::String(CONNECT_COLLECTION_ID.to_string());
    let extension = mapping
        .entry(extension_key)
        .or_insert_with(|| serde_yaml::Value::Mapping(serde_yaml::Mapping::new()));
    let extension = extension.as_mapping_mut().ok_or_else(|| {
        ConnectError::CollectionOpen(format!("{CONNECT_EXTENSION} must be a YAML mapping."))
    })?;
    if require_matching_existing {
        if let Some(existing) = extension
            .get(&collection_id_key)
            .and_then(serde_yaml::Value::as_str)
        {
            if existing != id.to_string() {
                return Err(ConnectError::CollectionOpen(
                    "This folder already has a different mdbase connect collection identity."
                        .to_string(),
                ));
            }
        }
    }
    extension.insert(collection_id_key, serde_yaml::Value::String(id.to_string()));

    persist_collection_configuration(root, &config_path, &config)
}

pub(super) fn clear_collection_identity(root: &Path) -> Result<(), ConnectError> {
    let config_path = root.join("mdbase.yaml");
    let source = fs::read_to_string(&config_path)?;
    let mut config: serde_yaml::Value = serde_yaml::from_str(&source)?;
    let mapping = config.as_mapping_mut().ok_or_else(|| {
        ConnectError::CollectionOpen("mdbase.yaml must contain a YAML mapping.".to_string())
    })?;
    let extension_key = serde_yaml::Value::String(CONNECT_EXTENSION.to_string());
    let collection_id_key = serde_yaml::Value::String(CONNECT_COLLECTION_ID.to_string());
    let remove_extension = if let Some(extension) = mapping
        .get_mut(&extension_key)
        .and_then(serde_yaml::Value::as_mapping_mut)
    {
        extension.remove(&collection_id_key);
        extension.is_empty()
    } else {
        false
    };
    if remove_extension {
        mapping.remove(&extension_key);
    }
    persist_collection_configuration(root, &config_path, &config)
}

pub(super) fn persist_collection_configuration(
    root: &Path,
    config_path: &Path,
    config: &serde_yaml::Value,
) -> Result<(), ConnectError> {
    let serialized = serde_yaml::to_string(&config)?;
    let permissions = fs::metadata(config_path)?.permissions();
    let mut temporary = NamedTempFile::new_in(root)?;
    temporary.as_file().set_permissions(permissions)?;
    temporary.write_all(serialized.as_bytes())?;
    temporary.as_file().sync_all()?;
    temporary
        .persist(config_path)
        .map_err(|error| ConnectError::Io(error.error))?;
    Ok(())
}

pub(super) fn read_collection_metadata(root: &Path) -> Result<CollectionMetadata, ConnectError> {
    let source = fs::read_to_string(root.join("mdbase.yaml"))?;
    Ok(serde_yaml::from_str(&source)?)
}

pub(super) fn collection_display_name(metadata: &CollectionMetadata, path: &Path) -> String {
    metadata
        .name
        .as_deref()
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(str::to_string)
        .or_else(|| {
            path.file_name()
                .map(|name| name.to_string_lossy().to_string())
        })
        .unwrap_or_else(|| "Collection".to_string())
}

pub(super) fn normalized_optional(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}
