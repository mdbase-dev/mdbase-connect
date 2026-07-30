use super::*;

impl MirrorManager {
    pub(super) fn ensure_path_available(
        &self,
        path: &Path,
        collection_id: Uuid,
    ) -> Result<(), ConnectError> {
        for collection in self.registry.list()? {
            let registered = fs::canonicalize(&collection.path)
                .unwrap_or_else(|_| PathBuf::from(&collection.path));
            let retired_authority_becoming_its_mirror = collection.id == collection_id
                && !collection.enabled
                && registered == path
                && mdbase_connect_core::mirror_collection_id(path)?
                    .is_some_and(|marker_id| marker_id == collection_id);
            if retired_authority_becoming_its_mirror {
                continue;
            }
            if paths_overlap(path, &registered) {
                return Err(mirror_error(
                    "mirror_path_overlaps_authority",
                    "Mirror folder overlaps a computer-owned collection.",
                ));
            }
        }
        if self
            .entries()
            .iter()
            .any(|entry| paths_overlap(path, &entry.path))
        {
            return Err(mirror_error(
                "mirror_path_overlap",
                "Mirror folder overlaps another hosted mirror.",
            ));
        }
        Ok(())
    }

    pub(super) fn cloud(&self) -> Result<&CloudControlClient, ConnectError> {
        self.cloud.as_ref().ok_or_else(|| {
            ConnectError::Cloud("Connect this computer to an account first.".to_string())
        })
    }

    pub(super) fn require_active(&self, entry: &MirrorRegistryEntry) -> Result<(), ConnectError> {
        if entry.lifecycle == MirrorLifecycle::Active {
            Ok(())
        } else {
            Err(mirror_error(
                "mirror_lifecycle_in_progress",
                "This mirror is still being provisioned or removed; retry after recovery.",
            ))
        }
    }

    pub(super) fn validate_mirror_root(
        &self,
        entry: &MirrorRegistryEntry,
    ) -> Result<(), ConnectError> {
        let resolved = fs::canonicalize(&entry.path)?;
        if resolved != entry.path {
            return Err(mirror_error(
                "mirror_root_replaced",
                "The mirror root or one of its parent directories was replaced.",
            ));
        }
        self.validate_mirror_root_if_present(entry)
    }

    pub(super) fn validate_mirror_root_if_present(
        &self,
        entry: &MirrorRegistryEntry,
    ) -> Result<(), ConnectError> {
        match fs::symlink_metadata(&entry.path) {
            Ok(metadata) if metadata.file_type().is_symlink() => Err(mirror_error(
                "mirror_symlink_refused",
                "The mirror root was replaced by a symbolic link.",
            )),
            Ok(metadata) if !metadata.is_dir() => Err(mirror_error(
                "invalid_mirror_path",
                "The mirror root is no longer a directory.",
            )),
            Ok(_) => {
                let resolved = fs::canonicalize(&entry.path)?;
                if resolved == entry.path {
                    Ok(())
                } else {
                    Err(mirror_error(
                        "mirror_root_replaced",
                        "The mirror root or one of its parent directories was replaced.",
                    ))
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(ConnectError::Io(error)),
        }
    }

    pub(super) fn entries(&self) -> Vec<MirrorRegistryEntry> {
        self.entries
            .read()
            .expect("mirror registry lock poisoned")
            .clone()
    }

    pub(super) fn entry(&self, replica_id: Uuid) -> Result<MirrorRegistryEntry, ConnectError> {
        self.entries()
            .into_iter()
            .find(|entry| entry.replica_id == replica_id)
            .ok_or_else(|| {
                mirror_error(
                    "mirror_not_found",
                    "That mirror is not controlled by this computer.",
                )
            })
    }

    pub(super) fn insert_entry(&self, entry: MirrorRegistryEntry) -> Result<(), ConnectError> {
        let mut entries = self.entries.write().expect("mirror registry lock poisoned");
        if entries.iter().any(|candidate| {
            candidate.replica_id == entry.replica_id || paths_overlap(&candidate.path, &entry.path)
        }) {
            return Err(mirror_error(
                "mirror_already_exists",
                "That mirror or folder is already registered.",
            ));
        }
        let mut updated = entries.clone();
        updated.push(entry);
        write_registry(&self.state_dir.join("mirrors.json"), &updated)?;
        *entries = updated;
        Ok(())
    }

    pub(super) fn replace_entry(&self, entry: MirrorRegistryEntry) -> Result<(), ConnectError> {
        let mut entries = self.entries.write().expect("mirror registry lock poisoned");
        let mut updated = entries.clone();
        let target = updated
            .iter_mut()
            .find(|candidate| candidate.replica_id == entry.replica_id)
            .ok_or_else(|| mirror_error("mirror_not_found", "Mirror registration disappeared."))?;
        *target = entry;
        write_registry(&self.state_dir.join("mirrors.json"), &updated)?;
        *entries = updated;
        Ok(())
    }

    pub(super) fn update_expiry(
        &self,
        replica_id: Uuid,
        expiry: String,
    ) -> Result<(), ConnectError> {
        let mut entries = self.entries.write().expect("mirror registry lock poisoned");
        let mut updated = entries.clone();
        let target = updated
            .iter_mut()
            .find(|candidate| candidate.replica_id == replica_id)
            .ok_or_else(|| mirror_error("mirror_not_found", "Mirror registration disappeared."))?;
        target.access_token_expires_at = expiry;
        write_registry(&self.state_dir.join("mirrors.json"), &updated)?;
        *entries = updated;
        Ok(())
    }

    pub(super) fn remove_entry(&self, replica_id: Uuid) -> Result<(), ConnectError> {
        let mut entries = self.entries.write().expect("mirror registry lock poisoned");
        let mut updated = entries.clone();
        updated.retain(|entry| entry.replica_id != replica_id);
        write_registry(&self.state_dir.join("mirrors.json"), &updated)?;
        *entries = updated;
        Ok(())
    }

    pub(super) fn replica_state_dir(&self, replica_id: Uuid) -> PathBuf {
        self.state_dir.join("mirrors").join(replica_id.to_string())
    }
}
