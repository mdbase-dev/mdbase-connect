use super::*;

impl CollectionRegistry {
    pub fn list(&self) -> Result<Vec<CollectionSummary>, ConnectError> {
        let connection = self.connection()?;
        let mut statement = connection.prepare(
            "SELECT id, display_name, description, path, spec_version, enabled
             FROM collections ORDER BY display_name COLLATE NOCASE, path",
        )?;
        let rows = statement.query_map([], |row| {
            let id: String = row.get(0)?;
            Ok((
                id,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, bool>(5)?,
            ))
        })?;

        let mut collections = rows
            .map(|row| {
                let (id, display_name, description, path, spec_version, enabled) = row?;
                let id = Uuid::parse_str(&id).map_err(|error| {
                    ConnectError::CollectionOpen(format!(
                        "invalid collection id in registry: {error}"
                    ))
                })?;
                Ok(CollectionSummary {
                    id,
                    display_name,
                    description,
                    path,
                    spec_version,
                    enabled,
                    contracts: Vec::new(),
                })
            })
            .collect::<Result<Vec<_>, ConnectError>>()?;
        drop(statement);
        drop(connection);
        for collection in &mut collections {
            if mirror_collection_id(Path::new(&collection.path))?.is_some() {
                collection.enabled = false;
                continue;
            }
            let _ = self.refresh_summary_metadata(collection);
            if let Ok(description) = self.describe(collection.id) {
                collection.contracts = description.contracts;
            }
        }
        collections.sort_by(|left, right| {
            left.display_name
                .to_lowercase()
                .cmp(&right.display_name.to_lowercase())
                .then_with(|| left.path.cmp(&right.path))
        });
        Ok(collections)
    }

    pub fn count(&self) -> Result<usize, ConnectError> {
        let count: i64 =
            self.connection()?
                .query_row("SELECT COUNT(*) FROM collections", [], |row| row.get(0))?;
        Ok(count as usize)
    }

    pub fn add(&self, path: impl AsRef<Path>) -> Result<CollectionSummary, ConnectError> {
        let requested_path = path.as_ref();
        if !requested_path.exists() {
            return Err(ConnectError::PathNotFound(
                requested_path.display().to_string(),
            ));
        }
        let path = requested_path.canonicalize()?;
        assert_local_authority_folder(&path)?;
        if !path.join("mdbase.yaml").is_file() {
            return Err(ConnectError::NotACollection(path.display().to_string()));
        }

        let provider = Arc::new(FilesystemProvider::open(&path)?);

        let id = ensure_collection_id(&path)?;
        let metadata = read_collection_metadata(&path)?;
        let path_string = path.to_string_lossy().to_string();
        let display_name = collection_display_name(&metadata, &path);
        let description = normalized_optional(metadata.description);

        let existing_path = self
            .connection()?
            .query_row(
                "SELECT path FROM collections WHERE id = ?1",
                [id.to_string()],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        if let Some(existing_path) = existing_path.as_deref() {
            if existing_path != path_string && Path::new(existing_path).exists() {
                return Err(ConnectError::DuplicateCollectionIdentity {
                    collection_id: id,
                    existing_path: existing_path.to_string(),
                });
            }
        }

        self.connection()?.execute(
            "INSERT INTO collections (id, path, display_name, description, spec_version, enabled)
             VALUES (?1, ?2, ?3, ?4, ?5, 1)
             ON CONFLICT(id) DO UPDATE SET
               path = excluded.path,
               display_name = excluded.display_name,
               description = excluded.description,
               spec_version = excluded.spec_version,
               updated_at = CURRENT_TIMESTAMP",
            params![
                id.to_string(),
                path_string,
                display_name,
                description,
                metadata.spec_version
            ],
        )?;

        self.providers
            .lock()
            .map_err(|_| ConnectError::CollectionOpen("provider registry lock poisoned".into()))?
            .insert(id, provider);

        self.get(id)
    }

    pub fn add_copy(&self, path: impl AsRef<Path>) -> Result<CollectionSummary, ConnectError> {
        let requested_path = path.as_ref();
        if !requested_path.exists() {
            return Err(ConnectError::PathNotFound(
                requested_path.display().to_string(),
            ));
        }
        let path = requested_path.canonicalize()?;
        assert_local_authority_folder(&path)?;
        if !path.join("mdbase.yaml").is_file() {
            return Err(ConnectError::NotACollection(path.display().to_string()));
        }
        FilesystemProvider::open(&path)?;

        let copied_id = read_collection_id(&path)?.ok_or_else(|| {
            ConnectError::NotARegisteredCollectionCopy(
                "The collection has no existing Connect identity; register it normally."
                    .to_string(),
            )
        })?;
        let existing_path = self
            .connection()?
            .query_row(
                "SELECT path FROM collections WHERE id = ?1",
                [copied_id.to_string()],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        let Some(existing_path) = existing_path else {
            return Err(ConnectError::NotARegisteredCollectionCopy(
                "Its identity is not registered on this computer; register it normally."
                    .to_string(),
            ));
        };
        if existing_path == path.to_string_lossy() {
            return Err(ConnectError::NotARegisteredCollectionCopy(
                "The selected folder is the registered original.".to_string(),
            ));
        }
        if !Path::new(&existing_path).exists() {
            return Err(ConnectError::NotARegisteredCollectionCopy(
                "The registered path no longer exists; register this folder normally to record its move."
                    .to_string(),
            ));
        }

        write_collection_id(&path, Uuid::new_v4())?;
        self.add(path)
    }

    pub fn make_independent(&self, id: Uuid) -> Result<CollectionSummary, ConnectError> {
        let collection = self.get(id)?;
        crate::LocalSyncStore::for_registry(self).assert_mutation_allowed(id)?;
        let path = PathBuf::from(&collection.path);
        let new_id = Uuid::new_v4();
        write_collection_id(&path, new_id)?;
        let result = (|| {
            let mut connection = self.connection()?;
            let transaction =
                connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            transaction.execute(
                "DELETE FROM grant_crypto_state
                 WHERE grant_id IN (SELECT id FROM grants WHERE collection_id = ?1)",
                [id.to_string()],
            )?;
            transaction.execute(
                "DELETE FROM grant_crypto_requests
                 WHERE grant_id IN (SELECT id FROM grants WHERE collection_id = ?1)",
                [id.to_string()],
            )?;
            transaction.execute(
                "DELETE FROM grants WHERE collection_id = ?1",
                [id.to_string()],
            )?;
            transaction.execute(
                "DELETE FROM collection_changes WHERE collection_id = ?1",
                [id.to_string()],
            )?;
            transaction.execute(
                "UPDATE collections SET id = ?1, updated_at = CURRENT_TIMESTAMP WHERE id = ?2",
                params![new_id.to_string(), id.to_string()],
            )?;
            transaction.commit()?;
            Ok::<(), ConnectError>(())
        })();
        if let Err(error) = result {
            let _ = write_collection_id(&path, id);
            return Err(error);
        }
        let mut providers = self
            .providers
            .lock()
            .map_err(|_| ConnectError::CollectionOpen("provider registry lock poisoned".into()))?;
        if let Some(provider) = providers.remove(&id) {
            providers.insert(new_id, provider);
        }
        drop(providers);
        self.get(new_id)
    }

    pub fn create(
        &self,
        path: impl AsRef<Path>,
        name: Option<&str>,
    ) -> Result<CollectionSummary, ConnectError> {
        let mut config = serde_json::Map::new();
        config.insert("spec_version".to_string(), json!("0.3.0"));
        if let Some(name) = name.filter(|name| !name.trim().is_empty()) {
            config.insert("name".to_string(), json!(name.trim()));
        }
        let result = mdbase::init::init_collection(
            path.as_ref(),
            &json!({ "config": Value::Object(config) }),
        );
        if result.get("error").is_some() {
            return Err(ConnectError::CollectionInit(error_message(
                &result,
                "Failed to initialize collection",
            )));
        }
        self.add(path)
    }

    pub fn update_metadata(
        &self,
        id: Uuid,
        name: &str,
        description: Option<&str>,
    ) -> Result<CollectionSummary, ConnectError> {
        let name = name.trim();
        if name.is_empty() || name.chars().count() > 100 {
            return Err(ConnectError::CollectionOpen(
                "Collection name must be between 1 and 100 characters.".to_string(),
            ));
        }
        let description = description.map(str::trim).filter(|value| !value.is_empty());
        if description.is_some_and(|value| value.chars().count() > 500) {
            return Err(ConnectError::CollectionOpen(
                "Collection description must be 500 characters or fewer.".to_string(),
            ));
        }

        let registered = self.get(id)?;
        assert_local_authority_folder(Path::new(&registered.path))?;
        let provider = self.provider_for(&registered)?;
        let sync_store = crate::LocalSyncStore::for_registry(self);
        provider.with_collection::<_, ConnectError>(|_| {
            sync_store.assert_mutation_allowed(id)?;
            let config_path = Path::new(&registered.path).join("mdbase.yaml");
            let source = fs::read_to_string(&config_path)?;
            let mut config: serde_yaml::Value = serde_yaml::from_str(&source)?;
            let mapping = config.as_mapping_mut().ok_or_else(|| {
                ConnectError::CollectionOpen("mdbase.yaml must contain a YAML mapping.".to_string())
            })?;
            mapping.insert(
                serde_yaml::Value::String("name".to_string()),
                serde_yaml::Value::String(name.to_string()),
            );
            let description_key = serde_yaml::Value::String("description".to_string());
            if let Some(description) = description {
                mapping.insert(
                    description_key,
                    serde_yaml::Value::String(description.to_string()),
                );
            } else {
                mapping.remove(&description_key);
            }

            let serialized = serde_yaml::to_string(&config)?;
            let root = config_path.parent().ok_or_else(|| {
                ConnectError::CollectionOpen("Collection config has no parent folder.".to_string())
            })?;
            let permissions = fs::metadata(&config_path)?.permissions();
            let mut temporary = NamedTempFile::new_in(root)?;
            temporary.as_file().set_permissions(permissions)?;
            temporary.write_all(serialized.as_bytes())?;
            temporary.as_file().sync_all()?;
            temporary
                .persist(&config_path)
                .map_err(|error| ConnectError::Io(error.error))?;
            Ok(())
        })?;

        let mut updated = registered;
        self.refresh_summary_metadata(&mut updated)?;
        self.providers
            .lock()
            .map_err(|_| ConnectError::CollectionOpen("provider registry lock poisoned".into()))?
            .remove(&id);
        Ok(updated)
    }

    pub fn set_enabled(&self, id: Uuid, enabled: bool) -> Result<CollectionSummary, ConnectError> {
        let store = crate::LocalSyncStore::for_registry(self);
        if enabled {
            let registered = self.get(id)?;
            assert_local_authority_folder(Path::new(&registered.path))?;
            store.assert_mutation_allowed(id)?;
        } else {
            store.assert_not_transferring(id)?;
        }
        let changed = self.connection()?.execute(
            "UPDATE collections SET enabled = ?2, updated_at = CURRENT_TIMESTAMP WHERE id = ?1",
            params![id.to_string(), enabled],
        )?;
        if changed == 0 {
            return Err(ConnectError::CollectionNotFound(id));
        }
        self.get(id)
    }

    pub fn get(&self, id: Uuid) -> Result<CollectionSummary, ConnectError> {
        let connection = self.connection()?;
        let row = connection
            .query_row(
                "SELECT display_name, description, path, spec_version, enabled
                 FROM collections WHERE id = ?1",
                [id.to_string()],
                |row| {
                    Ok(CollectionSummary {
                        id,
                        display_name: row.get(0)?,
                        description: row.get(1)?,
                        path: row.get(2)?,
                        spec_version: row.get(3)?,
                        enabled: row.get(4)?,
                        contracts: Vec::new(),
                    })
                },
            )
            .optional()?;
        let mut collection = row.ok_or(ConnectError::CollectionNotFound(id))?;
        if mirror_collection_id(Path::new(&collection.path))?.is_some() {
            collection.enabled = false;
        }
        Ok(collection)
    }

    pub fn remove(&self, id: Uuid) -> Result<CollectionSummary, ConnectError> {
        let collection = self.get(id)?;
        crate::LocalSyncStore::for_registry(self).assert_not_transferring(id)?;
        self.connection()?
            .execute("DELETE FROM collections WHERE id = ?1", [id.to_string()])?;
        self.providers
            .lock()
            .map_err(|_| ConnectError::CollectionOpen("provider registry lock poisoned".into()))?
            .remove(&id);
        Ok(collection)
    }
}
