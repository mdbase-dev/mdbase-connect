use super::*;

impl CollectionRegistry {
    pub fn describe(&self, id: Uuid) -> Result<CollectionDescription, ConnectError> {
        let registered = self.get(id)?;
        let provider = self.provider_for(&registered)?;
        provider.with_collection_read(|collection| self.describe_loaded(&registered, collection))
    }

    pub(super) fn describe_loaded(
        &self,
        registered: &CollectionSummary,
        collection: &Collection,
    ) -> Result<CollectionDescription, ConnectError> {
        let mut types = Vec::new();
        let mut contracts = Vec::new();
        let mut configuration = None;
        if collection.spec_profile() == SpecProfile::V03 {
            let report = mdbase::v03::inspect_collection(Path::new(&registered.path));
            if !report.valid {
                let message = report
                    .diagnostics
                    .first()
                    .map(|diagnostic| diagnostic.message.clone())
                    .unwrap_or_else(|| "Collection type metadata is invalid".to_string());
                return Err(ConnectError::CollectionOpen(message));
            }
            configuration = report.config.as_ref().and_then(portable_configuration);
            for type_file in report.types {
                let description = type_file
                    .frontmatter
                    .get("description")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                let collection_metadata = type_file.frontmatter.get("collection").cloned();
                let lifecycle = type_file.frontmatter.get("lifecycle").cloned();
                let extensions = type_file
                    .frontmatter
                    .as_object()
                    .into_iter()
                    .flatten()
                    .filter(|(key, _)| key.starts_with("x-"))
                    .map(|(key, value)| (key.clone(), value.clone()))
                    .collect::<serde_json::Map<_, _>>();
                types.push(CollectionTypeDescriptor {
                    name: type_file.name,
                    version: type_file.version,
                    description,
                    revision: fs::read(Path::new(&registered.path).join(&type_file.path))
                        .ok()
                        .map(|bytes| format!("sha256:{:x}", Sha256::digest(&bytes))),
                    path: Some(type_file.path),
                    definition: type_file
                        .frontmatter
                        .as_object()
                        .cloned()
                        .map(Value::Object),
                    schema: type_file.schema,
                    collection: collection_metadata,
                    lifecycle,
                    extensions,
                });
            }
            contracts = collection
                .list_data_contracts()
                .into_iter()
                .filter_map(|definition| {
                    let implementations = collection
                        .get_data_contract_implementations(&definition.id, &definition.version)
                        .into_iter()
                        .map(|implementation| {
                            mdbase_connect_protocol::CollectionContractImplementationDescriptor {
                                type_name: implementation.type_name,
                                type_version: implementation.type_version,
                                type_path: implementation.source_path,
                                digest: implementation.implementation_digest,
                                fields: implementation.fields,
                                binding: implementation.binding,
                            }
                        })
                        .collect::<Vec<_>>();
                    (!implementations.is_empty()).then_some(CollectionContractDescriptor {
                        implementations,
                        contract_type: definition.contract_type,
                        id: definition.id,
                        version: definition.version,
                        digest: definition.digest,
                        schema: definition
                            .record_schema
                            .expect("record implementations require record_schema"),
                        binding_schema: definition.binding_schema,
                    })
                })
                .collect();
        }
        types.sort_by(|left, right| left.name.cmp(&right.name));
        contracts
            .sort_by(|left, right| (&left.id, &left.version).cmp(&(&right.id, &right.version)));
        Ok(CollectionDescription {
            protocol_version: CONTROL_PROTOCOL_VERSION,
            collection_id: registered.id,
            display_name: registered.display_name.clone(),
            spec_version: registered.spec_version.clone(),
            operations: supported_operations(collection.spec_profile())
                .iter()
                .map(|value| (*value).to_string())
                .collect(),
            change_cursor: self.current_change_cursor(registered.id)?,
            types,
            contracts,
            configuration,
        })
    }

    pub fn append_change(
        &self,
        collection_id: Uuid,
        event: &mdbase::watch::WatchEvent,
    ) -> Result<u64, ConnectError> {
        self.get(collection_id)?;
        let mut payload = event.payload.clone();
        if let Some(object) = payload.as_object_mut() {
            object.remove("before");
            object.remove("after");
        }
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        let cursor: i64 = transaction.query_row(
            "SELECT COALESCE(MAX(cursor), 0) + 1 FROM collection_changes WHERE collection_id = ?1",
            [collection_id.to_string()],
            |row| row.get(0),
        )?;
        transaction.execute(
            "INSERT INTO collection_changes
               (collection_id, cursor, event_type, occurred_at, payload)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                collection_id.to_string(),
                cursor,
                event.event_type,
                event.occurred_at,
                serde_json::to_string(&payload)?,
            ],
        )?;
        transaction.execute(
            "DELETE FROM collection_changes WHERE collection_id = ?1 AND cursor <= ?2",
            params![collection_id.to_string(), cursor.saturating_sub(2_000)],
        )?;
        transaction.commit()?;
        Ok(cursor as u64)
    }

    pub(super) fn refresh_summary_metadata(
        &self,
        collection: &mut CollectionSummary,
    ) -> Result<(), ConnectError> {
        let path = Path::new(&collection.path);
        let metadata = read_collection_metadata(path)?;
        let display_name = collection_display_name(&metadata, path);
        let description = normalized_optional(metadata.description);
        if collection.display_name != display_name
            || collection.description != description
            || collection.spec_version != metadata.spec_version
        {
            self.connection()?.execute(
                "UPDATE collections
                 SET display_name = ?2, description = ?3, spec_version = ?4,
                     updated_at = CURRENT_TIMESTAMP
                 WHERE id = ?1",
                params![
                    collection.id.to_string(),
                    display_name,
                    description,
                    metadata.spec_version
                ],
            )?;
            collection.display_name = display_name;
            collection.description = description;
            collection.spec_version = metadata.spec_version;
        }
        Ok(())
    }

    pub fn changes(
        &self,
        collection_id: Uuid,
        input: &Value,
    ) -> Result<CollectionChangesPage, ConnectError> {
        self.get(collection_id)?;
        let current = self.current_change_cursor(collection_id)?;
        let Some(after) = input.get("after").and_then(Value::as_u64) else {
            return Ok(CollectionChangesPage {
                events: Vec::new(),
                cursor: current,
                has_more: false,
                reset: false,
            });
        };
        let limit = input
            .get("limit")
            .and_then(Value::as_u64)
            .unwrap_or(100)
            .clamp(1, 500) as usize;
        let connection = self.connection()?;
        let earliest = connection
            .query_row(
                "SELECT MIN(cursor) FROM collection_changes WHERE collection_id = ?1",
                [collection_id.to_string()],
                |row| row.get::<_, Option<u64>>(0),
            )?
            .unwrap_or(current.saturating_add(1));
        if after.saturating_add(1) < earliest {
            return Ok(CollectionChangesPage {
                events: Vec::new(),
                cursor: current,
                has_more: false,
                reset: true,
            });
        }
        let mut statement = connection.prepare(
            "SELECT cursor, event_type, occurred_at, payload
             FROM collection_changes
             WHERE collection_id = ?1 AND cursor > ?2
             ORDER BY cursor ASC LIMIT ?3",
        )?;
        let rows = statement.query_map(
            params![collection_id.to_string(), after, (limit + 1) as u64],
            |row| {
                Ok((
                    row.get::<_, u64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                ))
            },
        )?;
        let mut events = rows
            .map(|row| {
                let (cursor, event_type, occurred_at, payload) = row?;
                Ok(CollectionChange {
                    cursor,
                    event_type,
                    occurred_at,
                    payload: serde_json::from_str(&payload)?,
                })
            })
            .collect::<Result<Vec<_>, ConnectError>>()?;
        let has_more = events.len() > limit;
        events.truncate(limit);
        let cursor = events.last().map(|event| event.cursor).unwrap_or(after);
        Ok(CollectionChangesPage {
            events,
            cursor,
            has_more,
            reset: false,
        })
    }

    fn current_change_cursor(&self, collection_id: Uuid) -> Result<u64, ConnectError> {
        let cursor = self.connection()?.query_row(
            "SELECT COALESCE(MAX(cursor), 0) FROM collection_changes WHERE collection_id = ?1",
            [collection_id.to_string()],
            |row| row.get::<_, u64>(0),
        )?;
        Ok(cursor)
    }
}

fn portable_configuration(configuration: &Value) -> Option<Value> {
    let source = configuration.as_object()?;
    let mut result = serde_json::Map::new();
    if let Some(spec_version) = source.get("spec_version") {
        result.insert("spec_version".to_string(), spec_version.clone());
    }
    if let Some(settings) = select_configuration_fields(
        source.get("settings"),
        &[
            "types_folder",
            "record_extensions",
            "validation",
            "explicit_type_keys",
            "id_field",
            "include_subfolders",
            "exclude",
        ],
    ) {
        result.insert("settings".to_string(), settings);
    }
    if let Some(runtime) = select_configuration_fields(
        source.get("runtime"),
        &["profile_version", "enabled", "contract_mode", "policy"],
    ) {
        result.insert("runtime".to_string(), runtime);
    }
    Some(Value::Object(result))
}

fn select_configuration_fields(value: Option<&Value>, fields: &[&str]) -> Option<Value> {
    let source = value?.as_object()?;
    let selected = fields
        .iter()
        .filter_map(|field| {
            source
                .get(*field)
                .map(|value| ((*field).to_string(), value.clone()))
        })
        .collect::<serde_json::Map<_, _>>();
    Some(Value::Object(selected))
}
