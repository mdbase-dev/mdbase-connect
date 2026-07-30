use super::*;

impl CollectionRegistry {
    /// Turn a fully verified hosted mirror into the local authority.
    ///
    /// The caller must fence and verify the hosted authority first. This
    /// transition is idempotent so a daemon can resume it after a crash.
    pub fn activate_mirror_authority(
        &self,
        path: impl AsRef<Path>,
        collection_id: Uuid,
    ) -> Result<CollectionSummary, ConnectError> {
        let path = path.as_ref().canonicalize()?;
        let path_string = path.to_string_lossy().to_string();
        let existing = self
            .list()?
            .into_iter()
            .find(|collection| collection.id == collection_id);
        let already_materialized = existing
            .as_ref()
            .is_some_and(|collection| collection.path == path_string)
            && collection_identity(&path)? == Some(collection_id)
            && mirror_collection_id(&path)?.is_none();
        if !already_materialized {
            if mirror_collection_id(&path)? != Some(collection_id) {
                return Err(ConnectError::InvalidMirrorMarker(
                    "Only the matching hosted mirror can become this collection authority."
                        .to_string(),
                ));
            }
            if let Some(existing) = &existing {
                let existing_path = Path::new(&existing.path);
                if existing.path != path_string && existing_path.exists() {
                    return Err(ConnectError::DuplicateCollectionIdentity {
                        collection_id,
                        existing_path: existing.path.clone(),
                    });
                }
            }
            let identity_was_present = collection_identity(&path)?.is_some();
            set_collection_identity(&path, collection_id)?;
            remove_mirror_marker(&path, collection_id)?;
            match self.add(&path) {
                Ok(_) => {}
                Err(error) => {
                    if !identity_was_present {
                        let _ = clear_collection_identity(&path);
                    }
                    let _ = write_mirror_marker(&path, collection_id);
                    return Err(error);
                }
            }
        } else {
            self.add(&path)?;
        }
        let mut connection = self.connection()?;
        let transaction =
            connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        transaction.execute(
            "DELETE FROM local_sync_collections WHERE collection_id = ?1",
            [collection_id.to_string()],
        )?;
        transaction.execute(
            "UPDATE collections SET enabled = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?1",
            [collection_id.to_string()],
        )?;
        transaction.commit()?;
        self.get(collection_id)
    }

    /// Restore a materialized-but-uncommitted authority to its mirror role.
    pub fn rollback_mirror_authority(
        &self,
        path: impl AsRef<Path>,
        collection_id: Uuid,
        identity_was_present: bool,
        registration_was_present: bool,
    ) -> Result<(), ConnectError> {
        let path = path.as_ref().canonicalize()?;
        if let Ok(existing) = self.get(collection_id) {
            if existing.path == path.to_string_lossy() {
                if registration_was_present {
                    self.set_enabled(collection_id, false)?;
                } else {
                    self.remove(collection_id)?;
                }
            }
        }
        if !identity_was_present && collection_identity(&path)? == Some(collection_id) {
            clear_collection_identity(&path)?;
        }
        write_mirror_marker(&path, collection_id)
    }

    pub fn authority_snapshot(&self, id: Uuid) -> Result<AuthoritySnapshot, ConnectError> {
        let registered = self.get(id)?;
        if !registered.enabled {
            return Err(ConnectError::AccessDenied(
                "This collection is disabled on its computer.".to_string(),
            ));
        }
        let provider = self.provider_for(&registered)?;
        let store = crate::LocalSyncStore::for_registry(self);
        provider.with_collection_read(|collection| {
            store.assert_authority_available(id)?;
            self.authority_snapshot_loaded(&registered, collection, &store)
        })
    }

    /// Fence mutations and capture the final source snapshot under the same
    /// provider write gate. The fence is durable across agent restarts.
    pub fn fence_authority(
        &self,
        id: Uuid,
        transfer_id: Uuid,
    ) -> Result<AuthoritySnapshot, ConnectError> {
        let registered = self.get(id)?;
        let provider = self.provider_for(&registered)?;
        let store = crate::LocalSyncStore::for_registry(self);
        provider.with_collection(|collection| {
            let snapshot = collection.snapshot()?;
            store.reconcile(id, &snapshot, &HashMap::new())?;
            store.fence(id, transfer_id)?;
            let description = self.describe_loaded(&registered, collection)?;
            let resources = sync_resources(&snapshot, description, &BTreeSet::new());
            store.export_snapshot(id, &snapshot, resources)
        })
    }

    pub fn resume_authority(&self, id: Uuid, transfer_id: Uuid) -> Result<(), ConnectError> {
        let registered = self.get(id)?;
        let provider = self.provider_for(&registered)?;
        let store = crate::LocalSyncStore::for_registry(self);
        provider.with_collection::<_, ConnectError>(|_| store.resume(id, transfer_id))
    }

    pub fn retire_authority(
        &self,
        id: Uuid,
        transfer_id: Uuid,
        authority_epoch: u64,
    ) -> Result<(), ConnectError> {
        let registered = self.get(id)?;
        let store = crate::LocalSyncStore::for_registry(self);
        if store.is_retired(id)? {
            write_mirror_marker(Path::new(&registered.path), id)?;
            self.connection()?.execute(
                "UPDATE collections SET enabled = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?1",
                [id.to_string()],
            )?;
            return Ok(());
        }
        let provider = self.provider_for(&registered)?;
        provider.with_collection::<_, ConnectError>(|_| {
            store.retire(id, transfer_id, authority_epoch)?;
            write_mirror_marker(Path::new(&registered.path), id)?;
            self.connection()?.execute(
                "UPDATE collections SET enabled = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?1",
                [id.to_string()],
            )?;
            Ok(())
        })
    }

    /// Capture a complete provider-neutral authority snapshot without fencing
    /// ordinary mutations. Transfer orchestrators use this for the resumable
    /// bulk stage before the short cutover window.
    pub(super) fn authority_snapshot_loaded(
        &self,
        registered: &CollectionSummary,
        collection: &Collection,
        store: &crate::LocalSyncStore,
    ) -> Result<AuthoritySnapshot, ConnectError> {
        let snapshot = collection.snapshot()?;
        store.reconcile(registered.id, &snapshot, &HashMap::new())?;
        let description = self.describe_loaded(registered, collection)?;
        let resources = sync_resources(&snapshot, description, &BTreeSet::new());
        store.export_snapshot(registered.id, &snapshot, resources)
    }
}
