use super::*;
use mdbase_connect_protocol::{
    DeleteFileReceipt, DeleteFileReceiptKind, DeleteFileRequest, MoveFileReceipt,
    MoveFileReceiptKind, MoveFileRequest,
};

#[derive(Debug)]
struct StoredLifecycleMutation {
    collection_id: Uuid,
    owner_id: Uuid,
    kind: String,
    request: String,
    planned_receipt: String,
    receipt: Option<String>,
}

impl CollectionRegistry {
    pub fn move_file(
        &self,
        id: Uuid,
        owner_id: Uuid,
        request: &MoveFileRequest,
    ) -> Result<MoveFileReceipt, ConnectError> {
        require_file_protocol(request.protocol_version)?;
        if request.mutation_id.is_nil() {
            return Err(file_error(
                "invalid_mutation_id",
                "File mutations require a non-nil client-generated UUID.",
            ));
        }
        if request.update_references {
            return Err(file_error(
                "reference_updates_unsupported",
                "Atomic Markdown reference updates are not available for this authority yet.",
            ));
        }
        let registered = self.get(id)?;
        let provider = self.provider_for(&registered)?;
        provider.with_collection(|collection| {
            crate::LocalSyncStore::for_registry(self).assert_mutation_allowed(id)?;
            let serialized = serde_json::to_string(request)?;
            let existing = self.lifecycle_mutation(request.mutation_id)?;
            if let Some(existing) = &existing {
                assert_same_lifecycle_request(existing, id, owner_id, "move", &serialized)?;
                if let Some(receipt) = &existing.receipt {
                    return serde_json::from_str(receipt).map_err(Into::into);
                }
            }

            let mut planned = existing
                .as_ref()
                .map(|stored| serde_json::from_str::<MoveFileReceipt>(&stored.planned_receipt))
                .transpose()?;
            let snapshot = collection.snapshot()?;
            let preferences = planned.as_ref().map(move_preferences).unwrap_or_default();
            let files = if existing.is_some() {
                self.reconcile_files_loaded_with_preferences(
                    &registered,
                    collection,
                    &snapshot,
                    &preferences,
                )?
            } else {
                self.reconcile_files_loaded(&registered, collection, &snapshot)?
            };
            let current = files
                .iter()
                .find(|file| file.file_id == request.file_id)
                .cloned();
            if existing.is_none() {
                let current = current.as_ref().ok_or_else(file_not_found)?;
                if current.path != request.from_path {
                    return Err(source_path_mismatch());
                }
                if current.revision != request.if_revision {
                    return Err(stale_file_revision());
                }
                validate_move_destination(
                    collection,
                    &registered,
                    &snapshot,
                    &files,
                    current,
                    &request.path,
                )?;
                let receipt = planned_move_receipt(request, current);
                self.prepare_lifecycle_mutation(
                    id,
                    owner_id,
                    request.mutation_id,
                    "move",
                    &serialized,
                    &serde_json::to_string(&receipt)?,
                )?;
                planned = Some(receipt);
            }
            let planned = planned.expect("new and resumed mutations both have a durable plan");
            let preferences = move_preferences(&planned);

            let current = current.ok_or_else(file_not_found)?;
            if current.path == request.from_path && current.path != request.path {
                if current.revision != request.if_revision {
                    return Err(stale_file_revision());
                }
                validate_move_destination(
                    collection,
                    &registered,
                    &snapshot,
                    &files,
                    &current,
                    &request.path,
                )?;
                let root = Path::new(&registered.path);
                let source = root.join(&current.path);
                let source_handle = open_verified_file(&source, false)?;
                if hash_exact_file(&source, current.size)? != current.content_digest {
                    return Err(file_error(
                        "file_changed_during_read",
                        "The source file changed before it could be moved.",
                    ));
                }
                let destination = prepare_destination(root, &request.path)?;
                if destination.exists() {
                    return Err(file_error(
                        "path_occupied",
                        "Another collection file already uses the destination path.",
                    ));
                }
                verify_open_path(&source_handle, &source)?;
                fs::rename(&source, &destination)?;
                sync_parent(&source)?;
                sync_parent(&destination)?;
                if hash_exact_file(&destination, current.size)? != current.content_digest {
                    let _ = fs::rename(&destination, &source);
                    return Err(file_error(
                        "file_changed_during_read",
                        "The source file changed while it was being moved.",
                    ));
                }
            } else if current.path != request.path {
                return Err(source_path_mismatch());
            }

            let after_snapshot = collection.snapshot()?;
            let moved = self
                .reconcile_files_loaded_with_preferences(
                    &registered,
                    collection,
                    &after_snapshot,
                    &preferences,
                )?
                .into_iter()
                .find(|file| file.file_id == request.file_id && file.path == request.path)
                .ok_or_else(|| {
                    file_error(
                        "file_move_failed",
                        "The moved file did not appear in the authority index.",
                    )
                })?;
            if moved != planned.file {
                return Err(file_error(
                    "file_changed_during_move",
                    "The moved file no longer matches the durable mutation plan.",
                ));
            }
            self.complete_lifecycle_mutation(request.mutation_id, &planned)?;
            Ok(planned)
        })
    }

    pub fn delete_file(
        &self,
        id: Uuid,
        owner_id: Uuid,
        request: &DeleteFileRequest,
    ) -> Result<DeleteFileReceipt, ConnectError> {
        require_file_protocol(request.protocol_version)?;
        if request.mutation_id.is_nil() {
            return Err(file_error(
                "invalid_mutation_id",
                "File mutations require a non-nil client-generated UUID.",
            ));
        }
        let registered = self.get(id)?;
        let provider = self.provider_for(&registered)?;
        provider.with_collection(|collection| {
            crate::LocalSyncStore::for_registry(self).assert_mutation_allowed(id)?;
            let serialized = serde_json::to_string(request)?;
            let existing = self.lifecycle_mutation(request.mutation_id)?;
            if let Some(existing) = &existing {
                assert_same_lifecycle_request(existing, id, owner_id, "delete", &serialized)?;
                if let Some(receipt) = &existing.receipt {
                    return serde_json::from_str(receipt).map_err(Into::into);
                }
            }

            let mut planned = existing
                .as_ref()
                .map(|stored| serde_json::from_str::<DeleteFileReceipt>(&stored.planned_receipt))
                .transpose()?;
            let snapshot = collection.snapshot()?;
            let preferences = planned.as_ref().map(delete_preferences).unwrap_or_default();
            let files = if existing.is_some() {
                self.reconcile_files_loaded_with_preferences(
                    &registered,
                    collection,
                    &snapshot,
                    &preferences,
                )?
            } else {
                self.reconcile_files_loaded(&registered, collection, &snapshot)?
            };
            let current = files
                .iter()
                .find(|file| file.file_id == request.file_id)
                .cloned();
            if existing.is_none() {
                let current = current.as_ref().ok_or_else(file_not_found)?;
                if current.path != request.path {
                    return Err(source_path_mismatch());
                }
                if current.revision != request.if_revision {
                    return Err(stale_file_revision());
                }
                let receipt = planned_delete_receipt(request);
                self.prepare_lifecycle_mutation(
                    id,
                    owner_id,
                    request.mutation_id,
                    "delete",
                    &serialized,
                    &serde_json::to_string(&receipt)?,
                )?;
                planned = Some(receipt);
            }
            let planned = planned.expect("new and resumed mutations both have a durable plan");
            let preferences = delete_preferences(&planned);

            if let Some(current) = current {
                if current.path != request.path {
                    return Err(source_path_mismatch());
                }
                if current.revision != request.if_revision {
                    return Err(stale_file_revision());
                }
                let path = Path::new(&registered.path).join(&current.path);
                let source = open_verified_file(&path, false)?;
                if hash_exact_file(&path, current.size)? != current.content_digest {
                    return Err(file_error(
                        "file_changed_during_read",
                        "The file changed before it could be deleted.",
                    ));
                }
                verify_open_path(&source, &path)?;
                remove_file_if_present(&path)?;
                let after_snapshot = collection.snapshot()?;
                self.reconcile_files_loaded_with_preferences(
                    &registered,
                    collection,
                    &after_snapshot,
                    &preferences,
                )?;
            } else if existing.is_none() {
                return Err(file_not_found());
            }

            self.complete_lifecycle_mutation(request.mutation_id, &planned)?;
            Ok(planned)
        })
    }

    fn lifecycle_mutation(
        &self,
        mutation_id: Uuid,
    ) -> Result<Option<StoredLifecycleMutation>, ConnectError> {
        self.connection()?
            .query_row(
                "SELECT collection_id, owner_id, kind, request, planned_receipt, receipt
                 FROM collection_file_mutations WHERE mutation_id = ?1",
                [mutation_id.to_string()],
                |row| {
                    Ok(StoredLifecycleMutation {
                        collection_id: parse_uuid(&row.get::<_, String>(0)?, "collection")
                            .map_err(to_sql_conversion_error)?,
                        owner_id: parse_uuid(&row.get::<_, String>(1)?, "owner")
                            .map_err(to_sql_conversion_error)?,
                        kind: row.get(2)?,
                        request: row.get(3)?,
                        planned_receipt: row.get(4)?,
                        receipt: row.get(5)?,
                    })
                },
            )
            .optional()
            .map_err(Into::into)
    }

    fn prepare_lifecycle_mutation(
        &self,
        collection_id: Uuid,
        owner_id: Uuid,
        mutation_id: Uuid,
        kind: &str,
        request: &str,
        planned_receipt: &str,
    ) -> Result<(), ConnectError> {
        self.connection()?.execute(
            "INSERT INTO collection_file_mutations
               (mutation_id, collection_id, owner_id, kind, request, planned_receipt, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                mutation_id.to_string(),
                collection_id.to_string(),
                owner_id.to_string(),
                kind,
                request,
                planned_receipt,
                Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
            ],
        )?;
        Ok(())
    }

    fn complete_lifecycle_mutation<T: serde::Serialize>(
        &self,
        mutation_id: Uuid,
        receipt: &T,
    ) -> Result<(), ConnectError> {
        self.connection()?.execute(
            "UPDATE collection_file_mutations
             SET receipt = ?2, completed_at = ?3 WHERE mutation_id = ?1",
            params![
                mutation_id.to_string(),
                serde_json::to_string(receipt)?,
                Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
            ],
        )?;
        Ok(())
    }
}

fn assert_same_lifecycle_request(
    stored: &StoredLifecycleMutation,
    collection_id: Uuid,
    owner_id: Uuid,
    kind: &str,
    request: &str,
) -> Result<(), ConnectError> {
    if stored.collection_id == collection_id
        && stored.owner_id == owner_id
        && stored.kind == kind
        && stored.request == request
    {
        return Ok(());
    }
    Err(file_error(
        "file_mutation_conflict",
        "The mutation ID was already used for a different file change.",
    ))
}

fn planned_move_receipt(
    request: &MoveFileRequest,
    current: &mdbase_connect_protocol::CollectionFileDescriptor,
) -> MoveFileReceipt {
    let mut file = current.clone();
    file.path.clone_from(&request.path);
    if file.path != current.path {
        file.revision = new_file_revision();
    }
    MoveFileReceipt {
        protocol_version: FILE_PROTOCOL_VERSION,
        message_type: MoveFileReceiptKind::FileMoved,
        mutation_id: request.mutation_id,
        file,
    }
}

fn planned_delete_receipt(request: &DeleteFileRequest) -> DeleteFileReceipt {
    DeleteFileReceipt {
        protocol_version: FILE_PROTOCOL_VERSION,
        message_type: DeleteFileReceiptKind::FileDeleted,
        mutation_id: request.mutation_id,
        file_id: request.file_id,
        previous_path: request.path.clone(),
        revision: new_file_revision(),
    }
}

fn move_preferences(receipt: &MoveFileReceipt) -> crate::registry::files::FileReconcilePreferences {
    crate::registry::files::FileReconcilePreferences {
        ids_by_path: HashMap::from([(portable_path_key(&receipt.file.path), receipt.file.file_id)]),
        revisions_by_path: HashMap::from([(
            portable_path_key(&receipt.file.path),
            receipt.file.revision.clone(),
        )]),
        ..Default::default()
    }
}

fn delete_preferences(
    receipt: &DeleteFileReceipt,
) -> crate::registry::files::FileReconcilePreferences {
    crate::registry::files::FileReconcilePreferences {
        tombstone_revisions_by_file: HashMap::from([(receipt.file_id, receipt.revision.clone())]),
        ..Default::default()
    }
}

fn new_file_revision() -> String {
    format!("file:{}", Uuid::now_v7())
}

fn source_path_mismatch() -> ConnectError {
    file_error(
        "file_source_mismatch",
        "The file is no longer at the source path bound to this mutation.",
    )
}

fn to_sql_conversion_error(error: ConnectError) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(error))
}

fn validate_move_destination(
    collection: &mdbase::Collection,
    registered: &CollectionSummary,
    snapshot: &CollectionSnapshot,
    files: &[mdbase_connect_protocol::CollectionFileDescriptor],
    current: &mdbase_connect_protocol::CollectionFileDescriptor,
    destination: &str,
) -> Result<(), ConnectError> {
    validate_target_path(
        collection,
        Path::new(&registered.path),
        snapshot,
        destination,
    )?;
    let target_key = portable_path_key(destination);
    if files
        .iter()
        .any(|file| file.file_id != current.file_id && portable_path_key(&file.path) == target_key)
    {
        return Err(file_error(
            "path_occupied",
            "Another collection file already uses the destination path.",
        ));
    }
    Ok(())
}

fn stale_file_revision() -> ConnectError {
    file_error(
        "stale_file_revision",
        "The file changed after this mutation was prepared.",
    )
}

fn file_not_found() -> ConnectError {
    file_error("file_not_found", "Collection file not found.")
}

#[cfg(test)]
mod tests {
    use super::*;
    use mdbase::runtime::FilesystemProvider;
    use tempfile::tempdir;

    fn owner() -> Uuid {
        Uuid::from_u128(42)
    }

    fn setup() -> (
        tempfile::TempDir,
        tempfile::TempDir,
        CollectionRegistry,
        Uuid,
    ) {
        let state = tempdir().unwrap();
        let root = tempdir().unwrap();
        fs::write(root.path().join("mdbase.yaml"), "spec_version: 0.3.0\n").unwrap();
        let registry = CollectionRegistry::open(state.path()).unwrap();
        let id = registry.add(root.path()).unwrap().id;
        (state, root, registry, id)
    }

    fn indexed_file(
        registry: &CollectionRegistry,
        id: Uuid,
        root: &Path,
        path: &str,
        bytes: &[u8],
    ) -> mdbase_connect_protocol::CollectionFileDescriptor {
        let target = root.join(path);
        fs::create_dir_all(target.parent().unwrap()).unwrap();
        fs::write(target, bytes).unwrap();
        registry
            .reconcile_files(id)
            .unwrap()
            .into_iter()
            .find(|file| file.path == path)
            .unwrap()
    }

    fn move_request(
        file: &mdbase_connect_protocol::CollectionFileDescriptor,
        destination: &str,
    ) -> MoveFileRequest {
        MoveFileRequest {
            protocol_version: FILE_PROTOCOL_VERSION,
            message_type: mdbase_connect_protocol::MoveFileRequestKind::MoveFile,
            mutation_id: Uuid::now_v7(),
            file_id: file.file_id,
            if_revision: file.revision.clone(),
            from_path: file.path.clone(),
            path: destination.to_string(),
            update_references: false,
        }
    }

    fn delete_request(
        file: &mdbase_connect_protocol::CollectionFileDescriptor,
    ) -> DeleteFileRequest {
        DeleteFileRequest {
            protocol_version: FILE_PROTOCOL_VERSION,
            message_type: mdbase_connect_protocol::DeleteFileRequestKind::DeleteFile,
            mutation_id: Uuid::now_v7(),
            file_id: file.file_id,
            if_revision: file.revision.clone(),
            path: file.path.clone(),
        }
    }

    #[test]
    fn move_preserves_identity_and_bytes_and_replays_the_exact_receipt() {
        let (_state, root, registry, id) = setup();
        let original = indexed_file(&registry, id, root.path(), "Images/plot.png", b"plot bytes");
        let request = move_request(&original, "Figures/final.png");

        let receipt = registry.move_file(id, owner(), &request).unwrap();
        assert_eq!(receipt.file.file_id, original.file_id);
        assert_ne!(receipt.file.revision, original.revision);
        assert_eq!(receipt.file.path, request.path);
        assert_eq!(
            fs::read(root.path().join(&request.path)).unwrap(),
            b"plot bytes"
        );
        assert!(!root.path().join(&request.from_path).exists());
        registry
            .connection()
            .unwrap()
            .execute(
                "UPDATE collection_file_mutations SET receipt = NULL, completed_at = NULL
                 WHERE mutation_id = ?1",
                [request.mutation_id.to_string()],
            )
            .unwrap();
        assert_eq!(registry.move_file(id, owner(), &request).unwrap(), receipt);

        let (planned, stored): (String, String) = registry
            .connection()
            .unwrap()
            .query_row(
                "SELECT planned_receipt, receipt FROM collection_file_mutations
                 WHERE mutation_id = ?1",
                [request.mutation_id.to_string()],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(planned, stored);
    }

    #[test]
    fn move_recovers_after_rename_before_index_or_receipt_commit() {
        let (state, root, registry, id) = setup();
        let original = indexed_file(&registry, id, root.path(), "source.bin", b"recover");
        let request = move_request(&original, "Nested/destination.bin");
        let planned = planned_move_receipt(&request, &original);
        registry
            .prepare_lifecycle_mutation(
                id,
                owner(),
                request.mutation_id,
                "move",
                &serde_json::to_string(&request).unwrap(),
                &serde_json::to_string(&planned).unwrap(),
            )
            .unwrap();
        fs::create_dir(root.path().join("Nested")).unwrap();
        fs::rename(
            root.path().join(&request.from_path),
            root.path().join(&request.path),
        )
        .unwrap();

        let reopened = CollectionRegistry::open(state.path()).unwrap();
        assert_eq!(reopened.move_file(id, owner(), &request).unwrap(), planned);
        assert_eq!(reopened.indexed_files(id).unwrap(), vec![planned.file]);
    }

    #[test]
    fn delete_is_durable_replayable_and_emits_the_planned_tombstone_revision() {
        let (_state, root, registry, id) = setup();
        let provider = FilesystemProvider::open(root.path()).unwrap();
        crate::LocalSyncStore::for_registry(&registry)
            .reconcile(id, &provider.snapshot().unwrap(), &HashMap::new())
            .unwrap();
        let original = indexed_file(&registry, id, root.path(), "Archive/report.pdf", b"pdf");
        let request = delete_request(&original);

        let receipt = registry.delete_file(id, owner(), &request).unwrap();
        assert_eq!(receipt.previous_path, original.path);
        assert!(!root.path().join(&request.path).exists());
        registry
            .connection()
            .unwrap()
            .execute(
                "UPDATE collection_file_mutations SET receipt = NULL, completed_at = NULL
                 WHERE mutation_id = ?1",
                [request.mutation_id.to_string()],
            )
            .unwrap();
        assert_eq!(
            registry.delete_file(id, owner(), &request).unwrap(),
            receipt
        );
        let tombstone_revision: String = registry
            .connection()
            .unwrap()
            .query_row(
                "SELECT revision FROM collection_file_changes
                 WHERE collection_id = ?1 AND file_id = ?2 AND after_file IS NULL",
                params![id.to_string(), original.file_id.to_string()],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(tombstone_revision, receipt.revision);
    }

    #[test]
    fn delete_recovers_after_unlink_before_index_or_receipt_commit() {
        let (state, root, registry, id) = setup();
        let original = indexed_file(&registry, id, root.path(), "delete-me.bin", b"recover");
        let request = delete_request(&original);
        let planned = planned_delete_receipt(&request);
        registry
            .prepare_lifecycle_mutation(
                id,
                owner(),
                request.mutation_id,
                "delete",
                &serde_json::to_string(&request).unwrap(),
                &serde_json::to_string(&planned).unwrap(),
            )
            .unwrap();
        fs::remove_file(root.path().join(&request.path)).unwrap();

        let reopened = CollectionRegistry::open(state.path()).unwrap();
        assert_eq!(
            reopened.delete_file(id, owner(), &request).unwrap(),
            planned
        );
        assert!(reopened.indexed_files(id).unwrap().is_empty());
    }

    #[test]
    fn lifecycle_preconditions_fail_closed_without_mutating_files() {
        let (_state, root, registry, id) = setup();
        let original = indexed_file(&registry, id, root.path(), "safe.bin", b"safe");

        let mut stale = move_request(&original, "moved.bin");
        stale.if_revision = "file:stale".to_string();
        assert_eq!(
            registry.move_file(id, owner(), &stale).unwrap_err().code(),
            "stale_file_revision"
        );

        let mut wrong_path = move_request(&original, "moved.bin");
        wrong_path.from_path = "other.bin".to_string();
        assert_eq!(
            registry
                .move_file(id, owner(), &wrong_path)
                .unwrap_err()
                .code(),
            "file_source_mismatch"
        );

        let mut wrong_delete_path = delete_request(&original);
        wrong_delete_path.path = "other.bin".to_string();
        assert_eq!(
            registry
                .delete_file(id, owner(), &wrong_delete_path)
                .unwrap_err()
                .code(),
            "file_source_mismatch"
        );

        let mut stale_delete = delete_request(&original);
        stale_delete.if_revision = "file:stale".to_string();
        assert_eq!(
            registry
                .delete_file(id, owner(), &stale_delete)
                .unwrap_err()
                .code(),
            "stale_file_revision"
        );

        fs::write(root.path().join("occupied.bin"), b"occupied").unwrap();
        registry.reconcile_files(id).unwrap();
        let occupied = move_request(&original, "occupied.bin");
        assert_eq!(
            registry
                .move_file(id, owner(), &occupied)
                .unwrap_err()
                .code(),
            "path_occupied"
        );

        let hidden = move_request(&original, ".hidden/file.bin");
        assert_eq!(
            registry.move_file(id, owner(), &hidden).unwrap_err().code(),
            "unsafe_file_path"
        );

        let mut references = move_request(&original, "moved.bin");
        references.update_references = true;
        assert_eq!(
            registry
                .move_file(id, owner(), &references)
                .unwrap_err()
                .code(),
            "reference_updates_unsupported"
        );
        let count: u64 = registry
            .connection()
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM collection_file_mutations",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 0);
        assert_eq!(fs::read(root.path().join("safe.bin")).unwrap(), b"safe");
    }

    #[test]
    fn mutation_ids_are_globally_bound_to_owner_collection_and_exact_request() {
        let (_state, root, registry, id) = setup();
        let original = indexed_file(&registry, id, root.path(), "owned.bin", b"owned");
        let request = move_request(&original, "moved.bin");
        registry.move_file(id, owner(), &request).unwrap();

        let other_owner = Uuid::from_u128(43);
        assert_eq!(
            registry
                .move_file(id, other_owner, &request)
                .unwrap_err()
                .code(),
            "file_mutation_conflict"
        );
        let mut changed = request.clone();
        changed.path = "elsewhere.bin".to_string();
        assert_eq!(
            registry
                .move_file(id, owner(), &changed)
                .unwrap_err()
                .code(),
            "file_mutation_conflict"
        );
    }
}
